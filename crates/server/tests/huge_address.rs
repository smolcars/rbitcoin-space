//! Address histories the node will not finish (docs/API.md, "Very large addresses"), against a
//! mock node on port 0. Nothing here reaches a real node.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::http::{StatusCode, Uri};
use axum::response::IntoResponse;
use axum::routing::any;
use bitcoin::hashes::Hash;
use bitcoin::{Address, Network, ScriptBuf, WPubkeyHash};
use node::esplora::ScriptHash;
use rbitcoin_space::config::{IpNet, TrustedProxy};
use rbitcoin_space::{App, Config, Limits};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Above the node's `--max-sh-creates`: its totals are refused, its history is slow.
const BIG: &str = "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h";
/// Totals answered, history slow.
const SLOW: &str = "3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6";
/// Above the cap, and its totals refusal takes the node 200 ms: inside the test's deadline.
const LATE: &str = "1KFHE7w8BhaENAswwryaoccDb6qcT6DbYY";
/// Above the cap, refused in words that no longer give the counts.
const RESHAPED: &str = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
/// Above the cap, and its history pages are refused for size at once, as rbitcoin
/// `nightly-20261122` refuses a page that reads every create.
const CAPPED: &str = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
/// Everything answered at once.
const SMALL: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const TXID: &str = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";
/// How long the node takes over a slow history page.
const NODE_SLOW: Duration = Duration::from_millis(1500);
/// The history timeout the tests run with.
const DEADLINE: Duration = Duration::from_millis(300);

type Seen = Arc<Mutex<Vec<String>>>;

/// rbitcoin's answers for the three kinds of address, and for any other address the refusal for
/// size. Every request is recorded.
async fn mock() -> (String, Seen) {
    let seen: Seen = Arc::default();
    let log = Arc::clone(&seen);
    let app = Router::new().fallback(any(move |uri: Uri| {
        let log = Arc::clone(&log);
        async move {
            let pq = uri.path_and_query().map(ToString::to_string).unwrap();
            log.lock().unwrap().push(pq.clone());
            let rest = pq.strip_prefix("/address/").unwrap_or_default();
            let (addr, tail) = rest.split_once(['/', '?']).unwrap_or((rest, ""));
            let history = tail.starts_with("txs") && !tail.starts_with("txs/mempool");
            if history && addr == CAPPED {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "scripthash join exceeds --max-sh-creates (52000 creates, cap 10000)",
                )
                    .into_response();
            }
            if history && addr != SMALL {
                tokio::time::sleep(NODE_SLOW).await;
                return (StatusCode::OK, "[]").into_response();
            }
            if tail.is_empty() && addr == LATE {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            if tail.is_empty() && addr == RESHAPED {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "scripthash join exceeds --max-sh-creates; use a paged route",
                )
                    .into_response();
            }
            if tail.is_empty() && addr != SMALL && addr != SLOW {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "scripthash join exceeds --max-sh-creates (2366550 creates, cap 10000)",
                )
                    .into_response();
            }
            let stats = r#"{"chain_stats":{"funded_txo_count":10000},"mempool_stats":{}}"#;
            let body = if tail.is_empty() { stats } else { "[]" };
            (StatusCode::OK, body).into_response()
        }
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, seen)
}

/// The server against a fresh mock node, its requests naming their client in `X-Real-IP`.
async fn start() -> (String, Seen) {
    let (url, seen) = mock().await;
    let app = App::new(&config(&url));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(app.serve(listener, std::future::pending()));
    (addr, seen)
}

fn config(url: &str) -> Config {
    let mut vars = HashMap::new();
    for (k, v) in [
        ("RPC_HOST", "127.0.0.1"),
        ("RPC_PORT", "1"),
        ("RPC_USER", "u"),
        ("RPC_PASSWORD", "p"),
        ("ESPLORA_URL", url),
        ("ELECTRUM_ADDR", "127.0.0.1:1"),
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
        history_timeout: DEADLINE,
        trusted_proxy: Some(TrustedProxy {
            header: "x-real-ip".parse().unwrap(),
            proxies: vec![IpNet::parse("127.0.0.1").unwrap()],
        }),
        ..Limits::default()
    };
    c
}

