//! A log output that stops taking writes, like a full or hung disk, must never hold up a
//! request (docs/LOGGING.md, "Output"). A binary of its own, since the logger is set once per
//! process and here it is the blocked one.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use logging::{Format, Level, QUEUE_LINES, Settings};
use rbitcoin_space::{App, Config, Limits};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Output whose writes wait while the gate is shut.
#[derive(Clone)]
struct Gated {
    open: Arc<(Mutex<bool>, Condvar)>,
    out: Arc<Mutex<Vec<u8>>>,
}

impl Write for Gated {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let (lock, cvar) = &*self.open;
        drop(
            cvar.wait_while(lock.lock().unwrap(), |open| !*open)
                .unwrap(),
        );
        self.out.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stalled_log_never_holds_up_a_request() {
    let gate = Gated {
        open: Arc::new((Mutex::new(false), Condvar::new())),
        out: Arc::default(),
    };
    let settings = Settings {
        format: Format::Json,
        level: Level::Info,
        max_bytes_per_sec: logging::DEFAULT_MAX_BYTES_PER_SEC,
    };
    assert!(logging::init(settings, gate.clone()));

    let vars: HashMap<&str, &str> = HashMap::from([
        ("REGTEST_RPC_HOST", "127.0.0.1"),
        ("REGTEST_RPC_PORT", "1"),
        ("REGTEST_RPC_USER", "u"),
        ("REGTEST_RPC_PASSWORD", "p"),
        ("REGTEST_ESPLORA_URL", "http://127.0.0.1:1"),
        ("REGTEST_ELECTRUM_ADDR", "127.0.0.1:1"),
        ("REGTEST_MEMPOOL_ENABLED", "false"),
    ]);
    let mut config = Config::from_vars(|k| vars.get(k).map(|v| (*v).to_owned())).unwrap();
    config.web_dir = Some(std::env::temp_dir().join("rbitcoin-space-no-web-dir"));
    config.limits = Limits {
        client_burst: 1_000_000,
        client_rate_per_sec: 1_000_000,
        ..Limits::default()
    };
    let app = App::new(&config);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(app.serve(listener, std::future::pending()));

    // More served requests than the queue holds, each one an event the writer cannot write.
    let count = QUEUE_LINES * 2;
    let mut reqs = String::new();
    for i in 0..count {
        let close = if i + 1 == count {
            "close"
        } else {
            "keep-alive"
        };
        reqs.push_str(&format!(
            "GET /app/config HTTP/1.1\r\nHost: t\r\nConnection: {close}\r\n\r\n"
        ));
    }
    let mut stream = TcpStream::connect(&addr).await.unwrap();
    let (mut rd, mut wr) = stream.split();
    let (_, raw) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(wr.write_all(reqs.as_bytes()), async {
            let mut raw = Vec::new();
            rd.read_to_end(&mut raw).await.unwrap();
            raw
        })
    })
    .await
    .expect("requests were held up by the log");
    let ok = String::from_utf8_lossy(&raw)
        .matches("HTTP/1.1 200")
        .count();
    assert_eq!(
        ok, count,
        "every request answered while the log was stalled"
    );

    // Unblock: what fit in the queue is written, the rest is counted as dropped.
    *gate.open.0.lock().unwrap() = true;
    gate.open.1.notify_all();
    logging::flush(Duration::from_secs(5));
    let out = String::from_utf8(gate.out.lock().unwrap().clone()).unwrap();
    let lines: Vec<Value> = out
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let written = lines
        .iter()
        .filter(|v| v["event"] == "http_request")
        .count();
    let dropped: u64 = lines
        .iter()
        .filter(|v| v["event"] == "log_events_dropped")
        .map(|v| v["events"]["http_request"].as_u64().unwrap_or(0))
        .sum();
    assert!(written <= QUEUE_LINES + 1, "{written}");
    assert_eq!(written as u64 + dropped, count as u64, "written or counted");
}
