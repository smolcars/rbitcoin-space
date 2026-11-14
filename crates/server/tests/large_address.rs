//! Very large addresses against a mock node on port 0 (docs/API.md, "Very large addresses"): the
//! guard's one join at a time, the ledger seeded from an answer or a queue, a refused seed,
//! eviction, and discovery. Nothing here reaches a real node.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use bitcoin::hashes::{Hash, sha256d};
use bitcoin::{Address, BlockHash, Network, ScriptBuf, WPubkeyHash};
use node::esplora::ScriptHash;
use rbitcoin_space::config::{IpNet, TrustedProxy};
use rbitcoin_space::{App, Config, Limits};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The mock chain's height.
const TIP: u32 = 110;
/// The deadline the tests run with.
const DEADLINE: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Copy)]
enum Kind {
    /// Totals answered at once, a few outputs.
    Small,
    /// Totals answered after `ms`, with 50,000 outputs.
    Large { ms: u64 },
    /// Totals refused for size after `ms`.
    Refused { ms: u64 },
    /// Small at blocks below 100, at once; large from there on, after `ms`.
    Grew { ms: u64 },
}

#[derive(Default)]
struct Node {
    /// By address and by scripthash.
    kinds: Mutex<HashMap<String, Kind>>,
    in_flight: AtomicUsize,
    most: AtomicUsize,
    seen: Mutex<Vec<String>>,
    /// Scripts the tip block pays twice: discovery's candidates.
    paid: Mutex<Vec<ScriptBuf>>,
    /// Each address's script hex, by address and by scripthash.
    scripts: Mutex<HashMap<String, String>>,
    /// Scripts whose whole history the mock's Electrum lists, by scripthash, with its length;
    /// every other list is refused for size. And how many lists were asked.
    lists: Mutex<HashMap<String, u64>>,
    list_calls: AtomicUsize,
    /// Transactions the lists named: by txid, their height and the script they pay 1,000 sats.
    txs: Mutex<HashMap<String, (u32, String)>>,
    /// The node says these blocks left its best chain: a reorg the ledger has not followed yet.
    orphaned: Mutex<Vec<String>>,
    /// History pages fail: no fill ends, so none tells an address's followers anything.
    fail_pages: std::sync::atomic::AtomicBool,
    /// The node serves the uncapped totals route on its socket (rbitcoin PR 1628): totals of any
    /// address, those refused for size included. Without it the route is the unknown path, 404.
    internal: std::sync::atomic::AtomicBool,
    /// The route's probe answers 503: a node that does not say.
    probe_fails: std::sync::atomic::AtomicBool,
    /// Electrum completes its handshake (answers `blockchain.headers.subscribe`), so the server
    /// asks the node which routes it serves.
    handshake: std::sync::atomic::AtomicBool,
    /// Closes every Electrum connection: the node restarted (upgraded, say).
    restart: tokio::sync::Notify,
}

impl Node {
    fn set(&self, address: &Address, kind: Kind) {
        let sh = ScriptHash::from_script(&address.script_pubkey());
        let mut k = self.kinds.lock().unwrap();
        k.insert(address.to_string(), kind);
        k.insert(sh.to_string(), kind);
        let hex = address.script_pubkey().to_hex_string();
        let mut sc = self.scripts.lock().unwrap();
        sc.insert(address.to_string(), hex.clone());
        sc.insert(sh.to_string(), hex);
    }

    fn totals_calls(&self, address: &Address) -> usize {
        let sh = ScriptHash::from_script(&address.script_pubkey()).to_string();
        let a = address.to_string();
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|p| {
                let path = p.split('?').next().unwrap_or_default();
                path == format!("/address/{a}") || path == format!("/scripthash/{sh}")
            })
            .count()
    }

    /// Paths asked under `/internal`, with their query.
    fn internal_paths(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.starts_with("/internal"))
            .cloned()
            .collect()
    }

    /// History pages asked for any script, with their query.
    fn pages(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.contains("/txs/summary"))
            .cloned()
            .collect()
    }
}

fn hash(h: u32) -> BlockHash {
    if h == 0 {
        bitcoin::constants::genesis_block(Network::Regtest).block_hash()
    } else {
        BlockHash::from_byte_array(sha256d::Hash::hash(format!("b{h}").as_bytes()).to_byte_array())
    }
}

fn height_of(hash_hex: &str) -> Option<u32> {
    (0..=TIP).find(|h| hash(*h).to_string() == hash_hex)
}

fn stats(n: u64) -> Value {
    json!({"funded_txo_count": n, "funded_txo_sum": n * 1000, "spent_txo_count": 0,
           "spent_txo_sum": 0, "tx_count": n})
}

fn header(h: u32) -> Value {
    json!({"hash": hash(h).to_string(), "confirmations": TIP - h + 1, "height": h, "version": 1,
           "merkleroot": "00".repeat(32), "time": 1_700_000_000 + h * 600,
           "mediantime": 1_700_000_000 + h * 600, "nonce": 0, "bits": "207fffff",
           "target": "7f".repeat(32), "difficulty": 1.0, "chainwork": "00".repeat(32), "nTx": 1,
           "previousblockhash": (h > 0).then(|| hash(h - 1).to_string()),
           "nextblockhash": (h < TIP).then(|| hash(h + 1).to_string())})
}

fn block(node: &Node, h: u32) -> Value {
    let out = |hex: String| json!({"value": 1.0, "scriptPubKey": {"hex": hex}});
    let mut txs =
        vec![json!({"txid": format!("{:064x}", h), "vin": [{}], "vout": [out("51".into())]})];
    if h == TIP {
        for (i, s) in node.paid.lock().unwrap().iter().enumerate() {
            for j in 0..2 {
                txs.push(
                    json!({"txid": format!("{:060x}{i:02x}{j:02x}", h), "vin": [],
                    "vout": [out(s.to_hex_string())]}),
                );
            }
        }
    }
    json!({"hash": hash(h).to_string(), "height": h, "time": 1_700_000_000 + h * 600,
           "previousblockhash": (h > 0).then(|| hash(h - 1).to_string()), "tx": txs})
}

fn rpc(node: &Node, body: &[u8]) -> Response {
    let req: Value = serde_json::from_slice(body).unwrap_or_default();
    let p = &req["params"];
    let result = match req["method"].as_str().unwrap_or_default() {
        "getblockchaininfo" => json!({"chain": "regtest", "blocks": TIP, "headers": TIP,
            "bestblockhash": hash(TIP).to_string(), "bits": "207fffff", "target": "7f".repeat(32),
            "difficulty": 1.0, "time": 1_700_000_000 + TIP * 600,
            "mediantime": 1_700_000_000 + TIP * 600, "verificationprogress": 1.0,
            "initialblockdownload": false, "chainwork": "00".repeat(32), "size_on_disk": 0,
            "pruned": false}),
        "getblockhash" => match p[0].as_u64().and_then(|h| u32::try_from(h).ok()) {
            Some(h) if h <= TIP => json!(hash(h).to_string()),
            _ => return rpc_error(-8),
        },
        "getblockheader" => match height_of(p[0].as_str().unwrap_or_default()) {
            Some(h) => header(h),
            None => return rpc_error(-5),
        },
        "getblock" => match height_of(p[0].as_str().unwrap_or_default()) {
            Some(h) => block(node, h),
            None => return rpc_error(-5),
        },
        _ => return rpc_error(-32601),
    };
    let id = req["id"].clone();
    (
        StatusCode::OK,
        json!({"result": result, "error": null, "id": id}).to_string(),
    )
        .into_response()
}

