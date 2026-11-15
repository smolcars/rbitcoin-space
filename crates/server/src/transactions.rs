//! The mempool.space-shaped transaction routes under `/api/v1` (`docs/API.md`, "Transactions"):
//! address validation, first-seen times, replacement trees, CPFP and prevouts.
//!
//! Every parameter is parsed into a strict type before any work. All but `POST /prevouts` are
//! answered from memory (the tracker, the projected blocks and the replacement record) and
//! never ask the node anything. `POST /prevouts` asks Esplora for each outpoint, under the cost
//! limit of the address and batch routes ([`esplora::heavy_call`]).

#[cfg(test)]
mod tests;

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use axum::body::{Body, Bytes};
use axum::extract::{Path, RawQuery, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use bitcoin::Txid;
use engine::replacements::{Facts, Mined, Node, Replacements};
use node::esplora::{ChainTip, Error, Esplora, RawResponse, Route};
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

use crate::api_v1::{MEMPOOL_OFF, NOT_READY};
use crate::esplora::{self, Answer, ApiOutcome, LIVE};
use crate::limits::Client;
use crate::{ApiError, NetworkContext};

/// Most txids one `transaction-times` request may ask about. A request head is at most 16 KiB,
/// which fits about 200; this is the cap we promise.
pub const MAX_TIMES: usize = 100;
/// Most outpoints one `POST /prevouts` may ask about. Each costs the node one or two point reads.
pub const MAX_PREVOUTS: usize = 100;
/// No read of a `prevouts` batch starts this long after the first: with each read's own limit,
/// a batch holds its slot at most twice this.
const BATCH_DEADLINE: std::time::Duration = esplora::HEAVY_CEILING;
/// Trees in `/replacements` and `/fullrbf/replacements`, as the reference answers.
pub const RECENT_TREES: usize = 25;
/// An address's answer never changes; a day bounds the cost of a parser fix reaching caches.
const ADDRESS_CACHE: &str = "public, max-age=86400";

pub fn routes() -> Router<Arc<NetworkContext>> {
    Router::new()
        .route("/api/v1/validate-address/{address}", get(validate_address))
        .route("/api/v1/transaction-times", get(transaction_times))
        .route("/api/v1/replacements", get(replacements))
        // The reference's frontend asks with a trailing slash; each such path is listed.
        .route("/api/v1/replacements/", get(replacements))
        .route("/api/v1/fullrbf/replacements", get(full_rbf_replacements))
        .route("/api/v1/fullrbf/replacements/", get(full_rbf_replacements))
        .route("/api/v1/tx/{txid}/rbf", get(rbf))
        .route("/api/v1/cpfp/{txid}", get(cpfp))
        .route("/api/v1/prevouts", post(prevouts))
}

/// A rate or size as the reference writes it: a whole value as an integer (`125`, not `125.0`).
fn num(x: f64) -> Number {
    if x.fract() == 0.0 && (0.0..9e15).contains(&x) {
        Number::from(x as u64)
    } else {
        Number::from_f64(x).unwrap_or_else(|| Number::from(0))
    }
}

fn with_cache(mut res: Response, cache: &'static str) -> Response {
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}

fn tip_headers(res: &mut Response, tip: Option<ChainTip>) {
    let Some(tip) = tip else { return };
    let h = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&tip.hash.to_string()) {
        h.insert("x-bitcoin-chain-tip", v);
    }
    h.insert("x-bitcoin-chain-tip-height", HeaderValue::from(tip.height));
}

// Address validation.

/// The reference's shape for a valid address: the node's `validateaddress` fields, in its order.
#[derive(Debug, Serialize, PartialEq)]
struct Valid {
    address: String,
    isscript: bool,
    isvalid: bool,
    iswitness: bool,
    #[serde(rename = "scriptPubKey")]
    script_pub_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    witness_program: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    witness_version: Option<u8>,
}

#[derive(Debug, Serialize)]
struct Invalid {
    isvalid: bool,
}

async fn validate_address(
    State(ctx): State<Arc<NetworkContext>>,
    Path(address): Path<String>,
) -> Response {
    let res = match validate(&address, ctx.config.network) {
        Some(v) => Json(v).into_response(),
        None => Json(Invalid { isvalid: false }).into_response(),
    };
    with_cache(res, ADDRESS_CACHE)
}

