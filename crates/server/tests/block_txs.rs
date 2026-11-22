//! Listing a block's transactions through `/block/:hash/txs/summary` or `getblock` verbosity 2:
//! both give the same answers, and a block the route fails on is listed by `getblock`. Against a mock node serving a recorded testnet4 block (160,394:
//! a coinbase and five segwit spends) and a scripted Electrum server, on port 0.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashMap;
use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use bitcoin::BlockHash;
use engine::blocks::listing::Via;
use engine::blocks::{Lister, NodeSource, Source, stats};
use logging::{Format, Level, Settings};
use node::esplora::Esplora;
use node::rpc::Rpc;
use rbitcoin_space::{App, Config};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tower::ServiceExt;

const WAIT: Duration = Duration::from_secs(5);
/// The recorded block's coinbase.
const COINBASE: &str = "a332c863b4c1b3a24fbf8b4250ec9e70d21a2269df21505e4e3c6651b62e64b7";

/// What the mock answers on `/block/:hash/txs/summary`.
#[derive(Clone, Copy)]
#[repr(u8)]
enum Mode {
    /// The recorded rows.
    Route = 0,
    /// A refusal of the path itself, as a node without the route gives (rbitcoin v0.9.2's).
    Refused = 1,
    /// One row short of the header's `tx_count`.
    Short = 2,
    /// 404, as for a block the route cannot list.
    Gone = 3,
}

/// A node that knows every hash starting with ten zeros as the recorded block, and no other.
#[derive(Default)]
struct Node {
    mode: AtomicU8,
    getblock: AtomicUsize,
    route: AtomicUsize,
}

impl Node {
    fn set(&self, mode: Mode) {
        self.mode.store(mode as u8, Ordering::SeqCst);
    }
    fn calls(&self) -> (usize, usize) {
        (
            self.getblock.load(Ordering::SeqCst),
            self.route.load(Ordering::SeqCst),
        )
    }
}

type N = State<Arc<Node>>;

fn fixture(path: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures")
        .join(path);
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn known(hash: &str) -> bool {
    hash.len() == 64 && hash.starts_with("0000000000")
}

fn hash(i: u8) -> String {
    format!("{}{i:02x}", "0".repeat(62))
}

async fn rpc(State(node): N, Json(req): Json<Value>) -> Json<Value> {
    // Other tasks ask too (the health check); only `getblock` concerns these tests.
    if req["method"] != "getblock" {
        return Json(json!({"result": null, "error": {"code": -32601, "message": "not here"}}));
    }
    assert_eq!(req["params"][1], 2);
    let h = req["params"][0].as_str().unwrap();
    if !known(h) {
        return Json(json!({"result": null, "error": {"code": -5, "message": "Block not found"}}));
    }
    node.getblock.fetch_add(1, Ordering::SeqCst);
    let mut b: Value =
        serde_json::from_slice(&fixture("rpc/testnet4/getblock-160394.json")).unwrap();
    b["hash"] = json!(h);
    Json(json!({"result": b, "error": null, "id": 0}))
}

async fn block(Path(h): Path<String>) -> Response {
    if !known(&h) {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }
    let mut b: Value =
        serde_json::from_slice(&fixture("esplora/testnet4/block-160394.json")).unwrap();
    b["id"] = json!(h);
    Json(b).into_response()
}

async fn summary(State(node): N, Path(h): Path<String>) -> Response {
    if !known(&h) {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }
    node.route.fetch_add(1, Ordering::SeqCst);
    let rows = fixture("esplora/testnet4/block-160394-txs-summary.json");
    let mode = node.mode.load(Ordering::SeqCst);
    match mode {
        0 => rows.into_response(),
        1 => (
            StatusCode::BAD_REQUEST,
            "Invalid URL: Cannot parse value at index 1 with value `summary` to a `u32`",
        )
            .into_response(),
        2 => {
            let mut rows: Vec<Value> = serde_json::from_slice(&rows).unwrap();
            rows.pop();
            Json(rows).into_response()
        }
        _ => (StatusCode::NOT_FOUND, "Not Found").into_response(),
    }
}

/// The recorded block's transactions, from `getblock`'s hex.
fn transactions() -> Vec<bitcoin::Transaction> {
    let b: Value = serde_json::from_slice(&fixture("rpc/testnet4/getblock-160394.json")).unwrap();
    b["tx"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| bitcoin::consensus::encode::deserialize_hex(t["hex"].as_str().unwrap()).unwrap())
        .collect()
}

/// The recorded block's raw bytes, for the flags. The header is not read.
async fn raw_block(Path(h): Path<String>) -> Response {
    if !known(&h) {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }
    let block = bitcoin::Block {
        header: bitcoin::constants::genesis_block(bitcoin::Network::Testnet4).header,
        txdata: transactions(),
    };
    bitcoin::consensus::serialize(&block).into_response()
}

async fn raw_tx(Path(txid): Path<String>) -> Response {
    if txid != COINBASE {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }
    fixture("esplora/testnet4/block-160394-coinbase.bin").into_response()
}

/// The mock on port 0: JSON-RPC at `/`, Esplora beside it. Returns its address.
async fn mock(node: &Arc<Node>) -> SocketAddr {
    let app = axum::Router::new()
        .route("/", post(rpc))
        .route("/block/{hash}", get(block))
        .route("/block/{hash}/txs/summary", get(summary))
        .route("/block/{hash}/raw", get(raw_block))
        .route("/tx/{txid}/raw", get(raw_tx))
        .with_state(Arc::clone(node));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await });
    addr
}

