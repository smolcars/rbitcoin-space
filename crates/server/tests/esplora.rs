//! The `/api` pass-through against a mock node on port 0. Nothing here reaches a real node.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use rbitcoin_space::esplora::{BROADCAST_BURST, LIVE, MAX_TX_BYTES};
use rbitcoin_space::{App, Config, IMMUTABLE, Limits};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const H: &str = "00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054";
/// A mainnet address, for the heavy routes.
const MAIN: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const TIP: &str = "00000000000000000000ec095818efb89e40f794c13326dbbdec38e1de395193";
/// A legacy (no witness) transaction: one input spending a null outpoint, one empty output.
const TX: &str = concat!(
    "01000000",
    "01",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "ffffffff",
    "0100",
    "ffffffff",
    "01",
    "0000000000000000",
    "00",
    "00000000"
);

/// Requests the mock node received: method, path and query, body.
type Seen = Arc<Mutex<Vec<(Method, String, Bytes)>>>;

/// A stand-in for rbitcoin's Esplora: canned answers, every request recorded, each answered
/// after `delay` so concurrent requests overlap.
async fn mock(delay: Duration) -> (String, Seen) {
    let seen: Seen = Arc::default();
    let log = Arc::clone(&seen);
    let app = Router::new().fallback(any(move |method: Method, uri: Uri, body: Bytes| {
        let log = Arc::clone(&log);
        async move {
            let pq = uri
                .path_and_query()
                .map(ToString::to_string)
                .unwrap_or_default();
            log.lock()
                .unwrap()
                .push((method.clone(), pq.clone(), body.clone()));
            tokio::time::sleep(delay).await;
            answer(&method, &pq, &body)
        }
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, seen)
}

fn answer(method: &Method, pq: &str, body: &[u8]) -> Response {
    let stamp = [
        ("x-bitcoin-chain-tip", TIP.to_owned()),
        ("x-bitcoin-chain-tip-height", "800001".to_owned()),
        ("x-powered-by", "rbitcoin-esplora/0.9.1".to_owned()),
        ("cache-control", "public, no-transform".to_owned()),
    ];
    let text = [("content-type", "text/plain; charset=utf-8")];
    let json = [("content-type", "application/json")];
    let octets = [("content-type", "application/octet-stream")];
    fn with(h: &[(&'static str, &str)], extra: &[(&'static str, String)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in h {
            m.insert(*k, v.parse().unwrap());
        }
        for (k, v) in extra {
            m.insert(*k, v.parse().unwrap());
        }
        m
    }
    if method == Method::GET
        && let Some(r) = block_answer(pq)
    {
        return r;
    }
    match (method.as_str(), pq) {
        ("GET", p) if p.starts_with("/blindbit/v1/") => {
            if p == "/blindbit/v1/block-hash/42" {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    with(&json, &[]),
                    r#"{"error":"private detail"}"#,
                )
                    .into_response();
            }
            if p == "/blindbit/v1/block-hash/43" {
                return (
                    StatusCode::NOT_FOUND,
                    with(&json, &[]),
                    r#"{"error":"height not indexed"}"#,
                )
                    .into_response();
            }
            (with(&json, &[]), r#"["00", "ff"]"#).into_response()
        }
        ("POST", "/blindbit/v1/forward-tx") => {
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(body).unwrap(),
                serde_json::json!({"data": TX})
            );
            (with(&json, &[]), format!("\"{H}\"")).into_response()
        }
        ("GET", "/blocks/tip/height") => (with(&text, &stamp), "800001").into_response(),
        ("GET", "/fee-estimates") => (with(&json, &[]), r#"{"1":2.5,"6":1.0}"#).into_response(),
        ("GET", p) if p == format!("/tx/{H}") => (
            with(&json, &stamp),
            format!(r#"{{"txid":"{H}","status":{{"confirmed":false}}}}"#),
        )
            .into_response(),
        ("GET", p) if p == format!("/tx/{H}/raw") => {
            let bytes = bitcoin::hex::FromHex::from_hex(TX)
                .map(|v: Vec<u8>| v)
                .unwrap();
            (with(&octets, &stamp), bytes).into_response()
        }
        ("GET", p) if p == format!("/block/{H}/raw") => {
            (with(&octets, &stamp), vec![0u8, 1, 2, 255]).into_response()
        }
        ("GET", p) if p.starts_with("/address/") => (
            StatusCode::SERVICE_UNAVAILABLE,
            with(&text, &[]),
            "scripthash index disabled (start with --sh-index)",
        )
            .into_response(),
        ("GET", p) if p.starts_with("/scripthash/") => (
            StatusCode::INTERNAL_SERVER_ERROR,
            with(&text, &[]),
            "internal error at /var/lib/rbitcoin/db",
        )
            .into_response(),
        ("POST", "/tx") if body == TX.as_bytes() => (with(&text, &[]), H).into_response(),
        ("POST", "/tx") => (
            StatusCode::BAD_REQUEST,
            with(&text, &[]),
            "durable: /var/lib/rbitcoin/mempool.db locked",
        )
            .into_response(),
        ("POST", p) if p.starts_with("/block-heights/txs/outs") => {
            (with(&json, &stamp), "[null,null]").into_response()
        }
        _ => (StatusCode::NOT_FOUND, with(&text, &stamp), "Not Found").into_response(),
    }
}

/// Blocks the mock node no longer serves: they left its best chain.
static GONE: Mutex<Vec<String>> = Mutex::new(Vec::new());
const BLOCKS_FROM: u64 = 0xb10c_0000_0000;

/// The hash the mock gives the block at `height`; the mock's tip is 800,001.
fn block_at(height: u64) -> String {
    format!("{:064x}", BLOCKS_FROM + height)
}

/// `/block/:hash`, `/header` and `/txids` for a [`block_at`] hash, stamped with the tip.
fn block_answer(pq: &str) -> Option<Response> {
    let rest = pq.strip_prefix("/block/")?;
    let (hash, tail) = rest.split_at_checked(64)?;
    let height = u64::from_str_radix(hash, 16)
        .ok()?
        .checked_sub(BLOCKS_FROM)?;
    if height > 800_001 {
        return None;
    }
    if GONE.lock().unwrap().iter().any(|g| g == hash) {
        return Some((StatusCode::NOT_FOUND, "Block not found").into_response());
    }
    let mut h = HeaderMap::new();
    h.insert("x-bitcoin-chain-tip", TIP.parse().unwrap());
    h.insert("x-bitcoin-chain-tip-height", "800001".parse().unwrap());
    let json = || "application/json".parse().unwrap();
    let body = match tail {
        "" => {
            h.insert("content-type", json());
            serde_json::json!({"id": hash, "height": height, "version": 536870912,
                "timestamp": 1_700_000_000, "tx_count": 1, "size": 300, "weight": 1200,
                "merkle_root": H, "previousblockhash": block_at(height - 1),
                "mediantime": 1_699_999_000, "nonce": 7, "bits": 386_000_000,
                "difficulty": 1.0})
            .to_string()
        }
        "/header" => {
            h.insert("content-type", "text/plain".parse().unwrap());
            "00".repeat(80)
        }
        "/txids" => {
            h.insert("content-type", json());
            format!("[\"{H}\"]")
        }
        _ => return None,
    };
    Some((h, body).into_response())
}

fn config(esplora: &str, broadcast: bool) -> Config {
    let mut vars = HashMap::new();
    for net in ["MAINNET", "SIGNET"] {
        for (k, v) in [
            ("RPC_HOST", "127.0.0.1"),
            ("RPC_PORT", "1"),
            ("RPC_USER", "u"),
            ("RPC_PASSWORD", "p"),
            ("ESPLORA_URL", esplora),
            ("ELECTRUM_ADDR", "127.0.0.1:1"),
        ] {
            vars.insert(format!("{net}_{k}"), v.to_owned());
        }
    }
    vars.insert(
        "BROADCAST_ENABLED".into(),
        if broadcast { "true" } else { "false" }.into(),
    );
    let mut c = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
    c.web_dir = Some(std::env::temp_dir().join("rbitcoin-space-no-web-dir"));
    c.limits = Limits {
        client_burst: 10_000,
        client_rate_per_sec: 10_000,
        client_connections: 10_000,
        client_requests: 10_000,
        max_requests: 10_000,
        ..Limits::default()
    };
    c
}

/// Starts the server against a fresh mock node; returns the server address and the mock's log.
async fn start(delay: Duration, broadcast: bool) -> (String, Seen) {
    let (url, seen) = mock(delay).await;
    let app = App::new(&config(&url, broadcast));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(app.serve(listener, std::future::pending()));
    (addr, seen)
}

#[derive(Debug)]
struct Reply {
    status: u16,
    head: String,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.head
            .lines()
            .find_map(|l| l.strip_prefix(&format!("{name}: ")))
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// Our own error body: `{"error": message}`.
    fn error(&self) -> String {
        let v: serde_json::Value = serde_json::from_slice(&self.body).unwrap();
        v["error"].as_str().unwrap().to_owned()
    }
}

/// Sends the request line exactly as written, so hostile targets reach the server unaltered.
async fn send(addr: &str, line: &str, headers: &str, body: &[u8]) -> Reply {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "{line} HTTP/1.1\r\nHost: test\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n",
        body.len()
    );
    let mut bytes = head.into_bytes();
    bytes.extend_from_slice(body);
    let _ = stream.write_all(&bytes).await;
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw).await;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    Reply {
        status: head[9..12].parse().unwrap(),
        head,
        body: raw[split + 4..].to_vec(),
    }
}

async fn get(addr: &str, target: &str) -> Reply {
    send(addr, &format!("GET {target}"), "", b"").await
}

async fn post(addr: &str, target: &str, body: &[u8]) -> Reply {
    send(addr, &format!("POST {target}"), "", body).await
}

fn hits(seen: &Seen) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .map(|(_, p, _)| p.clone())
        .collect()
}

#[tokio::test]
async fn responses_are_forwarded_byte_for_byte_with_our_headers() {
    let (addr, seen) = start(Duration::ZERO, true).await;
    for prefix in ["", "/signet"] {
        let r = get(&addr, &format!("{prefix}/api/tx/{H}")).await;
        assert_eq!(r.status, 200, "{r:?}");
        assert_eq!(
            r.text(),
            format!(r#"{{"txid":"{H}","status":{{"confirmed":false}}}}"#)
        );
        assert_eq!(r.header("content-type"), Some("application/json"));
        assert_eq!(r.header("x-bitcoin-chain-tip"), Some(TIP));
        assert_eq!(r.header("x-bitcoin-chain-tip-height"), Some("800001"));
        assert_eq!(r.header("cache-control"), Some(LIVE));
        assert_eq!(r.header("access-control-allow-origin"), Some("*"));
        // Each header docs/API.md lets a cross-origin caller read is exposed, in any order.
        let exposed: Vec<String> = r
            .header("access-control-expose-headers")
            .unwrap_or_default()
            .split(',')
            .map(|h| h.trim().to_ascii_lowercase())
            .collect();
        for h in [
            "x-bitcoin-chain-tip",
            "x-bitcoin-chain-tip-height",
            "x-request-id",
            "x-data-from-height",
            "x-data-from-time",
            "x-data-complete",
            "x-fee-source",
        ] {
            assert!(exposed.iter().any(|e| e == h), "{h} not in {exposed:?}");
        }
        assert!(
            r.header("x-powered-by").is_none(),
            "upstream headers are not copied"
        );
        assert!(r.header("content-security-policy").is_some());
    }
    let raw = get(&addr, &format!("/api/block/{H}/raw")).await;
    assert_eq!(raw.body, [0u8, 1, 2, 255]);
    assert_eq!(raw.header("content-type"), Some("application/octet-stream"));
    assert_eq!(
        hits(&seen),
        [
            format!("/tx/{H}"),
            format!("/tx/{H}"),
            format!("/block/{H}/raw")
        ]
    );
}

#[tokio::test]
async fn cache_headers_per_route_class() {
    let (addr, _) = start(Duration::ZERO, true).await;
    for (path, cache) in [
        (format!("/api/block/{H}/raw"), IMMUTABLE),
        // TX has no witness, so its bytes are fixed by its txid.
        (format!("/api/tx/{H}/raw"), IMMUTABLE),
        (format!("/api/tx/{H}"), LIVE),
        ("/api/blocks/tip/height".into(), LIVE),
        ("/api/fee-estimates".into(), LIVE),
        // Errors and refusals are never cached.
        (format!("/api/block/{H}"), "no-store"),
        ("/api/nope".into(), "no-store"),
        ("/api/tx/zz".into(), "no-store"),
    ] {
        let r = get(&addr, &path).await;
        assert_eq!(r.header("cache-control"), Some(cache), "{path}: {r:?}");
    }
}

#[tokio::test]
async fn upstream_errors_become_our_fixed_messages() {
    let (addr, _) = start(Duration::ZERO, true).await;
    let r = get(&addr, &format!("/api/block/{H}")).await;
    assert_eq!((r.status, r.error()), (404, "not found".into()));
    let r = get(
        &addr,
        "/api/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    )
    .await;
    assert_eq!(r.status, 503);
    assert_eq!(r.error(), "address index is disabled on this server");
    let r = get(&addr, &format!("/api/scripthash/{H}/utxo")).await;
    assert_eq!((r.status, r.error()), (502, "upstream unavailable".into()));
    assert!(!r.text().contains("/var"));
    let r = post(&addr, "/api/tx", b"01000000000000000000").await;
    assert_eq!(r.status, 400);
    // The node is down: 502, never a hang or a panic.
    let app = App::new(&config("http://127.0.0.1:1", true));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let down = listener.local_addr().unwrap().to_string();
    tokio::spawn(app.serve(listener, std::future::pending()));
    let r = get(&down, "/api/blocks/tip/height").await;
    assert_eq!((r.status, r.error()), (502, "upstream unavailable".into()));
}

#[tokio::test]
async fn the_node_sees_only_paths_we_wrote() {
    let (addr, seen) = start(Duration::ZERO, true).await;
    let addr_upper = "BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ";
    let r = get(
        &addr,
        &format!(
            "/api/address/{addr_upper}/txs?after_txid={}&asof={H}",
            H.to_uppercase()
        ),
    )
    .await;
    assert_eq!(r.status, 503);
    let r = get(&addr, &format!("/api/block/{H}/txs")).await;
    assert_eq!(r.status, 404);
    assert_eq!(
        hits(&seen),
        [
            format!(
                "/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq/txs?after_txid={H}&asof={H}"
            ),
            format!("/block/{H}/txs/0"),
        ]
    );
}

#[tokio::test]
async fn hostile_requests_never_reach_the_node() {
    let (addr, seen) = start(Duration::ZERO, true).await;
    let long = "a".repeat(8000);
    let cases = [
        ("/api/internal/txs".to_owned(), 404),
        ("/api/internal/mempool/txs/all".into(), 404),
        ("/api/../internal/txs".into(), 404),
        (
            "/api/tx/..%2F..%2Finternal%2Fmempool%2Ftxs%2Fall".into(),
            400,
        ),
        (format!("/api/tx/{}%2Fraw", &H[..58]), 400),
        ("/api/block/%2e%2e".into(), 400),
        ("/api//blocks".into(), 404),
        ("/api/blocks/tip/height/".into(), 404),
        (format!("/api/tx/{long}"), 400),
        (format!("/api/address/{long}"), 400),
        ("/api/blocks/tip/height?cb=1".into(), 400),
        (format!("/api/tx/{H}?asof={H}"), 400),
        (format!("/api/tx/{H}/status?asof=..%2F"), 400),
        (
            "/api/address/tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx".into(),
            400,
        ),
        ("/api/block-template".into(), 404),
        ("/api/txs/package".into(), 404),
        ("/api/v1/fees/unknown".into(), 404),
        (
            "/signet/api/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq".into(),
            400,
        ),
    ];
    for (path, status) in &cases {
        let r = get(&addr, path).await;
        assert_eq!(r.status, *status, "{path}: {}", r.text());
        assert_eq!(r.header("content-type"), Some("application/json"), "{path}");
    }
    for (line, status) in [
        (format!("POST /api/tx/{H}"), 405),
        ("GET /api/tx".to_owned(), 405),
        ("DELETE /api/mempool".into(), 405),
        ("POST /api/txs/test".into(), 404),
        ("POST /api/addresses/txs".into(), 404),
        ("POST /api/internal/txs".into(), 404),
    ] {
        let r = send(&addr, &line, "", b"[]").await;
        assert_eq!(r.status, status, "{line}: {}", r.text());
    }
    assert!(hits(&seen).is_empty(), "{:?}", hits(&seen));
}

#[tokio::test]
async fn identical_concurrent_requests_make_one_upstream_call() {
    let (addr, seen) = start(Duration::from_millis(300), true).await;
    let path = format!("/api/tx/{H}");
    let mut tasks = Vec::new();
    // Under the OS accept backlog (128 on macOS), so no connection is refused before it is served.
    for _ in 0..100 {
        let (addr, path) = (addr.clone(), path.clone());
        tasks.push(tokio::spawn(async move { get(&addr, &path).await }));
    }
    for t in tasks {
        let r = t.await.unwrap();
        assert_eq!(r.status, 200);
        assert!(r.text().contains(H));
    }
    assert_eq!(hits(&seen).len(), 1);
    // Not a cache: once answered, the next request asks the node again.
    get(&addr, &path).await;
    assert_eq!(hits(&seen).len(), 2);
}

#[tokio::test]
async fn hot_answers_are_held_briefly() {
    let (addr, seen) = start(Duration::ZERO, true).await;
    for _ in 0..50 {
        assert_eq!(get(&addr, "/api/fee-estimates").await.status, 200);
        assert_eq!(get(&addr, "/signet/api/fee-estimates").await.status, 200);
    }
    // One call per network: each network has its own node.
    assert_eq!(hits(&seen).len(), 2);
    tokio::time::sleep(Duration::from_millis(1100)).await;
    get(&addr, "/api/fee-estimates").await;
    assert_eq!(hits(&seen).len(), 3);
}

#[tokio::test]
async fn broadcast_is_parsed_rebuilt_and_limited() {
    let (addr, seen) = start(Duration::ZERO, true).await;
    // Uppercase hex with whitespace reaches the node as canonical lowercase.
    let r = post(
        &addr,
        "/api/tx",
        format!("  {}\n", TX.to_uppercase()).as_bytes(),
    )
    .await;
    assert_eq!((r.status, r.text()), (200, H.to_owned()), "{r:?}");
    assert_eq!(r.header("cache-control"), Some("no-store"));
    assert_eq!(r.header("access-control-allow-origin"), Some("*"));
    {
        let log = seen.lock().unwrap();
        assert_eq!((log[0].1.as_str(), &log[0].2[..]), ("/tx", TX.as_bytes()));
    }
    // Garbage and oversized bodies are refused before the node is asked.
    for body in [b"zz".to_vec(), format!("{TX}00").into_bytes(), vec![]] {
        assert_eq!(post(&addr, "/api/tx", &body).await.status, 400);
    }
    let big = "00".repeat(MAX_TX_BYTES + 100);
    assert_eq!(post(&addr, "/api/tx", big.as_bytes()).await.status, 413);
    assert_eq!(hits(&seen).len(), 1);
    // Refused bodies spent tokens too: five attempts, then one per ten seconds.
    assert_eq!(BROADCAST_BURST, 5);
    let r = post(&addr, "/api/tx", TX.as_bytes()).await;
    assert_eq!((r.status, r.header("retry-after")), (429, Some("10")));
    assert_eq!(hits(&seen).len(), 1);
    // Reads are not affected by the broadcast limit.
    assert_eq!(get(&addr, "/api/fee-estimates").await.status, 200);
}

#[tokio::test]
async fn broadcast_rejects_are_not_forwarded() {
    let (addr, _) = start(Duration::ZERO, true).await;
    let other = TX.replace("0100ffffffff", "0151ffffffff");
    let r = post(&addr, "/api/tx", other.as_bytes()).await;
    assert_eq!((r.status, r.error()), (400, "transaction rejected".into()));
}

#[tokio::test]
async fn broadcast_can_be_switched_off() {
    let (addr, seen) = start(Duration::ZERO, false).await;
    let r = post(&addr, "/api/tx", TX.as_bytes()).await;
    assert_eq!(
        (r.status, r.error()),
        (403, "broadcast is disabled on this server".into())
    );
    assert!(hits(&seen).is_empty());
}

#[tokio::test]
async fn output_batches_are_rebuilt_from_parsed_positions() {
    let (addr, seen) = start(Duration::ZERO, true).await;
    let r = post(
        &addr,
        &format!("/api/block-heights/txs/outs?asof={H}"),
        b" [ [1, 2, 3], [4,5,6] ] ",
    )
    .await;
    assert_eq!((r.status, r.text()), (200, "[null,null]".into()));
    {
        let log = seen.lock().unwrap();
        assert_eq!(log[0].1, format!("/block-heights/txs/outs?asof={H}"));
        assert_eq!(&log[0].2[..], b"[[1,2,3],[4,5,6]]");
    }
    for (body, status) in [
        (b"[[1,2]]".to_vec(), 400),
        (b"[[1,2,-3]]".to_vec(), 400),
        (b"[[1,2,4294967296]]".to_vec(), 400),
        (b"{\"a\":1}".to_vec(), 400),
        (
            format!("[{}[0,0,0]]", "[0,0,0],".repeat(300)).into_bytes(),
            422,
        ),
        (vec![b' '; 20_000], 413),
    ] {
        let r = post(&addr, "/api/block-heights/txs/outs", &body).await;
        assert_eq!(r.status, status, "{}", r.text());
    }
    assert_eq!(hits(&seen).len(), 1);
}

#[tokio::test]
async fn cors_preflight_and_scope() {
    let (addr, seen) = start(Duration::ZERO, true).await;
    let r = send(
        &addr,
        "OPTIONS /signet/api/tx",
        "Origin: https://wallet.example\r\nAccess-Control-Request-Method: POST\r\n",
        b"",
    )
    .await;
    assert_eq!(r.status, 204);
    assert_eq!(r.header("access-control-allow-origin"), Some("*"));
    assert_eq!(
        r.header("access-control-allow-methods"),
        Some("get, head, post")
    );
    assert_eq!(
        r.header("access-control-allow-headers"),
        Some("content-type")
    );
    assert!(r.header("content-security-policy").is_some());
    assert!(hits(&seen).is_empty());
    // Pages and the private API are same-origin only.
    for path in ["/", "/healthz", "/app/x", "/apix"] {
        let r = get(&addr, path).await;
        assert!(r.header("access-control-allow-origin").is_none(), "{path}");
    }
}

#[tokio::test]
async fn responses_carry_an_outcome_for_the_request_log() {
    use axum::extract::ConnectInfo;
    use rbitcoin_space::esplora::{ApiOutcome, Source};
    use tower::ServiceExt;

    let (url, _) = mock(Duration::ZERO).await;
    let router = App::new(&config(&url, true)).router();
    let call = |path: &str| {
        let mut req = axum::http::Request::get(path)
            .body(axum::body::Body::empty())
            .unwrap();
        req.extensions_mut()
            .insert(ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 9))));
        router.clone().oneshot(req)
    };
    let first = call("/api/fee-estimates").await.unwrap();
    let outcome = *first.extensions().get::<ApiOutcome>().unwrap();
    assert_eq!(outcome.route, "fee_estimates");
    assert!(matches!(outcome.source, Source::Upstream(_)));
    assert_eq!(outcome.upstream_error, None);
    let second = call("/signet/api/fee-estimates").await.unwrap();
    assert!(matches!(
        second.extensions().get::<ApiOutcome>().unwrap().source,
        Source::Upstream(_)
    ));
    let hot = call("/api/fee-estimates").await.unwrap();
    assert_eq!(
        hot.extensions().get::<ApiOutcome>().unwrap().source,
        Source::Hot
    );
    // An upstream 404 still went upstream; a request refused before that has no outcome.
    let missing = call(&format!("/api/block/{H}")).await.unwrap();
    assert_eq!(
        missing.extensions().get::<ApiOutcome>().unwrap().route,
        "block"
    );
    let refused = call("/api/tx/zz").await.unwrap();
    assert!(refused.extensions().get::<ApiOutcome>().is_none());
}

