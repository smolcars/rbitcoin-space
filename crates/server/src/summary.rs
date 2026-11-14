//! Block summaries in the private `/app` API (`docs/FRONTEND.md`): one block's fee facts, its
//! transactions as fixed-width records, and the facts of up to [`MAX_BATCH`] blocks at once.
//!
//! One summary costs the node a block listing ([`Lister`]): on a node with
//! `/block/:hash/txs/summary`, about 0.2 MB and a few tens of milliseconds for a full mainnet
//! block, three small Esplora calls; without it, a `getblock` at verbosity 2, about 10 MB and
//! most of a second. So (SECURITY.md rules 6–8):
//! - a computation runs in its own task, and every request for that block meanwhile joins it;
//! - results are kept in a cache bounded in bytes (`BLOCK_SUMMARY_CACHE_MB`), least recently
//!   used out first, and the newest [`WARM_BLOCKS`] are computed as blocks arrive;
//! - at most [`MAX_RUNNING`] computation runs per network, leaving the rest of the RPC client's
//!   slots to the mempool tracker, and at most [`MAX_PENDING`] started by clients run or wait;
//!   past that a request is answered `503` at once;
//! - each client may start [`CLIENT_BURST`] computations, then one per [`CLIENT_EVERY`].
//!
//! A summary is fixed by the block's hash, so answers are cached for good by clients and proxies.

pub use engine::blocks::stats;

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, RETRY_AFTER};
use axum::http::{HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use bitcoin::{BlockHash, Txid};
use engine::audit::Totals;
use engine::blocks::Lister;
use engine::blocks::listing::Event as Listed;
use logging::events::{
    BlockSummariesRecovered, BlockSummariesRefused, BlockSummaryComputed, BlockSummaryFailed,
    BlockTxsFellBack, BlockTxsSource,
};
use node::electrum::Event as ElectrumEvent;
use node::rpc::Error as RpcError;
use serde::Serialize;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};

use crate::esplora::{ApiOutcome, Source};
use crate::limits::{Client, Clients, Refused};
use crate::ws::{Snapshot, Topic};
use crate::{ApiError, IMMUTABLE, Network, NetworkContext};
use stats::Facts;

/// Computations running at once per network: at most one `getblock` of the RPC client's four
/// slots where the node has no listing route.
pub const MAX_RUNNING: usize = 1;
/// Client-started computations running or waiting per network. At about 0.9 s each on mainnet,
/// the last one in the queue still answers well inside the 10 s request timeout.
pub const MAX_PENDING: usize = 6;
/// Computations a client may start at once: a page of ten block tiles.
pub const CLIENT_BURST: u32 = 10;
/// Then one computation per this long, per client.
pub const CLIENT_EVERY: Duration = Duration::from_secs(2);
/// Most blocks `/app/blocks/summary` takes: one page of `/api/blocks`.
pub const MAX_BATCH: usize = 10;
/// Blocks computed back from each new tip, unless already cached.
pub const WARM_BLOCKS: usize = 10;
/// Bytes counted per cache entry on top of its records: the facts, the map entry and pointers.
const ENTRY_OVERHEAD: usize = 512;

/// One block's summary as served.
#[derive(Debug)]
pub struct Summary {
    pub facts: Facts,
    /// [`stats::encode_txs`].
    pub txs: Bytes,
    /// Each transaction's txid and weight, in the records' order: what `/api/v1` adds to them.
    ids: Vec<(Txid, u32)>,
    prev: Option<BlockHash>,
    /// The block's audit, decided before the summary is published.
    audit: Option<Totals>,
}

impl Summary {
    fn size(&self) -> usize {
        self.txs.len() + self.ids.len() * std::mem::size_of::<(Txid, u32)>() + ENTRY_OVERHEAD
    }

