//! The mempool.space-shaped WebSocket at `/api/v1/ws` (`docs/WS.md`, "The mempool.space-shaped
//! socket"; the shapes are `docs/compat/websocket.md`). The same hub, limits and tracking as
//! `/app/ws`, speaking the reference's JSON instead of ours.
//!
//! Every message is produced once per network and fanned out like any topic: `blocks` from the
//! hub's own block feed, `stats` and `mempool-blocks` from the answers the `/api/v1` routes serve,
//! tracked transactions from the same pass that writes the `tx:` topics. Only an address costs the
//! node anything: one page of its history per change of its Electrum status, shared by every
//! socket following it.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use axum::Extension;
use axum::extract::{Request, State};
use axum::response::Response;
use bitcoin::{BlockHash, Txid};
use node::electrum::{self, ScriptHash};
use node::esplora::{Esplora, Route, ScriptRef};
use serde_json::{Map, Value, json};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{Semaphore, watch};
use tokio::time::Instant;

use super::track::{self, TxState};
use super::{Api, Close, Conn, Frame, Hub, Snapshot, Subscriptions, Topic};
use crate::config::WsLimits;
use crate::verdicts::Verdict;
use crate::{NetworkContext, api_v1, limits};

/// Blocks in the `blocks` message, oldest first, as the reference sends them.
const BLOCKS: usize = 8;
/// Address history pages read from the node at once, per network.
const FETCHES: usize = 2;
/// The largest address history page taken from the node. A page is at most 75 transactions.
const MAX_PAGE: usize = 8 << 20;
/// Longest `mempool-blocks` on another tip waits for the block just sent, as on `/app/ws`.
const HOLD: Duration = super::mempool::HOLD;
/// Wait before reading the block table again after a failed read.
const RETRY: Duration = Duration::from_secs(1);
/// The answer to a follow past the client's budget for new addresses.
const TOO_FAST: &str = "too many new addresses from this client; retry in a moment";
/// Messages the reference has that this server does not serve, answered with `<key>-error` so a
/// person reading the traffic sees why nothing comes.
const UNSERVED: [&str; 8] = [
    "track-mempool",
    "track-mempool-txids",
    "track-mempool-block",
    "track-rbf",
    "track-rbf-summary",
    "track-txs",
    "track-scripthashes",
    "track-accelerations",
];

/// `GET /api/v1/ws`.
pub async fn handle(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<limits::Client>,
    req: Request,
) -> Response {
    super::upgrade(ctx, &client, req, Api::V1)
}

/// One network's state for the compatible socket.
pub struct Compat {
    /// The last [`BLOCKS`] blocks announced, oldest first: the `blocks` message.
    blocks: Mutex<VecDeque<Value>>,
    /// A read of the node's recent blocks is in flight.
    filling: AtomicBool,
    /// Bumped when the last block sent changes: the `mempool-blocks` held for it may go.
    sent: watch::Sender<()>,
    /// The newest transactions, in the reference's shape, for the next `stats` message.
    latest: Mutex<Option<Value>>,
    /// Addresses some compatible socket follows.
    addresses: Mutex<Addresses>,
    fetches: Semaphore,
    /// Its own client, so an address page has its own size cap.
    esplora: Option<Esplora>,
}

impl std::fmt::Debug for Compat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Compat").finish_non_exhaustive()
    }
}

#[derive(Default)]
struct Addresses {
    by_script: HashMap<ScriptHash, Follow>,
    next_epoch: u64,
}

struct Follow {
    /// As the server writes it: the key of `multi-address-transactions`.
    address: Arc<str>,
    /// Compatible sockets following it.
    refs: usize,
    /// Distinguishes it from a later follow of the same script.
    epoch: u64,
    /// The history page last read: `None` until the first read, which says nothing.
    known: Option<Known>,
    /// A read is in flight; `again` asks for one more when it ends.
    busy: bool,
    again: bool,
    /// Dropped with the follow, which cancels its read, waiting or running.
    alive: watch::Sender<()>,
}

