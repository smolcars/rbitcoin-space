//! The shell: follows the tracker, asks the node for the clusters that changed, packs blocks
//! off the async runtime and publishes. All packing decisions live in [`super::model`].

use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use bitcoin::{BlockHash, Txid};
use node::esplora::ChainTip;
use node::rpc::model::Cluster;
use node::rpc::{self, Rpc};
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::model::{Delta, Group, Model, Packing, Position, ProjectedBlock, Projection};
use crate::mempool::{self, SourceError, Tracker};

/// Where cluster chunks come from. [`Rpc`] is the real one; tests mock it.
pub trait ClusterSource: Send + Sync + 'static {
    /// The cluster of each txid, in order; `None` where it is no longer in the mempool.
    fn clusters(
        &self,
        txids: &[Txid],
    ) -> impl Future<Output = Result<Vec<Option<Cluster>>, SourceError>> + Send;
    /// Response bytes read so far, for cost accounting.
    fn bytes(&self) -> u64;
}

impl ClusterSource for Rpc {
    async fn clusters(&self, txids: &[Txid]) -> Result<Vec<Option<Cluster>>, SourceError> {
        let err = |e: rpc::Error| match e {
            rpc::Error::Busy => SourceError::Busy,
            rpc::Error::ResponseTooBig => SourceError::TooBig,
            e => SourceError::Failed(e.to_string()),
        };
        self.mempool_clusters(txids)
            .await
            .map_err(err)?
            .into_iter()
            .map(|r| match r {
                Ok(c) => Ok(Some(c)),
                Err(rpc::Error::Rpc { code: -5, .. }) => Ok(None),
                Err(e) => Err(err(e)),
            })
            .collect()
    }

    fn bytes(&self) -> u64 {
        self.bytes_received()
    }
}

/// Settings. The defaults follow rbitcoin's template and are argued in `docs/MEMPOOL.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Config {
    /// Projected blocks, the last one standing for everything beyond. 2 to 255.
    pub blocks: usize,
    /// Raw weight a block gives to mempool transactions: rbitcoin keeps 8,000 of 4,000,000
    /// for the coinbase.
    pub block_weight: u64,
    /// Chunks under this rate, in sat per 1,000 vB, are left for the last block: rbitcoin's
    /// default `-blockmintxfee`.
    pub min_rate: u64,
    /// Clusters asked for in one node request, at most [`rpc::MAX_BATCH`].
    pub batch: usize,
    /// Deltas a subscriber may fall behind before it must resubscribe.
    pub subscriber_queue: usize,
    /// Expected blocks kept for the blocks that follow them ([`Projector::expected`]).
    pub archive: usize,
    /// Longest wait between retries after the node failed a cluster request.
    pub max_backoff: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            blocks: 8,
            block_weight: 3_992_000,
            min_rate: 1,
            batch: 500,
            subscriber_queue: 64,
            archive: 6,
            max_backoff: Duration::from_secs(30),
        }
    }
}

/// The first projected block as it stood on `tip`, kept after the next block arrives so the
/// block mined on `tip` can be audited against it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expected {
    pub tip: ChainTip,
    /// The projection it came from.
    pub seq: u64,
    pub block: Arc<ProjectedBlock>,
    /// That projection was stale: the node had stopped answering.
    pub stale: bool,
    /// The tip of the projection that replaced it.
    pub next: ChainTip,
    /// Sorted, with the rate it was placed at: every transaction in that projection that the one
    /// on `next` no longer holds, in any block. Those in the block mined on `tip` are the ones we
    /// had seen.
    pub left: Arc<[(Txid, u32)]>,
    /// When the projector learnt of `next`, Unix seconds: before it asked the node anything
    /// for the projection on `next`.
    pub at: u32,
}

/// What one update did and cost.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateStats {
    /// The projection it published, if anything changed.
    pub seq: Option<u64>,
    pub mempool_seq: u64,
    /// Tracker deltas folded into this update.
    pub deltas: usize,
    /// Transactions whose cluster was asked, node requests, and response bytes.
    pub asked: usize,
    pub calls: u32,
    pub bytes: u64,
    /// Waiting for the node, then packing (off the async runtime).
    pub fetch: Duration,
    pub pack: Duration,
    pub txs: usize,
    pub chunks: usize,
    /// Records set and removed in the published delta.
    pub set: usize,
    pub removed: usize,
    pub stale: bool,
    /// The once-a-block refresh of every cluster: `set` and `removed` are then how far the
    /// projection published for the block was from the node's full answer.
    pub refresh: bool,
}

