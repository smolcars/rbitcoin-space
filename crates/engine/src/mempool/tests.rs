#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bitcoin::absolute::LockTime;
use bitcoin::block::{Header, Version};
use bitcoin::hashes::Hash;
use bitcoin::{
    Amount, Block, BlockHash, CompactTarget, OutPoint, ScriptBuf, Sequence, Transaction, TxIn,
    TxMerkleNode, TxOut, Txid, Witness,
};
use node::esplora::ChainTip;
use node::rpc::model::{EntryFees, MempoolEntry, MempoolInfo, RawMempool};
use tokio::sync::broadcast::error::RecvError;

use super::model::{Delta, Mempool, Removal, TxInfo};
use super::tracker::{Config, Event, Source, SourceError, Tracker};

// Building blocks.

/// A transaction spending `inputs` with `outputs` outputs; `tag` makes its txid unique.
fn tx(inputs: &[OutPoint], outputs: u32, tag: u32) -> Transaction {
    Transaction {
        version: bitcoin::transaction::Version::TWO,
        lock_time: LockTime::from_consensus(tag),
        input: inputs
            .iter()
            .map(|o| TxIn {
                previous_output: *o,
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
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

/// A confirmed outpoint nobody in the test mempool created.
fn coin(n: u32) -> OutPoint {
    OutPoint::new(Txid::from_byte_array([0xcc; 32]), n)
}

fn out(t: &Transaction, vout: u32) -> OutPoint {
    OutPoint::new(t.compute_txid(), vout)
}

fn block(height: u32, prev: BlockHash, txs: &[&Transaction]) -> Block {
    let coinbase = Transaction {
        input: vec![TxIn {
            previous_output: OutPoint::null(),
            script_sig: ScriptBuf::from_bytes(height.to_le_bytes().to_vec()),
            sequence: Sequence::MAX,
            witness: Witness::new(),
        }],
        ..tx(&[], 1, height)
    };
    let mut b = Block {
        header: Header {
            version: Version::TWO,
            prev_blockhash: prev,
            merkle_root: TxMerkleNode::all_zeros(),
            time: height,
            bits: CompactTarget::from_consensus(0x207f_ffff),
            nonce: 0,
        },
        txdata: std::iter::once(coinbase)
            .chain(txs.iter().map(|t| (*t).clone()))
            .collect(),
    };
    b.header.merkle_root = b.compute_merkle_root().unwrap();
    b
}

fn entry(t: &Transaction) -> MempoolEntry {
    let fee = Amount::from_sat(100 + u64::from(t.lock_time.to_consensus_u32()));
    let weight = t.weight().to_wu();
    MempoolEntry {
        wtxid: t.compute_wtxid(),
        vsize: weight.div_ceil(4),
        vsize_bip141: weight.div_ceil(4),
        weight,
        time: 1_700_000_000,
        height: 0,
        fees: EntryFees {
            base: fee,
            modified: fee.to_signed().unwrap(),
            ancestor: fee.to_signed().unwrap(),
            descendant: fee.to_signed().unwrap(),
            chunk: fee.to_signed().unwrap(),
        },
        ancestorcount: 1,
        ancestorsize: 0,
        descendantcount: 1,
        descendantsize: 0,
        chunkweight: weight,
        depends: Vec::new(),
        spentby: Vec::new(),
        bip125_replaceable: true,
        unbroadcast: false,
    }
}

fn tip(b: &Block, height: u32) -> ChainTip {
    ChainTip {
        hash: b.block_hash(),
        height,
    }
}

fn genesis() -> BlockHash {
    BlockHash::all_zeros()
}

/// A mempool holding `txs`, as the first delta would leave it.
fn pool(txs: &[&Transaction]) -> Mempool {
    let mut m = Mempool::default();
    let added = txs
        .iter()
        .map(|t| (t.compute_txid(), m.keys().record(&entry(t), t)))
        .collect();
    let d = Delta {
        seq: 1,
        mempool_sequence: 1,
        tip: tip(&block(0, genesis(), &[]), 0),
        added,
        removed: Vec::new(),
        replaced: Vec::new(),
        blocks: Vec::new(),
    };
    assert!(m.apply(&d));
    m
}

fn classify(
    m: &Mempool,
    removed: &[&Transaction],
    added: &[&Transaction],
    blocks: &[(u32, Block)],
) -> HashMap<Txid, Removal> {
    let mut removed: Vec<Txid> = removed.iter().map(|t| t.compute_txid()).collect();
    removed.sort_unstable();
    let added: Vec<(Txid, TxInfo)> = added
        .iter()
        .map(|t| (t.compute_txid(), m.keys().record(&entry(t), t)))
        .collect();
    let blocks: Vec<_> = blocks
        .iter()
        .map(|(h, b)| std::sync::Arc::new(m.keys().block(*h, b)))
        .collect();
    m.classify(&removed, &added, &blocks).into_iter().collect()
}

fn replaced(by: &Transaction) -> Removal {
    Removal::Replaced {
        by: by.compute_txid(),
    }
}

// The pure core.

#[test]
fn records_carry_fee_size_value_and_time() {
    let t = tx(&[coin(0), coin(1)], 3, 7);
    let m = Mempool::default();
    let r = m.keys().record(&entry(&t), &t);
    assert_eq!(r.fee, Amount::from_sat(107));
    assert_eq!(r.value, Amount::from_sat(1000 + 1001 + 1002));
    assert_eq!(u64::from(r.weight), t.weight().to_wu());
    assert_eq!(r.time, 1_700_000_000);
    assert_eq!((r.outputs, r.spends().len()), (3, 2));
    assert_eq!(r.flags, crate::flags::of(&t));
    assert_eq!(r.flags, crate::flags::NO_RBF | crate::flags::V2);
    // The fingerprint is keyed per mempool: another instance hashes differently.
    assert_ne!(
        Mempool::default().keys().key(&coin(0)),
        m.keys().key(&coin(0))
    );
}

#[test]
fn records_keep_outputs_without_growing_the_slot() {
    use crate::outputs::{MAX_OUTPUTS, Outputs};
    // The map's slot is what every mempool transaction costs: outputs ride in the heap
    // allocation the inputs already have, and their word count in padding.
    assert_eq!(std::mem::size_of::<(Txid, TxInfo)>(), 96);
    let m = Mempool::default();
    let mut t = tx(&[coin(0), coin(1)], 2, 7);
    t.output[0].script_pubkey = ScriptBuf::from_bytes([&[0x00, 0x14][..], &[7; 20]].concat());
    t.output[1].script_pubkey = ScriptBuf::from_bytes(vec![0x6a; 60]);
    let r = m.keys().record(&entry(&t), &t);
    assert_eq!(r.kept_outputs(), Some(Outputs::of(&t.output)));
    assert_eq!(
        r.spends().len(),
        2,
        "the inputs are untouched by what follows them"
    );
    assert_eq!(r.inputs(), 2);
    // value 2 + tag 1 + 22, value 2 + tag 1 + hash 16: 44 bytes in 6 words.
    assert_eq!(r.kept_bytes(), 48);
    // Too many: only the count, and no heap beyond the inputs.
    let many = tx(&[coin(2)], MAX_OUTPUTS as u32 + 1, 8);
    let r = m.keys().record(&entry(&many), &many);
    assert_eq!(
        r.kept_outputs(),
        Some(Outputs::TooMany(MAX_OUTPUTS as u32 + 1))
    );
    assert_eq!((r.kept_bytes(), r.spends().len()), (0, 1));
    // Dropped for the budget: the inputs stay, the outputs read as not kept.
    let mut r = m.keys().record(&entry(&t), &t);
    r.drop_outputs();
    assert_eq!((r.kept_outputs(), r.spends().len()), (None, 2));
}

#[test]
fn shared_inputs_are_counted_from_the_fingerprints() {
    let m = Mempool::default();
    let a = tx(&[coin(0), coin(1), coin(2)], 1, 1);
    let b = tx(&[coin(1), coin(2), coin(3), coin(4)], 1, 2);
    let c = tx(&[out(&a, 0)], 1, 3);
    let rec = |t: &Transaction| m.keys().record(&entry(t), t);
    assert_eq!(rec(&a).shared_inputs(&rec(&b)), 2);
    assert_eq!(rec(&b).shared_inputs(&rec(&a)), 2);
    assert_eq!(rec(&c).shared_inputs(&rec(&b)), 0, "a child shares nothing");
}

#[test]
fn a_block_tells_a_conflict_from_a_child_when_its_replacement_was_never_held() {
    use crate::replacements::Sides;
    let m = Mempool::default();
    let a = tx(&[coin(0)], 2, 1);
    let child = tx(&[out(&a, 0)], 1, 2);
    let b = tx(&[coin(0)], 1, 3);
    let blk = m.keys().block(1, &block(1, BlockHash::all_zeros(), &[&b]));
    let by = b.compute_txid();
    let rec = |t: &Transaction| m.keys().record(&entry(t), t);
    assert_eq!(blk.shared_inputs(&rec(&a), &by), 1);
    assert_eq!(blk.shared_inputs(&rec(&child), &by), 0);
    let conflict = Sides::of(&rec(&a), None, Some((&blk, &by)));
    assert_eq!(conflict.shared, Some(1));
    assert!(conflict.outputs.is_some());
    let left_with_parent = Sides::of(&rec(&child), None, Some((&blk, &by)));
    assert_eq!(
        (left_with_parent.shared, left_with_parent.outputs),
        (Some(0), None)
    );
}

#[test]
fn diff_finds_added_and_removed_in_txid_order() {
    let (a, b, c, d) = (
        tx(&[coin(0)], 1, 1),
        tx(&[coin(1)], 1, 2),
        tx(&[coin(2)], 1, 3),
        tx(&[coin(3)], 1, 4),
    );
    let m = pool(&[&a, &b, &c]);
    let diff = m.diff(&[d.compute_txid(), b.compute_txid(), c.compute_txid()]);
    assert_eq!(diff.added, vec![d.compute_txid()]);
    assert_eq!(diff.removed, vec![a.compute_txid()]);
    assert_eq!(m.diff(&[]).removed.len(), 3);
    let mut all = vec![a.compute_txid(), b.compute_txid(), c.compute_txid()];
    all.sort_unstable();
    assert_eq!(m.diff(&[]).removed, all);
    assert!(m.diff(&all).added.is_empty() && m.diff(&all).removed.is_empty());
}

#[test]
fn apply_refuses_out_of_order_deltas_and_keeps_totals() {
    let (a, b) = (tx(&[coin(0)], 1, 1), tx(&[coin(1)], 1, 2));
    let mut m = pool(&[&a, &b]);
    let (va, vb) = (
        m.get(&a.compute_txid()).unwrap().vsize,
        m.get(&b.compute_txid()).unwrap().vsize,
    );
    assert_eq!(m.vsize(), u64::from(va + vb));
    assert_eq!(m.fees(), Amount::from_sat(101 + 102));
    let d = Delta {
        seq: 3,
        mempool_sequence: 9,
        tip: m.tip().unwrap(),
        added: Vec::new(),
        removed: vec![(a.compute_txid(), Removal::Evicted)],
        replaced: Vec::new(),
        blocks: Vec::new(),
    };
    assert!(!m.apply(&d), "seq 3 after 1 is a gap");
    assert_eq!(m.len(), 2);
    assert!(m.apply(&Delta { seq: 2, ..d }));
    assert_eq!((m.len(), m.seq(), m.mempool_sequence()), (1, 2, 9));
    assert_eq!(m.vsize(), u64::from(vb));
    assert_eq!(m.fees(), Amount::from_sat(102));
}

#[test]
fn confirmed_replaced_and_evicted() {
    let confirmed = tx(&[coin(0)], 1, 1);
    let original = tx(&[coin(1), coin(2)], 1, 2);
    let evicted = tx(&[coin(3)], 1, 3);
    let stays = tx(&[coin(4)], 1, 4);
    // The replacement keeps only the second input, so matching cannot lean on the first.
    let replacement = tx(&[coin(2), coin(9)], 1, 5);
    let m = pool(&[&confirmed, &original, &evicted, &stays]);
    let b = block(1, genesis(), &[&confirmed]);
    let r = classify(
        &m,
        &[&confirmed, &original, &evicted],
        &[&replacement],
        &[(1, b.clone())],
    );
    assert_eq!(
        r[&confirmed.compute_txid()],
        Removal::Confirmed {
            height: 1,
            block: b.block_hash()
        }
    );
    assert_eq!(r[&original.compute_txid()], replaced(&replacement));
    assert_eq!(r[&evicted.compute_txid()], Removal::Evicted);
    assert_eq!(r.len(), 3);
}

#[test]
fn a_block_can_confirm_some_and_double_spend_others() {
    // `a` confirms. `b` loses to `b2`, which the node never saw but a miner did.
    // `c` loses to `c2` arriving in the mempool in the same cycle.
    let a = tx(&[coin(0)], 1, 1);
    let b = tx(&[coin(1)], 1, 2);
    let b2 = tx(&[coin(1)], 1, 20);
    let c = tx(&[coin(2)], 1, 3);
    let c2 = tx(&[coin(2)], 1, 30);
    let m = pool(&[&a, &b, &c]);
    let blk = block(5, genesis(), &[&a, &b2]);
    let r = classify(&m, &[&a, &b, &c], &[&c2], &[(5, blk.clone())]);
    assert_eq!(
        r[&a.compute_txid()],
        Removal::Confirmed {
            height: 5,
            block: blk.block_hash()
        }
    );
    assert_eq!(r[&b.compute_txid()], replaced(&b2));
    assert_eq!(r[&c.compute_txid()], replaced(&c2));
}

#[test]
fn a_block_rules_out_held_transactions_and_additions_alike() {
    // Held: `a` is mined, `b` loses its coin to `b2` and takes its child `bc` along, `ac` spends
    // `a`'s output and stays, `e` left the pool on its own.
    let a = tx(&[coin(0)], 1, 1);
    let b = tx(&[coin(1)], 1, 2);
    let b2 = tx(&[coin(1)], 1, 3);
    let bc = tx(&[out(&b, 0)], 1, 4);
    let ac = tx(&[out(&a, 0)], 1, 5);
    let e = tx(&[coin(2)], 1, 6);
    let m = pool(&[&a, &b, &bc, &ac, &e]);
    let blk = std::sync::Arc::new(m.keys().block(1, &block(1, genesis(), &[&a, &b2])));
    let mut want = vec![a.compute_txid(), b.compute_txid(), bc.compute_txid()];
    want.sort_unstable();
    assert_eq!(m.ruled_out(std::slice::from_ref(&blk)), want);

    // Added in the same cycle, from a listing taken before the block: the mined `x`, `y` that
    // loses its coin to the block, `yc` its child, `ec` a child of the departed `e`, and two that
    // stay: `z`, and `ac2`, which spends `a`'s second output.
    let x = tx(&[coin(3)], 1, 7);
    let y = tx(&[coin(4)], 1, 8);
    let yc = tx(&[out(&y, 0)], 1, 9);
    let ec = tx(&[out(&e, 0)], 1, 10);
    let z = tx(&[coin(5)], 1, 11);
    let ac2 = tx(&[out(&ac, 0)], 1, 12);
    let blk = std::sync::Arc::new(m.keys().block(
        1,
        &block(1, genesis(), &[&a, &b2, &x, &tx(&[coin(4)], 1, 13)]),
    ));
    let mut added: Vec<(Txid, TxInfo)> = [&yc, &x, &y, &ec, &z, &ac2]
        .iter()
        .map(|t| (t.compute_txid(), m.keys().record(&entry(t), t)))
        .collect();
    let removed = [a.compute_txid(), e.compute_txid()];
    m.rule_out_added(&mut added, &removed, &[blk]);
    let kept: HashSet<Txid> = added.iter().map(|(t, _)| *t).collect();
    assert_eq!(kept, HashSet::from([z.compute_txid(), ac2.compute_txid()]));
}

#[test]
fn an_older_block_in_the_window_still_counts() {
    let a = tx(&[coin(0)], 1, 1);
    let m = pool(&[&a]);
    let b1 = block(1, genesis(), &[&a]);
    let b2 = block(2, b1.block_hash(), &[]);
    let r = classify(&m, &[&a], &[], &[(2, b2), (1, b1.clone())]);
    assert_eq!(
        r[&a.compute_txid()],
        Removal::Confirmed {
            height: 1,
            block: b1.block_hash()
        }
    );
}

#[test]
fn descendants_leave_with_their_replaced_ancestor() {
    let parent = tx(&[coin(0)], 2, 1);
    let child = tx(&[out(&parent, 1)], 1, 2);
    let grandchild = tx(&[out(&child, 0)], 1, 3);
    let replacement = tx(&[coin(0)], 1, 4);
    let m = pool(&[&parent, &child, &grandchild]);
    // Listed in any order: the result does not depend on it.
    let r = classify(&m, &[&grandchild, &child, &parent], &[&replacement], &[]);
    for t in [&parent, &child, &grandchild] {
        assert_eq!(r[&t.compute_txid()], replaced(&replacement));
    }
}

#[test]
fn links_find_parents_and_children_among_the_given() {
    let parent = tx(&[coin(0)], 3, 1);
    let child = tx(&[out(&parent, 0), out(&parent, 2)], 1, 2);
    let grandchild = tx(&[out(&child, 0), coin(9)], 1, 3);
    let other = tx(&[out(&parent, 1)], 1, 4);
    let m = pool(&[&parent, &child, &grandchild, &other]);
    let ids: Vec<Txid> = [&parent, &child, &grandchild, &other, &tx(&[coin(5)], 1, 9)]
        .iter()
        .map(|t| t.compute_txid())
        .collect();
    let mut links = m.links(&ids);
    links.sort_unstable();
    // Two inputs from one parent are one link; an unknown txid has none.
    assert_eq!(links, vec![(0, 1), (0, 3), (1, 2)]);
    // Only links among the txids given.
    assert_eq!(m.links(&ids[1..3]), vec![(0, 1)]);
}

#[test]
fn a_child_of_a_confirmed_or_evicted_parent_is_not_replaced() {
    let parent = tx(&[coin(0)], 1, 1);
    let child = tx(&[out(&parent, 0)], 1, 2);
    let lone = tx(&[coin(5)], 1, 3);
    let lone_child = tx(&[out(&lone, 0)], 1, 4);
    let m = pool(&[&parent, &child, &lone, &lone_child]);
    let b = block(1, genesis(), &[&parent]);
    let r = classify(&m, &[&parent, &child, &lone, &lone_child], &[], &[(1, b)]);
    assert!(matches!(
        r[&parent.compute_txid()],
        Removal::Confirmed { .. }
    ));
    assert_eq!(r[&child.compute_txid()], Removal::Evicted);
    assert_eq!(r[&lone.compute_txid()], Removal::Evicted);
    assert_eq!(r[&lone_child.compute_txid()], Removal::Evicted);
}

#[test]
fn a_replacement_chain_names_the_live_replacement() {
    // a -> b -> c inside one interval: b was never seen, c shares a's input.
    let a = tx(&[coin(0)], 1, 1);
    let c = tx(&[coin(0), coin(1)], 1, 3);
    let m = pool(&[&a]);
    assert_eq!(
        classify(&m, &[&a], &[&c], &[])[&a.compute_txid()],
        replaced(&c)
    );
    // If c spends none of a's inputs, the link is lost and a reads as evicted (documented).
    let c_only_b_inputs = tx(&[coin(7)], 1, 4);
    assert_eq!(
        classify(&m, &[&a], &[&c_only_b_inputs], &[])[&a.compute_txid()],
        Removal::Evicted
    );
}

#[test]
fn after_a_reorg_only_the_new_chain_counts() {
    // `a` was in a block that a reorg removed; the winning block double-spends it.
    let a = tx(&[coin(0)], 1, 1);
    let rival = tx(&[coin(0)], 1, 2);
    let m = pool(&[&a]);
    let winner = block(1, genesis(), &[&rival]);
    assert_eq!(
        classify(&m, &[&a], &[], &[(1, winner)])[&a.compute_txid()],
        replaced(&rival)
    );
}

// The shell, against a mock node.

#[derive(Default)]
struct Node {
    pool: Vec<Transaction>,
    sequence: u64,
    /// Blocks by hash, and the active tip.
    blocks: HashMap<BlockHash, Block>,
    tip: Option<ChainTip>,
    /// Listed but answering "not in mempool" to detail calls.
    vanish: HashSet<Txid>,
    /// Errors returned by the next calls of any kind, in order.
    failures: VecDeque<SourceError>,
    /// Outcomes of the next detail calls, in order; `None` succeeds.
    detail_failures: VecDeque<Option<SourceError>>,
    /// Detail batches larger than this answer `TooBig`.
    max_batch: Option<usize>,
    /// Txids as they entered, newest first: `/mempool/recent` is the first ten.
    recent: VecDeque<Txid>,
    /// Same probe answers whatever the pool, to test the heartbeat.
    frozen_info: bool,
    /// Arrives right after the first of the probe's two reads answers, before the second.
    between_reads: Option<Transaction>,
    delay: Duration,
    /// What Esplora's tip route answers while the node has announced a block it does not serve.
    lag: Option<ChainTip>,
}

#[derive(Default)]
struct Counters {
    infos: AtomicU32,
    recents: AtomicU32,
    listings: AtomicU32,
    details: AtomicU32,
    blocks: AtomicU32,
    in_flight: AtomicU32,
    max_in_flight: AtomicU32,
    listings_in_flight: AtomicU32,
    max_listings: AtomicU32,
    bytes: AtomicU64,
}

#[derive(Clone, Default)]
struct Mock {
    node: Arc<Mutex<Node>>,
    n: Arc<Counters>,
}

impl Mock {
    fn new() -> Self {
        let m = Self::default();
        m.mine(&[]);
        m
    }

    fn with<R>(&self, f: impl FnOnce(&mut Node) -> R) -> R {
        f(&mut self.node.lock().unwrap())
    }

    fn send(&self, t: &Transaction) {
        self.with(|n| Self::arrive(n, t));
    }

    fn arrive(n: &mut Node, t: &Transaction) {
        n.pool.retain(|p| {
            !p.input.iter().any(|i| {
                t.input
                    .iter()
                    .any(|j| i.previous_output == j.previous_output)
            })
        });
        n.pool.push(t.clone());
        n.recent.push_front(t.compute_txid());
        n.sequence += 1;
    }

    /// Mines `txs` onto the tip, dropping them and their conflicts from the pool.
    fn mine(&self, txs: &[&Transaction]) -> Block {
        self.with(|n| {
            let (prev, height) = n.tip.map_or((genesis(), 0), |t| (t.hash, t.height + 1));
            Self::connect(n, block(height, prev, txs), height)
        })
    }

    fn connect(n: &mut Node, b: Block, height: u32) -> Block {
        let spent: HashSet<OutPoint> = b
            .txdata
            .iter()
            .flat_map(|t| t.input.iter().map(|i| i.previous_output))
            .collect();
        let ids: HashSet<Txid> = b.txdata.iter().map(|t| t.compute_txid()).collect();
        // Conflicts go, and so do their descendants, generation by generation.
        let mut gone: HashSet<Txid> = HashSet::new();
        loop {
            let before = n.pool.len();
            n.pool.retain(|p| {
                let out = p.input.iter().any(|i| {
                    spent.contains(&i.previous_output) || gone.contains(&i.previous_output.txid)
                });
                if out && !ids.contains(&p.compute_txid()) {
                    gone.insert(p.compute_txid());
                }
                !out && !ids.contains(&p.compute_txid())
            });
            if n.pool.len() == before {
                break;
            }
        }
        n.sequence += 1;
        n.tip = Some(tip(&b, height));
        n.blocks.insert(b.block_hash(), b.clone());
        b
    }

    async fn enter(&self) -> Result<(), SourceError> {
        let now = self.n.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.n.max_in_flight.fetch_max(now, Ordering::SeqCst);
        let delay = self.with(|n| n.delay);
        tokio::time::sleep(delay).await;
        self.n.in_flight.fetch_sub(1, Ordering::SeqCst);
        self.n.bytes.fetch_add(100, Ordering::SeqCst);
        match self.with(|n| n.failures.pop_front()) {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

impl Source for Mock {
    async fn mempool_info(&self) -> Result<MempoolInfo, SourceError> {
        self.n.infos.fetch_add(1, Ordering::SeqCst);
        self.enter().await?;
        Ok(self.with(|n| {
            // The node's own totals: count, vsize and base fees, which equal swaps leave alone.
            let entries = n.pool.iter().map(entry).filter(|_| !n.frozen_info);
            let (size, bytes, total_fee) = entries.fold((0, 0, Amount::ZERO), |(c, v, f), e| {
                (c + 1, v + e.vsize, f + e.fees.base)
            });
            let info = MempoolInfo {
                loaded: true,
                size,
                bytes,
                usage: 0,
                maxmempool: 300_000_000,
                total_fee,
                mempoolminfee: Amount::ZERO,
                minrelaytxfee: Amount::ZERO,
                incrementalrelayfee: Amount::ZERO,
                fullrbf: true,
                limitclustercount: 64,
                limitclustersize: 101_000,
                unbroadcastcount: 0,
            };
            if let Some(t) = n.between_reads.take() {
                Self::arrive(n, &t);
            }
            info
        }))
    }

    async fn recent(&self) -> Result<Vec<Txid>, SourceError> {
        // Outside `enter`: injected failures and delays stay aimed at the calls they test.
        self.n.recents.fetch_add(1, Ordering::SeqCst);
        Ok(self.with(|n| {
            let recent = match n.frozen_info {
                true => Vec::new(),
                false => n.recent.iter().take(10).copied().collect(),
            };
            if let Some(t) = n.between_reads.take() {
                Self::arrive(n, &t);
            }
            recent
        }))
    }

    async fn listing(&self) -> Result<RawMempool, SourceError> {
        self.n.listings.fetch_add(1, Ordering::SeqCst);
        let now = self.n.listings_in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.n.max_listings.fetch_max(now, Ordering::SeqCst);
        let r = self.enter().await;
        self.n.listings_in_flight.fetch_sub(1, Ordering::SeqCst);
        r?;
        Ok(self.with(|n| RawMempool {
            mempool_sequence: n.sequence,
            txids: n.pool.iter().map(Transaction::compute_txid).collect(),
        }))
    }

    async fn details(
        &self,
        txids: &[Txid],
    ) -> Result<Vec<Option<(MempoolEntry, Transaction)>>, SourceError> {
        self.n.details.fetch_add(1, Ordering::SeqCst);
        self.enter().await?;
        self.with(|n| {
            if let Some(Some(e)) = n.detail_failures.pop_front() {
                return Err(e);
            }
            if n.max_batch.is_some_and(|m| txids.len() > m) {
                return Err(SourceError::TooBig);
            }
            Ok(txids
                .iter()
                .map(|id| {
                    let t = n.pool.iter().find(|t| t.compute_txid() == *id)?;
                    (!n.vanish.contains(id)).then(|| (entry(t), t.clone()))
                })
                .collect())
        })
    }

    async fn tip(&self) -> Result<ChainTip, SourceError> {
        self.enter().await?;
        self.with(|n| n.lag.or(n.tip).ok_or(SourceError::Failed("no tip".into())))
    }

    async fn block(&self, hash: BlockHash) -> Result<Block, SourceError> {
        self.n.blocks.fetch_add(1, Ordering::SeqCst);
        self.enter().await?;
        self.with(|n| {
            n.blocks
                .get(&hash)
                .cloned()
                .ok_or(SourceError::Failed("unknown block".into()))
        })
    }

    fn bytes(&self) -> u64 {
        self.n.bytes.load(Ordering::SeqCst)
    }
}

fn config() -> Config {
    Config {
        batch: 2,
        blocks: 3,
        ..Config::default()
    }
}

/// The next `Cycle` or `PollFailed`, skipping other events.
async fn next_cycle(ev: &mut tokio::sync::broadcast::Receiver<Event>) -> Event {
    loop {
        if let e @ (Event::Cycle(_) | Event::PollFailed { .. }) = ev.recv().await.unwrap() {
            return e;
        }
    }
}

fn cycle(e: Event) -> super::CycleStats {
    match e {
        Event::Cycle(s) => s,
        e => panic!("expected a cycle, got {e:?}"),
    }
}

/// The tracker's txids.
fn txids(t: &Tracker) -> HashSet<Txid> {
    t.read(|m| m.iter().map(|(k, _)| *k).collect())
}

fn pool_txids(mock: &Mock) -> HashSet<Txid> {
    mock.with(|n| n.pool.iter().map(Transaction::compute_txid).collect())
}

#[tokio::test(start_paused = true)]
async fn follows_sends_replacements_and_blocks_with_reasons() {
    let mock = Mock::new();
    let (a, b, c) = (
        tx(&[coin(0)], 2, 1),
        tx(&[coin(1)], 1, 2),
        tx(&[coin(2)], 1, 3),
    );
    for t in [&a, &b, &c] {
        mock.send(t);
    }
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    let first = ev.recv().await.unwrap();
    let Event::Synced { txs: 3, .. } = first else {
        panic!("{first:?}")
    };
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.seq, s.added, s.size), (Some(1), 3, 3));
    assert_eq!(txids(&tracker), pool_txids(&mock));

    // A subscriber mirrors the state from a snapshot plus deltas.
    let (mut mirror, mut sub) = tracker.subscribe(|m| {
        (
            m.seq(),
            m.iter()
                .map(|(k, v)| (*k, v.clone()))
                .collect::<HashMap<_, _>>(),
        )
    });

    // RBF of `b`, and a child of `a`.
    let b2 = tx(&[coin(1)], 1, 20);
    let child = tx(&[out(&a, 1)], 1, 4);
    mock.send(&b2);
    mock.send(&child);
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.added, s.replaced, s.size), (2, 1, 4));
    let d = sub.recv().await.unwrap();
    assert_eq!(d.seq, mirror.0 + 1);
    assert_eq!(d.removed, vec![(b.compute_txid(), replaced(&b2))]);
    // The replacement is marked as one; the unrelated child is not.
    let flag = |t: &Transaction| {
        let (_, i) = d
            .added
            .iter()
            .find(|(id, _)| *id == t.compute_txid())
            .unwrap();
        i.flags & crate::flags::REPLACEMENT
    };
    assert_eq!((flag(&b2), flag(&child)), (crate::flags::REPLACEMENT, 0));
    assert_eq!(
        tracker.read(|m| m.get(&b2.compute_txid()).map(|i| i.flags)),
        Some(crate::flags::of(&b2) | crate::flags::REPLACEMENT)
    );
    // The replaced record comes along, as it was held.
    assert_eq!(
        d.replaced,
        vec![(b.compute_txid(), mirror.1[&b.compute_txid()].clone())]
    );

    // A block confirms `a` and `b2`; `child` stays.
    let blk = mock.mine(&[&a, &b2]);
    tracker.tip_changed();
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.confirmed, s.blocks, s.size), (2, 1, 2));
    let d2 = sub.recv().await.unwrap();
    assert_eq!(d2.seq, d.seq + 1);
    assert_eq!(d2.tip.hash, blk.block_hash());
    assert!(d2.removed.iter().all(|(_, r)| *r
        == Removal::Confirmed {
            height: 1,
            block: blk.block_hash()
        }));
    for delta in [d, d2] {
        mirror.0 = delta.seq;
        for (t, _) in &delta.removed {
            mirror.1.remove(t);
        }
        mirror.1.extend(delta.added.iter().cloned());
    }
    let state = tracker.read(|m| (m.seq(), m.iter().map(|(k, v)| (*k, v.clone())).collect()));
    assert_eq!(mirror, state);
    assert_eq!(txids(&tracker), pool_txids(&mock));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn outputs_are_kept_while_the_budget_lasts() {
    let mock = Mock::new();
    // Each transaction's two outputs (empty scripts) take 6 bytes, one word: room for two.
    let txs: Vec<Transaction> = (0..3).map(|i| tx(&[coin(i)], 2, i)).collect();
    for t in &txs {
        mock.send(t);
    }
    let (tracker, task) = Tracker::start(
        mock.clone(),
        Config {
            kept_outputs: 16,
            subscriber_queue: 2,
            ..config()
        },
    );
    let mut ev = tracker.events();
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.added, s.unkept, s.kept_bytes), (3, 1, 16));
    let kept = tracker.read(|m| {
        txs.iter()
            .filter(|t| m.get(&t.compute_txid()).unwrap().kept_outputs().is_some())
            .count()
    });
    assert_eq!(kept, 2);
    // What leaves frees its share once nothing holds it: no subscriber here, so at once.
    // (`outputs_count_while_any_delta_still_holds_them` holds the other case.)
    mock.mine(&[&txs[0], &txs[1]]);
    tracker.tip_changed();
    cycle(next_cycle(&mut ev).await);
    let freed = tx(&[coin(30)], 2, 30);
    mock.send(&freed);
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!(s.unkept, 0);
    assert!(tracker.read(|m| {
        m.get(&freed.compute_txid())
            .unwrap()
            .kept_outputs()
            .is_some()
    }));
    assert_eq!(tracker.read(Mempool::kept_bytes), s.kept_bytes);
    task.abort();
}

