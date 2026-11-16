//! Fee recommendations: the rate a new transaction should pay to be mined within each horizon,
//! read off the projected blocks and the recent arrival of competing transactions. Pure: no I/O,
//! no clock; callers pass the time. The method and its evidence: `docs/MEMPOOL.md`, "Fee
//! recommendations".
//!
//! Every rate is in sat per 1,000 vB, the node's own unit and resolution.

use std::collections::{BTreeMap, VecDeque};

use node::esplora::ChainTip;

use crate::projected::Projection;

pub mod db;
pub mod score;

/// Virtual bytes a block holds for transactions: 4,000,000 weight units less the 8,000 a
/// template keeps for the coinbase, as the projected blocks pack them.
pub const BLOCK_VSIZE: u64 = 3_992_000 / 4;

/// The node's relay floor (0.1 sat/vB): nothing below it is accepted, whatever it reports.
pub const RELAY_FLOOR: u32 = 100;

/// One recommendation level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Level {
    /// As the home page names it: `high`, `medium`, `low`, `no_rush`.
    pub name: &'static str,
    /// Mined within this many blocks.
    pub blocks: u32,
    /// The horizon at one block per ten minutes.
    pub minutes: u32,
}

/// Fastest first. The reference's `fastestFee`, `halfHourFee`, `hourFee` and `economyFee`.
pub const LEVELS: [Level; 4] = [
    Level {
        name: "high",
        blocks: 1,
        minutes: 10,
    },
    Level {
        name: "medium",
        blocks: 3,
        minutes: 30,
    },
    Level {
        name: "low",
        blocks: 6,
        minutes: 60,
    },
    Level {
        name: "no_rush",
        blocks: 144,
        minutes: 1_440,
    },
];

/// The method's two judgements, chosen from recordings on mainnet (`docs/MEMPOOL.md`, "Against
/// the blocks that followed"). A parameter so the recorder can replay other choices through the
/// same code.
#[derive(Debug, Clone, Copy)]
pub struct Tuning {
    /// Arrivals are counted up to the time by which a level's `N`-th block has come with this
    /// probability ([`arrival_secs`]).
    pub confidence: f64,
    /// How many of the busiest minutes are left out of the arrivals.
    pub busiest_left_out: LeftOut,
}

/// Of this many minutes watched, how many of the busiest to leave out.
pub type LeftOut = fn(usize) -> usize;

/// The tuning served.
pub const TUNING: Tuning = Tuning {
    confidence: 0.9,
    busiest_left_out: |n| usize::from(n >= 5),
};

/// Seconds by which the `blocks`-th block has come with probability `confidence`, block
/// intervals being exponential with a 600 s mean: a quantile of the gamma (Erlang) distribution
/// of shape `blocks`, to the whole second.
pub fn arrival_secs(blocks: u32, confidence: f64) -> u64 {
    // P(the N-th block by t) = 1 - sum over k < N of e^-x x^k / k!, with x = t / 600 s.
    let by = |t: u64| {
        let x = t as f64 / 600.0;
        let mut term = (-x).exp();
        let mut sum = term;
        for k in 1..blocks {
            term *= x / f64::from(k);
            sum += term;
        }
        1.0 - sum
    };
    // Ten times the mean is past any confidence the method uses.
    let (mut lo, mut hi) = (0u64, 6_000 * u64::from(blocks.max(1)));
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if by(mid) >= confidence {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}

/// One answer: a rate per level of [`LEVELS`], fastest first, and the node's minimum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rates {
    pub levels: [u32; 4],
    /// The lowest rate the node accepts now: its `mempoolminfee`, never under [`RELAY_FLOOR`].
    pub minimum: u32,
}

impl Rates {
    /// Raised to a minimum seen since: every level and the minimum at least `floor`.
    pub fn at_least(mut self, floor: u32) -> Self {
        self.minimum = self.minimum.max(floor);
        self.ordered()
    }

    /// No level higher than `cap`'s, then put in order again: the minimum is kept.
    pub fn at_most(mut self, cap: &Rates) -> Self {
        for (l, c) in self.levels.iter_mut().zip(cap.levels) {
            *l = (*l).min(c);
        }
        self.ordered()
    }

    /// The day-long level at least `floor` ([`score::day_floor`]), but never above the 6-block
    /// level: a mempool that clears within six blocks needs no more for a day. Without a floor,
    /// unchanged.
    pub fn no_rush_at_least(mut self, floor: Option<u32>) -> Self {
        if let (Some(f), [.., low, no_rush]) = (floor, &mut self.levels) {
            *no_rush = (*no_rush).max(f).min(*low);
        }
        self
    }