/// Something worth recording. Read with [`Projector::events`]; the projector logs nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Update(UpdateStats),
    /// A cluster request failed. The affected transactions keep their last chunks, the
    /// projection is marked stale, and they are asked again after `retry_in`.
    FetchFailed {
        error: SourceError,
        consecutive: u32,
        pending: usize,
        retry_in: Duration,
    },
    /// The projector fell behind the tracker and rebuilt from a fresh snapshot.
    Resynced {
        txs: usize,
    },
    /// A subscriber fell more than [`Config::subscriber_queue`] deltas behind.
    SubscriberLagged {
        missed: u64,
    },
}

struct State {
    model: Model,
    current: Arc<Projection>,
    archive: VecDeque<Arc<Expected>>,
    deltas: broadcast::Sender<Arc<Delta>>,
}

struct Shared {
    state: RwLock<State>,
    events: broadcast::Sender<Event>,
}

/// A handle on a running projector. Cheap to clone.
#[derive(Clone)]
pub struct Projector {
    shared: Arc<Shared>,
}

/// Deltas after a snapshot, in order, without gaps.
pub struct Subscription {
    rx: broadcast::Receiver<Arc<Delta>>,
    events: broadcast::Sender<Event>,
}

impl Subscription {
    /// The next delta. `Err(Lagged)`: deltas were dropped, call [`Projector::subscribe`] again.
    /// `Err(Closed)`: the projector is gone.
    pub async fn recv(&mut self) -> Result<Arc<Delta>, RecvError> {
        let r = self.rx.recv().await;
        if let Err(RecvError::Lagged(missed)) = r {
            let _ = self.events.send(Event::SubscriberLagged { missed });
        }
        r
    }
}

fn lock<T>(l: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    l.write().unwrap_or_else(PoisonError::into_inner)
}

impl Projector {
    /// Follows `tracker` on the current runtime. Abort the handle to stop it.
    pub fn start<S: ClusterSource>(
        tracker: Tracker,
        source: S,
        config: Config,
    ) -> (Self, JoinHandle<()>) {
        let shared = Arc::new(Shared {
            state: RwLock::new(State {
                model: Model::default(),
                current: Arc::default(),
                archive: VecDeque::new(),
                deltas: broadcast::channel(config.subscriber_queue.max(1)).0,
            }),
            events: broadcast::channel(256).0,
        });
        let runner = Runner {
            tracker,
            source: Arc::new(source),
            shared: shared.clone(),
            config,
            pending: HashSet::new(),
            failures: 0,
            retry_at: None,
            refresh: Vec::new(),
            tracker_failing: false,
        };
        (Self { shared }, tokio::spawn(runner.run()))
    }

    /// The current projection, and the deltas that follow it: the first has `seq` one above.
    pub fn subscribe(&self) -> (Arc<Projection>, Subscription) {
        let state = self.read();
        let rx = state.deltas.subscribe();
        let current = state.current.clone();
        drop(state);
        let events = self.shared.events.clone();
        (current, Subscription { rx, events })
    }

    pub fn current(&self) -> Arc<Projection> {
        self.read().current.clone()
    }

    /// Which projected block a transaction is in and what is ahead of it.
    pub fn position(&self, txid: &Txid) -> Option<Position> {
        self.read().model.position(txid)
    }

    /// The cluster holding a transaction, as the node last told it, chunk by chunk.
    pub fn group(&self, txid: &Txid) -> Option<Group> {
        self.read().model.group(txid)
    }

    /// The first projected block as it stood just before a block on top of `parent` arrived.
    pub fn expected(&self, parent: &BlockHash) -> Option<Arc<Expected>> {
        let state = self.read();
        state
            .archive
            .iter()
            .rev()
            .find(|e| e.tip.hash == *parent)
            .cloned()
    }

