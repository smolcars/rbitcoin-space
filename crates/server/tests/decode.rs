//! `POST /app/decode` through the whole router: a regtest server with Lightning on (its peer
//! unreachable), a graph index the test installs, the body cap, the rate limit and the log.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashMap;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use bitcoin::hashes::{Hash, sha256};
use bitcoin::secp256k1::{PublicKey, Secp256k1, SecretKey};
use engine::lightning::{Announcement, GraphChannel, GraphNode, Index, Past};
use lightning::bolt11_invoice::{
    Currency, InvoiceBuilder, PaymentSecret, RouteHint, RouteHintHop, RoutingFees,
};
use logging::{Format, Level, Settings};
use rbitcoin_space::decode::{CLIENT_BURST, MAX_BODY};
use rbitcoin_space::{App, Config};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const PEER: &str = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@127.0.0.1:1";
/// A channel the graph holds, and one it does not.
const KNOWN_SCID: u64 = 101 << 40 | 2 << 16 | 1;
const PRIVATE_SCID: u64 = 102 << 40 | 3 << 16;

struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn key(n: u8) -> (SecretKey, PublicKey) {
    let sk = SecretKey::from_slice(&[n; 32]).unwrap();
    (sk, PublicKey::from_secret_key(&Secp256k1::new(), &sk))
}

/// A regtest invoice paid through a hint: the known channel from node 2, then the unknown one
/// from node 3 to the payee, node 1.
fn invoice() -> String {
    let secp = Secp256k1::new();
    let hop = |n: u8, scid| RouteHintHop {
        src_node_id: key(n).1,
        short_channel_id: scid,
        fees: RoutingFees {
            base_msat: 1_000,
            proportional_millionths: 100,
        },
        cltv_expiry_delta: 40,
        htlc_minimum_msat: None,
        htlc_maximum_msat: None,
    };
    InvoiceBuilder::new(Currency::Regtest)
        .description("Coffee <script>".to_owned())
        .payment_hash(sha256::Hash::hash(b"preimage"))
        .payment_secret(PaymentSecret([9; 32]))
        .duration_since_epoch(Duration::from_secs(1_790_000_000))
        .min_final_cltv_expiry_delta(144)
        .amount_milli_satoshis(21_000)
        .private_route(RouteHint(vec![hop(2, KNOWN_SCID), hop(3, PRIVATE_SCID)]))
        .build_signed(|m| secp.sign_ecdsa_recoverable(m, &key(1).0))
        .unwrap()
        .to_string()
}

async fn start(dir: &Dir) -> (String, Arc<rbitcoin_space::lightning::Lightning>) {
    capture();
    let vars: HashMap<&str, String> = [
        ("REGTEST_RPC_HOST", "127.0.0.1".to_owned()),
        ("REGTEST_RPC_PORT", "1".to_owned()),
        ("REGTEST_RPC_USER", "u".to_owned()),
        ("REGTEST_RPC_PASSWORD", "p".to_owned()),
        ("REGTEST_ESPLORA_URL", "http://127.0.0.1:1".to_owned()),
        ("REGTEST_ELECTRUM_ADDR", "127.0.0.1:1".to_owned()),
        ("REGTEST_MEMPOOL_ENABLED", "false".to_owned()),
        ("REGTEST_LIGHTNING_ENABLED", "true".to_owned()),
        ("REGTEST_LIGHTNING_PEERS", PEER.to_owned()),
        ("BACKFILL_ENABLED", "false".to_owned()),
        ("DATA_DIR", dir.0.display().to_string()),
        ("TRUSTED_PROXY_HEADER", "X-Real-IP".to_owned()),
        ("TRUSTED_PROXIES", "127.0.0.1".to_owned()),
    ]
    .into_iter()
    .collect();
    let mut config = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
    config.limits.client_rate_per_sec = 10_000;
    config.limits.client_burst = 10_000;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let app = App::new(&config);
    let ln = app.lightning().first().cloned().unwrap();
    tokio::spawn(app.serve(listener, std::future::pending()));
    (addr, ln)
}

