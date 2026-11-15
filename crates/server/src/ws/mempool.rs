//! The live mempool over the WebSocket: runs one network's tracker and projector, and feeds the
//! `mempool`, `projected`, `projected-txs:N` and `transactions` topics from them. The protocol
//! is `docs/WS.md`; how the engines run is `docs/MEMPOOL.md`.
//!
//! Every topic is produced once per network, whatever the number of subscribers, from state the
//! engines already hold: a subscription never causes work on the node (SECURITY.md rule 10).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use bitcoin::Txid;
use bitcoin::hashes::Hash;
use engine::mempool::{self, Mempool, NodeSource, SourceError, Tracker, TxInfo};
use engine::projected::{self, BANDS, Placed, ProjectedBlock, Projection, Projector};
use logging::events::{
    MempoolBlock, MempoolPollFailed, MempoolRecovered, MempoolSequenceRegressed,
    MempoolSubscriberLagged, MempoolSummary, MempoolSynced, ProjectionFetchFailed,
    ProjectionRecovered, ProjectionResynced,
};
use node::electrum;
use node::esplora::{ChainTip, Esplora};
use node::rpc::Rpc;
use serde_json::{Value, json};
use tokio::sync::broadcast::error::RecvError;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::{Frame, Hub, Snapshot, Topic, frame};
use crate::NetworkContext;
use crate::config::{EsploraEndpoint, NetworkConfig};

/// Projected blocks whose transactions a client can subscribe to: every one but the last, which
/// holds the rest of the mempool and so has no size bound. The rest are bounded by block weight.
pub const TXS_TOPICS: usize = 7;

/// Byte 0 of a binary frame: a projected block's whole state.
pub const KIND_SNAPSHOT: u8 = 1;
/// Byte 0 of a binary frame: changes to a projected block since the previous frame.
pub const KIND_DELTA: u8 = 2;
/// Byte 1 of both kinds. Bumped when their layout changes.
pub const FORMAT_VERSION: u8 = 1;
/// One transaction: txid 32, rate 4, vsize 4, fee 8.
pub const RECORD: usize = 48;
const SNAPSHOT_HEAD: usize = 16;
const DELTA_HEAD: usize = 32;
/// Changes kept after a topic's state for new subscribers before they are folded into a new
/// state. Well under the send queue, so a new subscriber never fills it on its own.
pub(super) const MAX_APPENDED: usize = 16;
/// How often a healthy network writes a `mempool_summary` line.
const SUMMARY_EVERY: Duration = Duration::from_secs(60);
/// Longest a projection waits for the `blocks` topic to announce its tip (or for one on the
/// announced tip): the tracker's own limit for waiting on the node to serve a new block.
pub(super) const HOLD: Duration = Duration::from_secs(3);

/// Every topic this module produces.
fn topics() -> impl Iterator<Item = Topic> {
    [
        Topic::Mempool,
        Topic::Projected,
        Topic::Transactions,
        Topic::Replacements,
    ]
    .into_iter()
    .chain((0..TXS_TOPICS).filter_map(|i| u8::try_from(i).ok().map(Topic::ProjectedTxs)))
}

/// Starts the network's tracker and projector on their own node clients, and the tasks that
/// feed the topics from them. All of it stops when shutdown starts. With the engine switched off,
/// each topic's state says so instead.
pub fn start(ctx: &Arc<NetworkContext>) {
    if !ctx.config.mempool {
        for topic in topics() {
            let msg = json!({ "topic": topic.name(), "type": "off" });
            ctx.hub.publish(
                topic,
                &Frame::text(msg.to_string().as_bytes()),
                Snapshot::Replace,
            );
        }
        // Fee recommendations fall back to the node's own estimates.
        let fees = tokio::spawn(super::fees::run(Arc::clone(ctx), None, Default::default()));
        abort_on_shutdown(ctx, vec![fees]);
        return;
    }
    // Their own clients, so the byte counts in the events are the engines' traffic alone.
    let Some((rpc, esplora)) = clients(&ctx.config) else {
        return;
    };
    let Some((projector_rpc, _)) = clients(&ctx.config) else {
        return;
    };
    let (tracker, tracker_task) =
        Tracker::start(NodeSource { rpc, esplora }, mempool::Config::default());
    let (projector, projector_task) =
        Projector::start(tracker.clone(), projector_rpc, projected::Config::default());
    let mut tasks = run(ctx, &tracker, &projector);
    tasks.extend(crate::statistics::start(ctx, &tracker, &projector));
    tasks.push(tracker_task);
    tasks.push(projector_task);
    abort_on_shutdown(ctx, tasks);
}