/// An empty block on the mock, and the cycle that follows it.
async fn empty_block(
    mock: &Mock,
    tracker: &Tracker,
    ev: &mut tokio::sync::broadcast::Receiver<Event>,
) -> super::tracker::CycleStats {
    mock.mine(&[]);
    tracker.tip_changed();
    cycle(next_cycle(ev).await)
}

#[tokio::test(start_paused = true)]
async fn outputs_count_while_any_delta_still_holds_them() {
    let mock = Mock::new();
    let txs: Vec<Transaction> = (0..2).map(|i| tx(&[coin(i)], 2, i)).collect();
    for t in &txs {
        mock.send(t);
    }
    // Five asked for, eight given: the channel rounds its capacity up to a power of two.
    let (tracker, task) = Tracker::start(
        mock.clone(),
        Config {
            kept_outputs: 16,
            subscriber_queue: 5,
            ..config()
        },
    );
    // A subscriber that never reads: the channel keeps every delta until it is overwritten.
    let (_, _idle) = tracker.subscribe(|_| ());
    let mut ev = tracker.events();
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.seq, s.kept_bytes), (Some(1), 16));
    // Both leave in delta 2; delta 1, which added them, still holds their records.
    mock.mine(&[&txs[0], &txs[1]]);
    tracker.tip_changed();
    cycle(next_cycle(&mut ev).await);
    for _ in 3..=8 {
        empty_block(&mock, &tracker, &mut ev).await;
    }
    // Delta 9: the channel's eight slots hold deltas 1 to 8, so delta 1's outputs still count,
    // though more than five deltas have passed.
    let late = tx(&[coin(9)], 2, 9);
    mock.send(&late);
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.seq, s.unkept), (Some(9), 1));
    // Delta 9 overwrote delta 1: nothing holds them, and the next arrival keeps its outputs.
    let later = tx(&[coin(10)], 2, 10);
    mock.send(&later);
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.seq, s.unkept), (Some(10), 0));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn outputs_count_while_a_subscriber_keeps_a_delta_past_the_channel() {
    let mock = Mock::new();
    let txs: Vec<Transaction> = (0..2).map(|i| tx(&[coin(i)], 2, i)).collect();
    for t in &txs {
        mock.send(t);
    }
    let (tracker, task) = Tracker::start(
        mock.clone(),
        Config {
            kept_outputs: 16,
            subscriber_queue: 1,
            ..config()
        },
    );
    // A subscriber takes delta 1 and keeps it, as a batch being worked through is kept.
    let (_, mut sub) = tracker.subscribe(|_| ());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    let kept = sub.recv().await.unwrap();
    mock.mine(&[&txs[0], &txs[1]]);
    tracker.tip_changed();
    cycle(next_cycle(&mut ev).await);
    for _ in 0..4 {
        empty_block(&mock, &tracker, &mut ev).await;
    }
    // The channel has long moved on; the delta it handed out still holds them.
    mock.send(&tx(&[coin(9)], 2, 9));
    assert_eq!(cycle(next_cycle(&mut ev).await).unkept, 1);
    drop(kept);
    mock.send(&tx(&[coin(10)], 2, 10));
    assert_eq!(cycle(next_cycle(&mut ev).await).unkept, 0);
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn outputs_staged_for_a_retry_stay_within_the_budget() {
    let mock = Mock::new();
    for i in 0..6 {
        mock.send(&tx(&[coin(i)], 2, i));
    }
    // Batches of 2, one at a time: the third fails after four records are staged. One word each,
    // and room for three.
    mock.with(|n| n.detail_failures = VecDeque::from(vec![None, None, Some(SourceError::Busy)]));
    let mut cfg = Config {
        kept_outputs: 24,
        ..config()
    };
    cfg.in_flight = 1;
    let (tracker, task) = Tracker::start(mock.clone(), cfg);
    let mut ev = tracker.events();
    let Event::PollFailed { .. } = next_cycle(&mut ev).await else {
        panic!()
    };
    // The retry finds the budget spent by what it staged: the last two keep no outputs.
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.added, s.unkept, s.kept_bytes), (6, 3, 24));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn only_published_arrivals_count_as_held_without_outputs() {
    let mock = Mock::new();
    let txs: Vec<Transaction> = (0..4).map(|i| tx(&[coin(i)], 2, i)).collect();
    for t in &txs {
        mock.send(t);
    }
    // Room for one record's outputs. Batches of two, in txid order: the first keeps one record's
    // outputs and stages the other without; the second batch fails.
    mock.with(|n| n.detail_failures = VecDeque::from(vec![None, Some(SourceError::Busy)]));
    let mut cfg = Config {
        kept_outputs: 8,
        ..config()
    };
    cfg.in_flight = 1;
    let (tracker, task) = Tracker::start(mock.clone(), cfg);
    let mut ev = tracker.events();
    let Event::PollFailed { .. } = next_cycle(&mut ev).await else {
        panic!()
    };
    // The staged one without outputs leaves the node's mempool before the retry.
    let mut ids: Vec<Txid> = txs.iter().map(Transaction::compute_txid).collect();
    ids.sort_unstable();
    let gone = ids[1];
    mock.with(|n| n.pool.retain(|t| t.compute_txid() != gone));
    let s = cycle(next_cycle(&mut ev).await);
    // Three published: one with outputs, two past the budget. The one that left is not counted.
    assert_eq!((s.added, s.unkept), (3, 2));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn probes_skip_unchanged_pools_and_the_heartbeat_lists_anyway() {
    let mock = Mock::new();
    mock.send(&tx(&[coin(0)], 1, 1));
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    // The first cycle's probe had no newest arrivals to save, so the next one lists once more.
    cycle(next_cycle(&mut ev).await);
    tokio::time::sleep(Duration::from_millis(5500)).await;
    // Then five probes found nothing.
    assert_eq!(mock.n.listings.load(Ordering::SeqCst), 2);
    assert!(mock.n.infos.load(Ordering::SeqCst) >= 6);

    // A change the probe cannot see is still found by the heartbeat.
    mock.with(|n| n.frozen_info = true);
    cycle(next_cycle(&mut ev).await); // the probe saw the info change to frozen
    mock.send(&tx(&[coin(1)], 1, 2));
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!(s.added, 1);
    assert!(s.skipped >= 8, "{s:?}");
    task.abort();
    drop(tracker);
}

#[tokio::test(start_paused = true)]
async fn an_arrival_just_like_one_that_left_is_seen_at_the_next_probe() {
    // Same tag, same fee; same shape, same size; another coin, another txid.
    let like = |coin_n, tag| tx(&[coin(coin_n)], 1, tag);
    let (a, b) = (like(0, 5), like(1, 6));
    let mock = Mock::new();
    mock.send(&a);
    mock.send(&b);
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    cycle(next_cycle(&mut ev).await); // the second listing, which saves the newest arrivals
    tokio::time::sleep(Duration::from_millis(3500)).await;
    let skipping = mock.n.listings.load(Ordering::SeqCst);

    // `a` is evicted and `a2`, its twin in size and fee, arrives: the node's totals do not move.
    let a2 = like(2, 5);
    let info = mock.mempool_info().await.unwrap();
    mock.with(|n| n.pool.retain(|t| *t != a));
    mock.send(&a2);
    let after = mock.mempool_info().await.unwrap();
    assert_eq!(
        (info.size, info.bytes, info.total_fee),
        (after.size, after.bytes, after.total_fee)
    );
    let at = tokio::time::Instant::now();
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.added, s.evicted), (1, 1));
    assert!(at.elapsed() <= Duration::from_secs(1), "{:?}", at.elapsed());
    assert_eq!(mock.n.listings.load(Ordering::SeqCst), skipping + 1);

    // A block takes `b`, announced, and `b2` arrives just like it: the end-to-end tests' case.
    tokio::time::sleep(Duration::from_millis(3500)).await;
    mock.mine(&[&b]);
    tracker.block_found(found(&mock));
    assert_eq!(next_block(&mut ev).await.confirmed, 1);
    let b2 = like(3, 6);
    mock.send(&b2);
    let at = tokio::time::Instant::now();
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!(s.added, 1);
    assert!(at.elapsed() <= Duration::from_secs(1), "{:?}", at.elapsed());
    assert_eq!(txids(&tracker), pool_txids(&mock));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn an_arrival_between_the_probes_two_reads_is_not_saved_half_seen() {
    let (a, b) = (tx(&[coin(0)], 1, 5), tx(&[coin(1)], 1, 5));
    let mock = Mock::new();
    mock.send(&b);
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    // `a`, the twin of `b` in size and fee, arrives while a probe is between its two reads.
    mock.with(|n| n.between_reads = Some(a.clone()));
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.added, s.size), (1, 2));
    // Then, before the next probe, `b` is evicted: the totals are back to what the probe's
    // first read saw. The probe saved with that cycle must still tell.
    mock.with(|n| n.pool.retain(|t| *t != b));
    let at = tokio::time::Instant::now();
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.evicted, s.size), (1, 1));
    assert!(at.elapsed() <= Duration::from_secs(1), "{:?}", at.elapsed());
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn a_slow_node_is_never_polled_twice_at_once() {
    let mock = Mock::new();
    for i in 0..10 {
        mock.send(&tx(&[coin(i)], 1, i));
    }
    mock.with(|n| n.delay = Duration::from_secs(3));
    let mut cfg = config();
    cfg.in_flight = 2;
    let (tracker, task) = Tracker::start(mock.clone(), cfg);
    let mut ev = tracker.events();
    let mut last_start = None;
    for i in 0..4 {
        mock.send(&tx(&[coin(100 + i)], 1, 100 + i));
        let s = cycle(next_cycle(&mut ev).await);
        assert!(s.duration >= Duration::from_secs(9), "{s:?}");
        let start = tokio::time::Instant::now() - s.duration;
        if let Some(prev) = last_start {
            // The previous cycle took as long; it was followed by at least as long a rest.
            assert!(start - prev >= s.duration * 2, "{:?}", start - prev);
        }
        last_start = Some(start);
    }
    // A hint during a cycle waits for it to end: never two listings at once.
    mock.send(&tx(&[coin(200)], 1, 200));
    tokio::time::sleep(Duration::from_secs(20)).await;
    tracker.tip_changed();
    tokio::time::sleep(Duration::from_secs(1)).await;
    tracker.tip_changed();
    cycle(next_cycle(&mut ev).await);
    cycle(next_cycle(&mut ev).await);
    assert_eq!(mock.n.max_listings.load(Ordering::SeqCst), 1);
    // At most two detail batches at once.
    assert!(mock.n.max_in_flight.load(Ordering::SeqCst) <= 2);
    assert_eq!(txids(&tracker), pool_txids(&mock));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn failures_back_off_up_to_the_cap() {
    let mock = Mock::new();
    mock.send(&tx(&[coin(0)], 1, 0));
    mock.with(|n| n.failures = VecDeque::from(vec![SourceError::Busy]));
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    let e = next_cycle(&mut ev).await;
    assert_eq!(
        e,
        Event::PollFailed {
            error: SourceError::Busy,
            consecutive: 1,
            retry_in: Duration::from_secs(2)
        }
    );
    assert_eq!(cycle(next_cycle(&mut ev).await).size, 1);

    mock.with(|n| {
        n.failures = std::iter::repeat_n(SourceError::Failed("down".into()), 6).collect();
    });
    let mut waits = Vec::new();
    for _ in 0..6 {
        let Event::PollFailed { retry_in, .. } = next_cycle(&mut ev).await else {
            panic!()
        };
        waits.push(retry_in.as_secs());
    }
    assert_eq!(waits, vec![2, 4, 8, 16, 30, 30]);
    mock.send(&tx(&[coin(50)], 1, 50));
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.added, s.size), (1, 2));
    assert_eq!(txids(&tracker), pool_txids(&mock));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn a_failed_fetch_publishes_nothing_and_resumes_where_it_stopped() {
    let mock = Mock::new();
    for i in 0..6 {
        mock.send(&tx(&[coin(i)], 1, i));
    }
    // Batches of 2, one at a time: the second of three batches fails.
    mock.with(|n| n.detail_failures = VecDeque::from(vec![None, Some(SourceError::Busy)]));
    let mut cfg = config();
    cfg.in_flight = 1;
    let (tracker, task) = Tracker::start(mock.clone(), cfg);
    let mut ev = tracker.events();
    let (_, mut sub) = tracker.subscribe(|_| ());
    let Event::PollFailed { error, .. } = next_cycle(&mut ev).await else {
        panic!()
    };
    assert_eq!(error, SourceError::Busy);
    assert!(tracker.read(|m| m.is_empty()), "nothing applied");
    assert!(
        tokio::time::timeout(Duration::ZERO, sub.recv())
            .await
            .is_err()
    );
    // The retry fetches only the four it does not hold yet.
    let s = cycle(next_cycle(&mut ev).await);
    // The probe (after a failure, `getmempoolinfo` alone), listing, tip, two detail batches;
    // the block is still held.
    assert_eq!((s.added, s.size, s.calls, s.blocks), (6, 6, 5, 0));
    assert_eq!(mock.n.details.load(Ordering::SeqCst), 4);
    let d = sub.recv().await.unwrap();
    assert_eq!((d.seq, d.added.len()), (1, 6));

    // Over the size cap: batches are halved until they fit.
    mock.with(|n| n.max_batch = Some(1));
    mock.send(&tx(&[coin(10)], 1, 10));
    mock.send(&tx(&[coin(11)], 1, 11));
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.added, s.size), (2, 8));
    // A single transaction that never fits is skipped; the rest of the cycle still lands.
    mock.with(|n| n.max_batch = Some(0));
    mock.send(&tx(&[coin(12)], 1, 12));
    mock.with(|n| {
        n.pool
            .retain(|t| t.compute_txid() != tx(&[coin(10)], 1, 10).compute_txid())
    });
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.added, s.vanished, s.evicted, s.size), (0, 1, 1, 7));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn vanished_transactions_are_skipped_then_forgotten() {
    let mock = Mock::new();
    let (a, b) = (tx(&[coin(0)], 1, 1), tx(&[coin(1)], 1, 2));
    mock.send(&a);
    mock.send(&b);
    mock.with(|n| {
        n.vanish.insert(b.compute_txid());
    });
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.added, s.vanished, s.size), (1, 1, 1));
    // Readable again in an unchanged pool: the probe must not skip it until the heartbeat.
    mock.with(|n| n.vanish.clear());
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.added, s.vanished, s.skipped, s.size), (1, 0, 0, 2));
    // Gone for real; the next cycle classifies its removal.
    mock.with(|n| n.pool.retain(|t| t.compute_txid() != b.compute_txid()));
    mock.send(&tx(&[coin(2)], 1, 3));
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.added, s.vanished, s.evicted, s.size), (1, 0, 1, 2));
    assert_eq!(txids(&tracker), pool_txids(&mock));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn restarts_emptied_pools_and_sequence_regressions() {
    let mock = Mock::new();
    for i in 0..4 {
        mock.send(&tx(&[coin(i)], 1, i));
    }
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    // The node restarts with an empty pool and a reset sequence.
    mock.with(|n| {
        n.pool.clear();
        n.sequence = 1;
    });
    let mut regressed = None;
    let s = loop {
        match ev.recv().await.unwrap() {
            Event::SequenceRegressed { from, to } => regressed = Some((from, to)),
            Event::Cycle(s) => break s,
            _ => {}
        }
    };
    assert_eq!(regressed, Some((5, 1)));
    assert_eq!((s.evicted, s.size), (4, 0));
    assert!(tracker.read(|m| m.is_empty()));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn reorgs_return_transactions_and_confirm_the_new_chain() {
    let mock = Mock::new();
    let (a, b) = (tx(&[coin(0)], 1, 1), tx(&[coin(1)], 1, 2));
    mock.send(&a);
    mock.send(&b);
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    let fork_base = mock.with(|n| n.tip.unwrap());
    let old = mock.mine(&[&a]);
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!(s.confirmed, 1);
    // A heavier branch from the same parent confirms `b` and a rival of nothing;
    // `a` returns to the mempool.
    let rival_b = tx(&[coin(1)], 1, 99);
    mock.with(|n| {
        n.pool.push(a.clone());
        n.blocks.remove(&old.block_hash());
        let x = Mock::connect(
            n,
            block(fork_base.height + 1, fork_base.hash, &[&rival_b]),
            fork_base.height + 1,
        );
        let y = block(fork_base.height + 2, x.block_hash(), &[]);
        Mock::connect(n, y, fork_base.height + 2);
    });
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.added, s.replaced, s.size), (1, 1, 1));
    assert_eq!(txids(&tracker), HashSet::from([a.compute_txid()]));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn a_slow_subscriber_is_told_to_resubscribe() {
    let mock = Mock::new();
    let mut cfg = config();
    cfg.subscriber_queue = 2;
    let (tracker, task) = Tracker::start(mock.clone(), cfg);
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    let (seq, mut sub) = tracker.subscribe(|m| m.seq());
    for i in 0..4 {
        mock.send(&tx(&[coin(i)], 1, i));
        cycle(next_cycle(&mut ev).await);
    }
    assert_eq!(sub.recv().await.unwrap_err(), RecvError::Lagged(2));
    let lag = loop {
        if let Event::SubscriberLagged { missed } = ev.recv().await.unwrap() {
            break missed;
        }
    };
    assert_eq!(lag, 2);
    // After the lag it continues with the newest deltas it still holds.
    assert_eq!(sub.recv().await.unwrap().seq, seq + 3);
    // A fresh subscription starts consistent again.
    let (seq, _sub) = tracker.subscribe(|m| m.seq());
    assert_eq!(seq, tracker.read(|m| m.seq()));
    task.abort();
}

