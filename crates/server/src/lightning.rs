//! The Lightning gossip peer inside the server (`docs/LIGHTNING.md`, "In the server").
//!
//! One task per network owns the peer: it starts it, stores its channel history and a statistics
//! snapshot every ten minutes, turns its events into log lines, and stops it at shutdown. That
//! task is spawned after the routes are built and nothing else waits on it, so a slow, failing
//! or panicking peer never delays startup, readiness or any other task. Routes answer from the
//! store or the peer's memory, never by asking the node.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path as UrlPath, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use engine::lightning::{
    self as store_ln, Change, Channel, EVERY, Index, Interval, Point, Series, Stats,
};
use engine::store::{self, Store};
use ln::{CloseKind, Event, History, Peer, Record};
use logging::events::{
    LightningCeilingReached, LightningChannelClosed, LightningFailed, LightningGraphSaved,
    LightningHistoryFailed, LightningHistoryGap, LightningHistoryResumed, LightningLdkRecord,
    LightningLookupFailed, LightningPeerConnected, LightningPeerLost, LightningPeerUnreachable,
    LightningPeerWrongChain, LightningPruned, LightningReorg, LightningSaveFailed,
    LightningStarted, LightningStatsSkipped, LightningStatsStored, LightningStopped,
    LightningSummary, LightningSynced, LightningWatchFailed, LightningWatchReset,
};
use serde_json::{Value, json};
use tokio::sync::broadcast::error::{RecvError, TryRecvError};
use tokio::sync::{Notify, broadcast, watch};
use tokio::task::JoinHandle;

use crate::config::LightningConfig;
use crate::error::ApiError;
use crate::esplora::{ApiOutcome, Source};
use crate::{Network, NetworkContext};

const OFF: ApiError = ApiError::new(
    StatusCode::SERVICE_UNAVAILABLE,
    "lightning is off on this network",
);
const NO_STATISTICS: ApiError = ApiError::new(StatusCode::NOT_FOUND, "no lightning statistics yet");
/// Most channels a list route returns, and how many when `limit` is not given.
pub const MAX_LIST: usize = 100;
const DEFAULT_LIST: usize = 25;
/// History records stored in one write: about 10 ms of the writer.
const BATCH: usize = 2_000;
/// How long shutdown waits for the peer to write its graph (about 0.1 s on mainnet).
const STOP_WAIT: Duration = Duration::from_secs(10);
/// Silence from the peer, which sends `Stats` every ten seconds, after which it is taken as dead.
const STALLED: Duration = Duration::from_secs(120);
/// Seconds between two `lightning_summary` lines.
const SUMMARY_EVERY: Duration = Duration::from_secs(60);

/// Where the peer of one network stands, for the routes and `/readyz`.
#[derive(Debug, Clone)]
enum Phase {
    Starting,
    Running(watch::Receiver<ln::Status>),
    Failed,
    Stopped,
}

/// One network's Lightning side, held in [`NetworkContext`] when `{NET}_LIGHTNING_ENABLED`.
pub struct Lightning {
    config: LightningConfig,
    /// `<DATA_DIR>/lightning/<network>`: the node key and the graph file.
    dir: PathBuf,
    phase: Mutex<Phase>,
    /// The running peer, for routes that read its graph. Routes borrow it under the lock and
    /// never keep a clone, so at shutdown the owning task gets it back whole.
    peer: RwLock<Option<Arc<Peer>>>,
    stop: Notify,
    /// Told each time an index is set, so the overview's first computation need not wait out a retry.
    indexed: Notify,
    task: Mutex<Option<JoinHandle<()>>>,
    /// History records stored since start, and the sequence number of the last.
    records: AtomicU64,
    seq: AtomicU64,
    /// Statistics snapshots written since start: a cached answer from before the latest is stale.
    written: AtomicU64,
    answers: Mutex<HashMap<(Shape, Interval), Answer>>,
    compute: tokio::sync::Mutex<()>,
    /// What the node, channel, search and ranking routes read: `None` until the graph is synced.
    /// Requests clone the `Arc` and let go; only the index task writes it.
    index: RwLock<Option<Arc<Index>>>,
    /// The graph's totals when it first synced: the latest statistics until a snapshot is stored,
    /// which can take ten minutes.
    live: Mutex<Option<Point>>,
    /// The last index build, microseconds, and funding txids learned since start.
    index_ms: AtomicU64,
    /// Rounds of the index task in a row that failed (`index::round`).
    index_failures: AtomicU32,
    funded: AtomicU64,
    /// The newest fee record kept for each direction: what a round compares the index with, and
    /// what a node's newest fee changes are found by ([`fees`]).
    fees: RwLock<store_ln::fees::Heads>,
    /// Fee records stored since start, the last round's write (microseconds), failed rounds.
    fee_records: AtomicU64,
    fee_write_us: AtomicU64,
    fee_failures: AtomicU64,
    /// The overview's live feed ([`feed`]): events sent since start, and left out by the cap.
    feed: Mutex<feed::Feed>,
    feed_events: AtomicU64,
    feed_left_out: AtomicU64,
    feed_us: AtomicU64,
    /// The overview's movers and closes ([`movers`]), the last computation's read and work
    /// (microseconds), and computations that failed.
    overview: RwLock<Option<Arc<movers::Overview>>>,
    overview_read_us: AtomicU64,
    overview_us: AtomicU64,
    overview_failures: AtomicU64,
    /// Times the overview began waiting for an index, and times setting one woke it: what the
    /// tests observe of [`movers::keep`].
    overview_waits: AtomicU64,
    overview_wakes: AtomicU64,
}

impl std::fmt::Debug for Lightning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lightning")
            .field("dir", &self.dir)
            .field("state", &self.state())
            .finish_non_exhaustive()
    }
}

impl Lightning {
    pub fn new(config: &LightningConfig, data_dir: &Path, network: Network) -> Self {
        Self {
            config: config.clone(),
            dir: data_dir.join("lightning").join(network.name()),
            phase: Mutex::new(Phase::Starting),
            peer: RwLock::new(None),
            stop: Notify::new(),
            indexed: Notify::new(),
            task: Mutex::new(None),
            records: AtomicU64::new(0),
            seq: AtomicU64::new(0),
            written: AtomicU64::new(0),
            answers: Mutex::new(HashMap::new()),
            compute: tokio::sync::Mutex::new(()),
            index: RwLock::new(None),
            live: Mutex::new(None),
            index_ms: AtomicU64::new(0),
            index_failures: AtomicU32::new(0),
            funded: AtomicU64::new(0),
            fees: RwLock::default(),
            fee_records: AtomicU64::new(0),
            fee_write_us: AtomicU64::new(0),
            fee_failures: AtomicU64::new(0),
            feed: Mutex::default(),
            feed_events: AtomicU64::new(0),
            feed_left_out: AtomicU64::new(0),
            feed_us: AtomicU64::new(0),
            overview: RwLock::new(None),
            overview_read_us: AtomicU64::new(0),
            overview_us: AtomicU64::new(0),
            overview_failures: AtomicU64::new(0),
            overview_waits: AtomicU64::new(0),
            overview_wakes: AtomicU64::new(0),
        }
    }

