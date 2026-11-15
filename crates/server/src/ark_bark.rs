//! `GET /app/ark/bark/vtxo/{id}`: a Bark VTXO, fetched from the network's Bark server, decoded,
//! and checked against the node before anything is shown; and `POST /app/ark/bark/vtxo`, the same
//! for a VTXO a client sends as hex (docs/ARK.md).
//!
//! The Bark server is a third party and the client a stranger: what either sends is untrusted,
//! read under a size cap, and refused unless its exit chain spends the anchor output the node holds
//! and hashes to its id, with valid signatures. Identical lookups in flight share one, answers are
//! kept a while, and a client starts at most a few new lookups a second.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::hash::Hash;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use axum::Extension;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bark::{Checked, FetchError, Policy, SigState, Transition, Vtxo, VtxoId};
use bitcoin::TxOut;
use bitcoin::hashes::{Hash as HashBytes, sha256};
use serde_json::{Value, json};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};

use crate::esplora::{ApiOutcome, Source};
use crate::limits::{Client, Clients, Refused};
use crate::{ApiError, NetworkContext};

/// How long one lookup may take at the Bark server, inside the request timeout.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(6);
/// Lookups at once, for the network: at the Bark server, and of sent VTXOs, each.
pub const MAX_LOOKUPS: usize = 4;
/// Answers kept, by id (or, for a sent VTXO, by its bytes' hash).
pub const MAX_KEPT: usize = 256;
/// A checked VTXO, kept this long: a leaf's preimage can still arrive and sign it.
pub const KEEP_FOUND: Duration = Duration::from_secs(600);
/// An id the server does not know, or an answer that did not check out.
pub const KEEP_REFUSED: Duration = Duration::from_secs(30);
/// New lookups one client may start: a burst, then one every few seconds.
pub const CLIENT_BURST: u32 = 10;
pub const CLIENT_EVERY: Duration = Duration::from_secs(3);
/// The largest VTXO a client may send: room for the decoder's cap of 256 exit transactions at 256
/// bytes each. Real ones have a handful and are 0.3 to 1.5 KB.
pub const MAX_SENT: usize = 256 * 256;
/// The body that carries it, as hex.
pub const MAX_SENT_BODY: usize = 2 * MAX_SENT;

const ROUTE: &str = "bark_vtxo";
const SENT_ROUTE: &str = "bark_vtxo_hex";
const NOT_FOUND: ApiError = ApiError::new(StatusCode::NOT_FOUND, "vtxo not found");
const OFF: ApiError = ApiError::new(StatusCode::NOT_FOUND, "bark is not set up on this network");
const DOWN: ApiError = ApiError::new(StatusCode::BAD_GATEWAY, "bark server unavailable");
const UNREADABLE: ApiError =
    ApiError::new(StatusCode::BAD_GATEWAY, "bark server answer unreadable");
const INVALID: ApiError =
    ApiError::new(StatusCode::BAD_GATEWAY, "bark server answer did not verify");
const BUSY: ApiError = ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "bark lookups busy");
const NOT_HEX: ApiError = ApiError::bad_request("invalid vtxo hex");
const TOO_BIG: ApiError = ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "vtxo too large");
const SENT_UNREADABLE: ApiError = ApiError::bad_request("vtxo does not decode");
const SENT_INVALID: ApiError =
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "vtxo did not verify");

/// What a lookup came to: a JSON body, or an error with the label the request log gives it.
#[derive(Debug, Clone)]
enum Outcome {
    Found(Bytes),
    Failed(ApiError, &'static str),
}

impl Outcome {
    /// How long it is kept; a failure that may pass at once is not.
    fn keep(&self) -> Option<Duration> {
        match self {
            Self::Found(_) => Some(KEEP_FOUND),
            Self::Failed(_, "not_found" | "decode" | "invalid") => Some(KEEP_REFUSED),
            Self::Failed(..) => None,
        }
    }
}

/// Kept answers and lookups in flight by key, with the slots and per-client budget that bound
/// new ones.
#[derive(Debug)]
pub struct Lookups<K> {
    kept: Arc<Mutex<Kept<K>>>,
    slots: Arc<Semaphore>,
    clients: Arc<Clients>,
}

#[derive(Debug)]
struct Kept<K> {
    answers: HashMap<K, (Instant, Duration, Outcome)>,
    /// Oldest first, for eviction.
    order: VecDeque<K>,
    flights: HashMap<K, watch::Receiver<Option<Outcome>>>,
}

impl<K> Default for Kept<K> {
    fn default() -> Self {
        Self {
            answers: HashMap::new(),
            order: VecDeque::new(),
            flights: HashMap::new(),
        }
    }
}

enum Start {
    Kept(Outcome),
    /// A lookup in flight, and whether this request started it.
    Joined(watch::Receiver<Option<Outcome>>, bool),
}

fn lock<K>(kept: &Mutex<Kept<K>>) -> MutexGuard<'_, Kept<K>> {
    kept.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<K: Copy + Eq + Hash + Send + Sync + 'static> Lookups<K> {
    fn new(max_tracked_clients: usize) -> Self {
        Self {
            kept: Arc::default(),
            slots: Arc::new(Semaphore::new(MAX_LOOKUPS)),
            clients: Clients::with_rate(
                1.0 / CLIENT_EVERY.as_secs_f64(),
                CLIENT_BURST,
                max_tracked_clients,
            ),
        }
    }

