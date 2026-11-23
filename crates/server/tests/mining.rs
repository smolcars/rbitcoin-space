//! The mining routes end to end: the server on port 0 over a block table filled here, with a
//! mock RPC that counts calls and an Esplora and Electrum that do not answer. Nothing here
//! reaches a real node.

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
use std::time::{Duration, Instant, SystemTime};

use axum::routing::any;
use engine::store::{Options, Store, params};
use rbitcoin_space::{App, Config};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const V1: &str = "/regtest/api/v1/mining";
const TIP: u32 = 3023;
/// Heights from here up have fee rates.
const RATED: u32 = 2900;
const TAGS: [&[u8]; 3] = [b"\x03abFoundry USA Pool #x/", b"/AntPool/", b"\x00\xff"];

fn now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn dir(name: &str) -> Dir {
    let d = std::env::temp_dir().join(format!(
        "rbitcoin-space-mining-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    Dir(d)
}

/// Rows for `heights`, a block every 600 s up to one at `TIP` stamped a minute ago, mined in
/// turn by Foundry USA, AntPool and nobody known; difficulty 1 then 2 after the retarget at 2016.
/// Written without a pool: the server's first pass attributes them.
async fn fill(dir: &Path, heights: impl Iterator<Item = u32>) {
    fill_to(dir, heights, now() - 60).await;
}

/// [`fill`] with the block at `TIP` stamped `tip_time`.
async fn fill_to(dir: &Path, heights: impl Iterator<Item = u32>, tip_time: u64) {
    let base = tip_time - u64::from(TIP) * 600;
    fill_at(dir, heights, move |h| base + u64::from(h) * 600).await;
}

/// [`fill`] with each height stamped `time(height)`.
async fn fill_at(
    dir: &Path,
    heights: impl Iterator<Item = u32>,
    time: impl Fn(u32) -> u64 + Send + 'static,
) {
    let rows: Vec<u32> = heights.collect();
    let store = Store::open(dir, "regtest", Options::default()).unwrap();
    store
        .write(move |sql| {
            let mut stmt = sql.prepare(
                "INSERT INTO blocks (height, hash, time, tx_count, size, weight, paying_weight, \
                 fees, subsidy, reward, difficulty, coinbase_tag, payouts, rated, fee_min, \
                 fee_p10, fee_p25, fee_median, fee_p75, fee_p90, fee_max, band0, band1, band2, \
                 band3, band4, band5, band6, band7, band8, band9) VALUES (?1, ?2, ?3, ?4, ?5, ?6, \
                 3000, ?7, 5000000000, ?8, ?9, ?10, x'', ?11, ?12, ?12, ?12, ?12, ?12, ?12, ?12, \
                 ?13, ?13, ?13, ?13, ?13, ?13, ?13, ?13, ?13, ?13)",
            )?;
            for h in rows {
                let mut hash = [0u8; 32];
                hash[..4].copy_from_slice(&h.to_le_bytes());
                let rated = h >= RATED;
                stmt.execute(params![
                    h,
                    &hash[..],
                    time(h) as i64,
                    1 + h % 3,
                    1000 + h,
                    4000 + h,
                    100 * h,
                    5_000_000_000i64 + 100 * i64::from(h),
                    f64::from(1 + h / 2016),
                    TAGS[h as usize % 3],
                    rated,
                    rated.then_some(f64::from(h % 7) + 0.25),
                    rated.then_some(75),
                ])?;
            }
            Ok(())
        })
        .await
        .unwrap();
    store.close().await;
}

/// The block hash `fill` writes at `height`.
fn block_hash(height: u32) -> [u8; 32] {
    let mut hash = [0u8; 32];
    hash[..4].copy_from_slice(&height.to_le_bytes());
    hash
}

/// Audits of `(height, hash, match rate)`, every other figure zero.
async fn audit(dir: &Path, rows: Vec<(u32, [u8; 32], f64)>) {
    let store = Store::open(dir, "regtest", Options::default()).unwrap();
    store
        .write(move |sql| {
            let mut stmt = sql.prepare(
                "INSERT INTO audits VALUES (?1, ?2, 0, 0, ?3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, \
                 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, x'')",
            )?;
            for (height, hash, rate) in rows {
                stmt.execute(params![&hash[..], height, rate])?;
            }
            Ok(())
        })
        .await
        .unwrap();
    store.close().await;
}

/// The server over `dir`, and the count of RPC calls it makes.
async fn start(dir: &Path) -> (String, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let rpc = axum::Router::new().fallback(any(move |body: String| {
        // The readiness check calls `getblockchaininfo` on its own schedule, whatever the
        // requests; count only what the routes might cause.
        if !body.contains("getblockchaininfo") {
            counter.fetch_add(1, Ordering::SeqCst);
        }
        async { "{}" }
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rpc_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, rpc).await });
    let vars: HashMap<&str, String> = [
        ("REGTEST_RPC_HOST", "127.0.0.1".to_owned()),
        ("REGTEST_RPC_PORT", rpc_port.to_string()),
        ("REGTEST_RPC_USER", "u".to_owned()),
        ("REGTEST_RPC_PASSWORD", "p".to_owned()),
        ("REGTEST_ESPLORA_URL", "http://127.0.0.1:1".to_owned()),
        ("REGTEST_ELECTRUM_ADDR", "127.0.0.1:1".to_owned()),
        ("DATA_DIR", dir.display().to_string()),
        ("BACKFILL_ENABLED", "false".to_owned()),
        // The mempool tracker polls the node; these routes must not, so count them alone.
        ("REGTEST_MEMPOOL_ENABLED", "false".to_owned()),
    ]
    .into_iter()
    .collect();
    let mut config = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
    config.limits.client_rate_per_sec = 10_000;
    config.limits.client_burst = 10_000;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let app = App::new(&config);
    // The mock answers `{}` to everything, so nothing confirms the chain: open the gate.
    if let Some(n) = app.network(rbitcoin_space::Network::Regtest)
        && let Some(t) = &n.blocks
    {
        t.store.set_gate(engine::store::Gate::Open);
    }
    tokio::spawn(app.serve(listener, std::future::pending()));
    // Ready once the first pass has attributed the rows.
    let started = Instant::now();
    while get(&addr, &format!("{V1}/pools/all")).await.status != 200 {
        assert!(started.elapsed() < Duration::from_secs(10), "never ready");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    (addr, calls)
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

    fn coverage(&self) -> (Option<u32>, Option<&str>) {
        (
            self.header("x-data-from-height")
                .map(|h| h.parse().unwrap()),
            self.header("x-data-complete"),
        )
    }
}

async fn request(addr: &str, method: &str, target: &str) -> Reply {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req = format!("{method} {target} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n");
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

async fn get(addr: &str, target: &str) -> Reply {
    request(addr, "GET", target).await
}

/// JSON with object keys in the order they were sent (`Value` sorts them).
enum Ordered {
    Object(Vec<(String, Ordered)>),
    Array(Vec<Ordered>),
    Other,
}

impl<'de> serde::Deserialize<'de> for Ordered {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Ordered;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut m: A,
            ) -> Result<Ordered, A::Error> {
                let mut out = Vec::new();
                while let Some(e) = m.next_entry()? {
                    out.push(e);
                }
                Ok(Ordered::Object(out))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut s: A,
            ) -> Result<Ordered, A::Error> {
                let mut out = Vec::new();
                while let Some(e) = s.next_element()? {
                    out.push(e);
                }
                Ok(Ordered::Array(out))
            }
            fn visit_bool<E>(self, _: bool) -> Result<Ordered, E> {
                Ok(Ordered::Other)
            }
            fn visit_i64<E>(self, _: i64) -> Result<Ordered, E> {
                Ok(Ordered::Other)
            }
            fn visit_u64<E>(self, _: u64) -> Result<Ordered, E> {
                Ok(Ordered::Other)
            }
            fn visit_u128<E>(self, _: u128) -> Result<Ordered, E> {
                Ok(Ordered::Other)
            }
            fn visit_f64<E>(self, _: f64) -> Result<Ordered, E> {
                Ok(Ordered::Other)
            }
            fn visit_str<E>(self, _: &str) -> Result<Ordered, E> {
                Ok(Ordered::Other)
            }
            fn visit_unit<E>(self) -> Result<Ordered, E> {
                Ok(Ordered::Other)
            }
            fn visit_none<E>(self) -> Result<Ordered, E> {
                Ok(Ordered::Other)
            }
        }
        d.deserialize_any(V)
    }
}

/// The keys of the object at `path` (keys, or array indexes as digits) in the body, in order.
fn keys(r: &Reply, path: &[&str]) -> Vec<String> {
    let mut v: Ordered = serde_json::from_slice(&r.body).unwrap();
    for p in path {
        v = match v {
            Ordered::Object(o) => o.into_iter().find(|(k, _)| k == p).unwrap().1,
            Ordered::Array(a) => a.into_iter().nth(p.parse().unwrap()).unwrap(),
            Ordered::Other => panic!("no {p}"),
        };
    }
    match v {
        Ordered::Object(o) => o.into_iter().map(|(k, _)| k).collect(),
        _ => panic!("not an object"),
    }
}

#[tokio::test]
async fn routes_answer_from_the_table_in_the_reference_shapes() {
    let d = dir("full");
    fill(&d.0, 0..=TIP).await;
    // Foundry USA mines the heights divisible by 3: two of its blocks audited, one in the last
    // day; AntPool's none. The audit at 3018 is of a block that left the best chain.
    let mut reorged = block_hash(3018);
    reorged[31] = 1;
    audit(
        &d.0,
        vec![
            (TIP - 2, block_hash(TIP - 2), 99.0),
            (1500, block_hash(1500), 97.5),
            (3018, reorged, 10.0),
        ],
    )
    .await;
    let (addr, calls) = start(&d.0).await;
    let get = |p: &str| {
        let target = format!("{V1}{p}");
        let addr = addr.clone();
        async move { get(&addr, &target).await }
    };

    let r = get("/pools").await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.json()[0],
        serde_json::json!({"name": "Unknown", "slug": "unknown", "unique_id": 0})
    );
    assert!(r.json().as_array().unwrap().len() > 100);

    let r = get("/pools/all").await;
    let v = r.json();
    assert_eq!(
        keys(&r, &[]),
        [
            "pools",
            "blockCount",
            "lastEstimatedHashrate",
            "lastEstimatedHashrate3d",
            "lastEstimatedHashrate1w"
        ]
    );
    assert_eq!(
        keys(&r, &["pools", "0"]),
        [
            "poolId",
            "name",
            "link",
            "blockCount",
            "rank",
            "emptyBlocks",
            "slug",
            "avgMatchRate",
            "avgFeeDelta",
            "poolUniqueId"
        ]
    );
    assert_eq!(v["blockCount"], 3024);
    let ranked: Vec<_> = v["pools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["slug"].as_str().unwrap(),
                p["blockCount"].as_u64().unwrap(),
                p["rank"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        ranked,
        [
            ("unknown", 1008, 1),
            ("antpool", 1008, 2),
            ("foundryusa", 1008, 3)
        ]
    );
    assert_eq!(
        v["pools"][2]["emptyBlocks"], 1008,
        "heights 3k + 0 hold only the coinbase"
    );
    // The mean over the period's audited best-chain blocks; `null` for a pool with none.
    let rates: Vec<_> = v["pools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["avgMatchRate"].clone())
        .collect();
    assert_eq!(rates, [Value::Null, Value::Null, serde_json::json!(98.25)]);
    // Difficulty 2 at a block every 600 s: 2 × 2^32 / 600.
    let h = v["lastEstimatedHashrate"].as_f64().unwrap();
    assert!(
        (h / (2.0 * 4_294_967_296.0 / 600.0) - 1.0).abs() < 1e-6,
        "{h}"
    );
    assert_eq!(r.coverage(), (Some(0), Some("true")));
    assert_eq!(r.header("x-bitcoin-chain-tip-height"), Some("3023"));
    assert_eq!(r.header("cache-control"), Some("public, max-age=1"));
    assert!(
        r.header("age").is_some(),
        "no Electrum: the tip cannot be confirmed"
    );

    let r = get("/pools/24h").await;
    assert_eq!(r.json()["blockCount"], 144);
    let foundry = r.json()["pools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["slug"] == "foundryusa")
        .cloned()
        .unwrap();
    assert_eq!(foundry["avgMatchRate"], 99.0);
    assert_eq!(r.coverage(), (Some(TIP - 143), Some("true")));

    let r = get("/pool/foundryusa").await;
    let v = r.json();
    assert_eq!(
        keys(&r, &[]),
        [
            "pool",
            "blockCount",
            "blockShare",
            "estimatedHashrate",
            "reportedHashrate",
            "avgBlockHealth",
            "totalReward"
        ]
    );
    assert_eq!(
        keys(&r, &["pool"]),
        [
            "id",
            "name",
            "link",
            "addresses",
            "regexes",
            "slug",
            "unique_id"
        ]
    );
    assert_eq!(
        v["blockCount"],
        serde_json::json!({"all": 1008, "24h": 48, "1w": 336})
    );
    assert!((v["blockShare"]["all"].as_f64().unwrap() - 1.0 / 3.0).abs() < 1e-12);
    assert!(v["totalReward"].is_string());
    assert_eq!(v["avgBlockHealth"], 98.25);
    assert_eq!(
        get("/pool/antpool").await.json()["avgBlockHealth"],
        Value::Null
    );

    let r = get("/pool/foundryusa/hashrate").await;
    let weeks = r.json();
    assert!(!weeks.as_array().unwrap().is_empty());
    assert_eq!(
        keys(&r, &["0"]),
        ["timestamp", "avgHashrate", "share", "poolName"]
    );
    assert_eq!(weeks[0]["poolName"], "Foundry USA");

    let r = get("/pool/foundryusa/blocks").await;
    let page = r.json();
    let heights: Vec<u64> = page
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["height"].as_u64().unwrap())
        .collect();
    assert_eq!(heights.len(), 100);
    assert_eq!(heights[0], 3021);
    assert!(heights.windows(2).all(|w| w[0] - w[1] == 3));
    assert_eq!(page[0]["extras"]["pool"]["slug"], "foundryusa");
    assert_eq!(page[0]["extras"]["coinbaseRaw"], hex(TAGS[0]));
    assert_eq!(page[0]["extras"]["feeRange"].as_array().unwrap().len(), 7);
    let last = heights[99];
    let next = get(&format!("/pool/foundryusa/blocks/{last}")).await.json();
    assert_eq!(next[0]["height"], last - 3, "strictly below");

    let r = get("/hashrate/1m").await;
    let v = r.json();
    assert_eq!(
        keys(&r, &[]),
        [
            "hashrates",
            "difficulty",
            "currentHashrate",
            "currentDifficulty"
        ]
    );
    assert_eq!(keys(&r, &["hashrates", "0"]), ["timestamp", "avgHashrate"]);
    assert_eq!(v["difficulty"][0]["height"], 2016);
    assert_eq!(v["difficulty"][0]["adjustment"], 2.0);
    assert_eq!(v["currentDifficulty"], 2.0);
    // Days are points; the first full 7-day window ends 7 days after the first block.
    assert!(v["hashrates"].as_array().unwrap().len() >= 13);

    let r = get("/difficulty-adjustments").await;
    let a = r.json();
    assert_eq!(a.as_array().unwrap().len(), 1);
    assert_eq!(a[0][1], 2016);
    assert_eq!(a[0][3], 2.0);

    let r = get("/hashrate/pools/1m").await;
    assert_eq!(
        keys(&r, &["0"]),
        ["timestamp", "avgHashrate", "share", "poolName"]
    );

    let r = get("/reward-stats/144").await;
    let v = r.json();
    assert_eq!(
        keys(&r, &[]),
        [
            "startBlock",
            "endBlock",
            "totalReward",
            "totalFee",
            "totalTx"
        ]
    );
    assert_eq!(
        (v["startBlock"].as_u64(), v["endBlock"].as_u64()),
        (Some(2880), Some(3023))
    );
    let fees: u64 = (2880..=3023u64).map(|h| 100 * h).sum();
    assert_eq!(v["totalFee"], fees.to_string());
    assert_eq!(r.coverage(), (Some(2880), Some("true")));

    for (route, key) in [("fees", "avgFees"), ("rewards", "avgRewards")] {
        let r = get(&format!("/blocks/{route}/1w")).await;
        let v = r.json();
        assert_eq!(keys(&r, &["0"]), ["avgHeight", "timestamp", key]);
        assert_eq!(v.as_array().unwrap().len(), 1008);
    }
    let v = get("/blocks/fees/1m").await.json();
    // Six blocks a point: heights 3018..=3023 average to 3020 and fees 302,050.
    let last = v.as_array().unwrap().last().unwrap();
    assert_eq!(
        (last["avgHeight"].as_u64(), last["avgFees"].as_u64()),
        (Some(3020), Some(302_050))
    );
    let r = get("/blocks/sizes-weights/1w").await;
    assert_eq!(keys(&r, &[]), ["sizes", "weights"]);
    assert_eq!(
        keys(&r, &["sizes", "0"]),
        ["avgHeight", "timestamp", "avgSize"]
    );

    // Fee rates only where every block in a point is rated, and the gap is said.
    let r = get("/blocks/fee-rates/1w").await;
    let v = r.json();
    assert_eq!(
        keys(&r, &["0"]),
        [
            "avgHeight",
            "timestamp",
            "avgFee_0",
            "avgFee_10",
            "avgFee_25",
            "avgFee_50",
            "avgFee_75",
            "avgFee_90",
            "avgFee_100"
        ]
    );
    assert_eq!(v[0]["avgHeight"], RATED);
    assert_eq!(v.as_array().unwrap().len() as u32, TIP - RATED + 1);
    assert_eq!(r.coverage(), (Some(RATED), Some("false")));
    let precise = get("/blocks/fee-rates/1w/precise").await.json();
    assert_eq!(precise[0]["avgFee_50"], f64::from(RATED % 7) + 0.25);
    assert!(v[0]["avgFee_50"].is_u64());
    // A month in 6-block points: the point holding 2898..=2903 is part rated, so left out.
    let v = get("/blocks/fee-rates/1m/precise").await.json();
    assert_eq!(v[0]["avgHeight"], 2906);

    let r = get(&format!("/blocks/timestamp/{}", now())).await;
    assert_eq!(r.json()["height"], TIP);
    assert!(r.json()["timestamp"].as_str().unwrap().ends_with(".000Z"));
    assert_eq!(get("/blocks/timestamp/1000").await.status, 404);

    assert_eq!(calls.load(Ordering::SeqCst), 0, "no node call");
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test]
async fn coverage_is_reported_on_a_half_filled_table() {
    let d = dir("half");
    // A few old rows, then a gap the backfill has not filled, then the newest 1,024.
    fill(&d.0, (0..100).chain(2000..=TIP)).await;
    let (addr, _) = start(&d.0).await;

    let r = get(&addr, &format!("{V1}/pools/all")).await;
    assert_eq!(
        r.json()["blockCount"],
        1024,
        "rows below the gap are left out"
    );
    assert_eq!(r.coverage(), (Some(2000), Some("false")));
    let from_time: u64 = r.header("x-data-from-time").unwrap().parse().unwrap();
    let want = now() - 60 - u64::from(TIP - 2000) * 600;
    assert!(from_time.abs_diff(want) < 5, "{from_time} {want}");
    // A day is inside the stored history.
    assert_eq!(
        get(&addr, &format!("{V1}/pools/24h")).await.coverage(),
        (Some(TIP - 143), Some("true"))
    );
    // A month reaches past the history's start: not complete, though every stored row is in.
    let r = get(&addr, &format!("{V1}/pools/1m")).await;
    assert_eq!(r.json()["blockCount"], 1024);
    assert_eq!(r.coverage(), (Some(2000), Some("false")));
    // The retarget at 2016 would be measured against height 0, below the gap: left out.
    let r = get(&addr, &format!("{V1}/difficulty-adjustments")).await;
    assert_eq!(r.json(), serde_json::json!([]));
    let r = get(&addr, &format!("{V1}/reward-stats/2000")).await;
    assert_eq!(r.json()["startBlock"], 2000);
    assert_eq!(r.coverage(), (Some(2000), Some("false")));
    let v = get(&addr, &format!("{V1}/pool/antpool/blocks/2010"))
        .await
        .json();
    assert_eq!(
        v.as_array()
            .unwrap()
            .iter()
            .map(|b| b["height"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [2008, 2005, 2002]
    );
    // A time before the stored history has no answer rather than a wrong one.
    let old = now() - 60 - u64::from(TIP - 50) * 600;
    assert_eq!(
        get(&addr, &format!("{V1}/blocks/timestamp/{old}"))
            .await
            .status,
        404
    );
}

/// The weekly points over the same half-filled table, its newest block a minute before each of
/// these times on Monday 16 November 2026: where Monday 00:00 UTC falls in the history decides
/// which blocks each week holds, so the test names its clock (`all` starts at 0 whatever the server's).
#[tokio::test]
async fn hashrate_points_on_a_half_filled_table_are_exact_at_any_hour() {
    const MONDAY: u64 = 1_794_787_200;
    const WEEK: u64 = 7 * 86_400;
    let mut across_retarget = false;
    for now in [30, 7 * 60, 9_000, 9_900, 43_200, 86_370].map(|s| MONDAY + s) {
        let d = dir(&format!("hashrate-{now}"));
        let tip_time = now - 60;
        fill_to(&d.0, (0..100).chain(2000..=TIP), tip_time).await;
        let (addr, _) = start(&d.0).await;
        let r = get(&addr, &format!("{V1}/hashrate/all")).await;
        assert_eq!(r.coverage().1, Some("false"), "{now}: {r:?}");
        let time = |h: u32| tip_time - u64::from(TIP - h) * 600;
        let last_before = |t: u64| (2000..=TIP).rev().find(|&h| time(h) < t);
        // Only points whose whole window is stored, each the work of the week's blocks over the
        // time since the last block before it: none dragged down by the gap.
        let points = r.json()["hashrates"].as_array().unwrap().clone();
        assert!(!points.is_empty(), "{now}");
        for p in points {
            let week = p["timestamp"].as_u64().unwrap();
            let first = last_before(week).expect("a stored block before the week") + 1;
            let last = last_before(week + WEEK).unwrap();
            across_retarget |= first < 2016;
            let work: f64 = (first..=last).map(|h| f64::from(1 + h / 2016)).sum();
            let want = work * 4_294_967_296.0 / f64::from((last - first + 1) * 600);
            let h = p["avgHashrate"].as_f64().unwrap();
            assert!((h / want - 1.0).abs() < 1e-6, "{now}: {p} {want}");
        }
    }
    assert!(
        across_retarget,
        "some hour puts a week across the retarget at 2016"
    );
}

/// Testnet 5 in November 2026: its hashrate fell by two thirds, and its last 1,008 blocks reached
/// back four days. Here the network loses three quarters of its hashrate at height 1,000: a block
/// every 600 s, then every 2,400 s up to 1,100, a few minutes ago, so even the last 144 blocks
/// reach into the fast stretch. The estimates named for a day, three days and a week count the
/// blocks of that time; the 1,008 blocks of `currentHashrate` still reach back nine days. Every
/// window's edge falls 300 s from a block, so the server's clock and the test's agree on which
/// blocks are in. A history that starts inside a window gives no estimate for it.
#[tokio::test]
async fn estimates_named_for_a_time_cover_that_time() {
    const SLOW: u32 = 1000;
    const TOP: u32 = 1100;
    let tip_time = now() - 300;
    let time = move |h: u32| {
        let slow = u64::from(TOP - h.max(SLOW)) * 2400;
        tip_time - slow - u64::from(SLOW.saturating_sub(h)) * 600
    };
    // Difficulty 1 throughout: a block's work is 2^32 hashes.
    let work = 4_294_967_296.0;
    let close = |v: &Value, field: &str, want: f64| {
        let h = v[field].as_f64().unwrap();
        assert!((h / want - 1.0).abs() < 1e-6, "{field}: {h}, want {want}");
    };

    let d = dir("slowdown");
    fill_at(&d.0, 0..=TOP, time).await;
    let (addr, _) = start(&d.0).await;
    let v = get(&addr, &format!("{V1}/pools/1w")).await.json();
    // The day: 36 slow blocks (1,065 to 1,100), timed from 1,064. The last 144 blocks would
    // say 144 blocks over 266,400 s, 44 of them fast.
    close(&v, "lastEstimatedHashrate", work / 2400.0);
    // Three days: 969 to 1,100, timed from 968.
    close(&v, "lastEstimatedHashrate3d", 132.0 * work / 259_200.0);
    // The week: 393 to 1,100, timed from 392.
    close(&v, "lastEstimatedHashrate1w", 708.0 * work / 604_800.0);
    // `currentHashrate` keeps its 1,008 blocks (93 to 1,100), and so its threefold overstatement.
    let current = get(&addr, &format!("{V1}/hashrate/1w")).await.json()["currentHashrate"]
        .as_f64()
        .unwrap();
    let want = 1008.0 * work / f64::from((TOP - SLOW) * 2400 + (SLOW - 92) * 600);
    assert!((current / want - 1.0).abs() < 1e-6, "{current} {want}");
    assert!(current > 3.0 * work / 2400.0);

    // A history from 600, five and a half days back: the week is not all stored.
    let d = dir("slowdown-short");
    fill_at(&d.0, 600..=TOP, time).await;
    let (addr, _) = start(&d.0).await;
    let v = get(&addr, &format!("{V1}/pools/24h")).await.json();
    close(&v, "lastEstimatedHashrate", work / 2400.0);
    close(&v, "lastEstimatedHashrate3d", 132.0 * work / 259_200.0);
    assert_eq!(v["lastEstimatedHashrate1w"], Value::Null);

    // A history from 1,080, 14 hours back: not even the day. The ranking and a pool's own page
    // both give no estimate rather than one from the part held.
    let d = dir("slowdown-day");
    fill_at(&d.0, 1080..=TOP, time).await;
    let (addr, _) = start(&d.0).await;
    let v = get(&addr, &format!("{V1}/pools/24h")).await.json();
    assert_eq!(v["lastEstimatedHashrate"], Value::Null);
    let r = get(&addr, &format!("{V1}/pool/foundryusa")).await;
    assert_eq!(r.status, 200, "{r:?}");
    assert_eq!(r.json()["estimatedHashrate"], Value::Null);
}

#[tokio::test]
async fn bad_parameters_are_refused_before_any_work() {
    let d = dir("bad");
    fill(&d.0, 0..=10).await;
    let (addr, calls) = start(&d.0).await;
    for (path, status) in [
        ("/pools/1W", 400),
        ("/pools/7d", 400),
        ("/pools/1w%00", 400),
        ("/hashrate/forever", 400),
        ("/blocks/fees/", 404),
        ("/blocks/fees/1w/precise", 404),
        ("/pool/FoundryUSA", 404),
        ("/pool/nobody/blocks", 404),
        ("/pool/foundryusa/blocks/-1", 400),
        ("/pool/foundryusa/blocks/1e3", 400),
        ("/pool/foundryusa/blocks/4294967296", 400),
        ("/reward-stats/0", 400),
        ("/reward-stats/52561", 400),
        ("/reward-stats/+5", 400),
        ("/blocks/timestamp/abc", 400),
        ("/blocks/timestamp/18446744073709551616", 400),
    ] {
        let r = get(&addr, &format!("{V1}{path}")).await;
        assert_eq!(r.status, status, "{path}: {r:?}");
        assert!(r.json()["error"].is_string(), "{path}");
    }
    let long = "a".repeat(10_000);
    assert_eq!(get(&addr, &format!("{V1}/pool/{long}")).await.status, 404);
    assert_eq!(
        request(&addr, "POST", &format!("{V1}/pools/1w"))
            .await
            .status,
        405
    );
    assert_eq!(
        request(&addr, "HEAD", &format!("{V1}/pools/1w"))
            .await
            .status,
        200
    );
    assert_eq!(
        get(&addr, &format!("{V1}/reward-stats/52560")).await.status,
        200
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