/// Our own parser's answer for `s` on `network`. An address of another network is invalid
/// here, as on the reference.
fn validate(s: &str, network: crate::config::Network) -> Option<Valid> {
    let a = esplora::address(s, network).ok()?;
    let script = a.script_pubkey();
    let program = a.witness_program();
    let anchor = program
        .as_ref()
        .is_some_and(bitcoin::WitnessProgram::is_p2a);
    // The node names no program for pay-to-anchor.
    let named = program.as_ref().filter(|_| !anchor);
    Some(Valid {
        address: a.to_string(),
        // As the node counts it: pay to a script hash, a witness script hash, taproot or anchor.
        isscript: script.is_p2sh()
            || script.is_p2wsh()
            || script.is_p2tr()
            || program
                .as_ref()
                .is_some_and(bitcoin::WitnessProgram::is_p2a),
        isvalid: true,
        iswitness: program.is_some(),
        script_pub_key: script.to_hex_string(),
        witness_program: named.map(|p| {
            use bitcoin::hex::DisplayHex;
            p.program().as_bytes().to_lower_hex_string()
        }),
        witness_version: named.map(|p| p.version().to_num()),
    })
}

// First-seen times.

/// `txId[]=` values, each a txid. Other parameters are ignored, like every `/api/v1` query.
pub(crate) fn times_query(query: Option<&str>) -> Result<Vec<Txid>, ApiError> {
    let mut out = Vec::new();
    for part in query.unwrap_or("").split('&') {
        let (name, value) = part.split_once('=').unwrap_or((part, ""));
        if !matches!(name, "txId[]" | "txId%5B%5D" | "txId%5b%5d") {
            continue;
        }
        if out.len() == MAX_TIMES {
            return Err(ApiError::bad_request("at most 100 txids"));
        }
        out.push(esplora::txid(value).map_err(|_| ApiError::bad_request("invalid txId"))?);
    }
    Ok(out)
}

/// The engines, once the tracker has finished its first cycle.
fn engines(
    ctx: &NetworkContext,
) -> Result<&(engine::mempool::Tracker, engine::projected::Projector), ApiError> {
    if !ctx.track.mempool_enabled() {
        return Err(MEMPOOL_OFF);
    }
    let e = ctx.track.engines().ok_or(NOT_READY)?;
    if e.0.read(|m| m.tip().is_none()) {
        return Err(NOT_READY);
    }
    Ok(e)
}

async fn transaction_times(
    State(ctx): State<Arc<NetworkContext>>,
    RawQuery(query): RawQuery,
) -> Result<Response, ApiError> {
    let ids = times_query(query.as_deref())?;
    let (tracker, _) = engines(&ctx)?;
    let (held, tip) = tracker.read(|m| {
        let held: Vec<Option<u32>> = ids.iter().map(|t| m.get(t).map(|i| i.time)).collect();
        (held, m.tip())
    });
    // Not in the mempool: a replaced transaction or replacement the record still holds.
    let times: Vec<u64> = ctx.track.with_replacements(|r| {
        ids.iter()
            .zip(held)
            .map(|(t, h)| u64::from(h.or_else(|| r.facts(t).map(|f| f.time)).unwrap_or(0)))
            .collect()
    });
    let mut res = with_cache(Json(times).into_response(), LIVE);
    tip_headers(&mut res, tip);
    Ok(res)
}

// Replacements.

/// One transaction of a tree, in the reference's field order. Figures are `null` only for a
/// newest replacement the tracker never held (confirmed in the block that removed the original).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeTx {
    txid: Txid,
    fee: Option<u64>,
    /// Weight over four, unrounded, as the reference writes it.
    vsize: Option<Number>,
    value: Option<u64>,
    /// Sat/vB on that size.
    rate: Option<Number>,
    time: u64,
    rbf: Option<bool>,
    /// Whether a transaction it replaced itself did not signal. Absent on a leaf.
    #[serde(skip_serializing_if = "Option::is_none")]
    full_rbf: Option<bool>,
    /// `true` when mined, `null` when unknown (its block left the best chain), absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    mined: Option<Value>,
}

/// One node of a tree, in the reference's field order.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Tree {
    tx: TreeTx,
    time: u64,
    /// Seconds from this transaction's arrival to its replacement's. Absent on the root.
    #[serde(skip_serializing_if = "Option::is_none")]
    interval: Option<i64>,
    /// Whether this transaction, or anything below it, was replaced without signalling.
    full_rbf: bool,
    replaces: Vec<Tree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mined: Option<Value>,
}

