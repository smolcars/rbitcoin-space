//! Esplora REST client for rbitcoin v0.9.2.
//!
//! Every call names a [`Route`], which can only be built from parsed values. Two ways to call:
//!
//! - [`Esplora::raw`] returns the upstream status, body bytes, content type and chain-tip
//!   stamp without decoding, for the `/api` pass-through.
//! - The typed methods ([`Esplora::tx`], [`Esplora::block`], …) decode into [`model`] types
//!   or `bitcoin` types and map non-200 answers to [`Error`]. Each returns its [`Stamped`] tip.
//!
//! Reads that span several requests use [`consistent`] with a [`TipCheck`] so a tip that
//! moves between them is retried instead of mixed.

mod error;
pub mod model;
mod route;

use std::collections::HashMap;
use std::future::Future;
use std::str::FromStr;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use bitcoin::consensus::Decodable;
use bitcoin::{BlockHash, OutPoint, Transaction, Txid};
use bytes::Bytes;
use hyper::StatusCode;
use hyper::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::de::DeserializeOwned;

pub use crate::http::Endpoint;
pub use error::{Error, ScriptSize};
pub use route::{
    BlockTxsStart, MAX_OUT_POSITIONS, OutPosition, OutPositions, Route, ScriptHash,
    ScriptHashOrder, ScriptRef,
};

use crate::http::Transport;
use model::{
    Block, BlockStatus, BlockTxSummary, FeeEstimates, MempoolInfo, MempoolRecent, MerkleProof,
    Outspend, PositionedOutput, ScriptInfo, Tx, TxStatus, TxSummary, Utxo,
};

/// The view a response was computed against: the live tip, the address-index watermark,
/// or the `?asof=` block. From `X-Bitcoin-Chain-Tip` and `X-Bitcoin-Chain-Tip-Height`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ChainTip {
    pub hash: BlockHash,
    pub height: u32,
}

impl ChainTip {
    /// `None` when the route is unstamped (mempool, fee estimates, broadcast) or a header is malformed.
    fn from_headers(h: &HeaderMap) -> Option<Self> {
        let hash = h.get("x-bitcoin-chain-tip")?.to_str().ok()?.parse().ok()?;
        let height = h
            .get("x-bitcoin-chain-tip-height")?
            .to_str()
            .ok()?
            .parse()
            .ok()?;
        Some(Self { hash, height })
    }
}

/// A decoded value and the chain view it belongs to.
#[derive(Debug, Clone, PartialEq)]
pub struct Stamped<T> {
    pub value: T,
    pub tip: Option<ChainTip>,
}

/// An upstream answer as received, for forwarding without a decode and re-encode.
#[derive(Debug, Clone)]
pub struct RawResponse {
    pub status: StatusCode,
    pub content_type: Option<HeaderValue>,
    pub tip: Option<ChainTip>,
    pub body: Bytes,
}

/// Checks that every stamped response of one multi-request read saw the same chain view.
///
/// Address and scripthash routes are stamped with the address-index watermark, which can
/// trail the live tip that block and transaction routes carry; check them separately.
#[derive(Debug, Default, Clone)]
pub struct TipCheck(Option<ChainTip>);

impl TipCheck {
    /// Returns the value, or [`Error::ChainViewMoved`] if its stamp differs from an earlier one.
    pub fn take<T>(&mut self, s: Stamped<T>) -> Result<T, Error> {
        match (self.0, s.tip) {
            (Some(seen), Some(tip)) if seen != tip => Err(Error::ChainViewMoved),
            (None, tip) => {
                self.0 = tip;
                Ok(s.value)
            }
            _ => Ok(s.value),
        }
    }

    /// The view every stamped response so far agreed on.
    pub fn tip(&self) -> Option<ChainTip> {
        self.0
    }
}

/// How many times [`consistent`] runs a read before giving up.
pub const CONSISTENT_ATTEMPTS: usize = 3;

