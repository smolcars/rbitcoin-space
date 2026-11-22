//! The polling shell: one loop that lists, diffs, fetches and publishes. All decisions about
//! what changed and why live in [`super::model`]; this file only moves data.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::{Arc, PoisonError, RwLock, Weak};
use std::time::Duration;

use bitcoin::{BlockHash, Transaction, Txid};
use node::esplora::{ChainTip, Esplora};
use node::rpc::model::{MempoolEntry, MempoolInfo, RawMempool};
use node::rpc::{self, Rpc};
use tokio::sync::{Notify, broadcast};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Instant;

use super::model::{BlockSpends, Delta, Mempool, Removal, TxInfo};

/// A node call that failed, in terms the loop acts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceError {
    /// The node's work queue is full.
    Busy,
    /// The answer was over the client's size cap; a smaller request may fit.
    TooBig,
    Failed(String),
}

/// Everything the tracker reads from the node. [`NodeSource`] is the real one; tests mock it.
pub trait Source: Send + Sync + 'static {
    fn mempool_info(&self) -> impl Future<Output = Result<MempoolInfo, SourceError>> + Send;
    /// The newest arrivals' txids, newest first: Esplora's `/mempool/recent`. Read with the probe
    /// so an arrival that leaves the totals unchanged still changes what the probe sees. The
    /// default, nothing, leaves the probe on the totals alone.
    fn recent(&self) -> impl Future<Output = Result<Vec<Txid>, SourceError>> + Send {
        async { Ok(Vec::new()) }
    }
    /// Every mempool txid with the node's `mempool_sequence`.
    fn listing(&self) -> impl Future<Output = Result<RawMempool, SourceError>> + Send;
    /// Entry and bytes for each txid, in order; `None` where it is no longer in the mempool.
    fn details(
        &self,
        txids: &[Txid],
    ) -> impl Future<Output = Result<Vec<Option<(MempoolEntry, Transaction)>>, SourceError>> + Send;
    fn tip(&self) -> impl Future<Output = Result<ChainTip, SourceError>> + Send;
    fn block(
        &self,
        hash: BlockHash,
    ) -> impl Future<Output = Result<bitcoin::Block, SourceError>> + Send;
    /// Response bytes read so far, for cost accounting.
    fn bytes(&self) -> u64;
    /// Node calls one [`Source::details`] makes.
    const DETAIL_CALLS: u32 = 1;
}

/// The node over JSON-RPC (listing, entries, raw transactions) and Esplora (tip, blocks).
/// Give the tracker its own clients so [`CycleStats::bytes`] counts only its traffic.
#[derive(Clone)]
pub struct NodeSource {
    pub rpc: Rpc,
    pub esplora: Esplora,
}

pub(crate) fn rpc_err(e: rpc::Error) -> SourceError {
    match e {
        rpc::Error::Busy => SourceError::Busy,
        rpc::Error::ResponseTooBig => SourceError::TooBig,
        e => SourceError::Failed(e.to_string()),
    }
}

pub(crate) fn esplora_err(e: node::esplora::Error) -> SourceError {
    match e {
        node::esplora::Error::ResponseTooBig => SourceError::TooBig,
        e => SourceError::Failed(e.to_string()),
    }
}

impl Source for NodeSource {
    const DETAIL_CALLS: u32 = 2;

    async fn mempool_info(&self) -> Result<MempoolInfo, SourceError> {
        self.rpc.mempool_info().await.map_err(rpc_err)
    }

    async fn recent(&self) -> Result<Vec<Txid>, SourceError> {
        let r = self.esplora.mempool_recent().await.map_err(esplora_err)?;
        Ok(r.value.into_iter().map(|t| t.txid).collect())
    }

    async fn listing(&self) -> Result<RawMempool, SourceError> {
        self.rpc.raw_mempool().await.map_err(rpc_err)
    }

