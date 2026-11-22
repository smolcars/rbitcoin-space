#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bitcoin::absolute::LockTime;
use bitcoin::block::{Header, Version};
use bitcoin::hashes::Hash;
use bitcoin::{
    Amount, Block, BlockHash, CompactTarget, OutPoint, ScriptBuf, Sequence, SignedAmount,
    Transaction, TxIn, TxMerkleNode, TxOut, Txid, Witness,
};
use node::esplora::ChainTip;
use node::rpc::model::{Cluster, ClusterChunk, EntryFees, MempoolEntry, MempoolInfo, RawMempool};

use super::model::{Model, Packing, Placed};
use super::{BlockSummary, ClusterSource, Config, Event, Projection, Projector, band};
use crate::mempool::{self, Source, SourceError, Tracker};

fn id(n: u8) -> Txid {
    Txid::from_byte_array([n; 32])
}

/// A cluster answer: chunks of (fee, sigop-adjusted weight, members in linearization order).
fn cluster(chunks: &[(i64, u64, &[Txid])]) -> Cluster {
    Cluster {
        clusterweight: chunks.iter().map(|c| c.1).sum(),
        txcount: chunks.iter().map(|c| c.2.len() as u64).sum(),
        chunks: chunks
            .iter()
            .map(|(fee, weight, txs)| ClusterChunk {
                chunkfee: SignedAmount::from_sat(*fee),
                chunkweight: *weight,
                txs: txs.to_vec(),
            })
            .collect(),
    }
}

const ONE_BLOCK: Packing = Packing {
    blocks: 2,
    block_weight: 4_000_000,
    min_rate: 1,
};

fn order(m: &mut Model, p: Packing) -> Vec<Vec<(Txid, Placed)>> {
    m.pack(p).0.into_iter().map(|b| b.txs).collect()
}

fn txids(block: &[(Txid, Placed)]) -> Vec<Txid> {
    block.iter().map(|(t, _)| *t).collect()
}

// The pure core.

#[test]
fn orders_by_rate_with_sub_sat_resolution() {
    let mut m = Model::default();
    m.add(id(1), 150, 1000, 4000, 0); // 0.150 sat/vB
    m.add(id(2), 2_345, 1000, 4000, 0); // 2.345
    m.add(id(3), 151, 1000, 4000, 0); // 0.151
    let blocks = order(&mut m, ONE_BLOCK);
    assert_eq!(txids(&blocks[0]), vec![id(2), id(3), id(1)]);
    let rates: Vec<u32> = blocks[0].iter().map(|(_, p)| p.rate).collect();
    assert_eq!(rates, vec![2345, 151, 150]);
    assert!(blocks[1].is_empty());
}

#[test]
fn equal_rates_go_higher_fee_first() {
    let mut m = Model::default();
    m.add(id(1), 100, 1000, 4000, 0);
    m.add(id(2), 200, 2000, 8000, 0);
    assert_eq!(txids(&order(&mut m, ONE_BLOCK)[0]), vec![id(2), id(1)]);
}

#[test]
fn a_child_lifts_its_parent() {
    let (parent, child, other) = (id(1), id(2), id(3));
    let mut m = Model::default();
    m.add(parent, 100, 1000, 4000, 0); // 0.1 sat/vB alone
    m.add(child, 10_000, 200, 800, 0);
    m.add(other, 2_000, 1000, 4000, 0); // 2 sat/vB
    // Before the node says they are one chunk, each stands alone.
    assert_eq!(
        txids(&order(&mut m, ONE_BLOCK)[0]),
        vec![child, other, parent]
    );
    assert!(m.apply_cluster(&cluster(&[(10_100, 4800, &[parent, child])])));
    let blocks = order(&mut m, ONE_BLOCK);
    assert_eq!(txids(&blocks[0]), vec![parent, child, other]);
    // Both carry the chunk's rate, 10,100 sat over 1,200 vB; each keeps its own fee.
    assert_eq!(blocks[0][0].1.rate, 8416);
    assert_eq!(blocks[0][1].1.rate, 8416);
    assert_eq!((blocks[0][0].1.fee, blocks[0][1].1.fee), (100, 10_000));
    // The group says the same: one chunk at that rate, the node's fee and weight.
    let g = m.group(&child).unwrap();
    assert_eq!((g.chunk, g.chunks.len()), (0, 1));
    let c = &g.chunks[0];
    assert_eq!((c.fee, c.weight, c.rate), (10_100, 4800, 8416));
    assert_eq!(
        c.txs,
        vec![
            (parent, Some(blocks[0][0].1)),
            (child, Some(blocks[0][1].1))
        ]
    );
    assert_eq!(
        m.group(&other).unwrap().chunks[0].txs,
        vec![(other, Some(blocks[0][2].1))]
    );
    assert_eq!(m.group(&id(9)), None);
    // When the child leaves, the parent's cluster must be asked again.
    assert_eq!(m.remove(&child), vec![parent]);
    assert!(m.apply_cluster(&cluster(&[(100, 4000, &[parent])])));
    assert_eq!(txids(&order(&mut m, ONE_BLOCK)[0]), vec![other, parent]);
}