fn tree_json(n: &Node, parent: Option<u64>) -> Tree {
    let f: Option<&Facts> = n.tx.as_ref();
    let vsize = f.map(|f| f64::from(f.weight) / 4.0);
    let signalled = f.is_none_or(|f| f.rbf);
    let replaces: Vec<Tree> = n
        .replaces
        .iter()
        .map(|c| tree_json(c, Some(n.time)))
        .collect();
    let direct = n.replaces.iter().any(|c| c.tx.is_some_and(|f| !f.rbf));
    Tree {
        tx: TreeTx {
            txid: n.txid,
            fee: f.map(|f| f.fee),
            vsize: vsize.map(num),
            value: f.map(|f| f.value),
            rate: f
                .zip(vsize)
                .and_then(|(f, v)| (v > 0.0).then(|| num(f.fee as f64 / v))),
            time: n.time,
            rbf: f.map(|f| f.rbf),
            full_rbf: (!n.replaces.is_empty()).then_some(direct),
            mined: mined(n.mined),
        },
        time: n.time,
        interval: parent.map(|p| {
            i64::try_from(p).unwrap_or(i64::MAX) - i64::try_from(n.time).unwrap_or(i64::MAX)
        }),
        full_rbf: (parent.is_some() && !signalled) || n.full_rbf(),
        replaces,
        mined: mined(n.mined),
    }
}

/// A tree's `mined`: absent when not mined, as the reference leaves it out.
fn mined(m: Mined) -> Option<Value> {
    (m != Mined::No).then(|| m.json())
}

/// The two lists, built once per change of the record.
#[derive(Debug, Default)]
pub struct Trees(Mutex<Option<(u64, Bytes, Bytes)>>);

impl Trees {
    /// What `/replacements` answers, or with `full_rbf` `/fullrbf/replacements`; the socket's
    /// `rbfLatest` carries the same bytes.
    pub(crate) fn get(&self, r: &Replacements, full_rbf: bool) -> Bytes {
        let mut held = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let fresh = held.as_ref().filter(|(v, ..)| *v == r.version());
        let (all, full) = match fresh {
            Some((_, all, full)) => (all.clone(), full.clone()),
            None => {
                let list = |full| -> Bytes {
                    let trees: Vec<Tree> = r
                        .recent(RECENT_TREES, full)
                        .iter()
                        .map(|t| tree_json(t, None))
                        .collect();
                    serde_json::to_vec(&trees).unwrap_or_default().into()
                };
                let (all, full) = (list(false), list(true));
                *held = Some((r.version(), all.clone(), full.clone()));
                (all, full)
            }
        };
        if full_rbf { full } else { all }
    }
}

/// Replacements in the socket's `rbfLatestSummary`, as the reference sends.
pub(crate) const SUMMARY_TREES: usize = 6;

/// One replacement in short: the newest of a tree and what it directly replaced, summed, as the
/// reference adds them up (seen on mempool.space 2026-11-15: two replaced, 152 + 330 sats).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Brief {
    txid: Txid,
    mined: Value,
    full_rbf: bool,
    old_fee: u64,
    old_vsize: Number,
    new_fee: Option<u64>,
    new_vsize: Option<Number>,
}

/// The socket's `rbfLatestSummary` message.
#[derive(Debug, Serialize)]
struct Briefs {
    #[serde(rename = "rbfLatestSummary")]
    list: Vec<Brief>,
}

/// The `rbfLatestSummary` message, in the reference's field order: the [`SUMMARY_TREES`] newest
/// trees of `/replacements`, in short.
pub(crate) fn summary(r: &Replacements) -> Vec<u8> {
    let briefs: Vec<Brief> = r
        .recent(SUMMARY_TREES, false)
        .iter()
        .map(|n| {
            // From the record, not the tree, which stops at `MAX_TREE` transactions.
            let old = r
                .replaced_by(&n.txid)
                .iter()
                .filter_map(|t| r.get(t).map(|l| l.tx));
            Brief {
                txid: n.txid,
                mined: n.mined.json(),
                full_rbf: n.full_rbf(),
                old_fee: old.clone().map(|f| f.fee).sum(),
                old_vsize: num(old.map(|f| f64::from(f.weight) / 4.0).sum()),
                new_fee: n.tx.map(|f| f.fee),
                new_vsize: n.tx.map(|f| num(f64::from(f.weight) / 4.0)),
            }
        })
        .collect();
    serde_json::to_vec(&Briefs { list: briefs }).unwrap_or_default()
}