    async fn details(
        &self,
        txids: &[Txid],
    ) -> Result<Vec<Option<(MempoolEntry, Transaction)>>, SourceError> {
        let (entries, txs) = tokio::join!(
            self.rpc.mempool_entries(txids),
            self.rpc.raw_transactions(txids)
        );
        let (entries, txs) = (entries.map_err(rpc_err)?, txs.map_err(rpc_err)?);
        // A per-txid error (usually -5, gone since the listing) leaves that slot empty, so one
        // odd transaction can never stall the loop; it is listed and fetched again next cycle.
        Ok(txids
            .iter()
            .zip(entries.into_iter().zip(txs))
            .map(|(txid, pair)| match pair {
                (Ok(e), Ok(tx)) if tx.compute_txid() == *txid => Some((e, tx)),
                _ => None,
            })
            .collect())
    }

    async fn tip(&self) -> Result<ChainTip, SourceError> {
        let s = self.esplora.tip_hash().await.map_err(esplora_err)?;
        s.tip
            .filter(|t| t.hash == s.value)
            .ok_or_else(|| SourceError::Failed("tip answer without a matching stamp".into()))
    }

    async fn block(&self, hash: BlockHash) -> Result<bitcoin::Block, SourceError> {
        Ok(self
            .esplora
            .block_raw(hash)
            .await
            .map_err(esplora_err)?
            .value)
    }

    fn bytes(&self) -> u64 {
        self.rpc.bytes_received() + self.esplora.bytes_received()
    }
}

/// Timing and batching. The defaults are argued in `docs/MEMPOOL.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Config {
    /// Least time between cycle starts. A cycle slower than this waits as long as it took.
    pub gap: Duration,
    /// A full listing at least this often, even when `getmempoolinfo` looks unchanged.
    pub heartbeat: Duration,
    /// Longest wait after failures; the wait doubles from `gap` up to this.
    pub max_backoff: Duration,
    /// Txids per detail batch, at most [`rpc::MAX_BATCH`].
    pub batch: usize,
    /// Detail batches in flight at once.
    pub in_flight: usize,
    /// Recent active-chain blocks kept for classifying removals.
    pub blocks: usize,
    /// Deltas a subscriber may fall behind before it must resubscribe.
    pub subscriber_queue: usize,
    /// Most heap bytes the held transactions' kept outputs may take ([`TxInfo::kept_outputs`]).
    /// A transaction that arrives past it is held without its outputs, so a replacement of it
    /// cannot say what changed in them (`docs/MEMPOOL.md`, "The record").
    pub kept_outputs: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            gap: Duration::from_secs(1),
            heartbeat: Duration::from_secs(10),
            max_backoff: Duration::from_secs(30),
            batch: 500,
            in_flight: 2,
            blocks: 6,
            subscriber_queue: 64,
            kept_outputs: KEPT_OUTPUTS,
        }
    }
}

/// The removed-record handles the tracker keeps room for without giving any back (24 bytes each).
pub(super) const LEFT_SLACK: usize = 1024;

/// Stops counting the removed records nothing holds any more, and gives back the list's own
/// memory once it is mostly empty: a block or a restarted node can remove a whole mempool at
/// once, and a handle kept past its record's last holder would pin that record's memory.
pub(super) fn forget_released(left: &mut Vec<(Weak<[u64]>, u64)>) {
    left.retain(|(w, _)| w.strong_count() > 0);
    if left.capacity() > LEFT_SLACK && left.capacity() / 4 > left.len() {
        left.shrink_to(left.len().max(LEFT_SLACK));
    }
}

/// The default [`Config::kept_outputs`]: 32 MiB, about twice what a 300,000-transaction mempool of
/// mainnet's usual outputs takes (`docs/MEMPOOL.md`, "The record").
pub const KEPT_OUTPUTS: u64 = 32 << 20;

