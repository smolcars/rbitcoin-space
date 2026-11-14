//! Very large addresses (docs/API.md, "Very large addresses"): the guard that keeps the node from
//! running more than one unseeded large-address join at a time, and the ledger that adds such an
//! address up once and then answers for it from each block (`engine::ledger`).
//!
//! **The guard.** An unpaged call (an address's totals or unspent outputs) for a script the server
//! does not know to be small goes through one lane for the whole server: one such call at the
//! node at a time, held until the node answers. Each answer teaches the server the script's size
//! (`Verdict::Small` or `Verdict::Large`); a large one is never sent to the node again except to
//! seed it. Seeds, the WebSocket's checks before following an address, and background discovery
//! take the same lane.
//!
//! **The ledger** (with `DATA_DIR`): a reader opening a large address queues a seed; discovery
//! queues the scripts each block pays most, after a size check. One seed runs at a time; the
//! queue is bounded and a client may hold at most [`CLIENT_SEEDS`] places in it. Each kept address
//! then takes its whole history from the node once ([`book::history`]), in the same lane, after
//! the readers' seeds; one whose history the node refuses, or that is dropped for the bound, takes
//! the node's newest history page before its seed once instead ([`book::fill`]).

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::header::CACHE_CONTROL;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, body::Body};
use bitcoin::{Script, ScriptBuf};
use engine::ledger::{self as book, At, NodeSource, Seeded, Source as _};
use engine::store::Store;
use logging::events::{
    LedgerChecked, LedgerFillFailed, LedgerFilled, LedgerFollowFailed, LedgerFollowed,
    LedgerHistory, LedgerHistoryBound, LedgerHistoryFailed, LedgerSeedFailed, LedgerSeedRefused,
    LedgerSeeded, LedgerTotalsRoute,
};
use node::esplora::model::ScriptInfo;
use node::esplora::{Error, Esplora, RawResponse, Route, ScriptHash, ScriptRef, ScriptSize};
use node::rpc::{Limits as RpcLimits, Rpc};
use serde_json::{Value, json};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use crate::config::{LedgerConfig, NetworkConfig};
use crate::limits::Client;
use crate::verdicts::{Verdict, Verdicts};
use crate::ws::Tracking;
use crate::{ApiError, NetworkContext};

/// An address is large when the node refuses its totals for size, when its totals answer counts
/// more funded outputs than this, or when that answer takes longer than the history deadline.
/// rbitcoin's own unit is paying transactions (its default `--heavy-sh-creates` and
/// `--max-sh-creates`, 10,000); a totals answer gives only funded outputs, of which every paying
/// transaction has at least one, so the server counts outputs, never fewer than the node would.
pub const LARGE: u64 = 10_000;
/// How long the server waits for a call in the lane: a seed, or a totals answer it learns from. The
/// node cannot be stopped, so the lane stays held this long at most (docs/RBITCOIN.md: 8 s for
/// 1.8 million outputs on signet; never measured on mainnet).
pub const SEED_TIMEOUT: Duration = Duration::from_secs(900);
/// How long a reader's request waits for the lane before it is told the node is busy.
pub const LANE_WAIT: Duration = Duration::from_secs(5);
/// Seeds waiting per network, readers' and discovery's each.
pub const QUEUE: usize = 16;
/// Places in the readers' queue one client may hold.
pub const CLIENT_SEEDS: usize = 2;
/// A queued reader seed nobody has asked about for this long is dropped before it starts.
pub const ABANDONED: Duration = Duration::from_secs(120);
/// A seed the node refused for size is not tried again for this long.
const REFUSED_FOR: Duration = Duration::from_secs(3600);
/// A seed that failed is not tried again for this long; a fill, this long doubled at each failure
/// of that address, up to [`FILL_RETRY_MAX`].
const FAILED_FOR: Duration = Duration::from_secs(600);
const FILL_RETRY_MAX: Duration = Duration::from_secs(24 * 3600);
/// A whole history the node refused is asked again after this long: the operator may have raised
/// its cap. A refusal costs the node milliseconds.
const HISTORY_REFUSED_FOR: Duration = Duration::from_secs(24 * 3600);
/// Failed whole lists after which a kept address takes the newest page before its seed instead,
/// while its list is still tried now and then. A refused list counts as this many.
const LIST_TRIES: u32 = 2;
/// Discovery: candidates taken from each block, size checks an hour, and how long a checked
/// script is not checked again.
pub const PER_BLOCK: usize = 3;
pub const CHECKS_PER_HOUR: usize = 12;
const RECHECK: Duration = Duration::from_secs(7 * 24 * 3600);
/// Bounds of the remembered outcomes and checked scripts.
const REMEMBERED: usize = 4096;
/// A reader's view is written to the store at most this often per script (for eviction).
const TOUCH_EVERY: Duration = Duration::from_secs(300);
/// A whole history viewed this lately is never dropped to make room: a reader may be paging it.
pub const VIEWING: Duration = Duration::from_secs(1800);
/// A kept address's whole list is taken only once a reader has viewed it, and stays queued this
/// long after the last view.
pub const WANTED_FOR: Duration = Duration::from_secs(3600);
/// A history dropped for the bound is taken again at most this often per address, counted from
/// when it was last taken: the lists are heavy for the node.
pub const RELIST: Duration = Duration::from_secs(24 * 3600);

/// The lane's sentinel: no place in it within [`LANE_WAIT`].
pub const LANE_BUSY: &str = "lane busy";

/// The size check and the lane, held by every network. The lane itself is one for the server.
pub struct Guard {
    pub verdicts: Arc<Verdicts>,
    lane: Arc<Semaphore>,
    /// Its own client, timing out at [`SEED_TIMEOUT`], so the lane is not freed while the node
    /// may still be working.
    esplora: Esplora,
    deadline: Duration,
    pub ledger: Option<Arc<Ledger>>,
}

impl std::fmt::Debug for Guard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Guard").finish_non_exhaustive()
    }
}

/// What a check found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Size {
    Small,
    Large,
    /// The node refused it for size.
    TooLarge,
}

impl Guard {
    pub fn new(
        verdicts: Arc<Verdicts>,
        lane: Arc<Semaphore>,
        url: &str,
        deadline: Duration,
        ledger: Option<Arc<Ledger>>,
    ) -> Option<Self> {
        Some(Self {
            verdicts,
            lane,
            esplora: Esplora::with_limits(url, SEED_TIMEOUT, Esplora::DEFAULT_MAX_RESPONSE).ok()?,
            deadline,
            ledger,
        })
    }

    /// The lane, waited for at most `wait`.
    pub async fn lane(&self, wait: Duration) -> Option<OwnedSemaphorePermit> {
        tokio::time::timeout(wait, Arc::clone(&self.lane).acquire_owned())
            .await
            .ok()?
            .ok()
    }

    /// What is known of the script's size: tracked by the ledger counts as large.
    pub fn known(&self, sh: ScriptHash) -> Option<Size> {
        if self.ledger.as_ref().is_some_and(|l| l.is_tracked(sh)) {
            return Some(Size::Large);
        }
        match self.verdicts.class(sh, Instant::now())? {
            Verdict::Small => Some(Size::Small),
            Verdict::Large => Some(Size::Large),
            Verdict::TooLarge(_) => Some(Size::TooLarge),
            Verdict::Slow => None,
        }
    }

    /// Asks the node for `route` (a totals or unspent route of a script not known to be small)
    /// in the lane, and learns the script's size from the answer. `script` is the script itself
    /// when known, so a large one can be adopted by the ledger. Run in a heavy call's own task.
    pub async fn ask(
        &self,
        route: &Route,
        sh: ScriptHash,
        script: Option<ScriptBuf>,
        asked: Option<tokio::sync::oneshot::Sender<()>>,
    ) -> Result<RawResponse, Error> {
        let Some(lane) = self.lane(LANE_WAIT).await else {
            return Err(Error::Unavailable(LANE_BUSY.into()));
        };
        // The reader's deadline starts now.
        if let Some(tx) = asked {
            let _ = tx.send(());
        }
        self.ask_holding(lane, route, sh, script).await
    }