/// Stops `tasks` when shutdown starts.
fn abort_on_shutdown(ctx: &NetworkContext, tasks: Vec<JoinHandle<()>>) {
    let mut shutdown = ctx.sockets.shutdown.subscribe();
    tokio::spawn(async move {
        super::until(&mut shutdown, |s| *s).await;
        for task in tasks {
            task.abort();
        }
    });
}

/// RPC and Esplora clients for one network. `None` cannot happen: `Config` checked the endpoints
/// by the clients' own rules.
fn clients(config: &NetworkConfig) -> Option<(Rpc, Esplora)> {
    let url = match &config.esplora {
        EsploraEndpoint::Http(url) => url.clone(),
        EsploraEndpoint::Unix(path) => path.to_string_lossy().into_owned(),
    };
    let rpc = &config.rpc;
    Some((
        Rpc::new(&rpc.host, rpc.port, &rpc.user, rpc.password.expose()).ok()?,
        Esplora::new(&url).ok()?,
    ))
}

/// Starts the tasks that follow running engines: the tip hint, the topics and the log. Returns
/// them so the caller can stop them.
pub(crate) fn run(
    ctx: &Arc<NetworkContext>,
    tracker: &Tracker,
    projector: &Projector,
) -> Vec<JoinHandle<()>> {
    let stats = Arc::new(Mutex::new(Sent::default()));
    let found = Arc::new(Mutex::new(None));
    ctx.track.attach(tracker, projector);
    let (kept, writer) = crate::replacements::writer(ctx).unzip();
    let mut tasks: Vec<JoinHandle<()>> = writer.into_iter().collect();
    tasks.extend(super::fees::score::start(ctx, tracker, projector));
    tasks.extend([
        tokio::spawn(super::track::follow_txs(
            Arc::clone(&ctx.track),
            ctx.sockets.limits.mempool_interval,
            kept,
            ctx.esplora.clone(),
        )),
        tokio::spawn(hint(
            tracker.clone(),
            ctx.electrum.events(),
            Arc::clone(&found),
        )),
        tokio::spawn(projected_feed(
            Arc::clone(ctx),
            projector.clone(),
            tracker.clone(),
            Arc::clone(&stats),
            Arc::clone(&found),
        )),
        tokio::spawn(latest_feed(
            Arc::clone(ctx),
            tracker.clone(),
            Arc::clone(&stats),
        )),
        tokio::spawn(super::v1::drawings(
            Arc::clone(ctx),
            tracker.clone(),
            projector.clone(),
        )),
        tokio::spawn(report(
            ctx.config.network.name(),
            tracker.clone(),
            projector.clone(),
            stats,
            found,
        )),
        tokio::spawn(super::fees::run(
            Arc::clone(ctx),
            Some(super::fees::Engines {
                tracker: tracker.clone(),
                projector: projector.clone(),
            }),
            Default::default(),
        )),
    ]);
    tasks
}

/// A new block's way through the engines and the topics, for its `mempool_block` line.
#[derive(Debug, Clone, Copy)]
struct Found {
    height: u32,
    /// When Electrum announced it.
    at: Instant,
    tracker: Option<Duration>,
    path: &'static str,
    confirmed: usize,
    replaced: usize,
    node_calls: u32,
    node_bytes: u64,
    sent: Option<Duration>,
}

type Clock = Arc<Mutex<Option<Found>>>;

fn clock(c: &Clock) -> std::sync::MutexGuard<'_, Option<Found>> {
    c.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Hands every block Electrum announces to the tracker, which drops what it confirmed at once;
