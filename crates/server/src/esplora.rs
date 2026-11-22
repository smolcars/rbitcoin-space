//! The Esplora pass-through at `/api` (`docs/API.md`).
//!
//! Every request is parsed into a typed [`Route`] before anything reaches the node, and the
//! upstream path, query and body are written from that value alone (SECURITY.md rules 1–3).
//! Identical reads share one upstream call and the hottest tip-scoped answers are reused for
//! [`HOT_TTL`] (rule 8). Broadcast is the only write (rule 5).

use std::collections::HashMap;
use std::future::Future;
use std::str::FromStr;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::Extension;
use axum::body::{Body, Bytes};
use axum::extract::{FromRequest, Request, State};
use axum::http::header::{ALLOW, CACHE_CONTROL, CONTENT_TYPE, RETRY_AFTER};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use bitcoin::address::NetworkUnchecked;
use bitcoin::{Address, BlockHash, PublicKey, ScriptBuf, Transaction, Txid};
use node::esplora::{
    BlockTxsStart, Error, Esplora, OutPosition, OutPositions, RawResponse, Route, ScriptHash,
    ScriptRef, ScriptSize,
};
use tokio::sync::{OnceCell, Semaphore, watch};

use crate::config::{Limits, Network};
use crate::ledger;
use crate::limits::{Client, Clients, Held, Refused};
use crate::verdicts::{self, Verdict, Verdicts};
use crate::{ApiError, IMMUTABLE, NetworkContext};

/// How long the hot tip-scoped answers ([`is_hot`]) are reused.
pub const HOT_TTL: Duration = Duration::from_secs(1);
/// Everything that is not content-addressed may change with the next block or mempool update.
pub const LIVE: &str = "public, max-age=1";
/// Largest transaction broadcast accepts: no standard transaction weighs more than 400,000
/// weight units, and a transaction's size in bytes never exceeds its weight.
pub const MAX_TX_BYTES: usize = 400_000;
/// Body limit of both broadcast routes. Hex doubles the size; the slack covers JSON framing.
pub const MAX_BROADCAST_BODY: usize = 2 * MAX_TX_BYTES + 16;
/// Broadcasts per client: a burst of this many, then one per [`BROADCAST_EVERY`].
pub const BROADCAST_BURST: u32 = 5;
pub const BROADCAST_EVERY: Duration = Duration::from_secs(10);
/// The node takes at most this many txids on `/txs/outspends`.
pub const MAX_OUTSPENDS_TXIDS: usize = 50;

const CHAIN_TIP: HeaderName = HeaderName::from_static("x-bitcoin-chain-tip");
const CHAIN_TIP_HEIGHT: HeaderName = HeaderName::from_static("x-bitcoin-chain-tip-height");

/// Heavy calls ([`is_heavy`]) running on the node at once, per network.
pub const HEAVY_RUNNING: usize = 4;
/// Heavy calls running or waiting for one of those slots, per network. Past it: `503` at once.
/// At 1 to 2 s each for a busy address, the last in line still answers inside the request timeout.
pub const HEAVY_PENDING: usize = 12;

/// One client's share of heavy calls, from its general per-client limits, so a deployment that
/// raises those for many users behind one address raises this too. By default 4 running or
/// waiting (two address pages at once), 30 at once and then 2 a second (an address page costs 2).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HeavyShare {
    pub pending: u32,
    pub burst: u32,
    pub per_sec: f64,
}

impl HeavyShare {
    pub fn of(limits: &Limits) -> Self {
        Self {
            pending: (limits.client_requests / 12).max(2),
            burst: (limits.client_burst / 4).max(2),
            per_sec: (f64::from(limits.client_rate_per_sec) / 10.0).max(0.5),
        }
    }
}

/// How long a heavy call is counted as running when the node does not answer: well past the
/// request timeout, because the node may keep working after we stop waiting.
pub const HEAVY_CEILING: Duration = Duration::from_secs(60);

/// Per-network state of the pass-through, held in [`NetworkContext`].
#[derive(Debug)]
pub struct Api {
    pub(crate) flights: Flights,
    /// `None` when broadcast is switched off (`BROADCAST_ENABLED=false`).
    broadcast: Option<Arc<Clients>>,
    heavy: Heavy,
    /// Address histories the node will not finish, learned from its answers.
    pub verdicts: Arc<Verdicts>,
}

/// The cost limit of heavy calls (SECURITY.md rules 8 and 11).
struct Heavy {
    running: Arc<Semaphore>,
    pending: Arc<Semaphore>,
    clients: Arc<Clients>,
    share: HeavyShare,
    /// Heavy calls admitted and not yet answered, by key. Each is driven by its own task, never
    /// by a request, so a request that times out cannot hand the call to another.
    calls: Arc<HeavyCalls>,
    /// Its own client, whose timeout is [`HEAVY_CEILING`], so a call is not abandoned (and its
    /// slot freed) while the node may still be working on it.
    esplora: Esplora,
    /// How long a page of address history may take before its requests are answered `504`.
    history_timeout: Duration,
}

impl std::fmt::Debug for Heavy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Heavy")
            .field("running", &self.running)
            .finish_non_exhaustive()
    }
}

impl Api {
    /// How long a page of address history may take before it is answered `504` and remembered as
    /// slow ([`Verdict::Slow`]).
    pub fn history_timeout(&self) -> Duration {
        self.heavy.history_timeout
    }

    /// `url` is the network's Esplora endpoint, checked by `Config`.
    pub fn new(broadcast: bool, limits: &Limits, url: &str) -> Result<Self, Error> {
        let max_tracked_clients = limits.max_tracked_clients;
        let share = HeavyShare::of(limits);
        let rate = 1.0 / BROADCAST_EVERY.as_secs_f64();
        Ok(Self {
            flights: Flights::default(),
            broadcast: broadcast
                .then(|| Clients::with_rate(rate, BROADCAST_BURST, max_tracked_clients)),
            heavy: Heavy {
                running: Arc::new(Semaphore::new(HEAVY_RUNNING)),
                pending: Arc::new(Semaphore::new(HEAVY_PENDING)),
                calls: Arc::default(),
                clients: Clients::with_rate(share.per_sec, share.burst, max_tracked_clients),
                share,
                esplora: Esplora::with_limits(url, HEAVY_CEILING, Esplora::DEFAULT_MAX_RESPONSE)?,
                history_timeout: limits.history_timeout,
            },
            verdicts: Arc::default(),
        })
    }
}

/// What the pass-through did for one request that reached the node, attached to the response as
/// an extension for the request log. Requests refused before that carry none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApiOutcome {
    /// The matched route, for example `tx_status`.
    pub route: &'static str,
    pub source: Source,
    /// Why the upstream call failed, when it did not get an answer: `timeout`, `unavailable`,
    /// `response_too_big` or `decode`. A non-200 answer from the node is not a failure here.
    pub upstream_error: Option<&'static str>,
}

/// Where a response's upstream answer came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// This request made the one upstream call, which took this long.
    Upstream(Duration),
    /// It joined an identical call already in flight: no upstream call of its own.
    Coalesced,
    /// It got a hot answer younger than [`HOT_TTL`]: no upstream call.
    Hot,
    /// From memory: the summary cache (`crate::summary`) or a kept answer (`crate::answers`).
    /// No upstream call and no store read.
    Cached,
    /// Block facts from the block table (`crate::blocks`): no upstream call.
    Stored,
}

/// What a request asks for, once its path and query have parsed.
#[derive(Debug, PartialEq)]
enum Call {
    Read(Route),
    /// `POST /tx`; the body is parsed by the handler.
    Broadcast,
    BlindbitForwardTx,
    /// `POST /block-heights/txs/outs`; the body is parsed by the handler.
    Outputs {
        asof: Option<BlockHash>,
    },
}

/// Handles everything under `/api/` that no other route claimed.
pub async fn handle(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<Client>,
    req: Request,
) -> Response {
    match serve(&ctx, &client, req).await {
        Ok(res) => res,
        Err(e) => e.into_response(),
    }
}

async fn serve(ctx: &NetworkContext, client: &Client, req: Request) -> Result<Response, ApiError> {
    let path = req
        .uri()
        .path()
        .strip_prefix("/api/")
        .ok_or(ApiError::NOT_FOUND)?;
    let call = parse(path, req.uri().query(), ctx.config.network)?;
    let reading = matches!(call, Call::Read(_));
    let method = req.method();
    let allowed = if reading {
        method == Method::GET || method == Method::HEAD
    } else {
        method == Method::POST
    };
    if !allowed {
        let mut res =
            ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "method not allowed").into_response();
        let allow = if reading { "GET, HEAD" } else { "POST" };
        res.headers_mut()
            .insert(ALLOW, HeaderValue::from_static(allow));
        return Ok(res);
    }
    match call {
        Call::Read(route) => Ok(read(ctx, client, route).await),
        Call::Outputs { asof } => {
            let body = read_body(req).await?;
            let positions: Vec<[u32; 3]> = serde_json::from_slice(&body).map_err(|_| {
                ApiError::bad_request("body must be a JSON array of [height, index, vout]")
            })?;
            let positions = positions
                .into_iter()
                .map(|[height, index, vout]| OutPosition {
                    height,
                    index,
                    vout,
                })
                .collect();
            let positions = OutPositions::new(positions).ok_or(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "at most 300 positions",
            ))?;
            Ok(read(ctx, client, Route::OutputsAt { positions, asof }).await)
        }
        Call::Broadcast | Call::BlindbitForwardTx => {
            let limiter = ctx.api.broadcast.as_ref().ok_or(ApiError::new(
                StatusCode::FORBIDDEN,
                "broadcast is disabled on this server",
            ))?;
            if let Err(e) = limiter.take(client.addr) {
                let mut res = e.into_response();
                res.headers_mut()
                    .insert(RETRY_AFTER, HeaderValue::from(BROADCAST_EVERY.as_secs()));
                return Ok(res);
            }
            let body = read_body(req).await?;
            let route = if matches!(call, Call::BlindbitForwardTx) {
                #[derive(serde::Deserialize)]
                #[serde(deny_unknown_fields)]
                struct ForwardTx {
                    data: String,
                }
                let forward: ForwardTx = serde_json::from_slice(&body).map_err(|_| {
                    ApiError::bad_request("body must be a JSON object with data transaction hex")
                })?;
                Route::BlindbitForwardTx(parse_tx(forward.data.as_bytes())?)
            } else {
                Route::Broadcast(parse_tx(&body)?)
            };
            let started = Instant::now();
            let answer = ctx.esplora.raw(&route).await;
            Ok(respond(&route, answer, Source::Upstream(started.elapsed())))
        }
    }
}