    /// [`Guard::ask`] with the lane already held: it is let go once the node has answered.
    pub async fn ask_holding(
        &self,
        _lane: OwnedSemaphorePermit,
        route: &Route,
        sh: ScriptHash,
        script: Option<ScriptBuf>,
    ) -> Result<RawResponse, Error> {
        // Learned while this waited: the node is not asked again for a large one.
        if matches!(self.known(sh), Some(Size::Large)) {
            return Err(Error::TooLarge);
        }
        let started = Instant::now();
        let call = self.esplora.raw(route);
        tokio::pin!(call);
        // Past the deadline it is large, known at once to every other request; the lane stays
        // held until the node answers.
        let answer = match tokio::time::timeout(self.deadline, &mut call).await {
            Ok(a) => a,
            Err(_) => {
                self.verdicts
                    .learn(sh, None, Verdict::Large, Instant::now());
                call.await
            }
        };
        if let Ok(raw) = &answer {
            self.learn(route, sh, script, raw, started.elapsed()).await;
        }
        answer
    }

    /// Checks a script's size in the lane, waiting for it at most `wait`: `None` when the lane
    /// stayed busy or the node failed.
    pub async fn check(&self, script: &Script, wait: Duration) -> Option<Size> {
        let sh = ScriptHash::from_script(script);
        if let Some(size) = self.known(sh) {
            return Some(size);
        }
        let _lane = self.lane(wait).await?;
        if let Some(size) = self.known(sh) {
            return Some(size);
        }
        let route = Route::ScriptStats {
            script: ScriptRef::ScriptHash(sh),
            asof: None,
        };
        let started = Instant::now();
        let raw = self.esplora.raw(&route).await.ok()?;
        self.learn(&route, sh, Some(script.to_owned()), &raw, started.elapsed())
            .await
    }

    /// What `raw` says of the script's size, remembered. A large script whose totals came with a
    /// chain-tip stamp the ledger holds is adopted as tracked at once, still in the lane, so no
    /// seed of it can start meanwhile: that answer is its seed.
    async fn learn(
        &self,
        route: &Route,
        sh: ScriptHash,
        script: Option<ScriptBuf>,
        raw: &RawResponse,
        took: Duration,
    ) -> Option<Size> {
        let now = Instant::now();
        if raw.status.as_u16() != 200 {
            if Error::from_status(raw.status, &raw.body) == Error::TooLarge {
                let size = ScriptSize::from_refusal(&raw.body);
                self.verdicts.learn(sh, None, Verdict::TooLarge(size), now);
                return Some(Size::TooLarge);
            }
            return None;
        }
        let stats = match route {
            Route::ScriptStats { .. } => {
                Some(serde_json::from_slice::<ScriptInfo>(&raw.body).ok()?)
            }
            _ => None,
        };
        // An address only grows, so an old block's count can show it is large today, never that
        // it is small: only current totals grant that.
        let current = matches!(route, Route::ScriptStats { asof: None, .. });
        let large = took >= self.deadline
            || stats
                .as_ref()
                .is_some_and(|s| s.chain_stats.funded_txo_count > LARGE);
        if !large {
            // Only current totals say how large a script is: a quick list of unspent outputs, or
            // totals at an old block, do not.
            stats.as_ref()?;
            if !current {
                return None;
            }
            self.verdicts.learn(sh, None, Verdict::Small, now);
            return Some(Size::Small);
        }
        self.verdicts.learn(sh, None, Verdict::Large, now);
        // Only a plain totals answer is exact at its stamp; one pinned with `?asof=` is too.
        if let (Some(ledger), Some(script), Some(info), Some(tip)) =
            (&self.ledger, script, stats, raw.tip)
        {
            ledger
                .adopt(&script, info.chain_stats.into(), tip.hash, tip.height)
                .await;
        }
        Some(Size::Large)
    }
}

/// A seed waiting for its turn.
#[derive(Debug, Clone)]
struct Job {
    script: ScriptBuf,
    sh: ScriptHash,
    /// The reader whose page asked for it; `None` for discovery.
    client: Option<IpAddr>,
    /// When a reader last asked about it.
    asked: Instant,
}

/// How a seed ended, remembered for a while.
#[derive(Debug, Clone, Copy)]
enum Ended {
    Refused(Option<ScriptSize>),
    Failed,
}

#[derive(Debug, Default)]
struct Seeds {
    readers: VecDeque<Job>,
    found: VecDeque<Job>,
    /// The seed taken from the queue: its script, when it was taken, its reader, and when that
    /// reader last asked (refreshed while it waits for the lane, so it is not taken as abandoned).
    running: Option<(ScriptHash, Instant, Option<IpAddr>, Instant)>,
    ended: HashMap<ScriptHash, (Ended, Instant)>,
    /// Discovery: scripts to check, and those checked lately.
    candidates: VecDeque<ScriptBuf>,
    checked: HashMap<ScriptHash, Instant>,
    checks: VecDeque<Instant>,
    touched: HashMap<ScriptHash, Instant>,
    /// The node's refusal of a seed was logged since the last seed that worked.
    refused_said: bool,
    failures: u32,
    /// Kept scripts still to be filled (as the store says), with their failures so far and when
    /// each may be tried next.
    unfilled: HashMap<ScriptHash, (u32, Instant)>,
    /// Kept scripts whose whole history is still to be taken, the same way.
    unhistoried: HashMap<ScriptHash, (u32, Instant)>,
    /// Kept scripts a reader viewed, and when last: only these take their whole list.
    wanted: HashMap<ScriptHash, Instant>,
}

impl Seeds {
    /// A reader asks about a script not tracked: where its seed stands. A script known to be
    /// large and not queued is queued for `client` while the queue and the client's share allow.
    /// The flag says whether a seed was queued.
    fn ask(
        &mut self,
        script: &Script,
        large: bool,
        client: IpAddr,
        now: Instant,
    ) -> (Status, bool) {
        let sh = ScriptHash::from_script(script);
        if let Some((running, since, c, _)) = self.running
            && running == sh
        {
            self.running = Some((running, since, c, now));
            return (Status::Seeding(now.saturating_duration_since(since)), false);
        }
        for (i, j) in self.readers.iter_mut().enumerate() {
            if j.sh == sh {
                j.asked = now;
                return (Status::Queued(i + 1), false);
            }
        }
        if let Some(i) = self.found.iter().position(|j| j.sh == sh) {
            // Asked for by a reader now: it moves to the readers' queue if there is room and the
            // reader holds fewer than its share.
            if self.readers.len() < QUEUE
                && self.held_by(client) < CLIENT_SEEDS
                && let Some(mut j) = self.found.remove(i)
            {
                j.client = Some(client);
                j.asked = now;
                self.readers.push_back(j);
                return (Status::Queued(self.readers.len()), true);
            }
            return (Status::Queued(self.readers.len() + i + 1), false);
        }
        if let Some((ended, until)) = self.ended.get(&sh).copied() {
            if until > now {
                let status = match ended {
                    Ended::Refused(size) => Status::Refused(size),
                    Ended::Failed => Status::Failed,
                };
                return (status, false);
            }
            self.ended.remove(&sh);
        }
        if !large {
            return (Status::None, false);
        }
        if self.readers.len() >= QUEUE || self.held_by(client) >= CLIENT_SEEDS {
            return (Status::Busy, false);
        }
        self.readers.push_back(Job {
            script: script.to_owned(),
            sh,
            client: Some(client),
            asked: now,
        });
        (Status::Queued(self.readers.len()), true)
    }

    /// Places `client` holds: its queued seeds and the one running, if its.
    fn held_by(&self, client: IpAddr) -> usize {
        let running = self.running.is_some_and(|(_, _, c, _)| c == Some(client));
        self.readers
            .iter()
            .filter(|j| j.client == Some(client))
            .count()
            + usize::from(running)
    }

