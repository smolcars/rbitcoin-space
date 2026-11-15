//! Lists blocks through both sources, `/block/:hash/txs/summary` and `getblock` verbosity 2, and
//! checks that everything we derive from them is byte-identical: the block every consumer reads,
//! the facts (fee-rate percentiles, the ten bands, miner), the block view's binary records, the
//! `/api/v1` summary rows' inputs and the audit's. Read-only; one call at a time.
//!
//! `NET=MAINNET cargo run --release -p engine --example listing_equality` reads `{NET}_RPC_HOST`,
//! `_RPC_PORT`, `_RPC_USER`, `_RPC_PASSWORD` and `_ESPLORA_URL`. `SPREAD` (default 150 on mainnet,
//! 40 elsewhere) blocks are spaced evenly over the chain, beside the newest `RECENT` (20, or 10),
//! fixed heights of note on mainnet, and `EMPTY` (10, mainnet) recent blocks holding only their
//! coinbase. `HEIGHTS=a,b,…` replaces all of that. Exits non-zero on any difference.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
// A command-line proof program: its printed output is its purpose.
#![allow(clippy::print_stdout)]

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use engine::blocks::listing::Via;
use engine::blocks::{Lister, stats};
use node::esplora::Esplora;
use node::rpc::Rpc;
use node::rpc::model::Block;

fn var(net: &str, name: &str) -> String {
    std::env::var(format!("{net}_{name}")).unwrap_or_else(|_| panic!("{net}_{name} is not set"))
}

fn num(name: &str, default: u32) -> u32 {
    std::env::var(name).map_or(default, |s| s.parse().unwrap())
}

/// Mainnet heights of note: genesis, the first spend, the BIP30 duplicate coinbases, the first
/// halving, BIP34, SegWit, Taproot, a block of one near-4 MB transaction, the 2024 halving.
const MAINNET: [u32; 20] = [
    0, 1, 170, 546, 91_722, 91_812, 91_842, 91_880, 100_000, 210_000, 227_836, 420_000, 481_824,
    481_825, 630_000, 709_632, 774_628, 840_000, 840_001, 900_000,
];

/// Everything we store or serve from one listing, as bytes.
fn derived(b: &Block) -> Vec<u8> {
    let mut out = serde_json::to_vec(&stats::facts(b)).unwrap();
    // The flags need the raw block, which neither listing gives; the rest of each record is here.
    out.extend(stats::encode_txs(b, &vec![0; b.tx.len()]));
    // `/api/v1/block/:hash/summary` adds each txid and weight; the audit reads txid, fee, vsize
    // and weight of every transaction but the coinbase; the summary keeps the parent.
    for t in &b.tx {
        out.extend(t.txid.to_string().as_bytes());
        out.extend(t.weight.to_le_bytes());
        out.extend(t.vsize.to_le_bytes());
        out.extend(t.fee.map_or(u64::MAX, |f| f.to_sat()).to_le_bytes());
    }
    out.extend(format!("{:?}{}{}", b.previousblockhash, b.height, b.time).as_bytes());
    out
}

