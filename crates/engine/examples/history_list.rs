//! Measures taking the whole history of a few scripts the way the server does (docs/RBITCOIN.md,
//! "The whole history of a large address"): each is seeded into a fresh store, then
//! `ledger::history` takes its list in one Electrum `blockchain.scripthash.get_history` pinned to
//! the block below the tip, streamed into the store in batches. The seed's totals are not asked
//! of Esplora (a development machine's may be an explorer, not a node): its transaction count is
//! the length of the same list, read once before, which the second must match.
//! Prints the time of each and the history table's size per row from `dbstat`. Run it under
//! `/usr/bin/time -l` (macOS) or `-v` (Linux) for the peak memory. Read-only, one request at a time.
//!
//! `NET=SIGNET cargo run --release -p engine --example history_list -- <script hex>...` reads
//! `{NET}_ELECTRUM_ADDR` and `{NET}_RPC_HOST`, `_RPC_PORT`, `_RPC_USER`, `_RPC_PASSWORD`.
//! `ledger_discovery` prints busy scripts' hex.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
// A command-line measuring program: its printed output is its purpose.
#![allow(clippy::print_stdout)]

use std::time::{Duration, Instant};

use bitcoin::{BlockHash, Script, ScriptBuf};
use engine::ledger::{self, At, HistoryRow, NodeSource, Source, Totals};
use engine::mempool::SourceError;
use engine::store::{Options, Store};
use node::esplora::model::TxSummary;
use node::esplora::{Esplora, ScriptHash, ScriptSize};
use node::rpc::model::PrevoutBlock;
use node::rpc::{Limits, Rpc};
use tokio::sync::mpsc;

/// The node, with a script's totals counted from its history list.
struct Counted(NodeSource);

impl Source for Counted {
    async fn height(&self) -> Result<u32, SourceError> {
        self.0.height().await
    }
    async fn at(&self, height: u32) -> Result<Option<At>, SourceError> {
        self.0.at(height).await
    }
    async fn block(&self, hash: BlockHash) -> Result<PrevoutBlock, SourceError> {
        self.0.block(hash).await
    }
    async fn totals(
        &self,
        script: &Script,
        at: BlockHash,
    ) -> Result<Result<Totals, Option<ScriptSize>>, SourceError> {
        let height = self.0.rpc.block_header(at).await.unwrap().height;
        let (tx, mut rx) = mpsc::channel::<Vec<HistoryRow>>(2);
        let count = async move {
            let mut n = 0u64;
            while let Some(b) = rx.recv().await {
                n += b.len() as u64;
            }
            n
        };
        let at = At {
            height,
            hash: at,
            time: 0,
        };
        let (r, n) = tokio::join!(self.0.history(script, at, tx), count);
        r.map(|r| {
            r.map(|()| Totals {
                tx_count: n,
                ..Totals::default()
            })
        })
    }
    async fn page(&self, _: &Script, _: BlockHash) -> Result<Vec<TxSummary>, SourceError> {
        Ok(Vec::new())
    }
    async fn history(
        &self,
        script: &Script,
        at: At,
        rows: mpsc::Sender<Vec<HistoryRow>>,
    ) -> Result<Result<(), Option<ScriptSize>>, SourceError> {
        self.0.history(script, at, rows).await
    }
}

fn var(net: &str, name: &str) -> String {
    std::env::var(format!("{net}_{name}")).unwrap_or_else(|_| panic!("{net}_{name} is not set"))
}

#[tokio::main]
async fn main() {
    let net = std::env::var("NET").unwrap_or_else(|_| "SIGNET".into());
    let node = Counted(NodeSource {
        rpc: Rpc::with_limits(
            &var(&net, "RPC_HOST"),
            var(&net, "RPC_PORT").parse().unwrap(),
            &var(&net, "RPC_USER"),
            &var(&net, "RPC_PASSWORD"),
            Limits {
                timeout: Duration::from_secs(120),
                max_concurrent: 1,
                max_response_bytes: 256 << 20,
            },
        )
        .unwrap(),
        esplora: Esplora::new("http://127.0.0.1:1").unwrap(),
        electrum: var(&net, "ELECTRUM_ADDR"),
        uncapped: Default::default(),
    });
    let dir = std::env::temp_dir().join(format!("history_list_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let store = Store::open(&dir, "measure", Options::default()).unwrap();
    for hex in std::env::args().skip(1) {
        let script = ScriptBuf::from_hex(&hex).unwrap();
        let sh = ScriptHash::from_script(&script);
        let started = Instant::now();
        let seeded = ledger::seed(&store, &node, &script, false, 100, 0)
            .await
            .unwrap();
        let seed_s = started.elapsed().as_secs_f64();
        let started = Instant::now();
        let r = ledger::history(&store, &node, sh, i64::MAX as u64, i64::MAX as u64, 0).await;
        println!(
            "{sh}: counted and seeded ({seeded:?}) in {seed_s:.1} s; history {r:?} in {:.1} s",
            started.elapsed().as_secs_f64()
        );
    }
    store.close().await;
    let db = rusqlite::Connection::open(dir.join("measure.sqlite")).unwrap();
    let (rows, bytes): (i64, i64) = db
        .query_row(
            concat!(
                "SELECT (SELECT count(*) FROM ledger_history), ",
                "(SELECT sum(pgsize) FROM dbstat WHERE name = 'ledger_history')"
            ),
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    println!(
        "stored {rows} rows in {:.1} MB, {:.1} bytes a row",
        bytes as f64 / 1e6,
        bytes as f64 / rows.max(1) as f64
    );
    drop(db);
    std::fs::remove_dir_all(&dir).unwrap();
}
