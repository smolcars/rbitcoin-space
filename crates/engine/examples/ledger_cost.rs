//! What the address ledger costs per block (docs/STORE.md, "ledger"): reads the newest `BLOCKS`
//! (default 20) blocks with `getblock` verbosity 3, one call at a time, timing each; then applies
//! them to a temporary ledger tracking 0, 1 and 1,000 scripts (the scripts most active in those
//! blocks), and reports the time per block and the store's size per script. Read-only: the
//! scripts are entered with zero totals instead of asking the node to add any of them up.
//!
//! `NET=SIGNET cargo run --release -p engine --example ledger_cost` reads `{NET}_RPC_HOST`,
//! `_RPC_PORT`, `_RPC_USER` and `_RPC_PASSWORD`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
// A command-line measuring program: its printed output is its purpose.
#![allow(clippy::print_stdout)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use bitcoin::{BlockHash, Script, ScriptBuf};
use engine::ledger::{self, At, NodeSource, Source, Totals};
use engine::mempool::SourceError;
use engine::store::{Options, Store};
use node::esplora::model::TxSummary;
use node::esplora::{Esplora, ScriptSize};
use node::rpc::model::PrevoutBlock;
use node::rpc::{Limits, Rpc};

fn var(net: &str, name: &str) -> String {
    std::env::var(format!("{net}_{name}")).unwrap_or_else(|_| panic!("{net}_{name} is not set"))
}

/// The node for heights and blocks, served from the blocks read once; totals of zero.
struct Measure {
    node: NodeSource,
    blocks: HashMap<BlockHash, PrevoutBlock>,
    ceiling: AtomicU32,
}

impl Source for Measure {
    async fn height(&self) -> Result<u32, SourceError> {
        Ok(self.ceiling.load(Ordering::SeqCst))
    }

    async fn at(&self, height: u32) -> Result<Option<At>, SourceError> {
        if height > self.ceiling.load(Ordering::SeqCst) {
            return Ok(None);
        }
        self.node.at(height).await
    }

    async fn block(&self, hash: BlockHash) -> Result<PrevoutBlock, SourceError> {
        match self.blocks.get(&hash) {
            Some(b) => Ok(b.clone()),
            None => self.node.block(hash).await,
        }
    }

    async fn totals(
        &self,
        _: &Script,
        _: BlockHash,
    ) -> Result<Result<Totals, Option<ScriptSize>>, SourceError> {
        Ok(Ok(Totals::default()))
    }

    async fn page(&self, _: &Script, _: BlockHash) -> Result<Vec<TxSummary>, SourceError> {
        Ok(Vec::new())
    }

    async fn history(
        &self,
        _: &Script,
        _: At,
        _: tokio::sync::mpsc::Sender<Vec<ledger::HistoryRow>>,
    ) -> Result<Result<(), Option<ScriptSize>>, SourceError> {
        Ok(Ok(()))
    }
}

fn size(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum()
}

#[tokio::main]
async fn main() {
    let net = std::env::var("NET").unwrap_or_else(|_| "SIGNET".into());
    let n: u32 = std::env::var("BLOCKS").map_or(20, |s| s.parse().unwrap());
    let limits = Limits {
        timeout: Duration::from_secs(120),
        max_concurrent: 1,
        max_response_bytes: 256 << 20,
    };
    let rpc = Rpc::with_limits(
        &var(&net, "RPC_HOST"),
        var(&net, "RPC_PORT").parse().unwrap(),
        &var(&net, "RPC_USER"),
        &var(&net, "RPC_PASSWORD"),
        limits,
    )
    .unwrap();
    // Unused: the totals and pages are not asked.
    let node = NodeSource {
        rpc: rpc.clone(),
        esplora: Esplora::new("http://127.0.0.1:1").unwrap(),
        electrum: String::new(),
        uncapped: Default::default(),
    };
    let tip = node.height().await.unwrap();
    let from = tip - n;
    let mut blocks = HashMap::new();
    let mut active: HashMap<String, u32> = HashMap::new();
    let (mut total_ms, mut total_bytes, mut total_txs) = (0.0, 0, 0);
    for h in from + 1..=tip {
        let hash = node.at(h).await.unwrap().unwrap().hash;
        let before = rpc.bytes_received();
        let started = Instant::now();
        let b = node.block(hash).await.unwrap();
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        let bytes = rpc.bytes_received() - before;
        println!(
            "getblock 3 at {h}: {} txs, {ms:.0} ms, {} KB",
            b.tx.len(),
            bytes / 1000
        );
        total_ms += ms;
        total_bytes += bytes;
        total_txs += b.tx.len();
        for tx in &b.tx {
            let outs = tx.vout.iter().map(|o| &o.script_pub_key.hex);
            let ins = tx.vin.iter().filter_map(|i| i.prevout.as_ref());
            for hex in outs.chain(ins.map(|p| &p.script_pub_key.hex)) {
                *active.entry(hex.clone()).or_default() += 1;
            }
        }
        blocks.insert(hash, b);
    }
    println!(
        "getblock 3, {n} blocks: {:.0} ms and {} KB a block on average, {} transactions a block",
        total_ms / f64::from(n),
        total_bytes / u64::from(n) / 1000,
        total_txs / n as usize
    );
    let mut ranked: Vec<(String, u32)> = active.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    println!("{} distinct scripts in those blocks", ranked.len());
    let measure = Measure {
        node,
        blocks,
        ceiling: AtomicU32::new(from + 1),
    };
    for count in [0_usize, 1, 1000] {
        let dir = std::env::temp_dir().join(format!("ledger-cost-{}-{count}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(&dir, "measure", Options::default()).unwrap();
        measure.ceiling.store(from + 1, Ordering::SeqCst);
        // Anchored at `from`, one below the ceiling, so following applies the `n` blocks read.
        for (hex, _) in ranked.iter().take(count) {
            let script = ScriptBuf::from_hex(hex).unwrap();
            ledger::seed(&store, &measure, &script, false, 10_000, 0)
                .await
                .unwrap();
        }
        let empty = size(&dir);
        measure.ceiling.store(tip, Ordering::SeqCst);
        let started = Instant::now();
        let f = ledger::follow(&store, &measure).await.unwrap();
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        store.close().await;
        let grown = size(&dir).saturating_sub(empty);
        println!(
            "{count} scripts: {} blocks applied, {:.1} ms a block of following (four small RPC \
             lookups and the store's write; the block itself read above); files grew {} KB; \
             tables in {}",
            f.applied,
            ms / f64::from(f.applied.max(1)),
            grown / 1000,
            dir.display()
        );
    }
}
