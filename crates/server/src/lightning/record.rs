//! A node's close record (`docs/API.md`, "A node's close record"): how its channels this server
//! watched ended, by kind, by week and by peer, with their closing fees, beside the network's. The
//! node's part is one indexed read of at most its newest [`MAX_CLOSES`] closes per request; the
//! network's is worked out with the overview, every ten minutes, and read from memory, so the two
//! are not of one moment.

use std::collections::HashMap;
use std::sync::{Arc, PoisonError};

use axum::Router;
use axum::extract::{Path as UrlPath, State};
use axum::routing::get;
use engine::lightning::record::{self, MAX_CLOSES, MINIMUM, NodeRecord, Peer, Record, Tally};
use engine::lightning::{self as store_ln, Index, Node};
use serde_json::{Value, json};

use super::nodes::{Answer, NO_NODE, graph, pubkey, send};
use super::{hex, store_error};
use crate::NetworkContext;

/// Peers listed with a force close or a penalty, most first; the rest are counted.
pub(crate) const PEERS: usize = 50;

const KINDS: [&str; 4] = ["cooperative", "force", "penalty", "other"];

pub fn routes() -> Router<Arc<NetworkContext>> {
    Router::new().route("/app/lightning/nodes/{key}/closes", get(app_node_closes))
}

fn by_kind<T: Copy + Into<Value>>(v: [T; 4]) -> Value {
    Value::Object(
        KINDS
            .iter()
            .zip(v)
            .map(|(k, n)| ((*k).into(), n.into()))
            .collect(),
    )
}

fn shares_json(closes: &[u32; 4]) -> Value {
    record::shares(closes).map_or(Value::Null, by_kind)
}

fn tally_json(t: &Tally) -> Value {
    let mut v = by_kind(t.closes);
    if let Some(o) = v.as_object_mut() {
        o.insert("closed".into(), t.total().into());
        o.insert("shares".into(), shares_json(&t.closes));
        let fees = KINDS
            .iter()
            .zip(t.fees.iter().zip(t.known))
            .map(|(k, (sum, known))| ((*k).into(), json!({ "sum": sum, "known": known })));
        o.insert("fees".into(), Value::Object(fees.collect()));
    }
    v
}

pub(crate) fn record_json(r: &Record) -> Value {
    let mut v = tally_json(&r.total);
    if let Some(o) = v.as_object_mut() {
        let weeks = r.weeks.iter().map(|w| {
            let mut v = by_kind(w.closes);
            if let Some(o) = v.as_object_mut() {
                o.insert("time".into(), w.time.into());
            }
            v
        });
        o.insert("weeks".into(), weeks.collect::<Vec<_>>().into());
    }
    v
}

/// The node's open channels with each peer, by the index.
fn open_with(index: &Index, n: Option<&Node>) -> HashMap<[u8; 33], u32> {
    let mut out = HashMap::new();
    for c in n.into_iter().flat_map(|n| index.channels_of(n)) {
        for peer in c.nodes {
            if n.is_some_and(|n| n.id != peer) {
                *out.entry(peer).or_default() += 1;
            }
        }
    }
    out
}

fn peer_json(index: &Index, p: &Peer, open: &HashMap<[u8; 33], u32>) -> Value {
    let mut v = by_kind(p.closes);
    if let Some(o) = v.as_object_mut() {
        o.insert("id".into(), hex(&p.id).into());
        o.insert(
            "alias".into(),
            index.node(&p.id).and_then(Node::alias).into(),
        );
        o.insert("closed".into(), p.total().into());
        o.insert("shares".into(), shares_json(&p.closes));
        o.insert("open".into(), open.get(&p.id).copied().unwrap_or(0).into());
        o.insert("held".into(), index.node(&p.id).is_some().into());
    }
    v
}

fn peers_json(index: &Index, node: Option<&Node>, r: &NodeRecord) -> Value {
    let forced: Vec<&Peer> = r.peers.iter().filter(|p| p.forced() > 0).collect();
    let open = open_with(index, node);
    json!({
        "count": r.peers.len(),
        "forced": forced.len(),
        "list": forced.iter().take(PEERS).map(|p| peer_json(index, p, &open)).collect::<Vec<_>>(),
        "more": forced.len().saturating_sub(PEERS),
    })
}

/// `GET /app/lightning/nodes/:key/closes`: the node's record from its newest [`MAX_CLOSES`]
/// stored closes, which any node with a stored close has, held in the graph or not; the
/// network's from memory, as of the overview's last computation (its `time`), `null` until the
/// first.
async fn app_node_closes(
    State(ctx): State<Arc<NetworkContext>>,
    UrlPath(key): UrlPath<String>,
) -> Answer {
    let id = pubkey(&key)?;
    let (index, l, store) = graph(&ctx)?;
    let (rows, capped) = store_ln::node_close_rows(store, id, MAX_CLOSES)
        .await
        .map_err(|e| store_error(&e))?;
    let held = index.node(&id);
    if held.is_none() && rows.is_empty() {
        return Err(NO_NODE);
    }
    let network = l
        .overview
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let now = store_ln::unix_now();
    let oldest = rows.iter().map(|r| r.time).min();
    // From when the record runs: its oldest close read when it holds only the newest; otherwise
    // when our history starts, or the oldest close stored if older.
    let from = if capped {
        oldest
    } else {
        [
            index.start,
            network.as_ref().and_then(|o| o.record_from),
            oldest,
        ]
        .into_iter()
        .flatten()
        .min()
    };
    let mine = record::node(&id, &rows, from.unwrap_or(now), now);
    let network = network.map(|o| {
        let mut v = record_json(&o.network);
        if let Some(m) = v.as_object_mut() {
            m.insert("time".into(), o.time.into());
        }
        v
    });
    let v = json!({
        "id": hex(&id),
        "from": from,
        "time": now,
        "minimum": MINIMUM,
        "cap": MAX_CLOSES,
        "capped": capped,
        "node": record_json(&mine.record),
        "peers": peers_json(&index, held, &mine),
        "network": network,
    });
    Ok(send(&v, "lightning_node_closes"))
}