    fn set(&self, phase: Phase) {
        *self.phase.lock().unwrap_or_else(PoisonError::into_inner) = phase;
    }

    fn phase(&self) -> Phase {
        self.phase
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// `off` is never returned here: a network without Lightning has no [`Lightning`].
    /// `starting`, `syncing`, `synced`, `failed` or `stopped`. `synced` once the routes can
    /// answer: the graph is synced and indexed. A synced graph whose first index is still being
    /// built is `syncing`, and one whose index cannot be built is `failed` until a build works.
    pub fn state(&self) -> &'static str {
        match self.phase() {
            Phase::Starting => "starting",
            Phase::Running(s) if s.borrow().synced => match self.index() {
                Some(_) => "synced",
                None if self.index_failing() => "failed",
                None => "syncing",
            },
            Phase::Running(_) => "syncing",
            Phase::Failed => "failed",
            Phase::Stopped => "stopped",
        }
    }

    /// Runs `f` on the live graph, if the peer runs. Gossip waits meanwhile: keep it short.
    /// Routes read [`Lightning::index`] instead.
    pub fn read_graph<R>(&self, f: impl FnOnce(&ln::ReadOnlyNetworkGraph<'_>) -> R) -> Option<R> {
        let peer = self.peer.read().unwrap_or_else(PoisonError::into_inner);
        peer.as_ref().map(|p| p.read(f))
    }

    /// The newest index of the synced graph, `None` before the first.
    pub fn index(&self) -> Option<Arc<Index>> {
        self.index
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Whether the index task's latest rounds failed ([`index::round`]).
    pub(crate) fn index_failing(&self) -> bool {
        self.index_failures.load(Ordering::Relaxed) > 0
    }

    /// Replaces the index. The server's own task calls it; tests use it to serve a graph they
    /// built, since their peer never syncs.
    #[doc(hidden)]
    pub fn set_index(&self, index: Index) {
        *self.index.write().unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(index));
        self.indexed.notify_one();
    }

    /// How many times the overview began waiting for an index, and how many times setting one woke
    /// it. For tests.
    #[doc(hidden)]
    pub fn overview_wakes(&self) -> (u64, u64) {
        (
            self.overview_waits.load(Ordering::Relaxed),
            self.overview_wakes.load(Ordering::Relaxed),
        )
    }

    /// Replaces the fee history's heads, as the index task loads them at its first round. Tests
    /// use it beside [`Lightning::set_index`].
    #[doc(hidden)]
    pub fn set_fee_heads(&self, heads: store_ln::fees::Heads) {
        *self.fees.write().unwrap_or_else(PoisonError::into_inner) = heads;
    }

    /// Stops the peer and waits, at most [`STOP_WAIT`], for it to write its graph.
    pub async fn stop(&self) {
        self.stop.notify_one();
        let task = self
            .task
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(t) = task {
            let _ = tokio::time::timeout(STOP_WAIT, t).await;
        }
    }
}

/// Starts the network's peer in the background, if Lightning is on. Returns at once.
pub fn spawn(ctx: &Arc<NetworkContext>) {
    let Some(l) = &ctx.lightning else {
        return;
    };
    let network = ctx.config.network;
    let Some(table) = &ctx.blocks else {
        logging::emit(&LightningFailed {
            network: network.name(),
            stage: "start",
            error: "the network's store did not open",
        });
        l.set(Phase::Failed);
        return;
    };
    let run = tokio::spawn(run(
        Arc::clone(l),
        ctx.esplora.clone(),
        Arc::clone(&table.store),
        Arc::clone(&ctx.hub),
        network,
    ));
    // A panic ends only this task; say so and show it as failed.
    let guard = {
        let l = Arc::clone(l);
        tokio::spawn(async move {
            if let Err(e) = run.await
                && e.is_panic()
            {
                logging::emit(&LightningFailed {
                    network: network.name(),
                    stage: "run",
                    error: "panicked",
                });
                *l.peer.write().unwrap_or_else(PoisonError::into_inner) = None;
                l.set(Phase::Failed);
            }
        })
    };
    *l.task.lock().unwrap_or_else(PoisonError::into_inner) = Some(guard);
}

async fn run(
    l: Arc<Lightning>,
    chain: node::esplora::Esplora,
    store: Arc<Store>,
    hub: Arc<crate::ws::Hub>,
    network: Network,
) {
    let name = network.name();
    // Unreachable: the config refuses Lightning where LDK has no such network.
    let Some(ln_network) = network.ln() else {
        return;
    };
    let mut config = ln::Config::new(ln_network, l.dir.clone());
    config.peers.clone_from(&l.config.peers);
    config.max_peers = l.config.max_peers;
    config.max_channels = l.config.max_channels;
    let (peer, load) = match Peer::start(config, chain.clone()) {
        Ok(p) => p,
        Err(e) => {
            logging::emit(&LightningFailed {
                network: name,
                stage: "start",
                error: &e.to_string(),
            });
            l.set(Phase::Failed);
            return;
        }
    };
    report_start(&l, name, &load);
    let peer = Arc::new(peer);
    // Subscribed before anything is read, so no record falls between `recent` and the stream.
    let history = peer.history();
    let events = peer.events();
    *l.peer.write().unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(&peer));
    l.set(Phase::Running(peer.status()));

    let skipped = AtomicU32::new(0);
    let sampler = store_ln::Config {
        observer: Arc::new({
            let l = Arc::clone(&l);
            move |e: &store_ln::Event| report_snapshot(&l, name, &skipped, e)
        }),
        ..store_ln::Config::default()
    };
    let mut history = history;
    let mut pending = Pending::default();
    let stalled = tokio::select! {
        () = consume(&*peer, &mut history, &mut pending, &store, &l, name) => false,
        stalled = report(&peer, events, &l, name) => stalled,
        () = store_ln::run(Arc::clone(&store), || statistics(&peer), sampler) => false,
        () = index::keep(Arc::clone(&peer), Arc::clone(&store), Arc::clone(&l), hub, name) => false,
        () = movers::keep(Arc::clone(&store), Arc::clone(&l)) => false,
        () = index::fill_funding(chain, Arc::clone(&peer), Arc::clone(&store), Arc::clone(&l), name) => false,
        () = l.stop.notified() => false,
    };
    if stalled {
        logging::emit(&LightningFailed {
            network: name,
            stage: "run",
            error: "stalled",
        });
    }

