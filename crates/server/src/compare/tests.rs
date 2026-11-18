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
    let (status, body) = compare(&s, &child, &b).await;
    assert_eq!(status, 200);
    assert_eq!(body["shared_inputs"], 0);
    assert_eq!(body["a"]["outputs"], json!({ "state": "not_recorded" }));
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
