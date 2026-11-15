//! The block routes of `/api/v1` end to end: the server on port 0 over a block table filled here,
//! against a mock node serving Esplora headers and `getblock` that counts every call. The chain
//! is regtest-shaped with real proof of work, so every header hashes to its id. Nothing here
//! reaches a real node.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::{Path as UrlPath, State};
use axum::routing::{get as route_get, post};
use axum::{Json, Router};
use bitcoin::block::{Header, Version};
use bitcoin::consensus::encode::serialize_hex;
use bitcoin::hashes::Hash;
use bitcoin::{BlockHash, CompactTarget, TxMerkleNode};
use engine::audit::{Audit, Side, Totals};
use engine::store::{Options, Store, params};
use rbitcoin_space::{App, Config, IMMUTABLE};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

const V1: &str = "/regtest/api/v1";
const TIP: u32 = 160;
/// The backfill has not reached this height.
const HOLE: u32 = 20;
/// Rows below this, and this one, have no fee rates.
const RATED_FROM: u32 = 10;
const UNRATED: u32 = 30;
/// Transactions in every mock block, the coinbase included.
const TXS: u32 = 5;
/// Foundry USA's first listed payout script (12KKDt4Mj7N5UAkQMN7LtPZMayenXHa8KL).
const FOUNDRY: &str = "76a9140e6ed2f95e8a7f3131535472e1009a1c77bd01e588ac";
const TAG: &[u8] = b"\x02\xa0\x00<script>alert(1)</script>";

// The chain.

/// A header on `prev` that meets regtest's target; `salt` makes a competing block.
fn mine(prev: BlockHash, height: u32, salt: u8) -> Header {
    let mut root = [salt; 32];
    root[..4].copy_from_slice(&height.to_le_bytes());
    let mut h = Header {
        version: Version::from_consensus(0x2000_0000),
        prev_blockhash: prev,
        merkle_root: TxMerkleNode::from_byte_array(root),
        time: 1_700_000_000 + height * 600,
        bits: CompactTarget::from_consensus(0x207f_ffff),
        nonce: 0,
    };
    while h.validate_pow(h.target()).is_err() {
        h.nonce += 1;
    }
    h
}

fn chain() -> Vec<Header> {
    let mut out: Vec<Header> = Vec::new();
    for height in 0..=TIP {
        let prev = out
            .last()
            .map_or(BlockHash::all_zeros(), Header::block_hash);
        out.push(mine(prev, height, 0));
    }
    out
}

/// Esplora's JSON for the block at `height`.
fn esplora(h: &Header, height: u32) -> Value {
    json!({
        "id": h.block_hash().to_string(),
        "height": height,
        "version": h.version.to_consensus(),
        "timestamp": h.time,
        "tx_count": TXS,
        "size": 1000 + height,
        "weight": 4001 + height,
        "merkle_root": h.merkle_root.to_string(),
        "previousblockhash": (height > 0).then(|| h.prev_blockhash.to_string()),
        "mediantime": h.time - 300,
        "nonce": h.nonce,
        "bits": h.bits.to_consensus(),
        "difficulty": 4.656542373906925e-10,
    })
}

/// The `n`th transaction's txid in every mock block: `n + 1` as the printed hash's last byte.
fn txid(n: u32) -> String {
    format!("{:064x}", n + 1)
}

/// `getblock` verbosity 2: the coinbase, then fee `1000 * i` sats on weight `561 * i`.
fn block_json(hash: &str, height: u32) -> Value {
    let tx: Vec<Value> = (0..TXS)
        .map(|i| {
            let weight = 561 * (i + 1);
            let mut t = json!({"txid": txid(i), "vsize": weight.div_ceil(4), "weight": weight,
                "size": weight / 2, "vout": [{"value": 0.0001 * f64::from(i + 1), "n": 0}]});
            if i == 0 {
                t["vin"] = json!([{"coinbase": "02a000", "sequence": 0}]);
                t["vout"] = json!([{"value": 0.0001, "n": 0, "scriptPubKey": {"hex": FOUNDRY}}]);
            } else {
                t["fee"] = json!(f64::from(1000 * i) / 1e8);
            }
            t
        })
        .collect();
    json!({"hash": hash, "confirmations": 1, "height": height, "time": 1, "mediantime": 1,
        "size": 1000, "strippedsize": 900, "weight": 4000, "tx": tx})
}

// The node.

#[derive(Default)]
struct Node {
    /// Esplora JSON by height: the node's best chain.
    best: Mutex<Vec<Value>>,
    /// Esplora JSON by hash, stale blocks included.
    known: Mutex<HashMap<String, Value>>,
    calls: Mutex<HashMap<&'static str, usize>>,
    /// Serves what the table's follower reads (`/blocks`): off, so the table stays as filled.
    follows: std::sync::atomic::AtomicBool,
}

impl Node {
    fn count(&self, what: &'static str) {
        *self.calls.lock().unwrap().entry(what).or_default() += 1;
    }

    fn calls(&self, what: &str) -> usize {
        self.calls.lock().unwrap().get(what).copied().unwrap_or(0)
    }

    fn set_best(&self, height: u32, block: Value) {
        let id = block["id"].as_str().unwrap().to_owned();
        self.best.lock().unwrap()[height as usize] = block.clone();
        self.known.lock().unwrap().insert(id, block);
    }
}

type N = State<Arc<Node>>;

async fn blocks_from(State(node): N, UrlPath(h): UrlPath<u32>) -> Json<Value> {
    node.count("blocks");
    let best = node.best.lock().unwrap();
    let page: Vec<Value> = best
        .iter()
        .take(h as usize + 1)
        .rev()
        .take(10)
        .cloned()
        .collect();
    Json(Value::Array(page))
}

async fn block(State(node): N, UrlPath(hash): UrlPath<String>) -> axum::response::Response {
    use axum::response::IntoResponse;
    node.count("block");
    match node.known.lock().unwrap().get(&hash) {
        Some(b) => Json(b.clone()).into_response(),
        None => (axum::http::StatusCode::NOT_FOUND, "Block not found").into_response(),
    }
}

async fn status(State(node): N, UrlPath(hash): UrlPath<String>) -> Json<Value> {
    node.count("status");
    let best = node.best.lock().unwrap();
    let in_best_chain = best.iter().any(|b| b["id"] == hash.as_str());
    Json(json!({"in_best_chain": in_best_chain}))
}

