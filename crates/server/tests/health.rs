//! Liveness, readiness and the node check, against a mock RPC on port 0. Nothing here reaches a
//! real node.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::Router;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::post;
use logging::{Format, Level, Settings};
use rbitcoin_space::{App, Config};
use serde_json::{Value, json};
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

async fn logged(f: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        logging::flush(Duration::from_secs(1));
        let raw = String::from_utf8(capture().0.lock().unwrap().clone()).unwrap();
        if let Some(v) = raw
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .find(|v| f(v))
        {
            return v;
        }
        assert!(Instant::now() < deadline, "not logged");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A node RPC that refuses every call with 401 while `refuse` is set, and otherwise answers
/// `getblockchaininfo` for `chain`. Returns its port.
async fn rpc(refuse: Arc<AtomicBool>, chain: &'static str) -> u16 {
    let app = Router::new().route(
        "/",
        post(move || {
            let refuse = refuse.load(Ordering::SeqCst);
            async move {
                if refuse {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(json!({"id": 0, "error": null, "result": {
                    "chain": chain, "blocks": 110, "headers": 110,
                    "bestblockhash": "3fa932c75119e4a4f4c4f5f43afe8fec03c5f3bc9b84fbadd1e96dd34bc6654d",
                    "bits": "207fffff", "target": "7fffff0000000000000000000000000000000000000000000000000000000000",
                    "difficulty": 4.6e-10, "time": 1_700_000_000, "mediantime": 1_700_000_000,
                    "verificationprogress": 1.0, "initialblockdownload": false,
                    "chainwork": "00000000000000000000000000000000000000000000000000000000000000de",
                    "size_on_disk": 1, "pruned": false
                }}))
                .into_response()
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    port
}

/// The server with regtest pointed at the mock RPC; Esplora and Electrum lead nowhere.
async fn start(rpc_port: u16) -> String {
    capture();
    let vars: HashMap<&str, String> = [
        ("REGTEST_RPC_HOST", "127.0.0.1".to_owned()),
        ("REGTEST_RPC_PORT", rpc_port.to_string()),
        ("REGTEST_RPC_USER", "u".to_owned()),
        ("REGTEST_RPC_PASSWORD", "wrong-password".to_owned()),
        ("REGTEST_ESPLORA_URL", "http://127.0.0.1:1".to_owned()),
        ("REGTEST_ELECTRUM_ADDR", "127.0.0.1:1".to_owned()),
        ("REGTEST_MEMPOOL_ENABLED", "false".to_owned()),
    ]
    .into_iter()
    .collect();
    let mut config = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
    config.web_dir = Some(std::env::temp_dir().join("rbitcoin-space-no-web-dir"));
    let app = App::new(&config);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(app.serve(listener, std::future::pending()));
    addr
}

async fn get(addr: &str, path: &str) -> (u16, String) {
    let mut s = TcpStream::connect(addr).await.unwrap();
    let req = format!("GET {path} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut raw = String::new();
    s.read_to_string(&mut raw).await.unwrap();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    (head[9..12].parse().unwrap(), body.to_owned())
}

#[tokio::test]
async fn a_refused_password_is_logged_at_startup_and_clients_learn_only_unavailable() {
    let port = rpc(Arc::new(AtomicBool::new(true)), "regtest").await;
    let addr = start(port).await;
    // At startup, without any request: its own error event, not a network problem.
    let e = logged(|v| v["event"] == "rpc_auth_failed").await;
    assert_eq!(
        (e["level"].as_str(), e["network"].as_str()),
        (Some("error"), Some("regtest"))
    );
    // The server keeps running, and a client is told nothing more than "unavailable".
    let hash = "3fa932c75119e4a4f4c4f5f43afe8fec03c5f3bc9b84fbadd1e96dd34bc6654d";
    let (status, body) = get(&addr, &format!("/regtest/app/block/{hash}/summary")).await;
    assert_eq!(
        (status, body.as_str()),
        (502, r#"{"error":"upstream unavailable"}"#)
    );
    let request = logged(|v| v["event"] == "http_request" && v["status"] == 502).await;
    assert_eq!(request["upstream_error"], "auth");
    assert!(!body.contains("auth"));
    // Readiness names the cause.
    let (status, body) = get(&addr, "/readyz").await;
    let ready: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(status, 503);
    assert_eq!(ready["networks"]["regtest"]["rpc"], "auth_failed");
}

#[tokio::test]
async fn a_node_on_another_chain_is_an_error_and_not_ready() {
    // The regtest variables point at a mainnet node.
    let port = rpc(Arc::new(AtomicBool::new(false)), "main").await;
    let addr = start(port).await;
    let e = logged(|v| v["event"] == "rpc_wrong_network").await;
    assert_eq!(
        (
            e["level"].as_str(),
            e["network"].as_str(),
            e["node_chain"].as_str()
        ),
        (Some("error"), Some("regtest"), Some("main"))
    );
    let (status, body) = get(&addr, "/readyz").await;
    let ready: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(status, 503);
    assert_eq!(ready["networks"]["regtest"]["rpc"], "wrong_network");
}

#[tokio::test]
async fn liveness_ignores_the_node_and_readiness_does_not() {
    let port = rpc(Arc::new(AtomicBool::new(false)), "regtest").await;
    let addr = start(port).await;
    logged(|v| v["event"] == "rpc_reachable" && v["height"] == 110).await;
    // RPC answers, but Electrum is unreachable: alive, not ready, and the body says which part.
    assert_eq!(get(&addr, "/healthz").await.0, 200);
    let (status, body) = get(&addr, "/readyz").await;
    let ready: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(status, 503);
    let n = &ready["networks"]["regtest"];
    assert_eq!(ready["status"], "not_ready");
    assert_eq!(
        (n["ready"].as_bool(), n["rpc"].as_str()),
        (Some(false), Some("ok"))
    );
    assert_eq!(
        (n["electrum"].as_bool(), n["tip_height"].as_u64()),
        (Some(false), None)
    );
    assert!(n["rpc_checked_secs_ago"].as_u64().unwrap() < 5);

    // With no network at all there is nothing to wait for.
    let empty = Config::from_vars(|_| None).unwrap();
    let app = App::new(&empty);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let other = listener.local_addr().unwrap().to_string();
    tokio::spawn(app.serve(listener, std::future::pending()));
    let (status, body) = get(&other, "/readyz").await;
    assert_eq!(
        (status, body.as_str()),
        (200, r#"{"networks":{},"status":"ready"}"#)
    );
}

/// The server with regtest on the mock RPC and a store in `dir`, and that store.
async fn start_stored(rpc_port: u16, dir: &std::path::Path) -> (String, Arc<engine::store::Store>) {
    capture();
    let vars: HashMap<&str, String> = [
        ("REGTEST_RPC_HOST", "127.0.0.1".to_owned()),
        ("REGTEST_RPC_PORT", rpc_port.to_string()),
        ("REGTEST_RPC_USER", "u".to_owned()),
        ("REGTEST_RPC_PASSWORD", "p".to_owned()),
        ("REGTEST_ESPLORA_URL", "http://127.0.0.1:1".to_owned()),
        ("REGTEST_ELECTRUM_ADDR", "127.0.0.1:1".to_owned()),
        ("DATA_DIR", dir.display().to_string()),
    ]
    .into_iter()
    .collect();
    let mut config = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
    config.web_dir = Some(std::env::temp_dir().join("rbitcoin-space-no-web-dir"));
    let app = App::new(&config);
    let store = app
        .network(rbitcoin_space::Network::Regtest)
        .and_then(|n| Some(Arc::clone(&n.blocks.as_ref()?.store)))
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(app.serve(listener, std::future::pending()));
    (addr, store)
}

async fn store_state(addr: &str) -> Value {
    let (_, body) = get(addr, "/readyz").await;
    let ready: Value = serde_json::from_str(&body).unwrap();
    ready["networks"]["regtest"]["store"].clone()
}

#[tokio::test]
async fn a_node_on_another_chain_gets_nothing_written_and_the_right_one_does() {
    // Every writer is started, against a node that says it is on mainnet.
    let dir = std::env::temp_dir().join(format!("rbitcoin-space-health-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let port = rpc(Arc::new(AtomicBool::new(false)), "main").await;
    let (addr, store) = start_stored(port, &dir).await;
    logged(|v| v["event"] == "rpc_wrong_network").await;
    assert_eq!(store_state(&addr).await, "waiting");
    // A write, as any writer makes one, waits instead of landing; none has committed.
    let write = store.write(|_| Ok(()));
    assert!(
        tokio::time::timeout(Duration::from_millis(300), write)
            .await
            .is_err()
    );
    assert!(store.write_health().last_ok.is_none());

    // A regtest node: the writers get in.
    let port = rpc(Arc::new(AtomicBool::new(false)), "regtest").await;
    drop(store);
    let other = dir.join("again");
    let (addr, store) = start_stored(port, &other).await;
    let deadline = Instant::now() + Duration::from_secs(5);
    while store_state(&addr).await != "ok" {
        assert!(Instant::now() < deadline, "never ok");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    store.write(|_| Ok(())).await.unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

/// A read the store refuses, whichever task made it and whether or not that task drops the
/// error, is logged with which read and SQLite's error kind and message, and so is its recovery.
#[tokio::test]
async fn a_failing_store_read_is_logged_with_its_read_and_kind_then_its_recovery() {
    use engine::store::Read;
    let dir = std::env::temp_dir().join(format!("rbitcoin-space-read-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let port = rpc(Arc::new(AtomicBool::new(false)), "regtest").await;
    let (_, store) = start_stored(port, &dir).await;
    let gone = store
        .read(Read::LightningIndex, |sql| {
            Ok(sql
                .prepare("SELECT count(*) FROM gone")?
                .query_row([], |r| r.get::<_, i64>(0))?)
        })
        .await;
    assert!(gone.is_err());
    let failed =
        logged(|v| v["event"] == "store_read_failed" && v["read"] == "lightning_index").await;
    assert_eq!(
        (&failed["network"], &failed["error"], &failed["failures"]),
        (&"regtest".into(), &"other".into(), &1.into())
    );
    assert_eq!(failed["sqlite"], "no such table: gone");
    store
        .read(Read::LightningIndex, |sql| {
            Ok(sql
                .prepare("SELECT 1")?
                .query_row([], |r| r.get::<_, i64>(0))?)
        })
        .await
        .unwrap();
    let recovered =
        logged(|v| v["event"] == "store_read_recovered" && v["read"] == "lightning_index").await;
    assert_eq!(recovered["failures"], 1);
    let _ = std::fs::remove_dir_all(&dir);
}
