//! The WebSocket hub at `/app/ws`: one socket per browser tab, bounded in every dimension
//! (SECURITY.md rule 9). The protocol is `docs/WS.md`.
//!
//! - [`Sockets`] is process-wide: the total cap and shutdown.
//! - [`Hub`] is per network: topics, their subscribers and the snapshot a new subscriber gets.
//!   [`Hub::publish`] encodes nothing; callers encode a [`Frame`] once and every subscriber gets
//!   a reference to the same bytes through its bounded send queue.
//! - [`feed`] turns the network's Electrum events into `blocks` messages.
//!
//! Each connection runs as one task with three parts: a reader (frames in, rate and size checked),
//! a writer (send queue out, never interrupted mid-frame) and a watchdog (ping, idle, shutdown).
//! Any of them, or the hub on a full queue, sets the close reason once; the writer then sends the
//! close frame and the task ends.

pub mod fees;
mod frame;
mod hub;
pub mod mempool;
pub mod track;
pub mod v1;

use std::collections::HashSet;
use std::pin::pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::Extension;
use axum::extract::{Request, State};
use axum::http::header::{
    CONNECTION, HOST, ORIGIN, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, UPGRADE,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};

use crate::NetworkContext;
use crate::config::WsLimits;
use crate::error::ApiError;
use crate::limits::{self, Held, Hold, Refused};
use crate::refusals::{Refusal, Refusals};

pub use frame::Frame;
pub use hub::{Fanout, Hub, Snapshot, feed};
pub use track::Tracking;

/// Protocol version, sent in `hello`. Bumped only for a change an old client would misread.
pub const VERSION: u32 = 1;

/// After our close frame, how long the client gets to answer before the TCP connection is dropped.
const CLOSE_GRACE: Duration = Duration::from_secs(1);

/// Why a socket closed. `code` and `reason` go in the close frame, except [`Close::GONE`];
/// `label` goes in the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Close {
    pub code: u16,
    pub reason: &'static str,
    pub label: &'static str,
}

impl Close {
    pub const NORMAL: Self = Self::new(1000, "closed by client", "client_closed");
    pub const GOING_AWAY: Self = Self::new(1001, "server shutting down", "shutdown");
    pub const PROTOCOL: Self = Self::new(1002, "protocol error", "protocol_error");
    pub const UNSUPPORTED: Self = Self::new(1003, "binary messages are not accepted", "binary");
    pub const INVALID_UTF8: Self = Self::new(1007, "invalid utf-8", "invalid_utf8");
    pub const TOO_BIG: Self = Self::new(1009, "message too big", "too_big");
    pub const BAD_MESSAGE: Self = Self::new(4000, "bad message", "bad_message");
    pub const TOO_MANY_SUBSCRIPTIONS: Self =
        Self::new(4001, "too many subscriptions", "too_many_subscriptions");
    pub const RATE: Self = Self::new(4002, "too many messages", "rate");
    pub const SLOW: Self = Self::new(4003, "too slow", "too_slow");
    pub const IDLE: Self = Self::new(4004, "idle timeout", "idle");
    /// The connection dropped without a close frame. Never sent: 1006 is reserved for that meaning.
    pub const GONE: Self = Self::new(1006, "connection lost", "connection_lost");

    const fn new(code: u16, reason: &'static str, label: &'static str) -> Self {
        Self {
            code,
            reason,
            label,
        }
    }

    /// Whether the server dropped the client for breaking a limit, as opposed to a close by the
    /// client, a lost connection or shutdown.
    fn is_limit(self) -> bool {
        !matches!(self.code, 1000 | 1001 | 1006)
    }
}

