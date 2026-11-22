//! The in-memory mempool and the deltas that change it. Pure: no I/O, no clock.

use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, RandomState};
use std::sync::Arc;

use bitcoin::{Amount, BlockHash, OutPoint, Transaction, Txid};
use node::esplora::ChainTip;
use node::rpc::model::MempoolEntry;

use crate::outputs::{self, Outputs};

/// What we keep for every mempool transaction: 64 bytes, plus on the heap 8 per input and its
/// outputs as kept ([`crate::outputs`]), in one allocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxInfo {
    /// Base fee, without `prioritisetransaction` deltas.
    pub fee: Amount,
    /// Total output value, for the live feed.
    pub value: Amount,
    /// Sigop-adjusted virtual size, the size mining uses.
    pub vsize: u32,
    pub weight: u32,
    /// Serialized size in bytes, witness included: the projected blocks' `blockSize`.
    pub size: u32,
    /// Unix time the node accepted it, from `getmempoolentry`. Survives our own restarts.
    pub time: u32,
    /// Signals replaceability itself (BIP 125: an input's sequence below `0xfffffffe`). rbitcoin
    /// replaces regardless; kept for the `/api/v1` replacement trees' `rbf`. Fits in padding.
    pub rbf: bool,
    /// How many of `words`, at the end, hold the outputs as kept: 0 when they are not (too many,
    /// or past the tracker's budget). Fits in padding, so the record does not grow.
    kept: u16,
    /// Its feature bits in the reference's layout: from its own bytes ([`crate::flags::of`]),
    /// and [`crate::flags::REPLACEMENT`] when the tracker saw it replace another transaction.
    pub flags: u64,
    /// Output count, to find children of a removed transaction.
    pub(crate) outputs: u32,
    /// Keyed 64-bit fingerprints of the outpoints it spends, to find what replaced it; then its
    /// outputs as kept, packed little-endian into the last `kept` words, so a replacement can say
    /// what changed after the node has forgotten this version. Shared, not copied: the map and
    /// the delta that added it hold one allocation (same 16-byte pointer as a `Box`).
    words: Arc<[u64]>,
}

impl TxInfo {
    /// A record with no inputs, for building deltas in other crates' tests. Its size is its
    /// weight over four.
    pub fn new(fee: Amount, value: Amount, vsize: u32, weight: u32, time: u32) -> Self {
        Self {
            fee,
            value,
            vsize,
            weight,
            size: weight.div_ceil(4),
            time,
            rbf: false,
            kept: 0,
            flags: 0,
            outputs: 0,
            words: Arc::from([]),
        }
    }

    /// Keyed fingerprints of the outpoints it spends.
    pub(crate) fn spends(&self) -> &[u64] {
        let n = self.words.len().saturating_sub(usize::from(self.kept));
        self.words.get(..n).unwrap_or_default()
    }

    /// How many inputs it has.
    pub fn inputs(&self) -> u32 {
        u32::try_from(self.spends().len()).unwrap_or(u32::MAX)
    }

    /// Its outputs as kept: `None` when they were not (the tracker's budget for them was spent,
    /// or the record was built without them).
    pub fn kept_outputs(&self) -> Option<Outputs> {
        if self.outputs as usize > outputs::MAX_OUTPUTS {
            return Some(Outputs::TooMany(self.outputs));
        }
        if self.kept == 0 {
            return None;
        }
        let words = self.words.get(self.spends().len()..)?;
        let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
        let (_, n) = outputs::decode_n(&bytes, self.outputs as usize)?;
        Some(Outputs::Kept(bytes.get(..n)?.into()))
    }

    /// How many of the outpoints it spends `other` spends too. Exact but for a collision of the
    /// keyed 64-bit fingerprints.
    pub fn shared_inputs(&self, other: &TxInfo) -> u32 {
        let theirs: HashSet<u64> = other.spends().iter().copied().collect();
        let n = self.spends().iter().filter(|k| theirs.contains(k)).count();
        u32::try_from(n).unwrap_or(u32::MAX)
    }

    /// Whether its outputs could have been kept but were not: the tracker's budget was spent.
    /// Reads only the counts, never the outputs.
    pub(crate) fn outputs_unkept(&self) -> bool {
        self.kept == 0 && self.outputs > 0 && self.outputs as usize <= outputs::MAX_OUTPUTS
    }

