//! mempool.space-shaped routes under `/api/v1` (`docs/API.md`, `docs/compat/api-v1.md`).
//!
//! The pattern for every route here: field names and types as observed on the reference backend,
//! values computed by us; answered from memory that a background task keeps current, never by a
//! call to the node per request; `{"error": …}` and a 503 with `Retry-After` until that memory is
//! filled; the chain-tip headers naming the tip the answer is as of; query strings ignored.

use std::sync::Arc;
use std::time::SystemTime;

use axum::extract::State;
use axum::http::header::{AGE, CACHE_CONTROL};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::NetworkContext;
use crate::difficulty::{Answer, unix_ms};
use crate::error::ApiError;
use crate::ws::fees::Source;

pub(crate) const NOT_READY: ApiError =
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "not ready yet; retry");
pub(crate) const MEMPOOL_OFF: ApiError = ApiError::new(
    StatusCode::SERVICE_UNAVAILABLE,
    "the mempool engine is off on this server",
);

/// The answers change at most once a block, but time-based fields move every second.
const CACHE: &str = "public, max-age=1";

/// In the reference's field order. Times are Unix milliseconds except `previousTime` (seconds).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DifficultyAdjustment {
    progress_percent: f64,
    difficulty_change: f64,
    estimated_retarget_date: u64,
    remaining_blocks: u32,
    remaining_time: u64,
    previous_retarget: f64,
    previous_time: u64,
    next_retarget_height: u32,
    time_avg: u64,
    /// Kept for clients that read them: we make no adjustment and no offset.
    adjusted_time_avg: u64,
    time_offset: i64,
    expected_blocks: f64,
}

pub fn routes() -> Router<Arc<NetworkContext>> {
    Router::new()
        .route("/api/v1/difficulty-adjustment", get(difficulty_adjustment))
        .route("/api/v1/fees/recommended", get(fees_recommended))
        .route("/api/v1/fees/precise", get(fees_precise))
        .route("/api/v1/fees/mempool-blocks", get(fees_mempool_blocks))
        .route("/api/v1/backend-info", get(backend_info_route))
        .merge(crate::mining::routes())
        .merge(crate::statistics::routes())
        .merge(crate::v1_blocks::routes())
}

/// `/backend-info` in the reference's field order. What it says about its own stack (the host's
/// name and OS, the node's version) is `null` here: private, or a node call (`docs/API.md`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendInfo {
    hostname: Option<&'static str>,
    version: &'static str,
    /// The commit `/healthz` reports, `null` for a build without one.
    git_commit: Option<&'static str>,
    lightning: bool,
    backend: &'static str,
    core_version: Option<&'static str>,
    os_version: Option<&'static str>,
}

/// Also sent on the compatible socket, in its answer to `init`.
pub(crate) fn backend_info(ctx: &NetworkContext) -> BackendInfo {
    BackendInfo {
        hostname: None,
        version: env!("CARGO_PKG_VERSION"),
        git_commit: (crate::REVISION != "unknown").then_some(crate::REVISION),
        lightning: ctx.lightning.is_some(),
        // Transactions and addresses come from the node's Esplora, as the reference's do in
        // this mode.
        backend: "esplora",
        core_version: None,
        os_version: None,
    }
}

async fn backend_info_route(State(ctx): State<Arc<NetworkContext>>) -> Response {
    let mut res = Json(backend_info(&ctx)).into_response();
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static(CACHE));
    res
}

/// The reference's five levels, in its order. `T` is whole sat/vB (`u64`) or precise (`f64`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeeLevels<T> {
    fastest_fee: T,
    half_hour_fee: T,
    hour_fee: T,
    economy_fee: T,
    minimum_fee: T,
}

impl<T> FeeLevels<T> {
    fn of(r: &engine::fees::Rates, f: impl Fn(u32) -> T) -> Self {
        let [fastest, half_hour, hour, economy] = r.levels;
        Self {
            fastest_fee: f(fastest),
            half_hour_fee: f(half_hour),
            hour_fee: f(hour),
            economy_fee: f(economy),
            minimum_fee: f(r.minimum),
        }
    }
}

/// Sat/vB from sat per 1,000 vB: exact to the node's resolution, three decimals.
fn sat_vb(rate: u32) -> f64 {
    f64::from(rate) / 1000.0
}

async fn fees_recommended(State(ctx): State<Arc<NetworkContext>>) -> Response {
    fee_levels(&ctx, |r| FeeLevels::of(r, engine::fees::whole))
}

async fn fees_precise(State(ctx): State<Arc<NetworkContext>>) -> Response {
    fee_levels(&ctx, precise)
}

/// `/fees/precise`'s body; also the `fees` of `/api/v1/ws`.
pub(crate) fn precise(r: &engine::fees::Rates) -> FeeLevels<f64> {
    FeeLevels::of(r, sat_vb)
}