/// A topic a client can subscribe to. The fixed ones parse with [`Topic::parse`], a tracked
/// transaction or address with [`track::parse`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Topic {
    Blocks,
    /// Mempool totals.
    Mempool,
    /// Every projected block's totals.
    Projected,
    /// One projected block's transactions, in binary frames. Always below
    /// [`mempool::TXS_TOPICS`].
    ProjectedTxs(u8),
    /// The newest transactions seen.
    Transactions,
    /// One transaction followed: `tx:<txid>`.
    Tx(bitcoin::Txid),
    /// One address followed, by its script: `address:<address>`.
    Address(node::electrum::ScriptHash),
    /// Fee recommendations.
    Fees,
    /// The replacement record's version: a page listing replacements asks for them again when
    /// it changes.
    Replacements,
    /// The mempool.space-shaped `/api/v1/ws` (`v1.rs`): its `blocks` and `block` messages.
    V1Blocks,
    /// `/api/v1/ws`: the `stats` messages (mempool info, fees, difficulty adjustment).
    V1Stats,
    /// `/api/v1/ws`: the `mempool-blocks` messages.
    V1MempoolBlocks,
    /// `/api/v1/ws`: `live-2h-chart`, each mempool history sample as it is written.
    V1LiveChart,
    /// `/api/v1/ws`: one transaction followed with `track-tx`. Shares [`Topic::Tx`]'s entry.
    V1Tx(bitcoin::Txid),
    /// `/api/v1/ws`: one address followed with `track-address`. Shares [`Topic::Address`]'s
    /// Electrum subscription.
    V1Address(node::electrum::ScriptHash),
    /// `/api/v1/ws`: one address of a `track-addresses` set, sent in that message's shape.
    V1Addresses(node::electrum::ScriptHash),
    /// `/api/v1/ws`: one projected block's transactions, `track-mempool-block`. Always below
    /// [`mempool::TXS_TOPICS`].
    V1ProjectedTxs(u8),
}

/// Names of the [`Topic::ProjectedTxs`] topics, by block.
const PROJECTED_TXS: [&str; mempool::TXS_TOPICS] = [
    "projected-txs:0",
    "projected-txs:1",
    "projected-txs:2",
    "projected-txs:3",
    "projected-txs:4",
    "projected-txs:5",
    "projected-txs:6",
];

impl Topic {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "blocks" => Some(Self::Blocks),
            "mempool" => Some(Self::Mempool),
            "projected" => Some(Self::Projected),
            "transactions" => Some(Self::Transactions),
            "fees" => Some(Self::Fees),
            "replacements" => Some(Self::Replacements),
            _ => PROJECTED_TXS
                .iter()
                .position(|n| *n == s)
                .and_then(|i| u8::try_from(i).ok())
                .map(Self::ProjectedTxs),
        }
    }

    /// The topic's name; for a tracked transaction or address only its kind, so it can go in a log
    /// line without saying what someone looks at.
    pub fn name(self) -> &'static str {
        match self {
            Self::Tx(_) => "tx",
            Self::Address(_) => "address",
            Self::Blocks => "blocks",
            Self::Mempool => "mempool",
            Self::Projected => "projected",
            Self::Transactions => "transactions",
            Self::Fees => "fees",
            Self::Replacements => "replacements",
            Self::V1Blocks => "v1:blocks",
            Self::V1Stats => "v1:stats",
            Self::V1MempoolBlocks => "v1:mempool-blocks",
            Self::V1LiveChart => "v1:live-2h-chart",
            Self::V1Tx(_) => "v1:tx",
            Self::V1Address(_) | Self::V1Addresses(_) => "v1:address",
            Self::V1ProjectedTxs(_) => "v1:projected-txs",
            Self::ProjectedTxs(i) => PROJECTED_TXS.get(usize::from(i)).copied().unwrap_or(""),
        }
    }
}

/// Process-wide socket state: the total cap and shutdown.
#[derive(Debug)]
pub struct Sockets {
    limits: WsLimits,
    permits: Arc<Semaphore>,
    /// `/api/v1/ws` sockets: a pool apart, so they can never take `/app/ws` slots.
    v1_permits: Arc<Semaphore>,
    shutdown: watch::Sender<bool>,
    closed_at: OnceLock<Instant>,
    /// How long sockets get to close after [`Sockets::close_all`].
    grace: Duration,
    next_id: AtomicU64,
    /// Upgrades refused for their `Origin`, every network together.
    origin_refused: AtomicU64,
    /// The server's refusal summary, which socket messages refused are counted in too.
    pub(crate) refusals: Arc<Refusals>,
}