fn record(ctx: &NetworkContext) -> Result<(), ApiError> {
    if ctx.track.mempool_enabled() {
        Ok(())
    } else {
        Err(MEMPOOL_OFF)
    }
}

fn json_bytes(body: Bytes) -> Response {
    let mut res = Response::new(Body::from(body));
    res.headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    with_cache(res, LIVE)
}

async fn replacements(State(ctx): State<Arc<NetworkContext>>) -> Result<Response, ApiError> {
    record(&ctx)?;
    let body = ctx.track.with_replacements(|r| ctx.trees.get(r, false));
    Ok(json_bytes(body))
}

async fn full_rbf_replacements(
    State(ctx): State<Arc<NetworkContext>>,
) -> Result<Response, ApiError> {
    record(&ctx)?;
    let body = ctx.track.with_replacements(|r| ctx.trees.get(r, true));
    Ok(json_bytes(body))
}

#[derive(Debug, Serialize)]
struct Rbf {
    replacements: Option<Tree>,
    replaces: Option<Vec<Txid>>,
}

async fn rbf(
    State(ctx): State<Arc<NetworkContext>>,
    Path(txid): Path<String>,
) -> Result<Response, ApiError> {
    let txid = esplora::txid(&txid)?;
    record(&ctx)?;
    let body = ctx.track.with_replacements(|r| {
        let direct = r.replaced_by(&txid);
        Rbf {
            replacements: r.tree(&txid).map(|t| tree_json(&t, None)),
            replaces: (!direct.is_empty()).then(|| direct.to_vec()),
        }
    });
    Ok(with_cache(Json(body).into_response(), LIVE))
}

// CPFP.

#[derive(Debug, Serialize, PartialEq)]
struct Relative {
    txid: Txid,
    fee: u64,
    weight: u32,
}

/// The reference's shape, without `sigops`: we do not count them.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Cpfp {
    ancestors: Vec<Relative>,
    best_descendant: Option<Relative>,
    descendants: Vec<Relative>,
    effective_fee_per_vsize: Number,
    fee: u64,
    adjusted_vsize: u32,
}

/// What the reference answers for a transaction it has no CPFP data for.
#[derive(Debug, Serialize)]
struct NoCpfp {
    ancestors: [Relative; 0],
}

async fn cpfp(
    State(ctx): State<Arc<NetworkContext>>,
    Path(txid): Path<String>,
) -> Result<Response, ApiError> {
    let txid = esplora::txid(&txid)?;
    engines(&ctx)?;
    // The projected blocks' lock is held through a pack: wait for it on a blocking thread.
    let c = Arc::clone(&ctx);
    let (answer, tip) = tokio::task::spawn_blocking(move || cpfp_of(&c, txid))
        .await
        .map_err(|_| ApiError::INTERNAL)?;
    let mut res = match answer {
        Some(a) => Json(a).into_response(),
        None => Json(NoCpfp { ancestors: [] }).into_response(),
    };
    tip_headers(&mut res, tip);
    Ok(with_cache(res, LIVE))
}

