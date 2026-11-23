//! The mining routes under `/api/v1/mining` (`docs/API.md`, "Mining"), answered from the block
//! table and never from the node.
//!
//! Each answer is computed once per change to the table and kept in memory, keyed by route and
//! interval (or pool), so a request is a lookup. [`run`] first brings the table's pool column in
//! line with the build's pool list, then recomputes the answers clients have asked for whenever
//! `follow` writes a block, and at most once a minute while the backfill adds rows. A request for
//! an answer not computed yet computes it, one at a time per network. The routes that take an
//! unbounded parameter (a height, a timestamp, a block count) are single indexed reads and are not
//! cached.
//!
//! Every answer that rests on history says how far back it reaches, since the backfill may still
//! be filling the table: `X-Data-From-Height` and `X-Data-From-Time` name the earliest block it
//! includes, and `X-Data-Complete` whether it covers the whole period asked for.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::header::{AGE, CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use bitcoin::{Address, BlockHash, Script};
use engine::audit;
use engine::blocks::{self, Bucket, Period, Row, Span, WEEK};
use engine::mining::pools::{self, Pool, UNKNOWN};
use engine::mining::{Interval, hashrate};
use engine::store::{self, Store};
use logging::events::{BlockTotalsFilled, MiningFailed, MiningRefreshed, PoolsReattributed};
use serde::Serialize;
use tokio::sync::watch;

use crate::error::ApiError;
use crate::esplora::{ApiOutcome, Source};
use crate::{Network, NetworkContext};

const NOT_READY: ApiError = ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "not ready yet; retry");
const NO_TABLE: ApiError = ApiError::new(
    StatusCode::SERVICE_UNAVAILABLE,
    "mining data needs a block table on this server",
);
const NO_HISTORY: ApiError = ApiError::new(
    StatusCode::NOT_FOUND,
    "no indexed block at or before that time",
);
const CACHE: &str = "public, max-age=1";
/// Blocks in a page of one pool's blocks, as the reference pages them.
const POOL_PAGE: u32 = 100;
/// The most blocks `reward-stats` sums: a year's worth.
pub const MAX_REWARD_BLOCKS: u32 = 52_560;
/// While the backfill adds rows, the answers are recomputed at most this often.
const BACKFILL_REFRESH: Duration = Duration::from_secs(60);
const RETRY_MAX: Duration = Duration::from_secs(300);
/// Answers for a period ending now are recomputed at least this often, blocks or not.
const MAX_AGE: Duration = Duration::from_secs(600);
const DAY: u64 = 86_400;

/// One network's mining answers, held in [`NetworkContext`].
#[derive(Default)]
pub struct Mining {
    /// `None` until the pool column matches the list and the table has a row.
    table: watch::Sender<Option<Table>>,
    answers: Mutex<HashMap<Key, Arc<Answer>>>,
    /// One computation at a time per network, whoever asks.
    compute: tokio::sync::Mutex<()>,
    failures: AtomicU32,
}

/// The table as of one refresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Table {
    version: u64,
    span: Span,
}

/// The answers one computation gives: every pool's statistics and weekly shares together, and
/// an interval's five block series together.
fn family(key: Key) -> Key {
    match key {
        Key::Pool(_) | Key::PoolHashrate(_) => Key::Pool(0),
        Key::Fees(i)
        | Key::Rewards(i)
        | Key::SizesWeights(i)
        | Key::FeeRates(i)
        | Key::FeeRatesPrecise(i) => Key::Fees(i),
        k => k,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Key {
    List,
    Pools(Interval),
    Pool(u16),
    PoolHashrate(u16),
    Hashrate(Interval),
    HashratePools(Interval),
    Adjustments(Interval),
    Fees(Interval),
    Rewards(Interval),
    FeeRates(Interval),
    FeeRatesPrecise(Interval),
    SizesWeights(Interval),
}

/// How far back an answer reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Coverage {
    /// The earliest block included; `None` when the answer includes none.
    from: Option<(u32, u64)>,
    /// Whether it covers the whole period asked for.
    complete: bool,
}

#[derive(Debug)]
struct Answer {
    version: u64,
    body: Bytes,
    tip: BlockHash,
    tip_height: u32,
    computed: SystemTime,
    coverage: Option<Coverage>,
}

pub fn routes() -> Router<Arc<NetworkContext>> {
    Router::new()
        .route("/api/v1/mining/pools", get(list))
        .route("/api/v1/mining/pools/{interval}", get(pools_ranking))
        .route("/api/v1/mining/pool/{slug}", get(pool))
        .route("/api/v1/mining/pool/{slug}/hashrate", get(pool_hashrate))
        .route("/api/v1/mining/pool/{slug}/blocks", get(pool_blocks_top))
        .route(
            "/api/v1/mining/pool/{slug}/blocks/{height}",
            get(pool_blocks),
        )
        .route("/api/v1/mining/hashrate", get(hashrate_all))
        .route("/api/v1/mining/hashrate/{interval}", get(hashrate_route))
        .route("/api/v1/mining/hashrate/pools", get(hashrate_pools_all))
        .route(
            "/api/v1/mining/hashrate/pools/{interval}",
            get(hashrate_pools),
        )
        .route(
            "/api/v1/mining/difficulty-adjustments",
            get(adjustments_all),
        )
        .route(
            "/api/v1/mining/difficulty-adjustments/{interval}",
            get(adjustments),
        )
        .route("/api/v1/mining/reward-stats/{count}", get(reward_stats))
        .route("/api/v1/mining/blocks/fees/{interval}", get(fees))
        .route("/api/v1/mining/blocks/rewards/{interval}", get(rewards))
        .route("/api/v1/mining/blocks/fee-rates/{interval}", get(fee_rates))
        .route(
            "/api/v1/mining/blocks/fee-rates/{interval}/precise",
            get(fee_rates_precise),
        )
        .route(
            "/api/v1/mining/blocks/sizes-weights/{interval}",
            get(sizes_weights),
        )
        .route(
            "/api/v1/mining/blocks/timestamp/{timestamp}",
            get(timestamp),
        )
}

// Requests.

type Ctx = State<Arc<NetworkContext>>;

fn interval(s: &str) -> Result<Interval, ApiError> {
    Interval::parse(s).ok_or(ApiError::bad_request("invalid interval"))
}

fn slug(s: &str) -> Result<&'static Pool, ApiError> {
    pools::list().by_slug(s).ok_or(ApiError::NOT_FOUND)
}

/// Decimal digits only, as every other numeric parameter here.
pub(crate) fn number<T: std::str::FromStr>(s: &str, what: &'static str) -> Result<T, ApiError> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ApiError::bad_request(what));
    }
    s.parse().map_err(|_| ApiError::bad_request(what))
}

async fn list(State(ctx): Ctx) -> Response {
    cached(&ctx, Key::List, "mining_pools").await
}

async fn pools_ranking(State(ctx): Ctx, Path(i): Path<String>) -> Response {
    match interval(&i) {
        Ok(i) => cached(&ctx, Key::Pools(i), "mining_pools_interval").await,
        Err(e) => e.into_response(),
    }
}

async fn pool(State(ctx): Ctx, Path(s): Path<String>) -> Response {
    match slug(&s) {
        Ok(p) => cached(&ctx, Key::Pool(p.id), "mining_pool").await,
        Err(e) => e.into_response(),
    }
}

