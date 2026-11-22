//! Client for rbitcoin's Electrum server: newline-delimited JSON-RPC over TCP,
//! protocol 1.4 to 1.6 plus the 1.7 outpoint methods.
//!
//! One long-lived connection carries every request and subscription. It
//! reconnects with backoff on any failure, re-subscribes everything, and then
//! sends [`Event::Resynced`]. Subscriptions are shared and reference-counted:
//! any number of [`Subscription`] handles for one topic hold one upstream
//! subscription, which is dropped with the last handle. Every queue is bounded,
//! and a slow event consumer loses events (and learns so) instead of blocking
//! the connection.

pub mod history;
mod types;

#[cfg(test)]
mod tests;

pub use types::{
    Balance, Error, Event, Features, HistoryItem, MempoolInfo, OutpointStatus, ScriptHash,
    ServerVersion, Stamped, Status, Tip, Topic,
};

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use bitcoin::block::Header;
use bitcoin::{BlockHash, OutPoint};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::net::tcp::OwnedWriteHalf;
use tokio::sync::{Notify, Semaphore, broadcast, mpsc, oneshot, watch};
use tokio::task::JoinSet;
use tokio::time::{sleep, timeout};

use types::{parse, parse_header, parse_headers, parse_tip, parse_version, protocol};

const CLIENT_NAME: &str = "rbitcoin.space";
const WRITE_QUEUE: usize = 4096;
const FIRST_RETRY: Duration = Duration::from_millis(100);
/// Recent blocks remembered to find a fork point, and the most re-read after a gap.
const TIP_WINDOW: u32 = 144;

/// Connection settings. [`Config::new`] gives defaults for everything but the address.
#[derive(Clone, Debug)]
pub struct Config {
    /// `host:port` of the node's `--electrum-listen`.
    pub addr: String,
    pub connect_timeout: Duration,
    /// How long a reply may take, counted from sending the request.
    pub request_timeout: Duration,
    /// How often an idle connection is checked with `server.ping`.
    pub ping_interval: Duration,
    pub max_reconnect_delay: Duration,
    /// Longest line accepted from the server; a longer one drops the connection.
    pub max_line_bytes: usize,
    /// Requests awaiting a reply at once. Further callers wait their turn.
    pub max_in_flight: usize,
    /// Distinct upstream subscriptions. rbitcoin allows 10,000 of each kind per connection.
    pub max_subscriptions: usize,
    /// Events buffered per consumer before the slowest starts losing them.
    pub event_capacity: usize,
}

impl Config {
    pub fn new(addr: impl Into<String>) -> Self {
        Config {
            addr: addr.into(),
            connect_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(30),
            ping_interval: Duration::from_secs(30),
            max_reconnect_delay: Duration::from_secs(30),
            max_line_bytes: 8 << 20,
            max_in_flight: 256,
            max_subscriptions: 10_000,
            event_capacity: 4096,
        }
    }
}

/// Handle to the Electrum connection. Cheap to clone; all clones share it.
#[derive(Clone)]
pub struct Client {
    shared: Arc<Shared>,
}

/// One holder's claim on a shared upstream subscription. Dropping the last
/// handle for a topic unsubscribes upstream.
pub struct Subscription {
    shared: Arc<Shared>,
    topic: Topic,
}

struct Shared {
    config: Config,
    state: Mutex<State>,
    permits: Semaphore,
    events: broadcast::Sender<Event>,
    /// The newest header the node pushed, before reconciling with our chain.
    pushed_tip: watch::Sender<Option<(u32, Header)>>,
    health: watch::Sender<Health>,
}

/// The connection's state, for whoever reports on it. The client never logs; the server turns
/// changes into log events.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Health {
    /// Connected, handshake done and subscriptions restored.
    pub ready: bool,
    /// Connection attempts in a row that did not get ready. Reset when one does.
    pub failures: u32,
    /// Lines from the server that were not valid JSON-RPC and were skipped, since start.
    pub skipped_lines: u64,
}

#[derive(Default)]
struct State {
    conn: Option<Conn>,
    next_id: u64,
    pending: HashMap<u64, Pending>,
    subs: HashMap<Topic, Sub>,
    version: Option<ServerVersion>,
    tip: Option<Tip>,
}

struct Conn {
    lines: mpsc::Sender<String>,
    kill: Arc<Notify>,
}

