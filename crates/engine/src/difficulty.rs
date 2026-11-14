//! Where the chain is in its difficulty period and what the next retarget is expected to do.
//! Pure arithmetic over three blocks (the tip, this period's first, the previous period's first);
//! the server fetches them. Each network's rules and what the answer means: `docs/API.md`.
//!
//! The consensus rules this follows:
//! - A period is 2016 blocks. The first block of the next period gets new bits.
//! - The retarget measures the time from the period's first block to its last: 2015 intervals,
//!   not 2016, so a period mined at exactly 600 s a block still raises difficulty slightly.
//! - The measured time is clamped to a quarter and four times two weeks, so difficulty moves at
//!   most fourfold either way, and the new target never exceeds the network's proof-of-work limit.
//! - The new target is the old one scaled by the measured time. On mainnet and signet every block
//!   in a period has the same bits. On testnet4, BIP94 scales the period's *first* block, because
//!   the last may be a minimum-difficulty block mined after a 20-minute gap. Using the first
//!   block's bits is therefore right on every network.
//! - Regtest never retargets.
//! - Testnet 5 (BIP 95) retargets as mainnet does, with no minimum-difficulty blocks and a
//!   proof-of-work limit of its genesis block's bits ([`TESTNET5`]).

use std::sync::LazyLock;

use bitcoin::params::Params;
use bitcoin::{CompactTarget, Network, Target};

/// Testnet 5's rules, which rust-bitcoin does not have: testnet4's, without minimum-difficulty
/// blocks and with the genesis block's bits as the proof-of-work limit, as rbitcoin builds them.
pub static TESTNET5: LazyLock<Params> = LazyLock::new(|| {
    let mut p = Params::new(Network::Testnet4);
    p.allow_min_difficulty_blocks = false;
    p.max_attainable_target = Target::from_compact(CompactTarget::from_consensus(0x1a0f_ffff));
    p
});

/// Blocks in a difficulty period.
pub const INTERVAL: u32 = 2016;

/// The height of the first block of the period `height` is in.
pub fn period_start(height: u32) -> u32 {
    height - height % INTERVAL
}

/// A block as far as this module cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Block {
    pub height: u32,
    /// Header timestamp, Unix seconds.
    pub time: u64,
    pub bits: CompactTarget,
}

/// Why blocks were refused: they are not the ones [`Period::new`] asked for, or their bits are
/// not a valid target on this network. Either means the node's answer cannot be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invalid {
    Height,
    Bits,
}

impl Invalid {
    pub fn label(self) -> &'static str {
        match self {
            Self::Height => "wrong_height",
            Self::Bits => "invalid_bits",
        }
    }
}

/// The bits consensus gives the first block of the next period, from this period's first block's
/// bits and the seconds from that block to the period's last. `None` if `first` is not a valid
/// target on `params`.
pub fn next_bits(params: &Params, first: CompactTarget, timespan: i64) -> Option<CompactTarget> {
    target(params, first)?;
    Some(retarget(params, first, timespan))
}

/// `first` must be a valid target on `params`: then `target × timespan` fits in 256 bits on every
/// network (signet's limit is the closest, just under 2^256 at the fourfold clamp).
fn retarget(params: &Params, first: CompactTarget, timespan: i64) -> CompactTarget {
    let span = i64::try_from(params.pow_target_timespan).unwrap_or(i64::MAX);
    let clamped = timespan.clamp(span / 4, span.saturating_mul(4));
    // Applies the proof-of-work limit and returns `first` unchanged where retargeting is off.
    CompactTarget::from_next_work_required(
        first,
        u64::try_from(clamped).unwrap_or_default(),
        params,
    )
}

/// The target `bits` encodes, if a block on this network could carry it: not negative, not zero,
/// not overflowing and not above the proof-of-work limit.
fn target(params: &Params, bits: CompactTarget) -> Option<Target> {
    let raw = bits.to_consensus();
    // An exponent above 32 shifts the mantissa past 256 bits; the sign bit makes it negative.
    if raw >> 24 > 32 || raw & 0x0080_0000 != 0 {
        return None;
    }
    let t = Target::from_compact(bits);
    (t != Target::ZERO && t <= params.max_attainable_target).then_some(t)
}

/// How many times harder `to` is than `from`.
fn ratio(from: Target, to: Target) -> f64 {
    to.difficulty_float() / from.difficulty_float()
}