#[tokio::test]
async fn heavy_routes_have_a_cost_limit_that_outlives_the_request() {
    use rbitcoin_space::config::{IpNet, TrustedProxy};
    use rbitcoin_space::esplora::{HEAVY_PENDING, HEAVY_RUNNING, HeavyShare};
    assert_eq!((HEAVY_RUNNING, HEAVY_PENDING), (4, 12));
    // The node takes 3 s per answer; our requests give up after 1 s.
    let (url, seen) = mock(Duration::from_secs(3)).await;
    let mut c = config(&url, false);
    c.limits.request_timeout = Duration::from_secs(1);
    // A client's share follows its general limits: 24 requests at once make 2 heavy ones.
    c.limits.client_requests = 24;
    assert_eq!(HeavyShare::of(&c.limits).pending, 2);
    // Requests come from loopback and name their client, so one test can be several clients.
    c.limits.trusted_proxy = Some(TrustedProxy {
        header: "x-real-ip".parse().unwrap(),
        proxies: vec![IpNet::parse("127.0.0.1").unwrap()],
    });
    let app = App::new(&c);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(app.serve(listener, std::future::pending()));

    // `?asof=` makes each request its own key, as an attacker would. A history page: totals of
    // an address not known to be small go one at a time for the whole server (`ledger`), and
    // `large_address_totals_go_one_at_a_time` tests that.
    let heavy = |client: u8, n: u32| {
        let addr = addr.clone();
        tokio::spawn(async move {
            let line = format!("GET /api/address/{MAIN}/txs/chain?asof={n:064x}");
            send(
                &addr,
                &line,
                &format!("X-Real-IP: 192.0.2.{client}\r\n"),
                b"",
            )
            .await
        })
    };
    let address_calls = |seen: &Seen| {
        hits(seen)
            .iter()
            .filter(|p| p.starts_with("/address/"))
            .count()
    };
    let settle = || tokio::time::sleep(Duration::from_millis(200));
    let mut waiting = vec![heavy(1, 1), heavy(1, 2)];
    settle().await;
    // A third from the same client is refused at once.
    let r = heavy(1, 3).await.unwrap();
    assert_eq!((r.status, r.error().as_str()), (429, "too many requests"));
    // Five more clients fill the network's twelve places: four run, eight wait.
    for client in 2..=6 {
        waiting.extend([
            heavy(client, u32::from(client) * 10),
            heavy(client, u32::from(client) * 10 + 1),
        ]);
    }
    settle().await;
    assert_eq!(address_calls(&seen), 4, "only four run at once");
    // Anyone else is told to retry: one that waited for a place would have timed out first (504).
    let r = heavy(7, 7).await.unwrap();
    assert_eq!((r.status, r.error().as_str()), (503, "node busy; retry"));
    assert_eq!(r.header("retry-after"), Some("1"));
    // Joining a call already running needs no place, and cheap routes are not limited at all
    // (this one reaches the slow node like any read, and times out like one).
    waiting.push(heavy(8, 1));
    assert_eq!(get(&addr, &format!("/api/tx/{H}/status")).await.status, 504);
    // Every request gives up after 1 s...
    for r in waiting {
        assert_eq!(r.await.unwrap().status, 504);
    }
    // ...but the node is still working on four calls, so a new one waits behind them, and
    // gives up too, without reaching the node.
    assert_eq!(heavy(9, 9).await.unwrap().status, 504);
    assert_eq!(
        address_calls(&seen),
        4,
        "slots were freed while the node still worked"
    );
    // Once the node has answered, the slots are free again.
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert_eq!(heavy(9, 10).await.unwrap().status, 504);
    assert_eq!(address_calls(&seen), 5);
}