struct Sub {
    refs: usize,
    /// `None` until the first upstream reply.
    status: Option<Status>,
}

struct Pending {
    reply: oneshot::Sender<Result<Reply, Error>>,
    kind: Kind,
}

/// Replies the reader applies itself, so they keep their order with notifications.
enum Kind {
    Plain,
    Subscribe(Topic),
    Headers,
}

struct Reply {
    result: Value,
    chain_tip: Option<String>,
    chain_tip_height: Option<u32>,
}

impl Client {
    /// Starts connecting in the background and returns at once. Must be
    /// called inside a tokio runtime.
    pub fn spawn(config: Config) -> Client {
        let (events, _) = broadcast::channel(config.event_capacity.max(1));
        let (pushed_tip, tip_rx) = watch::channel(None);
        let shared = Arc::new(Shared {
            permits: Semaphore::new(config.max_in_flight.max(1)),
            config,
            state: Mutex::default(),
            events,
            pushed_tip,
            health: watch::Sender::default(),
        });
        tokio::spawn(supervise(shared.clone()));
        tokio::spawn(track_tip(shared.clone(), tip_rx));
        Client { shared }
    }

    /// A new receiver of every event from now on. A receiver that falls more
    /// than `event_capacity` behind gets `RecvError::Lagged`: treat it as
    /// [`Event::Resynced`].
    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.shared.events.subscribe()
    }

    /// Changes to the connection's [`Health`]. Updates may be coalesced: compare with the last
    /// value seen rather than counting notifications.
    pub fn health(&self) -> watch::Receiver<Health> {
        self.shared.health.subscribe()
    }

    pub fn tip(&self) -> Option<Tip> {
        self.shared.state().tip.clone()
    }

    /// The `server.version` reply from the current connection's handshake.
    pub fn server_version(&self) -> Option<ServerVersion> {
        self.shared.state().version.clone()
    }

    pub async fn features(&self) -> Result<Features, Error> {
        parse(self.call("server.features", json!([])).await?.result)
    }

    pub async fn block_header(&self, height: u32) -> Result<Header, Error> {
        let reply = self
            .call("blockchain.block.header", json!([height]))
            .await?;
        parse_header(&reply.result)
    }

    /// Up to `count` headers from `start`; the node returns at most 2016,
    /// and fewer past its tip.
    pub async fn block_headers(&self, start: u32, count: u32) -> Result<Vec<Header>, Error> {
        let reply = self
            .call("blockchain.block.headers", json!([start, count]))
            .await?;
        parse_headers(&reply.result)
    }

    pub async fn mempool_info(&self) -> Result<MempoolInfo, Error> {
        parse(self.call("mempool.get_info", json!([])).await?.result)
    }

    /// `[fee rate, vsize]` pairs, highest rate first, as rbitcoin returns them:
    /// the rate is in sat/kvB, not the protocol's sat/vB, and vsize is cumulative.
    pub async fn fee_histogram(&self) -> Result<Vec<(f64, u64)>, Error> {
        parse(
            self.call("mempool.get_fee_histogram", json!([]))
                .await?
                .result,
        )
    }

    /// BTC per kvB to confirm within `blocks`, or `None` if the node has no estimate.
    pub async fn estimate_fee(&self, blocks: u16) -> Result<Option<f64>, Error> {
        let fee: f64 = parse(
            self.call("blockchain.estimatefee", json!([blocks]))
                .await?
                .result,
        )?;
        Ok((fee >= 0.0).then_some(fee))
    }

    pub async fn outpoint_status(&self, outpoint: &OutPoint) -> Result<OutpointStatus, Error> {
        let topic = Topic::Outpoint(*outpoint);
        let reply = self
            .call("blockchain.outpoint.get_status", topic.params())
            .await?;
        OutpointStatus::parse(&reply.result)
    }

    pub async fn history(&self, sh: &ScriptHash) -> Result<Stamped<Vec<HistoryItem>>, Error> {
        stamped(
            self.call("blockchain.scripthash.get_history", json!([sh.to_string()]))
                .await?,
        )
    }

    pub async fn balance(&self, sh: &ScriptHash) -> Result<Stamped<Balance>, Error> {
        stamped(
            self.call("blockchain.scripthash.get_balance", json!([sh.to_string()]))
                .await?,
        )
    }

    /// Joins the shared upstream subscription for `topic`, creating it if
    /// needed. Changes arrive as [`Event::Status`] on [`Client::events`].
    pub async fn subscribe(&self, topic: Topic) -> Result<Subscription, Error> {
        let handle = {
            let mut state = self.shared.state();
            let max = self.shared.config.max_subscriptions;
            let subs = state.subs.len();
            match state.subs.get_mut(&topic) {
                Some(sub) => {
                    sub.refs += 1;
                    let known = sub.status.is_some();
                    let handle = Subscription {
                        shared: self.shared.clone(),
                        topic: topic.clone(),
                    };
                    if known {
                        return Ok(handle);
                    }
                    // Another holder's subscribe is still in flight; ask again
                    // for the status, which the node treats as one subscription.
                    handle
                }
                None if subs >= max => return Err(Error::SubscriptionLimit { max }),
                None => {
                    state.subs.insert(
                        topic.clone(),
                        Sub {
                            refs: 1,
                            status: None,
                        },
                    );
                    Subscription {
                        shared: self.shared.clone(),
                        topic: topic.clone(),
                    }
                }
            }
        };
        // On failure the handle drops here and releases its reference.
        self.shared.subscribe_upstream(&topic).await?;
        Ok(handle)
    }

    async fn call(&self, method: &str, params: Value) -> Result<Reply, Error> {
        self.shared.call(method, params, Kind::Plain).await
    }
}