#[test]
fn chunk_members_below_and_above_their_chunk_are_flagged() {
    use crate::flags::{PAID_BY_CHILD, PAYS_FOR_PARENT, V2};
    let (parent, child, lone, a, b) = (id(1), id(2), id(3), id(4), id(5));
    let mut m = Model::default();
    m.add(parent, 100, 1000, 4000, V2); // 0.1 sat/vB
    m.add(child, 10_000, 200, 800, V2); // 50 sat/vB
    m.add(lone, 2_000, 1000, 4000, V2);
    m.add(a, 300, 141, 561, 0); // equal rates, a weight that does not divide by four
    m.add(b, 300, 141, 561, 0);
    let flags = |m: &mut Model| -> HashMap<Txid, u64> {
        let blocks = order(m, ONE_BLOCK);
        blocks
            .iter()
            .flatten()
            .map(|(t, p)| (*t, p.flags))
            .collect()
    };
    // Alone in their chunks, nobody pays for anybody.
    assert!(
        flags(&mut m)
            .values()
            .all(|f| f & (PAID_BY_CHILD | PAYS_FOR_PARENT) == 0)
    );
    assert!(m.apply_cluster(&cluster(&[(10_100, 4800, &[parent, child])])));
    assert!(m.apply_cluster(&cluster(&[(600, 1122, &[a, b])])));
    let f = flags(&mut m);
    // The context bits join the bits from the bytes.
    assert_eq!(f[&parent], V2 | PAID_BY_CHILD);
    assert_eq!(f[&child], V2 | PAYS_FOR_PARENT);
    assert_eq!(f[&lone], V2);
    // Equal members of one chunk get neither.
    assert_eq!((f[&a], f[&b]), (0, 0));
    // Each flip is a changed record; a chunk that splits clears them.
    assert!(m.apply_cluster(&cluster(&[(10_000, 800, &[child]), (100, 4000, &[parent])])));
    let (_, changed) = m.pack(ONE_BLOCK);
    let changed: HashMap<Txid, u64> = changed.into_iter().map(|(t, p)| (t, p.flags)).collect();
    assert_eq!(changed, HashMap::from([(parent, V2), (child, V2)]));
}

/// The bits of each transaction after packing.
fn cpfp_bits(m: &mut Model) -> HashMap<Txid, u64> {
    use crate::flags::{PAID_BY_CHILD, PAYS_FOR_PARENT};
    let blocks = order(m, ONE_BLOCK);
    blocks
        .iter()
        .flatten()
        .map(|(t, p)| (*t, p.flags & (PAID_BY_CHILD | PAYS_FOR_PARENT)))
        .collect()
}