/// The app with `net` pointed at the mock, and the Electrum listener it connects to.
async fn start(net: &str, node: &Arc<Node>) -> (App, TcpListener) {
    capture();
    let addr = mock(node).await;
    let electrum = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let vars: HashMap<String, String> = [
        ("RPC_HOST", "127.0.0.1".to_owned()),
        ("RPC_PORT", addr.port().to_string()),
        ("RPC_USER", "u".to_owned()),
        ("RPC_PASSWORD", "p".to_owned()),
        ("ESPLORA_URL", format!("http://{addr}")),
        ("ELECTRUM_ADDR", electrum.local_addr().unwrap().to_string()),
        ("MEMPOOL_ENABLED", "false".to_owned()),
    ]
    .into_iter()
    .map(|(k, v)| (format!("{net}_{k}"), v))
    .collect();
    let mut config = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
    config.limits.client_burst = 10_000;
    config.limits.client_rate_per_sec = 10_000;
    (App::new(&config), electrum)
}

async fn get_raw(app: &App, path: &str) -> (StatusCode, Vec<u8>) {
    let mut req = Request::builder()
        .method(Method::GET)
        .uri(path)
        .body(Body::empty())
        .unwrap();
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 9))));
    let res = app.router().oneshot(req).await.unwrap();
    let status = res.status();
    (
        status,
        to_bytes(res.into_body(), 1 << 20).await.unwrap().to_vec(),
    )
}

// The log. Global per test binary, so each test uses a network of its own.

#[derive(Clone)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn capture() -> &'static Capture {
    static CAPTURE: OnceLock<Capture> = OnceLock::new();
    CAPTURE.get_or_init(|| {
        let c = Capture(Arc::default());
        let settings = Settings {
            format: Format::Json,
            level: Level::Debug,
            max_bytes_per_sec: logging::DEFAULT_MAX_BYTES_PER_SEC,
        };
        assert!(logging::init(settings, c.clone()));
        c
    })
}

fn lines(network: &str, event: &str) -> Vec<Value> {
    logging::flush(Duration::from_secs(1));
    let raw = String::from_utf8(capture().0.lock().unwrap().clone()).unwrap();
    raw.lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|v| v["event"] == event && v["network"] == network)
        .collect()
}