/// Runs `read` until it does not fail with [`Error::ChainViewMoved`], at most
/// [`CONSISTENT_ATTEMPTS`] times. Inside `read`, pass each result through one [`TipCheck`]:
///
/// ```no_run
/// # async fn f(esplora: &node::esplora::Esplora, hash: bitcoin::BlockHash) -> Result<(), node::esplora::Error> {
/// use node::esplora::{BlockTxsStart, TipCheck, consistent};
/// let (block, txs) = consistent(|| async {
///     let mut tips = TipCheck::default();
///     let block = tips.take(esplora.block(hash).await?)?;
///     let txs = tips.take(esplora.block_txs(hash, BlockTxsStart::FIRST).await?)?;
///     Ok((block, txs))
/// })
/// .await?;
/// # Ok(()) }
/// ```
pub async fn consistent<T, F, Fut>(mut read: F) -> Result<T, Error>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, Error>>,
{
    for _ in 1..CONSISTENT_ATTEMPTS {
        match read().await {
            Err(Error::ChainViewMoved) => continue,
            done => return done,
        }
    }
    read().await
}

/// A totals answer echoes the path's hash as `"scripthash"`. Asked in `sent` order, the hash is
/// given back in digest order, the public form, so the answer is the same whatever the node's
/// build. Anything but exactly one such field is left as it is.
fn echo_in_digest_order(body: Bytes, sh: ScriptHash, sent: ScriptHashOrder) -> Bytes {
    if sent == ScriptHashOrder::Digest {
        return body;
    }
    let field = format!("\"scripthash\":\"{}\"", sh.hex(sent));
    let field = field.as_bytes();
    let mut at = body
        .windows(field.len())
        .enumerate()
        .filter(|(_, w)| *w == field);
    let (Some((i, _)), None) = (at.next(), at.next()) else {
        return body;
    };
    let (Some(head), Some(tail)) = (body.get(..i), body.get(i + field.len()..)) else {
        return body;
    };
    let mut out = Vec::with_capacity(body.len());
    out.extend_from_slice(head);
    out.extend_from_slice(format!("\"scripthash\":\"{}\"", sh.digest_hex()).as_bytes());
    out.extend_from_slice(tail);
    Bytes::from(out)
}

/// A client for one node's Esplora listener. Cheap to clone; clones share the connection pool.
///
/// Every client of one endpoint, clones or not, shares what is known of that node's
/// [`ScriptHashOrder`]: it is a fact about the node, found by [`Esplora::find_scripthash_order`]
/// and set with [`Esplora::set_scripthash_order`]. Until it is known, a route that names a script
/// by its hash fails with [`Error::ScriptHashOrderUnknown`] without asking the node.
#[derive(Clone)]
pub struct Esplora {
    transport: Transport,
    order: Arc<OrderCell>,
}

/// What is known of one node's [`ScriptHashOrder`]: 0 not known, 1 reversed, 2 digest.
#[derive(Debug, Default)]
struct OrderCell(AtomicU8);

/// The cell for `endpoint`, shared by every client made for it in this process.
fn order_cell(endpoint: &Endpoint) -> Arc<OrderCell> {
    static CELLS: OnceLock<Mutex<HashMap<Endpoint, Arc<OrderCell>>>> = OnceLock::new();
    let mut cells = CELLS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    Arc::clone(cells.entry(endpoint.clone()).or_default())
}

/// Blocks [`Esplora::find_scripthash_order`] looks back through, from the address index's
/// position, for a block with transactions besides its coinbase.
const ORDER_PROBE_BLOCKS: usize = 10;
/// Scripts it asks about at most, each in both orders.
const ORDER_PROBE_SCRIPTS: usize = 3;
/// A BIP141 witness commitment: `OP_RETURN`, a 36-byte push, then this tag.
const WITNESS_COMMITMENT: [u8; 6] = [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed];