    *l.peer.write().unwrap_or_else(PoisonError::into_inner) = None;
    l.set(if stalled {
        Phase::Failed
    } else {
        Phase::Stopped
    });
    let started = Instant::now();
    // No clone is left: routes only borrow it under the lock taken above.
    if let Ok(peer) = Arc::try_unwrap(peer) {
        let result = tokio::time::timeout(STOP_WAIT / 2, peer.shutdown()).await;
        let result = result.unwrap_or_else(|_| Err(std::io::Error::other("timed out")));
        let error = result.as_ref().err().map(ToString::to_string);
        logging::emit(&LightningStopped {
            network: name,
            graph_bytes: result.ok(),
            error: error.as_deref(),
            duration_ms: started.elapsed().as_secs_f64() * 1000.0,
        });
    }
    // The peer sends nothing more: store what it sent.
    let deadline = Instant::now() + STOP_WAIT * 2 / 5;
    flush(&mut history, &mut pending, &store, &l, name, deadline).await;
}

fn report_start(l: &Lightning, network: &'static str, load: &ln::GraphLoad) {
    let mut e = LightningStarted {
        network,
        peers: l.config.peers.len(),
        max_peers: l.config.max_peers,
        max_channels: l.config.max_channels,
        graph: "fresh",
        graph_channels: None,
        graph_nodes: None,
        graph_bytes: None,
        graph_age_secs: None,
        load_ms: None,
        error: None,
    };
    match load {
        ln::GraphLoad::Fresh => {}
        ln::GraphLoad::Loaded {
            nodes,
            channels,
            bytes,
            duration,
            age,
        } => {
            e.graph = "loaded";
            e.graph_channels = Some(*channels);
            e.graph_nodes = Some(*nodes);
            e.graph_bytes = Some(*bytes);
            e.graph_age_secs = Some(age.as_secs());
            e.load_ms = Some(duration.as_secs_f64() * 1000.0);
        }
        ln::GraphLoad::Unreadable { error } => {
            e.graph = "unreadable";
            e.error = Some(error);
        }
    }
    logging::emit(&e);
}

// The history: the peer's records, stored in order, once each.

/// Where the history comes from: the peer, or a scripted one in the tests.
pub(crate) trait HistorySource {
    fn recent(&self, after: u64) -> Vec<Record>;
    fn open(&self) -> (u64, Vec<ln::Opened>);
}

impl HistorySource for Peer {
    fn recent(&self, after: u64) -> Vec<Record> {
        Peer::recent(self, after)
    }

    fn open(&self) -> (u64, Vec<ln::Opened>) {
        Peer::open(self)
    }
}

fn block(b: ln::BlockRef) -> store_ln::Block {
    store_ln::Block {
        height: b.height,
        hash: b.hash,
        time: b.time,
    }
}

fn node(id: ln::NodeId) -> [u8; 33] {
    let mut out = [0; 33];
    let s = id.as_slice();
    if s.len() == out.len() {
        out.copy_from_slice(s);
    }
    out
}

fn open(o: &ln::Opened) -> store_ln::Open {
    store_ln::Open {
        scid: o.scid,
        node_one: node(o.node_one),
        node_two: node(o.node_two),
        capacity: o.capacity_sats,
        block: block(o.block),
    }
}

fn kind(k: CloseKind) -> store_ln::Kind {
    match k {
        CloseKind::Cooperative => store_ln::Kind::Cooperative,
        CloseKind::Force => store_ln::Kind::Force,
        CloseKind::Penalty => store_ln::Kind::Penalty,
        CloseKind::Other => store_ln::Kind::Other,
    }
}

/// `<height>x<index>x<output>`, as Lightning writes a short channel id.
pub fn scid_text(scid: u64) -> String {
    format!(
        "{}x{}x{}",
        scid >> 40,
        scid >> 16 & 0xff_ffff,
        scid & 0xffff
    )
}

fn change(h: &History) -> Change {
    match h {
        History::Opened(o) => Change::Opened(open(o)),
        History::Closed(c) => Change::Closed(
            store_ln::Open {
                scid: c.scid,
                node_one: node(c.node_one),
                node_two: node(c.node_two),
                capacity: c.capacity_sats,
                block: block(c.opened),
            },
            store_ln::Close {
                block: block(c.closed),
                txid: c.txid,
                kind: kind(c.kind),
                fee: c.fee_sats,
            },
        ),
        History::Penalty {
            scid,
            txid,
            block: b,
        } => Change::Penalty(
            *scid,
            store_ln::Penalty {
                block: block(*b),
                txid: *txid,
            },
        ),
        History::OpenUndone { scid } => Change::OpenUndone(*scid),
        History::CloseUndone { scid } => Change::CloseUndone(*scid),
        History::PenaltyUndone { scid } => Change::PenaltyUndone(*scid),
    }
}

/// Records waiting to be stored, oldest first, each with the sequence number it brings the
/// table to. They leave only once committed, so a write cut short loses none of them.
#[derive(Default)]
pub(crate) struct Pending {
    pub(crate) changes: VecDeque<(u64, Change)>,
    /// The last record taken.
    pub(crate) seq: u64,
    /// The store's generation when `changes` were taken ([`Store::write_from`]).
    pub(crate) generation: u64,
}

impl Pending {
    /// Takes `r` if it is the next record; skips one already taken. `false`: a gap before it.
    fn take(&mut self, r: &Record, network: &'static str) -> bool {
        if r.seq <= self.seq {
            return true;
        }
        if r.seq != self.seq + 1 {
            return false;
        }
        if let History::Closed(c) = &r.change {
            logging::emit(&LightningChannelClosed {
                network,
                channel: scid_text(c.scid),
                kind: kind(c.kind).label(),
                height: c.closed.height,
                capacity: Some(c.capacity_sats),
                fee: c.fee_sats,
            });
        } else if let History::Penalty { scid, block, .. } = &r.change {
            logging::emit(&LightningChannelClosed {
                network,
                channel: scid_text(*scid),
                kind: "penalty",
                height: block.height,
                capacity: None,
                fee: None,
            });
        }
        self.changes.push_back((r.seq, change(&r.change)));
        self.seq = r.seq;
        true
    }

    /// Takes `r` whatever came before it: past a gap that nothing can fill.
    fn take_after_gap(&mut self, r: &Record, network: &'static str, open: usize) {
        if !self.take(r, network) {
            logging::emit(&LightningHistoryGap {
                network,
                missed: r.seq - self.seq - 1,
                open,
            });
            self.seq = r.seq - 1;
            self.take(r, network);
        }
    }