    /// Every level at least the minimum, and a faster level never below a slower one.
    fn ordered(mut self) -> Self {
        let mut below = self.minimum;
        for r in self.levels.iter_mut().rev() {
            *r = (*r).max(below);
            below = *r;
        }
        self
    }
}

/// A rate in whole sat/vB for the integer route: rounded up, so it never pays less than the
/// precise rate, and at least 1, the shape old wallets expect.
pub fn whole(rate: u32) -> u64 {
    u64::from(rate).div_ceil(1000).max(1)
}

/// The mempool's virtual size at or above each rate.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Depth {
    /// Distinct rates, highest first, and the vsize at or above each.
    rates: Vec<u32>,
    above: Vec<u64>,
}

impl Depth {
    /// From `(rate, vsize)` pairs in any order.
    pub fn new(pairs: impl IntoIterator<Item = (u32, u64)>) -> Self {
        let mut by_rate: BTreeMap<u32, u64> = BTreeMap::new();
        for (rate, vsize) in pairs {
            *by_rate.entry(rate).or_default() += vsize;
        }
        let (mut rates, mut above) = (Vec::with_capacity(by_rate.len()), Vec::new());
        let mut total = 0u64;
        for (rate, vsize) in by_rate.into_iter().rev() {
            total = total.saturating_add(vsize);
            rates.push(rate);
            above.push(total);
        }
        Self { rates, above }
    }

    /// Every transaction of a projection at its effective rate: the rate of the chunk it is
    /// mined in, so a parent lifted by its child counts where the node would mine it.
    pub fn of(p: &Projection) -> Self {
        Self::new(
            p.blocks
                .iter()
                .flat_map(|b| b.txs.iter())
                .map(|(_, t)| (t.rate, u64::from(t.vsize))),
        )
    }

    /// Vsize paying `rate` or more. Ties count as ahead: the node orders equal rates in an order
    /// nobody outside it can know.
    pub fn at_or_above(&self, rate: u32) -> u64 {
        let n = self.rates.partition_point(|r| *r >= rate);
        n.checked_sub(1)
            .and_then(|i| self.above.get(i))
            .copied()
            .unwrap_or(0)
    }

    pub fn total(&self) -> u64 {
        self.above.last().copied().unwrap_or(0)
    }

    fn max_rate(&self) -> u32 {
        self.rates.first().copied().unwrap_or(0)
    }
}

/// Minutes of arrivals kept.
pub const INFLOW_MINUTES: usize = 30;

/// Whole minutes observed before the inflow is trusted: until then, recommendations are the
/// node's own, no higher than [`Recommender::cap`] ([`Inflow::ready`]).
pub const WARM_UP_MINUTES: usize = 5;

/// Transactions that entered the mempool, per minute, over the last [`INFLOW_MINUTES`]: the
/// competition a new transaction will meet before it is mined.
#[derive(Debug, Clone, Default)]
pub struct Inflow {
    /// Closed minutes, oldest first.
    closed: VecDeque<Depth>,
    /// The minute being filled: its start (seconds), and its arrivals.
    open: Option<(u64, Vec<(u32, u64)>)>,
}

impl Inflow {
    /// Closes every minute that ended by `now`. A minute with no arrival is a zero, not a gap.
    pub fn roll(&mut self, now: u64) {
        let Some((start, _)) = &self.open else {
            self.open = Some((now, Vec::new()));
            return;
        };
        let elapsed = now.saturating_sub(*start) / 60;
        if elapsed == 0 {
            return;
        }
        let start = start.saturating_add(elapsed * 60);
        if let Some((_, arrivals)) = self.open.replace((start, Vec::new())) {
            self.closed.push_back(Depth::new(arrivals));
        }
        let empty = usize::try_from(elapsed - 1).unwrap_or(usize::MAX);
        for _ in 0..empty.min(INFLOW_MINUTES) {
            self.closed.push_back(Depth::default());
        }
        while self.closed.len() > INFLOW_MINUTES {
            self.closed.pop_front();
        }
    }

    /// A transaction that entered the mempool at `now`, at its own rate.
    pub fn record(&mut self, now: u64, rate: u32, vsize: u32) {
        self.roll(now);
        if let Some((_, arrivals)) = &mut self.open {
            arrivals.push((rate, u64::from(vsize)));
        }
    }

    /// Arrivals were missed (the change stream lagged): the minute in progress is dropped rather
    /// than counted short.
    pub fn gap(&mut self, now: u64) {
        self.open = Some((now, Vec::new()));
    }

    /// Whether enough minutes were watched to count on.
    pub fn ready(&self) -> bool {
        self.closed.len() >= WARM_UP_MINUTES
    }

