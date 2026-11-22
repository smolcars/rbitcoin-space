//! The block table: one row per block on the best chain, with what the mining dashboard and the
//! history charts need, kept in the network's [`Store`] (`docs/STORE.md`, "blocks").
//!
//! - [`follow`] keeps the newest [`ZONE`] rows in line with the node on every new tip, replacing
//!   rows a reorg made stale, and takes the newest blocks' fee rates from the summary cache.
//! - [`backfill`] fills older rows the node can still serve, newest first, in two tiers: totals
//!   and coinbase (cheap, batched), then fee rates for the recent ones (one block listing each,
//!   through [`Lister`]).
//! - [`by_hash`], [`by_height`], [`page`], [`periods`] and [`heights_between`] read it; the
//!   mining routes read it through [`span`], [`pool_counts`], [`pool_page`] and the rest of
//!   `mining.rs`, and [`reattribute`] redoes its pool column when the pool list changes.
//!
//! The table itself is the backfill's progress: nothing else records how far it got, so a
//! restart redoes no work and a deleted file is rebuilt from the node.

mod backfill;
mod db;
mod follow;
pub mod listing;
mod mining;
mod source;
pub mod stats;
#[cfg(test)]
mod tests;
mod totals;

use bitcoin::{Amount, BlockHash, ScriptBuf, Transaction, TxOut};
use node::rpc::model::BlockTotals;

pub use crate::mempool::SourceError;
use crate::mining::sv2;
use crate::projected::Bands;
use crate::store;
pub use backfill::{Event, Options, Progress, backfill};
pub use db::{
    Bucket, MAX_PAGE, Period, by_hash, by_hashes, by_height, heights_between, page, periods,
    pool_page,
};
pub use follow::{Followed, Reorgs, follow};
pub use listing::Lister;
pub use mining::{
    PoolCount, PoolWeek, Reattributed, Retarget, Span, WEEK, WEEK_OFFSET, Work, at_or_before,
    first_since, pool_counts, pool_weeks, reattribute, retargets, row_counts, span, top, work,
};
pub use source::{Header, NodeSource, Source};
pub use stats::{Facts, Miner, Rates};
pub(crate) use totals::settle;
pub use totals::{FILL, Filled, fill_totals, totals_ready};

/// The newest blocks [`follow`] owns: it checks their rows against the node on every new tip.
/// The backfill writes only below them, so a reorg up to this deep never races it.
pub const ZONE: u32 = 100;
/// The newest blocks whose fee rates [`follow`] takes from the summaries the server computes
/// for them anyway; the backfill rates only blocks below them.
pub const RATED_BY_FOLLOW: u32 = 10;
/// Longest coinbase tag kept. Consensus caps the coinbase script at 100 bytes already.
pub const MAX_TAG: usize = 100;
/// Most payout scripts kept per block, in output order.
pub const MAX_PAYOUTS: usize = 8;
/// Longest payout script kept; a longer one is no address and is left out. P2PK with an
/// uncompressed key, the longest common payout, is 67 bytes.
pub const MAX_SCRIPT: usize = 128;

/// One block's row.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub height: u32,
    pub hash: BlockHash,
    /// Header timestamp, Unix seconds.
    pub time: u64,
    /// Every transaction, the coinbase included.
    pub tx_count: u32,
    pub size: u64,
    pub weight: u64,
    /// Weight of every transaction but the coinbase, as [`Facts::weight`].
    pub paying_weight: u64,
    /// Sats, as are `subsidy` and `reward`.
    pub fees: u64,
    pub subsidy: u64,
    /// The coinbase's outputs summed: what the miner took, which may be less than subsidy and fees.
    pub reward: u64,
    pub difficulty: f64,
    pub coinbase: Coinbase,
    /// `None` until the fee rates are known: the row's completeness.
    pub rates: Option<Rated>,
}

/// What the pool-attribution task needs from the coinbase. Chain data, written by whoever mined
/// the block: bounded here, stored as bytes and never interpreted.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Coinbase {
    /// The coinbase input's script, at most [`MAX_TAG`] bytes.
    pub tag: Vec<u8>,
    /// Scripts of the outputs paying more than zero, at most [`MAX_PAYOUTS`] of at most
    /// [`MAX_SCRIPT`] bytes each, in output order.
    pub payouts: Vec<ScriptBuf>,
}

/// A block's fee rates, from its every transaction.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rated {
    /// `None` for a block holding only its coinbase.
    pub fee_rate: Option<Rates>,
    pub fee_bands: Bands,
}

impl From<&Facts> for Rated {
    fn from(f: &Facts) -> Self {
        Self {
            fee_rate: f.fee_rate,
            fee_bands: f.fee_bands,
        }
    }
}

