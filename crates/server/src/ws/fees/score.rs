//! The score the server keeps of its own fee recommendations (`docs/MEMPOOL.md`, "The score the
//! server keeps"): every [`EVERY`] what was served, and for every block the rate that sufficed
//! to get in, kept in memory and in the store, scored by `engine::fees::score` for the
//! `/app/fees/score` route and a daily `fees_score` line.
//!
//! It asks the node nothing. Blocks' transactions come from the tracker's own window of recent
//! blocks, which every tracker delta carries, and the rates they were held at from the last
//! projection before them. The fee task is not touched: the served answer is read from
//! [`super::Fees::current`].

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, Uri};
use axum::response::{IntoResponse, Response};
use engine::fees::LEVELS;
use engine::fees::db::{self, Batch, KEEP_BLOCKS, KEEP_SAMPLES};
use engine::fees::score::{self, Block, MIN_BLOCKS, Record, Report, Sample, Served, Tally};
use engine::mempool::{BlockSpends, Tracker};
use engine::projected::{Projection, Projector};
use engine::store::Store;
use logging::events::{FeesScore, FeesScoreLevel};
use serde_json::{Value, json};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::Source;
use crate::NetworkContext;
use crate::api_v1::{MEMPOOL_OFF, NOT_READY};
use crate::error::ApiError;
use crate::esplora::{ApiOutcome, Source as Outcome};

/// How often what is served is sampled: as the recordings did, so the scores compare. Samples
/// waiting for the same block share its fate, so more would add rows, not evidence.
pub const EVERY: Duration = Duration::from_secs(30);
/// Writes waiting for the store: half an hour of samples while the gate waits for the node.
const QUEUE: usize = 64;
/// Blocks missed while the server was down are recorded, without a clearing rate, up to the
/// longest horizon. Past that, only the new tip: such a gap is an outage anyway.
const MAX_FILL: u32 = 144;
const DAY: u64 = 86_400;

/// The windows the route answers, by their parameter.
const WINDOWS: [(&str, Option<u64>); 4] = [
    ("24h", Some(DAY)),
    ("1w", Some(7 * DAY)),
    ("1m", Some(30 * DAY)),
    ("all", None),
];

/// The score's answers, one body per window, rebuilt after every sample.
#[derive(Debug, Default)]
pub struct Scores {
    bodies: Mutex<Option<Arc<[Bytes; WINDOWS.len()]>>>,
    /// Writes dropped (queue full) or failed since the last daily line.
    unsaved: AtomicU64,
    /// The day-long level's floor from the blocks recorded (`fees::score::day_floor`), 0 for none.
    day_floor: AtomicU32,
}

impl Scores {
    /// The day-long level's floor now, `None` before a block with a clearing rate is recorded.
    pub fn day_floor(&self) -> Option<u32> {
        Some(self.day_floor.load(Ordering::Relaxed)).filter(|f| *f > 0)
    }

