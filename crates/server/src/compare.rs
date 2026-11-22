//! `GET /app/tx/:txid/compare/:other`: two versions of a replaced transaction side by side, for
//! the transaction page's compare view (`docs/FRONTEND.md`, `docs/API.md`).
//!
//! Answered from memory: each version's figures, inputs and outputs as the replacement record
//! kept them ([`engine::replacements::Replacements::version_of`]), or as the mempool tracker holds
//! them for a version still waiting. A version not itself replaced (the newest of its line) whose
//! outputs neither has is asked of the node: one Esplora read, coalesced with identical reads in
//! flight, so at most two a request; never one that was replaced, which the node has forgotten.
//! The answer is bounded: two versions of at most `MAX_OUTPUTS` outputs each.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::header::CACHE_CONTROL;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bitcoin::{ScriptBuf, Txid};
use engine::outputs::{MAX_OUTPUTS, Outputs, Script};
use engine::replacements::{Facts, Replacements};
use node::esplora::Route;
use serde_json::{Value, json};

use crate::ws::track::MEMPOOL_OFF;
use crate::{ApiError, NetworkContext, esplora};

const NOT_VERSIONS: ApiError =
    ApiError::new(StatusCode::NOT_FOUND, "not two versions of one transaction");
const SAME: ApiError = ApiError::bad_request("the same transaction twice");

/// Where a version's figures came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum From {
    Record,
    Mempool,
    Node,
}

/// One version as answered.
#[derive(Debug, Clone, Default)]
struct Version {
    facts: Option<Facts>,
    outputs: Option<Outputs>,
    inputs: Option<u32>,
    from: Option<From>,
}

/// Each kept output with its address added where its script has one, so the page shows what a
/// reader knows (`bc1q…`), not a script.
fn outputs_json(outputs: Option<&Outputs>, chain: bitcoin::Network) -> Value {
    let Some(o) = outputs else {
        return json!({ "state": "not_recorded" });
    };
    let mut v = o.json();
    if let Some(Value::Array(list)) = v.get_mut("list") {
        let scripts = o.list().unwrap_or_default();
        for (item, out) in list.iter_mut().zip(scripts) {
            if let (Value::Object(m), Script::Full(s)) = (item, &out.script) {
                let address = bitcoin::Address::from_script(bitcoin::Script::from_bytes(s), chain)
                    .ok()
                    .map(|a| a.to_string());
                m.insert("address".into(), json!(address));
            }
        }
    }
    v
}

impl Version {
    fn json(&self, txid: &Txid, chain: bitcoin::Network) -> Value {
        let f = self.facts;
        json!({
            "txid": txid,
            "fee": f.map(|f| f.fee),
            "vsize": f.map(|f| f.vsize),
            "weight": f.map(|f| f.weight),
            "value": f.map(|f| f.value),
            "rate": f.and_then(|f| {
                (f.vsize > 0).then(|| f.fee.saturating_mul(1000) / u64::from(f.vsize))
            }),
            "inputs": self.inputs,
            "outputs": outputs_json(self.outputs.as_ref(), chain),
            "from": match self.from {
                Some(From::Record) => "record",
                Some(From::Mempool) => "mempool",
                Some(From::Node) => "node",
                None => "none",
            },
        })
    }
}

/// How many inputs `a` and `b` both spend, when one directly replaced the other and the tracker
/// held both.
fn shared(r: &Replacements, a: &Txid, b: &Txid) -> Option<u32> {
    let between = |x: &Txid, y: &Txid| {
        r.get(x)
            .filter(|l| l.by == *y)
            .and_then(|_| r.sides(x)?.shared)
    };
    between(a, b).or_else(|| between(b, a))
}

