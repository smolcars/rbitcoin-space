//! The node's mining chunks, ordered and packed into blocks the way rbitcoin builds a template.
//! Pure: no I/O, no clock.

use std::cmp::Reverse;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use bitcoin::Txid;
use node::esplora::ChainTip;
use node::rpc::model::Cluster;

/// Fee bands, as in `docs/DESIGN.md` "Fee scale".
pub const BANDS: usize = 12;

/// Lower bounds of bands 2 to 12 in hundredths of a sat/vB.
pub(crate) const BAND_EDGES: [u64; BANDS - 1] = [12, 15, 20, 30, 50, 100, 150, 200, 300, 500, 1000];

/// The band a rate in sat per 1,000 vB falls in, 0 to 11. The rate is first rounded to the two
/// decimals it prints with, so the color never disagrees with the number next to it.
pub fn band(rate: u32) -> usize {
    let printed = (u64::from(rate) + 5) / 10;
    BAND_EDGES.iter().filter(|e| printed >= **e).count()
}

/// Bands the store first had: the lowest holds everything under 0.2 sat/vB.
pub const STORED_BANDS: usize = 10;

/// Virtual size per fee band as the store holds it (`docs/STORE.md`): the ten stored bands and,
/// when it was recorded, the split of the lowest at 0.12 and 0.15 sat/vB. Serialized as the 12
/// bands when the split is known and as the ten when it is not, cheapest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bands {
    /// The first is everything under 0.2 sat/vB.
    pub stored: [u64; STORED_BANDS],
    /// The parts of `stored[0]` in [0.12, 0.15) and [0.15, 0.2). `None` for data recorded
    /// before the split, which is never guessed at.
    pub split: Option<[u64; 2]>,
}

/// Nothing, split: the sum of no rows knows its split.
impl Default for Bands {
    fn default() -> Self {
        Self {
            stored: [0; STORED_BANDS],
            split: Some([0; 2]),
        }
    }
}

impl Bands {
    /// From the 12 bands, cheapest first.
    pub fn new(b: [u64; BANDS]) -> Self {
        let [b0, b1, b2, rest @ ..] = b;
        let mut stored = [0; STORED_BANDS];
        stored[0] = b0.saturating_add(b1).saturating_add(b2);
        stored[1..].copy_from_slice(&rest);
        Self {
            stored,
            split: Some([b1, b2]),
        }
    }

    /// The 12 bands when the split is known, else the ten.
    pub fn list(&self) -> Vec<u64> {
        let [b0, rest @ ..] = self.stored;
        match self.split {
            Some([b1, b2]) => [b0.saturating_sub(b1).saturating_sub(b2), b1, b2]
                .into_iter()
                .chain(rest)
                .collect(),
            None => self.stored.to_vec(),
        }
    }

    /// Adds `o` band by band. The sum knows its split only if both did.
    pub fn add(&mut self, o: &Self) {
        for (a, b) in self.stored.iter_mut().zip(o.stored) {
            *a = a.saturating_add(b);
        }
        self.split = match (self.split, o.split) {
            (Some([a1, a2]), Some([b1, b2])) => {
                Some([a1.saturating_add(b1), a2.saturating_add(b2)])
            }
            _ => None,
        };
    }
}

impl serde::Serialize for Bands {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.list())
    }
}

/// The node's chunk rate: sat per 1,000 vB, rounded down, on sigop-adjusted vbytes.
fn chunk_rate(fee: u64, adjusted_weight: u64) -> u64 {
    match adjusted_weight.div_ceil(4) {
        0 => 0,
        vsize => fee.saturating_mul(1000) / vsize,
    }
}

/// One transaction's place: 25 bytes after its 32-byte txid (`docs/MEMPOOL.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placed {
    /// Projected block, 0 for the next one. The last block holds everything beyond the others.
    pub block: u8,
    /// Effective fee rate: the rate of the chunk it is mined in, in sat per 1,000 vB.
    pub rate: u32,
    /// Sigop-adjusted virtual size.
    pub vsize: u32,
    /// Its own base fee, in satoshis.
    pub fee: u64,
    /// Its feature bits ([`crate::flags`]): the tracker's, and paid for by a child or pays for
    /// a parent from its chunk in this projection (more than
    /// [`crate::flags::CPFP_MARGIN_PERCENT`] apart).
    pub flags: u64,
}