#[tokio::test]
async fn a_heavy_call_outlives_its_first_request_without_being_repeated() {
    use rbitcoin_space::config::{IpNet, TrustedProxy};
    // The node takes 3 s per answer; our requests give up after 1 s.
    let (url, seen) = mock(Duration::from_secs(3)).await;
    let mut c = config(&url, false);
    c.limits.request_timeout = Duration::from_secs(1);
    c.limits.client_requests = 24;
    c.limits.trusted_proxy = Some(TrustedProxy {
        header: "x-real-ip".parse().unwrap(),
        proxies: vec![IpNet::parse("127.0.0.1").unwrap()],
    });
    let app = App::new(&c);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(app.serve(listener, std::future::pending()));
    let heavy = |client: u8, n: u32| {
        let addr = addr.clone();
        tokio::spawn(async move {
            let line = format!("GET /api/address/{MAIN}?asof={n:064x}");
            send(
                &addr,
                &line,
                &format!("X-Real-IP: 192.0.2.{client}\r\n"),
                b"",
            )
            .await
        })
    };
    let calls = |seen: &Seen| {
        hits(seen)
            .iter()
            .filter(|p| p.starts_with("/address/"))
            .count()
    };

    let first = heavy(1, 1);
    tokio::time::sleep(Duration::from_millis(500)).await;
    // Joins the running call, then outlives the request that started it.
    let follower = heavy(2, 1);
    assert_eq!(first.await.unwrap().status, 504);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        calls(&seen),
        1,
        "the follower must not start the call again"
    );
    assert_eq!(follower.await.unwrap().status, 504);
    // With no request left, the call still runs and is still joined, not repeated.
    assert_eq!(heavy(3, 1).await.unwrap().status, 504);
    assert_eq!(calls(&seen), 1);
}