/// More transactions than a block can hold: the smallest transaction is 60 bytes, 240 weight
/// units, so 4,000,000 weight holds at most 16,666.
pub const MAX_BLOCK_TXS: usize = 20_000;
/// Largest `/block/:hash/txs/summary` answer read: [`MAX_BLOCK_TXS`] rows of at most about 125
/// bytes (a quoted txid, two `u64` and a `u32`). A full mainnet block is about 0.2 MB.
pub const MAX_SUMMARY_BYTES: usize = 4 << 20;
/// Largest `/block/:hash/raw` answer read: a block's serialized size is at most its weight,
/// 4,000,000.
pub const MAX_BLOCK_BYTES: usize = 4_000_000;

impl Esplora {
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
    /// Fits a full block's raw bytes and a large mempool's txid list.
    pub const DEFAULT_MAX_RESPONSE: usize = 64 << 20;

    /// `url` is `{NET}_ESPLORA_URL`: `http://host:port[/base]` or a unix-socket path.
    pub fn new(url: &str) -> Result<Self, Error> {
        Self::with_limits(url, Self::DEFAULT_TIMEOUT, Self::DEFAULT_MAX_RESPONSE)
    }

    /// `timeout` covers connecting, the request and reading the whole body.
    pub fn with_limits(
        url: &str,
        timeout: Duration,
        max_response_bytes: usize,
    ) -> Result<Self, Error> {
        let endpoint = Endpoint::parse(url).map_err(Error::Config)?;
        Ok(Self {
            transport: Transport::new(&endpoint, timeout, max_response_bytes),
            order: order_cell(&endpoint),
        })
    }

    /// The order the node reads `/scripthash/:hash` in, if known.
    pub fn scripthash_order(&self) -> Option<ScriptHashOrder> {
        match self.order.0.load(Ordering::Relaxed) {
            1 => Some(ScriptHashOrder::Reversed),
            2 => Some(ScriptHashOrder::Digest),
            _ => None,
        }
    }

    /// Records the node's order for every client of this endpoint; `None` makes scripthash
    /// routes fail again until it is set. Returns what was known before.
    pub fn set_scripthash_order(&self, order: Option<ScriptHashOrder>) -> Option<ScriptHashOrder> {
        let v = match order {
            None => 0,
            Some(ScriptHashOrder::Reversed) => 1,
            Some(ScriptHashOrder::Digest) => 2,
        };
        match self.order.0.swap(v, Ordering::Relaxed) {
            1 => Some(ScriptHashOrder::Reversed),
            2 => Some(ScriptHashOrder::Digest),
            _ => None,
        }
    }

    /// Asks the node which order it reads `/scripthash/:hash` in, by asking for a script that
    /// certainly has history in both orders: the order whose answer has transactions is the
    /// node's, and the other answers an empty history. Does not record the answer.
    ///
    /// The script is the witness commitment of a recent block's coinbase, which is unique to its
    /// block when the block holds other transactions, so its history is that one transaction:
    /// one index lookup in either order. The block is the address index's own position (the stamp
    /// on a question about [`ScriptHash::NONE_PROBE`]) or up to [`ORDER_PROBE_BLOCKS`] below it, and the
    /// questions are pinned there with `?asof=`, so an index that trails the tip still has it.
    /// Where none of those blocks has one (an empty stretch of a test chain), the newest block's
    /// coinbase output of the largest value is asked instead. A refusal for size counts as
    /// history. `Ok(None)` when nothing decides it: no indexed block but genesis (whose coinbase
    /// is not indexed), or every script answered the same in both orders. When both orders have
    /// history the node reads either, and the digest is chosen. Errors are the node's.
    pub async fn find_scripthash_order(&self) -> Result<Option<ScriptHashOrder>, Error> {
        let none = ScriptRef::ScriptHash(ScriptHash::NONE_PROBE);
        let Some(at) = self.script_stats(none, None).await?.tip else {
            return Ok(None);
        };
        let mut hash = at.hash;
        let mut fallback: Option<bitcoin::ScriptBuf> = None;
        let mut asked = 0;
        for _ in 0..ORDER_PROBE_BLOCKS {
            let block = self.block(hash).await?.value;
            if block.height == 0 {
                break;
            }
            let coinbase = self.tx(self.block_txid(hash, 0).await?.value).await?.value;
            let scripts: Vec<bitcoin::ScriptBuf> = coinbase
                .vout
                .iter()
                .filter_map(|o| bitcoin::ScriptBuf::from_hex(&o.scriptpubkey).ok())
                .collect();
            if fallback.is_none() {
                fallback = coinbase
                    .vout
                    .iter()
                    .zip(&scripts)
                    .max_by_key(|(o, _)| o.value)
                    .map(|(_, s)| s.clone());
            }
            let commitment = scripts
                .iter()
                .find(|s| s.as_bytes().starts_with(&WITNESS_COMMITMENT))
                .or_else(|| scripts.iter().find(|s| s.is_op_return()));
            if block.tx_count > 1
                && let Some(script) = commitment
            {
                asked += 1;
                if let Some(order) = self.order_of(script, at.hash).await? {
                    return Ok(Some(order));
                }
                if asked >= ORDER_PROBE_SCRIPTS {
                    return Ok(None);
                }
            }
            match block.previousblockhash {
                Some(parent) => hash = parent,
                None => break,
            }
        }
        match fallback {
            Some(script) => self.order_of(&script, at.hash).await,
            None => Ok(None),
        }
    }