    /// The next thing to do in the lane: a reader's seed, a fill that is due, a discovered seed,
    /// or a size check within the hour's budget. Readers who stopped asking are dropped first.
    fn next(&mut self, now: Instant) -> Option<Work> {
        self.readers.retain(|j| now < j.asked + ABANDONED);
        let job = match self.readers.pop_front() {
            Some(j) => Some(j),
            None => {
                // Only a script a reader viewed lately takes its whole list.
                let wanted =
                    |sh: &ScriptHash| self.wanted.get(sh).is_some_and(|at| now < *at + WANTED_FOR);
                // A fill waits for the whole list while it may still come soon; after two failed
                // lists, or while a dropped one waits its day, the page fill goes ahead.
                let listing = |sh: &ScriptHash| {
                    wanted(sh)
                        && self.unhistoried.get(sh).is_some_and(|(fails, due)| {
                            *fails < LIST_TRIES && *due <= now + FAILED_FOR
                        })
                };
                let fills: HashMap<ScriptHash, (u32, Instant)> = self
                    .unfilled
                    .iter()
                    .filter(|(sh, _)| !listing(sh))
                    .map(|(sh, v)| (*sh, *v))
                    .collect();
                if let Some(sh) = due_in(&fills, now) {
                    return Some(Work::Fill(sh));
                }
                let lists: HashMap<ScriptHash, (u32, Instant)> = self
                    .unhistoried
                    .iter()
                    .filter(|(sh, _)| wanted(sh))
                    .map(|(sh, v)| (*sh, *v))
                    .collect();
                if let Some(sh) = due_in(&lists, now) {
                    return Some(Work::History(sh));
                }
                self.found.pop_front()
            }
        };
        if let Some(j) = job {
            // Running from now, for the client's share and the page, though it waits for the lane.
            self.running = Some((j.sh, now, j.client, j.asked));
            return Some(Work::Seed(j));
        }
        while self
            .checks
            .front()
            .is_some_and(|t| now >= *t + Duration::from_secs(3600))
        {
            self.checks.pop_front();
        }
        if self.checks.len() >= CHECKS_PER_HOUR {
            return None;
        }
        let script = self.candidates.pop_front()?;
        self.checks.push_back(now);
        if self.checked.len() >= REMEMBERED {
            self.checked.retain(|_, t| now < *t + RECHECK);
            if self.checked.len() >= REMEMBERED {
                self.checked.clear();
            }
        }
        self.checked.insert(ScriptHash::from_script(&script), now);
        Some(Work::Check(script))
    }
}

impl Seeds {
    /// The scripts the store says are still to be filled: new ones are due now, and those
    /// known keep their failures.
    fn set_unfilled(&mut self, kept: &[ScriptHash], now: Instant) {
        self.unfilled.retain(|sh, _| kept.contains(sh));
        for sh in kept {
            self.unfilled.entry(*sh).or_insert((0, now));
        }
    }

    /// A fill failed: it is due again after a wait that doubles with each failure. Its count.
    fn fill_failed(&mut self, sh: ScriptHash, now: Instant) -> u32 {
        backoff(&mut self.unfilled, sh, now)
    }

    /// The scripts the store says may take their whole history, each due from the time given
    /// (later for a history dropped lately), as [`Self::set_unfilled`].
    fn set_unhistoried(&mut self, kept: &[(ScriptHash, Instant)]) {
        self.unhistoried
            .retain(|sh, _| kept.iter().any(|(k, _)| k == sh));
        for (sh, due) in kept {
            let e = self.unhistoried.entry(*sh).or_insert((0, *due));
            e.1 = e.1.max(*due);
        }
    }

    /// A reader viewed a kept script: its whole list may be taken, while it is viewed.
    fn want(&mut self, sh: ScriptHash, now: Instant) {
        if self.wanted.len() >= REMEMBERED && !self.wanted.contains_key(&sh) {
            self.wanted.retain(|_, at| now < *at + WANTED_FOR);
            if self.wanted.len() >= REMEMBERED {
                return;
            }
        }
        self.wanted.insert(sh, now);
    }
}

/// The script due first in `map`, if one is due.
fn due_in(map: &HashMap<ScriptHash, (u32, Instant)>, now: Instant) -> Option<ScriptHash> {
    map.iter()
        .filter(|(_, (_, at))| now >= *at)
        .min_by_key(|(sh, (_, at))| (*at, sh.to_byte_array()))
        .map(|(sh, _)| *sh)
}

/// A failure of `sh`'s work in `map`: due again after a wait that doubles with each failure, up
/// to [`FILL_RETRY_MAX`]. Its count.
fn backoff(map: &mut HashMap<ScriptHash, (u32, Instant)>, sh: ScriptHash, now: Instant) -> u32 {
    let e = map.entry(sh).or_insert((0, now));
    e.0 += 1;
    let wait = FAILED_FOR
        .saturating_mul(1 << (e.0 - 1).min(16))
        .min(FILL_RETRY_MAX);
    e.1 = now + wait;
    e.0
}

/// What the ledger says of a script, for `/app/address/:address/ledger`.
#[derive(Debug)]
pub enum Status {
    Tracked(book::View),
    Queued(usize),
    Seeding(Duration),
    Refused(Option<ScriptSize>),
    Failed,
    /// Large, but the queue is full or the client holds its share: asked again later.
    Busy,
    /// Not known to be large.
    None,
}

/// One network's ledger: its store, its own node clients, the seed queue and discovery.
pub struct Ledger {
    network: &'static str,
    store: Arc<Store>,
    source: NodeSource,
    config: LedgerConfig,
    lane: Arc<Semaphore>,
    verdicts: Arc<Verdicts>,
    track: Arc<Tracking>,
    tracked: RwLock<HashSet<ScriptHash>>,
    /// The scripts whose whole history the store held at the last reload, and the ledger's tip
    /// height then.
    wholes: Mutex<(HashSet<ScriptHash>, u32)>,
    seeds: Mutex<Seeds>,
    wake: Notify,
}

impl std::fmt::Debug for Ledger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ledger")
            .field("network", &self.network)
            .finish_non_exhaustive()
    }
}