struct Known {
    mempool: HashSet<Txid>,
    confirmed: HashSet<Txid>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn text(v: &Value) -> Frame {
    Frame::text(v.to_string().as_bytes())
}

impl Compat {
    /// `esplora` is the network's Esplora URL or socket path; `None` makes every address read
    /// fail, for tests without a node.
    pub fn new(esplora: Option<&str>) -> Self {
        Self {
            blocks: Mutex::default(),
            filling: AtomicBool::new(false),
            sent: watch::Sender::new(()),
            latest: Mutex::default(),
            addresses: Mutex::default(),
            fetches: Semaphore::new(FETCHES),
            esplora: esplora.and_then(|u| {
                Esplora::with_limits(u, crate::esplora::HEAVY_CEILING, MAX_PAGE).ok()
            }),
        }
    }

    /// Addresses compatible sockets follow now.
    pub fn followed(&self) -> usize {
        lock(&self.addresses).by_script.len()
    }

    /// Follows `sh` for `conn`. A first follow reads its history from the node, which takes one
    /// of the client's tokens for new node work; `false` when it has none left.
    fn follow(
        &self,
        ctx: &Arc<NetworkContext>,
        sh: ScriptHash,
        address: &str,
        conn: &Conn,
    ) -> bool {
        let mut a = lock(&self.addresses);
        if let Some(f) = a.by_script.get_mut(&sh) {
            f.refs += 1;
            return true;
        }
        if !ctx.track.charge(conn, "/api/v1/ws") {
            return false;
        }
        a.next_epoch += 1;
        let epoch = a.next_epoch;
        a.by_script.insert(
            sh,
            Follow {
                address: address.into(),
                refs: 1,
                epoch,
                known: None,
                busy: true,
                again: false,
                alive: watch::Sender::new(()),
            },
        );
        tokio::spawn(read_address(Arc::clone(ctx), sh, epoch));
        true
    }

    fn release(&self, sh: ScriptHash) {
        let mut a = lock(&self.addresses);
        if let Some(f) = a.by_script.get_mut(&sh) {
            f.refs = f.refs.saturating_sub(1);
            if f.refs == 0 {
                a.by_script.remove(&sh);
            }
        }
    }

    /// The node says the script's history changed: read it again, once whatever the number of
    /// changes meanwhile.
    fn changed(&self, ctx: &Arc<NetworkContext>, sh: ScriptHash) {
        let mut a = lock(&self.addresses);
        let Some(f) = a.by_script.get_mut(&sh) else {
            return;
        };
        if f.busy {
            f.again = true;
        } else {
            f.busy = true;
            tokio::spawn(read_address(Arc::clone(ctx), sh, f.epoch));
        }
    }

    fn changed_all(&self, ctx: &Arc<NetworkContext>) {
        let all: Vec<ScriptHash> = lock(&self.addresses).by_script.keys().copied().collect();
        for sh in all {
            self.changed(ctx, sh);
        }
    }
}

// The session: one compatible socket's client messages.

/// One compatible socket: what it wants and follows.
pub(crate) struct Session<'a> {
    ctx: &'a Arc<NetworkContext>,
    subs: Subscriptions<'a>,
    /// `track-tx`.
    tx: Option<Txid>,
    /// `track-address`.
    address: Option<ScriptHash>,
    /// `track-addresses`.
    addresses: Vec<ScriptHash>,
}

impl<'a> Session<'a> {
    pub(crate) fn new(ctx: &'a Arc<NetworkContext>, conn: &'a Arc<Conn>) -> Self {
        Self {
            ctx,
            subs: Subscriptions::new(&ctx.track, conn),
            tx: None,
            address: None,
            addresses: Vec::new(),
        }
    }

    fn send(&self, v: &Value) {
        self.subs.conn().send(text(v));
    }

    fn error(&self, key: &str, message: &str) {
        let mut m = Map::new();
        m.insert(format!("{key}-error"), Value::from(message));
        self.send(&Value::Object(m));
    }

