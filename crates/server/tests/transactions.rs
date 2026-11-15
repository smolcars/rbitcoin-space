//! The `/api/v1` transaction routes over HTTP, against a mock Esplora on port 0: `POST /prevouts`
//! and the node calls it makes, the limits in front of every route, and hostile input. The
//! answers from the mempool engines are tested in `src/transactions/tests.rs`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use rbitcoin_space::esplora::HEAVY_PENDING;
use rbitcoin_space::{App, Config, Limits};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// A confirmed transaction (block 1's coinbase), one still in the mempool, one unknown.
const H1: &str = "0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098";
const H2: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const H3: &str = "3333333333333333333333333333333333333333333333333333333333333333";
const P2PK: &str = "410496b538e853519c726a2c91e61ec11600ae1390813a627c66fb8be7947be63c52da7589379515d4e0a604f8141781e62294721166bf621e73a82cbf2342c858eeac";
const ASM: &str = "OP_PUSHBYTES_65 0496b538e853519c726a2c91e61ec11600ae1390813a627c66fb8be7947be63c52da7589379515d4e0a604f8141781e62294721166bf621e73a82cbf2342c858ee OP_CHECKSIG";

#[derive(Default)]
struct Node {
    hits: Mutex<Vec<String>>,
    now: AtomicUsize,
    most: AtomicUsize,
}

