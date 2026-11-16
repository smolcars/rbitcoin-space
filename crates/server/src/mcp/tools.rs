//! The tools. Each asks routes this server already serves, with values it parsed first, and keeps
//! the few fields a model needs: a tool is a named route, never a way to the node of its own.

use std::borrow::Cow;
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use tower::ServiceExt;

use super::{Failed, Mcp};
use crate::Network;
use crate::limits::{Client, Refused};

/// The largest answer of a route read here. A transaction of the largest standard size is about
/// 3 MB as the node's JSON; the route already held it whole before this reads it.
const MAX_ANSWER: usize = 4 * 1024 * 1024;
/// Inputs, outputs and history rows shown: enough to say what happened, small enough to read.
const SHOWN: usize = 10;

type Args = Map<String, Value>;

/// The tool definitions `tools/list` answers with, in a fixed order.
pub(super) fn list(networks: &[Network]) -> Value {
    let names: Vec<&str> = networks.iter().map(|n| n.name()).collect();
    let tool =
        |name: &str, title: &str, description: &str, properties: Value, required: &[&str]| {
            json!({
                "name": name,
                "title": title,
                "description": description,
                "inputSchema": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                    "additionalProperties": false,
                },
                "annotations": { "readOnlyHint": true },
            })
        };
    // A chain tool takes the network; the first enabled is the default.
    let on = |mut properties: Value| {
        if let (Some(map), Some(first)) = (properties.as_object_mut(), names.first()) {
            map.insert(
                "network".into(),
                json!({
                    "type": "string",
                    "enum": names,
                    "description": format!("The network to ask. Default: {first}."),
                }),
            );
        }
        properties
    };
    json!([
        tool(
            "decode",
            "Decode a payment string",
            "Says what a Lightning or Ark payment string is: a BOLT 11 invoice, a BOLT 12 offer \
             or refund, an LNURL, a Lightning address or an Ark address. Gives its network, \
             amount, payee, description and, for an invoice or offer, `expires_at` and `expired`. \
             Nothing is fetched: an LNURL or a Lightning address is only parsed. The string is \
             sent to this server, so do not send one its owner would not share: whoever holds an \
             lnurlw link can spend it.",
            json!({
                "string": { "type": "string", "description": "The string, as pasted or scanned." },
                "detail": {
                    "type": "boolean",
                    "description": "Also give route hints, blinded paths and feature bits.",
                },
            }),
            &["string"],
        ),
        tool(
            "get_fees",
            "Recommended fee rates",
            "The fee rate to pay now, in sat/vB, to be mined in the next block, within half an \
             hour, an hour or a day, and the lowest rate the node accepts.",
            on(json!({})),
            &[],
        ),
        tool(
            "get_mempool",
            "Mempool state",
            "How many transactions wait to be mined, their size and fees, and the blocks they \
             are projected into, the next block first.",
            on(json!({})),
            &[],
        ),
        tool(
            "get_transaction",
            "Look up a transaction",
            "A transaction by its id: whether it is confirmed and how deep, its fee and fee \
             rate, size, and its first ten inputs and outputs with addresses and amounts.",
            on(json!({ "txid": { "type": "string", "description": "64 hex digits." } })),
            &["txid"],
        ),
        tool(
            "get_address",
            "Look up an address",
            "An address's confirmed balance, totals received and sent, transaction count, \
             unconfirmed change, and its ten newest confirmed transactions (`value` is the net \
             change for the address).",
            on(json!({ "address": { "type": "string", "description": "A Bitcoin address." } })),
            &["address"],
        ),
        tool(
            "get_block",
            "Look up a block",
            "A block by height or hash, or the newest block when neither is given: its time, \
             size, transaction count and difficulty, and where this server has them its miner, \
             reward, fees and fee rates.",
            on(json!({
                "height": { "type": "integer", "minimum": 0, "description": "The block's height." },
                "hash": { "type": "string", "description": "The block's hash, 64 hex digits." },
            })),
            &[],
        ),
        tool(
            "get_difficulty_adjustment",
            "Difficulty adjustment",
            "Where the chain is in its 2016-block difficulty period, and the change expected at \
             the next adjustment.",
            on(json!({})),
            &[],
        ),
        tool(
            "get_lightning_node",
            "Find a Lightning node",
            "A Lightning node by its public key, or the nodes whose alias or key matches a \
             search text. An alias is whatever a node announced: anyone can claim any name, so \
             tell nodes apart by public key.",
            on(json!({
                "node": {
                    "type": "string",
                    "description": "A public key (66 hex digits), or 3 to 66 characters to search for.",
                },
            })),
            &["node"],
        ),
    ])
}