/// The body, up to the route's `DefaultBodyLimit`: `MAX_BODY_BYTES`, or [`MAX_BROADCAST_BODY`].
async fn read_body(req: Request) -> Result<Bytes, ApiError> {
    Bytes::from_request(req, &()).await.map_err(|r| {
        if r.status() == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::PAYLOAD_TOO_LARGE
        } else {
            ApiError::bad_request("could not read the request body")
        }
    })
}

/// Raw transaction hex, optionally surrounded by whitespace, holding exactly one transaction.
pub(crate) fn parse_tx(body: &[u8]) -> Result<Transaction, ApiError> {
    let bad = || ApiError::bad_request("body must be one raw transaction in hex");
    let hex = std::str::from_utf8(body).map_err(|_| bad())?.trim();
    if hex.len() > 2 * MAX_TX_BYTES {
        return Err(ApiError::PAYLOAD_TOO_LARGE);
    }
    bitcoin::consensus::encode::deserialize_hex(hex).map_err(|_| bad())
}

async fn read(ctx: &NetworkContext, client: &Client, route: Route) -> Response {
    let mut key = String::with_capacity(160);
    route.write_path(&mut key);
    if let Some((body, _)) = route.body() {
        // Only the outputs batch gets here; its body is JSON we wrote ourselves.
        key.push('\n');
        key.push_str(&String::from_utf8_lossy(&body));
    }
    if is_heavy(&route) {
        if let Some(res) = guarded(ctx, client, &route, &key).await {
            return res;
        }
        if let Some((script, page)) = verdicts::history_page(&route)
            && let Some(verdict) = ctx.api.verdicts.check(script, page, Instant::now())
        {
            return refused_early(verdict);
        }
        return heavy(ctx, client, route, key).await;
    }
    let kept_key = block_of(&route).map(|_| kept_key(&route));
    if let Some(k) = &kept_key
        && let Some(kept) = ctx.answers.get(k, 0)
    {
        let mut res = kept.response(Some(Source::Cached));
        tip_headers(
            res.headers_mut(),
            ctx.electrum.tip().map(|t| (t.hash, t.height)),
        );
        return res;
    }
    let ttl = if is_hot(&route) {
        HOT_TTL
    } else {
        Duration::ZERO
    };
    let (answer, source) = ctx.api.flights.run(key, ttl, ctx.esplora.raw(&route)).await;
    let keep = kept_key.and_then(|k| Some((k, buried(ctx, &route, &answer)?)));
    let res = respond(&route, answer, source);
    if let Some((k, body)) = keep {
        let mut headers = res.headers().clone();
        // A kept answer is stamped with the tip when it is served, not when it was fetched.
        tip_headers(&mut headers, None);
        let outcome = res.extensions().get::<ApiOutcome>().copied();
        let kept = crate::answers::Kept::new(headers, body, outcome);
        ctx.answers.insert(k, 0, Arc::new(kept));
    }
    res
}

/// Blocks at least this far under the node's tip are taken never to leave the best chain: the
/// block table's own zone (`engine::blocks::ZONE`, 100 blocks). No reorg that deep has happened.
const BURIED: u32 = engine::blocks::ZONE;

/// The block an immutable block route is fixed by.
fn block_of(route: &Route) -> Option<BlockHash> {
    match route {
        Route::Block(h)
        | Route::BlockHeader(h)
        | Route::BlockRaw(h)
        | Route::BlockTxids(h)
        | Route::BlockTxid { hash: h, .. } => Some(*h),
        _ => None,
    }
}

/// Where the pass-through keeps a route's answer among the network's kept answers.
fn kept_key(route: &Route) -> String {
    let mut key = String::from("esplora ");
    route.write_path(&mut key);
    key
}

/// The two fields of a block's JSON that say which block it is and where.
#[derive(serde::Deserialize)]
struct Placed {
    id: BlockHash,
    height: u32,
}

/// The body to keep, when the node's answer is one we serve `immutable` and its block was at
/// least [`BURIED`] deep under the tip the node stamped it with. The node serves no block off
/// its best chain, so a block that leaves the chain before it is buried is never kept. The
/// height is the answer's own for the block JSON; for the block's other routes, the one in its
/// kept JSON or in the headers the `/api/v1` block routes hold.
fn buried(ctx: &NetworkContext, route: &Route, answer: &Answer) -> Option<Bytes> {
    let raw = answer.as_ref().ok()?;
    let (hash, tip) = (block_of(route)?, raw.tip?);
    if raw.status != StatusCode::OK || cache_control(route, &raw.body) != IMMUTABLE {
        return None;
    }
    let placed = |body: &[u8]| {
        serde_json::from_slice::<Placed>(body)
            .ok()
            .filter(|p| p.id == hash)
            .map(|p| p.height)
    };
    let height = match route {
        Route::Block(_) => placed(&raw.body)?,
        _ => match ctx.block_headers.height(&hash) {
            Some(h) => h,
            None => placed(ctx.answers.get(&kept_key(&Route::Block(hash)), 0)?.body())?,
        },
    };
    (height.saturating_add(BURIED) <= tip.height).then(|| raw.body.clone())
}

fn tip_headers(h: &mut axum::http::HeaderMap, tip: Option<(BlockHash, u32)>) {
    h.remove(CHAIN_TIP);
    h.remove(CHAIN_TIP_HEIGHT);
    if let Some((hash, height)) = tip
        && let Ok(v) = HeaderValue::from_str(&hash.to_string())
    {
        h.insert(CHAIN_TIP, v);
        h.insert(CHAIN_TIP_HEIGHT, HeaderValue::from(height));
    }
}

/// `GET /api/v1/blocks/tip/height`: `/blocks/tip/height`'s answer, sharing its calls and cache.
pub(crate) async fn tip_height(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<Client>,
) -> Response {
    read(&ctx, &client, Route::TipHeight).await
}

/// The node's JSON answer to a light read, through the same call sharing as the pass-through,
/// for routes built on it. Errors are the pass-through's.
pub(crate) async fn json<T: serde::de::DeserializeOwned>(
    ctx: &NetworkContext,
    route: Route,
) -> Result<(T, Source), ApiError> {
    let mut key = String::with_capacity(160);
    route.write_path(&mut key);
    let ttl = if is_hot(&route) {
        HOT_TTL
    } else {
        Duration::ZERO
    };
    let (answer, source) = ctx.api.flights.run(key, ttl, ctx.esplora.raw(&route)).await;
    let raw = answer.map_err(|e| upstream_error(&e, &route))?;
    if raw.status != StatusCode::OK {
        let e = Error::from_status(raw.status, &raw.body);
        return Err(upstream_error(&e, &route));
    }
    let value = serde_json::from_slice(&raw.body).map_err(|_| ApiError::UPSTREAM)?;
    Ok((value, source))
}

/// Routes whose cost on the node grows with the data behind them: an address's whole history
/// (seconds for a busy one), or a batch of lookups. `?asof=` makes every request a distinct key,
/// so sharing calls cannot bound them; [`heavy`] does.
fn is_heavy(route: &Route) -> bool {
    matches!(
        route,
        Route::ScriptStats { .. }
            | Route::ScriptUtxo { .. }
            | Route::ScriptTxs { .. }
            | Route::ScriptTxsChain { .. }
            | Route::ScriptTxsMempool(_)
            | Route::ScriptTxsSummary { .. }
            | Route::TxsOutspends(_)
            | Route::OutputsAt { .. }
    )
}

/// One heavy call's answer, once the node gives it. Requests for it subscribe.
type HeavyCall = Arc<watch::Sender<Option<(Answer, Duration)>>>;

type HeavyCalls = Mutex<HashMap<String, HeavyCall>>;

/// Removes `call` from `calls` unless a request still waits for it. Joining subscribes under the
/// same lock, so a request either joined before this (and the call goes on) or finds no call
/// and starts its own: it is never left on a call that ends without an answer.
fn finish(calls: &HeavyCalls, key: &str, call: &HeavyCall, abandon: bool) -> bool {
    let mut calls = calls.lock().unwrap_or_else(PoisonError::into_inner);
    if abandon && call.receiver_count() > 0 {
        return false;
    }
    if calls.get(key).is_some_and(|c| Arc::ptr_eq(c, call)) {
        calls.remove(key);
    }
    true
}

/// Removes a heavy call however its task ends. A task that panicked would otherwise leave its
/// call in the map with the map's sender open, so every later request for the key would join a
/// call that never answers.
struct Ended {
    calls: Arc<HeavyCalls>,
    key: String,
    call: HeavyCall,
}

impl Drop for Ended {
    fn drop(&mut self) {
        finish(&self.calls, &self.key, &self.call, false);
    }
}

