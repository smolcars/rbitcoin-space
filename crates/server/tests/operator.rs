//! What an operator sees of the node's address index, the store and the build: the log events,
//! `/readyz`'s detail and `/healthz`. Against a mock node and a scripted Electrum server on port
//! 0; nothing here reaches a real node. A store whose writes fail is in `engine`'s store tests.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use bitcoin::consensus::encode::serialize_hex;
use logging::{Format, Level, Settings};
use rbitcoin_space::{App, Config};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(5);
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// The node: RPC answers the health check; Esplora answers the address index question as a node
/// with `--sh-index` while `index` is set, and as rbitcoin without it otherwise.
#[derive(Default)]
struct Node {
    index: AtomicBool,
    asked: Mutex<Vec<String>>,
}

async fn rpc() -> Json<Value> {
    Json(json!({"id": 0, "error": null, "result": {
        "chain": "regtest", "blocks": 0, "headers": 0,
        "bestblockhash": "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206",
        "bits": "207fffff", "target": "7fffff0000000000000000000000000000000000000000000000000000000000",
        "difficulty": 4.6e-10, "time": 1_296_688_602, "mediantime": 1_296_688_602,
        "verificationprogress": 1.0, "initialblockdownload": false,
        "chainwork": "0000000000000000000000000000000000000000000000000000000000000002",
        "size_on_disk": 1, "pruned": false
    }}))
}

async fn scripthash(
    State(node): State<Arc<Node>>,
    axum::extract::Path(h): axum::extract::Path<String>,
) -> Response {
    node.asked.lock().unwrap().push(h.clone());
    if !node.index.load(Ordering::SeqCst) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "scripthash index disabled (start with --sh-index)",
        )
            .into_response();
    }
    let none = json!({"funded_txo_count": 0, "funded_txo_sum": 0, "spent_txo_count": 0,
        "spent_txo_sum": 0, "tx_count": 0});
    Json(json!({"scripthash": h, "chain_stats": none, "mempool_stats": none})).into_response()
}

/// The mock node, and the Electrum listener the server connects to. Returns the server's vars.
async fn mock(node: &Arc<Node>) -> (HashMap<String, String>, TcpListener) {
    let app = axum::Router::new()
        .route("/", post(rpc))
        .route("/scripthash/{h}", get(scripthash))
        .with_state(Arc::clone(node));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await });
    let electrum = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let vars = [
        ("RPC_HOST", "127.0.0.1".to_owned()),
        ("RPC_PORT", addr.port().to_string()),
        ("RPC_USER", "u".to_owned()),
        ("RPC_PASSWORD", "p".to_owned()),
        ("ESPLORA_URL", format!("http://{addr}")),
        ("ELECTRUM_ADDR", electrum.local_addr().unwrap().to_string()),
        ("MEMPOOL_ENABLED", "false".to_owned()),
    ]
    .into_iter()
    .map(|(k, v)| (format!("REGTEST_{k}"), v))
    .collect();
    (vars, electrum)
}

async fn serve(vars: &HashMap<String, String>) -> String {
    capture();
    let mut config = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
    config.web_dir = Some(std::env::temp_dir().join("rbitcoin-space-no-web-dir"));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(App::new(&config).serve(listener, std::future::pending()));
    addr
}

/// One connection from the server's Electrum client, through its handshake.
struct Peer {
    _lines: Lines<BufReader<OwnedReadHalf>>,
    _wr: OwnedWriteHalf,
}