    /// One client message. Not JSON closes the socket, as on the reference; anything else that
    /// is not understood is left unanswered, and the socket stays.
    pub(crate) fn handle(&mut self, text: &str, limits: &WsLimits) -> Result<(), Close> {
        let Ok(v) = serde_json::from_str::<Value>(text) else {
            return Err(Close::BAD_MESSAGE);
        };
        let Value::Object(m) = v else {
            return Ok(());
        };
        match m.get("action").and_then(Value::as_str) {
            Some("ping") => self.send(&json!({ "pong": true })),
            // What no `want` part carries; the parts' state comes with `want`.
            Some("init") => self.send(&json!({
                "loadingIndicators": {},
                "backend": "esplora",
                "backendInfo": api_v1::backend_info(self.ctx),
            })),
            Some("want") => {
                if let Some(names) = strings(m.get("data")) {
                    self.want(&names, limits)?;
                }
            }
            _ => {}
        }
        if let Some(Value::String(s)) = m.get("track-tx") {
            self.track_tx(s, limits);
        }
        if let Some(Value::String(s)) = m.get("track-address") {
            self.track_address(s, limits);
        }
        if let Some(names) = strings(m.get("track-addresses")) {
            self.track_addresses(&names, limits);
        }
        for key in UNSERVED {
            if m.contains_key(key) {
                self.error(key, "not served by this server");
            }
        }
        Ok(())
    }

    /// The topics wanted now: the list replaces the last one.
    fn want(&mut self, names: &[&str], limits: &WsLimits) -> Result<(), Close> {
        let all = [
            ("blocks", Topic::V1Blocks),
            ("stats", Topic::V1Stats),
            ("mempool-blocks", Topic::V1MempoolBlocks),
            ("live-2h-chart", Topic::V1LiveChart),
        ];
        for (name, topic) in all {
            if !names.contains(&name) {
                self.subs.part(topic);
            }
        }
        for (name, topic) in all {
            if names.contains(&name) {
                self.subs.join(topic, "", limits)?;
            }
        }
        Ok(())
    }

    fn track_tx(&mut self, s: &str, limits: &WsLimits) {
        if s == "stop" {
            if let Some(t) = self.tx.take() {
                self.subs.part(Topic::V1Tx(t));
            }
            return;
        }
        let Some((Topic::Tx(txid), _)) = track::parse(&format!("tx:{s}"), self.network()) else {
            return;
        };
        if self.tx == Some(txid) {
            return;
        }
        if let Some(t) = self.tx.take() {
            self.subs.part(Topic::V1Tx(t));
        }
        match self.subs.join(Topic::V1Tx(txid), "", limits) {
            Ok(None) => self.tx = Some(txid),
            Ok(Some(_)) => self.error(
                "track-tx",
                "the server follows too many transactions; retry later",
            ),
            Err(_) => self.error("track-tx", "too many subscriptions on this connection"),
        }
    }

    fn track_address(&mut self, s: &str, limits: &WsLimits) {
        if s == "stop" {
            if let Some(sh) = self.address.take() {
                self.ctx.v1.release(sh);
                self.subs.part(Topic::V1Address(sh));
            }
            return;
        }
        let Some((sh, name)) = self.parse_address(s) else {
            return;
        };
        if self.address == Some(sh) {
            return;
        }
        if let Some(old) = self.address.take() {
            self.ctx.v1.release(old);
            self.subs.part(Topic::V1Address(old));
        }
        if self.join_address(Topic::V1Address(sh), sh, &name, limits, "track-address") {
            self.address = Some(sh);
        }
    }