    /// Takes records in order; past a gap, starts again from the peer's open channels.
    fn extend(&mut self, src: &impl HistorySource, records: Vec<Record>, network: &'static str) {
        let mut records = records.into_iter();
        let mut recovered = false;
        while let Some(r) = records.next() {
            if self.take(&r, network) {
                continue;
            }
            if recovered {
                // The peer's memory did not follow its own open set: take what comes.
                self.take_after_gap(&r, network, 0);
                continue;
            }
            recovered = true;
            let missed = r.seq - self.seq - 1;
            let (seq, open) = src.open();
            logging::emit(&LightningHistoryGap {
                network,
                missed,
                open: open.len(),
            });
            let seq = self.seq.max(seq);
            self.changes
                .extend(open.iter().map(|o| (seq, Change::Opened(self::open(o)))));
            self.seq = seq;
            // What came after the open set's sequence number, from the peer's own memory.
            records = src.recent(self.seq).into_iter();
        }
    }

    /// Stores up to [`BATCH`] changes from the front, in one write. On failure they stay.
    async fn store_front(&mut self, store: &Store, l: &Lightning) -> Result<(), store::Error> {
        let n = self.changes.len().min(BATCH);
        let batch: Vec<Change> = self.changes.iter().take(n).map(|(_, c)| *c).collect();
        let written = store_ln::apply_from(store, self.generation, batch.clone()).await?;
        // Those deleted the channel's fee history: its next round starts it again.
        {
            let mut heads = l.fees.write().unwrap_or_else(PoisonError::into_inner);
            for c in &batch {
                match c {
                    Change::Closed(o, _) => heads.forget(o.scid),
                    Change::OpenUndone(scid) => heads.forget(*scid),
                    _ => {}
                }
            }
        }
        // What the table did not hold is news for the overview's feed, once it is live.
        let mut penalties = Vec::new();
        {
            let mut f = l.feed.lock().unwrap_or_else(PoisonError::into_inner);
            for (c, _) in batch.iter().zip(&written).filter(|(_, w)| **w) {
                match c {
                    Change::Penalty(scid, p) => penalties.push((*scid, *p)),
                    c => f.wait_for(c),
                }
            }
        }
        for (scid, p) in penalties {
            // A breach is rare: one indexed read for its channel. A failed read loses the event.
            if let Ok(Some(c)) = store_ln::channel(store, scid).await {
                l.feed
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .wait(feed::Event::penalty(&c, &p));
            }
        }
        if let Some((seq, _)) = self.changes.drain(..n).next_back() {
            l.seq.store(seq, Ordering::Relaxed);
        }
        l.records.fetch_add(n as u64, Ordering::Relaxed);
        Ok(())
    }
}

/// Stores the peer's history, in order and once each, until the stream closes. Records already
/// kept by the peer are read first; a receiver that lags reads the peer's memory again. What is
/// not stored yet stays in `p` if this is dropped: [`flush`] stores it at shutdown.
pub(crate) async fn consume(
    src: &impl HistorySource,
    rx: &mut broadcast::Receiver<Record>,
    p: &mut Pending,
    store: &Store,
    l: &Lightning,
    network: &'static str,
) {
    if p.changes.is_empty() {
        p.generation = store.generation();
    }
    p.extend(src, src.recent(p.seq), network);
    let mut failures = 0u32;
    loop {
        if p.changes.is_empty() {
            match rx.recv().await {
                Ok(r) => p.extend(src, vec![r], network),
                Err(RecvError::Lagged(_)) => p.extend(src, src.recent(p.seq), network),
                Err(RecvError::Closed) => return,
            }
        }
        while p.changes.len() < BATCH {
            match rx.try_recv() {
                Ok(r) => p.extend(src, vec![r], network),
                Err(TryRecvError::Lagged(_)) => p.extend(src, src.recent(p.seq), network),
                Err(TryRecvError::Empty | TryRecvError::Closed) => break,
            }
        }
        // Retried until stored: these records are what nothing can rebuild.
        match p.store_front(store, l).await {
            Ok(()) if failures > 0 => {
                logging::emit(&LightningHistoryResumed { network, failures });
                failures = 0;
            }
            Ok(()) => {}
            // The node was found on another chain since these were taken: they and what the
            // peer sent meanwhile are never written, and the records after them are taken anew.
            Err(store::Error::Held) => {
                // Read first: a reopening while this runs must leave what it takes stale too.
                let now = store.generation();
                let mut dropped = p.changes.len();
                p.changes.clear();
                loop {
                    match rx.try_recv() {
                        Ok(r) => {
                            p.seq = p.seq.max(r.seq);
                            dropped += 1;
                        }
                        Err(TryRecvError::Lagged(n)) => {
                            dropped =
                                dropped.saturating_add(usize::try_from(n).unwrap_or(usize::MAX));
                        }
                        Err(TryRecvError::Empty | TryRecvError::Closed) => break,
                    }
                }
                // What the receiver skipped is still in the peer's memory: skip it there too.
                if let Some(last) = src.recent(p.seq).last() {
                    p.seq = p.seq.max(last.seq);
                }
                p.generation = now;
                logging::emit(&LightningHistoryFailed {
                    network,
                    error: "held",
                    failures: 1,
                    waiting: dropped,
                });
            }
            Err(e) => {
                failures = failures.saturating_add(1);
                if failures.is_power_of_two() {
                    logging::emit(&LightningHistoryFailed {
                        network,
                        error: if matches!(e, store::Error::Full) {
                            "busy"
                        } else {
                            "store"
                        },
                        failures,
                        waiting: p.changes.len(),
                    });
                }
                let backoff = 1u64 << failures.min(6).saturating_sub(1);
                tokio::time::sleep(Duration::from_secs(backoff)).await;
            }
        }
    }
}

/// At shutdown, once the peer has stopped and sends nothing more: takes what is left on the
/// stream and stores everything pending, trying until `deadline`. A close the peer found is no
/// longer in its graph file, so a restart could not find it again.
pub(crate) async fn flush(
    rx: &mut broadcast::Receiver<Record>,
    p: &mut Pending,
    store: &Store,
    l: &Lightning,
    network: &'static str,
    deadline: Instant,
) {
    loop {
        match rx.try_recv() {
            Ok(r) => p.take_after_gap(&r, network, 0),
            Err(TryRecvError::Lagged(missed)) => logging::emit(&LightningHistoryGap {
                network,
                missed,
                open: 0,
            }),
            Err(TryRecvError::Empty | TryRecvError::Closed) => break,
        }
    }
    let until = tokio::time::Instant::from_std(deadline);
    while !p.changes.is_empty() {
        match tokio::time::timeout_at(until, p.store_front(store, l)).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            // Out of time, waiting for the writer or after failures: what is left is lost.
            _ => {
                logging::emit(&LightningHistoryFailed {
                    network,
                    error: "shutdown",
                    failures: 1,
                    waiting: p.changes.len(),
                });
                return;
            }
        }
    }
}