    /// A handle on its allocation that does not keep it alive: whether anything still holds it.
    pub(crate) fn allocation(&self) -> std::sync::Weak<[u64]> {
        Arc::downgrade(&self.words)
    }

    /// Heap bytes its kept outputs take.
    pub fn kept_bytes(&self) -> u64 {
        u64::from(self.kept) * 8
    }

    /// Forgets its outputs, keeping its inputs, as a record made past the budget has none.
    #[cfg(test)]
    pub(crate) fn drop_outputs(&mut self) {
        if self.kept > 0 {
            self.words = Arc::from(self.spends());
            self.kept = 0;
        }
    }
}

/// Why a transaction left the mempool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Removal {
    /// It is in a block on the active chain.
    Confirmed { height: u32, block: BlockHash },
    /// `by` spends one of its inputs: a transaction that entered the mempool in the same cycle,
    /// or one confirmed in a recent block. A child of a replaced transaction carries its
    /// parent's replacement.
    Replaced { by: Txid },
    /// Neither: evicted for size, expired, or dropped for another reason the node does not
    /// report. Also the fallback where a replacement could not be seen (see `docs/MEMPOOL.md`).
    Evicted,
}

/// One change to the mempool. Deltas are numbered without gaps from 1; applying them in order
/// to the snapshot they follow reproduces the tracker's state.
#[derive(Debug, Clone, PartialEq)]
pub struct Delta {
    pub seq: u64,
    /// The node's `mempool_sequence` for the listing this delta came from. Informational: it
    /// resets when the node restarts, and the diff never relies on it.
    pub mempool_sequence: u64,
    /// The chain tip read just after that listing.
    pub tip: ChainTip,
    /// Sorted by txid.
    pub added: Vec<(Txid, TxInfo)>,
    /// Sorted by txid.
    pub removed: Vec<(Txid, Removal)>,
    /// The records of the removed transactions that were replaced, as they were held: what a
    /// replacement replaced, after it has left. Sorted by txid.
    pub replaced: Vec<(Txid, TxInfo)>,
    /// The recent active-chain blocks this delta was classified against, ending at `tip`, tip
    /// first: what a reader needs to follow the chain without asking the node. Shared, not
    /// copied.
    pub blocks: Vec<Arc<BlockSpends>>,
}

/// The tracked mempool. Read it through [`super::Tracker`].
#[derive(Debug)]
pub struct Mempool {
    txs: HashMap<Txid, TxInfo>,
    seq: u64,
    mempool_sequence: u64,
    tip: Option<ChainTip>,
    vsize: u64,
    fees: Amount,
    /// Heap bytes the held transactions' kept outputs take, for the tracker's budget.
    kept: u64,
    keys: Keys,
}

/// The secret key for outpoint fingerprints, so nobody can grind a collision.
#[derive(Debug, Clone, Default)]
pub(crate) struct Keys(RandomState);

impl Default for Mempool {
    fn default() -> Self {
        Self {
            txs: HashMap::new(),
            seq: 0,
            mempool_sequence: 0,
            tip: None,
            vsize: 0,
            fees: Amount::ZERO,
            kept: 0,
            keys: Keys::default(),
        }
    }
}

impl Keys {
    pub(crate) fn key(&self, o: &OutPoint) -> u64 {
        self.0.hash_one(o)
    }

    /// The record for a transaction from its mempool entry and its bytes, its outputs kept.
    #[cfg(test)]
    pub(crate) fn record(&self, entry: &MempoolEntry, tx: &Transaction) -> TxInfo {
        let mut room = u64::MAX;
        self.record_within(entry, tx, &mut room)
    }