/// The current period, checked. Build it with [`Period::new`] and ask [`Period::estimate`].
#[derive(Debug, Clone, Copy)]
pub struct Period {
    params: &'static Params,
    tip_height: u32,
    tip_time: u64,
    start: Block,
    /// Percent change at the adjustment that started this period.
    previous_change: f64,
}

/// The answer, in the units `/api/v1/difficulty-adjustment` uses.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Estimate {
    /// Blocks after the period's first, out of 2016.
    pub progress_percent: f64,
    /// Expected change at the next retarget, in percent, if the rest of the period is mined at
    /// this period's average pace.
    pub difficulty_change: f64,
    /// When the first block of the next period is expected, Unix milliseconds.
    pub estimated_retarget_ms: u64,
    /// Blocks still to be mined up to and including the first block of the next period.
    pub remaining_blocks: u32,
    pub remaining_ms: u64,
    /// The change at the adjustment that started this period, in percent.
    pub previous_retarget: f64,
    /// Timestamp of this period's first block, Unix seconds.
    pub previous_time: u64,
    pub next_retarget_height: u32,
    /// Average time between this period's blocks so far, by their timestamps; the target
    /// spacing while the tip is the period's first block.
    pub time_avg_ms: u64,
    /// Blocks the period would have by now at one per target spacing.
    pub expected_blocks: f64,
}

impl Period {
    /// `start` must be the first block of the tip's period and `previous` the first block of the
    /// period before it (`None` only in the first period). The next period's first height must
    /// fit a `u32`.
    pub fn new(
        params: &'static Params,
        tip_height: u32,
        tip_time: u64,
        start: Block,
        previous: Option<Block>,
    ) -> Result<Self, Invalid> {
        if start.height != period_start(tip_height)
            || previous.map(|p| p.height) != start.height.checked_sub(INTERVAL)
            || start.height.checked_add(INTERVAL).is_none()
        {
            return Err(Invalid::Height);
        }
        let current = target(params, start.bits).ok_or(Invalid::Bits)?;
        let previous_change = match previous {
            Some(p) if !params.no_pow_retargeting => {
                let before = target(params, p.bits).ok_or(Invalid::Bits)?;
                (ratio(before, current) - 1.0) * 100.0
            }
            // Regtest's bits can still differ between periods (a fixed-bits option), but that
            // is not an adjustment.
            _ => 0.0,
        };
        Ok(Self {
            params,
            tip_height,
            tip_time,
            start,
            previous_change,
        })
    }

    pub fn tip_height(&self) -> u32 {
        self.tip_height
    }

    /// The estimate at `now_ms` (Unix milliseconds): the rest of the period is expected at its
    /// average pace so far. The retarget measures block timestamps, so the projected timespan
    /// runs from the later of now and the tip's timestamp (testnet4 miners run hours ahead);
    /// the estimated date is wall-clock, from now.
    pub fn estimate(&self, now_ms: u64) -> Estimate {
        let params = self.params;
        let spacing = params.pow_target_spacing as f64;
        let mined = self.tip_height - self.start.height;
        let remaining_blocks = INTERVAL - mined;
        let avg = if mined == 0 {
            spacing
        } else {
            self.tip_time.saturating_sub(self.start.time) as f64 / f64::from(mined)
        };
        // When the period's last block (height start + 2015) is or is expected to be mined.
        let last = if mined == INTERVAL - 1 {
            self.tip_time as f64
        } else {
            (now_ms as f64 / 1000.0).max(self.tip_time as f64)
                + f64::from(INTERVAL - 1 - mined) * avg
        };
        let timespan = (last - self.start.time as f64).round() as i64;
        let current = Target::from_compact(self.start.bits);
        let next = Target::from_compact(retarget(params, self.start.bits, timespan));
        let remaining_ms = (f64::from(remaining_blocks) * avg * 1000.0).round() as u64;
        let since_start = now_ms as f64 / 1000.0 - self.start.time as f64;
        Estimate {
            progress_percent: f64::from(mined) / f64::from(INTERVAL) * 100.0,
            difficulty_change: (ratio(current, next) - 1.0) * 100.0,
            estimated_retarget_ms: now_ms.saturating_add(remaining_ms),
            remaining_blocks,
            remaining_ms,
            previous_retarget: self.previous_change,
            previous_time: self.start.time,
            next_retarget_height: self.start.height + INTERVAL,
            time_avg_ms: (avg * 1000.0).round() as u64,
            expected_blocks: (since_start / spacing).max(0.0),
        }
    }
}

#[cfg(test)]
mod tests;