// Events: what the peer reports, as log lines.

/// An error's first line, at most 120 bytes: a node error can quote a whole proxy error page.
fn short(error: &str) -> &str {
    let line = error.lines().next().unwrap_or_default();
    let mut end = line.len().min(120);
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    line.get(..end).unwrap_or_default()
}

fn ldk_level(l: ln::Level) -> &'static str {
    match l {
        ln::Level::Gossip => "gossip",
        ln::Level::Trace => "trace",
        ln::Level::Debug => "debug",
        ln::Level::Info => "info",
        ln::Level::Warn => "warn",
        ln::Level::Error => "error",
    }
}

/// Logs the peer's events until it stops. `true` when it went silent: the peer sends `Stats`
/// every ten seconds, so [`STALLED`] without one means its supervisor ended (a panic, or a
/// worker it watches ended) and the peer can no longer validate, watch or report.
async fn report(
    peer: &Peer,
    mut events: broadcast::Receiver<Event>,
    l: &Lightning,
    network: &'static str,
) -> bool {
    let mut summarised = Instant::now();
    let mut heard = tokio::time::Instant::now();
    let status = peer.status();
    loop {
        let e = match tokio::time::timeout_at(heard + STALLED, events.recv()).await {
            Err(_) => return true,
            Ok(Ok(e)) => e,
            Ok(Err(RecvError::Lagged(_))) => continue,
            Ok(Err(RecvError::Closed)) => return false,
        };
        if matches!(e, Event::Stats(_)) {
            heard = tokio::time::Instant::now();
        }
        match e {
            Event::Stats(s) if summarised.elapsed() >= SUMMARY_EVERY => {
                summarised = Instant::now();
                summary(network, &s, &status.borrow(), l);
            }
            Event::Stats(_) | Event::LdkSuppressed { .. } => {}
            Event::Synced {
                after,
                nodes,
                channels,
                from_disk,
            } => logging::emit(&LightningSynced {
                network,
                after_ms: after.as_secs_f64() * 1000.0,
                nodes,
                channels,
                from_disk,
            }),
            Event::PeerConnected(p) => logging::emit(&LightningPeerConnected {
                network,
                peer: p.to_string(),
            }),
            Event::PeerDisconnected {
                peer,
                connected_for,
            } => logging::emit(&LightningPeerLost {
                network,
                peer: peer.to_string(),
                connected_secs: connected_for.as_secs(),
            }),
            Event::PeerWrongChain(key) => logging::emit(&LightningPeerWrongChain {
                network,
                peer: key.to_string(),
            }),
            Event::PeerUnreachable { peer, failures } => {
                if failures.is_power_of_two() {
                    logging::emit(&LightningPeerUnreachable {
                        network,
                        peer: peer.to_string(),
                        failures,
                    });
                }
            }
            Event::CeilingReached { channels } => {
                logging::emit(&LightningCeilingReached { network, channels });
            }
            Event::GraphSaved { bytes, duration } => logging::emit(&LightningGraphSaved {
                network,
                bytes,
                duration_ms: duration.as_secs_f64() * 1000.0,
            }),
            Event::GraphSaveFailed { error } => logging::emit(&LightningSaveFailed {
                network,
                error: short(&error),
            }),
            Event::Pruned { channels, nodes } => logging::emit(&LightningPruned {
                network,
                channels,
                nodes,
            }),
            Event::Ldk(r) => logging::emit(&LightningLdkRecord {
                network,
                ldk_level: ldk_level(r.level),
                module: r.module,
                line: r.line,
                peer: r.peer.map(|p| p.to_string()),
                message: &r.message,
            }),
            Event::LookupFailed {
                failures,
                error,
                pending,
            } => {
                if failures.is_power_of_two() {
                    logging::emit(&LightningLookupFailed {
                        network,
                        error,
                        failures,
                        pending,
                    });
                }
            }
            Event::CloseWatchFailed { failures, error } => {
                if failures.is_power_of_two() {
                    logging::emit(&LightningWatchFailed {
                        network,
                        error,
                        failures,
                    });
                }
            }
            Event::Reorg { fork, disconnected } => logging::emit(&LightningReorg {
                network,
                fork_height: fork,
                disconnected,
            }),
            Event::CloseWatchReset {
                from,
                to,
                rechecked,
            } => logging::emit(&LightningWatchReset {
                network,
                from,
                to,
                rechecked,
            }),
        }
    }
}

fn summary(network: &'static str, s: &ln::Stats, status: &ln::Status, l: &Lightning) {
    let (v, c) = (&s.validation, &status.closes);
    logging::emit(&LightningSummary {
        network,
        synced: status.synced,
        peers: s.peers,
        nodes: s.nodes,
        channels: s.channels,
        unchecked: v.unchecked,
        pending: v.pending,
        early: v.early,
        rejected: v.rejected.total(),
        lookup_requests: v.requests,
        lookup_outputs: v.outputs,
        lookup_failures: v.node_failures,
        close_height: c.height,
        watched: c.watched,
        catch_up: c.catch_up,
        blocks_read: c.blocks,
        close_requests: c.requests,
        close_failures: c.node_failures,
        cooperative: c.cooperative,
        force: c.force,
        penalty: c.penalty,
        other: c.other,
        reorgs: c.reorgs,
        messages_per_sec: s.messages_per_sec,
        gossip_bytes: s.totals.bytes,
        withheld_batches: s.totals.withheld,
        history_records: l.records.load(Ordering::Relaxed),
        history_seq: l.seq.load(Ordering::Relaxed),
        index_ms: match l.index_ms.load(Ordering::Relaxed) {
            0 => None,
            us => Some(us as f64 / 1000.0),
        },
        funding_txids: l.funded.load(Ordering::Relaxed),
        fee_records: l.fee_records.load(Ordering::Relaxed),
        fee_write_ms: match l.fee_write_us.load(Ordering::Relaxed) {
            0 => None,
            us => Some(us as f64 / 1000.0),
        },
        fee_failures: l.fee_failures.load(Ordering::Relaxed),
        feed_events: l.feed_events.load(Ordering::Relaxed),
        feed_left_out: l.feed_left_out.load(Ordering::Relaxed),
        feed_ms: match l.feed_us.load(Ordering::Relaxed) {
            0 => None,
            us => Some(us as f64 / 1000.0),
        },
        overview_read_ms: match l.overview_read_us.load(Ordering::Relaxed) {
            0 => None,
            us => Some(us as f64 / 1000.0),
        },
        overview_ms: match l.overview_us.load(Ordering::Relaxed) {
            0 => None,
            us => Some(us as f64 / 1000.0),
        },
        overview_failures: l.overview_failures.load(Ordering::Relaxed),
    });
}

