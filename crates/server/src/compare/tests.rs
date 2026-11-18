//! The compare route against the real tracker on the mock node of `ws/track/tests.rs`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use axum::extract::{Path, State};
use bitcoin::OutPoint;
use serde_json::{Value, json};

use super::*;
use crate::ws::track::tests::{Mock, Server, coin};

async fn compare(s: &Server, a: &str, b: &str) -> (u16, Value) {
    let r = route(
        State(Arc::clone(&s.ctx)),
        Path((a.to_owned(), b.to_owned())),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response);
    let status = r.status().as_u16();
    let bytes = axum::body::to_bytes(r.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// The mock's outputs: empty scripts paying 1,000 sats, 1,001, and so on.
fn kept(n: u64) -> Value {
    json!({
        "state": "kept",
        "list": (0..n)
            .map(|i| json!({ "value": 1000 + i, "script": "", "address": null }))
            .collect::<Vec<_>>(),
    })
}

#[tokio::test]
async fn neighbours_and_any_two_versions_are_compared_from_memory() {
    let mock = Mock::new();
    let a = mock.send(&[coin(1), coin(2)], 1, 500, 200);
    let child = mock.send(&[OutPoint::new(a, 0)], 1, 300, 100);
    let s = Server::start(&mock, |_| {});
    s.settle().await;
    // B drops one of A's inputs and adds an output; C adds an input.
    let b = mock.send(&[coin(1)], 2, 1000, 250);
    s.settle().await;
    let c = mock.send(&[coin(1), coin(3)], 3, 2000, 300);
    s.settle().await;
    let (a, b, c, child) = (
        a.to_string(),
        b.to_string(),
        c.to_string(),
        child.to_string(),
    );

    let (status, body) = compare(&s, &a, &b).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["a"]["txid"], a);
    assert_eq!(
        (&body["a"]["fee"], &body["a"]["vsize"], &body["a"]["rate"]),
        (&json!(500), &json!(200), &json!(2500))
    );
    assert_eq!(
        (&body["a"]["inputs"], &body["b"]["inputs"]),
        (&json!(2), &json!(1))
    );
    assert_eq!(body["a"]["outputs"], kept(1));
    assert_eq!(body["b"]["outputs"], kept(2));
    assert_eq!(body["a"]["value"], 1000);
    assert_eq!(body["shared_inputs"], 1);
    assert_eq!(body["a"]["from"], "record");
    // Either way round.
    assert_eq!(compare(&s, &b, &a).await.1["shared_inputs"], 1);
    // The newest version is still waiting; the record kept it as B's replacement.
    let (_, body) = compare(&s, &b, &c).await;
    assert_eq!(
        (&body["a"]["txid"], &body["b"]["txid"]),
        (&json!(b), &json!(c))
    );
    assert_eq!(
        (&body["a"]["outputs"], &body["b"]["outputs"]),
        (&kept(2), &kept(3))
    );
    assert_eq!(
        (&body["b"]["inputs"], &body["shared_inputs"]),
        (&json!(2), &json!(1))
    );
    // Any two in one history; not neighbours, so no shared inputs.
    let (status, body) = compare(&s, &a, &c).await;
    assert_eq!(status, 200);
    assert_eq!(
        (&body["b"]["outputs"], &body["shared_inputs"]),
        (&kept(3), &Value::Null)
    );
    // A child that left with its parent shares nothing with the replacement, and its outputs
    // are not kept: it is not an earlier version.
    // The replacements route says the same per link.
    let r = crate::replacements::route(State(Arc::clone(&s.ctx)), Path(b.clone()))
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(r.into_body(), usize::MAX)
        .await
        .unwrap();
    let links: Value = serde_json::from_slice(&bytes).unwrap();
    let shared_of = |t: &str| {
        links["replaces"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["txid"] == t)
            .unwrap()["shared_inputs"]
            .clone()
    };
    assert_eq!((shared_of(&a), shared_of(&child)), (json!(1), json!(0)));
    // It is no version of either, whichever way round.
    for (x, y) in [(&child, &b), (&b, &child), (&child, &c), (&a, &child)] {
        assert_eq!(compare(&s, x, y).await.0, 404, "{x} {y}");
    }
    assert_eq!(links["versions"], json!([a, b, c]));
}

#[tokio::test]
async fn what_is_not_two_versions_is_refused() {
    let mock = Mock::new();
    let a = mock.send(&[coin(1)], 1, 500, 200);
    let other = mock.send(&[coin(5)], 1, 500, 200);
    let s = Server::start(&mock, |_| {});
    s.settle().await;
    let b = mock.send(&[coin(1)], 1, 900, 200);
    s.settle().await;
    let (a, b, other) = (a.to_string(), b.to_string(), other.to_string());
    let unknown = "11".repeat(32);
    for (x, y, want) in [
        (a.as_str(), other.as_str(), 404),
        (unknown.as_str(), "22".repeat(32).as_str(), 404),
        (b.as_str(), b.as_str(), 400),
        ("zz", b.as_str(), 400),
        (a.as_str(), &"a".repeat(65), 400),
    ] {
        assert_eq!(compare(&s, x, y).await.0, want, "{x} {y}");
    }
    assert_eq!(compare(&s, &a, &b).await.0, 200);
}

#[tokio::test]
async fn a_replacement_never_held_is_asked_of_the_node_and_reads_unrecorded_without_it() {
    let mock = Mock::new();
    let a = mock.send(&[coin(1)], 2, 500, 200);
    let s = Server::start(&mock, |_| {});
    s.settle().await;
    // A miner confirms a conflicting B we never saw in the mempool. The test's Esplora is not
    // there, so the one read fails and the version says so.
    let b = mock.send(&[coin(1)], 1, 900, 200);
    mock.evict(b);
    mock.mine_replaced(&[b]);
    s.settle().await;
    let (status, body) = compare(&s, &a.to_string(), &b.to_string()).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["a"]["outputs"], kept(2));
    assert_eq!(body["b"]["outputs"], json!({ "state": "not_recorded" }));
    assert_eq!(
        (&body["b"]["fee"], &body["b"]["from"]),
        (&Value::Null, &json!("none"))
    );
}

