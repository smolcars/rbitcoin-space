//! Running totals the server keeps for a bounded set of very large addresses (docs/STORE.md,
//! "ledger"): the node refuses their totals above its `--max-sh-creates`, or takes minutes for
//! them, so each is asked of the node once ([`seed`]) and then kept by reading every new block
//! once ([`follow`]), whatever the number of scripts tracked.
//!
//! Every tracked script is exact at one block, the ledger's tip. A block is applied to all of them
//! in one write, and the last [`UNDO_DEPTH`] blocks' effects are kept so a reorg is undone
//! exactly. After any sequence of connects, disconnects, restarts and catch-ups, a script's totals
//! equal what the node's `/address/:a?asof=<tip>` answers (the regtest test in `tests.rs` checks
//! this against a real node).

mod db;
mod source;
#[cfg(test)]
mod tests;

use std::collections::HashMap;

use bitcoin::{BlockHash, Script, ScriptBuf, Txid};
use node::esplora::{ScriptHash, ScriptSize};
use node::rpc::model::PrevoutBlock;

pub use self::source::{HISTORY_BATCH, HISTORY_TIMEOUT, NodeSource, Source};
use crate::mempool::SourceError;
use crate::store::{self, Read, Store};
pub use node::electrum::history::Row as HistoryRow;

/// Blocks whose effects are kept for undoing a reorg. A deeper reorg drops every script, to be
/// seeded again ([`Followed::reset`]). The block table repairs to the same depth.
pub const UNDO_DEPTH: u32 = 100;
/// Newest confirmed transactions kept per script.
pub const WINDOW: usize = 200;
/// Heights per point of the balance chart: about a day.
pub const POINT_SPAN: u32 = 144;

/// A script's confirmed totals, as `chain_stats` of the node's `/address/:a`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Totals {
    pub funded_count: u64,
    pub funded_sum: u64,
    pub spent_count: u64,
    pub spent_sum: u64,
    pub tx_count: u64,
}

impl Totals {
    /// Funded minus spent, in sats.
    pub fn balance(&self) -> i64 {
        i64::try_from(self.funded_sum)
            .unwrap_or(i64::MAX)
            .saturating_sub(i64::try_from(self.spent_sum).unwrap_or(i64::MAX))
    }

    fn add(&mut self, d: &Self) -> Result<(), Error> {
        let add = |a: u64, b: u64| a.checked_add(b).ok_or(Error::OutOfRange);
        self.funded_count = add(self.funded_count, d.funded_count)?;
        self.funded_sum = add(self.funded_sum, d.funded_sum)?;
        self.spent_count = add(self.spent_count, d.spent_count)?;
        self.spent_sum = add(self.spent_sum, d.spent_sum)?;
        self.tx_count = add(self.tx_count, d.tx_count)?;
        Ok(())
    }
}

impl From<node::esplora::model::ScriptStats> for Totals {
    fn from(s: node::esplora::model::ScriptStats) -> Self {
        Self {
            funded_count: s.funded_txo_count,
            funded_sum: s.funded_txo_sum,
            spent_count: s.spent_txo_count,
            spent_sum: s.spent_txo_sum,
            tx_count: s.tx_count,
        }
    }
}

/// A block on the best chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct At {
    pub height: u32,
    pub hash: BlockHash,
    /// Header time, Unix seconds.
    pub time: u32,
}

/// A confirmed transaction of a script, as a row of the node's `/txs/summary`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxRow {
    pub txid: Txid,
    pub height: u32,
    /// In the block, coinbase 0.
    pub position: u32,
    /// Net sats for the script: funded minus spent.
    pub value: i64,
    pub time: u32,
}

/// A point of the balance chart: the balance after `height`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Point {
    pub height: u32,
    pub time: u32,
    pub balance: i64,
}

/// What the ledger holds for one script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tracked {
    /// The script itself, as kept.
    pub script: ScriptBuf,
    pub totals: Totals,
    /// The block the totals are exact at: the ledger's tip.
    pub at: At,
    /// The block the node's totals were pinned to: tracking began after it.
    pub seeded_height: u32,
    pub seeded_time: u32,
    /// The node's newest history page before the seed block was joined to the newest
    /// transactions, or found not to be needed: [`fill`] has nothing left to do.
    pub filled: bool,
    /// Where the script's whole history stands.
    pub history: History,
    /// When its whole history was last taken from the node, Unix seconds.
    pub history_taken: Option<u64>,
}