    /// Every transaction in block order, as `/api/v1/block/:hash/summary` lists them.
    fn rows(&self) -> impl Iterator<Item = TxRow> + '_ {
        let records = self
            .txs
            .get(stats::TXS_HEADER..)
            .unwrap_or_default()
            .as_chunks::<{ stats::TXS_RECORD }>()
            .0;
        self.ids.iter().zip(records).map(|(&(txid, weight), r)| {
            // A record is vsize `u32`, fee `u64`, value `u64`, little-endian.
            let num = |at: usize| {
                r.get(at..at + 8)
                    .and_then(|b| b.try_into().ok())
                    .map_or(0, u64::from_le_bytes)
            };
            let fee = num(4);
            let whole = r
                .get(..4)
                .and_then(|b| b.try_into().ok())
                .map_or(0, u32::from_le_bytes);
            TxRow {
                txid,
                fee,
                vsize: f64::from(weight) / 4.0,
                value: num(12),
                rate: if whole == 0 {
                    0.0
                } else {
                    fee as f64 / f64::from(whole)
                },
            }
        })
    }
}

/// One transaction as the reference's block summary lists it. `vsize` is weight / 4, unrounded,
/// as the reference gives it; `rate` is the fee over the node's vsize (whole vbytes), as the
/// reference's is for every transaction it does not rate as part of a package.
#[derive(Debug, Serialize)]
struct TxRow {
    txid: Txid,
    fee: u64,
    vsize: f64,
    value: u64,
    rate: f64,
}

/// Why a computation produced no summary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failure {
    NotFound,
    /// The node's work queue is full.
    Busy,
    /// The node refused our RPC credentials.
    Auth,
    Timeout,
    TooBig,
    Decode,
    Unavailable,
    /// The computing task ended without an answer.
    Lost,
}

impl Failure {
    fn from_rpc(e: &RpcError) -> Self {
        match e {
            RpcError::Rpc { code: -5, .. } => Self::NotFound,
            RpcError::Busy => Self::Busy,
            RpcError::Auth => Self::Auth,
            RpcError::Timeout => Self::Timeout,
            RpcError::ResponseTooBig => Self::TooBig,
            RpcError::Decode(_) => Self::Decode,
            _ => Self::Unavailable,
        }
    }

    /// The `upstream_error` label of the request event; `None` for an answer that is not a failure.
    fn label(self) -> Option<&'static str> {
        match self {
            Self::NotFound => None,
            Self::Busy => Some("busy"),
            Self::Auth => Some("auth"),
            Self::Timeout => Some("timeout"),
            Self::TooBig => Some("response_too_big"),
            Self::Decode => Some("decode"),
            Self::Unavailable | Self::Lost => Some("unavailable"),
        }
    }

    fn error(self) -> ApiError {
        match self {
            Self::NotFound => ApiError::NOT_FOUND,
            Self::Busy => ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "node busy"),
            Self::Timeout => ApiError::TIMEOUT,
            // A client learns only that the node is unavailable; the log says why.
            Self::Auth | Self::TooBig | Self::Decode | Self::Unavailable => ApiError::UPSTREAM,
            Self::Lost => ApiError::INTERNAL,
        }
    }
}

type Outcome = Result<Arc<Summary>, Failure>;
/// A computation in flight; it sends its outcome once.
type Flight = watch::Receiver<Option<Outcome>>;

/// Per-network state, held in [`NetworkContext`].
#[derive(Debug)]
pub struct Summaries {
    state: Mutex<Shared>,
    pending: Arc<Semaphore>,
    running: Semaphore,
    clients: Arc<Clients>,
    /// The newest block, for [`worker`].
    tip: watch::Sender<Option<(BlockHash, Instant)>>,
    /// Node failures in a row, for [`BlockSummaryFailed`].
    failures: AtomicU32,
    refused_busy: AtomicU64,
    refused_rate: AtomicU64,
}

#[derive(Debug)]
struct Shared {
    cache: Lru,
    flights: HashMap<BlockHash, Flight>,
}

/// What [`Summaries::start`] found.
enum Start {
    Cached(Arc<Summary>),
    Joined(Flight),
    Started(Flight),
}

/// Who asks for a computation.
#[derive(Debug, Clone, Copy)]
enum Cause {
    /// A client: counted under [`MAX_PENDING`] and its own rate.
    Request(IpAddr),
    /// The [`worker`]: one computation at a time, outside both.
    NewBlock,
}