/// From the projected blocks' copy of its cluster (the node's chunks, at most 64 members) and the
/// tracker's records and inputs. `None` when it is not in the mempool, or not placed yet.
fn cpfp_of(ctx: &NetworkContext, txid: Txid) -> (Option<Cpfp>, Option<ChainTip>) {
    let Some((tracker, projector)) = ctx.track.engines() else {
        return (None, None);
    };
    let tip = tracker.read(|m| m.tip());
    let Some(group) = projector.group(&txid) else {
        return (None, tip);
    };
    let members: Vec<Txid> = group
        .chunks
        .iter()
        .flat_map(|c| c.txs.iter().map(|(t, _)| *t))
        .collect();
    let (links, records, tip) = tracker.read(|m| {
        let records: Vec<Option<(u64, u32, u32)>> = members
            .iter()
            .map(|t| m.get(t).map(|i| (i.fee.to_sat(), i.weight, i.vsize)))
            .collect();
        (m.links(&members), records, m.tip())
    });
    let Some(me) = members.iter().position(|t| *t == txid) else {
        return (None, tip);
    };
    let Some(Some((fee, _, vsize))) = records.get(me).copied() else {
        return (None, tip);
    };
    // Everything reachable from `me` along the links, one way or the other.
    let reach = |up: bool| -> HashSet<usize> {
        let mut seen = HashSet::new();
        let mut stack = vec![me];
        while let Some(i) = stack.pop() {
            for (p, c) in &links {
                let next = if up {
                    (*c == i).then_some(*p)
                } else {
                    (*p == i).then_some(*c)
                };
                if let Some(n) = next
                    && seen.insert(n)
                {
                    stack.push(n);
                }
            }
        }
        seen
    };
    let (up, down) = (reach(true), reach(false));
    let relative = |i: usize| {
        let (fee, weight, _) = records.get(i).copied().flatten()?;
        Some(Relative {
            txid: *members.get(i)?,
            fee,
            weight,
        })
    };
    // In mining order: the cluster's own linearization.
    let list = |set: &HashSet<usize>| -> Vec<Relative> {
        (0..members.len())
            .filter(|i| set.contains(i))
            .filter_map(relative)
            .collect()
    };
    // The descendant mined last in its chunk: the child whose fee lifts it.
    let mut start = 0;
    let mut own = 0..0;
    for (n, c) in group.chunks.iter().enumerate() {
        if n == group.chunk {
            own = start..start + c.txs.len();
        }
        start += c.txs.len();
    }
    let chunk = group.chunks.get(group.chunk);
    // Lifted: its chunk pays more per vbyte than it does alone (fee/vsize against chunk fee over
    // weight/4, cross-multiplied).
    let lifted = chunk.is_some_and(|c| {
        u128::from(c.fee) * 4 * u128::from(vsize) > u128::from(fee) * u128::from(c.weight)
    });
    let best = own
        .rev()
        .find(|i| lifted && down.contains(i))
        .and_then(relative);
    let effective = chunk
        .filter(|c| c.weight > 0)
        .map_or(0.0, |c| c.fee as f64 * 4.0 / c.weight as f64);
    (
        Some(Cpfp {
            ancestors: list(&up),
            best_descendant: best,
            descendants: list(&down),
            effective_fee_per_vsize: num(effective),
            fee,
            adjusted_vsize: vsize,
        }),
        tip,
    )
}

// Prevouts.

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Outpoint {
    txid: String,
    vout: u32,
}

/// An output as Esplora writes it, keeping only these fields, in this order.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
struct Prevout {
    scriptpubkey: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    scriptpubkey_address: Option<String>,
    scriptpubkey_asm: String,
    scriptpubkey_type: String,
    value: u64,
}

#[derive(Debug, Deserialize)]
struct TxOuts {
    vout: Vec<Prevout>,
    status: Confirmed,
}

#[derive(Debug, Deserialize)]
struct Confirmed {
    confirmed: bool,
}

#[derive(Debug, Serialize)]
struct Found {
    prevout: Prevout,
    unconfirmed: bool,
}

/// The body as typed outpoints: at most [`MAX_PREVOUTS`], each txid exactly 64 hex digits.
fn outpoints(body: &[u8]) -> Result<Vec<(Txid, u32)>, ApiError> {
    let list: Vec<Outpoint> = serde_json::from_slice(body)
        .map_err(|_| ApiError::bad_request("body must be a JSON array of {\"txid\", \"vout\"}"))?;
    if list.len() > MAX_PREVOUTS {
        return Err(ApiError::bad_request("at most 100 outpoints"));
    }
    list.into_iter()
        .map(|o| Ok((esplora::txid(&o.txid)?, o.vout)))
        .collect()
}