impl Subscription {
    pub fn topic(&self) -> &Topic {
        &self.topic
    }

    /// The topic's latest status, shared by every handle. `None` while the
    /// node is not watching it, for example after it refused a re-subscribe.
    pub fn status(&self) -> Option<Status> {
        self.shared
            .state()
            .subs
            .get(&self.topic)
            .and_then(|s| s.status.clone())
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut state = self.shared.state();
        let Some(sub) = state.subs.get_mut(&self.topic) else {
            return;
        };
        sub.refs = sub.refs.saturating_sub(1);
        if sub.refs > 0 {
            return;
        }
        state.subs.remove(&self.topic);
        // Sent under the lock so it cannot overtake a later re-subscribe. The
        // reply is ignored. If it cannot be queued, reconnecting drops it upstream.
        let id = state.next_id();
        if let Some(conn) = &state.conn {
            let line = request_line(id, &self.topic.method("unsubscribe"), &self.topic.params());
            if conn.lines.try_send(line).is_err() {
                conn.kill.notify_one();
            }
        }
    }
}

impl State {
    fn next_id(&mut self) -> u64 {
        self.next_id = self.next_id.wrapping_add(1);
        self.next_id
    }
}

fn request_line(id: u64, method: &str, params: &Value) -> String {
    let mut line =
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string();
    line.push('\n');
    line
}

fn stamped<T: for<'de> Deserialize<'de>>(reply: Reply) -> Result<Stamped<T>, Error> {
    let chain_tip = match reply.chain_tip {
        Some(hash) => Some(hash.parse::<BlockHash>().map_err(protocol)?),
        None => None,
    };
    Ok(Stamped {
        value: parse(reply.result)?,
        chain_tip,
        chain_tip_height: reply.chain_tip_height,
    })
}