// Immutable answers kept in memory (`crate::answers`).

fn calls(seen: &Seen, path: &str) -> usize {
    hits(seen).iter().filter(|p| *p == path).count()
}

#[tokio::test]
async fn a_buried_block_is_kept_and_a_recent_one_is_not() {
    let (addr, seen) = start(Duration::ZERO, false).await;
    let buried = block_at(700_000);
    let mut bodies = Vec::new();
    for _ in 0..3 {
        let r = get(&addr, &format!("/api/block/{buried}")).await;
        assert_eq!(r.status, 200, "{r:?}");
        assert_eq!(r.header("cache-control"), Some(IMMUTABLE));
        assert_eq!(r.header("content-type"), Some("application/json"));
        bodies.push(r.body);
    }
    assert!(bodies.iter().all(|b| *b == bodies[0]));
    assert_eq!(calls(&seen, &format!("/block/{buried}")), 1);
    // The block's other immutable routes: its height is known from its JSON.
    for tail in ["/header", "/txids"] {
        for _ in 0..3 {
            assert_eq!(
                get(&addr, &format!("/api/block/{buried}{tail}"))
                    .await
                    .status,
                200
            );
        }
        assert_eq!(calls(&seen, &format!("/block/{buried}{tail}")), 1, "{tail}");
    }
    // Within 100 blocks of the tip, the tip itself, and a block whose height we never learnt:
    // every request asks the node, as before.
    let unknown = block_at(600_000);
    for path in [
        format!("/block/{}", block_at(799_902)),
        format!("/block/{}", block_at(800_001)),
        format!("/block/{unknown}/header"),
    ] {
        for _ in 0..3 {
            assert_eq!(get(&addr, &format!("/api{path}")).await.status, 200);
        }
        assert_eq!(calls(&seen, &path), 3, "{path}");
    }
}