#[test]
fn outputs_name_their_address_and_long_scripts_only_their_hash() {
    use bitcoin::{Amount, TxOut};
    let p2wpkh = [&[0x00, 0x14][..], &[7; 20]].concat();
    let outs = Outputs::of(&[
        TxOut {
            value: Amount::from_sat(5000),
            script_pubkey: ScriptBuf::from_bytes(p2wpkh.clone()),
        },
        TxOut {
            value: Amount::ZERO,
            script_pubkey: ScriptBuf::from_bytes(vec![0x6a; 60]),
        },
    ]);
    let v = outputs_json(Some(&outs), bitcoin::Network::Regtest);
    let address: bitcoin::Address<bitcoin::address::NetworkUnchecked> =
        v["list"][0]["address"].as_str().unwrap().parse().unwrap();
    let address = address.require_network(bitcoin::Network::Regtest).unwrap();
    assert_eq!(address.script_pubkey().as_bytes(), &p2wpkh[..]);
    assert!(v["list"][1].get("address").is_none());
    assert_eq!(v["list"][1]["script_len"], 60);
    assert_eq!(
        outputs_json(None, bitcoin::Network::Regtest),
        json!({ "state": "not_recorded" })
    );
}

type Txs = Arc<std::sync::Mutex<Vec<(String, Value)>>>;

