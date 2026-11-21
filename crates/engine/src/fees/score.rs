//! Keeping score of fee recommendations against the blocks that followed them: the clearing rate
//! of a block, the scorer `fee_watch` used for the recordings in `docs/MEMPOOL.md`, and the
//! record the server keeps of its own answers. Pure: no I/O, no clock.

use bitcoin::Txid;

use super::LEVELS;
use crate::projected::Projection;

/// The longest gap between two recorded blocks taken as real. Longer, and the recorder's node
/// had lost the network: on a live chain a two-hour gap comes about once in 450 years.
pub const MAX_GAP_SECS: u64 = 7_200;

/// Seconds after an outage whose samples are left out too, while the method's arrivals still
/// hold the quiet and the mempool refills: the arrival window.
pub const AFTERMATH_SECS: u64 = super::INFLOW_MINUTES as u64 * 60;

/// Fewer distinct blocks than this decided a level's samples, and its met share is not given:
/// the 95% interval would be wider than 13 points either side of 85%.
pub const MIN_BLOCKS: usize = 30;

/// The rate that sufficed to get into a block: the 1st percentile by vsize of the effective
/// rates of its transactions we held, so one prioritised or out-of-band transaction does not
/// set it. `None` when we held none of them: no rate sufficed.
pub fn clearing(rates: &mut [(u32, u64)]) -> Option<u32> {
    rates.sort_unstable();
    let total: u64 = rates.iter().map(|(_, v)| v).sum();
    let mut below = 0;
    rates
        .iter()
        .find(|(_, v)| {
            below += v;
            below * 100 >= total
        })
        .map(|(r, _)| *r)
}

/// A block's transactions that projection `before` held, as `(effective rate, vsize)`: what
/// [`clearing`] is taken over. `before` is the last projection on the block's parent.
pub fn held(before: &Projection, in_block: impl Fn(&Txid) -> bool) -> Vec<(u32, u64)> {
    before
        .blocks
        .iter()
        .flat_map(|b| b.txs.iter())
        .filter(|(t, _)| in_block(t))
        .map(|(_, p)| (p.rate, u64::from(p.vsize)))
        .collect()
}

/// A recorded block: its height, when we saw it, and the rate that sufficed to get in, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Block {
    pub height: u32,
    pub t: u64,
    pub clearing: Option<u32>,
}

/// Steps of 0.001 sat/vB above the cheapest clearing rate of the last day that the day-long
/// level pays at least: a block's clearing rate plus one is what got in, and over three days on
/// mainnet the next day's cheapest block cleared up to two steps above the last day's
/// (`docs/MEMPOOL.md`, "The day-long level").
pub const DAY_FLOOR_STEPS: u32 = 3;

/// The day-long level's floor: [`DAY_FLOOR_STEPS`] above the cheapest clearing rate among
/// `blocks` in the 144 heights to the highest. `None` when none of them has one.
pub fn day_floor(blocks: &[Block]) -> Option<u32> {
    let tip = blocks.iter().map(|b| b.height).max()?;
    let from = tip.saturating_sub(DAY_BLOCKS - 1);
    blocks
        .iter()
        .filter(|b| b.height >= from)
        .filter_map(|b| b.clearing)
        .min()
        .map(|c| c.saturating_add(DAY_FLOOR_STEPS))
}

/// The day-long level's horizon: the last of [`LEVELS`].
const DAY_BLOCKS: u32 = {
    let [.., day] = LEVELS;
    day.blocks
};

/// Spans whose outcome means nothing: a gap between two recorded blocks (sorted by time)
/// longer than `max_gap`, and the [`AFTERMATH_SECS`] after it.
pub fn outages(blocks: &[Block], max_gap: u64) -> Vec<(u64, u64)> {
    blocks
        .windows(2)
        .filter_map(|w| match w {
            [a, b] if b.t.saturating_sub(a.t) > max_gap => {
                Some((a.t, b.t.saturating_add(AFTERMATH_SECS)))
            }
            _ => None,
        })
        .collect()
}

/// How one sample's answer at one level turned out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Its `N`-th block has not come yet (or came after the end of a fit).
    Unfinished,
    /// Its horizon reaches into an outage.
    LeftOut,
    /// The source gave no rate.
    NoRate,
    /// No block of its horizon has a clearing rate.
    Unscored,
    Scored {
        /// Paid at least one step above the clearing rate of one of the next `N` blocks.
        met: bool,
        /// The rate given and the cheapest that got in, sat per 1,000 vB.
        rate: u64,
        need: u64,
        /// The first block after the sample, by its place in the blocks: the one it waited for.
        waited_for: usize,
        /// The `N`-th block came within `N` × 10 minutes.
        faster: bool,
    },
}