/// Totals of one projected block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BlockSummary {
    pub txs: u32,
    /// Raw weight, which is what the block budget counts.
    pub weight: u64,
    /// Summed sigop-adjusted vsize.
    pub vsize: u64,
    /// Summed base fees, in satoshis.
    pub fees: u64,
    /// Effective rates in sat per 1,000 vB. The median is the rate at the middle vbyte.
    pub min_rate: u32,
    pub median_rate: u32,
    pub max_rate: u32,
    /// Vsize in each fee band, cheapest first: the strata a tile draws.
    pub bands: [u64; BANDS],
}

/// One projected block, transactions in mining order.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProjectedBlock {
    pub summary: BlockSummary,
    pub txs: Vec<(Txid, Placed)>,
}

/// The projected blocks at one moment. Cheap to clone: blocks are shared.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Projection {
    /// Counts up by one per published [`Delta`]; 0 before the first.
    pub seq: u64,
    /// The tracker delta this reflects ([`crate::mempool::Mempool::seq`]).
    pub mempool_seq: u64,
    pub tip: Option<ChainTip>,
    /// Some chunk data could not be read from the node, or the tracker is failing: this is the
    /// last good projection, possibly behind the node.
    pub stale: bool,
    /// [`Config::blocks`](super::Config::blocks) blocks, the last one holding the rest.
    pub blocks: Vec<Arc<ProjectedBlock>>,
}

/// What changed between two projections. Applying `removed`, then `set`, to the previous
/// projection's records gives the next one's, and `blocks` are the new totals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delta {
    pub seq: u64,
    pub mempool_seq: u64,
    pub tip: Option<ChainTip>,
    pub stale: bool,
    /// Transactions that entered, moved to another block or changed rate or flags. Sorted by
    /// txid.
    pub set: Vec<(Txid, Placed)>,
    /// Transactions that left the mempool. Sorted by txid.
    pub removed: Vec<Txid>,
    pub blocks: Vec<BlockSummary>,
}

/// Where a transaction is in the projection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Position {
    pub placed: Placed,
    /// Vsize and transactions mined before it, earlier blocks included.
    pub ahead_vsize: u64,
    pub ahead_txs: u32,
}

/// A transaction's cluster as the projector holds it: the node's chunks, in its linearization
/// order, with the members we know.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub chunks: Vec<GroupChunk>,
    /// The index in `chunks` of the chunk holding the transaction asked about.
    pub chunk: usize,
}

/// One mining chunk: its members are mined together, at its rate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupChunk {
    /// The node's chunk fee in satoshis, `prioritisetransaction` deltas included; 0 if negative.
    pub fee: u64,
    /// The node's sigop-adjusted chunk weight. It counts members we do not know yet.
    pub weight: u64,
    /// Sat per 1,000 vB, the node's rounding: every member's effective rate.
    pub rate: u32,
    /// Known members in mining order, with their place after the last pack (`None` until then).
    pub txs: Vec<(Txid, Option<Placed>)>,
}

/// How blocks are packed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Packing {
    pub blocks: usize,
    pub block_weight: u64,
    pub min_rate: u64,
}

/// What we keep for a transaction.
#[derive(Debug)]
struct Tx {
    fee: u64,
    flags: u64,
    vsize: u32,
    weight: u32,
    chunk: u64,
    pos: Option<Position>,
}

/// Mining order: the node sorts by integer rate, then fee, both descending. It breaks the
/// remaining ties by hash-map order; we break them by age.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Key {
    rate: Reverse<u64>,
    fee: Reverse<u64>,
    id: u64,
}

#[derive(Debug)]
struct Chunk {
    key: Key,
    /// Raw weight of the members we know.
    raw: u64,
    /// The node's sigop-adjusted weight of the whole chunk.
    weight: u64,
    /// Known members, in the node's linearization order.
    txs: Vec<Txid>,
    cluster: u64,
    /// The block it was packed into on the last pass.
    slot: Option<u8>,
    /// A negative modified fee (only through `prioritisetransaction`): never mined, whatever
    /// the minimum rate.
    negative: bool,
}

