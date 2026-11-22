//! Readiness at `/readyz`, and the node check behind it. `/healthz` stays liveness: cheap and
//! independent of the node. Readiness says, per network, whether the node can be reached and how
//! old our view of the chain is. It is answered from memory: the Electrum client's state, and one
//! RPC call every [`CHECK_EVERY`] per network made by [`watch`], whatever the number of requests.
//! The first check runs at startup, so a refused password is logged at once (`rpc_auth_failed`).
//! It also says whether the node has its address index ([`watch_address_index`]) and whether the
//! store's writes commit; neither counts towards `ready`, since the explorer serves without them.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bitcoin::BlockHash;
use bitcoin::hashes::Hash;
use engine::store::{Gate, OptionalExtension, Read, Store, params};
use logging::events::{
    AddressIndexOff, AddressIndexOn, RpcAuthFailed, RpcReachable, RpcUnreachable, RpcWrongNetwork,
    StoreChainUnverified, StoreWrongChain,
};
use node::electrum::Event as ElectrumEvent;
use node::esplora::{Error as EsploraError, ScriptHash, ScriptRef};
use node::rpc::Error as RpcError;
use serde_json::{Map, json};
use tokio::sync::broadcast::error::RecvError;

use crate::NetworkContext;

/// Time between two RPC checks of one network.
pub const CHECK_EVERY: Duration = Duration::from_secs(30);
/// A block this deep in the node's chain is taken as settled: an older store's row there that
/// the node does not have was written for another chain, not left by a reorg.
const SETTLED: u32 = 100;

/// What the last RPC check found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rpc {
    /// No check has finished yet.
    Pending,
    Ok,
    /// The node refused our user and password.
    AuthFailed,
    /// The node answered for another chain than the network configured.
    WrongNetwork,
    /// Timeout, connection failure, a full work queue or nonsense: the label says which.
    Unreachable(&'static str),
}

impl Rpc {
    fn label(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ok => "ok",
            Self::AuthFailed => "auth_failed",
            Self::WrongNetwork => "wrong_network",
            Self::Unreachable(_) => "unreachable",
        }
    }
}

/// One network's node check, held in [`NetworkContext`].
#[derive(Debug)]
pub struct NodeCheck(Mutex<(Rpc, Option<Instant>)>);

impl Default for NodeCheck {
    fn default() -> Self {
        Self(Mutex::new((Rpc::Pending, None)))
    }
}

impl NodeCheck {
    fn get(&self) -> (Rpc, Option<Instant>) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set(&self, rpc: Rpc) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = (rpc, Some(Instant::now()));
    }
}

/// Checks the network's RPC now and every [`CHECK_EVERY`], forever. Logs a refused password each
/// time it starts being refused, a node on another chain each time it is found, an unreachable node at the 1st, 2nd, 4th… failure in a row, and
/// the first answer and each recovery. Never stops the server: the node may simply be down.
///
/// It also keeps the store's gate: writes wait until a check has found the node on this
/// network's chain and the file's rows on it too, and are held whenever the node is found on
/// another chain. An unreachable node or a refused password changes nothing: the chain is
/// what it last was.
pub async fn watch(ctx: Arc<NetworkContext>) {
    let mut checks = Checks::default();
    loop {
        check(&ctx, &mut checks).await;
        tokio::time::sleep(CHECK_EVERY).await;
    }
}

/// What [`check`] carries from one check to the next.
#[derive(Debug, Default)]
struct Checks {
    /// Unreachable checks in a row.
    failures: u32,
    /// `store_chain_unverified` was written.
    unverified: bool,
}

