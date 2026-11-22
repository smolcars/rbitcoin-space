//! Measures the block table's two backfill tiers against a live node over bounded ranges,
//! read-only, and checks sampled rows against the node's own answers. It never walks all of
//! history: each range is a few hundred to a few thousand blocks.
//!
//! `NET=MAINNET cargo run --release -p engine --example blocks_probe`
//! reads `{NET}_RPC_HOST`, `_RPC_PORT`, `_RPC_USER`, `_RPC_PASSWORD` and `_ESPLORA_URL`.
//! `TOTALS="top:count,…"` and `RATES="top:count,…"` choose the ranges (`tip` for the zone's
//! edge); `BUSY_PERCENT` (default 50) paces it as the backfill would. `LISTING=getblock` rates
//! through `getblock` verbosity 2 instead of `/block/:hash/txs/summary`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
// A command-line proof program: its printed output is its purpose.
#![allow(clippy::print_stdout)]

use std::time::{Duration, Instant};

use bitcoin::hashes::Hash;
use std::sync::Arc;

use engine::blocks::listing::Via;
use engine::blocks::{Header, Lister, NodeSource, RATED_BY_FOLLOW, Row, Source, ZONE};
use node::esplora::Esplora;
use node::rpc::{BlockRef, Rpc};

fn var(net: &str, name: &str) -> String {
    std::env::var(format!("{net}_{name}")).unwrap_or_else(|_| panic!("{net}_{name} is not set"))
}

fn ranges(name: &str, default: &str, tip: u32) -> Vec<(u32, u32)> {
    std::env::var(name)
        .unwrap_or_else(|_| default.into())
        .split(',')
        .map(|r| {
            let (top, count) = r.split_once(':').unwrap();
            let top = if top == "tip" {
                tip
            } else {
                top.parse().unwrap()
            };
            (top, count.parse().unwrap())
        })
        .collect()
}

struct Pace {
    busy: u32,
}

impl Pace {
    async fn after(&self, took: Duration) {
        tokio::time::sleep(took * (100 - self.busy) / self.busy).await;
    }
}