impl Shared {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    async fn call(&self, method: &str, params: Value, kind: Kind) -> Result<Reply, Error> {
        // Not under the timeout: each holder keeps a permit for at most one timeout.
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| Error::Disconnected)?;
        let (id, reply) = {
            let mut state = self.state();
            let id = state.next_id();
            let conn = state.conn.as_ref().ok_or(Error::Disconnected)?;
            conn.lines
                .try_send(request_line(id, method, &params))
                .map_err(|e| match e {
                    mpsc::error::TrySendError::Full(_) => Error::Overloaded,
                    mpsc::error::TrySendError::Closed(_) => Error::Disconnected,
                })?;
            let (tx, rx) = oneshot::channel();
            state.pending.insert(id, Pending { reply: tx, kind });
            (id, rx)
        };
        let _forget = ForgetOnDrop { shared: self, id };
        match timeout(self.config.request_timeout, reply).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err(Error::Disconnected),
            Err(_) => Err(Error::Timeout),
        }
    }

    async fn subscribe_upstream(&self, topic: &Topic) -> Result<(), Error> {
        let kind = Kind::Subscribe(topic.clone());
        self.call(&topic.method("subscribe"), topic.params(), kind)
            .await
            .map(drop)
    }

    /// Handles one line from the server. Lines that are not JSON-RPC are
    /// returned as errors and skipped by the caller.
    fn dispatch(&self, line: &[u8]) -> Result<(), Error> {
        #[derive(Deserialize)]
        struct Incoming {
            #[serde(default)]
            id: Option<u64>,
            #[serde(default)]
            method: Option<String>,
            #[serde(default)]
            params: Value,
            #[serde(default)]
            result: Value,
            #[serde(default)]
            error: Value,
            #[serde(default)]
            chain_tip: Option<String>,
            #[serde(default)]
            chain_tip_height: Option<u32>,
        }
        let msg: Incoming = serde_json::from_slice(line).map_err(protocol)?;
        let mut state = self.state();
        if let Some(method) = msg.method {
            return self.notification(&mut state, &method, &msg.params);
        }
        // Replies to unsubscribes, and to requests that timed out, have no taker.
        let Some(pending) = msg.id.and_then(|id| state.pending.remove(&id)) else {
            return Ok(());
        };
        let reply = if msg.error.is_null() {
            self.apply(&mut state, &pending.kind, &msg.result)
                .map(|()| Reply {
                    result: msg.result,
                    chain_tip: msg.chain_tip,
                    chain_tip_height: msg.chain_tip_height,
                })
        } else {
            Err(Error::Server {
                code: msg.error.get("code").and_then(Value::as_i64).unwrap_or(0),
                message: match msg.error.get("message").and_then(Value::as_str) {
                    Some(m) => m.to_owned(),
                    None => msg.error.to_string(),
                },
            })
        };
        let _ = pending.reply.send(reply);
        Ok(())
    }

    fn apply(&self, state: &mut State, kind: &Kind, result: &Value) -> Result<(), Error> {
        match kind {
            Kind::Plain => {}
            Kind::Subscribe(topic) => {
                let status = topic.parse_status(result)?;
                self.set_status(state, topic, status);
            }
            Kind::Headers => {
                self.pushed_tip.send_replace(Some(parse_tip(result)?));
            }
        }
        Ok(())
    }

    fn notification(&self, state: &mut State, method: &str, params: &Value) -> Result<(), Error> {
        let arg = |i: usize| params.get(i).unwrap_or(&Value::Null);
        match method {
            "blockchain.headers.subscribe" => {
                self.pushed_tip.send_replace(Some(parse_tip(arg(0))?));
            }
            "blockchain.scripthash.subscribe" => {
                let sh = arg(0)
                    .as_str()
                    .ok_or_else(|| protocol("scripthash"))?
                    .parse()?;
                let topic = Topic::ScriptHash(sh);
                let status = topic.parse_status(arg(1))?;
                self.set_status(state, &topic, status);
            }
            "blockchain.outpoint.subscribe" => {
                let txid = arg(0).as_str().ok_or_else(|| protocol("txid"))?;
                let vout = arg(1).as_u64().and_then(|v| u32::try_from(v).ok());
                let vout = vout.ok_or_else(|| protocol("vout"))?;
                let topic = Topic::Outpoint(OutPoint {
                    txid: txid.parse().map_err(protocol)?,
                    vout,
                });
                let status = topic.parse_status(arg(2))?;
                self.set_status(state, &topic, status);
            }
            _ => {}
        }
        Ok(())
    }

    fn set_status(&self, state: &mut State, topic: &Topic, status: Status) {
        let Some(sub) = state.subs.get_mut(topic) else {
            return;
        };
        if sub.status.as_ref() == Some(&status) {
            return;
        }
        let first = sub.status.replace(status.clone()).is_none();
        if !first {
            let _ = self.events.send(Event::Status {
                topic: topic.clone(),
                status,
            });
        }
    }
}

struct ForgetOnDrop<'a> {
    shared: &'a Shared,
    id: u64,
}

impl Drop for ForgetOnDrop<'_> {
    fn drop(&mut self) {
        self.shared.state().pending.remove(&self.id);
    }
}