/// after a reorg or missed events, polls at once instead.
async fn hint(
    tracker: Tracker,
    mut events: tokio::sync::broadcast::Receiver<electrum::Event>,
    found: Clock,
) {
    loop {
        match events.recv().await {
            Ok(electrum::Event::Block(tip)) => {
                *clock(&found) = Some(Found {
                    height: tip.height,
                    at: Instant::now(),
                    tracker: None,
                    path: "listing",
                    confirmed: 0,
                    replaced: 0,
                    node_calls: 0,
                    node_bytes: 0,
                    sent: None,
                });
                tracker.block_found(ChainTip {
                    hash: tip.hash,
                    height: tip.height,
                });
            }
            Ok(electrum::Event::Reorg { .. }) | Err(RecvError::Lagged(_)) => tracker.tip_changed(),
            Ok(_) => {}
            Err(RecvError::Closed) => return,
        }
    }
}

/// What the topics sent since the last summary line.
#[derive(Debug, Default)]
struct Sent {
    messages: u64,
    bytes: u64,
    sent_bytes: u64,
    dropped_slow: u64,
    fanout_ms_max: f64,
}

fn publish(hub: &Hub, stats: &Mutex<Sent>, topic: Topic, frame: &Frame, snapshot: Snapshot) {
    let f = hub.publish(topic, frame, snapshot);
    let mut s = stats.lock().unwrap_or_else(PoisonError::into_inner);
    let len = frame.len() as u64;
    s.messages += 1;
    s.bytes += len;
    s.sent_bytes += len * f.subscribers as u64;
    s.dropped_slow += f.dropped_slow as u64;
    s.fanout_ms_max = s.fanout_ms_max.max(f.elapsed.as_secs_f64() * 1000.0);
}

// Projected blocks: `mempool`, `projected` and `projected-txs:N`.

/// Publishes the projection at most once per `WS_MEMPOOL_INTERVAL_MS`, always its latest state,
/// except that one on a new tip goes out at once. It reads whole projections and compares them
/// with what it published, so it can never lose its place in the projector's stream. The node's
/// minimum fee rate can move on its own, so it is also checked once per interval.
///
/// The order `docs/WS.md` promises: a projection on another tip than the block the `blocks` topic
/// last announced waits for the two to agree, for at most [`HOLD`]. So after a block's message,
/// the next mempool messages are on that block, and none comes before it.
async fn projected_feed(
    ctx: Arc<NetworkContext>,
    projector: Projector,
    tracker: Tracker,
    stats: Arc<Mutex<Sent>>,
    found: Clock,
) {
    let interval = ctx.sockets.limits.mempool_interval;
    let mut announced = ctx.hub.announced();
    let mut out = Published::default();
    let mut next = Instant::now();
    // Since when the projection and the announced block have disagreed.
    let mut held: Option<Instant> = None;
    loop {
        let (p, mut sub) = projector.subscribe();
        let min_fee = tracker.node_info().map(|i| i.mempoolminfee);
        drop(announced.borrow_and_update());
        // Before the tracker's first cycle the projection is empty, not the mempool.
        let changed = p.tip.is_some() && (out.seq != Some(p.seq) || out.min_fee != min_fee);
        let new_tip = p.tip != out.tip;
        let wake = ctx.hub.in_block_order(|block| {
            let now = Instant::now();
            let agrees = block.is_none_or(|b| p.tip.is_some_and(|t| t.hash == b));
            let hold_until = if agrees {
                held = None;
                None
            } else {
                Some(*held.get_or_insert(now) + HOLD)
            };
            if !changed {
                None
            } else if hold_until.is_some_and(|t| now < t) {
                hold_until
            } else if new_tip || now >= next {
                out.publish(&ctx.hub, &stats, &p, min_fee);
                next = now + interval;
                if let (Some(t), Some(f)) = (p.tip, clock(&found).as_mut())
                    && t.height == f.height
                    && f.sent.is_none()
                {
                    f.sent = Some(f.at.elapsed());
                }
                None
            } else {
                Some(next)
            }
        });
        tokio::select! {
            r = sub.recv() => if let Err(RecvError::Closed) = r {
                return;
            },
            r = announced.changed() => if r.is_err() {
                return;
            },
            () = sleep_until(wake) => {}
            () = tokio::time::sleep(interval) => {}
        }
    }
}