/// Where a kept script's whole history stands (docs/STORE.md, "ledger").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum History {
    /// Not taken yet, or the last try failed.
    None,
    /// Being taken from the node now.
    Taking,
    /// Every confirmed transaction is kept: the node's list at block `height`, and every block
    /// applied since.
    Whole { height: u32 },
    /// The node refused the list for size: its `--max-sh-creates` is in force.
    Refused,
    /// Dropped to keep the stored history within its bound, to be taken again when viewed.
    Dropped,
    /// More transactions than the whole bound holds.
    TooLarge,
}

impl History {
    fn from_sql(state: i64, height: Option<u32>) -> Self {
        match (state, height) {
            (1, _) => Self::Taking,
            (2, Some(height)) => Self::Whole { height },
            (3, _) => Self::Refused,
            (4, _) => Self::Dropped,
            (5, _) => Self::TooLarge,
            _ => Self::None,
        }
    }
}

/// A script's totals, newest transactions (newest first) and balance chart (oldest first), read
/// together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub tracked: Tracked,
    pub txs: Vec<TxRow>,
    pub points: Vec<Point>,
}

/// What [`seed`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seeded {
    /// Tracked from now on. `page` says whether the node's newest history page was kept too, so
    /// the newest transactions reach back before tracking began.
    Tracked { at: At, page: bool, evicted: usize },
    /// It was tracked already.
    Already,
    /// The node refused its totals for size, with the counts its refusal gave.
    Refused(Option<ScriptSize>),
}

/// What one [`follow`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Followed {
    /// Blocks applied.
    pub applied: u32,
    /// Blocks undone, for a reorg.
    pub undone: u32,
    /// Scripts dropped because a reorg took away the block they were seeded at.
    pub dropped: usize,
    /// A reorg ran deeper than [`UNDO_DEPTH`]: every script was dropped.
    pub reset: bool,
    /// The scripts whose totals changed.
    pub changed: Vec<ScriptHash>,
    /// The ledger's tip afterwards; `None` when nothing is tracked.
    pub tip: Option<At>,
}

#[derive(Debug)]
pub enum Error {
    Source(SourceError),
    Store(store::Error),
    /// The ledger's tip, or the node's chain, moved while this ran; nothing was written. Not a
    /// failure: run again.
    Moved,
    /// A total would not fit: the node's answer cannot be right.
    OutOfRange,
    /// The node's history list did not hold as many transactions as the ledger counts.
    Mismatch,
}

impl Error {
    /// A short name for logs.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Source(SourceError::Busy) => "node_busy",
            Self::Source(SourceError::TooBig) => "too_big",
            Self::Source(SourceError::Failed(_)) => "node",
            Self::Store(_) => "store",
            Self::Moved => "moved",
            Self::OutOfRange => "out_of_range",
            Self::Mismatch => "mismatch",
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Source(SourceError::Busy) => f.write_str("node busy"),
            Self::Source(SourceError::TooBig) => f.write_str("node answer too big"),
            Self::Source(SourceError::Failed(e)) => write!(f, "node: {e}"),
            Self::Store(e) => write!(f, "store: {e}"),
            Self::Moved => f.write_str("the chain moved"),
            Self::OutOfRange => f.write_str("a total out of range"),
            Self::Mismatch => f.write_str("the history list does not match the totals"),
        }
    }
}

impl std::error::Error for Error {}

impl From<SourceError> for Error {
    fn from(e: SourceError) -> Self {
        Self::Source(e)
    }
}

impl From<store::Error> for Error {
    fn from(e: store::Error) -> Self {
        Self::Store(e)
    }
}

/// What one block did to one script.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Effect {
    totals: Totals,
    /// Every transaction of the script in the block, in block order.
    rows: Vec<TxRow>,
}

