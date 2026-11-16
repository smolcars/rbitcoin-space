//! Fee recommendations for one network: a task that keeps them current from the projected blocks
//! (`engine::fees`), falls back to the node's own estimates while it cannot, publishes the `fees`
//! topic and holds the answers the `/api/v1/fees/*` routes serve. The method is
//! `docs/MEMPOOL.md` "Fee recommendations"; the routes `docs/API.md`; the topic `docs/WS.md`.
//!
//! No request and no subscription causes a node call: the only upstream work is the node's
//! estimates, fetched by this task every `NODE_EVERY` while they are what we serve.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use engine::fees::{self, LEVELS, Rates, Recommender};
use engine::mempool::{Mempool, Tracker};
use engine::projected::{Projection, Projector};
use logging::events::{FeesFallbackEnded, FeesFallbackStarted, FeesSummary};
use node::esplora::ChainTip;
use serde_json::{Value, json};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::watch;
use tokio::time::Instant;

use super::{Frame, Snapshot, Topic};
use crate::NetworkContext;

pub(crate) mod score;

/// How often the node's estimates are asked for while they are served.
const NODE_EVERY: Duration = Duration::from_secs(30);
/// The longest the task waits on the node for its estimates; arrivals queue meanwhile.
const NODE_WAIT: Duration = Duration::from_secs(5);
/// Node estimates older than this are not served: nothing is better than an old answer.
const NODE_MAX_AGE: Duration = Duration::from_secs(90);
/// The node's estimates are fetched only while fees were asked for this recently, or the topic
/// has a subscriber: nobody asking means no node call.
const WANTED_FOR: u64 = 600;
/// How often a `fees_summary` line is written.
const SUMMARY_EVERY: Duration = Duration::from_secs(60);

/// Where an answer came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// Our own, from the projected blocks.
    Projected,
    /// The node's `/fee-estimates`, while ours cannot be trusted.
    Node,
}

impl Source {
    pub fn name(self) -> &'static str {
        match self {
            Self::Projected => "projected",
            Self::Node => "node",
        }
    }
}

/// The recommendation being served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub rates: Rates,
    pub source: Source,
    /// The tip the projection was made on; `None` for the node's estimates, which carry none.
    pub tip: Option<ChainTip>,
    /// When it was computed, or when the node answered.
    pub at: SystemTime,
}

/// One projected block as `/api/v1/fees/mempool-blocks` reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct MempoolBlock {
    /// Serialized bytes, witness included.
    pub size: u64,
    pub vsize: u64,
    pub txs: u32,
    pub fees: u64,
    /// Sat per 1,000 vB.
    pub median: u32,
    pub range: Vec<u32>,
}

/// The projected blocks as of one projection.
#[derive(Debug, Clone)]
pub struct Blocks {
    pub blocks: Arc<[MempoolBlock]>,
    pub tip: Option<ChainTip>,
    pub stale: bool,
    pub at: SystemTime,
}

/// What the routes read. Written only by [`run`].
#[derive(Debug, Default)]
pub struct Fees {
    answer: Mutex<Option<Answer>>,
    /// Watched by the compatible socket, which sends them when they change.
    blocks: watch::Sender<Option<Blocks>>,
    /// Unix seconds of the last request for a recommendation.
    wanted: AtomicU64,
    /// How the answers fared: `score`.
    pub(crate) score: score::Scores,
}

impl Fees {
    /// A client asked for a recommendation: keep the node's estimates coming while ours cannot
    /// be served.
    pub fn want(&self) {
        self.wanted
            .store(unix(SystemTime::now()), Ordering::Relaxed);
    }

    fn wanted(&self, now: u64) -> bool {
        now.saturating_sub(self.wanted.load(Ordering::Relaxed)) < WANTED_FOR
    }

    /// The answer to serve now. The node's estimates expire here too, not only at the task's
    /// next tick.
    pub fn current(&self) -> Option<Answer> {
        self.answer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .filter(|a| {
                a.source == Source::Projected || a.at.elapsed().is_ok_and(|age| age < NODE_MAX_AGE)
            })
    }

    pub fn blocks(&self) -> Option<Blocks> {
        self.blocks.borrow().clone()
    }

    /// Changes to [`Fees::blocks`].
    pub fn blocks_changed(&self) -> watch::Receiver<Option<Blocks>> {
        self.blocks.subscribe()
    }