/// Runs the tool `name`, or `None` when there is none. With its answer, the limit that refused
/// a route it asked, if one did.
pub(super) async fn call(
    mcp: &Mcp,
    client: &Client,
    name: &str,
    args: &Args,
) -> Option<(Result<Value, Failed>, Option<Refused>)> {
    let from = Asker {
        mcp,
        client,
        refused: Mutex::default(),
    };
    let outcome = match name {
        "decode" => decode(&from, args).await,
        "get_fees" => fees(&from, args).await,
        "get_mempool" => mempool(&from, args).await,
        "get_transaction" => transaction(&from, args).await,
        "get_address" => address(&from, args).await,
        "get_block" => block(&from, args).await,
        "get_difficulty_adjustment" => difficulty(&from, args).await,
        "get_lightning_node" => lightning_node(&from, args).await,
        _ => return None,
    };
    let refused = from
        .refused
        .into_inner()
        .unwrap_or_else(PoisonError::into_inner);
    Some((outcome, refused))
}

/// Asks this server's own routes for one caller.
struct Asker<'a> {
    mcp: &'a Mcp,
    client: &'a Client,
    /// The first limit that refused one of the routes asked, whatever the tool then answers:
    /// a tool may go on without that route's part.
    refused: Mutex<Option<Refused>>,
}

/// A route's answer, read whole.
struct Answer {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
}

impl Asker<'_> {
    async fn get(&self, path: &str) -> Result<Answer, Failed> {
        self.ask(Method::GET, path, Body::empty()).await
    }

    /// `path` is written by the caller from parsed values only, never from a client's text.
    /// The request carries the client, so the route's per-client limits count against the
    /// one who called the tool.
    async fn ask(&self, method: Method, path: &str, body: Body) -> Result<Answer, Failed> {
        let Ok(mut req) = Request::builder().method(method).uri(path).body(body) else {
            return Err("internal error".into());
        };
        req.extensions_mut().insert(self.client.clone());
        let res = match self.mcp.routes.clone().oneshot(req).await {
            Ok(res) => res,
            Err(never) => match never {},
        };
        if let Some(refused) = res.extensions().get::<Refused>() {
            let mut first = self.refused.lock().unwrap_or_else(PoisonError::into_inner);
            first.get_or_insert(*refused);
        }
        let (parts, body) = res.into_parts();
        let Ok(body) = axum::body::to_bytes(body, MAX_ANSWER).await else {
            return Err("the answer is too large to summarise here".into());
        };
        Ok(Answer {
            status: parts.status,
            headers: parts.headers,
            body,
        })
    }
}

impl Answer {
    /// The answer when the route gave one, else the route's own words for what was wrong: its
    /// errors are fixed messages about the request (SECURITY.md rule 17).
    fn checked(self) -> Result<Self, Failed> {
        if self.status.is_success() {
            return Ok(self);
        }
        let said = serde_json::from_slice::<Value>(&self.body)
            .ok()
            .and_then(|v| {
                let text = v.get("error")?.as_str()?;
                Some(text.chars().take(200).collect::<String>())
            });
        let message = match (said, self.status) {
            (Some(text), _) => Cow::Owned(text),
            (None, StatusCode::NOT_FOUND) => Cow::Borrowed("not found"),
            (None, _) => Cow::Borrowed("request failed"),
        };
        Err(Failed { message })
    }

    fn json<T: DeserializeOwned>(&self) -> Result<T, Failed> {
        serde_json::from_slice(&self.body).map_err(|_| "unexpected answer".into())
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name)?.to_str().ok()
    }
}

