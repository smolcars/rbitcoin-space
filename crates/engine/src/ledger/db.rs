//! SQL for the ledger tables. Every statement is a literal; values are bound (SECURITY.md rule 12).

use std::collections::HashMap;

use bitcoin::hashes::Hash;
use bitcoin::{BlockHash, ScriptBuf, Txid};
use node::esplora::ScriptHash;
use rusqlite::types::Type;

use node::rpc::model::PrevoutBlock;

use super::{
    At, Effect, History, HistoryRow, POINT_SPAN, Point, Totals, Tracked, TxRow, UNDO_DEPTH, View,
    WINDOW,
};
use crate::store::{Error, OptionalExtension, Sql, SqlError, params};

fn sh_bytes(sh: ScriptHash) -> [u8; 32] {
    sh.to_byte_array()
}

fn blob32(r: &rusqlite::Row<'_>, i: usize) -> Result<[u8; 32], SqlError> {
    let b: Vec<u8> = r.get(i)?;
    <[u8; 32]>::try_from(b.as_slice())
        .map_err(|e| SqlError::FromSqlConversionFailure(i, Type::Blob, Box::new(e)))
}

fn int<T: TryFrom<i64>>(r: &rusqlite::Row<'_>, i: usize) -> Result<T, SqlError>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    let v: i64 = r.get(i)?;
    T::try_from(v).map_err(|e| SqlError::FromSqlConversionFailure(i, Type::Integer, Box::new(e)))
}

/// A `u64` as SQLite's `i64`: totals stay far below `i64::MAX` (21 million BTC is 2.1e15 sats).
fn sql_int(v: u64) -> Result<i64, Error> {
    i64::try_from(v).map_err(|_| Error::Sql(SqlError::IntegralValueOutOfRange(0, 0)))
}

/// The ledger's tip, or `None` when nothing is tracked.
pub fn tip(sql: &Sql<'_>) -> Result<Option<At>, Error> {
    Ok(sql
        .prepare(concat!(
            "SELECT height, hash, time FROM ledger_chain ",
            "WHERE EXISTS (SELECT 1 FROM ledger_scripts) ORDER BY height DESC LIMIT 1"
        ))?
        .query_row([], at)
        .optional()?)
}

fn at(r: &rusqlite::Row<'_>) -> Result<At, SqlError> {
    Ok(At {
        height: int(r, 0)?,
        hash: BlockHash::from_byte_array(blob32(r, 1)?),
        time: int(r, 2)?,
    })
}

pub fn chain_at(sql: &Sql<'_>, height: u32) -> Result<Option<At>, Error> {
    Ok(sql
        .prepare("SELECT height, hash, time FROM ledger_chain WHERE height = ?1")?
        .query_row(params![height], at)
        .optional()?)
}

/// The chain's rows from `from` to `to`, lowest first.
pub fn chain(sql: &Sql<'_>, from: u32, to: u32) -> Result<Vec<At>, Error> {
    let mut stmt = sql.prepare(
        "SELECT height, hash, time FROM ledger_chain WHERE height BETWEEN ?1 AND ?2 ORDER BY height",
    )?;
    let rows = stmt.query_map(params![from, to], at)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn scripts(sql: &Sql<'_>) -> Result<Vec<(ScriptHash, ScriptBuf)>, Error> {
    let mut stmt = sql.prepare("SELECT sh, script FROM ledger_scripts")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            ScriptHash::from_byte_array(blob32(r, 0)?),
            ScriptBuf::from_bytes(r.get(1)?),
        ))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn count(sql: &Sql<'_>) -> Result<usize, Error> {
    Ok(sql
        .prepare("SELECT count(*) FROM ledger_scripts")?
        .query_row([], |r| int(r, 0))?)
}

pub fn is_tracked(sql: &Sql<'_>, sh: ScriptHash) -> Result<bool, Error> {
    Ok(sql
        .prepare("SELECT 1 FROM ledger_scripts WHERE sh = ?1")?
        .query_row(params![sh_bytes(sh)], |_| Ok(()))
        .optional()?
        .is_some())
}

/// The script's totals with the tip they are exact at, in one statement so both come from one
/// committed state.
pub fn tracked(sql: &Sql<'_>, sh: ScriptHash) -> Result<Option<Tracked>, Error> {
    Ok(sql
        .prepare(concat!(
            "SELECT s.funded_count, s.funded_sum, s.spent_count, s.spent_sum, s.tx_count, ",
            "s.seeded_height, s.seeded_time, c.height, c.hash, c.time, s.script, s.filled, ",
            "s.history, s.history_height, s.history_taken ",
            "FROM ledger_scripts s, ",
            "(SELECT height, hash, time FROM ledger_chain ORDER BY height DESC LIMIT 1) c ",
            "WHERE s.sh = ?1"
        ))?
        .query_row(params![sh_bytes(sh)], |r| {
            Ok(Tracked {
                script: ScriptBuf::from_bytes(r.get(10)?),
                totals: Totals {
                    funded_count: int(r, 0)?,
                    funded_sum: int(r, 1)?,
                    spent_count: int(r, 2)?,
                    spent_sum: int(r, 3)?,
                    tx_count: int(r, 4)?,
                },
                seeded_height: int(r, 5)?,
                seeded_time: int(r, 6)?,
                filled: r.get(11)?,
                history: History::from_sql(r.get(12)?, r.get(13)?),
                history_taken: r
                    .get::<_, Option<i64>>(14)?
                    .and_then(|t| u64::try_from(t).ok()),
                at: At {
                    height: int(r, 7)?,
                    hash: BlockHash::from_byte_array(blob32(r, 8)?),
                    time: int(r, 9)?,
                },
            })
        })
        .optional()?)
}