impl Summaries {
    pub fn new(cache_bytes: usize, max_tracked_clients: usize) -> Self {
        Self {
            state: Mutex::new(Shared {
                cache: Lru::new(cache_bytes),
                flights: HashMap::new(),
            }),
            pending: Arc::new(Semaphore::new(MAX_PENDING)),
            running: Semaphore::new(MAX_RUNNING),
            clients: Clients::with_rate(
                1.0 / CLIENT_EVERY.as_secs_f64(),
                CLIENT_BURST,
                max_tracked_clients,
            ),
            tip: watch::Sender::new(None),
            failures: AtomicU32::new(0),
            refused_busy: AtomicU64::new(0),
            refused_rate: AtomicU64::new(0),
        }
    }

    /// The newest block as [`Summaries::new_tip`] last heard of it; the block table follows it.
    pub fn tips(&self) -> watch::Receiver<Option<(BlockHash, Instant)>> {
        self.tip.subscribe()
    }

    /// Tells the [`worker`] about a new best block, announced at `since`.
    pub fn new_tip(&self, hash: BlockHash, since: Instant) {
        self.tip.send_replace(Some((hash, since)));
    }

    /// Bytes the cache holds, as it counts them, and its entries. For tests and measurements.
    pub fn cached(&self) -> (usize, usize) {
        let state = self.lock();
        (state.cache.bytes, state.cache.map.len())
    }

    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The cached summary, the flight computing it, or a new flight, unless a limit says no.
    fn start(
        &self,
        ctx: &Arc<NetworkContext>,
        hash: BlockHash,
        cause: Cause,
    ) -> Result<Start, Refused> {
        let mut state = self.lock();
        if let Some(s) = state.cache.get(&hash) {
            return Ok(Start::Cached(s));
        }
        if let Some(flight) = state.flights.get(&hash) {
            return Ok(Start::Joined(flight.clone()));
        }
        let permit = match cause {
            Cause::Request(addr) => {
                let Ok(permit) = Arc::clone(&self.pending).try_acquire_owned() else {
                    self.refused(ctx, "summary_busy");
                    return Err(Refused {
                        error: ApiError::OVERLOADED,
                        reason: "summary_busy",
                    });
                };
                if let Err(refused) = self.clients.take(addr) {
                    self.refused(ctx, refused.reason);
                    return Err(refused);
                }
                Some(permit)
            }
            Cause::NewBlock => None,
        };
        let (tx, flight) = watch::channel(None);
        state.flights.insert(hash, flight.clone());
        drop(state);
        let landing = Landing {
            ctx: Arc::clone(ctx),
            hash,
        };
        tokio::spawn(compute(landing, permit, cause, tx));
        Ok(Start::Started(flight))
    }

    /// Counts a refusal; logged when the count for that reason reaches a power of two.
    fn refused(&self, ctx: &NetworkContext, reason: &'static str) {
        let counter = if reason == "summary_busy" {
            &self.refused_busy
        } else {
            &self.refused_rate
        };
        let total = counter.fetch_add(1, Ordering::Relaxed) + 1;
        if total.is_power_of_two() {
            logging::emit(&BlockSummariesRefused {
                network: ctx.config.network.name(),
                reason,
                total,
            });
        }
    }
}

/// Removes a flight from the map when its task ends, normally or not, so a block whose
/// computation failed is computed afresh by the next request.
struct Landing {
    ctx: Arc<NetworkContext>,
    hash: BlockHash,
}

impl Drop for Landing {
    fn drop(&mut self) {
        self.ctx.summaries.lock().flights.remove(&self.hash);
    }
}