/// The time (Unix seconds) at or after which a stored view keeps a history from being dropped:
/// [`VIEWING`] back, and [`TOUCH_EVERY`] more, since a view is stored at most that often and the
/// last one may be newer than the one stored.
fn viewing_since(now: u64) -> u64 {
    now.saturating_sub(VIEWING.as_secs() + TOUCH_EVERY.as_secs())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl Ledger {
    /// The ledger in the network's store, with node clients of its own: one RPC slot whose
    /// timeout and size fit a full block at verbosity 3, and an Esplora client that waits for a
    /// seed.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: Arc<Store>,
        network: &NetworkConfig,
        url: &str,
        config: LedgerConfig,
        lane: Arc<Semaphore>,
        verdicts: Arc<Verdicts>,
        track: Arc<Tracking>,
    ) -> Option<Self> {
        let rpc = &network.rpc;
        let limits = RpcLimits {
            timeout: Duration::from_secs(120),
            max_concurrent: 1,
            max_response_bytes: 256 << 20,
        };
        Some(Self {
            network: network.network.name(),
            store,
            source: NodeSource {
                rpc: Rpc::with_limits(
                    &rpc.host,
                    rpc.port,
                    &rpc.user,
                    rpc.password.expose(),
                    limits,
                )
                .ok()?,
                esplora: Esplora::with_limits(url, SEED_TIMEOUT, Esplora::DEFAULT_MAX_RESPONSE)
                    .ok()?,
                electrum: network.electrum.clone(),
                uncapped: Default::default(),
            },
            config,
            lane,
            verdicts,
            track,
            tracked: RwLock::default(),
            wholes: Mutex::default(),
            seeds: Mutex::default(),
            wake: Notify::new(),
        })
    }

    /// The script's totals and the block they are exact at, from the store.
    pub async fn totals(&self, sh: ScriptHash) -> Option<book::Tracked> {
        book::tracked(&self.store, sh).await.ok().flatten()
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.store
    }

    /// Asks the node whether its socket adds up totals above its cap (docs/RBITCOIN.md, "Totals of
    /// large addresses"), and logs the answer. Called when the node's connection is first ready
    /// and after every reconnect; over TCP it asks nothing.
    pub async fn detect(&self) {
        if let Some(uncapped) = self.source.detect().await {
            // Seeds the cap refused before the node was upgraded may run at once.
            if uncapped {
                self.seeds()
                    .ended
                    .retain(|_, (e, _)| !matches!(e, Ended::Refused(_)));
            }
            logging::emit(&LedgerTotalsRoute {
                network: self.network,
                uncapped,
            });
        }
    }

    /// Whether seeds add up addresses above the node's cap, as last found.
    fn uncapped(&self) -> bool {
        self.source
            .uncapped
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn is_tracked(&self, sh: ScriptHash) -> bool {
        self.tracked
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&sh)
    }

    fn seeds(&self) -> std::sync::MutexGuard<'_, Seeds> {
        self.seeds.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Reads the tracked set again from the store, and the scripts still to be filled.
    async fn reload(&self) {
        if let Ok(rows) = book::tracked_scripts(&self.store).await {
            *self.tracked.write().unwrap_or_else(PoisonError::into_inner) =
                rows.into_iter().map(|(sh, _)| sh).collect();
        }
        // Both read before either is set: a fill is decided from the lists together.
        let (Ok(unfilled), Ok(unlisted)) = (
            book::unfilled(&self.store).await,
            book::unhistoried(&self.store).await,
        ) else {
            return;
        };
        let now = Instant::now();
        let unix = unix_now();
        // A history dropped for the bound is due a day after it was last taken.
        let unlisted: Vec<(ScriptHash, Instant)> = unlisted
            .into_iter()
            .map(|(sh, h, taken)| {
                let again = match (h, taken) {
                    (book::History::Dropped, Some(t)) => {
                        let at = t.saturating_add(RELIST.as_secs());
                        now + Duration::from_secs(at.saturating_sub(unix))
                    }
                    _ => now,
                };
                (sh, again)
            })
            .collect();
        {
            let mut s = self.seeds();
            s.set_unfilled(&unfilled, now);
            s.set_unhistoried(&unlisted);
        }
        if !unfilled.is_empty() || !unlisted.is_empty() {
            self.wake.notify_one();
        }
        // A history dropped (for the bound, by another's list, a reorg, or with its address when
        // the ledger made room for another) leaves its page paging a history that is gone: its
        // followers hear the address changed, and ask again.
        if let Ok((now, tip)) = book::wholes(&self.store).await {
            let now: HashSet<ScriptHash> = now.into_iter().collect();
            let (left, height) = {
                let mut was = self.wholes.lock().unwrap_or_else(PoisonError::into_inner);
                let left: Vec<ScriptHash> = was.0.difference(&now).copied().collect();
                let height = tip.map_or(was.1, |t| t.height);
                *was = (now, height);
                (left, height)
            };
            for sh in left {
                self.track
                    .ledger_changed(node::electrum::ScriptHash(sh.to_byte_array()), height);
            }
        }
    }

    /// Adopts totals the guard learned from an answer as the script's seed; queues a seed when
    /// the answer's block is not one the ledger holds.
    async fn adopt(&self, script: &Script, totals: book::Totals, hash: bitcoin::BlockHash, h: u32) {
        let sh = ScriptHash::from_script(script);
        let started = Instant::now();
        let r = book::adopt(
            &self.store,
            &self.source,
            script,
            totals,
            hash,
            h,
            self.config.max_addresses,
            unix_now(),
        )
        .await;
        match r {
            Ok(Seeded::Tracked { at, evicted, .. }) => {
                self.reload().await;
                self.seeded(sh, at, false, evicted, started.elapsed(), "answer");
            }
            Ok(_) => {}
            Err(_) => self.queue_found(script.to_owned()),
        }
    }

    fn seeded(
        &self,
        sh: ScriptHash,
        at: At,
        page: bool,
        evicted: usize,
        took: Duration,
        via: &'static str,
    ) {
        {
            let mut s = self.seeds();
            s.refused_said = false;
            s.failures = 0;
            s.ended.remove(&sh);
        }
        logging::emit(&LedgerSeeded {
            network: self.network,
            scripthash: sh.to_string(),
            height: at.height,
            page,
            evicted,
            via,
            duration_ms: ms(took),
        });
        self.track
            .ledger_changed(node::electrum::ScriptHash(sh.to_byte_array()), at.height);
    }

    fn queue_found(&self, script: ScriptBuf) {
        let sh = ScriptHash::from_script(&script);
        let mut s = self.seeds();
        if s.found.len() < QUEUE && !s.found.iter().any(|j| j.sh == sh) {
            s.found.push_back(Job {
                script,
                sh,
                client: None,
                asked: Instant::now(),
            });
            drop(s);
            self.wake.notify_one();
        }
    }

    /// A reader asks about a script: its view when tracked, otherwise where its seed stands. A
    /// script the server knows to be large and that is not queued is queued for this client,
    /// within the bounds.
    pub async fn status(&self, script: &Script, large: bool, client: IpAddr) -> Status {
        let sh = ScriptHash::from_script(script);
        if self.is_tracked(sh)
            && let Ok(Some(view)) = book::view(&self.store, sh).await
        {
            self.touch(sh);
            // Viewed: its whole list is taken (or taken again) if it is not held.
            if matches!(
                view.tracked.history,
                book::History::None | book::History::Refused | book::History::Dropped
            ) {
                self.seeds().want(sh, Instant::now());
                self.wake.notify_one();
            }
            return Status::Tracked(view);
        }
        let (status, queued) = self.seeds().ask(script, large, client, Instant::now());
        if queued {
            self.wake.notify_one();
        }
        status
    }

    /// Records a reader's view in the store, at most once per [`TOUCH_EVERY`] per script.
    fn touch(&self, sh: ScriptHash) {
        let now = Instant::now();
        {
            let mut s = self.seeds();
            if s.touched.get(&sh).is_some_and(|t| now < *t + TOUCH_EVERY) {
                return;
            }
            if s.touched.len() >= REMEMBERED {
                s.touched.clear();
            }
            s.touched.insert(sh, now);
        }
        let store = Arc::clone(&self.store);
        tokio::spawn(async move {
            let _ = book::touch(&store, sh, unix_now()).await;
        });
    }

    /// Scripts a block paid most: candidates for a size check, at most [`QUEUE`] waiting.
    fn consider(&self, guard: &Guard, found: Vec<(ScriptBuf, u32)>) {
        if !self.config.discover {
            return;
        }
        let now = Instant::now();
        let mut s = self.seeds();
        for (script, _) in found {
            let sh = ScriptHash::from_script(&script);
            let checked = s.checked.get(&sh).is_some_and(|t| now < *t + RECHECK);
            if checked
                || guard.known(sh).is_some()
                || s.candidates.len() >= QUEUE
                || s.candidates.contains(&script)
            {
                continue;
            }
            s.candidates.push_back(script);
        }
        drop(s);
        self.wake.notify_one();
    }

    fn next(&self) -> Option<Work> {
        self.seeds().next(Instant::now())
    }

    /// Runs one seed in the lane (already held).
    async fn seed(&self, job: Job) {
        // Its reader may have left while it waited for the lane: the last ask, refreshed meanwhile.
        let asked = self
            .seeds()
            .running
            .filter(|r| r.0 == job.sh)
            .map_or(job.asked, |r| r.3);
        if job.client.is_some() && Instant::now() >= asked + ABANDONED {
            return;
        }
        if self.is_tracked(job.sh) {
            return;
        }
        let started = Instant::now();
        let r = tokio::time::timeout(
            SEED_TIMEOUT,
            book::seed(
                &self.store,
                &self.source,
                &job.script,
                true,
                self.config.max_addresses,
                unix_now(),
            ),
        )
        .await;
        let via = if job.client.is_some() {
            "reader"
        } else {
            "discovery"
        };
        match r {
            Ok(Ok(Seeded::Tracked { at, page, evicted })) => {
                self.reload().await;
                self.seeded(job.sh, at, page, evicted, started.elapsed(), via);
            }
            Ok(Ok(Seeded::Already)) => self.reload().await,
            Ok(Ok(Seeded::Refused(size))) => {
                self.verdicts
                    .learn(job.sh, None, Verdict::TooLarge(size), Instant::now());
                let say = {
                    let mut s = self.seeds();
                    remember(&mut s.ended, job.sh, Ended::Refused(size), REFUSED_FOR);
                    !std::mem::replace(&mut s.refused_said, true)
                };
                if say {
                    logging::emit(&LedgerSeedRefused {
                        network: self.network,
                        creates: size.map(|s| s.creates),
                        cap: size.map(|s| s.cap),
                    });
                }
            }
            // The chain moved under it: queued again, to be tried at once.
            Ok(Err(book::Error::Moved)) => {
                let mut s = self.seeds();
                if s.readers.len() < QUEUE {
                    s.readers.push_front(job);
                }
            }
            Ok(Err(e)) => self.failed(job.sh, e.label(), started.elapsed()),
            Err(_) => self.failed(job.sh, "timeout", started.elapsed()),
        }
    }

    /// Fills one kept script in the lane (already held): the node's page before its seed, once.
    async fn fill(&self, sh: ScriptHash) {
        let started = Instant::now();
        let r = tokio::time::timeout(SEED_TIMEOUT, book::fill(&self.store, &self.source, sh)).await;
        let error = match r {
            Ok(Ok(filled)) => {
                self.seeds().unfilled.remove(&sh);
                let (height, outcome, rows, tip) = match filled {
                    book::Filled::Joined { height, rows, tip } => (height, "joined", rows, tip),
                    book::Filled::Skipped {
                        height,
                        reason,
                        tip,
                    } => (height, reason, 0, tip),
                    book::Filled::Nothing => return,
                };
                // Followers refetch the list, as after a block: it changed, or it is no longer
                // `filling`.
                if let Some(tip) = tip {
                    self.track
                        .ledger_changed(node::electrum::ScriptHash(sh.to_byte_array()), tip.height);
                }
                logging::emit(&LedgerFilled {
                    network: self.network,
                    scripthash: sh.to_string(),
                    height,
                    outcome,
                    rows,
                    duration_ms: ms(started.elapsed()),
                });
                return;
            }
            Ok(Err(e)) => e.label(),
            Err(_) => "timeout",
        };
        let failures = self.seeds().fill_failed(sh, Instant::now());
        if failures.is_power_of_two() {
            logging::emit(&LedgerFillFailed {
                network: self.network,
                scripthash: sh.to_string(),
                error,
                failures,
                duration_ms: ms(started.elapsed()),
            });
        }
    }

    /// Keeps the whole histories within their bound after blocks made them grow: the least
    /// recently viewed leave first. How many were dropped.
    async fn bound(&self) -> usize {
        let viewing = viewing_since(unix_now());
        let dropped = book::bound(&self.store, self.config.max_history_rows, viewing)
            .await
            .unwrap_or(0);
        if dropped > 0 {
            logging::emit(&LedgerHistoryBound {
                network: self.network,
                dropped,
            });
        }
        dropped
    }

    /// Takes one kept script's whole history in the lane (already held), once.
    async fn history(&self, sh: ScriptHash) {
        let started = Instant::now();
        let now = unix_now();
        let r = book::history(
            &self.store,
            &self.source,
            sh,
            self.config.max_history_rows,
            viewing_since(now),
            now,
        )
        .await;
        let took = started.elapsed();
        let (outcome, height, rows, evicted) = match r {
            Ok(book::Historied::Whole {
                height,
                rows,
                evicted,
            }) => {
                self.seeds().unhistoried.remove(&sh);
                ("whole", height, rows, evicted)
            }
            Ok(book::Historied::Refused(_)) => {
                let mut s = self.seeds();
                let e = s.unhistoried.entry(sh).or_insert((0, started));
                e.1 = Instant::now() + HISTORY_REFUSED_FOR;
                // No list will come while the node's cap is in force: the page may be taken.
                e.0 = e.0.max(LIST_TRIES);
                ("refused", 0, 0, 0)
            }
            Ok(book::Historied::TooLarge) => {
                self.seeds().unhistoried.remove(&sh);
                ("too_large", 0, 0, 0)
            }
            // The room is held by histories readers are viewing: tried again later.
            Ok(book::Historied::NoRoom) => {
                backoff(&mut self.seeds().unhistoried, sh, Instant::now());
                ("no_room", 0, 0, 0)
            }
            Ok(book::Historied::Nothing) => {
                self.seeds().unhistoried.remove(&sh);
                return;
            }
            Err(e) => {
                let failures = backoff(&mut self.seeds().unhistoried, sh, Instant::now());
                // Histories it dropped to make room may now take the newest page; its own wait
                // is kept.
                self.reload().await;
                if failures.is_power_of_two() {
                    logging::emit(&LedgerHistoryFailed {
                        network: self.network,
                        scripthash: sh.to_string(),
                        error: e.label(),
                        failures,
                        duration_ms: ms(took),
                    });
                }
                return;
            }
        };
        logging::emit(&LedgerHistory {
            network: self.network,
            scripthash: sh.to_string(),
            outcome,
            height,
            rows,
            evicted,
            duration_ms: ms(took),
        });
        // A refused or dropped history leaves the newest page to a fill; followers hear the
        // address changed.
        self.reload().await;
        if let Some(t) = self.totals(sh).await {
            self.track
                .ledger_changed(node::electrum::ScriptHash(sh.to_byte_array()), t.at.height);
        }
    }

    fn failed(&self, sh: ScriptHash, error: &'static str, took: Duration) {
        let failures = {
            let mut s = self.seeds();
            remember(&mut s.ended, sh, Ended::Failed, FAILED_FOR);
            s.failures += 1;
            s.failures
        };
        if failures.is_power_of_two() {
            logging::emit(&LedgerSeedFailed {
                network: self.network,
                error,
                failures,
                duration_ms: ms(took),
            });
        }
    }
}