impl Sockets {
    /// `grace` is how long sockets get to close after [`Sockets::close_all`]; then they are dropped.
    pub fn new(limits: &WsLimits, grace: Duration) -> Arc<Self> {
        Arc::new(Self {
            limits: limits.clone(),
            permits: Arc::new(Semaphore::new(limits.max_sockets)),
            v1_permits: Arc::new(Semaphore::new(limits.v1_max_sockets)),
            shutdown: watch::Sender::new(false),
            closed_at: OnceLock::new(),
            grace,
            next_id: AtomicU64::new(0),
            origin_refused: AtomicU64::new(0),
            refusals: Refusals::new(std::time::Instant::now()),
        })
    }

    /// Sockets open now, on every network and both APIs.
    pub fn open(&self) -> usize {
        let used = |all: usize, s: &Semaphore| all.saturating_sub(s.available_permits());
        used(self.limits.max_sockets, &self.permits)
            + used(self.limits.v1_max_sockets, &self.v1_permits)
    }

    /// Refuses new sockets and tells every open one to close with 1001.
    pub fn close_all(&self) {
        self.closed_at.get_or_init(Instant::now);
        self.permits.close();
        self.v1_permits.close();
        self.shutdown.send_replace(true);
    }

    /// Waits until every socket has finished. Each one is cancelled at the grace deadline; the
    /// margin after it lets those tasks run their cleanup. Bounded, so an upgrade still pending in
    /// an HTTP connection cannot hold shutdown.
    pub async fn drain(&self) {
        let _ = tokio::time::timeout_at((self.deadline() + CLOSE_GRACE).into(), async {
            // `close_all` closed the semaphores, so wait on the count instead of acquiring.
            while self.open() > 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
    }

    /// When sockets still open after [`Sockets::close_all`] are dropped.
    fn deadline(&self) -> Instant {
        *self.closed_at.get_or_init(Instant::now) + self.grace
    }

    /// Resolves at the shutdown deadline; pending until shutdown starts.
    async fn expired(&self) {
        until(&mut self.shutdown.subscribe(), |s| *s).await;
        tokio::time::sleep_until(self.deadline().into()).await;
    }
}

/// One connection as the hub sees it: where to queue its frames and how to close it.
#[derive(Debug)]
pub struct Conn {
    id: u64,
    /// The client, as the per-client limits key it.
    who: Refusal,
    queue: mpsc::Sender<Frame>,
    closing: watch::Sender<Option<Close>>,
}

impl Conn {
    /// Queues `frame`. A full queue means the client is not keeping up: it is closed with
    /// [`Close::SLOW`] and `false` is returned if this call is what closed it.
    fn send(&self, frame: Frame) -> bool {
        match self.queue.try_send(frame) {
            Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => true,
            Err(mpsc::error::TrySendError::Full(_)) => !self.close(Close::SLOW),
        }
    }

    /// Sets the close reason if none is set yet; returns whether this call set it.
    fn close(&self, reason: Close) -> bool {
        self.closing.send_if_modified(|c| {
            let first = c.is_none();
            if first {
                *c = Some(reason);
            }
            first
        })
    }

    fn reason(&self) -> Option<Close> {
        *self.closing.borrow()
    }
}

#[cfg(test)]
impl Conn {
    /// A connection for tests, whose client address is made from `id`: one client each.
    pub(crate) fn test(id: u64, queue: mpsc::Sender<Frame>) -> Self {
        let client =
            std::net::IpAddr::from(u32::try_from(id % (1 << 32)).unwrap_or(0).to_be_bytes());
        Self {
            id,
            who: Refusal {
                client,
                untrusted_forwarded: false,
                proxy_keyed: false,
            },
            queue,
            closing: watch::Sender::new(None),
        }
    }
}

/// Which protocol a socket speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Api {
    /// Ours, at `/app/ws`.
    App,
    /// mempool.space's, at `/api/v1/ws` (`v1.rs`).
    V1,
}

impl Api {
    fn name(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::V1 => "v1",
        }
    }
}