/// Waits until `network` has logged `event` `n` times; returns the last.
async fn logged(network: &str, event: &str, n: usize) -> Value {
    let deadline = Instant::now() + WAIT;
    loop {
        let found = lines(network, event);
        if found.len() >= n {
            return found[n - 1].clone();
        }
        assert!(Instant::now() < deadline, "{event} not logged {n} times");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// Tests.

/// The block every consumer reads, the facts the backfill rates from, and every summary route's
/// bytes, the flags included, are the same through either source.
#[tokio::test]
async fn both_sources_give_identical_answers() {
    let node = Arc::new(Node::default());
    let addr = mock(&node).await;
    let rpc = Rpc::new("127.0.0.1", addr.port(), "u", "p").unwrap();
    let esplora = Esplora::new(&format!("http://{addr}")).unwrap();
    let h: BlockHash = hash(1).parse().unwrap();

    let (route, via) = Lister::fixed(Via::Route).block(&rpc, &esplora, h).await;
    assert_eq!(via, Via::Route);
    assert_eq!(node.calls(), (0, 1));
    let (getblock, via) = Lister::fixed(Via::GetBlock).block(&rpc, &esplora, h).await;
    assert_eq!(via, Via::GetBlock);
    assert_eq!(node.calls(), (1, 1));
    let (route, getblock) = (route.unwrap(), getblock.unwrap());
    assert_eq!(route, getblock, "the audit and the summaries read this");
    assert_eq!(route.tx.len(), 6);
    let flags = stats::flags(&route, &esplora.block_raw(h).await.unwrap().value).unwrap();
    assert_eq!(
        stats::encode_txs(&route, &flags),
        stats::encode_txs(&getblock, &flags)
    );
    assert_eq!(stats::facts(&route), stats::facts(&getblock));

    // The backfill's source, each way.
    let source = |via| NodeSource {
        rpc: rpc.clone(),
        esplora: esplora.clone(),
        lister: Arc::new(Lister::fixed(via)),
    };
    let a = source(Via::Route).facts(h).await.unwrap().unwrap();
    let b = source(Via::GetBlock).facts(h).await.unwrap().unwrap();
    assert_eq!(a, b);
    assert_eq!(node.calls(), (2, 2));

    // The routes, from two servers whose nodes differ only in having the route.
    let paths = |p: &str| {
        let h = hash(1);
        [
            format!("{p}/app/block/{h}/summary"),
            format!("{p}/app/block/{h}/txs"),
            format!("{p}/api/v1/block/{h}/summary"),
            format!("{p}/app/blocks/summary?hashes={h}"),
        ]
    };
    let with = Arc::new(Node::default());
    let (app, _electrum) = start("SIGNET", &with).await;
    let mut served = Vec::new();
    for p in paths("/signet") {
        let (status, body) = get_raw(&app, &p).await;
        assert_eq!(status, StatusCode::OK, "{p}");
        served.push(body);
    }
    assert_eq!(with.calls(), (0, 1), "one listing however many routes ask");
    // Each transaction's flags, from the raw block, in the records and the `/api/v1` rows.
    let want: Vec<u64> = transactions().iter().map(engine::flags::of).collect();
    assert!(want.iter().all(|&f| f != 0));
    let records = &served[1][8..];
    assert_eq!(records.len(), 28 * want.len());
    let in_records: Vec<u64> = records
        .chunks(28)
        .map(|r| u64::from_le_bytes(r[20..].try_into().unwrap()))
        .collect();
    assert_eq!(in_records, want);
    let rows: Vec<Value> = serde_json::from_slice(&served[2]).unwrap();
    let in_rows: Vec<u64> = rows.iter().map(|r| r["flags"].as_u64().unwrap()).collect();
    assert_eq!(in_rows, want);
    let without = Arc::new(Node::default());
    without.set(Mode::Refused);
    let (app, _electrum) = start("TESTNET4", &without).await;
    for (p, theirs) in paths("/testnet4").iter().zip(&served) {
        let (status, body) = get_raw(&app, p).await;
        assert_eq!(status, StatusCode::OK, "{p}");
        assert_eq!(&body, theirs, "{p}");
    }
    assert_eq!(without.calls(), (1, 1), "refused, then getblock");
    assert_eq!(
        logged("signet", "block_summary_computed", 1).await["source"],
        "summary_route"
    );
    assert_eq!(
        logged("testnet4", "block_summary_computed", 1).await["source"],
        "getblock"
    );
    assert_eq!(
        logged("testnet4", "block_txs_fell_back", 1).await["reason"],
        "refused"
    );
}

/// Every block tries the route; one it fails on is listed by `getblock`, and the next block
/// tries the route again.
#[tokio::test]
async fn a_block_the_route_fails_on_is_listed_by_getblock() {
    let node = Arc::new(Node::default());
    let (app, _electrum) = start("MAINNET", &node).await;
    let summary = |i: u8| {
        let app = app.clone();
        async move {
            let (status, _) = get_raw(&app, &format!("/app/block/{}/summary", hash(i))).await;
            assert_eq!(status, StatusCode::OK);
        }
    };
    summary(1).await;
    assert_eq!(node.calls(), (0, 1));
    // A row count that disagrees with the header.
    node.set(Mode::Short);
    summary(2).await;
    assert_eq!(node.calls(), (1, 2));
    assert_eq!(
        logged("mainnet", "block_txs_fell_back", 1).await["reason"],
        "mismatch"
    );
    node.set(Mode::Gone);
    summary(3).await;
    assert_eq!(node.calls(), (2, 3));
    assert_eq!(
        logged("mainnet", "block_txs_fell_back", 2).await["reason"],
        "not_found"
    );
    // A refusal of the route itself is one block's failure too.
    node.set(Mode::Refused);
    summary(4).await;
    summary(5).await;
    assert_eq!(node.calls(), (4, 5));
    assert_eq!(
        logged("mainnet", "block_txs_fell_back", 3).await["reason"],
        "refused"
    );
    node.set(Mode::Route);
    summary(6).await;
    assert_eq!(node.calls(), (4, 6));
}
