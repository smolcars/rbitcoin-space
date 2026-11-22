//! The block table for one network (`docs/STORE.md`, "blocks"): opens the store, follows each
//! new tip, runs the backfill, and turns what they report into log events.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bitcoin::BlockHash;
use bitcoin::hashes::Hash;
use engine::blocks::{
    self, Event, Facts, Header, Lister, NodeSource, Progress, Reorgs, Row, Source, SourceError,
};
use engine::store::{self, Store};
use logging::events::{
    BlockBackfillProgress, BlockRowsFailed, BlockRowsFollowed, BlockRowsRecovered,
    BlockRowsReorged, StoreMigrationApplied, StoreOpenFailed, StoreReadFailed, StoreReadRecovered,
    StoreReadTimedOut, StoreSlowWrite, StoreWriteFailed, StoreWriteRecovered,
};
use node::esplora::Esplora;
use node::rpc::{Limits, Rpc};
use tokio::sync::{Notify, watch};

use crate::config::{Backfill, NetworkConfig};
use crate::{Network, NetworkContext, summary};

/// After the tip moved mid-read, follow again this soon unless the new tip is announced first.
const FOLLOW_MOVED: Duration = Duration::from_secs(1);
/// The block table's node calls wait at most this long: a `getblockstats` batch of 50 full
/// blocks takes about 1.3 s of node time, a `getblock` about 2 s.
const NODE_TIMEOUT: Duration = Duration::from_secs(30);
/// First pause before following again after a failure; doubles up to [`FOLLOW_RETRY_MAX`].
const FOLLOW_RETRY: Duration = Duration::from_secs(5);
const FOLLOW_RETRY_MAX: Duration = Duration::from_secs(300);

/// One network's block table, held in [`NetworkContext`].
pub struct BlockTable {
    pub store: Arc<Store>,
    /// Where the backfill stands; stays at its default while the backfill is off.
    pub progress: watch::Sender<Progress>,
    /// Counts the times `follow` has written to the table, so the mining answers can follow.
    pub followed: watch::Sender<u64>,
    /// Wakes `follow` for a new block the `blocks` topic gave up waiting for: it then takes the
    /// block on its own retries, whenever the node serves it.
    pub wake: Notify,
    /// The table's own node clients: one RPC slot, shared by follow and the backfill, never one
    /// of the four shared ones. Each task makes one Esplora request at a time.
    source: NodeSource,
}

impl BlockTable {
    /// Opens `<dir>/<network>.sqlite`. On failure the network runs without a table, and says so.
    pub fn open(
        dir: &Path,
        config: &NetworkConfig,
        esplora: &str,
        lister: &Arc<Lister>,
    ) -> Option<Self> {
        let network = config.network.name();
        let observer = move |e: &store::Event| match e {
            store::Event::MigrationApplied { name, elapsed } => {
                logging::emit(&StoreMigrationApplied {
                    network,
                    migration: name,
                    duration_ms: ms(*elapsed),
                });
            }
            store::Event::SlowWrite {
                elapsed,
                queue_depth,
            } => logging::emit(&StoreSlowWrite {
                network,
                duration_ms: ms(*elapsed),
                queue_depth: *queue_depth,
            }),
            store::Event::ReadTimedOut { read, limit } => logging::emit(&StoreReadTimedOut {
                network,
                read: read.label(),
                limit_ms: u64::try_from(limit.as_millis()).unwrap_or(u64::MAX),
            }),
            store::Event::WriteFailed {
                kind,
                detail,
                failures,
            } => logging::emit(&StoreWriteFailed {
                network,
                error: kind,
                sqlite: detail,
                failures: *failures,
            }),
            store::Event::WriteRecovered { failures } => logging::emit(&StoreWriteRecovered {
                network,
                failures: *failures,
            }),
            store::Event::ReadFailed {
                read,
                kind,
                detail,
                failures,
            } => logging::emit(&StoreReadFailed {
                network,
                read: read.label(),
                error: kind,
                sqlite: detail,
                failures: *failures,
            }),
            store::Event::ReadRecovered { read, failures } => {
                logging::emit(&StoreReadRecovered {
                    network,
                    read: read.label(),
                    failures: *failures,
                });
            }
        };
        let options = store::Options {
            observer: Arc::new(observer),
            genesis: Some(genesis(config.network)),
            ..store::Options::default()
        };
        let store = match Store::open(dir, network, options) {
            Ok(s) => Arc::new(s),
            Err(e) => {
                logging::emit(&StoreOpenFailed {
                    network,
                    error: e.to_string(),
                });
                return None;
            }
        };
        let rpc = &config.rpc;
        let limits = Limits {
            timeout: NODE_TIMEOUT,
            max_concurrent: 1,
            ..Limits::default()
        };
        let source = NodeSource {
            rpc: Rpc::with_limits(
                &rpc.host,
                rpc.port,
                &rpc.user,
                rpc.password.expose(),
                limits,
            )
            .ok()?,
            esplora: Esplora::new(esplora).ok()?,
            lister: Arc::clone(lister),
        };
        Some(Self {
            store,
            progress: watch::Sender::new(Progress::default()),
            followed: watch::Sender::new(0),
            wake: Notify::new(),
            source,
        })
    }
}