pub(super) async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// What the projected topics last published.
#[derive(Default)]
struct Published {
    seq: Option<u64>,
    tip: Option<ChainTip>,
    min_fee: Option<bitcoin::Amount>,
    blocks: [Option<TxsTopic>; TXS_TOPICS],
}

/// One `projected-txs:N` topic: the block its subscribers hold, and the changes appended to its
/// stored state.
struct TxsTopic {
    /// The projection the last frame came from: the next delta's `prev`.
    seq: u64,
    block: Arc<ProjectedBlock>,
    appended: usize,
    appended_bytes: usize,
}

impl Published {
    fn publish(
        &mut self,
        hub: &Hub,
        stats: &Mutex<Sent>,
        p: &Projection,
        min_fee: Option<bitcoin::Amount>,
    ) {
        let moved = self.seq.replace(p.seq) != Some(p.seq);
        self.min_fee = min_fee;
        self.tip = p.tip;
        let text = |v: Value| Frame::text(v.to_string().as_bytes());
        publish(
            hub,
            stats,
            Topic::Mempool,
            &text(totals(p, min_fee)),
            Snapshot::Replace,
        );
        // Only the minimum fee rate moved.
        if !moved {
            return;
        }
        publish(
            hub,
            stats,
            Topic::Projected,
            &text(projected(p)),
            Snapshot::Replace,
        );
        let empty = Arc::new(ProjectedBlock::default());
        for (i, slot) in self.blocks.iter_mut().enumerate() {
            let Ok(index) = u8::try_from(i) else {
                continue;
            };
            let topic = Topic::ProjectedTxs(index);
            let block = p.blocks.get(i).unwrap_or(&empty);
            let Some(last) = slot else {
                let frame = Frame::encode(frame::BINARY, &snapshot(index, p.seq, block));
                publish(hub, stats, topic, &frame, Snapshot::Replace);
                *slot = Some(TxsTopic::new(p.seq, block));
                continue;
            };
            let (removed, set) = diff(&last.block, block);
            if removed.is_empty() && set.is_empty() {
                continue;
            }
            let whole = SNAPSHOT_HEAD + block.txs.len() * RECORD;
            let change = DELTA_HEAD + removed.len() * 32 + set.len() * RECORD;
            if change >= whole {
                let frame = Frame::encode(frame::BINARY, &snapshot(index, p.seq, block));
                publish(hub, stats, topic, &frame, Snapshot::Replace);
                *last = TxsTopic::new(p.seq, block);
                continue;
            }
            let payload = delta(index, p.seq, last.seq, &removed, &set);
            publish(
                hub,
                stats,
                topic,
                &Frame::encode(frame::BINARY, &payload),
                Snapshot::Append,
            );
            last.seq = p.seq;
            last.block = Arc::clone(block);
            last.appended += 1;
            last.appended_bytes += change;
            // A new subscriber gets the state and every change since: keep that short.
            if last.appended >= MAX_APPENDED || last.appended_bytes >= whole {
                let frame = Frame::encode(frame::BINARY, &snapshot(index, p.seq, block));
                hub.set_snapshot(topic, frame);
                *last = TxsTopic::new(p.seq, block);
            }
        }
    }
}

impl TxsTopic {
    fn new(seq: u64, block: &Arc<ProjectedBlock>) -> Self {
        Self {
            seq,
            block: Arc::clone(block),
            appended: 0,
            appended_bytes: 0,
        }
    }
}