/// What `block` did to each of `scripts` it touched, keyed by the script's hex as the node writes
/// it. Funded: each output paying the script. Spent: each input spending one of its outputs. A
/// transaction doing either counts once.
fn effects(
    block: &PrevoutBlock,
    scripts: &HashMap<String, ScriptHash>,
) -> Result<HashMap<ScriptHash, Effect>, Error> {
    let mut out: HashMap<ScriptHash, Effect> = HashMap::new();
    if scripts.is_empty() {
        return Ok(out);
    }
    let find = |hex: &str| -> Option<ScriptHash> {
        // The node writes lower case; anything else is matched as lower case rather than missed.
        if hex.bytes().any(|b| b.is_ascii_uppercase()) {
            scripts.get(&hex.to_ascii_lowercase()).copied()
        } else {
            scripts.get(hex).copied()
        }
    };
    let mut net: HashMap<ScriptHash, i64> = HashMap::new();
    for (position, tx) in block.tx.iter().enumerate() {
        net.clear();
        for prev in tx.vin.iter().filter_map(|i| i.prevout.as_ref()) {
            let Some(sh) = find(&prev.script_pub_key.hex) else {
                continue;
            };
            let v = prev.value.to_sat();
            let e = out.entry(sh).or_default();
            e.totals.add(&Totals {
                spent_count: 1,
                spent_sum: v,
                ..Totals::default()
            })?;
            let n = net.entry(sh).or_default();
            *n = n
                .checked_sub(i64::try_from(v).map_err(|_| Error::OutOfRange)?)
                .ok_or(Error::OutOfRange)?;
        }
        for o in &tx.vout {
            let Some(sh) = find(&o.script_pub_key.hex) else {
                continue;
            };
            let v = o.value.to_sat();
            let e = out.entry(sh).or_default();
            e.totals.add(&Totals {
                funded_count: 1,
                funded_sum: v,
                ..Totals::default()
            })?;
            let n = net.entry(sh).or_default();
            *n = n
                .checked_add(i64::try_from(v).map_err(|_| Error::OutOfRange)?)
                .ok_or(Error::OutOfRange)?;
        }
        for (sh, value) in &net {
            let e = out.entry(*sh).or_default();
            e.totals.tx_count += 1;
            e.rows.push(TxRow {
                txid: tx.txid,
                height: block.height,
                position: u32::try_from(position).map_err(|_| Error::OutOfRange)?,
                value: *value,
                time: block.time,
            });
        }
    }
    Ok(out)
}

/// Brings every tracked script to the node's tip: undoes blocks that left the best chain, then
/// applies each new block, one write per block, so a restart resumes where it stopped. With
/// nothing tracked it asks the node nothing.
pub async fn follow<S: Source>(store: &Store, source: &S) -> Result<Followed, Error> {
    follow_seeing(store, source, |_| {}).await
}

/// [`follow`], showing `seen` each block it applies, so a caller can look at the block without
/// reading it again.
pub async fn follow_seeing<S: Source>(
    store: &Store,
    source: &S,
    mut seen: impl FnMut(&PrevoutBlock) + Send,
) -> Result<Followed, Error> {
    let mut f = Followed::default();
    let mut changed: Vec<ScriptHash> = Vec::new();
    let mut node_height: Option<u32> = None;
    loop {
        let Some(tip) = store.read(Read::Ledger, db::tip).await? else {
            f.tip = None;
            break;
        };
        // A block that left the best chain is undone first, one at a time, down to the fork.
        let here = source.at(tip.height).await?;
        if here.map(|a| a.hash) != Some(tip.hash) {
            let undone = store
                .write(move |sql| db::undo(sql, tip))
                .await?
                .ok_or(Error::Moved)?;
            f.undone += 1;
            f.dropped += undone.dropped;
            f.reset |= undone.reset;
            changed.extend(undone.touched);
            node_height = None;
            continue;
        }
        let height = match node_height {
            Some(h) => h,
            None => *node_height.insert(source.height().await?),
        };
        if height <= tip.height {
            // Caught up with the height read; read it again once in case it moved meanwhile.
            let now = source.height().await?;
            if now <= tip.height {
                f.tip = Some(tip);
                break;
            }
            node_height = Some(now);
            continue;
        }
        let Some(next) = source.at(tip.height + 1).await? else {
            node_height = None;
            continue;
        };
        let block = source.block(next.hash).await?;
        if block.hash != next.hash
            || block.height != next.height
            || block.previousblockhash != Some(tip.hash)
        {
            // The chain moved between the reads: start again from the top.
            node_height = None;
            continue;
        }
        seen(&block);
        // The block is matched against the scripts inside the write, so a script seeded
        // meanwhile gets this block too.
        match store.write(move |sql| db::apply(sql, tip, &block)).await? {
            db::Applied::Done(touched) => changed.extend(touched),
            db::Applied::Moved => return Err(Error::Moved),
            db::Applied::OutOfRange => return Err(Error::OutOfRange),
        }
        f.applied += 1;
    }
    changed.sort_unstable_by_key(|s| s.to_byte_array());
    changed.dedup();
    f.changed = changed;
    Ok(f)
}