fn string<'a>(args: &'a Args, key: &str, missing: &'static str) -> Result<&'a str, Failed> {
    args.get(key).and_then(Value::as_str).ok_or(missing.into())
}

/// A txid or block hash: exactly 64 hex digits, lowercased.
fn hash(text: &str, wrong: &'static str) -> Result<String, Failed> {
    if text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(text.to_ascii_lowercase())
    } else {
        Err(wrong.into())
    }
}

fn network(mcp: &Mcp, args: &Args) -> Result<Network, Failed> {
    let Some(asked) = args.get("network").filter(|v| !v.is_null()) else {
        let first = mcp.networks.first().copied();
        return first.ok_or("no network is enabled on this server".into());
    };
    let found = mcp
        .networks
        .iter()
        .copied()
        .find(|n| Some(n.name()) == asked.as_str());
    found.ok_or_else(|| {
        let names: Vec<&str> = mcp.networks.iter().map(|n| n.name()).collect();
        Failed {
            message: format!("network must be one of: {}", names.join(", ")).into(),
        }
    })
}

/// A rate to three decimals, the node's own resolution.
fn rate(fee: u64, weight: u64) -> Option<f64> {
    (weight > 0).then(|| (fee as f64 * 4000.0 / weight as f64).round() / 1000.0)
}

async fn decode(from: &Asker<'_>, args: &Args) -> Result<Value, Failed> {
    let text = string(
        args,
        "string",
        "string is required: the payment string to decode",
    )?;
    let detail = args.get("detail").and_then(Value::as_bool).unwrap_or(false);
    let answer = from
        .ask(Method::POST, "/app/decode", Body::from(text.to_owned()))
        .await?
        .checked()?;
    let Value::Object(mut v) = answer.json()? else {
        return Err("unexpected answer".into());
    };
    // An invoice lasts `expiry` seconds from `created`; an offer says when it ends.
    let number = |key: &str| v.get(key).and_then(Value::as_u64);
    let expires = match (number("created"), number("expiry")) {
        (Some(created), Some(expiry)) => Some(created.saturating_add(expiry)),
        _ => number("expires"),
    };
    if let Some(at) = expires {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        v.insert("expires_at".into(), json!(at));
        v.insert("expired".into(), json!(now > at));
    }
    if !detail {
        for long in ["hints", "paths", "features"] {
            v.remove(long);
        }
    }
    v.insert(
        "untrusted_text".into(),
        json!(["description", "issuer", "payer_note", "alias", "url"]),
    );
    Ok(Value::Object(v))
}

async fn fees(from: &Asker<'_>, args: &Args) -> Result<Value, Failed> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fees {
        fastest_fee: f64,
        half_hour_fee: f64,
        hour_fee: f64,
        economy_fee: f64,
        minimum_fee: f64,
    }
    let net = network(from.mcp, args)?;
    let answer = from
        .get(&format!("{}/api/v1/fees/precise", net.path_prefix()))
        .await?
        .checked()?;
    let f: Fees = answer.json()?;
    Ok(json!({
        "network": net.name(),
        "unit": "sat/vB",
        "next_block": f.fastest_fee,
        "half_hour": f.half_hour_fee,
        "hour": f.hour_fee,
        "day": f.economy_fee,
        "minimum": f.minimum_fee,
        // `projected`: from this server's projected blocks. `node`: the node's own estimate.
        "source": answer.header("x-fee-source"),
    }))
}

