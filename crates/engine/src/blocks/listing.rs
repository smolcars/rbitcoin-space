//! A block's transactions with each one's txid, fee, weight and output value: what the block
//! summaries, the audit and the fee-rate backfill read (`docs/RBITCOIN.md`).
//!
//! The node lists them at Esplora's `/block/:hash/txs/summary`, about 0.2 MB for a full mainnet
//! block. A block the route fails on (one off the best chain, a timeout, an answer that disagrees
//! with the block's header) is listed by `getblock` at verbosity 2, about 10 MB, which gives the
//! same [`Block`].

use bitcoin::BlockHash;
use node::esplora::{self, Esplora};
use node::rpc::model::{Block, BlockTx, Coinbase};
use node::rpc::{self, Rpc};

/// Where a block's transactions came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    /// Esplora's `/block/:hash/txs/summary`, with the block's header and coinbase beside it.
    Route,
    /// JSON-RPC `getblock` at verbosity 2.
    GetBlock,
}

impl Via {
    /// A fixed label for logs.
    pub fn label(self) -> &'static str {
        match self {
            Self::Route => "summary_route",
            Self::GetBlock => "getblock",
        }
    }
}

/// Lists a network's blocks. One per network, shared by everything that lists them.
pub struct Lister {
    getblock_only: bool,
    /// Told why the route failed for a block that was then listed by `getblock`.
    fell_back: Box<dyn Fn(&'static str) + Send + Sync>,
}

impl std::fmt::Debug for Lister {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lister")
            .field("getblock_only", &self.getblock_only)
            .finish()
    }
}

impl Default for Lister {
    fn default() -> Self {
        Self::new(|_| {})
    }
}

impl Lister {
    pub fn new(fell_back: impl Fn(&'static str) + Send + Sync + 'static) -> Self {
        Self {
            getblock_only: false,
            fell_back: Box::new(fell_back),
        }
    }

    /// Lists every block through `via` and reports nothing: for measurements and tests that
    /// compare the two. [`Via::Route`] still falls back for a block the route fails on.
    pub fn fixed(via: Via) -> Self {
        Self {
            getblock_only: via == Via::GetBlock,
            ..Self::default()
        }
    }

    /// The block, from the route, or from `getblock` when the route fails for it. The errors are
    /// `getblock`'s.
    pub async fn block(
        &self,
        rpc: &Rpc,
        esplora: &Esplora,
        hash: BlockHash,
    ) -> (Result<Block, rpc::Error>, Via) {
        if !self.getblock_only {
            match from_route(esplora, hash).await {
                Ok(block) => return (Ok(block), Via::Route),
                Err(reason) => (self.fell_back)(reason),
            }
        }
        (rpc.block(hash).await, Via::GetBlock)
    }
}

fn failed(e: &esplora::Error) -> &'static str {
    match e {
        esplora::Error::Rejected { .. } => "refused",
        esplora::Error::NotFound => "not_found",
        esplora::Error::ResponseTooBig => "too_big",
        esplora::Error::Decode(_) => "malformed",
        _ => "unavailable",
    }
}

/// The block as `getblock` would give it, from the route, the block's Esplora header (height,
/// times, sizes, parent) and its coinbase (who mined it): three small calls. The header and
/// coinbase must agree with the rows, or the block is listed by `getblock` instead.
async fn from_route(esplora: &Esplora, hash: BlockHash) -> Result<Block, &'static str> {
    let rows = esplora
        .block_txs_summary(hash)
        .await
        .map_err(|e| failed(&e))?
        .value;
    let first = rows.first().ok_or("malformed")?;
    // A refusal here is not the route's: the node answered it a moment ago.
    let other = |e: esplora::Error| match failed(&e) {
        "refused" => "unavailable",
        m => m,
    };
    let header = esplora.block(hash).await.map_err(other)?.value;
    let coinbase = esplora.tx_raw(first.txid).await.map_err(other)?.value;
    let mismatch = "mismatch";
    if header.id != hash
        || usize::try_from(header.tx_count) != Ok(rows.len())
        || coinbase.compute_txid() != first.txid
        || !coinbase.is_coinbase()
    {
        return Err(mismatch);
    }
    let (Ok(time), Ok(mediantime)) = (
        u32::try_from(header.timestamp),
        u32::try_from(header.mediantime),
    ) else {
        return Err("malformed");
    };
    let tx = rows
        .iter()
        .enumerate()
        .map(|(i, r)| BlockTx {
            txid: r.txid,
            // `getblock` gives the coinbase no fee; the route gives it 0.
            fee: (i > 0).then_some(r.fee),
            // BIP141 virtual size, not sigop-adjusted: what `getblock` gives as `vsize`.
            vsize: r.weight.div_ceil(4),
            weight: r.weight,
            value: r.value,
        })
        .collect();
    let script = coinbase
        .input
        .into_iter()
        .next()
        .map(|i| i.script_sig)
        .unwrap_or_default();
    Ok(Block {
        hash,
        height: header.height,
        time,
        mediantime,
        size: header.size,
        weight: header.weight,
        previousblockhash: header.previousblockhash,
        tx,
        coinbase: Coinbase {
            script,
            outputs: coinbase.output,
        },
    })
}