/// A heavy read. Joining an identical call already admitted costs nothing. Starting one needs a
/// place among the network's [`HEAVY_PENDING`] and the client's [`HeavyShare`], or is refused at
/// once with a "retry" (`503` or `429`). Joining or starting is decided under one lock. The call
/// is a task of its own: it waits for one of the [`HEAVY_RUNNING`] slots, giving its places back
/// if every request for it has gone meanwhile, then asks the node and keeps its places until the
/// node answers or [`HEAVY_CEILING`] passes, even after every request waiting for it is gone.
///
/// A page of address history whose node call runs past the history timeout is answered `504` at
/// that moment and remembered, so it is refused at once for a while; its call keeps its places
/// until the node has finished. A totals, unspent or history answer the node refuses for size is
/// remembered too: that script's history is refused at once for the same while.
async fn heavy(ctx: &NetworkContext, client: &Client, route: Route, key: String) -> Response {
    let call = route.clone();
    let deadline = verdicts::history_page(&route).map(|(script, page)| {
        let verdicts = Arc::clone(&ctx.api.verdicts);
        Deadline {
            after: ctx.api.heavy.history_timeout,
            then: Box::new(move || verdicts.learn(script, page, Verdict::Slow, Instant::now())),
            started: None,
        }
    });
    // Learned in the call's own task, so a client that hangs up first does not lose it. The node
    // refuses a page for size as it refuses totals, with the script's counts.
    let size = verdicts::unpaged_script(&route)
        .or_else(|| verdicts::history_page(&route).map(|(s, _)| s))
        .map(|s| (s, Arc::clone(&ctx.api.verdicts)));
    let known = verdicts::history_page(&route).map(|p| (p, Arc::clone(&ctx.api.verdicts)));
    match heavy_call(ctx, client, key, deadline, move |esplora| async move {
        // A verdict learned while this call waited for its slot still spares the node.
        if let Some(((script, page), verdicts)) = known
            && let Some(verdict) = verdicts.check(script, page, Instant::now())
        {
            return Err(match verdict {
                Verdict::TooLarge(_) | Verdict::Large | Verdict::Small => Error::TooLarge,
                Verdict::Slow => Error::Timeout,
            });
        }
        let answer = esplora.raw(&call).await;
        if let Some((script, verdicts)) = size
            && let Ok(raw) = &answer
            && Error::from_status(raw.status, &raw.body) == Error::TooLarge
        {
            let size = ScriptSize::from_refusal(&raw.body);
            verdicts.learn(script, None, Verdict::TooLarge(size), Instant::now());
        }
        answer
    })
    .await
    {
        // Refused by a verdict learned while it waited: counted as a refusal, like one refused on
        // arrival. The node's own refusal is an answer, not this error, and a page it timed out on
        // took the whole history timeout, so neither is taken for the other.
        Ok((Err(Error::TooLarge), _)) if verdicts::history_page(&route).is_some() => {
            refused_early(Verdict::TooLarge(None))
        }
        Ok((Err(Error::Timeout), Source::Upstream(took)))
            if took < ctx.api.heavy.history_timeout && verdicts::history_page(&route).is_some() =>
        {
            refused_early(Verdict::Slow)
        }
        Ok((result, source)) => respond(&route, result, source),
        Err(refused) => *refused,
    }
}

/// The address routes the large-address guard decides (docs/API.md, "Very large addresses"), or
/// `None` to go on as for any heavy route. A tracked script's totals come from the ledger; its
/// history, unspent outputs and pinned totals, and a large script's anything, are refused at
/// once. Totals or unspent outputs of a script not known to be small go through the guard's lane,
/// one such call at the node for the whole server, and teach the server its size.
async fn guarded(
    ctx: &NetworkContext,
    client: &Client,
    route: &Route,
    key: &str,
) -> Option<Response> {
    let history = verdicts::history_page(route).map(|(s, _)| s);
    let sh = history.or_else(|| verdicts::unpaged_script(route))?;
    let guard = &ctx.guard;
    let tracked = guard.ledger.as_ref().filter(|l| l.is_tracked(sh));
    if history.is_some() {
        // A kept address whose whole history the ledger holds is paged from the store.
        if let Some(l) = tracked
            && let Some(r) = crate::kept::page(ctx, client, l, sh, route, key).await
        {
            return Some(r);
        }
        return (tracked.is_some() || guard.known(sh) == Some(ledger::Size::Large))
            .then(|| refused_early(Verdict::Large));
    }
    if let (Some(ledger), Route::ScriptStats { script, asof: None }) = (tracked, route) {
        return Some(tracked_stats(ctx, client, ledger, sh, script, key).await);
    }
    if tracked.is_some() {
        return Some(
            Refused {
                error: NOT_KEPT,
                reason: "history_too_large",
            }
            .into_response(),
        );
    }
    match guard.known(sh) {
        Some(ledger::Size::Small) => return None,
        Some(ledger::Size::Large) => return Some(refused_early(Verdict::Large)),
        Some(ledger::Size::TooLarge) | None => {}
    }
    // An address or a public key gives the script, so the ledger can adopt the answer.
    let script = match route {
        Route::ScriptStats { script, .. } | Route::ScriptUtxo { script, .. } => {
            script.script_pubkey()
        }
        _ => None,
    };
    let (g, call) = (Arc::clone(guard), route.clone());
    // The reader's deadline, from when the lane is taken; the guard learns the size from the
    // node's own time.
    let (asked, started) = tokio::sync::oneshot::channel();
    let deadline = Deadline {
        after: ctx.api.heavy.history_timeout,
        then: Box::new(|| ()),
        started: Some(started),
    };
    // Identical requests share the call; only its leader waits for the lane.
    let answer = heavy_call(
        ctx,
        client,
        key.to_owned(),
        Some(deadline),
        move |_| async move { g.ask(&call, sh, script, Some(asked)).await },
    )
    .await;
    Some(match answer {
        Ok((Err(Error::TooLarge), _)) => refused_early(Verdict::Large),
        Ok((Err(Error::Unavailable(m)), _)) if m == ledger::LANE_BUSY => {
            if guard.known(sh) == Some(ledger::Size::Large) {
                refused_early(Verdict::Large)
            } else {
                Refused {
                    error: HEAVY_BUSY,
                    reason: "lane_busy",
                }
                .into_response()
            }
        }
        Ok((result, source)) => respond(route, result, source),
        Err(refused) => *refused,
    })
}

/// A tracked script's totals from the ledger, with its unconfirmed ones from the node's mempool
/// rows for it: one cheap call under the cost limit, shared by identical requests.
async fn tracked_stats(
    ctx: &NetworkContext,
    client: &Client,
    ledger: &Arc<ledger::Ledger>,
    sh: ScriptHash,
    script: &ScriptRef,
    key: &str,
) -> Response {
    let Some(tracked) = ledger.totals(sh).await else {
        return ApiError::UPSTREAM.into_response();
    };
    let mempool = Route::ScriptTxsMempool(script.clone());
    let mut mkey = String::from("ledger-mempool:");
    mkey.push_str(key);
    let rows = match heavy_call(ctx, client, mkey, None, move |esplora| async move {
        esplora.raw(&mempool).await
    })
    .await
    {
        Ok((Ok(raw), _)) if raw.status == StatusCode::OK => {
            serde_json::from_slice::<Vec<node::esplora::model::Tx>>(&raw.body).ok()
        }
        Err(refused) => return *refused,
        _ => None,
    };
    let mut res = ledger::tracked_answer(script, &tracked, rows.as_deref());
    res.extensions_mut().insert(ApiOutcome {
        route: "address_stats",
        source: Source::Stored,
        upstream_error: None,
    });
    res
}

/// A tracked script's unspent outputs: the ledger keeps totals, not outputs.
pub(crate) const NOT_KEPT: ApiError = ApiError::new(
    StatusCode::SERVICE_UNAVAILABLE,
    "unspent outputs and older history are not kept for an address this large",
);

/// A history request refused from what the node said moments ago: no node call.
fn refused_early(verdict: Verdict) -> Response {
    match verdict {
        Verdict::TooLarge(_) | Verdict::Large | Verdict::Small => Refused {
            error: TOO_LARGE,
            reason: "history_too_large",
        },
        Verdict::Slow => Refused {
            error: ApiError::TIMEOUT,
            reason: "history_slow",
        },
    }
    .into_response()
}

/// The node refuses this address's totals for size, and the server its history with them.
const TOO_LARGE: ApiError = ApiError::new(
    StatusCode::SERVICE_UNAVAILABLE,
    "address history too large for this server",
);

/// When a call's requests stop waiting for the node, and what to do then. The call itself goes on.
pub(crate) struct Deadline {
    pub after: Duration,
    pub then: Box<dyn FnOnce() + Send>,
    /// When set, `after` counts from this signal, not from the call's start: a call that waits
    /// for something of its own (the large-address lane) before it asks the node.
    pub started: Option<tokio::sync::oneshot::Receiver<()>>,
}

