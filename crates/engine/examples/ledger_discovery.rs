//! What discovery would consider over the newest `BLOCKS` (default 144, about a day) blocks: the
//! scripts each block pays most (`ledger::paid_most`, three a block, as the server takes them),
//! once each, with their scripthashes for a size check. Read-only, one `getblock` at a time.
//!
//! `NET=SIGNET cargo run --release -p engine --example ledger_discovery` reads `{NET}_RPC_HOST`,
//! `_RPC_PORT`, `_RPC_USER` and `_RPC_PASSWORD`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
// A command-line measuring program: its printed output is its purpose.
#![allow(clippy::print_stdout)]

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use engine::ledger::{self, NodeSource, Source};
use node::esplora::{Esplora, ScriptHash};
use node::rpc::{Limits, Rpc};

fn var(net: &str, name: &str) -> String {
    std::env::var(format!("{net}_{name}")).unwrap_or_else(|_| panic!("{net}_{name} is not set"))
}

#[tokio::main]
async fn main() {
    let net = std::env::var("NET").unwrap_or_else(|_| "SIGNET".into());
    let n: u32 = std::env::var("BLOCKS").map_or(144, |s| s.parse().unwrap());
    let limits = Limits {
        timeout: Duration::from_secs(120),
        max_concurrent: 1,
        max_response_bytes: 256 << 20,
    };
    let node = NodeSource {
        rpc: Rpc::with_limits(
            &var(&net, "RPC_HOST"),
            var(&net, "RPC_PORT").parse().unwrap(),
            &var(&net, "RPC_USER"),
            &var(&net, "RPC_PASSWORD"),
            limits,
        )
        .unwrap(),
        esplora: Esplora::new("http://127.0.0.1:1").unwrap(),
        electrum: String::new(),
        uncapped: Default::default(),
    };
    let tip = node.height().await.unwrap();
    let started = Instant::now();
    let mut found: BTreeMap<String, (u32, u32)> = BTreeMap::new();
    for h in tip - n + 1..=tip {
        let at = node.at(h).await.unwrap().unwrap();
        let block = node.block(at.hash).await.unwrap();
        for (script, paid) in ledger::paid_most(&block, 3) {
            let e = found.entry(script.to_hex_string()).or_default();
            e.0 += 1;
            e.1 += paid;
        }
    }
    println!(
        "{n} blocks to {tip} read in {:.0} s; {} distinct candidates",
        started.elapsed().as_secs_f64(),
        found.len()
    );
    for (hex, (blocks, paid)) in &found {
        let script = bitcoin::ScriptBuf::from_hex(hex).unwrap();
        println!("{} {blocks} {paid} {hex}", ScriptHash::from_script(&script));
    }
}