fn remember(
    map: &mut HashMap<ScriptHash, (Ended, Instant)>,
    sh: ScriptHash,
    e: Ended,
    d: Duration,
) {
    let now = Instant::now();
    if map.len() >= REMEMBERED {
        map.retain(|_, (_, until)| *until > now);
        if map.len() >= REMEMBERED {
            map.clear();
        }
    }
    map.insert(sh, (e, now + d));
}

enum Work {
    Seed(Job),
    Fill(ScriptHash),
    History(ScriptHash),
    Check(ScriptBuf),
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Starts the ledger's tasks for a network: following blocks, and the seed runner.
pub fn spawn(ctx: &Arc<NetworkContext>) {
    if ctx.guard.ledger.is_none() {
        return;
    }
    tokio::spawn(follow(Arc::clone(ctx)));
    tokio::spawn(run(Arc::clone(ctx)));
}

/// Takes seeds and checks from the queue, one at a time in the lane.
async fn run(ctx: Arc<NetworkContext>) {
    let Some(ledger) = ctx.guard.ledger.clone() else {
        return;
    };
    loop {
        let Some(work) = ledger.next() else {
            tokio::select! {
                () = ledger.wake.notified() => {}
                () = tokio::time::sleep(Duration::from_secs(60)) => {}
            }
            continue;
        };
        match work {
            Work::Seed(job) => {
                let Ok(_lane) = Arc::clone(&ledger.lane).acquire_owned().await else {
                    return;
                };
                ledger.seed(job).await;
                ledger.seeds().running = None;
            }
            Work::Fill(sh) => {
                let Ok(_lane) = Arc::clone(&ledger.lane).acquire_owned().await else {
                    return;
                };
                ledger.fill(sh).await;
            }
            Work::History(sh) => {
                let Ok(_lane) = Arc::clone(&ledger.lane).acquire_owned().await else {
                    return;
                };
                ledger.history(sh).await;
            }
            Work::Check(script) => {
                let started = Instant::now();
                // Waits for the lane itself.
                let size = ctx.guard.check(&script, SEED_TIMEOUT).await;
                logging::emit(&LedgerChecked {
                    network: ledger.network,
                    scripthash: ScriptHash::from_script(&script).to_string(),
                    size: match size {
                        Some(Size::Small) => "small",
                        Some(Size::Large) => "large",
                        Some(Size::TooLarge) => "too_large",
                        None => "unknown",
                    },
                    duration_ms: ms(started.elapsed()),
                });
                // Above the node's cap: added up through its socket when it can, else shown
                // as refused for a while.
                if size == Some(Size::TooLarge) && ledger.uncapped() {
                    ledger.queue_found(script);
                } else if size == Some(Size::TooLarge) {
                    remember(
                        &mut ledger.seeds().ended,
                        ScriptHash::from_script(&script),
                        Ended::Refused(None),
                        REFUSED_FOR,
                    );
                }
            }
        }
    }
}

/// Follows each new tip: undoes and applies blocks for the tracked scripts, tells the followers
/// of a changed script, and hands the scripts each block paid most to discovery. With nothing
/// tracked and discovery on, it reads the new tip's block for discovery alone; with discovery
/// off, it asks the node nothing.
async fn follow(ctx: Arc<NetworkContext>) {
    let Some(ledger) = ctx.guard.ledger.clone() else {
        return;
    };
    // A history being taken when the server stopped is taken again from the start, and the
    // bound may have been lowered since.
    let _ = book::history_restarted(&ledger.store).await;
    ledger.bound().await;
    ledger.reload().await;
    let mut tips = ctx.summaries.tips();
    let mut failures = 0u32;
    let mut seen_tip: Option<u32> = None;
    loop {
        let started = Instant::now();
        let mut found: Vec<(ScriptBuf, u32)> = Vec::new();
        let r = book::follow_seeing(&ledger.store, &ledger.source, |b| {
            if ledger.config.discover {
                found.extend(book::paid_most(b, PER_BLOCK));
            }
        })
        .await;
        let mut retry = false;
        match r {
            Ok(f) => {
                if failures > 0 {
                    failures = 0;
                }
                let bounded = ledger.bound().await;
                if f.dropped > 0 || f.reset || f.undone > 0 || bounded > 0 {
                    ledger.reload().await;
                }
                if let Some(tip) = f.tip {
                    for sh in &f.changed {
                        ctx.track.ledger_changed(
                            node::electrum::ScriptHash(sh.to_byte_array()),
                            tip.height,
                        );
                    }
                    seen_tip = Some(tip.height);
                } else if ledger.config.discover
                    && let Ok(h) = ledger.source.height().await
                    && seen_tip != Some(h)
                    && let Ok(Some(at)) = ledger.source.at(h).await
                    && let Ok(block) = ledger.source.block(at.hash).await
                {
                    seen_tip = Some(h);
                    found.extend(book::paid_most(&block, PER_BLOCK));
                }
                if f.applied > 0 || f.undone > 0 {
                    logging::emit(&LedgerFollowed {
                        network: ledger.network,
                        tip: f.tip.map(|t| t.height),
                        applied: f.applied,
                        undone: f.undone,
                        dropped: f.dropped,
                        reset: f.reset,
                        changed: f.changed.len(),
                        duration_ms: ms(started.elapsed()),
                    });
                }
            }
            Err(book::Error::Moved) => {
                retry = true;
                if ledger.bound().await > 0 {
                    ledger.reload().await;
                }
            }
            Err(e) => {
                // Blocks applied before the failure count too.
                if ledger.bound().await > 0 {
                    ledger.reload().await;
                }
                failures += 1;
                retry = true;
                if failures.is_power_of_two() {
                    logging::emit(&LedgerFollowFailed {
                        network: ledger.network,
                        error: e.label(),
                        failures,
                    });
                }
            }
        }
        ledger.consider(&ctx.guard, found);
        let pause = if retry {
            Duration::from_secs(5)
                .saturating_mul(1 << failures.min(6))
                .min(Duration::from_secs(300))
        } else {
            Duration::from_secs(3600)
        };
        tokio::select! {
            changed = tips.changed() => if changed.is_err() { return },
            () = tokio::time::sleep(pause) => {}
        }
    }
}

/// The gate before following an address on a WebSocket: the node is asked to watch a script
/// only once it is known to be small, since watching makes it join the script's whole history.
impl crate::ws::track::AddressGate for Guard {
    fn decide(
        &self,
        sh: node::electrum::ScriptHash,
    ) -> Pin<Box<dyn Future<Output = crate::ws::track::Decision> + Send + '_>> {
        use crate::ws::track::Decision;
        let sh = ScriptHash::from_byte_array(sh.0);
        Box::pin(async move {
            if let Some(ledger) = &self.ledger
                && ledger.is_tracked(sh)
                && let Ok(Some(t)) = book::tracked(&ledger.store, sh).await
            {
                return Decision::Ledger(t.at.height);
            }
            match self.known(sh) {
                Some(Size::Small) => return Decision::Watch,
                Some(Size::Large | Size::TooLarge) => return Decision::TooLarge,
                None => {}
            }
            let route = Route::ScriptStats {
                script: ScriptRef::ScriptHash(sh),
                asof: None,
            };
            match self.ask(&route, sh, None, None).await {
                Err(Error::Unavailable(m)) if m == LANE_BUSY => Decision::Later,
                _ => match self.known(sh) {
                    Some(Size::Small) => Decision::Watch,
                    Some(Size::Large | Size::TooLarge) => Decision::TooLarge,
                    None => Decision::Later,
                },
            }
        })
    }
}

