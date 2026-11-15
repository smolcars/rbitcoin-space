//! The request log and the Electrum reporter, against a real server on port 0. The logger is
//! global, so every test here shares one capture and finds its own lines by request id.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::Path;
use axum::routing::get;
use logging::{Format, Level, Settings};
use rbitcoin_space::config::{Network, RequestLog};
use rbitcoin_space::{App, Config, Limits, NetworkContext};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

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

/// Every line written so far, each checked to be one JSON object.
fn logged() -> (String, Vec<Value>) {
    let c = capture();
    logging::flush(Duration::from_secs(5));
    let raw = String::from_utf8(c.0.lock().unwrap().clone()).unwrap();
    let lines = raw
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    (raw, lines)
}

fn events_for(id: &str) -> Vec<Value> {
    logged()
        .1
        .into_iter()
        .filter(|v| v["request_id"] == id)
        .collect()
}

fn config(vars: &[(&str, &str)], limits: Limits) -> Config {
    let mut map: HashMap<String, String> = HashMap::new();
    for net in ["MAINNET", "SIGNET"] {
        for (k, v) in [
            ("RPC_HOST", "127.0.0.1"),
            ("RPC_PORT", "1"),
            ("RPC_USER", "u"),
            ("RPC_PASSWORD", "probe-password"),
            ("ESPLORA_URL", "http://127.0.0.1:1"),
            ("ELECTRUM_ADDR", "127.0.0.1:1"),
        ] {
            map.insert(format!("{net}_{k}"), v.to_owned());
        }
    }
    for (k, v) in vars {
        map.insert((*k).to_owned(), (*v).to_owned());
    }
    let mut c = Config::from_vars(|k| map.get(k).cloned()).unwrap();
    c.web_dir = Some(std::env::temp_dir().join("rbitcoin-space-no-web-dir"));
    // The proxy settings come from the variables; everything else from `limits`.
    c.limits = Limits {
        trusted_proxy: c.limits.trusted_proxy.take(),
        ..limits
    };
    c
}

fn roomy() -> Limits {
    Limits {
        client_burst: 1000,
        client_rate_per_sec: 1000,
        ..Limits::default()
    }
}

async fn start(config: Config) -> String {
    capture();
    let probes: Router<Arc<NetworkContext>> = Router::new().route(
        "/app/lookup/{id}",
        get(|Path(id): Path<String>| async move { id }),
    );
    let app = App::with_routes(&config, probes);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(app.serve(listener, std::future::pending()));
    addr
}