    /// The set followed now: the list replaces the last one; an empty list stops them all.
    fn track_addresses(&mut self, names: &[&str], limits: &WsLimits) {
        let max = limits.max_tracked_addresses;
        let too_many = || format!("at most {max} addresses can be followed on one connection");
        if names.len() > max {
            return self.error("track-addresses", &too_many());
        }
        let mut wanted: Vec<(ScriptHash, String)> = Vec::new();
        for (sh, name) in names.iter().filter_map(|n| self.parse_address(n)) {
            if !wanted.iter().any(|(s, _)| *s == sh) {
                wanted.push((sh, name));
            }
        }
        if wanted.len() + usize::from(self.address.is_some()) > max {
            return self.error("track-addresses", &too_many());
        }
        for sh in std::mem::take(&mut self.addresses) {
            if wanted.iter().any(|(s, _)| *s == sh) {
                self.addresses.push(sh);
            } else {
                self.ctx.v1.release(sh);
                self.subs.part(Topic::V1Addresses(sh));
            }
        }
        for (sh, name) in wanted {
            if !self.addresses.contains(&sh)
                && self.join_address(Topic::V1Addresses(sh), sh, &name, limits, "track-addresses")
            {
                self.addresses.push(sh);
            }
        }
    }

    /// Follows an address on `topic`; says why not under `key` when it cannot.
    fn join_address(
        &mut self,
        topic: Topic,
        sh: ScriptHash,
        name: &str,
        limits: &WsLimits,
        key: &str,
    ) -> bool {
        match self.subs.join(topic, name, limits) {
            Ok(None) => {
                let address = name.strip_prefix("address:").unwrap_or(name);
                if self.ctx.v1.follow(self.ctx, sh, address, self.subs.conn()) {
                    return true;
                }
                self.subs.part(topic);
                self.error(key, TOO_FAST);
                false
            }
            Ok(Some(track::Declined::Full)) => {
                self.error(key, "the server follows too many addresses; retry later");
                false
            }
            Ok(Some(track::Declined::Rate)) => {
                self.error(key, TOO_FAST);
                false
            }
            Err(_) => {
                self.error(key, "too many subscriptions on this connection");
                false
            }
        }
    }

    /// An address of this network, and its `/app` topic name: `address:` and the address as the
    /// server writes it.
    fn parse_address(&self, s: &str) -> Option<(ScriptHash, String)> {
        match track::parse(&format!("address:{s}"), self.network())? {
            (Topic::Address(sh), name) => Some((sh, name)),
            _ => None,
        }
    }

    fn network(&self) -> crate::config::Network {
        self.subs.track().hub().network()
    }
}

impl Drop for Session<'_> {
    // Runs before `subs` leaves the topics: released first, an address is never published again.
    fn drop(&mut self) {
        for sh in self
            .address
            .take()
            .into_iter()
            .chain(self.addresses.drain(..))
        {
            self.ctx.v1.release(sh);
        }
    }
}

/// An array of strings, or `None` for anything else: a wrong type anywhere voids the field.
fn strings(v: Option<&Value>) -> Option<Vec<&str>> {
    v?.as_array()?.iter().map(Value::as_str).collect()
}

// What the server sends.

/// A tracked transaction's message in the reference's shape, or `None` for a state it has no
/// message for (evicted, unknown, not yet placed). `starts` is the vsize ahead of each projected
/// block: the reference gives the position inside the block.
pub(crate) fn tx_message(txid: &Txid, state: &TxState, starts: &[u64]) -> Option<Value> {
    match state {
        TxState::Mempool {
            position: Some(p), ..
        } => {
            let start = starts
                .get(usize::from(p.placed.block))
                .copied()
                .unwrap_or(0);
            Some(json!({ "txPosition": {
                "txid": txid,
                "position": { "block": p.placed.block, "vsize": p.ahead_vsize.saturating_sub(start) },
            }}))
        }
        TxState::Confirmed { .. } => Some(json!({ "txConfirmed": txid })),
        TxState::Replaced(chain, _) => chain
            .first()
            .map(|l| json!({ "txReplaced": { "txid": l.by } })),
        TxState::Mempool { position: None, .. } | TxState::Evicted | TxState::Unknown => None,
    }
}

