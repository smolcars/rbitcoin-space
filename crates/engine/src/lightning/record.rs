//! A node's close record, and the network's beside it (`docs/LIGHTNING.md`, "A node's
//! close record"): how the channels this server watched ended, by kind, by week and by peer, and
//! the fees of their closing transactions. Counted from stored rows only, each closed channel once,
//! in one kind: a force close whose revocation sweep was seen as a penalty, not a force close.

use std::collections::HashMap;

use super::overview::Row;
use super::{DAY, Kind};

/// The fewest closes over which a share is given: below it, counts only.
pub const MINIMUM: u32 = 20;

/// A week's length; weeks start on a Monday, 00:00 UTC.
pub const WEEK: u64 = 7 * DAY;

/// Weeks a record holds at most: its newest. Ten years of history. Past that, the first week held
/// also counts every older close.
pub const MAX_WEEKS: usize = 520;

/// The most closed rows one node's record reads: its newest. A request's work is bounded by this,
/// whatever the node's history; a node with more has a record of its newest closes only.
pub const MAX_CLOSES: usize = 10_000;

/// The Monday, 00:00 UTC, of the week holding `t`. 1 January 1970 was a Thursday.
pub fn week_of(t: u64) -> u64 {
    let day = t / DAY;
    day.saturating_sub((day + 3) % 7) * DAY
}

/// Closes and their closing fees, by [`Kind`]'s code.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tally {
    pub closes: [u32; 4],
    /// The closing transactions' fees, sats, summed over the closes whose fee is known.
    pub fees: [u64; 4],
    /// How many closes of each kind have a known fee.
    pub known: [u32; 4],
}

impl Tally {
    fn add(&mut self, kind: Kind, fee: Option<u64>) {
        let i = kind as usize;
        if let Some(n) = self.closes.get_mut(i) {
            *n = n.saturating_add(1);
        }
        if let (Some(fee), Some(sum), Some(n)) = (fee, self.fees.get_mut(i), self.known.get_mut(i))
        {
            *sum = sum.saturating_add(fee);
            *n = n.saturating_add(1);
        }
    }

    /// Closes of every kind.
    pub fn total(&self) -> u32 {
        self.closes.iter().fold(0, |a, n| a.saturating_add(*n))
    }
}

/// One week's closes, by kind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Week {
    /// Its Monday, 00:00 UTC.
    pub time: u64,
    pub closes: [u32; 4],
}

/// A record over a span: its total and each week's, oldest first, every week present.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Record {
    pub total: Tally,
    pub weeks: Vec<Week>,
}

/// The closes with one peer, by kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Peer {
    pub id: [u8; 33],
    pub closes: [u32; 4],
}

impl Peer {
    /// Force closes and penalties: the closes by a commitment transaction.
    pub fn forced(&self) -> u32 {
        let [_, force, penalty, _] = self.closes;
        force.saturating_add(penalty)
    }

    pub fn total(&self) -> u32 {
        self.closes.iter().fold(0, |a, n| a.saturating_add(*n))
    }
}

/// A node's record, and its closes with each peer: most force closes and penalties first, then
/// most closes, then by key.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NodeRecord {
    pub record: Record,
    pub peers: Vec<Peer>,
}

/// Counts `closes` (time, kind, fee) into a record whose weeks run from the week of `from` to the
/// week of `now`, the newest [`MAX_WEEKS`] of them. A close before `from` counts in the total and
/// in the first week; one after `now` (a block dated ahead of the clock) in the last.
fn record(closes: impl Iterator<Item = (u64, Kind, Option<u64>)>, from: u64, now: u64) -> Record {
    let last = week_of(now.max(from));
    let first = week_of(from).max(last.saturating_sub((MAX_WEEKS as u64 - 1) * WEEK));
    let count = usize::try_from((last - first) / WEEK + 1).unwrap_or(MAX_WEEKS);
    let mut weeks: Vec<Week> = (0..count as u64)
        .map(|i| Week {
            time: first + i * WEEK,
            closes: [0; 4],
        })
        .collect();
    let mut total = Tally::default();
    for (time, kind, fee) in closes {
        total.add(kind, fee);
        let i = usize::try_from(week_of(time).clamp(first, last).saturating_sub(first) / WEEK)
            .unwrap_or(usize::MAX);
        if let Some(n) = weeks
            .get_mut(i)
            .and_then(|w| w.closes.get_mut(kind as usize))
        {
            *n = n.saturating_add(1);
        }
    }
    Record { total, weeks }
}

/// One of a node's closed channels, as its record reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloseRow {
    /// The channel's other end; the node itself on a stored row whose two ends are the same.
    pub peer: [u8; 33],
    /// The closing block's time.
    pub time: u64,
    /// A force close whose revocation sweep was seen counted as a penalty.
    pub kind: Kind,
    pub fee: Option<u64>,
}

/// The record of `node` from its closed rows (`db::node_close_rows`), weeks from `from` to `now`,
/// and its closes with each other end, every one of them. A row whose other end is the node itself
/// counts in the record and lists no peer.
pub fn node(node: &[u8; 33], rows: &[CloseRow], from: u64, now: u64) -> NodeRecord {
    let record = record(rows.iter().map(|r| (r.time, r.kind, r.fee)), from, now);
    let mut peers: HashMap<[u8; 33], [u32; 4]> = HashMap::new();
    for r in rows.iter().filter(|r| r.peer != *node) {
        if let Some(n) = peers.entry(r.peer).or_default().get_mut(r.kind as usize) {
            *n = n.saturating_add(1);
        }
    }
    let mut peers: Vec<Peer> = peers
        .into_iter()
        .map(|(id, closes)| Peer { id, closes })
        .collect();
    peers.sort_unstable_by(|a, b| {
        b.forced()
            .cmp(&a.forced())
            .then(b.total().cmp(&a.total()))
            .then(a.id.cmp(&b.id))
    });
    NodeRecord { record, peers }
}

/// The network's record from `from` to `now`, from the overview's rows: each closed channel once.
pub fn network(rows: &[Row], from: u64, now: u64) -> Record {
    record(
        rows.iter()
            .filter_map(|r| r.close.map(|(t, k)| (t, k, r.fee))),
        from,
        now,
    )
}

/// The oldest close among the overview's rows.
pub fn first_close(rows: &[Row]) -> Option<u64> {
    rows.iter().filter_map(|r| r.close.map(|c| c.0)).min()
}

/// Each kind's share of `closes`, in percent to one decimal, or `None` below [`MINIMUM`] closes:
/// a share of a handful of closes would read as a rate it is not.
pub fn shares(closes: &[u32; 4]) -> Option<[f64; 4]> {
    let total = closes.iter().fold(0u32, |a, n| a.saturating_add(*n));
    if total < MINIMUM {
        return None;
    }
    Some(closes.map(|n| (f64::from(n) * 1_000.0 / f64::from(total)).round() / 10.0))
}