async fn compute(
    landing: Landing,
    pending: Option<OwnedSemaphorePermit>,
    cause: Cause,
    tx: watch::Sender<Option<Outcome>>,
) {
    let ctx = &landing.ctx;
    let s = &ctx.summaries;
    let started = Instant::now();
    let (block, via, node_ms) = {
        // Never closed, so this cannot fail.
        let _running = s.running.acquire().await;
        let called = Instant::now();
        let (block, via) = ctx.lister.block(&ctx.rpc, &ctx.esplora, landing.hash).await;
        (block, via, called.elapsed().as_secs_f64() * 1000.0)
    };
    drop(pending);
    let network = ctx.config.network.name();
    let outcome = match block {
        // A different block under the asked hash would poison the cache for good.
        Ok(b) if b.hash != landing.hash => Err(Failure::Decode),
        Ok(b) => {
            let txs: Bytes = stats::encode_txs(&b).into();
            logging::emit(&BlockSummaryComputed {
                network,
                height: b.height,
                txs: b.tx.len(),
                block_bytes: b.size,
                bytes: txs.len(),
                node_ms,
                duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                cause: match cause {
                    Cause::Request(_) => "request",
                    Cause::NewBlock => "new_block",
                },
                source: via.label(),
            });
            // Before the summary is published, so its facts carry the audit from the start.
            let audit = crate::audits::for_block(ctx, &b).await;
            Ok(Arc::new(Summary {
                facts: stats::facts(&b),
                txs,
                ids: b.tx.iter().map(|t| (t.txid, t.weight)).collect(),
                prev: b.previousblockhash,
                audit,
            }))
        }
        Err(e) => Err(Failure::from_rpc(&e)),
    };
    match &outcome {
        Ok(summary) => {
            s.lock().cache.insert(landing.hash, Arc::clone(summary));
            let failures = s.failures.swap(0, Ordering::Relaxed);
            if failures > 0 {
                logging::emit(&BlockSummariesRecovered { network, failures });
            }
        }
        Err(Failure::NotFound) => {}
        Err(f) => {
            let failures = s.failures.fetch_add(1, Ordering::Relaxed) + 1;
            if failures.is_power_of_two() {
                logging::emit(&BlockSummaryFailed {
                    network,
                    error: f.label().unwrap_or("unavailable"),
                    failures,
                });
            }
        }
    }
    drop(landing);
    tx.send_replace(Some(outcome));
}

/// The network's [`Lister`], reporting as log events.
pub fn lister(network: Network) -> Lister {
    let network = network.name();
    let fell_back = AtomicU64::new(0);
    Lister::new(move |e| match e {
        Listed::Source { via, why } => logging::emit(&BlockTxsSource {
            network,
            source: via.label(),
            reason: why.label(),
        }),
        Listed::FellBack { reason } => {
            let total = fell_back.fetch_add(1, Ordering::Relaxed) + 1;
            if total.is_power_of_two() {
                logging::emit(&BlockTxsFellBack {
                    network,
                    reason,
                    total,
                });
            }
        }
    })
}

/// Asks the node which routes it serves when the Electrum connection is first ready, then after
/// every reconnect, since the node may have been upgraded or downgraded meanwhile (a new node
/// means a restart, so a reconnect): which source lists its blocks, and whether its socket adds
/// up large addresses' totals above its cap. A reconnect is the client's `Resynced` event, which
/// unlike the health watch is never merged with the next one.
pub async fn detect_routes(ctx: Arc<NetworkContext>) {
    let detect = async || {
        ctx.lister.detect(&ctx.esplora).await;
        if let Some(ledger) = &ctx.guard.ledger {
            ledger.detect().await;
        }
    };
    // Subscribed before the first probe, so a reconnect during it is still heard.
    let mut events = ctx.electrum.events();
    if ctx.electrum.health().wait_for(|h| h.ready).await.is_err() {
        return;
    }
    detect().await;
    loop {
        match events.recv().await {
            // A lagged receiver may have missed a reconnect.
            Ok(ElectrumEvent::Resynced) | Err(RecvError::Lagged(_)) => detect().await,
            Ok(_) => {}
            Err(RecvError::Closed) => return,
        }
    }
}

async fn wait(mut flight: Flight) -> Outcome {
    match flight.wait_for(Option::is_some).await {
        Ok(outcome) => outcome.clone().unwrap_or(Err(Failure::Lost)),
        Err(_) => Err(Failure::Lost),
    }
}

/// A block's facts for the block table: cached, or computed as the [`worker`] computes a new
/// block's, outside the client limits. `None` when the node gave no summary.
pub async fn new_block_facts(ctx: &Arc<NetworkContext>, hash: BlockHash) -> Option<Facts> {
    let s = match ctx.summaries.start(ctx, hash, Cause::NewBlock).ok()? {
        Start::Cached(s) => s,
        Start::Joined(f) | Start::Started(f) => wait(f).await.ok()?,
    };
    Some(s.facts.clone())
}