/// `GET /app/address/:address/ledger` (docs/API.md, "What the page shows of such an address").
/// Read from the store and memory; queues a seed for an address the server knows to be large.
pub async fn route(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<Client>,
    Path(address): Path<String>,
) -> Result<Response, ApiError> {
    let address = crate::esplora::address(&address, ctx.config.network)?;
    let script = address.script_pubkey();
    let sh = ScriptHash::from_script(&script);
    let Some(ledger) = &ctx.guard.ledger else {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "this server keeps no ledger",
        ));
    };
    let large = matches!(ctx.guard.known(sh), Some(Size::Large | Size::TooLarge));
    let body = match ledger.status(&script, large, client.addr).await {
        Status::Tracked(v) => tracked_json(&v),
        Status::Queued(position) => json!({ "state": "queued", "position": position }),
        Status::Seeding(d) => json!({ "state": "seeding", "seconds": d.as_secs() }),
        Status::Refused(size) => json!({
            "state": "refused",
            "creates": size.map(|s| s.creates),
            "cap": size.map(|s| s.cap),
        }),
        Status::Failed => json!({ "state": "failed" }),
        Status::Busy => json!({ "state": "busy" }),
        Status::None => json!({ "state": "none" }),
    };
    let mut res = (StatusCode::OK, Json(body)).into_response();
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

fn tracked_json(v: &book::View) -> Value {
    let t = &v.tracked;
    json!({
        "state": "tracked",
        "chain_stats": stats_json(&t.totals),
        "balance": t.totals.balance(),
        "at": { "height": t.at.height, "hash": t.at.hash.to_string(), "time": t.at.time },
        "seeded": { "height": t.seeded_height, "time": t.seeded_time },
        "window": book::WINDOW,
        // A whole history holds the transactions from before `seeded`: nothing is to come.
        "filling": !t.filled && !matches!(t.history, book::History::Whole { .. }),
        "history": match t.history {
            book::History::None => "none",
            book::History::Taking => "taking",
            book::History::Whole { .. } => "whole",
            book::History::Refused => "refused",
            book::History::Dropped => "dropped",
            book::History::TooLarge => "too_large",
        },
        // A history dropped for the bound is taken again once a reader views it, but not before
        // this (Unix seconds); `null` once it may be.
        "history_again": match (t.history, t.history_taken) {
            (book::History::Dropped, Some(taken)) => {
                let at = taken.saturating_add(RELIST.as_secs());
                (at > unix_now()).then_some(at)
            }
            _ => None,
        },
        "txs": v.txs.iter().map(|r| json!({
            "txid": r.txid.to_string(),
            "height": r.height,
            "position": r.position,
            "value": r.value,
            "time": r.time,
        })).collect::<Vec<_>>(),
        "points": v.points.iter().map(|p| json!({
            "height": p.height, "time": p.time, "balance": p.balance,
        })).collect::<Vec<_>>(),
    })
}