#[test]
fn only_a_chunk_more_than_ten_percent_away_flags() {
    use crate::flags::{PAID_BY_CHILD, PAYS_FOR_PARENT};
    // A parent at 1 sat/vB and a child of the same size: the chunk is exactly 10% above the
    // parent at a child fee of 1,200; one sat less is under, one more is over.
    for (child_fee, parent_bits) in [(1_199, 0), (1_200, 0), (1_201, PAID_BY_CHILD)] {
        let mut m = Model::default();
        m.add(id(1), 1_000, 1_000, 4_000, 0);
        m.add(id(2), child_fee, 1_000, 4_000, 0);
        let fee = 1_000 + i64::try_from(child_fee).unwrap();
        assert!(m.apply_cluster(&cluster(&[(fee, 8_000, &[id(1), id(2)])])));
        // The child, at most 9% above the chunk, pays for its parent by too little to say so.
        assert_eq!(
            cpfp_bits(&mut m),
            HashMap::from([(id(1), parent_bits), (id(2), 0)])
        );
    }
    // A zero-fee parent of 1,000 vB: a child of 10,000 vB is exactly 10% above the chunk; one
    // vbyte larger is under, one smaller is over. The parent pays nothing, so a child pays for it.
    for (child_vsize, child_bits) in [(10_001, 0), (10_000, 0), (9_999, PAYS_FOR_PARENT)] {
        let mut m = Model::default();
        m.add(id(1), 0, 1_000, 4_000, 0);
        m.add(id(2), 20_000, child_vsize, child_vsize * 4, 0);
        let weight = u64::from(1_000 + child_vsize) * 4;
        assert!(m.apply_cluster(&cluster(&[(20_000, weight, &[id(1), id(2)])])));
        assert_eq!(
            cpfp_bits(&mut m),
            HashMap::from([(id(1), PAID_BY_CHILD), (id(2), child_bits)])
        );
    }
}

#[test]
fn a_long_chain_lifted_by_one_member_flags_only_that_member() {
    use crate::flags::PAYS_FOR_PARENT;
    // As on mainnet: twenty members at 1 sat/vB and one at nearly double lift the chunk by 5%.
    let mut m = Model::default();
    let members: Vec<Txid> = (1..=21).map(id).collect();
    for (i, t) in members.iter().enumerate() {
        m.add(*t, if i == 20 { 199 } else { 100 }, 100, 400, 0);
    }
    assert!(m.apply_cluster(&cluster(&[(2_199, 8_400, &members)])));
    let bits = cpfp_bits(&mut m);
    assert_eq!(bits[&id(21)], PAYS_FOR_PARENT);
    assert!(members[..20].iter().all(|t| bits[t] == 0));
}

#[test]
fn new_tracker_flags_for_a_held_transaction_are_a_change() {
    use crate::flags::{REPLACEMENT, V2};
    let mut m = Model::default();
    m.add(id(1), 100, 1000, 4000, V2 | REPLACEMENT);
    m.pack(ONE_BLOCK);
    // As after a resync whose snapshot holds it again without the replacement mark.
    assert!(m.set_flags(&id(1), V2));
    assert!(!m.set_flags(&id(2), V2));
    let (_, changed) = m.pack(ONE_BLOCK);
    assert_eq!(changed.len(), 1);
    assert_eq!((changed[0].0, changed[0].1.flags), (id(1), V2));
}

#[test]
fn a_cluster_with_unknown_members_asks_again() {
    let mut m = Model::default();
    m.add(id(1), 100, 1000, 4000, 0);
    // id(2) arrived at the node after the tracker's listing.
    assert!(!m.apply_cluster(&cluster(&[(5_100, 4400, &[id(1), id(2)])])));
    let blocks = order(&mut m, ONE_BLOCK);
    assert_eq!(txids(&blocks[0]), vec![id(1)]);
    assert_eq!(blocks[0][0].1.rate, 4636);
    assert_eq!(m.position(&id(2)), None);
}

#[test]
fn blocks_fill_by_raw_weight_and_skip_what_does_not_fit() {
    let mut m = Model::default();
    let p = Packing {
        blocks: 3,
        block_weight: 1000,
        min_rate: 1,
    };
    m.add(id(1), 6000, 150, 600, 0); // 40 sat/vB
    m.add(id(2), 3000, 150, 600, 0); // 20
    m.add(id(3), 300, 75, 300, 0); // 4: does not come next, but fits the gap
    m.add(id(4), 0, 100, 400, 0); // under the minimum rate: never in a real block
    let blocks = order(&mut m, p);
    assert_eq!(txids(&blocks[0]), vec![id(1), id(3)]);
    assert_eq!(txids(&blocks[1]), vec![id(2)]);
    assert_eq!(txids(&blocks[2]), vec![id(4)]);
    assert_eq!(blocks[2][0].1.block, 2);
}