/// Facts the block table holds for these blocks, in order: an old block costs the node nothing
/// once backfilled. `None` where it has no rated row, or the read failed and the node answers.
async fn stored(ctx: &NetworkContext, hashes: &[BlockHash]) -> Vec<Option<Facts>> {
    let rows = match &ctx.blocks {
        Some(t) => engine::blocks::by_hashes(&t.store, hashes.to_vec())
            .await
            .ok(),
        None => None,
    };
    match rows {
        Some(rows) => rows
            .into_iter()
            .map(|r| r.and_then(|r| r.facts()))
            .collect(),
        None => vec![None; hashes.len()],
    }
}

/// A summary for a client request, and where it came from.
async fn get(
    ctx: &Arc<NetworkContext>,
    hash: BlockHash,
    client: IpAddr,
) -> Result<(Arc<Summary>, Source), Answer> {
    let started = Instant::now();
    match ctx.summaries.start(ctx, hash, Cause::Request(client)) {
        Ok(Start::Cached(s)) => Ok((s, Source::Cached)),
        Ok(Start::Joined(f)) => wait(f)
            .await
            .map(|s| (s, Source::Coalesced))
            .map_err(|e| Answer::Failed(e, Source::Coalesced)),
        Ok(Start::Started(f)) => {
            let outcome = wait(f).await;
            let source = Source::Upstream(started.elapsed());
            outcome
                .map(|s| (s, source))
                .map_err(|e| Answer::Failed(e, source))
        }
        Err(r) => Err(Answer::Refused(r)),
    }
}

/// Why a request got no summary.
enum Answer {
    Refused(Refused),
    Failed(Failure, Source),
    Bad(ApiError),
}

impl Answer {
    fn into_response(self, route: &'static str) -> Response {
        match self {
            Self::Refused(r) => {
                let mut res = r.into_response();
                if r.reason == "route_rate" {
                    res.headers_mut()
                        .insert(RETRY_AFTER, HeaderValue::from(CLIENT_EVERY.as_secs()));
                }
                res
            }
            Self::Failed(f, source) => {
                let mut res = f.error().into_response();
                res.extensions_mut().insert(ApiOutcome {
                    route,
                    source,
                    upstream_error: f.label(),
                });
                res
            }
            Self::Bad(e) => e.into_response(),
        }
    }
}

fn ok(route: &'static str, content_type: &'static str, body: Bytes, source: Source) -> Response {
    let mut res = (
        [(CONTENT_TYPE, content_type), (CACHE_CONTROL, IMMUTABLE)],
        body,
    )
        .into_response();
    res.extensions_mut().insert(ApiOutcome {
        route,
        source,
        upstream_error: None,
    });
    res
}

/// Marks `res` not to be kept when its audits could not be read: it shows none for now.
fn unkept_unless(read: bool, mut res: Response) -> Response {
    if !read {
        res.extensions_mut().insert(crate::answers::Unkept);
    }
    res
}

/// The hash in the path, before anything is asked of the node.
fn parse_hash(hash: &str, uri: &Uri) -> Result<BlockHash, Answer> {
    if uri.query().is_some_and(|q| !q.is_empty()) {
        return Err(Answer::Bad(ApiError::bad_request(
            "unexpected query parameter",
        )));
    }
    crate::esplora::block_hash(hash).map_err(Answer::Bad)
}

/// `GET /app/block/{hash}/summary`: [`Facts`] as JSON.
pub async fn facts(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<Client>,
    Path(hash): Path<String>,
    uri: Uri,
) -> Response {
    const ROUTE: &str = "block_summary";
    let answer = async {
        let hash = parse_hash(&hash, &uri)?;
        let (facts, source) = match stored(&ctx, &[hash]).await.pop().flatten() {
            Some(f) => (f, Source::Stored),
            None => {
                let (s, source) = get(&ctx, hash, client.addr).await?;
                (s.facts.clone(), source)
            }
        };
        let (mut audits, read) = crate::audits::totals(&ctx, &[hash]).await;
        let audit = audits.pop().flatten();
        let body = serde_json::to_vec(&Published {
            facts: &facts,
            audit: audit.as_ref(),
        })
        .map_err(|_| Answer::Bad(ApiError::INTERNAL))?;
        Ok(unkept_unless(
            read,
            ok(ROUTE, "application/json", body.into(), source),
        ))
    };
    answer
        .await
        .unwrap_or_else(|a: Answer| a.into_response(ROUTE))
}