/// `GET /app/ws`: checks the handshake and the caps, answers `101`, and runs the socket.
pub async fn handle(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<limits::Client>,
    req: Request,
) -> Response {
    upgrade(ctx, &client, req, Api::App)
}

/// Checks the handshake, the origin (`/app/ws` only) and `api`'s caps, answers `101`, and runs
/// the socket.
pub(crate) fn upgrade(
    ctx: Arc<NetworkContext>,
    client: &limits::Client,
    mut req: Request,
    api: Api,
) -> Response {
    let accept = match handshake(req.headers()) {
        Ok(accept) => accept,
        Err(e) => return e.into_response(),
    };
    let sockets = Arc::clone(&ctx.sockets);
    // A public API is meant for other sites' pages: its own pools below stand in for this rule.
    if api == Api::App
        && let Err((origin, host)) = same_origin(req.headers())
    {
        let total = sockets.origin_refused.fetch_add(1, Ordering::Relaxed) + 1;
        if total.is_power_of_two() {
            logging::emit(&logging::events::WsOriginRefused {
                network: ctx.config.network.name(),
                origin,
                host,
                total,
            });
        }
        return refused(ORIGIN_REFUSED, "origin");
    }
    let limits = &sockets.limits;
    let (permits, held, max, server_cap, client_cap) = match api {
        Api::App => (
            &sockets.permits,
            Held::Socket,
            limits.client_max_sockets,
            "server_sockets",
            "client_sockets",
        ),
        Api::V1 => (
            &sockets.v1_permits,
            Held::V1Socket,
            limits.v1_client_max_sockets,
            "v1_server_sockets",
            "v1_client_sockets",
        ),
    };
    // Each cap names itself in the request log, as every other limit does.
    let Ok(permit) = Arc::clone(permits).try_acquire_owned() else {
        return refused(ApiError::OVERLOADED, server_cap);
    };
    let hold = match client.hold(held, max) {
        Ok(hold) => hold,
        Err(r) if r.reason == "client_concurrency" => return refused(r.error, client_cap),
        Err(r) => return r.into_response(),
    };
    let who = client.who;
    let upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        if let Ok(io) = upgrade.await {
            run(ctx, TokioIo::new(io), (permit, hold), who, api).await;
        }
    });
    let mut res = StatusCode::SWITCHING_PROTOCOLS.into_response();
    let h = res.headers_mut();
    h.insert(UPGRADE, HeaderValue::from_static("websocket"));
    h.insert(CONNECTION, HeaderValue::from_static("Upgrade"));
    h.insert(SEC_WEBSOCKET_ACCEPT, accept);
    res
}

const ORIGIN_REFUSED: ApiError = ApiError::new(
    StatusCode::FORBIDDEN,
    "websocket refused: Origin is not this site",
);