    /// Which order finds history for `script` at `at`, asking in both.
    async fn order_of(
        &self,
        script: &bitcoin::Script,
        at: BlockHash,
    ) -> Result<Option<ScriptHashOrder>, Error> {
        let route = Route::ScriptStats {
            script: ScriptRef::ScriptHash(ScriptHash::from_script(script)),
            asof: Some(at),
        };
        let mut found = [false; 2];
        for (i, order) in [ScriptHashOrder::Digest, ScriptHashOrder::Reversed]
            .into_iter()
            .enumerate()
        {
            let raw = self.raw_in(&route, order).await?;
            let has = if raw.status == StatusCode::OK {
                let info: ScriptInfo =
                    serde_json::from_slice(&raw.body).map_err(|e| Error::Decode(e.to_string()))?;
                info.chain_stats.tx_count + info.mempool_stats.tx_count > 0
            } else {
                match Error::from_status(raw.status, &raw.body) {
                    Error::TooLarge => true,
                    e => return Err(e),
                }
            };
            if let Some(slot) = found.get_mut(i) {
                *slot = has;
            }
        }
        Ok(match found {
            [true, _] => Some(ScriptHashOrder::Digest),
            [false, true] => Some(ScriptHashOrder::Reversed),
            [false, false] => None,
        })
    }

    /// Response body bytes this client and its clones have read, for cost accounting.
    pub fn bytes_received(&self) -> u64 {
        self.transport.bytes_received()
    }

    /// Whether the `/internal/*` bulk routes can be called: only over a unix socket.
    pub fn has_internal(&self) -> bool {
        self.transport.is_unix()
    }

    /// Calls `route` and returns the answer undecoded, whatever its status.
    /// Errors only on transport failure, timeout or the size cap, and with
    /// [`Error::ScriptHashOrderUnknown`] before the node's scripthash order is known.
    pub async fn raw(&self, route: &Route) -> Result<RawResponse, Error> {
        let order = match self.scripthash_order() {
            Some(order) => order,
            None if route.needs_order() => return Err(Error::ScriptHashOrderUnknown),
            // The path is the same in either.
            None => ScriptHashOrder::Digest,
        };
        self.raw_in(route, order).await
    }

    async fn raw_in(&self, route: &Route, order: ScriptHashOrder) -> Result<RawResponse, Error> {
        if route.is_internal() && !self.has_internal() {
            return Err(Error::InternalUnavailable);
        }
        let mut path = String::with_capacity(160);
        route.write_path(order, &mut path);
        // These routes have a bound of their own, enforced while reading.
        let cap = match route {
            Route::BlockTxsSummary(_) => MAX_SUMMARY_BYTES,
            Route::BlockRaw(_) => MAX_BLOCK_BYTES,
            _ => usize::MAX,
        };
        let res = self
            .transport
            .send_limited(route.method(), &path, route.body(), cap)
            .await?;
        let mut body = res.body;
        if let Route::ScriptStats { .. } | Route::InternalScriptStats { .. } = route
            && let Some(sh) = route.path_script_hash()
        {
            body = echo_in_digest_order(body, sh, order);
        }
        Ok(RawResponse {
            status: res.status,
            content_type: res.headers.get(CONTENT_TYPE).cloned(),
            tip: ChainTip::from_headers(&res.headers),
            body,
        })
    }