    pub fn minutes(&self) -> usize {
        self.closed.len()
    }

    /// Mean vsize a minute arriving at `rate` or more. The busiest minutes are left out as
    /// `tuning` says, so a burst is not extrapolated over the horizon: it is in the mempool
    /// already, and [`Depth`] counts it there.
    pub fn per_minute_at_or_above(&self, rate: u32, tuning: &Tuning) -> f64 {
        let mut v: Vec<u64> = self.closed.iter().map(|m| m.at_or_above(rate)).collect();
        v.sort_unstable();
        v.truncate(v.len().saturating_sub((tuning.busiest_left_out)(v.len())));
        if v.is_empty() {
            return 0.0;
        }
        v.iter().sum::<u64>() as f64 / v.len() as f64
    }

    fn max_rate(&self) -> u32 {
        self.closed.iter().map(Depth::max_rate).max().unwrap_or(0)
    }
}

/// The recommendation for a mempool of `depth`, with `inflow` arriving, and the node's minimum
/// accepted rate `floor` (sat per 1,000 vB).
///
/// For each level of `N` blocks: the lowest rate `r` at which what pays `r` or more now, plus
/// what is expected to arrive paying `r` or more before the `N`-th block (at [`TUNING`]'s
/// confidence on block times), leaves room in `N` blocks. Both terms only shrink as `r` grows,
/// so the search is a bisection, and a level never asks more than one step above the highest
/// rate anyone pays.
pub fn recommend(depth: &Depth, inflow: &Inflow, floor: u32) -> Rates {
    recommend_tuned(depth, inflow, floor, &TUNING)
}

/// [`recommend`] with another tuning, for the recorder's replay.
pub fn recommend_tuned(depth: &Depth, inflow: &Inflow, floor: u32, tuning: &Tuning) -> Rates {
    let floor = floor.max(RELAY_FLOOR);
    let top = depth.max_rate().max(inflow.max_rate()).saturating_add(1);
    let mut rates = Rates {
        levels: [floor; 4],
        minimum: floor,
    };
    for (out, level) in rates.levels.iter_mut().zip(LEVELS) {
        let room = u64::from(level.blocks) * BLOCK_VSIZE;
        let minutes = arrival_secs(level.blocks, tuning.confidence) as f64 / 60.0;
        let fits = |r: u32| {
            let expected = inflow.per_minute_at_or_above(r, tuning) * minutes;
            // Strictly less: a block exactly full of transactions at `r` has no room for one more.
            (depth.at_or_above(r) as f64 + expected) < room as f64
        };
        // The lowest rate in [floor, top] that fits; `top` always does (nothing pays it).
        let (mut lo, mut hi) = (floor, top.max(floor));
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if fits(mid) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        *out = lo;
    }
    rates.ordered()
}

/// The node's own estimates as a fallback: Esplora `/fee-estimates` in sat/vB by target blocks.
/// Each level takes the estimate for its block count, or the nearest longer target the node
/// gave. `None` when the node gave none.
pub fn from_node(estimates: &BTreeMap<u16, f64>, floor: u32) -> Option<Rates> {
    let floor = floor.max(RELAY_FLOOR);
    let mut rates = Rates {
        levels: [floor; 4],
        minimum: floor,
    };
    for (out, level) in rates.levels.iter_mut().zip(LEVELS) {
        let (_, sat_vb) = estimates
            .range(u16::try_from(level.blocks).unwrap_or(u16::MAX)..)
            .find(|(_, v)| v.is_finite() && **v >= 0.0)?;
        // Rounded up to the node's resolution; absurd values saturate rather than wrap.
        *out = (sat_vb * 1000.0).ceil().min(f64::from(u32::MAX)) as u32;
    }
    Some(rates.ordered())
}

/// Seconds a raw recommendation holds a level up: a level rises at once and falls only after
/// this long, so it does not flicker with each arrival at a block's edge.
pub const HOLD_SECS: u64 = 60;

/// Smooths recommendations: each level is the highest of the last [`HOLD_SECS`] since the tip
/// last moved. A new block starts over, since it changes the picture for real.
#[derive(Debug, Clone, Default)]
pub struct Smoother {
    tip: Option<ChainTip>,
    recent: VecDeque<(u64, Rates)>,
}

impl Smoother {
    pub fn push(&mut self, now: u64, tip: Option<ChainTip>, raw: Rates) -> Rates {
        if self.tip != tip {
            self.tip = tip;
            self.recent.clear();
        }
        self.recent.push_back((now, raw));
        while self
            .recent
            .front()
            .is_some_and(|(t, _)| now.saturating_sub(*t) >= HOLD_SECS)
        {
            self.recent.pop_front();
        }
        let mut out = raw;
        for (_, r) in &self.recent {
            for (o, l) in out.levels.iter_mut().zip(r.levels) {
                *o = (*o).max(l);
            }
        }
        // The floor is the node's, now: never held up.
        out.minimum = raw.minimum;
        out.ordered()
    }

