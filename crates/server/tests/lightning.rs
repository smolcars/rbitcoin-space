//! The Lightning routes and wiring end to end: the server on port 0 with Lightning on, its one
//! peer unreachable, over a store filled here, a mock RPC that counts calls, and an Esplora and
//! Electrum that do not answer. Nothing here reaches a real node or the Lightning network.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::routing::any;
use bitcoin::hashes::Hash;
use bitcoin::{BlockHash, Txid};
use engine::lightning::{self, Block, Change, Close, EVERY, Kind, Level, Open, Point, Stats};
use engine::store::{Options, Store};
use rbitcoin_space::{App, Config};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn dir(name: &str) -> Dir {
    let d = std::env::temp_dir().join(format!(
        "rbitcoin-space-lightning-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    Dir(d)
}

fn block(height: u32) -> Block {
    Block {
        height,
        hash: BlockHash::from_byte_array([7; 32]),
        time: 1_700_000_000,
    }
}

fn open(n: u64) -> Open {
    Open {
        scid: (800_000 + n) << 40 | 3 << 16,
        node_one: [2; 33],
        node_two: [3; 33],
        capacity: 1_000_000,
        block: block(800_000 + u32::try_from(n).unwrap()),
    }
}

fn stats(n: u64) -> Stats {
    Stats {
        channels: 36_000 * n,
        nodes: 13_000 * n,
        capacity: 323_100_000_000 * n,
        tor_nodes: 6_000 * n,
        clearnet_nodes: 3_000 * n,
        clearnet_tor_nodes: 1_000 * n,
        unannounced_nodes: 3_000 * n,
        med_capacity: 2_000_000 * n,
        policies: 60_000 * n,
        fee_rate: 60_000 * 800 * n,
        base_fee: 60_000 * 900 * n,
        med_fee_rate: 100 * n,
        med_base_fee: 500 * n,
    }
}

/// 120 channels, 30 of them closed, and a snapshot every ten minutes for the last day.
async fn fill(dir: &Path) {
    let store = Store::open(dir, "regtest", Options::default()).unwrap();
    let mut changes: Vec<Change> = (0..120).map(|n| Change::Opened(open(n))).collect();
    changes.extend((0..30).map(|n| {
        Change::Closed(
            open(n),
            Close {
                block: block(800_200 + u32::try_from(n).unwrap()),
                txid: Txid::from_byte_array([9; 32]),
                kind: Kind::Cooperative,
                fee: Some(300),
            },
        )
    }));
    lightning::apply(&store, changes).await.unwrap();
    let now = lightning::unix_now() / EVERY * EVERY;
    let points = (0..=144)
        .map(|i| Point {
            time: now - i * EVERY,
            samples: 1,
            sums: stats(1),
        })
        .collect();
    lightning::insert(&store, Level::Minute, points)
        .await
        .unwrap();
    store.close().await;
}

/// A peer that cannot be reached: nothing listens on port 1.
const PEER: &str = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@127.0.0.1:1";

/// The server over `dir`, Lightning on or off, and the count of RPC calls it makes.
async fn start(
    dir: &Path,
    lightning: bool,
) -> (
    String,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
    tokio::sync::oneshot::Sender<()>,
    Option<Arc<rbitcoin_space::lightning::Lightning>>,
) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let rpc = axum::Router::new().fallback(any(move |body: String| {
        // The readiness check calls `getblockchaininfo` on its own schedule; count the rest.
        if !body.contains("getblockchaininfo") {
            counter.fetch_add(1, Ordering::SeqCst);
        }
        async { "{}" }
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rpc_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, rpc).await });
    let mut vars: HashMap<&str, String> = [
        ("REGTEST_RPC_HOST", "127.0.0.1".to_owned()),
        ("REGTEST_RPC_PORT", rpc_port.to_string()),
        ("REGTEST_RPC_USER", "u".to_owned()),
        ("REGTEST_RPC_PASSWORD", "p".to_owned()),
        ("REGTEST_ESPLORA_URL", "http://127.0.0.1:1".to_owned()),
        ("REGTEST_ELECTRUM_ADDR", "127.0.0.1:1".to_owned()),
        ("REGTEST_MEMPOOL_ENABLED", "false".to_owned()),
        ("BACKFILL_ENABLED", "false".to_owned()),
        ("DATA_DIR", dir.display().to_string()),
        ("MCP_ENABLED", "true".to_owned()),
    ]
    .into_iter()
    .collect();
    if lightning {
        vars.insert("REGTEST_LIGHTNING_ENABLED", "true".to_owned());
        vars.insert("REGTEST_LIGHTNING_PEERS", PEER.to_owned());
    }
    let mut config = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
    config.limits.client_rate_per_sec = 10_000;
    config.limits.client_burst = 10_000;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(&config);
    let ln = app.lightning().first().cloned();
    let server = tokio::spawn(app.serve(listener, async {
        let _ = stopped.await;
    }));
    (addr, calls, server, stop, ln)
}

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

/// A `get_lightning_node` call's answer, as `POST /mcp` gives it.
async fn lightning_tool(addr: &str, node: &str) -> Value {
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": { "name": "get_lightning_node", "arguments": { "node": node } },
    })
    .to_string();
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "POST /mcp HTTP/1.1\r\nHost: t\r\nConnection: close\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let reply: Value = serde_json::from_slice(&raw[split + 4..]).unwrap();
    reply["result"]["structuredContent"].clone()
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

