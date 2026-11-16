//! Decoding against answers recorded from signet's public Arkade server (`fixtures/arkade`), and
//! the client against a fake arkd on port 0.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

const INFO_SIGNET: &str = include_str!("../../../fixtures/arkade/info-signet.json");
const INFO_MAINNET: &str = include_str!("../../../fixtures/arkade/info-mainnet.json");
const VTXO_PRE: &str = include_str!("../../../fixtures/arkade/vtxo-preconfirmed.json");
const CHAIN_PRE: &str = include_str!("../../../fixtures/arkade/chain-preconfirmed.json");
const COMMITMENT_128: &str = include_str!("../../../fixtures/arkade/commitment-128.json");
const TREE_128: &str = include_str!("../../../fixtures/arkade/tree-128.json");
const VTXO_SETTLED: &str = include_str!("../../../fixtures/arkade/vtxo-settled.json");
const CHAIN_SETTLED: &str = include_str!("../../../fixtures/arkade/chain-settled.json");
const COMMITMENT_1: &str = include_str!("../../../fixtures/arkade/commitment-1.json");
const TREE_1: &str = include_str!("../../../fixtures/arkade/tree-1.json");
const VTXO_UNKNOWN: &str = include_str!("../../../fixtures/arkade/vtxo-unknown.json");
const CHAIN_UNKNOWN: &str = include_str!("../../../fixtures/arkade/chain-unknown.json");
const CHAIN_PAGED: &str = include_str!("../../../fixtures/arkade/chain-paged.json");
const LIST_PAGE1: &str = include_str!("../../../fixtures/arkade/list-page1.json");
const LIST_LAST: &str = include_str!("../../../fixtures/arkade/list-last.json");
const LIST_EMPTY: &str = include_str!("../../../fixtures/arkade/list-empty.json");

/// arkd's own test vector (`pkg/ark-lib/encoding_test.go`): its signer and VTXO keys.
const VECTOR: &str = "tark1qqellv77udfmr20tun8dvju5vgudpf9vxe8jwhthrkn26fz96pawqfdy8nk05rsmrf8h94j26905e7n6sng8y059z8ykn2j5xcuw4xt846qj6x";
/// Signet's server key and the script of the VTXO in the fixtures, as an address.
const SIGNET_ADDR: &str = "tark1qz9l2ctqalrkjyftxcw7gytm83cm3r9pdudmna4v0gncry56h30x5eu7kqsr8ul6td7gu8qqv70s60ufv6nz7rytef7hs33wdhc76xqnrjdp6x";
const SIGNET_SCRIPT: &str = "5120679eb02033f3fa5b7c8e1c00679f0d3f8966a62f0c8bca7d78462e6df1ed1813";

const PRE: &str = "d922b2c3811ec22ae6c7b0bea4eaef16c33250bf4e717950f1898095e79773fc";
const C128: &str = "5cac5e493337e37ef5a66c66a4c36f7d8e87f3c9b85c635ca49fe6721268bd80";
const SETTLED: &str = "c10fa27e82b2f17f900a44435f4e43f2a086f823abed971f81afc7813637e4ba";
const C1: &str = "56b618725603cf08e8f2c1b3d851f9c1f53024fa3112c4f72b9b292e15a401a9";
const UNKNOWN: &str = "abababababababababababababababababababababababababababababababab";

fn op(txid: &str, vout: u32) -> Outpoint {
    Outpoint {
        txid: txid.parse().unwrap(),
        vout,
    }
}

#[test]
fn outpoints_parse_strictly() {
    assert_eq!(format!("{PRE}:0").parse::<Outpoint>().unwrap(), op(PRE, 0));
    assert_eq!(
        format!("{PRE}:4294967295")
            .parse::<Outpoint>()
            .unwrap()
            .vout,
        u32::MAX
    );
    for bad in [
        String::new(),
        PRE.to_owned(),
        format!("{PRE}:"),
        format!("{PRE}:01"),
        format!("{PRE}:+1"),
        format!("{PRE}:-1"),
        format!("{PRE}:4294967296"),
        format!("{PRE}:0:0"),
        format!("{}:0", &PRE[1..]),
        format!("{}g:0", &PRE[1..]),
        format!(" {PRE}:0"),
    ] {
        assert!(bad.parse::<Outpoint>().is_err(), "{bad}");
    }
}

