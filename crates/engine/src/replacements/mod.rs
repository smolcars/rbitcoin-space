//! The record of recent replacements: what replaced what, when we saw it, and each side's own
//! figures as the mempool tracker held them. Bounded, oldest out first. The server keeps it in
//! memory, fed from the tracker's change stream, and with a store also in the `replacements`
//! table ([`db`]), so it survives a restart (`docs/MEMPOOL.md`, "The replacement record").
//!
//! Read as chains (what replaced this, and what replaced that) by the `tx:` topic and `/app`, and
//! as trees (a replacement and everything it replaced, recursively) by `/api/v1`.
//!
//! A mined replacement carries its block. The record follows the chain from the tracker's own
//! window of recent blocks ([`Replacements::follow`]), so a reorg reaches it from the same source
//! the tracker trusts; what the window cannot settle is asked of the node, a bounded number of
//! reads per reorg ([`Replacements::asks`], [`ask`]).

pub mod db;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::Arc;

use bitcoin::{BlockHash, Txid};
use node::esplora::Esplora;
use serde_json::{Value, json};

use crate::mempool::{BlockSpends, TxInfo};
use crate::outputs::Outputs;

/// Most links one chain answer or message carries, in each direction. A longer history is cut
/// and marked `truncated`.
pub const MAX_LINKS: usize = 32;
/// Most transactions one tree holds. A replacement removes at most 100 transactions with their
/// descendants on rbitcoin, so a single step fits; a longer history is cut.
pub const MAX_TREE: usize = 100;
/// Most node reads one reorg may cause, failed ones included. Past it, whatever is still
/// unsettled reads [`Mined::Unknown`] and stays so.
pub const CHECKS: usize = 100;

/// Whether a replacement is confirmed, and where.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mined {
    /// Not seen in a block on the best chain.
    #[default]
    No,
    /// In this block, height and hash, on the best chain as far as the record has followed it.
    /// `None` only for a link stored before blocks were recorded, which no reorg re-examines.
    In(Option<(u32, BlockHash)>),
    /// Its block left the best chain and where it is now is not known: a check is due, failed,
    /// or was past [`CHECKS`].
    Unknown,
}

impl Mined {
    /// `true`, `false`, or `null` when unknown.
    pub fn json(self) -> Value {
        match self {
            Self::No => Value::Bool(false),
            Self::In(_) => Value::Bool(true),
            Self::Unknown => Value::Null,
        }
    }
}

/// One transaction's own figures, as the tracker held them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Facts {
    /// Base fee, sats.
    pub fee: u64,
    /// Sigop-adjusted virtual size.
    pub vsize: u32,
    pub weight: u32,
    /// Total output value, sats.
    pub value: u64,
    /// When the node accepted it, Unix seconds.
    pub time: u32,
    /// It signalled replaceability itself (BIP 125).
    pub rbf: bool,
}

impl Facts {
    pub fn of(info: &TxInfo) -> Self {
        Self {
            fee: info.fee.to_sat(),
            vsize: info.vsize,
            weight: info.weight,
            value: info.value.to_sat(),
            time: info.time,
            rbf: info.rbf,
        }
    }
}

/// One replacement: `txid` left the mempool because `by` spent one of its inputs, or one of its
/// ancestors' (a child leaves with its replaced parent and carries the same replacement).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Link {
    pub txid: Txid,
    pub by: Txid,
    /// Unix seconds when the tracker saw it.
    pub seen: u64,
    /// The replaced transaction's.
    pub tx: Facts,
    /// The replacement's, when the tracker held it: `None` when it was confirmed in the same
    /// block that removed the original, or left before we could read it.
    pub by_tx: Option<Facts>,
    /// Whether the replacement is confirmed, and where.
    pub mined: Mined,
}

/// Sat per 1,000 vB, rounded down, like every rate the server sends.
fn rate(fee: u64, vsize: u32) -> Option<u64> {
    (vsize > 0).then(|| fee.saturating_mul(1000) / u64::from(vsize))
}

impl Link {
    /// The link as the `tx:` topic and `/app` send it.
    pub fn json(&self) -> Value {
        let by_fee = self.by_tx.map(|f| f.fee);
        let by_vsize = self.by_tx.map(|f| f.vsize);
        json!({
            "txid": self.txid,
            "by": self.by,
            "seen": self.seen,
            "fee": self.tx.fee,
            "vsize": self.tx.vsize,
            "rate": rate(self.tx.fee, self.tx.vsize),
            "by_fee": by_fee,
            "by_vsize": by_vsize,
            "by_rate": self.by_tx.and_then(|f| rate(f.fee, f.vsize)),
            "mined": self.mined.json(),
            "block": match self.mined {
                Mined::In(Some((height, hash))) => json!({ "height": height, "hash": hash }),
                _ => Value::Null,
            },
        })
    }
}