#[tokio::test]
async fn routes_answer_from_the_store_with_strict_parameters_and_no_node_calls() {
    let d = dir("routes");
    fill(&d.0).await;
    // A corrupt graph file: the peer starts empty and says so.
    let ln_dir = d.0.join("lightning").join("regtest");
    std::fs::create_dir_all(&ln_dir).unwrap();
    std::fs::write(ln_dir.join("graph"), b"not a graph").unwrap();
    let (addr, calls, server, stop, _) = start(&d.0, true).await;

    let s = get(&addr, "/regtest/app/lightning/status").await.json();
    assert!(
        ["starting", "syncing"].contains(&s["state"].as_str().unwrap()),
        "{s}"
    );
    assert_eq!(s["peers_configured"], 1, "{s}");

    // Our latest snapshot, and the reference's shape of it.
    let r = get(&addr, "/regtest/app/lightning/statistics/latest").await;
    assert_eq!(r.status, 200);
    let v = r.json();
    assert_eq!(v["channels"], 36_000);
    assert_eq!(v["avg_capacity"], 323_100_000_000u64 / 36_000);
    assert_eq!(
        (v["avg_fee_rate"].clone(), v["med_fee_rate"].clone()),
        (800.into(), 100.into())
    );
    let r = get(&addr, "/regtest/api/v1/lightning/statistics/latest").await;
    assert_eq!(r.header("access-control-allow-origin"), Some("*"));
    let latest = &r.json()["latest"];
    assert_eq!(latest["channel_count"], 36_000);
    assert_eq!(latest["node_count"], 13_000);
    assert_eq!(latest["avg_base_fee_mtokens"], 900);
    assert!(latest["added"].as_str().unwrap().ends_with(":00.000Z"));
    // The reference's fields, in its order.
    let text = String::from_utf8(r.body.clone()).unwrap();
    let order = [
        "id",
        "added",
        "channel_count",
        "node_count",
        "total_capacity",
        "tor_nodes",
        "clearnet_nodes",
        "unannounced_nodes",
        "avg_capacity",
        "avg_fee_rate",
        "avg_base_fee_mtokens",
        "med_capacity",
        "med_fee_rate",
        "med_base_fee_mtokens",
        "clearnet_tor_nodes",
    ];
    let at: Vec<usize> = order
        .iter()
        .map(|k| text.find(&format!("\"{k}\":")).unwrap())
        .collect();
    assert!(at.windows(2).all(|w| w[0] < w[1]), "{text}");
    assert_eq!(latest.as_object().unwrap().len(), order.len());

    // A day of ten-minute snapshots: complete, newest first in the reference's shape.
    let r = get(&addr, "/regtest/api/v1/lightning/statistics/24h").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("x-data-complete"), Some("true"));
    let points = r.json();
    let points = points.as_array().unwrap();
    assert!((144..=145).contains(&points.len()), "{}", points.len());
    assert!(points[0]["added"].as_u64() > points[1]["added"].as_u64());
    let text = String::from_utf8(r.body.clone()).unwrap();
    assert!(
        text.starts_with(r#"[{"added":"#) && text.contains(r#","channel_count":36000,"total_capacity":323100000000,"tor_nodes":6000,"clearnet_nodes":3000,"unannounced_nodes":3000,"clearnet_tor_nodes":1000}"#),
        "{text}"
    );
    assert_eq!(points[0].as_object().unwrap().len(), 7);
    let a = get(&addr, "/regtest/app/lightning/statistics/1m")
        .await
        .json();
    assert_eq!(a["step"], 3_600);
    assert_eq!(a["complete"], false);
    // Hourly points, each the mean of its snapshots: all 145 are counted once.
    let samples: u64 = a["points"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["samples"].as_u64().unwrap())
        .sum();
    assert_eq!(samples, 145);
    assert_eq!(a["points"][0]["channels"], 36_000);
    for bad in ["5h", "1M", "", "24h%00"] {
        let r = get(&addr, &format!("/regtest/app/lightning/statistics/{bad}")).await;
        assert!(r.status == 400 || r.status == 404, "{bad}: {}", r.status);
    }

    // The newest opens and closes, capped.
    let o = get(&addr, "/regtest/app/lightning/channels/opened")
        .await
        .json();
    let o = o.as_array().unwrap();
    assert_eq!(o.len(), 25);
    assert_eq!(o[0]["id"], "800119x3x0");
    assert_eq!(o[0]["closed"], Value::Null);
    let c = get(&addr, "/regtest/app/lightning/channels/closed?limit=100")
        .await
        .json();
    let c = c.as_array().unwrap();
    assert_eq!(c.len(), 30);
    assert_eq!(c[0]["closed"]["block"]["height"], 800_229);
    assert_eq!(c[0]["closed"]["kind"], "cooperative");
    assert_eq!(c[0]["node_one"]["id"].as_str().unwrap().len(), 66);
    for q in [
        "limit=0",
        "limit=101",
        "limit=x",
        "page=2",
        "limit=5&limit=6",
    ] {
        let r = get(
            &addr,
            &format!("/regtest/app/lightning/channels/opened?{q}"),
        )
        .await;
        assert_eq!(r.status, 400, "{q}");
    }

    // The explorer around it works, and readiness reports Lightning without depending on it.
    assert_eq!(get(&addr, "/healthz").await.status, 200);
    let ready = get(&addr, "/readyz").await.json();
    assert!(
        ready["networks"]["regtest"]["lightning"].is_string(),
        "{ready}"
    );
    assert_eq!(
        get(&addr, "/regtest/api/v1/statistics/2h").await.status,
        200
    );

    assert_eq!(calls.load(Ordering::SeqCst), 0, "a route called the node");
    // The server stops promptly, the peer with it.
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(20), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn with_lightning_off_the_routes_say_so() {
    let d = dir("off");
    let (addr, _, _server, _stop, _) = start(&d.0, false).await;
    assert_eq!(
        get(&addr, "/regtest/app/lightning/status").await.json(),
        serde_json::json!({ "state": "off" })
    );
    for path in [
        "/regtest/app/lightning/statistics/latest",
        "/regtest/app/lightning/statistics/24h",
        "/regtest/app/lightning/channels/closed",
        "/regtest/api/v1/lightning/statistics/latest",
        "/regtest/app/lightning/overview",
        "/regtest/app/lightning/feed",
        "/regtest/app/lightning/movers?period=1m",
        "/regtest/app/lightning/closes?days=90",
        "/regtest/app/lightning/penalties",
        "/regtest/app/lightning/search?q=acinq",
        "/regtest/app/lightning/channels/1x1x1",
        "/regtest/app/lightning/block/0000000000000000000000000000000000000000000000000000000000000000",
        "/regtest/api/v1/lightning/nodes/rankings",
        "/regtest/api/v1/lightning/channels/txids",
        "/regtest/api/v1/lightning/nodes/isp-ranking",
        "/regtest/api/v1/lightning/channels-geo",
    ] {
        let r = get(&addr, path).await;
        assert_eq!(r.status, 503, "{path}");
        assert_eq!(r.json()["error"], "lightning is off on this network");
    }
    // Not served at all, so the same 404 whether Lightning is on or off.
    for path in ["countries", "world"] {
        let r = get(&addr, &format!("/regtest/api/v1/lightning/nodes/{path}")).await;
        assert_eq!(r.status, 404, "{path}");
    }
    let ready = get(&addr, "/readyz").await.json();
    assert_eq!(ready["networks"]["regtest"]["lightning"], "off");
}

#[tokio::test]
async fn a_peer_that_cannot_start_leaves_the_explorer_working() {
    let d = dir("broken");
    fill(&d.0).await;
    // Where the peer's directory should be, a file: it cannot create its key there.
    std::fs::write(d.0.join("lightning"), b"in the way").unwrap();
    let (addr, calls, _server, _stop, _) = start(&d.0, true).await;
    let mut state = Value::Null;
    for _ in 0..100 {
        state = get(&addr, "/regtest/app/lightning/status").await.json()["state"].clone();
        if state == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(state, "failed");
    // What was stored is still served, and so is everything else.
    assert_eq!(
        get(&addr, "/regtest/app/lightning/channels/closed?limit=3")
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(get(&addr, "/healthz").await.status, 200);
    assert_eq!(
        get(&addr, "/regtest/api/v1/statistics/2h").await.status,
        200
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

// Nodes, channels, search and rankings: a scripted graph over a filled store.

mod graph {
    use super::*;
    use engine::lightning::fees::{self, FeeRecord, Fees};
    use engine::lightning::{
        Announcement, GraphChannel, GraphNode, Inbound, Index, Penalty, Policy, set_funding,
    };

    pub fn key(n: u8) -> [u8; 33] {
        let mut k = [n; 33];
        k[0] = 3;
        k
    }

    pub fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    pub const T: u64 = 1_790_000_000;
    pub const DAY: u64 = 86_400;

    pub fn policy(fee_rate: u32, enabled: bool) -> Policy {
        Policy {
            fee_rate,
            base_fee_msat: 1_000,
            cltv_delta: 144,
            min_htlc_msat: 1_000,
            max_htlc_msat: 990_000_000,
            enabled,
            last_update: 1_790_000_100,
            inbound: None,
        }
    }

    pub fn scid(h: u64, i: u64, o: u64) -> u64 {
        h << 40 | i << 16 | o
    }

    pub fn at(height: u32, days: u64) -> Block {
        Block {
            height,
            hash: BlockHash::from_byte_array([u8::try_from(height % 251).unwrap(); 32]),
            time: T + days * DAY,
        }
    }

    pub fn sopen(scid: u64, a: u8, b: u8, capacity: u64, days: u64) -> Open {
        Open {
            scid,
            node_one: key(a),
            node_two: key(b),
            capacity,
            block: at(u32::try_from(scid >> 40).unwrap(), days),
        }
    }

    pub fn txid(n: u8) -> Txid {
        Txid::from_byte_array([n; 32])
    }

    /// Node 1 "ACINQ" with two open channels; node 2 claims a hostile alias; node 3 announced
    /// nothing; node 4 copies node 1's alias. Three closes in the store: cooperative, force with
    /// a breach, and other.
    pub async fn fill(dir: &Path) -> (Vec<GraphNode>, Vec<GraphChannel>) {
        let store = Store::open(dir, "regtest", Options::default()).unwrap();
        let (c1, c2, c3, c4, c5, c6) = (
            scid(800_000, 5, 1),
            scid(800_100, 7, 0),
            scid(799_000, 1, 0),
            scid(799_500, 2, 1),
            scid(799_600, 3, 0),
            scid(800_200, 9, 0),
        );
        let close = |height, days, tx, kind, fee| Close {
            block: at(height, days),
            txid: txid(tx),
            kind,
            fee,
        };
        lightning::apply(
            &store,
            vec![
                Change::Opened(sopen(c1, 1, 2, 5_000_000, 0)),
                Change::Opened(sopen(c2, 1, 3, 2_000_000, 1)),
                Change::Opened(sopen(c6, 4, 3, 100_000, 2)),
                Change::Closed(
                    sopen(c3, 2, 3, 700_000, 0),
                    close(800_300, 3, 0x33, Kind::Cooperative, Some(300)),
                ),
                Change::Closed(
                    sopen(c4, 1, 3, 800_000, 0),
                    close(800_301, 3, 0x44, Kind::Force, None),
                ),
                Change::Penalty(
                    c4,
                    Penalty {
                        block: at(800_310, 3),
                        txid: txid(0x45),
                    },
                ),
                Change::Closed(
                    sopen(c5, 1, 2, 900_000, 0),
                    close(800_302, 3, 0x55, Kind::Other, Some(1_000)),
                ),
            ],
        )
        .await
        .unwrap();
        set_funding(
            &store,
            vec![
                (c1, at(800_000, 0).hash, txid(0xf1)),
                (c4, at(799_500, 0).hash, txid(0xf4)),
                // c4's close funded c2, between the same two nodes: a lineage.
                (c2, at(800_100, 1).hash, txid(0x44)),
            ],
        )
        .await
        .unwrap();
        // Fee history: node 1 moved its fee on c1 at T + 100 (with an inbound discount) and node
        // 2 its own at T + 90; c2 has only node 1's starting point.
        let rec = |time: u64, fee_rate, inbound| FeeRecord {
            time: u32::try_from(time).unwrap(),
            fees: Fees {
                fee_rate,
                base_fee_msat: 1_000,
                inbound,
            },
        };
        let discount = Some(Inbound {
            base_fee_msat: -1_000,
            fee_rate: -50,
        });
        for batch in [
            vec![
                (c1, 0, rec(T + 10, 2_000, None)),
                (c1, 1, rec(T + 20, 5, None)),
            ],
            vec![
                (c1, 0, rec(T + 100, 2_499, discount)),
                (c1, 1, rec(T + 90, 1, None)),
                (c2, 0, rec(T + 100, 150, None)),
            ],
        ] {
            fees::record(&store, batch, T, T + 1_000).await.unwrap();
        }
        // The history starts two days before the first close.
        lightning::insert(
            &store,
            Level::Day,
            vec![Point {
                time: T + DAY,
                samples: 1,
                sums: stats(1),
            }],
        )
        .await
        .unwrap();
        store.close().await;
        let node = |n: u8, alias: Option<&str>| GraphNode {
            id: key(n),
            announcement: alias.map(|a| Announcement {
                alias: a.to_owned(),
                color: [0x49, 0xda, 0xaa],
                addresses: vec![
                    "3.33.236.230:9735".to_owned(),
                    "of7husrflx7sforh3fw6yqlpwstee3wg5imvvmkp4bz6rbjxtg5nljad.onion:9735"
                        .to_owned(),
                ],
                // Bits 0, 7, 13 and 63.
                features: vec![0x81, 0x20, 0, 0, 0, 0, 0, 0x80],
                last_update: 1_790_000_200,
            }),
        };
        let nodes = vec![
            node(1, Some("ACINQ")),
            node(2, Some("<img src=x onerror=alert(1)>\"\\\u{fffd}")),
            node(3, None),
            node(4, Some("ACINQ")),
        ];
        let channels = vec![
            GraphChannel {
                scid: c1,
                nodes: [key(1), key(2)],
                capacity: 5_000_000,
                policies: [
                    Some(Policy {
                        inbound: Some(Inbound {
                            base_fee_msat: -1_000,
                            fee_rate: -50,
                        }),
                        ..policy(2_499, true)
                    }),
                    Some(policy(1, true)),
                ],
            },
            GraphChannel {
                scid: c2,
                nodes: [key(1), key(3)],
                capacity: 2_000_000,
                policies: [Some(policy(150, false)), None],
            },
            GraphChannel {
                scid: c6,
                nodes: [key(4), key(3)],
                capacity: 100_000,
                policies: [None, None],
            },
        ];
        (nodes, channels)
    }

    pub async fn install(
        dir: &Path,
        l: &rbitcoin_space::lightning::Lightning,
        nodes: Vec<GraphNode>,
        channels: Vec<GraphChannel>,
    ) {
        // A second handle on the server's file, read-only use: the past as the server reads it.
        let store = Store::open(dir, "regtest", Options::default()).unwrap();
        let past = lightning::past(&store).await.unwrap();
        l.set_index(Index::build(nodes, channels, &past));
        l.set_fee_heads(fees::heads(&store).await.unwrap());
    }
}

/// JSON parsed with its keys in order, which `serde_json::Value` does not keep.
#[derive(Debug)]
enum J {
    Obj(Vec<(String, J)>),
    Arr(Vec<J>),
    Str,
    Num,
    Bool,
    Null,
}

fn parse(s: &str) -> J {
    fn ws(b: &[u8], i: &mut usize) {
        while b[*i].is_ascii_whitespace() {
            *i += 1;
        }
    }
    fn string(b: &[u8], i: &mut usize) -> String {
        let start = *i + 1;
        *i += 1;
        while b[*i] != b'"' {
            *i += if b[*i] == b'\\' { 2 } else { 1 };
        }
        *i += 1;
        String::from_utf8(b[start..*i - 1].to_vec()).unwrap()
    }
    fn value(b: &[u8], i: &mut usize) -> J {
        ws(b, i);
        match b[*i] {
            b'{' => {
                *i += 1;
                let mut out = Vec::new();
                loop {
                    ws(b, i);
                    if b[*i] == b'}' {
                        *i += 1;
                        return J::Obj(out);
                    }
                    if b[*i] == b',' {
                        *i += 1;
                        ws(b, i);
                    }
                    let k = string(b, i);
                    ws(b, i);
                    *i += 1; // ':'
                    out.push((k, value(b, i)));
                }
            }
            b'[' => {
                *i += 1;
                let mut out = Vec::new();
                loop {
                    ws(b, i);
                    match b[*i] {
                        b']' => {
                            *i += 1;
                            return J::Arr(out);
                        }
                        b',' => *i += 1,
                        _ => out.push(value(b, i)),
                    }
                }
            }
            b'"' => {
                string(b, i);
                J::Str
            }
            b't' | b'f' => {
                *i += if b[*i] == b't' { 4 } else { 5 };
                J::Bool
            }
            b'n' => {
                *i += 4;
                J::Null
            }
            _ => {
                while *i < b.len() && (b[*i].is_ascii_digit() || b"-+.eE".contains(&b[*i])) {
                    *i += 1;
                }
                J::Num
            }
        }
    }
    value(s.as_bytes(), &mut 0)
}

/// Fields we leave out because we cannot know them (docs/API.md, "Lightning").
const OMITTED: [&str; 3] = ["single_funded", "funding_balance", "closing_balance"];

/// `ours` has the reference's fields in its order and their JSON types; `null` stands for a
/// value either side does not know. Objects keyed by numbers (a transaction's inputs and
/// outputs) are compared by their values.
fn same_shape(ours: &J, reference: &J, at: &str) {
    match (ours, reference) {
        (J::Null, _) | (_, J::Null) => {}
        (J::Obj(a), J::Obj(b)) => {
            let numbered =
                |o: &Vec<(String, J)>| o.iter().all(|(k, _)| k.bytes().all(|c| c.is_ascii_digit()));
            if numbered(a) && numbered(b) {
                if let Some((_, r)) = b.first() {
                    for (k, v) in a {
                        same_shape(v, r, &format!("{at}.{k}"));
                    }
                }
                return;
            }
            let want: Vec<&str> = b
                .iter()
                .map(|(k, _)| k.as_str())
                .filter(|k| !OMITTED.contains(k))
                .collect();
            let got: Vec<&str> = a.iter().map(|(k, _)| k.as_str()).collect();
            assert_eq!(got, want, "keys at {at}");
            for ((k, v), (_, r)) in a
                .iter()
                .zip(b.iter().filter(|(k, _)| !OMITTED.contains(&k.as_str())))
            {
                same_shape(v, r, &format!("{at}.{k}"));
            }
        }
        (J::Arr(a), J::Arr(b)) => {
            // Each against the reference's item at the same place, or its last.
            for (i, v) in a.iter().enumerate() {
                if let Some(r) = b.get(i).or(b.last()) {
                    same_shape(v, r, &format!("{at}[{i}]"));
                }
            }
        }
        (J::Str, J::Str) | (J::Num, J::Num) | (J::Bool, J::Bool) => {}
        _ => panic!("type at {at}: ours {ours:?}, reference {reference:?}"),
    }
}

#[tokio::test]
async fn nodes_channels_search_and_rankings_answer_exactly_in_both_shapes() {
    let d = dir("graph");
    let (nodes, channels) = graph::fill(&d.0).await;
    let (addr, calls, server, stop, ln) = start(&d.0, true).await;
    let one = graph::hex(&graph::key(1));

    // Before a synced graph is indexed: retry, never a half-loaded answer.
    for p in [
        format!("/app/lightning/nodes/{one}"),
        "/api/v1/lightning/nodes/rankings".to_owned(),
        "/app/lightning/penalties".to_owned(),
    ] {
        let r = get(&addr, &format!("/regtest{p}")).await;
        assert_eq!((r.status, r.header("retry-after")), (503, Some("1")), "{p}");
        assert_eq!(r.json()["error"], "lightning graph is still syncing; retry");
    }
    graph::install(&d.0, &ln.unwrap(), nodes, channels).await;

    // The MCP tool names every field of gossip text it passes on: a node's announced addresses
    // can be a hostname of its choosing.
    let node = lightning_tool(&addr, &one).await;
    assert_eq!(
        node["sockets"],
        "3.33.236.230:9735,of7husrflx7sforh3fw6yqlpwstee3wg5imvvmkp4bz6rbjxtg5nljad.onion:9735"
    );
    assert_eq!(
        node["untrusted_text"],
        serde_json::json!(["alias", "sockets"])
    );
    let found = lightning_tool(&addr, "acinq").await;
    assert_eq!(found["matches"][0]["alias"], "ACINQ", "{found}");
    assert!(found["matches"][0]["sockets"].is_null(), "{found}");
    assert_eq!(found["untrusted_text"], serde_json::json!(["alias"]));

    // Every route's exact body, as reviewed when recorded.
    let want: serde_json::Map<String, Value> =
        serde_json::from_str(include_str!("lightning_routes.json")).unwrap();
    for (path, body) in &want {
        let r = get(&addr, &format!("/regtest{path}")).await;
        assert_eq!(r.status, 200, "{path}");
        assert_eq!(
            String::from_utf8(r.body).unwrap(),
            body.as_str().unwrap(),
            "{path}"
        );
        if path.starts_with("/api/v1/") {
            assert!(r.head.contains("access-control-allow-origin: *"), "{path}");
        }
    }

    // The totals a period ago, for the overview's changes: the first row from then, if near.
    {
        let store = Store::open(&d.0, "regtest", Options::default()).unwrap();
        let day_ago = (lightning::unix_now() - lightning::DAY) / EVERY * EVERY + EVERY;
        let point = |time| Point {
            time,
            samples: 1,
            sums: stats(7),
        };
        lightning::insert(&store, Level::Minute, vec![point(day_ago)])
            .await
            .unwrap();
        // A week ago there is only a row too far after it.
        let week_ago = lightning::unix_now() - 7 * lightning::DAY;
        lightning::insert(&store, Level::Hour, vec![point(week_ago + lightning::DAY)])
            .await
            .unwrap();
        store.close().await;
        let v = get(&addr, "/regtest/app/lightning/overview").await.json();
        let before = &v["before"];
        assert_eq!(before["24h"]["time"], day_ago, "{before}");
        assert_eq!(before["24h"]["channels"], stats(7).channels);
        assert_eq!(before["24h"]["med_fee_rate"], stats(7).med_fee_rate);
        assert_eq!((&before["1w"], &before["1m"]), (&Value::Null, &Value::Null));
    }

    // The reference's fields, order and types, against its recorded answers.
    let fixture = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/api-v1/lightning.json"
    ))
    .unwrap();
    let J::Obj(reference) = parse(&fixture) else {
        panic!()
    };
    let reference = |name: &str| &reference.iter().find(|(k, _)| k == name).unwrap().1;
    let c1 = graph::scid(800_000, 5, 1);
    let (f1, x4, x5) = (graph::txid(0xf1), graph::txid(0x44), graph::txid(0x55));
    for (path, name) in [
        ("search?searchText=acinq".to_owned(), "search"),
        ("search?searchText=799000x1x0".to_owned(), "search_channel"),
        ("nodes/rankings".to_owned(), "rankings"),
        ("nodes/rankings/liquidity".to_owned(), "rankings_liquidity"),
        (
            "nodes/rankings/connectivity".to_owned(),
            "rankings_connectivity",
        ),
        ("nodes/rankings/age".to_owned(), "rankings_age"),
        (format!("nodes/{one}"), "node"),
        (format!("nodes/{one}/statistics"), "node_statistics"),
        (format!("nodes/{one}/fees/histogram"), "node_fees_histogram"),
        (
            format!("channels?public_key={one}&status=open"),
            "channels_open",
        ),
        (
            format!("channels?public_key={one}&status=closed"),
            "channels_closed",
        ),
        (
            format!("channels?public_key={one}&status=active&index=0"),
            "channels_active",
        ),
        (
            format!("channels?public_key={one}&status=active&index=-1"),
            "channels_map",
        ),
        ("nodes/isp-ranking".to_owned(), "isp_ranking"),
        (
            format!("channels-geo/{one}?style=nodepage"),
            "channels_geo_node",
        ),
        (format!("channels/{c1}"), "channel"),
        (
            format!("channels/txids?txId[]={f1}&txId[]={x4}&txId[]={x5}"),
            "channels_txids",
        ),
    ] {
        let r = get(&addr, &format!("/regtest/api/v1/lightning/{path}")).await;
        assert_eq!(r.status, 200, "{path}");
        same_shape(
            &parse(std::str::from_utf8(&r.body).unwrap()),
            reference(name),
            name,
        );
    }
    // The reference's frontend asks the txids route with a trailing slash: the same answer.
    let txids = format!("/regtest/api/v1/lightning/channels/txids?txId[]={f1}&txId[]={x4}");
    let plain = get(&addr, &txids).await;
    let slash = get(&addr, &txids.replace("txids?", "txids/?")).await;
    assert_eq!((slash.status, slash.body), (plain.status, plain.body));

    // A node's past: a point per UTC midnight from our first statistics row, a point at each
    // open or close between, then now.
    let h = get(
        &addr,
        &format!("/regtest/app/lightning/nodes/{one}/history"),
    )
    .await
    .json();
    assert_eq!(h["from"], graph::T + graph::DAY);
    let points = h["points"].as_array().unwrap();
    assert_eq!(
        points[0],
        serde_json::json!({ "time": 1_790_121_600, "channels": 4, "capacity": 8_700_000 })
    );
    // The close a day in, at its block's time, not at the midnight after it.
    let at = |t: u64| points.iter().find(|p| p["time"] == t).cloned();
    assert_eq!(
        at(1_790_259_200),
        Some(serde_json::json!({ "time": 1_790_259_200, "channels": 2, "capacity": 7_000_000 }))
    );
    assert_eq!(
        at(1_790_294_400),
        Some(serde_json::json!({ "time": 1_790_294_400, "channels": 2, "capacity": 7_000_000 }))
    );
    let midnights = points
        .iter()
        .filter(|p| p["time"].as_u64().is_some_and(|t| t % graph::DAY == 0))
        .count();
    let s = get(
        &addr,
        &format!("/regtest/api/v1/lightning/nodes/{one}/statistics"),
    )
    .await
    .json();
    let s = s.as_array().unwrap();
    // The reference's shape is daily: the midnights and now, without the changes between.
    assert_eq!(s.len(), midnights + 1);
    assert_eq!(
        s.last().unwrap(),
        &serde_json::json!({ "added": 1_790_121_600, "capacity": 8_700_000, "channels": 4 })
    );

    // Active: the open channels that can forward (c1, not c2 whose one policy is disabled),
    // paged or all at once in the map's shape; X-Total-Count counts them either way.
    let channels = |q: &str| {
        let addr = &addr;
        let path = format!("/regtest/api/v1/lightning/channels?public_key={one}&{q}");
        async move { get(addr, &path).await }
    };
    let (c1, c2) = (c1.to_string(), graph::scid(800_100, 7, 0).to_string());
    for (q, total, ids) in [
        ("status=active&index=0", "1", vec![c1.as_str()]),
        ("status=active&index=-1", "1", vec![c1.as_str()]),
        ("status=active", "1", vec![c1.as_str()]),
        ("status=open&index=-1", "2", vec![c1.as_str(), c2.as_str()]),
    ] {
        let r = channels(q).await;
        let got: Vec<String> = r
            .json()
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            (r.header("x-total-count"), got),
            (Some(total), ids.iter().map(|s| (*s).to_owned()).collect()),
            "{q}"
        );
        assert_eq!(r.header("cache-control"), Some("public, max-age=10"), "{q}");
    }
    let map = channels("status=active&index=-1").await.json();
    assert_eq!(
        map,
        serde_json::json!([{
            "capacity": 5_000_000,
            "short_id": "800000x5x1",
            "id": c1,
            "node": { "alias": "<img src=x onerror=alert(1)>\"\\\u{fffd}", "public_key": graph::hex(&graph::key(2)) },
        }])
    );
    // Capacity by its nodes' addresses: c1 joins two clearnet nodes; c2 and c6 reach node 3,
    // which announced nothing, so they are unknown.
    let isp = get(&addr, "/regtest/api/v1/lightning/nodes/isp-ranking").await;
    assert_eq!(
        String::from_utf8(isp.body).unwrap(),
        r#"{"clearnetCapacity":5000000,"torCapacity":0,"unknownCapacity":2100000,"ispRanking":[]}"#
    );
    for p in [
        "channels-geo?style=widget".to_owned(),
        format!("channels-geo/{one}?style=nodepage"),
        format!("channels-geo/{}", graph::hex(&graph::key(9))),
    ] {
        let r = get(&addr, &format!("/regtest/api/v1/lightning/{p}")).await;
        assert_eq!((r.status, r.json()), (200, serde_json::json!([])), "{p}");
    }

    // Paging: X-Total-Count, and past the end an empty page.
    let r = get(
        &addr,
        &format!("/regtest/api/v1/lightning/channels?public_key={one}&status=open&index=1"),
    )
    .await;
    assert_eq!(
        (
            r.header("x-total-count"),
            r.json().as_array().unwrap().len()
        ),
        (Some("2"), 1)
    );
    let r = get(
        &addr,
        &format!("/regtest/api/v1/lightning/channels?public_key={one}&status=closed&index=100000"),
    )
    .await;
    assert_eq!((r.status, r.json()), (200, serde_json::json!([])));
    let p = get(
        &addr,
        &format!("/regtest/app/lightning/nodes/{one}/channels?status=open&page=4000"),
    )
    .await
    .json();
    assert_eq!(
        (p["total"].clone(), p["channels"].clone()),
        (2.into(), serde_json::json!([]))
    );

    // Unknown things are 404; malformed ones 400, before any work.
    let unknown = graph::hex(&graph::key(9));
    for (p, status) in [
        (format!("/app/lightning/nodes/{unknown}"), 404),
        (format!("/api/v1/lightning/nodes/{unknown}"), 404),
        (
            format!("/api/v1/lightning/nodes/{unknown}/fees/histogram"),
            404,
        ),
        (format!("/app/lightning/nodes/{unknown}/history"), 404),
        ("/app/lightning/channels/1x1x1".to_owned(), 404),
        ("/api/v1/lightning/channels/1".to_owned(), 404),
        (format!("/app/lightning/tx/{}", graph::txid(1)), 200),
        (format!("/app/lightning/nodes/{}", &one[..64]), 400),
        (format!("/app/lightning/nodes/{one}00"), 400),
        (
            format!("/api/v1/lightning/nodes/{}", one.replace('1', "g")),
            400,
        ),
        ("/app/lightning/channels/800000x5".to_owned(), 400),
        ("/app/lightning/channels/16777216x0x0".to_owned(), 400),
        ("/api/v1/lightning/channels/-1".to_owned(), 400),
        (
            "/api/v1/lightning/channels/18446744073709551616".to_owned(),
            400,
        ),
        ("/app/lightning/tx/abc".to_owned(), 400),
        ("/api/v1/lightning/channels/txids?txId[]=zz".to_owned(), 400),
        ("/app/lightning/search?q=ab".to_owned(), 400),
        ("/app/lightning/search?q=%3Cb%3E%07x".to_owned(), 400),
        ("/app/lightning/search?q=a%ZZb".to_owned(), 400),
        ("/app/lightning/search?q=acinq&q=acinq".to_owned(), 400),
        ("/app/lightning/search?q=acinq&x=1".to_owned(), 400),
        (
            format!("/api/v1/lightning/search?searchText={}", "a".repeat(10_000)),
            400,
        ),
        ("/api/v1/lightning/search".to_owned(), 400),
        ("/api/v1/lightning/channels?status=open".to_owned(), 400),
        (
            format!("/api/v1/lightning/channels?public_key={one}&status=all"),
            400,
        ),
        (
            format!("/api/v1/lightning/channels?public_key={one}&index=100001"),
            400,
        ),
        (
            format!("/app/lightning/nodes/{one}/channels?page=4001"),
            400,
        ),
        (format!("/app/lightning/nodes/{one}/channels?page=01"), 400),
        (format!("/app/lightning/nodes/{one}/channels?sort=fee"), 400),
        (format!("/app/lightning/nodes/{one}/channels?state=on"), 400),
        (
            format!("/app/lightning/nodes/{one}/channels?fee=out:150"),
            400,
        ),
        (format!("/app/lightning/nodes/{one}/channels?q=a%07"), 400),
        (
            format!("/app/lightning/nodes/{one}/channels?sort=age&sort=age"),
            400,
        ),
        (
            format!("/app/lightning/nodes/{one}/channels?status=closed&state=here"),
            400,
        ),
        (
            format!(
                "/app/lightning/nodes/{one}/channels?status=closed&sort=lived&kind=force&q=0303"
            ),
            200,
        ),
        (
            format!(
                "/app/lightning/nodes/{one}/channels?sort=peer&dir=asc&state=inactive&fee=in:none&q=0303"
            ),
            200,
        ),
        // Fee history: a bounded limit, written plainly, once; nothing else.
        (format!("/app/lightning/nodes/{unknown}/fees"), 404),
        ("/app/lightning/channels/1x1x1/fees".to_owned(), 404),
        ("/app/lightning/channels/800000x5/fees".to_owned(), 400),
        (
            "/app/lightning/channels/800000x5x1/fees?x=1".to_owned(),
            400,
        ),
        (format!("/app/lightning/nodes/{}/fees", &one[..64]), 400),
        (format!("/app/lightning/nodes/{one}/fees?limit=0"), 400),
        (format!("/app/lightning/nodes/{one}/fees?limit=51"), 400),
        (format!("/app/lightning/nodes/{one}/fees?limit=01"), 400),
        (format!("/app/lightning/nodes/{one}/fees?limit=-1"), 400),
        (
            format!("/app/lightning/nodes/{one}/fees?limit={}", "9".repeat(30)),
            400,
        ),
        (
            format!("/app/lightning/nodes/{one}/fees?limit=2&limit=2"),
            400,
        ),
        (format!("/app/lightning/nodes/{one}/fees?limit=2&x=1"), 400),
        (format!("/app/lightning/nodes/{one}/fees?limit=50"), 200),
        ("/app/lightning/rankings/liquidity".to_owned(), 400),
        ("/app/lightning/rankings/capacity?limit=101".to_owned(), 400),
        ("/api/v1/lightning/nodes/rankings/capacity".to_owned(), 404),
        ("/app/lightning/overview?x=1".to_owned(), 400),
        ("/app/lightning/feed?x=1".to_owned(), 400),
        ("/app/lightning/feed".to_owned(), 200),
        ("/app/lightning/movers?period=2d".to_owned(), 400),
        ("/app/lightning/movers?period=24h&x=1".to_owned(), 400),
        ("/app/lightning/movers?period=1w&period=1w".to_owned(), 400),
        ("/app/lightning/closes?days=0".to_owned(), 400),
        ("/app/lightning/closes?days=91".to_owned(), 400),
        ("/app/lightning/closes?days=01".to_owned(), 400),
        ("/app/lightning/closes?days=-1".to_owned(), 400),
        // The penalties: a page 0 to 4000, written plainly, once; nothing else.
        ("/app/lightning/penalties?page=4000".to_owned(), 200),
        ("/app/lightning/penalties?page=4001".to_owned(), 400),
        ("/app/lightning/penalties?page=-1".to_owned(), 400),
        ("/app/lightning/penalties?page=01".to_owned(), 400),
        ("/app/lightning/penalties?page=1&page=1".to_owned(), 400),
        ("/app/lightning/penalties?limit=10".to_owned(), 400),
        ("/app/lightning/penalties?page=%FF".to_owned(), 400),
        // The reference's location routes are not served: 404 like any route we do not serve,
        // not a malformed key, while anything else in a key's place is still checked strictly.
        ("/api/v1/lightning/nodes/countries".to_owned(), 404),
        ("/api/v1/lightning/nodes/world".to_owned(), 404),
        ("/api/v1/lightning/nodes/country/us".to_owned(), 404),
        ("/api/v1/lightning/nodes/isp/16509".to_owned(), 404),
        ("/api/v1/lightning/nodes/group/x".to_owned(), 404),
        ("/api/v1/lightning/penalties".to_owned(), 404),
        ("/api/v1/lightning/channels-geo/zz".to_owned(), 400),
        (
            format!("/api/v1/lightning/channels?public_key={one}&status=Active"),
            400,
        ),
        (
            format!("/api/v1/lightning/channels?public_key={one}&index=-2"),
            400,
        ),
        ("/api/v1/lightning/nodes/countrie".to_owned(), 400),
        ("/api/v1/lightning/nodes/world/statistics".to_owned(), 400),
    ] {
        let r = get(&addr, &format!("/regtest{p}")).await;
        assert_eq!(r.status, status, "{p}");
        if p.contains("/nodes/countries") || p.ends_with("/world") {
            assert_eq!(r.json(), serde_json::json!({ "error": "not found" }), "{p}");
        }
        if status != 200 {
            let e = r.json()["error"].as_str().unwrap().to_owned();
            assert!(!e.contains("sqlite") && !e.contains('/'), "{p}: {e}");
        }
    }
    // Markup and quotes in a search come back as JSON text; a cache-buster is ignored on /api/v1.
    let r = get(
        &addr,
        "/regtest/api/v1/lightning/search?searchText=%3Cimg+src&_=1",
    )
    .await;
    assert_eq!(
        r.json()["nodes"][0]["alias"],
        "<img src=x onerror=alert(1)>\"\\\u{fffd}"
    );

    assert_eq!(calls.load(Ordering::SeqCst), 0, "a route called the node");
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(20), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn penalties_are_listed_newest_sweep_first_a_page_at_a_time() {
    use engine::lightning::{GraphNode, Index, Penalty};
    let d = dir("penalties");
    let (addr, calls, _server, _stop, ln) = start(&d.0, true).await;
    let ln = ln.unwrap();
    let store = Store::open(&d.0, "regtest", Options::default()).unwrap();
    let past = lightning::past(&store).await.unwrap();
    let nodes = vec![GraphNode {
        id: [2; 33],
        announcement: None,
    }];
    ln.set_index(Index::build(nodes, Vec::new(), &past));
    let list = |q: &'static str| {
        let addr = addr.clone();
        async move { get(&addr, &format!("/regtest/app/lightning/penalties{q}")).await }
    };
    // None yet: an empty list and its count, not a refusal.
    let none = list("").await;
    assert_eq!(none.status, 200);
    assert_eq!(
        none.json(),
        serde_json::json!({ "page": 0, "per_page": 25, "total": 0, "from": null, "channels": [] })
    );
    // 31 breaches, each swept ten blocks after its close, and a reorg that undoes the newest.
    let mut changes = Vec::new();
    for n in 0..31u32 {
        let c = open(u64::from(n));
        changes.push(Change::Closed(
            c,
            Close {
                block: block(800_500 + n),
                txid: Txid::from_byte_array([9; 32]),
                kind: Kind::Force,
                fee: None,
            },
        ));
        changes.push(Change::Penalty(
            c.scid,
            Penalty {
                block: block(800_510 + n),
                txid: Txid::from_byte_array([u8::try_from(n).unwrap(); 32]),
            },
        ));
    }
    changes.push(Change::PenaltyUndone(open(30).scid));
    lightning::apply(&store, changes).await.unwrap();
    store.close().await;
    let first = list("").await.json();
    assert_eq!(
        (first["total"].as_u64(), first["page"].as_u64()),
        (Some(30), Some(0))
    );
    let rows = first["channels"].as_array().unwrap();
    assert_eq!(rows.len(), 25);
    let row = &rows[0];
    assert_eq!(row["id"], "800029x3x0");
    assert_eq!(row["closed"]["block"]["height"], 800_529);
    assert_eq!(row["penalty"]["block"]["height"], 800_539);
    assert_eq!(
        row["penalty"]["txid"],
        Txid::from_byte_array([29; 32]).to_string()
    );
    // Both ends as `{id, alias}`: a node without an announcement, one the graph does not hold.
    assert_eq!(
        row["node_one"],
        serde_json::json!({ "id": "02".repeat(33), "alias": null })
    );
    assert_eq!(row["node_two"]["alias"], Value::Null);
    let second = list("?page=1").await.json();
    let ids: Vec<&str> = second["channels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        [
            "800004x3x0",
            "800003x3x0",
            "800002x3x0",
            "800001x3x0",
            "800000x3x0"
        ]
    );
    for q in ["?page=2", "?page=4000"] {
        let r = list(q).await;
        assert_eq!(r.status, 200, "{q}");
        assert_eq!(
            (
                r.json()["total"].as_u64(),
                r.json()["channels"].as_array().map(Vec::len)
            ),
            (Some(30), Some(0)),
            "{q}"
        );
    }
    for q in [
        "?page=4001",
        "?page=",
        "?page=1.5",
        "?per_page=50",
        "?page=0&page=0",
    ] {
        let r = list(q).await;
        assert_eq!(r.status, 400, "{q}");
        assert!(r.json()["error"].is_string(), "{q}");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0, "the list called the node");
}

#[tokio::test]
async fn a_graph_of_mainnet_s_size_answers_every_route() {
    mainnet_size_routes().await;
}

/// The time budget, measured where nothing else shares the machine. Run with
/// `cargo test -p rbitcoin-space --test lightning -- --ignored mainnet_s_size_answers_within`.
#[tokio::test]
#[ignore = "a time budget: a busy machine fails it for no fault of the code"]
async fn a_graph_of_mainnet_s_size_answers_within_its_budget() {
    let (built, slowest) = mainnet_size_routes().await;
    // A debug build; release figures are in docs/LIGHTNING.md.
    assert!(built < Duration::from_secs(3), "building took {built:?}");
    assert!(slowest.0 < Duration::from_millis(250), "{slowest:?}");
}

/// Serves a graph of mainnet's size through every Lightning route, checking each answers without
/// calling the node. Returns how long the index took to build and the slowest route.
async fn mainnet_size_routes() -> (Duration, (Duration, String)) {
    use engine::lightning::{Announcement, GraphChannel, GraphNode, Index};
    let d = dir("mainnet-size");
    let id = |n: u32| {
        let mut k = [3; 33];
        k[1..5].copy_from_slice(&n.to_be_bytes());
        k
    };
    // 36,000 channels between 13,600 nodes, 20 hubs of 1,800 (the largest real node's size)
    // holding them all, and every one stored.
    let channels: Vec<GraphChannel> = (0..36_000u32)
        .map(|c| GraphChannel {
            scid: (u64::from(c) + 600_000) << 40,
            nodes: [id(c % 20), id(20 + c % 13_580)],
            capacity: 100_000 + u64::from(c) * 997 % 50_000_000,
            policies: [
                Some(graph::policy(c % 3_000, true)),
                Some(graph::policy(1, c % 7 != 0)),
            ],
        })
        .collect();
    let nodes: Vec<GraphNode> = (0..13_600u32)
        .map(|n| GraphNode {
            id: id(n),
            announcement: Some(Announcement {
                alias: format!("node-{n}"),
                color: [1, 2, 3],
                addresses: vec![format!("10.0.{}.{}:9735", n / 256, n % 256)],
                features: vec![0x81, 0x20],
                last_update: 1_790_000_000,
            }),
        })
        .collect();
    {
        let store = Store::open(&d.0, "regtest", Options::default()).unwrap();
        let opens = channels
            .iter()
            .map(|c| {
                Change::Opened(Open {
                    scid: c.scid,
                    node_one: c.nodes[0],
                    node_two: c.nodes[1],
                    capacity: c.capacity,
                    block: block(u32::try_from(c.scid >> 40).unwrap()),
                })
            })
            .collect();
        lightning::apply(&store, opens).await.unwrap();
        store.close().await;
    }
    let (addr, calls, _server, _stop, ln) = start(&d.0, true).await;
    let started = std::time::Instant::now();
    let store = Store::open(&d.0, "regtest", Options::default()).unwrap();
    let past = lightning::past(&store).await.unwrap();
    ln.unwrap().set_index(Index::build(nodes, channels, &past));
    let built = started.elapsed();
    let hub = graph::hex(&id(0));
    let mut slowest = (Duration::ZERO, String::new());
    for p in [
        "/app/lightning/overview".to_owned(),
        "/app/lightning/search?q=node-1".to_owned(),
        "/app/lightning/search?q=030000".to_owned(),
        "/app/lightning/rankings/age?limit=100".to_owned(),
        // Every channel here was funded in one block: the most a block's route can read.
        format!("/app/lightning/block/{}", block(0).hash),
        format!("/app/lightning/nodes/{hub}"),
        format!("/app/lightning/nodes/{hub}/channels?status=open&page=28"),
        format!("/app/lightning/nodes/{hub}/channels?sort=age&page=28"),
        format!("/app/lightning/nodes/{hub}/channels?sort=peer&dir=asc&q=node-1"),
        format!("/app/lightning/nodes/{hub}/channels?status=closed&sort=lived"),
        format!("/app/lightning/nodes/{hub}/history"),
        format!("/app/lightning/channels/{}", 600_000u64 << 40),
        format!("/api/v1/lightning/nodes/{hub}"),
        format!("/api/v1/lightning/nodes/{hub}/statistics"),
        format!("/api/v1/lightning/nodes/{hub}/fees/histogram"),
        format!("/api/v1/lightning/channels?public_key={hub}&status=open&index=700"),
        "/api/v1/lightning/nodes/rankings/connectivity".to_owned(),
        "/api/v1/lightning/search?searchText=node".to_owned(),
        "/app/lightning/penalties".to_owned(),
    ] {
        let t = std::time::Instant::now();
        let r = get(&addr, &format!("/regtest{p}")).await;
        let took = t.elapsed();
        assert_eq!(r.status, 200, "{p}");
        if took > slowest.0 {
            slowest = (took, p);
        }
    }
    // A hub's every active channel at once: the largest 1,000, X-Total-Count all 1,800.
    let p = format!("/api/v1/lightning/channels?public_key={hub}&status=active&index=-1");
    let t = std::time::Instant::now();
    let r = get(&addr, &format!("/regtest{p}")).await;
    let took = t.elapsed();
    if took > slowest.0 {
        slowest = (took, p);
    }
    assert_eq!(r.header("x-total-count"), Some("1800"));
    let all = r.json();
    let caps: Vec<u64> = all
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["capacity"].as_u64().unwrap())
        .collect();
    assert_eq!(caps.len(), 1_000);
    assert!(caps.is_sorted_by(|a, b| a >= b));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    (built, slowest)
}