    /// A kept answer, the lookup in flight, or `work` started in its own task: a client that
    /// leaves does not cancel the lookup others wait on. Only a new lookup costs a slot and a token.
    fn start<F>(&self, key: K, client: &Client, work: F) -> Result<Start, Refused>
    where
        F: Future<Output = Outcome> + Send + 'static,
    {
        let mut kept = lock(&self.kept);
        if let Some((at, ttl, outcome)) = kept.answers.get(&key) {
            if at.elapsed() < *ttl {
                return Ok(Start::Kept(outcome.clone()));
            }
            kept.answers.remove(&key);
        }
        if let Some(flight) = kept.flights.get(&key) {
            return Ok(Start::Joined(flight.clone(), false));
        }
        let permit: OwnedSemaphorePermit =
            Arc::clone(&self.slots)
                .try_acquire_owned()
                .map_err(|_| Refused {
                    error: BUSY,
                    reason: "bark_busy",
                })?;
        self.clients.take(client.addr)?;
        let (tx, rx) = watch::channel(None);
        kept.flights.insert(key, rx.clone());
        drop(kept);
        let state = Arc::clone(&self.kept);
        tokio::spawn(async move {
            let outcome = work.await;
            drop(permit);
            land(&state, key, &outcome);
            let _ = tx.send(Some(outcome));
        });
        Ok(Start::Joined(rx, true))
    }
}

fn land<K: Copy + Eq + Hash>(state: &Mutex<Kept<K>>, key: K, outcome: &Outcome) {
    let mut kept = lock(state);
    kept.flights.remove(&key);
    let Some(ttl) = outcome.keep() else { return };
    kept.order.retain(|k| *k != key);
    while kept.order.len() >= MAX_KEPT {
        if let Some(old) = kept.order.pop_front() {
            kept.answers.remove(&old);
        }
    }
    kept.order.push_back(key);
    kept.answers
        .insert(key, (Instant::now(), ttl, outcome.clone()));
}

/// The network's Bark lookups by id: its server, kept answers and calls in flight.
#[derive(Debug)]
pub struct Bark {
    endpoint: bark::Endpoint,
    lookups: Lookups<VtxoId>,
}

impl Bark {
    pub fn new(endpoint: bark::Endpoint, max_tracked_clients: usize) -> Self {
        Self {
            endpoint,
            lookups: Lookups::new(max_tracked_clients),
        }
    }
}

/// VTXOs clients send as hex, keyed by their bytes' hash. Every network has it: nothing here
/// asks a Bark server.
pub type Sent = Lookups<[u8; 32]>;

pub fn sent(max_tracked_clients: usize) -> Sent {
    Lookups::new(max_tracked_clients)
}

/// Why a VTXO was not shown, before each route words it.
enum Fault {
    Invalid,
    Node,
    Internal,
}

/// Checks a decoded VTXO against the anchor output the node holds, and writes the page's answer.
/// `asked` is the id it was fetched by, if any; a sent VTXO is checked against its own point.
async fn examine(ctx: &NetworkContext, vtxo: Vtxo, asked: Option<VtxoId>) -> Result<Bytes, Fault> {
    // The anchor is a transaction on our own chain: the node, not the sender, says what it is.
    let anchor: Option<TxOut> = match ctx.esplora.tx_raw(vtxo.anchor.txid).await {
        Ok(tx) => match tx.value.output.get(vtxo.anchor.vout as usize) {
            Some(out) => Some(out.clone()),
            None => return Err(Fault::Invalid),
        },
        Err(node::esplora::Error::NotFound) => None,
        Err(_) => return Err(Fault::Node),
    };
    let id = asked.unwrap_or(VtxoId(vtxo.point));
    // Up to about 40 ms of key aggregation at the size caps: off the async workers.
    let checked = tokio::task::spawn_blocking(move || bark::check(vtxo, id, anchor.as_ref()))
        .await
        .map_err(|_| Fault::Internal)?
        .map_err(|_| Fault::Invalid)?;
    serde_json::to_vec(&report(&checked, id))
        .map(Bytes::from)
        .map_err(|_| Fault::Internal)
}