/// A new block joined the best chain: `block` to every subscriber, and the `blocks` state for
/// new ones. Called by the hub's block feed in the same step as `/app/ws`'s `block`. With a block
/// table the blocks come from the table instead ([`follow_table`]).
pub(crate) fn block(ctx: &NetworkContext, block: &Value) {
    if ctx.blocks.is_some() {
        return;
    }
    let c = &ctx.v1;
    let mut ring = lock(&c.blocks);
    let follows = ring.back().and_then(|b| b.get("id")).is_some()
        && ring.back().and_then(|b| b.get("id")) == block.get("previousblockhash");
    if !follows {
        ring.clear();
    }
    ring.push_back(block.clone());
    while ring.len() > BLOCKS {
        ring.pop_front();
    }
    // Appended first, so a socket joining between the two still gets this block.
    ctx.hub.publish(
        Topic::V1Blocks,
        &text(&json!({ "block": block })),
        Snapshot::Append,
    );
    ctx.hub
        .set_snapshot(Topic::V1Blocks, text(&json!({ "blocks": &*ring })));
    let full = ring.len() == BLOCKS;
    drop(ring);
    c.sent.send_replace(());
    if !full {
        fill(ctx);
    }
}

/// Blocks left the best chain: the list is read again from the node. With a block table, the
/// table's next follow replaces it ([`follow_table`]).
pub(crate) fn reorg(ctx: &NetworkContext) {
    if ctx.blocks.is_some() {
        return;
    }
    lock(&ctx.v1.blocks).clear();
    ctx.hub.clear(Topic::V1Blocks);
    ctx.v1.sent.send_replace(());
    fill(ctx);
}

/// With a block table, the blocks are the table's, each the JSON `GET /api/v1/blocks` lists it
/// as: read again each time the table follows the chain, so a new block goes out once its row,
/// and the audit written before it, are there. A failed read is tried again after [`RETRY`].
async fn follow_table(ctx: Arc<NetworkContext>) {
    let Some(table) = &ctx.blocks else { return };
    let mut followed = table.followed.subscribe();
    loop {
        let read = crate::v1_blocks::newest(&ctx, BLOCKS as u32).await;
        let failed = read.is_err();
        if let Ok(mut list) = read {
            list.reverse();
            from_table(&ctx, list);
        }
        tokio::select! {
            r = followed.changed() => if r.is_err() { return },
            () = tokio::time::sleep(RETRY), if failed => {}
        }
    }
}

/// The table's newest blocks, oldest first. Each block after the last one sent goes out as
/// `block`, in order; a list that does not reach back to it (a reorg, or more new blocks than the
/// list holds) is sent whole as `blocks`. So no block is sent twice.
fn from_table(ctx: &NetworkContext, list: Vec<Value>) {
    if list.is_empty() {
        return;
    }
    let mut ring = lock(&ctx.v1.blocks);
    let last = ring.back().and_then(|b| b.get("id"));
    match last.and_then(|l| list.iter().position(|b| b.get("id") == Some(l))) {
        Some(i) => {
            for b in list.iter().skip(i + 1) {
                let msg = text(&json!({ "block": b }));
                ctx.hub.publish(Topic::V1Blocks, &msg, Snapshot::Append);
            }
            *ring = list.into();
            // Also when no block is new: a row rated since changes its extras.
            ctx.hub
                .set_snapshot(Topic::V1Blocks, text(&json!({ "blocks": &*ring })));
        }
        None => {
            *ring = list.into();
            let msg = text(&json!({ "blocks": &*ring }));
            ctx.hub.publish(Topic::V1Blocks, &msg, Snapshot::Replace);
        }
    }
    drop(ring);
    ctx.v1.sent.send_replace(());
}