#[test]
fn recorded_answers_decode() {
    let info: wire::Info = serde_json::from_str(INFO_SIGNET).unwrap();
    assert_eq!(info.unilateral_exit_delay, 172_544);
    assert_eq!(info.network, "signet");
    let info: wire::Info = serde_json::from_str(INFO_MAINNET).unwrap();
    assert_eq!(info.unilateral_exit_delay, 605_184);
    assert_eq!(info.network, "bitcoin");

    let v: wire::Vtxos = serde_json::from_str(VTXO_PRE).unwrap();
    let v = &v.vtxos[0];
    assert!(v.is_preconfirmed && v.is_swept && !v.is_spent);
    assert_eq!((v.amount, v.depth, v.spent_by), (1000, 1, None));
    assert_eq!(v.commitment_txids, vec![C128.parse().unwrap()]);

    let c: wire::Chain = serde_json::from_str(CHAIN_PRE).unwrap();
    let kinds: Vec<Kind> = c.chain.iter().map(|t| Kind::parse(&t.kind)).collect();
    assert_eq!(kinds[0], Kind::Ark);
    assert_eq!(kinds[1], Kind::Checkpoint);
    assert_eq!(kinds.iter().filter(|k| **k == Kind::Tree).count(), 8);
    assert_eq!(kinds[10], Kind::Commitment);
    // The checkpoint names the output it spends; the txid is kept.
    assert_eq!(
        c.chain[1].spends[0].to_string(),
        "42d53e9b27f46a383f81c1077cfa5b8b264a340d2dcf96acc31015dccea01e0f"
    );

    let c: wire::Commitment = serde_json::from_str(COMMITMENT_128).unwrap();
    assert_eq!(c.batches["0"].total_output_vtxos, 128);

    let empty: wire::Vtxos = serde_json::from_str(VTXO_UNKNOWN).unwrap();
    assert!(empty.vtxos.is_empty());
}