struct Reply {
    status: u16,
    error: String,
    body: serde_json::Value,
    took: Duration,
}

async fn get_as(addr: &str, client: u8, target: &str) -> Reply {
    let started = Instant::now();
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "GET {target} HTTP/1.1\r\nHost: test\r\nConnection: close\r\nX-Real-IP: 192.0.2.{client}\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let body: serde_json::Value = serde_json::from_slice(&raw[split + 4..]).unwrap_or_default();
    Reply {
        status: String::from_utf8_lossy(&raw[9..12]).parse().unwrap(),
        error: body["error"].as_str().unwrap_or_default().to_owned(),
        body,
        took: started.elapsed(),
    }
}

async fn get(addr: &str, target: &str) -> Reply {
    get_as(addr, 1, target).await
}

fn calls(seen: &Seen, needle: &str) -> usize {
    seen.lock()
        .unwrap()
        .iter()
        .filter(|p| p.contains(needle))
        .count()
}

const TOO_LARGE: (u16, &str) = (503, "address history too large for this server");

#[tokio::test]
async fn once_the_node_refuses_the_totals_for_size_the_history_never_reaches_it() {
    let (addr, seen) = start().await;
    let r = get(&addr, &format!("/api/address/{BIG}")).await;
    assert_eq!((r.status, r.error.as_str()), TOO_LARGE);
    assert_eq!(calls(&seen, BIG), 1);

    let script = Address::from_str(BIG)
        .unwrap()
        .assume_checked()
        .script_pubkey();
    let sh = ScriptHash::from_script(&script);
    let asof = "0".repeat(64);
    for path in [
        format!("/api/address/{BIG}/txs"),
        format!("/api/address/{BIG}/txs?after_txid={TXID}"),
        format!("/api/address/{BIG}/txs/chain"),
        format!("/api/address/{BIG}/txs/chain/{TXID}"),
        format!("/api/address/{BIG}/txs/summary"),
        format!("/api/address/{BIG}/txs/summary/{TXID}?asof={asof}"),
        format!("/api/scripthash/{}/txs", sh.digest_hex()),
        format!("/api/scripthash/{}/txs/summary", sh.digest_hex()),
    ] {
        let r = get(&addr, &path).await;
        assert_eq!((r.status, r.error.as_str()), TOO_LARGE, "{path}");
    }
    assert_eq!(calls(&seen, BIG), 1, "no history request reached the node");
    assert_eq!(calls(&seen, &sh.digest_hex()), 0);

    // Its mempool rows are not history: still served.
    assert_eq!(
        get(&addr, &format!("/api/address/{BIG}/txs/mempool"))
            .await
            .status,
        200
    );
    // An address whose totals the node answered, at the cap, is served as before.
    assert_eq!(
        get(&addr, &format!("/api/address/{SMALL}")).await.status,
        200
    );
    assert_eq!(
        get(&addr, &format!("/api/address/{SMALL}/txs"))
            .await
            .status,
        200
    );
    assert_eq!(
        get(&addr, &format!("/api/address/{SMALL}/txs/chain/{TXID}"))
            .await
            .status,
        200
    );
}