/// `/app` is our frontend's private API, so a browser may open a socket only from a page of this
/// site; otherwise any page could use up its visitors' per-client socket allowance (SECURITY.md
/// rule 21). Same site means the `Origin` header's host and port equal the `Host` header's, the
/// name the browser used to reach us, whatever the scheme (TLS ends at the proxy). That holds for
/// every host name the site answers to, as long as the proxy passes `Host` through. A request
/// without `Origin` is not from a browser, which always sends it, so no third party can make a
/// visitor send one; it is allowed. On refusal, the origin and host, cut short, for the log.
fn same_origin(h: &HeaderMap) -> Result<(), (String, String)> {
    let mut origins = h.get_all(ORIGIN).iter();
    let Some(origin) = origins.next() else {
        return Ok(());
    };
    let text = |v: Option<&HeaderValue>| {
        let s = v
            .map(|v| String::from_utf8_lossy(v.as_bytes()))
            .unwrap_or_default();
        s.chars().take(100).collect::<String>()
    };
    let host = h.get(HOST);
    let site = |origin: &HeaderValue| {
        let origin = origin.to_str().ok()?;
        let (authority, default_port) = match origin.split_once("://")? {
            ("http", a) => (a, ":80"),
            ("https", a) => (a, ":443"),
            _ => return None,
        };
        let host = host?.to_str().ok()?;
        let norm = |a: &str| {
            let a = a.to_ascii_lowercase();
            a.strip_suffix(default_port).map(str::to_owned).unwrap_or(a)
        };
        (!authority.is_empty() && norm(authority) == norm(host)).then_some(())
    };
    if origins.next().is_none() && site(origin).is_some() {
        return Ok(());
    }
    Err((text(Some(origin)), text(host)))
}

fn refused(error: ApiError, reason: &'static str) -> Response {
    Refused { error, reason }.into_response()
}

/// Validates an opening handshake (RFC 6455 section 4.2.1) and returns the accept header.
fn handshake(h: &HeaderMap) -> Result<HeaderValue, ApiError> {
    let has_token = |name, token: &str| {
        h.get_all(name).iter().any(|v| {
            v.to_str()
                .is_ok_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case(token)))
        })
    };
    if !has_token(UPGRADE, "websocket") || !has_token(CONNECTION, "upgrade") {
        return Err(ApiError::bad_request("websocket upgrade required"));
    }
    if h.get("sec-websocket-version").map(HeaderValue::as_bytes) != Some(b"13") {
        return Err(ApiError::bad_request("websocket version 13 required"));
    }
    let key = h
        .get(SEC_WEBSOCKET_KEY)
        .map(HeaderValue::as_bytes)
        .filter(|k| frame::valid_key(k))
        .ok_or(ApiError::bad_request("invalid websocket key"))?;
    HeaderValue::from_str(&frame::accept_key(key)).map_err(|_| ApiError::INTERNAL)
}

/// Runs one upgraded connection to its end. `slots` (the total and per-client caps) are held
/// until then.
async fn run<S>(
    ctx: Arc<NetworkContext>,
    io: S,
    slots: (OwnedSemaphorePermit, Hold),
    who: Refusal,
    api: Api,
) where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let sockets = &ctx.sockets;
    let limits = &sockets.limits;
    let opened = Instant::now();

    let (queue, mut outbox) = mpsc::channel(limits.send_queue);
    let (closing, mut close_rx) = watch::channel(None);
    let conn = Arc::new(Conn {
        id: sockets.next_id.fetch_add(1, Ordering::Relaxed),
        who,
        queue,
        closing,
    });
    // The conformance suite expects a socket to stay silent until it is sent something; the
    // mempool.space protocol has no greeting.
    if !cfg!(feature = "autobahn") && api == Api::App {
        conn.send(hello(&ctx));
    }
    let reader = match api {
        Api::App => Reader::App(Subscriptions::new(&ctx.track, &conn)),
        Api::V1 => Reader::V1(v1::Session::new(&ctx, &conn)),
    };

    let (rd, mut wr) = tokio::io::split(io);
    // Milliseconds since `opened` of the last complete frame from the client.
    let last_seen = AtomicU64::new(0);
    let mut reading = pin!(read_loop(rd, reader, &conn, limits, opened, &last_seen));
    let mut watchdog = pin!(watchdog(
        &conn,
        limits.idle_timeout,
        opened,
        &last_seen,
        sockets.shutdown.subscribe()
    ));
    let mut writing = pin!(async {
        loop {
            tokio::select! {
                biased;
                () = until(&mut close_rx, Option::is_some) => break,
                frame = outbox.recv() => match frame {
                    Some(f) => {
                        if wr.write_all(f.as_bytes()).await.is_err() {
                            conn.close(Close::GONE);
                            return;
                        }
                    }
                    None => return,
                },
            }
        }
        if let Some(reason) = conn.reason().filter(|r| *r != Close::GONE) {
            let _ = wr.write_all(Frame::close(reason).as_bytes()).await;
        }
        let _ = wr.shutdown().await;
    });

    let lifecycle = async {
        let mut read_done = false;
        loop {
            tokio::select! {
                () = &mut writing => break,
                () = &mut reading, if !read_done => read_done = true,
                () = &mut watchdog => {}
            }
        }
        if !read_done {
            // Let the client's close frame arrive, so closing does not reset what it has not read.
            let _ = tokio::time::timeout(CLOSE_GRACE, reading).await;
        }
    };
    // A client that reads slowly enough to keep a write making progress must not outlive shutdown.
    tokio::select! {
        () = lifecycle => {}
        () = sockets.expired() => {
            conn.close(Close::GOING_AWAY);
        }
    }

    let reason = conn.reason().unwrap_or(Close::GONE);
    drop(slots);
    let network = ctx.config.network.name();
    logging::emit(&logging::events::WsClosed {
        network,
        api: api.name(),
        code: reason.code,
        reason: reason.label,
        duration_ms: opened.elapsed().as_secs_f64() * 1000.0,
        open: sockets.open(),
    });
    if reason.is_limit() {
        ctx.hub.dropped(reason);
    }
}