async fn mempool(from: &Asker<'_>, args: &Args) -> Result<Value, Failed> {
    #[derive(Deserialize)]
    struct Totals {
        count: u64,
        vsize: u64,
        total_fee: u64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Projected {
        #[serde(rename = "blockVSize")]
        block_vsize: u64,
        n_tx: u64,
        total_fees: u64,
        median_fee: f64,
        #[serde(default)]
        fee_range: Vec<f64>,
    }
    let net = network(from.mcp, args)?;
    let prefix = net.path_prefix();
    let totals: Totals = from
        .get(&format!("{prefix}/api/mempool"))
        .await?
        .checked()?
        .json()?;
    // The projection needs the mempool engine, which an operator may leave off: then `null`.
    let projected = from
        .get(&format!("{prefix}/api/v1/fees/mempool-blocks"))
        .await?
        .checked()
        .and_then(|a| a.json::<Vec<Projected>>())
        .ok();
    let blocks = projected.map(|blocks| {
        blocks
            .iter()
            .map(|b| {
                json!({
                    "transactions": b.n_tx,
                    "vsize": b.block_vsize,
                    "total_fees": b.total_fees,
                    "median_fee_rate": b.median_fee,
                    "lowest_fee_rate": b.fee_range.first(),
                    "highest_fee_rate": b.fee_range.last(),
                })
            })
            .collect::<Vec<_>>()
    });
    Ok(json!({
        "network": net.name(),
        "transactions": totals.count,
        "vsize": totals.vsize,
        "total_fees": totals.total_fee,
        "projected_blocks": blocks,
    }))
}

async fn transaction(from: &Asker<'_>, args: &Args) -> Result<Value, Failed> {
    #[derive(Deserialize)]
    struct Tx {
        txid: String,
        version: Option<i64>,
        locktime: Option<u64>,
        size: u64,
        weight: u64,
        fee: Option<u64>,
        #[serde(default)]
        status: Status,
        #[serde(default)]
        vin: Vec<Input>,
        #[serde(default)]
        vout: Vec<Output>,
    }
    #[derive(Deserialize, Default)]
    struct Status {
        #[serde(default)]
        confirmed: bool,
        block_height: Option<u64>,
        block_hash: Option<String>,
        block_time: Option<u64>,
    }
    #[derive(Deserialize)]
    struct Input {
        #[serde(default)]
        is_coinbase: bool,
        prevout: Option<Output>,
    }
    #[derive(Deserialize)]
    struct Output {
        scriptpubkey_address: Option<String>,
        scriptpubkey_type: Option<String>,
        value: u64,
    }
    const BAD: &str = "txid is required: 64 hex digits";
    let net = network(from.mcp, args)?;
    let txid = hash(string(args, "txid", BAD)?, BAD)?;
    let answer = from
        .get(&format!("{}/api/tx/{txid}", net.path_prefix()))
        .await?
        .checked()?;
    let tx: Tx = answer.json()?;
    let output = |o: &Output| json!({ "address": o.scriptpubkey_address, "value": o.value, "type": o.scriptpubkey_type });
    let inputs: Vec<Value> = tx
        .vin
        .iter()
        .take(SHOWN)
        .map(|i| match &i.prevout {
            _ if i.is_coinbase => json!({ "coinbase": true }),
            Some(o) => output(o),
            None => json!({ "address": null, "value": null }),
        })
        .collect();
    // The node stamps its answer with its tip: how deep the transaction is.
    let tip = answer
        .header("x-bitcoin-chain-tip-height")
        .and_then(|h| h.parse::<u64>().ok());
    let confirmations = match (tip, tx.status.block_height, tx.status.confirmed) {
        (Some(tip), Some(height), true) if tip >= height => Some(tip - height + 1),
        (_, _, false) => Some(0),
        _ => None,
    };
    Ok(json!({
        "network": net.name(),
        "txid": tx.txid,
        "confirmed": tx.status.confirmed,
        "confirmations": confirmations,
        "block_height": tx.status.block_height,
        "block_hash": tx.status.block_hash,
        "block_time": tx.status.block_time,
        "fee": tx.fee,
        "fee_rate": tx.fee.and_then(|fee| rate(fee, tx.weight)),
        "size": tx.size,
        "weight": tx.weight,
        "vsize": tx.weight.div_ceil(4),
        "version": tx.version,
        "locktime": tx.locktime,
        "input_count": tx.vin.len(),
        "output_count": tx.vout.len(),
        "output_value": tx.vout.iter().fold(0u64, |sum, o| sum.saturating_add(o.value)),
        "inputs": inputs,
        "outputs": tx.vout.iter().take(SHOWN).map(output).collect::<Vec<_>>(),
    }))
}

async fn address(from: &Asker<'_>, args: &Args) -> Result<Value, Failed> {
    #[derive(Deserialize)]
    struct Totals {
        chain_stats: Stats,
        mempool_stats: Stats,
    }
    #[derive(Deserialize)]
    struct Stats {
        funded_txo_count: u64,
        funded_txo_sum: u64,
        spent_txo_count: u64,
        spent_txo_sum: u64,
        tx_count: u64,
    }
    #[derive(Deserialize)]
    struct Row {
        txid: String,
        value: i64,
        height: Option<u64>,
        time: Option<u64>,
    }
    const BAD: &str = "address is required: a Bitcoin address";
    let net = network(from.mcp, args)?;
    let text = string(args, "address", BAD)?;
    // Every address form is letters and digits; the route parses it for the network.
    if text.is_empty() || text.len() > 100 || !text.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(BAD.into());
    }
    let base = format!("{}/api/address/{text}", net.path_prefix());
    let totals: Totals = from.get(&base).await?.checked()?.json()?;
    // A very large address's history is refused or kept apart: then `null`, with the totals.
    let recent = from
        .get(&format!("{base}/txs/summary"))
        .await?
        .checked()
        .and_then(|a| a.json::<Vec<Row>>())
        .ok();
    let recent = recent.map(|rows| {
        rows.iter()
            .take(SHOWN)
            .map(
                |r| json!({ "txid": r.txid, "value": r.value, "height": r.height, "time": r.time }),
            )
            .collect::<Vec<_>>()
    });
    let (chain, pending) = (&totals.chain_stats, &totals.mempool_stats);
    // Saturating: the sums are the node's, and no sum of real coins comes near the edge.
    let sats = |n: u64| i64::try_from(n).unwrap_or(i64::MAX);
    let net_of = |s: &Stats| sats(s.funded_txo_sum).saturating_sub(sats(s.spent_txo_sum));
    Ok(json!({
        "network": net.name(),
        "address": text,
        "balance": net_of(chain),
        "received": chain.funded_txo_sum,
        "sent": chain.spent_txo_sum,
        "transactions": chain.tx_count,
        "unspent_outputs": chain.funded_txo_count.saturating_sub(chain.spent_txo_count),
        "unconfirmed": { "balance_change": net_of(pending), "transactions": pending.tx_count },
        "recent_transactions": recent,
    }))
}