#[tokio::test]
async fn a_block_that_leaves_the_chain_before_it_is_buried_is_never_kept() {
    let (addr, seen) = start(Duration::ZERO, false).await;
    let recent = block_at(799_950);
    let path = format!("/api/block/{recent}");
    assert_eq!(get(&addr, &path).await.status, 200);
    // A reorg: the node drops the block from its best chain and answers 404 for it.
    GONE.lock().unwrap().push(recent.clone());
    let r = get(&addr, &path).await;
    assert_eq!(
        (r.status, r.header("cache-control")),
        (404, Some("no-store"))
    );
    assert_eq!(calls(&seen, &format!("/block/{recent}")), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_distinct_blocks_cost_one_call_each_and_stay_inside_the_budget() {
    let (url, seen) = mock(Duration::ZERO).await;
    let mut c = config(&url, false);
    c.limits.answer_cache_bytes = 1 << 20;
    let app = App::new(&c);
    let ctx = app.network(rbitcoin_space::Network::Mainnet).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(app.serve(listener, std::future::pending()));
    // A block in use, asked for twice.
    let hot = format!("/block/{}", block_at(1));
    for _ in 0..2 {
        assert_eq!(get(&addr, &format!("/api{hot}")).await.status, 200);
    }
    // A client walking 3,000 distinct buried blocks, about three times the budget.
    let walk: Vec<u64> = (100..3_100).collect();
    for chunk in walk.chunks(100) {
        let asks = chunk.iter().map(|&h| {
            let addr = addr.clone();
            async move {
                get(&addr, &format!("/api/block/{}", block_at(h)))
                    .await
                    .status
            }
        });
        for status in futures_join(asks).await {
            assert_eq!(status, 200);
        }
        assert!(ctx.answers.held().0 <= 1 << 20);
    }
    // One node call per distinct block, as without the cache; the block in use is still kept.
    for h in [100, 1_600, 3_099] {
        assert_eq!(calls(&seen, &format!("/block/{}", block_at(h))), 1);
    }
    assert_eq!(get(&addr, &format!("/api{hot}")).await.status, 200);
    assert_eq!(calls(&seen, &hot), 1);
    assert!(ctx.answers.held().1 < 3_000);
}

/// Runs the futures together, in order of their results.
async fn futures_join<F: std::future::Future<Output = u16> + Send + 'static>(
    fs: impl Iterator<Item = F>,
) -> Vec<u16> {
    let tasks: Vec<_> = fs.map(tokio::spawn).collect();
    let mut out = Vec::new();
    for t in tasks {
        out.push(t.await.unwrap());
    }
    out
}

/// A node that counts its address calls and holds each open until the gate opens, then answers
/// `status`.
struct Gated {
    url: String,
    calls: Arc<std::sync::atomic::AtomicUsize>,
    gate: tokio::sync::watch::Sender<bool>,
}

impl Gated {
    async fn start(status: StatusCode) -> Self {
        use std::sync::atomic::Ordering;
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (gate, open) = tokio::sync::watch::channel(false);
        let counted = Arc::clone(&calls);
        let app = Router::new().fallback(any(move |uri: Uri| {
            let (counted, mut open) = (Arc::clone(&counted), open.clone());
            async move {
                if uri.path().starts_with("/address/") {
                    counted.fetch_add(1, Ordering::SeqCst);
                }
                let _ = open.wait_for(|o| *o).await;
                (status, [("content-type", "application/json")], "[]").into_response()
            }
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { url, calls, gate }
    }

    fn calls(&self) -> usize {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Waits until the node has received `n` calls.
    async fn until(&self, n: usize) {
        while self.calls() < n {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Our server in front of this node, with `history_timeout` for history pages.
    async fn server(&self, history_timeout: Duration) -> String {
        let mut c = config(&self.url, false);
        c.limits.history_timeout = history_timeout;
        let app = App::new(&c);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        tokio::spawn(app.serve(listener, std::future::pending()));
        addr
    }
}

/// `n` clients asking for `target` at once.
fn many(addr: &str, target: &str, n: usize) -> Vec<tokio::task::JoinHandle<Reply>> {
    (0..n)
        .map(|_| {
            let (addr, target) = (addr.to_owned(), target.to_owned());
            tokio::spawn(async move { get(&addr, &target).await })
        })
        .collect()
}

/// A client that sends its request and hangs up without reading the answer.
async fn hang_up(addr: &str, target: &str) -> TcpStream {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let head = format!("GET {target} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    stream
}

/// SECURITY.md rule 8 on the heavy routes: every client asking for one key at the same moment
/// gets one node call, even when the client that started it hangs up before the node answers.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_heavy_key_costs_one_node_call_however_its_clients_come_and_go() {
    let node = Gated::start(StatusCode::OK).await;
    let addr = node.server(Duration::from_secs(5)).await;
    let target = format!("/api/address/{MAIN}");
    let first = hang_up(&addr, &target).await;
    node.until(1).await;
    let waiting = many(&addr, &target, 50);
    tokio::time::sleep(Duration::from_millis(300)).await;
    // The client that started the call is gone; the call is not started again for the others.
    drop(first);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(node.calls(), 1);
    node.gate.send_replace(true);
    for r in waiting {
        let r = r.await.unwrap();
        assert_eq!((r.status, r.text().as_str()), (200, "[]"));
    }
    assert_eq!(node.calls(), 1);
    // Not a cache: once answered, the next request asks the node again.
    assert_eq!(get(&addr, &target).await.status, 200);
    assert_eq!(node.calls(), 2);
}

/// A call the node fails is shared with the requests that waited for it, and with no request
/// that arrives after it ended.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_heavy_call_is_shared_only_while_it_runs() {
    let node = Gated::start(StatusCode::INTERNAL_SERVER_ERROR).await;
    let addr = node.server(Duration::from_secs(5)).await;
    let target = format!("/api/address/{MAIN}");
    let first = hang_up(&addr, &target).await;
    node.until(1).await;
    let waiting = many(&addr, &target, 50);
    tokio::time::sleep(Duration::from_millis(300)).await;
    drop(first);
    tokio::time::sleep(Duration::from_millis(100)).await;
    node.gate.send_replace(true);
    let answers = replies(waiting).await;
    assert!(answers.iter().all(|r| r.status == 502), "{answers:?}");
    assert_eq!(node.calls(), 1);
    // Arriving after the failure: a call of its own, not the failure again.
    assert_eq!(get(&addr, &target).await.status, 502);
    assert_eq!(node.calls(), 2);
}

/// A page of history the node takes too long over: one node call, every waiting request answered
/// `504` at the history timeout, and nothing new sent to the node while it is still working.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_heavy_call_that_times_out_is_one_node_call() {
    let node = Gated::start(StatusCode::OK).await;
    let addr = node.server(Duration::from_millis(600)).await;
    let target = format!("/api/address/{MAIN}/txs");
    let first = hang_up(&addr, &target).await;
    node.until(1).await;
    let waiting = many(&addr, &target, 50);
    tokio::time::sleep(Duration::from_millis(200)).await;
    drop(first);
    for r in replies(waiting).await {
        assert_eq!(r.status, 504);
    }
    // The node is still working on it: a request now is refused from what it learned.
    assert_eq!(get(&addr, &target).await.status, 504);
    assert_eq!(node.calls(), 1);
    node.gate.send_replace(true);
}

async fn replies(tasks: Vec<tokio::task::JoinHandle<Reply>>) -> Vec<Reply> {
    let mut out = Vec::with_capacity(tasks.len());
    for t in tasks {
        out.push(t.await.unwrap());
    }
    out
}

#[tokio::test]
async fn blindbit_routes_are_typed_and_forwarded_on_each_network() {
    let (addr, seen) = start(Duration::ZERO, false).await;
    let paths = [
        "info",
        "block-height",
        "block-hash/0007",
        "tweaks/7?dustLimit=000546",
        "tweak-index/7?dustLimit=18446744073709551615",
        "utxos/7",
        "spent-index/7",
        "filter/new-utxos/7",
        "filter/spent/7",
    ];
    for prefix in ["", "/signet"] {
        for path in paths {
            let r = get(&addr, &format!("{prefix}/api/blindbit/v1/{path}")).await;
            assert_eq!(r.status, 200, "{path}: {r:?}");
            assert_eq!(r.text(), r#"["00", "ff"]"#);
            assert_eq!(r.header("content-type"), Some("application/json"));
            assert_eq!(r.header("cache-control"), Some(LIVE));
            assert_eq!(r.header("access-control-allow-origin"), Some("*"));
        }
    }
    assert!(hits(&seen).contains(&"/blindbit/v1/block-hash/7".to_owned()));
    assert!(hits(&seen).contains(&"/blindbit/v1/tweaks/7?dustLimit=546".to_owned()));
    let r = send(&addr, "HEAD /api/blindbit/v1/info", "", b"").await;
    assert_eq!(r.status, 200);
    assert!(r.body.is_empty());
    assert_eq!(
        get(&addr, "/api/blindbit/v1/block-hash/42").await.error(),
        "node unavailable"
    );
    assert_eq!(
        get(&addr, "/api/blindbit/v1/block-hash/43").await.status,
        404
    );
}

#[tokio::test]
async fn blindbit_refusals_never_reach_the_node() {
    let (addr, seen) = start(Duration::ZERO, true).await;
    for (path, status) in [
        ("tweaks/-1", 400),
        ("tweaks/4294967296", 400),
        ("tweaks/%31", 400),
        ("tweaks/1?dustLimit=-1", 400),
        ("tweaks/1?dustLimit=18446744073709551616", 400),
        ("tweaks/1?dustLimit=", 400),
        ("tweaks/1?dustLimit=1&dustLimit=2", 400),
        ("utxos/1?dustLimit=1", 400),
        ("info?asof=1", 400),
        ("filter/unknown/1", 404),
        ("unknown", 404),
        ("info/", 404),
    ] {
        assert_eq!(
            get(&addr, &format!("/api/blindbit/v1/{path}")).await.status,
            status,
            "{path}"
        );
    }
    let r = post(&addr, "/api/blindbit/v1/info", b"").await;
    assert_eq!(r.status, 405);
    assert_eq!(r.header("allow"), Some("get, head"));
    assert_eq!(get(&addr, "/api/blindbit/v1/forward-tx").await.status, 405);
    for body in [b"{}".as_slice(), b"{\"data\":\"bad\"}", TX.as_bytes()] {
        assert_eq!(
            post(&addr, "/api/blindbit/v1/forward-tx", body)
                .await
                .status,
            400
        );
    }
    assert!(hits(&seen).is_empty());
}

#[tokio::test]
async fn blindbit_forward_shares_the_broadcast_switch_and_budget() {
    let body = serde_json::to_vec(&serde_json::json!({"data": TX.to_uppercase()})).unwrap();
    let (addr, seen) = start(Duration::ZERO, false).await;
    assert_eq!(
        post(&addr, "/api/blindbit/v1/forward-tx", &body)
            .await
            .status,
        403
    );
    assert!(hits(&seen).is_empty());
    let (addr, seen) = start(Duration::ZERO, true).await;
    let r = post(&addr, "/signet/api/blindbit/v1/forward-tx", &body).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.text(), format!("\"{H}\""));
    assert_eq!(r.header("cache-control"), Some("no-store"));
    for _ in 1..BROADCAST_BURST {
        assert_eq!(
            post(&addr, "/signet/api/tx", TX.as_bytes()).await.status,
            200
        );
    }
    assert_eq!(
        post(&addr, "/signet/api/blindbit/v1/forward-tx", &body)
            .await
            .status,
        429
    );
    assert_eq!(hits(&seen).len(), BROADCAST_BURST as usize);
}

#[tokio::test]
async fn blindbit_forward_has_the_broadcast_body_cap() {
    let (addr, seen) = start(Duration::ZERO, true).await;
    // Larger than the default 16 KiB body limit, but one valid transaction after trimming.
    let body =
        serde_json::to_vec(&serde_json::json!({"data": format!("{}{TX}", " ".repeat(20_000))}))
            .unwrap();
    assert_eq!(
        post(&addr, "/api/blindbit/v1/forward-tx", &body)
            .await
            .status,
        200
    );
    let body =
        serde_json::to_vec(&serde_json::json!({"data": "00".repeat(MAX_TX_BYTES + 1)})).unwrap();
    assert_eq!(
        post(&addr, "/api/blindbit/v1/forward-tx", &body)
            .await
            .status,
        413
    );
    assert_eq!(hits(&seen).len(), 1);
}
