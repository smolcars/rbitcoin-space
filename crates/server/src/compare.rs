//! `GET /app/tx/:txid/compare/:other`: two versions of a replaced transaction side by side, for
//! the transaction page's compare view (`docs/FRONTEND.md`, `docs/API.md`).
//!
//! Answered from memory: each version's figures, inputs and outputs as the replacement record
//! kept them ([`engine::replacements::Replacements::version_of`]), or as the mempool tracker holds
//! them for a version still waiting. Only a version the record names whose outputs neither has
//! (a replacement the tracker never held, confirmed straight from a block) is asked of the node:
//! one Esplora read each, so at most two a request, and none for a txid the record does not know.
//! The answer is bounded: two versions of at most `MAX_OUTPUTS` outputs each.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::header::CACHE_CONTROL;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bitcoin::{ScriptBuf, Txid};
use engine::outputs::{Outputs, Script};
use engine::replacements::{Facts, Replacements};
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
    let (mut versions, shared) = ctx.track.with_replacements(|r| {
        // Two txids in one history have the same newest end; two the record does not know are
        // each their own, and differ.
        if r.root(&a) != r.root(&b) {
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
        Ok(([of(&a), of(&b)], shared(r, &a, &b)))
    })?;
    for (txid, v) in [a, b].iter().zip(versions.iter_mut()) {
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
        if v.outputs.is_none() {
            from_node(&ctx, txid, v).await;
        }
    }
    let chain = crate::difficulty::chain(ctx.config.network);
    let body = json!({
        "a": versions[0].json(&a, chain),
        "b": versions[1].json(&b, chain),
        "shared_inputs": shared,
    });
    let mut res = (StatusCode::OK, Json(body)).into_response();
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

/// Fills in what the node knows of `txid`: one read. A version it has forgotten stays as it was.
async fn from_node(ctx: &NetworkContext, txid: &Txid, v: &mut Version) {
    let Ok(tx) = ctx.esplora.tx(*txid).await else {
        return;
    };
    let tx = tx.value;
    let scripts: Option<Vec<(u64, ScriptBuf)>> = tx
        .vout
        .iter()
        .map(|o| Some((o.value, ScriptBuf::from_hex(&o.scriptpubkey).ok()?)))
        .collect();
    let Some(scripts) = scripts else {
        return;
    };
    let outputs = match engine::outputs::encode(scripts.iter().map(|(v, s)| (*v, s.as_bytes()))) {
        Some(b) => Outputs::Kept(b.into()),
        None => Outputs::TooMany(u32::try_from(scripts.len()).unwrap_or(u32::MAX)),
    };
    let value = scripts
        .iter()
        .fold(0u64, |sum, (v, _)| sum.saturating_add(*v));
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
    v.inputs = v.inputs.or(u32::try_from(tx.vin.len()).ok());
    v.outputs = Some(outputs);
    v.from = v.from.or(Some(From::Node));
}

#[cfg(test)]
mod tests;