    async fn typed<T>(
        &self,
        route: Route,
        decode: impl FnOnce(&[u8]) -> Result<T, Error>,
    ) -> Result<Stamped<T>, Error> {
        let raw = self.raw(&route).await?;
        if raw.status != StatusCode::OK {
            return Err(Error::from_status(raw.status, &raw.body));
        }
        Ok(Stamped {
            value: decode(&raw.body)?,
            tip: raw.tip,
        })
    }

    async fn json<T: DeserializeOwned>(&self, route: Route) -> Result<Stamped<T>, Error> {
        self.typed(route, |b| {
            serde_json::from_slice(b).map_err(|e| Error::Decode(e.to_string()))
        })
        .await
    }

    // Tip and blocks.

    pub async fn tip_height(&self) -> Result<Stamped<u32>, Error> {
        self.typed(Route::TipHeight, parse_text).await
    }

    pub async fn tip_hash(&self) -> Result<Stamped<BlockHash>, Error> {
        self.typed(Route::TipHash, parse_text).await
    }

    /// Ten blocks, newest first, ending at `start_height` (clamped to the tip) or the tip.
    pub async fn blocks(&self, start_height: Option<u32>) -> Result<Stamped<Vec<Block>>, Error> {
        self.json(Route::Blocks { start_height }).await
    }

    pub async fn block_hash(&self, height: u32) -> Result<Stamped<BlockHash>, Error> {
        self.typed(Route::BlockHash(height), parse_text).await
    }

    pub async fn block(&self, hash: BlockHash) -> Result<Stamped<Block>, Error> {
        self.json(Route::Block(hash)).await
    }

    pub async fn block_header(
        &self,
        hash: BlockHash,
    ) -> Result<Stamped<bitcoin::block::Header>, Error> {
        self.typed(Route::BlockHeader(hash), consensus_hex).await
    }

    pub async fn block_status(&self, hash: BlockHash) -> Result<Stamped<BlockStatus>, Error> {
        self.json(Route::BlockStatus(hash)).await
    }

    /// The txid at `index` in the block; index 0 is the coinbase.
    pub async fn block_txid(&self, hash: BlockHash, index: u32) -> Result<Stamped<Txid>, Error> {
        self.typed(Route::BlockTxid { hash, index }, parse_text)
            .await
    }

    pub async fn block_txids(&self, hash: BlockHash) -> Result<Stamped<Vec<Txid>>, Error> {
        self.json(Route::BlockTxids(hash)).await
    }

    /// 25 transactions from `start`.
    pub async fn block_txs(
        &self,
        hash: BlockHash,
        start: BlockTxsStart,
    ) -> Result<Stamped<Vec<Tx>>, Error> {
        self.json(Route::BlockTxs { hash, start }).await
    }

    /// Every transaction's txid, fee, weight and output value, coinbase first: rbitcoin's
    /// `/block/:hash/txs/summary`, newer than v0.9.2. v0.9.2 answers `Rejected` (400); an unknown,
    /// off-best-chain or pruned block is `NotFound`. An answer over [`MAX_SUMMARY_BYTES`] is
    /// `ResponseTooBig`, refused while reading, and one over [`MAX_BLOCK_TXS`] rows a `Decode`
    /// error.
    pub async fn block_txs_summary(
        &self,
        hash: BlockHash,
    ) -> Result<Stamped<Vec<BlockTxSummary>>, Error> {
        self.typed(Route::BlockTxsSummary(hash), |b| {
            let rows: Vec<BlockTxSummary> =
                serde_json::from_slice(b).map_err(|e| Error::Decode(e.to_string()))?;
            if rows.len() > MAX_BLOCK_TXS {
                return Err(Error::Decode(format!("{} rows", rows.len())));
            }
            Ok(rows)
        })
        .await
    }