// Statistics: the verified graph's totals, every ten minutes.

/// The graph's totals, or `None` while it is not synced: a partial graph would undercount.
fn statistics(peer: &Peer) -> Option<Stats> {
    if !peer.status().borrow().synced {
        return None;
    }
    Some(peer.read(totals))
}

/// Policies above this fee rate (ppm, over 100 %) or base fee (msat, 1,000 sats) are left out of
/// the averages.
pub(crate) const FEE_CAP: u64 = 1_000_000;

/// Channels, capacity and policies over every channel in the graph, and nodes by the kind of
/// address they announce. Medians are computed after the graph is released.
pub(crate) fn totals(g: &ln::ReadOnlyNetworkGraph<'_>) -> Stats {
    let channels = g.channels();
    let mut capacities = Vec::with_capacity(channels.len());
    let mut rates = Vec::with_capacity(2 * channels.len());
    let mut bases = Vec::with_capacity(2 * channels.len());
    let mut s = Stats::default();
    for (_, c) in channels.unordered_iter() {
        let cap = c.capacity_sats.unwrap_or(0);
        s.channels += 1;
        s.capacity += cap;
        capacities.push(cap);
        for u in [&c.one_to_two, &c.two_to_one].into_iter().flatten() {
            let (rate, base) = (
                u64::from(u.fees.proportional_millionths),
                u64::from(u.fees.base_msat),
            );
            rates.push(rate);
            bases.push(base);
            // A fee over the cap refuses to route rather than prices it; a few hundred such
            // policies, up to 2^31 - 1, would make the averages meaningless. Medians keep them.
            if rate <= FEE_CAP && base <= FEE_CAP {
                s.policies += 1;
                s.fee_rate += rate;
                s.base_fee += base;
            }
        }
    }
    for (_, n) in g.nodes().unordered_iter() {
        s.nodes += 1;
        let (mut tor, mut clear) = (false, false);
        for a in n
            .announcement_info
            .as_ref()
            .map_or(&[][..], |a| a.addresses())
        {
            match a {
                ln::SocketAddress::OnionV2(_) | ln::SocketAddress::OnionV3 { .. } => tor = true,
                _ => clear = true,
            }
        }
        match (tor, clear) {
            (true, true) => s.clearnet_tor_nodes += 1,
            (true, false) => s.tor_nodes += 1,
            (false, true) => s.clearnet_nodes += 1,
            (false, false) => s.unannounced_nodes += 1,
        }
    }
    s.med_capacity = store_ln::median(&mut capacities);
    s.med_fee_rate = store_ln::median(&mut rates);
    s.med_base_fee = store_ln::median(&mut bases);
    s
}

fn report_snapshot(l: &Lightning, network: &'static str, skipped: &AtomicU32, e: &store_ln::Event) {
    match e {
        store_ln::Event::Written {
            time,
            stats,
            rolled,
            elapsed,
        } => {
            l.written.fetch_add(1, Ordering::Release);
            logging::emit(&LightningStatsStored {
                network,
                time: *time,
                channels: stats.channels,
                nodes: stats.nodes,
                capacity: stats.capacity,
                skipped: skipped.swap(0, Ordering::Relaxed),
                rolled_minutes: rolled.minutes,
                rolled_hours: rolled.hours,
                duration_ms: elapsed.as_secs_f64() * 1000.0,
            });
        }
        store_ln::Event::Skipped { reason, .. } => {
            let n = skipped.fetch_add(1, Ordering::Relaxed).saturating_add(1);
            if n.is_power_of_two() {
                logging::emit(&LightningStatsSkipped {
                    network,
                    reason: reason.label(),
                    skipped: n,
                });
            }
        }
    }
}

// Routes.

pub fn routes() -> Router<Arc<NetworkContext>> {
    Router::new()
        .route("/app/lightning/status", get(status))
        .route("/app/lightning/statistics/latest", get(app_latest))
        .route("/app/lightning/statistics/{interval}", get(app_series))
        .route("/app/lightning/channels/opened", get(opened))
        .route("/app/lightning/channels/closed", get(closed))
        .route("/api/v1/lightning/statistics/latest", get(v1_latest))
        .route("/api/v1/lightning/statistics/{interval}", get(v1_series))
        .merge(nodes::routes())
        .merge(fees::routes())
        .merge(feed::routes())
        .merge(movers::routes())
        .merge(record::routes())
        .merge(penalties::routes())
}

fn json_response(body: Bytes, route: &'static str, cache: &'static str) -> Response {
    let mut res = (
        [(CONTENT_TYPE, HeaderValue::from_static("application/json"))],
        body,
    )
        .into_response();
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static(cache));
    res.extensions_mut().insert(ApiOutcome {
        route,
        source: Source::Stored,
        upstream_error: None,
    });
    res
}

fn to_json(v: &impl serde::Serialize, route: &'static str) -> Response {
    match serde_json::to_vec(v) {
        Ok(b) => json_response(Bytes::from(b), route, "no-cache"),
        Err(_) => ApiError::INTERNAL.into_response(),
    }
}

fn store_error(e: &store::Error) -> ApiError {
    match e {
        store::Error::TimedOut => ApiError::OVERLOADED,
        _ => ApiError::INTERNAL,
    }
}

/// The network's Lightning side and its store, or the answer for a network without them.
fn enabled(ctx: &NetworkContext) -> Result<(&Lightning, &Arc<Store>), ApiError> {
    match (&ctx.lightning, &ctx.blocks) {
        (Some(l), Some(t)) => Ok((l, &t.store)),
        _ => Err(OFF),
    }
}