/// What one cycle did and cost.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CycleStats {
    /// The delta it published, if anything changed.
    pub seq: Option<u64>,
    pub duration: Duration,
    /// Response bytes read from the node.
    pub bytes: u64,
    /// Node calls, the probe included.
    pub calls: u32,
    /// Probes since the previous cycle that found nothing changed.
    pub skipped: u32,
    pub listed: usize,
    pub added: usize,
    /// Listed, then gone before its details were read.
    pub vanished: usize,
    pub confirmed: usize,
    pub replaced: usize,
    pub evicted: usize,
    /// Blocks fetched to classify removals.
    pub blocks: u32,
    /// Transactions tracked after the cycle.
    pub size: usize,
    pub mempool_sequence: u64,
    pub tip: Option<ChainTip>,
    /// For a [`Event::Block`]: from [`Tracker::block_found`] to the delta's publication.
    pub since_found: Option<Duration>,
    /// Added without their outputs kept, past [`Config::kept_outputs`].
    pub unkept: usize,
    /// Heap bytes the held transactions' kept outputs take after the cycle.
    pub kept_bytes: u64,
}

/// Something worth recording. Read with [`Tracker::events`]; the tracker itself logs nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A cycle completed.
    Cycle(CycleStats),
    /// A block from [`Tracker::block_found`] was applied from its own transaction list, before
    /// the next listing. `listed`, `added` and `vanished` are zero.
    Block(CycleStats),
    /// The first complete cycle: the initial sync. `duration` runs from start, failures included.
    Synced {
        duration: Duration,
        txs: usize,
        bytes: u64,
        calls: u32,
    },
    /// A cycle failed and nothing was applied. Details already fetched are kept for the retry.
    PollFailed {
        error: SourceError,
        consecutive: u32,
        retry_in: Duration,
    },
    /// The node's `mempool_sequence` went backwards: it restarted. The diff is unaffected.
    SequenceRegressed { from: u64, to: u64 },
    /// A subscriber fell more than [`Config::subscriber_queue`] deltas behind and must resubscribe.
    SubscriberLagged { missed: u64 },
}

struct Shared {
    state: RwLock<Mempool>,
    deltas: broadcast::Sender<Arc<Delta>>,
    events: broadcast::Sender<Event>,
    wake: Notify,
    /// The newest block announced through [`Tracker::block_found`] and not yet applied, and when.
    found: std::sync::Mutex<Option<(ChainTip, Instant)>>,
    /// The node's last `getmempoolinfo` answer.
    info: std::sync::Mutex<Option<MempoolInfo>>,
}

/// A handle on a running tracker. Cheap to clone.
#[derive(Clone)]
pub struct Tracker {
    shared: Arc<Shared>,
}

/// Deltas after a snapshot, in order, without gaps.
pub struct Subscription {
    rx: broadcast::Receiver<Arc<Delta>>,
    events: broadcast::Sender<Event>,
}

impl Subscription {
    /// The next delta. `Err(Lagged)` means deltas were dropped: take a new snapshot with
    /// [`Tracker::subscribe`]. `Err(Closed)` means the tracker is gone.
    pub async fn recv(&mut self) -> Result<Arc<Delta>, broadcast::error::RecvError> {
        let r = self.rx.recv().await;
        if let Err(broadcast::error::RecvError::Lagged(missed)) = r {
            let _ = self.events.send(Event::SubscriberLagged { missed });
        }
        r
    }
}

impl Tracker {
    /// Starts the polling loop on the current runtime. Abort the handle to stop it.
    pub fn start<S: Source>(source: S, config: Config) -> (Self, JoinHandle<()>) {
        let shared = Arc::new(Shared {
            state: RwLock::new(Mempool::default()),
            deltas: broadcast::channel(config.subscriber_queue.max(1)).0,
            events: broadcast::channel(256).0,
            wake: Notify::new(),
            found: std::sync::Mutex::new(None),
            info: std::sync::Mutex::new(None),
        });
        let poller = Poller {
            source: Arc::new(source),
            shared: shared.clone(),
            config,
            pending: HashMap::new(),
            left: Vec::new(),
            blocks: Vec::new(),
            probe: None,
            wanted: None,
            last_sequence: None,
            synced: false,
            started: Instant::now(),
            totals: (0, 0),
        };
        (Self { shared }, tokio::spawn(poller.run()))
    }