async fn prevouts(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<Client>,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    let body = match body {
        Ok(b) => b,
        Err(r) if r.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return ApiError::PAYLOAD_TOO_LARGE.into_response();
        }
        Err(_) => return ApiError::bad_request("could not read the request body").into_response(),
    };
    let wanted = match outpoints(&body) {
        Ok(w) => w,
        Err(e) => return e.into_response(),
    };
    if wanted.is_empty() {
        return with_cache(Json(Vec::<Found>::new()).into_response(), "no-store");
    }
    // Which txids the tracker holds: their outputs are read from the transaction straight away.
    let held: HashSet<Txid> = match ctx.track.engines() {
        Some((tracker, _)) => tracker.read(|m| {
            wanted
                .iter()
                .filter(|(t, _)| m.get(t).is_some())
                .map(|(t, _)| *t)
                .collect()
        }),
        None => HashSet::new(),
    };
    let mut key = String::from("v1/prevouts");
    for (t, v) in &wanted {
        key.push_str(&format!("\n{t}:{v}"));
    }
    let list = wanted.clone();
    let outcome = esplora::heavy_call(&ctx, &client, key, None, move |esplora| async move {
        let deadline = std::time::Instant::now() + BATCH_DEADLINE;
        lookup(&esplora, &list, &held, deadline).await
    })
    .await;
    let (answer, source) = match outcome {
        Ok(a) => a,
        Err(refused) => return *refused,
    };
    let upstream_error = answer.as_ref().err().map(|e| match e {
        Error::Timeout => "timeout",
        Error::ResponseTooBig => "response_too_big",
        Error::Decode(_) => "decode",
        _ => "unavailable",
    });
    let mut res = match answer {
        Ok(raw) => {
            let mut res = Response::new(Body::from(raw.body));
            res.headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
            with_cache(res, "no-store")
        }
        Err(Error::Timeout) => ApiError::TIMEOUT.into_response(),
        Err(_) => ApiError::UPSTREAM.into_response(),
    };
    res.extensions_mut().insert(ApiOutcome {
        route: "v1_prevouts",
        source,
        upstream_error,
    });
    res
}

/// One answer per outpoint, in order: the output and whether its transaction is unconfirmed, or
/// `null` when there is no such output. Reads one output by position (`/tx/:txid/out/:vout`,
/// confirmed only) unless the tracker holds the transaction, and the whole transaction
/// (`/tx/:txid`, once per txid) when that is not found: at most two calls per distinct outpoint,
/// one at a time.
async fn lookup(
    esplora: &Esplora,
    wanted: &[(Txid, u32)],
    held: &HashSet<Txid>,
    deadline: std::time::Instant,
) -> Answer {
    let mut outs: HashMap<(Txid, u32), Option<Found>> = HashMap::new();
    let mut txs: HashMap<Txid, Option<TxOuts>> = HashMap::new();
    let late = || {
        if std::time::Instant::now() >= deadline {
            Err(Error::Timeout)
        } else {
            Ok(())
        }
    };
    for &(txid, vout) in wanted {
        if outs.contains_key(&(txid, vout)) {
            continue;
        }
        late()?;
        if !held.contains(&txid) {
            let raw = esplora
                .raw(&Route::TxOut {
                    txid,
                    vout,
                    asof: None,
                })
                .await?;
            if let Some(prevout) = decode::<Prevout>(&raw)? {
                outs.insert(
                    (txid, vout),
                    Some(Found {
                        prevout,
                        unconfirmed: false,
                    }),
                );
                continue;
            }
        }
        if let Entry::Vacant(e) = txs.entry(txid) {
            late()?;
            let raw = esplora.raw(&Route::Tx(txid)).await?;
            e.insert(decode::<TxOuts>(&raw)?);
        }
        let found = txs.get(&txid).and_then(Option::as_ref).and_then(|t| {
            let prevout = t.vout.get(usize::try_from(vout).ok()?)?.clone();
            Some(Found {
                prevout,
                unconfirmed: !t.status.confirmed,
            })
        });
        outs.insert((txid, vout), found);
    }
    let answer: Vec<Option<&Found>> = wanted
        .iter()
        .map(|k| outs.get(k).and_then(Option::as_ref))
        .collect();
    let body = serde_json::to_vec(&answer).map_err(|e| Error::Decode(e.to_string()))?;
    Ok(RawResponse {
        status: StatusCode::OK,
        content_type: Some(HeaderValue::from_static("application/json")),
        tip: None,
        body: body.into(),
    })
}

/// A 200's body as `T`, `None` for a 404, an error for anything else.
fn decode<T: serde::de::DeserializeOwned>(raw: &RawResponse) -> Result<Option<T>, Error> {
    match raw.status {
        StatusCode::OK => serde_json::from_slice(&raw.body)
            .map(Some)
            .map_err(|e| Error::Decode(e.to_string())),
        StatusCode::NOT_FOUND => Ok(None),
        s => Err(Error::from_status(s, &raw.body)),
    }
}