/// `GET /app/lightning/status`: the peer's state from memory. `off` when not enabled.
async fn status(State(ctx): State<Arc<NetworkContext>>) -> Response {
    let Some(l) = &ctx.lightning else {
        return to_json(&json!({ "state": "off" }), "lightning_status");
    };
    let running = match l.phase() {
        Phase::Running(s) => Some(s.borrow().clone()),
        _ => None,
    };
    let s = running.as_ref();
    let v = json!({
        "state": l.state(),
        "peers_configured": l.config.peers.len(),
        "peers_connected": s.map(|s| s.peers.iter().filter(|p| p.connected).count()),
        "synced": s.map(|s| s.synced),
        "nodes": s.map(|s| s.nodes),
        "channels": s.map(|s| s.channels),
        "at_ceiling": s.map(|s| s.at_ceiling),
        "validation": s.map(|s| {
            let v = &s.validation;
            json!({
                "verified": v.verified,
                "unchecked": v.unchecked,
                "pending": v.pending,
                "early": v.early,
                "rejected": v.rejected.total(),
                "caught_up": v.caught_up,
            })
        }),
        "closes": s.map(|s| {
            let c = &s.closes;
            json!({
                "height": c.height,
                "caught_up": c.caught_up,
                "watched": c.watched,
                "catch_up": c.catch_up,
                "cooperative": c.cooperative,
                "force": c.force,
                "penalty": c.penalty,
                "other": c.other,
                "reorgs": c.reorgs,
            })
        }),
        "history": {
            "records": l.records.load(Ordering::Relaxed),
            "seq": l.seq.load(Ordering::Relaxed),
        },
    });
    to_json(&v, "lightning_status")
}

