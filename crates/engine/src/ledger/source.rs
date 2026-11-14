//! What the ledger reads from the node.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bitcoin::{BlockHash, Script};
use node::electrum::history::{self as list, Row};
use node::esplora::model::{ScriptInfo, TxSummary};
use node::esplora::{self, Esplora, Route, ScriptRef, ScriptSize};
use node::rpc::model::PrevoutBlock;
use node::rpc::{self, Rpc};
use tokio::sync::mpsc;

use super::{At, Totals};
use crate::mempool::{SourceError, esplora_err, rpc_err};

/// Everything [`super::follow`] and [`super::seed`] read from the node. [`NodeSource`] is the real
/// one; tests mock it. Each method makes its calls one after another.
pub trait Source: Send + Sync + 'static {
    /// The node's best height.
    fn height(&self) -> impl Future<Output = Result<u32, SourceError>> + Send;
    /// The best chain's block at `height`; `None` past the tip.
    fn at(&self, height: u32) -> impl Future<Output = Result<Option<At>, SourceError>> + Send;
    /// The block with every input's spent output.
    fn block(
        &self,
        hash: BlockHash,
    ) -> impl Future<Output = Result<PrevoutBlock, SourceError>> + Send;
    /// The script's confirmed totals as of block `at`, or the node's size refusal with the counts
    /// it gave. The one call that can take the node minutes.
    fn totals(
        &self,
        script: &Script,
        at: BlockHash,
    ) -> impl Future<Output = Result<Result<Totals, Option<ScriptSize>>, SourceError>> + Send;
    /// The script's newest page of confirmed history as of block `at`, newest first.
    fn page(
        &self,
        script: &Script,
        at: BlockHash,
    ) -> impl Future<Output = Result<Vec<TxSummary>, SourceError>> + Send;
    /// The script's whole confirmed history as of block `at`, in the node's order (height, then
    /// txid bytes, ascending), sent to `rows` in batches as it arrives; or the node's size refusal.
    /// A closed `rows` stops it with an error.
    fn history(
        &self,
        script: &Script,
        at: At,
        rows: mpsc::Sender<Vec<Row>>,
    ) -> impl Future<Output = Result<Result<(), Option<ScriptSize>>, SourceError>> + Send;
}

/// The node over JSON-RPC (heights, hashes, `getblock` verbosity 3), Esplora (totals and the
/// history page, pinned with `?asof=`) and Electrum (the whole history list, on a connection of its
/// own). Give it clients of its own: one RPC slot with a timeout that fits a full block, and an
/// Esplora client whose timeout fits a seed.
#[derive(Clone)]
pub struct NodeSource {
    pub rpc: Rpc,
    pub esplora: Esplora,
    /// `host:port` of the node's Electrum server.
    pub electrum: String,
    /// Whether the node's Esplora socket adds totals up above its `--max-sh-creates` (rbitcoin PR
    /// 1628): then [`Source::totals`] asks that route. Set by [`NodeSource::detect`]; false until
    /// then, and always over TCP.
    pub uncapped: Arc<AtomicBool>,
}