    /// One over [`MAX_BLOCK_BYTES`] is `ResponseTooBig`, refused before or while reading.
    pub async fn block_raw(&self, hash: BlockHash) -> Result<Stamped<bitcoin::Block>, Error> {
        self.typed(Route::BlockRaw(hash), consensus).await
    }

    // Transactions.

    pub async fn tx(&self, txid: Txid) -> Result<Stamped<Tx>, Error> {
        self.json(Route::Tx(txid)).await
    }

    pub async fn tx_status(
        &self,
        txid: Txid,
        asof: Option<BlockHash>,
    ) -> Result<Stamped<TxStatus>, Error> {
        self.json(Route::TxStatus { txid, asof }).await
    }

    pub async fn tx_hex(&self, txid: Txid) -> Result<Stamped<Transaction>, Error> {
        self.typed(Route::TxHex(txid), consensus_hex).await
    }

    pub async fn tx_raw(&self, txid: Txid) -> Result<Stamped<Transaction>, Error> {
        self.typed(Route::TxRaw(txid), consensus).await
    }

    pub async fn tx_merkle_proof(&self, txid: Txid) -> Result<Stamped<MerkleProof>, Error> {
        self.json(Route::TxMerkleProof(txid)).await
    }

    pub async fn tx_outspend(
        &self,
        txid: Txid,
        vout: u32,
        asof: Option<BlockHash>,
    ) -> Result<Stamped<Outspend>, Error> {
        self.json(Route::TxOutspend { txid, vout, asof }).await
    }

    pub async fn tx_outspends(
        &self,
        txid: Txid,
        asof: Option<BlockHash>,
    ) -> Result<Stamped<Vec<Outspend>>, Error> {
        self.json(Route::TxOutspends { txid, asof }).await
    }

    // Addresses and scripthashes. All need the node's `--sh-index`.

    pub async fn script_stats(
        &self,
        script: ScriptRef,
        asof: Option<BlockHash>,
    ) -> Result<Stamped<ScriptInfo>, Error> {
        self.json(Route::ScriptStats { script, asof }).await
    }

    pub async fn script_utxo(
        &self,
        script: ScriptRef,
        asof: Option<BlockHash>,
    ) -> Result<Stamped<Vec<Utxo>>, Error> {
        self.json(Route::ScriptUtxo { script, asof }).await
    }

    pub async fn script_txs(
        &self,
        script: ScriptRef,
        after: Option<Txid>,
        asof: Option<BlockHash>,
    ) -> Result<Stamped<Vec<Tx>>, Error> {
        self.json(Route::ScriptTxs {
            script,
            after,
            asof,
        })
        .await
    }

    pub async fn script_txs_chain(
        &self,
        script: ScriptRef,
        last_seen: Option<Txid>,
        asof: Option<BlockHash>,
    ) -> Result<Stamped<Vec<Tx>>, Error> {
        self.json(Route::ScriptTxsChain {
            script,
            last_seen,
            asof,
        })
        .await
    }

    /// Unstamped: the node does not stamp mempool rows.
    pub async fn script_txs_mempool(&self, script: ScriptRef) -> Result<Stamped<Vec<Tx>>, Error> {
        self.json(Route::ScriptTxsMempool(script)).await
    }

    pub async fn script_txs_summary(
        &self,
        script: ScriptRef,
        last_seen: Option<Txid>,
        asof: Option<BlockHash>,
    ) -> Result<Stamped<Vec<TxSummary>>, Error> {
        self.json(Route::ScriptTxsSummary {
            script,
            last_seen,
            asof,
        })
        .await
    }

    // Mempool, fees and broadcast. Unstamped.

    pub async fn mempool(&self) -> Result<Stamped<MempoolInfo>, Error> {
        self.json(Route::Mempool).await
    }

    pub async fn mempool_txids(&self) -> Result<Stamped<Vec<Txid>>, Error> {
        self.json(Route::MempoolTxids).await
    }