#[test]
fn hostile_answers_are_refused() {
    let vtxo = |txid: &str, amount: &str| {
        format!(
            r#"{{"vtxos":[{{"outpoint":{{"txid":"{txid}","vout":0}},"createdAt":"1","expiresAt":"1","amount":{amount}}}]}}"#
        )
    };
    assert!(serde_json::from_str::<wire::Vtxos>(&vtxo(PRE, r#""1""#)).is_ok());
    for bad in [
        vtxo("<script>alert(1)</script>", r#""1""#),
        vtxo(&PRE[2..], r#""1""#),
        vtxo(PRE, r#""-1""#),
        vtxo(PRE, r#""1e9""#),
        vtxo(PRE, r#""0x10""#),
        vtxo(PRE, r#""99999999999999999999""#),
        vtxo(PRE, "true"),
    ] {
        assert!(serde_json::from_str::<wire::Vtxos>(&bad).is_err(), "{bad}");
    }
}

#[test]
fn a_real_tree_is_ordered_from_its_root() {
    let raw: wire::Tree = serde_json::from_str(TREE_128).unwrap();
    assert_eq!(raw.vtxo_tree.len(), 255);
    let nodes: Vec<TreeNode> = raw
        .vtxo_tree
        .into_iter()
        .map(|n| TreeNode {
            txid: n.txid,
            children: n.children.into_values().map(|t| t.0).collect(),
        })
        .collect();
    let ordered = order_tree(nodes).unwrap();
    assert_eq!(ordered.len(), 255);
    // The chain's last tree transaction spends the commitment: it is the root.
    assert_eq!(
        ordered[0].txid.to_string(),
        "bcf8af2cfa2cfbfc7d76e25c145ec45da546ae8cc0cc66da609f7b678183c488"
    );
    assert_eq!(
        ordered.iter().filter(|n| n.children.is_empty()).count(),
        128
    );
}

#[test]
fn only_one_tree_is_a_tree() {
    let t = |c: char| -> Txid { c.to_string().repeat(64).parse().unwrap() };
    let node = |id, kids: &[Txid]| TreeNode {
        txid: id,
        children: kids.to_vec(),
    };
    let (a, b, c) = (t('a'), t('b'), t('c'));
    assert_eq!(
        order_tree(vec![node(b, &[]), node(a, &[b, c]), node(c, &[])])
            .unwrap()
            .iter()
            .map(|n| n.txid)
            .collect::<Vec<_>>(),
        vec![a, b, c]
    );
    // Two roots, a missing child, a node reached twice, a cycle with nothing outside it.
    assert!(order_tree(vec![node(a, &[]), node(b, &[])]).is_none());
    assert!(order_tree(vec![node(a, &[b])]).is_none());
    assert!(order_tree(vec![node(a, &[b, c]), node(b, &[c]), node(c, &[])]).is_none());
    assert!(order_tree(vec![node(a, &[b]), node(b, &[a])]).is_none());
    assert!(order_tree(Vec::new()).is_none());
}

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (o, i) in out.iter_mut().zip((0..64).step_by(2)) {
        *o = u8::from_str_radix(&s[i..i + 2], 16).unwrap();
    }
    out
}

/// An address of `hrp` over these 65 bytes, valid bech32m whatever they hold.
fn encode(hrp: &str, bytes: &[u8]) -> String {
    use bitcoin::bech32::{Bech32m, Hrp};
    bitcoin::bech32::encode::<Bech32m>(Hrp::parse(hrp).unwrap(), bytes).unwrap()
}

#[test]
fn arkades_own_vector_parses() {
    let a = Address::parse(VECTOR, false).unwrap();
    assert_eq!(
        a.server_key,
        hex32("33ffb3dee353b1a9ebe4ced64b946238d0a4ac364f275d771da6ad2445d07ae0")
    );
    assert_eq!(
        a.p2tr_key,
        hex32("25a43cecfa0e1b1a4f72d64ad15f4cfa7a84d0723e8511c969aa543638ea9967")
    );
    assert_eq!(
        a.script_hex(),
        "512025a43cecfa0e1b1a4f72d64ad15f4cfa7a84d0723e8511c969aa543638ea9967"
    );
    // Upper case is the same address; our own encoding of its bytes is the vector.
    assert_eq!(Address::parse(&VECTOR.to_uppercase(), false).unwrap(), a);
    let mut bytes = vec![0u8];
    bytes.extend_from_slice(&a.server_key);
    bytes.extend_from_slice(&a.p2tr_key);
    assert_eq!(encode("tark", &bytes), VECTOR);
    let s = Address::parse(SIGNET_ADDR, false).unwrap();
    assert_eq!(s.script_hex(), SIGNET_SCRIPT);
}

/// BOAT-1 version 0: the whole data part, version bits included, is 65 bytes: `arkade_version`
/// (0), `server_key`, `p2tr_key`. Its first character is `q` because the version is the first
/// byte's top five bits.
#[test]
fn boat1_version_0_is_65_bytes_version_server_key_p2tr_key() {
    let server_key = hex32("8bf56160efc769112b361de4117b3c71b88ca16f1bb9f6ac7a2781929abc5e6a");
    let p2tr_key = hex32(&SIGNET_SCRIPT[4..]);
    let layout = [&[0u8][..], &server_key, &p2tr_key].concat();
    assert_eq!(layout.len(), 65);
    let encoded = encode("tark", &layout);
    assert_eq!(encoded, SIGNET_ADDR);
    assert_eq!(encoded.len(), "tark1".len() + 104 + 6);
    assert_eq!(
        Address::parse(&encoded, false),
        Ok(Address {
            server_key,
            p2tr_key
        })
    );
    // A byte short or over is not version 0, nor is the keys' order swapped the same address.
    for bad in [&layout[..64], &[layout.as_slice(), &[0]].concat()[..]] {
        assert_eq!(
            Address::parse(&encode("tark", bad), false),
            Err(AddressError::Invalid)
        );
    }
    let swapped = [&[0u8][..], &p2tr_key, &server_key].concat();
    assert_eq!(
        Address::parse(&encode("tark", &swapped), false).unwrap(),
        Address {
            server_key: p2tr_key,
            p2tr_key: server_key
        }
    );
}

#[test]
fn addresses_parse_strictly() {
    let a = Address::parse(VECTOR, false).unwrap();
    let body = |first: u8| {
        let mut b = vec![first];
        b.extend_from_slice(&a.server_key);
        b.extend_from_slice(&a.p2tr_key);
        b
    };
    // `ark` is mainnet's; `tark` every test network's.
    assert_eq!(
        Address::parse(VECTOR, true),
        Err(AddressError::OtherNetwork)
    );
    let main = encode("ark", &body(0));
    assert!(main.starts_with("ark1q"));
    assert_eq!(Address::parse(&main, true), Ok(a));
    assert_eq!(
        Address::parse(&main, false),
        Err(AddressError::OtherNetwork)
    );
    // 0x08 begins with the five bits 00001: Bark's `p`.
    let bark = encode("tark", &body(0x08));
    assert!(bark.starts_with("tark1p"));
    assert_eq!(Address::parse(&bark, false), Err(AddressError::Bark));
    // Version 2, 0x10's top five bits: not defined.
    assert_eq!(
        Address::parse(&encode("tark", &body(0x10)), false),
        Err(AddressError::Version)
    );
    // Version 0 with an `arkade_version` of 1: its first five bits are `q`, the rest is not 0.
    assert_eq!(
        Address::parse(&encode("tark", &body(0x01)), false),
        Err(AddressError::Version)
    );
    let mut bad_key = body(0);
    bad_key[33..].fill(0xff);
    assert_eq!(
        Address::parse(&encode("tark", &bad_key), false),
        Err(AddressError::Key)
    );
    let mut flipped = VECTOR.to_owned();
    flipped.replace_range(20..21, if &VECTOR[20..21] == "q" { "p" } else { "q" });
    let mut mixed = VECTOR.to_owned();
    mixed.replace_range(..4, "TARK");
    for bad in [
        String::new(),
        "tark1".into(),
        flipped,
        mixed,
        encode("tark", &body(0)[..64]),
        encode("tark", &[body(0), vec![0]].concat()),
        encode("tb", &body(0)),
        VECTOR.replace("tark1", "tark"),
        bitcoin::bech32::encode::<bitcoin::bech32::Bech32>(
            bitcoin::bech32::Hrp::parse("tark").unwrap(),
            &body(0),
        )
        .unwrap(),
        format!("{VECTOR}{}", "q".repeat(MAX_ADDRESS_LEN)),
        "tark1<script>".into(),
    ] {
        assert_eq!(
            Address::parse(&bad, false),
            Err(AddressError::Invalid),
            "{bad}"
        );
    }
}

#[test]
fn deprecated_signers_are_read() {
    let info: wire::Info = serde_json::from_str(INFO_MAINNET).unwrap();
    assert_eq!(info.deprecated_signers.len(), 1);
    assert_eq!(
        address::x_only(&info.deprecated_signers[0].pubkey).unwrap(),
        hex32("2b74c2011af089c849383ee527c72325de52df6a788428b68d49e9174053aaba")
    );
    assert!(address::x_only("04aa").is_none());
    assert!(address::x_only(&format!("05{}", "aa".repeat(32))).is_none());
    assert!(address::x_only(&format!("02+a{}", "aa".repeat(31))).is_none());
}

/// A fake arkd: answers paths it knows, `404` otherwise, counting every request.
struct Fake {
    url: String,
    hits: Arc<AtomicUsize>,
    paths: Arc<Mutex<Vec<String>>>,
}

type Routes = HashMap<String, (u16, String)>;

async fn fake(routes: Routes, stall: bool) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let paths = Arc::new(Mutex::new(Vec::new()));
    let routes = Arc::new(routes);
    let (h, p) = (Arc::clone(&hits), Arc::clone(&paths));
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let (routes, h, p) = (Arc::clone(&routes), Arc::clone(&h), Arc::clone(&p));
            tokio::spawn(async move {
                let mut buf = Vec::new();
                loop {
                    let mut chunk = [0u8; 4096];
                    let Ok(n) = sock.read(&mut chunk).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    while let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..end]).into_owned();
                        buf.drain(..end + 4);
                        let path = head.split(' ').nth(1).unwrap_or_default().to_owned();
                        h.fetch_add(1, Ordering::SeqCst);
                        p.lock().unwrap().push(path.clone());
                        if stall {
                            std::future::pending::<()>().await;
                        }
                        let (status, body) =
                            routes.get(&path).cloned().unwrap_or((404, "{}".into()));
                        let res = format!(
                            "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                            body.len()
                        );
                        if sock.write_all(res.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                }
            });
        }
    });
    Fake { url, hits, paths }
}

fn signet_routes() -> Routes {
    let ok = |s: &str| (200, s.to_owned());
    HashMap::from([
        ("/v1/info".into(), ok(INFO_SIGNET)),
        (format!("/v1/indexer/vtxos?outpoints={PRE}:0"), ok(VTXO_PRE)),
        (
            format!("/v1/indexer/vtxo/{PRE}/0/chain?page.size=128&page.index=1"),
            ok(CHAIN_PRE),
        ),
        (
            format!("/v1/indexer/commitmentTx/{C128}"),
            ok(COMMITMENT_128),
        ),
        (
            format!("/v1/indexer/batch/{C128}/0/tree?page.size=512&page.index=1"),
            ok(TREE_128),
        ),
        (
            format!("/v1/indexer/vtxos?outpoints={SETTLED}:0"),
            ok(VTXO_SETTLED),
        ),
        (
            format!("/v1/indexer/vtxo/{SETTLED}/0/chain?page.size=128&page.index=1"),
            ok(CHAIN_SETTLED),
        ),
        (format!("/v1/indexer/commitmentTx/{C1}"), ok(COMMITMENT_1)),
        (
            format!("/v1/indexer/batch/{C1}/0/tree?page.size=512&page.index=1"),
            ok(TREE_1),
        ),
        (
            format!("/v1/indexer/vtxos?outpoints={UNKNOWN}:0"),
            ok(VTXO_UNKNOWN),
        ),
        (
            format!("/v1/indexer/vtxo/{UNKNOWN}/0/chain?page.size=128&page.index=1"),
            (500, CHAIN_UNKNOWN.to_owned()),
        ),
        (list_path(SIGNET_SCRIPT, 1), ok(LIST_PAGE1)),
        (list_path(SIGNET_SCRIPT, 11), ok(LIST_LAST)),
    ])
}

fn list_path(script: &str, page: u32) -> String {
    format!("/v1/indexer/vtxos?scripts={script}&page.size=25&page.index={page}")
}

fn client(url: &str, mainnet: bool) -> Client {
    Client::new(
        &Endpoint::parse(url).unwrap(),
        mainnet,
        Duration::from_secs(4),
        "rbitcoin-space-test",
    )
    .unwrap()
}

#[tokio::test]
async fn a_preconfirmed_vtxo_is_found_with_its_whole_tree() {
    let f = fake(signet_routes(), false).await;
    let c = client(&f.url, false);
    let l = c.lookup(op(PRE, 0)).await.unwrap().unwrap();
    assert!(l.vtxo.preconfirmed);
    assert_eq!(l.server.exit_delay_secs, 172_544);
    assert_eq!(l.chain.len(), 11);
    assert!(l.chain_complete);
    assert_eq!(l.batches.len(), 1);
    let b = &l.batches[0];
    assert_eq!((b.vout, b.vtxos, b.amount), (0, 128, 140_000));
    assert_eq!(b.tree.as_ref().unwrap().len(), 255);
    // vtxo, info, chain, commitment, tree.
    assert_eq!(f.hits.load(Ordering::SeqCst), 5);
    assert!(f.hits.load(Ordering::SeqCst) <= MAX_CALLS);

    // Kept: asked again, nothing reaches the server.
    let again = c.lookup(op(PRE, 0)).await.unwrap().unwrap();
    assert!(Arc::ptr_eq(&l, &again));
    assert_eq!(f.hits.load(Ordering::SeqCst), 5);

    // The info is kept longer than one lookup: a second VTXO asks for it no more.
    let s = c.lookup(op(SETTLED, 0)).await.unwrap().unwrap();
    assert!(!s.vtxo.preconfirmed && s.vtxo.swept);
    assert_eq!(s.batches[0].tree.as_ref().unwrap().len(), 1);
    assert_eq!(f.hits.load(Ordering::SeqCst), 9);
    let asked = f.paths.lock().unwrap().clone();
    assert_eq!(asked.iter().filter(|p| *p == "/v1/info").count(), 1);
}

#[tokio::test]
async fn identical_lookups_in_flight_share_one() {
    let f = fake(signet_routes(), false).await;
    let c = Arc::new(client(&f.url, false));
    let tasks: Vec<_> = (0..8)
        .map(|_| {
            let c = Arc::clone(&c);
            tokio::spawn(async move { c.lookup(op(PRE, 0)).await })
        })
        .collect();
    for t in tasks {
        assert!(t.await.unwrap().unwrap().is_some());
    }
    assert_eq!(f.hits.load(Ordering::SeqCst), 5);
}

#[tokio::test]
async fn an_unknown_vtxo_costs_one_call() {
    let f = fake(signet_routes(), false).await;
    let c = client(&f.url, false);
    assert!(c.lookup(op(UNKNOWN, 0)).await.unwrap().is_none());
    assert_eq!(f.hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn failures_are_errors_and_are_not_kept() {
    let mut routes = signet_routes();
    routes.insert(
        format!("/v1/indexer/commitmentTx/{C128}"),
        (500, r#"{"code":13,"message":"batch not found"}"#.into()),
    );
    let f = fake(routes, false).await;
    let c = client(&f.url, false);
    assert_eq!(c.lookup(op(PRE, 0)).await.unwrap_err(), Error::Status);
    let before = f.hits.load(Ordering::SeqCst);
    assert_eq!(c.lookup(op(PRE, 0)).await.unwrap_err(), Error::Status);
    assert!(
        f.hits.load(Ordering::SeqCst) > before,
        "a failure is asked again"
    );
}

#[tokio::test]
async fn a_long_chain_is_cut_and_says_so() {
    let mut routes = signet_routes();
    routes.insert(
        format!("/v1/indexer/vtxo/{PRE}/0/chain?page.size=128&page.index=1"),
        (200, CHAIN_PAGED.to_owned()),
    );
    let f = fake(routes, false).await;
    let l = client(&f.url, false)
        .lookup(op(PRE, 0))
        .await
        .unwrap()
        .unwrap();
    assert!(!l.chain_complete);
    // Its commitment is still known from the VTXO itself.
    assert_eq!(l.batches.len(), 1);
}

#[tokio::test]
async fn a_tree_too_large_is_not_drawn() {
    let mut routes = signet_routes();
    let paged = TREE_128.replace(
        r#""page":{"current":1,"next":1,"total":1}"#,
        r#""page":{"current":1,"next":2,"total":2}"#,
    );
    assert_ne!(paged, TREE_128);
    routes.insert(
        format!("/v1/indexer/batch/{C128}/0/tree?page.size=512&page.index=1"),
        (200, paged),
    );
    let f = fake(routes, false).await;
    let l = client(&f.url, false)
        .lookup(op(PRE, 0))
        .await
        .unwrap()
        .unwrap();
    assert!(l.batches[0].tree.is_none());
    assert_eq!(l.batches[0].vtxos, 128);
}

#[tokio::test]
async fn an_answer_over_its_cap_is_refused() {
    let mut routes = signet_routes();
    let huge = format!(r#"{{"vtxos":[],"pad":"{}"}}"#, "x".repeat(VTXOS_BYTES));
    routes.insert(format!("/v1/indexer/vtxos?outpoints={PRE}:0"), (200, huge));
    let f = fake(routes, false).await;
    assert_eq!(
        client(&f.url, false).lookup(op(PRE, 0)).await.unwrap_err(),
        Error::TooBig
    );
}

#[tokio::test]
async fn a_server_on_another_chain_is_refused() {
    let mut routes = signet_routes();
    routes.insert("/v1/info".into(), (200, INFO_MAINNET.to_owned()));
    let f = fake(routes, false).await;
    assert_eq!(
        client(&f.url, false).lookup(op(PRE, 0)).await.unwrap_err(),
        Error::WrongNetwork
    );
}

#[tokio::test]
async fn a_silent_server_times_out() {
    let f = fake(signet_routes(), true).await;
    // A real clock: a paused one can fire the connect timeout before the connection is accepted.
    let c = Client::new(
        &Endpoint::parse(&f.url).unwrap(),
        false,
        Duration::from_millis(200),
        "rbitcoin-space-test",
    )
    .unwrap();
    assert_eq!(c.lookup(op(PRE, 0)).await.unwrap_err(), Error::Timeout);
    assert_eq!(f.hits.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn abandoned_lookups_cannot_fill_the_table() {
    // No server: slots are taken and left unanswered, as by callers that all gave up.
    let c = client("http://127.0.0.1:9", false);
    let first = c.kept.slot(op(PRE, 0)).unwrap();
    assert!(
        Arc::ptr_eq(&first, &c.kept.slot(op(PRE, 0)).unwrap()),
        "shared while running"
    );
    for vout in 1..MAX_KEPT as u32 {
        c.kept.slot(op(PRE, vout)).unwrap();
    }
    assert_eq!(c.kept.slot(op(SETTLED, 0)).unwrap_err(), Error::Busy);
    tokio::time::advance(STALLED).await;
    // Stalled slots give way: to a new outpoint, and to the same one asked again.
    assert!(c.kept.slot(op(SETTLED, 0)).is_ok());
    assert!(!Arc::ptr_eq(&first, &c.kept.slot(op(PRE, 0)).unwrap()));
}

#[tokio::test]
async fn nothing_listening_is_unavailable() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    assert_eq!(
        client(&url, false).lookup(op(PRE, 0)).await.unwrap_err(),
        Error::Unavailable
    );
}

#[tokio::test]
async fn an_address_lists_one_page_in_two_calls_then_one() {
    let f = fake(signet_routes(), false).await;
    let c = client(&f.url, false);
    let a = Address::parse(SIGNET_ADDR, false).unwrap();
    let l = c.list(&a, 1).await.unwrap().unwrap();
    assert_eq!((l.page, l.pages, l.vtxos.len()), (1, 11, 25));
    // arkd lists the newest first.
    assert!(
        l.vtxos
            .windows(2)
            .all(|w| w[0].created_at >= w[1].created_at)
    );
    assert_eq!(f.hits.load(Ordering::SeqCst), MAX_LIST_CALLS);
    // Kept, and the info with it: the same page costs nothing, another page one call.
    assert!(Arc::ptr_eq(&l, &c.list(&a, 1).await.unwrap().unwrap()));
    assert_eq!(f.hits.load(Ordering::SeqCst), 2);
    let last = c.list(&a, 11).await.unwrap().unwrap();
    assert_eq!((last.page, last.vtxos.len()), (11, 6));
    assert!(last.vtxos.iter().all(|v| v.spent && v.swept));
    assert_eq!(f.hits.load(Ordering::SeqCst), 3);
    // The page asked is clamped to the bounds.
    c.list(&a, u32::MAX).await.unwrap_err();
    assert_eq!(
        f.paths.lock().unwrap().last().unwrap(),
        &list_path(SIGNET_SCRIPT, MAX_PAGE)
    );
}

#[tokio::test]
async fn identical_pages_in_flight_share_one_failed_info() {
    let mut routes = signet_routes();
    routes.insert("/v1/info".into(), (500, "{}".into()));
    let f = fake(routes, false).await;
    let c = Arc::new(client(&f.url, false));
    let a = Address::parse(SIGNET_ADDR, false).unwrap();
    let tasks: Vec<_> = (0..8)
        .map(|_| {
            let c = Arc::clone(&c);
            tokio::spawn(async move { c.list(&a, 1).await })
        })
        .collect();
    for t in tasks {
        assert_eq!(t.await.unwrap().unwrap_err(), Error::Status);
    }
    assert_eq!(f.hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn an_address_of_another_server_is_not_listed() {
    let f = fake(signet_routes(), false).await;
    let c = client(&f.url, false);
    // arkd's vector names another signer: only the info is asked.
    assert!(
        c.list(&Address::parse(VECTOR, false).unwrap(), 1)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(*f.paths.lock().unwrap(), vec!["/v1/info".to_owned()]);
}

#[tokio::test]
async fn a_deprecated_signers_address_is_listed() {
    let mut routes = signet_routes();
    let deprecated = INFO_SIGNET.replace(
        r#""deprecatedSigners":[]"#,
        r#""deprecatedSigners":[{"pubkey":"0233ffb3dee353b1a9ebe4ced64b946238d0a4ac364f275d771da6ad2445d07ae0","cutoffDate":"1"}]"#,
    );
    assert_ne!(deprecated, INFO_SIGNET);
    routes.insert("/v1/info".into(), (200, deprecated));
    let vector = Address::parse(VECTOR, false).unwrap();
    routes.insert(
        list_path(&vector.script_hex(), 1),
        (200, LIST_EMPTY.to_owned()),
    );
    let f = fake(routes, false).await;
    let l = client(&f.url, false)
        .list(&vector, 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((l.pages, l.vtxos.len()), (0, 0));
}

#[tokio::test]
async fn a_list_of_other_scripts_or_too_long_is_refused() {
    let a = Address::parse(SIGNET_ADDR, false).unwrap();
    let other = LIST_PAGE1.replace(SIGNET_SCRIPT, &format!("5120{}", "ab".repeat(32)));
    let mut long: serde_json::Value = serde_json::from_str(LIST_PAGE1).unwrap();
    let first = long["vtxos"][0].clone();
    long["vtxos"].as_array_mut().unwrap().push(first);
    for body in [other, long.to_string()] {
        let mut routes = signet_routes();
        routes.insert(list_path(SIGNET_SCRIPT, 1), (200, body));
        let f = fake(routes, false).await;
        assert_eq!(
            client(&f.url, false).list(&a, 1).await.unwrap_err(),
            Error::Decode
        );
    }
}

#[test]
fn parse_any_reads_the_network_from_the_prefix() {
    let main = "ark1qz9l2ctqalrkjyftxcw7gytm83cm3r9pdudmna4v0gncry56h30x5eu7kqsr8ul6td7gu8qqv70s60ufv6nz7rytef7hs33wdhc76xqn9qxkrw";
    let (mainnet, a) = parse_any(main).unwrap();
    assert!(mainnet);
    let (mainnet, b) = parse_any(&SIGNET_ADDR.to_uppercase()).unwrap();
    assert!(!mainnet);
    assert_eq!(a, b);
    let AnyAddress::Arkade(a) = a else { panic!() };
    assert_eq!(a.script_hex(), SIGNET_SCRIPT);
    // One character changed: a checksum failure, said as such here and as "invalid" by `parse`.
    let typo = SIGNET_ADDR.replacen("qz9l", "qz8l", 1);
    assert_eq!(parse_any(&typo), Err(AddressError::Checksum));
    assert_eq!(Address::parse(&typo, false), Err(AddressError::Invalid));
    // A Bark address (ark-lib's round-trip vector) comes back as its payload.
    let bark = "tark1pwh9vsmezqqpharv69q4z8m6x364d5m5prnmcalcalq9pdmzw0y7mpveck4pcfhezqypczkrrj3lkx5ue4qrf4jc7ztpt9htdttmh2judhqnu7aue8p0y9mq47jn9z";
    assert!(matches!(parse_any(bark), Ok((false, AnyAddress::Bark(p))) if p.len() > 39));
    assert_eq!(
        parse_any("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"),
        Err(AddressError::Invalid)
    );
}
