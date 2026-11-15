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
    ])
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
    let first = c.slot(op(PRE, 0)).unwrap();
    assert!(
        Arc::ptr_eq(&first, &c.slot(op(PRE, 0)).unwrap()),
        "shared while running"
    );
    for vout in 1..MAX_KEPT as u32 {
        c.slot(op(PRE, vout)).unwrap();
    }
    assert_eq!(c.slot(op(SETTLED, 0)).unwrap_err(), Error::Busy);
    tokio::time::advance(STALLED).await;
    // Stalled slots give way: to a new outpoint, and to the same one asked again.
    assert!(c.slot(op(SETTLED, 0)).is_ok());
    assert!(!Arc::ptr_eq(&first, &c.slot(op(PRE, 0)).unwrap()));
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