    fn set(&self, a: Option<Answer>) {
        *self.answer.lock().unwrap_or_else(PoisonError::into_inner) = a;
    }

    fn set_blocks(&self, b: Blocks) {
        self.blocks.send_replace(Some(b));
    }
}

fn unix(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Sat per 1,000 vB from the node's BTC per 1,000 vB.
fn floor_of(fee: bitcoin::Amount) -> u32 {
    u32::try_from(fee.to_sat()).unwrap_or(u32::MAX)
}

/// The network's running engines, when its mempool engine is on.
#[derive(Clone)]
pub(crate) struct Engines {
    pub tracker: Tracker,
    pub projector: Projector,
}

/// Keeps the network's recommendations current until shutdown: once per `WS_MEMPOOL_INTERVAL_MS`,
/// and at once when the projection moves to a new tip, it recomputes ours from the latest
/// projection, or falls back to the node's estimates, stores the answer for the routes and
/// publishes the topic when it changed.
pub(crate) async fn run(ctx: Arc<NetworkContext>, engines: Option<Engines>, mut rec: Recommender) {
    let network = ctx.config.network.name();
    let interval = ctx.sockets.limits.mempool_interval;
    let mut tick = tokio::time::interval(interval);
    let mut summary = tokio::time::interval_at(Instant::now() + SUMMARY_EVERY, SUMMARY_EVERY);
    // The tracker's change stream, for arrivals. Its first delta is the whole mempool when the
    // tracker had not synced yet: not arrivals.
    let mut arrivals = engines.as_ref().map(|e| e.tracker.subscribe(Mempool::tip));
    let mut node: Option<(Instant, Rates)> = None;
    // When the node was last asked, answered or not: at most once per `NODE_EVERY`.
    let mut asked: Option<Instant> = None;
    let mut fallback: Option<(Instant, &'static str)> = None;
    let mut published: Option<Value> = None;
    let mut blocks_seq = None;
    let mut messages = 0u64;
    // The projection's changes, so one on a new tip is served at once, with the block.
    let mut projected = engines.as_ref().map(|e| e.projector.subscribe().1);
    let mut projected_tip = None;
    let mut held = None;
    // A block announced after the projection reached it releases ours at once.
    let mut announced = ctx.hub.announced();
    loop {
        // One held for its block goes out when the hold ends, whatever the interval.
        let release = held.map(|h: Instant| h + super::mempool::HOLD);
        tokio::select! {
            r = announced.changed() => if r.is_err() {
                return;
            } else if held.is_some() {
                tick.reset_immediately();
            },
            d = async {
                match &mut projected {
                    Some(sub) => sub.recv().await,
                    None => std::future::pending().await,
                }
            } => match (d, &engines) {
                (Ok(d), _) => {
                    if d.tip != projected_tip {
                        projected_tip = d.tip;
                        tick.reset_immediately();
                    }
                }
                (Err(RecvError::Lagged(_)), Some(e)) => {
                    projected = Some(e.projector.subscribe().1);
                    tick.reset_immediately();
                }
                _ => return,
            },
            d = async {
                match &mut arrivals {
                    Some((_, sub)) => sub.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                let now = unix(SystemTime::now());
                match (d, &mut arrivals, &engines) {
                    (Ok(d), Some((synced, _)), _) => {
                        if synced.is_none() {
                            *synced = Some(d.tip);
                            continue;
                        }
                        for (_, i) in &d.added {
                            rec.arrived(now, i.fee.to_sat(), i.vsize);
                        }
                    }
                    (Err(RecvError::Lagged(_)), Some(_), Some(e)) => {
                        rec.gap(now);
                        arrivals = Some(e.tracker.subscribe(Mempool::tip));
                    }
                    _ => return,
                }
            }
            // The hold's deadline runs the tick's work itself: a wake-up that only reset the
            // interval stayed due, and fired again on every pass until the tick won.
            () = async {
                match release {
                    Some(at) => tokio::select! {
                        _ = tick.tick() => {}
                        () = tokio::time::sleep_until(at) => {}
                    },
                    None => drop(tick.tick().await),
                }
            } => {
                let now = SystemTime::now();
                let (own, reason, limit) = match &engines {
                    Some(e) => {
                        let p = e.projector.current();
                        let floor = e.tracker.node_info().map(|i| floor_of(i.mempoolminfee));
                        if blocks_seq != Some(p.seq) && p.tip.is_some() {
                            blocks_seq = Some(p.seq);
                            ctx.fees.set_blocks(mempool_blocks(&p, &e.tracker, now));
                        }
                        // The day-long level no lower than the last day's blocks took (`fees::score::day_floor`).
                        let own = floor
                            .and_then(|f| rec.update(unix(now), &p, f))
                            .map(|r| r.no_rush_at_least(ctx.fees.score.day_floor()));
                        // Before the first projection the engine is still syncing: warming up too.
                        let (reason, limit) = match p.stale && p.tip.is_some() {
                            true => ("stale", Limit::AsTheyAre),
                            false => ("warming_up", rec.cap().map_or(Limit::Withheld, Limit::At)),
                        };
                        (own.map(|r| (r, p.tip)), reason, limit)
                    }
                    None => (None, "engine_off", Limit::AsTheyAre),
                };
                let mut fetch = false;
                let answer = match own {
                    Some((rates, tip)) => {
                        if let Some((since, _)) = fallback.take() {
                            logging::emit(&FeesFallbackEnded {
                                network,
                                duration_ms: u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX),
                            });
                        }
                        (node, asked) = (None, None);
                        Some(Answer { rates, source: Source::Projected, tip, at: now })
                    }
                    None => {
                        if fallback.is_none() {
                            logging::emit(&FeesFallbackStarted { network, reason });
                            fallback = Some((Instant::now(), reason));
                        }
                        let wanted = ctx.fees.wanted(unix(now)) || ctx.hub.subscribers(Topic::Fees) > 0;
                        fetch = wanted && asked.is_none_or(|a| a.elapsed() >= NODE_EVERY);
                        node_answer(node, now, seen_floor(engines.as_ref()), limit)
                    }
                };
                // Our own answer withdrawn, or an aged one dropped, before any wait on the node.
                messages += u64::from(serve(&ctx, answer, &mut published, &mut held));
                if fetch {
                    asked = Some(Instant::now());
                    let fetching = node_estimates(&ctx);
                    tokio::pin!(fetching);
                    // Wait no longer than the estimates being served stay young; if they expire
                    // first, withdraw them, then give the node the rest of its time.
                    let left = node.map_or(NODE_WAIT, |(at, _)| NODE_MAX_AGE.saturating_sub(at.elapsed()));
                    let mut got = tokio::time::timeout(left.min(NODE_WAIT), &mut fetching).await.ok();
                    if got.is_none() && left < NODE_WAIT {
                        let answer = node_answer(node, SystemTime::now(), seen_floor(engines.as_ref()), limit);
                        messages += u64::from(serve(&ctx, answer, &mut published, &mut held));
                        got = tokio::time::timeout(NODE_WAIT - left, &mut fetching).await.ok();
                    }
                    if let Some(Some(r)) = got {
                        node = Some((Instant::now(), r));
                    }
                    let answer = node_answer(node, SystemTime::now(), seen_floor(engines.as_ref()), limit);
                    messages += u64::from(serve(&ctx, answer, &mut published, &mut held));
                }
            }
            _ = summary.tick() => {
                let a = ctx.fees.current();
                let l = |i: usize| a.as_ref().and_then(|a| a.rates.levels.get(i).copied());
                logging::emit(&FeesSummary {
                    network,
                    source: a.as_ref().map_or("none", |a| a.source.name()),
                    high: l(0),
                    medium: l(1),
                    low: l(2),
                    no_rush: l(3),
                    minimum: a.as_ref().map(|a| a.rates.minimum),
                    inflow_minutes: rec.inflow().minutes(),
                    ws_messages: std::mem::take(&mut messages),
                });
            }
        }
    }
}

/// The node's own estimates with its minimum now, both asked: the tracker's copy of the
/// minimum may be as old as its last good cycle. The minimum is asked only once the estimates
/// came.
async fn node_estimates(ctx: &NetworkContext) -> Option<Rates> {
    let est = ctx.esplora.fee_estimates().await.ok()?;
    let floor = floor_of(ctx.rpc.mempool_info().await.ok()?.mempoolminfee);
    fees::from_node(&est.value, floor)
}

/// The minimum the tracker last saw the node accept, 0 without the engine.
fn seen_floor(engines: Option<&Engines>) -> u32 {
    engines
        .and_then(|e| e.tracker.node_info())
        .map_or(0, |i| floor_of(i.mempoolminfee))
}

/// How much of the node's estimates may be served while ours is not.
#[derive(Debug, Clone, Copy)]
enum Limit {
    /// All of them: the engine is off, or the projection is stale.
    AsTheyAre,
    /// None: warming up, and no whole minute of arrivals watched yet to bound them by. On a
    /// quiet network the node's next-block estimate is a high quantile of old blocks, far above
    /// what the mempool needs (`docs/MEMPOOL.md`, "When ours cannot be served").
    Withheld,
    /// Each level no higher than this ([`Recommender::cap`]).
    At(Rates),
}

/// The node's estimates as an answer while they are young enough to serve and `limit` lets
/// them, raised to any higher minimum seen since they came.
fn node_answer(
    node: Option<(Instant, Rates)>,
    now: SystemTime,
    floor: u32,
    limit: Limit,
) -> Option<Answer> {
    let (at, rates) = node.filter(|(at, _)| at.elapsed() < NODE_MAX_AGE)?;
    let rates = match limit {
        Limit::AsTheyAre => rates,
        Limit::Withheld => return None,
        Limit::At(cap) => rates.at_most(&cap),
    };
    Some(Answer {
        rates: rates.at_least(floor),
        source: Source::Node,
        tip: None,
        at: now - at.elapsed(),
    })
}

/// Stores the answer for the routes, and publishes the topic when the message changed. Returns
/// whether it published.
///
/// Ours is a mempool topic on a block (docs/WS.md "When a block is found"): one on another tip
/// than the block the `blocks` topic last announced waits for the two to agree, for at most
/// [`HOLD`](super::mempool::HOLD) since `held`, so it never comes before that block's `block`
/// message nor on an older block after it. The node's estimates and `unavailable` are on no block.
fn serve(
    ctx: &NetworkContext,
    answer: Option<Answer>,
    published: &mut Option<Value>,
    held: &mut Option<Instant>,
) -> bool {
    let msg = message(answer.as_ref());
    let tip = answer.as_ref().and_then(|a| a.tip);
    ctx.fees.set(answer);
    if published.as_ref() == Some(&msg) {
        *held = None;
        return false;
    }
    ctx.hub.in_block_order(|announced| {
        let agrees = announced.is_none() || tip.is_none_or(|t| Some(t.hash) == announced);
        if !agrees && held.get_or_insert_with(Instant::now).elapsed() < super::mempool::HOLD {
            return false;
        }
        *held = None;
        ctx.hub.publish(
            Topic::Fees,
            &Frame::text(msg.to_string().as_bytes()),
            Snapshot::Replace,
        );
        *published = Some(msg);
        true
    })
}

/// Each projected block's totals, its size from the tracker's records.
fn mempool_blocks(p: &Projection, tracker: &Tracker, at: SystemTime) -> Blocks {
    let blocks = tracker.read(|m| {
        p.blocks
            .iter()
            .map(|b| {
                let s = &b.summary;
                // A transaction that left since the projection counts at its vsize.
                let size = b
                    .txs
                    .iter()
                    .map(|(t, r)| u64::from(m.get(t).map_or(r.vsize, |i| i.size)))
                    .sum();
                MempoolBlock {
                    size,
                    vsize: s.vsize,
                    txs: s.txs,
                    fees: s.fees,
                    median: s.median_rate,
                    range: fees::fee_range(b.txs.iter().map(|(_, r)| (r.rate, r.vsize))),
                }
            })
            .collect()
    });
    Blocks {
        blocks,
        tip: p.tip,
        stale: p.stale,
        at,
    }
}

/// The `fees` message: the levels with their horizons, or `unavailable`.
fn message(a: Option<&Answer>) -> Value {
    let Some(a) = a else {
        return json!({ "topic": "fees", "type": "unavailable" });
    };
    let levels: Vec<Value> = LEVELS
        .iter()
        .zip(a.rates.levels)
        .map(|(l, rate)| json!({ "name": l.name, "blocks": l.blocks, "minutes": l.minutes, "rate": rate }))
        .collect();
    json!({
        "topic": "fees",
        "type": "fees",
        "source": a.source.name(),
        "tip": a.tip.map(|t| json!({ "height": t.height, "hash": t.hash })),
        "levels": levels,
        "min_fee_rate": a.rates.minimum,
    })
}

#[cfg(test)]
pub(crate) mod tests;