/// The genesis hash of `network`'s chain, which its store records ([`store::Options::genesis`]).
pub fn genesis(network: Network) -> [u8; 32] {
    if network == Network::Testnet5 {
        // rust-bitcoin has no Testnet 5; its genesis block, mined 2026-11-14 (BIP 95).
        return TESTNET5_GENESIS
            .parse::<BlockHash>()
            .map_or([0; 32], |h| h.to_byte_array());
    }
    bitcoin::constants::genesis_block(crate::difficulty::chain(network))
        .block_hash()
        .to_byte_array()
}

const TESTNET5_GENESIS: &str = "00000000000008c1637e7d3252dc1c333d4546fd6fff6a474b200d674a91d497";

/// Starts following the tip and, unless it is off, the backfill.
pub fn spawn(ctx: &Arc<NetworkContext>, backfill: Backfill) {
    if ctx.blocks.is_none() {
        return;
    }
    tokio::spawn(follow(Arc::clone(ctx), backfill));
}

/// The backfill, started once follow has checked the newest rows against the node: rows it
/// wrote before that could sit above stale ones that follow would then never reach.
fn start_backfill(ctx: &Arc<NetworkContext>, backfill: Backfill, reorgs: Reorgs) {
    let Some(table) = &ctx.blocks else { return };
    if !backfill.enabled {
        return;
    }
    let network = ctx.config.network;
    let options = blocks::Options {
        busy_percent: backfill.busy_percent,
        fee_rate_depth: backfill.fee_rate_depth,
        observer: Arc::new(move |e| report(network, e)),
        reorgs,
    };
    let (ctx, store, source) = (
        Arc::clone(ctx),
        Arc::clone(&table.store),
        table.source.clone(),
    );
    tokio::spawn(async move {
        if let Some(table) = &ctx.blocks {
            blocks::backfill(store, source, options, &table.progress).await;
        }
    });
}

fn report(network: Network, e: &Event) {
    let network = network.name();
    match e {
        Event::Progress {
            progress: p,
            counted,
        } => logging::emit(&BlockBackfillProgress {
            network,
            tip: p.tip,
            // Left out rather than repeated: two lines' difference must be real progress.
            rows: counted.then_some(p.rows),
            rated: counted.then_some(p.rated),
            totals_done: p.totals_done,
            rates_done: p.rates_done,
            totals_written: p.totals_written,
            rates_written: p.rates_written,
            busy_ms: u64::try_from(p.busy.as_millis()).unwrap_or(u64::MAX),
            bytes: p.bytes,
        }),
        Event::Failed {
            tier,
            error,
            failures,
        } => {
            if failures.is_power_of_two() {
                logging::emit(&BlockRowsFailed {
                    network,
                    task: tier,
                    error: error.label(),
                    failures: *failures,
                });
            }
        }
        Event::Recovered { failures } => logging::emit(&BlockRowsRecovered {
            network,
            task: "backfill",
            failures: *failures,
        }),
    }
}

/// The node as [`blocks::follow`] reads it: the table's own clients, except that fee rates come
/// from the summaries the server computes for every new block anyway.
struct Live {
    node: NodeSource,
    ctx: Arc<NetworkContext>,
}

