//! The check's answer against what rbitcoin's Esplora says of the same public transaction
//! (`fixtures/esplora/mainnet/tx-segwit-opreturn.*`). The HTTP route is in `tests/tx_check.rs`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use bitcoin::hashes::Hash;
use bitcoin::{Amount, OutPoint, ScriptBuf, Sequence, TxIn, Witness};
use serde_json::json;

use super::*;

const RAW: &[u8] = include_bytes!("../../../../fixtures/esplora/mainnet/tx-segwit-opreturn.bin");
const ESPLORA: &str = include_str!("../../../../fixtures/esplora/mainnet/tx-segwit-opreturn.json");

fn found(p: &Value) -> Prevout {
    serde_json::from_value(p.clone()).unwrap()
}

#[test]
fn a_public_transaction_reads_as_esplora_writes_it() {
    let tx: Transaction = bitcoin::consensus::deserialize(RAW).unwrap();
    let esplora: Value = serde_json::from_str(ESPLORA).unwrap();
    let wanted = wanted(&tx);
    let prevouts = vec![Some(found(&esplora["vin"][0]["prevout"]))];
    let ours = serde_json::to_value(checked(
        &tx,
        bitcoin::Network::Bitcoin,
        &wanted,
        prevouts,
        None,
    ))
    .unwrap();
    let t = &ours["tx"];
    for field in [
        "txid", "version", "locktime", "vin", "vout", "size", "weight", "fee",
    ] {
        assert_eq!(t[field], esplora[field], "{field}");
    }
    assert_eq!(t["status"], json!({"confirmed": false}));
    assert_eq!(ours["known"], Value::Null);
}

#[test]
fn the_fee_is_left_out_unless_every_spent_output_is_known_and_covers_the_outputs() {
    let tx: Transaction = bitcoin::consensus::deserialize(RAW).unwrap();
    let esplora: Value = serde_json::from_str(ESPLORA).unwrap();
    let w = wanted(&tx);
    let fee = |prevouts| {
        let v = serde_json::to_value(checked(&tx, bitcoin::Network::Bitcoin, &w, prevouts, None))
            .unwrap();
        (
            v["tx"].get("fee").cloned(),
            v["tx"]["vin"][0].get("prevout").cloned(),
        )
    };
    // Not found: `null`, and no fee.
    assert_eq!(fee(vec![None]), (None, Some(Value::Null)));
    // Found but worth less than the outputs: no fee either.
    let mut small = esplora["vin"][0]["prevout"].clone();
    small["value"] = json!(10);
    assert_eq!(fee(vec![Some(found(&small))]).0, None);
    // Not looked up at all: no `prevout` key.
    assert_eq!(fee(vec![]), (None, None));
}

fn spend(n: u32) -> TxIn {
    TxIn {
        previous_output: OutPoint::new(Txid::from_byte_array([7; 32]), n),
        script_sig: ScriptBuf::new(),
        sequence: Sequence::MAX,
        witness: Witness::new(),
    }
}

#[test]
fn at_most_the_cap_of_distinct_outputs_is_looked_up_and_a_coinbase_none() {
    let mut tx = Transaction {
        version: bitcoin::transaction::Version::TWO,
        lock_time: bitcoin::absolute::LockTime::ZERO,
        input: (0..300).map(|n| spend(n % 150)).collect(),
        output: vec![],
    };
    let w = wanted(&tx);
    assert_eq!(w.len(), MAX_LOOKUPS);
    assert_eq!(w[0], (Txid::from_byte_array([7; 32]), 0));
    // The later inputs list no `prevout`, so the fee is unknown.
    let v = serde_json::to_value(checked(
        &tx,
        bitcoin::Network::Bitcoin,
        &w,
        w.iter().map(|_| None).collect(),
        None,
    ))
    .unwrap();
    assert_eq!(v["tx"]["vin"][0]["prevout"], Value::Null);
    assert!(v["tx"]["vin"][120].get("prevout").is_none());
    assert!(v["tx"].get("fee").is_none());

    tx.input = vec![TxIn {
        previous_output: OutPoint::null(),
        ..spend(0)
    }];
    assert!(tx.is_coinbase());
    assert!(wanted(&tx).is_empty());
}

#[test]
fn output_forms_carry_esplora_names_and_this_networks_addresses() {
    let script = |hex: &str| ScriptBuf::from_hex(hex).unwrap();
    let out = |hex: &str, chain| {
        output(
            &TxOut {
                value: Amount::from_sat(1),
                script_pubkey: script(hex),
            },
            chain,
        )
    };
    let key = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    for (hex, kind) in [
        (
            "76a914000000000000000000000000000000000000000088ac".to_owned(),
            "p2pkh",
        ),
        (
            "a914000000000000000000000000000000000000000087".to_owned(),
            "p2sh",
        ),
        (
            "00140000000000000000000000000000000000000000".to_owned(),
            "v0_p2wpkh",
        ),
        (format!("0020{}", "00".repeat(32)), "v0_p2wsh"),
        (format!("5120{}", "00".repeat(32)), "v1_p2tr"),
        ("6a0568656c6c6f".to_owned(), "op_return"),
        (format!("21{key}ac"), "p2pk"),
        (format!("5121{key}51ae"), "multisig"),
        ("51024e73".to_owned(), "unknown"),
    ] {
        assert_eq!(
            out(&hex, bitcoin::Network::Bitcoin).scriptpubkey_type,
            kind,
            "{hex}"
        );
    }
    let p2wpkh = "00140000000000000000000000000000000000000000";
    assert!(
        out(p2wpkh, bitcoin::Network::Regtest)
            .scriptpubkey_address
            .unwrap()
            .starts_with("bcrt1q")
    );
    assert!(
        out(p2wpkh, bitcoin::Network::Signet)
            .scriptpubkey_address
            .unwrap()
            .starts_with("tb1q")
    );
    assert_eq!(
        out("6a00", bitcoin::Network::Bitcoin).scriptpubkey_address,
        None
    );
}