fn hello(ctx: &NetworkContext) -> Frame {
    let tip = ctx
        .electrum
        .tip()
        .map(|t| json!({ "height": t.height, "hash": t.hash }));
    let msg = json!({
        "type": "hello",
        "v": VERSION,
        "network": ctx.config.network.name(),
        "tip": tip,
    });
    Frame::text(msg.to_string().as_bytes())
}

/// What a client may send, as JSON text.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum ClientMessage {
    Subscribe { topics: Vec<String> },
    Unsubscribe { topics: Vec<String> },
    Ping,
}

/// What handles a socket's client messages: its protocol and its subscriptions.
enum Reader<'a> {
    App(Subscriptions<'a>),
    V1(v1::Session<'a>),
}

impl Reader<'_> {
    fn handle(&mut self, text: &str, limits: &WsLimits) -> Result<(), Close> {
        match self {
            Self::App(s) => s.handle(text, limits),
            Self::V1(s) => s.handle(text, limits),
        }
    }
}

/// Reads and handles client messages until the connection must close, then sets why.
async fn read_loop<R: AsyncRead>(
    rd: R,
    mut subs: Reader<'_>,
    conn: &Arc<Conn>,
    limits: &WsLimits,
    opened: Instant,
    last_seen: &AtomicU64,
) {
    let mut rd = pin!(rd);
    let rate = f64::from(limits.messages_per_sec);
    let (mut tokens, mut refilled) = (rate, Instant::now());
    let mut partial: Option<Vec<u8>> = None;
    let reason = loop {
        let f = match frame::read(&mut rd, limits.max_message_bytes).await {
            Ok(f) => f,
            Err(close) => break close,
        };
        let now = Instant::now();
        last_seen.store(millis(now - opened), Ordering::Relaxed);
        tokens = (tokens + now.duration_since(refilled).as_secs_f64() * rate).min(rate);
        refilled = now;
        if tokens < 1.0 {
            break Close::RATE;
        }
        tokens -= 1.0;

        let text = match (f.opcode, partial.as_mut()) {
            (frame::PING, _) => {
                conn.send(Frame::pong(&f.payload));
                continue;
            }
            (frame::PONG, _) => continue,
            (frame::CLOSE, _) => break peer_close(&f.payload),
            (frame::BINARY, None) => break Close::UNSUPPORTED,
            (frame::TEXT, None) if f.fin => f.payload,
            (frame::TEXT, None) => {
                partial = Some(f.payload);
                continue;
            }
            (frame::CONTINUATION, Some(buf)) => {
                if let Err(close) = append(buf, &f.payload, limits.max_message_bytes) {
                    break close;
                }
                if !f.fin {
                    continue;
                }
                partial.take().unwrap_or_default()
            }
            // A continuation with nothing to continue, or a new message inside a fragmented one.
            _ => break Close::PROTOCOL,
        };
        let Ok(text) = String::from_utf8(text) else {
            break Close::INVALID_UTF8;
        };
        if let Err(close) = subs.handle(&text, limits) {
            break close;
        }
    };
    conn.close(reason);
}