/// Starts tracking `script`: the node's totals pinned to a block the ledger holds (one block below
/// its tip, or below the node's tip when nothing is tracked yet, since the node's address index
/// can trail its tip), then the blocks since applied to this script alone, and, when `page` is
/// set, the node's newest history page at that block for the newest transactions. Past
/// `max_scripts`, the least recently viewed scripts are dropped first.
///
/// This is the call that costs the node: one unpaged join of the script's whole history (and a
/// page, when asked). Run one at a time. The node's refusal is [`Seeded::Refused`].
pub async fn seed<S: Source>(
    store: &Store,
    source: &S,
    script: &Script,
    page: bool,
    max_scripts: usize,
    now: u64,
) -> Result<Seeded, Error> {
    let sh = ScriptHash::from_script(script);
    if store
        .read(Read::Ledger, move |sql| db::is_tracked(sql, sh))
        .await?
    {
        return Ok(Seeded::Already);
    }
    let anchor = anchor(store, source).await?;
    let totals = match source.totals(script, anchor.hash).await? {
        Ok(t) => t,
        Err(size) => return Ok(Seeded::Refused(size)),
    };
    let rows = if page {
        match source.page(script, anchor.hash).await {
            Ok(Ok(rows)) => page_rows(rows, anchor.height),
            // Refused for size: no page will come, so none is waited for.
            Ok(Err(_)) => Some(Vec::new()),
            Err(_) => None,
        }
    } else {
        None
    };
    insert(
        store,
        source,
        script,
        totals,
        anchor,
        rows,
        max_scripts,
        now,
    )
    .await
}

/// The block a seed's totals are pinned to: one below the ledger's tip, or below the node's tip
/// when nothing is tracked, since the node's address index can trail its tip.
pub async fn anchor<S: Source>(store: &Store, source: &S) -> Result<At, Error> {
    match store.read(Read::Ledger, db::tip).await? {
        Some(t) => {
            let below = t.height.saturating_sub(1);
            Ok(store
                .read(Read::Ledger, move |sql| db::chain_at(sql, below))
                .await?
                .unwrap_or(t))
        }
        None => {
            let h = source.height().await?.saturating_sub(1);
            source.at(h).await?.ok_or(Error::Moved)
        }
    }
}

/// Starts tracking `script` from totals the caller already holds, exact at block `hash` at
/// `height`: an answer of the node's totals route, by its chain-tip stamp. That block must be one
/// the ledger holds, or the node's when nothing is tracked; otherwise [`Error::Moved`], and the
/// caller seeds instead. The newest transactions start from the next block.
#[allow(clippy::too_many_arguments)]
pub async fn adopt<S: Source>(
    store: &Store,
    source: &S,
    script: &Script,
    totals: Totals,
    hash: BlockHash,
    height: u32,
    max_scripts: usize,
    now: u64,
) -> Result<Seeded, Error> {
    let sh = ScriptHash::from_script(script);
    if store
        .read(Read::Ledger, move |sql| db::is_tracked(sql, sh))
        .await?
    {
        return Ok(Seeded::Already);
    }
    let held = match store.read(Read::Ledger, db::tip).await? {
        Some(_) => {
            store
                .read(Read::Ledger, move |sql| db::chain_at(sql, height))
                .await?
        }
        None => source.at(height).await?,
    };
    let anchor = held.filter(|a| a.hash == hash).ok_or(Error::Moved)?;
    insert(
        store,
        source,
        script,
        totals,
        anchor,
        None,
        max_scripts,
        now,
    )
    .await
}