    /// Runs `f` on the current state and subscribes in the same instant: the first delta
    /// received is the one right after what `f` saw (its `seq` is `state.seq() + 1`).
    pub fn subscribe<R>(&self, f: impl FnOnce(&Mempool) -> R) -> (R, Subscription) {
        let state = self
            .shared
            .state
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        let r = f(&state);
        let rx = self.shared.deltas.subscribe();
        drop(state);
        let events = self.shared.events.clone();
        (r, Subscription { rx, events })
    }

    /// Runs `f` on the current state.
    pub fn read<R>(&self, f: impl FnOnce(&Mempool) -> R) -> R {
        f(&self
            .shared
            .state
            .read()
            .unwrap_or_else(PoisonError::into_inner))
    }

    /// Statistics and abnormal conditions, for logging. Lossy if not read.
    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.shared.events.subscribe()
    }

    /// The node's last `getmempoolinfo` answer (its minimum accepted fee rate, memory use, …),
    /// read on every probe, so at most one cycle old. `None` before the first.
    pub fn node_info(&self) -> Option<MempoolInfo> {
        self.shared
            .info
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// A hint that the chain tip moved (from Electrum, say): poll now instead of at the next
    /// gap. Without hints the tracker still sees the new tip on its next cycle.
    pub fn tip_changed(&self) {
        self.shared.wake.notify_one();
    }

    /// A new best block, as the node announced it (Electrum's header subscription): what it
    /// confirms or conflicts with leaves at once, from the block's own transaction list, without
    /// waiting for the next listing. A cycle in progress finishes first. See `docs/MEMPOOL.md`.
    pub fn block_found(&self, tip: ChainTip) {
        let mut found = self
            .shared
            .found
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if found.is_none_or(|(f, _)| tip.height >= f.height) {
            *found = Some((tip, Instant::now()));
        }
        drop(found);
        self.shared.wake.notify_one();
    }
}

/// How often the tip is read again while the node's Esplora has not caught up with a block it
/// announced, and for how long (`docs/RBITCOIN.md`): as the WebSocket hub waits for a block.
const FOUND_RETRY: Duration = Duration::from_millis(25);
const FOUND_WAIT: Duration = Duration::from_secs(3);

struct Poller<S> {
    source: Arc<S>,
    shared: Arc<Shared>,
    config: Config,
    /// Details fetched for listed txids but not yet published, kept across a failed cycle.
    pending: HashMap<Txid, TxInfo>,
    /// The allocations of records with kept outputs that left the map, and their kept bytes:
    /// counted against the budget for as long as anything still holds one (a delta in the
    /// subscribers' channel, a batch a subscriber is working through), checked at each fetch.
    left: Vec<(Weak<[u64]>, u64)>,
    /// Recent active-chain blocks, tip first.
    blocks: Vec<Arc<BlockSpends>>,
    /// `getmempoolinfo` and `/mempool/recent` before the last complete cycle.
    probe: Option<Probe>,
    /// The last block announced through [`Tracker::block_found`]. Until the model's tip is it or
    /// above it, no probe may skip a listing: a block is a change even when the mempool's totals
    /// do not move, and the node can announce one before it serves it.
    wanted: Option<ChainTip>,
    last_sequence: Option<u64>,
    synced: bool,
    started: Instant,
    /// Bytes and calls until the first complete cycle.
    totals: (u64, u32),
}

/// Whether `tip` is the announced block `found` or above it. At the same height another hash is
/// not enough: after a reorg to an equal height, the node may still serve the block replaced.
fn reached(tip: ChainTip, found: ChainTip) -> bool {
    tip.height > found.height || tip.hash == found.hash
}

/// What a probe reads: `getmempoolinfo`, and the newest arrivals when the node answered them.
struct Probe {
    info: MempoolInfo,
    recent: Option<Vec<Txid>>,
}

/// Whether nothing the tracker must see can have changed between two probes. The totals move
/// with any removal on its own; the newest arrivals move with any arrival, so a new transaction
/// of the same size and fee as one that left (a block's, an evicted one's) is not missed.
fn same_pool(a: &Probe, b: &Probe) -> bool {
    let (x, y) = (&a.info, &b.info);
    (x.size, x.bytes, x.total_fee) == (y.size, y.bytes, y.total_fee)
        && a.recent.is_some()
        && a.recent == b.recent
}