impl Peer {
    async fn connect(listener: &TcpListener) -> Peer {
        let (stream, _) = timeout(WAIT, listener.accept()).await.unwrap().unwrap();
        let (rd, mut wr) = stream.into_split();
        let mut lines = BufReader::new(rd).lines();
        let tip = bitcoin::constants::genesis_block(bitcoin::Network::Regtest).header;
        for (method, result) in [
            ("server.version", json!(["rbitcoin-electrs 0.9.2", "1.6"])),
            (
                "blockchain.headers.subscribe",
                json!({"height": 0, "hex": serialize_hex(&tip)}),
            ),
        ] {
            let line = timeout(WAIT, lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let req: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(req["method"], method);
            let reply = json!({"jsonrpc": "2.0", "id": req["id"], "result": result});
            wr.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
        }
        Peer {
            _lines: lines,
            _wr: wr,
        }
    }
}

async fn get_json(addr: &str, path: &str) -> (u16, Value) {
    let mut s = TcpStream::connect(addr).await.unwrap();
    let req = format!("GET {path} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut raw = String::new();
    s.read_to_string(&mut raw).await.unwrap();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    (
        head[9..12].parse().unwrap(),
        serde_json::from_str(body).unwrap(),
    )
}

/// `/readyz` once `ready(regtest detail)` holds.
async fn readyz_when(addr: &str, ready: impl Fn(&Value) -> bool) -> (u16, Value) {
    let deadline = Instant::now() + WAIT;
    loop {
        let (status, body) = get_json(addr, "/readyz").await;
        if ready(&body["networks"]["regtest"]) {
            return (status, body["networks"]["regtest"].clone());
        }
        assert!(Instant::now() < deadline, "never: {body}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// The log. Global per test binary.

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

fn events(names: &[&str]) -> Vec<Value> {
    logging::flush(Duration::from_secs(1));
    let raw = String::from_utf8(capture().0.lock().unwrap().clone()).unwrap();
    raw.lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|v| names.iter().any(|n| v["event"] == *n) && v["network"] == "regtest")
        .collect()
}

async fn logged(names: &[&str], n: usize) -> Vec<Value> {
    let deadline = Instant::now() + WAIT;
    loop {
        let found = events(names);
        if found.len() >= n {
            return found;
        }
        assert!(Instant::now() < deadline, "{names:?} not logged {n} times");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

const INDEX: [&str; 2] = ["address_index_on", "address_index_off"];

/// A node without `--sh-index` is found at startup, said once in the log and in `/readyz`,
/// without making the server unready; a restart with the index on is found at the reconnect.
#[tokio::test]
async fn the_address_index_is_asked_at_startup_and_after_each_reconnect() {
    let node = Arc::new(Node::default());
    let (vars, electrum) = mock(&node).await;
    let addr = serve(&vars).await;
    let (status, n) = readyz_when(&addr, |n| n["address_index"] == "unknown").await;
    assert_eq!((status, &n["store"]), (503, &json!("off")));

    let peer = Peer::connect(&electrum).await;
    let e = logged(&INDEX, 1).await;
    assert_eq!(
        (&e[0]["event"], &e[0]["level"]),
        (&json!("address_index_off"), &json!("warn"))
    );
    let (status, n) = readyz_when(&addr, |n| n["ready"] == true).await;
    assert_eq!((status, &n["address_index"]), (200, &json!("off")));
    // The cheapest question: one scripthash no script hashes to.
    assert_eq!(*node.asked.lock().unwrap(), [ZERO]);

    // The node restarted with the index on: the reconnect asks again.
    node.index.store(true, Ordering::SeqCst);
    drop(peer);
    let peer = Peer::connect(&electrum).await;
    let e = logged(&INDEX, 2).await;
    assert_eq!(
        (&e[1]["event"], &e[1]["level"]),
        (&json!("address_index_on"), &json!("info"))
    );
    let (status, _) = readyz_when(&addr, |n| n["address_index"] == "on").await;
    assert_eq!(status, 200);

    // The same answer again is asked, not logged.
    drop(peer);
    let _peer = Peer::connect(&electrum).await;
    let deadline = Instant::now() + WAIT;
    while node.asked.lock().unwrap().len() < 3 {
        assert!(
            Instant::now() < deadline,
            "not asked after the second reconnect"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(events(&INDEX).len(), 2);
}

/// `/readyz` says whether the store is there and writing, and never why: no path, no SQLite text.
#[tokio::test]
async fn readiness_reports_the_store_without_its_details() {
    let dir = std::env::temp_dir().join(format!("rbitcoin-space-operator-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    // A data directory that cannot be created: the file under it does not open.
    let blocked = dir.join("a-file");
    std::fs::write(&blocked, b"").unwrap();
    let (mut vars, _electrum) = mock(&Arc::default()).await;
    vars.insert(
        "DATA_DIR".into(),
        blocked.join("data").display().to_string(),
    );
    vars.insert("BACKFILL_ENABLED".into(), "false".into());
    let addr = serve(&vars).await;
    let (_, n) = readyz_when(&addr, |n| n["store"] == "open_failed").await;
    assert_eq!(n["store_written_secs_ago"], Value::Null);
    let text = n.to_string();
    assert!(
        !text.contains("a-file") && !text.contains("sqlite"),
        "{text}"
    );

    // One that opens: `ok` once the node is found on regtest, which lets the writers in.
    vars.insert("DATA_DIR".into(), dir.join("data").display().to_string());
    let addr = serve(&vars).await;
    let (_, n) = readyz_when(&addr, |n| n["store"] == "ok").await;
    assert!(
        n["store_written_secs_ago"].as_u64().is_none_or(|s| s < 10),
        "{n}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The commit at `/healthz` and in `server_starting`: the checkout's `HEAD` here, since tests
/// build from one; `unknown` without `.git` is checked by building from `git archive`
/// (docs/DEPLOY.md, "Health").
#[tokio::test]
async fn the_build_reports_its_revision() {
    let rev = rbitcoin_space::REVISION;
    assert!(
        rev == "unknown" || (rev.len() == 40 && rev.bytes().all(|b| b.is_ascii_hexdigit())),
        "{rev}"
    );
    let head = Command::new("git")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args(["rev-parse", "HEAD"])
        .output();
    if let Ok(out) = head
        && out.status.success()
    {
        assert_eq!(rev, String::from_utf8(out.stdout).unwrap().trim());
    }

    let addr = serve(&HashMap::new()).await;
    let (status, body) = get_json(&addr, "/healthz").await;
    assert_eq!(status, 200);
    assert_eq!(
        body,
        json!({"status": "ok", "version": env!("CARGO_PKG_VERSION"), "revision": rev})
    );

    // The binary's startup line, from the binary itself.
    let mut child = Command::new(env!("CARGO_BIN_EXE_rbitcoin-space"))
        .env_clear()
        .env("LISTEN_ADDR", "127.0.0.1:0")
        .env(
            "WEB_DIR",
            Path::new(env!("CARGO_MANIFEST_DIR")).join("no-web-dir"),
        )
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = std::io::BufReader::new(child.stdout.take().unwrap());
    let starting = stdout
        .lines()
        .map(|l| serde_json::from_str::<Value>(&l.unwrap()).unwrap())
        .find(|v| v["event"] == "server_starting");
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(starting.unwrap()["revision"], rev);
}