async fn block(from: &Asker<'_>, args: &Args) -> Result<Value, Failed> {
    #[derive(Deserialize)]
    struct Block {
        id: String,
        height: u64,
        timestamp: u64,
        tx_count: u64,
        size: u64,
        weight: u64,
        difficulty: f64,
        previousblockhash: Option<String>,
        extras: Option<Extras>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Extras {
        reward: Option<u64>,
        total_fees: Option<u64>,
        median_fee: Option<f64>,
        #[serde(default)]
        fee_range: Option<Vec<f64>>,
        pool: Option<Pool>,
    }
    #[derive(Deserialize)]
    struct Pool {
        name: String,
    }
    const BAD_HASH: &str = "hash must be 64 hex digits";
    let net = network(from.mcp, args)?;
    let prefix = net.path_prefix();
    let text = |answer: Answer| {
        let said = String::from_utf8_lossy(&answer.body);
        hash(said.trim(), "unexpected answer")
    };
    // A model often sends `null` for an argument it leaves out.
    let given = |key: &str| args.get(key).filter(|v| !v.is_null());
    let id = match (given("hash"), given("height")) {
        (Some(Value::String(h)), _) => hash(h, BAD_HASH)?,
        (Some(_), _) => return Err(BAD_HASH.into()),
        (None, Some(height)) => {
            let Some(height) = height.as_u64().and_then(|h| u32::try_from(h).ok()) else {
                return Err("height must be a whole number".into());
            };
            let path = format!("{prefix}/api/block-height/{height}");
            text(from.get(&path).await?.checked()?)?
        }
        (None, None) => text(
            from.get(&format!("{prefix}/api/blocks/tip/hash"))
                .await?
                .checked()?,
        )?,
    };
    // The block with this server's own figures where it keeps them, else as the node has it.
    let kept = from
        .get(&format!("{prefix}/api/v1/block/{id}"))
        .await?
        .checked();
    let b: Block = match kept {
        Ok(answer) => answer.json()?,
        Err(_) => from
            .get(&format!("{prefix}/api/block/{id}"))
            .await?
            .checked()?
            .json()?,
    };
    let extras = b.extras.as_ref();
    let range = extras.and_then(|e| e.fee_range.as_ref());
    Ok(json!({
        "network": net.name(),
        "hash": b.id,
        "height": b.height,
        "time": b.timestamp,
        "transactions": b.tx_count,
        "size": b.size,
        "weight": b.weight,
        "difficulty": b.difficulty,
        "previous_hash": b.previousblockhash,
        "miner": extras.and_then(|e| e.pool.as_ref()).map(|p| &p.name),
        "reward": extras.and_then(|e| e.reward),
        "total_fees": extras.and_then(|e| e.total_fees),
        "median_fee_rate": extras.and_then(|e| e.median_fee),
        "lowest_fee_rate": range.and_then(|r| r.first()),
        "highest_fee_rate": range.and_then(|r| r.last()),
    }))
}

async fn difficulty(from: &Asker<'_>, args: &Args) -> Result<Value, Failed> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Adjustment {
        progress_percent: f64,
        difficulty_change: f64,
        estimated_retarget_date: u64,
        remaining_blocks: u64,
        previous_retarget: f64,
        next_retarget_height: u64,
        time_avg: u64,
    }
    let net = network(from.mcp, args)?;
    let a: Adjustment = from
        .get(&format!(
            "{}/api/v1/difficulty-adjustment",
            net.path_prefix()
        ))
        .await?
        .checked()?
        .json()?;
    Ok(json!({
        "network": net.name(),
        "progress_percent": a.progress_percent,
        "remaining_blocks": a.remaining_blocks,
        "next_adjustment_height": a.next_retarget_height,
        "expected_change_percent": a.difficulty_change,
        "expected_at": a.estimated_retarget_date / 1000,
        "previous_change_percent": a.previous_retarget,
        "average_block_seconds": a.time_avg as f64 / 1000.0,
    }))
}