#[tokio::main]
async fn main() {
    let net = std::env::var("NET").unwrap_or_else(|_| "MAINNET".into());
    let pace = Pace {
        busy: std::env::var("BUSY_PERCENT").map_or(50, |s| s.parse().unwrap()),
    };
    let limits = node::rpc::Limits {
        timeout: Duration::from_secs(30),
        max_concurrent: 1,
        ..Default::default()
    };
    let rpc = Rpc::with_limits(
        &var(&net, "RPC_HOST"),
        var(&net, "RPC_PORT").parse().unwrap(),
        &var(&net, "RPC_USER"),
        &var(&net, "RPC_PASSWORD"),
        limits,
    )
    .unwrap();
    let esplora = Esplora::new(&var(&net, "ESPLORA_URL")).unwrap();
    let via = match std::env::var("LISTING").as_deref() {
        Ok("getblock") => Via::GetBlock,
        _ => Via::Route,
    };
    let lister = Lister::fixed(via);
    let source = NodeSource {
        rpc: rpc.clone(),
        esplora: esplora.clone(),
        lister: Arc::new(lister),
    };
    let tip = source.headers(None).await.unwrap()[0].height;
    println!(
        "tip {tip}, paced at {}% busy, listing by {via:?}",
        pace.busy
    );

    // Tier 1: totals and coinbase, in steps of 50 as the backfill takes them.
    let mut samples: Vec<Row> = Vec::new();
    let totals = ranges(
        "TOTALS",
        "tip:2000,2000:2000,75250:500,225250:500,375250:500,525250:500,675250:500,862250:500",
        tip - ZONE,
    );
    for (top, count) in totals {
        let (mut busy, bytes0, mut n) = (Duration::ZERO, source.bytes(), 0u32);
        let mut h = top;
        while n < count {
            let started = Instant::now();
            let mut headers: Vec<Header> = Vec::new();
            while headers.len() < 50 && n + (headers.len() as u32) < count {
                let page = source.headers(Some(h)).await.unwrap();
                let take = (50 - headers.len()).min((count - n) as usize - headers.len());
                headers.extend(page.into_iter().take(take));
                h = headers.last().unwrap().height.saturating_sub(1);
            }
            let rows = source.rows(&headers).await.unwrap();
            let took = started.elapsed();
            busy += took;
            n += rows.len() as u32;
            samples.extend(rows.first().cloned());
            samples.extend(rows.last().cloned());
            pace.after(took).await;
        }
        let bytes = source.bytes() - bytes0;
        println!(
            "totals {top}..{}: {n} blocks, {:.1} ms/block, {:.0} bytes/block",
            top + 1 - n,
            busy.as_secs_f64() * 1000.0 / f64::from(n),
            bytes as f64 / f64::from(n),
        );
    }

    // Tier 2: fee rates, one block listing each.
    let mut rated: Vec<(Row, engine::blocks::Facts)> = Vec::new();
    let rates = ranges(
        "RATES",
        "tip:30,75250:10,225250:10,375250:10,525250:10,675250:10,862250:10",
        tip - RATED_BY_FOLLOW,
    );
    for (top, count) in rates {
        let (mut busy, bytes0) = (Duration::ZERO, source.bytes());
        let mut h = top;
        let mut n = 0u32;
        while n < count {
            let page = source.headers(Some(h)).await.unwrap();
            for header in page.into_iter().take((count - n) as usize) {
                let started = Instant::now();
                let facts = source.facts(header.id).await.unwrap().unwrap();
                let took = started.elapsed();
                busy += took;
                n += 1;
                h = header.height.saturating_sub(1);
                if n == 1 {
                    let row = source.rows(std::slice::from_ref(&header)).await.unwrap();
                    rated.push((row[0].clone(), facts));
                }
                pace.after(took).await;
            }
        }
        let bytes = source.bytes() - bytes0;
        println!(
            "rates {top}..{}: {n} blocks, {:.0} ms/block, {:.0} KB/block",
            top + 1 - n,
            busy.as_secs_f64() * 1000.0 / f64::from(n),
            bytes as f64 / f64::from(n) / 1000.0,
        );
    }

    // Spot checks against the node's own answers, by other routes than the ones rows use.
    let mut checked = 0;
    for row in samples.iter().chain(rated.iter().map(|(r, _)| r)) {
        let header = rpc.block_header(row.hash).await.unwrap();
        assert_eq!(header.height, row.height);
        assert_eq!(u64::from(header.time), row.time);
        assert_eq!(header.n_tx, row.tx_count);
        // RPC prints difficulty to 16 significant digits, Esplora (which rows use) to 17.
        assert!((header.difficulty - row.difficulty).abs() <= row.difficulty * 1e-15);
        let block = esplora.block(row.hash).await.unwrap().value;
        assert_eq!((block.size, block.weight), (row.size, row.weight));
        if row.height > 0 {
            let stats = rpc.block_stats(BlockRef::Hash(row.hash)).await.unwrap();
            assert_eq!(stats.totalfee.to_sat(), row.fees, "{}", row.height);
            assert_eq!(stats.subsidy.to_sat(), row.subsidy);
            assert_eq!(stats.total_weight, row.paying_weight);
            assert_eq!(stats.txs, u64::from(row.tx_count));
        }
        if row.height == 0 {
            checked += 1;
            println!(
                "checked 0 {}: genesis, tag {} bytes",
                row.hash,
                row.coinbase.tag.len()
            );
            continue;
        }
        let txid = esplora.block_txid(row.hash, 0).await.unwrap().value;
        let cb = esplora.tx(txid).await.unwrap().value;
        assert!(cb.vin[0].is_coinbase);
        let tag = hex(&row.coinbase.tag);
        assert!(cb.vin[0].scriptsig.as_deref().unwrap().starts_with(&tag));
        assert_eq!(row.reward, cb.vout.iter().map(|o| o.value).sum::<u64>());
        let payouts: Vec<String> = cb
            .vout
            .iter()
            .filter(|o| o.value > 0 && o.scriptpubkey.len() <= 256)
            .take(8)
            .map(|o| o.scriptpubkey.clone())
            .collect();
        let ours: Vec<String> = row
            .coinbase
            .payouts
            .iter()
            .map(|s| hex(s.as_bytes()))
            .collect();
        assert_eq!(payouts, ours);
        checked += 1;
        println!(
            "checked {} {}: {} txs, fees {}, reward {}, tag {} bytes, {} payouts",
            row.height,
            row.hash,
            row.tx_count,
            row.fees,
            row.reward,
            row.coinbase.tag.len(),
            ours.len()
        );
    }
    for (row, facts) in &rated {
        assert_eq!((facts.fees, facts.weight), (row.fees, row.paying_weight));
        assert_eq!(facts.tx_count, row.tx_count as usize);
        assert_eq!(facts.id.as_byte_array(), row.hash.as_byte_array());
    }
    println!(
        "{checked} rows match the node; {} rated rows agree with getblockstats",
        rated.len()
    );
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