async fn pool_hashrate(State(ctx): Ctx, Path(s): Path<String>) -> Response {
    match slug(&s) {
        Ok(p) => cached(&ctx, Key::PoolHashrate(p.id), "mining_pool_hashrate").await,
        Err(e) => e.into_response(),
    }
}

async fn hashrate_all(State(ctx): Ctx) -> Response {
    cached(&ctx, Key::Hashrate(Interval::All), "mining_hashrate").await
}

async fn hashrate_route(State(ctx): Ctx, Path(i): Path<String>) -> Response {
    match interval(&i) {
        Ok(i) => cached(&ctx, Key::Hashrate(i), "mining_hashrate").await,
        Err(e) => e.into_response(),
    }
}

async fn hashrate_pools_all(State(ctx): Ctx) -> Response {
    cached(
        &ctx,
        Key::HashratePools(Interval::All),
        "mining_hashrate_pools",
    )
    .await
}

async fn hashrate_pools(State(ctx): Ctx, Path(i): Path<String>) -> Response {
    match interval(&i) {
        Ok(i) => cached(&ctx, Key::HashratePools(i), "mining_hashrate_pools").await,
        Err(e) => e.into_response(),
    }
}

async fn adjustments_all(State(ctx): Ctx) -> Response {
    cached(
        &ctx,
        Key::Adjustments(Interval::All),
        "mining_difficulty_adjustments",
    )
    .await
}

async fn adjustments(State(ctx): Ctx, Path(i): Path<String>) -> Response {
    match interval(&i) {
        Ok(i) => cached(&ctx, Key::Adjustments(i), "mining_difficulty_adjustments").await,
        Err(e) => e.into_response(),
    }
}

macro_rules! series_route {
    ($name:ident, $key:ident, $route:literal) => {
        async fn $name(State(ctx): Ctx, Path(i): Path<String>) -> Response {
            match interval(&i) {
                Ok(i) => cached(&ctx, Key::$key(i), $route).await,
                Err(e) => e.into_response(),
            }
        }
    };
}
series_route!(fees, Fees, "mining_block_fees");
series_route!(rewards, Rewards, "mining_block_rewards");
series_route!(fee_rates, FeeRates, "mining_block_fee_rates");
series_route!(fee_rates_precise, FeeRatesPrecise, "mining_block_fee_rates");
series_route!(sizes_weights, SizesWeights, "mining_block_sizes_weights");

/// The table, or why there is none to answer from.
fn ready(ctx: &NetworkContext) -> Result<(&Store, Table), ApiError> {
    let store = &ctx.blocks.as_ref().ok_or(NO_TABLE)?.store;
    let table = (*ctx.mining.table.borrow()).ok_or(NOT_READY)?;
    Ok((store, table))
}

/// The answer for `key`, computing it (and any answers that come with it) if no refresh has.
async fn cached(ctx: &NetworkContext, key: Key, route: &'static str) -> Response {
    let (store, _) = match ready(ctx) {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };
    let m = &ctx.mining;
    if let Some(a) = m.get(key) {
        return respond(ctx, &a, route, Source::Cached);
    }
    let _one = m.compute.lock().await;
    if let Some(a) = m.get(key) {
        return respond(ctx, &a, route, Source::Cached);
    }
    let Some(table) = *m.table.borrow() else {
        return NOT_READY.into_response();
    };
    match compute(store, table, key, &Shared::default()).await {
        // The chain moved under the reads; the refresh that follows answers next time.
        Ok(None) => NOT_READY.into_response(),
        Ok(Some(answers)) => {
            m.failures.store(0, Ordering::Relaxed);
            m.insert(answers);
            match m.get(key) {
                Some(a) => respond(ctx, &a, route, Source::Stored),
                None => ApiError::NOT_FOUND.into_response(),
            }
        }
        Err(e) => {
            let failures = m.failures.fetch_add(1, Ordering::Relaxed).saturating_add(1);
            failed(ctx.config.network, "request", &e, failures);
            error(&e).into_response()
        }
    }
}

fn error(e: &store::Error) -> ApiError {
    match e {
        store::Error::TimedOut => ApiError::OVERLOADED,
        _ => ApiError::INTERNAL,
    }
}

fn failed(network: Network, task: &'static str, e: &store::Error, failures: u32) {
    if failures.is_power_of_two() {
        logging::emit(&MiningFailed {
            network: network.name(),
            task,
            error: match e {
                store::Error::TimedOut => "timed_out",
                _ => "store",
            },
            failures,
        });
    }
}

impl Mining {
    fn get(&self, key: Key) -> Option<Arc<Answer>> {
        self.answers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key)
            .cloned()
    }

    fn insert(&self, answers: Vec<(Key, Answer)>) {
        let mut map = self.answers.lock().unwrap_or_else(PoisonError::into_inner);
        for (k, a) in answers {
            map.insert(k, Arc::new(a));
        }
    }
}

/// The answer's bytes with the chain tip it is as of, its coverage, and `Age` when the node's
/// tip is not the one it was computed at (a block not yet in the table, or Electrum down).
fn respond(ctx: &NetworkContext, a: &Answer, route: &'static str, source: Source) -> Response {
    let mut res = (
        [(CONTENT_TYPE, HeaderValue::from_static("application/json"))],
        a.body.clone(),
    )
        .into_response();
    let h = res.headers_mut();
    h.insert(CACHE_CONTROL, HeaderValue::from_static(CACHE));
    if let Ok(tip) = HeaderValue::from_str(&a.tip.to_string()) {
        h.insert("x-bitcoin-chain-tip", tip);
    }
    h.insert(
        "x-bitcoin-chain-tip-height",
        HeaderValue::from(a.tip_height),
    );
    if let Some(c) = a.coverage {
        if let Some((height, time)) = c.from {
            h.insert("x-data-from-height", HeaderValue::from(height));
            h.insert("x-data-from-time", HeaderValue::from(time));
        }
        h.insert(
            "x-data-complete",
            HeaderValue::from_static(if c.complete { "true" } else { "false" }),
        );
    }
    let current =
        ctx.electrum.health().borrow().ready && ctx.electrum.tip().is_some_and(|t| t.hash == a.tip);
    if !current {
        let age = SystemTime::now()
            .duration_since(a.computed)
            .unwrap_or_default()
            .as_secs();
        h.insert(AGE, HeaderValue::from(age));
    }
    res.extensions_mut().insert(ApiOutcome {
        route,
        source,
        upstream_error: None,
    });
    res
}

/// An answer computed for this request alone, for the routes not cached.
fn fresh(
    ctx: &NetworkContext,
    table: Table,
    body: &impl Serialize,
    coverage: Option<Coverage>,
    route: &'static str,
) -> Response {
    let a = answer(table, body, coverage);
    respond(ctx, &a, route, Source::Stored)
}

fn answer(table: Table, body: &impl Serialize, coverage: Option<Coverage>) -> Answer {
    Answer {
        version: table.version,
        body: Bytes::from(serde_json::to_vec(body).unwrap_or_default()),
        tip: table.span.tip_hash,
        tip_height: table.span.tip,
        computed: SystemTime::now(),
        coverage,
    }
}

// The routes that are not cached.