#[tokio::test]
async fn the_app_says_how_large_the_node_said_an_address_is_without_asking_it() {
    let (addr, seen) = start().await;
    let size = |a: &str| format!("/app/address/{a}/size");
    const UNKNOWN: (u16, &str) = (404, "size not known");
    // Nothing learned yet: not known, and the node is not asked.
    let r = get(&addr, &size(BIG)).await;
    assert_eq!((r.status, r.error.as_str()), UNKNOWN);
    assert_eq!(calls(&seen, BIG), 0);

    assert_eq!(get(&addr, &format!("/api/address/{BIG}")).await.status, 503);
    let r = get(&addr, &size(BIG)).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body,
        serde_json::json!({"creates": 2_366_550_u64, "cap": 10_000_u64})
    );
    assert_eq!(calls(&seen, BIG), 1, "read from memory");

    // A refusal whose words changed is still a refusal, but its size is not known.
    assert_eq!(
        get(&addr, &format!("/api/address/{RESHAPED}")).await.status,
        503
    );
    assert_eq!(
        get(&addr, &format!("/api/address/{RESHAPED}/txs"))
            .await
            .error,
        TOO_LARGE.1
    );
    let r = get(&addr, &size(RESHAPED)).await;
    assert_eq!((r.status, r.error.as_str()), UNKNOWN);

    // An address the node totals has no size to give.
    assert_eq!(
        get(&addr, &format!("/api/address/{SMALL}")).await.status,
        200
    );
    let r = get(&addr, &size(SMALL)).await;
    assert_eq!((r.status, r.error.as_str()), UNKNOWN);

    // Hostile and wrong-network input is refused before anything is looked up.
    for (path, error) in [
        (size("not-an-address"), "invalid address"),
        (size(&"1".repeat(200)), "invalid address"),
        (size("%3Cscript%3E"), "invalid address"),
        (
            size("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"),
            "address is for another network",
        ),
    ] {
        let r = get(&addr, &path).await;
        assert_eq!((r.status, r.error.as_str()), (400, error), "{path}");
    }
}

/// A history page the node refuses for size teaches the size as a totals refusal does: the other
/// pages are refused without the node, and the app can say how large the address is.
#[tokio::test]
async fn a_page_the_node_refuses_for_size_is_remembered() {
    let (addr, seen) = start().await;
    let r = get(&addr, &format!("/api/address/{CAPPED}/txs")).await;
    assert_eq!((r.status, r.error.as_str()), TOO_LARGE);
    assert_eq!(calls(&seen, CAPPED), 1);
    for path in [
        format!("/api/address/{CAPPED}/txs/chain"),
        format!("/api/address/{CAPPED}/txs/summary/{TXID}"),
    ] {
        let r = get(&addr, &path).await;
        assert_eq!((r.status, r.error.as_str()), TOO_LARGE, "{path}");
    }
    assert_eq!(calls(&seen, CAPPED), 1, "the node is not asked again");
    let r = get(&addr, &format!("/app/address/{CAPPED}/size")).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body,
        serde_json::json!({"creates": 52_000_u64, "cap": 10_000_u64})
    );
}

#[tokio::test]
async fn a_size_refusal_is_remembered_when_its_client_has_hung_up() {
    let (addr, seen) = start().await;
    let gone = tokio::time::timeout(
        Duration::from_millis(100),
        get(&addr, &format!("/api/address/{LATE}")),
    )
    .await;
    assert!(gone.is_err(), "the client hangs up while the node works");
    tokio::time::sleep(Duration::from_millis(700)).await;
    let r = get(&addr, &format!("/api/address/{LATE}/txs")).await;
    assert_eq!((r.status, r.error.as_str()), TOO_LARGE);
    assert_eq!(calls(&seen, "/txs"), 0);
    assert_eq!(calls(&seen, LATE), 1);
}