/// What a link keeps beside its figures, for comparing the two versions: each side's outputs and
/// inputs. Kept beside the link rather than in it, so a [`Link`] stays `Copy`. Each is `None` when
/// it was not recorded: a link stored before outputs were (store migration 0021), a replacement
/// the tracker never held, or a transaction that arrived past the tracker's budget for outputs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Sides {
    /// The replaced transaction's outputs.
    pub outputs: Option<Outputs>,
    /// The replacement's.
    pub by_outputs: Option<Outputs>,
    /// How many inputs the replaced transaction had.
    pub inputs: Option<u32>,
    /// How many the replacement had.
    pub by_inputs: Option<u32>,
    /// How many inputs both spend, from the tracker's fingerprints when it held both. 0 means the
    /// replaced transaction left with a parent that was replaced, not as an earlier version.
    pub shared: Option<u32>,
}

impl Sides {
    /// From the tracker's records of both sides: `by` is `None` when it never held the replacement,
    /// and then `block` is the block that holds it, if the tracker's window has it: its own map
    /// of who spends what says which inputs the two share. A transaction that shares no input
    /// with its replacement left with a replaced parent: it is not an earlier version, so there is
    /// nothing to compare and no outputs are kept for it.
    pub fn of(tx: &TxInfo, by: Option<&TxInfo>, block: Option<(&BlockSpends, &Txid)>) -> Self {
        let shared = by
            .map(|b| tx.shared_inputs(b))
            .or_else(|| block.map(|(b, by)| b.shared_inputs(tx, by)));
        let compared = shared != Some(0);
        Self {
            outputs: tx.kept_outputs().filter(|_| compared),
            by_outputs: by.and_then(TxInfo::kept_outputs).filter(|_| compared),
            inputs: Some(tx.inputs()),
            by_inputs: by.map(TxInfo::inputs),
            shared,
        }
    }

    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// One version of a replaced transaction, as the record holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub facts: Facts,
    pub outputs: Option<Outputs>,
    pub inputs: Option<u32>,
}

/// One transaction in a replacement tree, and what it replaced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub txid: Txid,
    /// `None` only for a tree's newest replacement when the tracker never held it.
    pub tx: Option<Facts>,
    /// When it entered the mempool: its accept time, or for a replacement we never held, when we
    /// saw it replace.
    pub time: u64,
    /// Confirmed: only ever other than [`Mined::No`] on a tree's newest replacement.
    pub mined: Mined,
    /// What it replaced, oldest replacement first.
    pub replaces: Vec<Node>,
}

impl Node {
    /// Whether anything below it was replaced without signalling (full RBF).
    pub fn full_rbf(&self) -> bool {
        self.replaces
            .iter()
            .any(|c| c.tx.is_some_and(|f| !f.rbf) || c.full_rbf())
    }
}

/// One change to the record, in the order made: what the store replays.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// A replacement, as recorded.
    Link(Link),
    /// What the link for this replaced transaction keeps beside its figures; follows its
    /// [`Change::Link`] when there is anything to keep.
    Sides(Txid, Sides),
    /// Everything this transaction replaced now has its replacement in this state.
    Mined(Txid, Mined),
    /// The transaction no longer stands replaced, and what it replaced is no longer mined.
    Returned(Txid),
}

/// One node read a check needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ask {
    /// The best chain's block hash at this height.
    Hash(u32),
    /// Where this transaction is confirmed, if anywhere.
    Tx(Txid),
}

/// The node's answer to an [`Ask`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Hash(BlockHash),
    /// The block that confirms it on the best chain; `None` when it is in none.
    Tx(Option<(u32, BlockHash)>),
}

/// Where a check's reads go: the node's Esplora in the server, a script in tests.
pub trait Lookup: Send + Sync {
    /// `None` when the node could not answer.
    fn answer(&self, ask: Ask) -> impl Future<Output = Option<Answer>> + Send;
}