async fn reward_stats(State(ctx): Ctx, Path(count): Path<String>) -> Response {
    let run = async {
        let n: u32 = number(&count, "invalid block count")?;
        if !(1..=MAX_REWARD_BLOCKS).contains(&n) {
            return Err(ApiError::bad_request("block count must be 1 to 52560"));
        }
        let (store, table) = ready(&ctx)?;
        let s = table.span;
        let want = (s.tip + 1).saturating_sub(n);
        let lo = want.max(s.from);
        let b = blocks::periods(store, lo, s.tip, Period::Blocks(u32::MAX))
            .await
            .map_err(|e| error(&e))?;
        let b = b.first();
        let body = RewardStats {
            start_block: lo,
            end_block: s.tip,
            total_reward: b.map_or(0, |b| b.reward).to_string(),
            total_fee: b.map_or(0, |b| b.fees).to_string(),
            total_tx: b.map_or(0, |b| b.tx_count).to_string(),
        };
        let from = time_of(store, lo, s).await.map_err(|e| error(&e))?;
        let coverage = Coverage {
            from: Some((lo, from)),
            complete: s.from <= want,
        };
        if moved(store, table.span).await.map_err(|e| error(&e))? {
            return Err(NOT_READY);
        }
        Ok::<_, ApiError>(fresh(
            &ctx,
            table,
            &body,
            Some(coverage),
            "mining_reward_stats",
        ))
    };
    run.await.unwrap_or_else(IntoResponse::into_response)
}

async fn pool_blocks_top(State(ctx): Ctx, Path(s): Path<String>) -> Response {
    pool_page(&ctx, &s, None).await
}

async fn pool_blocks(State(ctx): Ctx, Path((s, height)): Path<(String, String)>) -> Response {
    match number(&height, "invalid height") {
        Ok(h) => pool_page(&ctx, &s, Some(h)).await,
        Err(e) => e.into_response(),
    }
}

/// Up to [`POOL_PAGE`] of the pool's blocks below `below`, newest first.
async fn pool_page(ctx: &NetworkContext, s: &str, below: Option<u32>) -> Response {
    let run = async {
        let p = slug(s)?;
        let (store, table) = ready(ctx)?;
        let span = table.span;
        let below = below.unwrap_or(span.tip.saturating_add(1));
        let rows = blocks::pool_page(store, p.id, span.from, below, POOL_PAGE)
            .await
            .map_err(|e| error(&e))?;
        let network = crate::difficulty::chain(ctx.config.network);
        let body: Vec<_> = rows.iter().map(|r| PoolBlock::new(r, p, network)).collect();
        let coverage = Coverage {
            from: Some((span.from, span.from_time)),
            complete: span.from == 0,
        };
        if moved(store, table.span).await.map_err(|e| error(&e))? {
            return Err(NOT_READY);
        }
        Ok::<_, ApiError>(fresh(
            ctx,
            table,
            &body,
            Some(coverage),
            "mining_pool_blocks",
        ))
    };
    run.await.unwrap_or_else(IntoResponse::into_response)
}

async fn timestamp(State(ctx): Ctx, Path(t): Path<String>) -> Response {
    let run = async {
        let t: u64 = number(&t, "invalid timestamp")?;
        let (store, table) = ready(&ctx)?;
        let span = table.span;
        let found = blocks::at_or_before(store, span.from, t)
            .await
            .map_err(|e| error(&e))?
            .filter(|b| b.0 >= span.from)
            .ok_or(NO_HISTORY)?;
        let body = AtTime {
            height: found.0,
            hash: found.1.to_string(),
            timestamp: iso8601(found.2),
        };
        let coverage = Coverage {
            from: Some((span.from, span.from_time)),
            complete: span.from == 0,
        };
        if moved(store, table.span).await.map_err(|e| error(&e))? {
            return Err(NOT_READY);
        }
        Ok::<_, ApiError>(fresh(
            &ctx,
            table,
            &body,
            Some(coverage),
            "mining_block_timestamp",
        ))
    };
    run.await.unwrap_or_else(IntoResponse::into_response)
}

// Shapes, in the reference's field order.

#[derive(Serialize)]
struct ListEntry<'a> {
    name: &'a str,
    slug: &'a str,
    unique_id: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ranking<'a> {
    pools: Vec<Ranked<'a>>,
    block_count: u32,
    last_estimated_hashrate: Option<u128>,
    last_estimated_hashrate3d: Option<u128>,
    last_estimated_hashrate1w: Option<u128>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ranked<'a> {
    pool_id: u16,
    name: &'a str,
    link: &'a str,
    block_count: u32,
    rank: usize,
    empty_blocks: u32,
    slug: &'a str,
    /// Over the period's audited blocks: only those this server watched arrive.
    avg_match_rate: Option<f64>,
    avg_fee_delta: Option<f64>,
    pool_unique_id: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PoolStats<'a> {
    pool: PoolInfo<'a>,
    block_count: Periods<u32>,
    block_share: Periods<f64>,
    estimated_hashrate: Option<u128>,
    reported_hashrate: Option<u128>,
    avg_block_health: Option<f64>,
    total_reward: String,
}

#[derive(Serialize)]
struct PoolInfo<'a> {
    id: u16,
    name: &'a str,
    link: &'a str,
    addresses: &'a [String],
    /// The list's tags, matched as literal text.
    regexes: &'a [String],
    slug: &'a str,
    unique_id: u16,
}