#[tokio::test]
async fn a_page_waiting_for_a_slot_is_refused_by_a_verdict_learned_meanwhile() {
    use axum::extract::ConnectInfo;
    use rbitcoin_space::esplora::HEAVY_RUNNING;
    use rbitcoin_space::limits::Refused;
    use tower::ServiceExt;
    let (url, seen) = mock().await;
    // Driven without a socket, so the response's extensions show how it is logged.
    let router = App::new(&config(&url)).router();
    let spawn = |path: String| {
        let mut req = axum::http::Request::get(path)
            .body(axum::body::Body::empty())
            .unwrap();
        req.extensions_mut()
            .insert(ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 0))));
        tokio::spawn(router.clone().oneshot(req))
    };
    // Slow pages take all slots but one; the last goes to totals the node refuses after 200 ms.
    let busy: Vec<_> = (0..HEAVY_RUNNING - 1)
        .map(|n| spawn(format!("/api/address/{SLOW}/txs?asof={n:064x}")))
        .collect();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let totals = spawn(format!("/api/address/{LATE}"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    // Its history arrives before that answer, so it passes the first check and waits for a slot.
    let history = spawn(format!("/api/address/{LATE}/txs"));
    assert_eq!(totals.await.unwrap().unwrap().status(), 503);
    let r = history.await.unwrap().unwrap();
    assert_eq!(r.status(), 503);
    // Counted as a refusal, not logged as a request the node served.
    assert_eq!(
        r.extensions().get::<Refused>().map(|r| r.reason),
        Some("history_too_large")
    );
    assert_eq!(calls(&seen, &format!("{LATE}/txs")), 0);
    for b in busy {
        assert_eq!(b.await.unwrap().unwrap().status(), 504);
    }
}

#[tokio::test]
async fn a_slow_page_releases_its_client_is_remembered_and_still_holds_its_slot() {
    use axum::extract::ConnectInfo;
    use rbitcoin_space::esplora::HEAVY_RUNNING;
    use rbitcoin_space::limits::Refused;
    use tower::ServiceExt;
    let (url, seen) = mock().await;
    let app = App::new(&config(&url));
    // The same server without a socket too, where a response's extensions show how it is logged.
    let router = app.router();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(app.serve(listener, std::future::pending()));
    // Four slow pages (distinct by `?asof=`) from four clients take every slot.
    let page = |n: usize| format!("/api/address/{SLOW}/txs?asof={n:064x}");
    let waiting: Vec<_> = (0..HEAVY_RUNNING)
        .map(|n| {
            let (addr, path) = (addr.clone(), page(n));
            tokio::spawn(async move { get_as(&addr, u8::try_from(n + 10).unwrap(), &path).await })
        })
        .collect();
    for w in waiting {
        let r = w.await.unwrap();
        assert_eq!((r.status, r.error.as_str()), (504, "request timed out"));
        assert!(r.took >= DEADLINE, "took {:?}", r.took);
    }
    assert_eq!(calls(&seen, "/txs"), HEAVY_RUNNING);

    // The same page again is refused from what was learned, without a node call or a wait for a
    // slot: one that waited would time out like the four, not be refused.
    let mut req = axum::http::Request::get(page(0))
        .body(axum::body::Body::empty())
        .unwrap();
    req.extensions_mut()
        .insert(ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 0))));
    let r = router.oneshot(req).await.unwrap();
    assert_eq!(r.status(), 504);
    assert_eq!(
        r.extensions().get::<Refused>().map(|r| r.reason),
        Some("history_slow")
    );
    // Another page of the same address is not judged by it, but the node is still busy with the
    // four: it waits for a slot, and reaches the node only once one is free.
    let fifth = {
        let (addr, path) = (addr.clone(), page(9));
        tokio::spawn(async move { get_as(&addr, 20, &path).await })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        calls(&seen, "/txs"),
        HEAVY_RUNNING,
        "slots freed while the node worked"
    );
    let r = fifth.await.unwrap();
    assert_eq!(r.status, 504);
    assert!(
        r.took > Duration::from_millis(700),
        "waited for a slot: {:?}",
        r.took
    );
    assert_eq!(calls(&seen, "/txs"), HEAVY_RUNNING + 1);
    // An ordinary address is not held up by any of this.
    assert_eq!(
        get(&addr, &format!("/api/address/{SMALL}/txs"))
            .await
            .status,
        200
    );
}

#[tokio::test]
async fn many_huge_addresses_cost_one_cheap_call_each_and_no_history() {
    let (addr, seen) = start().await;
    let addresses: Vec<String> = (0..40u8)
        .map(|i| {
            let script = ScriptBuf::new_p2wpkh(&WPubkeyHash::from_byte_array([i; 20]));
            Address::from_script(&script, Network::Bitcoin)
                .unwrap()
                .to_string()
        })
        .collect();
    for a in &addresses {
        let r = get(&addr, &format!("/api/address/{a}")).await;
        assert_eq!((r.status, r.error.as_str()), TOO_LARGE);
        for _ in 0..3 {
            let r = get(&addr, &format!("/api/address/{a}/txs")).await;
            assert_eq!((r.status, r.error.as_str()), TOO_LARGE);
        }
    }
    let seen = seen.lock().unwrap();
    assert_eq!(
        seen.len(),
        addresses.len(),
        "one totals call each: {seen:?}"
    );
    assert!(seen.iter().all(|p| !p.contains("/txs")));
}
