//! The block routes of `/api/v1` (`docs/API.md`, "Blocks"): blocks with `extras`, built from the
//! node's Esplora header, the block table's row and the block's audit.
//!
//! The table decides which blocks a list holds: the run of stored rows from the start height down,
//! cut at the first height the backfill has not reached, so a list never has a hole and never a
//! block without its extras. Headers are kept by hash (a hash fixes its header), so a block costs
//! the node one Esplora request the first time a route shows it and none after.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use axum::Router;
use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use bitcoin::hashes::Hash;
use bitcoin::{Address, BlockHash, TxMerkleNode};
use engine::blocks::{self, Row, ZONE};
use engine::mining::pools::{self, UNKNOWN};
use engine::store::{self, Store};
use node::esplora::Route;
use node::esplora::model::BlockStatus;
use serde::Serialize;
use serde_json::Value;

use crate::NetworkContext;
use crate::difficulty::chain;
use crate::error::ApiError;
use crate::esplora::{ApiOutcome, Source};
use crate::mining::{hex, number, round};

/// Blocks in a list, as the reference pages them.
const LIST: u32 = 15;
/// Headers kept per network, about 150 bytes each.
const MAX_HEADERS: usize = 4096;
/// For an answer that can no longer change: every block buried under [`ZONE`] more, where
/// `follow` no longer rewrites rows, and every block rated. Not `immutable`: a release with a
/// new pool list can name a block's miner differently.
const SETTLED: &str = "public, max-age=86400";
const CACHE: &str = "public, max-age=1";

const NOT_READY: ApiError = ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "not ready yet; retry");
const NO_TABLE: ApiError = ApiError::new(
    StatusCode::SERVICE_UNAVAILABLE,
    "block extras need a block table on this server",
);
const NOT_INDEXED: ApiError = ApiError::new(StatusCode::NOT_FOUND, "block not indexed yet");
const STALE: ApiError = ApiError::new(StatusCode::NOT_FOUND, "block is not on the best chain");

type Header = node::esplora::model::Block;

/// Esplora headers by hash, for every network's block routes.
#[derive(Debug, Default)]
pub struct Headers(Mutex<HashMap<BlockHash, Header>>);

impl Headers {
    fn get(&self, hash: &BlockHash) -> Option<Header> {
        self.lock().get(hash).cloned()
    }

    /// The height of a block whose header is held.
    pub(crate) fn height(&self, hash: &BlockHash) -> Option<u32> {
        self.lock().get(hash).map(|h| h.height)
    }