/// [`heavy`] for any work on the node that one request causes: `fetch` is run with the heavy
/// calls' own client, under the same places and slot, by the same rules. Requests with the same
/// `key` share one run. Past a `deadline` after the node call starts, its requests get a timeout
/// while the call keeps its places until the node answers. A refusal is the response to send.
pub(crate) async fn heavy_call<F, Fut>(
    ctx: &NetworkContext,
    client: &Client,
    key: String,
    deadline: Option<Deadline>,
    fetch: F,
) -> Result<(Answer, Source), Box<Response>>
where
    F: FnOnce(Esplora) -> Fut + Send + 'static,
    Fut: Future<Output = Answer> + Send + 'static,
{
    let h = &ctx.api.heavy;
    let (mut answer, led) = {
        let mut calls = h.calls.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(call) = calls.get(&key) {
            (call.subscribe(), false)
        } else {
            let Ok(pending) = Arc::clone(&h.pending).try_acquire_owned() else {
                return Err(Box::new(
                    Refused {
                        error: HEAVY_BUSY,
                        reason: "heavy_busy",
                    }
                    .into_response(),
                ));
            };
            let hold = match h
                .clients
                .acquire(client.addr, Held::Request, h.share.pending, 1.0)
            {
                Ok(hold) => hold,
                Err(r) => {
                    let reason = match r.reason {
                        "client_rate" => "route_rate",
                        "client_concurrency" => "route_concurrency",
                        other => other,
                    };
                    return Err(Box::new(Refused { reason, ..r }.into_response()));
                }
            };
            let (tx, rx) = watch::channel(None);
            let tx = Arc::new(tx);
            calls.insert(key.clone(), Arc::clone(&tx));
            let running = Arc::clone(&h.running);
            let (esplora, all) = (h.esplora.clone(), Arc::clone(&h.calls));
            let ended = Ended {
                calls: Arc::clone(&all),
                key: key.clone(),
                call: Arc::clone(&tx),
            };
            tokio::spawn(async move {
                let _ended = ended;
                let slot = loop {
                    tokio::select! {
                        slot = Arc::clone(&running).acquire_owned() => break slot,
                        // Every request for it timed out while it waited: never call the node,
                        // unless one joined meanwhile.
                        () = tx.closed() => {
                            if finish(&all, &key, &tx, true) {
                                return;
                            }
                        }
                    }
                };
                let Ok(slot) = slot else {
                    return;
                };
                let called = Instant::now();
                let fetch = fetch(esplora);
                let answer = match deadline {
                    None => Some(fetch.await),
                    Some(Deadline {
                        after,
                        then,
                        started,
                    }) => {
                        tokio::pin!(fetch);
                        // Until the call says it has asked the node, its time does not count.
                        let early = match started {
                            Some(rx) => tokio::select! {
                                answer = &mut fetch => Some(answer),
                                _ = rx => None,
                            },
                            None => None,
                        };
                        if let Some(answer) = early {
                            Some(answer)
                        } else if let Ok(answer) = tokio::time::timeout(after, &mut fetch).await {
                            Some(answer)
                        } else {
                            then();
                            tx.send_replace(Some((Err(Error::Timeout), after)));
                            // The node is still working: hold the places until it answers.
                            drop(fetch.await);
                            None
                        }
                    }
                };
                let node_time = called.elapsed();
                drop((slot, pending, hold));
                finish(&all, &key, &tx, false);
                if let Some(answer) = answer {
                    tx.send_replace(Some((answer, node_time)));
                }
            });
            (rx, true)
        }
    };
    let (result, node_time) = match answer.wait_for(Option::is_some).await {
        Ok(a) => a
            .clone()
            .unwrap_or_else(|| (Err(Error::Unavailable("no answer".into())), Duration::ZERO)),
        Err(_) => (Err(Error::Unavailable("call ended".into())), Duration::ZERO),
    };
    // The node's own time, not the wait for a slot.
    let source = if led {
        Source::Upstream(node_time)
    } else {
        Source::Coalesced
    };
    Ok((result, source))
}

/// The network's heavy calls are all running: retry in a moment.
const HEAVY_BUSY: ApiError = ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "node busy; retry");

/// Fixed-key answers that every page polls and that cost the node 200–300 ms or more.
fn is_hot(route: &Route) -> bool {
    matches!(
        route,
        Route::TipHeight
            | Route::TipHash
            | Route::Blocks { start_height: None }
            | Route::Mempool
            | Route::MempoolTxids
            | Route::MempoolRecent
            | Route::FeeEstimates
    )
}

/// The node's answer as our response, with an [`ApiOutcome`] for the request log.
pub(crate) fn respond(route: &Route, answer: Answer, source: Source) -> Response {
    let upstream_error = answer.as_ref().err().map(|e| match e {
        Error::Timeout => "timeout",
        Error::ResponseTooBig => "response_too_big",
        Error::Decode(_) => "decode",
        _ => "unavailable",
    });
    let mut res = forward(route, answer).unwrap_or_else(IntoResponse::into_response);
    res.extensions_mut().insert(ApiOutcome {
        route: route_name(route),
        source,
        upstream_error,
    });
    res
}

/// Same status, body bytes and content type as the node for a 200; our own fixed message for
/// anything else (SECURITY.md rule 17).
fn forward(route: &Route, answer: Answer) -> Result<Response, ApiError> {
    let raw = answer.map_err(|e| upstream_error(&e, route))?;
    if raw.status != StatusCode::OK {
        if raw.status == StatusCode::SERVICE_UNAVAILABLE
            && matches!(
                Error::from_status(raw.status, &raw.body),
                Error::Unavailable(_)
            )
        {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "node unavailable",
            ));
        }
        return Err(upstream_error(
            &Error::from_status(raw.status, &raw.body),
            route,
        ));
    }
    let cache = cache_control(route, &raw.body);
    let mut res = Response::new(Body::from(raw.body));
    let h = res.headers_mut();
    if let Some(ct) = raw.content_type {
        h.insert(CONTENT_TYPE, ct);
    }
    if let Some(tip) = raw.tip {
        if let Ok(v) = HeaderValue::from_str(&tip.hash.to_string()) {
            h.insert(CHAIN_TIP, v);
        }
        h.insert(CHAIN_TIP_HEIGHT, HeaderValue::from(tip.height));
    }
    h.insert(CACHE_CONTROL, HeaderValue::from_static(cache));
    Ok(res)
}

/// Immutable only for answers fully determined by the hash in the URL, with no status in them.
fn cache_control(route: &Route, body: &[u8]) -> &'static str {
    match route {
        Route::Block(_)
        | Route::BlockHeader(_)
        | Route::BlockRaw(_)
        | Route::BlockTxids(_)
        | Route::BlockTxid { .. } => IMMUTABLE,
        // A txid does not commit to the witness, so a segwit transaction's bytes can still change
        // (a witness replacement, or a reorg). Only a transaction without a witness is fixed.
        // Byte 4 of a witness serialization is the 0x00 marker; otherwise it is the input count.
        Route::TxRaw(_) if body.get(4).is_some_and(|&b| b != 0) => IMMUTABLE,
        Route::TxHex(_) if body.get(8..10).is_some_and(|b| b != b"00") => IMMUTABLE,
        Route::Broadcast(_) | Route::BlindbitForwardTx(_) => "no-store",
        _ => LIVE,
    }
}

fn upstream_error(e: &Error, route: &Route) -> ApiError {
    let status = |s: StatusCode, m| ApiError::new(s, m);
    match e {
        Error::NotFound => ApiError::NOT_FOUND,
        Error::AddressIndexDisabled => status(
            StatusCode::SERVICE_UNAVAILABLE,
            "address index is disabled on this server",
        ),
        Error::TooLarge => TOO_LARGE,
        Error::ChainViewMoved => status(
            StatusCode::SERVICE_UNAVAILABLE,
            "chain tip moved during the request; retry",
        ),
        Error::Rejected { message, .. }
            if matches!(route, Route::Broadcast(_) | Route::BlindbitForwardTx(_)) =>
        {
            ApiError::bad_request(reject_reason(message))
        }
        Error::Rejected { status: s, .. } if *s == StatusCode::UNPROCESSABLE_ENTITY => {
            status(*s, "after_txid not found")
        }
        Error::Rejected { .. } => ApiError::bad_request("bad request"),
        Error::Timeout => ApiError::TIMEOUT,
        Error::Unavailable(_)
        | Error::ResponseTooBig
        | Error::Decode(_)
        | Error::Config(_)
        | Error::InternalUnavailable => ApiError::UPSTREAM,
    }
}

/// A stable name for the request log.
fn route_name(route: &Route) -> &'static str {
    use Route as R;
    match route {
        R::BlindbitInfo => "blindbit_info",
        R::BlindbitBlockHeight => "blindbit_block_height",
        R::BlindbitBlockHash(_) => "blindbit_block_hash",
        R::BlindbitTweaks { .. } => "blindbit_tweaks",
        R::BlindbitTweakIndex { .. } => "blindbit_tweak_index",
        R::BlindbitUtxos(_) => "blindbit_utxos",
        R::BlindbitSpentIndex(_) => "blindbit_spent_index",
        R::BlindbitFilterNewUtxos(_) => "blindbit_filter_new_utxos",
        R::BlindbitFilterSpent(_) => "blindbit_filter_spent",
        R::BlindbitForwardTx(_) => "blindbit_forward_tx",
        R::TipHeight => "tip_height",
        R::TipHash => "tip_hash",
        R::Blocks { .. } => "blocks",
        R::BlockHash(_) => "block_height",
        R::Block(_) => "block",
        R::BlockHeader(_) => "block_header",
        R::BlockStatus(_) => "block_status",
        R::BlockTxids(_) => "block_txids",
        R::BlockTxs { .. } => "block_txs",
        R::BlockRaw(_) => "block_raw",
        R::BlockTxid { .. } => "block_txid",
        R::Tx(_) => "tx",
        R::TxStatus { .. } => "tx_status",
        R::TxHex(_) => "tx_hex",
        R::TxRaw(_) => "tx_raw",
        R::TxMerkleProof(_) => "tx_merkle_proof",
        R::TxMerkleblockProof(_) => "tx_merkleblock_proof",
        R::TxOutspend { .. } => "tx_outspend",
        R::TxOutspends { .. } => "tx_outspends",
        R::TxsOutspends(_) => "txs_outspends",
        R::ScriptStats { .. } => "script_stats",
        R::ScriptUtxo { .. } => "script_utxo",
        R::ScriptTxs { .. } => "script_txs",
        R::ScriptTxsChain { .. } => "script_txs_chain",
        R::ScriptTxsMempool(_) => "script_txs_mempool",
        R::ScriptTxsSummary { .. } => "script_txs_summary",
        R::Mempool => "mempool",
        R::MempoolTxids => "mempool_txids",
        R::MempoolTxidsPage { .. } => "mempool_txids_page",
        R::MempoolRecent => "mempool_recent",
        R::FeeEstimates => "fee_estimates",
        R::Broadcast(_) => "broadcast",
        R::TxAt { .. } => "tx_at",
        R::TxOut { .. } => "tx_out",
        R::OutputAt { .. } => "output_at",
        R::OutputsAt { .. } => "outputs_at",
        // Never parsed from a client request.
        _ => "internal",
    }
}