    /// The record for a transaction, keeping its outputs only if they fit in `room` bytes (taken
    /// from it): past that, the encoding is dropped at once and never stored.
    pub(crate) fn record_within(
        &self,
        entry: &MempoolEntry,
        tx: &Transaction,
        room: &mut u64,
    ) -> TxInfo {
        let sat = |v: u64| u32::try_from(v).unwrap_or(u32::MAX);
        let value = tx.output.iter().fold(Amount::ZERO, |sum, o| {
            sum.checked_add(o.value).unwrap_or(Amount::MAX)
        });
        // At most `MAX_KEPT_BYTES` / 8 words, so `kept` always holds the count.
        let kept = outputs::encode_tx(&tx.output)
            .filter(|k| k.len().div_ceil(8) <= usize::from(u16::MAX))
            .filter(|k| (k.len().div_ceil(8) as u64) * 8 <= *room)
            .unwrap_or_default();
        let kept_words = kept.len().div_ceil(8);
        *room -= kept_words as u64 * 8;
        let mut words = Vec::with_capacity(tx.input.len() + kept_words);
        words.extend(tx.input.iter().map(|i| self.key(&i.previous_output)));
        words.extend(kept.chunks(8).map(|c| {
            let mut w = [0u8; 8];
            for (to, from) in w.iter_mut().zip(c) {
                *to = *from;
            }
            u64::from_le_bytes(w)
        }));
        TxInfo {
            fee: entry.fees.base,
            value,
            vsize: sat(entry.vsize),
            weight: sat(entry.weight),
            size: sat(tx.total_size() as u64),
            time: sat(entry.time),
            rbf: tx.is_explicitly_rbf(),
            kept: u16::try_from(kept_words).unwrap_or(0),
            flags: crate::flags::of(tx),
            outputs: sat(tx.output.len() as u64),
            words: words.into(),
        }
    }

    pub(crate) fn block(&self, height: u32, block: &bitcoin::Block) -> BlockSpends {
        let mut spends = HashMap::new();
        let mut txids = HashSet::with_capacity(block.txdata.len());
        for tx in &block.txdata {
            let txid = tx.compute_txid();
            txids.insert(txid);
            if !tx.is_coinbase() {
                for i in &tx.input {
                    spends.insert(self.key(&i.previous_output), txid);
                }
            }
        }
        BlockSpends {
            hash: block.block_hash(),
            prev: block.header.prev_blockhash,
            height,
            txids,
            spends,
        }
    }
}

/// What a listing adds and removes, each sorted by txid.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Diff {
    pub added: Vec<Txid>,
    pub removed: Vec<Txid>,
}

/// One recent block's transactions and the outpoints they spend.
#[derive(Debug, PartialEq, Eq)]
pub struct BlockSpends {
    pub hash: BlockHash,
    pub prev: BlockHash,
    pub height: u32,
    txids: HashSet<Txid>,
    spends: HashMap<u64, Txid>,
}

impl BlockSpends {
    pub fn contains(&self, txid: &Txid) -> bool {
        self.txids.contains(txid)
    }

    /// How many of the outpoints `tx` spends this block's transaction `by` spends too. Exact but
    /// for a collision of the keyed 64-bit fingerprints.
    pub fn shared_inputs(&self, tx: &TxInfo, by: &Txid) -> u32 {
        let n = tx
            .spends()
            .iter()
            .filter(|k| self.spends.get(k) == Some(by))
            .count();
        u32::try_from(n).unwrap_or(u32::MAX)
    }

    pub fn txids(&self) -> impl Iterator<Item = &Txid> {
        self.txids.iter()
    }

    /// A block holding `txids`, spending nothing we track: for other modules' tests.
    #[cfg(test)]
    pub(crate) fn listed(height: u32, hash: BlockHash, prev: BlockHash, txids: &[Txid]) -> Self {
        Self {
            hash,
            prev,
            height,
            txids: txids.iter().copied().collect(),
            spends: HashMap::new(),
        }
    }
}

impl Mempool {
    pub fn get(&self, txid: &Txid) -> Option<&TxInfo> {
        self.txs.get(txid)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&Txid, &TxInfo)> {
        self.txs.iter()
    }

    pub fn len(&self) -> usize {
        self.txs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.txs.is_empty()
    }

    /// The last delta applied; 0 before the first.
    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn mempool_sequence(&self) -> u64 {
        self.mempool_sequence
    }

    pub fn tip(&self) -> Option<ChainTip> {
        self.tip
    }

    /// Summed sigop-adjusted vsize.
    pub fn vsize(&self) -> u64 {
        self.vsize
    }

    pub fn fees(&self) -> Amount {
        self.fees
    }

