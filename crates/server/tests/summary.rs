//! The block summary routes against a mock JSON-RPC node on port 0. Nothing here reaches a node.
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
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use axum::routing::post;
use logging::{Format, Level, Settings};
use rbitcoin_space::summary::{CLIENT_BURST, MAX_PENDING};
use rbitcoin_space::{App, Config, IMMUTABLE};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// A block's facts name its miner, which a new pool list can change: a day, not `immutable`.
const FACTS: &str = "public, max-age=86400";

/// Transactions in each mock block, the coinbase included.
const TXS: usize = 100;
/// Bytes the server's cache counts for one mock block: header, records, txids and weights, and
/// fixed overhead.
const ENTRY: usize = 8 + 28 * TXS + 36 * TXS + 512;

// The node side.

#[derive(Default)]
struct Node {
    delay: Duration,
    /// `getblock` calls, by hash.
    calls: Mutex<HashMap<String, usize>>,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
    /// While a test holds this for writing, `getblock` answers nothing.
    gate: tokio::sync::RwLock<()>,
    /// What `/block/:hash/raw` answers: [`Raw`] as a `u8`.
    raw: std::sync::atomic::AtomicU8,
}

/// `/block/:hash/raw` answers.
#[derive(Clone, Copy)]
#[repr(u8)]
enum Raw {
    /// The listed transactions.
    Good = 0,
    /// The same transactions, the first two swapped.
    Swapped = 1,
    /// Cut short by one byte.
    Truncated = 2,
    /// One byte over what a block can be.
    TooBig = 3,
}

impl Node {
    fn calls(&self, hash: &str) -> usize {
        self.calls.lock().unwrap().get(hash).copied().unwrap_or(0)
    }

    fn total(&self) -> usize {
        self.calls.lock().unwrap().values().sum()
    }
}

/// Answers `getblock` for any hash not starting `ff` with a block of [`TXS`] transactions:
/// the coinbase, then fee `i * 10` sats on 100 vB. Hashes starting `ff` are unknown (`-5`).
async fn rpc(
    State(node): State<Arc<Node>>,
    Json(req): Json<Value>,
) -> (axum::http::StatusCode, Json<Value>) {
    assert_eq!(
        req["method"], "getblock",
        "the summary routes call nothing else"
    );
    let hash = req["params"][0].as_str().unwrap().to_owned();
    assert_eq!(req["params"][1], 2);
    *node.calls.lock().unwrap().entry(hash.clone()).or_default() += 1;
    let now = node.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
    node.max_in_flight.fetch_max(now, Ordering::SeqCst);
    tokio::time::sleep(node.delay).await;
    drop(node.gate.read().await);
    node.in_flight.fetch_sub(1, Ordering::SeqCst);
    if hash.starts_with("ff") {
        let e =
            json!({"result": null, "error": {"code": -5, "message": "Block not found"}, "id": 0});
        return (axum::http::StatusCode::NOT_FOUND, Json(e));
    }
    (
        axum::http::StatusCode::OK,
        Json(json!({"result": block_json(&hash), "error": null, "id": 0})),
    )
}

/// Foundry USA's first listed payout address, 12KKDt4Mj7N5UAkQMN7LtPZMayenXHa8KL.
const FOUNDRY_PAYOUT: &str = "76a9140e6ed2f95e8a7f3131535472e1009a1c77bd01e588ac";
/// Hostile text a miner could write in its coinbase.
const HOSTILE_TAG: &str = "<img src=x onerror=alert(1)>";

/// Mainnet block 976,280's coinbase script, laid out as Stratum V2's reference implementation
/// writes it: the height, `Sv2/MARA🇺🇸🇺🇸//`, a 20-byte extranonce.
const SV2_SCRIPT: &str = "0398e50e1a5376322f4d415241f09f87baf09f87b8f09f87baf09f87b82f2f\
                          14020000140000000000000000000005cf0007c4fa";
/// The mock's block whose coinbase script is [`SV2_SCRIPT`].
const SV2_BLOCK: u32 = 5;