async fn lightning_node(from: &Asker<'_>, args: &Args) -> Result<Value, Failed> {
    const BAD: &str =
        "node is required: a public key (66 hex digits) or 3 to 66 characters to search for";
    let net = network(from.mcp, args)?;
    let base = format!("{}/api/v1/lightning", net.path_prefix());
    let text = string(args, "node", BAD)?.trim();
    let untrusted = json!(["alias"]);
    if text.len() == 66 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
        let key = text.to_ascii_lowercase();
        let Value::Object(node) = from
            .get(&format!("{base}/nodes/{key}"))
            .await?
            .checked()?
            .json()?
        else {
            return Err("unexpected answer".into());
        };
        let mut kept = Map::new();
        kept.insert("network".into(), json!(net.name()));
        for field in [
            "public_key",
            "alias",
            "capacity",
            "active_channel_count",
            "opened_channel_count",
            "closed_channel_count",
            "first_seen",
            "updated_at",
            "sockets",
        ] {
            kept.insert(
                field.into(),
                node.get(field).cloned().unwrap_or(Value::Null),
            );
        }
        kept.insert("untrusted_text".into(), untrusted);
        return Ok(Value::Object(kept));
    }
    if !(3..=66).contains(&text.chars().count()) {
        return Err(BAD.into());
    }
    // Percent-encoded whole, so the text can only ever be the query's value.
    let mut query = String::with_capacity(text.len() * 3);
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() {
            query.push(char::from(b));
        } else {
            query.push_str(&format!("%{b:02X}"));
        }
    }
    let found: Value = from
        .get(&format!("{base}/search?searchText={query}"))
        .await?
        .checked()?
        .json()?;
    Ok(json!({
        "network": net.name(),
        "matches": found.get("nodes"),
        "untrusted_text": untrusted,
    }))
}