#[derive(Debug)]
struct Reply {
    status: u16,
    head: String,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

async fn post(addr: &str, body: &[u8], ip: &str) -> Reply {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "POST /app/decode HTTP/1.1\r\nHost: t\r\nConnection: close\r\nX-Real-IP: {ip}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let _ = stream.write_all(body).await;
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

fn graph() -> Index {
    let node = |n: u8, alias: &str| GraphNode {
        id: key(n).1.serialize(),
        announcement: Some(Announcement {
            alias: alias.to_owned(),
            color: [0, 0, 0],
            addresses: Vec::new(),
            features: Vec::new(),
            last_update: 1_790_000_000,
        }),
    };
    let channel = GraphChannel {
        scid: KNOWN_SCID,
        nodes: [key(2).1.serialize(), key(4).1.serialize()],
        capacity: 1_000_000,
        policies: [None, None],
    };
    Index::build(
        vec![node(2, "Hop <b>two</b>"), node(4, "Four")],
        vec![channel],
        &Past::default(),
    )
}

#[tokio::test]
async fn decodes_names_from_the_graph_caps_limits_and_logs_nothing_of_the_string() {
    let dir =
        Dir(std::env::temp_dir().join(format!("rbitcoin-space-decode-{}", std::process::id())));
    let _ = std::fs::remove_dir_all(&dir.0);
    let (addr, ln) = start(&dir).await;
    let invoice = invoice();

    // The graph is still syncing: the keys come without names, and the answer is still 200.
    let r = post(
        &addr,
        format!("  lightning:{}\n", invoice.to_uppercase()).as_bytes(),
        "192.0.2.1",
    )
    .await;
    assert_eq!(r.status, 200, "{r:?}");
    assert!(r.head.contains("cache-control: no-store"), "{}", r.head);
    let j = r.json();
    assert_eq!(j["kind"], "bolt11");
    assert_eq!(j["network"], "regtest");
    assert_eq!(j["names"], Value::Null);
    assert_eq!(j["payee"]["known"], Value::Null);
    assert_eq!(j["description"], "Coffee <script>");
    assert_eq!(j["created"], 1_790_000_000);

    // With an index, the matching network names what it knows.
    ln.set_index(graph());
    let j = post(&addr, invoice.as_bytes(), "192.0.2.1").await.json();
    assert_eq!(j["names"], "regtest");
    assert_eq!(j["payee"]["key"], key(1).1.to_string());
    assert_eq!(j["payee"]["known"], false);
    let hops = &j["hints"][0];
    assert_eq!(hops[0]["node"]["alias"], "Hop <b>two</b>");
    assert_eq!(hops[0]["node"]["known"], true);
    assert_eq!(hops[0]["channel"]["known"], true);
    assert_eq!(hops[0]["channel"]["scid"], "101x2x1");
    assert_eq!(hops[1]["node"]["known"], false);
    assert_eq!(hops[1]["channel"]["known"], false);

    // A mainnet string on a server without mainnet: decoded, nothing named.
    let spec: Value =
        serde_json::from_str(include_str!("../../../fixtures/decode/bolt11.json")).unwrap();
    let mainnet = spec["valid"][0]["string"].as_str().unwrap();
    let j = post(&addr, mainnet.as_bytes(), "192.0.2.1").await.json();
    assert_eq!(j["network"], "mainnet");
    assert_eq!(j["names"], Value::Null);

    // The typed reasons, never LDK's text and never the input.
    let mut typo = invoice.clone().into_bytes();
    let last = typo.len() - 1;
    typo[last] = if typo[last] == b'q' { b'p' } else { b'q' };
    for (body, status, error) in [
        (typo, 400, "bad checksum"),
        (b"hello".to_vec(), 400, "not recognised"),
        (vec![0xff, 0xfe], 400, "not recognised"),
        (b"me@example".to_vec(), 400, "malformed"),
        (vec![b'a'; MAX_BODY], 400, "not recognised"),
        (vec![b'a'; MAX_BODY + 1], 413, "too long"),
    ] {
        let r = post(&addr, &body, "192.0.2.1").await;
        assert_eq!(
            (r.status, r.json()["error"].as_str().unwrap()),
            (status, error)
        );
    }

    // Each client has its own budget: a burst, then refused; another client is not.
    let mut statuses = Vec::new();
    for _ in 0..=CLIENT_BURST {
        statuses.push(
            post(&addr, b"satoshi@bitcoin.org", "198.51.100.7")
                .await
                .status,
        );
    }
    assert!(
        statuses[..CLIENT_BURST as usize - 1]
            .iter()
            .all(|s| *s == 200)
    );
    assert_eq!(statuses.last(), Some(&429));
    assert_eq!(
        post(&addr, b"satoshi@bitcoin.org", "198.51.100.8")
            .await
            .status,
        200
    );

    // The log names the route, never the string or what it decodes to.
    logging::flush(Duration::from_secs(1));
    let log = String::from_utf8(capture().0.lock().unwrap().clone()).unwrap();
    assert!(log.contains("\"route\":\"/app/decode\""), "{log}");
    for secret in [
        &invoice[..40],
        &invoice[invoice.len() - 40..],
        "satoshi",
        "Coffee",
    ] {
        assert!(
            !log.to_lowercase().contains(&secret.to_lowercase()),
            "{secret} was logged"
        );
    }
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