    /// Forget everything: the next value is taken as it is.
    pub fn reset(&mut self) {
        self.recent.clear();
    }
}

/// Our own recommendation as the server and the evidence program run it: arrivals in, a
/// smoothed answer out, or nothing while it cannot be trusted.
#[derive(Debug, Clone, Default)]
pub struct Recommender {
    inflow: Inflow,
    smoother: Smoother,
    /// Since when the projection has been stale or missing: arrivals are not being watched.
    unobserved: Option<u64>,
    /// While warming up: [`Recommender::cap`].
    cap: Option<Rates>,
}

/// An outage at least this long throws the arrivals away and starts the warm-up over: its
/// minutes would otherwise count as quiet ones.
pub const OUTAGE_SECS: u64 = 60;

impl Recommender {
    /// A transaction entered the mempool at `now`, paying `fee` satoshis for `vsize`.
    pub fn arrived(&mut self, now: u64, fee: u64, vsize: u32) {
        let rate = match u64::from(vsize) {
            0 => 0,
            v => fee.saturating_mul(1000) / v,
        };
        self.inflow
            .record(now, u32::try_from(rate).unwrap_or(u32::MAX), vsize);
    }

    /// Arrivals were missed: see [`Inflow::gap`].
    pub fn gap(&mut self, now: u64) {
        self.inflow.gap(now);
    }

    /// The answer for projection `p` with the node's minimum `floor`. `None` while the projection
    /// is stale or empty of a tip, or fewer than [`WARM_UP_MINUTES`] of arrivals were watched
    /// since it was last current: the caller falls back to the node's estimates then.
    pub fn update(&mut self, now: u64, p: &Projection, floor: u32) -> Option<Rates> {
        if p.stale || p.tip.is_none() {
            self.unobserved.get_or_insert(now);
            self.smoother.reset();
            self.cap = None;
            return None;
        }
        if let Some(since) = self.unobserved.take()
            && now.saturating_sub(since) >= OUTAGE_SECS
        {
            self.inflow = Inflow::default();
        }
        self.inflow.roll(now);
        if !self.inflow.ready() {
            self.cap = None;
            if self.inflow.minutes() == 0 {
                self.smoother.reset();
            } else {
                // Under five minutes the method leaves no minute out: a burst counts in full.
                let cap = recommend(&Depth::of(p), &self.inflow, floor);
                self.cap = Some(self.smoother.push(now, p.tip, cap));
            }
            return None;
        }
        if self.cap.take().is_some() {
            self.smoother.reset();
        }
        let raw = recommend(&Depth::of(p), &self.inflow, floor);
        Some(self.smoother.push(now, p.tip, raw))
    }

    pub fn inflow(&self) -> &Inflow {
        &self.inflow
    }

    /// While warming up, from the first whole minute of arrivals watched on a current
    /// projection: our method on the minutes watched so far, smoothed as ours is. The node's
    /// estimates are served no higher than this, since what the mempool holds and what was seen
    /// arriving cannot justify more. `None` before that minute, while the projection is stale or
    /// missing, and once ours is served.
    pub fn cap(&self) -> Option<Rates> {
        self.cap
    }
}

/// Seven rates across a block, cheapest first, by virtual size: the lowest, the 10th, 25th, 50th,
/// 75th and 90th percentiles, and the highest. Empty for an empty block.
pub fn fee_range(txs: impl IntoIterator<Item = (u32, u32)>) -> Vec<u32> {
    let mut by_rate: Vec<(u32, u32)> = txs.into_iter().collect();
    if by_rate.is_empty() {
        return Vec::new();
    }
    by_rate.sort_unstable();
    let total: u64 = by_rate.iter().map(|(_, v)| u64::from(*v)).sum();
    let mut out = Vec::with_capacity(7);
    out.push(by_rate.first().map_or(0, |(r, _)| *r));
    for pct in [10u64, 25, 50, 75, 90] {
        let want = total * pct;
        let mut below = 0u64;
        let rate = by_rate
            .iter()
            .find(|(_, v)| {
                below += u64::from(*v);
                below * 100 >= want
            })
            .map_or(0, |(r, _)| *r);
        out.push(rate);
    }
    out.push(by_rate.last().map_or(0, |(r, _)| *r));
    out
}

#[cfg(test)]
mod tests;