fn stats_json(t: &book::Totals) -> Value {
    json!({
        "funded_txo_count": t.funded_count,
        "funded_txo_sum": t.funded_sum,
        "spent_txo_count": t.spent_count,
        "spent_txo_sum": t.spent_sum,
        "tx_count": t.tx_count,
    })
}

/// `/api/address/:a` (or `/scripthash/:h`) of a tracked script, in the node's shape: confirmed
/// totals from the ledger, exact at its tip (the chain-tip headers name it), and the unconfirmed
/// ones counted from the node's mempool rows for the script, at most 50. With 50 rows there may
/// be more: `X-Mempool-Stats-Partial: true`.
pub fn tracked_answer(
    script_ref: &ScriptRef,
    tracked: &book::Tracked,
    mempool: Option<&[node::esplora::model::Tx]>,
) -> Response {
    let mut m = book::Totals::default();
    let mut partial = true;
    if let Some(txs) = mempool {
        let hex = tracked.script.to_hex_string();
        partial = txs.len() >= 50;
        for tx in txs {
            let mut touched = false;
            for p in tx.vin.iter().filter_map(|i| i.prevout.as_ref()) {
                if p.scriptpubkey == hex {
                    m.spent_count += 1;
                    m.spent_sum += p.value;
                    touched = true;
                }
            }
            for o in &tx.vout {
                if o.scriptpubkey == hex {
                    m.funded_count += 1;
                    m.funded_sum += o.value;
                    touched = true;
                }
            }
            m.tx_count += u64::from(touched);
        }
    }
    let (key, name) = match script_ref {
        ScriptRef::Address(a) => ("address", a.to_string()),
        ScriptRef::ScriptHash(h) => ("scripthash", h.to_string()),
    };
    let body = json!({
        key: name,
        "chain_stats": stats_json(&tracked.totals),
        "mempool_stats": stats_json(&m),
    });
    let mut res = Response::new(Body::from(body.to_string()));
    let h = res.headers_mut();
    h.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(v) = HeaderValue::from_str(&tracked.at.hash.to_string()) {
        h.insert("x-bitcoin-chain-tip", v);
    }
    h.insert(
        "x-bitcoin-chain-tip-height",
        HeaderValue::from(tracked.at.height),
    );
    if partial {
        h.insert("x-mempool-stats-partial", HeaderValue::from_static("true"));
    }
    res
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    fn script(i: u32) -> ScriptBuf {
        let mut b = vec![0x00, 0x14];
        b.extend(i.to_le_bytes());
        b.extend([0u8; 16]);
        ScriptBuf::from_bytes(b)
    }

    fn client(i: u8) -> IpAddr {
        IpAddr::from([192, 0, 2, i])
    }

    #[test]
    fn the_readers_queue_is_bounded_overall_and_per_client() {
        let mut s = Seeds::default();
        let now = Instant::now();
        // One client holds two places at most.
        assert!(matches!(
            s.ask(&script(0), true, client(1), now),
            (Status::Queued(1), true)
        ));
        assert!(matches!(
            s.ask(&script(1), true, client(1), now),
            (Status::Queued(2), true)
        ));
        assert!(matches!(
            s.ask(&script(2), true, client(1), now),
            (Status::Busy, false)
        ));
        // Asking again keeps its place, and costs nothing.
        assert!(matches!(
            s.ask(&script(0), true, client(1), now),
            (Status::Queued(1), false)
        ));
        // Others fill the queue to its bound.
        for i in 2..QUEUE {
            let i = u32::try_from(i).unwrap();
            let c = client(u8::try_from(i).unwrap());
            assert!(matches!(
                s.ask(&script(i), true, c, now),
                (Status::Queued(_), true)
            ));
        }
        assert_eq!(s.readers.len(), QUEUE);
        assert!(matches!(
            s.ask(&script(99), true, client(200), now),
            (Status::Busy, false)
        ));
        // A script not known to be large is never queued.
        assert!(matches!(
            s.ask(&script(98), false, client(201), now),
            (Status::None, false)
        ));
    }

    #[test]
    fn a_seed_whose_reader_stopped_asking_is_dropped_before_it_starts() {
        let mut s = Seeds::default();
        let now = Instant::now();
        s.ask(&script(0), true, client(1), now);
        s.ask(&script(1), true, client(2), now);
        s.found.push_back(Job {
            script: script(2),
            sh: ScriptHash::from_script(&script(2)),
            client: None,
            asked: now,
        });
        // Script 1's reader keeps asking; script 0's stopped.
        let later = now + ABANDONED - Duration::from_secs(1);
        s.ask(&script(1), true, client(2), later);
        let Some(Work::Seed(j)) = s.next(now + ABANDONED) else {
            panic!("a seed");
        };
        assert_eq!(j.script, script(1));
        // Discovery's comes after every reader's, and is never abandoned.
        let Some(Work::Seed(j)) = s.next(now + ABANDONED * 10) else {
            panic!("a seed");
        };
        assert_eq!((j.script, j.client), (script(2), None));
        assert!(s.next(now + ABANDONED * 10).is_none());
    }

    #[test]
    fn a_discovered_seed_asked_for_by_a_reader_moves_ahead() {
        let mut s = Seeds::default();
        let now = Instant::now();
        s.ask(&script(0), true, client(1), now);
        s.found.push_back(Job {
            script: script(5),
            sh: ScriptHash::from_script(&script(5)),
            client: None,
            asked: now,
        });
        assert!(matches!(
            s.ask(&script(5), true, client(2), now),
            (Status::Queued(2), true)
        ));
        assert!(s.found.is_empty());
    }

    #[test]
    fn a_discovered_seed_is_not_moved_past_a_clients_share() {
        let mut s = Seeds::default();
        let now = Instant::now();
        s.ask(&script(0), true, client(1), now);
        s.ask(&script(1), true, client(1), now);
        s.found.push_back(Job {
            script: script(5),
            sh: ScriptHash::from_script(&script(5)),
            client: None,
            asked: now,
        });
        assert!(matches!(
            s.ask(&script(5), true, client(1), now),
            (Status::Queued(3), false)
        ));
        assert_eq!(s.found.len(), 1);
        // The running seed counts too.
        let mut s = Seeds::default();
        s.ask(&script(0), true, client(1), now);
        assert!(matches!(s.next(now), Some(Work::Seed(_))));
        s.ask(&script(1), true, client(1), now);
        assert!(matches!(
            s.ask(&script(2), true, client(1), now),
            (Status::Busy, false)
        ));
    }

    #[test]
    fn a_seed_waiting_for_the_lane_keeps_its_readers_asks() {
        let mut s = Seeds::default();
        let now = Instant::now();
        s.ask(&script(0), true, client(1), now);
        assert!(matches!(s.next(now), Some(Work::Seed(_))));
        // Its reader asks while it waits for the lane; the last ask is what counts.
        let later = now + ABANDONED;
        assert!(matches!(
            s.ask(&script(0), true, client(1), later),
            (Status::Seeding(_), false)
        ));
        assert_eq!(s.running.map(|r| r.3), Some(later));
    }

    #[test]
    fn discovery_checks_at_most_its_hourly_budget() {
        let mut s = Seeds::default();
        let now = Instant::now();
        for i in 0..CHECKS_PER_HOUR + 3 {
            s.candidates.push_back(script(u32::try_from(i).unwrap()));
        }
        for _ in 0..CHECKS_PER_HOUR {
            assert!(matches!(s.next(now), Some(Work::Check(_))));
        }
        assert!(s.next(now + Duration::from_secs(3599)).is_none());
        assert!(matches!(
            s.next(now + Duration::from_secs(3600)),
            Some(Work::Check(_))
        ));
    }

    #[test]
    fn a_refused_seed_is_shown_for_a_while_then_asked_again() {
        let mut s = Seeds::default();
        let now = Instant::now();
        let sh = ScriptHash::from_script(&script(0));
        let size = ScriptSize {
            creates: 20_000,
            cap: 10_000,
        };
        s.ended
            .insert(sh, (Ended::Refused(Some(size)), now + REFUSED_FOR));
        assert!(matches!(
            s.ask(&script(0), true, client(1), now),
            (Status::Refused(Some(_)), false)
        ));
        assert!(matches!(
            s.ask(&script(0), true, client(1), now + REFUSED_FOR),
            (Status::Queued(1), true)
        ));
    }

    #[test]
    fn fills_run_after_the_readers_seeds_and_before_discoverys() {
        let mut s = Seeds::default();
        let now = Instant::now();
        let filled = ScriptHash::from_script(&script(7));
        s.set_unfilled(&[filled], now);
        s.found.push_back(Job {
            script: script(5),
            sh: ScriptHash::from_script(&script(5)),
            client: None,
            asked: now,
        });
        s.candidates.push_back(script(6));
        s.ask(&script(0), true, client(1), now);
        assert!(matches!(s.next(now), Some(Work::Seed(j)) if j.client.is_some()));
        s.running = None;
        assert!(matches!(s.next(now), Some(Work::Fill(sh)) if sh == filled));
        // Done: the store no longer lists it, and it is never offered again.
        s.unfilled.remove(&filled);
        s.set_unfilled(&[], now);
        assert!(matches!(s.next(now), Some(Work::Seed(j)) if j.client.is_none()));
        s.running = None;
        assert!(matches!(s.next(now), Some(Work::Check(_))));
        assert!(s.next(now).is_none());
    }

    #[test]
    fn a_failed_fill_waits_longer_each_time_and_keeps_its_count_across_reloads() {
        let mut s = Seeds::default();
        let now = Instant::now();
        let sh = ScriptHash::from_script(&script(7));
        s.set_unfilled(&[sh], now);
        assert!(matches!(s.next(now), Some(Work::Fill(_))));
        assert_eq!(s.fill_failed(sh, now), 1);
        // Not offered again while it waits, however often the loop asks.
        assert!(s.next(now + FAILED_FOR - Duration::from_secs(1)).is_none());
        // A reload from the store keeps the wait.
        s.set_unfilled(&[sh], now);
        assert!(s.next(now).is_none());
        let later = now + FAILED_FOR;
        assert!(matches!(s.next(later), Some(Work::Fill(_))));
        assert_eq!(s.fill_failed(sh, later), 2);
        assert!(s.next(later + FAILED_FOR).is_none());
        assert!(matches!(
            s.next(later + FAILED_FOR * 2),
            Some(Work::Fill(_))
        ));
        // The wait stops doubling at a day.
        for _ in 0..30 {
            s.fill_failed(sh, later);
        }
        assert!(matches!(
            s.next(later + FILL_RETRY_MAX),
            Some(Work::Fill(_))
        ));
    }

    #[test]
    fn whole_histories_run_after_fills_and_before_discoverys_and_back_off() {
        let mut s = Seeds::default();
        let now = Instant::now();
        let (filled, whole) = (
            ScriptHash::from_script(&script(7)),
            ScriptHash::from_script(&script(8)),
        );
        s.set_unfilled(&[filled], now);
        s.set_unhistoried(&[(whole, now)]);
        s.want(whole, now);
        s.found.push_back(Job {
            script: script(5),
            sh: ScriptHash::from_script(&script(5)),
            client: None,
            asked: now,
        });
        s.ask(&script(0), true, client(1), now);
        assert!(matches!(s.next(now), Some(Work::Seed(j)) if j.client.is_some()));
        s.running = None;
        assert!(matches!(s.next(now), Some(Work::Fill(sh)) if sh == filled));
        s.set_unfilled(&[], now);
        assert!(matches!(s.next(now), Some(Work::History(sh)) if sh == whole));
        // It failed: discovery's seed goes first, and the history waits, longer each time,
        // even across a reload from the store.
        assert_eq!(backoff(&mut s.unhistoried, whole, now), 1);
        s.set_unhistoried(&[(whole, now)]);
        assert!(matches!(s.next(now), Some(Work::Seed(j)) if j.client.is_none()));
        s.running = None;
        assert!(s.next(now + FAILED_FOR - Duration::from_secs(1)).is_none());
        let later = now + FAILED_FOR;
        assert!(matches!(s.next(later), Some(Work::History(_))));
        assert_eq!(backoff(&mut s.unhistoried, whole, later), 2);
        assert!(s.next(later + FAILED_FOR).is_none());
        // Taken: the store no longer lists it, and it is never offered again.
        s.set_unhistoried(&[]);
        assert!(s.next(later + FILL_RETRY_MAX).is_none());
    }

    #[test]
    fn a_fill_waits_for_the_whole_list_until_it_has_failed_twice() {
        let mut s = Seeds::default();
        let now = Instant::now();
        let sh = ScriptHash::from_script(&script(9));
        s.set_unfilled(&[sh], now);
        s.set_unhistoried(&[(sh, now)]);
        s.want(sh, now);
        // The list goes first; the page waits for it.
        assert!(matches!(s.next(now), Some(Work::History(_))));
        assert_eq!(backoff(&mut s.unhistoried, sh, now), 1);
        assert!(s.next(now).is_none());
        let later = now + FAILED_FOR;
        assert!(matches!(s.next(later), Some(Work::History(_))));
        assert_eq!(backoff(&mut s.unhistoried, sh, later), 2);
        // Failed twice: the page is taken meanwhile.
        assert!(matches!(s.next(later), Some(Work::Fill(f)) if f == sh));
    }

    #[test]
    fn only_a_viewed_address_takes_its_list_and_a_dropped_one_waits_its_day() {
        let mut s = Seeds::default();
        let now = Instant::now();
        let (found, viewed) = (
            ScriptHash::from_script(&script(10)),
            ScriptHash::from_script(&script(11)),
        );
        s.set_unfilled(&[found], now);
        s.set_unhistoried(&[(found, now), (viewed, now + RELIST)]);
        // Nobody viewed the discovered one: no list, and its page fill goes ahead at once.
        assert!(matches!(s.next(now), Some(Work::Fill(f)) if f == found));
        s.set_unfilled(&[], now);
        assert!(s.next(now).is_none());
        // A dropped one viewed now still waits for its day.
        s.want(viewed, now);
        assert!(s.next(now).is_none());
        // Viewed again then, it is taken again.
        let later = now + RELIST;
        s.want(viewed, later);
        assert!(matches!(s.next(later), Some(Work::History(h)) if h == viewed));
        // A view an hour old no longer asks for a list.
        assert!(s.next(later + WANTED_FOR).is_none());
    }

    #[test]
    fn a_viewed_address_whose_list_waits_its_day_takes_the_page_meanwhile() {
        let mut s = Seeds::default();
        let now = Instant::now();
        let sh = ScriptHash::from_script(&script(12));
        s.set_unfilled(&[sh], now);
        s.set_unhistoried(&[(sh, now + RELIST)]);
        s.want(sh, now);
        assert!(matches!(s.next(now), Some(Work::Fill(f)) if f == sh));
    }

    #[test]
    fn a_view_the_store_did_not_record_still_protects_for_the_whole_window() {
        // Stored at t0; viewed again just before the next write was allowed, so not stored.
        let t0 = 1_800_000_000;
        let last = t0 + TOUCH_EVERY.as_secs() - 1;
        // Until VIEWING after that last view, the stored t0 is still within the protection.
        assert!(viewing_since(last + VIEWING.as_secs()) <= t0);
        // And not much longer.
        assert!(viewing_since(t0 + VIEWING.as_secs() + TOUCH_EVERY.as_secs() + 1) > t0);
    }
}