/// `GET /app/block/{hash}/txs`: [`stats::encode_txs`].
pub async fn txs(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<Client>,
    Path(hash): Path<String>,
    uri: Uri,
) -> Response {
    const ROUTE: &str = "block_summary_txs";
    let answer = async {
        let hash = parse_hash(&hash, &uri)?;
        let (s, source) = get(&ctx, hash, client.addr).await?;
        Ok(ok(ROUTE, "application/octet-stream", s.txs.clone(), source))
    };
    answer
        .await
        .unwrap_or_else(|a: Answer| a.into_response(ROUTE))
}

/// `GET /app/blocks/summary?hashes=<hash>,<hash>,…`: up to [`MAX_BATCH`] [`Facts`], in order.
/// Blocks the block table holds cost nothing. Every other computation is started before any is
/// awaited, so a refusal answers at once and the work admitted before it goes on into the cache,
/// where the client's retry finds it.
pub async fn batch(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<Client>,
    uri: Uri,
) -> Response {
    const ROUTE: &str = "block_summaries";
    let answer = async {
        let hashes = parse_batch(uri.query())?;
        let started = Instant::now();
        let stored = stored(&ctx, &hashes).await;
        let mut starts = Vec::with_capacity(hashes.len());
        for (hash, known) in hashes.into_iter().zip(&stored) {
            let start = match known {
                Some(_) => None,
                None => Some(
                    ctx.summaries
                        .start(&ctx, hash, Cause::Request(client.addr))
                        .map_err(Answer::Refused)?,
                ),
            };
            starts.push(start);
        }
        let mut source = if starts.iter().all(Option::is_none) {
            Source::Stored
        } else {
            Source::Cached
        };
        let mut facts = Vec::with_capacity(starts.len());
        for (start, known) in starts.into_iter().zip(stored) {
            let Some(start) = start else {
                facts.extend(known);
                continue;
            };
            let s = match start {
                Start::Cached(s) => s,
                Start::Joined(f) => {
                    if source == Source::Cached {
                        source = Source::Coalesced;
                    }
                    wait(f).await.map_err(|e| Answer::Failed(e, source))?
                }
                Start::Started(f) => {
                    let s = wait(f).await;
                    source = Source::Upstream(started.elapsed());
                    s.map_err(|e| Answer::Failed(e, source))?
                }
            };
            facts.push(s.facts.clone());
        }
        let ids: Vec<BlockHash> = facts.iter().map(|f| f.id).collect();
        let (audits, read) = crate::audits::totals(&ctx, &ids).await;
        let published: Vec<Published> = facts
            .iter()
            .zip(&audits)
            .map(|(facts, audit)| Published {
                facts,
                audit: audit.as_ref(),
            })
            .collect();
        let body = serde_json::to_vec(&published).map_err(|_| Answer::Bad(ApiError::INTERNAL))?;
        Ok(unkept_unless(
            read,
            ok(ROUTE, "application/json", body.into(), source),
        ))
    };
    answer
        .await
        .unwrap_or_else(|a: Answer| a.into_response(ROUTE))
}

/// `GET /api/v1/block/{hash}/summary`: every transaction, in the reference's shape. The same
/// summary as the routes above, under their limits: a cached block costs the node nothing.
/// Query strings are ignored, as on every `/api/v1` route.
pub async fn v1_txs(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<Client>,
    Path(hash): Path<String>,
) -> Response {
    const ROUTE: &str = "v1_block_summary";
    let answer = async {
        let hash = crate::esplora::block_hash(&hash).map_err(Answer::Bad)?;
        let (s, source) = get(&ctx, hash, client.addr).await?;
        let rows: Vec<TxRow> = s.rows().collect();
        let body = serde_json::to_vec(&rows).map_err(|_| Answer::Bad(ApiError::INTERNAL))?;
        Ok(ok(ROUTE, "application/json", body.into(), source))
    };
    answer
        .await
        .unwrap_or_else(|a: Answer| a.into_response(ROUTE))
}