/// A block's channels: what it opened and closed, each kind of close, a breach, two blocks that
/// left the chain, the cap on rows with the counts over all of them, and refused hashes.
#[tokio::test]
async fn a_block_s_channels_are_found_by_its_hash_and_capped() {
    use engine::lightning::{Announcement, GraphChannel, GraphNode, Index, Penalty};
    let d = dir("block");
    let hash = |n: u8| BlockHash::from_byte_array([n; 32]);
    let at = |height: u32, n: u8| Block {
        height,
        hash: hash(n),
        time: 1_790_000_000,
    };
    let chan = |h: u64, i: u64, a: u8, b: u8, capacity: u64, n: u8| Open {
        scid: graph::scid(h, i, 0),
        node_one: graph::key(a),
        node_two: graph::key(b),
        capacity,
        block: at(u32::try_from(h).unwrap(), n),
    };
    let close = |n: u8, tx: u8, kind| Close {
        block: at(900_010, n),
        txid: graph::txid(tx),
        kind,
        fee: None,
    };
    // Block 0xa1 opened three; block 0xc1 closed four, one of them later found a breach; block
    // 0xee closed one and block 0xef opened one, and both left the chain; block 0xb1 opened 105.
    let (big, small, mid) = (
        chan(900_000, 1, 1, 2, 5_000_000, 0xa1),
        chan(900_000, 2, 2, 3, 1_000_000, 0xa1),
        chan(900_000, 3, 1, 3, 2_000_000, 0xa1),
    );
    let old = |i, capacity| chan(899_000, i, 3, 4, capacity, 0x11);
    let mut changes = vec![
        Change::Opened(big),
        Change::Opened(small),
        Change::Opened(mid),
        Change::Closed(old(1, 100_000), close(0xc1, 1, Kind::Cooperative)),
        Change::Closed(old(2, 400_000), close(0xc1, 2, Kind::Force)),
        Change::Closed(old(3, 300_000), close(0xc1, 3, Kind::Force)),
        Change::Penalty(
            graph::scid(899_000, 3, 0),
            Penalty {
                block: at(900_011, 0xd1),
                txid: graph::txid(4),
            },
        ),
        Change::Closed(old(4, 200_000), close(0xc1, 5, Kind::Other)),
        Change::Closed(old(5, 600_000), close(0xee, 6, Kind::Cooperative)),
        Change::CloseUndone(graph::scid(899_000, 5, 0)),
        Change::Opened(chan(900_020, 1, 1, 2, 700_000, 0xef)),
        Change::OpenUndone(graph::scid(900_020, 1, 0)),
    ];
    changes.extend((0..105).map(|i| Change::Opened(chan(900_005, i, 1, 2, 1_000 + i, 0xb1))));
    {
        let store = Store::open(&d.0, "regtest", Options::default()).unwrap();
        lightning::apply(&store, changes).await.unwrap();
        store.close().await;
    }
    let (addr, calls, _server, _stop, ln) = start(&d.0, true).await;
    let path = |n: u8| format!("/regtest/app/lightning/block/{}", hash(n));

    // Before the graph is indexed: retry, as every route here.
    let r = get(&addr, &path(0xa1)).await;
    assert_eq!((r.status, r.header("retry-after")), (503, Some("1")));

    let alias = |n: u8, a: &str| GraphNode {
        id: graph::key(n),
        announcement: Some(Announcement {
            alias: a.to_owned(),
            color: [1, 2, 3],
            addresses: vec![],
            features: vec![],
            last_update: 1_790_000_000,
        }),
    };
    let graph_channel = GraphChannel {
        scid: big.scid,
        nodes: [graph::key(1), graph::key(2)],
        capacity: big.capacity,
        policies: [None, None],
    };
    {
        let store = Store::open(&d.0, "regtest", Options::default()).unwrap();
        let past = lightning::past(&store).await.unwrap();
        let nodes = vec![alias(1, "ACINQ"), alias(2, "<b>\u{202e}x</b>")];
        ln.unwrap()
            .set_index(Index::build(nodes, vec![graph_channel], &past));
    }

    let r = get(&addr, &path(0xa1)).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("cache-control"), Some("public, max-age=10"));
    let one = graph::hex(&graph::key(1));
    let two = graph::hex(&graph::key(2));
    let three = graph::hex(&graph::key(3));
    assert_eq!(
        r.json(),
        serde_json::json!({
            "opened": {"count": 3, "capacity": 8_000_000, "channels": [
                {"id": "900000x1x0", "scid": big.scid.to_string(), "capacity": 5_000_000,
                 "node_one": {"id": one, "alias": "ACINQ"}, "node_two": {"id": two, "alias": "<b>\u{202e}x</b>"}},
                {"id": "900000x3x0", "scid": mid.scid.to_string(), "capacity": 2_000_000,
                 "node_one": {"id": one, "alias": "ACINQ"}, "node_two": {"id": three, "alias": null}},
                {"id": "900000x2x0", "scid": small.scid.to_string(), "capacity": 1_000_000,
                 "node_one": {"id": two, "alias": "<b>\u{202e}x</b>"}, "node_two": {"id": three, "alias": null}},
            ]},
            "closed": {"count": 0, "forced": 0, "channels": []},
        })
    );

    // Each kind, largest first; the breach is a penalty and counts as forced.
    let v = get(&addr, &path(0xc1)).await.json();
    let kinds: Vec<(&str, u64)> = v["closed"]["channels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["kind"].as_str().unwrap(), c["capacity"].as_u64().unwrap()))
        .collect();
    assert_eq!(
        kinds,
        [
            ("force", 400_000),
            ("penalty", 300_000),
            ("other", 200_000),
            ("cooperative", 100_000)
        ]
    );
    assert_eq!(
        (&v["closed"]["count"], &v["closed"]["forced"]),
        (&4.into(), &2.into())
    );
    assert_eq!(v["opened"]["count"], 0);

    // 105 opened, 100 sent, the largest; the counts are over all of them.
    let v = get(&addr, &path(0xb1)).await.json();
    let sent = v["opened"]["channels"].as_array().unwrap();
    assert_eq!(sent.len(), 100);
    assert_eq!(sent[0]["capacity"], 1_104);
    assert_eq!(sent[99]["capacity"], 1_005);
    assert_eq!(v["opened"]["count"], 105);
    assert_eq!(
        v["opened"]["capacity"],
        (0..105).map(|i| 1_000 + i).sum::<u64>()
    );

    // Blocks that left the chain, the sweep's block, and a block we never saw: nothing, cacheable.
    let empty = serde_json::json!({
        "opened": {"count": 0, "capacity": 0, "channels": []},
        "closed": {"count": 0, "forced": 0, "channels": []},
    });
    for n in [0xee, 0xef, 0xd1, 0x42] {
        let r = get(&addr, &path(n)).await;
        assert_eq!((r.status, r.json()), (200, empty.clone()), "{n:x}");
    }

    for bad in ["abc", &"g".repeat(64), &"0".repeat(65), "%00"] {
        let r = get(&addr, &format!("/regtest/app/lightning/block/{bad}")).await;
        assert_eq!(r.status, 400, "{bad}");
        assert_eq!(r.json()["error"], "invalid block hash");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

/// A node's close record: its stored closes by kind, by peer and with their fees, for a node in
/// the graph and for one that has left it; no node call, strict about the key.
#[tokio::test]
async fn a_node_s_close_record_comes_from_its_stored_closes() {
    let d = dir("record");
    let (nodes, channels) = graph::fill(&d.0).await;
    // Node 5 left the graph: its only channel, with node 1, was force closed.
    {
        let store = Store::open(&d.0, "regtest", Options::default()).unwrap();
        lightning::apply(
            &store,
            vec![Change::Closed(
                graph::sopen(graph::scid(799_700, 4, 0), 5, 1, 600_000, 0),
                Close {
                    block: graph::at(800_303, 4),
                    txid: graph::txid(0x66),
                    kind: Kind::Force,
                    fee: Some(2_500),
                },
            )],
        )
        .await
        .unwrap();
        store.close().await;
    }
    let (addr, calls, _server, _stop, ln) = start(&d.0, true).await;
    let ln = ln.unwrap();
    // The overview waits for an index, and setting one is what wakes it, not its retry five
    // seconds on: observed through its counters, not a clock.
    let waits = || async {
        for _ in 0..1_000 {
            if ln.overview_wakes().0 > 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the overview never waited for an index");
    };
    waits().await;
    let (_, woken) = ln.overview_wakes();
    graph::install(&d.0, &ln, nodes, channels).await;
    for _ in 0..1_000 {
        if ln.overview_wakes().1 > woken {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        ln.overview_wakes().1,
        woken + 1,
        "setting the index did not wake the overview"
    );
    let record = |n: u8| {
        let addr = addr.clone();
        async move {
            let key = graph::hex(&graph::key(n));
            get(&addr, &format!("/regtest/app/lightning/nodes/{key}/closes")).await
        }
    };

    let one = record(1).await;
    assert_eq!(one.status, 200);
    assert_eq!(one.header("cache-control"), Some("public, max-age=10"));
    let v = one.json();
    // The history starts a day after T; every close is later.
    assert_eq!(v["from"], graph::T + graph::DAY);
    assert_eq!(v["minimum"], 20);
    // Every close read: fewer than the cap.
    assert_eq!(
        (v["cap"].as_u64(), v["capped"].as_bool()),
        (Some(10_000), Some(false))
    );
    let n = &v["node"];
    assert_eq!(
        [
            &n["closed"],
            &n["cooperative"],
            &n["force"],
            &n["penalty"],
            &n["other"]
        ],
        [3, 0, 1, 1, 1].map(Value::from).each_ref()
    );
    // Three closes are not a rate.
    assert_eq!(n["shares"], Value::Null);
    assert_eq!(
        n["fees"],
        serde_json::json!({
            "cooperative": { "sum": 0, "known": 0 },
            "force": { "sum": 2_500, "known": 1 },
            "penalty": { "sum": 0, "known": 0 },
            "other": { "sum": 1_000, "known": 1 },
        })
    );
    let weeks = n["weeks"].as_array().unwrap();
    let summed: u64 = weeks
        .iter()
        .map(|w| {
            ["cooperative", "force", "penalty", "other"]
                .iter()
                .map(|k| w[k].as_u64().unwrap())
                .sum::<u64>()
        })
        .sum();
    assert_eq!(summed, 3, "each close in one week");
    assert!(weeks.windows(2).all(|w| w[1]["time"].as_u64().unwrap()
        - w[0]["time"].as_u64().unwrap()
        == 7 * graph::DAY));
    // Its peers with a commitment close: 3 (a breach, one channel still open with it) and 5,
    // gone from the graph (no alias, nothing open); 2 had only a close by neither protocol.
    let p = &v["peers"];
    assert_eq!(
        (
            p["count"].as_u64(),
            p["forced"].as_u64(),
            p["more"].as_u64()
        ),
        (Some(3), Some(2), Some(0))
    );
    let list = p["list"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    let three = list
        .iter()
        .find(|r| r["id"] == graph::hex(&graph::key(3)))
        .unwrap();
    assert_eq!(
        (
            three["penalty"].as_u64(),
            three["closed"].as_u64(),
            three["open"].as_u64()
        ),
        (Some(1), Some(1), Some(1))
    );
    assert_eq!(
        (&three["alias"], &three["shares"]),
        (&Value::Null, &Value::Null)
    );
    let five = list
        .iter()
        .find(|r| r["id"] == graph::hex(&graph::key(5)))
        .unwrap();
    assert_eq!(
        (five["force"].as_u64(), five["open"].as_u64()),
        (Some(1), Some(0))
    );
    // Whether each other end is in the graph, for a page to link it or not.
    assert_eq!(
        (three["held"].as_bool(), five["held"].as_bool()),
        (Some(true), Some(false))
    );

    // Node 5 is not in the graph, but its close is stored: its record still answers.
    let gone = record(5).await;
    assert_eq!(gone.status, 200);
    let g = gone.json();
    assert_eq!(
        (g["node"]["closed"].as_u64(), g["node"]["force"].as_u64()),
        (Some(1), Some(1))
    );
    assert_eq!(g["peers"]["list"][0]["id"], graph::hex(&graph::key(1)));
    assert_eq!(g["peers"]["list"][0]["alias"], "ACINQ");
    // Its closed list answers too, from the store, so its page can list the close; a key with
    // no close stored and not in the graph is still no node, and its open list is none either.
    let list = |k: u8, status: &'static str| {
        let addr = addr.clone();
        async move {
            get(
                &addr,
                &format!(
                    "/regtest/app/lightning/nodes/{}/channels?status={status}",
                    graph::hex(&graph::key(k))
                ),
            )
            .await
        }
    };
    let closed = list(5, "closed").await;
    assert_eq!(closed.status, 200);
    let c = closed.json();
    assert_eq!(c["total"].as_u64(), Some(1));
    assert_eq!(c["channels"][0]["peer"]["id"], graph::hex(&graph::key(1)));
    assert_eq!(list(5, "open").await.status, 404);
    assert_eq!(list(9, "closed").await.status, 404);
    // Node 4 is in the graph with no close: an empty record, not a refusal.
    let none = record(4).await.json();
    assert_eq!(
        (
            none["node"]["closed"].as_u64(),
            none["peers"]["count"].as_u64()
        ),
        (Some(0), Some(0))
    );
    // The network's figures come with the overview's computation, each channel once.
    for _ in 0..1_000 {
        if !record(1).await.json()["network"].is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let net = record(1).await.json()["network"].clone();
    assert_eq!(
        [
            &net["closed"],
            &net["cooperative"],
            &net["force"],
            &net["penalty"],
            &net["other"]
        ],
        [4, 1, 1, 1, 1].map(Value::from).each_ref(),
        "{net}"
    );
    assert_eq!(
        net["fees"]["cooperative"],
        serde_json::json!({ "sum": 300, "known": 1 })
    );

    // A node never seen, a malformed key, and the route takes no parameters that change it.
    let unknown = record(9).await;
    assert_eq!(
        (unknown.status, unknown.json()["error"].as_str()),
        (404, Some("node not found"))
    );
    let bad = get(&addr, "/regtest/app/lightning/nodes/03zz/closes").await;
    assert_eq!(bad.status, 400);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "the record called the node"
    );
}
