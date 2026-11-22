//! What the block table reads from the node.

use std::future::Future;
use std::sync::Arc;

use bitcoin::{BlockHash, Transaction};
use node::esplora::Esplora;
use node::rpc::{self, Rpc};

use super::Lister;
use super::stats::{self, Facts};
use super::{Error, Row, SourceError};
use crate::mempool::{esplora_err, rpc_err};

const BLOCK_PRUNED: &str = "Block not available (pruned data)";

/// A block as Esplora's `/blocks` lists it: identity, time, size and difficulty.
pub type Header = node::esplora::model::Block;

/// Everything [`super::follow`] and [`super::backfill`] read from the node. [`NodeSource`] is
/// the real one; tests mock it. Each method makes its node calls one after another, never two
/// at once, so a caller that awaits one method at a time has at most one call in flight.
pub trait Source: Send + Sync + 'static {
    /// Best height and optional inclusive prune watermark, read together for backfill.
    fn chain_state(&self) -> impl Future<Output = Result<(u32, Option<u32>), SourceError>> + Send;

    /// Up to ten blocks, newest first, from `top` down (from the tip when `None`).
    fn headers(
        &self,
        top: Option<u32>,
    ) -> impl Future<Output = Result<Vec<Header>, SourceError>> + Send;
    /// Rows without fee rates for these blocks, in the same order.
    fn rows(&self, headers: &[Header]) -> impl Future<Output = Result<Vec<Row>, Error>> + Send;
    /// The block's fee facts; `None` when the node does not know the block.
    fn facts(
        &self,
        height: u32,
        hash: BlockHash,
    ) -> impl Future<Output = Result<Option<Facts>, Error>> + Send;
    /// Response bytes read so far, for cost accounting.
    fn bytes(&self) -> u64 {
        0
    }
}

/// The node over Esplora (headers, coinbase txids, block listings) and JSON-RPC (totals,
/// coinbases, and blocks where the node has no listing route). Give it its own RPC client with
/// one slot (`max_concurrent: 1`), so it can never take the slots the mempool tracker and the
/// summary routes share.
#[derive(Clone)]
pub struct NodeSource {
    pub rpc: Rpc,
    pub esplora: Esplora,
    /// The network's, shared with the summaries.
    pub lister: Arc<Lister>,
}

impl NodeSource {
    /// The block's coinbase. The node will not look up the genesis coinbase by txid, so that one
    /// comes from the block itself (285 bytes).
    async fn genesis_coinbase(&self, hash: BlockHash) -> Result<Transaction, Error> {
        let block = self
            .esplora
            .block_raw(hash)
            .await
            .map_err(|error| match error {
                // Esplora gives the same status for a pruned body and an unknown hash.
                node::esplora::Error::NotFound => Error::Pruned(0),
                error => esplora_err(error).into(),
            })?
            .value;
        block
            .txdata
            .into_iter()
            .next()
            .ok_or_else(|| SourceError::Failed("block without transactions".into()).into())
    }
}

impl Source for NodeSource {
    async fn chain_state(&self) -> Result<(u32, Option<u32>), SourceError> {
        let info = self.rpc.blockchain_info().await.map_err(rpc_err)?;
        Ok((info.blocks, info.pruneheight))
    }

    async fn headers(&self, top: Option<u32>) -> Result<Vec<Header>, SourceError> {
        Ok(self.esplora.blocks(top).await.map_err(esplora_err)?.value)
    }

    async fn rows(&self, headers: &[Header]) -> Result<Vec<Row>, Error> {
        if headers.is_empty() {
            return Ok(Vec::new());
        }
        let hashes: Vec<BlockHash> = headers.iter().map(|h| h.id).collect();
        let totals = self.rpc.block_totals(&hashes).await.map_err(rpc_err)?;
        let totals = headers
            .iter()
            .zip(totals)
            .map(|(header, stats)| stats.map_err(|e| body_error(e, header.height, BLOCK_PRUNED)))
            .collect::<Result<Vec<_>, _>>()?;
        let mut txids = Vec::with_capacity(headers.len());
        for h in headers {
            txids.push(
                self.esplora
                    .block_txid(h.id, 0)
                    .await
                    .map_err(esplora_err)?
                    .value,
            );
        }
        let txs = self.rpc.raw_transactions(&txids).await.map_err(rpc_err)?;
        let mut rows = Vec::with_capacity(headers.len());
        for (((header, totals), txid), tx) in headers.iter().zip(totals).zip(txids).zip(txs) {
            let tx = match tx {
                Ok(tx) => tx,
                Err(_) if header.height == 0 => self.genesis_coinbase(header.id).await?,
                Err(e) => {
                    return Err(body_error(
                        e,
                        header.height,
                        "Transaction not available (pruned data)",
                    ));
                }
            };
            if tx.compute_txid() != txid || !tx.is_coinbase() {
                return Err(SourceError::Failed("not the block's coinbase".into()).into());
            }
            rows.push(Row::new(header, &totals, &tx));
        }
        Ok(rows)
    }

    async fn facts(&self, height: u32, hash: BlockHash) -> Result<Option<Facts>, Error> {
        match self.lister.block(&self.rpc, &self.esplora, hash).await.0 {
            Ok(b) if b.hash == hash => Ok(Some(stats::facts(&b))),
            Ok(_) => Err(SourceError::Failed("a different block than asked".into()).into()),
            Err(rpc::Error::Rpc { code: -5, .. }) => Ok(None),
            Err(e) => Err(body_error(e, height, BLOCK_PRUNED)),
        }
    }

    fn bytes(&self) -> u64 {
        self.rpc.bytes_received() + self.esplora.bytes_received()
    }
}

fn body_error(error: rpc::Error, height: u32, prune_message: &str) -> Error {
    match error {
        rpc::Error::Rpc { code: -8, message } if message == prune_message => Error::Pruned(height),
        error => rpc_err(error).into(),
    }
}