/// Transactions grouped into the node's chunks, chunks into clusters.
#[derive(Debug, Default)]
pub(crate) struct Model {
    txs: HashMap<Txid, Tx>,
    chunks: HashMap<u64, Chunk>,
    /// Chunk ids of each cluster, in linearization order.
    clusters: HashMap<u64, Vec<u64>>,
    order: BTreeSet<Key>,
    next: u64,
}

impl Model {
    pub fn len(&self) -> usize {
        self.txs.len()
    }

    pub fn chunks(&self) -> usize {
        self.chunks.len()
    }

    pub fn contains(&self, txid: &Txid) -> bool {
        self.txs.contains_key(txid)
    }

    pub fn txids(&self) -> impl Iterator<Item = &Txid> {
        self.txs.keys()
    }

    pub fn position(&self, txid: &Txid) -> Option<Position> {
        self.txs.get(txid)?.pos
    }

    /// The cluster holding `txid`, chunk by chunk.
    pub fn group(&self, txid: &Txid) -> Option<Group> {
        let own = self.txs.get(txid)?.chunk;
        let cluster = self.chunks.get(&own)?.cluster;
        let ids = self.clusters.get(&cluster)?;
        let chunks: Vec<GroupChunk> = ids
            .iter()
            .filter_map(|id| self.chunks.get(id).map(|c| (id, c)))
            .map(|(_, c)| GroupChunk {
                fee: c.key.fee.0,
                weight: c.weight,
                rate: u32::try_from(c.key.rate.0).unwrap_or(u32::MAX),
                txs: c
                    .txs
                    .iter()
                    .map(|t| (*t, self.txs.get(t).and_then(|x| x.pos).map(|p| p.placed)))
                    .collect(),
            })
            .collect();
        let chunk = ids
            .iter()
            .filter(|id| self.chunks.contains_key(id))
            .position(|id| *id == own)?;
        Some(Group { chunks, chunk })
    }

    /// The cluster a transaction was last seen in, to ask the node once per cluster.
    pub fn cluster_of(&self, txid: &Txid) -> Option<u64> {
        Some(self.chunks.get(&self.txs.get(txid)?.chunk)?.cluster)
    }

    fn id(&mut self) -> u64 {
        self.next += 1;
        self.next
    }

    /// A new transaction, alone in its cluster until the node says otherwise.
    pub fn add(&mut self, txid: Txid, fee: u64, vsize: u32, weight: u32, flags: u64) {
        self.remove(&txid);
        let id = self.id();
        let key = Key {
            rate: Reverse(chunk_rate(fee, u64::from(vsize) * 4)),
            fee: Reverse(fee),
            id,
        };
        self.chunks.insert(
            id,
            Chunk {
                key,
                raw: u64::from(weight),
                weight: u64::from(vsize) * 4,
                txs: vec![txid],
                cluster: id,
                slot: None,
                negative: false,
            },
        );
        self.clusters.insert(id, vec![id]);
        self.order.insert(key);
        self.txs.insert(
            txid,
            Tx {
                fee,
                flags,
                vsize,
                weight,
                chunk: id,
                pos: None,
            },
        );
    }

    /// Replaces a held transaction's tracker flags; the next pack sends it as changed. False when
    /// it is not held.
    pub fn set_flags(&mut self, txid: &Txid, flags: u64) -> bool {
        self.txs.get_mut(txid).map(|tx| tx.flags = flags).is_some()
    }

    /// Removes a transaction. Returns the members of its cluster that remain, whose chunks the
    /// node has to tell us again.
    pub fn remove(&mut self, txid: &Txid) -> Vec<Txid> {
        let Some(tx) = self.txs.remove(txid) else {
            return Vec::new();
        };
        let cluster = self.chunks.get(&tx.chunk).map(|c| c.cluster);
        self.unlink(txid, tx.chunk, tx.weight);
        cluster
            .and_then(|c| self.clusters.get(&c))
            .into_iter()
            .flatten()
            .filter_map(|id| self.chunks.get(id))
            .flat_map(|c| c.txs.iter().copied())
            .collect()
    }