pub async fn route(
    State(ctx): State<Arc<NetworkContext>>,
    Path((a, b)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let (a, b) = (esplora::txid(&a)?, esplora::txid(&b)?);
    if a == b {
        return Err(SAME);
    }
    if !ctx.track.mempool_enabled() {
        return Err(MEMPOOL_OFF);
    }
    let (mut versions, shared, replaced) = ctx.track.with_replacements(|r| {
        // Only versions of one another, joined by links that are not a child's (docs/MEMPOOL.md,
        // "Versions"): a child that left with its parent is no version, whichever way round.
        if !r.are_versions(&a, &b) {
            return Err(NOT_VERSIONS);
        }
        let of = |t: &Txid| {
            r.version_of(t).map_or_else(Version::default, |v| Version {
                facts: Some(v.facts),
                outputs: v.outputs,
                inputs: v.inputs,
                from: Some(From::Record),
            })
        };
        // A version that was itself replaced is forgotten by the node.
        let replaced = [r.get(&a).is_some(), r.get(&b).is_some()];
        Ok(([of(&a), of(&b)], shared(r, &a, &b), replaced))
    })?;
    for ((txid, v), replaced) in [a, b].iter().zip(versions.iter_mut()).zip(replaced) {
        if v.outputs.is_some() && v.facts.is_some() {
            continue;
        }
        // Still waiting: the tracker holds it, outputs and all.
        let held = ctx.track.engines().and_then(|(tracker, _)| {
            tracker.read(|m| {
                m.get(txid)
                    .map(|i| (Facts::of(i), i.kept_outputs(), i.inputs()))
            })
        });
        if let Some((facts, outputs, inputs)) = held {
            v.facts = v.facts.or(Some(facts));
            v.outputs = v.outputs.take().or(outputs);
            v.inputs = v.inputs.or(Some(inputs));
            v.from = v.from.or(Some(From::Mempool));
            continue;
        }
        // The node still has a version that was not itself replaced: the newest of its line,
        // waiting or mined. It is asked for one with no outputs here (never held, stored before
        // outputs were kept, or past the budget); a replaced one it has forgotten is not.
        if !replaced && v.outputs.is_none() {
            from_node(&ctx, txid, v).await;
        }
    }
    // One size basis for both sides: the node's is weight over four, the tracker's adjusted for
    // signature operations, so a side from the node puts both on weight.
    let by_weight = versions.iter().any(|v| v.from == Some(From::Node));
    if by_weight {
        for v in &mut versions {
            if let Some(f) = &mut v.facts {
                f.vsize = f.weight.div_ceil(4);
            }
        }
    }
    let chain = crate::difficulty::chain(ctx.config.network);
    let body = json!({
        "a": versions[0].json(&a, chain),
        "b": versions[1].json(&b, chain),
        "shared_inputs": shared,
        "vsize_basis": if by_weight { "weight" } else { "sigops" },
    });
    let mut res = (StatusCode::OK, Json(body)).into_response();
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

/// The node's answer for `txid`, shared with every identical read in flight, the public
/// transaction route's included (rule 8).
async fn node_tx(ctx: &NetworkContext, txid: &Txid) -> Option<node::esplora::model::Tx> {
    let route = Route::Tx(*txid);
    let mut key = String::with_capacity(80);
    route.write_path(&mut key);
    let (answer, _) = ctx
        .api
        .flights
        .run(key, Duration::ZERO, ctx.esplora.raw(&route))
        .await;
    let raw = answer.ok()?;
    if !raw.status.is_success() {
        return None;
    }
    serde_json::from_slice(&raw.body).ok()
}

/// Fills in what the node knows of `txid`: one read, coalesced. A version it has forgotten stays
/// as it was.
async fn from_node(ctx: &NetworkContext, txid: &Txid, v: &mut Version) {
    let Some(tx) = node_tx(ctx, txid).await else {
        return;
    };
    let value = tx
        .vout
        .iter()
        .fold(0u64, |sum, o| sum.saturating_add(o.value));
    // Counted before any script is read: past the cap only the count is kept.
    let outputs = if tx.vout.len() > MAX_OUTPUTS {
        Some(Outputs::TooMany(
            u32::try_from(tx.vout.len()).unwrap_or(u32::MAX),
        ))
    } else {
        let scripts: Option<Vec<(u64, ScriptBuf)>> = tx
            .vout
            .iter()
            .map(|o| Some((o.value, ScriptBuf::from_hex(&o.scriptpubkey).ok()?)))
            .collect();
        scripts.and_then(|s| {
            engine::outputs::encode(s.iter().map(|(v, s)| (*v, s.as_bytes())))
                .map(|b| Outputs::Kept(b.into()))
        })
    };
    let sat = |x: u64| u32::try_from(x).unwrap_or(u32::MAX);
    v.facts = v.facts.or_else(|| {
        let weight = tx.weight?;
        Some(Facts {
            fee: tx.fee?,
            vsize: sat(weight.div_ceil(4)),
            weight: sat(weight),
            value,
            time: 0,
            rbf: false,
        })
    });
    // A pruned reply lists only some inputs: their count says nothing.
    if !tx.pruned {
        v.inputs = v.inputs.or(u32::try_from(tx.vin.len()).ok());
    }
    v.outputs = v.outputs.take().or(outputs);
    v.from = v.from.or(Some(From::Node));
}

#[cfg(test)]
mod tests;