// A block announced by the node: `Tracker::block_found`.

/// The next `Block` event, skipping others.
async fn next_block(ev: &mut tokio::sync::broadcast::Receiver<Event>) -> super::CycleStats {
    loop {
        if let Event::Block(s) = ev.recv().await.unwrap() {
            return s;
        }
    }
}

fn found(mock: &Mock) -> ChainTip {
    mock.with(|n| n.tip.unwrap())
}

#[tokio::test(start_paused = true)]
async fn a_found_block_leaves_at_once_from_its_own_transactions() {
    let mock = Mock::new();
    // `a` confirms; `rival` loses its coin to `winner`, and takes its child with it; `stays`
    // spends an output of `a` and stays.
    let a = tx(&[coin(0)], 2, 1);
    let rival = tx(&[coin(1)], 1, 2);
    let child = tx(&[out(&rival, 0)], 1, 3);
    let stays = tx(&[out(&a, 1)], 1, 4);
    for t in [&a, &rival, &child, &stays] {
        mock.send(t);
    }
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    let (_, mut sub) = tracker.subscribe(|_| ());
    let listings = mock.n.listings.load(Ordering::SeqCst);

    let winner = tx(&[coin(1)], 1, 5);
    let blk = mock.mine(&[&a, &winner]);
    tracker.block_found(found(&mock));
    let s = next_block(&mut ev).await;
    assert_eq!((s.confirmed, s.replaced, s.evicted, s.blocks), (1, 2, 0, 1));
    assert_eq!(s.calls, 2, "one tip read and the block");
    assert_eq!(s.tip, Some(tip(&blk, 1)));
    let d = sub.recv().await.unwrap();
    let by = Removal::Replaced {
        by: winner.compute_txid(),
    };
    let mut want = vec![
        (
            a.compute_txid(),
            Removal::Confirmed {
                height: 1,
                block: blk.block_hash(),
            },
        ),
        (rival.compute_txid(), by),
        (child.compute_txid(), by),
    ];
    want.sort_unstable_by_key(|(t, _)| *t);
    assert_eq!(d.removed, want);
    assert!(d.added.is_empty());
    assert_eq!(txids(&tracker), pool_txids(&mock));
    assert_eq!(
        mock.n.listings.load(Ordering::SeqCst),
        listings,
        "no listing"
    );

    // The next cycle finds nothing left to do, and fetches no block again.
    let blocks = mock.n.blocks.load(Ordering::SeqCst);
    tracker.tip_changed();
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!((s.seq, s.blocks), (None, 0));
    assert_eq!(mock.n.blocks.load(Ordering::SeqCst), blocks);
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn a_block_found_during_a_poll_leaves_with_that_poll() {
    let mock = Mock::new();
    let a = tx(&[coin(0)], 1, 1);
    mock.send(&a);
    mock.with(|n| n.delay = Duration::from_millis(100));
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    let (_, mut sub) = tracker.subscribe(|_| ());
    // Mined after the next listing read the pool but before the cycle reads the tip: the
    // listing still holds `a`, the tip is the new block's.
    while mock.n.listings_in_flight.load(Ordering::SeqCst) == 0 {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    while mock.n.listings_in_flight.load(Ordering::SeqCst) == 1 {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    let at = tokio::time::Instant::now();
    mock.mine(&[&a]);
    tracker.block_found(found(&mock));
    // That cycle drops `a` itself: no delta on the new tip still holds it.
    let c = cycle(next_cycle(&mut ev).await);
    assert_eq!((c.tip.unwrap().height, c.confirmed), (1, 1));
    let d = sub.recv().await.unwrap();
    assert_eq!(d.tip.height, 1);
    assert_eq!(d.removed.len(), 1);
    assert!(tracker.read(Mempool::is_empty));
    assert!(
        at.elapsed() < Duration::from_millis(500),
        "{:?}",
        at.elapsed()
    );
    // The announced block then finds nothing left to do.
    let s = next_block(&mut ev).await;
    assert_eq!((s.confirmed, s.seq, s.blocks), (0, None, 0));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn blocks_announced_before_they_are_served_are_never_lost_in_a_quiet_mempool() {
    let mock = Mock::new();
    // Nothing in `getmempoolinfo` moves: only the tip says a block came.
    mock.with(|n| n.frozen_info = true);
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    let (_, mut sub) = tracker.subscribe(|_| ());
    for height in 1..=3 {
        let served = found(&mock);
        mock.mine(&[]);
        // Announced, but Esplora still answers the old tip for 300 ms.
        mock.with(|n| n.lag = Some(served));
        let at = tokio::time::Instant::now();
        tracker.block_found(found(&mock));
        tokio::time::sleep(Duration::from_millis(300)).await;
        mock.with(|n| n.lag = None);
        let d = sub.recv().await.unwrap();
        assert_eq!(d.tip.height, height);
        assert!(d.removed.is_empty() && d.added.is_empty());
        assert!(
            at.elapsed() < Duration::from_millis(400),
            "{:?}",
            at.elapsed()
        );
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }

    // Not served for longer than the tracker waits: the cycles that follow list again, probe
    // or not, until the tip shows, instead of waiting for the 10 s heartbeat.
    let served = found(&mock);
    mock.mine(&[]);
    mock.with(|n| n.lag = Some(served));
    tracker.block_found(found(&mock));
    tokio::time::sleep(Duration::from_secs(5)).await;
    let listings = mock.n.listings.load(Ordering::SeqCst);
    mock.with(|n| n.lag = None);
    let at = tokio::time::Instant::now();
    let d = sub.recv().await.unwrap();
    assert_eq!(d.tip.height, 4);
    assert!(at.elapsed() <= Duration::from_secs(1), "{:?}", at.elapsed());
    assert!(mock.n.listings.load(Ordering::SeqCst) > listings);
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn a_burst_of_blocks_fetches_each_once_and_confirms_them_all() {
    let mock = Mock::new();
    let txs: Vec<Transaction> = (0..6).map(|i| tx(&[coin(i)], 1, i)).collect();
    for t in &txs {
        mock.send(t);
    }
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    let blocks = mock.n.blocks.load(Ordering::SeqCst);
    let at = tokio::time::Instant::now();
    for pair in txs.chunks(2) {
        mock.mine(&[&pair[0], &pair[1]]);
        tracker.block_found(found(&mock));
    }
    let mut confirmed = 0;
    while confirmed < 6 {
        match ev.recv().await.unwrap() {
            Event::Block(s) | Event::Cycle(s) => confirmed += s.confirmed,
            _ => {}
        }
    }
    assert!(tracker.read(Mempool::is_empty));
    assert_eq!(tracker.read(Mempool::tip), Some(found(&mock)));
    assert_eq!(
        mock.n.blocks.load(Ordering::SeqCst) - blocks,
        3,
        "each block once"
    );
    assert!(
        at.elapsed() < Duration::from_millis(100),
        "{:?}",
        at.elapsed()
    );
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn a_found_block_on_another_branch_lists_at_once() {
    let mock = Mock::new();
    let (a, b) = (tx(&[coin(0)], 1, 1), tx(&[coin(1)], 1, 2));
    mock.send(&a);
    mock.send(&b);
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    let base = found(&mock);
    let old = mock.mine(&[&a]);
    tracker.block_found(found(&mock));
    assert_eq!(next_block(&mut ev).await.confirmed, 1);
    // A heavier branch from the same parent confirms `b`; `a` comes back.
    mock.with(|n| {
        n.pool.push(a.clone());
        n.blocks.remove(&old.block_hash());
        let x = Mock::connect(n, block(base.height + 1, base.hash, &[&b]), base.height + 1);
        Mock::connect(
            n,
            block(base.height + 2, x.block_hash(), &[]),
            base.height + 2,
        );
    });
    let listings = mock.n.listings.load(Ordering::SeqCst);
    let at = tokio::time::Instant::now();
    tracker.block_found(found(&mock));
    assert_eq!(next_block(&mut ev).await.confirmed, 1);
    // Only a listing shows what came back: one runs at once, not at the next gap.
    let s = cycle(next_cycle(&mut ev).await);
    assert_eq!(s.added, 1);
    assert_eq!(mock.n.listings.load(Ordering::SeqCst), listings + 1);
    assert!(
        at.elapsed() < Duration::from_millis(100),
        "{:?}",
        at.elapsed()
    );
    assert_eq!(txids(&tracker), HashSet::from([a.compute_txid()]));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn a_reorg_to_the_same_height_waits_for_the_new_block() {
    let mock = Mock::new();
    mock.with(|n| n.frozen_info = true);
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    let base = found(&mock);
    mock.mine(&[]);
    tracker.block_found(found(&mock));
    let old = next_block(&mut ev).await.tip.unwrap();
    let (_, mut sub) = tracker.subscribe(|_| ());
    // A rival block at the same height wins; Esplora keeps serving the old one for 500 ms.
    let rival = mock.with(|n| {
        n.blocks.remove(&old.hash);
        let other = tx(&[coin(9)], 1, 99);
        let b = Mock::connect(
            n,
            block(base.height + 1, base.hash, &[&other]),
            base.height + 1,
        );
        n.lag = Some(old);
        tip(&b, base.height + 1)
    });
    assert_eq!(rival.height, old.height);
    assert_ne!(rival.hash, old.hash);
    let at = tokio::time::Instant::now();
    tracker.block_found(rival);
    tokio::time::sleep(Duration::from_millis(500)).await;
    mock.with(|n| n.lag = None);
    let d = sub.recv().await.unwrap();
    assert_eq!(d.tip, rival);
    assert!(
        at.elapsed() < Duration::from_millis(600),
        "{:?}",
        at.elapsed()
    );
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn a_newer_announcement_replaces_one_still_waited_for() {
    let mock = Mock::new();
    mock.with(|n| n.frozen_info = true);
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    let (_, mut sub) = tracker.subscribe(|_| ());
    let base = found(&mock);
    // B is announced but never served: before Esplora has it, C replaces it at the same height.
    let b = block(base.height + 1, base.hash, &[]);
    tracker.block_found(tip(&b, base.height + 1));
    mock.with(|n| n.lag = Some(base));
    tokio::time::sleep(Duration::from_millis(100)).await;
    let c = mock.with(|n| {
        n.lag = None;
        let c = Mock::connect(
            n,
            block(base.height + 1, base.hash, &[&tx(&[coin(9)], 1, 99)]),
            base.height + 1,
        );
        tip(&c, base.height + 1)
    });
    let at = tokio::time::Instant::now();
    tracker.block_found(c);
    let d = sub.recv().await.unwrap();
    assert_eq!(d.tip, c);
    assert!(
        at.elapsed() < Duration::from_millis(100),
        "{:?}",
        at.elapsed()
    );
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn a_replacement_announcement_still_served_late_is_not_lost() {
    let mock = Mock::new();
    mock.with(|n| n.frozen_info = true);
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    let (_, mut sub) = tracker.subscribe(|_| ());
    let base = found(&mock);
    // B, then C on top of it, are announced; Esplora serves neither for longer than the wait,
    // then B for a while, then C.
    mock.mine(&[]);
    let b = found(&mock);
    mock.mine(&[]);
    let c = found(&mock);
    mock.with(|n| n.lag = Some(base));
    tracker.block_found(b);
    tokio::time::sleep(Duration::from_millis(100)).await;
    tracker.block_found(c);
    tokio::time::sleep(Duration::from_millis(3500)).await;
    mock.with(|n| n.lag = Some(b));
    assert_eq!(sub.recv().await.unwrap().tip, b);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    mock.with(|n| n.lag = None);
    let at = tokio::time::Instant::now();
    // C is still wanted: the next cycles list despite unchanged totals, and find it.
    assert_eq!(sub.recv().await.unwrap().tip, c);
    assert!(at.elapsed() <= Duration::from_secs(1), "{:?}", at.elapsed());
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn once_the_announced_block_is_applied_quiet_probes_skip_again() {
    let mock = Mock::new();
    mock.with(|n| n.frozen_info = true);
    let (tracker, task) = Tracker::start(mock.clone(), config());
    let mut ev = tracker.events();
    cycle(next_cycle(&mut ev).await);
    let base = found(&mock);
    mock.mine(&[]);
    let b = found(&mock);
    tracker.block_found(b);
    next_block(&mut ev).await;
    // D on top of B is announced but never served: C, a rival of B, wins and is announced
    // while D is still waited for.
    let d = tip(&block(b.height + 1, b.hash, &[]), b.height + 1);
    let c = mock.with(|n| {
        let c = block(base.height + 1, base.hash, &[&tx(&[coin(9)], 1, 99)]);
        tip(&Mock::connect(n, c, base.height + 1), base.height + 1)
    });
    tracker.block_found(d);
    tokio::time::sleep(Duration::from_millis(100)).await;
    tracker.block_found(c);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(tracker.read(Mempool::tip), Some(c));
    // D is no longer wanted: unchanged probes skip the listing again until the heartbeat.
    let listings = mock.n.listings.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert!(mock.n.listings.load(Ordering::SeqCst) - listings <= 1);
    task.abort();
}

// What keeping outputs costs.

/// This process's resident memory, KB (`ps`).
fn rss_kb() -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
}

/// The non-coinbase public mainnet transactions in `fixtures/flags/mainnet.json`.
fn mainnet_sample() -> Vec<Transaction> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/flags/mainnet.json"
    );
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    rows.iter()
        .filter(|r| r["index"] != 0)
        .map(|r| {
            let hex = r["hex"].as_str().unwrap();
            let bytes: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect();
            bitcoin::consensus::deserialize(&bytes).unwrap()
        })
        .collect()
}

/// A synthetic mempool of `N` transactions (300,000 by default), each a copy of a template with
/// its own inputs and scripts, held with their outputs (`KEPT=on`, the default) or without
/// (`KEPT=off`). Templates: `MIX=mainnet`, the public mainnet transactions above in turn; or
/// `MIX=wallet`, one or two inputs paying two P2WPKH or P2TR outputs. Run once per setting, so
/// each process measures one mempool:
/// `KEPT=on MIX=mainnet cargo test --release -p engine -- --ignored --nocapture kept_outputs_memory`
#[test]
#[ignore = "a measurement, not a check"]
#[allow(clippy::print_stdout)]
fn kept_outputs_memory() {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
    let n: usize = env("N", "300000").parse().unwrap();
    let kept = env("KEPT", "on") == "on";
    let mix = env("MIX", "mainnet");
    let templates = match mix.as_str() {
        "mainnet" => mainnet_sample(),
        _ => (0..4u32)
            .map(|i| {
                let mut t = tx(&[coin(0); 2][..1 + (i as usize % 2)], 2, 0);
                let script = if i < 2 {
                    [&[0x00, 0x14][..], &[1; 20]].concat()
                } else {
                    [&[0x51, 0x20][..], &[1; 32]].concat()
                };
                for (o, v) in t.output.iter_mut().zip([84_000u64, 1_250_000]) {
                    o.script_pubkey = ScriptBuf::from_bytes(script.clone());
                    o.value = Amount::from_sat(v);
                }
                t
            })
            .collect(),
    };
    let outputs: usize = templates.iter().map(|t| t.output.len()).sum();
    let mut m = Mempool::default();
    let before = rss_kb();
    let mut seq = 0;
    let mut done = 0usize;
    while done < n {
        let mut added = Vec::with_capacity(1000);
        for i in done..(done + 1000).min(n) {
            let mut t = templates[i % templates.len()].clone();
            let tag = u32::try_from(i).unwrap();
            t.lock_time = LockTime::from_consensus(tag);
            for (j, input) in t.input.iter_mut().enumerate() {
                input.previous_output = OutPoint::new(Txid::all_zeros(), tag ^ (j as u32) << 24);
            }
            // Scripts of their own, so nothing is shared that a real mempool would not share.
            for o in &mut t.output {
                let mut s = o.script_pubkey.to_bytes();
                if let Some(last) = s.last_mut() {
                    *last ^= tag as u8;
                }
                o.script_pubkey = ScriptBuf::from_bytes(s);
            }
            let mut info = m.keys().record(&entry(&t), &t);
            if !kept {
                info.drop_outputs();
            }
            added.push((t.compute_txid(), info));
        }
        done += added.len();
        added.sort_by_key(|(t, _)| *t);
        seq += 1;
        let d = Delta {
            seq,
            mempool_sequence: seq,
            tip: ChainTip {
                height: 1,
                hash: BlockHash::all_zeros(),
            },
            added,
            removed: Vec::new(),
            replaced: Vec::new(),
            blocks: Vec::new(),
        };
        assert!(m.apply(&d));
    }
    let after = rss_kb();
    println!(
        "mix {mix} ({} templates, {:.2} outputs each), kept {kept}: {} transactions, RSS {} KB \
         ({:.1} bytes a transaction), kept outputs {} bytes ({:.1} a transaction)",
        templates.len(),
        outputs as f64 / templates.len() as f64,
        m.len(),
        after - before,
        (after - before) as f64 * 1024.0 / n as f64,
        m.kept_bytes(),
        m.kept_bytes() as f64 / n as f64,
    );
}

#[test]
fn handles_on_released_records_are_dropped_and_their_list_shrinks() {
    use super::tracker::{LEFT_SLACK, forget_released};
    use std::sync::Arc;
    // A whole mempool leaves at once: 50,000 records nothing holds, and one a subscriber does.
    let held: Arc<[u64]> = Arc::from(vec![7u64; 4]);
    let mut left: Vec<_> = (0..50_000)
        .map(|_| (Arc::downgrade(&Arc::<[u64]>::from(vec![1u64; 4])), 32))
        .collect();
    left.push((Arc::downgrade(&held), 32));
    forget_released(&mut left);
    assert_eq!(left.len(), 1, "only the record still held is counted");
    assert!(
        left.capacity() <= LEFT_SLACK,
        "the list gave its memory back"
    );
    // Released too, the last one goes, and a small list is left as it is.
    drop(held);
    forget_released(&mut left);
    assert!(left.is_empty());
}
