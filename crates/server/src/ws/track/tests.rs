//! The `tx:` and `address:` topics, the replacement record and the relatives route, against the
//! real tracker and projected blocks on a mock node, and a mock Electrum server on port 0.
//!
//! Every transaction test settles the engines after each change, so each change is seen in its
//! own tracker cycle and the reason the tracker gives for a removal is the one a node gives.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    // The scale test prints its measurement.
    clippy::print_stdout
)]

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, State};
use bitcoin::absolute::LockTime;
use bitcoin::block::{Header, Version};
use bitcoin::consensus::encode::serialize_hex;
use bitcoin::hashes::Hash;
use bitcoin::{
    Amount, Block, BlockHash, CompactTarget, OutPoint, ScriptBuf, Sequence, SignedAmount,
    Transaction, TxIn, TxMerkleNode, TxOut, Txid, Witness,
};
use engine::mempool::{self, Source, SourceError, Tracker};
use engine::projected::{self, ClusterSource, Projector};
use node::esplora::ChainTip;
use node::rpc::model::{Cluster, ClusterChunk, EntryFees, MempoolEntry, MempoolInfo, RawMempool};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::*;
use crate::config::Config;
use crate::ws::{Conn, Sockets};
use crate::{NetworkContext, relatives, replacements};

const WAIT: Duration = Duration::from_secs(10);

// The node.

#[derive(Clone)]
pub(crate) struct MockTx {
    pub(crate) tx: Transaction,
    pub(crate) fee: u64,
    pub(crate) vsize: u64,
    pub(crate) time: u64,
}

impl MockTx {
    fn id(&self) -> Txid {
        self.tx.compute_txid()
    }
}

#[derive(Default)]
struct Node {
    /// The mempool, oldest first: a child always comes after its parents.
    txs: Vec<MockTx>,
    sequence: u64,
    /// Clusters set by [`Mock::join`]; any other transaction stands alone.
    clusters: HashMap<Txid, Cluster>,
    /// The active chain by height, and every block ever made.
    chain: Vec<BlockHash>,
    blocks: HashMap<BlockHash, Block>,
    /// Every transaction ever sent, to put a disconnected block's back.
    sent: HashMap<Txid, MockTx>,
    down: bool,
    next: u32,
}

#[derive(Clone, Default)]
pub(crate) struct Mock {
    node: Arc<Mutex<Node>>,
    /// Calls that read more than the probe: listings, detail batches, cluster batches.
    listings: Arc<AtomicUsize>,
    details: Arc<AtomicUsize>,
    clusters: Arc<AtomicUsize>,
}

/// An outpoint nobody else spends.
pub(crate) fn coin(n: u32) -> OutPoint {
    OutPoint::new(Txid::from_byte_array([0xcc; 32]), n)
}

fn out(t: Txid, vout: u32) -> OutPoint {
    OutPoint::new(t, vout)
}

fn make(inputs: &[OutPoint], outputs: u32, tag: u32) -> Transaction {
    make_with(inputs, outputs, tag, Sequence::MAX)
}

fn make_with(inputs: &[OutPoint], outputs: u32, tag: u32, sequence: Sequence) -> Transaction {
    Transaction {
        version: bitcoin::transaction::Version::TWO,
        lock_time: LockTime::from_consensus(tag),
        input: inputs
            .iter()
            .map(|o| TxIn {
                previous_output: *o,
                script_sig: ScriptBuf::new(),
                sequence,
                witness: Witness::new(),
            })
            .collect(),
        output: (0..outputs)
            .map(|i| TxOut {
                value: Amount::from_sat(1000 + u64::from(i)),
                script_pubkey: ScriptBuf::new(),
            })
            .collect(),
    }
}

fn chunk(txs: &[&MockTx]) -> ClusterChunk {
    ClusterChunk {
        chunkfee: SignedAmount::from_sat(txs.iter().map(|t| t.fee as i64).sum()),
        chunkweight: txs.iter().map(|t| t.vsize * 4).sum(),
        txs: txs.iter().map(|t| t.id()).collect(),
    }
}

impl Node {
    fn find(&self, id: Txid) -> Option<&MockTx> {
        self.txs.iter().find(|t| t.id() == id)
    }

    /// Takes `ids` out of the mempool; whatever was joined with them stands alone again.
    fn take(&mut self, ids: &HashSet<Txid>) -> Vec<MockTx> {
        let (gone, kept): (Vec<MockTx>, Vec<MockTx>) =
            self.txs.drain(..).partition(|t| ids.contains(&t.id()));
        self.txs = kept;
        let stale: Vec<Txid> = self
            .clusters
            .iter()
            .filter(|(_, c)| {
                c.chunks
                    .iter()
                    .flat_map(|c| &c.txs)
                    .any(|m| ids.contains(m))
            })
            .map(|(t, _)| *t)
            .collect();
        for t in stale {
            self.clusters.remove(&t);
        }
        self.sequence += 1;
        gone
    }

    /// A new block holding `ids`, on the active chain.
    fn mine(&mut self, ids: &[Txid]) -> BlockHash {
        let n = self;
        let set: HashSet<Txid> = ids.iter().copied().collect();
        let mined = n.take(&set);
        n.next += 1;
        let height = n.chain.len() as u32;
        let mut block = Block {
            header: Header {
                version: Version::TWO,
                prev_blockhash: n.chain.last().copied().unwrap_or(BlockHash::all_zeros()),
                merkle_root: TxMerkleNode::all_zeros(),
                time: height,
                bits: CompactTarget::from_consensus(0x207f_ffff),
                nonce: n.next,
            },
            txdata: std::iter::once(make(&[coin(4_000_000 + n.next)], 1, n.next))
                .chain(mined.into_iter().map(|t| t.tx))
                .collect(),
        };
        block.header.merkle_root = block.compute_merkle_root().unwrap();
        let hash = block.block_hash();
        n.blocks.insert(hash, block);
        n.chain.push(hash);
        hash
    }

    /// `ids` and every mempool transaction that spends from them, transitively.
    fn with_descendants(&self, ids: &[Txid]) -> HashSet<Txid> {
        let mut all: HashSet<Txid> = ids.iter().copied().collect();
        loop {
            let more: Vec<Txid> = self
                .txs
                .iter()
                .filter(|t| !all.contains(&t.id()))
                .filter(|t| {
                    t.tx.input
                        .iter()
                        .any(|i| all.contains(&i.previous_output.txid))
                })
                .map(MockTx::id)
                .collect();
            if more.is_empty() {
                return all;
            }
            all.extend(more);
        }
    }
}

impl Mock {
    pub(crate) fn new() -> Self {
        let m = Self::default();
        m.mine(&[]);
        m
    }