/// One RPC check of [`watch`].
async fn check(ctx: &NetworkContext, checks: &mut Checks) {
    let network = ctx.config.network.name();
    let store = ctx.blocks.as_ref().map(|t| &t.store);
    let was = ctx.node.get().0;
    let now = match ctx.rpc.blockchain_info().await {
        Ok(info) if info.chain != ctx.config.network.rpc_chain() => {
            if was != Rpc::WrongNetwork {
                let node_chain: String = info.chain.chars().take(16).collect();
                logging::emit(&RpcWrongNetwork {
                    network,
                    node_chain: &node_chain,
                });
            }
            if let Some(s) = store {
                s.set_gate(Gate::Held);
            }
            Rpc::WrongNetwork
        }
        Ok(info) => {
            if was != Rpc::Ok {
                logging::emit(&RpcReachable {
                    network,
                    height: info.blocks,
                    failures: checks.failures,
                });
            }
            checks.failures = 0;
            if let Some(s) = store {
                confirm(ctx, s, info.blocks, &mut checks.unverified).await;
            }
            Rpc::Ok
        }
        Err(RpcError::Auth) => {
            if was != Rpc::AuthFailed {
                logging::emit(&RpcAuthFailed { network });
            }
            Rpc::AuthFailed
        }
        Err(e) => {
            let error = match e {
                RpcError::Timeout => "timeout",
                RpcError::Busy => "busy",
                RpcError::Decode(_) => "decode",
                _ => "unavailable",
            };
            checks.failures = checks.failures.saturating_add(1);
            if checks.failures.is_power_of_two() {
                logging::emit(&RpcUnreachable {
                    network,
                    error,
                    failures: checks.failures,
                });
            }
            Rpc::Unreachable(error)
        }
    };
    ctx.node.set(now);
}

/// Opens the store's gate for a node found on the right chain, once the rows of a file from
/// before files recorded their chain are found on it too. Rows that are not refuse the file.
async fn confirm(ctx: &NetworkContext, store: &Store, tip: u32, unverified: &mut bool) {
    if store.gate() == Gate::Refused {
        return;
    }
    if store.unstamped() {
        let network = ctx.config.network.name();
        match older_rows(ctx, store, tip).await {
            Some(Older::Same) => {
                if store.stamp().await.is_err() {
                    return;
                }
            }
            Some(Older::Other(height)) => {
                logging::emit(&StoreWrongChain { network, height });
                store.set_gate(Gate::Refused);
                return;
            }
            Some(Older::Unsettled(height)) => {
                if !std::mem::replace(unverified, true) {
                    logging::emit(&StoreChainUnverified {
                        network,
                        height,
                        node_height: tip,
                    });
                }
                return;
            }
            // The node or the store failed: the next check tries again.
            None => return,
        }
    }
    store.set_gate(Gate::Open);
}

/// What an older file's block rows say about its chain.
#[derive(Debug, PartialEq, Eq)]
enum Older {
    /// Its lowest and highest settled rows are on the node's chain, or it has none.
    Same,
    /// The row at this height is not.
    Other(u32),
    /// No row is settled yet; the lowest is at this height.
    Unsettled(u32),
}