/// Transactions that left `old` (the mempool or this block), and those new to it or changed,
/// in `new`'s mining order.
fn diff<'a>(
    old: &'a ProjectedBlock,
    new: &'a ProjectedBlock,
) -> (Vec<&'a Txid>, Vec<&'a (Txid, Placed)>) {
    let before: HashMap<&Txid, &Placed> = old.txs.iter().map(|(t, p)| (t, p)).collect();
    let now: HashSet<&Txid> = new.txs.iter().map(|(t, _)| t).collect();
    let removed = old
        .txs
        .iter()
        .map(|(t, _)| t)
        .filter(|t| !now.contains(t))
        .collect();
    let set = new
        .txs
        .iter()
        .filter(|(t, p)| before.get(t).is_none_or(|b| !same(b, p)))
        .collect();
    (removed, set)
}

/// Whether a record changed, as the client sees it (the block index is the topic's own).
fn same(a: &Placed, b: &Placed) -> bool {
    (a.rate, a.vsize, a.fee) == (b.rate, b.vsize, b.fee)
}

/// A txid as it is written in hex, which is the reverse of its internal byte order.
fn txid_bytes(t: &Txid) -> [u8; 32] {
    let mut b = t.to_byte_array();
    b.reverse();
    b
}

fn record(out: &mut Vec<u8>, (txid, p): &(Txid, Placed)) {
    out.extend_from_slice(&txid_bytes(txid));
    out.extend_from_slice(&p.rate.to_le_bytes());
    out.extend_from_slice(&p.vsize.to_le_bytes());
    out.extend_from_slice(&p.fee.to_le_bytes());
}

/// Kind 1: `[1, version, block, 0, count u32, seq u64]`, then `count` records in mining order.
fn snapshot(block: u8, seq: u64, b: &ProjectedBlock) -> Vec<u8> {
    let mut out = Vec::with_capacity(SNAPSHOT_HEAD + b.txs.len() * RECORD);
    out.extend_from_slice(&[KIND_SNAPSHOT, FORMAT_VERSION, block, 0]);
    out.extend_from_slice(&count(b.txs.len()));
    out.extend_from_slice(&seq.to_le_bytes());
    for r in &b.txs {
        record(&mut out, r);
    }
    out
}

/// Kind 2: `[2, version, block, 0, removed u32, seq u64, prev u64, set u32, 0 u32]`, then
/// `removed` txids and `set` records.
fn delta(block: u8, seq: u64, prev: u64, removed: &[&Txid], set: &[&(Txid, Placed)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(DELTA_HEAD + removed.len() * 32 + set.len() * RECORD);
    out.extend_from_slice(&[KIND_DELTA, FORMAT_VERSION, block, 0]);
    out.extend_from_slice(&count(removed.len()));
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&prev.to_le_bytes());
    out.extend_from_slice(&count(set.len()));
    out.extend_from_slice(&[0; 4]);
    for t in removed {
        out.extend_from_slice(&txid_bytes(t));
    }
    for r in set {
        record(&mut out, r);
    }
    out
}

/// A block holds at most a few tens of thousands of transactions.
fn count(n: usize) -> [u8; 4] {
    u32::try_from(n).unwrap_or(u32::MAX).to_le_bytes()
}

fn tip_json(tip: Option<ChainTip>) -> Value {
    tip.map_or(
        Value::Null,
        |t| json!({ "height": t.height, "hash": t.hash }),
    )
}

/// The `mempool` message: the projection's blocks together are the whole mempool.
fn totals(p: &Projection, min_fee: Option<bitcoin::Amount>) -> Value {
    let (mut count, mut vsize, mut fees, mut bands) = (0u64, 0u64, 0u64, [0u64; BANDS]);
    for b in &p.blocks {
        let s = &b.summary;
        count += u64::from(s.txs);
        vsize += s.vsize;
        fees += s.fees;
        for (total, v) in bands.iter_mut().zip(s.bands) {
            *total += v;
        }
    }
    json!({
        "topic": "mempool",
        "type": "mempool",
        "seq": p.seq,
        "count": count,
        "vsize": vsize,
        "fees": fees,
        // BTC per 1,000 vB in the node's answer; sat per 1,000 vB here, like every rate.
        "min_fee_rate": min_fee.map(bitcoin::Amount::to_sat),
        "bands": bands,
        "stale": p.stale,
    })
}