    fn node(&self) -> std::sync::MutexGuard<'_, Node> {
        self.node.lock().unwrap()
    }

    /// Sends a transaction. Like the node's full RBF, whatever spends one of its inputs leaves,
    /// with its descendants.
    pub(crate) fn send(&self, inputs: &[OutPoint], outputs: u32, fee: u64, vsize: u64) -> Txid {
        self.send_with(inputs, outputs, fee, vsize, false)
    }

    /// [`Mock::send`], signalling replaceability (BIP 125) when `rbf`.
    pub(crate) fn send_with(
        &self,
        inputs: &[OutPoint],
        outputs: u32,
        fee: u64,
        vsize: u64,
        rbf: bool,
    ) -> Txid {
        let mut n = self.node();
        n.next += 1;
        let sequence = if rbf {
            Sequence::ENABLE_RBF_NO_LOCKTIME
        } else {
            Sequence::MAX
        };
        let t = MockTx {
            tx: make_with(inputs, outputs, n.next, sequence),
            fee,
            vsize,
            time: 1_700_000_000 + u64::from(n.next),
        };
        let conflicts: Vec<Txid> = n
            .txs
            .iter()
            .filter(|m| {
                m.tx.input
                    .iter()
                    .any(|i| inputs.contains(&i.previous_output))
            })
            .map(MockTx::id)
            .collect();
        let gone = n.with_descendants(&conflicts);
        n.take(&gone);
        let id = t.id();
        n.sent.insert(id, t.clone());
        n.txs.push(t);
        n.sequence += 1;
        id
    }

    /// Mines these chunks as one cluster, as the node would for a child paying for its parent.
    pub(crate) fn join(&self, chunks: &[&[Txid]]) {
        let mut n = self.node();
        let c: Vec<ClusterChunk> = chunks
            .iter()
            .map(|ids| chunk(&ids.iter().map(|i| n.find(*i).unwrap()).collect::<Vec<_>>()))
            .collect();
        let cluster = Cluster {
            clusterweight: c.iter().map(|c| c.chunkweight).sum(),
            txcount: c.iter().map(|c| c.txs.len() as u64).sum(),
            chunks: c,
        };
        for id in chunks.iter().flat_map(|c| c.iter()) {
            n.clusters.insert(*id, cluster.clone());
        }
        n.sequence += 1;
    }

    pub(crate) fn evict(&self, id: Txid) {
        let mut n = self.node();
        let gone = n.with_descendants(&[id]);
        n.take(&gone);
    }

    /// A new block holding `ids`, on the active chain.
    pub(crate) fn mine(&self, ids: &[Txid]) -> BlockHash {
        self.node().mine(ids)
    }

    /// A new block holding `ids`, sent before but replaced since: a miner that saw them first.
    /// What spends their inputs now leaves, with its descendants.
    pub(crate) fn mine_replaced(&self, ids: &[Txid]) -> BlockHash {
        let mut n = self.node();
        let txs: Vec<MockTx> = ids.iter().map(|i| n.sent[i].clone()).collect();
        let spent: Vec<OutPoint> = txs
            .iter()
            .flat_map(|t| t.tx.input.iter().map(|i| i.previous_output))
            .collect();
        let conflicts: Vec<Txid> = n
            .txs
            .iter()
            .filter(|m| {
                m.tx.input
                    .iter()
                    .any(|i| spent.contains(&i.previous_output))
            })
            .map(MockTx::id)
            .collect();
        let gone = n.with_descendants(&conflicts);
        n.take(&gone);
        n.txs.extend(txs);
        n.mine(ids)
    }

    /// Disconnects the tip block: its transactions return to the mempool.
    pub(crate) fn disconnect(&self) {
        let mut n = self.node();
        let hash = n.chain.pop().unwrap();
        let back: Vec<MockTx> = n.blocks[&hash]
            .txdata
            .iter()
            .skip(1)
            .map(|t| n.sent[&t.compute_txid()].clone())
            .collect();
        n.txs.extend(back);
        n.sequence += 1;
    }

    /// A reorg: the top `depth` blocks leave the best chain and `blocks` follow on what is
    /// left, each holding the transactions listed (sent before; what conflicts with them leaves
    /// the mempool). Of what the old blocks held, only `back` returns to the mempool.
    pub(crate) fn reorg(&self, depth: usize, back: &[Txid], blocks: &[&[Txid]]) -> Vec<BlockHash> {
        let mut n = self.node();
        for _ in 0..depth {
            n.chain.pop();
        }
        for t in back {
            let tx = n.sent[t].clone();
            n.txs.push(tx);
        }
        n.sequence += 1;
        let mut out = Vec::new();
        for ids in blocks {
            let txs: Vec<MockTx> = ids.iter().map(|i| n.sent[i].clone()).collect();
            let spent: Vec<OutPoint> = txs
                .iter()
                .flat_map(|t| t.tx.input.iter().map(|i| i.previous_output))
                .collect();
            let conflicts: Vec<Txid> = n
                .txs
                .iter()
                .filter(|m| !ids.contains(&m.id()))
                .filter(|m| {
                    m.tx.input
                        .iter()
                        .any(|i| spent.contains(&i.previous_output))
                })
                .map(MockTx::id)
                .collect();
            let gone = n.with_descendants(&conflicts);
            n.take(&gone);
            for t in txs {
                if n.find(t.id()).is_none() {
                    n.txs.push(t);
                }
            }
            out.push(n.mine(ids));
        }
        out
    }

    pub(crate) fn tip(&self) -> ChainTip {
        let n = self.node();
        ChainTip {
            hash: *n.chain.last().unwrap(),
            height: n.chain.len() as u32 - 1,
        }
    }

    pub(crate) fn set_down(&self, down: bool) {
        self.node().down = down;
    }

    fn check(&self) -> Result<std::sync::MutexGuard<'_, Node>, SourceError> {
        let n = self.node();
        if n.down {
            return Err(SourceError::Failed("rpc unavailable: refused".into()));
        }
        Ok(n)
    }

    pub(crate) fn get(&self, id: Txid) -> MockTx {
        self.node().sent[&id].clone()
    }

    /// Node calls beyond the probe, so far.
    fn reads(&self) -> (usize, usize, usize) {
        (
            self.listings.load(Ordering::Relaxed),
            self.details.load(Ordering::Relaxed),
            self.clusters.load(Ordering::Relaxed),
        )
    }
}

impl Source for Mock {
    async fn mempool_info(&self) -> Result<MempoolInfo, SourceError> {
        let n = self.check()?;
        Ok(MempoolInfo {
            loaded: true,
            size: n.txs.len() as u64,
            bytes: n.sequence + n.chain.len() as u64,
            usage: 0,
            maxmempool: 300_000_000,
            total_fee: Amount::ZERO,
            mempoolminfee: Amount::from_sat(1000),
            minrelaytxfee: Amount::from_sat(100),
            incrementalrelayfee: Amount::from_sat(100),
            fullrbf: true,
            limitclustercount: 64,
            limitclustersize: 101,
            unbroadcastcount: 0,
        })
    }

    async fn listing(&self) -> Result<RawMempool, SourceError> {
        let n = self.check()?;
        self.listings.fetch_add(1, Ordering::Relaxed);
        Ok(RawMempool {
            mempool_sequence: n.sequence,
            txids: n.txs.iter().map(MockTx::id).collect(),
        })
    }

    async fn details(
        &self,
        txids: &[Txid],
    ) -> Result<Vec<Option<(MempoolEntry, Transaction)>>, SourceError> {
        let n = self.check()?;
        self.details.fetch_add(1, Ordering::Relaxed);
        Ok(txids
            .iter()
            .map(|id| {
                let t = n.find(*id)?;
                let fee = Amount::from_sat(t.fee);
                let signed = fee.to_signed().unwrap();
                let entry = MempoolEntry {
                    wtxid: t.tx.compute_wtxid(),
                    vsize: t.vsize,
                    vsize_bip141: t.vsize,
                    weight: t.vsize * 4,
                    time: t.time,
                    height: 0,
                    fees: EntryFees {
                        base: fee,
                        modified: signed,
                        ancestor: signed,
                        descendant: signed,
                        chunk: signed,
                    },
                    ancestorcount: 1,
                    ancestorsize: 0,
                    descendantcount: 1,
                    descendantsize: 0,
                    chunkweight: t.vsize * 4,
                    depends: Vec::new(),
                    spentby: Vec::new(),
                    bip125_replaceable: true,
                    unbroadcast: false,
                };
                Some((entry, t.tx.clone()))
            })
            .collect())
    }

    async fn tip(&self) -> Result<ChainTip, SourceError> {
        drop(self.check()?);
        Ok(Mock::tip(self))
    }

    async fn block(&self, hash: BlockHash) -> Result<Block, SourceError> {
        self.check()?
            .blocks
            .get(&hash)
            .cloned()
            .ok_or_else(|| SourceError::Failed("no such block".into()))
    }

    fn bytes(&self) -> u64 {
        0
    }
}

impl ClusterSource for Mock {
    async fn clusters(&self, txids: &[Txid]) -> Result<Vec<Option<Cluster>>, SourceError> {
        let n = self.check()?;
        self.clusters.fetch_add(1, Ordering::Relaxed);
        Ok(txids
            .iter()
            .map(|t| {
                let tx = n.find(*t)?;
                Some(n.clusters.get(t).cloned().unwrap_or_else(|| Cluster {
                    clusterweight: tx.vsize * 4,
                    txcount: 1,
                    chunks: vec![chunk(&[tx])],
                }))
            })
            .collect())
    }

    fn bytes(&self) -> u64 {
        0
    }
}

// A scripted Electrum server on port 0.

/// What the mock answers `blockchain.scripthash.subscribe` with, by script hash.
#[derive(Clone)]
enum Answer {
    Status(Option<String>),
    Error(&'static str),
}

#[derive(Clone)]
pub(crate) struct Electrum {
    pub(crate) addr: String,
    answers: Arc<Mutex<HashMap<String, Answer>>>,
    /// `blockchain.scripthash.subscribe` requests received: the node's cost.
    subscribes: Arc<AtomicUsize>,
    unsubscribes: Arc<AtomicUsize>,
    /// Milliseconds before answering a subscribe, as a slow node would.
    delay: Arc<AtomicU64>,
    /// Refuses connections while set, as a node that is down.
    paused: Arc<std::sync::atomic::AtomicBool>,
    push: broadcast::Sender<String>,
    /// Drops every connection when set, as a node restart would.
    kill: broadcast::Sender<()>,
}

fn header_hex() -> String {
    serialize_hex(&Header {
        version: Version::TWO,
        prev_blockhash: BlockHash::all_zeros(),
        merkle_root: TxMerkleNode::all_zeros(),
        time: 1,
        bits: CompactTarget::from_consensus(0x207f_ffff),
        nonce: 0,
    })
}

impl Electrum {
    pub(crate) async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let e = Self {
            addr: listener.local_addr().unwrap().to_string(),
            answers: Arc::default(),
            subscribes: Arc::default(),
            unsubscribes: Arc::default(),
            delay: Arc::default(),
            paused: Arc::default(),
            push: broadcast::channel(64).0,
            kill: broadcast::channel(4).0,
        };
        let me = e.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(me.clone().serve(stream));
            }
        });
        e
    }

    fn answer(&self, sh: ScriptHash, a: Answer) {
        self.answers.lock().unwrap().insert(sh.to_string(), a);
    }

    /// Pushes a new status for a script, as the node does when its history changes.
    pub(crate) fn notify(&self, sh: ScriptHash, status: &str) {
        self.answer(sh, Answer::Status(Some(status.into())));
        let msg = json!({"jsonrpc": "2.0", "method": "blockchain.scripthash.subscribe",
            "params": [sh.to_string(), status]});
        let _ = self.push.send(msg.to_string());
    }

    async fn serve(self, stream: tokio::net::TcpStream) {
        if self.paused.load(Ordering::Relaxed) {
            return;
        }
        let (rd, mut wr) = stream.into_split();
        let mut lines = BufReader::new(rd).lines();
        let mut push = self.push.subscribe();
        let mut kill = self.kill.subscribe();
        loop {
            let line = tokio::select! {
                l = lines.next_line() => match l {
                    Ok(Some(l)) => l,
                    _ => return,
                },
                p = push.recv() => match p {
                    Ok(p) => {
                        let _ = wr.write_all(format!("{p}\n").as_bytes()).await;
                        continue;
                    }
                    Err(_) => continue,
                },
                _ = kill.recv() => return,
            };
            let req: Value = serde_json::from_str(&line).unwrap();
            let result = match req["method"].as_str().unwrap() {
                "server.version" => json!(["rbitcoin-electrs 0.9.2 electrumx", "1.6"]),
                "blockchain.headers.subscribe" => json!({"height": 0, "hex": header_hex()}),
                "blockchain.scripthash.subscribe" => {
                    self.subscribes.fetch_add(1, Ordering::Relaxed);
                    let delay = self.delay.load(Ordering::Relaxed);
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    let sh = req["params"][0].as_str().unwrap().to_owned();
                    let a = self.answers.lock().unwrap().get(&sh).cloned();
                    match a.unwrap_or(Answer::Status(None)) {
                        Answer::Status(s) => json!(s),
                        Answer::Error(message) => {
                            let e = json!({"jsonrpc": "2.0", "id": req["id"],
                                "error": {"code": -32600, "message": message}});
                            let _ = wr.write_all(format!("{e}\n").as_bytes()).await;
                            continue;
                        }
                    }
                }
                "blockchain.scripthash.unsubscribe" => {
                    self.unsubscribes.fetch_add(1, Ordering::Relaxed);
                    json!(true)
                }
                _ => Value::Null,
            };
            let reply = json!({"jsonrpc": "2.0", "id": req["id"], "result": result});
            let _ = wr.write_all(format!("{reply}\n").as_bytes()).await;
        }
    }
}