/// `GET /api/v1/block/{hash}/tx/{txid}/summary`: one row of the above.
pub async fn v1_tx(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<Client>,
    Path((hash, txid)): Path<(String, String)>,
) -> Response {
    const ROUTE: &str = "v1_block_tx_summary";
    let answer = async {
        let hash = crate::esplora::block_hash(&hash).map_err(Answer::Bad)?;
        let txid = crate::esplora::txid(&txid).map_err(Answer::Bad)?;
        let (s, source) = get(&ctx, hash, client.addr).await?;
        let row = s
            .rows()
            .find(|r| r.txid == txid)
            .ok_or(Answer::Bad(NOT_IN_BLOCK))?;
        let body = serde_json::to_vec(&row).map_err(|_| Answer::Bad(ApiError::INTERNAL))?;
        Ok(ok(ROUTE, "application/json", body.into(), source))
    };
    answer
        .await
        .unwrap_or_else(|a: Answer| a.into_response(ROUTE))
}

const NOT_IN_BLOCK: ApiError =
    ApiError::new(StatusCode::NOT_FOUND, "transaction not found in this block");

/// `hashes=` and nothing else: 1 to [`MAX_BATCH`] block hashes, comma-separated (`%2C` too).
fn parse_batch(query: Option<&str>) -> Result<Vec<BlockHash>, Answer> {
    let bad = |m| Answer::Bad(ApiError::bad_request(m));
    let list = query
        .and_then(|q| q.strip_prefix("hashes="))
        .ok_or_else(|| bad("hashes is required"))?;
    if list.contains(['&', '=']) {
        return Err(bad("unexpected query parameter"));
    }
    let list = list.replace("%2C", ",").replace("%2c", ",");
    let hashes = list
        .split(',')
        .map(|h| crate::esplora::block_hash(h).map_err(Answer::Bad))
        .collect::<Result<Vec<_>, _>>()?;
    if hashes.len() > MAX_BATCH {
        return Err(bad("at most 10 hashes"));
    }
    Ok(hashes)
}

/// Computes each new tip's summary, then walks back up to [`WARM_BLOCKS`] blocks filling the
/// cache, one block at a time behind any client waiting for the same slot. Each summary it
/// computes is sent on the `blocks` topic. A tip that arrives meanwhile is taken next; tips in
/// between are reached by the walk back. One task per network.
pub async fn worker(ctx: Arc<NetworkContext>) {
    let mut tips = ctx.summaries.tip.subscribe();
    loop {
        let tip = *tips.borrow_and_update();
        if let Some((hash, since)) = tip {
            let mut next = Some(hash);
            for depth in 0..WARM_BLOCKS {
                let Some(hash) = next else { break };
                let found = match ctx.summaries.start(&ctx, hash, Cause::NewBlock) {
                    Ok(Start::Cached(s)) => Some((s, false)),
                    Ok(Start::Joined(f) | Start::Started(f)) => {
                        wait(f).await.ok().map(|s| (s, true))
                    }
                    Err(_) => None,
                };
                let Some((summary, fresh)) = found else { break };
                if depth == 0 || fresh {
                    let msg = message(&summary.facts, summary.audit.as_ref());
                    ctx.hub
                        .announce(Topic::Blocks, "summary", &msg, Snapshot::Keep, since);
                }
                next = summary.prev;
            }
        }
        if tips.changed().await.is_err() {
            return;
        }
    }
}

/// The `blocks` topic's `summary` message: the facts exactly as the routes serve them, the miner
/// and the audit included, so a new tile can name its miner and show its health without asking.
fn message(facts: &Facts, audit: Option<&Totals>) -> serde_json::Value {
    json!({ "topic": "blocks", "type": "summary", "summary": Published { facts, audit } })
}

/// A block's facts as served: [`Facts`] and its audit's totals, `null` when it has none.
#[derive(Serialize)]
struct Published<'a> {
    #[serde(flatten)]
    facts: &'a Facts,
    audit: Option<&'a Totals>,
}

/// Summaries by hash, least recently used out first once their size passes the budget.
#[derive(Debug)]
struct Lru {
    map: HashMap<BlockHash, (Arc<Summary>, u64)>,
    clock: u64,
    bytes: usize,
    max_bytes: usize,
}

impl Lru {
    fn new(max_bytes: usize) -> Self {
        Self {
            map: HashMap::new(),
            clock: 0,
            bytes: 0,
            max_bytes,
        }
    }

    fn get(&mut self, hash: &BlockHash) -> Option<Arc<Summary>> {
        self.clock += 1;
        let (s, used) = self.map.get_mut(hash)?;
        *used = self.clock;
        Some(Arc::clone(s))
    }