/// Tracks `script` from `totals` exact at `anchor`, with the blocks the ledger applied since
/// applied to it alone, in one write that commits only if the ledger's tip has not moved.
#[allow(clippy::too_many_arguments)]
async fn insert<S: Source>(
    store: &Store,
    source: &S,
    script: &Script,
    totals: Totals,
    anchor: At,
    rows: Option<Vec<TxRow>>,
    max_scripts: usize,
    now: u64,
) -> Result<Seeded, Error> {
    let sh = ScriptHash::from_script(script);
    let kept_page = rows.is_some();
    let rows = rows.unwrap_or_default();
    let owned = script.to_owned();
    for _ in 0..3 {
        let tip = store.read(Read::Ledger, db::tip).await?;
        // The blocks the ledger applied after the anchor, applied here to this script alone.
        let mut since = Vec::new();
        if let Some(t) = tip
            && t != anchor
        {
            let (from, to) = (anchor.height, t.height);
            let chain = store
                .read(Read::Ledger, move |sql| db::chain(sql, from, to))
                .await?;
            // Every block from the anchor to the tip (heights are unique, so the count proves it),
            // or the chain moved between the reads: the anchor left it, or the tip was undone.
            // A tip undone below the anchor leaves no span at all.
            let span = to.checked_sub(from).map(|d| d as usize + 1);
            let whole = span == Some(chain.len())
                && chain.first() == Some(&anchor)
                && chain.last() == Some(&t);
            if !whole {
                return Err(Error::Moved);
            }
            let map = HashMap::from([(script.to_hex_string(), sh)]);
            for at in chain.into_iter().skip(1) {
                let block = source.block(at.hash).await?;
                if block.hash != at.hash || block.height != at.height {
                    return Err(Error::Moved);
                }
                let e = effects(&block, &map)?.remove(&sh).unwrap_or_default();
                since.push((at, e));
            }
        }
        let new = db::NewScript {
            sh,
            script: owned.clone(),
            totals,
            anchor,
            rows: rows.clone(),
            filled: kept_page,
            since,
            now,
        };
        if let Some(evicted) = store
            .write(move |sql| db::insert(sql, tip, &new, max_scripts))
            .await?
        {
            return Ok(Seeded::Tracked {
                at: anchor,
                page: kept_page,
                evicted,
            });
        }
    }
    Err(Error::Moved)
}

pub use self::db::Filled;

/// Joins the node's newest history page before a kept script's seed block below the rows kept
/// since, once per script: for a script seeded without it (from a totals answer, or whose page
/// failed), so its newest transactions reach back before tracking began.
///
/// The page is pinned to the seed block, so its rows are all older than the kept ones and none is
/// in both. It joins them without a gap when the kept rows are every transaction since the seed:
/// as many as the totals counted since. Where that cannot be shown, or the window is full of rows
/// since the seed, nothing is added and the node is not asked. Either way the script is marked
/// filled, and never asked about again; an error leaves it to be tried again.
///
/// The ledger keeps only its last [`UNDO_DEPTH`] blocks. An older seed block is the node's block
/// at that height, checked to be below the ledger's tip on the node's chain: a reorg below the
/// seed block would have dropped the script, and one deeper than the undo record, every script.
///
/// One page of the script's whole history at the node: run one at a time, as a seed.
pub async fn fill<S: Source>(store: &Store, source: &S, sh: ScriptHash) -> Result<Filled, Error> {
    let Some(s) = store
        .read(Read::Ledger, move |sql| db::to_fill(sql, sh))
        .await?
    else {
        return Ok(Filled::Nothing);
    };
    if s.filled {
        return Ok(Filled::Nothing);
    }
    let seeded = s.seeded_height;
    // Decided from the store alone, and decided again in the write.
    if s.skip.is_some() {
        return Ok(store
            .write(move |sql| db::fill(sql, sh, seeded, None))
            .await?);
    }
    let hash = match s.seed_block {
        Some(h) => h,
        None => {
            let tip = s.tip.ok_or(Error::Moved)?;
            let at = source.at(seeded).await?.ok_or(Error::Moved)?;
            if source.at(tip.height).await?.map(|a| a.hash) != Some(tip.hash) {
                return Err(Error::Moved);
            }
            at.hash
        }
    };
    // Refused for size: an answer, not a failure to retry. The address is marked filled.
    let Ok(page) = source.page(&s.script, hash).await? else {
        return Ok(store
            .write(move |sql| db::fill(sql, sh, seeded, Some((hash, None))))
            .await?);
    };
    let rows = page_rows(page, seeded).ok_or_else(|| {
        Error::Source(SourceError::Failed(
            "history page not at the block asked".into(),
        ))
    })?;
    Ok(store
        .write(move |sql| db::fill(sql, sh, seeded, Some((hash, Some(&rows)))))
        .await?)
}