    /// Heap bytes the held transactions' kept outputs take ([`TxInfo::kept_outputs`]).
    pub fn kept_bytes(&self) -> u64 {
        self.kept
    }

    /// Which of `txids` spends an output of which, from the inputs held for each: `(parent,
    /// child)` index pairs into `txids`, each once. Exact but for a collision of the keyed 64-bit
    /// input fingerprints. Costs one hash per output of the transactions given.
    pub fn links(&self, txids: &[Txid]) -> Vec<(usize, usize)> {
        let mut outputs = HashMap::new();
        for (i, t) in txids.iter().enumerate() {
            let n = self.txs.get(t).map_or(0, |info| info.outputs);
            for vout in 0..n {
                outputs.insert(self.keys.key(&OutPoint::new(*t, vout)), i);
            }
        }
        let mut links = Vec::new();
        for (child, t) in txids.iter().enumerate() {
            let Some(info) = self.txs.get(t) else {
                continue;
            };
            for k in info.spends() {
                if let Some(&parent) = outputs.get(k)
                    && parent != child
                    && !links.contains(&(parent, child))
                {
                    links.push((parent, child));
                }
            }
        }
        links
    }

    pub(crate) fn keys(&self) -> &Keys {
        &self.keys
    }

    pub(crate) fn diff(&self, listing: &[Txid]) -> Diff {
        let now: HashSet<&Txid> = listing.iter().collect();
        let mut added: Vec<Txid> = now
            .iter()
            .filter(|t| !self.txs.contains_key(**t))
            .map(|t| **t)
            .collect();
        let mut removed: Vec<Txid> = self
            .txs
            .keys()
            .filter(|t| !now.contains(t))
            .copied()
            .collect();
        added.sort_unstable();
        removed.sort_unstable();
        Diff { added, removed }
    }

    /// Classifies every removal. `blocks` are recent blocks on the active chain; `added` are
    /// the transactions that entered in the same cycle.
    pub(crate) fn classify(
        &self,
        removed: &[Txid],
        added: &[(Txid, TxInfo)],
        blocks: &[Arc<BlockSpends>],
    ) -> Vec<(Txid, Removal)> {
        let new_spends: HashMap<u64, Txid> = added
            .iter()
            .flat_map(|(txid, info)| info.spends().iter().map(move |k| (*k, *txid)))
            .collect();
        let mut out: Vec<(Txid, Option<Removal>)> = removed
            .iter()
            .map(|txid| {
                let spends = self.txs.get(txid).map_or(&[][..], |i| i.spends());
                let reason = blocks
                    .iter()
                    .find(|b| b.txids.contains(txid))
                    .map(|b| Removal::Confirmed {
                        height: b.height,
                        block: b.hash,
                    })
                    .or_else(|| {
                        spends.iter().find_map(|k| {
                            let by = blocks
                                .iter()
                                .find_map(|b| b.spends.get(k))
                                .or_else(|| new_spends.get(k))?;
                            Some(Removal::Replaced { by: *by })
                        })
                    });
                (*txid, reason)
            })
            .collect();

        // A child leaves with its replaced parent. Each pass settles one more generation, and
        // a pass that settles nothing ends it.
        loop {
            let replaced: HashMap<u64, Txid> = out
                .iter()
                .filter_map(|(txid, r)| match r {
                    Some(Removal::Replaced { by }) => Some((txid, *by)),
                    _ => None,
                })
                .flat_map(|(txid, by)| {
                    let outputs = self.txs.get(txid).map_or(0, |i| i.outputs);
                    (0..outputs).map(move |vout| (self.keys.key(&OutPoint::new(*txid, vout)), by))
                })
                .collect();
            let mut settled = false;
            for (txid, reason) in out.iter_mut().filter(|(_, r)| r.is_none()) {
                let spends = self.txs.get(txid).map_or(&[][..], |i| i.spends());
                if let Some(by) = spends.iter().find_map(|k| replaced.get(k)) {
                    *reason = Some(Removal::Replaced { by: *by });
                    settled = true;
                }
            }
            if !settled {
                break;
            }
        }
        out.into_iter()
            .map(|(t, r)| (t, r.unwrap_or(Removal::Evicted)))
            .collect()
    }