async fn lookup(ctx: &NetworkContext, id: VtxoId) -> Outcome {
    let Some(bark) = &ctx.bark else {
        return Outcome::Failed(OFF, "off");
    };
    let bytes = match bark::get_vtxo(&bark.endpoint, &id, FETCH_TIMEOUT).await {
        Ok(b) => b,
        Err(FetchError::NotFound) => return Outcome::Failed(NOT_FOUND, "not_found"),
        Err(e @ (FetchError::Timeout | FetchError::Unavailable)) => {
            return Outcome::Failed(DOWN, e.label());
        }
        Err(e @ (FetchError::TooBig | FetchError::Decode)) => {
            return Outcome::Failed(UNREADABLE, e.label());
        }
    };
    let Ok(vtxo) = bark::decode(&bytes) else {
        return Outcome::Failed(UNREADABLE, "decode");
    };
    match examine(ctx, vtxo, Some(id)).await {
        Ok(body) => Outcome::Found(body),
        Err(Fault::Invalid) => Outcome::Failed(INVALID, "invalid"),
        Err(Fault::Node) => Outcome::Failed(ApiError::UPSTREAM, "node_unavailable"),
        Err(Fault::Internal) => Outcome::Failed(ApiError::INTERNAL, "encode"),
    }
}

fn sig(s: SigState) -> &'static str {
    match s {
        SigState::Valid => "valid",
        SigState::Missing => "missing",
        SigState::Unchecked => "unchecked",
    }
}

/// The page's answer. Keys and hashes as hex, amounts in sats, heights as numbers.
fn report(c: &Checked, id: VtxoId) -> Value {
    let v = &c.vtxo;
    let policy = match &v.policy {
        Policy::Pubkey { user_pubkey } => {
            json!({ "kind": "pubkey", "user_pubkey": user_pubkey.to_string() })
        }
        Policy::HtlcSend {
            user_pubkey,
            payment_hash,
            htlc_expiry,
            ..
        } => json!({
            "kind": v.policy.bark_name(),
            "user_pubkey": user_pubkey.to_string(),
            "payment_hash": hex(payment_hash),
            "htlc_expiry": htlc_expiry,
        }),
        Policy::HtlcRecv {
            user_pubkey,
            payment_hash,
            htlc_expiry,
            htlc_expiry_delta,
            ..
        } => json!({
            "kind": v.policy.bark_name(),
            "user_pubkey": user_pubkey.to_string(),
            "payment_hash": hex(payment_hash),
            "htlc_expiry": htlc_expiry,
            "htlc_expiry_delta": htlc_expiry_delta,
        }),
        Policy::Other { type_byte } => json!({ "kind": "other", "type": type_byte }),
    };
    let txs: Vec<Value> = v
        .items
        .iter()
        .zip(&c.txs)
        .map(|(item, tx)| {
            let kind = match item.transition {
                Transition::Cosigned { .. } => "branch",
                Transition::HashLocked { .. } => "leaf",
                Transition::Arkoor { .. } => "transfer",
            };
            json!({
                "txid": tx.txid.map(|t| t.to_string()),
                "kind": kind,
                "bark": item.transition.bark_name(),
                "output": item.output_idx,
                "value": tx.value.to_sat(),
                "siblings": item.siblings.iter().map(|s| s.value.to_sat()).collect::<Vec<_>>(),
                "fee": item.fee.to_sat(),
                "signature": sig(tx.signature),
            })
        })
        .collect();
    json!({
        "id": id.to_string(),
        "version": v.version,
        "amount": v.amount.to_sat(),
        "expiry_height": v.expiry_height,
        "exit_delta": v.exit_delta,
        "server_pubkey": v.server_pubkey.to_string(),
        "policy": policy,
        "anchor": {
            "txid": v.anchor.txid.to_string(),
            "vout": v.anchor.vout,
            "value": c.anchor_value.to_sat(),
            "found": c.anchored,
        },
        "rebuilt": c.rebuilt,
        "expiry_bound": c.expiry_bound,
        "signatures": if c.all_signed() { "valid" } else if c.txs.iter().any(|t| t.signature == SigState::Missing) { "missing" } else { "unchecked" },
        "txs": txs,
    })
}

fn hex(b: &[u8; 32]) -> String {
    use std::fmt::Write;
    b.iter().fold(String::with_capacity(64), |mut s, x| {
        let _ = write!(s, "{x:02x}");
        s
    })
}

fn outcome_response(outcome: Outcome, source: Source, route: &'static str) -> Response {
    let (mut res, error) = match outcome {
        Outcome::Found(body) => {
            let mut res = (StatusCode::OK, body).into_response();
            res.headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
            res.headers_mut().insert(
                CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=60"),
            );
            (res, None)
        }
        Outcome::Failed(e, label) => (e.into_response(), Some(label)),
    };
    res.extensions_mut().insert(ApiOutcome {
        route,
        source,
        upstream_error: error,
    });
    res
}