#[test]
fn a_negative_fee_chunk_is_never_mined_even_without_a_minimum_rate() {
    let mut m = Model::default();
    m.add(id(1), 0, 100, 400, 0);
    m.add(id(2), 500, 100, 400, 0);
    assert!(m.apply_cluster(&cluster(&[(-500, 400, &[id(2)])])));
    let free = Packing {
        min_rate: 0,
        ..ONE_BLOCK
    };
    let blocks = order(&mut m, free);
    // A zero fee is mined when the node's minimum is zero; a negative modified fee is not.
    assert_eq!(txids(&blocks[0]), vec![id(1)]);
    assert_eq!(txids(&blocks[1]), vec![id(2)]);
}

#[test]
fn a_chunk_pulls_in_the_unplaced_chunks_before_it() {
    // Two chunks of one cluster with the same integer rate: the child chunk has the larger
    // fee so it sorts first, and selecting it must bring its parent chunk along, first.
    let (a, b) = (id(1), id(2));
    let mut m = Model::default();
    m.add(a, 1000, 1000, 4000, 0);
    m.add(b, 2000, 2000, 8000, 0);
    assert!(m.apply_cluster(&cluster(&[(1000, 4000, &[a]), (2000, 8000, &[b])])));
    assert_eq!(txids(&order(&mut m, ONE_BLOCK)[0]), vec![a, b]);
}

#[test]
fn summaries_band_by_printed_rate() {
    // Rates are sat per 1,000 vB; band 0 is the cheapest of the 12.
    assert_eq!(band(0), 0);
    assert_eq!(band(114), 0); // 0.11
    assert_eq!(band(115), 1); // prints as 0.12
    assert_eq!(band(119), 1); // 0.119, as 0.1196 rounds down to whole sat/kvB: prints as 0.12
    assert_eq!(band(144), 1); // 0.14
    assert_eq!(band(145), 2); // prints as 0.15
    assert_eq!(band(194), 2); // 0.19
    assert_eq!(band(195), 3); // prints as 0.20
    assert_eq!(band(994), 5); // 0.99
    assert_eq!(band(995), 6); // prints as 1.00
    assert_eq!(band(1000), 6);
    assert_eq!(band(9_999), 11); // prints as 10.00
    assert_eq!(band(u32::MAX), 11);

    let mut m = Model::default();
    m.add(id(1), 150, 1000, 4000, 0); // 0.15: band 2
    m.add(id(2), 600, 2000, 8000, 0); // 0.30: band 4
    m.add(id(3), 5000, 500, 2000, 0); // 10: band 11
    let (blocks, _) = m.pack(ONE_BLOCK);
    let mut bands = [0; super::BANDS];
    (bands[2], bands[4], bands[11]) = (1000, 2000, 500);
    assert_eq!(
        blocks[0].summary,
        BlockSummary {
            txs: 3,
            weight: 14_000,
            vsize: 3500,
            fees: 5750,
            min_rate: 150,
            median_rate: 300,
            max_rate: 10_000,
            bands,
        }
    );
    assert_eq!(blocks[1].summary, BlockSummary::default());
}

#[test]
fn lookup_says_what_is_ahead() {
    let mut m = Model::default();
    let p = Packing {
        blocks: 2,
        block_weight: 4000,
        min_rate: 1,
    };
    m.add(id(1), 3000, 1000, 4000, 0);
    m.add(id(2), 2000, 1000, 4000, 0);
    m.add(id(3), 1000, 1000, 4000, 0);
    m.pack(p);
    let pos = m.position(&id(3)).unwrap();
    assert_eq!(
        (pos.placed.block, pos.ahead_txs, pos.ahead_vsize),
        (1, 2, 2000)
    );
    assert_eq!(m.position(&id(1)).unwrap().ahead_vsize, 0);
    assert_eq!(m.position(&id(9)), None);
}

#[test]
fn empty_and_small_mempools() {
    let mut m = Model::default();
    let (blocks, changed) = m.pack(Packing {
        blocks: 8,
        ..ONE_BLOCK
    });
    assert_eq!(blocks.len(), 8);
    assert!(changed.is_empty());
    assert!(blocks.iter().all(|b| b.txs.is_empty()));
    m.add(id(1), 1000, 100, 400, 0);
    let (blocks, changed) = m.pack(Packing {
        blocks: 8,
        ..ONE_BLOCK
    });
    assert_eq!(changed.len(), 1);
    assert_eq!(txids(&blocks[0].txs), vec![id(1)]);
    assert!(blocks[1..].iter().all(|b| b.txs.is_empty()));
    // Nothing moved: nothing to send.
    assert!(
        m.pack(Packing {
            blocks: 8,
            ..ONE_BLOCK
        })
        .1
        .is_empty()
    );
}

