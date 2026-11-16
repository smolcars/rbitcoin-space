//! `POST /app/tx/check`: what a pasted raw transaction does, before anyone broadcasts it
//! (`docs/API.md`, "Checking a transaction"). It writes nothing. The node is asked only for the
//! outputs the transaction spends and whether it already has it, under the cost limit of the
//! address and batch routes ([`esplora::heavy_call`]).

#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::sync::Arc;

use axum::Extension;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::extract::rejection::BytesRejection;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bitcoin::hex::DisplayHex;
use bitcoin::{Address, Script, Transaction, TxOut, Txid};
use node::esplora::{Error, Esplora, RawResponse, Route};
use serde::Serialize;
use serde_json::Value;

use crate::esplora::{self, ApiOutcome};
use crate::limits::Client;
use crate::transactions::{self, BATCH_DEADLINE, Prevout};
use crate::{ApiError, NetworkContext};

/// Most distinct outputs one check looks up, as `POST /api/v1/prevouts` allows. Past it the
/// inputs are listed without what they spend, and the fee is not known.
pub const MAX_LOOKUPS: usize = transactions::MAX_PREVOUTS;

/// The transaction in Esplora's shape, so the transaction page's parts can show it.
#[derive(Debug, Serialize)]
struct Tx {
    txid: String,
    version: i32,
    locktime: u32,
    vin: Vec<Vin>,
    vout: Vec<Prevout>,
    size: usize,
    weight: u64,
    /// Only when every spent output was found and they hold at least what it pays out.
    #[serde(skip_serializing_if = "Option::is_none")]
    fee: Option<u64>,
    status: Unconfirmed,
}

#[derive(Debug, Serialize)]
struct Unconfirmed {
    confirmed: bool,
}

#[derive(Debug, Serialize)]
struct Vin {
    txid: String,
    vout: u32,
    /// Absent when not looked up (a coinbase, or past [`MAX_LOOKUPS`]), `null` when not found.
    #[serde(skip_serializing_if = "Option::is_none")]
    prevout: Option<Option<Prevout>>,
    scriptsig: String,
    scriptsig_asm: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    witness: Vec<String>,
    is_coinbase: bool,
    sequence: u32,
}

#[derive(Debug, Serialize)]
struct Checked {
    tx: Tx,
    /// The node's status of this txid when it already has it (in the mempool or a block).
    known: Option<Value>,
}

/// Esplora's name for an output script's form.
fn kind(s: &Script) -> &'static str {
    if s.is_p2pkh() {
        "p2pkh"
    } else if s.is_p2sh() {
        "p2sh"
    } else if s.is_p2wpkh() {
        "v0_p2wpkh"
    } else if s.is_p2wsh() {
        "v0_p2wsh"
    } else if s.is_p2tr() {
        "v1_p2tr"
    } else if s.is_op_return() {
        "op_return"
    } else if s.is_p2pk() {
        "p2pk"
    } else if s.is_multisig() {
        "multisig"
    } else {
        "unknown"
    }
}

fn output(out: &TxOut, chain: bitcoin::Network) -> Prevout {
    let s = &out.script_pubkey;
    Prevout {
        scriptpubkey: s.as_bytes().to_lower_hex_string(),
        scriptpubkey_address: Address::from_script(s, chain).ok().map(|a| a.to_string()),
        scriptpubkey_asm: s.to_asm_string(),
        scriptpubkey_type: kind(s).to_owned(),
        value: out.value.to_sat(),
    }
}

/// The distinct outputs the transaction spends, in input order, at most [`MAX_LOOKUPS`].
fn wanted(tx: &Transaction) -> Vec<(Txid, u32)> {
    if tx.is_coinbase() {
        return Vec::new();
    }
    let mut seen = HashSet::new();
    tx.input
        .iter()
        .map(|i| (i.previous_output.txid, i.previous_output.vout))
        .filter(|o| seen.insert(*o))
        .take(MAX_LOOKUPS)
        .collect()
}