/// Checks the lowest and the highest of an older file's settled rows against the node: those
/// [`SETTLED`] blocks or more below both the node's tip and the file's own highest row, which a
/// reorg the old server never saw finish could have left stale. Rows are written newest first
/// and replaced on a reorg, so rows from another chain show at one end: the lowest when another
/// node's backfill ran, the highest when its tip was followed. `None` when the store or node
/// failed.
async fn older_rows(ctx: &NetworkContext, store: &Store, tip: u32) -> Option<Older> {
    let (lowest, ends) = store
        .read(Read::Chain, move |sql| {
            let (lowest, highest): (Option<u32>, Option<u32>) = sql
                .prepare("SELECT min(height), max(height) FROM blocks")?
                .query_row([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            let Some(floor) = highest.and_then(|h| h.min(tip).checked_sub(SETTLED)) else {
                return Ok((lowest, [None, None]));
            };
            let end = |sql_text: &'static str| -> Result<Option<(u32, Vec<u8>)>, _> {
                sql.prepare(sql_text)?
                    .query_row(params![floor], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()
                    .map_err(engine::store::Error::from)
            };
            let low =
                end("SELECT height, hash FROM blocks WHERE height <= ?1 ORDER BY height LIMIT 1")?;
            let high = end(
                "SELECT height, hash FROM blocks WHERE height <= ?1 ORDER BY height DESC LIMIT 1",
            )?;
            Ok((lowest, [low, high]))
        })
        .await
        .ok()?;
    let Some(lowest) = lowest else {
        return Some(Older::Same);
    };
    if ends.iter().all(Option::is_none) {
        return Some(Older::Unsettled(lowest));
    }
    for (height, hash) in ends.into_iter().flatten() {
        let hash = BlockHash::from_slice(&hash).ok()?;
        match ctx.rpc.block_header(hash).await {
            Ok(h) if h.height == height && h.confirmations > 0 => {}
            Ok(_) | Err(RpcError::Rpc { code: -5, .. }) => return Some(Older::Other(height)),
            Err(_) => return None,
        }
    }
    Some(Older::Same)
}

/// Whether the node has its address index, as last asked: `unknown`, `on` or `off`.
#[derive(Debug, Default)]
pub struct AddressIndex(AtomicU8);

impl AddressIndex {
    fn label(&self) -> &'static str {
        match self.0.load(Ordering::Relaxed) {
            1 => "on",
            2 => "off",
            _ => "unknown",
        }
    }
}

/// Asks the node whether it has its address index (`--sh-index`) once Electrum is first ready,
/// then after every reconnect, since the node may have been restarted with other flags, and every
/// [`CHECK_EVERY`] while the question has no answer. Logs the first answer and each change.
pub async fn watch_address_index(ctx: Arc<NetworkContext>) {
    // No script hashes to it, so asking for its stats is one index lookup that finds nothing:
    // the cheapest question the address routes answer.
    let probe = ScriptHash::NONE;
    // Subscribed before the first question, so a reconnect during it is still heard.
    let mut events = ctx.electrum.events();
    if ctx.electrum.health().wait_for(|h| h.ready).await.is_err() {
        return;
    }
    let network = ctx.config.network.name();
    loop {
        let found = match ctx
            .esplora
            .script_stats(ScriptRef::ScriptHash(probe), None)
            .await
        {
            Ok(_) => Some(1),
            Err(EsploraError::AddressIndexDisabled) => Some(2),
            // No answer says nothing about the index.
            Err(_) => None,
        };
        if let Some(found) = found
            && ctx.address_index.0.swap(found, Ordering::Relaxed) != found
        {
            if found == 1 {
                logging::emit(&AddressIndexOn { network });
            } else {
                logging::emit(&AddressIndexOff { network });
            }
        }
        let retry = tokio::time::sleep(if found.is_some() {
            Duration::MAX
        } else {
            CHECK_EVERY
        });
        tokio::pin!(retry);
        loop {
            tokio::select! {
                e = events.recv() => match e {
                    // A lagged receiver may have missed a reconnect.
                    Ok(ElectrumEvent::Resynced) | Err(RecvError::Lagged(_)) => break,
                    Ok(_) => {}
                    Err(RecvError::Closed) => return,
                },
                () = &mut retry => break,
            }
        }
    }
}

/// The store's state for `/readyz`: `off` without `DATA_DIR`, `open_failed`, `failing` while
/// SQLite refuses writes, else `ok`; and how long ago a write last committed.
fn store(ctx: &NetworkContext) -> (&'static str, Option<u64>) {
    match &ctx.blocks {
        Some(t) => {
            let h = t.store.write_health();
            let state = match t.store.gate() {
                Gate::Refused => "wrong_chain",
                Gate::Waiting | Gate::Held => "waiting",
                Gate::Open if h.failures > 0 => "failing",
                Gate::Open => "ok",
            };
            (state, h.last_ok.map(|t| t.elapsed().as_secs()))
        }
        None if ctx.data_dir => ("open_failed", None),
        None => ("off", None),
    }
}

/// `GET /readyz`: `200` when every enabled network's node answers RPC with our credentials and
/// its Electrum connection is up, `503` otherwise. The body says which, per network.
pub fn readyz(networks: &[Arc<NetworkContext>]) -> Response {
    let unix_now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let mut all_ready = true;
    let mut out = Map::new();
    for ctx in networks {
        let (rpc, checked) = ctx.node.get();
        let electrum = ctx.electrum.health().borrow().ready;
        let tip = ctx.electrum.tip();
        let ready = rpc == Rpc::Ok && electrum;
        let (store, written) = store(ctx);
        all_ready &= ready;
        let n = json!({
            "ready": ready,
            "rpc": rpc.label(),
            "rpc_error": match rpc {
                Rpc::Unreachable(error) => Some(error),
                _ => None,
            },
            "rpc_checked_secs_ago": checked.map(|c| c.elapsed().as_secs()),
            "electrum": electrum,
            "tip_height": tip.as_ref().map(|t| t.height),
            // How old the newest block we know of is, by its own timestamp.
            "tip_age_secs": tip.map(|t| unix_now.saturating_sub(u64::from(t.header.time))),
            // Informational only: the explorer is ready whatever the Lightning peer is doing.
            "lightning": ctx.lightning.as_ref().map_or("off", |l| l.state()),
            // Informational too: without them address pages, or recorded history, stop.
            "address_index": ctx.address_index.label(),
            "store": store,
            "store_written_secs_ago": written,
        });
        out.insert(ctx.config.network.name().to_owned(), n);
    }
    let status = if all_ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    let body = json!({
        "status": if all_ready { "ready" } else { "not_ready" },
        "networks": out,
    });
    (status, Json(body)).into_response()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]

    use std::collections::HashMap;
    use std::sync::atomic::AtomicBool;

    use axum::routing::post;
    use engine::store::Error as StoreError;
    use serde_json::Value;

    use super::*;

    /// A node whose chain, reachability and blocks a test changes as it goes.
    #[derive(Default)]
    struct Node {
        chain: Mutex<&'static str>,
        down: AtomicBool,
        /// Blocks on its chain: hash as printed, and height.
        blocks: Mutex<HashMap<String, u32>>,
    }

    async fn node(n: Arc<Node>, chain: &'static str) -> u16 {
        *n.chain.lock().unwrap() = chain;
        let app = axum::Router::new().route(
            "/",
            post(move |Json(req): Json<Value>| {
                let n = Arc::clone(&n);
                async move {
                    if n.down.load(Ordering::SeqCst) {
                        return StatusCode::SERVICE_UNAVAILABLE.into_response();
                    }
                    let result = match req["method"].as_str() {
                        Some("getblockchaininfo") => json!({
                            "chain": *n.chain.lock().unwrap(), "blocks": 500, "headers": 500,
                            "bestblockhash": "00".repeat(32), "bits": "207fffff", "target": "00",
                            "difficulty": 1.0, "time": 1, "mediantime": 1,
                            "verificationprogress": 1.0, "initialblockdownload": false,
                            "chainwork": "00", "size_on_disk": 1, "pruned": false
                        }),
                        Some("getblockheader") => {
                            let hash = req["params"][0].as_str().unwrap_or_default().to_owned();
                            let Some(height) = n.blocks.lock().unwrap().get(&hash).copied() else {
                                return Json(json!({"id": 0, "result": null,
                                    "error": {"code": -5, "message": "Block not found"}}))
                                .into_response();
                            };
                            json!({
                                "hash": hash, "confirmations": 501 - height, "height": height,
                                "version": 1, "merkleroot": "00".repeat(32), "time": 1,
                                "mediantime": 1, "nonce": 0, "bits": "207fffff", "target": "00",
                                "difficulty": 1.0, "chainwork": "00", "nTx": 1
                            })
                        }
                        _ => Value::Null,
                    };
                    Json(json!({"id": 0, "error": null, "result": result})).into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await });
        port
    }

    /// Regtest on the mock node at `port`, with a store in `dir` and its gate as the server's.
    fn context(port: u16, dir: &std::path::Path) -> Arc<NetworkContext> {
        let vars: HashMap<&str, String> = [
            ("REGTEST_RPC_HOST", "127.0.0.1".to_owned()),
            ("REGTEST_RPC_PORT", port.to_string()),
            ("REGTEST_RPC_USER", "u".to_owned()),
            ("REGTEST_RPC_PASSWORD", "p".to_owned()),
            ("REGTEST_ESPLORA_URL", "http://127.0.0.1:1".to_owned()),
            ("REGTEST_ELECTRUM_ADDR", "127.0.0.1:1".to_owned()),
            ("DATA_DIR", dir.display().to_string()),
        ]
        .into_iter()
        .collect();
        let config = crate::Config::from_vars(|k| vars.get(k).cloned()).unwrap();
        let sockets = crate::ws::Sockets::new(&config.ws, Duration::from_secs(1));
        Arc::new(NetworkContext::new(&config.networks[0], &config, &sockets).unwrap())
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rbitcoin-space-gate-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn store(ctx: &NetworkContext) -> Arc<Store> {
        Arc::clone(&ctx.blocks.as_ref().unwrap().store)
    }

    async fn pending(store: &Arc<Store>) -> tokio::task::JoinHandle<Result<(), StoreError>> {
        let s = Arc::clone(store);
        let task = tokio::spawn(async move { s.write(|_| Ok(())).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!task.is_finished());
        task
    }

    #[tokio::test]
    async fn writers_wait_for_the_first_check_and_stop_while_the_node_is_elsewhere() {
        let n = Arc::new(Node::default());
        n.down.store(true, Ordering::SeqCst);
        let dir = temp("moves");
        let ctx = context(node(Arc::clone(&n), "regtest").await, &dir);
        let s = store(&ctx);
        let mut checks = Checks::default();

        // Unreachable at start: a write waits, through any number of checks.
        let waiting = pending(&s).await;
        check(&ctx, &mut checks).await;
        assert_eq!(s.gate(), Gate::Waiting);
        // The node answers on regtest: the write lands.
        n.down.store(false, Ordering::SeqCst);
        check(&ctx, &mut checks).await;
        waiting.await.unwrap().unwrap();

        // Unreachable after being right changes nothing.
        n.down.store(true, Ordering::SeqCst);
        check(&ctx, &mut checks).await;
        s.write(|_| Ok(())).await.unwrap();

        // Repointed at mainnet: writes wait, and the ones begun meanwhile never land.
        n.down.store(false, Ordering::SeqCst);
        *n.chain.lock().unwrap() = "main";
        check(&ctx, &mut checks).await;
        assert_eq!(s.gate(), Gate::Held);
        let held = pending(&s).await;
        check(&ctx, &mut checks).await;
        assert!(!held.is_finished());
        *n.chain.lock().unwrap() = "regtest";
        check(&ctx, &mut checks).await;
        assert!(matches!(held.await.unwrap(), Err(StoreError::Held)));
        s.write(|_| Ok(())).await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn replacements_made_while_the_node_was_elsewhere_are_never_written() {
        use engine::replacements::{Change, Facts, Link, Mined};
        let n = Arc::new(Node::default());
        let dir = temp("replacements");
        let ctx = context(node(Arc::clone(&n), "regtest").await, &dir);
        let s = store(&ctx);
        let mut checks = Checks::default();
        check(&ctx, &mut checks).await;
        let (kept, _writer) = crate::replacements::writer(&ctx).unwrap();
        let facts = Facts {
            fee: 100,
            vsize: 200,
            weight: 797,
            value: 5000,
            time: 1_700_000_000,
            rbf: true,
        };
        let link = |a: u8, b: u8| {
            vec![Change::Link(Link {
                txid: bitcoin::Txid::from_byte_array([a; 32]),
                by: bitcoin::Txid::from_byte_array([b; 32]),
                seen: 1,
                tx: facts,
                by_tx: Some(facts),
                mined: Mined::No,
            })]
        };
        let rows = || async {
            s.read(Read::Replacements, |sql| {
                Ok(sql
                    .prepare("SELECT count(*) FROM replacements")?
                    .query_row([], |r| r.get::<_, i64>(0))?)
            })
            .await
            .unwrap()
        };
        // Repointed at mainnet: batches made meanwhile pile up behind the waiting writer.
        *n.chain.lock().unwrap() = "main";
        check(&ctx, &mut checks).await;
        kept.send(link(1, 101));
        tokio::time::sleep(Duration::from_millis(50)).await;
        for i in 2..5 {
            kept.send(link(i, i + 100));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        *n.chain.lock().unwrap() = "regtest";
        check(&ctx, &mut checks).await;
        // A batch made once the node is right again is written; none of the others ever is.
        kept.send(link(9, 109));
        let deadline = Instant::now() + Duration::from_secs(5);
        while rows().await == 0 {
            assert!(
                Instant::now() < deadline,
                "the fresh batch was never written"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(rows().await, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file from before `chain`: block rows at these heights and hashes, and no chain row.
    async fn older_file(dir: &std::path::Path, rows: &[(u32, BlockHash)]) {
        let old = Store::open(dir, "regtest", engine::store::Options::default()).unwrap();
        let rows = rows.to_vec();
        old.write(move |sql| {
            sql.prepare("DELETE FROM chain")?.execute([])?;
            for (height, hash) in &rows {
                sql.prepare(
                    "INSERT INTO blocks (height, hash, time, tx_count, size, weight, \
                     paying_weight, fees, subsidy, reward, difficulty, coinbase_tag, payouts) \
                     VALUES (?1, ?2, 0, 1, 1, 4, 0, 0, 0, 0, 1.0, x'', x'')",
                )?
                .execute(params![height, hash.to_byte_array().to_vec()])?;
            }
            Ok(())
        })
        .await
        .unwrap();
        old.close().await;
    }

    fn hash(n: u8) -> BlockHash {
        BlockHash::from_byte_array([n; 32])
    }

    #[tokio::test]
    async fn an_older_file_is_checked_against_the_node_before_it_is_written() {
        // Rows at 10 and 300 the node has, and 390, which it does not: a block a reorg replaced
        // while the server was down, as the file's tip, far enough below the node's (500) to
        // look settled. It is not settled in the file: recorded and opened.
        let n = Arc::new(Node::default());
        let port = node(Arc::clone(&n), "regtest").await;
        n.blocks
            .lock()
            .unwrap()
            .extend([(hash(1).to_string(), 10), (hash(2).to_string(), 280)]);
        let dir = temp("same");
        older_file(&dir, &[(10, hash(1)), (280, hash(2)), (390, hash(3))]).await;
        let ctx = context(port, &dir);
        let s = store(&ctx);
        assert!(s.unstamped());
        check(&ctx, &mut Checks::default()).await;
        assert_eq!(s.gate(), Gate::Open);
        assert!(!s.unstamped());
        let _ = std::fs::remove_dir_all(&dir);

        // The lowest row is another chain's (another node's backfill reached it): refused.
        let dir = temp("low");
        older_file(&dir, &[(10, hash(9)), (280, hash(2)), (450, hash(3))]).await;
        let ctx = context(port, &dir);
        let s = store(&ctx);
        check(&ctx, &mut Checks::default()).await;
        assert_eq!(s.gate(), Gate::Refused);
        assert!(matches!(s.write(|_| Ok(())).await, Err(StoreError::Held)));
        assert!(s.unstamped());
        let _ = std::fs::remove_dir_all(&dir);

        // The highest settled row is (another node's tip was followed): refused.
        let dir = temp("high");
        older_file(&dir, &[(10, hash(1)), (280, hash(8)), (450, hash(3))]).await;
        let ctx = context(port, &dir);
        check(&ctx, &mut Checks::default()).await;
        assert_eq!(store(&ctx).gate(), Gate::Refused);
        let _ = std::fs::remove_dir_all(&dir);

        // Only rows the node cannot settle yet: writes keep waiting.
        let dir = temp("unsettled");
        older_file(&dir, &[(450, hash(3))]).await;
        let ctx = context(port, &dir);
        check(&ctx, &mut Checks::default()).await;
        assert_eq!(store(&ctx).gate(), Gate::Waiting);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