/// rbitcoin's broadcast rejects, mapped onto fixed text: its own messages can carry internal
/// detail (`durable: …`), so only reasons from this list reach the client.
fn reject_reason(message: &str) -> &'static str {
    const KNOWN: &[&str] = &[
        "mempool full",
        "negative fee",
        "mempool double-spend",
        "txn-same-nonwitness-data-in-mempool",
        "bad-txns-spends-conflicting-tx",
        "adds unconfirmed input",
        "min relay fee",
        "mempool min fee",
        "too-large-cluster",
        "rbf insufficient fee",
        "coinbase",
        "inputs-duplicate",
        "coinbase immature",
        "not final",
        "non-BIP68-final",
        "bad-txns-too-many-sigops",
        "dust",
        "libre annex",
        "scriptpubkey",
        "tx weight",
        "bad-txns-vin-empty",
        "bad-txns-vout-empty",
        "bad-txns-oversize",
        "bad-txns-vout-negative",
        "bad-txns-vout-toolarge",
        "bad-txns-txouttotal-toolarge",
        "bad-txns-inputs-duplicate",
        "bad-cb-length",
        "bad-txns-prevout-null",
        "bad-txns-in-belowout",
    ];
    let reason = message.strip_prefix("policy: ").unwrap_or(message);
    if let Some(known) = KNOWN.iter().find(|k| **k == reason) {
        return known;
    }
    if message.starts_with("duplicate ") {
        "transaction already in the mempool or chain"
    } else if message.starts_with("missing prevout ") || message.starts_with("orphaned ") {
        "missing or spent inputs"
    } else if message.starts_with("script: ") {
        "script verification failed"
    } else {
        "transaction rejected"
    }
}

/// Parses the path after `/api/` and the query into a [`Call`]. Unknown shapes are 404; a known
/// shape with a bad parameter is 400. Nothing is percent-decoded: no valid parameter contains `%`.
fn parse(path: &str, query: Option<&str>, network: Network) -> Result<Call, ApiError> {
    let segs: Vec<&str> = path.split('/').collect();
    // A trailing or doubled slash is not a route.
    if segs.contains(&"") {
        return Err(ApiError::NOT_FOUND);
    }
    let mut q = Query::parse(query)?;
    let call = parse_segments(&segs, &mut q, network)?;
    if !q.0.is_empty() {
        return Err(ApiError::bad_request("unexpected query parameter"));
    }
    Ok(call)
}

fn parse_segments(segs: &[&str], q: &mut Query<'_>, network: Network) -> Result<Call, ApiError> {
    use Route as R;
    let route = match *segs {
        ["blindbit", "v1", "info"] => R::BlindbitInfo,
        ["blindbit", "v1", "block-height"] => R::BlindbitBlockHeight,
        ["blindbit", "v1", "block-hash", h] => R::BlindbitBlockHash(int(h, "invalid height")?),
        ["blindbit", "v1", "tweaks", h] => R::BlindbitTweaks {
            height: int(h, "invalid height")?,
            dust_limit: q.dust_limit()?,
        },
        ["blindbit", "v1", "tweak-index", h] => R::BlindbitTweakIndex {
            height: int(h, "invalid height")?,
            dust_limit: q.dust_limit()?,
        },
        ["blindbit", "v1", "utxos", h] => R::BlindbitUtxos(int(h, "invalid height")?),
        ["blindbit", "v1", "spent-index", h] => R::BlindbitSpentIndex(int(h, "invalid height")?),
        ["blindbit", "v1", "filter", "new-utxos", h] => {
            R::BlindbitFilterNewUtxos(int(h, "invalid height")?)
        }
        ["blindbit", "v1", "filter", "spent", h] => {
            R::BlindbitFilterSpent(int(h, "invalid height")?)
        }
        ["blindbit", "v1", "forward-tx"] => return Ok(Call::BlindbitForwardTx),
        ["tx"] => return Ok(Call::Broadcast),
        ["block-heights", "txs", "outs"] => return Ok(Call::Outputs { asof: q.asof()? }),

        ["blocks", "tip", "height"] => R::TipHeight,
        ["blocks", "tip", "hash"] => R::TipHash,
        ["blocks"] => R::Blocks { start_height: None },
        ["blocks", h] => R::Blocks {
            start_height: Some(int(h, "invalid height")?),
        },
        ["block-height", h] => R::BlockHash(int(h, "invalid height")?),
        ["block-height", h, "tx", i] => R::TxAt {
            height: int(h, "invalid height")?,
            index: int(i, "invalid index")?,
            asof: q.asof()?,
        },
        ["block-height", h, "tx", i, "out", v] => R::OutputAt {
            position: OutPosition {
                height: int(h, "invalid height")?,
                index: int(i, "invalid index")?,
                vout: int(v, "invalid vout")?,
            },
            asof: q.asof()?,
        },

        ["block", h] => R::Block(block_hash(h)?),
        ["block", h, "header"] => R::BlockHeader(block_hash(h)?),
        ["block", h, "status"] => R::BlockStatus(block_hash(h)?),
        ["block", h, "raw"] => R::BlockRaw(block_hash(h)?),
        ["block", h, "txids"] => R::BlockTxids(block_hash(h)?),
        ["block", h, "txid", i] => R::BlockTxid {
            hash: block_hash(h)?,
            index: int(i, "invalid index")?,
        },
        // The node answers `/txs` and `/txs/0` with the same page.
        ["block", h, "txs"] => R::BlockTxs {
            hash: block_hash(h)?,
            start: BlockTxsStart::FIRST,
        },
        ["block", h, "txs", s] => R::BlockTxs {
            hash: block_hash(h)?,
            start: BlockTxsStart::new(int(s, "invalid start index")?).ok_or(
                ApiError::bad_request("start index must be a multiple of 25"),
            )?,
        },

        ["tx", t] => R::Tx(txid(t)?),
        ["tx", t, "hex"] => R::TxHex(txid(t)?),
        ["tx", t, "raw"] => R::TxRaw(txid(t)?),
        ["tx", t, "status"] => R::TxStatus {
            txid: txid(t)?,
            asof: q.asof()?,
        },
        ["tx", t, "merkle-proof"] => R::TxMerkleProof(txid(t)?),
        ["tx", t, "merkleblock-proof"] => R::TxMerkleblockProof(txid(t)?),
        ["tx", t, "outspend", v] => R::TxOutspend {
            txid: txid(t)?,
            vout: int(v, "invalid vout")?,
            asof: q.asof()?,
        },
        ["tx", t, "outspends"] => R::TxOutspends {
            txid: txid(t)?,
            asof: q.asof()?,
        },
        ["tx", t, "out", v] => R::TxOut {
            txid: txid(t)?,
            vout: int(v, "invalid vout")?,
            asof: q.asof()?,
        },
        ["txs", "outspends"] => R::TxsOutspends(q.txids()?),

        [kind @ ("address" | "scripthash"), s, ref rest @ ..] => {
            let script = if kind == "address" {
                payee(s, network)?.script_ref()
            } else {
                // The digest as hashed, as the node, electrs and mempool.space take it.
                ScriptRef::ScriptHash(
                    ScriptHash::from_digest_hex(s)
                        .map_err(|_| ApiError::bad_request("invalid scripthash"))?,
                )
            };
            match *rest {
                [] => R::ScriptStats {
                    script,
                    asof: q.asof()?,
                },
                ["utxo"] => R::ScriptUtxo {
                    script,
                    asof: q.asof()?,
                },
                ["txs"] => R::ScriptTxs {
                    script,
                    after: q.after_txid()?,
                    asof: q.asof()?,
                },
                ["txs", "chain"] => R::ScriptTxsChain {
                    script,
                    last_seen: None,
                    asof: q.asof()?,
                },
                ["txs", "chain", t] => R::ScriptTxsChain {
                    script,
                    last_seen: Some(txid(t)?),
                    asof: q.asof()?,
                },
                ["txs", "mempool"] => R::ScriptTxsMempool(script),
                // `?after_txid=` and the path cursor mean the same on the node.
                ["txs", "summary"] => R::ScriptTxsSummary {
                    script,
                    last_seen: q.after_txid()?,
                    asof: q.asof()?,
                },
                ["txs", "summary", t] => R::ScriptTxsSummary {
                    script,
                    last_seen: Some(txid(t)?),
                    asof: q.asof()?,
                },
                _ => return Err(ApiError::NOT_FOUND),
            }
        }

        ["mempool"] => R::Mempool,
        ["mempool", "txids"] => R::MempoolTxids,
        ["mempool", "txids", "page"] => R::MempoolTxidsPage {
            after: None,
            max_txs: q.max_txs()?,
        },
        ["mempool", "txids", "page", t] => R::MempoolTxidsPage {
            after: Some(txid(t)?),
            max_txs: q.max_txs()?,
        },
        ["mempool", "recent"] => R::MempoolRecent,
        ["fee-estimates"] => R::FeeEstimates,
        _ => return Err(ApiError::NOT_FOUND),
    };
    Ok(Call::Read(route))
}

/// Decimal digits only: `from_str` would also take a leading `+`.
fn int<T: FromStr>(s: &str, msg: &'static str) -> Result<T, ApiError> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ApiError::bad_request(msg));
    }
    s.parse().map_err(|_| ApiError::bad_request(msg))
}