/// The mock's coinbase for `hash`: block 1 is tagged ViaBTC but pays Foundry USA's address,
/// block [`SV2_BLOCK`] carries [`SV2_SCRIPT`], and every other block carries [`HOSTILE_TAG`];
/// those pay an address no pool lists.
fn coinbase_json(hash: &str) -> (Value, Value) {
    let unlisted = || format!("0014{}", "ab".repeat(20));
    if hash == self::hash(SV2_BLOCK) {
        return (
            json!([{"coinbase": SV2_SCRIPT, "sequence": 0}]),
            json!([{"value": 0.0001, "n": 0, "scriptPubKey": {"hex": unlisted()}}]),
        );
    }
    let (tag, payout) = if hash == self::hash(1) {
        (
            b"\x03\x00\x35\x0c/ViaBTC/".to_vec(),
            FOUNDRY_PAYOUT.to_owned(),
        )
    } else {
        let mut tag = b"\x03\x00\x35\x0c".to_vec();
        tag.extend_from_slice(HOSTILE_TAG.as_bytes());
        (tag, unlisted())
    };
    let hex: String = tag.iter().map(|b| format!("{b:02x}")).collect();
    (
        json!([{"coinbase": hex, "sequence": 0}]),
        json!([{"value": 0.0001, "n": 0, "scriptPubKey": {"hex": payout}},
            {"value": 0.00000002, "n": 1, "scriptPubKey": {"hex": "6a04aaaaaaaa"}}]),
    )
}

/// The mock's `i`th transaction in every block, told apart by its lock time. Only its txid and
/// flags are read.
fn tx(i: usize) -> bitcoin::Transaction {
    use bitcoin::{Amount, OutPoint, ScriptBuf, Sequence, TxIn, TxOut, Witness};
    bitcoin::Transaction {
        version: bitcoin::transaction::Version::TWO,
        lock_time: bitcoin::absolute::LockTime::from_consensus(i as u32),
        input: vec![TxIn {
            previous_output: OutPoint::null(),
            script_sig: ScriptBuf::new(),
            sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::from_sat(1),
            script_pubkey: ScriptBuf::new_op_return([]),
        }],
    }
}

/// What every mock transaction's flags are.
const FLAGS: u64 = engine::flags::RBF | engine::flags::V2 | engine::flags::OP_RETURN;

async fn raw(State(node): State<Arc<Node>>) -> axum::response::Response {
    use axum::response::IntoResponse;
    let mut txdata: Vec<_> = (0..TXS).map(tx).collect();
    let header = bitcoin::constants::genesis_block(bitcoin::Network::Regtest).header;
    let mode = node.raw.load(Ordering::SeqCst);
    if mode == Raw::Swapped as u8 {
        txdata.swap(0, 1);
    }
    let mut bytes = bitcoin::consensus::serialize(&bitcoin::Block { header, txdata });
    if mode == Raw::Truncated as u8 {
        bytes.pop();
    } else if mode == Raw::TooBig as u8 {
        bytes.resize(4_000_001, 0);
    }
    bytes.into_response()
}

/// The block the mock answers for `hash`.
fn block_json(hash: &str) -> Value {
    let tx = (0..TXS)
        .map(|i| {
            let mut t = json!({"txid": tx(i).compute_txid().to_string(), "vsize": 100, "weight": 400, "size": 100,
                "vout": [{"value": 0.0001, "n": 0}, {"value": 0.00000002, "n": 1}]});
            if i > 0 {
                t["fee"] = json!(i as f64 * 10.0 / 1e8);
            } else {
                let (vin, vout) = coinbase_json(hash);
                t["vin"] = vin;
                t["vout"] = vout;
            }
            t
        })
        .collect::<Vec<_>>();
    json!({"hash": hash, "confirmations": 1, "height": 800_000, "time": 1, "mediantime": 1,
        "size": 1000, "strippedsize": 900, "weight": 4000, "tx": tx})
}

async fn mock(delay: Duration) -> (u16, Arc<Node>) {
    let node = Arc::new(Node {
        delay,
        ..Node::default()
    });
    let app = axum::Router::new()
        .route("/", post(rpc))
        .route("/block/{hash}/raw", axum::routing::get(raw))
        .with_state(Arc::clone(&node));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await });
    (port, node)
}