/// The answer to a started lookup, kept or awaited.
async fn finish(start: Result<Start, Refused>, route: &'static str) -> Response {
    let started = Instant::now();
    let (mut rx, started_it) = match start {
        Ok(Start::Kept(o)) => return outcome_response(o, Source::Cached, route),
        Ok(Start::Joined(rx, started_it)) => (rx, started_it),
        Err(refused) => return refused.into_response(),
    };
    let outcome = match rx.wait_for(Option::is_some).await {
        Ok(o) => o
            .clone()
            .unwrap_or(Outcome::Failed(ApiError::INTERNAL, "lost")),
        Err(_) => Outcome::Failed(ApiError::INTERNAL, "lost"),
    };
    let source = if started_it {
        Source::Upstream(started.elapsed())
    } else {
        Source::Coalesced
    };
    outcome_response(outcome, source, route)
}

pub async fn route(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<Client>,
    Path(id): Path<String>,
) -> Response {
    // The request is checked before anything else, whatever the network has.
    let Ok(id) = id.parse::<VtxoId>() else {
        return ApiError::bad_request("invalid vtxo id").into_response();
    };
    let Some(bark) = &ctx.bark else {
        return OFF.into_response();
    };
    let work = {
        let ctx = Arc::clone(&ctx);
        async move { lookup(&ctx, id).await }
    };
    finish(bark.lookups.start(id, &client, work), ROUTE).await
}

/// Hex digits to bytes: exactly an even number of them, nothing else, not even a newline.
fn unhex(text: &[u8]) -> Option<Vec<u8>> {
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    let (pairs, rest) = text.as_chunks::<2>();
    if pairs.is_empty() || !rest.is_empty() {
        return None;
    }
    pairs
        .iter()
        .map(|[hi, lo]| Some(digit(*hi)? << 4 | digit(*lo)?))
        .collect()
}

/// `POST /app/ark/bark/vtxo`: a VTXO's bytes as hex in the body, checked as one fetched by id is,
/// against its own point. The body is never logged and never kept: only the answer, by its hash.
pub async fn sent_route(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<Client>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = match body {
        Ok(b) => b,
        Err(r) if r.status() == StatusCode::PAYLOAD_TOO_LARGE => return TOO_BIG.into_response(),
        Err(_) => return NOT_HEX.into_response(),
    };
    if body.len() > MAX_SENT_BODY {
        return TOO_BIG.into_response();
    }
    let Some(bytes) = unhex(&body) else {
        return NOT_HEX.into_response();
    };
    // Decoding is linear in a body already capped, so it costs no lookup slot or token.
    let Ok(vtxo) = bark::decode(&bytes) else {
        return SENT_UNREADABLE.into_response();
    };
    let key = <sha256::Hash as HashBytes>::hash(&bytes).to_byte_array();
    let work = {
        let ctx = Arc::clone(&ctx);
        async move {
            match examine(&ctx, vtxo, None).await {
                Ok(body) => Outcome::Found(body),
                Err(Fault::Invalid) => Outcome::Failed(SENT_INVALID, "invalid"),
                Err(Fault::Node) => Outcome::Failed(ApiError::UPSTREAM, "node_unavailable"),
                Err(Fault::Internal) => Outcome::Failed(ApiError::INTERNAL, "encode"),
            }
        }
    };
    finish(ctx.bark_sent.start(key, &client, work), SENT_ROUTE).await
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use bitcoin::Transaction;
    use bitcoin::consensus::deserialize;
    use bitcoin::hex::FromHex;

    const RECORDED: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/bark/answer-arkoor3.json"
    );

    /// The answer for ark-lib's `arkoor3_vtxo` (a branch, a leaf and two transfers), which the
    /// frontend's tests read. `BARK_RECORD=1` writes it again.
    #[test]
    fn the_recorded_answer_is_ours() {
        let text = include_str!("../../../fixtures/bark/vectors.json");
        let json: Value = serde_json::from_str(text).unwrap();
        let hex = |k: &str| Vec::<u8>::from_hex(json["v2"][k].as_str().unwrap()).unwrap();
        let vtxo = bark::decode(&hex("arkoor3_vtxo")).unwrap();
        let round: Transaction = deserialize(&hex("round_tx")).unwrap();
        let anchor = round.output[vtxo.anchor.vout as usize].clone();
        let id = VtxoId(vtxo.point);
        let checked = bark::check(vtxo, id, Some(&anchor)).unwrap();
        let answer = serde_json::to_string_pretty(&report(&checked, id)).unwrap() + "\n";
        if std::env::var_os("BARK_RECORD").is_some() {
            std::fs::write(RECORDED, &answer).unwrap();
        }
        assert_eq!(std::fs::read_to_string(RECORDED).unwrap(), answer);
    }
}