/// An Esplora that answers `/tx/:txid` from `txs`, slowly, and counts what it was asked.
async fn stub() -> (String, Txs, Arc<std::sync::atomic::AtomicUsize>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let hits = Arc::new(AtomicUsize::new(0));
    let txs: Txs = Arc::default();
    let (counted, held) = (Arc::clone(&hits), Arc::clone(&txs));
    let app = axum::Router::new().route(
        "/tx/{txid}",
        axum::routing::get(move |Path(t): Path<String>| {
            let (hits, txs) = (Arc::clone(&counted), Arc::clone(&held));
            async move {
                hits.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                let found = txs.lock().unwrap().iter().find(|(id, _)| *id == t).cloned();
                match found {
                    Some((_, v)) => Json(v).into_response(),
                    None => (StatusCode::NOT_FOUND, "Transaction not found").into_response(),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (url, txs, hits)
}

/// Esplora's answer for a transaction whose outputs pay 1,000 sats each to `scripts`.
fn esplora_tx(txid: &str, weight: u64, fee: u64, scripts: &[&str], pruned: bool) -> Value {
    json!({
        "txid": txid, "version": 2, "locktime": 0, "size": weight / 4, "weight": weight,
        "fee": fee, "vin": [], "pruned": pruned,
        "status": { "confirmed": true, "block_height": 2 },
        "vout": scripts.iter().map(|s| json!({
            "scriptpubkey": s, "scriptpubkey_asm": "", "scriptpubkey_type": "unknown", "value": 1000,
        })).collect::<Vec<_>>(),
    })
}

/// [`compare`] on a context of its own, so several can run at once.
async fn compare_on(ctx: Arc<NetworkContext>, a: String, b: String) -> (u16, Value) {
    let r = route(State(ctx), Path((a, b)))
        .await
        .unwrap_or_else(IntoResponse::into_response);
    let status = r.status().as_u16();
    let bytes = axum::body::to_bytes(r.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replacement_mined_straight_from_a_block_is_read_once_and_its_children_are_no_versions() {
    use std::sync::atomic::Ordering;
    let (url, txs, hits) = stub().await;
    let mock = Mock::new();
    let a = mock.send(&[coin(1)], 2, 500, 200);
    let child = mock.send(&[OutPoint::new(a, 0)], 1, 300, 100);
    let s = Server::on(
        crate::ws::track::tests::context_at("127.0.0.1:1", &url, true, |_| {}),
        &mock,
    );
    s.settle().await;
    // A miner confirms B, which conflicts with A and which we never saw waiting.
    let b = mock.send(&[coin(1)], 1, 900, 200);
    mock.evict(b);
    mock.mine_replaced(&[b]);
    s.settle().await;
    let p2wpkh = format!("0014{}", "07".repeat(20));
    txs.lock().unwrap().push((
        b.to_string(),
        esplora_tx(&b.to_string(), 804, 900, &[&p2wpkh], true),
    ));
    let (a, b, child) = (a.to_string(), b.to_string(), child.to_string());

    // Eight at once ask the node once.
    let asks: Vec<_> = (0..8)
        .map(|_| tokio::spawn(compare_on(Arc::clone(&s.ctx), a.clone(), b.clone())))
        .collect();
    let mut answers = Vec::new();
    for h in asks {
        answers.push(h.await.unwrap());
    }
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    let (status, body) = &answers[0];
    assert_eq!(*status, 200, "{body}");
    assert_eq!(body["b"]["from"], "node");
    assert_eq!(body["b"]["outputs"]["list"][0]["script"], p2wpkh);
    // A pruned reply lists only some inputs: its count is unknown, not 0.
    assert_eq!(body["b"]["inputs"], Value::Null);
    // One size basis: the node's is weight over four, so A's figure is put on it too.
    assert_eq!(body["vsize_basis"], "weight");
    assert_eq!(
        (&body["a"]["vsize"], &body["b"]["vsize"]),
        (&json!(200), &json!(201))
    );
    // The block's own spends tell the conflict from the child that left with it.
    assert_eq!(body["shared_inputs"], 1);
    assert_eq!(compare(&s, &child, &b).await.0, 404);
    assert_eq!(compare(&s, &b, &child).await.0, 404);
}

#[tokio::test]
async fn a_bumped_child_stays_a_version_of_what_it_bumped_and_of_nothing_past_its_parent() {
    let mock = Mock::new();
    // P, and A spending from it; then B bumps A.
    let p = mock.send(&[coin(1)], 1, 500, 200);
    let s = Server::start(&mock, |_| {});
    s.settle().await;
    let a = mock.send(&[OutPoint::new(p, 0)], 2, 300, 100);
    s.settle().await;
    let b = mock.send(&[OutPoint::new(p, 0)], 1, 900, 100);
    s.settle().await;
    // Then Q replaces P, and B leaves with it.
    let q = mock.send(&[coin(1)], 1, 2000, 200);
    s.settle().await;
    let (p, a, b, q) = (p.to_string(), a.to_string(), b.to_string(), q.to_string());
    // A and B are versions, whichever way round, with the inputs they share.
    for (x, y) in [(&a, &b), (&b, &a)] {
        let (status, body) = compare(&s, x, y).await;
        assert_eq!(
            (status, &body["shared_inputs"]),
            (200, &json!(1)),
            "{x} {y}"
        );
    }
    // Nothing joins A or B to Q but B's link as a child.
    for (x, y) in [(&a, &q), (&q, &a), (&b, &q), (&q, &b), (&a, &p), (&p, &b)] {
        assert_eq!(compare(&s, x, y).await.0, 404, "{x} {y}");
    }
    assert_eq!(compare(&s, &p, &q).await.0, 200);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_node_is_asked_for_the_newest_version_and_never_for_a_replaced_one() {
    use crate::replacements::{Link, Mined};
    use bitcoin::hashes::Hash;
    use std::sync::atomic::Ordering;
    let id = |n: u8| Txid::from_byte_array([n; 32]);
    let (url, txs, hits) = stub().await;
    // Forty outputs whose scripts are not even hex: counted, never read.
    let many = vec!["zz"; 40];
    txs.lock().unwrap().extend([
        (
            id(2).to_string(),
            esplora_tx(&id(2).to_string(), 800, 900, &["00"], false),
        ),
        (
            id(4).to_string(),
            esplora_tx(&id(4).to_string(), 800, 900, &many, false),
        ),
    ]);
    let s = Server::on(
        crate::ws::track::tests::context_at("127.0.0.1:1", &url, true, |_| {}),
        &Mock::new(),
    );
    s.settle().await;
    let facts = Facts {
        fee: 500,
        vsize: 200,
        weight: 800,
        value: 1000,
        time: 1,
        rbf: true,
    };
    let link = |a: u8, b: u8, by_tx: Option<Facts>| Link {
        txid: id(a),
        by: id(b),
        seen: 1,
        tx: facts,
        by_tx,
        mined: Mined::No,
    };
    // A link stored before outputs were kept: both sides were held, neither has outputs, and
    // the newest (2) has since confirmed. The node still has 2; it forgot 1, which was replaced.
    s.ctx
        .track
        .restore_replacements(vec![link(1, 2, Some(facts)), link(3, 4, None)]);
    for (x, y) in [(1, 2), (2, 1)] {
        let (status, body) = compare(&s, &id(x).to_string(), &id(y).to_string()).await;
        assert_eq!(status, 200);
        let (old, new) = if x == 1 { ("a", "b") } else { ("b", "a") };
        assert_eq!(body[old]["outputs"], json!({ "state": "not_recorded" }));
        assert_eq!(body[new]["outputs"]["list"][0]["script"], "00");
        // The record's figures stand: the node's are only for what the record lacks.
        assert_eq!(body[new]["from"], "record");
    }
    assert_eq!(
        hits.load(Ordering::SeqCst),
        2,
        "2 each time; 1, replaced, never"
    );
    // A replacement never held is asked, and its outputs are counted before any is read.
    let (_, body) = compare(&s, &id(3).to_string(), &id(4).to_string()).await;
    assert_eq!(hits.load(Ordering::SeqCst), 3);
    assert_eq!(
        body["b"]["outputs"],
        json!({ "state": "too_many", "count": 40 })
    );
}
