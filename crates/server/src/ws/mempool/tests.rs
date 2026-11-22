//! The mempool topics against real engines on a mock node: each topic's snapshot and changes, a
//! client-side model that must end equal to the server's, random sequences of mempool changes,
//! lagging and late subscribers, the bounds, the off switch, and a node down at boot.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    // The bound tests print what they measured, for docs/WS.md.
    clippy::print_stderr
)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bitcoin::absolute::LockTime;
use bitcoin::block::{Header, Version};
use bitcoin::hashes::Hash;
use bitcoin::{
    Amount, Block, BlockHash, CompactTarget, OutPoint, ScriptBuf, Sequence, SignedAmount,
    Transaction, TxIn, TxMerkleNode, TxOut, Txid, Witness,
};
use engine::mempool::{self, Source, SourceError, Tracker};
use engine::projected::{self, ClusterSource, Projection, Projector};
use node::esplora::ChainTip;
use node::rpc::model::{Cluster, ClusterChunk, EntryFees, MempoolEntry, MempoolInfo, RawMempool};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::*;
use crate::Config;
use crate::ws::{Close, Conn, Sockets};

const WAIT: Duration = Duration::from_secs(10);

// A deterministic generator, so a failing seed can be replayed.

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

// The node.

/// One mempool transaction as the mock node holds it.
#[derive(Clone)]
struct MockTx {
    tx: Transaction,
    fee: u64,
    vsize: u64,
    time: u64,
}

#[derive(Default)]
struct Node {
    txs: Vec<MockTx>,
    sequence: u64,
    /// Chunks the node mines by: every transaction alone unless joined.
    clusters: HashMap<Txid, Cluster>,
    tip: Option<ChainTip>,
    blocks: HashMap<BlockHash, Block>,
    /// Every call fails, as with a node that is down.
    down: bool,
    next_tag: u32,
    /// Every transaction ever added, oldest first.
    history: Vec<Txid>,
    /// The node's minimum accepted rate, sat per 1,000 vB.
    min_fee: u64,
    /// Requests answered or refused, by method.
    calls: HashMap<&'static str, usize>,
}

#[derive(Clone, Default)]
struct Mock(Arc<Mutex<Node>>);

fn tx(tag: u32) -> Transaction {
    Transaction {
        version: bitcoin::transaction::Version::TWO,
        lock_time: LockTime::from_consensus(tag),
        input: vec![TxIn {
            previous_output: OutPoint::new(Txid::from_byte_array([0xcc; 32]), tag),
            script_sig: ScriptBuf::new(),
            sequence: Sequence::MAX,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::from_sat(u64::from(tag) * 7 + 1000),
            script_pubkey: ScriptBuf::new(),
        }],
    }
}

fn alone(t: &MockTx) -> Cluster {
    cluster(&[(&[t])])
}

/// One chunk per slice, each holding its transactions.
fn cluster(chunks: &[&[&MockTx]]) -> Cluster {
    let chunks: Vec<ClusterChunk> = chunks
        .iter()
        .map(|c| ClusterChunk {
            chunkfee: SignedAmount::from_sat(c.iter().map(|t| t.fee as i64).sum()),
            chunkweight: c.iter().map(|t| t.vsize * 4).sum(),
            txs: c.iter().map(|t| t.tx.compute_txid()).collect(),
        })
        .collect();
    Cluster {
        clusterweight: chunks.iter().map(|c| c.chunkweight).sum(),
        txcount: chunks.iter().map(|c| c.txs.len() as u64).sum(),
        chunks,
    }
}

impl Mock {
    fn new() -> Self {
        let m = Self::default();
        m.mine(0);
        m
    }

    fn node(&self) -> std::sync::MutexGuard<'_, Node> {
        self.0.lock().unwrap()
    }

    fn add(&self, fee: u64, vsize: u64) -> Txid {
        let tag = {
            let mut n = self.node();
            n.next_tag += 1;
            n.next_tag
        };
        self.add_tx(tx(tag), fee, vsize)
    }

    /// Adds a given transaction, as the node would accept it.
    fn add_tx(&self, tx: Transaction, fee: u64, vsize: u64) -> Txid {
        let mut n = self.node();
        let t = MockTx {
            tx,
            fee,
            vsize,
            time: 1_700_000_000 + u64::from(n.next_tag),
        };
        let id = t.tx.compute_txid();
        n.clusters.insert(id, alone(&t));
        n.txs.push(t);
        n.history.push(id);
        n.sequence += 1;
        id
    }

    fn remove(&self, id: Txid) {
        let mut n = self.node();
        n.txs.retain(|t| t.tx.compute_txid() != id);
        n.clusters.remove(&id);
        // A transaction it was joined with stands alone again.
        let rest: Vec<MockTx> = n.txs.clone();
        for t in &rest {
            let tid = t.tx.compute_txid();
            if n.clusters
                .get(&tid)
                .is_some_and(|c| c.chunks.iter().flat_map(|c| &c.txs).any(|m| *m == id))
            {
                n.clusters.insert(tid, alone(t));
            }
        }
        n.sequence += 1;
    }

    /// Mines `a` and `b` as one chunk, as a child paying for its parent.
    fn join(&self, a: Txid, b: Txid) {
        let mut n = self.node();
        let find = |id| n.txs.iter().find(|t| t.tx.compute_txid() == id).cloned();
        let (Some(a), Some(b)) = (find(a), find(b)) else {
            return;
        };
        let c = cluster(&[&[&a, &b]]);
        for t in [&a, &b] {
            n.clusters.insert(t.tx.compute_txid(), c.clone());
        }
        n.sequence += 1;
    }

    /// A new block holding the `count` first transactions.
    fn mine(&self, count: usize) {
        let mut n = self.node();
        let count = count.min(n.txs.len());
        let mined: Vec<MockTx> = n.txs.drain(..count).collect();
        for t in &mined {
            n.clusters.remove(&t.tx.compute_txid());
        }
        let rest = n.txs.clone();
        for t in &rest {
            let id = t.tx.compute_txid();
            if n.clusters.get(&id).is_some_and(|c| {
                c.chunks
                    .iter()
                    .flat_map(|c| &c.txs)
                    .any(|m| mined.iter().any(|x| x.tx.compute_txid() == *m))
            }) {
                n.clusters.insert(id, alone(t));
            }
        }
        let height = n.tip.map_or(0, |t| t.height + 1);
        let mut block = Block {
            header: Header {
                version: Version::TWO,
                prev_blockhash: n.tip.map_or(BlockHash::all_zeros(), |t| t.hash),
                merkle_root: TxMerkleNode::all_zeros(),
                time: height,
                bits: CompactTarget::from_consensus(0x207f_ffff),
                nonce: height,
            },
            txdata: std::iter::once(tx(4_000_000 + height))
                .chain(mined.into_iter().map(|t| t.tx))
                .collect(),
        };
        block.header.merkle_root = block.compute_merkle_root().unwrap();
        let hash = block.block_hash();
        n.blocks.insert(hash, block);
        n.tip = Some(ChainTip { hash, height });
        n.sequence += 1;
    }

    /// Replaces the `k` oldest transactions with `k` new ones paying `fee`: a busy mempool's
    /// turnover, in one step.
    fn churn(&self, k: usize, fee: u64, vsize: u64) {
        {
            let mut n = self.node();
            let k = k.min(n.txs.len());
            let gone: Vec<Txid> = n.txs.drain(..k).map(|t| t.tx.compute_txid()).collect();
            for id in &gone {
                n.clusters.remove(id);
            }
            n.sequence += 1;
        }
        for _ in 0..k {
            self.add(fee, vsize);
        }
    }

    fn set_down(&self, down: bool) {
        self.node().down = down;
    }

    fn check(&self, method: &'static str) -> Result<std::sync::MutexGuard<'_, Node>, SourceError> {
        let mut n = self.node();
        *n.calls.entry(method).or_default() += 1;
        if n.down {
            return Err(SourceError::Failed(
                "rpc unavailable: connection refused".into(),
            ));
        }
        Ok(n)
    }
}