/// Adds a fragment to a message being reassembled. The buffer grows by doubling, as a `Vec`
/// does, but never past `max`, so a message's memory stays within the limit.
fn append(buf: &mut Vec<u8>, more: &[u8], max: usize) -> Result<(), Close> {
    let len = buf.len() + more.len();
    if len > max {
        return Err(Close::TOO_BIG);
    }
    if len > buf.capacity() {
        buf.reserve_exact(buf.capacity().saturating_mul(2).max(len).min(max) - buf.len());
    }
    buf.extend_from_slice(more);
    Ok(())
}

/// What to answer a client's close frame with: its status must be one an endpoint may send
/// (RFC 6455 section 7.4) and its reason UTF-8.
fn peer_close(payload: &[u8]) -> Close {
    match payload {
        [] => Close::NORMAL,
        [hi, lo, reason @ ..] => {
            let code = u16::from_be_bytes([*hi, *lo]);
            if !matches!(code, 1000..=1003 | 1007..=1014 | 3000..=4999) {
                Close::PROTOCOL
            } else if std::str::from_utf8(reason).is_err() {
                Close::INVALID_UTF8
            } else {
                Close::NORMAL
            }
        }
        [_] => Close::PROTOCOL,
    }
}

/// A connection's subscriptions, removed from the hub when the connection ends.
pub(crate) struct Subscriptions<'a> {
    track: &'a Arc<Tracking>,
    conn: &'a Arc<Conn>,
    topics: HashSet<Topic>,
}

impl<'a> Subscriptions<'a> {
    pub(crate) fn new(track: &'a Arc<Tracking>, conn: &'a Arc<Conn>) -> Self {
        Self {
            track,
            conn,
            topics: HashSet::new(),
        }
    }

    /// A topic name, strictly: a fixed topic, or a tracked transaction or address of this
    /// network. Returns the topic and its name as the server writes it.
    fn parse(&self, name: &str) -> Result<(Topic, String), Close> {
        Topic::parse(name)
            .map(|t| (t, String::new()))
            .or_else(|| track::parse(name, self.track.hub().network()))
            .ok_or(Close::BAD_MESSAGE)
    }

    fn leave(&self, topic: Topic) {
        if track::tracked(topic) {
            self.track.unsubscribe(topic, self.conn.id);
        } else {
            self.track.hub().unsubscribe(topic, self.conn.id);
        }
    }

    /// Subscribes to `topic` unless it already is, within the per-connection caps; over one,
    /// `Err` with the close code `/app/ws` uses. `Ok(Some(why))` when tracking declined it (the
    /// server's total, or the client's budget for new addresses): on `/app/ws` the client has
    /// been told, and stays.
    pub(crate) fn join(
        &mut self,
        topic: Topic,
        name: &str,
        limits: &WsLimits,
    ) -> Result<Option<track::Declined>, Close> {
        if self.topics.contains(&topic) {
            return Ok(None);
        }
        let count = |f: fn(&Topic) -> bool| self.topics.iter().filter(|t| f(t)).count();
        let blocks = |t: &Topic| matches!(t, Topic::ProjectedTxs(_));
        let txs = |t: &Topic| matches!(t, Topic::Tx(_) | Topic::V1Tx(_));
        let addresses = |t: &Topic| {
            matches!(
                t,
                Topic::Address(_) | Topic::V1Address(_) | Topic::V1Addresses(_)
            )
        };
        if self.topics.len() >= limits.max_subscriptions
            || blocks(&topic) && count(blocks) >= limits.max_block_subscriptions
            || txs(&topic) && count(txs) >= limits.max_tracked_txs
            || addresses(&topic) && count(addresses) >= limits.max_tracked_addresses
        {
            return Err(Close::TOO_MANY_SUBSCRIPTIONS);
        }
        if track::tracked(topic) {
            // Beyond the server's total or the client's budget it is told so, and stays connected.
            if let Err(why) = self.track.subscribe(topic, name, self.conn) {
                return Ok(Some(why));
            }
        } else {
            self.track.hub().subscribe(topic, self.conn);
        }
        self.topics.insert(topic);
        Ok(None)
    }

