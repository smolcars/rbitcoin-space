#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use bitcoin::absolute::LockTime;
use bitcoin::consensus::encode::deserialize_hex;
use bitcoin::hashes::Hash;
use bitcoin::transaction::Version;
use bitcoin::{Amount, OutPoint, ScriptBuf, Sequence, TxOut, Txid, Witness};
use serde::Deserialize;

use super::*;

#[derive(Deserialize)]
struct Recorded {
    txid: String,
    index: u32,
    flags: u64,
    hex: String,
}

/// `fixtures/flags/mainnet.json`: the reference's answer for 68 mainnet transactions.
#[test]
fn recorded_mainnet_transactions_match_the_reference_on_every_known_bit() {
    let recorded: Vec<Recorded> =
        serde_json::from_str(include_str!("../../../../fixtures/flags/mainnet.json")).unwrap();
    assert_eq!(recorded.len(), 68);
    let mut wrong = Vec::new();
    for r in &recorded {
        let tx: Transaction = deserialize_hex(&r.hex).unwrap();
        assert_eq!(tx.compute_txid().to_string(), r.txid);
        assert_eq!(tx.is_coinbase(), r.index == 0, "{}", r.txid);
        let (ours, theirs) = (of(&tx), r.flags & KNOWN);
        assert_eq!(ours & !KNOWN, 0);
        if ours != theirs {
            wrong.push(format!(
                "{} extra {:#x} missing {:#x}",
                r.txid,
                ours & !theirs,
                theirs & !ours
            ));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// A 9-byte DER signature whose sighash type is `kind`.
fn der(kind: u8) -> Vec<u8> {
    vec![0x30, 6, 0x02, 1, 1, 0x02, 1, 1, kind]
}

const KEY: [u8; 33] = [
    0x02, 0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95, 0xce, 0x87, 0x0b,
    0x07, 0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59, 0xf2, 0x81, 0x5b, 0x16, 0xf8, 0x17,
    0x98,
];

fn push(items: &[&[u8]]) -> ScriptBuf {
    let mut b = bitcoin::script::Builder::new();
    for i in items {
        b = b.push_slice(<&bitcoin::script::PushBytes>::try_from(*i).unwrap());
    }
    b.into_script()
}

fn input(script_sig: ScriptBuf, witness: &[&[u8]]) -> TxIn {
    TxIn {
        previous_output: OutPoint::new(Txid::from_byte_array([1; 32]), 0),
        script_sig,
        sequence: Sequence::MAX,
        witness: Witness::from_slice(witness),
    }
}

fn tx(version: i32, input: Vec<TxIn>, outputs: Vec<ScriptBuf>) -> Transaction {
    Transaction {
        version: Version(version),
        lock_time: LockTime::ZERO,
        input,
        output: outputs
            .into_iter()
            .map(|script_pubkey| TxOut {
                value: Amount::from_sat(1000),
                script_pubkey,
            })
            .collect(),
    }
}

/// The flags of a version 2, one-output transaction with these inputs, without the version,
/// RBF and output bits.
fn spent(inputs: Vec<TxIn>) -> u64 {
    of(&tx(2, inputs, vec![ScriptBuf::new()])) & !(V2 | NO_RBF | BATCH_PAYMENT | CONSOLIDATION)
}

#[test]
fn sighash_none_and_anyonecanpay_come_from_the_type_byte() {
    let p2pkh = |kind| spent(vec![input(push(&[&der(kind), &KEY]), &[])]);
    assert_eq!(p2pkh(0x02), P2PKH | SIGHASH_NONE);
    assert_eq!(p2pkh(0x82), P2PKH | SIGHASH_NONE | SIGHASH_ACP);
    assert_eq!(p2pkh(0x01), P2PKH | SIGHASH_ALL);
    assert_eq!(p2pkh(0x83), P2PKH | SIGHASH_SINGLE | SIGHASH_ACP);
}

#[test]
fn scriptsig_templates_are_told_apart() {
    assert_eq!(
        spent(vec![input(push(&[&der(1)]), &[])]),
        P2PK | SIGHASH_ALL
    );
    let multisig = push(&[&[], &der(1), &der(3)]);
    assert_eq!(
        spent(vec![input(multisig, &[])]),
        P2MS | SIGHASH_ALL | SIGHASH_SINGLE
    );
    // A redeem script after the signatures makes it P2SH.
    let p2sh = push(&[&[], &der(1), &[0x51, 0xae]]);
    assert_eq!(spent(vec![input(p2sh, &[])]), P2SH | SIGHASH_ALL);
    // An empty scriptSig with no witness spends nothing we can name.
    assert_eq!(spent(vec![input(ScriptBuf::new(), &[])]), 0);
}

#[test]
fn a_scriptsig_with_another_opcode_has_no_type_but_its_signatures_count() {
    let mut bytes = push(&[&der(1), &KEY]).into_bytes();
    bytes.push(0x76); // OP_DUP
    assert_eq!(
        spent(vec![input(ScriptBuf::from_bytes(bytes.clone()), &[])]),
        SIGHASH_ALL
    );
    // A truncated push ends the reading; what came before it still counts.
    bytes.extend_from_slice(&[0x4c]);
    assert_eq!(
        spent(vec![input(ScriptBuf::from_bytes(bytes), &[])]),
        SIGHASH_ALL
    );
}

#[test]
fn witness_spends_are_told_apart() {
    assert_eq!(
        spent(vec![input(ScriptBuf::new(), &[&der(1), &KEY])]),
        P2WPKH | SIGHASH_ALL
    );
    let wrapped = input(push(&[&[0u8; 22]]), &[&der(1), &KEY]);
    assert_eq!(spent(vec![wrapped]), P2SH | SIGHASH_ALL);
    let p2wsh = input(ScriptBuf::new(), &[&[], &der(1), &der(2), &[0x52, 0xae]]);
    assert_eq!(spent(vec![p2wsh]), P2WSH | SIGHASH_ALL | SIGHASH_NONE);
    assert_eq!(
        spent(vec![input(ScriptBuf::new(), &[&[7; 64]])]),
        P2TR | SIGHASH_DEFAULT
    );
    let mut sig65 = vec![7; 64];
    sig65.push(0x81);
    assert_eq!(
        spent(vec![input(ScriptBuf::new(), &[&sig65])]),
        P2TR | SIGHASH_ALL | SIGHASH_ACP
    );
}

#[test]
fn the_annex_is_dropped_before_the_witness_is_read() {
    let annex: &[u8] = &[0x50, 1, 2];
    assert_eq!(
        spent(vec![input(ScriptBuf::new(), &[&[7; 64], annex])]),
        P2TR | SIGHASH_DEFAULT
    );
    // Script path: a signature, an envelope script, a control block, the annex.
    let mut sig65 = vec![7; 64];
    sig65.push(0x83);
    let script = [
        0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0xac, 0x00, 0x63, 0x01, 0x61, 0x68,
    ];
    let control = [0xc1; 33];
    let spend = input(ScriptBuf::new(), &[&sig65, &script, &control, annex]);
    assert_eq!(
        spent(vec![spend]),
        P2TR | SIGHASH_SINGLE | SIGHASH_ACP | INSCRIPTION
    );
    // Script path with no annex: the 64-byte item before the script is the signature.
    let spend = input(ScriptBuf::new(), &[&[7; 64], &[0xac], &control]);
    assert_eq!(spent(vec![spend]), P2TR | SIGHASH_DEFAULT);
}

#[test]
fn an_envelope_is_found_by_opcode_not_by_bytes() {
    let control = [0xc0; 65];
    // 00 63 inside a push is data, not an envelope.
    let hidden: &[u8] = &[0x02, 0x00, 0x63, 0xac];
    assert_eq!(
        spent(vec![input(ScriptBuf::new(), &[&[], hidden, &control])]),
        P2TR
    );
    // An empty OP_PUSHDATA1 is not OP_FALSE.
    let pushdata: &[u8] = &[0x4c, 0x00, 0x63, 0x68];
    assert_eq!(
        spent(vec![input(ScriptBuf::new(), &[&[], pushdata, &control])]),
        P2TR
    );
    let open: &[u8] = &[0xac, 0x00, 0x63, 0x68];
    assert_eq!(
        spent(vec![input(ScriptBuf::new(), &[&[], open, &control])]),
        P2TR | INSCRIPTION
    );
}

#[test]
fn unknown_versions_set_no_version_bit() {
    for v in [0, 4, -1, i32::MAX] {
        assert_eq!(
            of(&tx(v, vec![input(ScriptBuf::new(), &[])], vec![])) & (V1 | V2 | V3),
            0
        );
    }
    assert_eq!(of(&tx(3, vec![], vec![])) & (V1 | V2 | V3), V3);
}

#[test]
fn bare_multisig_outputs_and_keys_off_the_curve() {
    let mut off = KEY;
    off[0] = 0x03;
    off[1..].fill(0xff); // x above the field's prime
    let ms = |a: &[u8], b: &[u8]| {
        let mut s = vec![0x51, 0x21];
        s.extend_from_slice(a);
        s.push(0x21);
        s.extend_from_slice(b);
        s.extend_from_slice(&[0x52, 0xae]);
        of(&tx(1, vec![], vec![ScriptBuf::from_bytes(s)])) & (P2MS | FAKE_PUBKEY)
    };
    assert_eq!(ms(&KEY, &KEY), P2MS);
    assert_eq!(ms(&KEY, &off), P2MS | FAKE_PUBKEY);
    // n must count the keys.
    let wrong_n = ScriptBuf::from_bytes([&[0x51, 0x21][..], &KEY, &[0x52, 0xae]].concat());
    assert_eq!(of(&tx(1, vec![], vec![wrong_n])) & P2MS, 0);
}

#[test]
fn transaction_shapes() {
    let ins = |n| {
        (0..n)
            .map(|_| input(ScriptBuf::new(), &[]))
            .collect::<Vec<_>>()
    };
    let outs = |n| vec![ScriptBuf::new(); n];
    assert_ne!(of(&tx(2, ins(5), outs(1))) & CONSOLIDATION, 0);
    assert_eq!(of(&tx(2, ins(4), outs(1))) & CONSOLIDATION, 0);
    assert_ne!(of(&tx(2, ins(1), outs(5))) & BATCH_PAYMENT, 0);
    assert_eq!(of(&tx(2, ins(1), outs(4))) & BATCH_PAYMENT, 0);
    let mut rbf = ins(2);
    rbf[1].sequence = Sequence(0xffff_fffd);
    assert_eq!(of(&tx(2, rbf, outs(1))) & (RBF | NO_RBF), RBF);
    let mut final_ = ins(1);
    final_[0].sequence = Sequence(0xffff_fffe);
    assert_eq!(of(&tx(2, final_, outs(1))) & (RBF | NO_RBF), NO_RBF);
}

#[test]
fn the_coinbase_input_has_no_type_but_its_outputs_count() {
    let mut cb = input(push(&[&der(1)]), &[&[0; 32]]);
    cb.previous_output = OutPoint::null();
    let coinbase = tx(1, vec![cb], vec![ScriptBuf::new(); 5]);
    assert!(coinbase.is_coinbase());
    assert_eq!(of(&coinbase), V1 | NO_RBF | BATCH_PAYMENT);
}

/// Truncated pushes, absurd lengths and random bytes in every place a script or witness is read.
#[test]
fn hostile_scripts_and_witnesses_do_not_panic() {
    let fixed: [&[u8]; 9] = [
        &[0x4c],
        &[0x4d, 0xff],
        &[0x4e, 0xff, 0xff, 0xff, 0xff],
        &[0x4b, 1, 2],
        &[0x51, 0x21, 0x02, 0xae],
        &[0x60, 0xae],
        &[0xae],
        &[0x50],
        &[],
    ];
    let mut cases: Vec<Vec<u8>> = fixed.iter().map(|b| b.to_vec()).collect();
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    for _ in 0..2000 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let len = (state % 80) as usize;
        cases.push(
            (0..len)
                .map(|i| (state >> (i % 8 * 8)) as u8 ^ i as u8)
                .collect(),
        );
    }
    for (n, c) in cases.iter().enumerate() {
        let other = &cases[(n * 7 + 3) % cases.len()];
        let mut first = c.clone();
        if let Some(b) = first.first_mut() {
            *b = [0xc0, 0x50, 0x30][n % 3];
        }
        for script_sig in [ScriptBuf::new(), ScriptBuf::from_bytes(c.clone())] {
            for witness in [
                vec![],
                vec![c.as_slice()],
                vec![other.as_slice(), &first],
                vec![c.as_slice(), other, &first],
            ] {
                let t = tx(
                    n as i32,
                    vec![input(script_sig.clone(), &witness)],
                    vec![ScriptBuf::from_bytes(c.clone())],
                );
                let _ = of(&t);
            }
        }
    }
}