    /// Takes a transaction out of its chunk, dropping the chunk and cluster once empty.
    fn unlink(&mut self, txid: &Txid, chunk: u64, weight: u32) {
        let Some(c) = self.chunks.get_mut(&chunk) else {
            return;
        };
        c.txs.retain(|t| t != txid);
        c.raw = c.raw.saturating_sub(u64::from(weight));
        if !c.txs.is_empty() {
            return;
        }
        let (key, cluster) = (c.key, c.cluster);
        self.chunks.remove(&chunk);
        self.order.remove(&key);
        if let Some(list) = self.clusters.get_mut(&cluster) {
            list.retain(|id| *id != chunk);
            if list.is_empty() {
                self.clusters.remove(&cluster);
            }
        }
    }

    /// Replaces the chunks of the transactions in `cluster` with the node's. Members we do
    /// not know (they arrived after the tracker's listing) are left out, but their fees still
    /// count in their chunk's rate. Returns false when there were such members, so the cluster
    /// is asked again once the tracker has caught up.
    pub fn apply_cluster(&mut self, cluster: &Cluster) -> bool {
        let id = self.id();
        let (mut ids, mut complete) = (Vec::new(), true);
        for ch in &cluster.chunks {
            let members: Vec<Txid> = ch
                .txs
                .iter()
                .filter(|t| self.txs.contains_key(*t))
                .copied()
                .collect();
            complete &= members.len() == ch.txs.len();
            if members.is_empty() {
                continue;
            }
            let chunk = self.id();
            let mut raw = 0;
            for m in &members {
                let Some(tx) = self.txs.get_mut(m) else {
                    continue;
                };
                let (old, weight) = (tx.chunk, tx.weight);
                tx.chunk = chunk;
                raw += u64::from(weight);
                self.unlink(m, old, weight);
            }
            let negative = ch.chunkfee.is_negative();
            let fee = u64::try_from(ch.chunkfee.to_sat()).unwrap_or(0);
            let key = Key {
                rate: Reverse(chunk_rate(fee, ch.chunkweight)),
                fee: Reverse(fee),
                id: chunk,
            };
            self.chunks.insert(
                chunk,
                Chunk {
                    key,
                    raw,
                    weight: ch.chunkweight,
                    txs: members,
                    cluster: id,
                    slot: None,
                    negative,
                },
            );
            self.order.insert(key);
            ids.push(chunk);
        }
        if !ids.is_empty() {
            self.clusters.insert(id, ids);
        }
        complete
    }

    /// The unplaced chunks of `id`'s cluster up to and including `id`: what selecting `id`
    /// pulls in. The node pulls in only unselected ancestors; earlier chunks of a cluster
    /// are the closest thing we know of, and are almost always ancestors or already placed.
    fn pull(&self, id: u64, out: &mut Vec<u64>) {
        out.clear();
        let Some(list) = self
            .chunks
            .get(&id)
            .and_then(|c| self.clusters.get(&c.cluster))
        else {
            out.push(id);
            return;
        };
        for i in list {
            if self.chunks.get(i).is_some_and(|c| c.slot.is_none()) {
                out.push(*i);
            }
            if *i == id {
                break;
            }
        }
    }