/// `?limit=N`, 1 to [`MAX_LIST`], and nothing else.
fn limit(uri: &Uri) -> Result<usize, ApiError> {
    const BAD: ApiError = ApiError::bad_request("the only parameter is limit, 1 to 100");
    let Some(q) = uri.query().filter(|q| !q.is_empty()) else {
        return Ok(DEFAULT_LIST);
    };
    q.strip_prefix("limit=")
        .filter(|n| (1..=3).contains(&n.len()) && !n.starts_with('0'))
        .filter(|n| n.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|n| n.parse::<usize>().ok())
        .filter(|n| (1..=MAX_LIST).contains(n))
        .ok_or(BAD)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

fn block_json(b: &store_ln::Block) -> Value {
    json!({ "height": b.height, "hash": b.hash.to_string(), "time": b.time })
}

/// A stored channel, with its nodes' aliases from the live graph when it holds them. An alias
/// is gossip: serialized as a JSON string, never interpreted.
fn channel_json(c: &Channel, aliases: &HashMap<[u8; 33], String>) -> Value {
    let node = |id: &[u8; 33]| json!({ "id": hex(id), "alias": aliases.get(id) });
    json!({
        "id": scid_text(c.open.scid),
        "scid": c.open.scid.to_string(),
        "node_one": node(&c.open.node_one),
        "node_two": node(&c.open.node_two),
        "capacity": c.open.capacity,
        "opened": block_json(&c.open.block),
        "closed": c.close.map(|x| json!({
            "block": block_json(&x.block),
            "txid": x.txid.to_string(),
            "kind": x.kind.label(),
            "fee": x.fee,
        })),
        "penalty": c.penalty.map(|p| json!({
            "block": block_json(&p.block),
            "txid": p.txid.to_string(),
        })),
    })
}

/// The aliases of `channels`' nodes, from the index (none before the first).
fn aliases(l: &Lightning, channels: &[Channel]) -> HashMap<[u8; 33], String> {
    let Some(index) = l.index() else {
        return HashMap::new();
    };
    channels
        .iter()
        .flat_map(|c| [c.open.node_one, c.open.node_two])
        .filter_map(|id| Some((id, index.node(&id)?.alias()?.to_owned())))
        .collect()
}

async fn list(ctx: &NetworkContext, uri: &Uri, closes: bool) -> Result<Response, ApiError> {
    let (l, store) = enabled(ctx)?;
    let n = limit(uri)?;
    let rows = if closes {
        store_ln::closed(store, n).await
    } else {
        store_ln::opened(store, n).await
    }
    .map_err(|e| store_error(&e))?;
    let names = aliases(l, &rows);
    let v: Vec<Value> = rows.iter().map(|c| channel_json(c, &names)).collect();
    let route = if closes {
        "lightning_closed"
    } else {
        "lightning_opened"
    };
    Ok(to_json(&v, route))
}

/// `GET /app/lightning/channels/opened`: newest funding first.
async fn opened(State(ctx): State<Arc<NetworkContext>>, uri: Uri) -> Result<Response, ApiError> {
    list(&ctx, &uri, false).await
}

/// `GET /app/lightning/channels/closed`: newest close first.
async fn closed(State(ctx): State<Arc<NetworkContext>>, uri: Uri) -> Result<Response, ApiError> {
    list(&ctx, &uri, true).await
}

/// A point's means over its snapshots, rounded to whole numbers. Averages over channels and
/// policies are their sums divided, so they stay exact across a roll-up; medians are the mean of
/// the snapshots' medians.
#[derive(serde::Serialize)]
struct Means {
    time: u64,
    samples: u64,
    channels: u64,
    nodes: u64,
    capacity: u64,
    avg_capacity: u64,
    med_capacity: u64,
    tor_nodes: u64,
    clearnet_nodes: u64,
    clearnet_tor_nodes: u64,
    unannounced_nodes: u64,
    policies: u64,
    avg_fee_rate: u64,
    avg_base_fee_msat: u64,
    med_fee_rate: u64,
    med_base_fee_msat: u64,
}

fn means(p: &Point) -> Means {
    let s = &p.sums;
    // `as` saturates and maps NaN to 0.
    let mean = |sum: u64| p.mean(sum).round() as u64;
    let per = |sum: u64, n: u64| (sum as f64 / n.max(1) as f64).round() as u64;
    Means {
        time: p.time,
        samples: p.samples,
        channels: mean(s.channels),
        nodes: mean(s.nodes),
        capacity: mean(s.capacity),
        avg_capacity: per(s.capacity, s.channels),
        med_capacity: mean(s.med_capacity),
        tor_nodes: mean(s.tor_nodes),
        clearnet_nodes: mean(s.clearnet_nodes),
        clearnet_tor_nodes: mean(s.clearnet_tor_nodes),
        unannounced_nodes: mean(s.unannounced_nodes),
        policies: mean(s.policies),
        avg_fee_rate: per(s.fee_rate, s.policies),
        avg_base_fee_msat: per(s.base_fee, s.policies),
        med_fee_rate: mean(s.med_fee_rate),
        med_base_fee_msat: mean(s.med_base_fee),
    }
}

/// The reference's `latest` object, its fields in its order.
#[derive(serde::Serialize)]
struct V1Latest {
    id: u64,
    added: String,
    channel_count: u64,
    node_count: u64,
    total_capacity: u64,
    tor_nodes: u64,
    clearnet_nodes: u64,
    unannounced_nodes: u64,
    avg_capacity: u64,
    avg_fee_rate: u64,
    avg_base_fee_mtokens: u64,
    med_capacity: u64,
    med_fee_rate: u64,
    med_base_fee_mtokens: u64,
    clearnet_tor_nodes: u64,
}

fn v1_latest_of(p: &Point) -> V1Latest {
    let m = means(p);
    V1Latest {
        id: p.time / EVERY,
        added: crate::mining::iso8601(p.time),
        channel_count: m.channels,
        node_count: m.nodes,
        total_capacity: m.capacity,
        tor_nodes: m.tor_nodes,
        clearnet_nodes: m.clearnet_nodes,
        unannounced_nodes: m.unannounced_nodes,
        avg_capacity: m.avg_capacity,
        avg_fee_rate: m.avg_fee_rate,
        avg_base_fee_mtokens: m.avg_base_fee_msat,
        med_capacity: m.med_capacity,
        med_fee_rate: m.med_fee_rate,
        med_base_fee_mtokens: m.med_base_fee_msat,
        clearnet_tor_nodes: m.clearnet_tor_nodes,
    }
}

/// `{"latest": …}`, kept a struct so the object inside keeps its order.
#[derive(serde::Serialize)]
struct V1Wrapped {
    latest: V1Latest,
}

/// One point of the reference's series, its fields in its order.
#[derive(serde::Serialize)]
struct V1Point {
    added: u64,
    channel_count: u64,
    total_capacity: u64,
    tor_nodes: u64,
    clearnet_nodes: u64,
    unannounced_nodes: u64,
    clearnet_tor_nodes: u64,
}

/// The newest totals: the latest snapshot stored, or the graph's at its first sync when newer, so
/// a synced graph never answers that it has no statistics.
pub(crate) async fn newest(l: &Lightning, store: &Store) -> Result<Option<Point>, ApiError> {
    let stored = store_ln::latest(store).await.map_err(|e| store_error(&e))?;
    let live = *l.live.lock().unwrap_or_else(PoisonError::into_inner);
    Ok(stored.into_iter().chain(live).max_by_key(|p| p.time))
}

async fn latest(ctx: &NetworkContext, shape: Shape) -> Result<Response, ApiError> {
    let (l, store) = enabled(ctx)?;
    let p = newest(l, store).await?.ok_or(NO_STATISTICS)?;
    let route = "lightning_statistics_latest";
    Ok(match shape {
        Shape::App => to_json(&means(&p), route),
        Shape::Reference => to_json(
            &V1Wrapped {
                latest: v1_latest_of(&p),
            },
            route,
        ),
    })
}

async fn app_latest(State(ctx): State<Arc<NetworkContext>>) -> Result<Response, ApiError> {
    latest(&ctx, Shape::App).await
}

async fn v1_latest(State(ctx): State<Arc<NetworkContext>>) -> Result<Response, ApiError> {
    latest(&ctx, Shape::Reference).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Shape {
    Reference,
    App,
}

/// A series answer as served, and the snapshot count and ten minutes it was computed for.
#[derive(Debug, Clone)]
struct Answer {
    key: (u64, u64),
    body: Bytes,
    from: Option<u64>,
    complete: bool,
}

fn app_series_json(s: &Series, interval: Interval) -> Value {
    json!({
        "interval": interval.name(),
        "from": s.from,
        "to": s.to,
        "step": s.step,
        "first": s.first,
        "slots": s.slots,
        "sampled": s.sampled,
        "complete": s.complete(),
        "points": s.points.iter().map(means).collect::<Vec<_>>(),
    })
}

/// The reference's series: newest first, its seven fields.
fn v1_series_json(s: &Series) -> Vec<V1Point> {
    s.points
        .iter()
        .rev()
        .map(|p| {
            let m = means(p);
            V1Point {
                added: p.time,
                channel_count: m.channels,
                total_capacity: m.capacity,
                tor_nodes: m.tor_nodes,
                clearnet_nodes: m.clearnet_nodes,
                unannounced_nodes: m.unannounced_nodes,
                clearnet_tor_nodes: m.clearnet_tor_nodes,
            }
        })
        .collect()
}

fn respond(a: Answer, route: &'static str) -> Response {
    let mut res = json_response(a.body, route, "public, max-age=10");
    let h = res.headers_mut();
    if let Some(from) = a.from {
        h.insert("x-data-from-time", HeaderValue::from(from));
    }
    h.insert(
        "x-data-complete",
        HeaderValue::from_static(if a.complete { "true" } else { "false" }),
    );
    res
}

/// A series answer, computed from the store on the first request after a new snapshot or a new
/// ten minutes, one computation at a time per network; until then served from memory.
async fn series(ctx: &NetworkContext, shape: Shape, i: &str) -> Result<Response, ApiError> {
    let interval = Interval::parse(i).ok_or(ApiError::bad_request("invalid interval"))?;
    let (l, store) = enabled(ctx)?;
    let route = match shape {
        Shape::App => "lightning_statistics",
        Shape::Reference => "lightning_statistics_v1",
    };
    let key = |now: u64| (l.written.load(Ordering::Acquire), now / EVERY);
    let cached = |now: u64| {
        let answers = l.answers.lock().unwrap_or_else(PoisonError::into_inner);
        answers
            .get(&(shape, interval))
            .filter(|a| a.key == key(now))
            .cloned()
    };
    if let Some(a) = cached(store_ln::unix_now()) {
        return Ok(respond(a, route));
    }
    let _one = l.compute.lock().await;
    let now = store_ln::unix_now();
    if let Some(a) = cached(now) {
        return Ok(respond(a, route));
    }
    let k = key(now);
    let s = store_ln::series(store, interval, now)
        .await
        .map_err(|e| store_error(&e))?;
    let mut answers = l.answers.lock().unwrap_or_else(PoisonError::into_inner);
    let mut mine = None;
    for (sh, body) in [
        (
            Shape::App,
            serde_json::to_vec(&app_series_json(&s, interval)),
        ),
        (Shape::Reference, serde_json::to_vec(&v1_series_json(&s))),
    ] {
        let a = Answer {
            key: k,
            body: Bytes::from(body.map_err(|_| ApiError::INTERNAL)?),
            from: s.earliest(),
            complete: s.complete(),
        };
        if sh == shape {
            mine = Some(a.clone());
        }
        answers.insert((sh, interval), a);
    }
    drop(answers);
    mine.map(|a| respond(a, route)).ok_or(ApiError::INTERNAL)
}

async fn app_series(
    State(ctx): State<Arc<NetworkContext>>,
    UrlPath(i): UrlPath<String>,
) -> Result<Response, ApiError> {
    series(&ctx, Shape::App, &i).await
}

async fn v1_series(
    State(ctx): State<Arc<NetworkContext>>,
    UrlPath(i): UrlPath<String>,
) -> Result<Response, ApiError> {
    series(&ctx, Shape::Reference, &i).await
}

mod feed;
mod fees;
mod index;
mod movers;
pub(crate) mod nodes;
mod penalties;
mod record;
#[cfg(test)]
mod tests;
