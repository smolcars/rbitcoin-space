//! The mempool.space-shaped WebSocket at `/api/v1/ws` (`docs/WS.md`, "The mempool.space-shaped
//! socket"; the shapes are `docs/compat/websocket.md`). The same hub, limits and tracking as
//! `/app/ws`, speaking the reference's JSON instead of ours.
//!
//! Every message is produced once per network and fanned out like any topic: `blocks` from the
//! hub's own block feed, `stats` and `mempool-blocks` from the answers the `/api/v1` routes serve,
//! tracked transactions from the same pass that writes the `tx:` topics, and a projected block's
//! transactions only while some socket draws it ([`drawings`]). Only an address costs the
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
use engine::mempool::{Mempool, Tracker};
use engine::projected::{Placed, ProjectedBlock, Projection, Projector};
use node::electrum::{self, ScriptHash};
use node::esplora::{Esplora, Route, ScriptRef};
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{Notify, Semaphore, watch};
use tokio::time::Instant;

use super::mempool::{MAX_APPENDED, TXS_TOPICS};
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
const UNSERVED: [&str; 5] = [
    "track-mempool",
    "track-mempool-txids",
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
    /// A socket started drawing a projected block: [`drawings`] sends it the block.
    drawings: Notify,
    /// A socket started a replacement feed: [`run`] sends the list if it has none stored.
    feeds: Notify,
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
            drawings: Notify::new(),
            feeds: Notify::new(),
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
    /// `track-mempool-block`, and when its state was last sent.
    drawing: Option<u8>,
    sent: Option<Instant>,
    /// `track-rbf` (`true` for full RBF) and `track-rbf-summary`, each with when its list was
    /// last sent.
    rbf: Option<(bool, Instant)>,
    summary: Option<Instant>,
}

