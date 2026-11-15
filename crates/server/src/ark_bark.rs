//! `GET /app/ark/bark/vtxo/{id}`: a Bark VTXO, fetched from the network's Bark server, decoded,
//! and checked against the node before anything is shown (docs/ARK.md).
//!
//! The Bark server is a third party: its answer is untrusted content, read under a size cap and
//! a timeout, and refused unless its exit chain spends the anchor output the node holds and hashes
//! to the id asked for, with valid signatures. Identical lookups in flight share one call, answers
//! are kept a while, and a client starts at most a few new lookups a second.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bark::{Checked, FetchError, Policy, SigState, Transition, VtxoId};
use bitcoin::TxOut;
use serde_json::{Value, json};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};

use crate::esplora::{ApiOutcome, Source};
use crate::limits::{Client, Clients, Refused};
use crate::{ApiError, NetworkContext};

/// How long one lookup may take at the Bark server, inside the request timeout.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(6);
/// Lookups at the Bark server at once, for the network.
pub const MAX_LOOKUPS: usize = 4;
/// Answers kept, by id.
pub const MAX_KEPT: usize = 256;
/// A checked VTXO, kept this long: a leaf's preimage can still arrive and sign it.
pub const KEEP_FOUND: Duration = Duration::from_secs(600);
/// An id the server does not know, or an answer that did not check out.
pub const KEEP_REFUSED: Duration = Duration::from_secs(30);
/// New lookups one client may start: a burst, then one every few seconds.
pub const CLIENT_BURST: u32 = 10;
pub const CLIENT_EVERY: Duration = Duration::from_secs(3);

const ROUTE: &str = "bark_vtxo";
const NOT_FOUND: ApiError = ApiError::new(StatusCode::NOT_FOUND, "vtxo not found");
const OFF: ApiError = ApiError::new(StatusCode::NOT_FOUND, "bark is not set up on this network");
const DOWN: ApiError = ApiError::new(StatusCode::BAD_GATEWAY, "bark server unavailable");
const UNREADABLE: ApiError =
    ApiError::new(StatusCode::BAD_GATEWAY, "bark server answer unreadable");
const INVALID: ApiError =
    ApiError::new(StatusCode::BAD_GATEWAY, "bark server answer did not verify");
const BUSY: ApiError = ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "bark lookups busy");

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

/// The network's Bark lookups: its server, kept answers and calls in flight.
#[derive(Debug)]
pub struct Bark {
    endpoint: bark::Endpoint,
    state: Mutex<Kept>,
    lookups: Arc<Semaphore>,
    clients: Arc<Clients>,
}

#[derive(Debug, Default)]
struct Kept {
    answers: HashMap<VtxoId, (Instant, Duration, Outcome)>,
    /// Oldest first, for eviction.
    order: VecDeque<VtxoId>,
    flights: HashMap<VtxoId, watch::Receiver<Option<Outcome>>>,
}

enum Start {
    Kept(Outcome),
    /// A lookup in flight, and whether this request started it.
    Joined(watch::Receiver<Option<Outcome>>, bool),
}

impl Bark {
    pub fn new(endpoint: bark::Endpoint, max_tracked_clients: usize) -> Self {
        Self {
            endpoint,
            state: Mutex::default(),
            lookups: Arc::new(Semaphore::new(MAX_LOOKUPS)),
            clients: Clients::with_rate(
                1.0 / CLIENT_EVERY.as_secs_f64(),
                CLIENT_BURST,
                max_tracked_clients,
            ),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Kept> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn start(
        &self,
        ctx: &Arc<NetworkContext>,
        id: VtxoId,
        client: &Client,
    ) -> Result<Start, Refused> {
        let mut kept = self.lock();
        if let Some((at, ttl, outcome)) = kept.answers.get(&id) {
            if at.elapsed() < *ttl {
                return Ok(Start::Kept(outcome.clone()));
            }
            kept.answers.remove(&id);
        }
        if let Some(flight) = kept.flights.get(&id) {
            return Ok(Start::Joined(flight.clone(), false));
        }
        let permit: OwnedSemaphorePermit =
            Arc::clone(&self.lookups)
                .try_acquire_owned()
                .map_err(|_| Refused {
                    error: BUSY,
                    reason: "bark_busy",
                })?;
        self.clients.take(client.addr)?;
        let (tx, rx) = watch::channel(None);
        kept.flights.insert(id, rx.clone());
        drop(kept);
        // Its own task: a client that leaves does not cancel the lookup others wait on.
        let ctx = Arc::clone(ctx);
        tokio::spawn(async move {
            let outcome = lookup(&ctx, id).await;
            drop(permit);
            if let Some(bark) = &ctx.bark {
                bark.land(id, &outcome);
            }
            let _ = tx.send(Some(outcome));
        });
        Ok(Start::Joined(rx, true))
    }

    fn land(&self, id: VtxoId, outcome: &Outcome) {
        let mut kept = self.lock();
        kept.flights.remove(&id);
        let Some(ttl) = outcome.keep() else { return };
        kept.order.retain(|k| *k != id);
        while kept.order.len() >= MAX_KEPT {
            if let Some(old) = kept.order.pop_front() {
                kept.answers.remove(&old);
            }
        }
        kept.order.push_back(id);
        kept.answers
            .insert(id, (Instant::now(), ttl, outcome.clone()));
    }
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
    // The anchor is a transaction on our own chain: the node, not the Bark server, says what it is.
    let anchor: Option<TxOut> = match ctx.esplora.tx_raw(vtxo.anchor.txid).await {
        Ok(tx) => match tx.value.output.get(vtxo.anchor.vout as usize) {
            Some(out) => Some(out.clone()),
            None => return Outcome::Failed(INVALID, "invalid"),
        },
        Err(node::esplora::Error::NotFound) => None,
        Err(_) => return Outcome::Failed(ApiError::UPSTREAM, "node_unavailable"),
    };
    match bark::check(vtxo, id, anchor.as_ref()) {
        Ok(c) => match serde_json::to_vec(&report(&c, id)) {
            Ok(body) => Outcome::Found(body.into()),
            Err(_) => Outcome::Failed(ApiError::INTERNAL, "encode"),
        },
        Err(_) => Outcome::Failed(INVALID, "invalid"),
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

fn outcome_response(outcome: Outcome, source: Source) -> Response {
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
        route: ROUTE,
        source,
        upstream_error: error,
    });
    res
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
    let started = Instant::now();
    let (mut rx, started_it) = match bark.start(&ctx, id, &client) {
        Ok(Start::Kept(o)) => return outcome_response(o, Source::Cached),
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
    outcome_response(outcome, source)
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