async fn supervise(shared: Arc<Shared>) {
    let mut delay = FIRST_RETRY;
    let mut resync = false;
    loop {
        let outcome = session(&shared, resync).await;
        if let Some(ready) = outcome {
            // Requests and pushes may have been served on it, so the next one resyncs.
            resync = true;
            if ready {
                delay = FIRST_RETRY;
            }
        }
        shared.health.send_modify(|h| {
            h.ready = false;
            if outcome != Some(true) {
                h.failures = h.failures.saturating_add(1);
            }
        });
        sleep(delay).await;
        delay = (delay * 2).min(shared.config.max_reconnect_delay);
    }
}

/// Runs one connection until it fails. Returns `None` if it never connected,
/// else whether it got fully set up.
async fn session(shared: &Arc<Shared>, resync: bool) -> Option<bool> {
    let connect = TcpStream::connect(shared.config.addr.as_str());
    let Ok(Ok(stream)) = timeout(shared.config.connect_timeout, connect).await else {
        return None;
    };
    let _ = stream.set_nodelay(true);
    let (rd, wr) = stream.into_split();
    let (lines, rx) = mpsc::channel(WRITE_QUEUE);
    let kill = Arc::new(Notify::new());
    shared.state().conn = Some(Conn {
        lines,
        kill: kill.clone(),
    });

    let mut ready = false;
    tokio::select! {
        _ = read_loop(shared, BufReader::with_capacity(64 << 10, rd)) => {}
        _ = write_loop(rx, wr) => {}
        _ = kill.notified() => {}
        _ = drive(shared, resync, &mut ready) => {}
    }

    let mut state = shared.state();
    state.conn = None;
    state.version = None;
    // Dropping the senders fails every waiting request with `Disconnected`.
    state.pending.clear();
    Some(ready)
}

async fn drive(shared: &Arc<Shared>, resync: bool, ready: &mut bool) {
    let hello = json!([CLIENT_NAME, ["1.4", "1.6"]]);
    let Ok(reply) = shared.call("server.version", hello, Kind::Plain).await else {
        return;
    };
    let Ok(version) = parse_version(reply.result) else {
        return;
    };
    shared.state().version = Some(version);
    if shared
        .call("blockchain.headers.subscribe", json!([]), Kind::Headers)
        .await
        .is_err()
    {
        return;
    }

    let topics: Vec<Topic> = shared.state().subs.keys().cloned().collect();
    let mut restoring = JoinSet::new();
    for topic in topics {
        let shared = shared.clone();
        restoring.spawn(async move {
            // Holding a reference keeps a concurrent unsubscribe ordered after ours.
            let Some(_hold) = Subscription::claim(&shared, &topic) else {
                return Ok(());
            };
            match shared.subscribe_upstream(&topic).await {
                // The node refused this one (for example, its own limit). Forget
                // its status so the next subscriber asks again, and keep going.
                Err(Error::Server { .. } | Error::Protocol(_)) => {
                    if let Some(sub) = shared.state().subs.get_mut(&topic) {
                        sub.status = None;
                    }
                    Ok(())
                }
                other => other,
            }
        });
    }
    while let Some(done) = restoring.join_next().await {
        if !matches!(done, Ok(Ok(()))) {
            return;
        }
    }

    *ready = true;
    shared.health.send_modify(|h| {
        h.ready = true;
        h.failures = 0;
    });
    if resync {
        let _ = shared.events.send(Event::Resynced);
    }
    loop {
        sleep(shared.config.ping_interval).await;
        if shared
            .call("server.ping", json!([]), Kind::Plain)
            .await
            .is_err()
        {
            return;
        }
    }
}

impl Subscription {
    fn claim(shared: &Arc<Shared>, topic: &Topic) -> Option<Subscription> {
        let mut state = shared.state();
        state.subs.get_mut(topic)?.refs += 1;
        Some(Subscription {
            shared: shared.clone(),
            topic: topic.clone(),
        })
    }
}

async fn read_loop<R: AsyncBufRead + Unpin>(shared: &Shared, mut rd: R) {
    let mut line = Vec::new();
    loop {
        line.clear();
        if read_line(&mut rd, &mut line, shared.config.max_line_bytes)
            .await
            .is_err()
        {
            return;
        }
        if shared.dispatch(&line).is_err() {
            shared.health.send_modify(|h| h.skipped_lines += 1);
        }
    }
}