#[tokio::main]
async fn main() {
    let net = std::env::var("NET").unwrap_or_else(|_| "MAINNET".into());
    let mainnet = net == "MAINNET";
    let rpc = Rpc::with_limits(
        &var(&net, "RPC_HOST"),
        var(&net, "RPC_PORT").parse().unwrap(),
        &var(&net, "RPC_USER"),
        &var(&net, "RPC_PASSWORD"),
        node::rpc::Limits {
            timeout: Duration::from_secs(60),
            max_concurrent: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let esplora = Esplora::new(&var(&net, "ESPLORA_URL")).unwrap();
    let route = Lister::fixed(Via::Route);
    let tip = esplora.tip_height().await.unwrap().value;

    let mut heights = BTreeSet::new();
    if let Ok(list) = std::env::var("HEIGHTS") {
        heights.extend(list.split(',').map(|h| h.parse::<u32>().unwrap()));
    } else {
        let spread = num("SPREAD", if mainnet { 150 } else { 40 });
        heights.extend(
            (0..spread).map(|i| (u64::from(tip) * u64::from(i) / u64::from(spread)) as u32),
        );
        let recent = num("RECENT", if mainnet { 20 } else { 10 });
        heights.extend(tip.saturating_sub(recent - 1)..=tip);
        if mainnet {
            heights.extend(MAINNET.iter().filter(|&&h| h <= tip));
            // Recent empty blocks, found ten headers at a time.
            let want = num("EMPTY", 10) as usize;
            let (mut found, mut top) = (0, tip);
            while found < want && top > tip.saturating_sub(20_000) {
                let page = esplora.blocks(Some(top)).await.unwrap().value;
                for b in &page {
                    if b.tx_count == 1 && found < want && heights.insert(b.height) {
                        found += 1;
                    }
                }
                top = page.last().unwrap().height.saturating_sub(1);
            }
        }
    }
    println!("{net}: tip {tip}, {} blocks", heights.len());

    let (mut differ, mut empty, mut txs) = (0, 0, 0usize);
    let (mut route_time, mut route_bytes) = (Duration::ZERO, 0u64);
    let (mut rpc_time, mut rpc_bytes) = (Duration::ZERO, 0u64);
    for &h in &heights {
        let hash = esplora.block_hash(h).await.unwrap().value;
        let (b0, t0) = (esplora.bytes_received(), Instant::now());
        let (a, via) = route.block(&rpc, &esplora, hash).await;
        let (ta, ba) = (t0.elapsed(), esplora.bytes_received() - b0);
        assert_eq!(via, Via::Route, "{h}: the route did not answer");
        let (b0, t0) = (rpc.bytes_received(), Instant::now());
        let b = rpc.block(hash).await.unwrap();
        let (tb, bb) = (t0.elapsed(), rpc.bytes_received() - b0);
        let a = a.unwrap();
        (route_time, route_bytes, rpc_time, rpc_bytes) = (
            route_time + ta,
            route_bytes + ba,
            rpc_time + tb,
            rpc_bytes + bb,
        );
        txs += a.tx.len();
        empty += usize::from(a.tx.len() == 1);
        let same = a == b && derived(&a) == derived(&b);
        if !same {
            differ += 1;
            println!("DIFFERS {h} {hash}");
            let bare = |x: &Block| Block {
                tx: Vec::new(),
                ..x.clone()
            };
            if bare(&a) != bare(&b) {
                println!(
                    "  header or coinbase: route {:?}\n  getblock {:?}",
                    bare(&a),
                    bare(&b)
                );
            }
            if a.tx.len() != b.tx.len() {
                println!("  {} rows against {}", a.tx.len(), b.tx.len());
            }
            for (i, (x, y)) in
                a.tx.iter()
                    .zip(&b.tx)
                    .enumerate()
                    .filter(|(_, (x, y))| x != y)
                    .take(5)
            {
                println!("  tx {i}: route {x:?}\n        getblock {y:?}");
            }
        }
        println!(
            "{h} {} txs: route {:.0} ms {:.1} KB, getblock {:.0} ms {:.1} KB{}",
            a.tx.len(),
            ta.as_secs_f64() * 1000.0,
            ba as f64 / 1000.0,
            tb.as_secs_f64() * 1000.0,
            bb as f64 / 1000.0,
            if same { "" } else { "  DIFFERS" }
        );
    }
    let n = heights.len() as f64;
    println!(
        "{net}: {} blocks ({empty} empty, {txs} transactions), {differ} differ. Route {:.0} ms and \
         {:.1} KB a block on average; getblock {:.0} ms and {:.1} KB",
        heights.len(),
        route_time.as_secs_f64() * 1000.0 / n,
        route_bytes as f64 / n / 1000.0,
        rpc_time.as_secs_f64() * 1000.0 / n,
        rpc_bytes as f64 / n / 1000.0,
    );
    if differ > 0 {
        std::process::exit(1);
    }
}