    /// Statistics and abnormal conditions, for logging. Lossy if not read.
    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.shared.events.subscribe()
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, State> {
        self.shared
            .state
            .read()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// Tracker deltas to fold in, or a fresh tracker snapshot after falling behind.
enum Input {
    Deltas(Vec<Arc<mempool::Delta>>),
    Snapshot {
        seq: u64,
        tip: Option<ChainTip>,
        txs: Vec<(Txid, u64, u32, u32, u64)>,
    },
    /// Nothing new from the tracker: a retry, or the stale flag changed.
    Nothing,
}

struct Runner<S> {
    tracker: Tracker,
    source: Arc<S>,
    shared: Arc<Shared>,
    config: Config,
    /// Transactions whose cluster must be asked at the next update.
    pending: HashSet<Txid>,
    failures: u32,
    /// When to ask again after a failure. Absolute, so unrelated wakeups do not push it back.
    retry_at: Option<Instant>,
    tracker_failing: bool,
    /// A block arrived: every transaction, to ask its cluster again once the block's own update
    /// is published and the tracker has nothing more to fold in.
    refresh: Vec<Txid>,
}

impl<S: ClusterSource> Runner<S> {
    async fn run(mut self) {
        let mut events = self.tracker.events();
        let mut first = true;
        loop {
            let ((mut seq, tip, txs), mut sub) = self.tracker.subscribe(|m| {
                let txs: Vec<_> = m
                    .iter()
                    .map(|(t, i)| (*t, i.fee.to_sat(), i.vsize, i.weight, i.flags))
                    .collect();
                (m.seq(), m.tip(), txs)
            });
            if !std::mem::take(&mut first) {
                let _ = self.shared.events.send(Event::Resynced { txs: txs.len() });
            }
            self.update(Input::Snapshot { seq, tip, txs }, false).await;
            loop {
                let retry = self.retry_at.filter(|_| !self.pending.is_empty());
                let mut lagged = false;
                let input = tokio::select! {
                    d = sub.recv() => match d {
                        Ok(d) => {
                            seq = d.seq;
                            let mut batch = vec![d];
                            // Fold in what the tracker has published since, so a slow update
                            // never leaves a queue behind it.
                            while !lagged && self.tracker.read(|m| m.seq()) > seq {
                                match sub.recv().await {
                                    Ok(d) => {
                                        seq = d.seq;
                                        batch.push(d);
                                    }
                                    Err(RecvError::Lagged(_)) => lagged = true,
                                    Err(RecvError::Closed) => return,
                                }
                            }
                            Input::Deltas(batch)
                        }
                        Err(RecvError::Lagged(_)) => break,
                        Err(RecvError::Closed) => return,
                    },
                    e = events.recv() => {
                        let failing = match e {
                            Ok(mempool::Event::PollFailed { .. }) => true,
                            Ok(mempool::Event::Cycle(_)) => false,
                            Ok(_) | Err(RecvError::Lagged(_)) => continue,
                            Err(RecvError::Closed) => return,
                        };
                        if failing == std::mem::replace(&mut self.tracker_failing, failing) {
                            continue;
                        }
                        // A recovering cycle's delta is already queued: let it publish, so the
                        // stale projection is never republished as current on the old tip.
                        if !failing && self.tracker.read(mempool::Mempool::seq) > seq {
                            continue;
                        }
                        Input::Nothing
                    }
                    () = sleep_until(retry) => Input::Nothing,
                };
                self.update(input, false).await;
                // Waits while the tracker has more: in a burst, each block's own update goes
                // out before the refresh, which then covers them all.
                if !self.refresh.is_empty() && self.tracker.read(mempool::Mempool::seq) == seq {
                    self.pending.extend(std::mem::take(&mut self.refresh));
                    self.update(Input::Nothing, true).await;
                }
                if lagged {
                    break;
                }
            }
        }
    }

    /// The wait before asking again after `failures` failed requests in a row.
    fn backoff(&self) -> Duration {
        Duration::from_secs(1)
            .saturating_mul(1 << self.failures.min(8))
            .min(self.config.max_backoff)
    }

    /// Applies the input, asks the node for every cluster that changed, packs and publishes.
    async fn update(&mut self, input: Input, refresh: bool) {
        let shared = self.shared.clone();
        let (mut need, tip, mempool_seq, deltas, all) =
            blocking(&shared, move |s| apply(s, input)).await;
        // When this update learnt its tip: an archived expectation's `at`, taken before the
        // cluster requests so no accept time recorded since can predate it.
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| u32::try_from(d.as_secs()).unwrap_or(u32::MAX));
        need.extend(self.pending.drain());
        // While backing off, everything waits for the deadline, new work included.
        let backing_off = self.retry_at.is_some_and(|t| Instant::now() < t);
        if backing_off {
            self.pending.extend(need.drain(..));
        }

        let mut stats = UpdateStats {
            deltas,
            mempool_seq,
            refresh,
            ..UpdateStats::default()
        };
        let started = Instant::now();
        let bytes = self.source.bytes();
        let (answers, failed) = self.fetch(need, &mut stats).await;
        stats.fetch = started.elapsed();
        stats.bytes = self.source.bytes().saturating_sub(bytes);
        match failed {
            Some(error) => {
                self.failures = self.failures.saturating_add(1);
                self.retry_at = Some(Instant::now() + self.backoff());
                let _ = self.shared.events.send(Event::FetchFailed {
                    error,
                    consecutive: self.failures,
                    pending: self.pending.len(),
                    retry_in: self.backoff(),
                });
            }
            None if !backing_off => {
                self.failures = 0;
                self.retry_at = None;
            }
            None => {}
        }
        stats.stale = self.failures > 0 || self.tracker_failing;

        let packing = Packing {
            blocks: self.config.blocks,
            block_weight: self.config.block_weight,
            min_rate: self.config.min_rate,
        };
        let archive = self.config.archive;
        let started = Instant::now();
        let (recheck, mut stats) = blocking(&shared, move |s| {
            let recheck = publish(s, &answers, packing, archive, (tip, at), &mut stats);
            (recheck, stats)
        })
        .await;
        stats.pack = started.elapsed();
        self.pending.extend(recheck);
        // What we cannot see change (a `prioritisetransaction`, a lost recheck) is corrected
        // once per block: every cluster is asked again right after this update.
        if !all.is_empty() {
            self.refresh = all;
        }
        let _ = self.shared.events.send(Event::Update(stats));
    }

    /// Asks the node for the cluster of every transaction in `need`, once per cluster as far
    /// as we know them: each answer covers its members, and the next round asks only for what
    /// is still uncovered. On failure the uncovered rest is kept in `pending`.
    async fn fetch(
        &mut self,
        need: Vec<Txid>,
        stats: &mut UpdateStats,
    ) -> (Vec<Cluster>, Option<SourceError>) {
        let mut need: HashSet<Txid> = need.into_iter().collect();
        let mut answers = Vec::new();
        let batch = self.config.batch.clamp(1, rpc::MAX_BATCH);
        while !need.is_empty() {
            let reps: Vec<Txid> = {
                let state = self
                    .shared
                    .state
                    .read()
                    .unwrap_or_else(PoisonError::into_inner);
                need.retain(|t| state.model.contains(t));
                let mut seen = HashSet::new();
                need.iter()
                    .filter(|t| state.model.cluster_of(t).is_none_or(|c| seen.insert(c)))
                    .take(batch)
                    .copied()
                    .collect()
            };
            if reps.is_empty() {
                break;
            }
            stats.asked += reps.len();
            stats.calls += 1;
            match self.source.clusters(&reps).await {
                Ok(rows) => {
                    for t in &reps {
                        need.remove(t);
                    }
                    for c in rows.into_iter().flatten() {
                        for t in c.chunks.iter().flat_map(|c| &c.txs) {
                            need.remove(t);
                        }
                        answers.push(c);
                    }
                }
                Err(e) => {
                    self.pending.extend(need);
                    return (answers, Some(e));
                }
            }
        }
        (answers, None)
    }
}

/// Applies tracker input to the model. Returns the transactions whose cluster must be asked,
/// the tip and tracker `seq` now reflected, how many deltas were folded in, and every txid
/// when the tip moved.
fn apply(s: &mut State, input: Input) -> (Vec<Txid>, Option<ChainTip>, u64, usize, Vec<Txid>) {
    let mut need = Vec::new();
    let (need, tip, seq, deltas) = match input {
        Input::Deltas(ds) => {
            for d in &ds {
                for (t, _) in &d.removed {
                    need.extend(s.model.remove(t));
                }
                for (t, i) in &d.added {
                    s.model.add(*t, i.fee.to_sat(), i.vsize, i.weight, i.flags);
                    need.push(*t);
                }
            }
            match ds.last() {
                Some(d) => (need, Some(d.tip), d.seq, ds.len()),
                None => (need, s.current.tip, s.current.mempool_seq, 0),
            }
        }
        Input::Snapshot { seq, tip, txs } => {
            let keep: HashSet<Txid> = txs.iter().map(|t| t.0).collect();
            let gone: Vec<Txid> = s
                .model
                .txids()
                .filter(|t| !keep.contains(*t))
                .copied()
                .collect();
            for t in &gone {
                s.model.remove(t);
            }
            for (t, fee, vsize, weight, flags) in txs {
                if !s.model.contains(&t) {
                    s.model.add(t, fee, vsize, weight, flags);
                }
            }
            // Clusters may have changed in any way while we were behind: ask for all of them.
            need.extend(keep);
            (need, tip, seq, 0)
        }
        Input::Nothing => (need, s.current.tip, s.current.mempool_seq, 0),
    };
    let moved = s
        .current
        .tip
        .is_some_and(|old| tip.is_some_and(|t| t.hash != old.hash));
    let all = if moved && deltas > 0 {
        s.model.txids().copied().collect()
    } else {
        Vec::new()
    };
    (need, tip, seq, deltas, all)
}

/// Applies the node's clusters, packs, and publishes a delta and a new projection if anything
/// changed. Returns transactions to ask about again at the next update.
fn publish(
    s: &mut State,
    answers: &[Cluster],
    packing: Packing,
    archive: usize,
    (tip, at): (Option<ChainTip>, u32),
    stats: &mut UpdateStats,
) -> Vec<Txid> {
    let mut recheck = Vec::new();
    for c in answers {
        if !s.model.apply_cluster(c) {
            // It has members the tracker has not shown us yet: ask again once it has.
            recheck.extend(
                c.chunks
                    .iter()
                    .flat_map(|c| &c.txs)
                    .find(|t| s.model.contains(t)),
            );
        }
    }
    let (blocks, set) = s.model.pack(packing);
    let mut gone: Vec<(Txid, u32)> = s
        .current
        .blocks
        .iter()
        .flat_map(|b| b.txs.iter().map(|(t, p)| (*t, p.rate)))
        .filter(|(t, _)| !s.model.contains(t))
        .collect();
    gone.sort_unstable();
    let removed: Vec<Txid> = gone.iter().map(|(t, _)| *t).collect();
    let summaries: Vec<_> = blocks.iter().map(|b| b.summary).collect();
    stats.txs = s.model.len();
    stats.chunks = s.model.chunks();
    stats.set = set.len();
    stats.removed = removed.len();
    let unchanged = set.is_empty()
        && removed.is_empty()
        && tip == s.current.tip
        && stats.stale == s.current.stale
        && summaries
            .iter()
            .eq(s.current.blocks.iter().map(|b| &b.summary));
    if unchanged {
        return recheck;
    }
    if let (Some(old), Some(first), Some(next)) = (s.current.tip, s.current.blocks.first(), tip)
        && next.hash != old.hash
    {
        s.archive.push_back(Arc::new(Expected {
            tip: old,
            seq: s.current.seq,
            block: first.clone(),
            stale: s.current.stale,
            next,
            left: gone.into(),
            at,
        }));
        while s.archive.len() > archive {
            s.archive.pop_front();
        }
    }
    let seq = s.current.seq + 1;
    let delta = Delta {
        seq,
        mempool_seq: stats.mempool_seq,
        tip,
        stale: stats.stale,
        set,
        removed,
        blocks: summaries,
    };
    s.current = Arc::new(Projection {
        seq,
        mempool_seq: stats.mempool_seq,
        tip,
        stale: stats.stale,
        blocks: blocks.into_iter().map(Arc::new).collect(),
    });
    stats.seq = Some(seq);
    // Sent under the write lock, so a subscriber's snapshot and its first delta meet.
    let _ = s.deltas.send(Arc::new(delta));
    recheck
}

/// Runs `f` on the state under the write lock, on a blocking thread.
async fn blocking<R: Send + 'static>(
    shared: &Arc<Shared>,
    f: impl FnOnce(&mut State) -> R + Send + 'static,
) -> R {
    let shared = shared.clone();
    let run = move || f(&mut lock(&shared.state));
    match tokio::task::spawn_blocking(run).await {
        Ok(r) => r,
        Err(e) => match e.try_into_panic() {
            // A panic in pure code is a bug: surface it where it happened.
            Ok(p) => std::panic::resume_unwind(p),
            // Only at runtime shutdown.
            Err(_) => std::future::pending().await,
        },
    }
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}