/// The `projected` message.
fn projected(p: &Projection) -> Value {
    let blocks: Vec<Value> = p
        .blocks
        .iter()
        .map(|b| {
            let s = &b.summary;
            json!({
                "txs": s.txs,
                "weight": s.weight,
                "vsize": s.vsize,
                "fees": s.fees,
                "min_rate": s.min_rate,
                "median_rate": s.median_rate,
                "max_rate": s.max_rate,
                "bands": s.bands,
            })
        })
        .collect();
    json!({
        "topic": "projected",
        "type": "projected",
        "seq": p.seq,
        "tip": tip_json(p.tip),
        "stale": p.stale,
        "blocks": blocks,
    })
}

// Newly seen transactions: `transactions`.

/// One row of the `transactions` list.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Seen {
    txid: Txid,
    time: u32,
    fee: u64,
    vsize: u32,
    value: u64,
}

impl Seen {
    fn new(txid: &Txid, i: &TxInfo) -> Self {
        Self {
            txid: *txid,
            time: i.time,
            fee: i.fee.to_sat(),
            vsize: i.vsize,
            value: i.value.to_sat(),
        }
    }

    /// Newest first; transactions accepted in the same second by txid.
    fn order(&self, other: &Self) -> std::cmp::Ordering {
        other.time.cmp(&self.time).then(self.txid.cmp(&other.txid))
    }
}

/// `list` with `added` merged in: the newest `limit`, each txid once (a transaction accepted
/// again keeps its newest row).
fn newest<'a>(
    mut list: Vec<Seen>,
    added: impl Iterator<Item = (&'a Txid, &'a TxInfo)>,
    limit: usize,
) -> Vec<Seen> {
    list.extend(added.map(|(t, i)| Seen::new(t, i)));
    list.sort_unstable_by(Seen::order);
    let mut seen = HashSet::new();
    list.retain(|s| seen.insert(s.txid));
    list.truncate(limit);
    list
}

/// Publishes the newest `WS_LATEST_TXS` transactions the tracker has seen, at most once per
/// `WS_MEMPOOL_INTERVAL_MS`. Each message is the whole list, so none depends on another.
async fn latest_feed(ctx: Arc<NetworkContext>, tracker: Tracker, stats: Arc<Mutex<Sent>>) {
    let limits = &ctx.sockets.limits;
    let (interval, limit) = (limits.mempool_interval, limits.latest_txs);
    let mut next = Instant::now();
    let mut published: Option<Vec<Seen>> = None;
    let mut list = Vec::new();
    loop {
        // Before the tracker's first cycle there is nothing to show yet. After a lag, what is
        // already listed stays: it is merged with the fresh snapshot, not replaced by it.
        let (init, mut sub) = tracker.subscribe(|m: &Mempool| {
            m.tip()
                .is_some()
                .then(|| newest(list.clone(), m.iter(), limit))
        });
        let mut dirty = init.is_some();
        if let Some(init) = init {
            list = init;
        }
        loop {
            tokio::select! {
                d = sub.recv() => match d {
                    Ok(d) => {
                        let added = d.added.iter().map(|(t, i)| (t, i));
                        list = newest(std::mem::take(&mut list), added, limit);
                        dirty = true;
                    }
                    // The whole list again from a fresh snapshot.
                    Err(RecvError::Lagged(_)) => break,
                    Err(RecvError::Closed) => return,
                },
                () = tokio::time::sleep_until(next), if dirty => {
                    dirty = false;
                    if published.as_ref() != Some(&list) {
                        let frame = Frame::text(latest(&list).to_string().as_bytes());
                        publish(&ctx.hub, &stats, Topic::Transactions, &frame, Snapshot::Replace);
                        super::v1::latest(&ctx.v1, list.iter().map(|s| (s.txid, s.time, s.fee, s.vsize, s.value)));
                        published = Some(list.clone());
                        next = Instant::now() + interval;
                    }
                }
            }
        }
    }
}