#[derive(Serialize)]
struct Periods<T> {
    all: T,
    #[serde(rename = "24h")]
    day: T,
    #[serde(rename = "1w")]
    week: T,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PoolWeek<'a> {
    timestamp: u64,
    avg_hashrate: u128,
    share: f64,
    pool_name: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HashrateAnswer {
    hashrates: Vec<HashratePoint>,
    difficulty: Vec<Adjustment>,
    current_hashrate: Option<u128>,
    current_difficulty: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HashratePoint {
    timestamp: u64,
    avg_hashrate: u128,
}

#[derive(Serialize)]
struct Adjustment {
    time: u64,
    height: u32,
    difficulty: f64,
    adjustment: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RewardStats {
    start_block: u32,
    end_block: u32,
    total_reward: String,
    total_fee: String,
    total_tx: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeePoint {
    avg_height: u32,
    timestamp: u64,
    avg_fees: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RewardPoint {
    avg_height: u32,
    timestamp: u64,
    avg_rewards: u64,
}

#[derive(Serialize)]
struct RatePoint<T> {
    #[serde(rename = "avgHeight")]
    avg_height: u32,
    timestamp: u64,
    #[serde(rename = "avgFee_0")]
    min: T,
    #[serde(rename = "avgFee_10")]
    p10: T,
    #[serde(rename = "avgFee_25")]
    p25: T,
    #[serde(rename = "avgFee_50")]
    median: T,
    #[serde(rename = "avgFee_75")]
    p75: T,
    #[serde(rename = "avgFee_90")]
    p90: T,
    #[serde(rename = "avgFee_100")]
    max: T,
}

#[derive(Serialize)]
struct SizesWeights {
    sizes: Vec<SizePoint>,
    weights: Vec<WeightPoint>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SizePoint {
    avg_height: u32,
    timestamp: u64,
    avg_size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WeightPoint {
    avg_height: u32,
    timestamp: u64,
    avg_weight: u64,
}

#[derive(Serialize)]
struct AtTime {
    height: u32,
    hash: String,
    timestamp: String,
}

/// A block as the reference lists a pool's blocks, with the fields the block table holds. The
/// header fields it does not (version, bits, nonce, merkle root, previous hash, median time) and
/// the per-transaction extras are left out (`docs/API.md`).
#[derive(Serialize)]
struct PoolBlock<'a> {
    id: String,
    height: u32,
    timestamp: u64,
    difficulty: f64,
    tx_count: u32,
    size: u64,
    weight: u64,
    extras: Extras<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Extras<'a> {
    total_fees: u64,
    /// `None` until the backfill has rated the block.
    median_fee: Option<f64>,
    fee_range: Option<[f64; 7]>,
    reward: u64,
    pool: BlockPool<'a>,
    avg_fee: u64,
    avg_fee_rate: f64,
    /// Chain data: hex, and the bytes as Latin-1 characters, serialized as JSON strings.
    coinbase_raw: String,
    coinbase_address: Option<String>,
    coinbase_addresses: Vec<String>,
    coinbase_signature: Option<String>,
    coinbase_signature_ascii: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlockPool<'a> {
    id: u16,
    name: &'a str,
    slug: &'a str,
    miner_names: Option<Vec<String>>,
}

impl<'a> PoolBlock<'a> {
    fn new(r: &Row, p: &'a Pool, network: bitcoin::Network) -> Self {
        let paying = r.tx_count.saturating_sub(1);
        let rates = r.rates.and_then(|x| x.fee_rate);
        let addresses: Vec<String> = r
            .coinbase
            .payouts
            .iter()
            .filter_map(|s| Address::from_script(s, network).ok())
            .map(|a| a.to_string())
            .collect();
        Self {
            id: r.hash.to_string(),
            height: r.height,
            timestamp: r.time,
            difficulty: r.difficulty,
            tx_count: r.tx_count,
            size: r.size,
            weight: r.weight,
            extras: Extras {
                total_fees: r.fees,
                median_fee: rates.map(|f| round(f.median, 3)),
                fee_range: rates.map(|f| {
                    [f.min, f.p10, f.p25, f.median, f.p75, f.p90, f.max].map(|x| round(x, 3))
                }),
                reward: r.reward,
                pool: BlockPool {
                    id: p.id,
                    name: &p.name,
                    slug: &p.slug,
                    miner_names: None,
                },
                avg_fee: r.fees.checked_div(u64::from(paying)).unwrap_or(0),
                avg_fee_rate: if r.paying_weight == 0 {
                    0.0
                } else {
                    round(r.fees as f64 * 4.0 / r.paying_weight as f64, 3)
                },
                coinbase_raw: hex(&r.coinbase.tag),
                coinbase_address: addresses.first().cloned(),
                coinbase_addresses: addresses,
                coinbase_signature: r.coinbase.payouts.first().map(|s| asm(s)),
                coinbase_signature_ascii: r.coinbase.tag.iter().map(|&b| char::from(b)).collect(),
            },
        }
    }
}

fn asm(s: &Script) -> String {
    s.to_asm_string()
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

pub(crate) fn round(x: f64, places: i32) -> f64 {
    let f = 10f64.powi(places);
    (x * f).round() / f
}

/// Hashes a second as the reference prints them: a whole number, which can exceed `u64`.
fn whole(h: f64) -> u128 {
    // `as` saturates and maps NaN to 0.
    h.round() as u128
}

/// `2025-11-11T22:22:28.000Z`.
pub(crate) fn iso8601(t: u64) -> String {
    // Days to civil date (Howard Hinnant's algorithm), for dates after 1970.
    let days = t / DAY;
    let secs = t % DAY;
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + u64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        secs / 3600,
        secs / 60 % 60,
        secs % 60
    )
}

// Computing answers.

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

async fn time_of(store: &Store, height: u32, span: Span) -> Result<u64, store::Error> {
    if height == span.from {
        return Ok(span.from_time);
    }
    Ok(blocks::by_height(store, height)
        .await?
        .map_or(span.from_time, |r| r.time))
}

/// Heights of a period within the stored history.
struct Range {
    lo: u32,
    hi: u32,
    /// The history reaches back to the period's start.
    complete: bool,
}

impl Range {
    fn is_empty(&self) -> bool {
        self.lo > self.hi
    }
}

/// The stored blocks stamped from `start` on, cut to the history's span.
async fn since(store: &Store, span: Span, start: u64) -> Result<Range, store::Error> {
    let first = if start == 0 {
        0
    } else {
        blocks::first_since(store, span.from, start)
            .await?
            .unwrap_or(span.tip.saturating_add(1))
    };
    Ok(Range {
        lo: first.max(span.from),
        hi: span.tip,
        // Only rows are found, so `first` alone cannot tell a missing start: the history must
        // begin before the period does.
        complete: span.from == 0 || span.from_time < start,
    })
}

/// The network's hashrate over a range's blocks, timed from the block before the first, which
/// starts its first interval. `None` for an empty range, one block with nothing before it, or a
/// range the history does not hold whole, so a partial history is never given as its rate.
async fn range_hashrate(store: &Store, span: Span, r: &Range) -> Result<Option<f64>, store::Error> {
    if r.is_empty() || !r.complete {
        return Ok(None);
    }
    let lo = r.lo.saturating_sub(1).max(span.from);
    Ok(blocks::work(store, lo, r.hi)
        .await?
        .and_then(|w| hashrate::estimate(w.difficulty_sum, w.max_time.saturating_sub(w.min_time))))
}

/// The network's hashrate over the blocks stamped in the `seconds` before `now`: by time, not by
/// a count of blocks, which on a test network whose hashrate fell reaches back days.
async fn hashrate_over(
    store: &Store,
    span: Span,
    now: u64,
    seconds: u64,
) -> Result<Option<f64>, store::Error> {
    let r = since(store, span, now.saturating_sub(seconds)).await?;
    range_hashrate(store, span, &r).await
}

async fn coverage(store: &Store, span: Span, r: &Range) -> Result<Coverage, store::Error> {
    Ok(Coverage {
        from: if r.is_empty() {
            None
        } else {
            Some((r.lo, time_of(store, r.lo, span).await?))
        },
        complete: r.complete,
    })
}

/// Reads that several answers of one computation run make alike: the hashrate over the newest
/// blocks, the network's hashrate points over a range, and the pools' weekly counts. A refresh
/// reads each once for all the answers it recomputes; a request's computation has its own.
#[derive(Default)]
struct Shared {
    recent: Mutex<HashMap<u32, Option<f64>>>,
    points: Mutex<HashMap<(u64, bool), Arc<NetworkPoints>>>,
    weeks: Mutex<HashMap<(u32, u32), Weeks>>,
}

/// Every pool's blocks per week over a range.
type Weeks = Arc<Vec<blocks::PoolWeek>>;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    /// Hashrate over the last `n` blocks of the history, or fewer where it is shorter.
    async fn recent_hashrate(
        &self,
        store: &Store,
        span: Span,
        n: u32,
    ) -> Result<Option<f64>, store::Error> {
        if let Some(h) = lock(&self.recent).get(&n) {
            return Ok(*h);
        }
        let lo = span.tip.saturating_sub(n).max(span.from);
        let h = blocks::work(store, lo, span.tip).await?.and_then(|w| {
            hashrate::estimate(w.difficulty_sum, w.max_time.saturating_sub(w.min_time))
        });
        lock(&self.recent).insert(n, h);
        Ok(h)
    }

    async fn network_points(
        &self,
        store: &Store,
        span: Span,
        first_point: u64,
        weekly: bool,
    ) -> Result<Arc<NetworkPoints>, store::Error> {
        if let Some(p) = lock(&self.points).get(&(first_point, weekly)) {
            return Ok(Arc::clone(p));
        }
        let p = Arc::new(network_points(store, span, first_point, weekly).await?);
        lock(&self.points).insert((first_point, weekly), Arc::clone(&p));
        Ok(p)
    }

    async fn pool_weeks(&self, store: &Store, from: u32, to: u32) -> Result<Weeks, store::Error> {
        if let Some(w) = lock(&self.weeks).get(&(from, to)) {
            return Ok(Arc::clone(w));
        }
        let w = Arc::new(blocks::pool_weeks(store, from, to).await?);
        lock(&self.weeks).insert((from, to), Arc::clone(&w));
        Ok(w)
    }
}

/// The answer for `key` (a pool's comes with every pool's), or `None` if the table's chain moved
/// while it was read: its reads are separate, so they could mix two chains.
async fn compute(
    store: &Store,
    table: Table,
    key: Key,
    shared: &Shared,
) -> Result<Option<Vec<(Key, Answer)>>, store::Error> {
    let answers = compute_unchecked(store, table, key, shared).await?;
    Ok((!moved(store, table.span).await?).then_some(answers))
}

/// Whether the table's top row is no longer the tip `span` was taken at.
async fn moved(store: &Store, span: Span) -> Result<bool, store::Error> {
    Ok(blocks::top(store).await? != Some((span.tip, span.tip_hash)))
}

async fn compute_unchecked(
    store: &Store,
    table: Table,
    key: Key,
    shared: &Shared,
) -> Result<Vec<(Key, Answer)>, store::Error> {
    let span = table.span;
    let now = unix_now();
    Ok(match key {
        Key::List => {
            let body: Vec<_> = pools::list()
                .all()
                .iter()
                .map(|p| ListEntry {
                    name: &p.name,
                    slug: &p.slug,
                    unique_id: p.id,
                })
                .collect();
            vec![(key, answer(table, &body, None))]
        }
        Key::Pools(i) => {
            let r = since(store, span, i.start(now)).await?;
            let (counts, health) = if r.is_empty() {
                (Vec::new(), Vec::new())
            } else {
                (
                    blocks::pool_counts(store, r.lo, r.hi).await?,
                    audit::pool_health(store, r.lo, r.hi).await?,
                )
            };
            let list = pools::list();
            let body = Ranking {
                block_count: counts.iter().map(|c| c.blocks).sum(),
                pools: counts
                    .iter()
                    .enumerate()
                    .map(|(n, c)| {
                        let p = list.by_id(c.pool).or_else(|| list.by_id(UNKNOWN));
                        let (name, link, slug) = p.map_or(("Unknown", "", "unknown"), |p| {
                            (&*p.name, &*p.link, &*p.slug)
                        });
                        Ranked {
                            pool_id: c.pool,
                            name,
                            link,
                            block_count: c.blocks,
                            rank: n + 1,
                            empty_blocks: c.empty,
                            slug,
                            avg_match_rate: avg_health(&health, c.pool),
                            avg_fee_delta: None,
                            pool_unique_id: c.pool,
                        }
                    })
                    .collect(),
                last_estimated_hashrate: hashrate_over(store, span, now, DAY).await?.map(whole),
                last_estimated_hashrate3d: hashrate_over(store, span, now, 3 * DAY)
                    .await?
                    .map(whole),
                last_estimated_hashrate1w: hashrate_over(store, span, now, 7 * DAY)
                    .await?
                    .map(whole),
            };
            vec![(
                key,
                answer(table, &body, Some(coverage(store, span, &r).await?)),
            )]
        }
        Key::Pool(_) | Key::PoolHashrate(_) => pool_family(store, table, now, shared).await?,
        Key::Hashrate(i) => {
            let first_point = if i.weekly_hashrate() {
                week_floor(i.start(now))
            } else {
                i.start(now) / DAY * DAY
            };
            let points = shared
                .network_points(store, span, first_point, i.weekly_hashrate())
                .await?;
            let r = since(store, span, i.start(now)).await?;
            let difficulty = blocks::retargets(store, span.from, r.lo, r.hi)
                .await?
                .into_iter()
                .map(|t| Adjustment {
                    time: t.time,
                    height: t.height,
                    difficulty: t.difficulty,
                    adjustment: t.difficulty / t.previous,
                })
                .collect();
            let tip = blocks::by_height(store, span.tip).await?;
            let body = HashrateAnswer {
                hashrates: points
                    .points
                    .iter()
                    .map(|p| HashratePoint {
                        timestamp: p.time,
                        avg_hashrate: whole(p.hashrate),
                    })
                    .collect(),
                difficulty,
                current_hashrate: shared.recent_hashrate(store, span, 1008).await?.map(whole),
                current_difficulty: tip.map_or(0.0, |t| t.difficulty),
            };
            vec![(key, answer(table, &body, Some(points.coverage)))]
        }
        Key::HashratePools(i) => {
            let first_point = week_ceil(i.start(now));
            let net = shared
                .network_points(store, span, first_point, true)
                .await?;
            // Rows come oldest week first: one week's pools are adjacent.
            let weekly = shared.pool_weeks(store, net.lo, span.tip).await?;
            let list = pools::list();
            let mut body = Vec::new();
            for p in &net.points {
                let Some(&total) = net.blocks.get(&p.time) else {
                    continue;
                };
                let start = weekly.partition_point(|w| w.0 < p.time);
                let end = weekly.partition_point(|w| w.0 <= p.time);
                let mut week: Vec<_> = weekly.get(start..end).unwrap_or_default().iter().collect();
                week.sort_by(|a, b| b.2.cmp(&a.2).then(a.1.cmp(&b.1)));
                for (_, pool, n) in week {
                    let share = f64::from(*n) / f64::from(total.max(1));
                    body.push(PoolWeek {
                        timestamp: p.time,
                        avg_hashrate: whole(p.hashrate * share),
                        share: round(share, 6),
                        pool_name: list.by_id(*pool).map_or("Unknown", |p| &p.name),
                    });
                }
            }
            vec![(key, answer(table, &body, Some(net.coverage)))]
        }
        Key::Adjustments(i) => {
            let r = since(store, span, i.start(now)).await?;
            let mut body: Vec<(u64, u32, f64, f64)> =
                blocks::retargets(store, span.from, r.lo, r.hi)
                    .await?
                    .into_iter()
                    .map(|t| {
                        (
                            t.time,
                            t.height,
                            t.difficulty,
                            round(t.difficulty / t.previous, 5),
                        )
                    })
                    .collect();
            body.reverse();
            vec![(
                key,
                answer(table, &body, Some(coverage(store, span, &r).await?)),
            )]
        }
        Key::Fees(i)
        | Key::Rewards(i)
        | Key::SizesWeights(i)
        | Key::FeeRates(i)
        | Key::FeeRatesPrecise(i) => block_series(store, table, i, now).await?,
    })
}

/// The five block series of an interval, from one read of its buckets: asking for one computes
/// them all, as a pool's statistics come with every pool's.
async fn block_series(
    store: &Store,
    table: Table,
    i: Interval,
    now: u64,
) -> Result<Vec<(Key, Answer)>, store::Error> {
    let span = table.span;
    let r = since(store, span, i.start(now)).await?;
    let buckets = series(store, &r, i).await?;
    let c = Some(coverage(store, span, &r).await?);
    let mid = |b: &Bucket| (mid_height(b), mid_time(b));
    let avg = |sum: u64, b: &Bucket| sum.checked_div(u64::from(b.blocks)).unwrap_or(0);
    let fees: Vec<_> = buckets
        .iter()
        .map(|b| FeePoint {
            avg_height: mid(b).0,
            timestamp: mid(b).1,
            avg_fees: avg(b.fees, b),
        })
        .collect();
    let rewards: Vec<_> = buckets
        .iter()
        .map(|b| RewardPoint {
            avg_height: mid(b).0,
            timestamp: mid(b).1,
            avg_rewards: avg(b.reward, b),
        })
        .collect();
    let sizes = SizesWeights {
        sizes: buckets
            .iter()
            .map(|b| SizePoint {
                avg_height: mid(b).0,
                timestamp: mid(b).1,
                avg_size: avg(b.size, b),
            })
            .collect(),
        weights: buckets
            .iter()
            .map(|b| WeightPoint {
                avg_height: mid(b).0,
                timestamp: mid(b).1,
                avg_weight: avg(b.weight, b),
            })
            .collect(),
    };
    // A fee-rate point only where every block in it has fee rates: never an average of some.
    let rated: Vec<_> = buckets
        .iter()
        .filter(|b| b.rated == b.blocks)
        .filter_map(|b| Some((b, b.fee_rate?)))
        .collect();
    let all = buckets.iter().all(|b| b.rated == b.blocks);
    let rates_coverage = Some(Coverage {
        from: rated.first().map(|(b, _)| (b.first_height, b.first_time)),
        complete: r.complete && all && !buckets.is_empty(),
    });
    let precise: Vec<_> = rated
        .iter()
        .map(|(b, f)| rate_point(b, *f, |x| round(x, 3)))
        .collect();
    let whole_rates: Vec<_> = rated
        .iter()
        // Whole sat/vB, as the reference: rbitcoin's sub-sat rates round to 0.
        .map(|(b, f)| rate_point(b, *f, |x| whole(x) as u64))
        .collect();
    Ok(vec![
        (Key::Fees(i), answer(table, &fees, c)),
        (Key::Rewards(i), answer(table, &rewards, c)),
        (Key::SizesWeights(i), answer(table, &sizes, c)),
        (
            Key::FeeRates(i),
            answer(table, &whole_rates, rates_coverage),
        ),
        (
            Key::FeeRatesPrecise(i),
            answer(table, &precise, rates_coverage),
        ),
    ])
}

fn rate_point<T>(b: &Bucket, f: blocks::Rates, conv: impl Fn(f64) -> T) -> RatePoint<T> {
    RatePoint {
        avg_height: mid_height(b),
        timestamp: mid_time(b),
        min: conv(f.min),
        p10: conv(f.p10),
        p25: conv(f.p25),
        median: conv(f.median),
        p75: conv(f.p75),
        p90: conv(f.p90),
        max: conv(f.max),
    }
}

fn mid_height(b: &Bucket) -> u32 {
    b.first_height + (b.last_height - b.first_height) / 2
}

fn mid_time(b: &Bucket) -> u64 {
    b.first_time / 2 + b.last_time / 2
}

async fn series(store: &Store, r: &Range, i: Interval) -> Result<Vec<Bucket>, store::Error> {
    if r.is_empty() {
        return Ok(Vec::new());
    }
    blocks::periods(store, r.lo, r.hi, Period::Blocks(i.blocks_per_point())).await
}

fn week_floor(t: u64) -> u64 {
    let off = blocks::WEEK_OFFSET;
    if t < off {
        return 0;
    }
    (t - off) / WEEK * WEEK + off
}

fn week_ceil(t: u64) -> u64 {
    let f = week_floor(t);
    if f == t || t == 0 { f } else { f + WEEK }
}

/// The network's hashrate by day or week from `first_point` on, and what that rests on.
struct NetworkPoints {
    points: Vec<hashrate::Point>,
    /// Blocks in each point's bucket, by its start.
    blocks: HashMap<u64, u32>,
    /// The lowest height read: the first window's start.
    lo: u32,
    coverage: Coverage,
}

async fn network_points(
    store: &Store,
    span: Span,
    first_point: u64,
    weekly: bool,
) -> Result<NetworkPoints, store::Error> {
    // Each point looks a week back for the block its window starts after.
    let r = since(store, span, first_point.saturating_sub(7 * DAY)).await?;
    let days = if r.is_empty() {
        Vec::new()
    } else {
        blocks::periods(store, r.lo, r.hi, Period::Day).await?
    };
    let buckets = if weekly { hashrate::weeks(&days) } else { days };
    let points: Vec<_> = hashrate::series(&buckets, 7)
        .into_iter()
        .filter(|p| p.time >= first_point)
        .collect();
    let blocks = buckets
        .iter()
        .filter_map(|b| Some((u64::try_from(b.key).ok()? * DAY, b.blocks)))
        .collect();
    let from = match points.first() {
        Some(_) => Some((r.lo, time_of(store, r.lo, span).await?)),
        None => None,
    };
    Ok(NetworkPoints {
        coverage: Coverage {
            from,
            complete: r.complete,
        },
        points,
        blocks,
        lo: r.lo,
    })
}

/// The pool's mean match rate over its audited blocks, two decimals as the reference writes
/// it; `null` without one, as the reference answers for a pool with no audited block.
fn avg_health(health: &[audit::PoolHealth], pool: u16) -> Option<f64> {
    health
        .iter()
        .find(|h| h.pool == pool)
        .map(|h| round(h.match_rate, 2))
}

/// Every pool's statistics and weekly hashrate share, from five reads over the whole history.
async fn pool_family(
    store: &Store,
    table: Table,
    now: u64,
    shared: &Shared,
) -> Result<Vec<(Key, Answer)>, store::Error> {
    let span = table.span;
    let list = pools::list();
    let all = blocks::pool_counts(store, span.from, span.tip).await?;
    let health = audit::pool_health(store, span.from, span.tip).await?;
    let day = since(store, span, now.saturating_sub(DAY)).await?;
    let week = since(store, span, now.saturating_sub(7 * DAY)).await?;
    let in_day = if day.is_empty() {
        Vec::new()
    } else {
        blocks::pool_counts(store, day.lo, day.hi).await?
    };
    let in_week = if week.is_empty() {
        Vec::new()
    } else {
        blocks::pool_counts(store, week.lo, week.hi).await?
    };
    let day_hashrate = range_hashrate(store, span, &day).await?;
    let net = shared.network_points(store, span, 0, true).await?;
    // Each pool's weeks, oldest first, and the network's hashrate by week.
    let mut weekly: HashMap<u16, Vec<(u64, u32)>> = HashMap::new();
    for &(w, p, n) in shared.pool_weeks(store, span.from, span.tip).await?.iter() {
        weekly.entry(p).or_default().push((w, n));
    }
    let points: HashMap<u64, f64> = net.points.iter().map(|w| (w.time, w.hashrate)).collect();
    let coverage = Some(Coverage {
        from: Some((span.from, span.from_time)),
        complete: span.from == 0,
    });
    let count =
        |c: &[blocks::PoolCount], id| c.iter().find(|c| c.pool == id).map_or(0, |c| c.blocks);
    let total = |c: &[blocks::PoolCount]| c.iter().map(|c| c.blocks).sum::<u32>();
    let share = |n: u32, of: u32| {
        if of == 0 {
            0.0
        } else {
            f64::from(n) / f64::from(of)
        }
    };
    let mut out = Vec::new();
    for p in list.all() {
        let counts = Periods {
            all: count(&all, p.id),
            day: count(&in_day, p.id),
            week: count(&in_week, p.id),
        };
        let shares = Periods {
            all: share(counts.all, total(&all)),
            day: share(counts.day, total(&in_day)),
            week: share(counts.week, total(&in_week)),
        };
        let body = PoolStats {
            pool: PoolInfo {
                id: p.id,
                name: &p.name,
                link: &p.link,
                addresses: &p.addresses,
                regexes: &p.tags,
                slug: &p.slug,
                unique_id: p.id,
            },
            estimated_hashrate: day_hashrate.map(|h| whole(h * shares.day)),
            block_count: counts,
            block_share: shares,
            reported_hashrate: None,
            avg_block_health: avg_health(&health, p.id),
            total_reward: all
                .iter()
                .find(|c| c.pool == p.id)
                .map_or(0, |c| c.reward)
                .to_string(),
        };
        out.push((Key::Pool(p.id), answer(table, &body, coverage)));
        let weeks: Vec<_> = weekly
            .get(&p.id)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter_map(|&(time, n)| {
                let hashrate = *points.get(&time)?;
                let s = share(n, *net.blocks.get(&time)?);
                Some(PoolWeek {
                    timestamp: time,
                    avg_hashrate: whole(hashrate * s),
                    share: round(s, 6),
                    pool_name: &p.name,
                })
            })
            .collect();
        out.push((Key::PoolHashrate(p.id), answer(table, &weeks, coverage)));
    }
    Ok(out)
}

// The refresher.

/// Brings the pool column in line with the list, then keeps the asked-for answers current until
/// the network's tasks stop.
pub async fn run(ctx: Arc<NetworkContext>) {
    let Some(table) = &ctx.blocks else { return };
    tokio::spawn(fill(Arc::clone(&ctx)));
    let network = ctx.config.network;
    let store = &table.store;
    let mut failures = 0u32;
    loop {
        let started = Instant::now();
        match blocks::reattribute(store, pools::list()).await {
            Ok(done) => {
                if let Some(d) = done {
                    logging::emit(&PoolsReattributed {
                        network: network.name(),
                        rows: d.rows,
                        changed: d.changed,
                        duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                    });
                }
                break;
            }
            Err(e) => {
                failures += 1;
                failed(network, "reattribute", &e, failures);
                tokio::time::sleep(backoff(failures)).await;
            }
        }
    }
    let mut followed = table.followed.subscribe();
    let mut last = None;
    let mut refreshed = Instant::now();
    let mut version = 0u64;
    failures = 0;
    loop {
        match fingerprint(store).await {
            // Also when time alone has moved: a day's or a week's answer must drop old blocks.
            Ok(Some(fp)) if last != Some(fp) || refreshed.elapsed() >= MAX_AGE => {
                version += 1;
                let t = Table {
                    version,
                    span: fp.0,
                };
                ctx.mining.table.send_replace(Some(t));
                match refresh(&ctx.mining, network, store, t).await {
                    Ok(true) => {
                        last = Some(fp);
                        refreshed = Instant::now();
                        failures = 0;
                    }
                    Ok(false) => {}
                    Err(e) => {
                        failures += 1;
                        failed(network, "refresh", &e, failures);
                    }
                }
            }
            Ok(_) => {}
            Err(e) => {
                failures += 1;
                failed(network, "refresh", &e, failures);
            }
        }
        let wait = if failures == 0 {
            BACKFILL_REFRESH
        } else {
            backoff(failures)
        };
        tokio::select! {
            changed = followed.changed() => if changed.is_err() { return },
            () = tokio::time::sleep(wait) => {}
        }
    }
}

/// Totals the rows stored before the block table kept running totals, once; the reads scan until
/// it is done ([`blocks::fill_totals`]).
async fn fill(ctx: Arc<NetworkContext>) {
    let Some(table) = &ctx.blocks else { return };
    let network = ctx.config.network;
    let mut failures = 0u32;
    loop {
        match blocks::fill_totals(&table.store).await {
            Ok(done) => {
                if let Some(d) = done {
                    logging::emit(&BlockTotalsFilled {
                        network: network.name(),
                        heights: d.heights,
                        writes: d.writes,
                        duration_ms: d.elapsed.as_secs_f64() * 1000.0,
                        longest_write_ms: d.longest.as_secs_f64() * 1000.0,
                    });
                }
                return;
            }
            Err(e) => {
                failures += 1;
                failed(network, "totals", &e, failures);
                tokio::time::sleep(backoff(failures)).await;
            }
        }
    }
}

fn backoff(failures: u32) -> Duration {
    Duration::from_secs(1)
        .saturating_mul(1 << failures.saturating_sub(1).min(9))
        .min(RETRY_MAX)
}

/// What changes when the table does: the span, and how many rows there are and are rated.
async fn fingerprint(store: &Store) -> Result<Option<(Span, u64, u64)>, store::Error> {
    let Some(span) = blocks::span(store).await? else {
        return Ok(None);
    };
    let (rows, rated) = blocks::row_counts(store).await?;
    Ok(Some((span, rows, rated)))
}

/// Recomputes every answer a client has asked for, one at a time so requests interleave. `false`
/// if the table's chain moved meanwhile: the caller takes a new span and tries again.
async fn refresh(
    m: &Mining,
    network: Network,
    store: &Store,
    table: Table,
) -> Result<bool, store::Error> {
    let started = Instant::now();
    let keys: Vec<Key> = m
        .answers
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .keys()
        .copied()
        .collect();
    let mut families = std::collections::HashSet::new();
    let shared = Shared::default();
    let mut answers = 0;
    for key in keys {
        // One computation answers its whole family.
        if !families.insert(family(key)) {
            continue;
        }
        let _one = m.compute.lock().await;
        if m.get(key).is_some_and(|a| a.version == table.version) {
            continue;
        }
        let Some(computed) = compute(store, table, key, &shared).await? else {
            return Ok(false);
        };
        answers += computed.len();
        m.insert(computed);
    }
    logging::emit(&MiningRefreshed {
        network: network.name(),
        tip: table.span.tip,
        from: table.span.from,
        answers,
        duration_ms: started.elapsed().as_secs_f64() * 1000.0,
    });
    Ok(true)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]

    use super::*;

    /// Rows `heights` with a known pool's tag, a block every 600 s.
    async fn fill(store: &Store, heights: std::ops::Range<u32>) {
        store
            .write(move |sql| {
                let mut stmt = sql.prepare(
                    "INSERT INTO blocks (height, hash, time, tx_count, size, weight, \
                     paying_weight, fees, subsidy, reward, difficulty, coinbase_tag, payouts, pool) \
                     VALUES (?1, ?2, ?3, 2, 1000, 4000, 3000, 10, 50, 60, 1.0, x'', x'', 88)",
                )?;
                for h in heights {
                    let mut hash = [0u8; 32];
                    hash[..4].copy_from_slice(&h.to_le_bytes());
                    stmt.execute(store::params![h, &hash[..], 1_700_000_000 + i64::from(h) * 600])?;
                }
                Ok(())
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_new_block_refreshes_the_answers_asked_for() {
        let dir =
            std::env::temp_dir().join(format!("rbitcoin-space-mining-unit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(&dir, "regtest", store::Options::default()).unwrap();
        fill(&store, 0..11).await;
        let m = Mining::default();
        let span = blocks::span(&store).await.unwrap().unwrap();
        let t1 = Table { version: 1, span };
        let all = Key::Pools(Interval::All);
        m.insert(
            compute(&store, t1, all, &Shared::default())
                .await
                .unwrap()
                .unwrap(),
        );
        let count = |m: &Mining| {
            let a = m.get(all).unwrap();
            let v: serde_json::Value = serde_json::from_slice(&a.body).unwrap();
            (a.version, a.tip_height, v["blockCount"].as_u64().unwrap())
        };
        assert_eq!(count(&m), (1, 10, 11));

        // A block arrives: the next refresh redoes what was asked for, and only that.
        fill(&store, 11..12).await;
        let (span2, _, _) = fingerprint(&store).await.unwrap().unwrap();
        assert_eq!((span2.tip, span2.from), (11, 0));
        let t2 = Table {
            version: 2,
            span: span2,
        };
        // Refreshing with the old span while the table holds a new tip publishes nothing.
        let t_stale = Table { version: 2, span };
        assert!(
            !refresh(&m, Network::Regtest, &store, t_stale)
                .await
                .unwrap()
        );
        assert_eq!(count(&m), (1, 10, 11));
        assert!(refresh(&m, Network::Regtest, &store, t2).await.unwrap());
        assert_eq!(count(&m), (2, 11, 12));
        assert!(m.get(Key::Hashrate(Interval::All)).is_none());
        // Nothing changed: nothing recomputed.
        let before = Arc::as_ptr(&m.get(all).unwrap());
        refresh(&m, Network::Regtest, &store, t2).await.unwrap();
        assert_eq!(Arc::as_ptr(&m.get(all).unwrap()), before);
        // A pool's answers come as a family: every pool's, from one computation.
        m.insert(
            compute(&store, t2, Key::Pool(88), &Shared::default())
                .await
                .unwrap()
                .unwrap(),
        );
        assert!(m.get(Key::PoolHashrate(1)).is_some());
        store.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The first computation of every mining answer on the store in
    /// `$MINING_BENCH_DIR/$MINING_BENCH_NET.sqlite` (filling its totals first if they are not),
    /// then three new blocks, each written as `follow` writes one and followed by the refresh of
    /// every answer. Run with `MINING_BENCH_DIR=<dir> MINING_BENCH_NET=mainnet cargo test
    /// --release -p rbitcoin-space -- --ignored --nocapture answers_benchmark` on a copy: it
    /// writes the blocks and deletes them again.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "reads a store of mainnet's size; a benchmark, not a test"]
    #[allow(clippy::print_stdout)] // A benchmark's report.
    async fn answers_benchmark() {
        let dir = std::path::PathBuf::from(std::env::var_os("MINING_BENCH_DIR").unwrap());
        let net = std::env::var("MINING_BENCH_NET").unwrap_or_else(|_| "regtest".into());
        let store = Store::open(&dir, &net, store::Options::default()).unwrap();
        let started = Instant::now();
        if let Some(f) = blocks::fill_totals(&store).await.unwrap() {
            println!(
                "filled the totals: {} heights in {} writes, {:.0} ms, the longest {:.0} ms",
                f.heights,
                f.writes,
                started.elapsed().as_secs_f64() * 1000.0,
                f.longest.as_secs_f64() * 1000.0
            );
        }
        let ms = |s: Instant| s.elapsed().as_secs_f64() * 1000.0;
        let s = Instant::now();
        let (span, _, _) = fingerprint(&store).await.unwrap().unwrap();
        println!("fingerprint (span and counts): {:.2} ms", ms(s));
        let m = Mining::default();
        let t = Table { version: 1, span };
        let mut keys = vec![Key::List, Key::Pool(0)];
        for i in Interval::ALL {
            keys.extend([
                Key::Pools(i),
                Key::Hashrate(i),
                Key::HashratePools(i),
                Key::Adjustments(i),
                Key::Fees(i),
            ]);
        }
        let mut total = 0.0;
        let shared = Shared::default();
        for key in keys {
            let s = Instant::now();
            let a = compute(&store, t, key, &shared).await.unwrap().unwrap();
            let took = ms(s);
            total += took;
            println!("first {key:?}: {took:.2} ms ({} answers)", a.len());
            m.insert(a);
        }
        println!("every first answer: {total:.1} ms");
        for n in 1..=3u32 {
            let s = Instant::now();
            let tip = span.tip + n;
            store
                .write(move |sql| {
                    sql.prepare(
                        "INSERT OR REPLACE INTO blocks (height, hash, time, tx_count, size, \
                         weight, paying_weight, fees, subsidy, reward, difficulty, \
                         coinbase_tag, payouts, rated, fee_min, fee_p10, fee_p25, fee_median, \
                         fee_p75, fee_p90, fee_max, band0, band1, band2, band3, band4, band5, \
                         band6, band7, band8, band9, pool) \
                         SELECT height + 1, randomblob(32), time + 600, tx_count, size, weight, \
                         paying_weight, fees, subsidy, reward, difficulty, coinbase_tag, \
                         payouts, rated, fee_min, fee_p10, fee_p25, fee_median, fee_p75, \
                         fee_p90, fee_max, band0, band1, band2, band3, band4, band5, band6, \
                         band7, band8, band9, pool FROM blocks WHERE height = ?1",
                    )?
                    .execute(store::params![tip - 1])?;
                    Ok(())
                })
                .await
                .unwrap();
            let write = ms(s);
            let s = Instant::now();
            let (span, _, _) = fingerprint(&store).await.unwrap().unwrap();
            let fp = ms(s);
            let s = Instant::now();
            let t = Table {
                version: 1 + u64::from(n),
                span,
            };
            assert!(refresh(&m, Network::Regtest, &store, t).await.unwrap());
            println!(
                "block {n}: write {write:.2} ms, fingerprint {fp:.2} ms, refresh of every \
                 answer {:.1} ms",
                ms(s)
            );
        }
        store
            .write(move |sql| {
                sql.prepare("DELETE FROM blocks WHERE height > ?1")?
                    .execute(store::params![span.tip])?;
                Ok(())
            })
            .await
            .unwrap();
        store.close().await;
    }

    #[test]
    fn iso8601_matches_known_dates() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(1_762_899_748), "2025-11-11T22:22:28.000Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso8601(4_102_444_799), "2099-12-31T23:59:59.000Z");
    }

    #[test]
    fn weeks_round_to_mondays() {
        let monday = 1_775_433_600;
        assert_eq!(week_floor(monday), monday);
        assert_eq!(week_floor(monday + 3 * DAY), monday);
        assert_eq!(week_ceil(monday + 1), monday + WEEK);
        assert_eq!(week_ceil(monday), monday);
        assert_eq!(week_floor(5), 0);
    }

    #[test]
    fn numbers_are_digits_only() {
        assert_eq!(number::<u32>("144", "x"), Ok(144));
        for bad in ["", "+1", "-1", " 1", "1e3", "0x10", "4294967296"] {
            assert!(number::<u32>(bad, "x").is_err(), "{bad:?}");
        }
    }
}