/// Reads up to and including the next newline, refusing lines over `max` bytes.
async fn read_line<R: AsyncBufRead + Unpin>(
    rd: &mut R,
    line: &mut Vec<u8>,
    max: usize,
) -> Result<(), Error> {
    loop {
        let buf = rd.fill_buf().await.map_err(|_| Error::Disconnected)?;
        if buf.is_empty() {
            return Err(Error::Disconnected);
        }
        let (take, done) = match buf.iter().position(|&b| b == b'\n') {
            Some(i) => (i + 1, true),
            None => (buf.len(), false),
        };
        if line.len() + take > max {
            return Err(protocol("line too long"));
        }
        line.extend_from_slice(buf.get(..take).unwrap_or_default());
        rd.consume(take);
        if done {
            return Ok(());
        }
    }
}

async fn write_loop(mut rx: mpsc::Receiver<String>, mut wr: OwnedWriteHalf) {
    while let Some(line) = rx.recv().await {
        if wr.write_all(line.as_bytes()).await.is_err() {
            return;
        }
    }
}

/// Turns the node's tip pushes into ordered `Block` and `Reorg` events.
async fn track_tip(shared: Arc<Shared>, mut pushed: watch::Receiver<Option<(u32, Header)>>) {
    let mut chain = VecDeque::new();
    while pushed.changed().await.is_ok() {
        let Some((height, header)) = *pushed.borrow_and_update() else {
            continue;
        };
        if follow(&shared, &mut chain, height, header).await.is_err() {
            // Retry with whatever tip is newest by then; a reconnect also re-pushes it.
            sleep(Duration::from_secs(1)).await;
            pushed.mark_changed();
        }
    }
}

async fn follow(
    shared: &Shared,
    chain: &mut VecDeque<(u32, BlockHash)>,
    height: u32,
    header: Header,
) -> Result<(), Error> {
    let hash = header.block_hash();
    let extends = match chain.back() {
        None => {
            seed_parent(chain, height, &header);
            true
        }
        Some(&(h, last)) if h == height && last == hash => return Ok(()),
        Some(&(h, last)) => h.checked_add(1) == Some(height) && header.prev_blockhash == last,
    };
    if extends {
        connect(shared, chain, height, header);
        return Ok(());
    }

    // Blocks were missed or replaced: re-read the recent chain and find where ours forks.
    let start = height.saturating_sub(TIP_WINDOW - 1);
    let params = json!([start, height - start + 1]);
    let reply = shared
        .call("blockchain.block.headers", params, Kind::Plain)
        .await?;
    let fetched: Vec<(u32, Header)> = (start..=height)
        .zip(parse_headers(&reply.result)?)
        .collect();
    let fork = fetched
        .iter()
        .rev()
        .map(|(h, hdr)| (*h, hdr.block_hash()))
        .find(|on_node| chain.contains(on_node));
    match fork {
        Some((fork_height, _)) => {
            if chain.back().is_some_and(|&(h, _)| h > fork_height) {
                chain.retain(|&(h, _)| h <= fork_height);
                // The fork block is the tip until a block of the new branch connects.
                if let Some(&(_, header)) = fetched.iter().find(|(h, _)| *h == fork_height) {
                    let hash = header.block_hash();
                    shared.state().tip = Some(Tip {
                        height: fork_height,
                        hash,
                        header,
                    });
                }
                let _ = shared.events.send(Event::Reorg { fork_height });
            }
            for (h, hdr) in fetched.into_iter().filter(|(h, _)| *h > fork_height) {
                connect(shared, chain, h, hdr);
            }
        }
        None => {
            chain.clear();
            seed_parent(chain, height, &header);
            let _ = shared.events.send(Event::Resynced);
            connect(shared, chain, height, header);
        }
    }
    Ok(())
}

/// Starts an empty chain with the tip's parent, known from its header, so a
/// one-block reorg right after is told apart from a gap.
fn seed_parent(chain: &mut VecDeque<(u32, BlockHash)>, height: u32, header: &Header) {
    if let Some(parent) = height.checked_sub(1) {
        chain.push_back((parent, header.prev_blockhash));
    }
}

fn connect(shared: &Shared, chain: &mut VecDeque<(u32, BlockHash)>, height: u32, header: Header) {
    let tip = Tip {
        height,
        hash: header.block_hash(),
        header,
    };
    chain.push_back((height, tip.hash));
    while chain.len() > TIP_WINDOW as usize {
        chain.pop_front();
    }
    shared.state().tip = Some(tip.clone());
    let _ = shared.events.send(Event::Block(tip));
}
