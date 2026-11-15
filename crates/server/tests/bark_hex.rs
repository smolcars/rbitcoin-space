//! `POST /app/ark/bark/vtxo`, a Bark VTXO sent as hex, against a fake Esplora on port 0 that
//! holds ark-lib's round transaction (`fixtures/bark`). No Bark server is configured or reached.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::IntoResponse;
use bitcoin::Transaction;
use bitcoin::consensus::deserialize;
use bitcoin::hex::FromHex;
use logging::{Format, Level, Settings};
use rbitcoin_space::ark_bark::{CLIENT_BURST, MAX_SENT_BODY};
use rbitcoin_space::{App, Config};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const ROUTE: &str = "/regtest/app/ark/bark/vtxo";

fn vector(name: &str) -> String {
    let text = include_str!("../../../fixtures/bark/vectors.json");
    let json: Value = serde_json::from_str(text).unwrap();
    json["v2"][name].as_str().unwrap().to_owned()
}

/// The fake node: the round transaction by its txid, everything else unknown, or nothing at all
/// when `down`. Counts the raw transactions it is asked for.
struct Node {
    round: (String, Vec<u8>),
    down: bool,
    reads: AtomicUsize,
}

async fn esplora(State(node): State<Arc<Node>>, uri: Uri) -> impl IntoResponse {
    if node.down {
        return (StatusCode::INTERNAL_SERVER_ERROR, Vec::new());
    }
    if uri.path().ends_with("/raw") {
        node.reads.fetch_add(1, Ordering::SeqCst);
    }
    if uri.path() == format!("/tx/{}/raw", node.round.0) {
        return (StatusCode::OK, node.round.1.clone());
    }
    (StatusCode::NOT_FOUND, b"Transaction not found".to_vec())
}

async fn start(down: bool) -> (String, Arc<Node>) {
    capture();
    let raw = Vec::<u8>::from_hex(&vector("round_tx")).unwrap();
    let tx: Transaction = deserialize(&raw).unwrap();
    let node = Arc::new(Node {
        round: (tx.compute_txid().to_string(), raw),
        down,
        reads: AtomicUsize::new(0),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let esplora_url = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .fallback(esplora)
        .with_state(Arc::clone(&node));
    tokio::spawn(async move { axum::serve(listener, router).await });
    let vars: HashMap<&str, String> = [
        ("REGTEST_RPC_HOST", "127.0.0.1".to_owned()),
        ("REGTEST_RPC_PORT", "1".to_owned()),
        ("REGTEST_RPC_USER", "u".to_owned()),
        ("REGTEST_RPC_PASSWORD", "p".to_owned()),
        ("REGTEST_ESPLORA_URL", esplora_url),
        ("REGTEST_ELECTRUM_ADDR", "127.0.0.1:1".to_owned()),
        ("REGTEST_MEMPOOL_ENABLED", "false".to_owned()),
        ("TRUSTED_PROXY_HEADER", "X-Real-IP".to_owned()),
        ("TRUSTED_PROXIES", "127.0.0.1".to_owned()),
    ]
    .into_iter()
    .collect();
    let config = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(App::new(&config).serve(listener, std::future::pending()));
    (addr, node)
}

#[derive(Debug)]
struct Reply {
    status: u16,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }

    fn error(&self) -> String {
        self.json()["error"].as_str().unwrap_or_default().to_owned()
    }
}

async fn post(addr: &str, body: &[u8], ip: &str) -> Reply {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "POST {ROUTE} HTTP/1.1\r\nHost: t\r\nConnection: close\r\nX-Real-IP: {ip}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    // A refused body may be cut off mid-write; the answer still comes.
    let _ = stream.write_all(body).await;
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw).await;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    Reply {
        status: head[9..12].parse().unwrap(),
        body: raw[split + 4..].to_vec(),
    }
}