    /// Unsubscribes from `topic`, if subscribed.
    pub(crate) fn part(&mut self, topic: Topic) {
        if self.topics.remove(&topic) {
            self.leave(topic);
        }
    }

    pub(crate) fn conn(&self) -> &'a Arc<Conn> {
        self.conn
    }

    pub(crate) fn track(&self) -> &'a Arc<Tracking> {
        self.track
    }

    fn handle(&mut self, text: &str, limits: &WsLimits) -> Result<(), Close> {
        // Echo for the conformance suite (dev/autobahn): its cases expect each message back.
        if cfg!(feature = "autobahn") {
            self.conn.send(Frame::text(text.as_bytes()));
            return Ok(());
        }
        let request: ClientMessage = serde_json::from_str(text).map_err(|_| Close::BAD_MESSAGE)?;
        match request {
            ClientMessage::Subscribe { topics } => {
                for name in topics {
                    let (topic, name) = self.parse(&name)?;
                    self.join(topic, &name, limits)?;
                }
            }
            ClientMessage::Unsubscribe { topics } => {
                for name in topics {
                    let (topic, _) = self.parse(&name)?;
                    self.part(topic);
                }
            }
            ClientMessage::Ping => {
                self.conn.send(Frame::text(br#"{"type":"pong"}"#));
            }
        }
        Ok(())
    }
}

impl Drop for Subscriptions<'_> {
    fn drop(&mut self) {
        for topic in std::mem::take(&mut self.topics) {
            self.leave(topic);
        }
    }
}

/// Pings a client quiet for half of `idle`, closes one quiet for all of it, and closes every
/// socket on shutdown. Never returns; the connection ends when its writer does.
async fn watchdog(
    conn: &Conn,
    idle: Duration,
    opened: Instant,
    last_seen: &AtomicU64,
    mut shutdown: watch::Receiver<bool>,
) {
    // Ticks a quarter apart always land one in [idle/2, 3·idle/4), so the ping goes out before
    // the close and the client has at least a quarter of `idle` to answer it.
    let tick = idle / 4;
    // The `last_seen` value at which we last pinged: one ping per quiet spell.
    let mut pinged_at = None;
    loop {
        tokio::select! {
            () = tokio::time::sleep(tick) => {}
            () = until(&mut shutdown, |s| *s) => {
                conn.close(Close::GOING_AWAY);
                std::future::pending::<()>().await;
            }
        }
        let seen = last_seen.load(Ordering::Relaxed);
        let quiet = Duration::from_millis(millis(opened.elapsed()).saturating_sub(seen));
        if quiet >= idle {
            conn.close(Close::IDLE);
        } else if quiet >= idle / 2 && pinged_at != Some(seen) {
            pinged_at = Some(seen);
            conn.send(Frame::ping());
        }
    }
}

/// Waits until `rx` holds a value matching `f`, or its sender is gone. Holds no borrow afterwards.
async fn until<T>(rx: &mut watch::Receiver<T>, f: impl FnMut(&T) -> bool) {
    let _ = rx.wait_for(f).await;
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests;