/// The answer from the transaction, the outputs found for [`wanted`] (in its order) and what the
/// node said about its txid.
fn checked(
    tx: &Transaction,
    chain: bitcoin::Network,
    wanted: &[(Txid, u32)],
    found: Vec<Option<Prevout>>,
    known: Option<Value>,
) -> Checked {
    let coinbase = tx.is_coinbase();
    let looked: std::collections::HashMap<(Txid, u32), Option<Prevout>> =
        wanted.iter().copied().zip(found).collect();
    let vin: Vec<Vin> = tx
        .input
        .iter()
        .map(|i| Vin {
            txid: i.previous_output.txid.to_string(),
            vout: i.previous_output.vout,
            prevout: looked
                .get(&(i.previous_output.txid, i.previous_output.vout))
                .cloned(),
            scriptsig: i.script_sig.as_bytes().to_lower_hex_string(),
            scriptsig_asm: i.script_sig.to_asm_string(),
            witness: i.witness.iter().map(|w| w.to_lower_hex_string()).collect(),
            is_coinbase: coinbase,
            sequence: i.sequence.0,
        })
        .collect();
    let vout: Vec<Prevout> = tx.output.iter().map(|o| output(o, chain)).collect();
    let fee = if coinbase {
        None
    } else {
        let spent = vin.iter().try_fold(0u64, |a, i| {
            a.checked_add(i.prevout.as_ref()?.as_ref()?.value)
        });
        let paid = vout.iter().try_fold(0u64, |a, o| a.checked_add(o.value));
        spent.zip(paid).and_then(|(s, p)| s.checked_sub(p))
    };
    Checked {
        tx: Tx {
            txid: tx.compute_txid().to_string(),
            version: tx.version.0,
            locktime: tx.lock_time.to_consensus_u32(),
            vin,
            vout,
            size: tx.total_size(),
            weight: tx.weight().to_wu(),
            fee,
            status: Unconfirmed { confirmed: false },
        },
        known,
    }
}

pub async fn route(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<Client>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = match body {
        Ok(b) => b,
        Err(r) if r.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return ApiError::PAYLOAD_TOO_LARGE.into_response();
        }
        Err(_) => return ApiError::bad_request("could not read the request body").into_response(),
    };
    let tx = match esplora::parse_tx(&body) {
        Ok(t) => t,
        Err(e) => return e.into_response(),
    };
    let wanted = wanted(&tx);
    // Outputs of transactions the tracker holds are read from the whole transaction at once.
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
    let chain = crate::difficulty::chain(ctx.config.network);
    // The wtxid names every byte that decoded, so equal checks share one call.
    let key = format!("app/tx/check\n{}", tx.compute_wtxid());
    let outcome = esplora::heavy_call(&ctx, &client, key, None, move |esplora| async move {
        let deadline = std::time::Instant::now() + BATCH_DEADLINE;
        let found = transactions::find(&esplora, &wanted, &held, deadline).await?;
        let found = found.into_iter().map(|f| f.map(|f| f.prevout)).collect();
        let known = status(&esplora, tx.compute_txid()).await?;
        let body = serde_json::to_vec(&checked(&tx, chain, &wanted, found, known))
            .map_err(|e| Error::Decode(e.to_string()))?;
        Ok(RawResponse {
            status: StatusCode::OK,
            content_type: Some(HeaderValue::from_static("application/json")),
            tip: None,
            body: body.into(),
        })
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
            res
        }
        Err(Error::Timeout) => ApiError::TIMEOUT.into_response(),
        Err(_) => ApiError::UPSTREAM.into_response(),
    };
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res.extensions_mut().insert(ApiOutcome {
        route: "app_tx_check",
        source,
        upstream_error,
    });
    res
}

/// The node's status of a txid it has, `None` when it has never heard of it.
async fn status(esplora: &Esplora, txid: Txid) -> Result<Option<Value>, Error> {
    let raw = esplora.raw(&Route::TxStatus { txid, asof: None }).await?;
    transactions::decode::<Value>(&raw)
}
