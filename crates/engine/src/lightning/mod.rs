//! What the Lightning gossip peer observes live, kept in the store: every channel's open and
//! close (`ln_channels`), and the network's totals every ten minutes (`ln_statistics`), rolled
//! into hours and days as they age. Tables, bounds and timings: `docs/STORE.md`.
//!
//! The engine does not depend on the `ln` crate: the server turns the peer's history records
//! into [`Change`]s and its graph into [`Stats`].

mod db;
pub mod fees;
mod graph;
pub mod overview;
mod sampler;

pub use db::{
    InBlock, apply, apply_from, at, by_txids, channel, closed, continued, in_block, insert, latest,
    lineage, node_closed, node_closes, node_spans, opened, past, penalties, record, series,
    set_funding, unfunded,
};
pub use graph::{
    Announcement, Bucket, GraphChannel, GraphNode, Inbound, Index, Link, Node, NodePast, NodePoint,
    Past, Policy, RANKED, Rank, Span, bucket, node_series,
};
pub use sampler::{Config, Event, Skip, run};

use bitcoin::{BlockHash, Txid};

pub use crate::history::{DAY, HOUR, Interval, KEEP_HOURS, KEEP_MINUTES, Level, MINUTE, unix_now};

/// Seconds between two snapshots, and what a level-0 row covers.
pub const EVERY: u64 = 10 * MINUTE;

/// A block, as a channel's open or close names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Block {
    pub height: u32,
    pub hash: BlockHash,
    /// The header's time, Unix seconds.
    pub time: u64,
}

/// How a channel closed (`docs/LIGHTNING.md`, "How a close is classified").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Cooperative = 0,
    Force = 1,
    Penalty = 2,
    Other = 3,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Cooperative => "cooperative",
            Self::Force => "force",
            Self::Penalty => "penalty",
            Self::Other => "other",
        }
    }

    fn from_code(code: i64) -> Option<Self> {
        Some(match code {
            0 => Self::Cooperative,
            1 => Self::Force,
            2 => Self::Penalty,
            3 => Self::Other,
            _ => return None,
        })
    }
}

/// A channel the peer verified: its funding output unspent and six deep.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Open {
    pub scid: u64,
    /// Compressed public keys, in the announcement's order.
    pub node_one: [u8; 33],
    pub node_two: [u8; 33],
    pub capacity: u64,
    /// The funding block. Its height is the short channel id's.
    pub block: Block,
}

/// Where and how a channel's funding output was spent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Close {
    pub block: Block,
    pub txid: Txid,
    pub kind: Kind,
    /// The closing transaction's fee, sats, when known.
    pub fee: Option<u64>,
}

/// A revocation sweep: the force close was a breach.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Penalty {
    pub block: Block,
    pub txid: Txid,
}

/// One record of the peer's history, as the table applies it. Applying the same records again,
/// or the opens of a later run, leaves the table as it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// The channel is open: any close stored for it left the chain.
    Opened(Open),
    Closed(Open, Close),
    Penalty(u64, Penalty),
    /// The funding block left the chain: the row goes. An `Opened` follows if the output is
    /// still at its position.
    OpenUndone(u64),
    /// The closing block left the chain: the channel is open again.
    CloseUndone(u64),
    /// The sweep's block left the chain: the close is a plain force close again.
    PenaltyUndone(u64),
}

/// A stored channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Channel {
    pub open: Open,
    pub close: Option<Close>,
    pub penalty: Option<Penalty>,
    /// The funding transaction, once asked of the node ([`unfunded`], [`set_funding`]).
    pub funding_txid: Option<Txid>,
}

/// The network as one snapshot of the verified graph saw it, or several snapshots' values
/// summed. A mean is a sum over the samples; a median field holds the snapshots' medians summed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    pub channels: u64,
    pub nodes: u64,
    /// Sats.
    pub capacity: u64,
    pub tor_nodes: u64,
    pub clearnet_nodes: u64,
    pub clearnet_tor_nodes: u64,
    pub unannounced_nodes: u64,
    pub med_capacity: u64,
    /// Channel policies, one per direction announced.
    pub policies: u64,
    /// Fee rates (ppm) and base fees (msat) summed over the policies.
    pub fee_rate: u64,
    pub base_fee: u64,
    pub med_fee_rate: u64,
    pub med_base_fee: u64,
}

impl Stats {
    /// The values in the table's column order.
    fn values(&self) -> [u64; 13] {
        [
            self.channels,
            self.nodes,
            self.capacity,
            self.tor_nodes,
            self.clearnet_nodes,
            self.clearnet_tor_nodes,
            self.unannounced_nodes,
            self.med_capacity,
            self.policies,
            self.fee_rate,
            self.base_fee,
            self.med_fee_rate,
            self.med_base_fee,
        ]
    }

    fn from_values(v: [u64; 13]) -> Self {
        let [
            channels,
            nodes,
            capacity,
            tor_nodes,
            clearnet_nodes,
            clearnet_tor_nodes,
            unannounced_nodes,
            med_capacity,
            policies,
            fee_rate,
            base_fee,
            med_fee_rate,
            med_base_fee,
        ] = v;
        Self {
            channels,
            nodes,
            capacity,
            tor_nodes,
            clearnet_nodes,
            clearnet_tor_nodes,
            unannounced_nodes,
            med_capacity,
            policies,
            fee_rate,
            base_fee,
            med_fee_rate,
            med_base_fee,
        }
    }
}

/// The middle value of `v`, the lower of the two middle ones for an even count; 0 when empty.
/// Sorts `v`.
pub fn median(v: &mut [u64]) -> u64 {
    v.sort_unstable();
    v.get(v.len().saturating_sub(1) / 2).copied().unwrap_or(0)
}

/// One stored row, or one point of a series: `sums` over `samples` snapshots.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Point {
    /// Unix seconds: the snapshot's ten minutes, or the start of the row's or point's period.
    pub time: u64,
    pub samples: u64,
    pub sums: Stats,
}

impl Point {
    /// The mean of a summed field over the point's snapshots.
    pub fn mean(&self, sum: u64) -> f64 {
        sum as f64 / self.samples.max(1) as f64
    }
}

/// A period's points and how much of it was sampled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Series {
    pub from: u64,
    pub to: u64,
    /// Seconds per point; each point's `time` is the start of its step.
    pub step: u64,
    /// Oldest first. A step with no snapshot has no point.
    pub points: Vec<Point>,
    /// The oldest stored row's time. `None` with nothing stored.
    pub first: Option<u64>,
    /// Snapshots stored from `from` to the last whole ten minutes before `to`, and how many that
    /// period holds.
    pub sampled: u64,
    pub slots: u64,
}

impl Series {
    /// Every snapshot of the period was taken.
    pub fn complete(&self) -> bool {
        self.slots > 0 && self.sampled >= self.slots
    }

    pub fn earliest(&self) -> Option<u64> {
        self.points.first().map(|p| p.time)
    }
}

#[cfg(test)]
mod tests;