/// How the answer `rate` given at `t` for `n` blocks fared against `blocks` (sorted by time).
/// Blocks seen at or after `to` are taken as not known yet.
pub fn outcome(
    t: u64,
    rate: Option<u32>,
    n: usize,
    blocks: &[Block],
    outages: &[(u64, u64)],
    to: u64,
) -> Outcome {
    let first = blocks.partition_point(|b| b.t <= t);
    let Some(after) = first.checked_add(n).and_then(|end| blocks.get(first..end)) else {
        return Outcome::Unfinished;
    };
    let Some(end) = after.last().map(|b| b.t) else {
        return Outcome::Unfinished;
    };
    if end >= to {
        return Outcome::Unfinished;
    }
    if outages.iter().any(|(from, to)| t < *to && end > *from) {
        return Outcome::LeftOut;
    }
    let Some(rate) = rate.map(u64::from) else {
        return Outcome::NoRate;
    };
    // The cheapest rate that got into one of the next `n` blocks: one step above a block's
    // clearing rate.
    let Some(need) = after
        .iter()
        .filter_map(|b| b.clearing)
        .map(|c| u64::from(c) + 1)
        .min()
    else {
        return Outcome::Unscored;
    };
    Outcome::Scored {
        met: rate >= need,
        rate,
        need,
        waited_for: first,
        faster: end - t <= n as u64 * 600,
    }
}

/// One source's tally at one level.
#[derive(Debug, Clone, Default)]
pub struct Tally {
    pub met: usize,
    pub total: usize,
    /// Overpay when met and shortfall when missed, sat/vB.
    pub over: Vec<f64>,
    pub short: Vec<f64>,
    /// The rate given, sat/vB, for every sample scored: the base overpay is read against.
    pub given: Vec<f64>,
    /// No block of the horizon has a clearing rate (all held none of our transactions).
    pub unscored: usize,
    /// Left out: the horizon reaches into an outage.
    pub left_out: usize,
    /// Not finished: the horizon's last block has not come.
    pub unfinished: usize,
    /// Per block that ended the wait: (met, total). Samples waiting for the same block share
    /// its fate, so the confidence interval is clustered on it.
    pub groups: std::collections::BTreeMap<usize, (usize, usize)>,
    /// (met, total) when the `N`-th block came within `N` × 10 minutes, and when it did not.
    pub faster: (usize, usize),
    pub slower: (usize, usize),
}

impl Tally {
    pub fn count(&mut self, o: Outcome) {
        match o {
            Outcome::Unfinished => self.unfinished += 1,
            Outcome::LeftOut => self.left_out += 1,
            Outcome::NoRate => {}
            Outcome::Unscored => self.unscored += 1,
            Outcome::Scored {
                met,
                rate,
                need,
                waited_for,
                faster,
            } => {
                self.total += 1;
                self.met += usize::from(met);
                let g = self.groups.entry(waited_for).or_default();
                g.0 += usize::from(met);
                g.1 += 1;
                let pace = if faster {
                    &mut self.faster
                } else {
                    &mut self.slower
                };
                pace.0 += usize::from(met);
                pace.1 += 1;
                self.given.push(rate as f64 / 1000.0);
                if met {
                    self.over.push((rate - need) as f64 / 1000.0);
                } else {
                    self.short.push((need - rate) as f64 / 1000.0);
                }
            }
        }
    }

    /// The share met, `NaN` with nothing scored.
    pub fn share(&self) -> f64 {
        self.met as f64 / self.total as f64
    }

    /// Distinct blocks that decided the samples scored: the number of outcomes.
    pub fn blocks(&self) -> usize {
        self.groups.len()
    }

    /// The 95% interval of the met share: the wider of one clustered on the block each sample
    /// waited for, and Wilson's for as many outcomes as blocks, so a share all met (or all
    /// missed) over a few blocks is never shown as certain. `NaN` under two blocks.
    pub fn interval(&self) -> (f64, f64) {
        let (n, g) = (self.total as f64, self.groups.len() as f64);
        let p = self.met as f64 / n;
        if g < 2.0 {
            return (f64::NAN, f64::NAN);
        }
        let ss: f64 = self
            .groups
            .values()
            .map(|&(m, t)| (m as f64 - p * t as f64).powi(2))
            .sum();
        let half = 1.96 * (g / (g - 1.0) * ss).sqrt() / n;
        let z2 = 1.96f64.powi(2);
        let centre = (p + z2 / (2.0 * g)) / (1.0 + z2 / g);
        let wilson = (p * (1.0 - p) / g + z2 / (4.0 * g * g)).sqrt() * 1.96 / (1.0 + z2 / g);
        (
            (p - half).min(centre - wilson).max(0.0),
            (p + half).max(centre + wilson).min(1.0),
        )
    }

    /// Mean overpay when met, sat/vB; `NaN` when none was met.
    pub fn mean_over(&self) -> f64 {
        mean(&self.over)
    }

    /// Median overpay when met, sat/vB: the upper middle, as the recordings report it.
    pub fn median_over(&self) -> f64 {
        upper_median(&self.over)
    }