/// Reads the node's recent blocks for the `blocks` state, once at a time. Taken only when they
/// end at the block last announced, so a read that raced a newer block is not used.
fn fill(ctx: &NetworkContext) {
    let c = &ctx.v1;
    let Some(esplora) = c.esplora.clone() else {
        return;
    };
    if c.filling.swap(true, Ordering::AcqRel) {
        return;
    }
    let hub = Arc::clone(&ctx.hub);
    let v1 = Arc::clone(&ctx.v1);
    tokio::spawn(async move {
        let got = recent_blocks(&esplora).await;
        v1.filling.store(false, Ordering::Release);
        let Some(mut list) = got else {
            return;
        };
        list.truncate(BLOCKS);
        list.reverse();
        let mut ring = lock(&v1.blocks);
        let id = |b: Option<&Value>| b.and_then(|b| b.get("id")).cloned();
        if ring.is_empty() || id(ring.back()) == id(list.last()) {
            *ring = list.into();
            // Sent too: a socket that wanted blocks before the list was read has only the tip.
            hub.publish(
                Topic::V1Blocks,
                &text(&json!({ "blocks": &*ring })),
                Snapshot::Replace,
            );
            drop(ring);
            v1.sent.send_replace(());
        }
    });
}

/// The node's ten newest blocks, newest first.
async fn recent_blocks(esplora: &Esplora) -> Option<Vec<Value>> {
    let raw = esplora
        .raw(&Route::Blocks { start_height: None })
        .await
        .ok()?;
    if !raw.status.is_success() {
        return None;
    }
    let list: Vec<Value> = serde_json::from_slice(&raw.body).ok()?;
    list.iter()
        .all(|b| b.get("id").and_then(Value::as_str).is_some())
        .then_some(list)
}

/// The newest transactions the `transactions` topic last published: `(txid, time, fee, vsize,
/// value)`, newest first.
pub(crate) fn latest(c: &Compat, list: impl Iterator<Item = (Txid, u32, u64, u32, u64)>) {
    let txs: Vec<Value> = list
        .map(|(txid, time, fee, vsize, value)| {
            json!({
                "txid": txid, "fee": fee, "vsize": vsize, "value": value,
                "rate": fee as f64 / f64::from(vsize.max(1)), "time": time,
            })
        })
        .collect();
    *lock(&c.latest) = Some(Value::Array(txs));
}

/// The `stats` message now: whatever of its parts the server has.
fn stats(ctx: &NetworkContext) -> Option<Value> {
    let mut m = Map::new();
    if let Some(i) = ctx.track.engines().and_then(|(t, _)| t.node_info()) {
        m.insert(
            "mempoolInfo".into(),
            json!({
                "loaded": i.loaded, "size": i.size, "bytes": i.bytes, "usage": i.usage,
                "total_fee": i.total_fee.to_btc(), "maxmempool": i.maxmempool,
                "mempoolminfee": i.mempoolminfee.to_btc(), "minrelaytxfee": i.minrelaytxfee.to_btc(),
                "incrementalrelayfee": i.incrementalrelayfee.to_btc(),
                "unbroadcastcount": i.unbroadcastcount, "fullrbf": i.fullrbf,
                "limitclustercount": i.limitclustercount, "limitclustersize": i.limitclustersize,
            }),
        );
    }
    // From the newest mempool history sample: absent without one, never a made-up zero.
    if let Some(rate) = ctx.history.inflow(engine::history::unix_now()) {
        m.insert("vBytesPerSecond".into(), rate.into());
    }
    if let Some(a) = ctx.fees.current() {
        m.insert(
            "fees".into(),
            serde_json::to_value(api_v1::precise(&a.rates)).ok()?,
        );
    }
    if let Some(a) = ctx.difficulty.current() {
        let da = api_v1::difficulty(&a, SystemTime::now());
        m.insert("da".into(), serde_json::to_value(da).ok()?);
    }
    if let Some(t) = lock(&ctx.v1.latest).clone() {
        m.insert("transactions".into(), t);
    }
    (!m.is_empty()).then_some(Value::Object(m))
}

/// What the `mempool-blocks` topic last published, and since when it has waited on a block.
#[derive(Default)]
struct Published {
    at: Option<SystemTime>,
    held: Option<Instant>,
}