impl Lookup for Esplora {
    async fn answer(&self, ask: Ask) -> Option<Answer> {
        match ask {
            Ask::Hash(h) => self.block_hash(h).await.ok().map(|s| Answer::Hash(s.value)),
            Ask::Tx(t) => match self.tx_status(t, None).await {
                Ok(s) if !s.value.confirmed => Some(Answer::Tx(None)),
                // Confirmed without saying where is no answer.
                Ok(s) => s
                    .value
                    .block_height
                    .zip(s.value.block_hash)
                    .map(|b| Answer::Tx(Some(b))),
                // Neither in the mempool nor in a block.
                Err(node::esplora::Error::NotFound) => Some(Answer::Tx(None)),
                Err(_) => None,
            },
        }
    }
}

/// Asks in turn, stopping at the first failure so an unreachable node is asked once, not once
/// per read. Returns each read made, a failed one with `None`.
pub async fn ask(lookup: &impl Lookup, asks: &[Ask]) -> Vec<(Ask, Option<Answer>)> {
    let mut out = Vec::with_capacity(asks.len());
    for a in asks {
        let answer = lookup.answer(*a).await;
        let failed = answer.is_none();
        out.push((*a, answer));
        if failed {
            break;
        }
    }
    out
}

/// The bounded record.
#[derive(Debug)]
pub struct Replacements {
    cap: usize,
    /// By replaced txid, with the insertion number that `order` refers to.
    links: HashMap<Txid, (u64, Link)>,
    /// Insertion order, oldest first. Holds at most `cap` entries, some of them for links since
    /// overwritten (a transaction that came back and was replaced again).
    order: VecDeque<(u64, Txid)>,
    /// Replaced txids by their replacement, to walk a history backwards.
    replaced: HashMap<Txid, Vec<Txid>>,
    /// What each link keeps beside its figures, by replaced txid: only links that have any.
    sides: HashMap<Txid, Sides>,
    next: u64,
    /// Links recorded since the counter was last taken, for the log.
    recorded: u64,
    /// Counts every change, so a reader can tell whether an answer built earlier still holds.
    version: u64,
    /// Changes since the store last took them.
    changes: Vec<Change>,
    /// The best chain as the newest window showed it, tip first, down to the parent of the
    /// window's oldest block: height and hash.
    chain: Vec<(u32, BlockHash)>,
    /// Mined links in blocks below this height are not proven on the best chain yet: a reorg,
    /// a start or a gap the window could not see the bottom of. Walked down by [`Self::asks`].
    unproven: Option<u32>,
    /// Node reads left for the reorg being checked.
    budget: usize,
    /// Counts reorgs, so a check's answers are not applied after the chain moved again.
    epoch: u64,
}