    /// Median rate given among the samples scored, sat/vB, the upper middle; `NaN` with none.
    pub fn median_given(&self) -> f64 {
        upper_median(&self.given)
    }

    /// Mean shortfall when missed, sat/vB; `NaN` when none was missed.
    pub fn mean_short(&self) -> f64 {
        mean(&self.short)
    }
}

fn upper_median(v: &[f64]) -> f64 {
    let mut v = v.to_vec();
    v.sort_by(f64::total_cmp);
    v.get(v.len() / 2).copied().unwrap_or(f64::NAN)
}

fn mean(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len() as f64
}

/// What was served at a sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Served {
    /// Ours: a rate per level of [`LEVELS`], fastest first, sat per 1,000 vB.
    Ours([u32; 4]),
    /// The node's estimates stood in: warming up, or the projection was stale.
    Node,
    /// Nothing could be served.
    Nothing,
}

/// One sample of what was served.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sample {
    pub t: u64,
    pub served: Served,
}

/// A window's score: per level of [`LEVELS`], and how many samples were not ours.
#[derive(Debug, Clone, Default)]
pub struct Report {
    pub levels: [Tally; 4],
    /// Samples in the window where the node's estimates, or nothing, were served instead.
    pub node: usize,
    pub nothing: usize,
}

/// The samples and blocks a server keeps, oldest first, and their score for any window.
#[derive(Debug, Clone, Default)]
pub struct Record {
    samples: Vec<Sample>,
    /// Sorted by the time seen; one per height.
    blocks: Vec<Block>,
}

impl Record {
    /// From stored rows in any order.
    pub fn new(mut samples: Vec<Sample>, mut blocks: Vec<Block>) -> Self {
        samples.sort_by_key(|s| s.t);
        blocks.sort_by_key(|b| (b.t, b.height));
        Self { samples, blocks }
    }

    pub fn samples(&self) -> &[Sample] {
        &self.samples
    }

    pub fn blocks(&self) -> &[Block] {
        &self.blocks
    }

    /// The highest height recorded.
    pub fn last_height(&self) -> Option<u32> {
        self.blocks.iter().map(|b| b.height).max()
    }

    /// [`day_floor`] of the blocks recorded.
    pub fn day_floor(&self) -> Option<u32> {
        day_floor(&self.blocks)
    }

    /// A sample at or after the last one; one from a clock that went back is dropped.
    pub fn sample(&mut self, s: Sample) -> bool {
        if self.samples.last().is_some_and(|l| l.t >= s.t) {
            return false;
        }
        self.samples.push(s);
        true
    }

    /// A block seen now. One at a height already recorded (a reorg) replaces it.
    pub fn block(&mut self, b: Block) {
        self.blocks.retain(|o| o.height != b.height);
        let at = self.blocks.partition_point(|o| o.t <= b.t);
        self.blocks.insert(at, b);
    }

    /// Forgets samples before `samples_from` and blocks seen before `blocks_from`.
    pub fn prune(&mut self, samples_from: u64, blocks_from: u64) {
        let s = self.samples.partition_point(|s| s.t < samples_from);
        self.samples.drain(..s);
        let b = self.blocks.partition_point(|b| b.t < blocks_from);
        self.blocks.drain(..b);
    }

    /// The score of the samples taken in each `[from, to)` of `windows`, against every block
    /// recorded, leaving out outages as [`outages`] finds them. Each sample's outcome is
    /// found once, whatever the number of windows.
    pub fn report(&self, windows: &[(u64, u64)]) -> Vec<Report> {
        let mut out = vec![Report::default(); windows.len()];
        let Some(start) = windows.iter().map(|w| w.0).min() else {
            return out;
        };
        let out_spans = outages(&self.blocks, MAX_GAP_SECS);
        let first = self.samples.partition_point(|s| s.t < start);
        for s in self.samples.get(first..).unwrap_or_default() {
            let inside = || {
                windows
                    .iter()
                    .zip(0..)
                    .filter(|((from, to), _)| (*from..*to).contains(&s.t))
                    .map(|(_, i)| i)
            };
            let rates = match s.served {
                Served::Ours(r) => r,
                Served::Node | Served::Nothing => {
                    for i in inside() {
                        if let Some(r) = out.get_mut(i) {
                            match s.served {
                                Served::Node => r.node += 1,
                                _ => r.nothing += 1,
                            }
                        }
                    }
                    continue;
                }
            };
            for (l, (level, rate)) in LEVELS.iter().zip(rates).enumerate() {
                let o = outcome(
                    s.t,
                    Some(rate),
                    level.blocks as usize,
                    &self.blocks,
                    &out_spans,
                    u64::MAX,
                );
                for i in inside() {
                    if let Some(t) = out.get_mut(i).and_then(|r| r.levels.get_mut(l)) {
                        t.count(o);
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests;