impl Row {
    /// A row without fee rates, from Esplora's block, the node's totals and the coinbase.
    pub fn new(header: &Header, totals: &BlockTotals, coinbase: &Transaction) -> Self {
        Self {
            height: header.height,
            hash: header.id,
            time: header.timestamp,
            tx_count: header.tx_count,
            size: header.size,
            weight: header.weight,
            paying_weight: totals.total_weight,
            fees: totals.totalfee.to_sat(),
            subsidy: totals.subsidy.to_sat(),
            reward: coinbase
                .output
                .iter()
                .fold(0, |sum: u64, o| sum.saturating_add(o.value.to_sat())),
            difficulty: header.difficulty,
            coinbase: Coinbase::new(coinbase),
            rates: None,
        }
    }

    /// The block's facts as `/app/block/{hash}/summary` serves them, once the row is rated.
    pub fn facts(&self) -> Option<Facts> {
        let r = self.rates?;
        Some(Facts {
            id: self.hash,
            height: self.height,
            tx_count: self.tx_count as usize,
            fees: self.fees,
            vsize: r.fee_bands.stored.iter().sum(),
            weight: self.paying_weight,
            fee_rate: r.fee_rate,
            fee_bands: r.fee_bands,
            miner: Miner::of(&self.coinbase),
            sv2: self.coinbase.is_sv2(),
        })
    }
}

impl Coinbase {
    pub fn new(tx: &Transaction) -> Self {
        let tag = tx
            .input
            .first()
            .map_or(&[][..], |i| i.script_sig.as_bytes());
        Self::from_parts(tag, &tx.output)
    }

    /// From the coinbase input's script and the outputs, bounded as [`Coinbase::new`] does.
    pub fn from_parts(tag: &[u8], outputs: &[TxOut]) -> Self {
        Self {
            tag: tag.get(..MAX_TAG).unwrap_or(tag).to_vec(),
            payouts: outputs
                .iter()
                .filter(|o| o.value > Amount::ZERO && o.script_pubkey.len() <= MAX_SCRIPT)
                .take(MAX_PAYOUTS)
                .map(|o| o.script_pubkey.clone())
                .collect(),
        }
    }

    /// Whether the script is laid out as the Stratum V2 reference implementation writes it
    /// ([`sv2::tag`]): the whole script is kept, so a stored row answers as the block does.
    pub fn is_sv2(&self) -> bool {
        sv2::tag(&self.tag).is_some()
    }

    /// Each script as one length byte, then its bytes.
    fn encode_payouts(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for s in &self.payouts {
            // `new` keeps scripts of at most MAX_SCRIPT bytes, so the length fits a byte.
            let Ok(len) = u8::try_from(s.len()) else {
                continue;
            };
            out.push(len);
            out.extend_from_slice(s.as_bytes());
        }
        out
    }

    /// Reads [`Coinbase::encode_payouts`]; a truncated last entry is dropped.
    fn decode_payouts(mut bytes: &[u8]) -> Vec<ScriptBuf> {
        let mut out = Vec::new();
        while let Some((&len, rest)) = bytes.split_first() {
            let Some((script, rest)) = rest.split_at_checked(usize::from(len)) else {
                break;
            };
            out.push(ScriptBuf::from_bytes(script.to_vec()));
            bytes = rest;
        }
        out
    }
}

/// Why following the tip or a backfill step failed.
#[derive(Debug)]
pub enum Error {
    Source(SourceError),
    Store(store::Error),
    /// A body read at this height reported pruned data.
    Pruned(u32),
    /// The tip moved while [`follow`] read the chain; nothing was written. Not a failure: call it
    /// again for the new tip.
    Moved,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Source(SourceError::Busy) => f.write_str("node busy"),
            Self::Source(SourceError::TooBig) => f.write_str("node answer too big"),
            Self::Source(SourceError::Failed(e)) => write!(f, "node: {e}"),
            Self::Store(e) => write!(f, "store: {e}"),
            Self::Pruned(height) => write!(f, "node: block data pruned at height {height}"),
            Self::Moved => f.write_str("the tip moved while reading the chain"),
        }
    }
}

impl std::error::Error for Error {}

impl From<SourceError> for Error {
    fn from(e: SourceError) -> Self {
        Self::Source(e)
    }
}

impl From<store::Error> for Error {
    fn from(e: store::Error) -> Self {
        Self::Store(e)
    }
}

impl Error {
    /// A fixed label for logs: `busy`, `too_big`, `node`, `store` or `moved`.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Source(SourceError::Busy) => "busy",
            Self::Source(SourceError::TooBig) => "too_big",
            Self::Source(SourceError::Failed(_)) | Self::Pruned(_) => "node",
            Self::Store(_) => "store",
            Self::Moved => "moved",
        }
    }
}

/// The block hash as stored: the bitcoin crate's internal byte order.
fn hash_bytes(hash: &BlockHash) -> &[u8; 32] {
    use bitcoin::hashes::Hash;
    hash.as_byte_array()
}