/// How long [`NodeSource::detect`] waits for the node.
pub const DETECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the whole history list may take, as a seed (the server's lane holds it that long).
pub const HISTORY_TIMEOUT: Duration = Duration::from_secs(900);
/// Rows handed on at a time: about 360 KB in memory, two batches waiting at most.
pub const HISTORY_BATCH: usize = 10_000;

/// A script as the address routes take it. The scripthash form is used, so any script works,
/// whether or not it has an address.
fn script_ref(script: &Script) -> ScriptRef {
    ScriptRef::ScriptHash(esplora::ScriptHash::from_script(script))
}

/// The answer must be stamped with the block asked for: anything else is not pinned there.
fn pinned<T>(s: esplora::Stamped<T>, at: BlockHash) -> Result<T, SourceError> {
    match s.tip {
        Some(t) if t.hash == at => Ok(s.value),
        _ => Err(SourceError::Failed(
            "answer not pinned to the block asked".into(),
        )),
    }
}

impl NodeSource {
    /// Asks the node whether its socket serves the uncapped totals route, for a scripthash no
    /// script has (all zeros), which runs no join: `200` it does, `404` it does not (a node
    /// without the route does not know the path). Anything else, or no answer within
    /// [`DETECT_TIMEOUT`], leaves what was known and gives `None`. Over TCP the route never
    /// exists, so nothing is asked.
    pub async fn detect(&self) -> Option<bool> {
        if !self.esplora.has_internal() {
            return None;
        }
        let route = Route::InternalScriptStats {
            script: ScriptRef::ScriptHash(esplora::ScriptHash::from_byte_array([0; 32])),
            asof: None,
        };
        let raw = tokio::time::timeout(DETECT_TIMEOUT, self.esplora.raw(&route))
            .await
            .ok()?
            .ok()?;
        let has = match raw.status.as_u16() {
            200 => true,
            404 => false,
            _ => return None,
        };
        self.uncapped.store(has, Ordering::Relaxed);
        Some(has)
    }
}

/// A totals answer pinned to `at`, or the node's size refusal.
fn totals_at(
    raw: esplora::RawResponse,
    at: BlockHash,
) -> Result<Result<Totals, Option<ScriptSize>>, SourceError> {
    if raw.status.as_u16() != 200 {
        return match esplora::Error::from_status(raw.status, &raw.body) {
            esplora::Error::TooLarge => Ok(Err(ScriptSize::from_refusal(&raw.body))),
            e => Err(esplora_err(e)),
        };
    }
    let info: ScriptInfo = serde_json::from_slice(&raw.body)
        .map_err(|e| SourceError::Failed(format!("totals: {e}")))?;
    let stamped = esplora::Stamped {
        value: info,
        tip: raw.tip,
    };
    Ok(Ok(pinned(stamped, at)?.chain_stats.into()))
}

impl Source for NodeSource {
    async fn height(&self) -> Result<u32, SourceError> {
        Ok(self.rpc.blockchain_info().await.map_err(rpc_err)?.blocks)
    }

    async fn at(&self, height: u32) -> Result<Option<At>, SourceError> {
        let hash = match self.rpc.block_hash(height).await {
            Ok(h) => h,
            Err(rpc::Error::Rpc { code: -8, .. }) => return Ok(None),
            Err(e) => return Err(rpc_err(e)),
        };
        let header = match self.rpc.block_header(hash).await {
            Ok(h) => h,
            // Reorged away between the two calls.
            Err(rpc::Error::Rpc { code: -5, .. }) => return Ok(None),
            Err(e) => return Err(rpc_err(e)),
        };
        if header.confirmations < 0 || header.height != height {
            return Ok(None);
        }
        Ok(Some(At {
            height,
            hash,
            time: header.time,
        }))
    }

    async fn block(&self, hash: BlockHash) -> Result<PrevoutBlock, SourceError> {
        self.rpc.block_with_prevouts(hash).await.map_err(rpc_err)
    }

    async fn totals(
        &self,
        script: &Script,
        at: BlockHash,
    ) -> Result<Result<Totals, Option<ScriptSize>>, SourceError> {
        let asof = Some(at);
        if self.uncapped.load(Ordering::Relaxed) {
            let route = Route::InternalScriptStats {
                script: script_ref(script),
                asof,
            };
            let raw = self.esplora.raw(&route).await.map_err(esplora_err)?;
            // A 404 is a block the node does not know, or a node without the route since the last
            // probe: asked again, only the latter goes to the capped route.
            if raw.status.as_u16() != 404 || self.detect().await != Some(false) {
                return totals_at(raw, at);
            }
        }
        let route = Route::ScriptStats {
            script: script_ref(script),
            asof,
        };
        totals_at(self.esplora.raw(&route).await.map_err(esplora_err)?, at)
    }

    async fn page(&self, script: &Script, at: BlockHash) -> Result<Vec<TxSummary>, SourceError> {
        let s = self
            .esplora
            .script_txs_summary(script_ref(script), None, Some(at))
            .await
            .map_err(esplora_err)?;
        pinned(s, at)
    }

    async fn history(
        &self,
        script: &Script,
        at: At,
        rows: mpsc::Sender<Vec<Row>>,
    ) -> Result<Result<(), Option<ScriptSize>>, SourceError> {
        let addr = self.electrum.clone();
        let sh =
            node::electrum::ScriptHash(esplora::ScriptHash::from_script(script).to_byte_array());
        let read = tokio::task::spawn_blocking(move || {
            list::list(
                &addr,
                &sh,
                at.hash,
                at.height,
                HISTORY_TIMEOUT,
                HISTORY_BATCH,
                &mut |b| rows.blocking_send(b).is_ok(),
            )
        });
        match read.await {
            Ok(Ok(_)) => Ok(Ok(())),
            Ok(Err(node::electrum::Error::Server { message, .. }))
                if message.starts_with("scripthash join exceeds --max-sh-creates") =>
            {
                Ok(Err(ScriptSize::from_refusal(message.as_bytes())))
            }
            Ok(Err(node::electrum::Error::Timeout)) => {
                Err(SourceError::Failed("history list timed out".into()))
            }
            Ok(Err(e)) => Err(SourceError::Failed(format!("history list: {e}"))),
            Err(_) => Err(SourceError::Failed("history list task ended".into())),
        }
    }
}