    pub async fn mempool_recent(&self) -> Result<Stamped<Vec<MempoolRecent>>, Error> {
        self.json(Route::MempoolRecent).await
    }

    pub async fn fee_estimates(&self) -> Result<Stamped<FeeEstimates>, Error> {
        self.json(Route::FeeEstimates).await
    }

    /// `POST /tx`. A policy reject is [`Error::Rejected`] with the node's reason.
    pub async fn broadcast(&self, tx: Transaction) -> Result<Stamped<Txid>, Error> {
        self.typed(Route::Broadcast(tx), parse_text).await
    }

    // Outputs by position. No address index needed.

    pub async fn output_at(
        &self,
        position: OutPosition,
        asof: Option<BlockHash>,
    ) -> Result<Stamped<PositionedOutput>, Error> {
        self.json(Route::OutputAt { position, asof }).await
    }

    /// One slot per position, in order; `None` where the output does not exist.
    pub async fn outputs_at(
        &self,
        positions: OutPositions,
        asof: Option<BlockHash>,
    ) -> Result<Stamped<Vec<Option<PositionedOutput>>>, Error> {
        self.json(Route::OutputsAt { positions, asof }).await
    }

    // Bulk `/internal/*` routes: unix socket only, see [`Esplora::has_internal`].

    /// Unknown txids are left out.
    pub async fn internal_txs(&self, txids: Vec<Txid>) -> Result<Stamped<Vec<Tx>>, Error> {
        self.json(Route::InternalTxs(txids)).await
    }

    /// Mempool transactions in txid order after `after`, at most `max_txs` (node default 10,000).
    pub async fn internal_mempool_txs(
        &self,
        after: Option<Txid>,
        max_txs: Option<u32>,
    ) -> Result<Stamped<Vec<Tx>>, Error> {
        self.json(Route::InternalMempoolTxs { after, max_txs })
            .await
    }

    pub async fn internal_mempool_txs_all(&self) -> Result<Stamped<Vec<Tx>>, Error> {
        self.json(Route::InternalMempoolTxsAll).await
    }

    /// Mempool only; others are left out.
    pub async fn internal_mempool_txs_by_txid(
        &self,
        txids: Vec<Txid>,
    ) -> Result<Stamped<Vec<Tx>>, Error> {
        self.json(Route::InternalMempoolTxsByTxid(txids)).await
    }

    pub async fn internal_block_txs(&self, hash: BlockHash) -> Result<Stamped<Vec<Tx>>, Error> {
        self.json(Route::InternalBlockTxs(hash)).await
    }

    /// One array per txid, in order; empty for an unknown txid.
    pub async fn internal_outspends_by_txid(
        &self,
        txids: Vec<Txid>,
    ) -> Result<Stamped<Vec<Vec<Outspend>>>, Error> {
        self.json(Route::InternalOutspendsByTxid(txids)).await
    }

    pub async fn internal_outspends_by_outpoint(
        &self,
        outpoints: Vec<OutPoint>,
    ) -> Result<Stamped<Vec<Outspend>>, Error> {
        self.json(Route::InternalOutspendsByOutpoint(outpoints))
            .await
    }
}

fn text(b: &[u8]) -> Result<&str, Error> {
    std::str::from_utf8(b)
        .map(str::trim)
        .map_err(|e| Error::Decode(e.to_string()))
}

fn parse_text<T: FromStr<Err: std::fmt::Display>>(b: &[u8]) -> Result<T, Error> {
    text(b)?
        .parse()
        .map_err(|e: T::Err| Error::Decode(e.to_string()))
}

fn consensus<T: Decodable>(b: &[u8]) -> Result<T, Error> {
    bitcoin::consensus::deserialize(b).map_err(|e| Error::Decode(e.to_string()))
}

fn consensus_hex<T: Decodable>(b: &[u8]) -> Result<T, Error> {
    bitcoin::consensus::encode::deserialize_hex(text(b)?).map_err(|e| Error::Decode(e.to_string()))
}