#[test]
fn a_large_cluster_keeps_its_linearization() {
    let members: Vec<Txid> = (1..=64).map(id).collect();
    let mut m = Model::default();
    for t in &members {
        m.add(*t, 100, 100, 400, 0);
    }
    let chunks: Vec<(i64, u64, &[Txid])> = members
        .chunks(8)
        .enumerate()
        .map(|(i, c)| (8000 - 100 * i as i64, 3200, c))
        .collect();
    assert!(m.apply_cluster(&cluster(&chunks)));
    assert_eq!(m.chunks(), 8);
    assert_eq!(txids(&order(&mut m, ONE_BLOCK)[0]), members);
    // Any member's group is the whole cluster in order; `chunk` points at its own.
    let g = m.group(&id(20)).unwrap();
    assert_eq!(g.chunk, 2);
    let all: Vec<Txid> = g
        .chunks
        .iter()
        .flat_map(|c| c.txs.iter().map(|t| t.0))
        .collect();
    assert_eq!(all, members);
    assert_eq!(g.chunks[2].fee, 7800);
}

// Replay of a recorded mainnet template and diagram.

#[derive(serde::Deserialize)]
struct Fixture {
    /// txid, fee, sigop-adjusted vsize, weight.
    txs: Vec<(Txid, u64, u32, u32)>,
    clusters: Vec<Cluster>,
    /// The top of the node's fee-rate diagram: (weight, fee) per chunk.
    diagram: Vec<(u64, u64)>,
    /// The node's template, in block order, cut where our recorded transactions end.
    template: Vec<Txid>,
}

#[test]
fn replays_a_mainnet_template_and_diagram() {
    let raw = include_str!("../../../../fixtures/projected/mainnet.json");
    let f: Fixture = serde_json::from_str(raw).unwrap();
    let mut m = Model::default();
    for (t, fee, vsize, weight) in &f.txs {
        m.add(*t, *fee, *vsize, *weight, 0);
    }
    for c in &f.clusters {
        assert!(m.apply_cluster(c));
    }
    let block = &order(&mut m, ONE_BLOCK)[0];
    // Our chunks in our order are the node's diagram.
    let mut ours = Vec::new();
    for (t, p) in block {
        let chunk = f
            .clusters
            .iter()
            .flat_map(|c| &c.chunks)
            .find(|c| c.txs.contains(t))
            .unwrap();
        if chunk.txs.first() == Some(t) {
            ours.push((chunk.chunkweight, chunk.chunkfee.to_sat() as u64, p.rate));
        }
    }
    for (i, (want, got)) in f.diagram.iter().zip(&ours).enumerate() {
        assert_eq!(*want, (got.0, got.1), "diagram point {i}");
    }
    // And the node's template, transaction by transaction.
    let ours = txids(block);
    assert_eq!(ours[..f.template.len()], f.template[..]);
}

// The shell, on a real tracker over a mock node.

/// Mempool transactions as the mock node holds them: (tx, fee, vsize).
#[derive(Default)]
pub(crate) struct Node {
    txs: Vec<(Transaction, u64)>,
    blocks: HashMap<BlockHash, Block>,
    tip: Option<ChainTip>,
    sequence: u64,
    clusters: HashMap<Txid, Cluster>,
    pub(crate) fail_clusters: bool,
    cluster_calls: u32,
}

#[derive(Clone, Default)]
pub(crate) struct Mock(pub(crate) Arc<Mutex<Node>>);

pub(crate) fn tx(tag: u32) -> Transaction {
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
            value: Amount::from_sat(1000),
            script_pubkey: ScriptBuf::new(),
        }],
    }
}

pub(crate) fn vsize(t: &Transaction) -> u64 {
    t.weight().to_wu().div_ceil(4)
}

