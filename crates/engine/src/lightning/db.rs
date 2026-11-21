//! SQL for `ln_channels` and `ln_statistics`. Every statement is a literal; values are bound
//! (SECURITY.md rule 12).

use bitcoin::hashes::Hash;
use bitcoin::{BlockHash, Txid};

use std::collections::HashMap;

use rusqlite::OptionalExtension;

use super::record::CloseRow;
use super::{
    Block, Change, Channel, Close, DAY, EVERY, HOUR, Interval, KEEP_HOURS, KEEP_MINUTES, Kind,
    Level, NodePast, Open, Past, Penalty, Point, Series, Span, Stats,
};
use crate::history::Rolled;
use crate::store::{Error, Read, Sql, SqlError, Store, params};

/// Opens a channel: inserts it, or makes the stored row match and clears any close, which the
/// chain no longer holds. A row that already matches is not written again. The funding txid
/// stays only while the funding block does.
const OPEN: &str = "INSERT INTO ln_channels (scid, node_one, node_two, capacity, open_hash, open_time) \
     VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (scid) DO UPDATE SET \
     node_one = excluded.node_one, node_two = excluded.node_two, capacity = excluded.capacity, \
     open_txid = CASE WHEN open_hash IS excluded.open_hash THEN open_txid END, \
     open_hash = excluded.open_hash, open_time = excluded.open_time, close_height = NULL, \
     close_hash = NULL, close_time = NULL, close_txid = NULL, close_kind = NULL, close_fee = NULL, \
     penalty_txid = NULL, penalty_height = NULL, penalty_hash = NULL, penalty_time = NULL \
     WHERE (node_one, node_two, capacity, open_hash, open_time, close_height, penalty_txid) \
     IS NOT (excluded.node_one, excluded.node_two, excluded.capacity, excluded.open_hash, \
     excluded.open_time, NULL, NULL)";

/// Closes a channel, inserting it if it was never stored open. A penalty already stored stays
/// when the close is the same transaction (the close found again after a restart), and a row that
/// already matches is not written again.
const CLOSE: &str = "INSERT INTO ln_channels (scid, node_one, node_two, capacity, open_hash, open_time, \
     close_height, close_hash, close_time, close_txid, close_kind, close_fee) \
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) ON CONFLICT (scid) DO UPDATE SET \
     node_one = excluded.node_one, node_two = excluded.node_two, capacity = excluded.capacity, \
     open_txid = CASE WHEN open_hash IS excluded.open_hash THEN open_txid END, \
     open_hash = excluded.open_hash, open_time = excluded.open_time, \
     close_height = excluded.close_height, close_hash = excluded.close_hash, \
     close_time = excluded.close_time, close_txid = excluded.close_txid, \
     close_kind = excluded.close_kind, close_fee = excluded.close_fee, \
     penalty_txid = CASE WHEN close_txid IS excluded.close_txid THEN penalty_txid END, \
     penalty_height = CASE WHEN close_txid IS excluded.close_txid THEN penalty_height END, \
     penalty_hash = CASE WHEN close_txid IS excluded.close_txid THEN penalty_hash END, \
     penalty_time = CASE WHEN close_txid IS excluded.close_txid THEN penalty_time END \
     WHERE (node_one, node_two, capacity, open_hash, open_time, close_height, close_hash, \
     close_time, close_txid, close_kind, close_fee) IS NOT (excluded.node_one, excluded.node_two, \
     excluded.capacity, excluded.open_hash, excluded.open_time, excluded.close_height, \
     excluded.close_hash, excluded.close_time, excluded.close_txid, excluded.close_kind, \
     excluded.close_fee)";