pub(crate) fn txid(s: &str) -> Result<Txid, ApiError> {
    hash(s).ok_or(ApiError::bad_request("invalid txid"))
}

pub(crate) fn block_hash(s: &str) -> Result<BlockHash, ApiError> {
    hash(s).ok_or(ApiError::bad_request("invalid block hash"))
}

/// Exactly 64 hex digits.
fn hash<T: FromStr>(s: &str) -> Option<T> {
    (s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| s.parse().ok())
        .flatten()
}

pub(crate) fn address(s: &str, network: Network) -> Result<Address, ApiError> {
    let chain = crate::difficulty::chain(network);
    // Longer than any address; refuse before the decoder looks at it.
    if s.len() > 128 {
        return Err(ApiError::bad_request("invalid address"));
    }
    s.parse::<Address<NetworkUnchecked>>()
        .map_err(|_| ApiError::bad_request("invalid address"))?
        .require_network(chain)
        .map_err(|_| ApiError::bad_request("address is for another network"))
}

/// What an address route's `:address` names: an address, or a bare public key, which is paid by
/// its pay-to-pubkey script and has no address (docs/API.md, "Public keys").
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Payee {
    Address(Address),
    Key(PublicKey),
}

impl Payee {
    pub(crate) fn script_pubkey(&self) -> ScriptBuf {
        match self {
            Self::Address(a) => a.script_pubkey(),
            Self::Key(k) => ScriptBuf::new_p2pk(k),
        }
    }

    /// How the node is asked: an address by itself, a key by its script's hash.
    fn script_ref(self) -> ScriptRef {
        match self {
            Self::Address(a) => ScriptRef::Address(a),
            Self::Key(k) => ScriptRef::Key(k),
        }
    }
}

/// As the server writes it: an address as [`Address`] does, a key as lower-case hex.
impl std::fmt::Display for Payee {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Address(a) => a.fmt(f),
            Self::Key(k) => k.fmt(f),
        }
    }
}

/// An address of `network`, or a public key, which belongs to every network.
pub(crate) fn payee(s: &str, network: Network) -> Result<Payee, ApiError> {
    match public_key(s) {
        Some(key) => Ok(Payee::Key(key)),
        None => address(s, network).map(Payee::Address),
    }
}

/// A point on the curve as 66 hex digits starting `02` or `03`, or 130 starting `04`.
fn public_key(s: &str) -> Option<PublicKey> {
    // A hybrid key (`06`, `07`) would parse and be written back as `04`: another script.
    let form = match s.len() {
        66 => s.starts_with("02") || s.starts_with("03"),
        130 => s.starts_with("04"),
        _ => false,
    };
    form.then(|| s.parse().ok()).flatten()
}

/// The query string as `name=value` pairs, each name at most once.
struct Query<'a>(Vec<(&'a str, &'a str)>);

impl<'a> Query<'a> {
    fn parse(query: Option<&'a str>) -> Result<Self, ApiError> {
        let mut pairs: Vec<(&str, &str)> = Vec::new();
        for part in query.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
            let (name, value) = part.split_once('=').unwrap_or((part, ""));
            if pairs.iter().any(|(n, _)| *n == name) {
                return Err(ApiError::bad_request("repeated query parameter"));
            }
            pairs.push((name, value));
        }
        Ok(Self(pairs))
    }

    fn take(&mut self, name: &str) -> Option<&'a str> {
        let i = self.0.iter().position(|(n, _)| *n == name)?;
        Some(self.0.swap_remove(i).1)
    }

    fn asof(&mut self) -> Result<Option<BlockHash>, ApiError> {
        self.take("asof")
            .map(|s| hash(s).ok_or(ApiError::bad_request("invalid asof")))
            .transpose()
    }

    /// An empty value counts as absent, as on the node.
    fn after_txid(&mut self) -> Result<Option<Txid>, ApiError> {
        match self.take("after_txid") {
            None | Some("") => Ok(None),
            Some(s) => hash(s)
                .map(Some)
                .ok_or(ApiError::bad_request("invalid after_txid")),
        }
    }

    fn dust_limit(&mut self) -> Result<Option<u64>, ApiError> {
        self.take("dustLimit")
            .map(|s| int(s, "invalid dustLimit"))
            .transpose()
    }

    fn max_txs(&mut self) -> Result<Option<u32>, ApiError> {
        self.take("max_txs")
            .map(|s| int(s, "invalid max_txs"))
            .transpose()
    }

    /// `txids=` as comma-separated txids. Browsers' URL encoders write the comma as `%2C`.
    fn txids(&mut self) -> Result<Vec<Txid>, ApiError> {
        let list = self
            .take("txids")
            .filter(|s| !s.is_empty())
            .ok_or(ApiError::bad_request("txids is required"))?;
        let list = list.replace("%2C", ",").replace("%2c", ",");
        let ids = list.split(',').map(txid).collect::<Result<Vec<_>, _>>()?;
        if ids.len() > MAX_OUTSPENDS_TXIDS {
            return Err(ApiError::bad_request("at most 50 txids"));
        }
        Ok(ids)
    }
}

pub(crate) type Answer = Result<RawResponse, Error>;

#[derive(Debug)]
struct Done {
    at: Instant,
    answer: Answer,
}

/// Upstream calls in flight, by upstream path, plus the last answer for each hot key.
///
/// The map holds an entry only while some request holds it, or for a hot key, whose answer stays
/// for its TTL. Hot keys are a fixed set ([`is_hot`]), so the map is bounded by the number of
/// requests in flight (`MAX_CONCURRENT_REQUESTS`) plus that set.
#[derive(Debug, Default)]
pub struct Flights {
    map: Mutex<HashMap<String, InFlight>>,
}

/// A call in the map, and the requests holding it, counted under the map's lock.
#[derive(Debug)]
struct InFlight {
    cell: Arc<OnceCell<Done>>,
    holders: usize,
}

impl Flights {
    /// Answers with `fetch`, unless an identical call is in flight or a hot answer for `key` is
    /// younger than `ttl`; then with that one. `fetch` is not polled when it is not needed.
    pub async fn run(
        &self,
        key: String,
        ttl: Duration,
        fetch: impl Future<Output = Answer>,
    ) -> (Answer, Source) {
        let cell = self.join(&key, ttl);
        let ready = cell.initialized();
        let mut took = None;
        let took_ref = &mut took;
        let _leave = Leave {
            flights: self,
            key: &key,
            cell: &cell,
            ttl,
        };
        // If the request driving the call is dropped, the next one waiting takes over.
        let done = cell
            .get_or_init(move || async move {
                let started = Instant::now();
                let answer = fetch.await;
                *took_ref = Some(started.elapsed());
                Done {
                    at: Instant::now(),
                    answer,
                }
            })
            .await;
        let source = match took {
            Some(d) => Source::Upstream(d),
            None if ready => Source::Hot,
            None => Source::Coalesced,
        };
        (done.answer.clone(), source)
    }

    fn join(&self, key: &str, ttl: Duration) -> Arc<OnceCell<Done>> {
        let mut map = self.map.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(held) = map.get_mut(key)
            && held.cell.get().is_none_or(|d| d.at.elapsed() < ttl)
        {
            held.holders += 1;
            return Arc::clone(&held.cell);
        }
        // An answered call is replaced; requests still holding it no longer count here.
        let cell = Arc::new(OnceCell::new());
        let held = InFlight {
            cell: Arc::clone(&cell),
            holders: 1,
        };
        map.insert(key.to_owned(), held);
        cell
    }