/// Publishes the projected blocks the `/fees/mempool-blocks` route serves, when they changed.
/// Ones on another tip than the block last sent wait for it, for at most [`HOLD`], so after a
/// `block` the next `mempool-blocks` is on it. Called as they change and as a block is sent, so
/// one on a new block follows that block's message at once when it is ready first.
fn mempool_blocks(ctx: &NetworkContext, out: &mut Published) {
    let Some(b) = ctx.fees.blocks() else {
        return;
    };
    if out.at == Some(b.at) {
        return;
    }
    let msg = json!({ "mempool-blocks": api_v1::mempool_blocks(&b) });
    // Under the blocks' lock, so no `block` goes out between the check and the publish.
    let ring = lock(&ctx.v1.blocks);
    let sent = ring
        .back()
        .and_then(|v| v.get("id")?.as_str()?.parse::<BlockHash>().ok());
    let agrees = sent.is_none_or(|h| b.tip.is_some_and(|t| t.hash == h));
    if !agrees && out.held.get_or_insert_with(Instant::now).elapsed() < HOLD {
        return;
    }
    out.held = None;
    out.at = Some(b.at);
    ctx.hub
        .publish(Topic::V1MempoolBlocks, &text(&msg), Snapshot::Replace);
}

/// Keeps one network's compatible topics current: `stats` and `mempool-blocks` once per
/// `WS_MEMPOOL_INTERVAL_MS`, and each followed address's history when the node says it changed.
pub async fn run(ctx: Arc<NetworkContext>) {
    let mut events = ctx.electrum.events();
    let mut tick = tokio::time::interval(ctx.sockets.limits.mempool_interval);
    let mut published = Published::default();
    let mut sent = ctx.v1.sent.subscribe();
    tokio::spawn(follow_table(Arc::clone(&ctx)));
    let mut blocks = ctx.fees.blocks_changed();
    loop {
        tokio::select! {
            // A block sent, or projected blocks on a new tip: the two go out together.
            r = sent.changed() => if r.is_err() {
                return;
            } else {
                mempool_blocks(&ctx, &mut published);
            },
            r = blocks.changed() => if r.is_err() {
                return;
            } else {
                mempool_blocks(&ctx, &mut published);
            },
            _ = tick.tick() => {
                if ctx.hub.subscribers(Topic::V1Stats) > 0 {
                    // Keeps the node's estimates coming while they are what is served.
                    ctx.fees.want();
                }
                if let Some(msg) = stats(&ctx) {
                    ctx.hub.publish(Topic::V1Stats, &text(&msg), Snapshot::Replace);
                }
                mempool_blocks(&ctx, &mut published);
            }
            e = events.recv() => match e {
                Ok(electrum::Event::Status { topic: electrum::Topic::ScriptHash(sh), .. }) => {
                    ctx.v1.changed(&ctx, sh);
                }
                // Changes may have been missed.
                Ok(electrum::Event::Resynced) | Err(RecvError::Lagged(_)) => ctx.v1.changed_all(&ctx),
                Ok(_) => {}
                Err(RecvError::Closed) => return,
            },
        }
    }
}