fn fee_levels<T: Serialize>(
    ctx: &NetworkContext,
    body: impl Fn(&engine::fees::Rates) -> FeeLevels<T>,
) -> Response {
    ctx.fees.want();
    let Some(answer) = ctx.fees.current() else {
        return NOT_READY.into_response();
    };
    let mut res = Json(body(&answer.rates)).into_response();
    let h = res.headers_mut();
    h.insert(CACHE_CONTROL, HeaderValue::from_static(CACHE));
    h.insert(
        "x-fee-source",
        HeaderValue::from_static(answer.source.name()),
    );
    tip_headers(&mut res, answer.tip);
    if answer.source == Source::Node {
        age(&mut res, answer.at);
    }
    res
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MempoolBlockJson {
    block_size: u64,
    #[serde(rename = "blockVSize")]
    block_vsize: u64,
    n_tx: u32,
    total_fees: u64,
    median_fee: f64,
    fee_range: Vec<f64>,
}

async fn fees_mempool_blocks(State(ctx): State<Arc<NetworkContext>>) -> Response {
    if !ctx.config.mempool {
        return MEMPOOL_OFF.into_response();
    }
    let Some(b) = ctx.fees.blocks() else {
        return NOT_READY.into_response();
    };
    let mut res = Json(mempool_blocks(&b)).into_response();
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static(CACHE));
    tip_headers(&mut res, b.tip);
    if b.stale {
        age(&mut res, b.at);
    }
    res
}

/// `/fees/mempool-blocks`' body; also the `mempool-blocks` of `/api/v1/ws`.
pub(crate) fn mempool_blocks(b: &crate::ws::fees::Blocks) -> Vec<MempoolBlockJson> {
    b.blocks
        .iter()
        // An empty projected block has nothing to report: only a mempool smaller than the blocks.
        .filter(|m| m.txs > 0)
        .map(|m| MempoolBlockJson {
            block_size: m.size,
            block_vsize: m.vsize,
            n_tx: m.txs,
            total_fees: m.fees,
            median_fee: sat_vb(m.median),
            fee_range: m.range.iter().copied().map(sat_vb).collect(),
        })
        .collect()
}

fn tip_headers(res: &mut Response, tip: Option<node::esplora::ChainTip>) {
    let Some(tip) = tip else { return };
    let h = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&tip.hash.to_string()) {
        h.insert("x-bitcoin-chain-tip", v);
    }
    h.insert("x-bitcoin-chain-tip-height", HeaderValue::from(tip.height));
}

/// Seconds since `at`: the answer is not known to be current.
fn age(res: &mut Response, at: SystemTime) {
    let secs = SystemTime::now()
        .duration_since(at)
        .unwrap_or_default()
        .as_secs();
    res.headers_mut().insert(AGE, HeaderValue::from(secs));
}

async fn difficulty_adjustment(State(ctx): State<Arc<NetworkContext>>) -> Response {
    let Some(answer) = ctx.difficulty.current() else {
        return NOT_READY.into_response();
    };
    let now = SystemTime::now();
    let mut res = Json(difficulty(&answer, now)).into_response();
    stamp(&mut res, &ctx, &answer, now);
    res
}

/// `/difficulty-adjustment`'s body at `now`; also the `da` of `/api/v1/ws`.
pub(crate) fn difficulty(answer: &Answer, now: SystemTime) -> DifficultyAdjustment {
    let e = answer.period.estimate(unix_ms(now));
    DifficultyAdjustment {
        progress_percent: e.progress_percent,
        difficulty_change: e.difficulty_change,
        estimated_retarget_date: e.estimated_retarget_ms,
        remaining_blocks: e.remaining_blocks,
        remaining_time: e.remaining_ms,
        previous_retarget: e.previous_retarget,
        previous_time: e.previous_time,
        next_retarget_height: e.next_retarget_height,
        time_avg: e.time_avg_ms,
        adjusted_time_avg: e.time_avg_ms,
        time_offset: 0,
        expected_blocks: e.expected_blocks,
    }
}

/// Cache headers, the tip the answer is as of, and `Age` when the node cannot confirm the answer
/// is current (disconnected, or a newer tip not yet computed): seconds since it was computed.
fn stamp(res: &mut Response, ctx: &NetworkContext, answer: &Answer, now: SystemTime) {
    let h = res.headers_mut();
    h.insert(CACHE_CONTROL, HeaderValue::from_static(CACHE));
    if let Ok(tip) = HeaderValue::from_str(&answer.tip.to_string()) {
        h.insert("x-bitcoin-chain-tip", tip);
    }
    h.insert(
        "x-bitcoin-chain-tip-height",
        HeaderValue::from(answer.period.tip_height()),
    );
    let current = ctx.electrum.health().borrow().ready
        && ctx.electrum.tip().is_some_and(|t| t.hash == answer.tip);
    if !current {
        let age = now
            .duration_since(answer.computed)
            .unwrap_or_default()
            .as_secs();
        h.insert(AGE, HeaderValue::from(age));
    }
}