    fn set_day_floor(&self, record: &Record) {
        let f = record.day_floor().unwrap_or(0);
        self.day_floor.store(f, Ordering::Relaxed);
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Starts keeping score on running engines: the keeper and, with a store, its writer.
pub(crate) fn start(
    ctx: &Arc<NetworkContext>,
    tracker: &Tracker,
    projector: &Projector,
) -> Vec<JoinHandle<()>> {
    let store = ctx.blocks.as_ref().map(|t| Arc::clone(&t.store));
    let (writes, writer) = match &store {
        Some(s) => {
            let (tx, rx) = mpsc::channel(QUEUE);
            (
                Some(tx),
                Some(tokio::spawn(write(Arc::clone(ctx), Arc::clone(s), rx))),
            )
        }
        None => (None, None),
    };
    let keeper = tokio::spawn(run(
        Arc::clone(ctx),
        tracker.clone(),
        projector.clone(),
        store,
        writes,
        EVERY,
    ));
    writer.into_iter().chain([keeper]).collect()
}

/// Writes batches in order, each at the store's generation when its data was read.
pub(crate) async fn write(
    ctx: Arc<NetworkContext>,
    store: Arc<Store>,
    mut rx: mpsc::Receiver<(u64, Batch)>,
) {
    while let Some((generation, batch)) = rx.recv().await {
        if db::write(&store, generation, batch, unix_now())
            .await
            .is_err()
        {
            ctx.fees.score.unsaved.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Keeps the record until aborted.
pub(crate) async fn run(
    ctx: Arc<NetworkContext>,
    tracker: Tracker,
    projector: Projector,
    store: Option<Arc<Store>>,
    writes: Option<mpsc::Sender<(u64, Batch)>>,
    every: Duration,
) {
    let mut record = match &store {
        Some(s) => db::load(s, unix_now())
            .await
            .map(|(samples, blocks)| Record::new(samples, blocks))
            .unwrap_or_default(),
        None => Record::default(),
    };
    let send = |batch: Batch| {
        let (Some(tx), Some(s)) = (&writes, &store) else {
            return;
        };
        if tx.try_send((s.generation(), batch)).is_err() {
            ctx.fees.score.unsaved.fetch_add(1, Ordering::Relaxed);
        }
    };
    let (_, mut deltas) = tracker.subscribe(|_| ());
    let (current, mut projections) = projector.subscribe();
    let mut chain = Chain::default();
    let found = chain.projection(current, record.last_height(), unix_now());
    record_blocks(&mut record, found, &send);
    ctx.fees.score.set_day_floor(&record);
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let midnight = || Duration::from_secs(DAY - unix_now() % DAY);
    let daily = tokio::time::sleep(midnight());
    tokio::pin!(daily);
    loop {
        tokio::select! {
            // A block's tracker delta is taken before the projection that follows it.
            biased;
            d = deltas.recv() => match d {
                Ok(d) => chain.window.clone_from(&d.blocks),
                Err(RecvError::Lagged(_)) => (_, deltas) = tracker.subscribe(|_| ()),
                Err(RecvError::Closed) => return,
            },
            d = projections.recv() => {
                match d {
                    Ok(_) => {}
                    Err(RecvError::Lagged(_)) => (_, projections) = projector.subscribe(),
                    Err(RecvError::Closed) => return,
                }
                let found = chain.projection(projector.current(), record.last_height(), unix_now());
                record_blocks(&mut record, found, &send);
                ctx.fees.score.set_day_floor(&record);
            }
            _ = tick.tick() => {
                let now = unix_now();
                let served = match ctx.fees.current() {
                    Some(a) if a.source == Source::Projected => Served::Ours(a.rates.levels),
                    Some(_) => Served::Node,
                    None => Served::Nothing,
                };
                let s = Sample { t: now, served };
                if record.sample(s) {
                    send(Batch { samples: vec![s], blocks: Vec::new() });
                }
                record.prune(now.saturating_sub(KEEP_SAMPLES), now.saturating_sub(KEEP_BLOCKS));
                // A month of samples takes milliseconds to score: off the runtime's threads.
                let r = record.clone();
                if let Ok(bodies) = tokio::task::spawn_blocking(move || bodies(&r, now)).await {
                    *ctx.fees.score.bodies.lock().unwrap_or_else(PoisonError::into_inner) =
                        Some(Arc::new(bodies));
                }
            }
            () = &mut daily => {
                let now = unix_now();
                let day = now / DAY * DAY - DAY;
                let r = record.clone();
                if let Ok(report) = tokio::task::spawn_blocking(move || {
                    r.report(&[(day, day + DAY)]).pop().unwrap_or_default()
                }).await {
                    log_day(&ctx, day, &report);
                }
                daily.as_mut().reset(tokio::time::Instant::now() + midnight());
            }
        }
    }
}

fn record_blocks(record: &mut Record, found: Vec<Block>, send: &impl Fn(Batch)) {
    for b in &found {
        record.block(*b);
    }
    if !found.is_empty() {
        send(Batch {
            samples: Vec::new(),
            blocks: found,
        });
    }
}

/// What the keeper follows of the chain: the last projection, and the tracker's recent blocks,
/// tip first, as its latest delta gave them.
#[derive(Default)]
struct Chain {
    before: Option<Arc<Projection>>,
    window: Vec<Arc<BlockSpends>>,
}

impl Chain {
    /// The blocks a new projection `p` reveals, seen at `now`. The first with a tip reveals
    /// those mined since `last`, the highest height recorded before a restart, without a
    /// clearing rate: nothing projected them. After that, as `fee_watch` records them: every
    /// height above the old tip's to the new one's, or the new tip alone after a reorg, each
    /// with the clearing rate the last projection on the old tip gives the block, when the
    /// tracker's window holds it.
    fn projection(&mut self, p: Arc<Projection>, last: Option<u32>, now: u64) -> Vec<Block> {
        let Some(new) = p.tip else {
            return Vec::new();
        };
        let before = match self.before.replace(Arc::clone(&p)) {
            Some(b) if b.tip.is_some() => b,
            _ => {
                let Some(last) = last.filter(|l| new.height > *l) else {
                    return Vec::new();
                };
                return heights(last + 1, new.height)
                    .map(|height| Block {
                        height,
                        t: now,
                        clearing: None,
                    })
                    .collect();
            }
        };
        let from = match before.tip {
            Some(old) if old == new => return Vec::new(),
            Some(old) if new.height > old.height => old.height + 1,
            _ => new.height,
        };
        heights(from, new.height)
            .map(|height| {
                let clearing = self
                    .window
                    .iter()
                    .find(|b| b.height == height)
                    .and_then(|b| score::clearing(&mut score::held(&before, |t| b.contains(t))));
                Block {
                    height,
                    t: now,
                    clearing,
                }
            })
            .collect()
    }
}

/// `from..=to`, or `to` alone when that is more than [`MAX_FILL`] heights: such a gap is an
/// outage, whatever filled it.
fn heights(from: u32, to: u32) -> std::ops::RangeInclusive<u32> {
    if to.saturating_sub(from) >= MAX_FILL {
        to..=to
    } else {
        from..=to
    }
}

/// Rounded to `places` decimals, or `null` when there is nothing to show.
fn num(x: f64, places: i32) -> Value {
    let f = 10f64.powi(places);
    if x.is_finite() {
        json!((x * f).round() / f)
    } else {
        Value::Null
    }
}

/// Rounded down (`up` false) or up to `places` decimals, or `null`: an interval's ends written
/// outward, so neither moves inside the true one across a threshold.
fn num_toward(x: f64, places: i32, up: bool) -> Value {
    let f = 10f64.powi(places);
    if !x.is_finite() {
        return Value::Null;
    }
    let scaled = if up { (x * f).ceil() } else { (x * f).floor() };
    json!(scaled / f)
}

/// The share met to four decimals, rounded down from the counts themselves: a share under a
/// threshold such as the 85% target is never written as it (33 999 of 40 000 is 0.8499, not
/// 0.85), and one at it is written exactly.
fn share_down(t: &Tally) -> Value {
    match t
        .met
        .checked_mul(10_000)
        .and_then(|m| m.checked_div(t.total))
    {
        Some(parts) => json!(parts as f64 / 10_000.0),
        None => num_toward(t.share(), 4, false),
    }
}

fn level_json(name: &str, blocks: u32, t: &Tally) -> Value {
    let enough = t.blocks() >= MIN_BLOCKS;
    let (lo, hi) = t.interval();
    let shown = |v: Value| if enough { v } else { Value::Null };
    json!({
        "name": name,
        "blocks": blocks,
        "scored": t.total,
        "outcomes": t.blocks(),
        "enough": enough,
        "met": shown(share_down(t)),
        "interval": shown(json!([num_toward(lo, 4, false), num_toward(hi, 4, true)])),
        "overpay": shown(json!({ "mean": num(t.mean_over(), 3), "median": num(t.median_over(), 3) })),
        "shortfall": shown(num(t.mean_short(), 3)),
        "recommended": shown(num(t.median_given(), 3)),
        "left_out": {
            "outage": t.left_out,
            "unfinished": t.unfinished,
            "no_clearing": t.unscored,
        },
    })
}

/// Every window's answer as of `now`.
fn bodies(r: &Record, now: u64) -> [Bytes; WINDOWS.len()] {
    let first = r.samples().first().map(|s| s.t);
    let spans = WINDOWS.map(|(_, span)| (span.map_or(0, |s| now.saturating_sub(s)), now + 1));
    let reports = r.report(&spans);
    let mut out = WINDOWS.map(|_| Bytes::new());
    for (((slot, (name, _)), (from, _)), report) in
        out.iter_mut().zip(WINDOWS).zip(spans).zip(&reports)
    {
        let levels: Vec<Value> = LEVELS
            .iter()
            .zip(&report.levels)
            .map(|(l, t)| level_json(l.name, l.blocks, t))
            .collect();
        let v = json!({
            "window": name,
            "from": first.map(|f| f.max(from)),
            "to": now,
            "min_blocks": MIN_BLOCKS,
            "levels": levels,
            "not_ours": { "node": report.node, "nothing": report.nothing },
        });
        *slot = Bytes::from(v.to_string());
    }
    out
}

fn log_day(ctx: &NetworkContext, day: u64, r: &Report) {
    let pct = |x: f64| x.is_finite().then(|| (x * 1000.0).round() / 10.0);
    let sat = |x: f64| x.is_finite().then(|| (x * 1000.0).round() / 1000.0);
    let levels = LEVELS
        .iter()
        .zip(&r.levels)
        .map(|(l, t)| {
            let enough = t.blocks() >= MIN_BLOCKS;
            let (lo, hi) = t.interval();
            let shown = |x: Option<f64>| x.filter(|_| enough);
            FeesScoreLevel {
                name: l.name,
                scored: t.total,
                blocks: t.blocks(),
                min_blocks: MIN_BLOCKS,
                met_pct: shown(pct(t.share())),
                met_low_pct: shown(pct(lo)),
                met_high_pct: shown(pct(hi)),
                overpay_sat_vb: shown(sat(t.mean_over())),
                shortfall_sat_vb: shown(sat(t.mean_short())),
                outage: t.left_out,
                unfinished: t.unfinished,
                no_clearing: t.unscored,
            }
        })
        .collect();
    logging::emit(&FeesScore {
        network: ctx.config.network.name(),
        day,
        levels,
        not_ours: r.node + r.nothing,
        unsaved: ctx.fees.score.unsaved.swap(0, Ordering::Relaxed),
    });
}

/// `GET /app/fees/score?window=24h|1w|1m|all`, `all` without one: the score as of the last
/// sample, from memory.
pub(crate) async fn route(State(ctx): State<Arc<NetworkContext>>, uri: Uri) -> Response {
    const BAD: ApiError = ApiError::bad_request("the only parameter is window: 24h, 1w, 1m or all");
    let i = match uri.query().filter(|q| !q.is_empty()) {
        None => WINDOWS.len() - 1,
        Some(q) => match q
            .strip_prefix("window=")
            .and_then(|w| WINDOWS.iter().position(|(n, _)| *n == w))
        {
            Some(i) => i,
            None => return BAD.into_response(),
        },
    };
    let bodies = ctx
        .fees
        .score
        .bodies
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let Some(body) = bodies.as_ref().and_then(|b| b.get(i)) else {
        return if ctx.config.mempool {
            NOT_READY
        } else {
            MEMPOOL_OFF
        }
        .into_response();
    };
    let mut res = (
        [(CONTENT_TYPE, HeaderValue::from_static("application/json"))],
        body.clone(),
    )
        .into_response();
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("public, max-age=1"));
    res.extensions_mut().insert(ApiOutcome {
        route: "fees_score",
        source: Outcome::Cached,
        upstream_error: None,
    });
    res
}

#[cfg(test)]
#[allow(clippy::indexing_slicing)]
mod tests {
    use super::*;
    use engine::fees::score::Outcome;

    /// A tally of `n` samples, each decided by its own block, given `rate` against `need`.
    fn tally(n: usize, rate: u64, need: u64) -> Tally {
        let mut t = Tally::default();
        for waited_for in 0..n {
            t.count(Outcome::Scored {
                met: rate >= need,
                rate,
                need,
                waited_for,
                faster: true,
            });
        }
        t
    }

    #[test]
    fn a_level_says_the_median_rate_it_recommended_only_with_enough_blocks() {
        // Rates that differ, so the convention shows: 1, 2, 3 and 4 sat/vB give the upper middle,
        // 3, not 2.5, the mean of the two middle ones.
        let mut t = Tally::default();
        for (waited_for, rate) in
            (0..MIN_BLOCKS + 2).zip([1_000u64, 2_000, 3_000, 4_000].iter().cycle())
        {
            t.count(Outcome::Scored {
                met: true,
                rate: *rate,
                need: 500,
                waited_for,
                faster: true,
            });
        }
        let enough = level_json("high", 1, &t);
        assert_eq!(enough["recommended"], json!(3.0));
        let same = level_json("high", 1, &tally(MIN_BLOCKS, 2_345, 1_000));
        assert_eq!(same["recommended"], json!(2.345));
        assert_eq!(same["overpay"]["median"], json!(1.345));
        let few = level_json("high", 1, &tally(MIN_BLOCKS - 1, 2_345, 1_000));
        assert_eq!(few["recommended"], Value::Null);
    }

    /// `met` of `total` answers met, spread over 40 blocks.
    fn split(met: usize, total: usize) -> Tally {
        let mut t = Tally::default();
        for i in 0..total {
            t.count(Outcome::Scored {
                met: i < met,
                rate: 2_000,
                need: if i < met { 1_000 } else { 3_000 },
                waited_for: i % 40,
                faster: true,
            });
        }
        t
    }

    /// The level as the route sends it: written to text and read back.
    fn served(t: &Tally) -> Value {
        serde_json::from_str(&level_json("high", 1, t).to_string()).unwrap_or(Value::Null)
    }

    #[test]
    fn a_share_under_the_target_is_never_written_as_the_target() {
        // 33 999 of 40 000 is 0.849975: written 0.8499, under the 85% target, as it is.
        let t = split(33_999, 40_000);
        let under = served(&t);
        assert_eq!(under["met"], json!(0.8499));
        assert_eq!(served(&split(34_000, 40_000))["met"], json!(0.85));
        // The interval is written outward: neither end moves inside the true one.
        let (lo, hi) = t.interval();
        let written = &under["interval"];
        let (wlo, whi) = (
            written[0].as_f64().unwrap_or(2.0),
            written[1].as_f64().unwrap_or(-1.0),
        );
        assert!(wlo <= lo && lo - wlo < 1e-4, "{wlo} for {lo}");
        assert!(whi >= hi && whi - hi < 1e-4, "{whi} for {hi}");
    }
}