    /// A summary larger than the whole budget is not kept.
    fn insert(&mut self, hash: BlockHash, summary: Arc<Summary>) {
        let size = summary.size();
        if size > self.max_bytes {
            return;
        }
        self.clock += 1;
        if let Some((old, _)) = self.map.insert(hash, (summary, self.clock)) {
            self.bytes -= old.size();
        }
        self.bytes += size;
        while self.bytes > self.max_bytes {
            // shortcut: a linear scan per eviction, about 50 µs at 64k entries; inserts are
            // capped by MAX_RUNNING. Use an ordered index if entries ever get much smaller.
            let Some(oldest) = self
                .map
                .iter()
                .min_by_key(|(_, (_, used))| *used)
                .map(|(h, _)| *h)
            else {
                break;
            };
            if let Some((old, _)) = self.map.remove(&oldest) {
                self.bytes -= old.size();
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use bitcoin::hashes::Hash;

    use super::*;

    fn summary(records: usize) -> Arc<Summary> {
        Arc::new(Summary {
            facts: Facts {
                id: BlockHash::all_zeros(),
                height: 0,
                tx_count: records,
                fees: 0,
                vsize: 0,
                weight: 0,
                fee_rate: None,
                fee_bands: engine::projected::Bands::default(),
                miner: engine::blocks::Miner::UNKNOWN,
            },
            txs: vec![0; records].into(),
            ids: Vec::new(),
            prev: None,
            audit: None,
        })
    }

    fn h(n: u8) -> BlockHash {
        BlockHash::from_byte_array([n; 32])
    }

    #[test]
    fn the_cache_stays_under_its_budget_and_drops_the_least_recently_used() {
        let mut lru = Lru::new(3 * (1000 + ENTRY_OVERHEAD));
        for n in 0..3 {
            lru.insert(h(n), summary(1000));
        }
        assert!(lru.get(&h(0)).is_some());
        lru.insert(h(3), summary(1000));
        assert!(
            lru.get(&h(1)).is_none(),
            "the least recently used goes first"
        );
        assert!(lru.get(&h(0)).is_some() && lru.get(&h(3)).is_some());
        // Needs two entries' room: the two least recently used go, the newest other one stays.
        lru.insert(h(4), summary(2500));
        assert!(lru.bytes <= lru.max_bytes);
        assert!(lru.get(&h(2)).is_none() && lru.get(&h(0)).is_none());
        assert!(lru.get(&h(3)).is_some() && lru.get(&h(4)).is_some());
        lru.insert(h(5), summary(10_000));
        assert!(lru.get(&h(5)).is_none(), "larger than the budget: not kept");
        lru.insert(h(4), summary(2500));
        assert_eq!(lru.bytes, 1000 + 2500 + 2 * ENTRY_OVERHEAD);
    }

    #[test]
    fn the_summary_message_names_the_miner() {
        let mut facts = summary(1).facts.clone();
        facts.miner = engine::blocks::Miner {
            name: "Foundry USA",
            slug: "foundryusa",
        };
        let msg = message(&facts, None);
        assert_eq!(msg["type"], "summary");
        let mut want = serde_json::to_value(&facts).unwrap();
        want["audit"] = serde_json::Value::Null;
        assert_eq!(msg["summary"], want);
        assert_eq!(
            msg["summary"]["miner"],
            json!({"name": "Foundry USA", "slug": "foundryusa"})
        );
    }

    #[test]
    fn batch_queries_are_strict() {
        let one = "11".repeat(32);
        assert_eq!(
            parse_batch(Some(&format!("hashes={one}")))
                .ok()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            parse_batch(Some(&format!("hashes={one}%2C{one},{one}")))
                .ok()
                .unwrap()
                .len(),
            3
        );
        let eleven = [one.as_str(); 11].join(",");
        for bad in [
            None,
            Some(""),
            Some("hashes="),
            Some("hash=00"),
            Some(&format!("hashes={one},")),
            Some(&format!("hashes={one}&x=1")),
            Some(&format!("hashes={one}&hashes={one}")),
            Some(&format!("hashes=0x{}", &one[2..])),
            Some(&format!("hashes={eleven}")),
        ] {
            assert!(parse_batch(bad).is_err(), "{bad:?}");
        }
    }
}