#[tokio::test]
async fn a_sent_vtxo_is_checked_as_one_looked_up_by_id_with_no_bark_server() {
    let (addr, node) = start(false).await;
    let hex = vector("arkoor3_vtxo");
    let r = post(&addr, hex.as_bytes(), "192.0.2.1").await;
    assert_eq!(r.status, 200, "{r:?}");
    // The very answer the by-id route writes for it (`ark_bark`'s recorded-answer test).
    let recorded: Value =
        serde_json::from_str(include_str!("../../../fixtures/bark/answer-arkoor3.json")).unwrap();
    assert_eq!(r.json(), recorded);
    assert_eq!(r.json()["signatures"], "valid");
    assert_eq!(node.reads.load(Ordering::SeqCst), 1);

    // The same bytes again are kept, in capitals too: the node is not asked twice.
    let again = post(&addr, hex.as_bytes(), "192.0.2.1").await;
    assert_eq!(again.status, 200);
    assert_eq!(node.reads.load(Ordering::SeqCst), 1);
    let upper = post(&addr, hex.to_uppercase().as_bytes(), "192.0.2.1").await;
    assert_eq!(upper.json(), recorded);
    assert_eq!(node.reads.load(Ordering::SeqCst), 1);

    // The body never reaches the log; the request line names the route.
    logging::flush(Duration::from_secs(1));
    let log = String::from_utf8(capture().0.lock().unwrap().clone()).unwrap();
    assert!(
        log.contains("\"route\":\"/regtest/app/ark/bark/vtxo\""),
        "{log}"
    );
    assert!(!log.contains(&hex[..64]), "the hex was logged");
    assert!(!log.contains(&hex[hex.len() - 64..]), "the hex was logged");
}

#[tokio::test]
async fn an_anchor_the_node_does_not_hold_leaves_it_unverified() {
    let (addr, _) = start(false).await;
    // board_vtxo hangs off anchor_tx, which this node does not hold.
    let r = post(&addr, vector("board_vtxo").as_bytes(), "192.0.2.2").await;
    assert_eq!(r.status, 200, "{r:?}");
    assert_eq!(r.json()["anchor"]["found"], false);
    assert_ne!(r.json()["signatures"], "valid");
}

#[tokio::test]
async fn what_is_not_a_vtxo_is_refused_plainly() {
    let (addr, node) = start(false).await;
    let hex = vector("arkoor3_vtxo");
    for (body, status, error) in [
        (String::new(), 400, "invalid vtxo hex"),
        ("abc".to_owned(), 400, "invalid vtxo hex"),
        ("zz".to_owned(), 400, "invalid vtxo hex"),
        (format!("{hex}\n"), 400, "invalid vtxo hex"),
        (format!(" {hex}"), 400, "invalid vtxo hex"),
        ("00".repeat(40), 400, "vtxo does not decode"),
        (format!("{hex}00"), 400, "vtxo does not decode"),
        ("ab".repeat(MAX_SENT_BODY / 2 + 1), 413, "vtxo too large"),
    ] {
        let r = post(&addr, body.as_bytes(), "192.0.2.3").await;
        assert_eq!(
            (r.status, r.error().as_str()),
            (status, error),
            "{}",
            &body[..body.len().min(40)]
        );
    }
    // None of them reached the node.
    assert_eq!(node.reads.load(Ordering::SeqCst), 0);

    // The point's vout changed: the chain no longer leads to it.
    let mut bytes = Vec::<u8>::from_hex(&hex).unwrap();
    *bytes.last_mut().unwrap() ^= 1;
    let r = post(&addr, hex_of(&bytes).as_bytes(), "192.0.2.3").await;
    assert_eq!((r.status, r.error().as_str()), (422, "vtxo did not verify"));
}

#[tokio::test]
async fn a_node_that_does_not_answer_is_a_bad_gateway() {
    let (addr, _) = start(true).await;
    let r = post(&addr, vector("arkoor3_vtxo").as_bytes(), "192.0.2.4").await;
    assert_eq!(
        (r.status, r.error().as_str()),
        (502, "upstream unavailable")
    );
}

#[tokio::test]
async fn a_client_starts_a_few_new_checks_then_waits() {
    let (addr, _) = start(false).await;
    let hex = vector("arkoor3_vtxo");
    let mut bytes = Vec::<u8>::from_hex(&hex).unwrap();
    let last = bytes.len() - 1;
    // Each one different (its point's vout), each one a check of its own.
    for n in 0..CLIENT_BURST {
        bytes[last] = u8::try_from(n + 1).unwrap();
        let r = post(&addr, hex_of(&bytes).as_bytes(), "192.0.2.5").await;
        assert_eq!(r.status, 422, "{n}");
    }
    bytes[last] = 0xff;
    let r = post(&addr, hex_of(&bytes).as_bytes(), "192.0.2.5").await;
    assert_eq!(r.status, 429);
    // One already checked costs nothing; another client is not held up.
    bytes[last] = 1;
    assert_eq!(
        post(&addr, hex_of(&bytes).as_bytes(), "192.0.2.5")
            .await
            .status,
        422
    );
    assert_eq!(post(&addr, hex.as_bytes(), "192.0.2.6").await.status, 200);
}

fn hex_of(b: &[u8]) -> String {
    use std::fmt::Write as _;
    b.iter().fold(String::new(), |mut s, x| {
        let _ = write!(s, "{x:02x}");
        s
    })
}

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