impl<S: Source> Poller<S> {
    async fn run(mut self) {
        let mut next = Instant::now();
        let mut last_full: Option<Instant> = None;
        let (mut failures, mut skipped) = (0u32, 0u32);
        loop {
            let forced = tokio::select! {
                () = tokio::time::sleep_until(next) => false,
                () = self.shared.wake.notified() => true,
            };
            let found = self
                .shared
                .found
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            // A block that extends the chain we hold needs no listing now; anything else (not
            // served in time, a reorg, a failure) falls through to a full cycle at once.
            if let Some((tip, at)) = found
                && self.synced
                && self.apply_found(tip, at).await
            {
                self.wanted = None;
                continue;
            }
            if let Some((tip, _)) = found {
                self.wanted = Some(tip);
            }
            if let (Some(t), Some(w)) = (self.read(Mempool::tip), self.wanted)
                && reached(t, w)
            {
                self.wanted = None;
            }
            let forced = forced || self.wanted.is_some();
            let started = Instant::now();
            let bytes = self.source.bytes();
            // The newest arrivals first: one between the two reads is then in the totals but not
            // in the list, so every later list differs. The other way round, it would be in the
            // list but not the totals, and a later removal of its twin would match both. Asked
            // only of a node that answered the last cycle: after a failure the next cycle lists
            // anyway, and a node that is down is not asked twice per retry.
            let ask_recent = failures == 0 && last_full.is_some();
            let recent = match ask_recent {
                true => self.source.recent().await.ok(),
                false => None,
            };
            let info = self.source.mempool_info().await;
            if let Ok(i) = &info {
                *self
                    .shared
                    .info
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner) = Some(i.clone());
            }
            let result = match info.map(|info| Probe { info, recent }) {
                Ok(probe)
                    if !forced
                        && last_full.is_some_and(|t| t.elapsed() < self.config.heartbeat)
                        && self.probe.as_ref().is_some_and(|p| same_pool(p, &probe)) =>
                {
                    skipped += 1;
                    next = self.pace(started);
                    continue;
                }
                Ok(probe) => self.cycle(probe).await,
                Err(e) => Err(e),
            };
            let bytes = self.source.bytes().saturating_sub(bytes);
            match result {
                Ok(mut stats) => {
                    failures = 0;
                    last_full = Some(started);
                    stats.duration = started.elapsed();
                    stats.bytes = bytes;
                    stats.calls += 1 + u32::from(ask_recent); // the probe's
                    stats.skipped = std::mem::take(&mut skipped);
                    next = self.pace(started);
                    self.totals.0 += bytes;
                    self.totals.1 += stats.calls;
                    if !self.synced {
                        self.synced = true;
                        self.emit(Event::Synced {
                            duration: self.started.elapsed(),
                            txs: stats.size,
                            bytes: self.totals.0,
                            calls: self.totals.1,
                        });
                    }
                    self.emit(Event::Cycle(stats));
                }
                Err(error) => {
                    failures = failures.saturating_add(1);
                    self.totals.0 += bytes;
                    let doubled = self.config.gap.saturating_mul(1u32 << failures.min(16));
                    let retry_in = doubled.min(self.config.max_backoff);
                    next = Instant::now() + retry_in;
                    self.emit(Event::PollFailed {
                        error,
                        consecutive: failures,
                        retry_in,
                    });
                }
            }
        }
    }

    /// When the next iteration may start: `gap` after this one started, and never sooner
    /// than this one took after it ended, so a slow node is talked to at most half the time.
    fn pace(&self, started: Instant) -> Instant {
        (started + self.config.gap).max(Instant::now() + started.elapsed())
    }

    fn emit(&self, e: Event) {
        let _ = self.shared.events.send(e);
    }

    /// Applies the announced block `found` (at `at`) from its transaction list. Returns true when
    /// that is all the moment needs: the new tip extends the chain the model was on.
    async fn apply_found(&mut self, found: ChainTip, at: Instant) -> bool {
        let started = Instant::now();
        let bytes = self.source.bytes();
        let mut stats = CycleStats::default();
        let Ok((tip, at)) = self.served_tip(found, at, &mut stats).await else {
            return false;
        };
        let old = self.read(Mempool::tip);
        let Ok(fetched) = self.recent_blocks(tip).await else {
            return false;
        };
        stats.blocks = fetched;
        stats.calls += fetched;
        let removed = self.read(|m| m.classify(&m.ruled_out(&self.blocks), &[], &self.blocks));
        for (_, r) in &removed {
            match r {
                Removal::Confirmed { .. } => stats.confirmed += 1,
                Removal::Replaced { .. } => stats.replaced += 1,
                Removal::Evicted => stats.evicted += 1,
            }
        }
        // A handle of its own, so the lock does not borrow `self`, which charges what leaves.
        let shared = Arc::clone(&self.shared);
        let mut state = shared.state.write().unwrap_or_else(PoisonError::into_inner);
        if !removed.is_empty() || state.tip() != Some(tip) {
            let replaced = removed
                .iter()
                .filter(|(_, r)| matches!(r, Removal::Replaced { .. }))
                .filter_map(|(t, _)| Some((*t, state.get(t)?.clone())))
                .collect();
            let delta = Delta {
                seq: state.seq() + 1,
                mempool_sequence: state.mempool_sequence(),
                tip,
                added: Vec::new(),
                removed,
                replaced,
                blocks: self.blocks.clone(),
            };
            self.left(&state, &delta);
            state.apply(&delta);
            stats.seq = Some(delta.seq);
            // Sent under the write lock, so a subscriber's snapshot and its first delta meet.
            let _ = self.shared.deltas.send(Arc::new(delta));
        }
        stats.size = state.len();
        stats.kept_bytes = state.kept_bytes();
        stats.mempool_sequence = state.mempool_sequence();
        drop(state);
        stats.tip = Some(tip);
        stats.since_found = Some(at.elapsed());
        stats.duration = started.elapsed();
        stats.bytes = self.source.bytes().saturating_sub(bytes);
        self.totals.0 += stats.bytes;
        self.totals.1 += stats.calls;
        self.emit(Event::Block(stats));
        // A reorg, or more blocks than the window: transactions may have come back.
        old.is_none_or(|o| self.blocks.iter().any(|b| b.hash == o.hash))
    }

    /// The node's tip once its Esplora serves `found` (announced at `at`) or a later block, read
    /// every [`FOUND_RETRY`] for at most [`FOUND_WAIT`], with when the block waited for was
    /// announced.
    async fn served_tip(
        &self,
        mut found: ChainTip,
        mut at: Instant,
        stats: &mut CycleStats,
    ) -> Result<(ChainTip, Instant), SourceError> {
        let deadline = Instant::now() + FOUND_WAIT;
        loop {
            let asked = Instant::now();
            let tip = self.source.tip().await?;
            stats.calls += 1;
            if reached(tip, found) {
                return Ok((tip, at));
            }
            if asked >= deadline {
                return Err(SourceError::Failed("announced block not served".into()));
            }
            tokio::time::sleep_until(asked + FOUND_RETRY).await;
            // A newer announcement (another block, or a reorg away from this one) is waited for
            // instead: this one may never be served. It stays queued, so the loop still takes it.
            if let Some(newer) = *self
                .shared
                .found
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
            {
                (found, at) = newer;
            }
        }
    }

    /// One listing, diffed and published. On error nothing is published.
    async fn cycle(&mut self, probe: Probe) -> Result<CycleStats, SourceError> {
        let mut stats = CycleStats::default();
        let listing = self.source.listing().await?;
        let tip = self.source.tip().await?;
        stats.calls += 2;
        if let Some(from) = self.last_sequence.filter(|s| *s > listing.mempool_sequence) {
            self.emit(Event::SequenceRegressed {
                from,
                to: listing.mempool_sequence,
            });
        }
        stats.blocks = self.recent_blocks(tip).await?;
        stats.calls += stats.blocks;

        let (mut diff, keys) = self.read(|m| (m.diff(&listing.txids), m.keys().clone()));
        // A block can land between the listing and the tip read: what the new blocks rule out
        // leaves now, though the listing still had it, so no delta on a new tip says otherwise.
        let moved = self.read(Mempool::tip) != Some(tip);
        if moved {
            diff.removed
                .extend(self.read(|m| m.ruled_out(&self.blocks)));
            diff.removed.sort_unstable();
            diff.removed.dedup();
        }
        self.pending
            .retain(|t, _| diff.added.binary_search(t).is_ok());
        let need: Vec<Txid> = diff
            .added
            .iter()
            .filter(|t| !self.pending.contains_key(*t))
            .copied()
            .collect();
        let (calls, vanished) = self.fetch(&keys, need).await?;
        stats.calls += calls;
        stats.vanished = vanished;

        let mut added: Vec<(Txid, TxInfo)> = diff
            .added
            .iter()
            .filter_map(|t| Some((*t, self.pending.remove(t)?)))
            .collect();
        if moved {
            self.read(|m| m.rule_out_added(&mut added, &diff.removed, &self.blocks));
        }
        let removed = self.read(|m| m.classify(&diff.removed, &added, &self.blocks));
        for (_, r) in &removed {
            match r {
                Removal::Confirmed { .. } => stats.confirmed += 1,
                Removal::Replaced { by } => {
                    stats.replaced += 1;
                    // `added` is in txid order; a replacement mined in a block is not in it.
                    if let Ok(i) = added.binary_search_by_key(by, |(t, _)| *t)
                        && let Some((_, info)) = added.get_mut(i)
                    {
                        info.flags |= crate::flags::REPLACEMENT;
                    }
                }
                Removal::Evicted => stats.evicted += 1,
            }
        }
        stats.listed = listing.txids.len();
        stats.added = added.len();
        stats.unkept = added.iter().filter(|(_, i)| i.outputs_unkept()).count();
        stats.mempool_sequence = listing.mempool_sequence;
        stats.tip = Some(tip);

        // A handle of its own, so the lock does not borrow `self`, which charges what leaves.
        let shared = Arc::clone(&self.shared);
        let mut state = shared.state.write().unwrap_or_else(PoisonError::into_inner);
        if !added.is_empty() || !removed.is_empty() || state.tip() != Some(tip) {
            let replaced = removed
                .iter()
                .filter(|(_, r)| matches!(r, Removal::Replaced { .. }))
                .filter_map(|(t, _)| Some((*t, state.get(t)?.clone())))
                .collect();
            let delta = Delta {
                seq: state.seq() + 1,
                mempool_sequence: listing.mempool_sequence,
                tip,
                added,
                removed,
                replaced,
                blocks: self.blocks.clone(),
            };
            self.left(&state, &delta);
            state.apply(&delta);
            stats.seq = Some(delta.seq);
            // Sent under the write lock, so a subscriber's snapshot and its first delta meet.
            let _ = self.shared.deltas.send(Arc::new(delta));
        }
        stats.size = state.len();
        stats.kept_bytes = state.kept_bytes();
        drop(state);
        self.last_sequence = Some(listing.mempool_sequence);
        // Listed transactions still missing details must be retried: no probe skip until then.
        self.probe = (stats.vanished == 0).then_some(probe);
        Ok(stats)
    }

    fn read<R>(&self, f: impl FnOnce(&Mempool) -> R) -> R {
        f(&self
            .shared
            .state
            .read()
            .unwrap_or_else(PoisonError::into_inner))
    }

    /// Makes `self.blocks` the last [`Config::blocks`] blocks ending at `tip`, fetching the
    /// ones not already held. A reorg simply walks a different chain. Returns blocks fetched.
    async fn recent_blocks(&mut self, tip: ChainTip) -> Result<u32, SourceError> {
        let keys = self.read(|m| m.keys().clone());
        let mut held = std::mem::take(&mut self.blocks);
        let mut chain = Vec::with_capacity(self.config.blocks);
        let (mut hash, mut height, mut fetched) = (tip.hash, tip.height, 0);
        while chain.len() < self.config.blocks {
            let block = match held.iter().position(|b| b.hash == hash) {
                Some(i) => held.swap_remove(i),
                None => {
                    fetched += 1;
                    let b = match self.source.block(hash).await {
                        Ok(raw) => Arc::new(keys.block(height, &raw)),
                        Err(e) => {
                            held.extend(chain);
                            self.blocks = held;
                            return Err(e);
                        }
                    };
                    if b.hash != hash {
                        held.extend(chain);
                        self.blocks = held;
                        return Err(SourceError::Failed("block answer has another hash".into()));
                    }
                    b
                }
            };
            hash = block.prev;
            chain.push(block);
            let Some(h) = height.checked_sub(1) else {
                break;
            };
            height = h;
        }
        self.blocks = chain;
        Ok(fetched)
    }

    /// Fetches details into `self.pending`, [`Config::in_flight`] batches at a time. Returns
    /// calls made and txids that vanished. Stops at the first failure, keeping what arrived.
    async fn fetch(
        &mut self,
        keys: &super::model::Keys,
        need: Vec<Txid>,
    ) -> Result<(u32, usize), SourceError> {
        let batch = self.config.batch.clamp(1, rpc::MAX_BATCH);
        // The budget bounds every record alive: the map, what waits here, and what left the map
        // but something still holds. Outputs past it are never stored.
        let staged: u64 = self.pending.values().map(TxInfo::kept_bytes).sum();
        forget_released(&mut self.left);
        let held: u64 = self.left.iter().map(|(_, b)| b).sum();
        let mut room = self
            .config
            .kept_outputs
            .saturating_sub(self.read(Mempool::kept_bytes))
            .saturating_sub(held)
            .saturating_sub(staged);
        let mut queue: VecDeque<Vec<Txid>> = need.chunks(batch).map(<[Txid]>::to_vec).collect();
        let mut set = JoinSet::new();
        let (mut calls, mut vanished, mut failed) = (0, 0, None);
        loop {
            while failed.is_none() && set.len() < self.config.in_flight.max(1) {
                let Some(chunk) = queue.pop_front() else {
                    break;
                };
                let source = self.source.clone();
                calls += S::DETAIL_CALLS;
                set.spawn(async move {
                    let r = source.details(&chunk).await;
                    (chunk, r)
                });
            }
            let Some(joined) = set.join_next().await else {
                break;
            };
            match joined {
                Ok((chunk, Ok(rows))) => {
                    for (txid, row) in chunk.iter().zip(rows) {
                        match row {
                            Some((entry, tx)) => {
                                let info = keys.record_within(&entry, &tx, &mut room);
                                self.pending.insert(*txid, info);
                            }
                            None => vanished += 1,
                        }
                    }
                }
                // Over the size cap: halve the batch and try again. A single transaction that
                // still does not fit is skipped like a vanished one, so it cannot stall the loop.
                Ok((chunk, Err(SourceError::TooBig))) if chunk.len() > 1 => {
                    let (a, b) = chunk.split_at(chunk.len() / 2);
                    queue.push_front(b.to_vec());
                    queue.push_front(a.to_vec());
                }
                Ok((_, Err(SourceError::TooBig))) => vanished += 1,
                Ok((_, Err(e))) => failed = failed.or(Some(e)),
                Err(e) => failed = failed.or(Some(SourceError::Failed(e.to_string()))),
            }
        }
        failed.map_or(Ok((calls, vanished)), Err)
    }

    /// Keeps counting what `delta` removes from the map for as long as anything holds it.
    fn left(&mut self, state: &Mempool, delta: &Delta) {
        // Each delta, not only each fetch: a block's delta comes with no fetch.
        forget_released(&mut self.left);
        for (t, _) in &delta.removed {
            if let Some(info) = state.get(t)
                && info.kept_bytes() > 0
            {
                self.left.push((info.allocation(), info.kept_bytes()));
            }
        }
    }
}