impl<'a> Session<'a> {
    pub(crate) fn new(ctx: &'a Arc<NetworkContext>, conn: &'a Arc<Conn>) -> Self {
        Self {
            ctx,
            subs: Subscriptions::new(&ctx.track, conn),
            tx: None,
            address: None,
            addresses: Vec::new(),
            drawing: None,
            sent: None,
            rbf: None,
            summary: None,
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
            // What no `want` part carries, and `da`, which the reference's transaction page needs
            // for its ETA without wanting `stats`; the parts' state comes with `want`.
            Some("init") => {
                let mut init = json!({
                    "loadingIndicators": {},
                    "backend": "esplora",
                    "backendInfo": api_v1::backend_info(self.ctx),
                });
                if let (Some(m), Some(da)) = (init.as_object_mut(), da(self.ctx)) {
                    m.insert("da".into(), da);
                }
                self.send(&init);
            }
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
        if let Some(n) = m.get("track-mempool-block").and_then(Value::as_i64) {
            self.track_mempool_block(n, limits);
        }
        // Anything else stops a feed, as `"stop"` and `false` do on the reference.
        if let Some(v) = m.get("track-rbf") {
            let want = match v.as_str() {
                Some("all") => Some(false),
                Some("fullRbf") => Some(true),
                _ => None,
            };
            let held = self.rbf.map(|(full, at)| (Topic::V1Rbf(full), at));
            let now = self.feed(held, want.map(Topic::V1Rbf), "track-rbf", limits);
            self.rbf = now.zip(want).map(|((_, at), full)| (full, at));
        }
        if let Some(v) = m.get("track-rbf-summary") {
            let held = self.summary.map(|at| (Topic::V1RbfSummary, at));
            let want = (v == &Value::Bool(true)).then_some(Topic::V1RbfSummary);
            self.summary = self
                .feed(held, want, "track-rbf-summary", limits)
                .map(|(_, at)| at);
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

    /// Draws projected block `n`, replacing the last; a negative `n` stops it. The block already
    /// drawn is sent again at most once per `WS_MEMPOOL_INTERVAL_MS`: the reference's frontend asks
    /// again, up to hundreds of times a second, when it loses its place.
    fn track_mempool_block(&mut self, n: i64, limits: &WsLimits) {
        let index = u8::try_from(n)
            .ok()
            .filter(|i| usize::from(*i) < TXS_TOPICS);
        if let Some(i) = index
            && self.drawing == Some(i)
        {
            if self
                .sent
                .is_none_or(|t| t.elapsed() >= limits.mempool_interval)
            {
                self.sent = Some(Instant::now());
                // The topic's stored state again: frames already encoded, queued by reference.
                self.ctx
                    .hub
                    .subscribe(Topic::V1ProjectedTxs(i), self.subs.conn());
            }
            return;
        }
        if let Some(old) = self.drawing.take() {
            self.subs.part(Topic::V1ProjectedTxs(old));
        }
        let Some(i) = index else {
            if n >= 0 {
                let last = TXS_TOPICS - 1;
                self.error(
                    "track-mempool-block",
                    &format!("projected blocks 0 to {last} are served"),
                );
            }
            return;
        };
        match self.subs.join(Topic::V1ProjectedTxs(i), "", limits) {
            Ok(_) => {
                self.drawing = Some(i);
                self.sent = Some(Instant::now());
                self.ctx.v1.drawings.notify_one();
            }
            Err(_) => self.error(
                "track-mempool-block",
                "too many subscriptions on this connection",
            ),
        }
    }

    /// A replacement feed follows `want` instead of `held`, the topic it followed and when its
    /// list was last sent; `None` stops it. Returns what it follows now. The topic already
    /// followed, asked again, is sent its stored list again at most once per
    /// `WS_MEMPOOL_INTERVAL_MS`; the rest are ignored.
    fn feed(
        &mut self,
        held: Option<(Topic, Instant)>,
        want: Option<Topic>,
        key: &str,
        limits: &WsLimits,
    ) -> Option<(Topic, Instant)> {
        if let (Some((t, sent)), Some(w)) = (held, want)
            && t == w
        {
            if sent.elapsed() < limits.mempool_interval {
                return held;
            }
            // The topic's stored list again: a frame already encoded, queued by reference.
            self.ctx.hub.subscribe(t, self.subs.conn());
            return Some((t, Instant::now()));
        }
        if let Some((old, _)) = held {
            self.subs.part(old);
        }
        let t = want?;
        match self.subs.join(t, "", limits) {
            Ok(_) => {
                self.ctx.v1.feeds.notify_one();
                Some((t, Instant::now()))
            }
            Err(_) => {
                self.error(key, "too many subscriptions on this connection");
                None
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
    if let Some(da) = da(ctx) {
        m.insert("da".into(), da);
    }
    if let Some(t) = lock(&ctx.v1.latest).clone() {
        m.insert("transactions".into(), t);
    }
    (!m.is_empty()).then_some(Value::Object(m))
}

/// `GET /api/v1/difficulty-adjustment`'s answer, from the figures held in memory; `None` before
/// the first tip was read.
fn da(ctx: &NetworkContext) -> Option<Value> {
    let a = ctx.difficulty.current()?;
    serde_json::to_value(api_v1::difficulty(&a, SystemTime::now())).ok()
}

/// The replacement feeds' topics: `track-rbf` `"all"` and `"fullRbf"`, and `track-rbf-summary`.
const FEEDS: [Topic; 3] = [Topic::V1Rbf(false), Topic::V1Rbf(true), Topic::V1RbfSummary];

/// What the replacement feeds last published: the record's version each topic's list is of
/// (`None` while nobody follows it, its list cleared), and when the last list went out.
#[derive(Default)]
struct Feeds {
    version: [Option<u64>; 3],
    at: Option<Instant>,
}

impl Feeds {
    /// Publishes each followed feed's list when the record changed since it was last sent, and
    /// clears the lists nobody follows, so nothing is encoded for nobody. `tick` is the
    /// `WS_MEMPOOL_INTERVAL_MS` tick; between ticks (a socket started a feed with no list stored)
    /// lists go out only if none did for an interval, so lists never go out more often than twice
    /// an interval. The trees are the bytes `GET /api/v1/replacements` answers, encoded once per
    /// change of the record for both.
    fn step(&mut self, ctx: &NetworkContext, tick: bool, now: Instant) {
        let mut due = [false; 3];
        for ((t, v), d) in FEEDS.iter().zip(&mut self.version).zip(&mut due) {
            if ctx.hub.subscribers(*t) > 0 {
                *d = true;
            } else if v.take().is_some() {
                ctx.hub.clear(*t);
            }
        }
        let quiet = self
            .at
            .is_some_and(|a| now < a + ctx.sockets.limits.mempool_interval);
        if !due.contains(&true) || !tick && quiet || !ctx.track.mempool_enabled() {
            return;
        }
        let msgs: Vec<(Topic, Frame)> = ctx.track.with_replacements(|r| {
            let version = r.version();
            let mut out = Vec::new();
            for ((t, v), d) in FEEDS.iter().zip(&mut self.version).zip(due) {
                if !d || *v == Some(version) {
                    continue;
                }
                *v = Some(version);
                let msg = match t {
                    Topic::V1Rbf(full) => trees(&ctx.trees.get(r, *full)),
                    _ => Some(Frame::text(&crate::transactions::summary(r))),
                };
                out.extend(msg.map(|m| (*t, m)));
            }
            out
        });
        for (t, msg) in &msgs {
            ctx.hub.publish(*t, msg, Snapshot::Replace);
        }
        if !msgs.is_empty() {
            self.at = Some(now);
        }
    }
}

/// The `rbfLatest` message.
#[derive(serde::Serialize)]
struct Latest<'a> {
    #[serde(rename = "rbfLatest")]
    list: &'a RawValue,
}

/// `{"rbfLatest":<trees>}` around a list already serialized: checked as JSON, not encoded again.
fn trees(list: &[u8]) -> Option<Frame> {
    let list: &RawValue = serde_json::from_slice(list).ok()?;
    serde_json::to_vec(&Latest { list })
        .ok()
        .map(|b| Frame::text(&b))
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

/// What [`drawings`] last sent of each projected block, and when it may send changes next.
#[derive(Default)]
struct Drawings {
    /// What each drawn topic's sockets hold; `None` while no socket draws it.
    drawn: [Option<Drawn>; TXS_TOPICS],
    /// Each block's last `sequence`: one more for every message, never reset, so whatever a
    /// socket joins or leaves, the messages it gets rise by exactly one.
    sequence: [u64; TXS_TOPICS],
    /// The projection, and its tip, that the last changes came from.
    seq: Option<u64>,
    tip: Option<node::esplora::ChainTip>,
    next: Option<Instant>,
    /// Since when the projection has been on another tip than the last `block` sent.
    held: Option<Instant>,
}

/// One drawn block: the block its sockets hold, and the messages and transactions appended to
/// its stored state since the last whole list.
struct Drawn {
    block: Arc<ProjectedBlock>,
    appended: usize,
    changes: usize,
}

/// Feeds `projected-block-transactions` for each projected block a compatible socket draws: its
/// transactions when the first socket asks, then its changes, at most once per
/// `WS_MEMPOOL_INTERVAL_MS` but at once on a new tip. Each message is encoded once for every
/// socket drawing that block, and a block nobody draws is not encoded at all. Held against
/// `block` as [`mempool_blocks`] is.
pub(crate) async fn drawings(ctx: Arc<NetworkContext>, tracker: Tracker, projector: Projector) {
    let mut d = Drawings::default();
    let mut sent = ctx.v1.sent.subscribe();
    loop {
        let (p, mut sub) = projector.subscribe();
        let wake = d.step(&ctx, &tracker, &p, Instant::now());
        tokio::select! {
            r = sub.recv() => if let Err(RecvError::Closed) = r {
                return;
            },
            r = sent.changed() => if r.is_err() {
                return;
            },
            () = ctx.v1.drawings.notified() => {}
            () = super::mempool::sleep_until(wake) => {}
        }
    }
}

impl Drawings {
    /// Sends what is due; returns when to look again, if before the next projection.
    fn step(
        &mut self,
        ctx: &NetworkContext,
        tracker: &Tracker,
        p: &Projection,
        now: Instant,
    ) -> Option<Instant> {
        let topic = |i: usize| Topic::V1ProjectedTxs(u8::try_from(i).unwrap_or(u8::MAX));
        let mut watched = false;
        for (i, drawn) in self.drawn.iter_mut().enumerate() {
            if ctx.hub.subscribers(topic(i)) > 0 {
                watched = true;
            } else if drawn.take().is_some() {
                ctx.hub.clear(topic(i));
            }
        }
        // Before the tracker's first cycle the projection is empty, not the mempool.
        if !watched || p.tip.is_none() {
            self.held = None;
            return None;
        }
        // Under the blocks' lock, so no `block` goes out between the check and the publish.
        let ring = lock(&ctx.v1.blocks);
        let sent = ring
            .back()
            .and_then(|v| v.get("id")?.as_str()?.parse::<BlockHash>().ok());
        if sent.is_none_or(|h| p.tip.is_some_and(|t| t.hash == h)) {
            self.held = None;
        } else {
            let until = *self.held.get_or_insert(now) + HOLD;
            if now < until {
                return Some(until);
            }
        }
        let changed = self.seq != Some(p.seq);
        let due = changed && (p.tip != self.tip || self.next.is_none_or(|n| now >= n));
        let empty = Arc::new(ProjectedBlock::default());
        let all = self.drawn.iter_mut().zip(self.sequence.iter_mut());
        for (i, (drawn, sequence)) in all.enumerate() {
            let t = topic(i);
            let block = p.blocks.get(i).unwrap_or(&empty);
            let index = u8::try_from(i).unwrap_or(u8::MAX);
            // A block drawn above keeps up even if its last socket just left: a socket joining
            // now gets its stored state, which must not fall behind `self.seq`.
            let Some(d) = drawn else {
                if ctx.hub.subscribers(t) == 0 {
                    continue;
                }
                *sequence += 1;
                let msg = whole(tracker, index, *sequence, block);
                ctx.hub.publish(t, &text(&msg), Snapshot::Replace);
                *drawn = Some(Drawn {
                    block: Arc::clone(block),
                    appended: 0,
                    changes: 0,
                });
                continue;
            };
            if !due {
                continue;
            }
            let Some((msg, size)) = changes(tracker, index, *sequence + 1, &d.block, block) else {
                continue;
            };
            *sequence += 1;
            d.block = Arc::clone(block);
            // A block found changes most of it: the whole list is smaller, as the reference sends.
            if size >= block.txs.len() {
                let msg = whole(tracker, index, *sequence, block);
                ctx.hub.publish(t, &text(&msg), Snapshot::Replace);
                (d.appended, d.changes) = (0, 0);
                continue;
            }
            ctx.hub.publish(t, &text(&msg), Snapshot::Append);
            d.appended += 1;
            d.changes += size;
            // A new socket gets the state and every change since: keep that short.
            if d.appended >= MAX_APPENDED || d.changes >= block.txs.len() {
                let msg = whole(tracker, index, *sequence, block);
                ctx.hub.set_snapshot(t, text(&msg));
                (d.appended, d.changes) = (0, 0);
            }
        }
        drop(ring);
        if due {
            self.seq = Some(p.seq);
            self.tip = p.tip;
            self.next = Some(now + ctx.sockets.limits.mempool_interval);
            return None;
        }
        changed.then_some(self.next).flatten()
    }
}

/// A transaction as the reference draws it: txid, fee, vsize, total output value, effective rate
/// in sat/vB, flags and when the node accepted it.
fn row(m: &Mempool, (txid, p): &(Txid, Placed)) -> Value {
    // Gone from the tracker since this projection: its value and time are no longer known.
    let (value, time) = m.get(txid).map_or((0, 0), |i| (i.value.to_sat(), i.time));
    json!([txid, p.fee, p.vsize, value, rate(p.rate), p.flags, time])
}

/// Sat per 1,000 vB to sat/vB.
fn rate(r: u32) -> f64 {
    f64::from(r) / 1000.0
}

/// The block's whole list, in mining order.
pub(super) fn whole(tracker: &Tracker, index: u8, sequence: u64, b: &ProjectedBlock) -> Value {
    let txs: Vec<Value> = tracker.read(|m| b.txs.iter().map(|t| row(m, t)).collect());
    json!({ "projected-block-transactions": {
        "index": index, "sequence": sequence, "blockTransactions": txs,
    }})
}

/// The changes from `old` to `new`, and how many there are; `None` when there are none.
fn changes(
    tracker: &Tracker,
    index: u8,
    sequence: u64,
    old: &ProjectedBlock,
    new: &ProjectedBlock,
) -> Option<(Value, usize)> {
    let before: HashMap<&Txid, &Placed> = old.txs.iter().map(|(t, p)| (t, p)).collect();
    let now: HashSet<&Txid> = new.txs.iter().map(|(t, _)| t).collect();
    let removed: Vec<&Txid> = old
        .txs
        .iter()
        .map(|(t, _)| t)
        .filter(|t| !now.contains(t))
        .collect();
    let (mut added, mut changed) = (Vec::new(), Vec::new());
    tracker.read(|m| {
        for t in &new.txs {
            match before.get(&t.0) {
                None => added.push(row(m, t)),
                // A transaction's fee and size are its own: only its rate and flags can change.
                Some(b) if (b.rate, b.flags) != (t.1.rate, t.1.flags) => {
                    changed.push(json!([t.0, rate(t.1.rate), t.1.flags, 0]));
                }
                Some(_) => {}
            }
        }
    });
    let size = removed.len() + added.len() + changed.len();
    (size > 0).then(|| {
        let delta = json!({ "added": added, "removed": removed, "changed": changed });
        let msg = json!({ "projected-block-transactions": {
            "index": index, "sequence": sequence, "delta": delta,
        }});
        (msg, size)
    })
}

/// Keeps one network's compatible topics current: `stats`, `mempool-blocks` and the replacement
/// feeds once per `WS_MEMPOOL_INTERVAL_MS`, and each followed address's history when the node says it changed.
pub async fn run(ctx: Arc<NetworkContext>) {
    let mut events = ctx.electrum.events();
    let mut tick = tokio::time::interval(ctx.sockets.limits.mempool_interval);
    let mut published = Published::default();
    let mut sent = ctx.v1.sent.subscribe();
    tokio::spawn(follow_table(Arc::clone(&ctx)));
    let mut blocks = ctx.fees.blocks_changed();
    let mut feeds = Feeds::default();
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
                feeds.step(&ctx, true, Instant::now());
            }
            () = ctx.v1.feeds.notified() => feeds.step(&ctx, false, Instant::now()),
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
    let script = node::esplora::ScriptHash::from_electrum(sh);
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
        // Refused for size, as the HTTP routes learn it: the size is known and not asked again.
        if node::esplora::Error::from_status(raw.status, &raw.body)
            == node::esplora::Error::TooLarge
        {
            let size = node::esplora::ScriptSize::from_refusal(&raw.body);
            verdicts.learn(
                script,
                None,
                Verdict::TooLarge(size),
                std::time::Instant::now(),
            );
        }
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