    /// Entries in the map, for tests.
    pub fn len(&self) -> usize {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Drops a request's hold on its entry; the last holder removes it unless it is a fresh hot answer.
/// Holders are counted under the map's lock, so requests leaving together cannot all leave it.
struct Leave<'a> {
    flights: &'a Flights,
    key: &'a str,
    cell: &'a Arc<OnceCell<Done>>,
    ttl: Duration,
}

impl Drop for Leave<'_> {
    fn drop(&mut self) {
        let mut map = self
            .flights
            .map
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // Only this request's own call: a newer one under the same key has its own holders.
        let Some(held) = map
            .get_mut(self.key)
            .filter(|h| Arc::ptr_eq(&h.cell, self.cell))
        else {
            return;
        };
        held.holders = held.holders.saturating_sub(1);
        let fresh = held.cell.get().is_some_and(|d| d.at.elapsed() < self.ttl);
        if held.holders == 0 && !fresh {
            map.remove(self.key);
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    const H: &str = "00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054";
    const MAIN_ADDR: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    const TEST_ADDR: &str = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    /// One input spending a null outpoint, one empty output: decodable, though not valid.
    const TX: &str = concat!(
        "01000000",
        "01",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "ffffffff",
        "0100",
        "ffffffff",
        "01",
        "0000000000000000",
        "00",
        "00000000"
    );

    fn path(c: &Call) -> String {
        let Call::Read(r) = c else { panic!("{c:?}") };
        let mut s = String::new();
        r.write_path(&mut s);
        s
    }

    fn ok(p: &str) -> String {
        let (p, q) = p.split_once('?').map_or((p, None), |(p, q)| (p, Some(q)));
        path(&parse(p, q, Network::Mainnet).unwrap())
    }

    fn err(p: &str) -> ApiError {
        let (p, q) = p.split_once('?').map_or((p, None), |(p, q)| (p, Some(q)));
        parse(p, q, Network::Mainnet).unwrap_err()
    }

    #[test]
    fn every_route_rebuilds_its_own_path() {
        let same = [
            "blocks/tip/height".to_owned(),
            "blocks/tip/hash".into(),
            "blocks".into(),
            "blocks/800000".into(),
            "block-height/800000".into(),
            "block-height/800000/tx/3".into(),
            "block-height/800000/tx/3/out/1".into(),
            format!("block-height/1/tx/2?asof={H}"),
            format!("block/{H}"),
            format!("block/{H}/header"),
            format!("block/{H}/status"),
            format!("block/{H}/raw"),
            format!("block/{H}/txids"),
            format!("block/{H}/txid/7"),
            format!("block/{H}/txs/25"),
            format!("tx/{H}"),
            format!("tx/{H}/hex"),
            format!("tx/{H}/raw"),
            format!("tx/{H}/status"),
            format!("tx/{H}/status?asof={H}"),
            format!("tx/{H}/merkle-proof"),
            format!("tx/{H}/merkleblock-proof"),
            format!("tx/{H}/outspend/4"),
            format!("tx/{H}/outspends?asof={H}"),
            format!("tx/{H}/out/0"),
            format!("txs/outspends?txids={H},{H}"),
            format!("address/{MAIN_ADDR}"),
            format!("address/{MAIN_ADDR}/utxo?asof={H}"),
            format!("address/{MAIN_ADDR}/txs"),
            format!("address/{MAIN_ADDR}/txs?after_txid={H}&asof={H}"),
            format!("address/{MAIN_ADDR}/txs/chain"),
            format!("address/{MAIN_ADDR}/txs/chain/{H}"),
            format!("address/{MAIN_ADDR}/txs/mempool"),
            format!("address/{MAIN_ADDR}/txs/summary"),
            format!("address/{MAIN_ADDR}/txs/summary/{H}"),
            format!("scripthash/{H}"),
            format!("scripthash/{H}/txs/chain/{H}?asof={H}"),
            "mempool".into(),
            "mempool/txids".into(),
            "mempool/txids/page".into(),
            format!("mempool/txids/page/{H}?max_txs=10"),
            "mempool/recent".into(),
            "fee-estimates".into(),
        ];
        for p in same {
            assert_eq!(ok(&p), format!("/{p}"), "{p}");
        }
    }

    #[test]
    fn equivalent_forms_are_normalized() {
        assert_eq!(ok(&format!("block/{H}/txs")), format!("/block/{H}/txs/0"));
        assert_eq!(
            ok(&format!("address/{MAIN_ADDR}/txs/summary?after_txid={H}")),
            format!("/address/{MAIN_ADDR}/txs/summary/{H}")
        );
        // Bech32 is case-insensitive; the node gets the canonical form.
        assert_eq!(
            ok(&format!("address/{}", MAIN_ADDR.to_uppercase())),
            format!("/address/{MAIN_ADDR}")
        );
        assert_eq!(
            ok(&format!("txs/outspends?txids={H}%2C{H}")),
            format!("/txs/outspends?txids={H},{H}")
        );
        assert_eq!(
            ok(&format!("address/{MAIN_ADDR}/txs?after_txid=")),
            format!("/address/{MAIN_ADDR}/txs")
        );
        // Uppercase hex is a valid hash; the node gets lowercase.
        assert_eq!(ok(&format!("tx/{}", H.to_uppercase())), format!("/tx/{H}"));
    }

    #[test]
    fn posts_and_unknown_shapes() {
        assert_eq!(
            parse("tx", None, Network::Mainnet).unwrap(),
            Call::Broadcast
        );
        assert_eq!(
            parse(
                "block-heights/txs/outs",
                Some(&format!("asof={H}")),
                Network::Mainnet
            )
            .unwrap(),
            Call::Outputs {
                asof: Some(H.parse().unwrap())
            }
        );
        for p in [
            "",
            "blocks/",
            "block-template",
            "internal/txs",
            "internal/mempool/txs/all",
            "txs/test",
            "txs/package",
            "addresses/txs",
            "v1/fees/recommended",
            "tx/../internal/txs",
            &format!("block/{H}/txs/25/x"),
            &format!("address/{MAIN_ADDR}/foo"),
        ] {
            assert_eq!(err(p), ApiError::NOT_FOUND, "{p}");
        }
    }

    #[test]
    fn hostile_parameters_are_400() {
        let long = "1".repeat(10_000);
        for p in [
            "blocks/+5".to_owned(),
            "blocks/tip".into(),
            "blocks/-1".into(),
            "blocks/4294967296".into(),
            "blocks/1.5".into(),
            "block-height/%31".into(),
            format!("block/{H}0"),
            format!("block/0x{}", &H[2..]),
            format!("block/{}", &H[1..]),
            format!("tx/{}%2F..", &H[..61]),
            format!("tx/{}", "g".repeat(64)),
            format!("tx/{long}"),
            "tx/..".into(),
            "tx/%2e%2e".into(),
            format!("block/{H}/txs/26"),
            format!("tx/{H}/outspend/x"),
            "address/notanaddress".into(),
            format!("address/{long}"),
            format!("address/{TEST_ADDR}"),
            format!("scripthash/{MAIN_ADDR}"),
            format!("tx/{H}/status?asof=zz"),
            format!("tx/{H}/status?asof="),
            format!("tx/{H}?asof={H}"),
            format!("tx/{H}/status?asof={H}&asof={H}"),
            format!("tx/{H}?foo=bar"),
            "mempool?cachebust".into(),
            format!("address/{MAIN_ADDR}/txs/mempool?asof={H}"),
            "txs/outspends".into(),
            "txs/outspends?txids=".into(),
            format!("txs/outspends?txids={H},zz"),
            format!("txs/outspends?txids={}", vec![H; 51].join(",")),
            "mempool/txids/page?max_txs=-1".into(),
        ] {
            let e = err(&p);
            assert_eq!(e.status(), StatusCode::BAD_REQUEST, "{p}: {e:?}");
        }
    }

    /// A signet key paid 513 times, and the hash of its pay-to-pubkey script as the node takes it.
    const KEY: &str = "04a8c3fa3dbc022ca7c9a2214c5e673833317b3cff37c0fc170fc347f1a2f6b6e2a53db4d023387f89209de481cd014a44040e1b09c3226d40fed02c0bc8d0f548";
    const KEY_SH: &str = "d0a91f940a8c68fbc4b13b5ac57cea9acf68a86dc9f05c59bf7e19388b824d8c";
    /// The curve's generator, compressed.
    const G: &str = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

    #[test]
    fn a_public_key_is_asked_by_the_hash_of_its_script() {
        for net in [Network::Mainnet, Network::Signet, Network::Regtest] {
            let r = parse(&format!("address/{KEY}/txs"), None, net).unwrap();
            assert_eq!(path(&r), format!("/scripthash/{KEY_SH}/txs"), "{net:?}");
        }
        let upper = KEY.to_ascii_uppercase();
        assert_eq!(
            ok(&format!("address/{upper}")),
            format!("/scripthash/{KEY_SH}")
        );
        assert_eq!(
            payee(&upper, Network::Signet).unwrap().to_string(),
            KEY,
            "written back in lower case"
        );
        // A compressed key is paid by its own, shorter script.
        let script = ScriptBuf::from_hex(&format!("21{G}ac")).unwrap();
        let sh = ScriptHash::from_script(&script);
        assert_eq!(
            ok(&format!("address/{G}")),
            format!("/scripthash/{}", sh.digest_hex())
        );
        // The route keeps the script, which the guard hands the ledger with a large key's totals.
        let Call::Read(Route::ScriptStats { script: kept, .. }) =
            parse(&format!("address/{G}"), None, Network::Mainnet).unwrap()
        else {
            panic!("not the totals route");
        };
        assert_eq!(kept.script_pubkey(), Some(script));
        assert_eq!(kept.script_hash(), sh);
    }

    #[test]
    fn only_a_point_in_its_own_form_is_a_public_key() {
        for bad in [
            // Hybrid: the same point, but another script.
            format!("06{}", &KEY[2..]),
            format!("07{}", &KEY[2..]),
            // Not on the curve.
            format!("04{}", "0".repeat(128)),
            format!("02{}", "f".repeat(64)),
            // The wrong length for its first byte, and no hex.
            format!("04{}", &G[2..]),
            format!("02{}", &KEY[2..]),
            KEY[..128].to_owned(),
            format!("{KEY}00"),
            format!("{}zz", &KEY[..128]),
        ] {
            let e = err(&format!("address/{bad}"));
            assert_eq!(e.status(), StatusCode::BAD_REQUEST, "{bad}");
        }
    }

    #[test]
    fn addresses_are_checked_for_the_network() {
        let p = format!("address/{TEST_ADDR}");
        for net in [Network::Signet, Network::Testnet4, Network::Testnet5] {
            assert!(parse(&p, None, net).is_ok());
        }
        assert!(parse(&format!("address/{MAIN_ADDR}"), None, Network::Signet).is_err());
        assert!(parse(&p, None, Network::Regtest).is_err());
    }

    #[test]
    fn cache_classes() {
        let h: BlockHash = H.parse().unwrap();
        let t: Txid = H.parse().unwrap();
        assert_eq!(cache_control(&Route::Block(h), b""), IMMUTABLE);
        assert_eq!(cache_control(&Route::BlockRaw(h), b""), IMMUTABLE);
        assert_eq!(cache_control(&Route::BlockStatus(h), b""), LIVE);
        assert_eq!(
            cache_control(
                &Route::BlockTxs {
                    hash: h,
                    start: BlockTxsStart::FIRST
                },
                b""
            ),
            LIVE
        );
        assert_eq!(cache_control(&Route::Tx(t), b""), LIVE);
        assert_eq!(cache_control(&Route::BlockHash(1), b""), LIVE);
        assert_eq!(cache_control(&Route::TxMerkleProof(t), b""), LIVE);
        // Legacy serialization: version, then a non-zero input count.
        assert_eq!(cache_control(&Route::TxHex(t), b"0200000001ab"), IMMUTABLE);
        assert_eq!(
            cache_control(&Route::TxRaw(t), &[2, 0, 0, 0, 1, 9]),
            IMMUTABLE
        );
        // Witness serialization: marker 0x00, flag 0x01.
        assert_eq!(cache_control(&Route::TxHex(t), b"020000000001ab"), LIVE);
        assert_eq!(cache_control(&Route::TxRaw(t), &[2, 0, 0, 0, 0, 1]), LIVE);
        assert_eq!(cache_control(&Route::TxRaw(t), &[2, 0]), LIVE);
    }

    #[test]
    fn upstream_errors_map_to_fixed_messages() {
        let r = Route::TipHeight;
        let b = Route::Broadcast(parse_tx(TX.as_bytes()).unwrap());
        let s = |status: u16, body: &str, route: &Route| {
            let e = Error::from_status(StatusCode::from_u16(status).unwrap(), body.as_bytes());
            let a = upstream_error(&e, route);
            (a.status().as_u16(), format!("{a:?}"))
        };
        assert_eq!(s(404, "Not Found", &r).0, 404);
        let (code, msg) = s(503, "scripthash index disabled (--sh-index)", &r);
        assert_eq!(code, 503);
        assert!(!msg.contains("--sh-index"), "{msg}");
        let (code, msg) = s(503, "too many rows; raise --max-sh-creates", &r);
        assert_eq!(code, 503);
        assert!(!msg.contains("--max"), "{msg}");
        assert_eq!(s(503, "chain view moved", &r).0, 503);
        assert_eq!(s(422, "after_txid not found", &r).0, 422);
        let (code, msg) = s(400, "policy: min relay fee", &b);
        assert_eq!(code, 400);
        assert!(msg.contains("\"min relay fee\""), "{msg}");
        let (_, msg) = s(400, "durable: /var/lib/node/x: disk full", &b);
        assert!(!msg.contains("/var"), "{msg}");
        let (_, msg) = s(400, &format!("duplicate {H}"), &b);
        assert!(msg.contains("already"), "{msg}");
        assert_eq!(s(500, "panic at src/x.rs", &r).0, 502);
    }

    fn answer(n: u8) -> Answer {
        Ok(RawResponse {
            status: StatusCode::OK,
            content_type: None,
            tip: None,
            body: Bytes::from(vec![n]),
        })
    }

    #[tokio::test]
    async fn concurrent_identical_calls_share_one_fetch() {
        let flights = Arc::new(Flights::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..50 {
            let (f, c) = (Arc::clone(&flights), Arc::clone(&calls));
            tasks.push(tokio::spawn(async move {
                f.run("/k".into(), Duration::ZERO, async {
                    c.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    answer(1)
                })
                .await
            }));
        }
        let mut sources = Vec::new();
        for t in tasks {
            let (a, source) = t.await.unwrap();
            assert_eq!(a.unwrap().body[0], 1);
            sources.push(source);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let fetched = sources
            .iter()
            .filter(|s| matches!(s, Source::Upstream(d) if *d >= Duration::from_millis(50)))
            .count();
        let joined = sources.iter().filter(|s| **s == Source::Coalesced).count();
        assert_eq!((fetched, joined), (1, 49));
        assert!(flights.is_empty(), "a finished call leaves nothing behind");
        // A later request is a new call: answers are shared only while in flight.
        flights
            .run("/k".into(), Duration::ZERO, async {
                calls.fetch_add(1, Ordering::SeqCst);
                answer(2)
            })
            .await
            .0
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn hot_answers_are_reused_for_their_ttl_only() {
        let flights = Flights::default();
        let ttl = Duration::from_millis(100);
        let a = flights.run("/hot".into(), ttl, async { answer(1) }).await;
        let b = flights.run("/hot".into(), ttl, async { answer(2) }).await;
        assert_eq!((a.0.unwrap().body[0], b.0.unwrap().body[0]), (1, 1));
        assert!(matches!(a.1, Source::Upstream(_)));
        assert_eq!(b.1, Source::Hot);
        assert_eq!(flights.len(), 1);
        tokio::time::sleep(ttl).await;
        let c = flights.run("/hot".into(), ttl, async { answer(3) }).await;
        assert_eq!(c.0.unwrap().body[0], 3);
        assert_eq!(flights.len(), 1, "one entry per hot key");
    }

    #[tokio::test]
    async fn cancelled_and_distinct_calls_do_not_accumulate() {
        let flights = Arc::new(Flights::default());
        for i in 0..1000 {
            let f = Arc::clone(&flights);
            let t = tokio::spawn(async move {
                f.run(format!("/k{i}"), Duration::ZERO, std::future::pending())
                    .await
            });
            tokio::task::yield_now().await;
            t.abort();
            let _ = t.await;
        }
        assert!(flights.is_empty(), "{} left", flights.len());
        // A waiter whose driver is cancelled takes over the call.
        let f = Arc::clone(&flights);
        let driver = tokio::spawn(async move {
            f.run("/x".into(), Duration::ZERO, std::future::pending())
                .await
        });
        tokio::task::yield_now().await;
        let f = Arc::clone(&flights);
        let waiter = tokio::spawn(async move {
            f.run("/x".into(), Duration::ZERO, async { answer(7) })
                .await
        });
        tokio::task::yield_now().await;
        driver.abort();
        let (a, source) = waiter.await.unwrap();
        assert_eq!(a.unwrap().body[0], 7);
        assert!(matches!(source, Source::Upstream(_)));
        assert!(flights.is_empty());
    }

    /// The race: request A's hold is released and the map unlocked, but A has not yet let go of
    /// its handle on the call, when request B's hold is released. Counting handles, B saw A as
    /// still there and both left the entry behind for good.
    #[test]
    fn the_last_request_out_removes_the_call_whatever_the_order() {
        let flights = Flights::default();
        let (a, b) = (
            flights.join("/k", Duration::ZERO),
            flights.join("/k", Duration::ZERO),
        );
        let leave = |cell| Leave {
            flights: &flights,
            key: "/k",
            cell,
            ttl: Duration::ZERO,
        };
        drop(leave(&a));
        assert_eq!(flights.len(), 1, "B still holds it");
        drop(leave(&b));
        assert!(flights.is_empty());
        // An older call's last request never touches a newer call under the same key.
        let old = flights.join("/k", Duration::ZERO);
        old.set(Done {
            at: Instant::now(),
            answer: answer(1),
        })
        .unwrap();
        let new = flights.join("/k", Duration::ZERO);
        assert!(!Arc::ptr_eq(&old, &new), "an answered call is not joined");
        drop(leave(&old));
        assert_eq!(flights.len(), 1, "the newer call is still held");
        drop(leave(&new));
        assert!(flights.is_empty());
        drop((a, b));
    }

    /// The same race, driven for real: requests sharing a call wake together when it answers and
    /// leave at once on several threads. Before the fix, about 1 key in 2,000 stayed in the map.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn requests_leaving_together_leave_nothing_behind() {
        let flights = Arc::new(Flights::default());
        for round in 0..20_000 {
            let tasks: Vec<_> = (0..8)
                .map(|_| {
                    let f = Arc::clone(&flights);
                    tokio::spawn(async move {
                        f.run(format!("/k{round}"), Duration::ZERO, async {
                            for _ in 0..20 {
                                tokio::task::yield_now().await;
                            }
                            answer(1)
                        })
                        .await
                    })
                })
                .collect();
            for t in tasks {
                assert_eq!(t.await.unwrap().0.unwrap().body[0], 1);
            }
        }
        assert!(flights.is_empty(), "{} entries left", flights.len());
    }

    #[tokio::test]
    async fn a_heavy_call_whose_task_panics_is_removed_and_its_requests_released() {
        let calls = Arc::new(HeavyCalls::default());
        let (tx, mut joined) = watch::channel(None);
        let tx: HeavyCall = Arc::new(tx);
        calls.lock().unwrap().insert("k".into(), Arc::clone(&tx));
        let ended = Ended {
            calls: Arc::clone(&calls),
            key: "k".into(),
            call: tx,
        };
        let task = tokio::spawn(async move {
            let _ended = ended;
            panic!("boom");
        });
        assert!(task.await.is_err());
        assert!(
            calls.lock().unwrap().is_empty(),
            "the next request starts afresh"
        );
        assert!(
            joined.wait_for(Option::is_some).await.is_err(),
            "a waiting request is told the call ended"
        );
    }

    #[test]
    fn a_waiting_call_is_dropped_only_when_nobody_waits_for_it() {
        let calls = HeavyCalls::default();
        let (tx, first) = watch::channel(None);
        let tx: HeavyCall = Arc::new(tx);
        calls.lock().unwrap().insert("k".into(), Arc::clone(&tx));
        // Its last request timed out, so the task saw the channel close...
        drop(first);
        // ...and before it took the lock, another request joined.
        let joined = calls.lock().unwrap().get("k").unwrap().subscribe();
        assert!(!finish(&calls, "k", &tx, true), "the call must go on");
        assert!(calls.lock().unwrap().contains_key("k"));
        drop(joined);
        assert!(finish(&calls, "k", &tx, true));
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn transactions_parse_strictly() {
        assert!(parse_tx(format!(" {TX}\n").as_bytes()).is_ok());
        assert!(
            parse_tx(format!("{TX}00").as_bytes()).is_err(),
            "trailing bytes"
        );
        assert!(parse_tx(b"zz").is_err());
        assert!(parse_tx(b"").is_err());
        assert!(parse_tx(&[0xff, 0xfe]).is_err());
        assert_eq!(
            parse_tx("00".repeat(MAX_TX_BYTES + 1).as_bytes()).unwrap_err(),
            ApiError::PAYLOAD_TOO_LARGE
        );
    }
}