pub(crate) fn block(prev: BlockHash, txs: &[&Transaction]) -> Block {
    let mut b = Block {
        header: Header {
            version: Version::TWO,
            prev_blockhash: prev,
            merkle_root: TxMerkleNode::all_zeros(),
            time: 0,
            bits: CompactTarget::from_consensus(0x207f_ffff),
            nonce: 0,
        },
        txdata: txs.iter().map(|t| (*t).clone()).collect(),
    };
    b.header.merkle_root = b.compute_merkle_root().unwrap_or(TxMerkleNode::all_zeros());
    b
}

impl Mock {
    pub(crate) fn set(&self, txs: &[(&Transaction, u64)]) {
        let mut n = self.0.lock().unwrap();
        n.txs = txs.iter().map(|(t, f)| ((*t).clone(), *f)).collect();
        n.sequence += 1;
        // Every transaction alone unless a test says otherwise.
        n.clusters = txs
            .iter()
            .map(|(t, f)| {
                let w = vsize(t) * 4;
                (
                    t.compute_txid(),
                    cluster(&[(*f as i64, w, &[t.compute_txid()])]),
                )
            })
            .collect();
    }

    fn join(&self, members: &[&Transaction], fee: i64) {
        let mut n = self.0.lock().unwrap();
        let ids: Vec<Txid> = members.iter().map(|t| t.compute_txid()).collect();
        let w = members.iter().map(|t| vsize(t) * 4).sum();
        let c = cluster(&[(fee, w, &ids)]);
        for t in ids {
            n.clusters.insert(t, c.clone());
        }
    }

    pub(crate) fn mine(&self, b: Block, height: u32) {
        let mut n = self.0.lock().unwrap();
        n.tip = Some(ChainTip {
            hash: b.block_hash(),
            height,
        });
        n.blocks.insert(b.block_hash(), b);
    }
}

impl Source for Mock {
    async fn mempool_info(&self) -> Result<MempoolInfo, SourceError> {
        let n = self.0.lock().unwrap();
        Ok(MempoolInfo {
            loaded: true,
            size: n.txs.len() as u64,
            bytes: n.sequence,
            usage: 0,
            maxmempool: 0,
            total_fee: Amount::ZERO,
            mempoolminfee: Amount::ZERO,
            minrelaytxfee: Amount::ZERO,
            incrementalrelayfee: Amount::ZERO,
            fullrbf: true,
            limitclustercount: 64,
            limitclustersize: 101,
            unbroadcastcount: 0,
        })
    }

    async fn listing(&self) -> Result<RawMempool, SourceError> {
        let n = self.0.lock().unwrap();
        Ok(RawMempool {
            mempool_sequence: n.sequence,
            txids: n.txs.iter().map(|(t, _)| t.compute_txid()).collect(),
        })
    }

    async fn details(
        &self,
        txids: &[Txid],
    ) -> Result<Vec<Option<(MempoolEntry, Transaction)>>, SourceError> {
        let n = self.0.lock().unwrap();
        Ok(txids
            .iter()
            .map(|id| {
                let (t, fee) = n.txs.iter().find(|(t, _)| t.compute_txid() == *id)?;
                let fee = Amount::from_sat(*fee);
                let signed = fee.to_signed().unwrap();
                let entry = MempoolEntry {
                    wtxid: t.compute_wtxid(),
                    vsize: vsize(t),
                    vsize_bip141: vsize(t),
                    weight: t.weight().to_wu(),
                    time: 0,
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
                    chunkweight: t.weight().to_wu(),
                    depends: Vec::new(),
                    spentby: Vec::new(),
                    bip125_replaceable: true,
                    unbroadcast: false,
                };
                Some((entry, t.clone()))
            })
            .collect())
    }

    async fn tip(&self) -> Result<ChainTip, SourceError> {
        self.0.lock().unwrap().tip.ok_or(SourceError::Busy)
    }

    async fn block(&self, hash: BlockHash) -> Result<Block, SourceError> {
        let n = self.0.lock().unwrap();
        n.blocks
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
        let mut n = self.0.lock().unwrap();
        n.cluster_calls += 1;
        if n.fail_clusters {
            return Err(SourceError::Busy);
        }
        Ok(txids.iter().map(|t| n.clusters.get(t).cloned()).collect())
    }

    fn bytes(&self) -> u64 {
        0
    }
}