// The server side.

pub(crate) struct Server {
    pub(crate) ctx: Arc<NetworkContext>,
    pub(crate) projector: Projector,
    mock: Mock,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

/// Fast settings for tests; `tweak` changes the bounds under test.
pub(crate) fn context(
    electrum: &str,
    mempool: bool,
    tweak: impl FnOnce(&mut WsLimits),
) -> Arc<NetworkContext> {
    context_at(electrum, "http://127.0.0.1:1", mempool, tweak)
}

/// [`context`] with an Esplora at `esplora`.
pub(crate) fn context_at(
    electrum: &str,
    esplora: &str,
    mempool: bool,
    tweak: impl FnOnce(&mut WsLimits),
) -> Arc<NetworkContext> {
    context_in(electrum, esplora, mempool, None, tweak)
}

/// [`context_at`] with a store in `data_dir`.
pub(crate) fn context_in(
    electrum: &str,
    esplora: &str,
    mempool: bool,
    data_dir: Option<&str>,
    tweak: impl FnOnce(&mut WsLimits),
) -> Arc<NetworkContext> {
    context_with(electrum, esplora, mempool, data_dir, |c| tweak(&mut c.ws))
}

/// [`context_in`] with any part of the configuration changed.
pub(crate) fn context_with(
    electrum: &str,
    esplora: &str,
    mempool: bool,
    data_dir: Option<&str>,
    tweak: impl FnOnce(&mut Config),
) -> Arc<NetworkContext> {
    let mut vars: HashMap<&str, &str> = [
        ("REGTEST_RPC_HOST", "127.0.0.1"),
        ("REGTEST_RPC_PORT", "1"),
        ("REGTEST_RPC_USER", "u"),
        ("REGTEST_RPC_PASSWORD", "p"),
        ("REGTEST_ESPLORA_URL", esplora),
        ("REGTEST_ELECTRUM_ADDR", electrum),
        (
            "REGTEST_MEMPOOL_ENABLED",
            if mempool { "true" } else { "false" },
        ),
    ]
    .into_iter()
    .collect();
    if let Some(dir) = data_dir {
        vars.insert("DATA_DIR", dir);
    }
    let mut config = Config::from_vars(|k| vars.get(k).map(|v| (*v).to_owned())).unwrap();
    config.ws.mempool_interval = Duration::from_millis(20);
    config.ws.position_interval = Duration::from_millis(200);
    tweak(&mut config);
    let sockets = Sockets::new(&config.ws, Duration::from_secs(1));
    Arc::new(
        NetworkContext::new(&config.networks[0], &config, &sockets)
            .unwrap()
            .with_open_store(),
    )
}

impl Server {
    pub(crate) fn start(mock: &Mock, tweak: impl FnOnce(&mut WsLimits)) -> Self {
        Self::on(context("127.0.0.1:1", true, tweak), mock)
    }

    pub(crate) fn on(ctx: Arc<NetworkContext>, mock: &Mock) -> Self {
        let tracker_config = mempool::Config {
            gap: Duration::from_millis(10),
            heartbeat: Duration::from_millis(100),
            max_backoff: Duration::from_millis(50),
            ..mempool::Config::default()
        };
        let (tracker, t1) = Tracker::start(mock.clone(), tracker_config);
        let config = projected::Config {
            max_backoff: Duration::from_millis(50),
            ..projected::Config::default()
        };
        let (projector, t2) = Projector::start(tracker.clone(), mock.clone(), config);
        let mut tasks = crate::ws::mempool::run(&ctx, &tracker, &projector);
        tasks.extend([t1, t2]);
        Self {
            ctx,
            projector,
            mock: mock.clone(),
            tasks,
        }
    }