/// A stand-in for rbitcoin's Esplora: `/tx/:txid/out/:vout` answers only confirmed outputs, as
/// the node does; every request is recorded, with the most ever in flight at once.
async fn mock(delay: Duration) -> (String, Arc<Node>) {
    let node = Arc::new(Node::default());
    let n = Arc::clone(&node);
    let app = Router::new().fallback(any(move |uri: Uri| {
        let n = Arc::clone(&n);
        async move {
            let path = uri.path().to_owned();
            n.hits.lock().unwrap().push(path.clone());
            let now = n.now.fetch_add(1, Ordering::SeqCst) + 1;
            n.most.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(delay).await;
            n.now.fetch_sub(1, Ordering::SeqCst);
            answer(&path)
        }
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, node)
}

fn answer(path: &str) -> Response {
    let json = |v: Value| ([("content-type", "application/json")], v.to_string()).into_response();
    if path == format!("/tx/{H1}/out/0") {
        return json(json!({
            "scriptpubkey": P2PK, "scriptpubkey_asm": ASM, "scriptpubkey_type": "p2pk",
            "spent": false,
            "status": {"confirmed": true, "block_height": 1, "block_hash": H1, "block_time": 1},
            "value": 5_000_000_000_u64,
        }));
    }
    if path == format!("/tx/{H2}") {
        return json(json!({
            "txid": H2, "version": 2, "locktime": 0, "vin": [],
            "vout": [{
                "scriptpubkey": "00144128c79f7aceed3fc8f452edf46d4cc0d119166b",
                "scriptpubkey_asm": "OP_0 OP_PUSHBYTES_20 4128c79f7aceed3fc8f452edf46d4cc0d119166b",
                "scriptpubkey_type": "v0_p2wpkh",
                "scriptpubkey_address": "bc1qgy5v08m6emknlj852tklgm2vcrg3j9nt5xtaef",
                "value": 48384,
            }],
            "size": 1, "weight": 4, "fee": 1, "status": {"confirmed": false},
        }));
    }
    if path.starts_with("/tx/4") {
        return (StatusCode::SERVICE_UNAVAILABLE, "unavailable").into_response();
    }
    (StatusCode::NOT_FOUND, "Not Found").into_response()
}

fn config(esplora: &str) -> Config {
    let mut vars = HashMap::new();
    for (k, v) in [
        ("RPC_HOST", "127.0.0.1"),
        ("RPC_PORT", "1"),
        ("RPC_USER", "u"),
        ("RPC_PASSWORD", "p"),
        ("ESPLORA_URL", esplora),
        ("ELECTRUM_ADDR", "127.0.0.1:1"),
        ("MEMPOOL_ENABLED", "false"),
    ] {
        vars.insert(format!("MAINNET_{k}"), v.to_owned());
    }
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

async fn start(delay: Duration) -> (String, Arc<Node>) {
    let (url, node) = mock(delay).await;
    let app = App::new(&config(&url));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(app.serve(listener, std::future::pending()));
    (addr, node)
}

#[derive(Debug)]
struct Reply {
    status: u16,
    head: String,
    body: String,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.head
            .lines()
            .find_map(|l| l.strip_prefix(&format!("{name}: ")))
    }

    fn error(&self) -> String {
        let v: Value = serde_json::from_str(&self.body).unwrap();
        v["error"].as_str().unwrap().to_owned()
    }
}

async fn send(addr: &str, line: &str, body: &[u8]) -> Reply {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "{line} HTTP/1.1\r\nHost: test\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
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
        body: String::from_utf8_lossy(&raw[split + 4..]).into_owned(),
    }
}

async fn prevouts(addr: &str, body: &str) -> Reply {
    send(addr, "POST /api/v1/prevouts", body.as_bytes()).await
}

fn hits(n: &Node) -> Vec<String> {
    n.hits.lock().unwrap().clone()
}

#[tokio::test]
async fn prevouts_read_each_output_once_in_order() {
    let (addr, node) = start(Duration::ZERO).await;
    let body = json!([
        {"txid": H1, "vout": 0},
        {"txid": H2, "vout": 0},
        {"txid": H3, "vout": 5},
        {"txid": H1, "vout": 0},
        {"txid": H2, "vout": 3},
    ]);
    let r = prevouts(&addr, &body.to_string()).await;
    assert_eq!(r.status, 200, "{}", r.body);
    let confirmed = format!(
        r#"{{"prevout":{{"scriptpubkey":"{P2PK}","scriptpubkey_asm":"{ASM}","scriptpubkey_type":"p2pk","value":5000000000}},"unconfirmed":false}}"#
    );
    let mempool = r#"{"prevout":{"scriptpubkey":"00144128c79f7aceed3fc8f452edf46d4cc0d119166b","scriptpubkey_address":"bc1qgy5v08m6emknlj852tklgm2vcrg3j9nt5xtaef","scriptpubkey_asm":"OP_0 OP_PUSHBYTES_20 4128c79f7aceed3fc8f452edf46d4cc0d119166b","scriptpubkey_type":"v0_p2wpkh","value":48384},"unconfirmed":true}"#;
    assert_eq!(
        r.body,
        format!("[{confirmed},{mempool},null,{confirmed},null]")
    );
    assert_eq!(r.header("content-type"), Some("application/json"));
    assert_eq!(r.header("cache-control"), Some("no-store"));
    // One call per distinct outpoint, and the whole transaction once per txid when the output
    // is not a confirmed one: never more than two per outpoint asked.
    assert_eq!(
        hits(&node),
        vec![
            format!("/tx/{H1}/out/0"),
            format!("/tx/{H2}/out/0"),
            format!("/tx/{H2}"),
            format!("/tx/{H3}/out/5"),
            format!("/tx/{H3}"),
            format!("/tx/{H2}/out/3"),
        ]
    );
    // The reference's shape for the mempool output; the confirmed one leaves out an address the
    // output does not have, where the reference wrote "".
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/api-v1/transactions.json")).unwrap();
    let ours: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(ours[1], fixture["prevouts"][1]);
    assert_eq!(ours[2], fixture["prevouts"][2]);

    // Nothing asked: no call.
    let before = hits(&node).len();
    let r = prevouts(&addr, "[]").await;
    assert_eq!((r.status, r.body.as_str()), (200, "[]"));
    assert_eq!(hits(&node).len(), before);
    // A node failure is ours to report, in our words.
    let r = prevouts(
        &addr,
        &json!([{"txid": "4".repeat(64), "vout": 0}]).to_string(),
    )
    .await;
    assert_eq!(
        (r.status, r.error()),
        (502, "upstream unavailable".to_owned())
    );
}

#[tokio::test]
async fn hostile_bodies_never_reach_the_node() {
    let (addr, node) = start(Duration::ZERO).await;
    let shape = "body must be a JSON array of {\"txid\", \"vout\"}";
    let one = |txid: &str, vout: Value| json!([{"txid": txid, "vout": vout}]).to_string();
    let many = |n: usize| Value::Array(vec![json!({"txid": H1, "vout": 0}); n]).to_string();
    for (body, status, error) in [
        ("{}".to_owned(), 400, shape),
        ("not json".to_owned(), 400, shape),
        (one("zz", json!(0)), 400, "invalid txid"),
        (one(&H1.to_uppercase()[..63], json!(0)), 400, "invalid txid"),
        (
            one(&format!("0x{}", &H1[2..]), json!(0)),
            400,
            "invalid txid",
        ),
        (one(H1, json!(-1)), 400, shape),
        (one(H1, json!(4_294_967_296_u64)), 400, shape),
        (one(H1, json!("0")), 400, shape),
        (
            json!([{"txid": H1, "vout": 0, "more": 1}]).to_string(),
            400,
            shape,
        ),
        (many(101), 400, "at most 100 outpoints"),
        (many(10_000), 413, "body too large"),
        ("[".repeat(20_000), 413, "body too large"),
    ] {
        let r = prevouts(&addr, &body).await;
        assert_eq!(
            (r.status, r.error()),
            (status, error.to_owned()),
            "{}",
            &body[..body.len().min(80)]
        );
    }
    assert!(hits(&node).is_empty());
    // A read, so only POST.
    let r = send(&addr, "GET /api/v1/prevouts", b"").await;
    assert_eq!(r.status, 405);
}

#[tokio::test]
async fn prevouts_share_the_cost_limit_of_the_batch_routes() {
    let (addr, node) = start(Duration::from_millis(200)).await;
    // Twenty different requests at once, each one outpoint the node does not have: two calls.
    let tasks: Vec<_> = (0..20)
        .map(|i| {
            let addr = addr.clone();
            tokio::spawn(async move {
                let txid = format!("{:064x}", 0x5000 + i);
                prevouts(&addr, &json!([{"txid": txid, "vout": 0}]).to_string()).await
            })
        })
        .collect();
    let mut by_status: HashMap<u16, usize> = HashMap::new();
    for t in tasks {
        let r = t.await.unwrap();
        if r.status == 503 {
            assert_eq!(r.error(), "node busy; retry");
            assert_eq!(r.header("retry-after"), Some("1"));
        }
        *by_status.entry(r.status).or_default() += 1;
    }
    assert_eq!(by_status.get(&200), Some(&HEAVY_PENDING));
    assert_eq!(by_status.get(&503), Some(&(20 - HEAVY_PENDING)));
    // At most four batches on the node at once, one call each at a time.
    assert!(
        node.most.load(Ordering::SeqCst) <= 4,
        "{}",
        node.most.load(Ordering::SeqCst)
    );
    assert_eq!(hits(&node).len(), 2 * HEAVY_PENDING);
}

#[tokio::test]
async fn the_other_routes_parse_before_anything_and_ask_the_node_nothing() {
    let (addr, node) = start(Duration::ZERO).await;
    let get = |target: String| {
        let addr = addr.clone();
        async move { send(&addr, &format!("GET {target}"), b"").await }
    };
    let r = get("/api/v1/validate-address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq".into()).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body,
        r#"{"address":"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq","isscript":false,"isvalid":true,"iswitness":true,"scriptPubKey":"0014e8df018c7e326cc253faac7e46cdc51e68542c42","witness_program":"e8df018c7e326cc253faac7e46cdc51e68542c42","witness_version":0}"#
    );
    assert_eq!(r.header("cache-control"), Some("public, max-age=86400"));
    assert_eq!(r.header("access-control-allow-origin"), Some("*"));
    for bad in [
        "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
        "%00",
        &"x".repeat(5000),
    ] {
        let r = get(format!("/api/v1/validate-address/{bad}")).await;
        assert_eq!((r.status, r.body.as_str()), (200, r#"{"isvalid":false}"#));
    }
    // A path that is not UTF-8 once decoded is not a question about an address.
    assert_eq!(get("/api/v1/validate-address/%ff".into()).await.status, 400);

    // With the mempool engine off, the routes it answers say so; their parameters are still
    // checked first.
    let t = H1;
    for target in [
        format!("/api/v1/transaction-times?txId[]={t}"),
        "/api/v1/replacements".into(),
        "/api/v1/fullrbf/replacements".into(),
        format!("/api/v1/tx/{t}/rbf"),
        format!("/api/v1/cpfp/{t}"),
    ] {
        let r = get(target.clone()).await;
        assert_eq!(
            (r.status, r.error()),
            (503, "the mempool engine is off on this server".into()),
            "{target}"
        );
    }
    for target in [
        "/api/v1/tx/zz/rbf".to_owned(),
        format!("/api/v1/cpfp/{}", &t[1..]),
        "/api/v1/transaction-times?txId[]=zz".into(),
        format!(
            "/api/v1/transaction-times?{}",
            vec![format!("txId[]={t}"); 101].join("&")
        ),
    ] {
        let r = get(target.clone()).await;
        assert_eq!(r.status, 400, "{target}");
    }
    // Ten thousand txids do not fit in a request head: the parser refuses it before any route.
    let huge = vec![format!("txId[]={t}"); 10_000].join("&");
    let r = get(format!("/api/v1/transaction-times?{huge}")).await;
    assert_eq!(r.status, 431);
    assert!(hits(&node).is_empty());
}

#[tokio::test]
async fn the_replacement_lists_answer_with_a_trailing_slash_as_without() {
    // The reference's frontend asks both with a trailing slash; only these paths are added.
    let (addr, _) = start(Duration::ZERO).await;
    for path in ["/api/v1/replacements", "/api/v1/fullrbf/replacements"] {
        let plain = send(&addr, &format!("GET {path}"), b"").await;
        let slash = send(&addr, &format!("GET {path}/"), b"").await;
        assert_eq!(
            (slash.status, slash.body),
            (plain.status, plain.body),
            "{path}"
        );
        let doubled = send(&addr, &format!("GET {path}//"), b"").await;
        assert_eq!(doubled.status, 404, "{path}");
    }
}