/// The `transactions` message, newest first.
fn latest(list: &[Seen]) -> Value {
    let txs: Vec<Value> = list
        .iter()
        .map(|s| {
            json!({
                "txid": s.txid,
                "time": s.time,
                "fee": s.fee,
                "vsize": s.vsize,
                "value": s.value,
            })
        })
        .collect();
    json!({ "topic": "transactions", "type": "transactions", "txs": txs })
}

// The log.

/// The label of a node failure, for the log. Classified from our own clients' error text, which
/// is all `SourceError::Failed` keeps.
fn error_label(e: &SourceError) -> &'static str {
    match e {
        SourceError::Busy => "busy",
        SourceError::TooBig => "response_too_big",
        SourceError::Failed(m) if m.contains("timed out") => "timeout",
        SourceError::Failed(m) if m.contains("unavailable") => "unavailable",
        SourceError::Failed(m) if m.contains("did not decode") => "decode",
        SourceError::Failed(m) if m.contains("authentication") => "auth",
        SourceError::Failed(_) => "failed",
    }
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Turns both engines' events into log lines: every abnormal condition as it happens (repeats
/// summarised at powers of two), and one `mempool_summary` a minute while things are healthy.
async fn report(
    network: &'static str,
    tracker: Tracker,
    projector: Projector,
    sent: Arc<Mutex<Sent>>,
    found: Clock,
) {
    let mut tracker_events = tracker.events();
    let mut projector_events = projector.events();
    let mut summary = summary_line(network);
    let (mut poll_failures, mut fetch_failures) = (0u32, 0u32);
    let mut lagged = [0u64; 2];
    let mut tick = tokio::time::interval_at(Instant::now() + SUMMARY_EVERY, SUMMARY_EVERY);
    loop {
        tokio::select! {
            e = tracker_events.recv() => match e {
                Ok(mempool::Event::Block(b)) => {
                    if let (Some(f), Some(tip)) = (clock(&found).as_mut(), b.tip)
                        && tip.height >= f.height
                        && f.tracker.is_none()
                    {
                        f.tracker = Some(b.since_found.unwrap_or_else(|| f.at.elapsed()));
                        f.path = "block";
                        (f.confirmed, f.replaced) = (b.confirmed, b.replaced);
                        (f.node_calls, f.node_bytes) = (b.calls, b.bytes);
                    }
                    summary.confirmed += b.confirmed as u64;
                    summary.replaced += b.replaced as u64;
                    summary.evicted += b.evicted as u64;
                    summary.node_calls += u64::from(b.calls);
                    summary.node_bytes += b.bytes;
                }
                Ok(mempool::Event::Cycle(c)) => {
                    if let (Some(f), Some(tip)) = (clock(&found).as_mut(), c.tip)
                        && tip.height >= f.height
                        && f.tracker.is_none()
                        && c.seq.is_some()
                    {
                        f.tracker = Some(f.at.elapsed());
                        (f.confirmed, f.replaced) = (c.confirmed, c.replaced);
                    }
                    if poll_failures > 0 {
                        logging::emit(&MempoolRecovered { network, failures: poll_failures });
                        poll_failures = 0;
                    }
                    summary.txs = c.size;
                    summary.cycles += 1;
                    summary.skipped += c.skipped;
                    summary.added += c.added as u64;
                    summary.confirmed += c.confirmed as u64;
                    summary.replaced += c.replaced as u64;
                    summary.evicted += c.evicted as u64;
                    summary.vanished += c.vanished as u64;
                    summary.node_calls += u64::from(c.calls);
                    summary.node_bytes += c.bytes;
                    summary.cycle_ms_max = summary.cycle_ms_max.max(ms(c.duration));
                }
                Ok(mempool::Event::Synced { duration, txs, bytes, calls }) => {
                    logging::emit(&MempoolSynced {
                        network,
                        duration_ms: ms(duration),
                        txs,
                        bytes,
                        calls,
                    });
                }
                Ok(mempool::Event::PollFailed { error, consecutive, retry_in }) => {
                    poll_failures = consecutive;
                    if consecutive.is_power_of_two() {
                        logging::emit(&MempoolPollFailed {
                            network,
                            error: error_label(&error),
                            failures: consecutive,
                            retry_in_ms: millis(retry_in),
                        });
                    }
                }
                Ok(mempool::Event::SequenceRegressed { from, to }) => {
                    logging::emit(&MempoolSequenceRegressed { network, from, to });
                }
                Ok(mempool::Event::SubscriberLagged { missed }) => {
                    lag(network, "tracker", missed, &mut lagged[0]);
                }
                Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => return,
            },
            e = projector_events.recv() => match e {
                Ok(projected::Event::Update(u)) => {
                    if u.refresh {
                        let f = clock(&found).take_if(|f| f.sent.is_some());
                        if let Some(f) = f {
                            logging::emit(&MempoolBlock {
                                network,
                                height: f.height,
                                path: f.path,
                                confirmed: f.confirmed,
                                replaced: f.replaced,
                                tracker_ms: f.tracker.map_or(0.0, ms),
                                sent_ms: f.sent.map_or(0.0, ms),
                                node_calls: f.node_calls,
                                node_bytes: f.node_bytes,
                                refresh_ms: ms(f.at.elapsed()),
                                refresh_set: u.set,
                                refresh_removed: u.removed,
                                refresh_bytes: u.bytes,
                            });
                        }
                    }
                    if fetch_failures > 0 && !u.stale {
                        logging::emit(&ProjectionRecovered { network, failures: fetch_failures });
                        fetch_failures = 0;
                    }
                    summary.updates += 1;
                    summary.cluster_calls += u64::from(u.calls);
                    summary.clusters_asked += u.asked as u64;
                    summary.cluster_bytes += u.bytes;
                    summary.pack_ms_max = summary.pack_ms_max.max(ms(u.pack));
                    summary.stale = u.stale;
                }
                Ok(projected::Event::FetchFailed { error, consecutive, pending, retry_in }) => {
                    fetch_failures = consecutive;
                    if consecutive.is_power_of_two() {
                        logging::emit(&ProjectionFetchFailed {
                            network,
                            error: error_label(&error),
                            failures: consecutive,
                            pending,
                            retry_in_ms: millis(retry_in),
                        });
                    }
                }
                Ok(projected::Event::Resynced { txs }) => {
                    logging::emit(&ProjectionResynced { network, txs });
                }
                Ok(projected::Event::SubscriberLagged { missed }) => {
                    lag(network, "projector", missed, &mut lagged[1]);
                }
                Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => return,
            },
            _ = tick.tick() => {
                let s = std::mem::take(&mut *sent.lock().unwrap_or_else(PoisonError::into_inner));
                summary.ws_messages = s.messages;
                summary.ws_bytes = s.bytes;
                summary.ws_sent_bytes = s.sent_bytes;
                summary.ws_dropped_slow = s.dropped_slow;
                summary.fanout_ms_max = s.fanout_ms_max;
                // Only while healthy: failures have lines of their own.
                if poll_failures == 0 {
                    logging::emit(&summary);
                }
                let (txs, stale) = (summary.txs, summary.stale);
                summary = MempoolSummary { txs, stale, ..summary_line(network) };
            }
        }
    }
}

fn lag(network: &'static str, source: &'static str, missed: u64, total: &mut u64) {
    *total += 1;
    if total.is_power_of_two() {
        logging::emit(&MempoolSubscriberLagged {
            network,
            source,
            missed,
            total: *total,
        });
    }
}

fn summary_line(network: &'static str) -> MempoolSummary {
    MempoolSummary {
        network,
        txs: 0,
        cycles: 0,
        skipped: 0,
        added: 0,
        confirmed: 0,
        replaced: 0,
        evicted: 0,
        vanished: 0,
        node_calls: 0,
        node_bytes: 0,
        cycle_ms_max: 0.0,
        updates: 0,
        cluster_calls: 0,
        clusters_asked: 0,
        cluster_bytes: 0,
        pack_ms_max: 0.0,
        stale: false,
        ws_messages: 0,
        ws_bytes: 0,
        ws_sent_bytes: 0,
        ws_dropped_slow: 0,
        fanout_ms_max: 0.0,
    }
}

#[cfg(test)]
pub(crate) mod tests;