/// Reads a followed address's newest history page and says what is new since the last read:
/// mempool transactions as `address-transactions`, confirmed ones as `block-transactions`, and
/// both as `multi-address-transactions` for `track-addresses`. The first read says nothing: it
/// is what the socket already knew when it asked. Loops while changes arrived during a read.
async fn read_address(ctx: Arc<NetworkContext>, sh: ScriptHash, epoch: u64) {
    let c = &ctx.v1;
    let Some(mut alive) = lock(&c.addresses)
        .by_script
        .get(&sh)
        .filter(|f| f.epoch == epoch)
        .map(|f| f.alive.subscribe())
    else {
        return;
    };
    loop {
        // Nobody follows it any more: stop waiting for a turn. A read already sent runs to its
        // end, keeping its turn while the node may still be working (SECURITY.md rule 11).
        let permit = tokio::select! {
            p = c.fetches.acquire() => p,
            _ = alive.changed() => return,
        };
        let page = match (permit, &c.esplora) {
            (Ok(_turn), Some(esplora)) => history(&ctx, esplora, sh).await,
            _ => None,
        };
        // Published under this lock, which `release` takes before the hub topics go, so a
        // released address is never published again.
        let mut a = lock(&c.addresses);
        let Some(f) = a.by_script.get_mut(&sh).filter(|f| f.epoch == epoch) else {
            return;
        };
        if let Some(page) = page {
            let ids = |confirmed: bool| -> HashSet<Txid> {
                page.iter()
                    .filter(|t| t.1 == confirmed)
                    .map(|t| t.0)
                    .collect()
            };
            let now = Known {
                mempool: ids(false),
                confirmed: ids(true),
            };
            if let Some(was) = &f.known {
                let new = |confirmed: bool, seen: &HashSet<Txid>| -> Vec<Value> {
                    page.iter()
                        .filter(|t| t.1 == confirmed && !seen.contains(&t.0))
                        .map(|t| t.2.clone())
                        .collect()
                };
                let (mempool, confirmed) = (new(false, &was.mempool), new(true, &was.confirmed));
                if !mempool.is_empty() || !confirmed.is_empty() {
                    publish_address(&ctx.hub, sh, &f.address, mempool, confirmed);
                }
            }
            f.known = Some(now);
        }
        if !f.again {
            f.busy = false;
            return;
        }
        f.again = false;
    }
}

fn publish_address(
    hub: &Hub,
    sh: ScriptHash,
    address: &str,
    mempool: Vec<Value>,
    confirmed: Vec<Value>,
) {
    if !mempool.is_empty() {
        let msg = json!({ "address-transactions": mempool });
        hub.publish(Topic::V1Address(sh), &text(&msg), Snapshot::Keep);
    }
    if !confirmed.is_empty() {
        let msg = json!({ "block-transactions": confirmed });
        hub.publish(Topic::V1Address(sh), &text(&msg), Snapshot::Keep);
    }
    let mut by_address = Map::new();
    by_address.insert(
        address.to_owned(),
        json!({ "mempool": mempool, "confirmed": confirmed, "removed": [] }),
    );
    let msg = json!({ "multi-address-transactions": by_address });
    hub.publish(Topic::V1Addresses(sh), &text(&msg), Snapshot::Keep);
}

/// The script's newest history page from the node: up to 50 mempool transactions and the 25
/// newest confirmed, each as `(txid, confirmed, the node's JSON)`. `None` when the node failed
/// or answered something else, or when the server knows the node will not finish it: the HTTP
/// routes' verdicts apply here too, and a read that runs past their deadline teaches one
/// (docs/API.md, "Very large addresses"; SECURITY.md rule 11).
async fn history(
    ctx: &NetworkContext,
    esplora: &Esplora,
    sh: ScriptHash,
) -> Option<Vec<(Txid, bool, Value)>> {
    let script = sh.to_string().parse().ok()?;
    let first = Some((None, None));
    let verdicts = &ctx.api.verdicts;
    if verdicts
        .check(script, first, std::time::Instant::now())
        .is_some()
    {
        return None;
    }
    let route = Route::ScriptTxs {
        script: ScriptRef::ScriptHash(script),
        after: None,
        asof: None,
    };
    let started = std::time::Instant::now();
    let raw = esplora.raw(&route).await;
    if started.elapsed() >= ctx.api.history_timeout() {
        verdicts.learn(script, first, Verdict::Slow, std::time::Instant::now());
    }
    let raw = raw.ok()?;
    if !raw.status.is_success() {
        return None;
    }
    let list: Vec<Value> = serde_json::from_slice(&raw.body).ok()?;
    list.into_iter()
        .map(|t| {
            let txid = t.get("txid")?.as_str()?.parse().ok()?;
            let confirmed = t.get("status")?.get("confirmed")?.as_bool()?;
            Some((txid, confirmed, t))
        })
        .collect()
}

#[cfg(test)]
mod tests;