    fn insert(&self, headers: impl IntoIterator<Item = Header>) {
        let mut map = self.lock();
        for h in headers {
            // shortcut: starts over when full instead of evicting the oldest; a full map is
            // 4,096 distinct blocks asked for, so this costs at most one request per block again.
            if map.len() >= MAX_HEADERS {
                map.clear();
            }
            map.insert(h.id, h);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<BlockHash, Header>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

pub fn routes() -> Router<Arc<NetworkContext>> {
    Router::new()
        .route("/api/v1/blocks", get(tip_list))
        .route("/api/v1/blocks/{height}", get(list))
        .route("/api/v1/blocks/tip/height", get(crate::esplora::tip_height))
        .route("/api/v1/block/{hash}", get(block))
        .route("/api/v1/block/{hash}/summary", get(crate::summary::v1_txs))
        .route(
            "/api/v1/block/{hash}/tx/{txid}/summary",
            get(crate::summary::v1_tx),
        )
}

type Ctx = State<Arc<NetworkContext>>;

async fn tip_list(State(ctx): Ctx) -> Response {
    from_height(&ctx, None).await
}

async fn list(State(ctx): Ctx, Path(height): Path<String>) -> Response {
    match number(&height, "invalid height") {
        Ok(h) => from_height(&ctx, Some(h)).await,
        Err(e) => e.into_response(),
    }
}

/// Up to [`LIST`] blocks from `start` (the table's top without it) down, newest first.
async fn from_height(ctx: &NetworkContext, start: Option<u32>) -> Response {
    let run = async {
        let started = Instant::now();
        let store = table(ctx)?;
        let top = blocks::top(store).await.map_err(read)?.ok_or(NOT_READY)?;
        let start = start.unwrap_or(top.0);
        if start > top.0 {
            // Past the node's tip, an empty list as on the reference; short of it, the table has
            // yet to follow the newest blocks.
            // The node's own answer, shared with `/api/blocks/tip/height` and held for a second.
            let (tip, _): (u32, _) = crate::esplora::json(ctx, Route::TipHeight).await?;
            if start <= tip {
                return Err(NOT_READY);
            }
            let mut res = reply(
                &Vec::<BlockJson>::new(),
                CACHE,
                top,
                None,
                "v1_blocks",
                None,
            );
            // Rests on the node's tip, not only the table: never kept (`crate::answers`).
            res.extensions_mut().insert(crate::answers::Unkept);
            return Ok(res);
        }
        let rows = run(store, Some(start), LIST).await?;
        let Some(last) = rows.last() else {
            return Err(NOT_INDEXED);
        };
        let complete = rows.len() == LIST as usize || last.height == 0;
        let coverage = Coverage {
            from: (last.height, last.time),
            complete,
        };
        let settled = complete
            && start.saturating_add(ZONE) <= top.0
            && rows.iter().all(|r| r.rates.is_some());
        let (body, asked) = with_extras(ctx, store, rows).await?;
        same_top(store, top).await?;
        let cache = if settled { SETTLED } else { CACHE };
        let source = asked.then(|| Source::Upstream(started.elapsed()));
        Ok(reply(
            &body,
            cache,
            top,
            Some(coverage),
            "v1_blocks",
            source,
        ))
    };
    run.await.unwrap_or_else(IntoResponse::into_response)
}

/// Up to `n` rows from `start` (the table's top without it) down, newest first, cut at the first
/// height missing.
async fn run(store: &Store, start: Option<u32>, n: u32) -> Result<Vec<Row>, ApiError> {
    let below = start.map(|s| s.saturating_add(1));
    let rows = blocks::page(store, below, n).await.map_err(read)?;
    let start = start.or(rows.first().map(|r| r.height)).unwrap_or(0);
    Ok(rows
        .into_iter()
        .zip((0..=start).rev())
        .take_while(|(r, h)| r.height == *h)
        .map(|(r, _)| r)
        .collect())
}

/// The table's newest `n` blocks, newest first, each the JSON `GET /api/v1/blocks` lists it as:
/// the compatible socket's blocks (`crate::ws::v1`).
pub(crate) async fn newest(ctx: &NetworkContext, n: u32) -> Result<Vec<Value>, ApiError> {
    let store = table(ctx)?;
    let rows = run(store, None, n).await?;
    let (body, _) = with_extras(ctx, store, rows).await?;
    body.iter()
        .map(serde_json::to_value)
        .collect::<Result<_, _>>()
        .map_err(|_| ApiError::INTERNAL)
}

async fn block(State(ctx): Ctx, Path(hash): Path<String>) -> Response {
    let run = async {
        let started = Instant::now();
        let hash = crate::esplora::block_hash(&hash)?;
        let store = table(&ctx)?;
        let top = blocks::top(store).await.map_err(read)?.ok_or(NOT_READY)?;
        let Some(row) = blocks::by_hash(store, hash).await.map_err(read)? else {
            // Why the table has no row: the node does not know the block (404 here), the table
            // has yet to follow it, a reorg left it behind, or the backfill has not reached it.
            let (h, _) = header(&ctx, hash).await?;
            if h.height > top.0 {
                return Err(NOT_READY);
            }
            if blocks::by_height(store, h.height)
                .await
                .map_err(read)?
                .is_none()
            {
                return Err(NOT_INDEXED);
            }
            // The table holds another block there: this one left the best chain, or the table
            // has yet to follow a reorg to it.
            let (status, _): (BlockStatus, _) =
                crate::esplora::json(&ctx, Route::BlockStatus(hash)).await?;
            return Err(if status.in_best_chain {
                NOT_READY
            } else {
                STALE
            });
        };
        let settled = row.height.saturating_add(ZONE) <= top.0 && row.rates.is_some();
        let (mut body, asked) = with_extras(&ctx, store, vec![row]).await?;
        let body = body.pop().ok_or(ApiError::INTERNAL)?;
        same_top(store, top).await?;
        let cache = if settled { SETTLED } else { CACHE };
        let source = asked.then(|| Source::Upstream(started.elapsed()));
        Ok::<_, ApiError>(reply(&body, cache, top, None, "v1_block", source))
    };
    run.await.unwrap_or_else(IntoResponse::into_response)
}

/// `503` if the table's top moved since `top` was read: the rows read since could be from
/// another chain than the tip the answer would name.
async fn same_top(store: &Store, top: (u32, BlockHash)) -> Result<(), ApiError> {
    match blocks::top(store).await.map_err(read)? {
        Some(now) if now == top => Ok(()),
        _ => Err(NOT_READY),
    }
}

fn table(ctx: &NetworkContext) -> Result<&Store, ApiError> {
    Ok(&ctx.blocks.as_ref().ok_or(NO_TABLE)?.store)
}

fn read(e: store::Error) -> ApiError {
    match e {
        store::Error::TimedOut => ApiError::OVERLOADED,
        _ => ApiError::INTERNAL,
    }
}

/// The header of `hash`, and whether the node was asked for it.
async fn header(ctx: &NetworkContext, hash: BlockHash) -> Result<(Header, bool), ApiError> {
    if let Some(h) = ctx.block_headers.get(&hash) {
        return Ok((h, false));
    }
    let (h, _): (Header, _) = crate::esplora::json(ctx, Route::Block(hash)).await?;
    // A different block under the asked hash would be kept for good.
    if h.id != hash {
        return Err(ApiError::UPSTREAM);
    }
    ctx.block_headers.insert([h.clone()]);
    Ok((h, true))
}

/// The rows as the reference's blocks, in order, and whether the node was asked for a header.
async fn with_extras(
    ctx: &NetworkContext,
    store: &Store,
    rows: Vec<Row>,
) -> Result<(Vec<BlockJson>, bool), ApiError> {
    let mut asked = false;
    let mut headers = Vec::with_capacity(rows.len());
    for r in &rows {
        if ctx.block_headers.get(&r.hash).is_none() {
            // Ten headers from this height down: this block's and the next nine of a list.
            let page = crate::esplora::json::<Vec<Header>>(
                ctx,
                Route::Blocks {
                    start_height: Some(r.height),
                },
            )
            .await?;
            ctx.block_headers.insert(page.0);
            asked = true;
        }
        // Not in the page when the node's chain has moved on from the table's at this height.
        let (h, by_hash) = header(ctx, r.hash).await?;
        asked |= by_hash;
        headers.push(h);
    }
    let hashes = rows.iter().map(|r| r.hash).collect();
    let audits = engine::audit::by_hashes(store, hashes)
        .await
        .map_err(read)?;
    let network = chain(ctx.config.network);
    let body = rows
        .iter()
        .zip(headers)
        .zip(audits)
        .map(|((r, h), a)| BlockJson::new(r, h, a.map(|a| a.totals), network))
        .collect();
    Ok((body, asked))
}

/// How far a list reaches: its lowest block, and whether it holds every block asked for.
struct Coverage {
    from: (u32, u64),
    complete: bool,
}

/// The tip the answer is as of is the table's top: the newest block it can give extras for.
fn reply(
    body: &impl Serialize,
    cache: &'static str,
    top: (u32, BlockHash),
    coverage: Option<Coverage>,
    route: &'static str,
    source: Option<Source>,
) -> Response {
    let body = serde_json::to_vec(body).unwrap_or_default();
    let mut res = ([(CONTENT_TYPE, "application/json")], body).into_response();
    let h = res.headers_mut();
    h.insert(CACHE_CONTROL, HeaderValue::from_static(cache));
    if let Ok(tip) = HeaderValue::from_str(&top.1.to_string()) {
        h.insert("x-bitcoin-chain-tip", tip);
    }
    h.insert("x-bitcoin-chain-tip-height", HeaderValue::from(top.0));
    if let Some(c) = coverage {
        h.insert("x-data-from-height", HeaderValue::from(c.from.0));
        h.insert("x-data-from-time", HeaderValue::from(c.from.1));
        h.insert(
            "x-data-complete",
            HeaderValue::from_static(if c.complete { "true" } else { "false" }),
        );
    }
    res.extensions_mut().insert(ApiOutcome {
        route,
        source: source.unwrap_or(Source::Stored),
        upstream_error: None,
    });
    res
}

/// A block as the reference serves it, in its field order.
#[derive(Debug, Serialize)]
struct BlockJson {
    id: BlockHash,
    height: u32,
    version: i64,
    timestamp: u64,
    bits: u32,
    nonce: u32,
    difficulty: f64,
    merkle_root: TxMerkleNode,
    tx_count: u32,
    size: u64,
    weight: u64,
    previousblockhash: Option<BlockHash>,
    mediantime: u64,
    /// Always `false`: only blocks on the best chain have a row.
    stale: bool,
    extras: Extras,
}

/// The reference's `extras`, less the fields we cannot produce (`docs/API.md`, "Blocks"). The
/// unit fields are `null` on the reference too.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Extras {
    reward: u64,
    /// Chain data: hex, and below as one Latin-1 character per byte, serialized as JSON strings.
    coinbase_raw: String,
    /// `None` until the block is rated.
    median_fee: Option<f64>,
    fee_range: Option<[f64; 7]>,
    total_fees: u64,
    avg_fee: u64,
    avg_fee_rate: f64,
    fee_percentiles: (),
    virtual_size: f64,
    coinbase_address: Option<String>,
    coinbase_addresses: Vec<String>,
    coinbase_signature: Option<String>,
    coinbase_signature_ascii: String,
    header: Option<String>,
    utxo_set_size: (),
    total_input_amt: (),
    pool: BlockPool,
    /// From the block's audit; `None` when we did not watch it arrive.
    match_rate: Option<f64>,
    expected_fees: Option<u64>,
    expected_weight: Option<u64>,
    first_seen: (),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BlockPool {
    id: u16,
    name: &'static str,
    slug: &'static str,
    miner_names: (),
}

impl BlockJson {
    fn new(
        r: &Row,
        h: Header,
        audit: Option<engine::audit::Totals>,
        network: bitcoin::Network,
    ) -> Self {
        let rates = r.rates.and_then(|x| x.fee_rate);
        let addresses: Vec<String> = r
            .coinbase
            .payouts
            .iter()
            .filter_map(|s| Address::from_script(s, network).ok())
            .map(|a| a.to_string())
            .collect();
        let list = pools::list();
        let (id, _) = list.attribute(&r.coinbase.tag, &r.coinbase.payouts);
        let pool = list.by_id(id).or_else(|| list.by_id(UNKNOWN));
        let paying = r.tx_count.saturating_sub(1);
        Self {
            id: h.id,
            height: h.height,
            version: h.version,
            timestamp: h.timestamp,
            bits: h.bits,
            nonce: h.nonce,
            difficulty: h.difficulty,
            merkle_root: h.merkle_root,
            tx_count: h.tx_count,
            size: h.size,
            weight: h.weight,
            previousblockhash: h.previousblockhash,
            mediantime: h.mediantime,
            stale: false,
            extras: Extras {
                reward: r.reward,
                coinbase_raw: hex(&r.coinbase.tag),
                median_fee: rates.map(|f| round(f.median, 3)),
                fee_range: rates.map(|f| {
                    [f.min, f.p10, f.p25, f.median, f.p75, f.p90, f.max].map(|x| round(x, 3))
                }),
                total_fees: r.fees,
                avg_fee: r.fees.checked_div(u64::from(paying)).unwrap_or(0),
                avg_fee_rate: if r.paying_weight == 0 {
                    0.0
                } else {
                    round(r.fees as f64 * 4.0 / r.paying_weight as f64, 3)
                },
                fee_percentiles: (),
                virtual_size: h.weight as f64 / 4.0,
                coinbase_address: addresses.first().cloned(),
                coinbase_addresses: addresses,
                coinbase_signature: r.coinbase.payouts.first().map(|s| s.to_asm_string()),
                coinbase_signature_ascii: r.coinbase.tag.iter().map(|&b| char::from(b)).collect(),
                header: header_hex(&h),
                utxo_set_size: (),
                total_input_amt: (),
                pool: BlockPool {
                    id: pool.map_or(UNKNOWN, |p| p.id),
                    name: pool.map_or("Unknown", |p| p.name.as_str()),
                    slug: pool.map_or("unknown", |p| p.slug.as_str()),
                    miner_names: (),
                },
                match_rate: audit.map(|a| a.match_rate),
                expected_fees: audit.map(|a| a.expected.fees),
                expected_weight: audit.map(|a| a.expected.weight),
                first_seen: (),
            },
        }
    }
}

/// The 80-byte header in hex, rebuilt from Esplora's fields; `None` if they do not hash to the
/// block's id.
fn header_hex(h: &Header) -> Option<String> {
    let header = bitcoin::block::Header {
        // The low 32 bits, whether the node printed the version signed or unsigned.
        version: bitcoin::block::Version::from_consensus(h.version as i32),
        prev_blockhash: h.previousblockhash.unwrap_or_else(BlockHash::all_zeros),
        merkle_root: h.merkle_root,
        time: u32::try_from(h.timestamp).ok()?,
        bits: bitcoin::CompactTarget::from_consensus(h.bits),
        nonce: h.nonce,
    };
    (header.block_hash() == h.id).then(|| bitcoin::consensus::encode::serialize_hex(&header))
}

#[cfg(test)]
pub(crate) mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    /// Block 800,000 as the compatible socket sends it: the recorded Esplora header, a rated row
    /// paying one address, and an audit.
    pub(crate) fn sample() -> Value {
        let h: Header =
            serde_json::from_str(include_str!("../../../fixtures/esplora/mainnet/block.json"))
                .unwrap();
        let rate = engine::blocks::Rates {
            min: 1.0,
            p10: 2.0,
            p25: 3.0,
            median: 4.0,
            p75: 5.0,
            p90: 6.0,
            max: 7.0,
        };
        let row = Row {
            height: h.height,
            hash: h.id,
            time: h.timestamp,
            tx_count: h.tx_count,
            size: h.size,
            weight: h.weight,
            paying_weight: h.weight - 800,
            fees: 2_000_000,
            subsidy: 625_000_000,
            reward: 627_000_000,
            difficulty: h.difficulty,
            coinbase: engine::blocks::Coinbase {
                tag: b"\x03\x00\x35\x0c/pool/".to_vec(),
                payouts: vec![bitcoin::ScriptBuf::new_p2pkh(
                    &bitcoin::PubkeyHash::all_zeros(),
                )],
            },
            rates: Some(engine::blocks::Rated {
                fee_rate: Some(rate),
                fee_bands: Default::default(),
            }),
        };
        let audit = engine::audit::Totals {
            match_rate: 99.5,
            expected: Default::default(),
            actual: Default::default(),
            matched: Default::default(),
            missing: Default::default(),
            displaced: Default::default(),
            fresh: Default::default(),
            conflicted: Default::default(),
            added: Default::default(),
            unseen: Default::default(),
        };
        let b = BlockJson::new(&row, h, Some(audit), bitcoin::Network::Bitcoin);
        serde_json::to_value(b).unwrap()
    }
}