/// Every record of a projection, keyed by txid.
fn records(p: &Projection) -> HashMap<Txid, Placed> {
    p.blocks
        .iter()
        .flat_map(|b| b.txs.iter().copied())
        .collect()
}

/// Waits for a delta that satisfies `done`, applying every delta to `view` on the way.
async fn until(
    sub: &mut super::Subscription,
    view: &mut (HashMap<Txid, Placed>, u64, Vec<BlockSummary>, bool),
    done: impl Fn(&HashMap<Txid, Placed>, bool) -> bool,
) {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let d = sub.recv().await.unwrap();
            assert_eq!(d.seq, view.1 + 1, "no gap, no duplicate");
            for t in &d.removed {
                assert!(view.0.remove(t).is_some(), "removed what was there");
            }
            view.0.extend(d.set.iter().copied());
            (view.1, view.2, view.3) = (d.seq, d.blocks.clone(), d.stale);
            if done(&view.0, view.3) {
                return;
            }
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn follows_the_tracker_with_exact_deltas_an_archive_and_staleness() {
    let mock = Mock::default();
    let b0 = block(BlockHash::all_zeros(), &[&tx(9_000)]);
    let h0 = b0.block_hash();
    mock.mine(b0, 0);
    let (parent, child, other) = (tx(1), tx(2), tx(3));
    mock.set(&[(&parent, 10), (&child, 5_000), (&other, 1_000)]);
    mock.join(&[&parent, &child], 5_010);

    let tracker_config = mempool::Config {
        gap: Duration::from_millis(20),
        ..mempool::Config::default()
    };
    let (tracker, tracker_task) = Tracker::start(mock.clone(), tracker_config);
    let config = Config {
        max_backoff: Duration::from_millis(300),
        ..Config::default()
    };
    let (projector, task) = Projector::start(tracker.clone(), mock.clone(), config);
    let (snapshot, mut sub) = projector.subscribe();
    let mut view = (records(&snapshot), snapshot.seq, Vec::new(), snapshot.stale);

    // The child lifts its parent above `other`.
    until(&mut sub, &mut view, |r, _| r.len() == 3).await;
    let p = projector.current();
    assert_eq!(records(&p), view.0);
    let first: Vec<Txid> = p.blocks[0].txs.iter().map(|(t, _)| *t).collect();
    assert_eq!(
        first,
        vec![
            parent.compute_txid(),
            child.compute_txid(),
            other.compute_txid()
        ]
    );
    assert_eq!(
        view.2,
        p.blocks.iter().map(|b| b.summary).collect::<Vec<_>>()
    );
    let pos = projector.position(&other.compute_txid()).unwrap();
    assert_eq!(pos.ahead_txs, 2);

    // A block confirms the parent and the child; `other` is replaced by a higher-fee spend.
    let bumped = Transaction {
        lock_time: LockTime::from_consensus(4),
        ..other.clone()
    };
    let b1 = block(h0, &[&tx(9_001), &parent, &child]);
    let h1 = b1.block_hash();
    mock.set(&[(&bumped, 2_000)]);
    mock.mine(b1, 1);
    until(&mut sub, &mut view, |r, _| {
        r.len() == 1 && r.contains_key(&bumped.compute_txid())
    })
    .await;
    assert_eq!(records(&projector.current()), view.0);
    let expected = projector.expected(&h0).unwrap();
    assert_eq!(expected.tip.height, 0);
    assert_eq!(expected.block.txs.len(), 3);
    assert!(projector.expected(&h1).is_none());

    // The node stops answering cluster requests while the mempool keeps changing: the
    // projection says it is stale, the backoff holds however often the tracker publishes,
    // and it recovers on its own.
    let before = {
        let mut n = mock.0.lock().unwrap();
        n.fail_clusters = true;
        n.cluster_calls
    };
    let mut live = vec![(bumped.clone(), 2_000)];
    for i in 0..30 {
        live.push((tx(100 + i), 700));
        let refs: Vec<(&Transaction, u64)> = live.iter().map(|(t, f)| (t, *f)).collect();
        mock.set(&refs);
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let calls = mock.0.lock().unwrap().cluster_calls - before;
    // About one a second without backoff would be 30; with it, one per 300 ms at most.
    assert!(calls <= 6, "{calls} cluster requests while backing off");
    until(&mut sub, &mut view, |_, stale| stale).await;
    mock.0.lock().unwrap().fail_clusters = false;
    until(&mut sub, &mut view, |r, stale| !stale && r.len() == 31).await;
    assert_eq!(records(&projector.current()), view.0);

    // A fee change the tracker cannot see (`prioritisetransaction` on the node) is picked up
    // at the next block, when every cluster is asked again.
    let bumped_id = bumped.compute_txid();
    mock.join(&[&bumped], 9_000);
    mock.mine(block(h1, &[&tx(9_002)]), 2);
    tracker.tip_changed(); // as the server does from Electrum's header subscription
    let lifted = u32::try_from(9_000 * 1000 / vsize(&bumped)).unwrap();
    until(&mut sub, &mut view, |r, _| r[&bumped_id].rate == lifted).await;
    assert_eq!(records(&projector.current()), view.0);

    // An empty mempool leaves empty blocks.
    mock.set(&[]);
    until(&mut sub, &mut view, |r, _| r.is_empty()).await;
    assert!(projector.current().blocks.iter().all(|b| b.txs.is_empty()));
    task.abort();
    tracker_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_found_block_is_projected_at_once_and_the_refresh_agrees() {
    let mock = Mock::default();
    let b0 = block(BlockHash::all_zeros(), &[&tx(9_000)]);
    let h0 = b0.block_hash();
    mock.mine(b0, 0);
    let (parent, child, other) = (tx(1), tx(2), tx(3));
    mock.set(&[(&parent, 10), (&child, 5_000), (&other, 1_000)]);
    mock.join(&[&parent, &child], 5_010);
    // Polls an hour apart, so only the found block can explain an update.
    let tracker_config = mempool::Config {
        gap: Duration::from_secs(3600),
        heartbeat: Duration::from_secs(3600),
        ..mempool::Config::default()
    };
    let (tracker, tracker_task) = Tracker::start(mock.clone(), tracker_config);
    let (projector, task) = Projector::start(tracker.clone(), mock.clone(), Config::default());
    let (snapshot, mut sub) = projector.subscribe();
    let mut view = (records(&snapshot), snapshot.seq, Vec::new(), snapshot.stale);
    until(&mut sub, &mut view, |r, _| r.len() == 3).await;
    let mut events = projector.events();

    // The block takes the parent and leaves its child, which now stands alone at its own rate.
    let b1 = block(h0, &[&tx(9_001), &parent]);
    let h1 = b1.block_hash();
    mock.set(&[(&child, 5_000), (&other, 1_000)]);
    mock.mine(b1, 1);
    tracker.block_found(ChainTip {
        hash: h1,
        height: 1,
    });
    let alone = u32::try_from(5_000 * 1000 / vsize(&child)).unwrap();
    until(&mut sub, &mut view, |r, _| r.len() == 2).await;
    let early = projector.current();
    assert_eq!(early.tip.map(|t| t.hash), Some(h1));
    assert_eq!(view.0[&child.compute_txid()].rate, alone);
    assert!(!view.0.contains_key(&parent.compute_txid()));

    // The refresh of every cluster that follows finds nothing to correct.
    let refresh = loop {
        if let Event::Update(u) = events.recv().await.unwrap()
            && u.refresh
        {
            break u;
        }
    };
    assert_eq!((refresh.set, refresh.removed, refresh.seq), (0, 0, None));
    assert_eq!(projector.current().seq, early.seq);

    // What we expected on the old tip is kept for the audit of the block mined on it.
    let expected = projector.expected(&h0).unwrap();
    assert_eq!(expected.tip.hash, h0);
    // With what the audit needs: the block it gave way to, and what left with that block.
    assert_eq!(expected.next.hash, h1);
    assert!(!expected.stale);
    assert_eq!(expected.left.len(), 1);
    assert_eq!(expected.left[0].0, parent.compute_txid());
    let txs: Vec<Txid> = expected.block.txs.iter().map(|(t, _)| *t).collect();
    assert_eq!(
        txs,
        vec![
            parent.compute_txid(),
            child.compute_txid(),
            other.compute_txid()
        ]
    );
    task.abort();
    tracker_task.abort();
}