    /// Waits until the engines hold exactly the mock's mempool on its tip and stopped moving.
    pub(crate) async fn settle(&self) {
        let deadline = Instant::now() + WAIT;
        loop {
            let want: HashSet<Txid> = self.mock.node().txs.iter().map(MockTx::id).collect();
            let p = self.projector.current();
            let have: HashSet<Txid> = p
                .blocks
                .iter()
                .flat_map(|b| b.txs.iter().map(|(t, _)| *t))
                .collect();
            if have == want && p.tip == Some(self.mock.tip()) && !p.stale {
                tokio::time::sleep(Duration::from_millis(60)).await;
                if self.projector.current().seq == p.seq {
                    return;
                }
            }
            assert!(Instant::now() < deadline, "the engines never settled");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    fn track(&self) -> &Arc<Tracking> {
        &self.ctx.track
    }

    /// What the server holds for a mempool transaction, built here from the engines and the
    /// mock rather than by the code under test.
    fn mempool_view(&self, id: Txid) -> Value {
        let t = self.mock.get(id);
        let p = self.projector.position(&id).unwrap();
        json!({
            "topic": format!("tx:{id}"), "type": "tx", "stale": false, "state": "mempool",
            "time": t.time, "fee": t.fee, "vsize": t.vsize, "rate": t.fee * 1000 / t.vsize,
            "position": {
                "block": p.placed.block, "blocks": 8, "effective_rate": p.placed.rate,
                "ahead_vsize": p.ahead_vsize, "ahead_txs": p.ahead_txs,
            },
        })
    }
}

// The client side: what a page holds, built only from the frames it receives.

static IDS: AtomicU64 = AtomicU64::new(2_000_000);

struct Client {
    conn: Arc<Conn>,
    rx: mpsc::Receiver<Frame>,
    /// The last message of each topic, and how many each sent.
    last: HashMap<String, Value>,
    count: HashMap<String, usize>,
}

impl Client {
    fn new(queue: usize) -> Self {
        let (tx, rx) = mpsc::channel(queue);
        let conn = Arc::new(Conn::test(IDS.fetch_add(1, Ordering::Relaxed), tx));
        Self {
            conn,
            rx,
            last: HashMap::new(),
            count: HashMap::new(),
        }
    }

    /// Another socket of the same client address.
    fn beside(&self, queue: usize) -> Self {
        let (tx, rx) = mpsc::channel(queue);
        let mut conn = Conn::test(IDS.fetch_add(1, Ordering::Relaxed), tx);
        conn.who = self.conn.who;
        Self {
            conn: Arc::new(conn),
            rx,
            last: HashMap::new(),
            count: HashMap::new(),
        }
    }

    fn drain(&mut self) {
        while let Ok(f) = self.rx.try_recv() {
            let b = f.as_bytes();
            let at = match b[1] & 0x7F {
                126 => 4,
                127 => 10,
                _ => 2,
            };
            let v: Value = serde_json::from_slice(&b[at..]).unwrap();
            let topic = v["topic"].as_str().unwrap().to_owned();
            *self.count.entry(topic.clone()).or_default() += 1;
            self.last.insert(topic, v);
        }
    }

    fn sub(&self, s: &Server, name: &str) -> Result<(), Declined> {
        let (topic, name) = parse(name, Network::Regtest).unwrap();
        s.track().subscribe(topic, &name, &self.conn)
    }

    fn unsub(&self, s: &Server, name: &str) {
        let (topic, _) = parse(name, Network::Regtest).unwrap();
        s.track().unsubscribe(topic, self.conn.id);
    }

    /// Waits until the topic's last message satisfies `f`, and returns it.
    async fn wait(&mut self, topic: &str, f: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            self.drain();
            if let Some(v) = self.last.get(topic).filter(|v| f(v)) {
                return v.clone();
            }
            assert!(
                Instant::now() < deadline,
                "{topic} never matched; last: {:?}",
                self.last.get(topic)
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// Waits until the topic's last message is exactly `want`.
    async fn expect(&mut self, want: &Value) {
        let topic = want["topic"].as_str().unwrap().to_owned();
        self.wait(&topic, |v| v == want).await;
    }
}

fn tx_topic(id: Txid) -> String {
    format!("tx:{id}")
}

fn state(v: &Value) -> &str {
    v["state"].as_str().unwrap_or("")
}

/// The `chain` of a `replaced` message as (txid, by) pairs.
fn chain(v: &Value) -> Vec<(String, String)> {
    v["chain"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            (
                l["txid"].as_str().unwrap().to_owned(),
                l["by"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn pairs(links: &[(Txid, Txid)]) -> Vec<(String, String)> {
    links
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}

async fn body(r: axum::response::Response) -> (u16, Value) {
    let status = r.status().as_u16();
    let bytes = axum::body::to_bytes(r.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn relatives(s: &Server, id: Txid) -> (u16, Value) {
    match relatives::route(State(Arc::clone(&s.ctx)), Path(id.to_string())).await {
        Ok(r) => body(r).await,
        Err(e) => body(axum::response::IntoResponse::into_response(e)).await,
    }
}

async fn replacements(s: &Server, id: Txid) -> Value {
    let r = replacements::route(State(Arc::clone(&s.ctx)), Path(id.to_string()))
        .await
        .unwrap();
    body(r).await.1
}

// The tests.

#[tokio::test]
async fn a_transaction_through_every_life() {
    let mock = Mock::new();
    let a = mock.send(&[coin(1)], 1, 500, 200);
    let s = Server::start(&mock, |_| {});
    s.settle().await;
    let mut c = Client::new(256);
    let topic = tx_topic(a);
    c.sub(&s, &topic).unwrap();

    // Accepted: its own figures and its place, block 0 with nothing ahead.
    c.expect(&s.mempool_view(a)).await;
    let v = c.last[&topic].clone();
    assert_eq!(
        (&v["rate"], &v["position"]["block"]),
        (&json!(2500), &json!(0))
    );

    // Moved: two large transactions paying more take a block each, so it is projected third.
    for i in 0..2 {
        mock.send(&[coin(100 + i)], 1, 5_000_000, 998_000);
    }
    s.settle().await;
    c.expect(&s.mempool_view(a)).await;
    assert_eq!(c.last[&topic]["position"]["block"], json!(2));

    // Replaced once: the message names the replacement, with both sides' figures.
    let a2 = mock.send(&[coin(1)], 1, 900, 200);
    s.settle().await;
    let v = c.wait(&topic, |v| state(v) == "replaced").await;
    assert_eq!(v["by"], json!(a2.to_string()));
    let l = &v["chain"][0];
    assert_eq!(
        (
            &l["fee"],
            &l["vsize"],
            &l["rate"],
            &l["by_fee"],
            &l["by_rate"]
        ),
        (
            &json!(500),
            &json!(200),
            &json!(2500),
            &json!(900),
            &json!(4500)
        )
    );

    // Replaced three times: the chain grows to its end, and stays in order.
    let a3 = mock.send(&[coin(1), coin(2)], 1, 2000, 300);
    s.settle().await;
    let a4 = mock.send(&[coin(2)], 2, 5000, 250);
    s.settle().await;
    let v = c
        .wait(&topic, |v| state(v) == "replaced" && chain(v).len() == 3)
        .await;
    assert_eq!(chain(&v), pairs(&[(a, a2), (a2, a3), (a3, a4)]));
    assert_eq!(v["truncated"], json!(false));

    // Follow the end of the chain.
    let end = tx_topic(a4);
    c.sub(&s, &end).unwrap();
    c.expect(&s.mempool_view(a4)).await;

    // Confirmed: the block it is in.
    let b1 = mock.mine(&[a4]);
    s.settle().await;
    let v = c.wait(&end, |v| state(v) == "confirmed").await;
    assert_eq!(
        (&v["height"], &v["hash"]),
        (&json!(1), &json!(b1.to_string()))
    );

    // Reorged out: back in the mempool. Then confirmed in the new block.
    mock.disconnect();
    s.settle().await;
    c.expect(&s.mempool_view(a4)).await;
    let b1b = mock.mine(&[a4]);
    s.settle().await;
    let v = c.wait(&end, |v| state(v) == "confirmed").await;
    assert_eq!(v["hash"], json!(b1b.to_string()));
    assert_ne!(b1, b1b);

    // Evicted: gone for a reason the node does not report.
    let b = mock.send(&[coin(9)], 1, 100, 100);
    s.settle().await;
    let other = tx_topic(b);
    c.sub(&s, &other).unwrap();
    c.expect(&s.mempool_view(b)).await;
    mock.evict(b);
    s.settle().await;
    c.wait(&other, |v| state(v) == "evicted").await;

    // The replaced one never changed meanwhile, and every message was its whole state.
    c.drain();
    assert_eq!(chain(&c.last[&topic]).len(), 3);
}

#[tokio::test]
async fn a_subscriber_arriving_at_each_stage() {
    let mock = Mock::new();
    mock.set_down(true);
    let s = Server::start(&mock, |_| {});
    let a = mock.send(&[coin(1)], 1, 500, 200);

    // Before the tracker's first cycle: nothing is said, rather than something untrue.
    let mut early = Client::new(64);
    early.sub(&s, &tx_topic(a)).unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    early.drain();
    assert!(early.last.is_empty());
    mock.set_down(false);
    s.settle().await;
    early.expect(&s.mempool_view(a)).await;

    // After a replacement: the record says what replaced it.
    let a2 = mock.send(&[coin(1)], 1, 900, 200);
    s.settle().await;
    let mut late = Client::new(64);
    late.sub(&s, &tx_topic(a)).unwrap();
    let v = late.wait(&tx_topic(a), |_| true).await;
    assert_eq!((state(&v), chain(&v)), ("replaced", pairs(&[(a, a2)])));

    // After confirmation, after eviction, or never seen: unknown. The page asks its HTTP route.
    mock.mine(&[a2]);
    let b = mock.send(&[coin(5)], 1, 100, 100);
    s.settle().await;
    mock.evict(b);
    s.settle().await;
    let never = Txid::from_byte_array([7; 32]);
    for id in [a2, b, never] {
        let mut c = Client::new(8);
        c.sub(&s, &tx_topic(id)).unwrap();
        let v = c.wait(&tx_topic(id), |_| true).await;
        assert_eq!(state(&v), "unknown", "{id}");
    }

    // Unknown, then sent: it enters the mempool and the topic says so.
    let mut c = Client::new(64);
    let coming = make(&[coin(77)], 1, 7_777).compute_txid();
    c.sub(&s, &tx_topic(coming)).unwrap();
    let v = c.wait(&tx_topic(coming), |_| true).await;
    assert_eq!(state(&v), "unknown");
    {
        let mut n = mock.node();
        let t = MockTx {
            tx: make(&[coin(77)], 1, 7_777),
            fee: 300,
            vsize: 150,
            time: 1_700_007_777,
        };
        n.sent.insert(coming, t.clone());
        n.txs.push(t);
        n.sequence += 1;
    }
    s.settle().await;
    c.expect(&s.mempool_view(coming)).await;
}

#[tokio::test]
async fn positions_are_sent_at_a_bounded_rate_and_block_changes_at_once() {
    let mock = Mock::new();
    let a = mock.send(&[coin(1)], 1, 100, 1000);
    let s = Server::start(&mock, |w| w.position_interval = Duration::from_millis(400));
    s.settle().await;
    let mut c = Client::new(1024);
    let topic = tx_topic(a);
    c.sub(&s, &topic).unwrap();
    c.expect(&s.mempool_view(a)).await;

    // A transaction paying more arrives every 20 ms: what is ahead of `a` grows all the time,
    // its block does not.
    let started = Instant::now();
    let mut i = 0;
    while started.elapsed() < Duration::from_millis(1200) {
        mock.send(&[coin(1000 + i)], 1, 10_000, 100);
        i += 1;
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    s.settle().await;
    c.drain();
    let sent = c.count[&topic];
    // The snapshot, then at most one shuffle per 400 ms.
    let allowed = 2 + started.elapsed().as_millis() / 400;
    assert!(
        sent as u128 <= allowed,
        "{sent} messages, {allowed} allowed"
    );
    c.expect(&s.mempool_view(a)).await;
    assert!(c.last[&topic]["position"]["ahead_txs"].as_u64().unwrap() > 0);

    // Leaving the next block is news, said once.
    let before = c.count[&topic];
    // Taken before the change, so before the message it causes: the interval runs from that.
    let moved = Instant::now();
    mock.send(&[coin(5000)], 1, 200_000_000, 998_000);
    s.settle().await;
    c.wait(&topic, |v| v["position"]["block"] == json!(1)).await;
    assert_eq!(c.count[&topic], before + 1);

    // A move between later blocks is a shuffle: it waits for the interval, then goes out.
    mock.send(&[coin(5001)], 1, 200_000_000, 998_000);
    s.settle().await;
    c.wait(&topic, |v| v["position"]["block"] == json!(2)).await;
    assert!(
        moved.elapsed() >= Duration::from_millis(400),
        "{:?}",
        moved.elapsed()
    );
    assert_eq!(c.count[&topic], before + 2);

    // With an interval longer than the test, a shuffle waits throughout while leaving the next
    // block still goes out: it never waits for the interval.
    let mock = Mock::new();
    let a = mock.send(&[coin(1)], 1, 100, 1000);
    let s = Server::start(&mock, |w| w.position_interval = Duration::from_secs(3600));
    s.settle().await;
    let mut c = Client::new(64);
    let topic = tx_topic(a);
    c.sub(&s, &topic).unwrap();
    c.expect(&s.mempool_view(a)).await;
    mock.send(&[coin(2)], 1, 10_000, 100);
    s.settle().await;
    mock.send(&[coin(5000)], 1, 200_000_000, 998_000);
    s.settle().await;
    c.expect(&s.mempool_view(a)).await;
    assert_eq!(c.last[&topic]["position"]["block"], json!(1));
    // The snapshot and the block change, which carries the shuffle held before it.
    assert_eq!(c.count[&topic], 2);
}

#[tokio::test]
async fn the_replacement_record_keeps_its_bound_and_the_whole_chain() {
    let mock = Mock::new();
    let s = Server::start(&mock, |w| w.replacements_kept = 4);
    let mut ids = vec![mock.send(&[coin(1)], 1, 100, 100)];
    s.settle().await;
    for i in 0..6u64 {
        ids.push(mock.send(&[coin(1)], 1, 200 + 100 * i, 100));
        s.settle().await;
    }
    // Six replacements seen, four kept: the two oldest fell out first.
    assert_eq!(s.track().with_replacements(Replacements::len), 4);
    let v = replacements(&s, ids[0]).await;
    assert_eq!(v["replaced_by"], json!([]));
    let v = replacements(&s, ids[2]).await;
    let later: Vec<&str> = v["replaced_by"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["by"].as_str().unwrap())
        .collect();
    let want: Vec<String> = ids[3..].iter().map(Txid::to_string).collect();
    assert_eq!(later, want);
    // From the newest, backwards: what it replaced, and what that replaced, as far as kept.
    let v = replacements(&s, ids[6]).await;
    let earlier: Vec<&str> = v["replaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["txid"].as_str().unwrap())
        .collect();
    let want: Vec<String> = ids[2..6].iter().rev().map(Txid::to_string).collect();
    assert_eq!(earlier, want);
    assert_eq!(v["replaced_by"], json!([]));
    assert_eq!(v["truncated"], json!(false));
    // Figures of both sides, as the tracker knew them.
    let l = &v["replaces"][0];
    assert_eq!((&l["fee"], &l["by_fee"]), (&json!(600), &json!(700)));

    // A child leaves with its replaced parent and carries the same replacement.
    let p = mock.send(&[coin(50)], 2, 100, 100);
    s.settle().await;
    let child = mock.send(&[out(p, 0)], 1, 100, 100);
    s.settle().await;
    let p2 = mock.send(&[coin(50)], 1, 500, 100);
    s.settle().await;
    let v = replacements(&s, p2).await;
    let mut earlier: Vec<String> = v["replaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["txid"].as_str().unwrap().to_owned())
        .collect();
    earlier.sort();
    let mut want = vec![p.to_string(), child.to_string()];
    want.sort();
    assert_eq!(earlier, want);
}

#[tokio::test]
async fn relatives_come_from_memory() {
    let mock = Mock::new();
    let s = Server::start(&mock, |_| {});
    let lone = mock.send(&[coin(1)], 1, 500, 200);
    let parent = mock.send(&[coin(2)], 2, 100, 1000);
    let child = mock.send(&[out(parent, 1)], 1, 10_000, 200);
    // A chain of twenty in four chunks.
    let mut big = vec![mock.send(&[coin(3)], 1, 1000, 100)];
    for _ in 1..20 {
        big.push(mock.send(&[out(*big.last().unwrap(), 0)], 1, 1000, 100));
    }
    s.settle().await;

    let (status, v) = relatives(&s, lone).await;
    assert_eq!(status, 200);
    assert_eq!((&v["parents"], &v["children"]), (&json!([]), &json!([])));
    assert_eq!(v["chunks"][0]["rate"], json!(2500));
    assert_eq!(v["txs"].as_array().unwrap().len(), 1);

    // Once the node says they are one chunk (the projected blocks ask every cluster again at
    // each block): the parent's effective rate is the chunk's.
    mock.join(&[&[parent, child]]);
    mock.mine(&[]);
    s.settle().await;
    let deadline = Instant::now() + WAIT;
    let v = loop {
        let (_, v) = relatives(&s, parent).await;
        if v["chunks"].as_array().unwrap().len() == 1 && v["txs"].as_array().unwrap().len() == 2 {
            break v;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    // 10,100 sat over 1,200 vB, the node's rounding.
    assert_eq!(
        (
            &v["chunks"][0]["fee"],
            &v["chunks"][0]["vsize"],
            &v["chunks"][0]["rate"]
        ),
        (&json!(10_100), &json!(1200), &json!(8416))
    );
    assert_eq!(v["children"], json!([child.to_string()]));
    let (_, v) = relatives(&s, child).await;
    assert_eq!(v["parents"], json!([parent.to_string()]));
    assert_eq!(v["txs"][1]["parents"], json!([parent.to_string()]));
    assert_eq!(
        s.projector.position(&parent).unwrap().placed.rate,
        8416,
        "the tracking topic says the same"
    );

    // A large cluster, as the node chunks it: every member, each chunk, the links between.
    let chunks: Vec<&[Txid]> = big.chunks(5).collect();
    mock.join(&chunks);
    mock.mine(&[]);
    s.settle().await;
    let calls = mock.reads();
    let deadline = Instant::now() + WAIT;
    let v = loop {
        let (_, v) = relatives(&s, big[7]).await;
        if v["chunks"].as_array().unwrap().len() == 4 {
            break v;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert_eq!(v["chunk"], json!(1));
    assert_eq!(v["txs"].as_array().unwrap().len(), 20);
    assert_eq!(v["parents"], json!([big[6].to_string()]));
    assert_eq!(v["children"], json!([big[8].to_string()]));

    // Not in the mempool, a malformed txid, and none of it asked the node anything.
    let (status, _) = relatives(&s, Txid::from_byte_array([1; 32])).await;
    assert_eq!(status, 404);
    let bad = relatives::route(State(Arc::clone(&s.ctx)), Path("zz".into())).await;
    assert_eq!(bad.unwrap_err().status().as_u16(), 400);
    let after = mock.reads();
    assert_eq!(
        (after.1 - calls.1, after.2 - calls.2),
        (0, 0),
        "detail and cluster requests while answering"
    );
}

#[tokio::test]
async fn global_bounds_refuse_clearly_and_release_frees_them() {
    let mock = Mock::new();
    let ids: Vec<Txid> = (0..4).map(|i| mock.send(&[coin(i)], 1, 100, 100)).collect();
    let s = Server::start(&mock, |w| {
        w.tracked_txs_total = 3;
        w.tracked_addresses_total = 1;
    });
    s.settle().await;
    let mut clients: Vec<Client> = (0..5).map(|_| Client::new(16)).collect();
    for i in 0..3 {
        clients[i].sub(&s, &tx_topic(ids[i])).unwrap();
    }
    // A fourth distinct transaction is refused, to that socket only; it stays connected.
    assert_eq!(clients[3].sub(&s, &tx_topic(ids[3])), Err(Declined::Full));
    clients[3].drain();
    assert_eq!(
        clients[3].last[&tx_topic(ids[3])],
        json!({"topic": tx_topic(ids[3]), "type": "refused", "reason": "server_full"})
    );
    assert_eq!(clients[3].conn.reason(), None);
    // One already followed is not a new one.
    clients[4].sub(&s, &tx_topic(ids[0])).unwrap();
    assert_eq!(s.track().tracked().0, 3);

    // Release: the last subscriber leaving forgets the transaction and its stored message.
    clients[4].unsub(&s, &tx_topic(ids[0]));
    assert_eq!(s.track().tracked().0, 3);
    clients[0].unsub(&s, &tx_topic(ids[0]));
    assert_eq!(s.track().tracked().0, 2);
    let mut fresh = Client::new(16);
    s.ctx.hub.subscribe(Topic::Tx(ids[0]), &fresh.conn);
    fresh.drain();
    assert!(fresh.last.is_empty(), "no stored state is left behind");
    s.ctx.hub.unsubscribe(Topic::Tx(ids[0]), fresh.conn.id);
    clients[3].sub(&s, &tx_topic(ids[3])).unwrap();

    // Addresses have their own total.
    let a1 = format!("address:{}", crate::ws::tests::address(1));
    let a2 = format!("address:{}", crate::ws::tests::address(2));
    clients[0].sub(&s, &a1).unwrap();
    assert_eq!(clients[1].sub(&s, &a2), Err(Declined::Full));
    // Released, but its node request still counts until it ends.
    clients[0].unsub(&s, &a1);
    let deadline = Instant::now() + WAIT;
    while s.track().tracked().1 > 0 {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    clients[1].sub(&s, &a2).unwrap();
    assert_eq!(s.track().tracked(), (3, 1));
}

#[tokio::test]
async fn off_and_stale_are_said_in_the_topic() {
    // Off: one message, at once, and nothing else.
    let ctx = context("127.0.0.1:1", false, |_| {});
    let mut c = Client::new(8);
    let id = Txid::from_byte_array([3; 32]);
    let (topic, name) = parse(&tx_topic(id), Network::Regtest).unwrap();
    ctx.track.subscribe(topic, &name, &c.conn).unwrap();
    c.drain();
    assert_eq!(
        c.last[&tx_topic(id)],
        json!({"topic": tx_topic(id), "type": "off"})
    );
    let r = relatives::route(State(Arc::clone(&ctx)), Path(id.to_string())).await;
    assert_eq!(r.unwrap_err(), MEMPOOL_OFF);

    // Stale: the node fails after the sync; the last state stays, marked stale, then recovers.
    let mock = Mock::new();
    let a = mock.send(&[coin(1)], 1, 500, 200);
    let s = Server::start(&mock, |_| {});
    s.settle().await;
    let mut c = Client::new(64);
    c.sub(&s, &tx_topic(a)).unwrap();
    c.expect(&s.mempool_view(a)).await;
    mock.set_down(true);
    let v = c.wait(&tx_topic(a), |v| v["stale"] == json!(true)).await;
    assert_eq!(state(&v), "mempool");
    mock.set_down(false);
    s.settle().await;
    c.expect(&s.mempool_view(a)).await;
}

#[tokio::test]
async fn addresses_signal_changes_and_say_what_the_node_refused() {
    let electrum = Electrum::start().await;
    let ctx = context(&electrum.addr, true, |_| {});
    let follow = tokio::spawn(follow_addresses(
        Arc::clone(&ctx.track),
        ctx.electrum.events(),
        ctx.electrum.health(),
    ));
    let mock = Mock::new();
    let s = Server::on(ctx, &mock);
    let name = |n: u8| format!("address:{}", crate::ws::tests::address(n));
    let sh = |n: u8| parse(&name(n), Network::Regtest).unwrap().0;
    let Topic::Address(paid) = sh(1) else {
        panic!()
    };
    electrum.answer(paid, Answer::Status(None));

    // Two sockets on one address: one node subscription.
    let mut c = Client::new(64);
    let mut d = Client::new(64);
    c.sub(&s, &name(1)).unwrap();
    d.sub(&s, &name(1)).unwrap();
    let v = c.wait(&name(1), |v| state(v) == "watching").await;
    assert_eq!(v["status"], Value::Null);
    d.wait(&name(1), |v| state(v) == "watching").await;
    assert_eq!(electrum.subscribes.load(Ordering::Relaxed), 1);

    // A payment arrives: the token changes, so the page refetches. Then it confirms.
    for status in ["aa", "bb"] {
        let token = status.repeat(32);
        electrum.notify(paid, &token);
        c.wait(&name(1), |v| v["status"] == json!(token)).await;
        d.wait(&name(1), |v| v["status"] == json!(token)).await;
    }

    // Refusals reach the client as a state, never as a closed socket.
    for (n, message, reason) in [
        (
            2,
            "scripthash join exceeds --max-sh-creates (12000 creates, cap 10000)",
            "too_large",
        ),
        (3, "scripthash index disabled", "no_index"),
        (4, "something else", "refused"),
    ] {
        let Topic::Address(x) = sh(n) else { panic!() };
        electrum.answer(x, Answer::Error(message));
        c.sub(&s, &name(n)).unwrap_or(());
        let v = c.wait(&name(n), |v| state(v) == "refused").await;
        assert_eq!(v["reason"], json!(reason), "{message}");
        c.unsub(&s, &name(n));
    }
    assert_eq!(c.conn.reason(), None);

    // The node goes away: unavailable, not a stale "watching". It comes back: watched again,
    // with the status as it is now, without a client asking.
    let before = electrum.subscribes.load(Ordering::Relaxed);
    electrum.paused.store(true, Ordering::Relaxed);
    let _ = electrum.kill.send(());
    c.wait(&name(1), |v| state(v) == "unavailable").await;
    d.wait(&name(1), |v| state(v) == "unavailable").await;
    let token = "cc".repeat(32);
    electrum.answer(paid, Answer::Status(Some(token.clone())));
    electrum.paused.store(false, Ordering::Relaxed);
    c.wait(&name(1), |v| v["status"] == json!(token)).await;
    assert!(electrum.subscribes.load(Ordering::Relaxed) > before);

    // The last socket leaving releases the node's subscription.
    c.unsub(&s, &name(1));
    assert_eq!(s.track().tracked().1, 1);
    let unsubscribed = electrum.unsubscribes.load(Ordering::Relaxed);
    d.unsub(&s, &name(1));
    assert_eq!(s.track().tracked().1, 0);
    let deadline = Instant::now() + WAIT;
    while electrum.unsubscribes.load(Ordering::Relaxed) == unsubscribed {
        assert!(
            Instant::now() < deadline,
            "the node subscription was never released"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    follow.abort();

    // Without a node connection at all: unavailable, not silence.
    let lone = Arc::new(Tracking::new(
        Network::Regtest,
        Arc::new(Hub::new(
            Network::Regtest,
            Sockets::new(&WsLimits::default(), Duration::from_secs(1)),
        )),
        None,
        true,
        &WsLimits::default(),
        &crate::config::Limits::default(),
    ));
    let mut e = Client::new(8);
    let (topic, n) = parse(&name(5), Network::Regtest).unwrap();
    lone.subscribe(topic, &n, &e.conn).unwrap();
    e.wait(&n, |v| state(v) == "unavailable").await;
}

/// A client's budget pays for node work only: following an address the node is already asked
/// about is free, whoever asked, and following one it is no longer asked about is not.
#[tokio::test]
async fn new_address_follows_are_charged_only_when_the_node_is_asked() {
    let electrum = Electrum::start().await;
    // A budget of 2, refilled at 0.5 a second: under one token in this test's time.
    let ctx = context_with(&electrum.addr, "http://127.0.0.1:1", false, None, |c| {
        c.limits.client_burst = 8;
        c.limits.client_rate_per_sec = 1;
    });
    let follow = tokio::spawn(follow_addresses(
        Arc::clone(&ctx.track),
        ctx.electrum.events(),
        ctx.electrum.health(),
    ));
    let s = Server::on(ctx, &Mock::new());
    let name = |n: u8| format!("address:{}", crate::ws::tests::address(n));
    let subscribes = || electrum.subscribes.load(Ordering::Relaxed);
    electrum.delay.store(100, Ordering::Relaxed);
    let mut c = Client::new(64);
    let mut d = c.beside(64);
    let other = Client::new(64);

    // A first follow asks the node: one token. Leaving and coming back while the node is still
    // being asked, or a second socket of the client joining, asks it nothing: free.
    c.sub(&s, &name(1)).unwrap();
    c.unsub(&s, &name(1));
    c.sub(&s, &name(1)).unwrap();
    d.sub(&s, &name(1)).unwrap();
    // Another client already following an address makes it free too.
    other.sub(&s, &name(2)).unwrap();
    c.sub(&s, &name(2)).unwrap();
    // The second token, then none.
    c.sub(&s, &name(3)).unwrap();
    assert_eq!(d.sub(&s, &name(4)), Err(Declined::Rate));
    let v = d.wait(&name(4), |v| v["type"] == "refused").await;
    assert_eq!(v["reason"], "follow_rate");
    for n in 1..=3 {
        c.wait(&name(n), |v| state(v) == "watching").await;
    }
    assert_eq!(subscribes(), 3, "addresses 1, 2 and 3, once each");
    assert_eq!(s.track().tracked().1, 3);

    // Released by every socket once the node answered: following it again is a new request to
    // the node, and the budget is spent.
    c.unsub(&s, &name(1));
    d.unsub(&s, &name(1));
    assert_eq!(c.sub(&s, &name(1)), Err(Declined::Rate));
    // Another client has a budget of its own.
    other.sub(&s, &name(1)).unwrap();
    // A refusal leaves the socket as it was: its follows still work.
    c.wait(&name(3), |v| state(v) == "watching").await;
    assert_eq!(c.conn.reason(), None);
    assert_eq!(d.conn.reason(), None);
    follow.abort();
}

/// The consistency test: a random sequence of sends, fee bumps, children, blocks, evictions and
/// reorgs, with a few transactions followed. After every step the client's model, built only
/// from messages, must equal the server's view: the engines' for a mempool transaction, the
/// node's own history (kept here) for one that left.
#[tokio::test]
async fn a_client_model_from_messages_equals_the_server_at_every_step() {
    struct Rng(u64);
    impl Rng {
        fn below(&mut self, n: usize) -> usize {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 % n.max(1) as u64) as usize
        }
    }
    #[derive(Debug, Clone, PartialEq)]
    enum Fate {
        Mempool,
        Replaced(Txid),
        Confirmed(BlockHash),
        Evicted,
    }

    let mock = Mock::new();
    let s = Server::start(&mock, |_| {});
    let mut rng = Rng(0x0DDB_A11C_AFE5_EED5);
    let mut fate: HashMap<Txid, Fate> = HashMap::new();
    let mut client = Client::new(4096);
    let mut followed: Vec<Txid> = Vec::new();
    // Followed transactions seen in the mempool since they were followed: the server saw them
    // leave, so it must say exactly why.
    let mut watched_in_pool: HashSet<Txid> = HashSet::new();
    let mut kinds: HashMap<String, usize> = HashMap::new();
    let mut next_coin = 0;
    // Sends, noting what it replaces: whatever spends one of its inputs, and their descendants.
    let send = |fate: &mut HashMap<Txid, Fate>, inputs: &[OutPoint], outputs, fee, vsize| {
        let conflicts: Vec<Txid> = mock
            .node()
            .txs
            .iter()
            .filter(|t| {
                t.tx.input
                    .iter()
                    .any(|i| inputs.contains(&i.previous_output))
            })
            .map(MockTx::id)
            .collect();
        let gone = mock.node().with_descendants(&conflicts);
        let id = mock.send(inputs, outputs, fee, vsize);
        for g in gone {
            fate.insert(g, Fate::Replaced(id));
        }
        fate.insert(id, Fate::Mempool);
    };
    for step in 0..80 {
        let pool: Vec<MockTx> = mock.node().txs.clone();
        match rng.below(10) {
            // A fresh payment.
            0..=2 => {
                next_coin += 1;
                let fee = 100 + rng.below(900) as u64;
                send(&mut fate, &[coin(next_coin)], 2, fee, 150);
            }
            // A fee bump: the replacement takes the inputs; it and its descendants leave.
            3 | 4 if !pool.is_empty() => {
                let old = &pool[rng.below(pool.len())];
                let inputs: Vec<OutPoint> =
                    old.tx.input.iter().map(|i| i.previous_output).collect();
                send(&mut fate, &inputs, 2, old.fee * 2 + 100, old.vsize);
            }
            // A child of a mempool transaction.
            5 if !pool.is_empty() => {
                let p = &pool[rng.below(pool.len())];
                let vout = rng.below(p.tx.output.len()) as u32;
                // Two children of one output: the second replaces the first.
                send(
                    &mut fate,
                    &[out(p.id(), vout)],
                    1,
                    2000 + rng.below(100) as u64,
                    120,
                );
            }
            // A block of the oldest few.
            6 | 7 if !pool.is_empty() => {
                let k = 1 + rng.below(pool.len());
                let ids: Vec<Txid> = pool[..k].iter().map(MockTx::id).collect();
                let hash = mock.mine(&ids);
                for id in ids {
                    fate.insert(id, Fate::Confirmed(hash));
                }
            }
            // An eviction of a transaction nothing spends from.
            8 if !pool.is_empty() => {
                let leaf = pool.iter().rev().find(|t| {
                    !pool
                        .iter()
                        .any(|c| c.tx.input.iter().any(|i| i.previous_output.txid == t.id()))
                });
                if let Some(t) = leaf {
                    mock.evict(t.id());
                    fate.insert(t.id(), Fate::Evicted);
                }
            }
            // A reorg: the tip block's transactions come back.
            9 if mock.node().chain.len() > 1 => {
                let tip = *mock.node().chain.last().unwrap();
                let back: Vec<Txid> = mock.node().blocks[&tip]
                    .txdata
                    .iter()
                    .skip(1)
                    .map(Transaction::compute_txid)
                    .collect();
                mock.disconnect();
                for id in back {
                    fate.insert(id, Fate::Mempool);
                }
            }
            _ => {
                next_coin += 1;
                send(&mut fate, &[coin(next_coin)], 1, 300, 100);
            }
        }
        s.settle().await;
        let in_pool: HashSet<Txid> = mock.node().txs.iter().map(MockTx::id).collect();
        // Pages come and go, only between changes: the server is settled, so what it says on
        // subscribe is what the node says.
        if followed.len() < 6 && rng.below(2) == 0 {
            // Mostly pages of transactions still waiting, some of ones long gone.
            let mut all: Vec<Txid> = fate.keys().copied().collect();
            if rng.below(4) > 0 && !in_pool.is_empty() {
                all = in_pool.iter().copied().collect();
                all.sort_unstable();
            }
            all.sort_unstable();
            let id = all[rng.below(all.len())];
            if !followed.contains(&id) {
                client.sub(&s, &tx_topic(id)).unwrap();
                followed.push(id);
            }
        }
        if followed.len() > 3 && rng.below(4) == 0 {
            let id = followed.remove(rng.below(followed.len()));
            client.unsub(&s, &tx_topic(id));
            client.last.remove(&tx_topic(id));
            watched_in_pool.remove(&id);
        }
        for id in &followed {
            let topic = tx_topic(*id);
            if in_pool.contains(id) {
                watched_in_pool.insert(*id);
            }
            // Followed only since it left: the server could not have seen why.
            let seen_leave = watched_in_pool.contains(id);
            match fate[id].clone() {
                _ if in_pool.contains(id) => client.expect(&s.mempool_view(*id)).await,
                Fate::Replaced(by) => {
                    let v = client.wait(&topic, |v| state(v) == "replaced").await;
                    assert_eq!(v["by"], json!(by.to_string()), "step {step}");
                    // The chain follows the node's own history to its end.
                    let mut want = vec![(*id, by)];
                    while let Some(Fate::Replaced(next)) = fate.get(&want.last().unwrap().1) {
                        want.push((want.last().unwrap().1, *next));
                    }
                    assert_eq!(chain(&v), pairs(&want), "step {step}");
                }
                Fate::Confirmed(hash) if seen_leave => {
                    let v = client.wait(&topic, |v| state(v) == "confirmed").await;
                    assert_eq!(v["hash"], json!(hash.to_string()), "step {step}");
                }
                Fate::Evicted if seen_leave => {
                    client.wait(&topic, |v| state(v) == "evicted").await;
                }
                Fate::Mempool => panic!("step {step}: {id} should be in the pool"),
                _ => {
                    client.wait(&topic, |v| state(v) == "unknown").await;
                }
            }
            *kinds
                .entry(state(&client.last[&topic]).to_owned())
                .or_default() += 1;
        }
    }
    // Every state was met along the way, and checked.
    for k in ["mempool", "replaced", "confirmed", "evicted", "unknown"] {
        assert!(kinds.get(k).is_some_and(|n| *n > 0), "{k}: {kinds:?}");
    }
    // Nothing leaks: every topic followed now is tracked, and nothing else.
    assert_eq!(s.track().tracked().0, followed.len());
}

/// 5,000 sockets, each following a different transaction: the node sees no extra call, and the
/// server holds one entry and one stored message per transaction.
#[tokio::test]
async fn five_thousand_followers_cost_the_node_nothing() {
    let mock = Mock::new();
    let real: Vec<Txid> = (0..100)
        .map(|i| mock.send(&[coin(i)], 1, 100 + u64::from(i), 100))
        .collect();
    let s = Server::start(&mock, |_| {});
    s.settle().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let before = mock.reads();
    let started = Instant::now();
    let mut clients: Vec<(Client, String)> = Vec::with_capacity(5000);
    for i in 0..5000u32 {
        let c = Client::new(8);
        let id = match real.get(i as usize) {
            Some(id) => *id,
            None => Txid::from_byte_array({
                let mut b = [0u8; 32];
                b[..4].copy_from_slice(&i.to_le_bytes());
                b
            }),
        };
        let topic = tx_topic(id);
        c.sub(&s, &topic).unwrap();
        clients.push((c, topic));
    }
    let subscribe = started.elapsed();
    assert_eq!(s.track().tracked().0, 5000);
    // A few feed rounds with every one of them followed.
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Each one's first message, however long a loaded machine takes to send them all.
    for (c, topic) in &mut clients {
        c.wait(topic, |_| true).await;
        assert_eq!(c.last.len(), 1);
    }
    let after = mock.reads();
    // The tracker's heartbeat lists now and then whatever we do; nothing else may move.
    assert_eq!(
        (after.1 - before.1, after.2 - before.2),
        (0, 0),
        "detail and cluster requests"
    );
    println!(
        "5000 followers subscribed in {subscribe:?}; heartbeat listings meanwhile: {}",
        after.0 - before.0
    );
    // Released as they leave: nothing is left behind.
    for (c, topic) in &clients {
        c.unsub(&s, topic);
    }
    assert_eq!(s.track().tracked().0, 0);
}

/// A socket churning addresses while the node is slow: every request in flight counts against
/// the total, so the node never holds more than the total, and everything is released at the end.
#[tokio::test]
async fn address_churn_cannot_outrun_the_total() {
    let electrum = Electrum::start().await;
    electrum.delay.store(300, Ordering::Relaxed);
    let ctx = context(&electrum.addr, true, |w| w.tracked_addresses_total = 2);
    let follow = tokio::spawn(follow_addresses(
        Arc::clone(&ctx.track),
        ctx.electrum.events(),
        ctx.electrum.health(),
    ));
    let s = Server::on(ctx, &Mock::new());
    let name = |n: u8| format!("address:{}", crate::ws::tests::address(n));
    // Wait for the connection, so the requests below reach the node.
    let deadline = Instant::now() + WAIT;
    while !s.ctx.electrum.health().borrow().ready {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let c = Client::new(64);
    let mut refused = 0;
    for n in 0..20 {
        match c.sub(&s, &name(n)) {
            Ok(()) => c.unsub(&s, &name(n)),
            Err(why) => {
                assert_eq!(why, Declined::Full);
                refused += 1;
            }
        }
        assert!(s.track().tracked().1 <= 2);
    }
    assert_eq!(refused, 18, "two in flight hold both places");
    let deadline = Instant::now() + WAIT;
    while s.track().tracked().1 > 0 || electrum.unsubscribes.load(Ordering::Relaxed) < 2 {
        assert!(Instant::now() < deadline, "never released");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(electrum.subscribes.load(Ordering::Relaxed), 2);
    // Resubscribing to one still in flight joins it rather than asking again.
    c.sub(&s, &name(30)).unwrap();
    c.unsub(&s, &name(30));
    c.sub(&s, &name(30)).unwrap();
    let mut c = c;
    c.wait(&name(30), |v| state(v) == "watching").await;
    assert_eq!(electrum.subscribes.load(Ordering::Relaxed), 3);
    follow.abort();
}

/// The record dropped the oldest link of a chain the tracker still remembers: the topic says the
/// link it knows, then the rest of the chain from the record.
#[tokio::test]
async fn a_chain_cut_by_the_record_still_reaches_its_end() {
    let mock = Mock::new();
    let a = mock.send(&[coin(1)], 1, 100, 100);
    let s = Server::start(&mock, |w| w.replacements_kept = 1);
    s.settle().await;
    let mut c = Client::new(64);
    c.sub(&s, &tx_topic(a)).unwrap();
    c.expect(&s.mempool_view(a)).await;
    let b = mock.send(&[coin(1)], 1, 200, 100);
    s.settle().await;
    let cc = mock.send(&[coin(1)], 1, 300, 100);
    s.settle().await;
    let v = c
        .wait(&tx_topic(a), |v| {
            state(v) == "replaced" && chain(v).len() == 2
        })
        .await;
    assert_eq!(chain(&v), pairs(&[(a, b), (b, cc)]));
    assert_eq!(
        v["chain"][0].get("fee"),
        None,
        "the link the record dropped has no figures"
    );
    assert_eq!(v["chain"][1]["fee"], json!(200));
}

/// A confirmation in a block that left the best chain is not kept when the transaction does not
/// come back: the topic says it does not know.
#[tokio::test]
async fn a_confirmation_above_a_fork_is_forgotten() {
    let mock = Mock::new();
    let a = mock.send(&[coin(1)], 1, 100, 100);
    let s = Server::start(&mock, |_| {});
    s.settle().await;
    let mut c = Client::new(64);
    c.sub(&s, &tx_topic(a)).unwrap();
    c.expect(&s.mempool_view(a)).await;
    mock.mine(&[a]);
    s.settle().await;
    c.wait(&tx_topic(a), |v| {
        state(v) == "confirmed" && v["height"] == json!(1)
    })
    .await;
    // Electrum reports blocks above 0 gone; the transaction does not return to the mempool. The
    // topic says so at once, without waiting for the mempool to move.
    s.track().reorged(0);
    c.wait(&tx_topic(a), |v| state(v) == "unknown").await;
}

/// Electrum outages around addresses: one that was never reachable is watched on the first
/// connection, and one the node refuses to restore after a reconnect says why.
#[tokio::test]
async fn addresses_recover_from_outages_honestly() {
    let electrum = Electrum::start().await;
    electrum.paused.store(true, Ordering::Relaxed);
    let ctx = context(&electrum.addr, true, |_| {});
    let follow = tokio::spawn(follow_addresses(
        Arc::clone(&ctx.track),
        ctx.electrum.events(),
        ctx.electrum.health(),
    ));
    let s = Server::on(ctx, &Mock::new());
    let name = |n: u8| format!("address:{}", crate::ws::tests::address(n));
    let mut c = Client::new(64);

    // Never connected yet: unavailable, then watching once the node is reachable.
    c.sub(&s, &name(1)).unwrap();
    c.wait(&name(1), |v| state(v) == "unavailable").await;
    electrum.paused.store(false, Ordering::Relaxed);
    c.wait(&name(1), |v| state(v) == "watching").await;

    // Down, then back with a node that refuses to watch it again: refused, with the reason.
    electrum.paused.store(true, Ordering::Relaxed);
    let _ = electrum.kill.send(());
    c.wait(&name(1), |v| state(v) == "unavailable").await;
    let Topic::Address(sh) = parse(&name(1), Network::Regtest).unwrap().0 else {
        panic!()
    };
    electrum.answer(
        sh,
        Answer::Error("scripthash join exceeds --max-sh-creates (20000 creates, cap 10000)"),
    );
    electrum.paused.store(false, Ordering::Relaxed);
    let v = c.wait(&name(1), |v| state(v) == "refused").await;
    assert_eq!(v["reason"], json!("too_large"));
    follow.abort();
}

#[tokio::test]
async fn a_confirmation_is_said_at_once_whatever_the_interval() {
    let mock = Mock::new();
    let a = mock.send(&[coin(1)], 1, 500, 200);
    // Longer than the test: a confirmation that waited for it would never arrive.
    let s = Server::start(&mock, |w| w.mempool_interval = Duration::from_secs(3600));
    s.settle().await;
    let mut c = Client::new(256);
    let topic = tx_topic(a);
    c.sub(&s, &topic).unwrap();
    c.expect(&s.mempool_view(a)).await;

    let b1 = mock.mine(&[a]);
    let v = c.wait(&topic, |v| state(v) == "confirmed").await;
    assert_eq!(v["hash"], json!(b1.to_string()));
}

/// Every message on a `/api/v1/ws` connection so far, oldest first: they carry no topic.
fn v1_frames(c: &mut Client) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(f) = c.rx.try_recv() {
        let b = f.as_bytes();
        let at = match b[1] & 0x7F {
            126 => 4,
            127 => 10,
            _ => 2,
        };
        out.push(serde_json::from_slice(&b[at..]).unwrap());
    }
    out
}

/// The block a `replaced` message's first link says its replacement is in, or `mined` itself
/// when that is not `true`.
fn mined_at(v: &Value) -> Value {
    let l = &v["chain"][0];
    if l["mined"] == json!(true) {
        l["block"]["hash"].clone()
    } else {
        l["mined"].clone()
    }
}

#[tokio::test]
async fn a_reorg_reaches_every_reader_of_the_record() {
    let mock = Mock::new();
    let a = mock.send(&[coin(1)], 1, 500, 200);
    let s = Server::start(&mock, |_| {});
    s.settle().await;
    let b = mock.send(&[coin(1)], 1, 900, 200);
    s.settle().await;
    let (mut c, mut v1) = (Client::new(256), Client::new(256));
    let topic = tx_topic(a);
    c.sub(&s, &topic).unwrap();
    s.track()
        .subscribe(Topic::V1Tx(a), &topic, &v1.conn)
        .unwrap();
    let hash = |h: BlockHash| json!(h.to_string());

    // Mined: the link names its block, on the topic and the route alike.
    let b1 = mock.mine(&[b]);
    s.settle().await;
    let v = c.wait(&topic, |v| mined_at(v) == hash(b1)).await;
    assert_eq!(v["chain"][0]["block"]["height"], json!(1));
    assert_eq!(
        replacements(&s, a).await["replaced_by"][0]["block"]["hash"],
        hash(b1)
    );

    // The block is replaced by one that also holds the replacement: mined, at the new block,
    // and nothing asked of the node (its Esplora here refuses every connection).
    let b1b = mock.reorg(1, &[], &[&[b]])[0];
    s.settle().await;
    c.wait(&topic, |v| mined_at(v) == hash(b1b)).await;
    assert_eq!(
        replacements(&s, a).await["replaced_by"][0]["block"]["hash"],
        hash(b1b)
    );

    // Replaced by one without it, and it is back in the mempool: not mined.
    mock.reorg(1, &[b], &[&[]]);
    s.settle().await;
    c.wait(&topic, |v| mined_at(v) == json!(false)).await;
    assert_eq!(
        replacements(&s, a).await["replaced_by"][0]["mined"],
        json!(false)
    );

    // Mined again, then reorged out of every block and the mempool: not mined.
    let b2 = mock.mine(&[b]);
    s.settle().await;
    c.wait(&topic, |v| mined_at(v) == hash(b2)).await;
    mock.reorg(1, &[], &[&[]]);
    s.settle().await;
    c.wait(&topic, |v| mined_at(v) == json!(false)).await;
    let frames = v1_frames(&mut v1);
    assert_eq!(
        frames.last(),
        Some(&json!({"txReplaced": {"txid": b.to_string()}})),
        "still replaced, for the compatible socket"
    );

    // The original wins a reorg: confirmed in the new block, no longer replaced.
    mock.reorg(0, &[], &[&[b]]);
    s.settle().await;
    c.wait(&topic, |v| mined_at(v) != json!(false)).await;
    let won = mock.reorg(1, &[], &[&[a]])[0];
    s.settle().await;
    let v = c.wait(&topic, |v| state(v) == "confirmed").await;
    assert_eq!(v["hash"], hash(won));
    assert_eq!(
        replacements(&s, a).await["replaced_by"],
        json!([]),
        "the route agrees"
    );
    let deadline = Instant::now() + WAIT;
    let mut frames = Vec::new();
    while !frames.contains(&json!({"txConfirmed": a.to_string()})) {
        frames.extend(v1_frames(&mut v1));
        assert!(Instant::now() < deadline, "{frames:?}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn a_reorg_deeper_than_the_window_with_the_node_unreachable_reads_unknown() {
    let mock = Mock::new();
    let a = mock.send(&[coin(1)], 1, 500, 200);
    let s = Server::start(&mock, |_| {});
    s.settle().await;
    let b = mock.send(&[coin(1)], 1, 900, 200);
    s.settle().await;
    let mut c = Client::new(256);
    let topic = tx_topic(a);
    c.sub(&s, &topic).unwrap();
    let b1 = mock.mine(&[b]);
    s.settle().await;
    for _ in 0..6 {
        mock.mine(&[]);
    }
    s.settle().await;
    c.wait(&topic, |v| mined_at(v) == json!(b1.to_string()))
        .await;
    // Seven blocks replaced by seven: the window cannot show where the chains part, and the
    // node's Esplora cannot be reached to say where `b` is now.
    let empty: [&[Txid]; 7] = [&[]; 7];
    mock.reorg(7, &[], &empty);
    s.settle().await;
    let v = c.wait(&topic, |v| mined_at(v) == Value::Null).await;
    assert_eq!(v["chain"][0]["block"], Value::Null);
    assert_eq!(state(&v), "replaced");
    assert_eq!(
        replacements(&s, a).await["replaced_by"][0]["mined"],
        Value::Null
    );
}

#[tokio::test]
async fn the_replacements_topic_says_each_change_of_the_record() {
    let mock = Mock::new();
    mock.send(&[coin(1)], 1, 500, 200);
    let s = Server::start(&mock, |_| {});
    s.settle().await;
    let mut c = Client::new(64);
    s.ctx.hub.subscribe(Topic::Replacements, &c.conn);
    // A subscriber is told the record as it stands, at once.
    let version = |v: &Value| v["version"].as_u64().unwrap_or(u64::MAX);
    let first = version(
        &c.wait("replacements", |v| v["type"] == "replacements")
            .await,
    );

    // A replacement changes it.
    let a2 = mock.send(&[coin(1)], 1, 900, 200);
    s.settle().await;
    let replaced = version(&c.wait("replacements", |v| version(v) > first).await);

    // So does the replacement's confirmation: the tree is now mined.
    mock.mine(&[a2]);
    let mined = version(&c.wait("replacements", |v| version(v) > replaced).await);

    // An ordinary delta does not.
    mock.send(&[coin(7)], 1, 500, 200);
    s.settle().await;
    c.drain();
    assert_eq!(version(&c.last["replacements"]), mined);
}