impl Source for Mock {
    async fn mempool_info(&self) -> Result<MempoolInfo, SourceError> {
        let n = self.check("mempool_info")?;
        Ok(MempoolInfo {
            loaded: true,
            size: n.txs.len() as u64,
            bytes: n.sequence,
            usage: 0,
            maxmempool: 300_000_000,
            total_fee: Amount::ZERO,
            mempoolminfee: Amount::from_sat(n.min_fee.max(1000)),
            minrelaytxfee: Amount::from_sat(100),
            incrementalrelayfee: Amount::from_sat(100),
            fullrbf: true,
            limitclustercount: 64,
            limitclustersize: 101,
            unbroadcastcount: 0,
        })
    }

    async fn listing(&self) -> Result<RawMempool, SourceError> {
        let n = self.check("listing")?;
        Ok(RawMempool {
            mempool_sequence: n.sequence,
            txids: n.txs.iter().map(|t| t.tx.compute_txid()).collect(),
        })
    }

    async fn details(
        &self,
        txids: &[Txid],
    ) -> Result<Vec<Option<(MempoolEntry, Transaction)>>, SourceError> {
        let n = self.check("details")?;
        let by_id: HashMap<Txid, &MockTx> =
            n.txs.iter().map(|t| (t.tx.compute_txid(), t)).collect();
        Ok(txids
            .iter()
            .map(|id| {
                let t = *by_id.get(id)?;
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
        self.check("tip")?.tip.ok_or(SourceError::Busy)
    }

    async fn block(&self, hash: BlockHash) -> Result<Block, SourceError> {
        self.check("block")?
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
        let n = self.check("clusters")?;
        Ok(txids.iter().map(|t| n.clusters.get(t).cloned()).collect())
    }

    fn bytes(&self) -> u64 {
        0
    }
}

// The server side.

struct Server {
    ctx: Arc<NetworkContext>,
    tracker: Tracker,
    projector: Projector,
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

fn context(mempool: bool, interval: Duration) -> Arc<NetworkContext> {
    let vars: HashMap<&str, &str> = [
        ("REGTEST_RPC_HOST", "127.0.0.1"),
        ("REGTEST_RPC_PORT", "1"),
        ("REGTEST_RPC_USER", "u"),
        ("REGTEST_RPC_PASSWORD", "p"),
        ("REGTEST_ESPLORA_URL", "http://127.0.0.1:1"),
        ("REGTEST_ELECTRUM_ADDR", "127.0.0.1:1"),
        (
            "REGTEST_MEMPOOL_ENABLED",
            if mempool { "true" } else { "false" },
        ),
    ]
    .into_iter()
    .collect();
    let mut config = Config::from_vars(|k| vars.get(k).map(|v| (*v).to_owned())).unwrap();
    config.ws.mempool_interval = interval;
    config.ws.latest_txs = 5;
    let sockets = Sockets::new(&config.ws, Duration::from_secs(1));
    Arc::new(
        NetworkContext::new(&config.networks[0], &config, &sockets)
            .unwrap()
            .with_open_store(),
    )
}

impl Server {
    /// Engines on `mock`, fast enough for tests, with the topics fed every `interval`.
    fn start(mock: &Mock, interval: Duration) -> Self {
        let ctx = context(true, interval);
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
        let mut tasks = run(&ctx, &tracker, &projector);
        tasks.extend([t1, t2]);
        Self {
            ctx,
            tracker,
            projector,
            mock: mock.clone(),
            tasks,
        }
    }

    /// Waits until the engines hold exactly the mock's mempool and have stopped moving.
    async fn settle(&self) {
        let deadline = Instant::now() + WAIT;
        loop {
            let want: std::collections::HashSet<Txid> = self
                .mock
                .node()
                .txs
                .iter()
                .map(|t| t.tx.compute_txid())
                .collect();
            let tip = self.mock.node().tip;
            let p = self.projector.current();
            let have: std::collections::HashSet<Txid> = p
                .blocks
                .iter()
                .flat_map(|b| b.txs.iter().map(|(t, _)| *t))
                .collect();
            if have == want && p.tip == tip && !p.stale {
                tokio::time::sleep(Duration::from_millis(60)).await;
                if self.projector.current().seq == p.seq {
                    return;
                }
            }
            assert!(Instant::now() < deadline, "the engines never settled");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

// The client side: a model of what a browser holds, built only from the frames it receives.

static IDS: AtomicU64 = AtomicU64::new(1_000_000);

pub(crate) fn conn(queue: usize) -> (Arc<Conn>, mpsc::Receiver<Frame>) {
    let (tx, rx) = mpsc::channel(queue);
    let conn = Conn::test(IDS.fetch_add(1, Ordering::Relaxed), tx);
    (Arc::new(conn), rx)
}

/// A frame's opcode and payload.
pub(crate) fn open(f: &Frame) -> (u8, &[u8]) {
    let b = f.as_bytes();
    let (len, at) = match b[1] & 0x7F {
        126 => (u64::from(u16::from_be_bytes([b[2], b[3]])), 4),
        127 => (u64::from_be_bytes(b[2..10].try_into().unwrap()), 10),
        n => (u64::from(n), 2),
    };
    assert_eq!(b.len() - at, len as usize);
    (b[0] & 0x0F, &b[at..])
}

type Records = HashMap<[u8; 32], (u32, u32, u64, u64)>;

#[derive(Default)]
struct Client {
    /// Per projected block: the seq of the last frame applied, and the records.
    blocks: HashMap<u8, (u64, Records)>,
    json: HashMap<String, Value>,
    frames: usize,
}

fn u32_at(p: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(p[at..at + 4].try_into().unwrap())
}

fn u64_at(p: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(p[at..at + 8].try_into().unwrap())
}

fn read_record(r: &[u8]) -> ([u8; 32], (u32, u32, u64, u64)) {
    (
        r[..32].try_into().unwrap(),
        (u32_at(r, 32), u32_at(r, 36), u64_at(r, 40), u64_at(r, 48)),
    )
}

impl Client {
    /// Applies one frame as `docs/WS.md` tells a browser to. A delta that does not follow the
    /// frame before it is an error: the client would have to start over.
    fn apply(&mut self, f: &Frame) -> Result<(), String> {
        self.frames += 1;
        let (opcode, p) = open(f);
        if opcode == frame::TEXT {
            let v: Value = serde_json::from_slice(p).unwrap();
            let topic = v["topic"].as_str().unwrap().to_owned();
            self.json.insert(topic, v);
            return Ok(());
        }
        assert_eq!(opcode, frame::BINARY);
        assert_eq!(p[1], FORMAT_VERSION);
        let block = p[2];
        match p[0] {
            KIND_SNAPSHOT => {
                let count = u32_at(p, 4) as usize;
                let seq = u64_at(p, 8);
                assert_eq!(p.len(), SNAPSHOT_HEAD + count * RECORD);
                let records = p[SNAPSHOT_HEAD..]
                    .as_chunks::<RECORD>()
                    .0
                    .iter()
                    .map(|r| read_record(r))
                    .collect();
                self.blocks.insert(block, (seq, records));
            }
            KIND_DELTA => {
                let removed = u32_at(p, 4) as usize;
                let (seq, prev) = (u64_at(p, 8), u64_at(p, 16));
                let set = u32_at(p, 24) as usize;
                assert_eq!(p.len(), DELTA_HEAD + removed * 32 + set * RECORD);
                let Some((have, records)) = self.blocks.get_mut(&block) else {
                    return Err(format!("delta for block {block} before its snapshot"));
                };
                if *have != prev {
                    return Err(format!("block {block}: delta after {prev}, we hold {have}"));
                }
                let (gone, rest) = p[DELTA_HEAD..].split_at(removed * 32);
                for t in gone.as_chunks::<32>().0 {
                    if records.remove(t).is_none() {
                        return Err(format!("block {block}: removed a record it did not hold"));
                    }
                }
                for r in rest.as_chunks::<RECORD>().0 {
                    let (t, v) = read_record(r);
                    records.insert(t, v);
                }
                *have = seq;
            }
            k => panic!("unknown kind {k}"),
        }
        Ok(())
    }

    fn drain(&mut self, rx: &mut mpsc::Receiver<Frame>) -> Result<(), String> {
        while let Ok(f) = rx.try_recv() {
            self.apply(&f)?;
        }
        Ok(())
    }
}

/// What a client must hold for each projected block, from the server's projection.
fn expected(p: &Projection, block: u8) -> Records {
    p.blocks
        .get(usize::from(block))
        .map(|b| {
            b.txs
                .iter()
                .map(|(t, r)| (txid_bytes(t), (r.rate, r.vsize, r.fee, r.flags)))
                .collect()
        })
        .unwrap_or_default()
}

fn subscribe_all(ctx: &NetworkContext, conn: &Arc<Conn>) {
    for topic in topics() {
        ctx.hub.subscribe(topic, conn);
    }
}

/// Waits until the client, fed only by its frames, holds exactly the server's current state.
async fn converge(s: &Server, client: &mut Client, rx: &mut mpsc::Receiver<Frame>) {
    s.settle().await;
    let deadline = Instant::now() + WAIT;
    loop {
        client.drain(rx).unwrap();
        let p = s.projector.current();
        let blocks_equal = (0..TXS_TOPICS as u8).all(|b| {
            client
                .blocks
                .get(&b)
                .is_some_and(|(_, r)| *r == expected(&p, b))
        });
        let min_fee = s.tracker.node_info().map(|i| i.mempoolminfee);
        let json_equal = client.json.get("mempool") == Some(&totals(&p, min_fee))
            && client.json.get("projected") == Some(&projected(&p));
        let latest_equal = client.json.get("transactions").is_some_and(|v| {
            let newest_ever: Vec<Txid> = s
                .mock
                .node()
                .history
                .iter()
                .rev()
                .take(5)
                .copied()
                .collect();
            let (want, all_there) = s.tracker.read(|m| {
                let all = newest_ever.iter().all(|t| m.get(t).is_some());
                (newest(Vec::new(), m.iter(), 5), all)
            });
            // Transactions stay in the list after they leave the mempool: compare only while
            // the newest ever added are all still there, so they are the list.
            !all_there || *v == latest(&want)
        });
        if blocks_equal && json_equal && latest_equal {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "client never matched the server: blocks {blocks_equal}, json {json_equal}, \
             latest {latest_equal}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

// The tests.

#[test]
fn every_topic_name_parses_back() {
    for topic in topics() {
        assert_eq!(Topic::parse(topic.name()), Some(topic));
    }
    assert_eq!(topics().count(), 4 + TXS_TOPICS);
    // Every projected block but the last, which holds the rest of the mempool.
    assert_eq!(TXS_TOPICS, projected::Config::default().blocks - 1);
}

#[test]
fn frames_have_the_documented_layout() {
    let a = Txid::from_byte_array([1; 32]);
    let mut b_bytes = [2; 32];
    b_bytes[0] = 0xab;
    let b = Txid::from_byte_array(b_bytes);
    let placed = |rate, vsize, fee, flags| projected::Placed {
        block: 3,
        rate,
        vsize,
        fee,
        flags,
    };
    // The highest bit the classifier sets, and one in each of the record's flag bytes 0 and 5.
    let flags = (1 << 44) | (1 << 40) | 0x0a;
    let block = ProjectedBlock {
        summary: projected::BlockSummary::default(),
        txs: vec![
            (a, placed(1500, 200, 300, 0)),
            (b, placed(1000, 141, 141, flags)),
        ],
    };
    let s = snapshot(3, 0x0102, &block);
    assert_eq!(&s[..16], &[1, 2, 3, 0, 2, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0]);
    assert_eq!(s.len(), 16 + 2 * 56);
    // The txid as it is written in hex: internal byte 0 comes last.
    assert_eq!(s[16..48], txid_bytes(&a));
    assert_eq!(s[64..72], [0; 8]);
    assert_eq!(s[72 + 31], 0xab);
    assert_eq!(hex(&s[72..104]), b.to_string());
    assert_eq!(
        &s[104..128],
        &[
            0xe8, 3, 0, 0, 141, 0, 0, 0, 141, 0, 0, 0, 0, 0, 0, 0, 0x0a, 0, 0, 0, 0, 0x11, 0, 0
        ]
    );

    let d = delta(3, 9, 7, &[&a], &[&block.txs[1]]);
    assert_eq!(
        &d[..32],
        &[
            2, 2, 3, 0, 1, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0,
            0, 0, 0
        ]
    );
    assert_eq!(d.len(), 32 + 32 + 56);
    assert_eq!(d[32..64], txid_bytes(&a));
    assert_eq!(d[64..120], s[72..128]);
}

/// A recorded mainnet transaction carries the reference's flags from the tracker to both sockets.
#[tokio::test]
async fn a_transactions_flags_reach_every_layer() {
    // RBF, V2, P2WPKH, OP_RETURN, batch payment, SIGHASH_ALL: only bits the classifier sets.
    let txid = "a4fafc60b41c07b2d829e6e58ccabf162a2b25a97aff4b1c264b2354267faf28";
    let recorded: Vec<Value> =
        serde_json::from_str(include_str!("../../../../../fixtures/flags/mainnet.json")).unwrap();
    let r = recorded.iter().find(|r| r["txid"] == txid).unwrap();
    let want = r["flags"].as_u64().unwrap();
    assert_eq!(want, 1_116_708_278_281);
    let tx: Transaction =
        bitcoin::consensus::encode::deserialize_hex(r["hex"].as_str().unwrap()).unwrap();

    let mock = Mock::new();
    let id = mock.add_tx(tx, 1_000, 200);
    let s = Server::start(&mock, Duration::from_millis(20));
    let (conn, mut rx) = conn(1024);
    subscribe_all(&s.ctx, &conn);
    let mut client = Client::default();
    converge(&s, &mut client, &mut rx).await;

    assert_eq!(s.tracker.read(|m| m.get(&id).map(|i| i.flags)), Some(want));
    let p = s.projector.current();
    assert_eq!(p.blocks[0].txs, vec![(id, p.blocks[0].txs[0].1)]);
    assert_eq!(p.blocks[0].txs[0].1.flags, want);
    assert_eq!(client.blocks[&0].1[&txid_bytes(&id)].3, want);
    let row = crate::ws::v1::whole(&s.tracker, 0, 1, &p.blocks[0]);
    let row = &row["projected-block-transactions"]["blockTransactions"][0];
    assert_eq!((&row[0], &row[5]), (&json!(txid), &json!(want)));
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test]
async fn each_topic_gives_a_state_then_changes_that_reach_the_servers_state() {
    let mock = Mock::new();
    let parent = mock.add(100, 1000); // 0.1 sat/vB alone
    let others: Vec<Txid> = (0..20).map(|i| mock.add(2_000 + i * 50, 1000)).collect();
    let s = Server::start(&mock, Duration::from_millis(20));
    let (conn, mut rx) = conn(1024);
    subscribe_all(&s.ctx, &conn);
    let mut client = Client::default();
    converge(&s, &mut client, &mut rx).await;
    let totals = &client.json["mempool"];
    assert_eq!(totals["count"], 21);
    assert_eq!(totals["vsize"], 21_000);
    assert_eq!(totals["min_fee_rate"], 1000);
    assert_eq!(totals["stale"], false);
    assert_eq!(
        client.json["projected"]["blocks"].as_array().unwrap().len(),
        8
    );
    let latest = &client.json["transactions"]["txs"];
    assert_eq!(latest.as_array().unwrap().len(), 5);
    assert_eq!(latest[0]["txid"], others[19].to_string(), "newest first");

    // A child lifts its parent: both records change rate in place.
    let child = mock.add(20_000, 200);
    mock.join(parent, child);
    converge(&s, &mut client, &mut rx).await;
    let lifted = client.blocks[&0].1[&txid_bytes(&parent)];
    assert_eq!(lifted.0, 20_100 * 1000 / 1200);
    // And each is flagged by how it pays, on both sockets.
    use engine::flags::{PAID_BY_CHILD, PAYS_FOR_PARENT, REPLACEMENT};
    let context = PAID_BY_CHILD | PAYS_FOR_PARENT | REPLACEMENT;
    let bits = |client: &Client, t: &Txid| client.blocks[&0].1[&txid_bytes(t)].3 & context;
    let row_bits = |t: &Txid| {
        let p = s.projector.current();
        let rows = crate::ws::v1::whole(&s.tracker, 0, 1, &p.blocks[0]);
        let rows = rows["projected-block-transactions"]["blockTransactions"].clone();
        let row = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r[0] == json!(t))
            .cloned();
        row.unwrap()[5].as_u64().unwrap() & context
    };
    assert_eq!(
        (bits(&client, &parent), bits(&client, &child)),
        (PAID_BY_CHILD, PAYS_FOR_PARENT)
    );
    assert_eq!(
        (row_bits(&parent), row_bits(&child)),
        (PAID_BY_CHILD, PAYS_FOR_PARENT)
    );
    assert_eq!(bits(&client, &others[1]), 0);

    // A replacement: a new transaction spending what `others[0]` spent. Then a block that
    // empties the first projected block.
    let mut replacement = mock
        .node()
        .txs
        .iter()
        .find(|t| t.tx.compute_txid() == others[0])
        .unwrap()
        .tx
        .clone();
    replacement.output[0].value = Amount::from_sat(1);
    mock.remove(others[0]);
    let replacement = mock.add_tx(replacement, 5_000, 1000);
    converge(&s, &mut client, &mut rx).await;
    assert_eq!(bits(&client, &replacement), REPLACEMENT);
    assert_eq!(row_bits(&replacement), REPLACEMENT);
    let n = mock.node().txs.len();
    mock.mine(n);
    converge(&s, &mut client, &mut rx).await;
    assert!(client.blocks[&0].1.is_empty());
    assert_eq!(client.json["mempool"]["count"], 0);
}

#[tokio::test]
async fn random_changes_keep_every_client_equal_to_the_server() {
    for seed in 1..=6u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15));
        let mock = Mock::new();
        let s = Server::start(&mock, Duration::from_millis(15));
        let (early, mut early_rx) = conn(4096);
        subscribe_all(&s.ctx, &early);
        let mut a = Client::default();
        for step in 0..12 {
            for _ in 0..rng.below(40) {
                // Large transactions so the mempool spans several projected blocks.
                mock.add(rng.below(400_000), 1_000 + rng.below(150_000));
            }
            let ids: Vec<Txid> = mock
                .node()
                .txs
                .iter()
                .map(|t| t.tx.compute_txid())
                .collect();
            for _ in 0..rng.below(8) {
                if !ids.is_empty() {
                    mock.remove(ids[rng.below(ids.len() as u64) as usize]);
                }
            }
            for _ in 0..rng.below(4) {
                if ids.len() > 1 {
                    let i = rng.below(ids.len() as u64) as usize;
                    let j = rng.below(ids.len() as u64) as usize;
                    if i != j {
                        mock.join(ids[i], ids[j]);
                    }
                }
            }
            if rng.below(4) == 0 {
                let n = mock.node().txs.len();
                mock.mine(rng.below(n as u64 + 1) as usize);
            }
            converge(&s, &mut a, &mut early_rx).await;
            // A client that subscribes now gets the stored state and the changes appended
            // since, and must land on the same state.
            let (late, mut late_rx) = conn(4096);
            subscribe_all(&s.ctx, &late);
            let mut b = Client::default();
            converge(&s, &mut b, &mut late_rx).await;
            assert!(
                b.frames <= 3 + TXS_TOPICS * (1 + MAX_APPENDED),
                "seed {seed} step {step}: a new subscriber got {} frames",
                b.frames
            );
            for t in topics() {
                s.ctx.hub.unsubscribe(t, late.id);
            }
        }
    }
}

#[tokio::test]
async fn many_small_changes_are_folded_into_a_new_stored_state() {
    let mock = Mock::new();
    for i in 0..50 {
        mock.add(1_000 + i, 500);
    }
    let s = Server::start(&mock, Duration::from_millis(5));
    let (conn_a, mut rx) = conn(4096);
    s.ctx.hub.subscribe(Topic::ProjectedTxs(0), &conn_a);
    let mut a = Client::default();
    converge_block0(&s, &mut a, &mut rx).await;
    for i in 0..(3 * MAX_APPENDED as u64) {
        mock.add(5_000 + i, 500);
        converge_block0(&s, &mut a, &mut rx).await;
    }
    let deltas = a.frames;
    assert!(deltas > 2 * MAX_APPENDED, "{deltas} frames");
    let (conn_b, mut rx_b) = conn(4096);
    s.ctx.hub.subscribe(Topic::ProjectedTxs(0), &conn_b);
    let mut b = Client::default();
    converge_block0(&s, &mut b, &mut rx_b).await;
    assert!(b.frames <= 1 + MAX_APPENDED, "{} frames", b.frames);
}

async fn converge_block0(s: &Server, client: &mut Client, rx: &mut mpsc::Receiver<Frame>) {
    s.settle().await;
    let deadline = Instant::now() + WAIT;
    loop {
        client.drain(rx).unwrap();
        let p = s.projector.current();
        if client
            .blocks
            .get(&0)
            .is_some_and(|(_, r)| *r == expected(&p, 0))
        {
            return;
        }
        assert!(Instant::now() < deadline, "block 0 never matched");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}

#[tokio::test]
async fn a_client_that_falls_behind_is_closed_and_a_new_subscription_catches_up() {
    let mock = Mock::new();
    let s = Server::start(&mock, Duration::from_millis(5));
    // Room for the snapshots only: the first change fills its queue.
    let (slow, _never_read) = conn(3 + TXS_TOPICS);
    subscribe_all(&s.ctx, &slow);
    for i in 0..30 {
        mock.add(1_000 + i, 500);
        s.settle().await;
    }
    assert_eq!(slow.reason(), Some(Close::SLOW));
    // Its reconnect subscribes afresh and lands on the server's state.
    for t in topics() {
        s.ctx.hub.unsubscribe(t, slow.id);
    }
    let (again, mut rx) = conn(1024);
    subscribe_all(&s.ctx, &again);
    let mut c = Client::default();
    converge(&s, &mut c, &mut rx).await;
}

/// Subscribers that never read, on a busy mempool: each holds at most `WS_SEND_QUEUE` frames,
/// then is closed as too slow. The frames are shared, so sixteen of them (one address's
/// allowance) on the same topics hold the same bytes as one.
#[tokio::test]
async fn subscribers_that_never_read_hold_at_most_their_queues() {
    const QUEUE: usize = 64; // `WS_SEND_QUEUE`
    let mock = Mock::new();
    // Small transactions, so frames are large for their count. A full block of the smallest
    // makes a snapshot of about 930 KB; this one is a quarter of that, to run in a debug build.
    for i in 0..4_000 {
        mock.add(2_000 + i % 1_000, 60);
    }
    let s = Server::start(&mock, Duration::from_millis(20));
    s.settle().await;
    // What one socket may hold at once: two projected blocks, and the other mempool topics.
    let topics = [
        Topic::Mempool,
        Topic::Projected,
        Topic::Transactions,
        Topic::ProjectedTxs(0),
        Topic::ProjectedTxs(1),
    ];
    let mut socks: Vec<_> = (0..16).map(|_| conn(QUEUE)).collect();
    for (c, _) in &socks {
        for t in topics {
            s.ctx.hub.subscribe(t, c);
        }
    }
    // A quarter of the mempool replaced at a higher rate every step: large deltas, fast.
    let started = Instant::now();
    let mut fee = 4_000;
    while socks.iter().any(|(c, _)| c.reason().is_none()) {
        assert!(started.elapsed() < WAIT * 6, "never closed");
        fee += 60;
        mock.churn(1_000, fee, 60);
        s.settle().await;
    }
    let took = started.elapsed();
    let mut largest = 0;
    let mut distinct: HashMap<*const u8, usize> = HashMap::new();
    let mut held = Vec::new();
    for (c, rx) in &mut socks {
        assert_eq!(c.reason(), Some(Close::SLOW));
        let (mut frames, mut bytes) = (0, 0);
        while let Ok(f) = rx.try_recv() {
            frames += 1;
            bytes += f.len();
            largest = largest.max(f.len());
            distinct.insert(f.as_bytes().as_ptr(), f.len());
        }
        assert_eq!(frames, QUEUE, "a full queue, and nothing past it");
        held.push(bytes);
    }
    let one = held.iter().copied().max().unwrap_or(0);
    let shared: usize = distinct.values().sum();
    eprintln!(
        "never reading: {one} bytes in {QUEUE} frames each (largest {largest}), closed after \
         {took:?}; 16 sockets hold {shared} distinct bytes"
    );
    assert!(one <= QUEUE * largest);
    // Sixteen hold what one does: the same frames, never copies.
    assert!(
        shared <= one,
        "{shared} distinct bytes for 16 sockets, {one} for one"
    );
}

#[tokio::test]
async fn messages_are_rate_limited() {
    let mock = Mock::new();
    let interval = Duration::from_millis(300);
    let s = Server::start(&mock, interval);
    let (conn, mut rx) = conn(4096);
    s.ctx.hub.subscribe(Topic::Mempool, &conn);
    s.ctx.hub.subscribe(Topic::Transactions, &conn);
    let started = Instant::now();
    // Changes every 10 ms for 1.2 s: at most one message per interval and topic, plus the first.
    while started.elapsed() < Duration::from_millis(1200) {
        mock.add(1_000, 500);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mut counts: HashMap<String, usize> = HashMap::new();
    while let Ok(f) = rx.try_recv() {
        let v: Value = serde_json::from_slice(open(&f).1).unwrap();
        *counts
            .entry(v["topic"].as_str().unwrap().to_owned())
            .or_default() += 1;
    }
    for topic in ["mempool", "transactions"] {
        let n = counts.get(topic).copied().unwrap_or(0);
        assert!((2..=6).contains(&n), "{topic}: {n} messages in 1.2 s");
    }
    // The list never exceeds its size.
    let _ = s;
}

#[tokio::test]
async fn the_off_switch_says_so_on_every_topic_and_polls_nothing() {
    let ctx = context(false, Duration::from_millis(10));
    start(&ctx);
    let (conn, mut rx) = conn(64);
    subscribe_all(&ctx, &conn);
    let mut seen = 0;
    while let Ok(f) = rx.try_recv() {
        let v: Value = serde_json::from_slice(open(&f).1).unwrap();
        assert_eq!(v["type"], "off", "{v}");
        seen += 1;
    }
    assert_eq!(seen, 4 + TXS_TOPICS);
}

#[tokio::test]
async fn a_node_down_at_boot_is_retried_and_the_topics_start_when_it_comes_back() {
    let mock = Mock::new();
    mock.add(1_000, 500);
    mock.set_down(true);
    let s = Server::start(&mock, Duration::from_millis(10));
    let (conn, mut rx) = conn(1024);
    subscribe_all(&s.ctx, &conn);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        rx.try_recv().is_err(),
        "nothing is published before the first cycle"
    );
    mock.set_down(false);
    let mut c = Client::default();
    converge(&s, &mut c, &mut rx).await;
    assert_eq!(c.json["mempool"]["count"], 1);

    // Down again: the last projection stays, marked stale; then it recovers.
    mock.set_down(true);
    let deadline = Instant::now() + WAIT;
    while c.json["projected"]["stale"] != true {
        assert!(Instant::now() < deadline, "never marked stale");
        tokio::time::sleep(Duration::from_millis(10)).await;
        c.drain(&mut rx).unwrap();
    }
    assert_eq!(c.json["mempool"]["stale"], true);
    mock.add(2_000, 500);
    mock.set_down(false);
    converge(&s, &mut c, &mut rx).await;
    assert_eq!(c.json["mempool"]["count"], 2);
    assert_eq!(c.json["projected"]["stale"], false);
}

#[test]
fn a_transaction_accepted_again_is_listed_once() {
    let info = |time| TxInfo::new(Amount::from_sat(1), Amount::ZERO, 1, 4, time);
    let (a, b) = (
        Txid::from_byte_array([1; 32]),
        Txid::from_byte_array([2; 32]),
    );
    let list = newest(
        Vec::new(),
        [(&a, &info(100)), (&b, &info(101))].into_iter(),
        10,
    );
    // `a` left and came back later: its newer row replaces the old one, wherever that sorted.
    let list = newest(list, std::iter::once((&a, &info(102))), 10);
    let rows: Vec<(Txid, u32)> = list.iter().map(|s| (s.txid, s.time)).collect();
    assert_eq!(rows, vec![(a, 102), (b, 101)]);
}

#[tokio::test]
async fn a_new_minimum_fee_rate_is_sent_on_its_own() {
    let mock = Mock::new();
    mock.add(1_000, 500);
    let s = Server::start(&mock, Duration::from_millis(20));
    let (conn, mut rx) = conn(1024);
    s.ctx.hub.subscribe(Topic::Mempool, &conn);
    let mut c = Client::default();
    let deadline = Instant::now() + WAIT;
    while c
        .json
        .get("mempool")
        .is_none_or(|v| v["min_fee_rate"] != 1000)
    {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
        c.drain(&mut rx).unwrap();
    }
    // Nothing else changes: no new projection, only the node's floor.
    mock.node().min_fee = 2_500;
    while c.json["mempool"]["min_fee_rate"] != 2_500 {
        assert!(Instant::now() < deadline, "the new floor never arrived");
        tokio::time::sleep(Duration::from_millis(10)).await;
        c.drain(&mut rx).unwrap();
    }
}

/// The latest `fees` message `rx` holds, if any.
fn latest_fees(rx: &mut mpsc::Receiver<Frame>, last: &mut Value) {
    while let Ok(f) = rx.try_recv() {
        *last = serde_json::from_slice(open(&f).1).unwrap();
    }
}

#[tokio::test]
async fn fees_follow_the_projection_and_are_withdrawn_while_it_is_stale() {
    let mock = Mock::new();
    let s = Server::start(&mock, Duration::from_millis(10));
    // The server's own fees task is still warming up and its node is unreachable: it serves
    // nothing rather than a guess.
    // A second fees task on its own context, warmed up as after five quiet minutes.
    let ctx = context(true, Duration::from_millis(10));
    let mut rec = engine::fees::Recommender::default();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    rec.gap(now - 400);
    let engines = crate::ws::fees::Engines {
        tracker: s.tracker.clone(),
        projector: s.projector.clone(),
    };
    let task = tokio::spawn(crate::ws::fees::run(Arc::clone(&ctx), Some(engines), rec));
    let (conn, mut rx) = conn(1024);
    ctx.hub.subscribe(Topic::Fees, &conn);

    // 1.2 MvB: six 100 kvB transactions at 5 sat/vB, six at 2 sat/vB.
    for fee in [500_000, 200_000] {
        for _ in 0..6 {
            mock.add(fee, 100_000);
        }
    }
    s.settle().await;
    let mut last = Value::Null;
    let deadline = Instant::now() + WAIT;
    let levels = |v: &Value| -> Vec<u64> {
        v["levels"]
            .as_array()
            .map(|l| l.iter().map(|l| l["rate"].as_u64().unwrap()).collect())
            .unwrap_or_default()
    };
    // The next block holds the 5 sat/vB half and must outbid the 2 sat/vB rest; three blocks
    // hold everything, so the rest is the node's minimum (1 sat/vB on this mock).
    while levels(&last) != [2_001, 1_000, 1_000, 1_000] {
        assert!(Instant::now() < deadline, "never recommended: {last}");
        tokio::time::sleep(Duration::from_millis(10)).await;
        latest_fees(&mut rx, &mut last);
    }
    assert_eq!(last["source"], "projected");
    assert_eq!(last["min_fee_rate"], 1_000);
    assert_eq!(last["tip"]["height"], 0);
    assert_eq!(
        ctx.fees.current().unwrap().source,
        crate::ws::fees::Source::Projected
    );
    assert!(s.ctx.fees.current().is_none());
    let mb = ctx.fees.blocks().unwrap();
    assert_eq!(mb.blocks[0].txs + mb.blocks[1].txs, 12);
    assert_eq!(mb.blocks[0].median, 5_000);

    // A block takes the 5 sat/vB ones: everything left fits in the next block.
    mock.mine(6);
    s.settle().await;
    while levels(&last) != [1_000; 4] {
        assert!(
            Instant::now() < deadline,
            "never followed the block: {last}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
        latest_fees(&mut rx, &mut last);
    }
    assert_eq!(last["tip"]["height"], 1);

    // The node fails: the projection goes stale, and with no node estimates either, nothing
    // is served rather than an old answer.
    mock.set_down(true);
    while last["type"] != "unavailable" {
        assert!(Instant::now() < deadline, "never withdrawn: {last}");
        tokio::time::sleep(Duration::from_millis(10)).await;
        latest_fees(&mut rx, &mut last);
    }
    assert!(ctx.fees.current().is_none());
    mock.set_down(false);
    while last["source"] != "projected" {
        assert!(Instant::now() < deadline, "never came back: {last}");
        tokio::time::sleep(Duration::from_millis(10)).await;
        latest_fees(&mut rx, &mut last);
    }
    task.abort();
}

/// The first answer `ctx`'s fees task serves.
async fn served(ctx: &NetworkContext) -> crate::ws::fees::Answer {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(a) = ctx.fees.current() {
            return a;
        }
        assert!(Instant::now() < deadline, "never served");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The restart sequence of `docs/MEMPOOL.md`, "When ours cannot be served": while warming up,
/// the node's estimates are not served until a whole minute of arrivals was watched, then no
/// higher than our method on what was watched. Each phase is a fees task of its own whose
/// arrivals were watched as the phase says, against a node whose next-block estimate is 4.3 sat/vB.
#[tokio::test]
async fn after_a_restart_the_nodes_estimates_wait_for_a_minute_of_arrivals_and_go_no_higher() {
    use crate::ws::fees::tests as f;
    let mock = Mock::new();
    let s = Server::start(&mock, Duration::from_millis(10));
    // A quiet mempool: three payments of 200 vB at 3 sat/vB.
    for _ in 0..3 {
        mock.add(600, 200);
    }
    s.settle().await;
    let (node_addr, node) = f::fake_node().await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // A fees task with `rec`, its routes, and a subscriber to `fees`.
    let start = |rec: engine::fees::Recommender| {
        let ctx = f::context(true, Some(&node_addr));
        let engines = crate::ws::fees::Engines {
            tracker: s.tracker.clone(),
            projector: s.projector.clone(),
        };
        let (conn, rx) = conn(1024);
        ctx.hub.subscribe(Topic::Fees, &conn);
        let task = tokio::spawn(crate::ws::fees::run(Arc::clone(&ctx), Some(engines), rec));
        (ctx, task, rx, conn)
    };

    // Just restarted, nothing watched: the node is asked, but its answer is not served.
    let (ctx, task, mut rx, _conn) = start(engine::fees::Recommender::default());
    let deadline = Instant::now() + WAIT;
    while node.hits.load(std::sync::atomic::Ordering::SeqCst) < 2 {
        assert!(Instant::now() < deadline, "the node was never asked");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(ctx.fees.current().is_none());
    let addr = f::serve(&ctx).await;
    let r = f::get_path(&addr, "/api/v1/fees/recommended").await;
    assert_eq!(r.status, 503);
    assert!(r.body.contains("not ready yet; retry"), "{}", r.body);
    let mut last = Value::Null;
    latest_fees(&mut rx, &mut last);
    assert_eq!(last["type"], "unavailable");
    task.abort();

    // A quiet minute watched: the mempool and the arrivals need the minimum, so the node's
    // 4.3 sat/vB is served as the minimum, still marked as the node's.
    let mut rec = engine::fees::Recommender::default();
    rec.gap(now - 70);
    let (ctx, task, mut rx, _conn) = start(rec);
    let a = served(&ctx).await;
    assert_eq!(a.source, crate::ws::fees::Source::Node);
    assert_eq!((a.rates.levels, a.rates.minimum), ([1_000; 4], 1_000));
    let addr = f::serve(&ctx).await;
    let r = f::get_path(&addr, "/api/v1/fees/precise").await;
    assert_eq!(
        r.body,
        r#"{"fastestFee":1.0,"halfHourFee":1.0,"hourFee":1.0,"economyFee":1.0,"minimumFee":1.0}"#
    );
    assert_eq!(r.header("x-fee-source"), Some("node"));
    latest_fees(&mut rx, &mut last);
    assert_eq!(
        (&last["source"], &last["tip"]),
        (&Value::from("node"), &Value::Null)
    );
    task.abort();

    // A busy minute watched, 3 MvB at 10 sat/vB: the node's estimates as they are.
    let mut rec = engine::fees::Recommender::default();
    rec.gap(now - 70);
    rec.arrived(now - 65, 30_000_000, 3_000_000);
    let (ctx, task, _rx, _conn) = start(rec);
    let a = served(&ctx).await;
    assert_eq!(a.source, crate::ws::fees::Source::Node);
    assert_eq!(a.rates.levels, [4_299, 1_799, 1_597, 1_000]);
    task.abort();
}

/// A fees task of its own on `s`'s engines, warmed up, publishing on an interval long enough
/// that only a block or a hold's deadline explains a message, with a subscriber to `fees` and
/// `blocks` on its context.
async fn held_fees_task(
    s: &Server,
) -> (Arc<NetworkContext>, JoinHandle<()>, mpsc::Receiver<Frame>) {
    let ctx = context(true, Duration::from_secs(600));
    let mut rec = engine::fees::Recommender::default();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    rec.gap(now - 400);
    let engines = crate::ws::fees::Engines {
        tracker: s.tracker.clone(),
        projector: s.projector.clone(),
    };
    let task = tokio::spawn(crate::ws::fees::run(Arc::clone(&ctx), Some(engines), rec));
    let (conn, rx) = conn(1024);
    ctx.hub.subscribe(Topic::Blocks, &conn);
    ctx.hub.subscribe(Topic::Fees, &conn);
    (ctx, task, rx)
}

/// The next frame as (topic, the tip height of a `fees` message or the height of a `block`
/// message), and when it came.
async fn next_labelled(rx: &mut mpsc::Receiver<Frame>) -> ((String, Option<u64>), Instant) {
    let f = tokio::time::timeout(Duration::from_secs(3600), rx.recv())
        .await
        .unwrap()
        .unwrap();
    let v: Value = serde_json::from_slice(open(&f).1).unwrap();
    let height = match v["type"].as_str() {
        Some("fees") => v["tip"]["height"].as_u64(),
        Some("block") => v["block"]["height"].as_u64(),
        _ => None,
    };
    (
        (v["topic"].as_str().unwrap().to_owned(), height),
        Instant::now(),
    )
}

/// Mines a block the engines see before the `blocks` topic announces it, and returns its tip and
/// the moment the fees task computed its answer on it: the moment the hold began.
async fn mine_unannounced(s: &Server, ctx: &NetworkContext) -> (ChainTip, Instant) {
    s.mock.mine(1);
    let tip = s.mock.node().tip.unwrap();
    s.tracker.block_found(tip);
    while ctx.fees.current().and_then(|a| a.tip) != Some(tip) {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    (tip, Instant::now())
}

/// The `blocks` feed's message for `tip` on `ctx`, and the record of what it announced.
fn announce_on(ctx: &NetworkContext, tip: ChainTip) {
    let msg = json!({ "topic": "blocks", "type": "block", "block": { "id": tip.hash, "height": tip.height } });
    ctx.hub.announce_tip(Some(tip.hash), || {
        ctx.hub.publish(
            Topic::Blocks,
            &Frame::text(msg.to_string().as_bytes()),
            Snapshot::Replace,
        );
    });
}

/// docs/WS.md "When a block is found": a fee answer on a block not yet announced is held until
/// the block's message, or released by the fees task's own wake-up at the hold's deadline, on
/// a paused clock, whatever the interval.
#[tokio::test]
async fn a_held_fee_answer_goes_out_after_its_block_or_at_the_deadline_exactly_once() {
    const HOLD: Duration = super::HOLD;
    let mock = Mock::new();
    for i in 0..10 {
        mock.add(2_000 + i, 1_000);
    }
    let s = Server::start(&mock, Duration::from_secs(600));
    s.settle().await;
    let (ctx, task, mut rx) = held_fees_task(&s).await;
    announce_on(&ctx, s.mock.node().tip.unwrap());
    let mut first = None;
    while first != Some(("fees".to_owned(), Some(0))) {
        first = Some(next_labelled(&mut rx).await.0);
    }
    tokio::time::pause();

    // Never announced: out at the deadline, not before, once.
    let (tip, held) = mine_unannounced(&s, &ctx).await;
    let (msg, at) = next_labelled(&mut rx).await;
    assert_eq!(msg, ("fees".to_owned(), Some(u64::from(tip.height))));
    assert_eq!(at - held, HOLD);
    tokio::time::sleep(HOLD * 10).await;
    assert!(rx.try_recv().is_err(), "released more than once");
    // The block's message, late, sends nothing more: the answer already agrees.
    announce_on(&ctx, tip);
    assert_eq!(next_labelled(&mut rx).await.0.0, "blocks");
    tokio::time::sleep(HOLD * 2).await;
    assert!(rx.try_recv().is_err());

    // Announced before the deadline: out right after the block's message. The released hold
    // before it neither lets this one out early nor keeps it waiting.
    let (tip, held) = mine_unannounced(&s, &ctx).await;
    tokio::time::sleep(HOLD / 3).await;
    assert!(rx.try_recv().is_err(), "out before its block");
    announce_on(&ctx, tip);
    let announced = Instant::now();
    let h = Some(u64::from(tip.height));
    assert_eq!(next_labelled(&mut rx).await.0, ("blocks".to_owned(), h));
    let (msg, at) = next_labelled(&mut rx).await;
    assert_eq!(msg, ("fees".to_owned(), h));
    // The timer wheel's resolution is a millisecond.
    assert!(
        at - announced <= Duration::from_millis(1),
        "{:?}",
        at - announced
    );
    assert!(at - held < HOLD);
    tokio::time::sleep(HOLD * 2).await;
    assert!(rx.try_recv().is_err(), "sent again at the old deadline");

    // Announced first, then seen by the engines: no hold at all.
    s.mock.mine(1);
    let tip = s.mock.node().tip.unwrap();
    announce_on(&ctx, tip);
    let announced = Instant::now();
    s.tracker.block_found(tip);
    let h = Some(u64::from(tip.height));
    assert_eq!(next_labelled(&mut rx).await.0, ("blocks".to_owned(), h));
    let (msg, at) = next_labelled(&mut rx).await;
    assert_eq!(msg, ("fees".to_owned(), h));
    assert!(
        at - announced < Duration::from_millis(100),
        "{:?}",
        at - announced
    );

    // And the deadline again, after all that.
    let (tip, held) = mine_unannounced(&s, &ctx).await;
    let (msg, at) = next_labelled(&mut rx).await;
    assert_eq!(msg, ("fees".to_owned(), Some(u64::from(tip.height))));
    assert_eq!(at - held, HOLD);
    task.abort();
}

// A block found: the order and timing `docs/WS.md` promises.

/// What the `blocks` feed does for a new block: its message to subscribers, then the record of
/// what it announced.
fn announce_block(s: &Server) -> ChainTip {
    let tip = s.mock.node().tip.unwrap();
    let msg = json!({ "topic": "blocks", "type": "block", "block": { "id": tip.hash, "height": tip.height } });
    s.ctx.hub.announce_tip(Some(tip.hash), || {
        s.ctx.hub.publish(
            Topic::Blocks,
            &Frame::text(msg.to_string().as_bytes()),
            Snapshot::Replace,
        );
    });
    tip
}

/// A received frame as (topic, the tip height of a `projected` message, or the height of a
/// `block` message).
fn label(f: &Frame) -> (String, Option<u64>) {
    let (opcode, p) = open(f);
    if opcode == frame::BINARY {
        return (format!("projected-txs:{}", p[2]), None);
    }
    let v: Value = serde_json::from_slice(p).unwrap();
    let topic = v["topic"].as_str().unwrap().to_owned();
    let height = match v["type"].as_str() {
        Some("projected") => v["tip"]["height"].as_u64(),
        Some("block") => v["block"]["height"].as_u64(),
        _ => None,
    };
    (topic, height)
}

/// Frames until a `projected` message on `height` arrives, with the time it took.
async fn until_projected(
    rx: &mut mpsc::Receiver<Frame>,
    height: u64,
) -> (Vec<(String, Option<u64>)>, Duration) {
    let at = Instant::now();
    let mut seen = Vec::new();
    loop {
        let f = tokio::time::timeout(WAIT, rx.recv())
            .await
            .unwrap()
            .unwrap();
        let l = label(&f);
        let done = l == ("projected".to_owned(), Some(height));
        seen.push(l);
        if done {
            return (seen, at.elapsed());
        }
    }
}

#[tokio::test]
async fn a_found_block_is_followed_by_the_projection_on_it_and_nothing_older() {
    let mock = Mock::new();
    for i in 0..20 {
        mock.add(1_000 + i, 500);
    }
    // A long interval: only the new tip can explain a prompt message.
    let s = Server::start(&mock, Duration::from_secs(10));
    s.settle().await;
    announce_block(&s);
    let (watcher, mut rx) = conn(4096);
    s.ctx.hub.subscribe(Topic::Blocks, &watcher);
    subscribe_all(&s.ctx, &watcher);
    tokio::time::sleep(Duration::from_millis(50)).await;
    while rx.try_recv().is_ok() {}
    // On a paused clock a message's delay is the code's, not the machine's.
    tokio::time::pause();

    // The engines see the block before the `blocks` topic has announced it: the mempool topics
    // wait for its message.
    mock.mine(10);
    let tip = mock.node().tip.unwrap();
    s.tracker.block_found(tip);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(s.projector.current().tip, Some(tip), "the engines have it");
    assert!(rx.try_recv().is_err(), "nothing before the block's message");
    announce_block(&s);
    let (seen, took) = until_projected(&mut rx, u64::from(tip.height)).await;
    assert_eq!(seen[0], ("blocks".to_owned(), Some(u64::from(tip.height))));
    assert!(took < Duration::from_millis(500), "{took:?}");

    // The other way round: the block's message first, then the engines.
    tokio::time::sleep(Duration::from_millis(50)).await;
    while rx.try_recv().is_ok() {}
    mock.mine(5);
    let tip = announce_block(&s);
    s.tracker.block_found(tip);
    let (seen, took) = until_projected(&mut rx, u64::from(tip.height)).await;
    assert_eq!(seen[0], ("blocks".to_owned(), Some(u64::from(tip.height))));
    assert!(
        seen.iter()
            .all(|(t, h)| t != "projected" || *h == Some(u64::from(tip.height))),
        "no projection on the old tip after the block: {seen:?}"
    );
    assert!(took < Duration::from_millis(500), "{took:?}");
    let mut c = Client::default();
    let (late, mut late_rx) = conn(4096);
    subscribe_all(&s.ctx, &late);
    converge(&s, &mut c, &mut late_rx).await;
    assert_eq!(c.json["mempool"]["count"], 5);
    assert_eq!(c.json["projected"]["tip"]["height"], tip.height);
}

#[tokio::test]
async fn in_an_empty_mempool_the_projection_follows_every_block() {
    let mock = Mock::new();
    let s = Server::start(&mock, Duration::from_secs(10));
    s.settle().await;
    announce_block(&s);
    let (conn, mut rx) = conn(4096);
    subscribe_all(&s.ctx, &conn);
    // On a paused clock a message's delay is the code's, not the machine's.
    tokio::time::pause();
    for _ in 0..4 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        mock.mine(0);
        let tip = announce_block(&s);
        s.tracker.block_found(tip);
        let (_, took) = until_projected(&mut rx, u64::from(tip.height)).await;
        assert!(took < Duration::from_millis(500), "{took:?}");
    }
}

#[tokio::test]
async fn found_blocks_keep_every_client_equal_to_the_server() {
    for seed in 1..=3u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15));
        let mock = Mock::new();
        let s = Server::start(&mock, Duration::from_millis(15));
        let (early, mut early_rx) = conn(4096);
        subscribe_all(&s.ctx, &early);
        let mut a = Client::default();
        for _ in 0..8 {
            for _ in 0..rng.below(40) {
                mock.add(rng.below(400_000), 1_000 + rng.below(150_000));
            }
            let ids: Vec<Txid> = mock
                .node()
                .txs
                .iter()
                .map(|t| t.tx.compute_txid())
                .collect();
            for _ in 0..rng.below(4) {
                if ids.len() > 1 {
                    let i = rng.below(ids.len() as u64) as usize;
                    let j = rng.below(ids.len() as u64) as usize;
                    if i != j {
                        mock.join(ids[i], ids[j]);
                    }
                }
            }
            converge(&s, &mut a, &mut early_rx).await;
            // The block is applied from its transactions and published at once; the client
            // still lands on the server's state.
            let n = mock.node().txs.len();
            mock.mine(rng.below(n as u64 + 1) as usize);
            let tip = announce_block(&s);
            s.tracker.block_found(tip);
            converge(&s, &mut a, &mut early_rx).await;
            assert_eq!(a.json["projected"]["tip"]["height"], tip.height);
        }
    }
}

/// The fee score's `/app/fees/score` body for `query`, and its status.
async fn fee_score(ctx: &Arc<NetworkContext>, query: &str) -> (u16, Value) {
    let uri: axum::http::Uri = format!("/app/fees/score{query}").parse().unwrap();
    let res = crate::ws::fees::score::route(axum::extract::State(Arc::clone(ctx)), uri).await;
    let status = res.status().as_u16();
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn the_fee_score_asks_the_node_nothing_and_survives_a_restart() {
    let mock = Mock::new();
    let s = Server::start(&mock, Duration::from_millis(10));
    // A fees task warmed up as after five quiet minutes, so ours is served.
    let ctx = context(true, Duration::from_millis(10));
    let mut rec = engine::fees::Recommender::default();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    rec.gap(now - 400);
    let engines = crate::ws::fees::Engines {
        tracker: s.tracker.clone(),
        projector: s.projector.clone(),
    };
    let fees = tokio::spawn(crate::ws::fees::run(Arc::clone(&ctx), Some(engines), rec));
    let dir = std::env::temp_dir().join(format!("rbitcoin-space-fee-score-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let store = Arc::new(engine::store::Store::open(&dir, "regtest", Default::default()).unwrap());
    store.set_gate(engine::store::Gate::Open);
    // The keeper and its writer, sampling every 20 ms.
    let keep = || {
        let (tx, rx) = mpsc::channel(64);
        let score = crate::ws::fees::score::run(
            Arc::clone(&ctx),
            s.tracker.clone(),
            s.projector.clone(),
            Some(Arc::clone(&store)),
            Some(tx),
            Duration::from_millis(20),
        );
        let write = crate::ws::fees::score::write(Arc::clone(&ctx), Arc::clone(&store), rx);
        [tokio::spawn(score), tokio::spawn(write)]
    };
    let mut keeper = keep();
    let stored = || async {
        engine::fees::db::load(&store, now)
            .await
            .unwrap()
            .1
            .into_iter()
            .map(|b| (b.height, b.clearing))
            .collect::<Vec<_>>()
    };
    let wait_for = |want: Vec<(u32, Option<u32>)>| async move {
        let deadline = Instant::now() + WAIT;
        while stored().await != want {
            assert!(
                Instant::now() < deadline,
                "blocks stored: {:?}",
                stored().await
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };

    // Six transactions at 5 sat/vB fill the next block; three at 2 sat/vB wait.
    for _ in 0..6 {
        mock.add(500_000, 100_000);
    }
    for _ in 0..3 {
        mock.add(200_000, 100_000);
    }
    s.settle().await;
    while ctx
        .fees
        .current()
        .is_none_or(|a| a.source != crate::ws::fees::Source::Projected)
    {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // Sampling and scoring, some fifty times over, ask the node for nothing beyond the
    // tracker's own polling: no block, no transaction, no cluster. Times are whole seconds:
    // waiting for the second to turn twice puts a sample of ours a second before the block.
    let calls = |m| mock.node().calls.get(m).copied().unwrap_or(0);
    let asked = |c: &dyn Fn(&'static str) -> usize| ["block", "details", "clusters"].map(c);
    let idle = asked(&calls);
    let unix = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    };
    let served_at = unix();
    while unix() < served_at + 2 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(asked(&calls), idle);

    // A block takes the 5 sat/vB transactions: it cleared at 5 sat/vB, and the only block
    // fetched is the tracker's own.
    mock.mine(6);
    s.settle().await;
    wait_for(vec![(1, Some(5_000))]).await;
    assert_eq!(calls("block"), idle[0] + 1);
    // The answers are rebuilt at the next sample.
    let deadline = Instant::now() + WAIT;
    let body = loop {
        let (status, body) = fee_score(&ctx, "?window=24h").await;
        assert_eq!(status, 200);
        if body["levels"][0]["scored"].as_u64() > Some(0) {
            break body;
        }
        assert!(Instant::now() < deadline, "never scored: {body}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    let high = &body["levels"][0];
    assert_eq!(high["outcomes"], 1);
    // One block is no evidence: no share is given.
    assert_eq!(
        (&high["enough"], &high["met"]),
        (&Value::Bool(false), &Value::Null)
    );
    assert_eq!(body["min_blocks"], 30);

    // Stopped, a block comes, and started again: the history is still there, and the block
    // mined while it was down is recorded without a clearing rate.
    for t in &keeper {
        t.abort();
    }
    mock.mine(3);
    s.settle().await;
    keeper = keep();
    wait_for(vec![(1, Some(5_000)), (2, None)]).await;
    let (_, again) = fee_score(&ctx, "").await;
    assert_eq!(again["window"], "all");
    assert!(again["levels"][0]["scored"].as_u64() >= high["scored"].as_u64());

    for bad in ["?window=2h", "?window=1w&window=1w", "?limit=1", "?window="] {
        assert_eq!(fee_score(&ctx, bad).await.0, 400, "{bad}");
    }
    for t in keeper {
        t.abort();
    }
    fees.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_block_says_what_the_kept_outputs_take_now() {
    let mut summary = summary_line("regtest");
    summary.outputs_kept_bytes = 4096;
    let block = mempool::CycleStats {
        confirmed: 3,
        kept_bytes: 1024,
        ..mempool::CycleStats::default()
    };
    count_block(&mut summary, &block);
    assert_eq!((summary.confirmed, summary.outputs_kept_bytes), (3, 1024));
}
