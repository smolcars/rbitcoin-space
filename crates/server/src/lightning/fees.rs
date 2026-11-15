//! Fee history (`docs/LIGHTNING.md`, "Fee history"): after every index build, each direction
//! whose fees differ from the newest record kept is stored, in one write off the request path;
//! and the two routes that read it, a channel's records and a node's newest changes.

use std::sync::atomic::Ordering;
use std::sync::{Arc, PoisonError};
use std::time::Instant;

use axum::Router;
use axum::extract::{Path as UrlPath, RawQuery, State};
use axum::routing::get;
use engine::lightning::fees::{self, FeeRecord};
use engine::lightning::{self as store_ln, Index};
use engine::store::Store;
use serde_json::{Value, json};

use super::nodes::{
    Answer, NO_CHANNEL, NO_NODE, graph, inbound_json, number, pubkey, query, scid, send,
};
use super::{Lightning, hex, scid_text, store_error};
use crate::NetworkContext;
use crate::error::ApiError;

/// Records stored per write: a first round stores every direction's starting point (about
/// 72,000 on mainnet), in writes the writer gets through in a few tens of milliseconds each.
const BATCH: usize = 2_000;
/// A node's newest changes: how many by default, and at most.
const CHANGES: usize = 10;
const MAX_CHANGES: u64 = 50;

/// One round, after an index build: loads the kept heads once per run, compares the newest
/// index with them, stores what differs and forgets channels the index no longer holds. A
/// failed read or write is tried again at the next round: the table decides what is a change,
/// so a round repeated stores nothing twice. `run` is when this run's watching began.
pub(crate) async fn round(l: &Arc<Lightning>, store: &Store, run: &mut Option<u64>) {
    let Some(index) = l.index() else { return };
    if run.is_none() {
        match fees::heads(store).await {
            Ok(h) => *l.fees.write().unwrap_or_else(PoisonError::into_inner) = h,
            Err(_) => {
                l.fee_failures.fetch_add(1, Ordering::Relaxed);
                return;
            }
        }
        *run = Some(store_ln::unix_now());
    }
    let Some(start) = *run else { return };
    let records = {
        let (l, index) = (Arc::clone(l), Arc::clone(&index));
        tokio::task::spawn_blocking(move || {
            // Requests read the heads meanwhile; only the forgetting below holds them.
            let heads = l.fees.read().unwrap_or_else(PoisonError::into_inner);
            let taken = (heads.epoch(), heads.diff(index.channels()));
            drop(heads);
            l.fees
                .write()
                .unwrap_or_else(PoisonError::into_inner)
                .retain(|scid| index.channel(scid).is_some());
            taken
        })
        .await
        .unwrap_or_default()
    };
    let (epoch, records) = records;
    let started = Instant::now();
    // At least one write a round, so the run's end moves with it.
    for chunk in records
        .chunks(BATCH)
        .chain(records.is_empty().then_some(&[][..]))
    {
        match fees::record(store, chunk.to_vec(), start, store_ln::unix_now()).await {
            Ok(outcomes) => {
                let stored = outcomes
                    .iter()
                    .filter(|o| matches!(o, fees::Outcome::Stored { .. }))
                    .count();
                l.fee_records.fetch_add(stored as u64, Ordering::Relaxed);
                l.fees
                    .write()
                    .unwrap_or_else(PoisonError::into_inner)
                    .apply(epoch, chunk, &outcomes);
            }
            Err(_) => {
                l.fee_failures.fetch_add(1, Ordering::Relaxed);
                break;
            }
        }
    }
    l.fee_write_us.store(
        started.elapsed().as_micros().try_into().unwrap_or(u64::MAX),
        Ordering::Relaxed,
    );
}

pub fn routes() -> Router<Arc<NetworkContext>> {
    Router::new()
        .route("/app/lightning/channels/{id}/fees", get(app_channel_fees))
        .route("/app/lightning/nodes/{key}/fees", get(app_node_fees))
}

fn fees_json(r: &FeeRecord) -> Value {
    json!({
        "fee_rate": r.fees.fee_rate,
        "base_fee_msat": r.fees.base_fee_msat,
        "inbound_fee": inbound_json(r.fees.inbound),
    })
}

fn record_json(r: &FeeRecord) -> Value {
    let mut v = fees_json(r);
    if let Some(o) = v.as_object_mut() {
        o.insert("time".into(), r.time.into());
    }
    v
}

fn side_json(records: &[FeeRecord]) -> Value {
    json!({
        "from": records.first().map(|r| r.time),
        "records": records.iter().map(record_json).collect::<Vec<_>>(),
    })
}