/// The kept scripts [`fill`] has yet to do.
pub async fn unfilled(store: &Store) -> Result<Vec<ScriptHash>, store::Error> {
    store.read(Read::Ledger, db::unfilled).await
}

/// What [`history`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Historied {
    /// The whole history is kept: `rows` from the node's list at block `height`, with `evicted`
    /// other scripts' histories dropped to make room.
    Whole {
        height: u32,
        rows: u64,
        evicted: usize,
    },
    /// The node refused the list for size, with the counts its refusal gave.
    Refused(Option<ScriptSize>),
    /// More transactions than the bound holds: not asked.
    TooLarge,
    /// Room could be made only by dropping histories viewed lately: not asked now.
    NoRoom,
    /// Not tracked, or its history taken, refused for good or dropped already: nothing done.
    Nothing,
}

/// Takes `sh`'s whole confirmed history from the node, once: its list pinned to a block the ledger
/// holds (one below its tip), streamed into the store in batches, with the rows of the blocks the
/// ledger applied after that block; from then on [`follow`] adds each block's rows and undoes
/// them on a reorg. The rows are served only once all are in and as many as the totals count.
///
/// The stored history of all scripts together is kept within `max_rows` (rows held or being
/// taken): room is made by dropping the least recently viewed scripts' histories, never one viewed
/// at or after `viewing` (Unix seconds), and a script with more transactions than that is not
/// asked at all. A history dropped before is taken again the same way; `now` is recorded as when
/// it was taken. A failure, a reorg below the list's block, or a restart leaves nothing behind,
/// to be tried again.
///
/// One request that costs the node a join of the script's whole history: run it in the lane, as
/// a seed.
#[allow(clippy::too_many_arguments)]
pub async fn history<S: Source>(
    store: &Store,
    source: &S,
    sh: ScriptHash,
    max_rows: u64,
    viewing: u64,
    now: u64,
) -> Result<Historied, Error> {
    let Some(t) = tracked(store, sh).await? else {
        return Ok(Historied::Nothing);
    };
    if !matches!(
        t.history,
        History::None | History::Refused | History::Dropped | History::TooLarge
    ) {
        return Ok(Historied::Nothing);
    }
    // Decided again when it begins, against the others' histories too.
    if t.totals.tx_count > max_rows {
        store
            .write(move |sql| db::history_too_large(sql, sh))
            .await?;
        return Ok(Historied::TooLarge);
    }
    let at = anchor(store, source).await?;
    // The rows of the blocks the ledger applied after `at`, read again for this script alone.
    let (from, to) = (at.height, t.at.height);
    let chain = store
        .read(Read::Ledger, move |sql| db::chain(sql, from, to))
        .await?;
    if chain.first() != Some(&at) || chain.last() != Some(&t.at) {
        return Err(Error::Moved);
    }
    let map = HashMap::from([(t.script.to_hex_string(), sh)]);
    let mut since = Vec::new();
    for b in chain.into_iter().skip(1) {
        let block = source.block(b.hash).await?;
        if block.hash != b.hash || block.height != b.height {
            return Err(Error::Moved);
        }
        let rows = effects(&block, &map)?.remove(&sh).unwrap_or_default().rows;
        since.extend(rows.into_iter().map(|r| HistoryRow {
            height: r.height,
            txid: r.txid,
        }));
    }
    let tip = t.at;
    let begun = store
        .write(move |sql| db::history_begin(sql, sh, tip, at.height, &since, max_rows, viewing))
        .await?;
    let (hid, evicted) = match begun {
        db::Begun::Taking { hid, evicted } => (hid, evicted),
        db::Begun::TooLarge => return Ok(Historied::TooLarge),
        db::Begun::NoRoom => return Ok(Historied::NoRoom),
        db::Begun::Moved => return Err(Error::Moved),
        db::Begun::Nothing => return Ok(Historied::Nothing),
    };
    // The list holds the transactions up to `at`, never more than the totals count at the tip
    // above it: a longer one is stopped before it fills the disk.
    let budget = t.totals.tx_count;
    let (rows_tx, mut rows_rx) = tokio::sync::mpsc::channel::<Vec<HistoryRow>>(2);
    // Owns the receiver, so a write that stops closes it and the node's list stops too.
    let write = async move {
        let mut received = 0u64;
        while let Some(batch) = rows_rx.recv().await {
            received = received.saturating_add(batch.len() as u64);
            if received > budget {
                return Ok(Err(Error::Mismatch));
            }
            if !store
                .write(move |sql| db::history_rows(sql, sh, hid, &batch))
                .await?
            {
                // A reorg below the list's block, a restart or the bound ended it.
                return Ok(Err(Error::Moved));
            }
        }
        Ok::<_, store::Error>(Ok(()))
    };
    let (listed, written) = tokio::join!(source.history(&t.script, at, rows_tx), write);
    let outcome = match (listed, written) {
        (_, Err(e)) => Err(Error::Store(e)),
        (_, Ok(Err(e))) => Err(e),
        (Ok(Ok(())), Ok(Ok(()))) => Ok(None),
        (Ok(Err(size)), Ok(Ok(()))) => Ok(Some(size)),
        (Err(e), Ok(Ok(()))) => Err(Error::Source(e)),
    };
    match outcome {
        Ok(None) => match store
            .write(move |sql| db::history_end(sql, sh, hid, max_rows, viewing, now))
            .await?
        {
            db::Ended::Whole(rows) => Ok(Historied::Whole {
                height: at.height,
                rows,
                evicted,
            }),
            db::Ended::TooLarge => Ok(Historied::TooLarge),
            db::Ended::NoRoom => Ok(Historied::NoRoom),
            db::Ended::Mismatch => Err(Error::Mismatch),
        },
        Ok(Some(size)) => {
            store
                .write(move |sql| db::history_abort(sql, sh, hid, 3))
                .await?;
            Ok(Historied::Refused(size))
        }
        Err(e) => {
            store
                .write(move |sql| db::history_abort(sql, sh, hid, 0))
                .await?;
            Err(e)
        }
    }
}