    /// Packs every chunk into blocks the way rbitcoin selects a template: best chunk first,
    /// a chunk that does not fit is skipped and later ones still tried, chunks under the
    /// minimum rate left out. The last block takes everything left. Returns the blocks and the
    /// transactions whose record changed since the last pack.
    pub fn pack(&mut self, p: Packing) -> (Vec<ProjectedBlock>, Vec<(Txid, Placed)>) {
        let n = p.blocks.clamp(2, usize::from(u8::MAX));
        for c in self.chunks.values_mut() {
            c.slot = None;
        }
        let mut queue: Vec<u64> = self.order.iter().map(|k| k.id).collect();
        let mut packed: Vec<(Vec<u64>, u64)> = Vec::with_capacity(n);
        let mut pull = Vec::new();
        for b in 0..n {
            let last = b + 1 == n;
            let (mut ids, mut used, mut rest) = (Vec::new(), 0u64, Vec::new());
            for id in queue {
                let Some(c) = self.chunks.get(&id) else {
                    continue;
                };
                if c.slot.is_some() {
                    continue;
                }
                if !last && (c.negative || c.key.rate.0 < p.min_rate) {
                    rest.push(id);
                    continue;
                }
                self.pull(id, &mut pull);
                let w: u64 = pull
                    .iter()
                    .filter_map(|i| self.chunks.get(i))
                    .map(|c| c.raw)
                    .sum();
                if !last && used + w > p.block_weight {
                    rest.push(id);
                    continue;
                }
                used += w;
                for i in &pull {
                    if let Some(c) = self.chunks.get_mut(i) {
                        c.slot = u8::try_from(b).ok();
                        ids.push(*i);
                    }
                }
            }
            packed.push((ids, used));
            queue = rest;
        }

        let (mut blocks, mut changed) = (Vec::with_capacity(n), Vec::new());
        let (mut ahead_vsize, mut ahead_txs) = (0u64, 0u32);
        for (b, (ids, weight)) in packed.into_iter().enumerate() {
            let block = u8::try_from(b).unwrap_or(u8::MAX);
            let mut txs = Vec::new();
            for id in ids {
                let Some(c) = self.chunks.get(&id) else {
                    continue;
                };
                let rate = u32::try_from(c.key.rate.0).unwrap_or(u32::MAX);
                // The chunk's own members, base fees on vsize, so equal members compare equal.
                let (fees, vsizes) = c
                    .txs
                    .iter()
                    .filter_map(|t| self.txs.get(t))
                    .fold((0u128, 0u128), |(f, v), tx| {
                        (f + u128::from(tx.fee), v + u128::from(tx.vsize))
                    });
                for t in &c.txs {
                    let Some(tx) = self.txs.get_mut(t) else {
                        continue;
                    };
                    // Its own rate and the chunk's, on one denominator: fee × the other's vsize.
                    let (own, all) = (u128::from(tx.fee) * vsizes, fees * u128::from(tx.vsize));
                    let (low, high) = (100, 100 + u128::from(crate::flags::CPFP_MARGIN_PERCENT));
                    let cpfp = match c.txs.len() > 1 {
                        true if all * low > own * high => crate::flags::PAID_BY_CHILD,
                        true if own * low > all * high => crate::flags::PAYS_FOR_PARENT,
                        _ => 0,
                    };
                    let placed = Placed {
                        block,
                        rate,
                        vsize: tx.vsize,
                        fee: tx.fee,
                        flags: tx.flags | cpfp,
                    };
                    if tx.pos.map(|p| p.placed) != Some(placed) {
                        changed.push((*t, placed));
                    }
                    tx.pos = Some(Position {
                        placed,
                        ahead_vsize,
                        ahead_txs,
                    });
                    ahead_vsize += u64::from(tx.vsize);
                    ahead_txs = ahead_txs.saturating_add(1);
                    txs.push((*t, placed));
                }
            }
            blocks.push(ProjectedBlock {
                summary: summarize(&txs, weight),
                txs,
            });
        }
        changed.sort_unstable_by_key(|(t, _)| *t);
        (blocks, changed)
    }
}

fn summarize(txs: &[(Txid, Placed)], weight: u64) -> BlockSummary {
    let mut s = BlockSummary {
        txs: u32::try_from(txs.len()).unwrap_or(u32::MAX),
        weight,
        min_rate: u32::MAX,
        ..BlockSummary::default()
    };
    for (_, p) in txs {
        s.vsize += u64::from(p.vsize);
        s.fees = s.fees.saturating_add(p.fee);
        s.min_rate = s.min_rate.min(p.rate);
        s.max_rate = s.max_rate.max(p.rate);
        if let Some(b) = s.bands.get_mut(band(p.rate)) {
            *b += u64::from(p.vsize);
        }
    }
    if txs.is_empty() {
        s.min_rate = 0;
    }
    let mut by_rate: Vec<(u32, u32)> = txs.iter().map(|(_, p)| (p.rate, p.vsize)).collect();
    by_rate.sort_unstable();
    let mut below = 0u64;
    for (rate, vsize) in by_rate {
        below += u64::from(vsize);
        if below * 2 >= s.vsize {
            s.median_rate = rate;
            break;
        }
    }
    s
}