/// GETs `target` and returns the status and the `X-Request-Id` header.
async fn get_id(addr: &str, target: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req = format!("GET {target} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let raw = String::from_utf8_lossy(&raw).to_ascii_lowercase();
    let status = raw[9..12].parse().unwrap();
    let id = raw
        .lines()
        .find_map(|l| l.strip_prefix("x-request-id: "))
        .expect("every response has a request id")
        .trim()
        .to_owned();
    (status, id)
}

const LOOKED_UP: &str = "d00dfeedd00dfeedd00dfeedd00dfeedd00dfeedd00dfeedd00dfeedd00dfeed";

#[tokio::test]
async fn one_event_per_request_with_the_template_and_never_the_path() {
    let addr = start(config(&[], roomy())).await;
    let (status, id) = get_id(
        &addr,
        &format!("/signet/app/lookup/{LOOKED_UP}?secret-query=1"),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(id.len(), 16);
    let events = events_for(&id);
    assert_eq!(events.len(), 1, "{events:?}");
    let e = &events[0];
    assert_eq!(e["event"], "http_request");
    assert_eq!(e["level"], "info");
    assert_eq!(e["network"], "signet");
    assert_eq!(e["method"], "GET");
    assert_eq!(e["route"], "/signet/app/lookup/{id}");
    assert_eq!(e["status"], 200);
    assert_eq!(e["bytes"], 64);
    assert!(e["duration_ms"].as_f64().unwrap() >= 0.0);
    assert!(e.get("client").is_none(), "no client address by default");

    let (raw, _) = logged();
    assert!(!raw.contains(LOOKED_UP), "the looked-up id reached the log");
    assert!(!raw.contains("secret-query"));
}

#[tokio::test]
async fn frontend_and_unknown_paths_are_labelled_not_echoed() {
    let addr = start(config(&[], roomy())).await;
    let (status, id) = get_id(&addr, "/address/bc1qhiddenaddressxyz").await;
    assert_eq!(status, 404, "no web dir in this test");
    let e = &events_for(&id)[0];
    assert_eq!(e["route"], "frontend");
    assert_eq!(e["network"], "mainnet");
    let (raw, _) = logged();
    assert!(!raw.contains("bc1qhiddenaddressxyz"));
}

#[tokio::test]
async fn a_refused_request_says_why() {
    let limits = Limits {
        client_burst: 1,
        client_rate_per_sec: 1,
        ..Limits::default()
    };
    // Each App has its own limiter, so other tests' requests do not share this bucket.
    let addr = start(config(&[], limits)).await;
    let (first, _) = get_id(&addr, "/signet/app/lookup/a").await;
    let (second, id) = get_id(&addr, "/signet/app/lookup/b").await;
    assert_eq!((first, second), (200, 429));
    let e = &events_for(&id)[0];
    assert_eq!(e["status"], 429);
    assert_eq!(e["refused"], "client_rate");
    assert_eq!(e["route"], "/signet/app/lookup/{id}");
}

#[tokio::test]
async fn api_requests_carry_the_pass_through_outcome() {
    let addr = start(config(&[], roomy())).await;
    let (status, id) = get_id(&addr, "/signet/api/blocks/tip/height").await;
    assert!(status >= 500, "nothing listens upstream: {status}");
    let e = &events_for(&id)[0];
    assert_eq!(e["route"], "/signet/api/{*rest}");
    assert_eq!(e["endpoint"], "tip_height");
    assert_eq!(e["upstream_error"], "unavailable");
    assert!(e["source"].is_string());
}

#[tokio::test]
async fn volume_setting_and_quiet_health_checks() {
    let all = start(config(&[], roomy())).await;
    let (status, id) = get_id(&all, "/healthz").await;
    assert_eq!(status, 200);
    assert!(
        events_for(&id).is_empty(),
        "a passing health check is not logged"
    );

    let failures = start(config(&[("LOG_REQUESTS", "failures")], roomy())).await;
    let (ok, ok_id) = get_id(&failures, "/app/lookup/x").await;
    let (missing, missing_id) = get_id(&failures, "/app/nothing").await;
    assert_eq!((ok, missing), (200, 404));
    assert!(events_for(&ok_id).is_empty());
    assert_eq!(events_for(&missing_id)[0]["status"], 404);

    let off = start(config(&[("LOG_REQUESTS", "off")], roomy())).await;
    let (status, id) = get_id(&off, "/app/nothing").await;
    assert_eq!(status, 404);
    assert!(events_for(&id).is_empty());
    assert_eq!(
        config(&[("LOG_REQUESTS", "off")], roomy()).log_requests,
        RequestLog::Off
    );
}

#[tokio::test]
async fn client_address_only_when_asked() {
    let addr = start(config(&[("LOG_CLIENT_ADDR", "true")], roomy())).await;
    let (_, id) = get_id(&addr, "/app/lookup/x").await;
    assert_eq!(events_for(&id)[0]["client"], "127.0.0.1");
}

#[tokio::test]
async fn an_ignored_forwarding_header_names_the_peer_only_when_asked() {
    let addr = start(config(&[("LOG_CLIENT_ADDR", "true")], roomy())).await;
    let mut s = TcpStream::connect(&addr).await.unwrap();
    let req = "GET /app/lookup/x HTTP/1.1\r\nHost: t\r\nX-Real-IP: 203.0.113.9\r\nConnection: close\r\n\r\n";
    s.write_all(req.as_bytes()).await.unwrap();
    s.read_to_end(&mut Vec::new()).await.unwrap();
    let lines = logged().1;
    assert!(
        lines.iter().any(|v| v["event"] == "proxy_header_ignored"
            && v["header"] == "x-real-ip"
            && v["peer"] == "127.0.0.1"
            && v["trusted_proxies_set"] == false),
        "the operator who asked for addresses is told which peer to trust"
    );
}

#[tokio::test]
async fn electrum_failures_are_summarised() {
    capture();
    // A port that was just free and now refuses connections.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = closed.local_addr().unwrap().to_string();
    drop(closed);
    let mut config = node::electrum::Config::new(addr);
    config.max_reconnect_delay = Duration::from_millis(50);
    let client = node::electrum::Client::spawn(config);
    let _reporter = rbitcoin_space::report::report_electrum(Network::Regtest, &client);

    let deadline = Instant::now() + Duration::from_secs(10);
    let attempts = loop {
        let attempts: Vec<u64> = logged()
            .1
            .iter()
            .filter(|v| v["event"] == "electrum_unreachable" && v["network"] == "regtest")
            .map(|v| v["attempts"].as_u64().unwrap())
            .collect();
        if attempts.len() >= 4 || Instant::now() > deadline {
            break attempts;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    // 1, 2, 4, 8… unless the watch coalesced two updates; each line still marks a new power of two.
    assert!(attempts.len() >= 4, "{attempts:?}");
    assert_eq!(attempts[0], 1);
    assert!(
        attempts.windows(2).all(|w| w[1].ilog2() > w[0].ilog2()),
        "{attempts:?}"
    );
}

#[tokio::test]
async fn electrum_reporter_sees_a_client_that_is_already_up() {
    use tokio::io::{AsyncBufReadExt, BufReader};
    capture();
    // A minimal Electrum server: answers the handshake, then keeps the connection open.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (rd, mut wr) = stream.into_split();
        let mut lines = BufReader::new(rd).lines();
        let genesis = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).unwrap();
            let result = match req["method"].as_str().unwrap() {
                "server.version" => serde_json::json!(["probe-electrum 1.0", "1.6"]),
                "blockchain.headers.subscribe" => serde_json::json!({"height": 0, "hex": genesis}),
                _ => Value::Null,
            };
            let reply = serde_json::json!({"jsonrpc": "2.0", "id": req["id"], "result": result});
            wr.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
        }
    });
    let client = node::electrum::Client::spawn(node::electrum::Config::new(addr));
    let mut health = client.health();
    tokio::time::timeout(Duration::from_secs(5), health.wait_for(|h| h.ready))
        .await
        .unwrap()
        .unwrap();

    let _reporter = rbitcoin_space::report::report_electrum(Network::Testnet4, &client);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let connected = logged()
            .1
            .into_iter()
            .find(|v| v["event"] == "electrum_connected" && v["network"] == "testnet4");
        if let Some(e) = connected {
            assert_eq!(e["server"], "probe-electrum 1.0");
            assert_eq!(e["protocol"], "1.6");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "no electrum_connected for a ready client"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Serves `config` until the returned sender fires; the handle ends when the server has.
async fn start_stoppable(
    config: Config,
) -> (
    String,
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    capture();
    let app = App::new(&config);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let served = tokio::spawn(app.serve(listener, async {
        let _ = stopped.await;
    }));
    (addr, stop, served)
}

/// Sends `count` GETs of `/app/config` down one connection, each naming `client(i)` as the
/// client, and returns how many were answered 200 and 429.
async fn pipeline(addr: &str, count: usize, client: impl Fn(usize) -> String) -> (usize, usize) {
    let raw = exchange(addr, count, |i| {
        format!(
            "GET /app/config HTTP/1.1\r\nHost: t\r\nX-Forwarded-For: {}\r\n",
            client(i)
        )
    })
    .await;
    (
        raw.matches("HTTP/1.1 200").count(),
        raw.matches("HTTP/1.1 429").count(),
    )
}

/// Sends `count` requests down one connection, each `head(i)` (request line and headers without
/// `Connection` or the blank line), and returns every response as text.
async fn exchange(addr: &str, count: usize, head: impl Fn(usize) -> String) -> String {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let mut reqs = String::new();
    for i in 0..count {
        let close = if i + 1 == count {
            "close"
        } else {
            "keep-alive"
        };
        reqs.push_str(&format!("{}Connection: {close}\r\n\r\n", head(i)));
    }
    let (mut rd, mut wr) = stream.split();
    let (_, raw) = tokio::join!(wr.write_all(reqs.as_bytes()), async {
        let mut raw = Vec::new();
        rd.read_to_end(&mut raw).await.unwrap();
        raw
    });
    String::from_utf8_lossy(&raw).into_owned()
}

/// A browser's preflight for a cross-origin POST to the API, from `client`.
fn preflight(client: &str) -> String {
    format!(
        "OPTIONS /signet/api/tx HTTP/1.1\r\nHost: t\r\nOrigin: https://wallet.example\r\n\
         Access-Control-Request-Method: POST\r\nX-Forwarded-For: {client}\r\n"
    )
}

fn proxied(limits: Limits) -> Config {
    config(
        &[
            ("LOG_CLIENT_ADDR", "true"),
            ("TRUSTED_PROXY_HEADER", "X-Forwarded-For"),
            ("TRUSTED_PROXIES", "127.0.0.1"),
        ],
        limits,
    )
}

#[tokio::test]
async fn a_flood_of_refusals_writes_the_same_few_lines_whatever_its_size() {
    let limits = Limits {
        client_burst: 5,
        client_rate_per_sec: 1,
        ..Limits::default()
    };
    let mut written = Vec::new();
    for (n, burst) in [(1, 100), (2, 3000)] {
        let ip = format!("198.51.100.{n}");
        let (addr, stop, served) = start_stoppable(proxied(limits.clone())).await;
        let (ok, refused) = pipeline(&addr, burst, |_| ip.clone()).await;
        assert_eq!(ok + refused, burst);
        assert!(refused >= burst - 10, "{ok} served");
        stop.send(()).unwrap();
        served.await.unwrap();

        let lines: Vec<Value> = logged()
            .1
            .into_iter()
            .filter(|v| v["client"] == ip.as_str() || v["top_client"] == ip.as_str())
            .collect();
        let requests: Vec<&Value> = lines
            .iter()
            .filter(|v| v["event"] == "http_request")
            .collect();
        // Every served request has its line; of the refused, only the first.
        assert_eq!(
            requests.iter().filter(|v| v["status"] == 200).count(),
            ok,
            "one event per request served"
        );
        let first: Vec<_> = requests.iter().filter(|v| v["status"] == 429).collect();
        assert_eq!(first.len(), 1, "{first:?}");
        assert_eq!(first[0]["refused"], "client_rate");
        let summaries: Vec<_> = lines
            .iter()
            .filter(|v| v["event"] == "requests_refused")
            .collect();
        assert_eq!(summaries.len(), 1, "{summaries:?}");
        let s = summaries[0];
        assert_eq!(s["level"], "warn");
        assert_eq!(s["total"], refused);
        assert_eq!(s["logged"], 1);
        assert_eq!(s["reasons"]["client_rate"], refused);
        assert_eq!(s["routes"]["app"], refused);
        assert_eq!(s["clients"], 1);
        assert_eq!(s["top_client_refused"], refused);
        assert_eq!(s["untrusted_forwarded"], 0);
        written.push(lines.len() - ok);
    }
    assert_eq!(written, [2, 2], "lines beyond the served ones: {written:?}");
}

#[tokio::test]
async fn many_clients_each_over_its_limit_share_one_summary() {
    const CLIENTS: usize = 300;
    let limits = Limits {
        client_burst: 1,
        client_rate_per_sec: 1,
        ..Limits::default()
    };
    let (addr, stop, served) = start_stoppable(proxied(limits)).await;
    let client = |i: usize| format!("10.9.{}.{}", i / 3 / 256, i / 3 % 256);
    // Three requests each, back to back: the first served, the next two refused.
    let (ok, refused) = pipeline(&addr, CLIENTS * 3, client).await;
    assert_eq!((ok, refused), (CLIENTS, 2 * CLIENTS));
    stop.send(()).unwrap();
    served.await.unwrap();

    let lines = logged().1;
    let ours = |v: &&Value| v["client"].as_str().is_some_and(|c| c.starts_with("10.9."));
    let requests = lines
        .iter()
        .filter(|v| v["event"] == "http_request")
        .filter(ours);
    assert_eq!(requests.filter(|v| v["status"] == 429).count(), 1);
    let s = lines
        .iter()
        .find(|v| {
            v["event"] == "requests_refused"
                && v["top_client"]
                    .as_str()
                    .is_some_and(|c| c.starts_with("10.9."))
        })
        .expect("one summary for every client");
    assert_eq!(s["total"], refused);
    assert!(s["top_client_refused"].as_u64() <= Some(2), "{s}");
    assert_eq!(s["proxy_keyed"], 0);
    let clients = s["clients"].as_u64().unwrap();
    assert!((290..=310).contains(&clients), "{clients}");
}

#[tokio::test]
async fn a_proxy_missing_from_trusted_proxies_is_told_apart() {
    let limits = Limits {
        client_burst: 1,
        client_rate_per_sec: 1,
        ..Limits::default()
    };
    // The header is configured but the peer is not a trusted proxy: every request is the peer's.
    let config = config(
        &[
            ("TRUSTED_PROXY_HEADER", "X-Forwarded-For"),
            ("TRUSTED_PROXIES", "192.0.2.1"),
        ],
        limits,
    );
    let (addr, stop, served) = start_stoppable(config).await;
    let (ok, refused) = pipeline(&addr, 50, |i| format!("198.51.100.{i}")).await;
    assert_eq!((ok, refused), (1, 49));
    stop.send(()).unwrap();
    served.await.unwrap();
    let lines = logged().1;
    let s = lines
        .iter()
        .find(|v| v["event"] == "requests_refused" && v["untrusted_forwarded"] == 49)
        .expect("the summary says the forwarding header was ignored");
    assert_eq!(s["clients"], 1);
    assert_eq!(s["top_client_refused"], 49);
    // Said at the first request already, before any refusal. Without `LOG_CLIENT_ADDR` the peer
    // is not named: without a proxy in front it is the visitor.
    let ignored: Vec<&Value> = lines
        .iter()
        .filter(|v| v["event"] == "proxy_header_ignored" && v["trusted_proxies_set"] == true)
        .collect();
    let first = ignored
        .iter()
        .find(|v| v["total"] == 1)
        .expect("said at once");
    assert_eq!(
        (first["level"].as_str(), first["header"].as_str()),
        (Some("warn"), Some("x-forwarded-for"))
    );
    assert!(first["peer"].is_null(), "{first}");
    assert_eq!(
        ignored.len(),
        6,
        "at 1, 2, 4, 8, 16 and 32 of 50: {ignored:?}"
    );
}

#[tokio::test]
async fn a_refusal_answered_before_routing_is_the_routed_one() {
    let limits = Limits {
        client_burst: 1,
        client_rate_per_sec: 1,
        ..Limits::default()
    };
    for path in ["/signet/api/blocks/tip/height", "/app/config", "/healthz"] {
        let addr = start(config(&[], limits.clone())).await;
        let mut stream = TcpStream::connect(&addr).await.unwrap();
        let req = |close| format!("GET {path} HTTP/1.1\r\nHost: t\r\nConnection: {close}\r\n\r\n");
        let reqs = [req("keep-alive"), req("keep-alive"), req("close")].concat();
        stream.write_all(reqs.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let raw = String::from_utf8(raw).unwrap();
        // Served; refused and routed to be logged; refused before routing.
        let responses: Vec<String> = raw
            .split("HTTP/1.1 ")
            .skip(1)
            .map(|r| {
                r.lines()
                    .filter(|l| {
                        !["x-request-id:", "date:", "connection:"]
                            .iter()
                            .any(|h| l.starts_with(h))
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .collect();
        assert_eq!(responses.len(), 3, "{raw}");
        assert!(responses[1].starts_with("429"), "{}", responses[1]);
        assert_eq!(responses[1], responses[2], "{path}");
        assert_eq!(
            raw.matches("x-request-id:").count(),
            3,
            "every response has an id"
        );
    }
}

#[tokio::test]
async fn a_preflight_flood_is_refused_past_its_limit_and_summarised() {
    let limits = Limits {
        client_burst: 5,
        client_rate_per_sec: 1,
        ..Limits::default()
    };
    let ip = "198.51.100.60";
    let (addr, stop, served) = start_stoppable(proxied(limits)).await;
    let raw = exchange(&addr, 500, |_| preflight(ip)).await;
    let (ok, refused) = (
        raw.matches("HTTP/1.1 204").count(),
        raw.matches("HTTP/1.1 429").count(),
    );
    assert_eq!(ok + refused, 500, "{raw}");
    assert!((5..=10).contains(&ok), "{ok} served");
    // The flood spent the preflights' allowance, not the API's.
    let (api_ok, _) = pipeline(&addr, 5, |_| ip.to_owned()).await;
    assert_eq!(api_ok, 5);
    stop.send(()).unwrap();
    served.await.unwrap();

    let lines: Vec<Value> = logged()
        .1
        .into_iter()
        .filter(|v| v["client"] == ip || v["top_client"] == ip)
        .collect();
    let requests: Vec<&Value> = lines
        .iter()
        .filter(|v| v["event"] == "http_request")
        .collect();
    assert_eq!(requests.iter().filter(|v| v["status"] == 204).count(), ok);
    let first: Vec<_> = requests.iter().filter(|v| v["status"] == 429).collect();
    assert_eq!(first.len(), 1, "{first:?}");
    assert_eq!(first[0]["refused"], "client_rate");
    let summaries: Vec<_> = lines
        .iter()
        .filter(|v| v["event"] == "requests_refused")
        .collect();
    assert_eq!(summaries.len(), 1, "{summaries:?}");
    assert_eq!(summaries[0]["total"], refused);
    assert_eq!(summaries[0]["routes"]["api"], refused);
}

#[tokio::test]
async fn an_honest_page_is_never_refused_a_preflight_or_its_request() {
    let limits = Limits {
        client_burst: 3,
        client_rate_per_sec: 20,
        ..Limits::default()
    };
    let ip = "198.51.100.61";
    let (addr, stop, served) = start_stoppable(proxied(limits)).await;
    let pair = |i: usize| {
        if i == 0 {
            preflight(ip)
        } else {
            format!("GET /app/config HTTP/1.1\r\nHost: t\r\nX-Forwarded-For: {ip}\r\n")
        }
    };
    // A whole burst of calls at once, each with its preflight; then calls at a little under the
    // sustained rate (one token every 50 ms).
    for _ in 0..3 {
        let raw = exchange(&addr, 2, pair).await;
        assert!(!raw.contains("HTTP/1.1 429"), "{raw}");
    }
    for _ in 0..15 {
        tokio::time::sleep(Duration::from_millis(60)).await;
        let raw = exchange(&addr, 2, pair).await;
        assert!(raw.starts_with("HTTP/1.1 204"), "{raw}");
        assert!(raw.contains("HTTP/1.1 200"), "{raw}");
    }
    stop.send(()).unwrap();
    served.await.unwrap();
}

#[tokio::test]
async fn preflights_from_many_clients_share_one_summary() {
    const CLIENTS: usize = 300;
    let limits = Limits {
        client_burst: 1,
        client_rate_per_sec: 1,
        ..Limits::default()
    };
    let (addr, stop, served) = start_stoppable(proxied(limits)).await;
    let client = |i: usize| format!("10.10.{}.{}", i / 3 / 256, i / 3 % 256);
    let raw = exchange(&addr, CLIENTS * 3, |i| preflight(&client(i))).await;
    let refused = raw.matches("HTTP/1.1 429").count();
    assert_eq!(raw.matches("HTTP/1.1 204").count(), CLIENTS);
    assert_eq!(refused, 2 * CLIENTS);
    stop.send(()).unwrap();
    served.await.unwrap();

    let lines = logged().1;
    let ours = |v: &&Value| {
        v["client"]
            .as_str()
            .is_some_and(|c| c.starts_with("10.10."))
    };
    let requests = lines
        .iter()
        .filter(|v| v["event"] == "http_request")
        .filter(ours);
    assert_eq!(requests.filter(|v| v["status"] == 429).count(), 1);
    let s = lines
        .iter()
        .find(|v| {
            v["event"] == "requests_refused"
                && v["top_client"]
                    .as_str()
                    .is_some_and(|c| c.starts_with("10.10."))
        })
        .expect("one summary for every client");
    assert_eq!(s["total"], refused);
    assert_eq!(s["routes"]["api"], refused);
}