/// Drops the least recently viewed scripts' histories while all of them together hold more than
/// `max_rows`: following blocks makes them grow. How many were dropped.
pub async fn bound(store: &Store, max_rows: u64, viewing: u64) -> Result<usize, store::Error> {
    // Read first: the writer is shared, and the bound is checked after every round of blocks.
    if !store
        .read(Read::Ledger, move |sql| db::history_over(sql, max_rows))
        .await?
    {
        return Ok(0);
    }
    store
        .write(move |sql| db::history_bound(sql, None, max_rows, viewing))
        .await
        .map(|room| match room {
            db::Room::Made(n) => n,
            db::Room::TooLarge | db::Room::Viewed => 0,
        })
}

/// The kept scripts whose history [`history`] may take: never taken, failed, refused, or dropped
/// for the bound, with when each was last taken whole (Unix seconds).
pub async fn unhistoried(
    store: &Store,
) -> Result<Vec<(ScriptHash, History, Option<u64>)>, store::Error> {
    store.read(Read::Ledger, db::unhistoried).await
}

pub use self::db::PageRead;

/// A page of `sh`'s whole history, newest first in the node's order (height, then txid bytes,
/// both descending), as the node's Esplora pages it: as of block `asof` (one of the ledger's last
/// [`UNDO_DEPTH`]) or the ledger's tip, after the row `after`, at most `limit` rows.
pub async fn history_page(
    store: &Store,
    sh: ScriptHash,
    asof: Option<BlockHash>,
    after: Option<HistoryRow>,
    limit: usize,
) -> Result<PageRead, store::Error> {
    store
        .read(Read::Ledger, move |sql| {
            db::history_page(sql, sh, asof, after, limit)
        })
        .await
}