/// `GET /app/lightning/channels/:id/fees`: both ends' kept records, oldest first, when each
/// starts, and the stretches the server watched since the oldest. A channel the index does not
/// hold open has nothing kept; one never held is `404`.
async fn app_channel_fees(
    State(ctx): State<Arc<NetworkContext>>,
    UrlPath(id): UrlPath<String>,
    RawQuery(raw): RawQuery,
) -> Answer {
    let scid = scid(&id)?;
    query(raw.as_deref(), &[], true)?;
    let (index, _, store) = graph(&ctx)?;
    let ([one, two], runs) = if index.channel(scid).is_some() {
        fees::history(store, scid)
            .await
            .map_err(|e| store_error(&e))?
    } else {
        store_ln::channel(store, scid)
            .await
            .map_err(|e| store_error(&e))?
            .ok_or(NO_CHANNEL)?;
        Default::default()
    };
    let v = json!({
        "id": scid_text(scid),
        "scid": scid.to_string(),
        "node_one": side_json(&one),
        "node_two": side_json(&two),
        "watched": runs.iter().map(|(from, to)| json!({ "from": from, "to": to })).collect::<Vec<_>>(),
    });
    Ok(send(&v, "lightning_channel_fees"))
}

/// A direction with a change, as a node's newest changes are found: when, which, whose.
struct Moved<'a> {
    time: u32,
    scid: u64,
    side: u8,
    own: bool,
    peer: [u8; 33],
    alias: Option<&'a str>,
}

/// The node's open channels' directions whose newest record is a change, newest first: the
/// newest `limit` changes are all in the first `limit` of them. From memory.
fn moved<'a>(l: &Lightning, index: &'a Index, node: &'a store_ln::Node) -> Vec<Moved<'a>> {
    let heads = l.fees.read().unwrap_or_else(PoisonError::into_inner);
    let mut out = Vec::new();
    for link in index.links(node) {
        let c = link.channel;
        let me = c.side(&node.id);
        for side in 0..2u8 {
            let Some(time) = heads.changed(c.scid, side) else {
                continue;
            };
            let other = usize::from(me != Some(1));
            out.push(Moved {
                time,
                scid: c.scid,
                side,
                own: me == Some(usize::from(side)),
                peer: c.nodes.get(other).copied().unwrap_or([0; 33]),
                alias: link.peer.and_then(store_ln::Node::alias),
            });
        }
    }
    out.sort_unstable_by(|a, b| (b.time, a.scid, a.side).cmp(&(a.time, b.scid, b.side)));
    out
}

/// `GET /app/lightning/nodes/:key/fees?limit=`: the newest fee changes on the node's open
/// channels, either end's, newest first. A direction's first record has nothing before it and is
/// not a change.
async fn app_node_fees(
    State(ctx): State<Arc<NetworkContext>>,
    UrlPath(key): UrlPath<String>,
    RawQuery(raw): RawQuery,
) -> Answer {
    const BAD_LIMIT: ApiError = ApiError::bad_request("limit is 1 to 50");
    let id = pubkey(&key)?;
    let q = query(raw.as_deref(), &["limit"], true)?;
    let limit = match q.get("limit") {
        None => CHANGES,
        Some(s) => number(s, MAX_CHANGES)
            .filter(|n| *n >= 1)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or(BAD_LIMIT)?,
    };
    let (index, l, store) = graph(&ctx)?;
    let node = index.node(&id).ok_or(NO_NODE)?;
    let mut dirs = moved(l, &index, node);
    dirs.truncate(limit);
    let wanted = dirs.iter().map(|d| (d.scid, d.side)).collect();
    let records = fees::newest(store, wanted, limit)
        .await
        .map_err(|e| store_error(&e))?;
    let mut changes: Vec<(&Moved<'_>, &FeeRecord, &FeeRecord)> = dirs
        .iter()
        .zip(&records)
        .flat_map(|(d, r)| {
            r.windows(2)
                .filter_map(move |w| Some((d, w.first()?, w.get(1)?)))
        })
        .collect();
    changes.sort_unstable_by(|(a, x, _), (b, y, _)| {
        (y.time, a.scid, a.side).cmp(&(x.time, b.scid, b.side))
    });
    changes.truncate(limit);
    let v = json!({
        "changes": changes.iter().map(|(d, after, before)| json!({
            "id": scid_text(d.scid),
            "scid": d.scid.to_string(),
            "peer": { "id": hex(&d.peer), "alias": d.alias },
            "whose": if d.own { "own" } else { "peer" },
            "time": after.time,
            "before": fees_json(before),
            "after": fees_json(after),
        })).collect::<Vec<_>>(),
    });
    Ok(send(&v, "lightning_node_fees"))
}