impl Source for Live {
    async fn chain_state(&self) -> Result<(u32, Option<u32>), SourceError> {
        self.node.chain_state().await
    }

    async fn headers(&self, top: Option<u32>) -> Result<Vec<Header>, SourceError> {
        self.node.headers(top).await
    }

    async fn rows(&self, headers: &[Header]) -> Result<Vec<Row>, blocks::Error> {
        self.node.rows(headers).await
    }

    /// `None` when the summary failed: the backfill rates the block later.
    async fn facts(&self, _: u32, hash: BlockHash) -> Result<Option<Facts>, blocks::Error> {
        Ok(summary::new_block_facts(&self.ctx, hash).await)
    }
}

/// Follows once at start, then on every new tip, and when the `blocks` topic gave up on a new
/// block; after a failure, or while the node's Esplora is behind the tip its Electrum announced,
/// again after a pause unless a new tip comes first. Starts the backfill after the first success.
async fn follow(ctx: Arc<NetworkContext>, backfill: Backfill) {
    let Some(table) = &ctx.blocks else { return };
    let live = Live {
        node: table.source.clone(),
        ctx: Arc::clone(&ctx),
    };
    let reorgs = Reorgs::default();
    let mut backfill = Some(backfill);
    let network = ctx.config.network.name();
    let mut tips = ctx.summaries.tips();
    let mut failures = 0u32;
    // Follows in a row that ended below the tip Electrum announced: the node's Esplora is late
    // (docs/RBITCOIN.md), so the newest block is looked for again after a pause.
    let mut behind = 0u32;
    loop {
        let started = Instant::now();
        match blocks::follow(&table.store, &live, &reorgs).await {
            Ok(f) => {
                if let Some(b) = backfill.take() {
                    start_backfill(&ctx, b, reorgs.clone());
                }
                if failures > 0 {
                    logging::emit(&BlockRowsRecovered {
                        network,
                        task: "follow",
                        failures,
                    });
                    failures = 0;
                }
                if f.written > 0 || f.rated > 0 || f.fork.is_some() {
                    table.followed.send_modify(|n| *n += 1);
                }
                if let Some(fork_height) = f.fork {
                    logging::emit(&BlockRowsReorged {
                        network,
                        fork_height,
                        stale: f.stale,
                    });
                }
                // Behind by height, or at the height with another block: a replacement the node's
                // Esplora does not serve yet.
                let lagging = match ctx.electrum.tip() {
                    Some(t) if t.height > f.tip => true,
                    Some(t) if t.height == f.tip => blocks::by_height(&table.store, t.height)
                        .await
                        .ok()
                        .flatten()
                        .is_some_and(|row| row.hash != t.hash),
                    _ => false,
                };
                behind = if lagging { behind.saturating_add(1) } else { 0 };
                logging::emit(&BlockRowsFollowed {
                    network,
                    tip: f.tip,
                    written: f.written,
                    rated: f.rated,
                    duration_ms: ms(started.elapsed()),
                });
            }
            Err(blocks::Error::Moved) => {
                tokio::select! {
                    changed = tips.changed() => if changed.is_err() { return },
                    () = tokio::time::sleep(FOLLOW_MOVED) => {}
                }
                continue;
            }
            Err(e) => {
                failures += 1;
                if failures.is_power_of_two() {
                    logging::emit(&BlockRowsFailed {
                        network,
                        task: "follow",
                        error: e.label(),
                        failures,
                    });
                }
            }
        }
        let tries = failures.max(behind);
        if tries == 0 {
            tokio::select! {
                changed = tips.changed() => if changed.is_err() { return },
                () = table.wake.notified() => {}
            }
        } else {
            let pause = FOLLOW_RETRY
                .saturating_mul(1 << (tries - 1).min(16))
                .min(FOLLOW_RETRY_MAX);
            tokio::select! {
                changed = tips.changed() => if changed.is_err() { return },
                () = tokio::time::sleep(pause) => {}
            }
        }
    }
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn testnet5_has_its_own_genesis() {
        let hash = BlockHash::from_byte_array(genesis(Network::Testnet5));
        assert_eq!(hash.to_string(), TESTNET5_GENESIS);
        assert_ne!(genesis(Network::Testnet5), genesis(Network::Testnet4));
    }
}