fn rpc_error(code: i64) -> Response {
    let body = json!({"result": null, "error": {"code": code, "message": "no"}, "id": 0});
    (StatusCode::OK, body.to_string()).into_response()
}

async fn esplora(node: Arc<Node>, pq: String) -> Response {
    let (path, query) = pq.split_once('?').unwrap_or((&pq, ""));
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    // The uncapped totals route: the totals route's own paths under `/internal`.
    let internal = parts.len() == 3 && parts[0] == "internal";
    let parts = if internal { &parts[1..] } else { &parts[..] };
    if internal && !node.internal.load(Ordering::SeqCst) {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }
    let stamp_height = query
        .strip_prefix("asof=")
        .map_or(Some(TIP), height_of)
        .unwrap_or(TIP);
    let stamped = |status: StatusCode, body: String| {
        let mut r = (status, body).into_response();
        let h = r.headers_mut();
        h.insert(
            "x-bitcoin-chain-tip",
            hash(stamp_height).to_string().parse().unwrap(),
        );
        h.insert("x-bitcoin-chain-tip-height", stamp_height.into());
        r
    };
    match parts {
        ["scripthash", id] if internal && *id == "00".repeat(32) => {
            if node.probe_fails.load(Ordering::SeqCst) {
                return (StatusCode::SERVICE_UNAVAILABLE, "busy").into_response();
            }
            let body =
                json!({"scripthash": id, "chain_stats": stats(0), "mempool_stats": stats(0)});
            stamped(StatusCode::OK, body.to_string())
        }
        [kind @ ("address" | "scripthash"), id] => {
            let k = node.kinds.lock().unwrap().get(*id).copied();
            let now = node.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            node.most.fetch_max(now, Ordering::SeqCst);
            let k = match k {
                Some(Kind::Grew { .. }) if stamp_height < 100 => Some(Kind::Small),
                Some(Kind::Grew { ms }) => Some(Kind::Large { ms }),
                // No cap on the internal route.
                Some(Kind::Refused { ms }) if internal => Some(Kind::Large { ms }),
                k => k,
            };
            let r = match k {
                Some(Kind::Large { ms }) => {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    let mut chain = stats(50_000);
                    // As many transactions as its list holds, when it has one.
                    let sh = node.scripts.lock().unwrap().get(*id).map(|hex| {
                        ScriptHash::from_script(&ScriptBuf::from_hex(hex).unwrap()).to_string()
                    });
                    if let Some(n) = sh.and_then(|sh| node.lists.lock().unwrap().get(&sh).copied())
                    {
                        chain["tx_count"] = n.into();
                    }
                    let body = json!({*kind: id, "chain_stats": chain, "mempool_stats": stats(0)});
                    stamped(StatusCode::OK, body.to_string())
                }
                Some(Kind::Refused { ms }) => {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    (
                        StatusCode::SERVICE_UNAVAILABLE,
                        "scripthash join exceeds --max-sh-creates (20000 creates, cap 10000)",
                    )
                        .into_response()
                }
                Some(Kind::Small | Kind::Grew { .. }) | None => {
                    let body =
                        json!({*kind: id, "chain_stats": stats(3), "mempool_stats": stats(0)});
                    stamped(StatusCode::OK, body.to_string())
                }
            };
            node.in_flight.fetch_sub(1, Ordering::SeqCst);
            r
        }
        // One unconfirmed transaction paying the address, 70,000 sats, whatever form asks.
        [_, id, "txs", "mempool"] => {
            let script = node.scripts.lock().unwrap().get(*id).cloned();
            let rows = script.map_or_else(Vec::new, |hex| {
                vec![
                    json!({"txid": "11".repeat(32), "version": 2, "locktime": 0, "vin": [],
                    "vout": [{"scriptpubkey": hex, "scriptpubkey_asm": "", "scriptpubkey_type":
                    "v0_p2wpkh", "value": 70_000}], "status": {"confirmed": false}}),
                ]
            });
            stamped(StatusCode::OK, Value::Array(rows).to_string())
        }
        [_, _, "txs", "summary", ..] if node.fail_pages.load(Ordering::SeqCst) => {
            (StatusCode::INTERNAL_SERVER_ERROR, "no").into_response()
        }
        [_, _, "txs", "summary", ..] | [_, _, "utxo"] => stamped(StatusCode::OK, "[]".into()),
        ["block", h, "status"] => match height_of(h) {
            Some(height) => {
                let best = !node.orphaned.lock().unwrap().iter().any(|o| o == h);
                stamped(
                    StatusCode::OK,
                    json!({"in_best_chain": best, "height": height}).to_string(),
                )
            }
            None => (StatusCode::NOT_FOUND, "Block not found").into_response(),
        },
        // Transactions the lists named, confirmed where the list put them.
        ["tx", id, rest @ ..] => {
            let Some((h, hex)) = node.txs.lock().unwrap().get(*id).cloned() else {
                return (StatusCode::NOT_FOUND, "Transaction not found").into_response();
            };
            let status = json!({"confirmed": true, "block_height": h,
                "block_hash": hash(h).to_string(), "block_time": 1_700_000_000 + h * 600});
            match rest {
                [] => stamped(
                    StatusCode::OK,
                    json!({"txid": id, "version": 2, "locktime": 0, "vin": [],
                        "vout": [{"scriptpubkey": hex, "scriptpubkey_asm": "",
                        "scriptpubkey_type": "v0_p2wpkh", "value": 1000}], "status": status})
                    .to_string(),
                ),
                ["status"] => stamped(StatusCode::OK, status.to_string()),
                _ => (StatusCode::NOT_FOUND, "not found").into_response(),
            }
        }
        _ => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// The mock's Electrum: answers `server.version`, and `get_history` pinned with `asof:` by the
/// node's rules (sorted by height then txid bytes, stamped with the block); refuses anything else.
async fn electrum(node: Arc<Node>) -> String {
    use tokio::io::AsyncBufReadExt;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let node = Arc::clone(&node);
            tokio::spawn(async move {
                let (rd, mut wr) = stream.into_split();
                let mut lines = tokio::io::BufReader::new(rd).lines();
                loop {
                    let line = tokio::select! {
                        l = lines.next_line() => l,
                        () = node.restart.notified() => return,
                    };
                    let Ok(Some(line)) = line else { return };
                    let req: Value = serde_json::from_str(&line).unwrap_or_default();
                    let id = req["id"].clone();
                    let reply = match req["method"].as_str().unwrap_or_default() {
                        "server.version" => json!({"id": id, "result": ["mock", "1.4"]}),
                        "blockchain.headers.subscribe" if node.handshake.load(Ordering::SeqCst) => {
                            let tip = bitcoin::constants::genesis_block(Network::Regtest).header;
                            json!({"id": id, "result": {"height": 0,
                                "hex": bitcoin::consensus::encode::serialize_hex(&tip)}})
                        }
                        "blockchain.scripthash.get_history" => {
                            node.list_calls.fetch_add(1, Ordering::SeqCst);
                            let sh = req["params"][0].as_str().unwrap_or_default().to_owned();
                            let at = req["params"][1].as_str().unwrap_or_default();
                            let at = at.strip_prefix("asof:").unwrap_or_default().to_owned();
                            let n = node.lists.lock().unwrap().get(&sh).copied();
                            match (n, height_of(&at)) {
                                (Some(n), Some(h)) => {
                                    let mut rows: Vec<(u32, [u8; 32])> = (0..n)
                                        .map(|k| {
                                            let txid =
                                                sha256d::Hash::hash(format!("{sh} {k}").as_bytes());
                                            (
                                                1 + u32::try_from(k).unwrap() % h,
                                                txid.to_byte_array(),
                                            )
                                        })
                                        .collect();
                                    rows.sort_unstable();
                                    let hex = node.scripts.lock().unwrap().get(&sh).cloned();
                                    let mut txs = node.txs.lock().unwrap();
                                    for (height, t) in &rows {
                                        let txid = bitcoin::Txid::from_byte_array(*t).to_string();
                                        txs.insert(
                                            txid,
                                            (*height, hex.clone().unwrap_or_default()),
                                        );
                                    }
                                    drop(txs);
                                    let rows: Vec<Value> = rows
                                        .into_iter()
                                        .map(|(height, t)| {
                                            json!({"height": height, "tx_hash":
                                                bitcoin::Txid::from_byte_array(t).to_string()})
                                        })
                                        .collect();
                                    json!({"id": id, "result": rows, "chain_tip": at,
                                        "chain_tip_height": h})
                                }
                                _ => json!({"id": id, "error": {"code": 1, "message":
                                    "scripthash join exceeds --max-sh-creates (20000 creates, cap 10000)"}}),
                            }
                        }
                        _ => json!({"id": id, "error": {"code": -32601, "message": "no"}}),
                    };
                    let mut out = reply.to_string();
                    out.push('\n');
                    if wr.write_all(out.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    addr
}

async fn mock(socket: Option<&std::path::Path>) -> (String, Arc<Node>) {
    let node = Arc::new(Node::default());
    let n = Arc::clone(&node);
    let app = Router::new().fallback(any(move |method: Method, uri: Uri, body: Bytes| {
        let node = Arc::clone(&n);
        async move {
            let pq = uri.path_and_query().map(ToString::to_string).unwrap();
            node.seen.lock().unwrap().push(pq.clone());
            if method == Method::POST {
                rpc(&node, &body)
            } else {
                esplora(node, pq).await
            }
        }
    }));
    if let Some(path) = socket {
        let listener = tokio::net::UnixListener::bind(path).unwrap();
        let app = app.clone();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr.to_string(), node)
}

struct Server {
    addr: String,
    node: Arc<Node>,
    _dir: Option<Dir>,
    _sock: Option<Dir>,
}

impl Server {
    /// Says, in the store as another process would, that `a` was last viewed long ago: it may
    /// then be dropped for the bound.
    async fn viewed_long_ago(&self, a: &Address) {
        let dir = self._dir.as_ref().unwrap().0.clone();
        let sh = ScriptHash::from_script(&a.script_pubkey()).to_byte_array();
        let other =
            engine::store::Store::open(&dir, "regtest", engine::store::Options::default()).unwrap();
        other
            .write(move |sql| {
                sql.prepare("UPDATE ledger_scripts SET viewed = 0 WHERE sh = ?1")?
                    .execute(engine::store::params![sh])?;
                Ok(())
            })
            .await
            .unwrap();
        other.close().await;
    }
}

struct Dir(std::path::PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn start(store: bool, vars: &[(&str, &str)]) -> Server {
    start_with(store, vars, |_| {}).await
}

async fn start_with(store: bool, extra: &[(&str, &str)], before: impl FnOnce(&Node)) -> Server {
    start_via(false, store, extra, before).await
}

/// With `socket`, the server reaches the mock's Esplora over a unix socket, and the mock's
/// Electrum completes its handshake.
async fn start_via(
    socket: bool,
    store: bool,
    extra: &[(&str, &str)],
    before: impl FnOnce(&Node),
) -> Server {
    static N: AtomicUsize = AtomicUsize::new(0);
    // A short path: a socket's path has a limit of about 100 bytes.
    let sock = socket.then(|| {
        let d = std::env::temp_dir().join(format!(
            "rbs-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Dir(d)
    });
    let sock_path = sock.as_ref().map(|d| d.0.join("e.sock"));
    let (mock, node) = mock(sock_path.as_deref()).await;
    node.handshake.store(socket, Ordering::SeqCst);
    before(&node);
    let electrum_addr = electrum(Arc::clone(&node)).await;
    let (host, port) = mock.split_once(':').unwrap();
    let url = sock_path.map_or_else(|| format!("http://{mock}"), |p| p.display().to_string());
    let mut vars: HashMap<String, String> = [
        ("REGTEST_RPC_HOST", host),
        ("REGTEST_RPC_PORT", port),
        ("REGTEST_RPC_USER", "u"),
        ("REGTEST_RPC_PASSWORD", "p"),
        ("REGTEST_ESPLORA_URL", url.as_str()),
        ("REGTEST_ELECTRUM_ADDR", electrum_addr.as_str()),
        ("BACKFILL_ENABLED", "false"),
        ("LEDGER_DISCOVER", "false"),
    ]
    .into_iter()
    .chain(extra.iter().copied())
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let dir = store.then(|| {
        let d = std::env::temp_dir().join(format!(
            "rbitcoin-space-large-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&d);
        Dir(d)
    });
    if let Some(d) = &dir {
        vars.insert("DATA_DIR".into(), d.0.display().to_string());
    }
    let mut c = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
    c.web_dir = std::env::temp_dir().join("rbitcoin-space-no-web-dir");
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
    let app = App::new(&c);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(app.serve(listener, std::future::pending()));
    let s = Server {
        addr,
        node,
        _dir: dir,
        _sock: sock,
    };
    if store {
        // The store takes writes once the RPC check has found the node on the right chain.
        wait_for("the store open", || async {
            get(&s.addr, 1, "/readyz")
                .await
                .body
                .to_string()
                .contains("\"store\":\"ok\"")
        })
        .await;
    }
    s
}

fn address(i: u8) -> Address {
    let script = ScriptBuf::new_p2wpkh(&WPubkeyHash::from_byte_array([i; 20]));
    Address::from_script(&script, Network::Regtest).unwrap()
}

struct Reply {
    status: u16,
    headers: String,
    body: Value,
}

async fn get(addr: &str, client: u8, target: &str) -> Reply {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "GET {target} HTTP/1.1\r\nHost: test\r\nConnection: close\r\nX-Real-IP: 192.0.2.{client}\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    Reply {
        status: String::from_utf8_lossy(&raw[9..12]).parse().unwrap(),
        headers: String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase(),
        body: serde_json::from_slice(&raw[split + 4..]).unwrap_or_default(),
    }
}

async fn wait_for<F, Fut>(what: &str, f: F)
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f().await {
        assert!(Instant::now() < deadline, "{what} never happened");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn ledger(s: &Server, client: u8, a: &Address) -> Value {
    get(&s.addr, client, &format!("/regtest/app/address/{a}/ledger"))
        .await
        .body
}

const TOO_LARGE: &str = "address history too large for this server";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn totals_of_addresses_not_known_small_go_one_at_a_time_and_large_ones_are_asked_once() {
    let s = start(false, &[]).await;
    let large: Vec<Address> = (1..=6).map(address).collect();
    for a in &large {
        s.node.set(a, Kind::Large { ms: 400 });
    }
    // Twelve clients at once, two to each address.
    let mut asks = Vec::new();
    for (i, a) in large.iter().enumerate() {
        for c in 0..2u8 {
            let (addr, path) = (s.addr.clone(), format!("/regtest/api/address/{a}"));
            let client = u8::try_from(i).unwrap() * 2 + c + 10;
            asks.push(tokio::spawn(async move { get(&addr, client, &path).await }));
        }
    }
    for a in asks {
        let r = a.await.unwrap();
        // The reader waits at most its deadline, or is told the node is busy.
        assert!(matches!(r.status, 503 | 504), "{}", r.status);
    }
    // Every call still running finishes, one at a time.
    tokio::time::sleep(Duration::from_millis(6 * 450)).await;
    assert_eq!(
        s.node.most.load(Ordering::SeqCst),
        1,
        "one join at the node at a time"
    );
    // Each large one learned is never asked again, whoever asks.
    let before: Vec<usize> = large.iter().map(|a| s.node.totals_calls(a)).collect();
    assert!(before.iter().all(|n| *n <= 1), "{before:?}");
    for a in &large {
        if s.node.totals_calls(a) == 1 {
            let r = get(&s.addr, 99, &format!("/regtest/api/address/{a}")).await;
            assert_eq!((r.status, r.body["error"].as_str()), (503, Some(TOO_LARGE)));
            let r = get(&s.addr, 98, &format!("/regtest/api/address/{a}/txs")).await;
            assert_eq!((r.status, r.body["error"].as_str()), (503, Some(TOO_LARGE)));
        }
    }
    let after: Vec<usize> = large.iter().map(|a| s.node.totals_calls(a)).collect();
    assert_eq!(before, after);
    // A small address is answered as before, then freely.
    let small = address(50);
    s.node.set(&small, Kind::Small);
    for _ in 0..3 {
        assert_eq!(
            get(&s.addr, 1, &format!("/regtest/api/address/{small}"))
                .await
                .status,
            200
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_large_address_is_added_up_from_its_answer_and_then_served_from_the_ledger() {
    let s = start(true, &[]).await;
    let a = address(7);
    s.node.set(&a, Kind::Large { ms: 500 });
    // Past the deadline: the reader is told, and the node's answer, when it comes, is the seed.
    let r = get(&s.addr, 1, &format!("/regtest/api/address/{a}")).await;
    assert_eq!(r.status, 504);
    wait_for("tracked", || async {
        ledger(&s, 1, &a).await["state"] == "tracked"
    })
    .await;
    let v = ledger(&s, 1, &a).await;
    assert_eq!(v["chain_stats"]["funded_txo_count"], 50_000);
    assert_eq!(v["at"]["height"], TIP);
    assert_eq!(v["seeded"]["height"], TIP);
    // Taken from an answer, without a page: the page before its seed block follows once, in the
    // lane, pinned to that block.
    wait_for("filled", || async {
        ledger(&s, 1, &a).await["filling"] == false
    })
    .await;
    let pages = s.node.pages();
    assert_eq!(pages.len(), 1, "{pages:?}");
    assert!(
        pages[0].ends_with(&format!("?asof={}", hash(TIP))),
        "{pages:?}"
    );
    // From the ledger, in the node's shape, stamped with the ledger's block; the node's own
    // totals route is not asked again.
    let r = get(&s.addr, 2, &format!("/regtest/api/address/{a}")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body["chain_stats"]["funded_txo_sum"], 50_000_000);
    assert_eq!(r.body["mempool_stats"]["tx_count"], 1);
    assert_eq!(r.body["address"], a.to_string());
    assert!(
        r.headers
            .contains(&format!("x-bitcoin-chain-tip-height: {TIP}")),
        "{}",
        r.headers
    );
    assert_eq!(r.body["mempool_stats"]["funded_txo_sum"], 70_000);
    // The scripthash form counts the same unconfirmed rows.
    let sh = ScriptHash::from_script(&a.script_pubkey());
    let r = get(&s.addr, 2, &format!("/regtest/api/scripthash/{sh}")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body["scripthash"], sh.to_string());
    assert_eq!(r.body["mempool_stats"]["funded_txo_sum"], 70_000);
    assert_eq!(r.body["mempool_stats"]["tx_count"], 1);
    assert_eq!(s.node.totals_calls(&a), 1);
    // What the ledger does not keep is refused in words that say so, without the node.
    let r = get(&s.addr, 2, &format!("/regtest/api/address/{a}/utxo")).await;
    assert_eq!(r.status, 503);
    assert!(
        r.body["error"].as_str().unwrap().contains("not kept"),
        "{}",
        r.body
    );
    let r = get(&s.addr, 2, &format!("/regtest/api/address/{a}/txs")).await;
    assert_eq!((r.status, r.body["error"].as_str()), (503, Some(TOO_LARGE)));
    assert_eq!(s.node.totals_calls(&a), 1);
    assert_eq!(s.node.pages().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_kept_address_takes_its_whole_history_once_and_a_refused_one_takes_the_page() {
    let s = start(true, &[]).await;
    let (whole, refused) = (address(40), address(41));
    s.node.set(&whole, Kind::Large { ms: 0 });
    s.node.set(&refused, Kind::Large { ms: 0 });
    let sh = ScriptHash::from_script(&whole.script_pubkey()).to_string();
    // As many rows as the totals count: 50,000.
    s.node.lists.lock().unwrap().insert(sh, 50_000);
    for a in [&whole, &refused] {
        assert_eq!(
            get(&s.addr, 1, &format!("/regtest/api/address/{a}"))
                .await
                .status,
            200
        );
    }
    wait_for("whole", || async {
        ledger(&s, 1, &whole).await["history"] == "whole"
    })
    .await;
    wait_for("refused", || async {
        ledger(&s, 1, &refused).await["history"] == "refused"
    })
    .await;
    // The refused one takes the newest page instead; the whole one needs none (it may have
    // taken it before a reader viewed it, as any kept address does).
    wait_for("filled", || async {
        ledger(&s, 1, &refused).await["filling"] == false
    })
    .await;
    assert_eq!(ledger(&s, 1, &whole).await["filling"], false);
    let refused_sh = ScriptHash::from_script(&refused.script_pubkey()).to_string();
    assert!(
        s.node.pages().iter().any(|p| p.contains(&refused_sh)),
        "{:?}",
        s.node.pages()
    );
    // Each list asked once; more blocks or readers do not ask again.
    assert_eq!(s.node.list_calls.load(Ordering::SeqCst), 2);
    for _ in 0..3 {
        ledger(&s, 2, &whole).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(s.node.list_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_seed_the_node_refuses_leaves_the_address_as_it_was_and_says_why() {
    let s = start(true, &[]).await;
    let a = address(8);
    s.node.set(&a, Kind::Refused { ms: 0 });
    let r = get(&s.addr, 1, &format!("/regtest/api/address/{a}")).await;
    assert_eq!((r.status, r.body["error"].as_str()), (503, Some(TOO_LARGE)));
    // The page asks: a seed is queued, tried once, and refused with the node's counts.
    let v = ledger(&s, 1, &a).await;
    assert!(
        ["queued", "seeding", "refused"].contains(&v["state"].as_str().unwrap()),
        "{v}"
    );
    wait_for("refused", || async {
        ledger(&s, 1, &a).await["state"] == "refused"
    })
    .await;
    let v = ledger(&s, 1, &a).await;
    assert_eq!(
        (v["creates"].as_u64(), v["cap"].as_u64()),
        (Some(20_000), Some(10_000))
    );
    // Asked again, it is not tried again for a while.
    let calls = s.node.totals_calls(&a);
    assert_eq!(ledger(&s, 1, &a).await["state"], "refused");
    assert_eq!(s.node.totals_calls(&a), calls);
    // Over TCP the uncapped route never exists: nothing is asked under `/internal`.
    assert!(
        s.node.internal_paths().is_empty(),
        "{:?}",
        s.node.internal_paths()
    );
}

const PROBE: &str =
    "/internal/scripthash/0000000000000000000000000000000000000000000000000000000000000000";

/// The server reaches the mock over a unix socket; whether the mock serves the uncapped route.
async fn on_socket(route: bool) -> Server {
    let s = start_via(true, true, &[], |n| {
        n.internal.store(route, Ordering::SeqCst)
    })
    .await;
    wait_for("the probe", || async {
        s.node.internal_paths().iter().any(|p| p == PROBE)
    })
    .await;
    s
}

/// Reads the address's totals the way a reader does (refused for size), then has the page ask
/// for its ledger until `state`.
async fn refused_then(s: &Server, a: &Address, state: &str) -> Value {
    let r = get(&s.addr, 1, &format!("/regtest/api/address/{a}")).await;
    assert_eq!((r.status, r.body["error"].as_str()), (503, Some(TOO_LARGE)));
    wait_for(state, || async { ledger(s, 1, a).await["state"] == state }).await;
    ledger(s, 1, a).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_address_above_the_cap_is_added_up_through_the_socket_and_its_list_stays_refused() {
    let s = on_socket(true).await;
    let a = address(90);
    s.node.set(&a, Kind::Refused { ms: 0 });
    let sh = ScriptHash::from_script(&a.script_pubkey()).to_string();
    let v = refused_then(&s, &a, "tracked").await;
    assert_eq!(v["chain_stats"]["funded_txo_count"], 50_000);
    // Added up once, through the uncapped route, pinned to a block the ledger holds.
    let asked: Vec<String> = s
        .node
        .internal_paths()
        .into_iter()
        .filter(|p| p.starts_with(&format!("/internal/scripthash/{sh}?asof=")))
        .collect();
    assert_eq!(asked.len(), 1, "{:?}", s.node.internal_paths());
    // Electrum still refuses its whole list: the ledger says so, and takes the newest page.
    wait_for("list refused", || async {
        ledger(&s, 1, &a).await["history"] == "refused"
    })
    .await;
    wait_for("filled", || async {
        ledger(&s, 1, &a).await["filling"] == false
    })
    .await;
    // Its totals are the ledger's now; its history pages are still refused, at once.
    let r = get(&s.addr, 1, &format!("/regtest/api/address/{a}")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body["chain_stats"]["funded_txo_count"], 50_000);
    let r = get(&s.addr, 1, &format!("/regtest/api/address/{a}/txs/chain")).await;
    assert_eq!((r.status, r.body["error"].as_str()), (503, Some(TOO_LARGE)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn on_a_socket_without_the_route_a_seed_above_the_cap_is_refused_as_before() {
    let s = on_socket(false).await;
    let a = address(91);
    s.node.set(&a, Kind::Refused { ms: 0 });
    let v = refused_then(&s, &a, "refused").await;
    assert_eq!(v["creates"], 20_000);
    assert_eq!(s.node.internal_paths(), vec![PROBE.to_owned()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_that_loses_the_route_is_probed_again_and_asked_the_capped_route() {
    let s = on_socket(true).await;
    // Downgraded since the probe: the route is the unknown path again.
    s.node.internal.store(false, Ordering::SeqCst);
    let a = address(92);
    s.node.set(&a, Kind::Refused { ms: 0 });
    refused_then(&s, &a, "refused").await;
    let sh = ScriptHash::from_script(&a.script_pubkey()).to_string();
    let internal = s.node.internal_paths();
    // The probe, the seed's 404, the probe again; then the capped route refused the seed.
    assert_eq!(internal.len(), 3, "{internal:?}");
    assert!(internal[1].starts_with(&format!("/internal/scripthash/{sh}?asof=")));
    assert_eq!(internal[2], PROBE);
    // A later seed asks the capped route only.
    let b = address(93);
    s.node.set(&b, Kind::Refused { ms: 0 });
    refused_then(&s, &b, "refused").await;
    assert_eq!(s.node.internal_paths().len(), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_upgraded_under_the_server_is_probed_again_and_adds_up_a_refused_address() {
    let s = on_socket(false).await;
    let a = address(96);
    s.node.set(&a, Kind::Refused { ms: 0 });
    refused_then(&s, &a, "refused").await;
    // Restarted with the route: the server reconnects, asks again, and the refusal it remembered
    // no longer holds the address back.
    s.node.internal.store(true, Ordering::SeqCst);
    s.node.restart.notify_waiters();
    wait_for("the second probe", || async {
        s.node
            .internal_paths()
            .iter()
            .filter(|p| *p == PROBE)
            .count()
            == 2
    })
    .await;
    wait_for("tracked", || async {
        ledger(&s, 1, &a).await["state"] == "tracked"
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_probe_without_an_answer_leaves_the_route_unused() {
    let s = start_via(true, true, &[], |n| {
        n.internal.store(true, Ordering::SeqCst);
        n.probe_fails.store(true, Ordering::SeqCst);
    })
    .await;
    wait_for("the probe", || async {
        s.node.internal_paths().iter().any(|p| p == PROBE)
    })
    .await;
    let a = address(94);
    s.node.set(&a, Kind::Refused { ms: 0 });
    refused_then(&s, &a, "refused").await;
    assert_eq!(s.node.internal_paths(), vec![PROBE.to_owned()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_adds_up_a_script_above_the_cap_through_the_socket() {
    let d = address(95);
    let s = start_via(true, true, &[("LEDGER_DISCOVER", "true")], |node| {
        node.internal.store(true, Ordering::SeqCst);
        node.paid.lock().unwrap().push(d.script_pubkey());
        node.set(&d, Kind::Refused { ms: 0 });
    })
    .await;
    wait_for("found and tracked", || async {
        ledger(&s, 1, &d).await["state"] == "tracked"
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn seeds_run_one_at_a_time_and_a_client_holds_two_places_at_most() {
    let s = start(true, &[]).await;
    // Refused for size, slowly: each seed holds the lane 200 ms.
    let addrs: Vec<Address> = (20..30).map(address).collect();
    for a in &addrs {
        s.node.set(a, Kind::Refused { ms: 200 });
        let r = get(&s.addr, 1, &format!("/regtest/api/address/{a}")).await;
        assert_eq!(r.status, 503);
    }
    s.node.most.store(0, Ordering::SeqCst);
    // One client queues two, a third is not taken.
    assert_eq!(ledger(&s, 5, &addrs[0]).await["state"], "queued");
    assert_eq!(ledger(&s, 5, &addrs[1]).await["state"], "queued");
    assert_eq!(ledger(&s, 5, &addrs[2]).await["state"], "busy");
    // Many clients at once, all the rest.
    let mut asks = Vec::new();
    for (i, a) in addrs.iter().enumerate().skip(2) {
        let (addr, path) = (s.addr.clone(), format!("/regtest/app/address/{a}/ledger"));
        let client = 40 + u8::try_from(i).unwrap();
        asks.push(tokio::spawn(async move { get(&addr, client, &path).await }));
    }
    for a in asks {
        assert_eq!(a.await.unwrap().status, 200);
    }
    // Readers keep asking while they wait, as the page does.
    wait_for("every seed refused", || async {
        let mut done = true;
        for (i, a) in addrs.iter().enumerate() {
            let client = if i < 2 {
                5
            } else {
                40 + u8::try_from(i).unwrap()
            };
            done &= ledger(&s, client, a).await["state"] == "refused";
        }
        done
    })
    .await;
    assert_eq!(
        s.node.most.load(Ordering::SeqCst),
        1,
        "one seed at the node at a time"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_evicted_address_is_added_up_again_when_a_reader_asks() {
    let s = start(true, &[("LEDGER_MAX_ADDRESSES", "1")]).await;
    let (a, b) = (address(60), address(61));
    for x in [&a, &b] {
        s.node.set(x, Kind::Large { ms: 350 });
    }
    get(&s.addr, 1, &format!("/regtest/api/address/{a}")).await;
    wait_for("a tracked", || async {
        ledger(&s, 1, &a).await["state"] == "tracked"
    })
    .await;
    get(&s.addr, 1, &format!("/regtest/api/address/{b}")).await;
    wait_for("b tracked", || async {
        ledger(&s, 1, &b).await["state"] == "tracked"
    })
    .await;
    // The ledger holds one: a, the least recently viewed, made room. Known large, it is queued
    // again when its page asks, and seeded at the ledger's own block (making room in turn).
    let v = ledger(&s, 1, &a).await;
    assert!(
        ["queued", "seeding", "tracked"].contains(&v["state"].as_str().unwrap()),
        "{v}"
    );
    wait_for("a tracked again", || async {
        ledger(&s, 1, &a).await["state"] == "tracked"
    })
    .await;
    assert!(
        s.node
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|p| p.contains("asof=")),
        "the second seed is pinned to a block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_finds_a_script_the_blocks_pay_often_without_a_reader() {
    let d = address(70);
    let s = start_with(true, &[("LEDGER_DISCOVER", "true")], |node| {
        node.paid.lock().unwrap().push(d.script_pubkey());
        node.set(&d, Kind::Large { ms: 0 });
    })
    .await;
    wait_for("found and tracked", || async {
        get(&s.addr, 1, &format!("/regtest/app/address/{d}/ledger"))
            .await
            .body["state"]
            == "tracked"
    })
    .await;
    assert_eq!(s.node.totals_calls(&d), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_quick_list_of_unspent_outputs_does_not_make_an_address_small() {
    let s = start(false, &[]).await;
    let a = address(80);
    s.node.set(&a, Kind::Large { ms: 400 });
    // Its unspent outputs answer at once: that says nothing of its size.
    assert_eq!(
        get(&s.addr, 1, &format!("/regtest/api/address/{a}/utxo"))
            .await
            .status,
        200
    );
    s.node.most.store(0, Ordering::SeqCst);
    // So its totals, pinned to two blocks (two keys), still go one at a time.
    let (x, y) = (hash(100), hash(101));
    let one = tokio::spawn({
        let addr = s.addr.clone();
        let path = format!("/regtest/api/address/{a}?asof={x}");
        async move { get(&addr, 2, &path).await }
    });
    let two = tokio::spawn({
        let addr = s.addr.clone();
        let path = format!("/regtest/api/address/{a}?asof={y}");
        async move { get(&addr, 3, &path).await }
    });
    one.await.unwrap();
    two.await.unwrap();
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(s.node.most.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn totals_at_an_old_block_do_not_make_an_address_small_today() {
    let s = start(false, &[]).await;
    let a = address(81);
    s.node.set(&a, Kind::Grew { ms: 400 });
    // Small at block 50: that says nothing of today.
    let r = get(
        &s.addr,
        1,
        &format!("/regtest/api/address/{a}?asof={}", hash(50)),
    )
    .await;
    assert_eq!(r.status, 200);
    s.node.most.store(0, Ordering::SeqCst);
    let ask = |client: u8, path: String| {
        let addr = s.addr.clone();
        tokio::spawn(async move { get(&addr, client, &path).await })
    };
    let one = ask(2, format!("/regtest/api/address/{a}"));
    let two = ask(3, format!("/regtest/api/address/{a}?asof={}", hash(105)));
    one.await.unwrap();
    two.await.unwrap();
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(s.node.most.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_readers_deadline_counts_from_when_the_node_is_asked() {
    let s = start(false, &[]).await;
    let (slow, quick) = (address(82), address(83));
    // The lane is held a second by another address's join.
    s.node.set(&slow, Kind::Large { ms: 1000 });
    s.node.set(&quick, Kind::Large { ms: 150 });
    let first = {
        let (addr, path) = (s.addr.clone(), format!("/regtest/api/address/{slow}"));
        tokio::spawn(async move { get(&addr, 1, &path).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    // This one waits for the lane, then the node answers well inside the deadline: answered.
    let r = get(&s.addr, 2, &format!("/regtest/api/address/{quick}")).await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(first.await.unwrap().status, 504);
}

/// Pages of `path` (a `/txs/chain` or `/txs/summary` route) to the end, each after the last.
async fn walk(s: &Server, path: &str) -> Vec<Value> {
    let mut all = Vec::new();
    let mut target = path.to_owned();
    loop {
        let r = get(&s.addr, 3, &target).await;
        assert_eq!(r.status, 200, "{target}: {}", r.body);
        assert!(
            r.headers
                .contains(&format!("x-bitcoin-chain-tip-height: {TIP}")),
            "{}",
            r.headers
        );
        let rows = r.body.as_array().unwrap().clone();
        assert!(rows.len() <= 25);
        let Some(last) = rows.last() else { break };
        target = format!("{path}/{}", last["txid"].as_str().unwrap());
        all.extend(rows);
    }
    all
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_whole_history_is_paged_from_the_store_as_the_node_pages() {
    let s = start(true, &[]).await;
    let a = address(42);
    s.node.set(&a, Kind::Large { ms: 0 });
    let sh = ScriptHash::from_script(&a.script_pubkey());
    s.node.lists.lock().unwrap().insert(sh.to_string(), 60);
    // Until the list is in, pages are refused as before.
    assert_eq!(
        get(&s.addr, 1, &format!("/regtest/api/address/{a}"))
            .await
            .status,
        200
    );
    wait_for("whole", || async {
        ledger(&s, 1, &a).await["history"] == "whole"
    })
    .await;
    // The node's order: height, then txid bytes, both descending.
    let mut want: Vec<(u32, [u8; 32])> = s
        .node
        .txs
        .lock()
        .unwrap()
        .iter()
        .map(|(t, (h, _))| (*h, t.parse::<bitcoin::Txid>().unwrap().to_byte_array()))
        .collect();
    want.sort_unstable_by(|x, y| y.cmp(x));
    let want: Vec<String> = want
        .into_iter()
        .map(|(_, t)| bitcoin::Txid::from_byte_array(t).to_string())
        .collect();
    assert_eq!(want.len(), 60);
    let before = s.node.seen.lock().unwrap().len();
    for form in [format!("address/{a}"), format!("scripthash/{sh}")] {
        let chain = walk(&s, &format!("/regtest/api/{form}/txs/chain")).await;
        let got: Vec<&str> = chain.iter().map(|t| t["txid"].as_str().unwrap()).collect();
        assert_eq!(got, want, "{form}");
        assert!(chain.iter().all(|t| t["status"]["confirmed"] == true));
        let summary = walk(&s, &format!("/regtest/api/{form}/txs/summary")).await;
        let got: Vec<&str> = summary
            .iter()
            .map(|t| t["txid"].as_str().unwrap())
            .collect();
        assert_eq!(got, want, "{form} summary");
        assert!(
            summary
                .iter()
                .all(|t| t["value"] == 1000 && t["time"].as_u64().unwrap() > 0)
        );
    }
    // Only the transactions themselves, by txid, the cursors' status and the ledger's block's
    // status: never a page of the address. A page costs at most 27 lookups.
    let asked: Vec<String> = s.node.seen.lock().unwrap()[before..].to_vec();
    let block = format!("/block/{}/status", hash(TIP));
    assert!(
        asked.iter().all(|p| p.starts_with("/tx/") || *p == block),
        "{asked:?}"
    );
    let pages = 2 * 2 * 3;
    assert!(asked.len() <= pages * 27, "{}", asked.len());
    // `/txs`: the unconfirmed row, then the newest 25; after the 25th, the next.
    let r = get(&s.addr, 1, &format!("/regtest/api/address/{a}/txs")).await;
    assert_eq!(r.status, 200);
    let rows = r.body.as_array().unwrap();
    assert_eq!(rows.len(), 26);
    assert_eq!(rows[0]["status"]["confirmed"], false);
    assert_eq!(rows[1]["txid"].as_str(), Some(want[0].as_str()));
    let r = get(
        &s.addr,
        1,
        &format!("/regtest/api/address/{a}/txs?after_txid={}", want[24]),
    )
    .await;
    let rows = r.body.as_array().unwrap();
    assert_eq!(rows[0]["txid"].as_str(), Some(want[25].as_str()));
    // Pinned to the ledger's block: the same; to a block it does not hold: refused in words.
    let r = get(
        &s.addr,
        1,
        &format!("/regtest/api/address/{a}/txs/chain?asof={}", hash(TIP)),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body[0]["txid"].as_str(), Some(want[0].as_str()));
    let r = get(
        &s.addr,
        1,
        &format!("/regtest/api/address/{a}/txs/chain?asof={}", hash(50)),
    )
    .await;
    assert_eq!(r.status, 503);
    assert!(
        r.body["error"].as_str().unwrap().contains("not kept"),
        "{}",
        r.body
    );
    // The node has left the ledger's block for another branch the ledger has not followed yet:
    // the page is not given as of a block that is no longer the node's.
    s.node.orphaned.lock().unwrap().push(hash(TIP).to_string());
    for route in ["txs/chain", "txs/summary", "txs"] {
        let r = get(&s.addr, 1, &format!("/regtest/api/address/{a}/{route}")).await;
        assert_eq!(r.status, 503, "{route}: {}", r.body);
        assert!(
            r.body["error"].as_str().unwrap().contains("retry"),
            "{}",
            r.body
        );
    }
    s.node.orphaned.lock().unwrap().clear();
    // A cursor the node does not know, or not this address's.
    for cursor in ["ab".repeat(32), "11".repeat(32)] {
        let r = get(
            &s.addr,
            1,
            &format!("/regtest/api/address/{a}/txs/chain/{cursor}"),
        )
        .await;
        assert_eq!(r.status, 422, "{cursor}: {}", r.body);
    }
}

/// A WebSocket on the app's socket, just enough to follow an address: text frames only.
struct Ws(TcpStream);

impl Ws {
    async fn open(addr: &str) -> Ws {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let req = concat!(
            "GET /regtest/app/ws HTTP/1.1\r\nHost: test\r\nUpgrade: websocket\r\n",
            "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
            "Sec-WebSocket-Version: 13\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut b = [0u8];
            stream.read_exact(&mut b).await.unwrap();
            head.push(b[0]);
        }
        assert!(head.starts_with(b"HTTP/1.1 101"));
        Ws(stream)
    }

    async fn send(&mut self, msg: Value) {
        let payload = msg.to_string().into_bytes();
        // Short messages only: one length byte, masked as a client must.
        let mut out = vec![0x81, 0x80 | u8::try_from(payload.len()).unwrap()];
        let key = [1u8, 2, 3, 4];
        out.extend_from_slice(&key);
        out.extend(payload.iter().zip(key.iter().cycle()).map(|(b, k)| b ^ k));
        self.0.write_all(&out).await.unwrap();
    }

    /// The next text message within `wait`, skipping pings; `None` when none came.
    async fn next(&mut self, wait: Duration) -> Option<Value> {
        let read = async {
            loop {
                let mut head = [0u8; 2];
                self.0.read_exact(&mut head).await.ok()?;
                let len = match head[1] & 0x7F {
                    126 => usize::from(self.0.read_u16().await.ok()?),
                    127 => usize::try_from(self.0.read_u64().await.ok()?).ok()?,
                    n => usize::from(n),
                };
                let mut payload = vec![0u8; len];
                self.0.read_exact(&mut payload).await.ok()?;
                if head[0] == 0x81 {
                    return serde_json::from_slice(&payload).ok();
                }
            }
        };
        tokio::time::timeout(wait, read).await.ok().flatten()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn followers_hear_when_a_whole_history_is_dropped_for_anothers() {
    // Room for one of the two histories. No fill ends, so only the drop itself can be heard.
    let s = start(true, &[("LEDGER_MAX_HISTORY_ROWS", "80")]).await;
    s.node.fail_pages.store(true, Ordering::SeqCst);
    let (a, b) = (address(50), address(51));
    for x in [&a, &b] {
        s.node.set(x, Kind::Large { ms: 0 });
        let sh = ScriptHash::from_script(&x.script_pubkey()).to_string();
        s.node.lists.lock().unwrap().insert(sh, 50);
    }
    get(&s.addr, 1, &format!("/regtest/api/address/{a}")).await;
    wait_for("a whole", || async {
        ledger(&s, 1, &a).await["history"] == "whole"
    })
    .await;
    // A page follows the address.
    let mut ws = Ws::open(&s.addr).await;
    ws.send(json!({"op": "subscribe", "topics": [format!("address:{a}")]}))
        .await;
    let topic = format!("address:{a}");
    let said = |m: &Value| m["topic"] == topic.as_str() && m["state"] == "ledger";
    loop {
        let m = ws
            .next(Duration::from_secs(5))
            .await
            .expect("no ledger message");
        if said(&m) {
            break;
        }
    }
    // Anything still on its way (the notice that its history is whole may come just after the
    // subscription) is read now, so what follows is heard only for what follows.
    while ws.next(Duration::from_millis(500)).await.is_some() {}
    // Another address takes its history, and the bound lets the first one's go once nobody has
    // viewed it lately.
    s.viewed_long_ago(&a).await;
    get(&s.addr, 2, &format!("/regtest/api/address/{b}")).await;
    wait_for("b whole", || async {
        ledger(&s, 2, &b).await["history"] == "whole"
    })
    .await;
    assert_eq!(ledger(&s, 1, &a).await["history"], "dropped");
    // The page hears it, so it stops paging a history that is gone.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let m = ws
            .next(deadline.saturating_duration_since(Instant::now()))
            .await
            .expect("the follower never heard the history was dropped");
        if said(&m) {
            break;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn followers_hear_when_an_address_with_a_whole_history_is_dropped_for_another() {
    // Room for one address. No fill ends, so only the drop itself can be heard.
    let s = start(true, &[("LEDGER_MAX_ADDRESSES", "1")]).await;
    s.node.fail_pages.store(true, Ordering::SeqCst);
    let (a, b) = (address(52), address(53));
    for x in [&a, &b] {
        s.node.set(x, Kind::Large { ms: 0 });
        let sh = ScriptHash::from_script(&x.script_pubkey()).to_string();
        s.node.lists.lock().unwrap().insert(sh, 50);
    }
    get(&s.addr, 1, &format!("/regtest/api/address/{a}")).await;
    wait_for("a whole", || async {
        ledger(&s, 1, &a).await["history"] == "whole"
    })
    .await;
    let mut ws = Ws::open(&s.addr).await;
    ws.send(json!({"op": "subscribe", "topics": [format!("address:{a}")]}))
        .await;
    let topic = format!("address:{a}");
    let said = |m: &Value| m["topic"] == topic.as_str() && m["state"] == "ledger";
    loop {
        let m = ws
            .next(Duration::from_secs(5))
            .await
            .expect("no ledger message");
        if said(&m) {
            break;
        }
    }
    // Anything still on its way (the notice that its history is whole may come just after the
    // subscription) is read now, so what follows is heard only for what follows.
    while ws.next(Duration::from_millis(500)).await.is_some() {}
    // Another large address is kept in its place.
    get(&s.addr, 2, &format!("/regtest/api/address/{b}")).await;
    wait_for("b kept", || async {
        ledger(&s, 2, &b).await["state"] == "tracked"
    })
    .await;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let m = ws
            .next(deadline.saturating_duration_since(Instant::now()))
            .await
            .expect("the follower never heard its address was dropped");
        if said(&m) {
            break;
        }
    }
    // Asked now, A is no longer kept (asking queues it again, which would tell its followers too).
    assert_ne!(ledger(&s, 1, &a).await["state"], "tracked");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_kept_address_nobody_views_takes_no_list_until_one_does() {
    let s = start(true, &[]).await;
    let a = address(54);
    s.node.set(&a, Kind::Large { ms: 0 });
    let sh = ScriptHash::from_script(&a.script_pubkey()).to_string();
    s.node.lists.lock().unwrap().insert(sh.clone(), 50);
    // Kept from an answer, as discovery's are, with nobody on its page: its newest page is taken
    // as before, its whole list is not.
    assert_eq!(
        get(&s.addr, 1, &format!("/regtest/api/address/{a}"))
            .await
            .status,
        200
    );
    wait_for("its page fill", || async {
        s.node.pages().iter().any(|p| p.contains(&sh))
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(s.node.list_calls.load(Ordering::SeqCst), 0);
    // A reader opens it: its whole list is taken.
    wait_for("whole", || async {
        ledger(&s, 1, &a).await["history"] == "whole"
    })
    .await;
    assert_eq!(s.node.list_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_history_a_reader_is_viewing_is_not_dropped_for_another() {
    // Room for one of the two histories.
    let s = start(true, &[("LEDGER_MAX_HISTORY_ROWS", "80")]).await;
    let (a, b) = (address(55), address(56));
    for x in [&a, &b] {
        s.node.set(x, Kind::Large { ms: 0 });
        let sh = ScriptHash::from_script(&x.script_pubkey()).to_string();
        s.node.lists.lock().unwrap().insert(sh, 50);
    }
    get(&s.addr, 1, &format!("/regtest/api/address/{a}")).await;
    wait_for("a whole", || async {
        ledger(&s, 1, &a).await["history"] == "whole"
    })
    .await;
    // B is viewed too, but A was viewed moments ago: B waits, and the node is not asked for it.
    get(&s.addr, 2, &format!("/regtest/api/address/{b}")).await;
    wait_for("b kept", || async {
        ledger(&s, 2, &b).await["state"] == "tracked"
    })
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(ledger(&s, 2, &b).await["history"], "none");
    assert_eq!(ledger(&s, 1, &a).await["history"], "whole");
    assert_eq!(s.node.list_calls.load(Ordering::SeqCst), 1);
}