async fn tip_height(State(node): N) -> String {
    node.count("tip");
    (node.best.lock().unwrap().len() - 1).to_string()
}

/// The coinbase every mock block has: the tag, and a payout to Foundry USA.
fn coinbase() -> bitcoin::Transaction {
    use bitcoin::{
        Amount, OutPoint, ScriptBuf, Sequence, TxIn, TxOut, Witness, absolute, transaction,
    };
    bitcoin::Transaction {
        version: transaction::Version::TWO,
        lock_time: absolute::LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint::null(),
            script_sig: ScriptBuf::from_bytes(TAG.to_vec()),
            sequence: Sequence::MAX,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::from_sat(5_000_010_000),
            script_pubkey: ScriptBuf::from_bytes(hex(FOUNDRY)),
        }],
    }
}

/// The ten newest blocks, newest first, as `/blocks` answers.
async fn blocks_tip(State(node): N) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !node.follows.load(std::sync::atomic::Ordering::Relaxed) {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    let best = node.best.lock().unwrap();
    Json(Value::Array(best.iter().rev().take(10).cloned().collect())).into_response()
}

async fn block_txid(UrlPath((_, _)): UrlPath<(String, u32)>) -> String {
    coinbase().compute_txid().to_string()
}

/// One call, or a batch of them as the table's follower sends.
async fn rpc(State(node): N, Json(req): Json<Value>) -> Json<Value> {
    if let Value::Array(calls) = &req {
        let answers: Vec<Value> = calls
            .iter()
            .map(|c| {
                let result = match c["method"].as_str() {
                    Some("getblockstats") => {
                        json!({"totalfee": 10_000, "subsidy": 5_000_000_000u64, "total_weight": 4000})
                    }
                    Some("getrawtransaction") => {
                        json!(bitcoin::consensus::encode::serialize_hex(&coinbase()))
                    }
                    _ => Value::Null,
                };
                json!({"result": result, "error": null, "id": c["id"]})
            })
            .collect();
        return Json(Value::Array(answers));
    }
    if req["method"] != "getblock" {
        return Json(json!({"result": null, "error": null, "id": 0}));
    }
    node.count("getblock");
    let hash = req["params"][0].as_str().unwrap();
    let height = node.known.lock().unwrap()[hash]["height"].as_u64().unwrap() as u32;
    Json(json!({"result": block_json(hash, height), "error": null, "id": 0}))
}

async fn mock(chain: &[Header]) -> (u16, Arc<Node>) {
    let node = Arc::new(Node::default());
    for (height, h) in chain.iter().enumerate() {
        let b = esplora(h, height as u32);
        node.best.lock().unwrap().push(b.clone());
        node.known
            .lock()
            .unwrap()
            .insert(h.block_hash().to_string(), b);
    }
    let app = Router::new()
        .route("/blocks/tip/height", route_get(tip_height))
        .route("/blocks", route_get(blocks_tip))
        .route("/block/{hash}/txid/{i}", route_get(block_txid))
        .route("/blocks/{h}", route_get(blocks_from))
        .route("/block/{hash}", route_get(block))
        .route("/block/{hash}/status", route_get(status))
        .route("/", post(rpc))
        .with_state(Arc::clone(&node));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await });
    (port, node)
}

// The table.

struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn dir(name: &str) -> Dir {
    let d = std::env::temp_dir().join(format!(
        "rbitcoin-space-blocks-v1-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    Dir(d)
}

const INSERT: &str = "INSERT OR REPLACE INTO blocks (height, hash, time, tx_count, size, weight, \
    paying_weight, fees, subsidy, reward, difficulty, coinbase_tag, payouts, rated, fee_min, \
    fee_p10, fee_p25, fee_median, fee_p75, fee_p90, fee_max, band0, band1, band2, band3, band4, \
    band5, band6, band7, band8, band9, pool) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 5000000000, \
    ?9, 4.656542373906925e-10, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, 10, 0, 0, 0, \
    0, 0, 0, 0, 0, 0, 0)";

/// Rows for every block but [`HOLE`], paying Foundry USA's listed address, rated from
/// [`RATED_FROM`] up except [`UNRATED`].
async fn fill(dir: &Path, chain: &[Header]) {
    let rows: Vec<(u32, BlockHash, u32)> = chain
        .iter()
        .enumerate()
        .filter(|(h, _)| *h as u32 != HOLE)
        .map(|(h, b)| (h as u32, b.block_hash(), b.time))
        .collect();
    let store = Store::open(dir, "regtest", Options::default()).unwrap();
    store
        .write(move |sql| {
            let mut stmt = sql.prepare(INSERT)?;
            let mut payout = vec![25u8];
            payout.extend(hex(FOUNDRY));
            for (h, hash, time) in rows {
                let rated = h >= RATED_FROM && h != UNRATED;
                let rate = |x: f64| rated.then_some(x);
                stmt.execute(params![
                    h,
                    &hash.as_byte_array()[..],
                    time,
                    TXS,
                    1000 + h,
                    4001 + h,
                    3000 + h,
                    10_000 + i64::from(h),
                    5_000_010_000i64 + i64::from(h),
                    TAG,
                    payout,
                    rated,
                    rate(0.1234),
                    rate(0.25),
                    rate(1.0),
                    rate(2.0004),
                    rate(3.5),
                    rate(10.0),
                    rate(50.0),
                ])?;
            }
            Ok(())
        })
        .await
        .unwrap();
    // The tip was watched: it has an audit.
    let tip = &chain[TIP as usize];
    engine::audit::write(&store, audit(tip, TIP)).await.unwrap();
    store.close().await;
}

/// An audit of `h` scoring 99.5.
fn audit(h: &Header, height: u32) -> Audit {
    let totals = Totals {
        match_rate: 99.5,
        expected: Side {
            txs: 4,
            vsize: 1400,
            weight: 5610,
            fees: 12_345,
        },
        actual: Side::default(),
        matched: Default::default(),
        missing: Default::default(),
        displaced: Default::default(),
        fresh: Default::default(),
        conflicted: Default::default(),
        added: Default::default(),
        unseen: Default::default(),
    };
    Audit {
        id: h.block_hash(),
        height,
        time: h.time,
        seen_at: h.time,
        totals,
        txs: Vec::new(),
    }
}

/// Replaces the table's row at `height` with `hash`, as `follow` does after a reorg, through the
/// server's own store.
async fn replace_row(store: &Store, height: u32, hash: BlockHash, time: u32) {
    store
        .write(move |sql| {
            sql.prepare("DELETE FROM blocks WHERE height = ?1")?
                .execute(params![height])?;
            let mut payout = vec![25u8];
            payout.extend(hex(FOUNDRY));
            let none: Option<f64> = None;
            sql.prepare(INSERT)?.execute(params![
                height,
                &hash.as_byte_array()[..],
                time,
                TXS,
                1000 + height,
                4001 + height,
                3000,
                10_000,
                5_000_010_000i64,
                TAG,
                payout,
                false,
                none,
                none,
                none,
                none,
                none,
                none,
                none,
            ])?;
            Ok(())
        })
        .await
        .unwrap();
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

// The server.

async fn start(port: u16, data: Option<&Path>) -> String {
    start_with(port, data, &[]).await
}

/// [`start`] with more variables, which win over its own.
async fn start_with(port: u16, data: Option<&Path>, extra: &[(&'static str, String)]) -> String {
    start_app(port, data, extra).await.0
}

/// [`start_with`], and the server's store when it has one.
async fn start_app(
    port: u16,
    data: Option<&Path>,
    extra: &[(&'static str, String)],
) -> (String, Option<Arc<Store>>) {
    let mut vars: HashMap<&str, String> = [
        ("REGTEST_RPC_HOST", "127.0.0.1".to_owned()),
        ("REGTEST_RPC_PORT", port.to_string()),
        ("REGTEST_RPC_USER", "u".to_owned()),
        ("REGTEST_RPC_PASSWORD", "p".to_owned()),
        ("REGTEST_ESPLORA_URL", format!("http://127.0.0.1:{port}")),
        ("REGTEST_ELECTRUM_ADDR", "127.0.0.1:1".to_owned()),
        ("BACKFILL_ENABLED", "false".to_owned()),
        ("REGTEST_MEMPOOL_ENABLED", "false".to_owned()),
    ]
    .into_iter()
    .collect();
    if let Some(d) = data {
        vars.insert("DATA_DIR", d.display().to_string());
    }
    vars.extend(extra.iter().cloned());
    let mut config = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
    config.limits.client_rate_per_sec = 10_000;
    config.limits.client_burst = 10_000;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let app = App::new(&config);
    let store = app
        .network(rbitcoin_space::Network::Regtest)
        .and_then(|n| Some(Arc::clone(&n.blocks.as_ref()?.store)));
    // The mock answers no `getblockchaininfo`, so nothing confirms the chain: open the gate.
    if let Some(s) = &store {
        s.set_gate(engine::store::Gate::Open);
    }
    tokio::spawn(app.serve(listener, std::future::pending()));
    (addr, store)
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

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }

    fn text(&self) -> &str {
        std::str::from_utf8(&self.body).unwrap()
    }
}

async fn get(addr: &str, target: &str) -> Reply {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req = format!("GET {target} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n");
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

/// The reference's keys in its order, as observed on mempool.space's `/api/v1/blocks`, and the
/// ones we leave out (`docs/API.md`, "Blocks").
const REF_BLOCK_KEYS: [&str; 15] = [
    "id",
    "height",
    "version",
    "timestamp",
    "bits",
    "nonce",
    "difficulty",
    "merkle_root",
    "tx_count",
    "size",
    "weight",
    "previousblockhash",
    "mediantime",
    "stale",
    "extras",
];
const REF_EXTRAS_KEYS: [&str; 32] = [
    "reward",
    "coinbaseRaw",
    "orphans",
    "medianFee",
    "feeRange",
    "totalFees",
    "avgFee",
    "avgFeeRate",
    "utxoSetChange",
    "avgTxSize",
    "totalInputs",
    "totalOutputs",
    "totalOutputAmt",
    "segwitTotalTxs",
    "segwitTotalSize",
    "segwitTotalWeight",
    "feePercentiles",
    "virtualSize",
    "coinbaseAddress",
    "coinbaseAddresses",
    "coinbaseSignature",
    "coinbaseSignatureAscii",
    "header",
    "utxoSetSize",
    "totalInputAmt",
    "pool",
    "matchRate",
    "expectedFees",
    "expectedWeight",
    "firstSeen",
    "coinbaseBip54",
    "similarity",
];
const LEFT_OUT: [&str; 11] = [
    "orphans",
    "utxoSetChange",
    "avgTxSize",
    "totalInputs",
    "totalOutputs",
    "totalOutputAmt",
    "segwitTotalTxs",
    "segwitTotalSize",
    "segwitTotalWeight",
    "coinbaseBip54",
    "similarity",
];

/// The keys of the first object in `body` (and of its `extras`) appear in the reference's order.
fn assert_reference_order(body: &str) {
    let first = &body[..body.find("}},").map_or(body.len(), |i| i + 2)];
    let extras_at = first.find("\"extras\":").unwrap();
    let mut last = 0;
    for k in REF_BLOCK_KEYS {
        let at = first.find(&format!("\"{k}\":")).unwrap();
        assert!(at >= last, "{k} out of order");
        last = at;
    }
    let mut last = extras_at;
    for k in REF_EXTRAS_KEYS.iter().filter(|k| !LEFT_OUT.contains(k)) {
        let at = first[extras_at..].find(&format!("\"{k}\":")).unwrap() + extras_at;
        assert!(at >= last, "{k} out of order");
        last = at;
    }
    for k in LEFT_OUT {
        assert!(
            !first.contains(&format!("\"{k}\":")),
            "{k} must be left out"
        );
    }
}

/// What we serve for the block at `height` of `chain`, with no audit unless `audited`.
fn expected(chain: &[Header], height: u32, audited: bool) -> Value {
    norm(expected_raw(chain, height, audited))
}

fn expected_raw(chain: &[Header], height: u32, audited: bool) -> Value {
    let h = &chain[height as usize];
    let rated = height >= RATED_FROM && height != UNRATED;
    let header = bitcoin::consensus::encode::serialize_hex(h);
    json!({
        "id": h.block_hash().to_string(),
        "height": height,
        "version": 0x2000_0000,
        "timestamp": h.time,
        "bits": 0x207f_ffff,
        "nonce": h.nonce,
        "difficulty": 4.656542373906925e-10,
        "merkle_root": h.merkle_root.to_string(),
        "tx_count": TXS,
        "size": 1000 + height,
        "weight": 4001 + height,
        "previousblockhash": (height > 0).then(|| h.prev_blockhash.to_string()),
        "mediantime": h.time - 300,
        "stale": false,
        "extras": {
            "reward": 5_000_010_000u64 + u64::from(height),
            "coinbaseRaw": "02a0003c7363726970743e616c6572742831293c2f7363726970743e",
            "medianFee": rated.then_some(2.0),
            "feeRange": rated.then_some([0.123, 0.25, 1.0, 2.0, 3.5, 10.0, 50.0]),
            "totalFees": 10_000 + height,
            "avgFee": (10_000 + height) / (TXS - 1),
            "avgFeeRate": ((f64::from(10_000 + height) * 4.0 / f64::from(3000 + height)) * 1000.0)
                .round() / 1000.0,
            "feePercentiles": null,
            "virtualSize": f64::from(4001 + height) / 4.0,
            "coinbaseAddress": foundry_address(),
            "coinbaseAddresses": [foundry_address()],
            "coinbaseSignature": "OP_DUP OP_HASH160 OP_PUSHBYTES_20 0e6ed2f95e8a7f3131535472e1009a1c77bd01e5 OP_EQUALVERIFY OP_CHECKSIG",
            "coinbaseSignatureAscii": "\u{2}\u{a0}\u{0}<script>alert(1)</script>",
            "header": header,
            "utxoSetSize": null,
            "totalInputAmt": null,
            "pool": {"id": pool_id(), "name": "Foundry USA", "slug": "foundryusa", "minerNames": null},
            "matchRate": audited.then_some(99.5),
            "expectedFees": audited.then_some(12_345),
            "expectedWeight": audited.then_some(5610),
            "firstSeen": null,
        },
    })
}

/// The payout as an address on regtest, as the routes print it.
fn foundry_address() -> String {
    let script = bitcoin::ScriptBuf::from_bytes(hex(FOUNDRY));
    bitcoin::Address::from_script(&script, bitcoin::Network::Regtest)
        .unwrap()
        .to_string()
}

/// `v` as it reads back from text: the default parser is not exact for every float, so expected
/// values go through the same text and parser as the answers.
fn norm(v: Value) -> Value {
    serde_json::from_str(&v.to_string()).unwrap()
}

fn pool_id() -> u16 {
    engine::mining::pools::list()
        .by_slug("foundryusa")
        .unwrap()
        .id
}

struct Setup {
    addr: String,
    node: Arc<Node>,
    chain: Vec<Header>,
    store: Arc<Store>,
    dir: Dir,
}

async fn setup(name: &str) -> Setup {
    let chain = chain();
    let dir = dir(name);
    fill(&dir.0, &chain).await;
    let (port, node) = mock(&chain).await;
    let (addr, store) = start_app(port, Some(&dir.0), &[]).await;
    socket_read(&addr).await;
    Setup {
        addr,
        node,
        chain,
        store: store.unwrap(),
        dir,
    }
}

#[tokio::test]
async fn the_tip_list_has_fifteen_blocks_with_extras_in_the_reference_shape() {
    let s = setup("tip").await;
    let r = get(&s.addr, &format!("{V1}/blocks")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let body = r.json();
    let blocks = body.as_array().unwrap();
    assert_eq!(blocks.len(), 15);
    for (i, b) in blocks.iter().enumerate() {
        let height = TIP - i as u32;
        assert_eq!(
            b,
            &expected(&s.chain, height, height == TIP),
            "height {height}"
        );
    }
    assert_reference_order(r.text());
    // The header is the real one: it hashes to the block's id.
    let raw = hex(blocks[0]["extras"]["header"].as_str().unwrap());
    let header: Header = bitcoin::consensus::deserialize(&raw).unwrap();
    assert_eq!(header.block_hash().to_string(), blocks[0]["id"]);

    assert_eq!(r.header("cache-control"), Some("public, max-age=1"));
    assert_eq!(
        r.header("x-bitcoin-chain-tip"),
        Some(s.chain[TIP as usize].block_hash().to_string().as_str())
    );
    assert_eq!(r.header("x-bitcoin-chain-tip-height"), Some("160"));
    assert_eq!(r.header("x-data-from-height"), Some("146"));
    assert_eq!(
        r.header("x-data-from-time"),
        Some(s.chain[146].time.to_string().as_str())
    );
    assert_eq!(r.header("x-data-complete"), Some("true"));
    assert_eq!(r.header("access-control-allow-origin"), Some("*"));

    // Two pages of ten headers, then nothing: the same list again, or one of its blocks.
    assert_eq!((s.node.calls("blocks"), s.node.calls("block")), (2, 0));
    let again = get(&s.addr, &format!("{V1}/blocks")).await;
    assert_eq!(again.body, r.body);
    let id = blocks[3]["id"].as_str().unwrap();
    let one = get(&s.addr, &format!("{V1}/block/{id}")).await;
    assert_eq!(one.status, 200);
    assert_eq!(one.json(), blocks[3]);
    assert_eq!(one.header("cache-control"), Some("public, max-age=1"));
    assert!(one.header("x-data-complete").is_none());
    assert_eq!((s.node.calls("blocks"), s.node.calls("block")), (2, 0));
    assert_eq!(s.node.calls("getblock"), 0, "extras never fetch a block");

    // The tip height is the Esplora route's answer.
    let alias = get(&s.addr, &format!("{V1}/blocks/tip/height")).await;
    let esplora = get(&s.addr, "/regtest/api/blocks/tip/height").await;
    assert_eq!((alias.status, alias.text()), (200, "160"));
    assert_eq!(alias.body, esplora.body);
    assert_eq!(s.node.calls("tip"), 1, "the two share one call");
    drop(s.dir);
}

#[tokio::test]
async fn holes_unrated_rows_and_settled_answers() {
    let s = setup("holes").await;
    // From 25 down, the list stops above the hole and says so.
    let r = get(&s.addr, &format!("{V1}/blocks/25")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let heights: Vec<u64> = r
        .json()
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["height"].as_u64().unwrap())
        .collect();
    assert_eq!(heights, [25, 24, 23, 22, 21]);
    assert_eq!(r.header("x-data-from-height"), Some("21"));
    assert_eq!(r.header("x-data-complete"), Some("false"));
    assert_eq!(r.header("cache-control"), Some("public, max-age=1"));
    // At the hole, an honest refusal, for the list and the block.
    let r = get(&s.addr, &format!("{V1}/blocks/{HOLE}")).await;
    assert_eq!(
        (r.status, r.json()),
        (404, json!({"error": "block not indexed yet"}))
    );
    assert_eq!(r.header("cache-control"), Some("no-store"));
    let id = s.chain[HOLE as usize].block_hash();
    let r = get(&s.addr, &format!("{V1}/block/{id}")).await;
    assert_eq!(
        (r.status, r.json()),
        (404, json!({"error": "block not indexed yet"}))
    );
    // Below it, from genesis up: complete, but unrated, so not settled.
    let r = get(&s.addr, &format!("{V1}/blocks/5")).await;
    assert_eq!(r.json().as_array().unwrap().len(), 6);
    assert_eq!(r.json()[5]["previousblockhash"], Value::Null);
    assert_eq!(r.header("x-data-complete"), Some("true"));
    assert_eq!(r.json()[0], expected(&s.chain, 5, false));
    assert_eq!(r.header("cache-control"), Some("public, max-age=1"));
    // An unrated row is served with its fee fields null, never as zero.
    let r = get(&s.addr, &format!("{V1}/blocks/40")).await;
    let b = &r.json()[10];
    assert_eq!(b["height"], UNRATED);
    assert_eq!(
        (&b["extras"]["medianFee"], &b["extras"]["feeRange"]),
        (&Value::Null, &Value::Null)
    );
    assert_eq!(
        r.header("cache-control"),
        Some("public, max-age=1"),
        "holds an unrated row"
    );
    // Buried under a hundred blocks, complete and rated: cached for a day.
    let r = get(&s.addr, &format!("{V1}/blocks/60")).await;
    assert_eq!(r.header("cache-control"), Some("public, max-age=86400"));
    let id = s.chain[60].block_hash();
    let r = get(&s.addr, &format!("{V1}/block/{id}")).await;
    assert_eq!(r.header("cache-control"), Some("public, max-age=86400"));
    let r = get(&s.addr, &format!("{V1}/blocks/61")).await;
    assert_eq!(
        r.header("cache-control"),
        Some("public, max-age=1"),
        "not buried enough"
    );
    drop(s.dir);
}

#[tokio::test]
async fn hostile_parameters_are_refused_before_any_work() {
    let s = setup("hostile").await;
    let ok = s.chain[TIP as usize].block_hash().to_string();
    for (target, error) in [
        ("/blocks/abc", "invalid height"),
        ("/blocks/-1", "invalid height"),
        ("/blocks/4294967296", "invalid height"),
        ("/blocks/1e3", "invalid height"),
        ("/blocks/%2010", "invalid height"),
        ("/block/xyz", "invalid block hash"),
        (&format!("/block/{}", &ok[1..]), "invalid block hash"),
        (&format!("/block/{ok}0"), "invalid block hash"),
        (&format!("/block/{}g", &ok[1..]), "invalid block hash"),
        (
            &format!("/block/{}/summary", &ok[2..]),
            "invalid block hash",
        ),
        (
            &format!("/block/{ok}/tx/{}/summary", "z".repeat(64)),
            "invalid txid",
        ),
        (
            &format!("/block/{ok}/tx/{}/summary", "a".repeat(63)),
            "invalid txid",
        ),
        (
            &format!("/block/zz/tx/{}/summary", txid(1)),
            "invalid block hash",
        ),
    ] {
        let r = get(&s.addr, &format!("{V1}{target}")).await;
        assert_eq!(
            (r.status, r.json()),
            (400, json!({"error": error})),
            "{target}"
        );
    }
    assert_eq!(
        (
            s.node.calls("blocks"),
            s.node.calls("block"),
            s.node.calls("getblock")
        ),
        (1, 0, 0),
        "only the socket's page at start"
    );
    // Beyond the tip: an empty list, as on the reference.
    let r = get(&s.addr, &format!("{V1}/blocks/4294967295")).await;
    assert_eq!((r.status, r.text()), (200, "[]"));
    // A block the node does not know.
    let unknown = "ab".repeat(32);
    let r = get(&s.addr, &format!("{V1}/block/{unknown}")).await;
    assert_eq!((r.status, r.json()), (404, json!({"error": "not found"})));
    // A transaction not in the block.
    let r = get(
        &s.addr,
        &format!("{V1}/block/{ok}/tx/{}/summary", "cd".repeat(32)),
    )
    .await;
    assert_eq!(
        (r.status, r.json()),
        (404, json!({"error": "transaction not found in this block"}))
    );

    // Without a block table, the extras routes say why; the summaries still work.
    let (port, _) = mock(&s.chain).await;
    let addr = start(port, None).await;
    for target in ["/blocks", "/blocks/5", &format!("/block/{ok}")] {
        let r = get(&addr, &format!("{V1}{target}")).await;
        assert_eq!(
            (r.status, r.json()),
            (
                503,
                json!({"error": "block extras need a block table on this server"})
            ),
            "{target}"
        );
    }
    assert_eq!(
        get(&addr, &format!("{V1}/block/{ok}/summary")).await.status,
        200
    );
    drop(s.dir);
}

#[tokio::test]
async fn a_block_summary_costs_one_node_call_whatever_asks_for_it() {
    let s = setup("summary").await;
    let id = s.chain[TIP as usize].block_hash();
    let r = get(&s.addr, &format!("{V1}/block/{id}/summary")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.header("cache-control"), Some(IMMUTABLE));
    let want: Vec<Value> = (0..TXS)
        .map(|i| {
            let weight = 561 * (i + 1);
            let fee = if i == 0 { 0 } else { 1000 * i };
            json!({"txid": txid(i), "fee": fee, "vsize": f64::from(weight) / 4.0,
                "value": 10_000 * (i + 1), "rate": f64::from(fee) / f64::from(weight.div_ceil(4))})
        })
        .collect();
    let want = norm(Value::Array(want));
    assert_eq!(r.json(), want);
    let text = r.text();
    assert!(
        text.find("\"txid\"") < text.find("\"fee\"")
            && text.find("\"value\"") < text.find("\"rate\"")
    );
    let again = get(&s.addr, &format!("{V1}/block/{id}/summary")).await;
    assert_eq!(again.body, r.body);
    let one = get(&s.addr, &format!("{V1}/block/{id}/tx/{}/summary", txid(2))).await;
    assert_eq!((one.status, one.json()), (200, want[2].clone()));
    assert_eq!(one.header("cache-control"), Some(IMMUTABLE));
    // The private routes read the same cached summary.
    assert_eq!(
        get(&s.addr, &format!("/regtest/app/block/{id}/txs"))
            .await
            .status,
        200
    );
    assert_eq!(s.node.calls("getblock"), 1, "one getblock for all of them");
    drop(s.dir);
}

#[tokio::test]
async fn a_reorg_of_the_tip_shows_the_new_block_once_the_table_has_it() {
    let s = setup("reorg").await;
    let old = s.chain[TIP as usize].block_hash();
    let new = mine(s.chain[TIP as usize - 1].block_hash(), TIP, 1);
    let first = get(&s.addr, &format!("{V1}/blocks")).await;
    assert_eq!(first.json()[0]["id"], old.to_string());

    // The node moves first: the table still holds the old tip, whose header is cached.
    s.node.set_best(TIP, esplora(&new, TIP));
    let r = get(&s.addr, &format!("{V1}/blocks")).await;
    assert_eq!(r.json()[0]["id"], old.to_string());

    // Then the table follows: the list shows the new tip, read fresh, never the cached one.
    replace_row(&s.store, TIP, new.block_hash(), new.time).await;
    let r = get(&s.addr, &format!("{V1}/blocks")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let blocks = r.json();
    assert_eq!(blocks[0]["id"], new.block_hash().to_string());
    assert_eq!(
        blocks[0]["extras"]["matchRate"],
        Value::Null,
        "the audit was of the old block"
    );
    assert_eq!(
        blocks[0]["extras"]["medianFee"],
        Value::Null,
        "not rated yet"
    );
    assert_eq!(
        blocks[1]["id"],
        s.chain[TIP as usize - 1].block_hash().to_string()
    );
    assert_eq!(
        r.header("x-bitcoin-chain-tip"),
        Some(new.block_hash().to_string().as_str())
    );
    let r = get(&s.addr, &format!("{V1}/block/{old}")).await;
    assert_eq!(
        (r.status, r.json()),
        (404, json!({"error": "block is not on the best chain"}))
    );
    drop(s.dir);
}

#[tokio::test]
async fn a_table_behind_the_node_reads_its_own_blocks_by_hash() {
    let chain = chain();
    let dir = dir("behind");
    fill(&dir.0, &chain).await;
    let (port, node) = mock(&chain).await;
    // The node has reorged the tip; the table has not yet, and nothing is cached.
    let new = mine(chain[TIP as usize - 1].block_hash(), TIP, 1);
    node.set_best(TIP, esplora(&new, TIP));
    let addr = start(port, Some(&dir.0)).await;
    socket_read(&addr).await;
    let r = get(&addr, &format!("{V1}/blocks")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()[0], expected(&chain, TIP, true));
    // The page did not hold the table's tip, so it was asked for by hash.
    assert_eq!((node.calls("blocks"), node.calls("block")), (2, 1));
    // A block the node has and the table has yet to follow: retry, never an empty list.
    let next = mine(new.block_hash(), TIP + 1, 0);
    node.best.lock().unwrap().push(esplora(&next, TIP + 1));
    let r = get(&addr, &format!("{V1}/blocks/{}", TIP + 1)).await;
    assert_eq!(
        (r.status, r.json()),
        (503, json!({"error": "not ready yet; retry"}))
    );
    let r = get(&addr, &format!("{V1}/blocks/{}", TIP + 2)).await;
    assert_eq!((r.status, r.text()), (200, "[]"), "past the node's tip");
    // The node's new tip, where the table still holds the old one: retry once it follows.
    let r = get(&addr, &format!("{V1}/block/{}", new.block_hash())).await;
    assert_eq!(
        (r.status, r.json()),
        (503, json!({"error": "not ready yet; retry"}))
    );
    assert_eq!(r.header("retry-after"), Some("1"));
}

// A block the node announces before it serves it (docs/RBITCOIN.md), for longer than the 3 s the
// hub used to wait: it must still reach the table, its summary and the tip routes on its own.

/// An Electrum server that answers the handshake with `tip` and then pushes each header sent on
/// the returned channel. Its address is the first value.
async fn electrum(tip: (u32, Header)) -> (String, mpsc::UnboundedSender<(u32, Header)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let (push, mut pushes) = mpsc::unbounded_channel::<(u32, Header)>();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (rd, mut wr) = stream.into_split();
        let mut lines = BufReader::new(rd).lines();
        let tip_json =
            |(h, header): (u32, Header)| json!({"height": h, "hex": serialize_hex(&header)});
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    let Ok(Some(line)) = line else { return };
                    let req: Value = serde_json::from_str(&line).unwrap();
                    let result = match req["method"].as_str() {
                        Some("server.version") => json!(["rbitcoin-electrs 0.9.2", "1.6"]),
                        Some("blockchain.headers.subscribe") => tip_json(tip),
                        _ => Value::Null,
                    };
                    let reply = json!({"jsonrpc": "2.0", "id": req["id"], "result": result});
                    wr.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                }
                Some(next) = pushes.recv() => {
                    let msg = json!({"jsonrpc": "2.0", "method": "blockchain.headers.subscribe",
                        "params": [tip_json(next)]});
                    wr.write_all(format!("{msg}\n").as_bytes()).await.unwrap();
                }
            }
        }
    });
    (addr, push)
}

/// Announces block `TIP + 1`, has the node serve it only after `hold`, and returns how long after
/// the announcement the table had it and the tip routes answered for it, with nothing else mined.
async fn late_block(name: &str, hold: std::time::Duration, extra: &[(&'static str, String)]) {
    let chain = chain();
    let dir = dir(name);
    fill(&dir.0, &chain).await;
    let (port, node) = mock(&chain).await;
    node.follows
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let tip = chain[TIP as usize];
    let (addr, push) = electrum((TIP, tip)).await;
    let mut vars = vec![("REGTEST_ELECTRUM_ADDR", addr)];
    vars.extend(extra.iter().cloned());
    let server = start_with(port, Some(&dir.0), &vars).await;
    // The server has followed the tip before the new block comes.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while get(&server, &format!("{V1}/blocks")).await.json()[0]["id"]
        != tip.block_hash().to_string()
    {
        assert!(std::time::Instant::now() < deadline, "never ready");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // And has gone quiet: the next thing that makes it look again is about the new block.
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let new = mine(tip.block_hash(), TIP + 1, 9);
    let id = new.block_hash().to_string();
    let announced = std::time::Instant::now();
    push.send((TIP + 1, new)).unwrap();
    tokio::time::sleep(hold).await;
    assert_ne!(
        get(&server, &format!("{V1}/block/{id}")).await.status,
        200,
        "not served yet"
    );
    let b = esplora(&new, TIP + 1);
    node.best.lock().unwrap().push(b.clone());
    node.known.lock().unwrap().insert(id.clone(), b);

    let deadline = announced + hold + std::time::Duration::from_secs(10);
    loop {
        let list = get(&server, &format!("{V1}/blocks")).await;
        let one = get(&server, &format!("{V1}/block/{id}")).await;
        // The table itself, read beside the server as another process would.
        let store = Store::open(&dir.0, "regtest", Options::default()).unwrap();
        let row = engine::blocks::by_hash(&store, new.block_hash())
            .await
            .unwrap();
        store.close().await;
        if row.is_some()
            && list.status == 200
            && list.json()[0]["id"] == id.as_str()
            && one.status == 200
        {
            // The table's row carries the block's facts, computed once it was served.
            assert_eq!(
                one.json()["extras"]["totalFees"],
                json!(10_000),
                "{}",
                one.text()
            );
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the tip routes never had the block: {} {} / {} {}",
            list.status,
            list.text().chars().take(120).collect::<String>(),
            one.status,
            one.text()
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    drop(dir);
}

#[tokio::test]
async fn a_block_served_after_the_old_three_second_bound_reaches_the_table_at_once() {
    late_block("late", std::time::Duration::from_secs(4), &[]).await;
}

#[tokio::test]
async fn a_block_served_after_the_blocks_topic_gave_up_still_reaches_the_table() {
    // The topic gives up after a second and tells clients to resync; the table keeps looking.
    late_block(
        "later",
        std::time::Duration::from_secs(2),
        &[("WS_BLOCK_WAIT_SECS", "1".to_owned())],
    )
    .await;
}

#[tokio::test]
async fn a_replacement_at_the_same_height_served_late_still_reaches_the_table() {
    // The node's Electrum already has B at the tip's height while its Esplora, and the table,
    // still have A there; the topic gives up on B after a second.
    let chain = chain();
    let dir = dir("replaced");
    fill(&dir.0, &chain).await;
    let (port, node) = mock(&chain).await;
    node.follows
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let b = mine(chain[TIP as usize - 1].block_hash(), TIP, 3);
    let (addr, _push) = electrum((TIP, b)).await;
    let server = start_with(
        port,
        Some(&dir.0),
        &[
            ("REGTEST_ELECTRUM_ADDR", addr),
            ("WS_BLOCK_WAIT_SECS", "1".to_owned()),
        ],
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    // Then the node serves B: the table must take it, though no other block comes.
    node.set_best(TIP, esplora(&b, TIP));
    let id = b.block_hash().to_string();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let store = Store::open(&dir.0, "regtest", Options::default()).unwrap();
        let row = engine::blocks::by_height(&store, TIP).await.unwrap();
        store.close().await;
        if row.is_some_and(|r| r.hash == b.block_hash()) {
            let list = get(&server, &format!("{V1}/blocks")).await;
            assert_eq!(list.json()[0]["id"], id.as_str(), "{}", list.text());
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the table never took the replacement"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    drop(dir);
}

// Kept answers (`crate::answers`).

/// What a client sees of an answer, less the headers that differ per request.
fn seen(r: &Reply) -> (u16, Vec<String>, Vec<u8>) {
    let mut head: Vec<String> = r
        .head
        .lines()
        .skip(1)
        .filter(|l| !l.starts_with("date:") && !l.starts_with("x-request-id:"))
        .map(str::to_owned)
        .collect();
    head.sort();
    (r.status, head, r.body.clone())
}

/// Each target from the server, twice, against a server started now on the same table, which
/// has kept nothing: the same status, headers and bytes.
async fn same_as_fresh(addr: &str, port: u16, dir: &Path, targets: &[String], when: &str) {
    let fresh = start(port, Some(dir)).await;
    for t in targets {
        let first = get(addr, t).await;
        let again = get(addr, t).await;
        let uncached = get(&fresh, t).await;
        assert_eq!(seen(&first), seen(&uncached), "{when}: {t}");
        assert_eq!(seen(&again), seen(&first), "{when}: {t}, again");
    }
}

#[tokio::test]
async fn kept_answers_follow_every_write_and_match_an_uncached_server() {
    let chain = chain();
    let dir = dir("kept");
    fill(&dir.0, &chain).await;
    let (port, node) = mock(&chain).await;
    let (addr, store) = start_app(port, Some(&dir.0), &[]).await;
    let store = store.unwrap();
    let at = |h: u32| chain[h as usize].block_hash();
    let targets = [
        format!("{V1}/blocks"),
        format!("{V1}/blocks/{}", HOLE + 5),
        format!("{V1}/block/{}", at(TIP - 1)),
        format!("/regtest/app/block/{}/summary", at(TIP - 2)),
        format!(
            "/regtest/app/blocks/summary?hashes={},{}",
            at(TIP - 1),
            at(TIP)
        ),
        format!("{V1}/mining/blocks/audit/scores"),
        format!("{V1}/mining/blocks/audit/score/{}", at(TIP - 1)),
    ];
    same_as_fresh(&addr, port, &dir.0, &targets, "at start").await;

    // A write from another connection moves no version: the answer is kept, so it is served
    // from memory. (The server's own writer is the only writer in service.)
    let list = get(&addr, &targets[0]).await;
    let other = Store::open(&dir.0, "regtest", Options::default()).unwrap();
    other
        .write(move |sql| {
            sql.prepare("UPDATE blocks SET fees = fees + 1 WHERE height = ?1")?
                .execute(params![TIP])?;
            Ok(())
        })
        .await
        .unwrap();
    other.close().await;
    assert_eq!(seen(&get(&addr, &targets[0]).await), seen(&list));

    // A new block.
    let next = mine(at(TIP), TIP + 1, 0);
    let b = esplora(&next, TIP + 1);
    node.best.lock().unwrap().push(b.clone());
    node.known
        .lock()
        .unwrap()
        .insert(next.block_hash().to_string(), b);
    replace_row(&store, TIP + 1, next.block_hash(), next.time).await;
    let r = get(&addr, &targets[0]).await;
    assert_eq!(r.json()[0]["id"], next.block_hash().to_string());
    assert_eq!(r.json()[1]["extras"]["totalFees"], json!(10_000 + TIP + 1));
    same_as_fresh(&addr, port, &dir.0, &targets, "after a new block").await;

    // The backfill fills the hole the list from HOLE + 5 was cut at.
    assert_eq!(
        get(&addr, &targets[1]).await.header("x-data-complete"),
        Some("false")
    );
    replace_row(&store, HOLE, at(HOLE), chain[HOLE as usize].time).await;
    assert_eq!(
        get(&addr, &targets[1]).await.header("x-data-complete"),
        Some("true")
    );
    same_as_fresh(&addr, port, &dir.0, &targets, "after a backfilled row").await;

    // A new audit.
    assert_eq!(get(&addr, &targets[6]).await.status, 404);
    engine::audit::write(&store, audit(&chain[TIP as usize - 1], TIP - 1))
        .await
        .unwrap();
    assert_eq!(get(&addr, &targets[6]).await.status, 200);
    assert_eq!(
        get(&addr, &targets[2]).await.json()["extras"]["matchRate"],
        json!(99.5)
    );
    same_as_fresh(&addr, port, &dir.0, &targets, "after an audit").await;

    // A reorg of the new tip.
    let other = mine(at(TIP), TIP + 1, 1);
    let b = esplora(&other, TIP + 1);
    node.set_best(TIP + 1, b);
    replace_row(&store, TIP + 1, other.block_hash(), other.time).await;
    let r = get(&addr, &targets[0]).await;
    assert_eq!(r.json()[0]["id"], other.block_hash().to_string());
    same_as_fresh(&addr, port, &dir.0, &targets, "after a reorg").await;
    drop(dir);
}

// The compatible socket's blocks are the same JSON as the list's.

/// A client of `/api/v1/ws`, as little of RFC 6455 as this needs: short masked text frames out,
/// unmasked frames in.
struct Ws(TcpStream);

impl Ws {
    async fn open(addr: &str) -> Self {
        let mut s = TcpStream::connect(addr).await.unwrap();
        let req = format!(
            "GET {V1}/ws HTTP/1.1\r\nHost: t\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        s.write_all(req.as_bytes()).await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(s.read_u8().await.unwrap());
        }
        assert!(head.starts_with(b"HTTP/1.1 101"), "{head:?}");
        Self(s)
    }

    async fn send(&mut self, text: &str) {
        let p = text.as_bytes();
        // A zero mask leaves the payload as it is.
        let mut f = vec![0x81, 0x80 | u8::try_from(p.len()).unwrap(), 0, 0, 0, 0];
        f.extend_from_slice(p);
        self.0.write_all(&f).await.unwrap();
    }

    /// The next text message, or `None` after `wait` without one.
    async fn next(&mut self, wait: std::time::Duration) -> Option<Value> {
        loop {
            let mut h = [0u8; 2];
            tokio::time::timeout(wait, self.0.read_exact(&mut h))
                .await
                .ok()?
                .unwrap();
            let len = match h[1] & 0x7F {
                126 => u64::from(self.0.read_u16().await.unwrap()),
                127 => self.0.read_u64().await.unwrap(),
                n => u64::from(n),
            };
            let mut p = vec![0u8; usize::try_from(len).unwrap()];
            self.0.read_exact(&mut p).await.unwrap();
            if h[0] & 0x0F == 1 {
                return Some(serde_json::from_slice(&p).unwrap());
            }
        }
    }
}

/// Waits for the compatible socket's first read of the table, which asks the node for a page of
/// headers, so that the tests counting node calls do not race it.
async fn socket_read(addr: &str) {
    let mut ws = Ws::open(addr).await;
    ws.send(r#"{"action":"want","data":["blocks"]}"#).await;
    let first = ws.next(std::time::Duration::from_secs(10)).await;
    assert!(first.is_some_and(|m| m.get("blocks").is_some()));
}

/// The list's eight newest blocks, oldest first: the socket's `blocks`.
async fn eight(addr: &str) -> Value {
    let mut list = get(addr, &format!("{V1}/blocks")).await.json();
    let list = list.as_array_mut().unwrap();
    list.truncate(8);
    list.reverse();
    Value::Array(list.clone())
}

#[tokio::test]
async fn socket_blocks_are_the_list_s_and_a_new_one_goes_out_once_its_row_is_there() {
    let chain = chain();
    let dir = dir("socket");
    fill(&dir.0, &chain).await;
    let (port, node) = mock(&chain).await;
    node.follows
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let tip = chain[TIP as usize];
    let (electrum_addr, push) = electrum((TIP, tip)).await;
    let server = start_with(
        port,
        Some(&dir.0),
        &[("REGTEST_ELECTRUM_ADDR", electrum_addr)],
    )
    .await;
    let wait = std::time::Duration::from_secs(10);

    let mut ws = Ws::open(&server).await;
    ws.send(r#"{"action":"want","data":["blocks"]}"#).await;
    let first = ws.next(wait).await.unwrap();
    assert_eq!(first, json!({"blocks": eight(&server).await}));
    assert_eq!(first["blocks"][7]["extras"]["matchRate"], json!(99.5));

    // A new block, served at once: one `block`, the list's newest once its row is written.
    let new = mine(tip.block_hash(), TIP + 1, 9);
    let b = esplora(&new, TIP + 1);
    node.best.lock().unwrap().push(b.clone());
    node.known
        .lock()
        .unwrap()
        .insert(new.block_hash().to_string(), b);
    push.send((TIP + 1, new)).unwrap();
    let msg = ws.next(wait).await.unwrap();
    let list = get(&server, &format!("{V1}/blocks")).await.json();
    assert_eq!(list[0]["id"], new.block_hash().to_string());
    assert_eq!(msg, json!({"block": list[0]}));
    assert_eq!(msg["block"]["extras"]["totalFees"], json!(10_000));
    let more = ws.next(std::time::Duration::from_secs(2)).await;
    assert_eq!(more, None, "sent once");

    // A client that starts now gets the list with it.
    let mut again = Ws::open(&server).await;
    again.send(r#"{"action":"want","data":["blocks"]}"#).await;
    assert_eq!(
        again.next(wait).await.unwrap(),
        json!({"blocks": eight(&server).await})
    );
    drop(dir);
}