impl Replacements {
    pub fn new(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            links: HashMap::new(),
            order: VecDeque::new(),
            replaced: HashMap::new(),
            sides: HashMap::new(),
            next: 0,
            recorded: 0,
            version: 0,
            changes: Vec::new(),
            chain: Vec::new(),
            unproven: None,
            budget: 0,
            epoch: 0,
        }
    }

    pub fn cap(&self) -> usize {
        self.cap
    }

    pub fn len(&self) -> usize {
        self.links.len()
    }

    pub fn is_empty(&self) -> bool {
        self.links.is_empty()
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    /// Links recorded since the last call.
    pub fn take_recorded(&mut self) -> u64 {
        std::mem::take(&mut self.recorded)
    }

    /// The changes made since the last call, oldest first, for the store. Links put back with
    /// [`Self::restore`] are not among them.
    pub fn take_changes(&mut self) -> Vec<Change> {
        std::mem::take(&mut self.changes)
    }

    pub fn get(&self, txid: &Txid) -> Option<&Link> {
        self.links.get(txid).map(|(_, l)| l)
    }

    /// Records a replacement seen now, and returns it as recorded: with the replacement's
    /// figures from its own old link when the tracker no longer held them.
    pub fn insert(&mut self, link: Link) -> Link {
        self.insert_with(link, Sides::default())
    }

    /// [`Self::insert`] with what the link keeps beside its figures.
    pub fn insert_with(&mut self, link: Link, sides: Sides) -> Link {
        let (link, sides) = self.restore_with(link, sides);
        self.recorded += 1;
        self.changes.push(Change::Link(link));
        if !sides.is_empty() {
            self.changes.push(Change::Sides(link.txid, sides));
        }
        link
    }

    /// Puts back a link recorded before (from the store), oldest first, without counting it as
    /// new. Returns it as [`Self::insert`] does.
    pub fn restore(&mut self, link: Link) -> Link {
        self.restore_with(link, Sides::default()).0
    }

    /// [`Self::restore`] with what the link keeps beside its figures. Returns both as recorded.
    pub fn restore_with(&mut self, mut link: Link, mut sides: Sides) -> (Link, Sides) {
        self.unlink(&link.txid);
        // `by` is back (in the mempool or a block), so what replaced it before no longer has:
        // keeping both would make a loop with no newest end. Its figures stay, as this link's:
        // a miner confirming a transaction we saw replaced is the usual way here, and the
        // tracker no longer held it.
        if let Some((old, old_sides)) = self.unlink(&link.by) {
            link.by_tx = link.by_tx.or(Some(old.tx));
            sides.by_outputs = sides.by_outputs.or(old_sides.outputs);
            sides.by_inputs = sides.by_inputs.or(old_sides.inputs);
        }
        self.next += 1;
        self.version += 1;
        self.links.insert(link.txid, (self.next, link));
        if !sides.is_empty() {
            self.sides.insert(link.txid, sides.clone());
        }
        self.order.push_back((self.next, link.txid));
        self.replaced.entry(link.by).or_default().push(link.txid);
        while self.order.len() > self.cap {
            if let Some((n, t)) = self.order.pop_front()
                && self.links.get(&t).is_some_and(|(m, _)| *m == n)
            {
                self.unlink(&t);
            }
        }
        (link, sides)
    }

    /// `txid` was confirmed in this block: if it replaced anything, its tree is now mined.
    /// Returns whether that changed the record.
    pub fn confirmed(&mut self, txid: &Txid, height: u32, block: BlockHash) -> bool {
        self.set_mined(*txid, Mined::In(Some((height, block))))
    }

    /// Whether `by`, as a replacement, is confirmed: [`Mined::No`] when it replaced nothing.
    pub fn mined(&self, by: &Txid) -> Mined {
        self.replaced_by(by)
            .iter()
            .find_map(|t| self.get(t))
            .map_or(Mined::No, |l| l.mined)
    }

    /// Puts everything `by` replaced in state `m`. Returns whether that changed anything.
    fn set_mined(&mut self, by: Txid, m: Mined) -> bool {
        let Some(list) = self.replaced.get(&by) else {
            return false;
        };
        let mut changed = false;
        for t in list {
            if let Some((_, l)) = self.links.get_mut(t)
                && l.mined != m
            {
                l.mined = m;
                changed = true;
            }
        }
        if changed {
            self.version += 1;
            self.changes.push(Change::Mined(by, m));
        }
        changed
    }

    /// Follows the best chain to the tracker's window `blocks` (tip first), as each delta
    /// carries it. Returns the window's blocks new since the last, for [`Self::originals`].
    ///
    /// A window that only extends the chain followed costs a hash comparison and a lookup per
    /// transaction of each new block. Any other (a reorg, a start, a gap longer than the
    /// window) re-examines every mined replacement: one whose block the window shows gone is
    /// placed in the window's block that holds it, else is not mined when the window shows
    /// where the chains part, else is [`Mined::Unknown`] until [`Self::asks`] finds it; one
    /// below a window that does not show where the chains part is left as it is until the
    /// walk down proves its block.
    pub fn follow(&mut self, blocks: &[Arc<BlockSpends>]) -> Vec<Arc<BlockSpends>> {
        let Some(tip) = blocks.first() else {
            return Vec::new();
        };
        if self.chain.first().is_some_and(|(_, h)| *h == tip.hash) {
            return Vec::new();
        }
        let mut chain: Vec<(u32, BlockHash)> = blocks.iter().map(|b| (b.height, b.hash)).collect();
        if let Some(b) = blocks.last()
            && let Some(h) = b.height.checked_sub(1)
        {
            chain.push((h, b.prev));
        }
        let old = std::mem::replace(&mut self.chain, chain);
        let new: Vec<Arc<BlockSpends>> = blocks
            .iter()
            .filter(|b| !old.iter().any(|(_, h)| *h == b.hash))
            .cloned()
            .collect();
        if !old.first().is_some_and(|o| self.chain.contains(o)) {
            self.reorged(blocks, &old);
        }
        // Whatever a new block holds is mined there, whether we saw it leave the mempool or not.
        for b in &new {
            for t in b.txids() {
                if self.replaced.contains_key(t) {
                    self.set_mined(*t, Mined::In(Some((b.height, b.hash))));
                }
            }
        }
        new
    }

    /// Replaced transactions that the `new` blocks ([`Self::follow`]) confirm themselves: the
    /// original won, after a reorg or from a miner that never saw the replacement. Each no longer
    /// stands replaced; returned with its block. Called after a delta's replacements are
    /// recorded, so one the tracker saw replace its own replacement keeps its figures
    /// ([`Self::restore`]).
    pub fn originals(&mut self, new: &[Arc<BlockSpends>]) -> Vec<(Txid, u32, BlockHash)> {
        let mut won = Vec::new();
        for b in new {
            for t in b.txids() {
                if self.links.contains_key(t) {
                    self.returned(t);
                    // What it replaced is mined with it, as `follow` found.
                    self.set_mined(*t, Mined::In(Some((b.height, b.hash))));
                    won.push((*t, b.height, b.hash));
                }
            }
        }
        won
    }

    /// The window no longer extends the chain followed: see [`Self::follow`].
    fn reorged(&mut self, blocks: &[Arc<BlockSpends>], old: &[(u32, BlockHash)]) {
        self.epoch += 1;
        self.budget = CHECKS;
        let chain = self.chain.clone();
        let at = |h: u32| chain.iter().find(|(k, _)| *k == h).map(|(_, x)| *x);
        let bottom = chain.last().map_or(0, |(h, _)| *h);
        // The highest block we knew that the window still shows: nothing at or below it moved.
        let fork = old
            .iter()
            .copied()
            .chain(self.links.values().filter_map(|(_, l)| match l.mined {
                Mined::In(Some(b)) => Some(b),
                _ => None,
            }))
            .filter(|(h, x)| at(*h) == Some(*x))
            .map(|(h, _)| h)
            .max();
        if fork.is_none() {
            self.unproven = Some(bottom);
        }
        let held = |t: &Txid| {
            blocks
                .iter()
                .find(|b| b.contains(t))
                .map(|b| (b.height, b.hash))
        };
        let mut bys: Vec<Txid> = self.replaced.keys().copied().collect();
        bys.sort_unstable();
        for by in bys {
            let m = self.mined(&by);
            let gone = match m {
                // Below the window, a block is proven only by the walk down.
                Mined::In(Some((h, x))) => h >= bottom && at(h) != Some(x),
                Mined::Unknown => true,
                Mined::In(None) | Mined::No => false,
            };
            if !gone {
                continue;
            }
            if let Some(b) = held(&by) {
                self.set_mined(by, Mined::In(Some(b)));
                continue;
            }
            // Unknown since an earlier reorg: it may be below this window, so the check decides.
            if m == Mined::Unknown {
                continue;
            }
            // Every best-chain block above the fork is in the window.
            if fork.is_some() {
                self.set_mined(by, Mined::No);
            } else {
                self.set_mined(by, Mined::Unknown);
            }
        }
    }

    /// The reads a check needs next, at most what is left of [`CHECKS`] for this reorg, with
    /// the epoch to hand back to [`Self::answers`]: the hash at the height of the highest mined
    /// block not proven on the best chain yet (the walk down), then where each unknown
    /// replacement is. `None` when nothing is due, or when this reorg's reads are spent.
    pub fn asks(&mut self) -> Option<(u64, Vec<Ask>)> {
        let walk = self.unproven.and_then(|u| {
            self.links
                .values()
                .filter_map(|(_, l)| match l.mined {
                    Mined::In(Some((h, _))) if h < u => Some(h),
                    _ => None,
                })
                .max()
        });
        if walk.is_none() {
            self.unproven = None;
        }
        let mut unknown: Vec<Txid> = self
            .replaced
            .keys()
            .filter(|by| self.mined(by) == Mined::Unknown)
            .copied()
            .collect();
        if walk.is_none() && unknown.is_empty() {
            return None;
        }
        if self.budget == 0 {
            return None;
        }
        unknown.sort_unstable();
        let mut asks: Vec<Ask> = walk.map(Ask::Hash).into_iter().collect();
        asks.extend(unknown.into_iter().map(Ask::Tx));
        asks.truncate(self.budget);
        Some((self.epoch, asks))
    }

    /// Replacements mined in a known block below height `u`.
    fn mined_below(&self, u: u32) -> Vec<Txid> {
        self.replaced
            .keys()
            .filter(|by| matches!(self.mined(by), Mined::In(Some((h, _))) if h < u))
            .copied()
            .collect()
    }

    /// Applies the reads made for the asks of `epoch`, each counted against [`CHECKS`]; a
    /// failed one (`None`) changes nothing, so it is asked again. Answers to an older epoch are
    /// dropped, and not counted against this one: the reorg since re-examined everything they
    /// were about. When the reads are spent, what is still unproven becomes [`Mined::Unknown`].
    pub fn answers(&mut self, epoch: u64, answers: &[(Ask, Option<Answer>)]) {
        if epoch != self.epoch {
            return;
        }
        self.budget = self.budget.saturating_sub(answers.len());
        for (ask, answer) in answers {
            match (ask, answer) {
                (Ask::Hash(h), Some(Answer::Hash(x))) => {
                    let mut held = false;
                    for by in self.mined_below(h.saturating_add(1)) {
                        match self.mined(&by) {
                            Mined::In(Some((k, y))) if k == *h && y == *x => held = true,
                            Mined::In(Some((k, _))) if k == *h => {
                                self.set_mined(by, Mined::Unknown);
                            }
                            _ => {}
                        }
                    }
                    // Our block is still there, and so is everything below it.
                    self.unproven = (!held).then_some(*h);
                }
                (Ask::Tx(t), Some(Answer::Tx(b))) if self.mined(t) == Mined::Unknown => {
                    self.set_mined(*t, b.map_or(Mined::No, |b| Mined::In(Some(b))));
                }
                _ => {}
            }
        }
        if self.budget == 0
            && let Some(u) = self.unproven.take()
        {
            for by in self.mined_below(u) {
                self.set_mined(by, Mined::Unknown);
            }
        }
    }

    /// Drops `txid`'s link, and returns it with what it kept beside it.
    fn unlink(&mut self, txid: &Txid) -> Option<(Link, Sides)> {
        let (_, old) = self.links.remove(txid)?;
        if let Some(list) = self.replaced.get_mut(&old.by) {
            list.retain(|t| t != txid);
            if list.is_empty() {
                self.replaced.remove(&old.by);
            }
        }
        Some((old, self.sides.remove(txid).unwrap_or_default()))
    }

    /// What the link for replaced transaction `txid` keeps beside its figures.
    pub fn sides(&self, txid: &Txid) -> Option<&Sides> {
        self.sides.get(txid)
    }

    /// `txid` as one version of a replaced transaction, if the record holds its figures: as a
    /// replaced transaction, or as the replacement of one. Its outputs and inputs come from
    /// whichever of its links kept them.
    pub fn version_of(&self, txid: &Txid) -> Option<Version> {
        let own = self.get(txid).map(|l| (l.tx, self.sides(txid)));
        let links = self.replaced_by(txid);
        let as_by = || links.iter().filter_map(|t| self.sides(t));
        // Each field from whichever link kept it: a later link can lack what an earlier one has
        // (it came back past the tracker's budget for outputs, say).
        let facts = own
            .map(|(f, _)| f)
            .or_else(|| links.iter().find_map(|t| self.get(t).and_then(|l| l.by_tx)))?;
        let own = own.and_then(|(_, s)| s);
        Some(Version {
            facts,
            outputs: own
                .and_then(|s| s.outputs.clone())
                .or_else(|| as_by().find_map(|s| s.by_outputs.clone())),
            inputs: own
                .and_then(|s| s.inputs)
                .or_else(|| as_by().find_map(|s| s.by_inputs)),
        })
    }

    /// What replaced `txid`, then what replaced that, to the newest we know: at most
    /// [`MAX_LINKS`], and `true` if there were more.
    pub fn chain(&self, txid: &Txid) -> (Vec<Link>, bool) {
        let mut out: Vec<Link> = Vec::new();
        let mut at = *txid;
        while let Some(l) = self.get(&at) {
            // A replacement that came back and was itself replaced by an earlier one: stop.
            if out.iter().any(|o| o.txid == l.txid) {
                break;
            }
            if out.len() == MAX_LINKS {
                return (out, true);
            }
            out.push(*l);
            at = l.by;
        }
        (out, false)
    }

    /// What `txid` replaced, and what those replaced, newest first: at most [`MAX_LINKS`], and
    /// `true` if there were more. Every link reached through version links comes first, so a
    /// child that left with a replaced parent, or anything reached through one, cannot crowd an
    /// earlier version out of the cut.
    pub fn earlier(&self, txid: &Txid) -> (Vec<Link>, bool) {
        let mut out = Vec::new();
        let mut seen = HashSet::from([*txid]);
        // Version links first; each child link found is walked only once they are exhausted.
        let mut queue = VecDeque::from([*txid]);
        let mut deferred = VecDeque::new();
        let mut through_child = false;
        loop {
            let Some(by) = queue.pop_front() else {
                if through_child || deferred.is_empty() {
                    break;
                }
                through_child = true;
                queue = std::mem::take(&mut deferred);
                continue;
            };
            for t in self.replaced_by(&by) {
                let Some(l) = self.get(t) else { continue };
                // In the first pass a child link waits; after it, every link is followed.
                if !through_child && !self.is_version_link(t) {
                    if !deferred.contains(&by) {
                        deferred.push_back(by);
                    }
                    continue;
                }
                if !seen.insert(*t) {
                    continue;
                }
                if out.len() == MAX_LINKS {
                    return (out, true);
                }
                out.push(*l);
                queue.push_back(*t);
            }
        }
        (out, false)
    }

    /// Whether `txid`'s own link, to what replaced it, is a version link: it is unless it is
    /// known to be a child's, one that shares no input with its replacement (`docs/MEMPOOL.md`,
    /// "Versions"). A link whose count was not recorded counts as one.
    pub fn is_version_link(&self, txid: &Txid) -> bool {
        self.get(txid).is_some() && self.sides(txid).and_then(|s| s.shared) != Some(0)
    }

    /// The newest version of `txid`: its replacement, and that one's, while each link is a
    /// version link. `txid` itself when nothing replaced it, or only as a child.
    pub fn newest_version(&self, txid: &Txid) -> Txid {
        let mut at = *txid;
        let mut walked = HashSet::new();
        while self.is_version_link(&at) && walked.insert(at) {
            match self.get(&at) {
                Some(l) => at = l.by,
                None => break,
            }
        }
        at
    }

    /// Whether `a` and `b` are versions of one another: joined by version links only. Each
    /// transaction has at most one link of its own, so they are joined exactly when following
    /// version links from each ends at the same transaction.
    pub fn are_versions(&self, a: &Txid, b: &Txid) -> bool {
        a != b && self.newest_version(a) == self.newest_version(b)
    }

    /// Every version of `txid`, oldest first (the farthest from the newest first, then by txid),
    /// `txid` among them: at most [`MAX_LINKS`] + 1, and `true` if there were more. Empty when
    /// `txid` has no other version.
    pub fn versions(&self, txid: &Txid) -> (Vec<Txid>, bool) {
        let newest = self.newest_version(txid);
        // The path from `txid` to the newest, walked whole (the record bounds it, and a version
        // link is followed once). Of a path longer than the line holds, three things are always
        // kept: `txid`, what replaced it (the pair its page compares first), and the versions
        // nearest the newest, the newest among them; and the line says there were more.
        let mut depth: HashMap<Txid, usize> = HashMap::new();
        let mut path = vec![*txid];
        let mut on_path = HashSet::from([*txid]);
        while let Some(last) = path.last().copied()
            && last != newest
        {
            match self.get(&last) {
                Some(l) if on_path.insert(l.by) => path.push(l.by),
                _ => break,
            }
        }
        let n = path.len();
        let mut more = n > MAX_LINKS + 1;
        let nearest = if more { MAX_LINKS - 1 } else { n };
        for (i, t) in path.iter().enumerate() {
            if i <= 1 || n - i <= nearest {
                depth.insert(*t, n - 1 - i);
            }
        }
        // Then the rest, nearest the newest first, through version links only.
        let mut queue = VecDeque::from([newest]);
        let mut walked = HashSet::from([newest]);
        while let Some(by) = queue.pop_front() {
            let d = depth.get(&by).copied().unwrap_or(0);
            for t in self.replaced_by(&by) {
                if !self.is_version_link(t) || !walked.insert(*t) {
                    continue;
                }
                if !depth.contains_key(t) {
                    if depth.len() > MAX_LINKS {
                        more = true;
                        continue;
                    }
                    depth.insert(*t, d + 1);
                }
                queue.push_back(*t);
            }
        }
        if depth.len() < 2 {
            return (Vec::new(), false);
        }
        let mut out: Vec<(usize, Txid)> = depth.into_iter().map(|(t, d)| (d, t)).collect();
        out.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        (out.into_iter().map(|(_, t)| t).collect(), more)
    }

    /// What `txid` itself replaced, oldest first.
    pub fn replaced_by(&self, txid: &Txid) -> &[Txid] {
        self.replaced.get(txid).map_or(&[], Vec::as_slice)
    }

    /// `txid`'s own figures, if the record holds them: as a replaced transaction, or as the
    /// replacement of one.
    pub fn facts(&self, txid: &Txid) -> Option<Facts> {
        self.get(txid).map(|l| l.tx).or_else(|| {
            self.replaced_by(txid)
                .iter()
                .find_map(|t| self.get(t).and_then(|l| l.by_tx))
        })
    }

    /// The newest replacement in `txid`'s history: `txid` itself if nothing replaced it.
    /// The walk is as long as the history, which the record's bound limits.
    pub fn root(&self, txid: &Txid) -> Txid {
        self.root_with(txid, &mut HashMap::new())
    }

    /// [`Self::root`], remembering every transaction walked through in `memo`, so walking every
    /// link of the record costs one step per link.
    fn root_with(&self, txid: &Txid, memo: &mut HashMap<Txid, Txid>) -> Txid {
        let mut path = Vec::new();
        let mut walked = HashSet::new();
        let mut at = *txid;
        let root = loop {
            if let Some(r) = memo.get(&at) {
                break *r;
            }
            // `restore` leaves no loop; this guards the walk all the same.
            if !walked.insert(at) {
                break at;
            }
            match self.get(&at) {
                Some(l) => {
                    path.push(at);
                    at = l.by;
                }
                None => break at,
            }
        };
        for t in path {
            memo.insert(t, root);
        }
        root
    }

    /// `txid` is in the mempool again (rebroadcast, or back from a block a reorg undid): it no
    /// longer stands replaced, and what it replaced is no longer mined. Returns whether that
    /// changed the record.
    pub fn returned(&mut self, txid: &Txid) -> bool {
        let mut changed = self.links.contains_key(txid);
        self.unlink(txid);
        if let Some(list) = self.replaced.get(txid) {
            for t in list {
                if let Some((_, l)) = self.links.get_mut(t)
                    && l.mined != Mined::No
                {
                    l.mined = Mined::No;
                    changed = true;
                }
            }
        }
        if changed {
            self.version += 1;
            self.changes.push(Change::Returned(*txid));
        }
        changed
    }

    /// The tree of `txid`'s history: its newest replacement and everything that replaced,
    /// recursively, up to [`MAX_TREE`] transactions. `None` if `txid` neither replaced nor was
    /// replaced.
    pub fn tree(&self, txid: &Txid) -> Option<Node> {
        let root = self.root(txid);
        let first = self.replaced_by(&root);
        if first.is_empty() {
            return None;
        }
        let links: Vec<&Link> = first.iter().filter_map(|t| self.get(t)).collect();
        let tx = links.iter().find_map(|l| l.by_tx);
        let time = tx.map_or_else(
            || links.iter().map(|l| l.seen).min().unwrap_or(0),
            |f| u64::from(f.time),
        );
        let mut node = Node {
            txid: root,
            tx,
            time,
            mined: self.mined(&root),
            replaces: Vec::new(),
        };
        let mut seen = HashSet::from([root]);
        self.grow(&mut node, &mut seen);
        Some(node)
    }

    /// Adds what `node` replaced, depth first, until the tree holds [`MAX_TREE`].
    fn grow(&self, node: &mut Node, seen: &mut HashSet<Txid>) {
        for t in self.replaced_by(&node.txid) {
            if seen.len() >= MAX_TREE {
                return;
            }
            let Some(l) = self.get(t) else { continue };
            if !seen.insert(*t) {
                continue;
            }
            let mut child = Node {
                txid: *t,
                tx: Some(l.tx),
                time: u64::from(l.tx.time),
                mined: Mined::No,
                replaces: Vec::new(),
            };
            self.grow(&mut child, seen);
            node.replaces.push(child);
        }
    }

    /// The `n` newest trees, newest replacement first; with `full_rbf`, only those where
    /// something was replaced without signalling.
    pub fn recent(&self, n: usize, full_rbf: bool) -> Vec<Node> {
        let mut out = Vec::new();
        let mut roots = HashSet::new();
        let mut memo = HashMap::new();
        for (i, t) in self.order.iter().rev() {
            if out.len() >= n {
                break;
            }
            if self.links.get(t).is_none_or(|(m, _)| m != i) {
                continue;
            }
            let root = self.root_with(t, &mut memo);
            if !roots.insert(root) {
                continue;
            }
            if let Some(tree) = self.tree(&root)
                && (!full_rbf || tree.full_rbf())
            {
                out.push(tree);
            }
        }
        out
    }
}