/// SQLite integers are signed; nothing stored here comes near 2^63.
fn int(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

fn open_params(o: &Open) -> [rusqlite::types::Value; 6] {
    [
        int(o.scid).into(),
        o.node_one.to_vec().into(),
        o.node_two.to_vec().into(),
        int(o.capacity).into(),
        o.block.hash.to_byte_array().to_vec().into(),
        int(o.block.time).into(),
    ]
}

/// A channel's fee history goes when it closes, so `ln_fees` holds open channels only.
fn forget_fees(sql: &Sql, scid: u64) -> Result<(), Error> {
    sql.prepare("DELETE FROM ln_fees WHERE scid = ?1")?
        .execute(params![int(scid)])?;
    Ok(())
}

/// Applies one change; `true` when it wrote a row: a new open, a new close or a new penalty.
fn change(sql: &Sql, c: &Change) -> Result<bool, Error> {
    let written = match c {
        Change::Opened(o) => sql.prepare(OPEN)?.execute(open_params(o))?,
        Change::Closed(o, c) => {
            let close: [rusqlite::types::Value; 6] = [
                i64::from(c.block.height).into(),
                c.block.hash.to_byte_array().to_vec().into(),
                int(c.block.time).into(),
                c.txid.to_byte_array().to_vec().into(),
                (c.kind as i64).into(),
                c.fee.map(int).into(),
            ];
            let n = sql.prepare(CLOSE)?.execute(rusqlite::params_from_iter(
                open_params(o).into_iter().chain(close),
            ))?;
            forget_fees(sql, o.scid)?;
            n
        }
        Change::Penalty(scid, p) => sql
            .prepare(
                "UPDATE ln_channels SET penalty_txid = ?2, penalty_height = ?3, penalty_hash = ?4, \
                 penalty_time = ?5 WHERE scid = ?1 AND close_height IS NOT NULL \
                 AND (penalty_txid, penalty_hash) IS NOT (?2, ?4)",
            )?
            .execute(params![
                int(*scid),
                p.txid.to_byte_array().to_vec(),
                p.block.height,
                p.block.hash.to_byte_array().to_vec(),
                int(p.block.time)
            ])?,
        Change::OpenUndone(scid) => {
            sql.prepare("DELETE FROM ln_channels WHERE scid = ?1")?
                .execute(params![int(*scid)])?;
            forget_fees(sql, *scid)?;
            0
        }
        Change::CloseUndone(scid) => sql
            .prepare(
                "UPDATE ln_channels SET close_height = NULL, close_hash = NULL, close_time = NULL, \
                 close_txid = NULL, close_kind = NULL, close_fee = NULL, penalty_txid = NULL, \
                 penalty_height = NULL, penalty_hash = NULL, penalty_time = NULL WHERE scid = ?1",
            )?
            .execute(params![int(*scid)])?,
        Change::PenaltyUndone(scid) => sql
            .prepare(
                "UPDATE ln_channels SET penalty_txid = NULL, penalty_height = NULL, \
                 penalty_hash = NULL, penalty_time = NULL WHERE scid = ?1",
            )?
            .execute(params![int(*scid)])?,
    };
    Ok(written > 0)
}

/// Applies changes in order, in one write. Fails with [`Error::Full`] rather than wait behind a
/// full write queue, so the block table's and the mempool history's writes never wait for it.
pub async fn apply(store: &Store, changes: Vec<Change>) -> Result<(), Error> {
    apply_from(store, store.generation(), changes)
        .await
        .map(drop)
}

/// [`apply`] for changes taken at `generation` ([`Store::write_from`]). Says of each change
/// whether it wrote a row: an open, close or penalty already stored as it is writes nothing.
pub async fn apply_from(
    store: &Store,
    generation: u64,
    changes: Vec<Change>,
) -> Result<Vec<bool>, Error> {
    store
        .try_write_from(generation, move |sql| {
            changes.iter().map(|c| change(sql, c)).collect()
        })
        .await
}

fn get(r: &rusqlite::Row, i: usize) -> Result<u64, SqlError> {
    let v: i64 = r.get(i)?;
    u64::try_from(v).map_err(|_| SqlError::IntegralValueOutOfRange(i, v))
}

fn bytes<const N: usize>(r: &rusqlite::Row, i: usize) -> Result<[u8; N], SqlError> {
    let v: Vec<u8> = r.get(i)?;
    v.try_into()
        .map_err(|_| SqlError::InvalidColumnType(i, "blob".into(), rusqlite::types::Type::Blob))
}

fn height(r: &rusqlite::Row, i: usize) -> Result<u32, SqlError> {
    let v: i64 = r.get(i)?;
    u32::try_from(v).map_err(|_| SqlError::IntegralValueOutOfRange(i, v))
}

/// The columns [`channel`] reads, in its order.
macro_rules! channel_columns {
    () => {
        "scid, node_one, node_two, capacity, open_hash, open_time, close_height, close_hash, \
         close_time, close_txid, close_kind, close_fee, penalty_txid, penalty_height, \
         penalty_hash, penalty_time, open_txid"
    };
}

/// A row of [`channel_columns!`].
fn row(r: &rusqlite::Row) -> Result<Channel, SqlError> {
    let scid = get(r, 0)?;
    let open = Open {
        scid,
        node_one: bytes(r, 1)?,
        node_two: bytes(r, 2)?,
        capacity: get(r, 3)?,
        block: Block {
            height: u32::try_from(scid >> 40).unwrap_or(u32::MAX),
            hash: BlockHash::from_byte_array(bytes(r, 4)?),
            time: get(r, 5)?,
        },
    };
    let close = match r.get::<_, Option<i64>>(6)? {
        None => None,
        Some(_) => Some(Close {
            block: Block {
                height: height(r, 6)?,
                hash: BlockHash::from_byte_array(bytes(r, 7)?),
                time: get(r, 8)?,
            },
            txid: Txid::from_byte_array(bytes(r, 9)?),
            kind: Kind::from_code(r.get(10)?).unwrap_or(Kind::Other),
            fee: r
                .get::<_, Option<i64>>(11)?
                .and_then(|f| u64::try_from(f).ok()),
        }),
    };
    let penalty = match r.get::<_, Option<Vec<u8>>>(12)? {
        None => None,
        Some(_) => Some(Penalty {
            txid: Txid::from_byte_array(bytes(r, 12)?),
            block: Block {
                height: height(r, 13)?,
                hash: BlockHash::from_byte_array(bytes(r, 14)?),
                time: get(r, 15)?,
            },
        }),
    };
    let funding_txid = r
        .get::<_, Option<Vec<u8>>>(16)?
        .map(|_| bytes(r, 16).map(Txid::from_byte_array))
        .transpose()?;
    Ok(Channel {
        open,
        close,
        penalty,
        funding_txid,
    })
}

/// Up to `limit` channels, newest funding first.
pub async fn opened(store: &Store, limit: usize) -> Result<Vec<Channel>, Error> {
    store
        .read(Read::Lightning, move |sql| {
            Ok(sql
                .prepare(concat!(
                    "SELECT ",
                    channel_columns!(),
                    " FROM ln_channels ",
                    "ORDER BY scid DESC LIMIT ?1"
                ))?
                .query_map(params![int(limit as u64)], row)?
                .collect::<Result<Vec<_>, _>>()?)
        })
        .await
}

/// Up to `limit` closed channels, newest close first.
pub async fn closed(store: &Store, limit: usize) -> Result<Vec<Channel>, Error> {
    store
        .read(Read::Lightning, move |sql| {
            Ok(sql
                .prepare(concat!(
                    "SELECT ",
                    channel_columns!(),
                    " FROM ln_channels ",
                    "WHERE close_height IS NOT NULL ORDER BY close_height DESC, scid DESC LIMIT ?1"
                ))?
                .query_map(params![int(limit as u64)], row)?
                .collect::<Result<Vec<_>, _>>()?)
        })
        .await
}

/// Channels whose force close was a breach, newest sweep first: `limit` of them from `offset`, and
/// how many there are. Through the breached rows' partial index (`0019`), so it reads only them.
pub async fn penalties(
    store: &Store,
    offset: usize,
    limit: usize,
) -> Result<(u64, Vec<Channel>), Error> {
    store
        .read(Read::Lightning, move |sql| {
            let total = sql
                .prepare("SELECT count(*) FROM ln_channels WHERE penalty_txid IS NOT NULL")?
                .query_row([], |r| get(r, 0))?;
            let rows = sql
                .prepare(concat!(
                    "SELECT ",
                    channel_columns!(),
                    " FROM ln_channels WHERE penalty_txid IS NOT NULL ",
                    "ORDER BY penalty_height DESC, scid DESC LIMIT ?1 OFFSET ?2"
                ))?
                .query_map(params![int(limit as u64), int(offset as u64)], row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok((total, rows))
        })
        .await
}

/// One channel by its short channel id.
pub async fn channel(store: &Store, scid: u64) -> Result<Option<Channel>, Error> {
    store
        .read(Read::Lightning, move |sql| {
            Ok(sql
                .prepare(concat!(
                    "SELECT ",
                    channel_columns!(),
                    " FROM ln_channels WHERE scid = ?1"
                ))?
                .query_row(params![int(scid)], row)
                .optional()?)
        })
        .await
}

/// A node's closed channels, newest close first: `limit` of them from `offset`, and how many it
/// has. Through the node indexes.
pub async fn node_closed(
    store: &Store,
    node: [u8; 33],
    offset: usize,
    limit: usize,
) -> Result<(u64, Vec<Channel>), Error> {
    store
        .read(Read::Lightning, move |sql| {
            let id = node.to_vec();
            let total = sql
                .prepare(
                    "SELECT count(*) FROM ln_channels \
                     WHERE (node_one = ?1 OR node_two = ?1) AND close_height IS NOT NULL",
                )?
                .query_row(params![id], |r| get(r, 0))?;
            let rows = sql
                .prepare(concat!(
                    "SELECT ",
                    channel_columns!(),
                    " FROM ln_channels WHERE (node_one = ?1 OR node_two = ?1) ",
                    "AND close_height IS NOT NULL ORDER BY close_height DESC, scid DESC ",
                    "LIMIT ?2 OFFSET ?3"
                ))?
                .query_map(params![id, int(limit as u64), int(offset as u64)], row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok((total, rows))
        })
        .await
}

/// The channels any of `txids` funded or closed, each once, in `txids` order. Two indexed
/// lookups per txid.
pub async fn by_txids(store: &Store, txids: Vec<Txid>) -> Result<Vec<Channel>, Error> {
    store
        .read(Read::Lightning, move |sql| {
            let mut out: Vec<Channel> = Vec::new();
            let mut funded = sql.prepare(concat!(
                "SELECT ",
                channel_columns!(),
                " FROM ln_channels WHERE open_txid = ?1 ORDER BY scid"
            ))?;
            let mut closed = sql.prepare(concat!(
                "SELECT ",
                channel_columns!(),
                " FROM ln_channels WHERE close_txid = ?1 ORDER BY scid"
            ))?;
            for t in &txids {
                let t = t.to_byte_array().to_vec();
                for s in [&mut funded, &mut closed] {
                    for c in s.query_map(params![t], row)? {
                        let c = c?;
                        if !out.iter().any(|o| o.open.scid == c.open.scid) {
                            out.push(c);
                        }
                    }
                }
            }
            Ok(out)
        })
        .await
}

/// What one block did to the channels we hold: up to the limit of those it funded and of those it
/// closed, largest first, and the totals over all of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InBlock {
    pub opened: Vec<Channel>,
    /// How many channels the block funded, and their capacity in sats.
    pub opened_count: u64,
    pub opened_capacity: u64,
    pub closed: Vec<Channel>,
    pub closed_count: u64,
    /// Closes by a commitment: force closes, breaches included.
    pub forced: u64,
}

/// The channels block `hash` funded and closed, `limit` of each, largest first: through the
/// hash indexes (`0020`), so a block that left the chain, whose rows were moved or cleared,
/// finds none. All four reads from one snapshot.
pub async fn in_block(store: &Store, hash: BlockHash, limit: usize) -> Result<InBlock, Error> {
    store
        .read(Read::Lightning, move |sql| {
            // One snapshot, so the lists and the counts agree while history commits; the store
            // ends the transaction after the read.
            sql.prepare("BEGIN")?.execute([])?;
            let h = hash.to_byte_array().to_vec();
            let n = int(limit as u64);
            let opened = sql
                .prepare(concat!(
                    "SELECT ",
                    channel_columns!(),
                    " FROM ln_channels WHERE open_hash = ?1 ORDER BY capacity DESC, scid LIMIT ?2"
                ))?
                .query_map(params![h, n], row)?
                .collect::<Result<Vec<_>, _>>()?;
            let closed = sql
                .prepare(concat!(
                    "SELECT ",
                    channel_columns!(),
                    " FROM ln_channels WHERE close_hash = ?1 ORDER BY capacity DESC, scid LIMIT ?2"
                ))?
                .query_map(params![h, n], row)?
                .collect::<Result<Vec<_>, _>>()?;
            let (opened_count, opened_capacity) = sql
                .prepare(
                    "SELECT count(*), coalesce(sum(capacity), 0) FROM ln_channels \
                     WHERE open_hash = ?1",
                )?
                .query_row(params![h], |r| Ok((get(r, 0)?, get(r, 1)?)))?;
            let (closed_count, forced) = sql
                .prepare(
                    "SELECT count(*), \
                     coalesce(sum(close_kind IN (1, 2) OR penalty_txid IS NOT NULL), 0) \
                     FROM ln_channels WHERE close_hash = ?1",
                )?
                .query_row(params![h], |r| Ok((get(r, 0)?, get(r, 1)?)))?;
            Ok(InBlock {
                opened,
                opened_count,
                opened_capacity,
                closed,
                closed_count,
                forced,
            })
        })
        .await
}

/// The lowest held channel between nodes ?2 and ?3 funded by transaction ?1.
const NEXT: &str = concat!(
    "SELECT ",
    channel_columns!(),
    " FROM ln_channels WHERE open_txid = ?1 AND ((node_one = ?2 AND node_two = ?3) ",
    "OR (node_one = ?3 AND node_two = ?2)) ORDER BY scid LIMIT 1"
);

/// The held channel between the same two nodes funded by `c`'s closing transaction, and the one
/// whose closing transaction funded `c`: a splice, or a close that reopens in one transaction.
/// The lowest id where one transaction funded or closed several. Two indexed lookups at most.
pub async fn lineage(
    store: &Store,
    c: Channel,
) -> Result<(Option<Channel>, Option<Channel>), Error> {
    store
        .read(Read::Lightning, move |sql| {
            let (a, b) = (c.open.node_one.to_vec(), c.open.node_two.to_vec());
            let one = |q: &'static str, t: Option<Txid>| -> Result<Option<Channel>, Error> {
                let Some(t) = t else { return Ok(None) };
                Ok(sql
                    .prepare(q)?
                    .query_row(params![t.to_byte_array().to_vec(), a, b], row)
                    .optional()?)
            };
            let next = one(NEXT, c.close.map(|x| x.txid))?;
            let previous = one(
                concat!(
                    "SELECT ",
                    channel_columns!(),
                    " FROM ln_channels WHERE close_txid = ?1 AND ((node_one = ?2 AND node_two = ?3) ",
                    "OR (node_one = ?3 AND node_two = ?2)) ORDER BY scid LIMIT 1"
                ),
                c.funding_txid,
            )?;
            Ok((next, previous))
        })
        .await
}

/// What each of `closed` continued as ([`lineage`]): one indexed lookup each, in one read.
pub async fn continued(store: &Store, closed: Vec<Channel>) -> Result<Vec<Option<u64>>, Error> {
    store
        .read(Read::Lightning, move |sql| {
            let mut next = sql.prepare(NEXT)?;
            closed
                .iter()
                .map(|c| {
                    let Some(x) = c.close else { return Ok(None) };
                    let (a, b) = (c.open.node_one.to_vec(), c.open.node_two.to_vec());
                    Ok(next
                        .query_row(params![x.txid.to_byte_array().to_vec(), a, b], row)
                        .optional()?
                        .map(|n| n.open.scid))
                })
                .collect()
        })
        .await
}

/// Every closed channel of a node, newest close first. Through the closed rows' node indexes
/// (`0017`), one per end: a node's open rows are never read. A row whose two ends are the node is
/// read once.
pub async fn node_closes(store: &Store, node: [u8; 33]) -> Result<Vec<Channel>, Error> {
    store
        .read(Read::Lightning, move |sql| {
            Ok(sql
                .prepare(concat!(
                    "SELECT ",
                    channel_columns!(),
                    " FROM ln_channels WHERE node_one = ?1 AND close_height IS NOT NULL ",
                    "UNION ALL SELECT ",
                    channel_columns!(),
                    // A row whose two ends are the node is the first half's already.
                    " FROM ln_channels WHERE node_two = ?1 AND node_one != ?1 ",
                    "AND close_height IS NOT NULL ",
                    "ORDER BY close_height DESC, scid DESC"
                ))?
                .query_map(params![node.to_vec()], row)?
                .collect::<Result<Vec<_>, _>>()?)
        })
        .await
}

/// A node's newest `limit` closed rows, newest close first, and whether it has more: its close
/// record's input. Through the closed rows' node indexes, which hold each end's closes by height
/// (`0022`), so at most `limit` + 1 entries of each are read whatever the node's history. A row whose
/// two ends are the node is read once.
pub async fn node_close_rows(
    store: &Store,
    node: [u8; 33],
    limit: usize,
) -> Result<(Vec<CloseRow>, bool), Error> {
    store
        .read(Read::Lightning, move |sql| {
            let mut rows = sql
                .prepare(
                    "SELECT peer, close_time, kind, fee FROM ( \
                     SELECT * FROM (SELECT node_two AS peer, close_height, scid, close_time, \
                     CASE WHEN penalty_txid IS NOT NULL THEN 2 ELSE close_kind END AS kind, close_fee AS fee \
                     FROM ln_channels WHERE node_one = ?1 AND close_height IS NOT NULL \
                     ORDER BY close_height DESC, scid DESC LIMIT ?2) \
                     UNION ALL \
                     SELECT * FROM (SELECT node_one, close_height, scid, close_time, \
                     CASE WHEN penalty_txid IS NOT NULL THEN 2 ELSE close_kind END, close_fee \
                     FROM ln_channels WHERE node_two = ?1 AND node_one <> ?1 AND close_height IS NOT NULL \
                     ORDER BY close_height DESC, scid DESC LIMIT ?2)) \
                     ORDER BY close_height DESC, scid DESC LIMIT ?2",
                )?
                .query_map(
                    params![node.to_vec(), int(limit as u64).saturating_add(1)],
                    |r| {
                        Ok(CloseRow {
                            peer: bytes(r, 0)?,
                            time: get(r, 1)?,
                            kind: Kind::from_code(r.get(2)?).unwrap_or(Kind::Other),
                            fee: r
                                .get::<_, Option<i64>>(3)?
                                .and_then(|f| u64::try_from(f).ok()),
                        })
                    },
                )?
                .collect::<Result<Vec<_>, _>>()?;
            let more = rows.len() > limit;
            rows.truncate(limit);
            Ok((rows, more))
        })
        .await
}

/// A node's channels as stored, open and closed: what its past is rebuilt from.
pub async fn node_spans(store: &Store, node: [u8; 33]) -> Result<Vec<Span>, Error> {
    store
        .read(Read::Lightning, move |sql| {
            Ok(sql
                .prepare(
                    "SELECT open_time, close_time, capacity FROM ln_channels \
                     WHERE node_one = ?1 OR node_two = ?1",
                )?
                .query_map(params![node.to_vec()], |r| {
                    Ok(Span {
                        open: get(r, 0)?,
                        close: r
                            .get::<_, Option<i64>>(1)?
                            .map(|t| u64::try_from(t).unwrap_or(0)),
                        capacity: get(r, 2)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?)
        })
        .await
}

/// Every stored node's oldest funding and closes by kind, every channel's funding time, and when
/// the history starts: the part of the index the live graph cannot give. Two passes over the
/// table.
pub async fn past(store: &Store) -> Result<Past, Error> {
    store
        .read(Read::LightningIndex, move |sql| {
            let start: Option<i64> = sql
                .prepare("SELECT min(time) FROM ln_statistics")?
                .query_row([], |r| r.get(0))?;
            let mut nodes = HashMap::new();
            let mut rows = sql.prepare(
                "SELECT node, min(open_time), \
                 count(*) FILTER (WHERE close_kind = 0 AND penalty_txid IS NULL), \
                 count(*) FILTER (WHERE close_kind = 1 AND penalty_txid IS NULL), \
                 count(*) FILTER (WHERE close_kind = 2 OR penalty_txid IS NOT NULL), \
                 count(*) FILTER (WHERE close_kind = 3 AND penalty_txid IS NULL) \
                 FROM (SELECT node_one AS node, open_time, close_kind, penalty_txid FROM ln_channels \
                 UNION ALL SELECT node_two, open_time, close_kind, penalty_txid FROM ln_channels) \
                 GROUP BY node",
            )?;
            let mut q = rows.query([])?;
            while let Some(r) = q.next()? {
                let closed = [2, 3, 4, 5].map(|i| get(r, i).map(|n| u32::try_from(n).unwrap_or(u32::MAX)));
                let [a, b, c, d] = closed;
                nodes.insert(
                    bytes(r, 0)?,
                    NodePast {
                        first_seen: get(r, 1)?,
                        closed: [a?, b?, c?, d?],
                    },
                );
            }
            let funded = sql
                .prepare("SELECT scid, open_time FROM ln_channels ORDER BY scid")?
                .query_map([], |r| Ok((get(r, 0)?, get(r, 1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Past {
                nodes,
                start: start.and_then(|t| u64::try_from(t).ok()),
                funded,
            })
        })
        .await
}

/// Up to `limit` channels after `after` whose funding txid is still to be asked, with their
/// funding block.
pub async fn unfunded(
    store: &Store,
    after: u64,
    limit: usize,
) -> Result<Vec<(u64, BlockHash)>, Error> {
    store
        .read(Read::LightningFunding, move |sql| {
            Ok(sql
                .prepare(
                    "SELECT scid, open_hash FROM ln_channels WHERE open_txid IS NULL AND scid > ?1 \
                     ORDER BY scid LIMIT ?2",
                )?
                .query_map(params![int(after), int(limit as u64)], |r| {
                    Ok((get(r, 0)?, BlockHash::from_byte_array(bytes(r, 1)?)))
                })?
                .collect::<Result<Vec<_>, _>>()?)
        })
        .await
}

/// Stores funding txids, each only while its row still names the block it was read from. Fails
/// with [`Error::Full`] rather than wait behind a full write queue.
pub async fn set_funding(store: &Store, found: Vec<(u64, BlockHash, Txid)>) -> Result<(), Error> {
    store
        .try_write(move |sql| {
            let mut set = sql.prepare(
                "UPDATE ln_channels SET open_txid = ?3 WHERE scid = ?1 AND open_hash = ?2",
            )?;
            for (scid, hash, txid) in &found {
                set.execute(params![
                    int(*scid),
                    hash.to_byte_array().to_vec(),
                    txid.to_byte_array().to_vec()
                ])?;
            }
            Ok(())
        })
        .await
}

// Statistics: the same shape and roll-up as `mempool_history` (crate::history::db).

macro_rules! stat_columns {
    () => {
        "samples, channels, nodes, capacity, tor_nodes, clearnet_nodes, clearnet_tor_nodes, \
         unannounced_nodes, med_capacity, policies, fee_rate, base_fee, med_fee_rate, med_base_fee"
    };
}

macro_rules! stat_sums {
    () => {
        "sum(samples), sum(channels), sum(nodes), sum(capacity), sum(tor_nodes), \
         sum(clearnet_nodes), sum(clearnet_tor_nodes), sum(unannounced_nodes), sum(med_capacity), \
         sum(policies), sum(fee_rate), sum(base_fee), sum(med_fee_rate), sum(med_base_fee)"
    };
}

const INSERT: &str = concat!(
    "INSERT OR IGNORE INTO ln_statistics (level, time, ",
    stat_columns!(),
    ") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"
);

/// Adds the rows of level ?1 older than ?4 into level ?2 rows of ?3 seconds, merging with any
/// already there.
const ROLL: &str = concat!(
    "INSERT INTO ln_statistics (level, time, ",
    stat_columns!(),
    ") SELECT ?2, time / ?3 * ?3, ",
    stat_sums!(),
    " FROM ln_statistics WHERE level = ?1 AND time < ?4 GROUP BY time / ?3 ",
    "ON CONFLICT (level, time) DO UPDATE SET samples = samples + excluded.samples, ",
    "channels = channels + excluded.channels, nodes = nodes + excluded.nodes, ",
    "capacity = capacity + excluded.capacity, tor_nodes = tor_nodes + excluded.tor_nodes, ",
    "clearnet_nodes = clearnet_nodes + excluded.clearnet_nodes, ",
    "clearnet_tor_nodes = clearnet_tor_nodes + excluded.clearnet_tor_nodes, ",
    "unannounced_nodes = unannounced_nodes + excluded.unannounced_nodes, ",
    "med_capacity = med_capacity + excluded.med_capacity, ",
    "policies = policies + excluded.policies, fee_rate = fee_rate + excluded.fee_rate, ",
    "base_fee = base_fee + excluded.base_fee, ",
    "med_fee_rate = med_fee_rate + excluded.med_fee_rate, ",
    "med_base_fee = med_base_fee + excluded.med_base_fee"
);

fn insert_row(sql: &Sql, level: Level, p: &Point) -> Result<usize, Error> {
    let values = [p.time, p.samples]
        .into_iter()
        .chain(p.sums.values())
        .map(int);
    Ok(sql.prepare(INSERT)?.execute(rusqlite::params_from_iter(
        std::iter::once(level as i64).chain(values),
    ))?)
}

/// Rolls every row past its level's retention, as of `now`, into the next level, in whole
/// periods: ten-minute rows into hours after 8 days, hours into days after 400.
fn roll(sql: &Sql, now: u64) -> Result<Rolled, Error> {
    let mut rolled = Rolled::default();
    for (from, to, period, keep, moved) in [
        (
            Level::Minute,
            Level::Hour,
            HOUR,
            KEEP_MINUTES,
            &mut rolled.minutes,
        ),
        (Level::Hour, Level::Day, DAY, KEEP_HOURS, &mut rolled.hours),
    ] {
        let cut = now.saturating_sub(keep) / period * period;
        sql.prepare(ROLL)?
            .execute(params![from as i64, to as i64, int(period), int(cut)])?;
        *moved = sql
            .prepare("DELETE FROM ln_statistics WHERE level = ?1 AND time < ?2")?
            .execute(params![from as i64, int(cut)])?;
    }
    Ok(rolled)
}

/// Stores one snapshot and rolls up what has aged, in one write. Fails with [`Error::Full`]
/// rather than wait behind a full write queue: a missed snapshot is a gap, not a delay. A
/// snapshot already stored is left as it is, and so is one whose hour or day was rolled up
/// already (the clock was ahead and came back), which it would otherwise count twice.
pub async fn record(store: &Store, snapshot: Point, now: u64) -> Result<Rolled, Error> {
    store
        .try_write(move |sql| {
            let rolled: bool = sql
                .prepare(
                    "SELECT EXISTS (SELECT 1 FROM ln_statistics WHERE \
                     (level = 1 AND time = ?1 / 3600 * 3600) OR (level = 2 AND time = ?1 / 86400 * 86400))",
                )?
                .query_row(params![int(snapshot.time)], |r| r.get(0))?;
            if !rolled {
                insert_row(sql, Level::Minute, &snapshot)?;
            }
            roll(sql, now)
        })
        .await
}

/// Stores rows at `level` as they are, keeping any already stored at the same time. For tests
/// and benchmarks.
pub async fn insert(store: &Store, level: Level, rows: Vec<Point>) -> Result<(), Error> {
    store
        .write(move |sql| {
            rows.iter()
                .try_for_each(|p| insert_row(sql, level, p).map(drop))
        })
        .await
}

/// A row of `time, ` followed by [`stat_columns!`] or [`stat_sums!`].
fn point(r: &rusqlite::Row) -> Result<Point, SqlError> {
    let mut v = [0; 13];
    for (i, x) in v.iter_mut().enumerate() {
        *x = get(r, i + 2)?;
    }
    Ok(Point {
        time: get(r, 0)?,
        samples: get(r, 1)?,
        sums: Stats::from_values(v),
    })
}

/// The newest stored row: a snapshot, or after a long stop the newest hour or day.
pub async fn latest(store: &Store) -> Result<Option<Point>, Error> {
    store
        .read(Read::Lightning, move |sql| {
            let mut newest = sql.prepare(concat!(
                "SELECT time, ",
                stat_columns!(),
                " FROM ln_statistics WHERE level = ?1 ORDER BY time DESC LIMIT 1"
            ))?;
            for level in [Level::Minute, Level::Hour, Level::Day] {
                let mut rows = newest.query_map(params![level as i64], point)?;
                if let Some(p) = rows.next() {
                    return Ok(Some(p?));
                }
            }
            Ok(None)
        })
        .await
}

/// The first stored row at or after `time` and before `time + within`: a snapshot, else an hour,
/// else a day, so one older than the snapshots kept is still found. At most three key lookups.
pub async fn at(store: &Store, time: u64, within: u64) -> Result<Option<Point>, Error> {
    store
        .read(Read::Lightning, move |sql| {
            let mut first = sql.prepare(concat!(
                "SELECT time, ",
                stat_columns!(),
                " FROM ln_statistics WHERE level = ?1 AND time >= ?2 AND time < ?3 ",
                "ORDER BY time LIMIT 1"
            ))?;
            let to = time.saturating_add(within);
            for level in [Level::Minute, Level::Hour, Level::Day] {
                let mut rows = first.query_map(params![level as i64, int(time), int(to)], point)?;
                if let Some(p) = rows.next() {
                    return Ok(Some(p?));
                }
            }
            Ok(None)
        })
        .await
}

/// The series for `interval` as of `now`, in one read. Steps are never finer than a snapshot.
pub async fn series(store: &Store, interval: Interval, now: u64) -> Result<Series, Error> {
    store
        .read(Read::Lightning, move |sql| {
            let mut first = None;
            let mut oldest = sql.prepare("SELECT min(time) FROM ln_statistics WHERE level = ?1")?;
            for level in [Level::Day, Level::Hour, Level::Minute] {
                let t: Option<i64> = oldest.query_row(params![level as i64], |r| r.get(0))?;
                if let Some(t) = t {
                    first = u64::try_from(t).ok();
                    break;
                }
            }
            let (from, step, since) = match interval.span() {
                Some((span, step)) => {
                    let step = step.max(EVERY);
                    let from = now.saturating_sub(span).div_ceil(step) * step;
                    (from, step, from)
                }
                None => {
                    let first = first.unwrap_or(now);
                    let step = now.saturating_sub(first).div_ceil(1_000 * DAY).max(1) * DAY;
                    (first / step * step, step, first)
                }
            };
            let points = sql
                .prepare(concat!(
                    "SELECT time / ?2 * ?2 AS t, ",
                    stat_sums!(),
                    " FROM ln_statistics WHERE level IN (0, 1, 2) AND time BETWEEN ?1 AND ?3 ",
                    "GROUP BY t ORDER BY t"
                ))?
                .query_map(params![int(from), int(step), int(now)], point)?
                .collect::<Result<Vec<_>, _>>()?;
            // The snapshot in progress may not be taken yet; the one before must be.
            let last = (now / EVERY * EVERY).saturating_sub(EVERY);
            let start = since.div_ceil(EVERY) * EVERY;
            let slots = if last >= start {
                (last - start) / EVERY + 1
            } else {
                0
            };
            let sampled: i64 = sql
                .prepare(
                    "SELECT coalesce(sum(samples), 0) FROM ln_statistics \
                     WHERE level IN (0, 1, 2) AND time BETWEEN ?1 AND ?2",
                )?
                .query_row(params![int(since), int(last)], |r| r.get(0))?;
            Ok(Series {
                from,
                to: now,
                step,
                points,
                first,
                sampled: u64::try_from(sampled).unwrap_or(0),
                slots,
            })
        })
        .await
}