    /// Transactions the blocks rule out, sorted by txid: those they contain, those spending an
    /// outpoint one of their transactions spends, and the descendants of the latter. Exact while
    /// the blocks are on the active chain: the node cannot hold any of them.
    pub(crate) fn ruled_out(&self, blocks: &[Arc<BlockSpends>]) -> Vec<Txid> {
        let mut out: HashSet<Txid> = blocks
            .iter()
            .flat_map(|b| &b.txids)
            .filter(|t| self.txs.contains_key(*t))
            .copied()
            .collect();
        let spent = |k: &u64| blocks.iter().any(|b| b.spends.contains_key(k));
        let mut generation: Vec<Txid> = self
            .txs
            .iter()
            .filter(|(t, i)| !out.contains(*t) && i.spends().iter().any(spent))
            .map(|(t, _)| *t)
            .collect();
        // A child of a conflicted transaction goes with it: one pass per generation.
        while !generation.is_empty() {
            let outputs: HashSet<u64> = generation
                .iter()
                .flat_map(|t| {
                    let n = self.txs.get(t).map_or(0, |i| i.outputs);
                    (0..n).map(move |vout| self.keys.key(&OutPoint::new(*t, vout)))
                })
                .collect();
            out.extend(generation);
            generation = self
                .txs
                .iter()
                .filter(|(t, i)| {
                    !out.contains(*t) && i.spends().iter().any(|k| outputs.contains(k))
                })
                .map(|(t, _)| *t)
                .collect();
        }
        let mut out: Vec<Txid> = out.into_iter().collect();
        out.sort_unstable();
        out
    }

    /// Drops the additions the blocks rule out, as [`Mempool::ruled_out`] does for those held:
    /// contained in a block, spending what a block's transaction spends, or spending an output of
    /// a transaction that left (`removed`, the confirmed excepted) or was dropped here.
    pub(crate) fn rule_out_added(
        &self,
        added: &mut Vec<(Txid, TxInfo)>,
        removed: &[Txid],
        blocks: &[Arc<BlockSpends>],
    ) {
        let mined = |t: &Txid| blocks.iter().any(|b| b.txids.contains(t));
        let outputs = |t: Txid, n: u32| (0..n).map(move |v| self.keys.key(&OutPoint::new(t, v)));
        let mut dead: HashSet<u64> = removed
            .iter()
            .filter(|t| !mined(t))
            .flat_map(|t| outputs(*t, self.txs.get(t).map_or(0, |i| i.outputs)))
            .collect();
        loop {
            let before = added.len();
            added.retain(|(t, i)| {
                let gone = mined(t)
                    || i.spends().iter().any(|k| {
                        dead.contains(k) || blocks.iter().any(|b| b.spends.contains_key(k))
                    });
                if gone && !mined(t) {
                    dead.extend(outputs(*t, i.outputs));
                }
                !gone
            });
            if added.len() == before {
                return;
            }
        }
    }

    /// Applies the next delta. A delta out of order is refused and changes nothing.
    pub fn apply(&mut self, d: &Delta) -> bool {
        if d.seq != self.seq + 1 {
            return false;
        }
        for (txid, _) in &d.removed {
            if let Some(info) = self.txs.remove(txid) {
                self.kept = self.kept.saturating_sub(info.kept_bytes());
                self.vsize = self.vsize.saturating_sub(u64::from(info.vsize));
                self.fees = self.fees.checked_sub(info.fee).unwrap_or(Amount::ZERO);
            }
        }
        for (txid, info) in &d.added {
            if let Some(old) = self.txs.insert(*txid, info.clone()) {
                self.kept = self.kept.saturating_sub(old.kept_bytes());
                self.vsize = self.vsize.saturating_sub(u64::from(old.vsize));
                self.fees = self.fees.checked_sub(old.fee).unwrap_or(Amount::ZERO);
            }
            self.vsize += u64::from(info.vsize);
            self.kept += info.kept_bytes();
            self.fees = self.fees.checked_add(info.fee).unwrap_or(Amount::MAX);
        }
        self.seq = d.seq;
        self.mempool_sequence = d.mempool_sequence;
        self.tip = Some(d.tip);
        true
    }
}