/// Totals, newest transactions and chart, from one snapshot.
pub fn view(sql: &Sql<'_>, sh: ScriptHash) -> Result<Option<View>, Error> {
    sql.prepare("BEGIN")?.execute([])?;
    let read = (|| {
        let Some(tracked) = tracked(sql, sh)? else {
            return Ok(None);
        };
        let mut stmt = sql.prepare(concat!(
            "SELECT txid, height, position, value, time FROM ledger_txs WHERE sh = ?1 ",
            "ORDER BY height DESC, position DESC"
        ))?;
        let txs = stmt
            .query_map(params![sh_bytes(sh)], |r| {
                Ok(TxRow {
                    txid: Txid::from_byte_array(blob32(r, 0)?),
                    height: int(r, 1)?,
                    position: int(r, 2)?,
                    value: r.get(3)?,
                    time: int(r, 4)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        let mut stmt = sql.prepare(
            "SELECT height, time, balance FROM ledger_points WHERE sh = ?1 ORDER BY height",
        )?;
        let points = stmt
            .query_map(params![sh_bytes(sh)], |r| {
                Ok(Point {
                    height: int(r, 0)?,
                    time: int(r, 1)?,
                    balance: r.get(2)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(Some(View {
            tracked,
            txs,
            points,
        }))
    })();
    sql.prepare("COMMIT")?.execute([])?;
    read
}

pub fn touch(sql: &Sql<'_>, sh: ScriptHash, now: u64) -> Result<(), Error> {
    sql.prepare("UPDATE ledger_scripts SET viewed = ?2 WHERE sh = ?1")?
        .execute(params![sh_bytes(sh), sql_int(now)?])?;
    Ok(())
}

/// Adds `d` to a script's totals; `sign` -1 subtracts it.
fn add_totals(sql: &Sql<'_>, sh: ScriptHash, d: &Totals, sign: i64) -> Result<(), Error> {
    sql.prepare(concat!(
        "UPDATE ledger_scripts SET funded_count = funded_count + ?2 * ?7, ",
        "funded_sum = funded_sum + ?3 * ?7, spent_count = spent_count + ?4 * ?7, ",
        "spent_sum = spent_sum + ?5 * ?7, tx_count = tx_count + ?6 * ?7 WHERE sh = ?1"
    ))?
    .execute(params![
        sh_bytes(sh),
        sql_int(d.funded_count)?,
        sql_int(d.funded_sum)?,
        sql_int(d.spent_count)?,
        sql_int(d.spent_sum)?,
        sql_int(d.tx_count)?,
        sign
    ])?;
    Ok(())
}

fn insert_rows(sql: &Sql<'_>, sh: ScriptHash, rows: &[TxRow]) -> Result<(), Error> {
    let mut insert = sql.prepare(concat!(
        "INSERT OR REPLACE INTO ledger_txs (sh, height, position, txid, value, time) ",
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ))?;
    for r in rows {
        insert.execute(params![
            sh_bytes(sh),
            r.height,
            r.position,
            r.txid.to_byte_array(),
            r.value,
            r.time
        ])?;
    }
    // Keep the newest WINDOW: drop every row older than the WINDOW-th newest.
    sql.prepare(concat!(
        "DELETE FROM ledger_txs WHERE sh = ?1 AND (height, position) < (",
        "SELECT height, position FROM ledger_txs WHERE sh = ?1 ",
        "ORDER BY height DESC, position DESC LIMIT 1 OFFSET ?2)"
    ))?
    .execute(params![sh_bytes(sh), WINDOW as i64 - 1])?;
    Ok(())
}

/// The script's balance as of `at`, as the chart's point for `at`'s span.
fn point(sql: &Sql<'_>, sh: ScriptHash, at: At) -> Result<(), Error> {
    sql.prepare(concat!(
        "INSERT INTO ledger_points (sh, span, height, time, balance) ",
        "SELECT sh, ?2, ?3, ?4, funded_sum - spent_sum FROM ledger_scripts WHERE sh = ?1 ",
        "ON CONFLICT (sh, span) DO UPDATE SET height = excluded.height, time = excluded.time, ",
        "balance = excluded.balance"
    ))?
    .execute(params![
        sh_bytes(sh),
        at.height / POINT_SPAN,
        at.height,
        at.time
    ])?;
    Ok(())
}

/// One block's effects on one script: totals, undo record, rows, chart.
fn apply_one(sql: &Sql<'_>, sh: ScriptHash, at: At, e: &Effect) -> Result<(), Error> {
    add_totals(sql, sh, &e.totals, 1)?;
    sql.prepare(concat!(
        "INSERT OR REPLACE INTO ledger_undo (sh, height, funded_count, funded_sum, spent_count, ",
        "spent_sum, tx_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
    ))?
    .execute(params![
        sh_bytes(sh),
        at.height,
        sql_int(e.totals.funded_count)?,
        sql_int(e.totals.funded_sum)?,
        sql_int(e.totals.spent_count)?,
        sql_int(e.totals.spent_sum)?,
        sql_int(e.totals.tx_count)?
    ])?;
    insert_rows(sql, sh, &e.rows)?;
    // A history being taken or whole takes the block's rows above the list's block.
    let hid: Option<i64> = sql
        .prepare(concat!(
            "SELECT hid FROM ledger_scripts WHERE sh = ?1 AND history IN (1, 2) ",
            "AND history_height < ?2"
        ))?
        .query_row(params![sh_bytes(sh), at.height], |r| r.get(0))
        .optional()?
        .flatten();
    if let Some(hid) = hid {
        let rows: Vec<HistoryRow> = e
            .rows
            .iter()
            .map(|r| HistoryRow {
                height: r.height,
                txid: r.txid,
            })
            .collect();
        insert_history(sql, hid, &rows)?;
    }
    point(sql, sh, at)
}

fn insert_history(sql: &Sql<'_>, hid: i64, rows: &[HistoryRow]) -> Result<(), Error> {
    let mut insert = sql
        .prepare("INSERT OR IGNORE INTO ledger_history (hid, height, txid) VALUES (?1, ?2, ?3)")?;
    for r in rows {
        insert.execute(params![hid, r.height, r.txid.to_byte_array()])?;
    }
    Ok(())
}

/// Drops what is older than [`UNDO_DEPTH`] below `height`.
fn prune(sql: &Sql<'_>, height: u32) -> Result<(), Error> {
    // The chain keeps the floor too: undoing the last undoable block needs its parent.
    let floor = height.saturating_sub(UNDO_DEPTH);
    sql.prepare("DELETE FROM ledger_chain WHERE height < ?1")?
        .execute(params![floor])?;
    sql.prepare("DELETE FROM ledger_undo WHERE height <= ?1")?
        .execute(params![floor])?;
    Ok(())
}

/// What [`apply`] did.
pub enum Applied {
    /// The scripts the block touched.
    Done(Vec<ScriptHash>),
    /// The ledger's tip is no longer the block's parent; nothing written.
    Moved,
    /// A total would not fit; nothing written.
    OutOfRange,
}

/// Applies `block`, child of `tip`, to every tracked script it touched, matched against the
/// scripts tracked now, in this write.
pub fn apply(sql: &Sql<'_>, tip: At, block: &PrevoutBlock) -> Result<Applied, Error> {
    if self::tip(sql)? != Some(tip) {
        return Ok(Applied::Moved);
    }
    let map: HashMap<String, ScriptHash> = scripts(sql)?
        .into_iter()
        .map(|(sh, script)| (script.to_hex_string(), sh))
        .collect();
    let Ok(effects) = super::effects(block, &map) else {
        return Ok(Applied::OutOfRange);
    };
    let at = At {
        height: block.height,
        hash: block.hash,
        time: block.time,
    };
    for (sh, e) in &effects {
        apply_one(sql, *sh, at, e)?;
    }
    sql.prepare("INSERT OR REPLACE INTO ledger_chain (height, hash, time) VALUES (?1, ?2, ?3)")?
        .execute(params![at.height, at.hash.to_byte_array(), at.time])?;
    prune(sql, at.height)?;
    Ok(Applied::Done(effects.into_keys().collect()))
}

/// What [`undo`] did.
pub struct Undone {
    pub touched: Vec<ScriptHash>,
    pub dropped: usize,
    pub reset: bool,
}

/// Undoes the ledger's tip block `tip`. `None`, writing nothing, when the tip is no longer `tip`.
/// Scripts seeded at or above it are dropped: their totals are for a block that left the chain.
/// When no block is left below it, the reorg is deeper than the ledger can undo, and every script
/// is dropped.
pub fn undo(sql: &Sql<'_>, tip: At) -> Result<Option<Undone>, Error> {
    if self::tip(sql)? != Some(tip) {
        return Ok(None);
    }
    let h = tip.height;
    let parent = chain_at(sql, h.saturating_sub(1))?.filter(|_| h > 0);
    let Some(parent) = parent else {
        let touched = scripts(sql)?.into_iter().map(|(sh, _)| sh).collect();
        for table in [
            "DELETE FROM ledger_scripts",
            "DELETE FROM ledger_chain",
            "DELETE FROM ledger_undo",
            "DELETE FROM ledger_txs",
            "DELETE FROM ledger_points",
            "DELETE FROM ledger_history",
        ] {
            sql.prepare(table)?.execute([])?;
        }
        return Ok(Some(Undone {
            touched,
            dropped: 0,
            reset: true,
        }));
    };
    let mut stmt = sql.prepare(concat!(
        "SELECT sh, funded_count, funded_sum, spent_count, spent_sum, tx_count FROM ledger_undo ",
        "WHERE height = ?1"
    ))?;
    let undo: Vec<(ScriptHash, Totals)> = stmt
        .query_map(params![h], |r| {
            Ok((
                ScriptHash::from_byte_array(blob32(r, 0)?),
                Totals {
                    funded_count: int(r, 1)?,
                    funded_sum: int(r, 2)?,
                    spent_count: int(r, 3)?,
                    spent_sum: int(r, 4)?,
                    tx_count: int(r, 5)?,
                },
            ))
        })?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    let mut touched = Vec::with_capacity(undo.len());
    for (sh, d) in &undo {
        add_totals(sql, *sh, d, -1)?;
        touched.push(*sh);
    }
    sql.prepare("DELETE FROM ledger_undo WHERE height = ?1")?
        .execute(params![h])?;
    sql.prepare("DELETE FROM ledger_txs WHERE height >= ?1")?
        .execute(params![h])?;
    // A history being taken from a block that leaves the chain starts again; the others lose
    // the block's rows.
    let mut stmt = sql.prepare(
        "SELECT hid, history, history_height FROM ledger_scripts WHERE history IN (1, 2)",
    )?;
    let histories: Vec<(i64, i64, u32)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, int(r, 2)?)))?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    for (hid, state, from) in histories {
        if state == 1 && from >= h {
            sql.prepare("DELETE FROM ledger_history WHERE hid = ?1")?
                .execute(params![hid])?;
            sql.prepare("UPDATE ledger_scripts SET history = 0, hid = NULL WHERE hid = ?1")?
                .execute(params![hid])?;
        } else {
            // The list's block may leave too: its rows go, and the blocks applied in its place
            // bring theirs.
            sql.prepare("DELETE FROM ledger_history WHERE hid = ?1 AND height >= ?2")?
                .execute(params![hid, h])?;
            sql.prepare(concat!(
                "UPDATE ledger_scripts SET history_height = min(history_height, ?2) ",
                "WHERE hid = ?1"
            ))?
            .execute(params![hid, h.saturating_sub(1)])?;
        }
    }
    // A script whose point is dropped gets one at the parent: its balance there is the one it now
    // holds, and a point dropped may have stood for the whole span.
    let mut stmt = sql.prepare("SELECT DISTINCT sh FROM ledger_points WHERE height >= ?1")?;
    let pointed: Vec<ScriptHash> = stmt
        .query_map(params![h], |r| {
            Ok(ScriptHash::from_byte_array(blob32(r, 0)?))
        })?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    sql.prepare("DELETE FROM ledger_points WHERE height >= ?1")?
        .execute(params![h])?;
    for sh in pointed.iter().chain(&touched) {
        point(sql, *sh, parent)?;
    }
    let mut stmt = sql.prepare("SELECT sh FROM ledger_scripts WHERE seeded_height >= ?1")?;
    let gone: Vec<ScriptHash> = stmt
        .query_map(params![h], |r| {
            Ok(ScriptHash::from_byte_array(blob32(r, 0)?))
        })?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    for sh in &gone {
        delete(sql, *sh)?;
        touched.push(*sh);
    }
    sql.prepare("DELETE FROM ledger_chain WHERE height = ?1")?
        .execute(params![h])?;
    Ok(Some(Undone {
        touched,
        dropped: gone.len(),
        reset: false,
    }))
}

/// Drops one script and its rows; the chain too once nothing is tracked.
fn delete(sql: &Sql<'_>, sh: ScriptHash) -> Result<(), Error> {
    delete_rows(sql, sh)?;
    if count(sql)? == 0 {
        sql.prepare("DELETE FROM ledger_chain")?.execute([])?;
    }
    Ok(())
}

/// Drops one script and its rows, keeping the chain.
fn delete_rows(sql: &Sql<'_>, sh: ScriptHash) -> Result<(), Error> {
    for stmt in [
        "DELETE FROM ledger_history WHERE hid = (SELECT hid FROM ledger_scripts WHERE sh = ?1)",
        "DELETE FROM ledger_scripts WHERE sh = ?1",
        "DELETE FROM ledger_undo WHERE sh = ?1",
        "DELETE FROM ledger_txs WHERE sh = ?1",
        "DELETE FROM ledger_points WHERE sh = ?1",
    ] {
        sql.prepare(stmt)?.execute(params![sh_bytes(sh)])?;
    }
    Ok(())
}

/// A script to start tracking: its totals at `anchor`, the node's newest rows there, and what each
/// block the ledger applied after `anchor` did to it.
pub struct NewScript {
    pub sh: ScriptHash,
    pub script: ScriptBuf,
    pub totals: Totals,
    pub anchor: At,
    pub rows: Vec<TxRow>,
    /// The node's page before the anchor was asked for (`rows` holds it).
    pub filled: bool,
    pub since: Vec<(At, Effect)>,
    pub now: u64,
}

/// Inserts `new` if the ledger's tip is still `tip`, dropping the least recently viewed scripts
/// first while `max_scripts` are tracked. `Some(dropped)`, or `None` writing nothing when the tip
/// moved.
pub fn insert(
    sql: &Sql<'_>,
    tip: Option<At>,
    new: &NewScript,
    max_scripts: usize,
) -> Result<Option<usize>, Error> {
    if self::tip(sql)? != tip {
        return Ok(None);
    }
    if is_tracked(sql, new.sh)? {
        return Ok(Some(0));
    }
    let mut evicted = 0;
    while count(sql)? >= max_scripts.max(1) {
        let oldest: Option<[u8; 32]> = sql
            .prepare("SELECT sh FROM ledger_scripts ORDER BY viewed, sh LIMIT 1")?
            .query_row([], |r| blob32(r, 0))
            .optional()?;
        let Some(oldest) = oldest else { break };
        // The chain stays: `new` was read against it.
        delete_rows(sql, ScriptHash::from_byte_array(oldest))?;
        evicted += 1;
    }
    if tip.is_none() {
        sql.prepare("DELETE FROM ledger_chain")?.execute([])?;
        sql.prepare("INSERT INTO ledger_chain (height, hash, time) VALUES (?1, ?2, ?3)")?
            .execute(params![
                new.anchor.height,
                new.anchor.hash.to_byte_array(),
                new.anchor.time
            ])?;
    }
    let t = &new.totals;
    sql.prepare(concat!(
        "INSERT INTO ledger_scripts (sh, script, funded_count, funded_sum, spent_count, ",
        "spent_sum, tx_count, seeded_height, seeded_time, viewed, seeded_tx_count, filled) ",
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?7, ?11)"
    ))?
    .execute(params![
        sh_bytes(new.sh),
        new.script.as_bytes(),
        sql_int(t.funded_count)?,
        sql_int(t.funded_sum)?,
        sql_int(t.spent_count)?,
        sql_int(t.spent_sum)?,
        sql_int(t.tx_count)?,
        new.anchor.height,
        new.anchor.time,
        sql_int(new.now)?,
        new.filled
    ])?;
    insert_rows(sql, new.sh, &new.rows)?;
    point(sql, new.sh, new.anchor)?;
    for (at, e) in &new.since {
        if e.totals != Totals::default() {
            apply_one(sql, new.sh, *at, e)?;
        }
    }
    Ok(Some(evicted))
}

/// The scripts still to be filled: not filled, and their whole history not kept.
pub fn unfilled(sql: &Sql<'_>) -> Result<Vec<ScriptHash>, Error> {
    // A whole history (or one being taken) holds every transaction: the page reads it instead.
    let mut stmt =
        sql.prepare("SELECT sh FROM ledger_scripts WHERE filled = 0 AND history NOT IN (1, 2)")?;
    let rows = stmt.query_map([], |r| Ok(ScriptHash::from_byte_array(blob32(r, 0)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// What [`super::fill`] needs to know of a script.
#[derive(Debug, Clone)]
pub struct ToFill {
    pub script: ScriptBuf,
    pub seeded_height: u32,
    pub filled: bool,
    /// Why no page can be joined, when none can: `full` (the window holds [`WINDOW`] rows since
    /// the seed) or `gap` (rows since the seed may be missing, so the page would not join them).
    pub skip: Option<&'static str>,
    /// The seed block's hash, while the ledger's chain still holds it.
    pub seed_block: Option<BlockHash>,
    /// The ledger's tip.
    pub tip: Option<At>,
}

pub fn to_fill(sql: &Sql<'_>, sh: ScriptHash) -> Result<Option<ToFill>, Error> {
    let row = sql
        .prepare(concat!(
            "SELECT s.script, s.seeded_height, s.filled, s.tx_count, s.seeded_tx_count, ",
            "(SELECT count(*) FROM ledger_txs t WHERE t.sh = s.sh), ",
            "(SELECT hash FROM ledger_chain c WHERE c.height = s.seeded_height) ",
            "FROM ledger_scripts s WHERE s.sh = ?1"
        ))?
        .query_row(params![sh_bytes(sh)], |r| {
            let seed_block: Option<Vec<u8>> = r.get(6)?;
            let seed_block = match seed_block {
                Some(b) => Some(BlockHash::from_byte_array(
                    <[u8; 32]>::try_from(b.as_slice()).map_err(|e| {
                        SqlError::FromSqlConversionFailure(6, Type::Blob, Box::new(e))
                    })?,
                )),
                None => None,
            };
            let seeded_tx_count: Option<i64> = r.get(4)?;
            Ok((
                ScriptBuf::from_bytes(r.get(0)?),
                int::<u32>(r, 1)?,
                r.get::<_, bool>(2)?,
                int::<u64>(r, 3)?,
                seeded_tx_count.and_then(|v| u64::try_from(v).ok()),
                int::<u64>(r, 5)?,
                seed_block,
            ))
        })
        .optional()?;
    let Some((script, seeded_height, filled, tx_count, seeded_tx_count, kept, seed_block)) = row
    else {
        return Ok(None);
    };
    // Every row kept is from a block after the seed. They are all of its transactions since
    // exactly when there are as many as the totals counted since: a window cut at WINDOW and
    // then shortened by a reorg holds fewer.
    let since = seeded_tx_count.and_then(|s| tx_count.checked_sub(s));
    let skip = if kept >= WINDOW as u64 {
        Some("full")
    } else if since != Some(kept) {
        Some("gap")
    } else {
        None
    };
    Ok(Some(ToFill {
        script,
        seeded_height,
        filled,
        skip,
        seed_block,
        tip: tip(sql)?,
    }))
}

/// What [`fill`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filled {
    /// The page at the seed block, `height`, was joined below the kept rows; `rows` of it stayed
    /// in the window. `tip` is the ledger's.
    Joined {
        height: u32,
        rows: usize,
        tip: Option<At>,
    },
    /// Marked done without a page, for the reason given (as [`ToFill::skip`]).
    Skipped {
        height: u32,
        reason: &'static str,
        tip: Option<At>,
    },
    /// Not tracked any more, done already, or seeded again at another block: nothing written.
    Nothing,
}

/// Joins `page`'s rows, the node's newest page at block `hash` at the script's seed height, below
/// the rows kept since, and marks the script filled; with the node's refusal of that page for size
/// (`Some((hash, None))`), marks it filled with nothing added; with no page, marks it filled when
/// it cannot take one. Decided again here, in the write: the script must still be the one seeded at that
/// block, and its rows since the seed all there.
pub fn fill(
    sql: &Sql<'_>,
    sh: ScriptHash,
    seeded_height: u32,
    page: Option<(BlockHash, Option<&[TxRow]>)>,
) -> Result<Filled, Error> {
    let Some(s) = to_fill(sql, sh)? else {
        return Ok(Filled::Nothing);
    };
    // Seeded again since, at another block: that seed is filled on its own.
    let other = page.is_some_and(|(hash, _)| s.seed_block.is_some_and(|h| h != hash));
    if s.filled || s.seeded_height != seeded_height || other {
        return Ok(Filled::Nothing);
    }
    let done = match (s.skip, page) {
        (Some(reason), _) => Filled::Skipped {
            height: seeded_height,
            reason,
            tip: s.tip,
        },
        // It can take a page after all: left for the next fill.
        (None, None) => return Ok(Filled::Nothing),
        (None, Some((_, None))) => Filled::Skipped {
            height: seeded_height,
            reason: "refused",
            tip: s.tip,
        },
        (None, Some((_, Some(rows)))) => {
            let before = count_rows(sql, sh)?;
            insert_rows(sql, sh, rows)?;
            Filled::Joined {
                height: seeded_height,
                rows: count_rows(sql, sh)?.saturating_sub(before),
                tip: s.tip,
            }
        }
    };
    sql.prepare("UPDATE ledger_scripts SET filled = 1 WHERE sh = ?1")?
        .execute(params![sh_bytes(sh)])?;
    Ok(done)
}

fn count_rows(sql: &Sql<'_>, sh: ScriptHash) -> Result<usize, Error> {
    Ok(sql
        .prepare("SELECT count(*) FROM ledger_txs WHERE sh = ?1")?
        .query_row(params![sh_bytes(sh)], |r| int(r, 0))?)
}

/// What [`history_begin`] did.
pub enum Begun {
    /// Rows go under `hid` from now on; `evicted` histories were dropped to make room.
    Taking { hid: i64, evicted: usize },
    /// More transactions than the bound holds: marked too large, never asked.
    TooLarge,
    /// Room could be made only by dropping histories viewed lately: nothing written.
    NoRoom,
    /// The ledger's tip moved: nothing written.
    Moved,
    /// Not tracked, or its history is not to be taken: nothing written.
    Nothing,
}

/// Starts taking `sh`'s history, pinned to the block at `from`, if the ledger's tip is still
/// `tip`: rows of the blocks after `from` (`since`) go in now, the node's list follows in batches.
/// Makes room within `max_rows` first. A history left half taken by a restart is dropped.
pub fn history_begin(
    sql: &Sql<'_>,
    sh: ScriptHash,
    tip: At,
    from: u32,
    since: &[HistoryRow],
    max_rows: u64,
    viewing: u64,
) -> Result<Begun, Error> {
    if self::tip(sql)? != Some(tip) {
        return Ok(Begun::Moved);
    }
    let state: Option<i64> = sql
        .prepare("SELECT history FROM ledger_scripts WHERE sh = ?1")?
        .query_row(params![sh_bytes(sh)], |r| r.get(0))
        .optional()?;
    if !matches!(state, Some(0 | 3 | 4)) {
        return Ok(Begun::Nothing);
    }
    history_restarted(sql)?;
    let evicted = match history_bound(sql, Some(sh), max_rows, viewing)? {
        Room::Made(n) => n,
        Room::TooLarge => {
            history_too_large(sql, sh)?;
            return Ok(Begun::TooLarge);
        }
        Room::Viewed => return Ok(Begun::NoRoom),
    };
    let hid: i64 = sql
        .prepare("SELECT coalesce(max(hid), 0) + 1 FROM ledger_scripts")?
        .query_row([], |r| r.get(0))?;
    sql.prepare(
        "UPDATE ledger_scripts SET history = 1, history_height = ?2, hid = ?3 WHERE sh = ?1",
    )?
    .execute(params![sh_bytes(sh), from, hid])?;
    insert_history(sql, hid, since)?;
    Ok(Begun::Taking { hid, evicted })
}

/// Stores a batch of the node's list for `hid`, unless that history stopped being taken (a reorg
/// below its block, a restart, the script dropped): then `false`, writing nothing.
pub fn history_rows(
    sql: &Sql<'_>,
    sh: ScriptHash,
    hid: i64,
    rows: &[HistoryRow],
) -> Result<bool, Error> {
    let taking = sql
        .prepare("SELECT 1 FROM ledger_scripts WHERE sh = ?1 AND hid = ?2 AND history = 1")?
        .query_row(params![sh_bytes(sh), hid], |_| Ok(()))
        .optional()?
        .is_some();
    if taking {
        insert_history(sql, hid, rows)?;
    }
    Ok(taking)
}

/// What [`history_end`] did.
pub enum Ended {
    /// Whole, with this many rows.
    Whole(u64),
    /// Blocks made it outgrow the bound while it was taken: dropped.
    TooLarge,
    /// Room could be made only by dropping histories viewed lately: its rows dropped.
    NoRoom,
    /// Not as many rows as the totals count, or no longer being taken: its rows dropped.
    Mismatch,
}

/// Ends taking `hid`'s history: whole when it holds exactly as many rows as the totals count
/// transactions and fits within `max_rows`, making room as [`history_bound`] does.
pub fn history_end(
    sql: &Sql<'_>,
    sh: ScriptHash,
    hid: i64,
    max_rows: u64,
    viewing: u64,
    now: u64,
) -> Result<Ended, Error> {
    let row: Option<(i64, i64)> = sql
        .prepare(concat!(
            "SELECT tx_count, (SELECT count(*) FROM ledger_history WHERE hid = ?2) ",
            "FROM ledger_scripts WHERE sh = ?1 AND hid = ?2 AND history = 1"
        ))?
        .query_row(params![sh_bytes(sh), hid], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    match row {
        Some((want, have)) if want == have => {
            match history_bound(sql, Some(sh), max_rows, viewing)? {
                Room::Made(_) => {}
                Room::TooLarge => {
                    history_abort(sql, sh, hid, 5)?;
                    return Ok(Ended::TooLarge);
                }
                // Blocks made room short while it streamed: asked again later.
                Room::Viewed => {
                    history_abort(sql, sh, hid, 0)?;
                    return Ok(Ended::NoRoom);
                }
            }
            sql.prepare("UPDATE ledger_scripts SET history = 2, history_taken = ?2 WHERE sh = ?1")?
                .execute(params![sh_bytes(sh), sql_int(now)?])?;
            Ok(Ended::Whole(u64::try_from(have).unwrap_or(u64::MAX)))
        }
        _ => {
            history_abort(sql, sh, hid, 0)?;
            Ok(Ended::Mismatch)
        }
    }
}

/// Drops `hid`'s rows and leaves the script at `state` (0 to be tried again, 3 refused), if it is
/// still the history being taken.
pub fn history_abort(sql: &Sql<'_>, sh: ScriptHash, hid: i64, state: i64) -> Result<(), Error> {
    sql.prepare("DELETE FROM ledger_history WHERE hid = ?1")?
        .execute(params![hid])?;
    sql.prepare(concat!(
        "UPDATE ledger_scripts SET history = ?3, hid = NULL ",
        "WHERE sh = ?1 AND hid = ?2 AND history = 1"
    ))?
    .execute(params![sh_bytes(sh), hid, state])?;
    Ok(())
}

/// Drops any history being taken: after a restart, nothing is taking it any more.
pub fn history_restarted(sql: &Sql<'_>) -> Result<(), Error> {
    sql.prepare(
        "DELETE FROM ledger_history WHERE hid IN (SELECT hid FROM ledger_scripts WHERE history = 1)",
    )?
    .execute([])?;
    sql.prepare("UPDATE ledger_scripts SET history = 0, hid = NULL WHERE history = 1")?
        .execute([])?;
    Ok(())
}

/// What [`history_bound`] could do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Room {
    /// Within the bound, with this many histories dropped to get there.
    Made(usize),
    /// `room_for` has more transactions than the whole bound.
    TooLarge,
    /// Room for `room_for` could be made only by dropping histories viewed lately: not now.
    Viewed,
}

/// Keeps the histories held or being taken within `max_rows`, counting each as its script's
/// transactions (exactly its rows once whole), and `room_for` as well when given: drops the least
/// recently viewed whole histories other than `room_for`'s, then, without `room_for`, any being
/// taken, marking them dropped. A history viewed at or after `viewing` (Unix seconds) is never
/// dropped: a reader may be paging it. Without `room_for` the histories may then stay over the
/// bound until those readers leave.
pub fn history_bound(
    sql: &Sql<'_>,
    room_for: Option<ScriptHash>,
    max_rows: u64,
    viewing: u64,
) -> Result<Room, Error> {
    let want = |sql: &Sql<'_>| -> Result<u64, Error> {
        let n: i64 = sql
            .prepare(concat!(
                "SELECT coalesce(sum(tx_count), 0) FROM ledger_scripts ",
                "WHERE history IN (1, 2) OR sh = ?1"
            ))?
            .query_row(params![room_for.map(sh_bytes)], |r| r.get(0))?;
        Ok(u64::try_from(n).unwrap_or(u64::MAX))
    };
    // Too large even alone: nothing else is dropped for it.
    if let Some(sh) = room_for {
        let own: i64 = sql
            .prepare("SELECT tx_count FROM ledger_scripts WHERE sh = ?1")?
            .query_row(params![sh_bytes(sh)], |r| r.get(0))?;
        if u64::try_from(own).unwrap_or(u64::MAX) > max_rows {
            return Ok(Room::TooLarge);
        }
    }
    // Nothing is dropped unless enough can be: what may go must make the room on its own.
    if room_for.is_some() {
        let free: i64 = sql
            .prepare(concat!(
                "SELECT coalesce(sum(tx_count), 0) FROM ledger_scripts ",
                "WHERE history = 2 AND sh IS NOT ?1 AND viewed < ?2"
            ))?
            .query_row(params![room_for.map(sh_bytes), sql_int(viewing)?], |r| {
                r.get(0)
            })?;
        if want(sql)?.saturating_sub(u64::try_from(free).unwrap_or(0)) > max_rows {
            return Ok(Room::Viewed);
        }
    }
    let mut dropped = 0;
    while want(sql)? > max_rows {
        let oldest: Option<(Vec<u8>, i64)> = sql
            .prepare(concat!(
                "SELECT sh, hid FROM ledger_scripts WHERE history IN (1, 2) AND sh IS NOT ?1 ",
                "AND (history = 2 OR ?1 IS NULL) AND viewed < ?2 ",
                "ORDER BY history DESC, viewed, sh LIMIT 1"
            ))?
            .query_row(params![room_for.map(sh_bytes), sql_int(viewing)?], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let Some((oldest, hid)) = oldest else {
            return Ok(if room_for.is_some() {
                Room::Viewed
            } else {
                Room::Made(dropped)
            });
        };
        sql.prepare("DELETE FROM ledger_history WHERE hid = ?1")?
            .execute(params![hid])?;
        sql.prepare("UPDATE ledger_scripts SET history = 4, hid = NULL WHERE sh = ?1")?
            .execute(params![oldest])?;
        dropped += 1;
    }
    Ok(Room::Made(dropped))
}

/// The scripts whose history may be taken: never taken (or failed), refused, or dropped for the
/// bound, with when each was last taken whole (Unix seconds).
pub fn unhistoried(sql: &Sql<'_>) -> Result<Vec<(ScriptHash, History, Option<u64>)>, Error> {
    let mut stmt = sql.prepare(
        "SELECT sh, history, history_taken FROM ledger_scripts WHERE history IN (0, 3, 4)",
    )?;
    let rows = stmt.query_map([], |r| {
        let taken: Option<i64> = r.get(2)?;
        Ok((
            ScriptHash::from_byte_array(blob32(r, 0)?),
            History::from_sql(r.get(1)?, None),
            taken.and_then(|t| u64::try_from(t).ok()),
        ))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Marks `sh`'s history too large for the bound, unless it is being taken or held.
pub fn history_too_large(sql: &Sql<'_>, sh: ScriptHash) -> Result<(), Error> {
    sql.prepare("UPDATE ledger_scripts SET history = 5 WHERE sh = ?1 AND history IN (0, 3, 4)")?
        .execute(params![sh_bytes(sh)])?;
    Ok(())
}

/// What [`history_page`] read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageRead {
    /// Rows exact at block `at` (the ledger's tip, or the block asked), newest first in the
    /// node's order: after the cursor, at most the limit. Empty past the end.
    Page { at: At, rows: Vec<HistoryRow> },
    /// The script is not kept, or its history is not whole.
    NotWhole,
    /// The block asked is not one the ledger holds.
    AsofNotKept,
    /// The cursor is not a transaction of this history at that block.
    CursorMissing,
}

/// A page of `sh`'s whole history from one snapshot: as of block `asof` (one of the ledger's
/// last [`UNDO_DEPTH`]) or its tip, after the row `after` (its height and txid), at most `limit`.
pub fn history_page(
    sql: &Sql<'_>,
    sh: ScriptHash,
    asof: Option<BlockHash>,
    after: Option<HistoryRow>,
    limit: usize,
) -> Result<PageRead, Error> {
    sql.prepare("BEGIN")?.execute([])?;
    let read = (|| {
        let hid: Option<i64> = sql
            .prepare("SELECT hid FROM ledger_scripts WHERE sh = ?1 AND history = 2")?
            .query_row(params![sh_bytes(sh)], |r| r.get(0))
            .optional()?
            .flatten();
        let (Some(hid), Some(tip)) = (hid, tip(sql)?) else {
            return Ok(PageRead::NotWhole);
        };
        let at = match asof {
            None => tip,
            Some(hash) => {
                let held = sql
                    .prepare("SELECT height, hash, time FROM ledger_chain WHERE hash = ?1")?
                    .query_row(params![hash.to_byte_array()], self::at)
                    .optional()?;
                let Some(held) = held else {
                    return Ok(PageRead::AsofNotKept);
                };
                held
            }
        };
        // One row-value bound, so the read seeks straight to it: everything below the cursor, or
        // everything at or below the block.
        let (height, txid) = match after {
            None => (i64::from(at.height) + 1, [0; 32]),
            Some(r) => {
                let found = r.height <= at.height
                    && sql
                        .prepare(concat!(
                            "SELECT 1 FROM ledger_history WHERE hid = ?1 AND height = ?2 ",
                            "AND txid = ?3"
                        ))?
                        .query_row(params![hid, r.height, r.txid.to_byte_array()], |_| Ok(()))
                        .optional()?
                        .is_some();
                if !found {
                    return Ok(PageRead::CursorMissing);
                }
                (i64::from(r.height), r.txid.to_byte_array())
            }
        };
        let mut stmt = sql.prepare(concat!(
            "SELECT height, txid FROM ledger_history WHERE hid = ?1 ",
            "AND (height, txid) < (?2, ?3) ORDER BY height DESC, txid DESC LIMIT ?4"
        ))?;
        let rows = stmt
            .query_map(
                params![hid, height, txid, i64::try_from(limit).unwrap_or(i64::MAX)],
                |r| {
                    Ok(HistoryRow {
                        height: int(r, 0)?,
                        txid: Txid::from_byte_array(blob32(r, 1)?),
                    })
                },
            )?
            .collect::<Result<_, _>>()?;
        Ok(PageRead::Page { at, rows })
    })();
    sql.prepare("COMMIT")?.execute([])?;
    read
}

/// Whether the histories held or being taken count more than `max_rows`.
pub fn history_over(sql: &Sql<'_>, max_rows: u64) -> Result<bool, Error> {
    let n: i64 = sql
        .prepare("SELECT coalesce(sum(tx_count), 0) FROM ledger_scripts WHERE history IN (1, 2)")?
        .query_row([], |r| r.get(0))?;
    Ok(u64::try_from(n).unwrap_or(u64::MAX) > max_rows)
}

/// Whether any history is marked as being taken.
pub fn taking_any(sql: &Sql<'_>) -> Result<bool, Error> {
    Ok(sql
        .prepare("SELECT 1 FROM ledger_scripts WHERE history = 1 LIMIT 1")?
        .query_row([], |_| Ok(()))
        .optional()?
        .is_some())
}

/// The scripts whose whole history is kept, and the ledger's tip.
pub fn wholes(sql: &Sql<'_>) -> Result<(Vec<ScriptHash>, Option<At>), Error> {
    let mut stmt = sql.prepare("SELECT sh FROM ledger_scripts WHERE history = 2")?;
    let rows = stmt.query_map([], |r| Ok(ScriptHash::from_byte_array(blob32(r, 0)?)))?;
    Ok((rows.collect::<Result<_, _>>()?, tip(sql)?))
}