/// The kept scripts whose whole history is kept, and the ledger's tip (`None` with nothing kept).
pub async fn wholes(store: &Store) -> Result<(Vec<ScriptHash>, Option<At>), store::Error> {
    store.read(Read::Ledger, db::wholes).await
}

/// After a restart: a history that was being taken is dropped, to be taken again.
pub async fn history_restarted(store: &Store) -> Result<(), store::Error> {
    if store.read(Read::Ledger, db::taking_any).await? {
        store.write(db::history_restarted).await?;
    }
    Ok(())
}

/// Rows in a page of the node's history (Esplora's page size).
const PAGE: usize = 25;

/// The node's newest history page as window rows, newest first in block order, or `None` if any
/// row is not a confirmed row at or below the anchor with its position. The window must be an
/// exact prefix of the history: the node does not list a block's rows in block order, so a full
/// page may end partway through its oldest block, and that block's rows are left out.
fn page_rows(rows: Vec<node::esplora::model::TxSummary>, anchor: u32) -> Option<Vec<TxRow>> {
    let full = rows.len() >= PAGE;
    let mut rows: Vec<TxRow> = rows
        .into_iter()
        .map(|r| {
            (r.height > 0 && r.height <= anchor).then_some(())?;
            Some(TxRow {
                txid: r.txid,
                height: r.height,
                position: r.tx_position?,
                value: r.value,
                time: u32::try_from(r.time).ok()?,
            })
        })
        .collect::<Option<_>>()?;
    if full && let Some(oldest) = rows.iter().map(|r| r.height).min() {
        rows.retain(|r| r.height > oldest);
    }
    rows.sort_unstable_by_key(|r| std::cmp::Reverse((r.height, r.position)));
    Some(rows)
}

/// What the ledger holds for `sh`, or `None` when it is not tracked.
pub async fn view(store: &Store, sh: ScriptHash) -> Result<Option<View>, store::Error> {
    store.read(Read::Ledger, move |sql| db::view(sql, sh)).await
}

/// Whether `sh` is tracked, without reading its rows.
pub async fn tracked(store: &Store, sh: ScriptHash) -> Result<Option<Tracked>, store::Error> {
    store
        .read(Read::Ledger, move |sql| db::tracked(sql, sh))
        .await
}

/// Records that a reader asked for `sh` at `now` (Unix seconds), for choosing what to drop when
/// the ledger is full. One write: the caller decides how often.
pub async fn touch(store: &Store, sh: ScriptHash, now: u64) -> Result<(), store::Error> {
    store.write(move |sql| db::touch(sql, sh, now)).await
}

/// How many scripts are tracked.
pub async fn count(store: &Store) -> Result<usize, store::Error> {
    store.read(Read::Ledger, db::count).await
}

/// The scripts tracked, for tests and tools.
pub async fn tracked_scripts(store: &Store) -> Result<Vec<(ScriptHash, ScriptBuf)>, store::Error> {
    store.read(Read::Ledger, db::scripts).await
}

/// The scripts paid by the most transactions in `block`, at most `k`, most paid first: the
/// candidates for tracking found without a reader asking. A transaction paying a script several
/// times counts once, as the node counts its creates. Scripts starting with `OP_RETURN` (unspendable)
/// are skipped, and so is any paid by a single transaction.
pub fn paid_most(block: &PrevoutBlock, k: usize) -> Vec<(ScriptBuf, u32)> {
    let mut paid: HashMap<&str, u32> = HashMap::new();
    let mut seen: Vec<&str> = Vec::new();
    for tx in &block.tx {
        seen.clear();
        for o in &tx.vout {
            let hex = o.script_pub_key.hex.as_str();
            if hex.starts_with("6a") || hex.is_empty() || seen.contains(&hex) {
                continue;
            }
            seen.push(hex);
            *paid.entry(hex).or_default() += 1;
        }
    }
    let mut ranked: Vec<(&str, u32)> = paid.into_iter().filter(|(_, n)| *n > 1).collect();
    ranked.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    ranked
        .into_iter()
        .filter_map(|(hex, n)| Some((ScriptBuf::from_hex(hex).ok()?, n)))
        .take(k)
        .collect()
}