/// The server on port 0 against a mock node answering after `delay`, with room for
/// `cache_entries` summaries. Clients are told apart by `X-Real-IP`.
async fn start(delay: Duration, cache_entries: usize) -> (String, Arc<Node>) {
    start_with(delay, cache_entries, &[]).await
}

async fn start_with(
    delay: Duration,
    cache_entries: usize,
    extra: &[(&'static str, String)],
) -> (String, Arc<Node>) {
    capture();
    let (port, node) = mock(delay).await;
    let vars: HashMap<&str, String> = [
        ("REGTEST_RPC_HOST", "127.0.0.1".to_owned()),
        ("REGTEST_RPC_PORT", port.to_string()),
        ("REGTEST_RPC_USER", "u".to_owned()),
        ("REGTEST_RPC_PASSWORD", "p".to_owned()),
        ("REGTEST_ESPLORA_URL", format!("http://127.0.0.1:{port}")),
        ("REGTEST_ELECTRUM_ADDR", "127.0.0.1:1".to_owned()),
        ("TRUSTED_PROXY_HEADER", "X-Real-IP".to_owned()),
        // The test connects from loopback and names its client in the header.
        ("TRUSTED_PROXIES", "127.0.0.1".to_owned()),
    ]
    .into_iter()
    .chain(extra.iter().cloned())
    .collect();
    let mut config = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
    config.limits.client_rate_per_sec = 10_000;
    config.limits.client_burst = 10_000;
    config.limits.client_requests = 10_000;
    config.limits.max_requests = 10_000;
    config.limits.summary_cache_bytes = cache_entries * ENTRY;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(App::new(&config).serve(listener, std::future::pending()));
    (addr, node)
}

// The client side.

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

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

/// `GET target` from client `ip`, with the request line exactly as written.
async fn get(addr: &str, target: &str, ip: &str) -> Reply {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req =
        format!("GET {target} HTTP/1.1\r\nHost: t\r\nConnection: close\r\nX-Real-IP: {ip}\r\n\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    Reply {
        status: head[9..12].parse().unwrap(),
        head,
        body: raw[split + 4..].to_vec(),
    }
}

/// A distinct, known block hash.
fn hash(n: u32) -> String {
    format!("{n:064x}")
}

fn summary(h: &str) -> String {
    format!("/regtest/app/block/{h}/summary")
}

// The log, shared by every test here.

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

/// The `http_request` event of the response `r`.
async fn request_event(r: &Reply) -> Value {
    let id = r.header("x-request-id").unwrap().to_owned();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        logging::flush(Duration::from_secs(1));
        let raw = String::from_utf8(capture().0.lock().unwrap().clone()).unwrap();
        if let Some(v) = raw
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .find(|v| v["event"] == "http_request" && v["request_id"] == id.as_str())
        {
            return v;
        }
        assert!(Instant::now() < deadline, "not logged");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// Tests.

#[tokio::test]
async fn facts_records_and_batches_are_served_and_cached() {
    let (addr, node) = start(Duration::ZERO, 100).await;
    let (a, b) = (hash(1), hash(2));

    let r = get(&addr, &summary(&a), "192.0.2.1").await;
    assert_eq!(r.status, 200, "{r:?}");
    assert_eq!(r.header("cache-control"), Some(FACTS));
    assert_eq!(r.header("content-type"), Some("application/json"));
    let f = r.json();
    assert_eq!(f["id"], a.as_str());
    assert_eq!(
        (f["height"].as_u64(), f["tx_count"].as_u64()),
        (Some(800_000), Some(100))
    );
    // Fees 10, 20 … 990 sats on 100 vB each: 0.1 to 9.9 sat/vB.
    assert_eq!(f["fees"], 49_500);
    assert_eq!(f["vsize"], 9_900);
    assert_eq!(f["fee_rate"]["min"], 0.1);
    assert_eq!(f["fee_rate"]["median"], 5.0);
    assert_eq!(f["fee_rate"]["max"], 9.9);
    let bands: u64 = f["fee_bands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap())
        .sum();
    assert_eq!(bands, 9_900);
    // Tagged ViaBTC, paid to Foundry USA's address: the tag decides, by the list's name.
    assert_eq!(f["miner"], json!({"name": "ViaBTC", "slug": "viabtc"}));
    assert_eq!(f["sv2"], false, "an ordinary coinbase");
    let e = request_event(&r).await;
    assert_eq!(
        (e["endpoint"].as_str(), e["source"].as_str()),
        (Some("block_summary"), Some("upstream"))
    );

    let r = get(
        &addr,
        &format!("/regtest/app/block/{a}/txs?v=2"),
        "192.0.2.1",
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("cache-control"), Some(IMMUTABLE));
    assert_eq!(r.header("content-type"), Some("application/octet-stream"));
    assert_eq!(r.body.len(), 8 + 28 * TXS);
    assert_eq!(r.body[..8], [2, 0, 0, 0, TXS as u8, 0, 0, 0]);
    // The second transaction: 100 vB, 10 sats, 10 002 sats out, and its flags.
    let rec = &r.body[36..64];
    assert_eq!(u32::from_le_bytes(rec[..4].try_into().unwrap()), 100);
    assert_eq!(u64::from_le_bytes(rec[4..12].try_into().unwrap()), 10);
    assert_eq!(u64::from_le_bytes(rec[12..20].try_into().unwrap()), 10_002);
    assert_eq!(u64::from_le_bytes(rec[20..].try_into().unwrap()), FLAGS);
    assert_eq!(FLAGS, engine::flags::of(&tx(1)));
    assert_eq!(request_event(&r).await["source"], "cached");
    assert_eq!(
        node.calls(&a),
        1,
        "facts and records come from one computation"
    );

    let r = get(
        &addr,
        // As the page asks, with the release it was built with (docs/FRONTEND.md).
        &format!(
            "/regtest/app/blocks/summary?hashes={b},{a}%2C{b}&r={}",
            rbitcoin_space::REVISION
        ),
        "192.0.2.1",
    )
    .await;
    assert_eq!(r.status, 200, "{r:?}");
    assert_eq!(r.header("cache-control"), Some(FACTS));
    let all = r.json();
    let ids: Vec<&str> = all
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [b.as_str(), a.as_str(), b.as_str()]);
    assert_eq!((node.calls(&a), node.calls(&b)), (1, 1));
    // Every block in a batch names its miner; a hostile tag is Unknown and never text here.
    assert_eq!(
        all[0]["miner"],
        json!({"name": "Unknown", "slug": "unknown"})
    );
    assert_eq!(all[1]["miner"]["slug"], "viabtc");
    let body = String::from_utf8_lossy(&r.body);
    assert!(
        !body.contains("onerror") && !body.contains("/ViaBTC/"),
        "{body}"
    );
    // A page of another release, open across a deploy, gets the facts with no copy kept under
    // its URL, which that release would read if it came back.
    let other = "0".repeat(40);
    assert_ne!(other, rbitcoin_space::REVISION);
    let foreign = get(
        &addr,
        &format!("/regtest/app/blocks/summary?hashes={a}&r={other}"),
        "192.0.2.1",
    )
    .await;
    assert_eq!(foreign.status, 200, "{foreign:?}");
    assert_eq!(foreign.header("cache-control"), Some("no-store"));
    assert_eq!(foreign.json()[0]["id"], a.as_str());

    // A coinbase laid out as Stratum V2 writes it is marked, alone and in a batch, and the mark
    // is a boolean: the tag's words stay out of the facts.
    let c = hash(SV2_BLOCK);
    let r = get(&addr, &summary(&c), "192.0.2.1").await;
    assert_eq!(r.status, 200, "{r:?}");
    let f = r.json();
    assert_eq!(f["sv2"], true);
    assert_eq!(f["miner"], json!({"name": "MARA Pool", "slug": "marapool"}));
    let r = get(
        &addr,
        &format!("/regtest/app/blocks/summary?hashes={c},{b}"),
        "192.0.2.1",
    )
    .await;
    assert_eq!(r.status, 200, "{r:?}");
    let all = r.json();
    assert_eq!(
        (&all[0]["sv2"], &all[1]["sv2"]),
        (&json!(true), &json!(false))
    );
    let body = String::from_utf8_lossy(&r.body);
    assert!(
        !body.contains("Sv2") && !body.contains("MARA\u{1f1fa}"),
        "{body}"
    );

    // HEAD is GET without the body.
    let mut stream = TcpStream::connect(&addr).await.unwrap();
    let req = format!(
        "HEAD {} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n",
        summary(&a)
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).await.unwrap();
    assert!(raw.starts_with("HTTP/1.1 200"), "{raw}");
    assert!(raw.ends_with("\r\n\r\n"), "{raw}");
}

/// Writes a rated row for the mock's block `hash`, as the backfill would, with its coinbase:
/// the tag and the payouts as length-prefixed scripts.
async fn store_row(dir: &std::path::Path, hash: &str) {
    use engine::store::{Options, Store, params};
    let block: node::rpc::model::Block = serde_json::from_value(block_json(hash)).unwrap();
    let f = engine::blocks::stats::facts(&block);
    let r = f.fee_rate.unwrap();
    let tag = block.coinbase.script.to_bytes();
    let mut payouts = Vec::new();
    for o in block
        .coinbase
        .outputs
        .iter()
        .filter(|o| o.value.to_sat() > 0)
    {
        payouts.push(o.script_pubkey.len() as u8);
        payouts.extend_from_slice(o.script_pubkey.as_bytes());
    }
    let store = Store::open(dir, "regtest", Options::default()).unwrap();
    let id = *bitcoin::hashes::Hash::as_byte_array(&f.id);
    let b = f.fee_bands.stored.map(|b| b as i64);
    let split = f.fee_bands.split.map(|s| s.map(|b| b as i64));
    let (s0, s1) = (split.map(|s| s[0]), split.map(|s| s[1]));
    store
        .write(move |sql| {
            sql.prepare(
                "INSERT INTO blocks VALUES (?1, ?2, 1, ?3, 1000, 4000, ?4, ?5, 0, 0, 1.0, ?23, ?24, \
                 1, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, 0, ?25, \
                 ?26)",
            )?
            .execute(params![
                f.height, &id[..], f.tx_count as i64, f.weight as i64, f.fees as i64,
                r.min, r.p10, r.p25, r.median, r.p75, r.p90, r.max,
                b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], tag, payouts, s0, s1
            ])?;
            Ok(())
        })
        .await
        .unwrap();
    store.close().await;
}

#[tokio::test]
async fn a_block_in_the_table_is_answered_without_the_node() {
    let a = hash(1);
    // The answer computed from the node, to compare with.
    let (addr, _) = start(Duration::ZERO, 100).await;
    let computed = get(&addr, &summary(&a), "192.0.2.1").await;
    assert_eq!(computed.status, 200);

    let dir = std::env::temp_dir().join(format!("rbitcoin-space-summary-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    store_row(&dir, &a).await;
    let (addr, node) = start_with(
        Duration::ZERO,
        100,
        &[
            ("DATA_DIR", dir.display().to_string()),
            ("BACKFILL_ENABLED", "false".to_owned()),
        ],
    )
    .await;
    let r = get(&addr, &summary(&a), "192.0.2.1").await;
    assert_eq!(r.status, 200, "{r:?}");
    assert_eq!(r.header("cache-control"), Some(FACTS));
    assert_eq!(r.body, computed.body, "the same answer, byte for byte");
    assert_eq!(
        r.json()["miner"]["slug"],
        "viabtc",
        "from the stored coinbase"
    );
    assert_eq!(request_event(&r).await["source"], "stored");
    assert_eq!(node.total(), 0, "no node call");

    // A batch asks the node only for what the table lacks.
    let b = hash(2);
    let r = get(
        &addr,
        &format!("/regtest/app/blocks/summary?hashes={a},{b}"),
        "192.0.2.1",
    )
    .await;
    assert_eq!(r.status, 200, "{r:?}");
    assert_eq!(r.json()[0]["id"], a.as_str());
    assert_eq!((node.calls(&a), node.calls(&b)), (0, 1));
    let r = get(
        &addr,
        &format!("/regtest/app/blocks/summary?hashes={a},{a}"),
        "192.0.2.1",
    )
    .await;
    assert_eq!(request_event(&r).await["source"], "stored");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The Stratum V2 mark needs no column of its own: the row's stored tag is the whole script.
#[tokio::test]
async fn a_stored_stratum_v2_block_is_marked_without_the_node() {
    let c = hash(SV2_BLOCK);
    let (addr, _) = start(Duration::ZERO, 100).await;
    let computed = get(&addr, &summary(&c), "192.0.2.1").await;
    assert_eq!(computed.status, 200);

    let dir = std::env::temp_dir().join(format!("rbitcoin-space-sv2-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    store_row(&dir, &c).await;
    let (addr, node) = start_with(
        Duration::ZERO,
        100,
        &[
            ("DATA_DIR", dir.display().to_string()),
            ("BACKFILL_ENABLED", "false".to_owned()),
        ],
    )
    .await;
    let r = get(&addr, &summary(&c), "192.0.2.1").await;
    assert_eq!(r.status, 200, "{r:?}");
    assert_eq!(r.body, computed.body, "the same answer, byte for byte");
    assert_eq!(r.json()["sv2"], true, "from the stored coinbase");
    assert_eq!(r.json()["miner"]["slug"], "marapool");
    assert_eq!(request_event(&r).await["source"], "stored");
    assert_eq!(node.total(), 0, "no node call");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn identical_concurrent_requests_share_one_node_call() {
    let (addr, node) = start(Duration::from_millis(300), 100).await;
    let h = hash(7);
    let tasks: Vec<_> = (0..100)
        .map(|i| {
            let (addr, h) = (addr.clone(), h.clone());
            // Spread over many clients, and over both routes that need the same computation.
            let path = if i % 2 == 0 {
                summary(&h)
            } else {
                format!("/regtest/app/block/{h}/txs")
            };
            tokio::spawn(async move {
                get(&addr, &path, &format!("10.0.{}.{}", i / 250, i % 250)).await
            })
        })
        .collect();
    let mut sources = HashMap::<String, usize>::new();
    for t in tasks {
        let r = t.await.unwrap();
        assert_eq!(r.status, 200, "{r:?}");
        let e = request_event(&r).await;
        *sources
            .entry(e["source"].as_str().unwrap().to_owned())
            .or_default() += 1;
    }
    assert_eq!(node.calls(&h), 1, "{sources:?}");
    assert_eq!(sources.get("upstream"), Some(&1), "{sources:?}");
}

#[tokio::test]
async fn the_cache_is_bounded_and_drops_the_least_recently_used() {
    let (addr, node) = start(Duration::ZERO, 3).await;
    for n in 1..=3 {
        assert_eq!(
            get(&addr, &summary(&hash(n)), "192.0.2.2").await.status,
            200
        );
    }
    // Touch 1, then add a fourth: 2 is the least recently used and goes.
    assert_eq!(
        get(&addr, &summary(&hash(1)), "192.0.2.2").await.status,
        200
    );
    assert_eq!(
        get(&addr, &summary(&hash(4)), "192.0.2.2").await.status,
        200
    );
    for n in [1, 3, 4] {
        let r = get(&addr, &summary(&hash(n)), "192.0.2.2").await;
        assert_eq!(request_event(&r).await["source"], "cached", "block {n}");
    }
    let r = get(&addr, &summary(&hash(2)), "192.0.2.2").await;
    assert_eq!(request_event(&r).await["source"], "upstream");
    assert_eq!(node.calls(&hash(2)), 2);
    assert_eq!(node.total(), 5);
}

#[tokio::test]
async fn computations_are_capped_and_a_full_queue_is_refused_at_once() {
    let (addr, node) = start(Duration::ZERO, 100).await;
    // The node answers nothing until every refusal is in, so a refusal cannot have waited for
    // the queue: it came back while every admitted computation was still waiting.
    let held = node.gate.write().await;
    // 20 clients, each asking for a different uncached block at the same moment.
    let (tx, mut replies) = tokio::sync::mpsc::unbounded_channel();
    for i in 0..20u32 {
        let (addr, tx) = (addr.clone(), tx.clone());
        tokio::spawn(async move {
            let r = get(&addr, &summary(&hash(100 + i)), &format!("198.51.100.{i}")).await;
            tx.send(r).unwrap();
        });
    }
    let mut busy = Vec::new();
    while busy.len() < 20 - MAX_PENDING {
        let r = replies.recv().await.unwrap();
        assert_eq!(r.status, 503, "only refusals while the node holds: {r:?}");
        assert_eq!(r.json()["error"], "server busy");
        assert_eq!(r.header("retry-after"), Some("1"));
        assert_eq!(r.header("cache-control"), Some("no-store"));
        busy.push(r);
    }
    drop(held);
    for _ in 0..MAX_PENDING {
        let r = replies.recv().await.unwrap();
        assert_eq!(r.status, 200, "the queue admits exactly its size: {r:?}");
    }
    assert_eq!(
        node.max_in_flight.load(Ordering::SeqCst),
        1,
        "one getblock at a time"
    );
    assert_eq!(node.total(), MAX_PENDING);
    assert_eq!(request_event(&busy[0]).await["refused"], "summary_busy");
    // A cold batch larger than the queue is refused at once, but the work it got admitted goes
    // on into the cache, so its retry finds more of it each time and is served in the end.
    let list: Vec<String> = (500..510).map(hash).collect();
    let target = format!("/regtest/app/blocks/summary?hashes={}", list.join(","));
    let held = node.gate.write().await;
    let first = get(&addr, &target, "198.51.100.200").await;
    assert_eq!(first.status, 503);
    drop(held);
    // Retried until served: a refused retry still admits what fits, so this ends.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let r = get(&addr, &target, "198.51.100.200").await;
        if r.status == 200 {
            assert_eq!(r.json().as_array().unwrap().len(), 10);
            break;
        }
        assert!(Instant::now() < deadline, "never served: {r:?}");
    }
    assert_eq!(
        list.iter().map(|h| node.calls(h)).sum::<usize>(),
        10,
        "each block computed once"
    );
}

#[tokio::test]
async fn one_client_may_start_only_a_few_computations() {
    let (addr, node) = start(Duration::ZERO, 100).await;
    let me = "203.0.113.5";
    for n in 0..CLIENT_BURST {
        let r = get(&addr, &summary(&hash(200 + n)), me).await;
        assert_eq!(r.status, 200, "{r:?}");
    }
    let r = get(&addr, &summary(&hash(300)), me).await;
    assert_eq!(r.status, 429, "{r:?}");
    assert_eq!(r.header("retry-after"), Some("2"));
    assert_eq!(r.header("cache-control"), Some("no-store"));
    assert_eq!(request_event(&r).await["refused"], "route_rate");
    assert_eq!(node.calls(&hash(300)), 0);
    // Cached blocks cost nothing and are still served; another client is not affected.
    assert_eq!(get(&addr, &summary(&hash(200)), me).await.status, 200);
    assert_eq!(
        get(&addr, &summary(&hash(300)), "203.0.113.6").await.status,
        200
    );
    // In a batch each uncached block counts.
    let other = "203.0.113.7";
    let list: Vec<String> = (400..400 + CLIENT_BURST + 1).map(hash).collect();
    let batch = |l: &[String]| format!("/regtest/app/blocks/summary?hashes={}", l.join(","));
    let half = CLIENT_BURST as usize / 2;
    assert_eq!(get(&addr, &batch(&list[..half]), other).await.status, 200);
    assert_eq!(
        get(&addr, &batch(&list[half..2 * half]), other)
            .await
            .status,
        200
    );
    assert_eq!(
        get(&addr, &batch(&list[..2 * half]), other).await.status,
        200
    );
    assert_eq!(
        get(&addr, &batch(&list[2 * half..]), other).await.status,
        429
    );
}

#[tokio::test]
async fn hostile_parameters_never_reach_the_node() {
    let (addr, node) = start(Duration::ZERO, 100).await;
    let good = hash(1);
    let long = "a".repeat(10_000);
    let eleven = [good.as_str(); 11].join(",");
    let cases = [
        format!("/regtest/app/block/{}/summary", &good[1..]),
        format!("/regtest/app/block/{good}0/summary"),
        format!("/regtest/app/block/0x{}/summary", &good[2..]),
        format!("/regtest/app/block/{}g/summary", &good[1..]),
        format!("/regtest/app/block/{long}/txs"),
        format!("/regtest/app/block/%2e%2e%2f{}/summary", &good[9..]),
        format!("/regtest/app/block/{good}/summary?asof={good}"),
        format!("/regtest/app/block/{good}/txs?x"),
        "/regtest/app/blocks/summary".to_owned(),
        "/regtest/app/blocks/summary?hashes=".to_owned(),
        format!("/regtest/app/blocks/summary?hashes={good},"),
        format!("/regtest/app/blocks/summary?hashes={good}&hashes={good}"),
        format!("/regtest/app/blocks/summary?hashes={eleven}"),
        format!("/regtest/app/blocks/summary?hashes={long}"),
    ];
    for target in &cases {
        let r = get(&addr, target, "192.0.2.9").await;
        assert_eq!(r.status, 400, "{target}: {r:?}");
        assert!(r.json()["error"].is_string());
        assert_eq!(r.header("cache-control"), Some("no-store"), "{target}");
    }
    for target in [
        format!("/regtest/app/block/{good}"),
        format!("/regtest/app/block/{good}/summary/"),
        format!("/regtest/app/block/{good}/other"),
    ] {
        assert_eq!(
            get(&addr, &target, "192.0.2.9").await.status,
            404,
            "{target}"
        );
    }
    // Refused before the handler runs: still our error model, still not cacheable.
    let r = get(&addr, "/regtest/app/block/%FF/summary", "192.0.2.9").await;
    assert_eq!(
        (r.status, r.header("cache-control")),
        (400, Some("no-store"))
    );
    let mut stream = TcpStream::connect(&addr).await.unwrap();
    let req = format!(
        "POST {} HTTP/1.1\r\nHost: t\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        summary(&good)
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).await.unwrap();
    assert!(raw.starts_with("HTTP/1.1 405"), "{raw}");
    assert!(
        raw.to_ascii_lowercase().contains("cache-control: no-store"),
        "{raw}"
    );
    assert_eq!(node.total(), 0);

    // An unknown block is a 404, not cached: the next request asks again.
    let unknown = format!("ff{}", &good[2..]);
    for _ in 0..2 {
        let r = get(&addr, &summary(&unknown), "192.0.2.9").await;
        assert_eq!(r.status, 404);
        assert_eq!(r.header("cache-control"), Some("no-store"));
    }
    assert_eq!(node.calls(&unknown), 2);
}

/// A raw block that is not the listed one, cut short or too big fails the computation: no
/// record with zeros for flags, nothing cached, and the next request computes again.
#[tokio::test]
async fn a_bad_raw_block_fails_the_summary_and_caches_nothing() {
    let (addr, node) = start(Duration::ZERO, 100).await;
    let h = hash(9);
    for (mode, label) in [
        (Raw::Swapped, "decode"),
        (Raw::Truncated, "decode"),
        (Raw::TooBig, "response_too_big"),
    ] {
        node.raw.store(mode as u8, Ordering::SeqCst);
        let before = node.calls(&h);
        for path in [summary(&h), format!("/regtest/app/block/{h}/txs")] {
            let r = get(&addr, &path, "192.0.2.3").await;
            assert_eq!(r.status, 502, "{label}: {r:?}");
            assert_eq!(r.header("cache-control"), Some("no-store"));
            assert_eq!(request_event(&r).await["upstream_error"], label);
        }
        assert_eq!(node.calls(&h), before + 2, "{label}: computed again");
    }
    node.raw.store(Raw::Good as u8, Ordering::SeqCst);
    let r = get(
        &addr,
        &format!("/regtest/api/v1/block/{h}/summary"),
        "192.0.2.3",
    )
    .await;
    assert_eq!(r.status, 200);
    let rows = r.json();
    assert_eq!(rows.as_array().unwrap().len(), TXS);
    assert!(rows.as_array().unwrap().iter().all(|r| r["flags"] == FLAGS));
}
