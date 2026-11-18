//! SQL for the `replacements` table. Every statement is a literal; values are bound
//! (SECURITY.md rule 12).

use bitcoin::hashes::Hash;
use bitcoin::{BlockHash, Txid};

use super::{Change, Facts, Link, Mined, Sides};
use crate::outputs::{MAX_BLOB_BYTES, Outputs};
use crate::store::{Error, Read, Sql, SqlError, Store, params};

const INSERT: &str = "INSERT OR REPLACE INTO replacements (txid, by, seen, fee, vsize, weight, \
    value, time, rbf, by_fee, by_vsize, by_weight, by_value, by_time, by_rbf, mined, height, \
    block) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)";

const SIDES: &str = "UPDATE replacements SET outputs = ?2, by_outputs = ?3, inputs = ?4, \
    by_inputs = ?5, shared = ?6 WHERE txid = ?1";

const MINED: &str = "UPDATE replacements SET mined = ?2, height = ?3, block = ?4 WHERE by = ?1";
const RETURNED: &str = "DELETE FROM replacements WHERE txid = ?1";

/// Keeps the newest ?1 rows by the order recorded. Rows replaced in place leave gaps, so it may
/// keep fewer, never more.
const PRUNE: &str = "DELETE FROM replacements WHERE n <= (SELECT max(n) FROM replacements) - ?1";

const LOAD: &str = "SELECT txid, by, seen, fee, vsize, weight, value, time, rbf, by_fee, \
    by_vsize, by_weight, by_value, by_time, by_rbf, mined, height, block, outputs, by_outputs, \
    inputs, by_inputs, shared FROM replacements ORDER BY n DESC LIMIT ?1";

/// The record's changes from one step (a tracker delta, a check's answers), in the order the
/// record made them ([`super::Replacements::take_changes`]).
pub type Batch = Vec<Change>;

/// `mined`, `height` and `block` as stored.
fn mined_columns(m: Mined) -> (u8, Option<u32>, Option<[u8; 32]>) {
    match m {
        Mined::No => (0, None, None),
        Mined::In(b) => (1, b.map(|b| b.0), b.map(|b| b.1.to_byte_array())),
        Mined::Unknown => (2, None, None),
    }
}

fn int(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

/// Stores `batches`, in order, in one transaction and keeps the newest `keep` rows.
pub async fn write(store: &Store, batches: Vec<Batch>, keep: usize) -> Result<(), Error> {
    write_from(store, store.generation(), batches, keep).await
}

/// [`write`] for batches read at `generation` ([`Store::write_from`]).
pub async fn write_from(
    store: &Store,
    generation: u64,
    batches: Vec<Batch>,
    keep: usize,
) -> Result<(), Error> {
    store
        .write_from(generation, move |sql| {
            for b in &batches {
                insert(sql, b)?;
            }
            prune(sql, keep)
        })
        .await
}

/// One batch's statements, inside a write's transaction, in the record's order.
pub(crate) fn insert(sql: &Sql, batch: &[Change]) -> Result<(), Error> {
    let (mut insert, mut delete) = (sql.prepare(INSERT)?, sql.prepare(RETURNED)?);
    let mut mined = sql.prepare(MINED)?;
    let mut sides = sql.prepare(SIDES)?;
    for c in batch {
        let l = match c {
            Change::Sides(t, s) => {
                let blob = |o: &Option<Outputs>| o.as_ref().map(Outputs::to_blob);
                sides.execute(params![
                    t.to_byte_array(),
                    blob(&s.outputs),
                    blob(&s.by_outputs),
                    s.inputs,
                    s.by_inputs,
                    s.shared,
                ])?;
                continue;
            }
            Change::Link(l) => l,
            Change::Mined(by, m) => {
                let (m, height, block) = mined_columns(*m);
                mined.execute(params![by.to_byte_array(), m, height, block])?;
                continue;
            }
            Change::Returned(t) => {
                delete.execute(params![t.to_byte_array()])?;
                mined.execute(params![t.to_byte_array(), 0, None::<u32>, None::<[u8; 32]>])?;
                continue;
            }
        };
        // As `Replacements::restore`: the replacement is back, so its own old link is stale.
        delete.execute(params![l.by.to_byte_array()])?;
        let by = l.by_tx;
        let (m, height, block) = mined_columns(l.mined);
        insert.execute(params![
            l.txid.to_byte_array(),
            l.by.to_byte_array(),
            int(l.seen),
            int(l.tx.fee),
            l.tx.vsize,
            l.tx.weight,
            int(l.tx.value),
            l.tx.time,
            l.tx.rbf,
            by.map(|f| int(f.fee)),
            by.map(|f| f.vsize),
            by.map(|f| f.weight),
            by.map(|f| int(f.value)),
            by.map(|f| f.time),
            by.map(|f| f.rbf),
            m,
            height,
            block,
        ])?;
    }
    Ok(())
}

fn prune(sql: &Sql, keep: usize) -> Result<(), Error> {
    sql.prepare(PRUNE)?.execute(params![int(keep as u64)])?;
    Ok(())
}

fn get<T: TryFrom<i64>>(r: &rusqlite::Row, i: usize) -> Result<T, SqlError> {
    let v: i64 = r.get(i)?;
    T::try_from(v).map_err(|_| SqlError::IntegralValueOutOfRange(i, v))
}

fn read(r: &rusqlite::Row) -> Result<Link, SqlError> {
    let txid: [u8; 32] = r.get(0)?;
    let by: [u8; 32] = r.get(1)?;
    let by_fee: Option<i64> = r.get(9)?;
    let by_tx = match by_fee {
        None => None,
        Some(_) => Some(Facts {
            fee: get(r, 9)?,
            vsize: get(r, 10)?,
            weight: get(r, 11)?,
            value: get(r, 12)?,
            time: get(r, 13)?,
            rbf: r.get(14)?,
        }),
    };
    Ok(Link {
        txid: Txid::from_byte_array(txid),
        by: Txid::from_byte_array(by),
        seen: get(r, 2)?,
        tx: Facts {
            fee: get(r, 3)?,
            vsize: get(r, 4)?,
            weight: get(r, 5)?,
            value: get(r, 6)?,
            time: get(r, 7)?,
            rbf: r.get(8)?,
        },
        by_tx,
        mined: match get::<u8>(r, 15)? {
            0 => Mined::No,
            1 => Mined::In(
                r.get::<_, Option<u32>>(16)?.zip(
                    r.get::<_, Option<[u8; 32]>>(17)?
                        .map(BlockHash::from_byte_array),
                ),
            ),
            _ => Mined::Unknown,
        },
    })
}

/// What a row keeps beside its link. Outputs that do not read back are left out, as if never
/// recorded, rather than trusted.
fn read_sides(r: &rusqlite::Row) -> Result<Sides, SqlError> {
    // Read in place: a blob longer than any kept form is not copied out at all.
    let outputs = |i: usize| -> Result<Option<Outputs>, SqlError> {
        Ok(match r.get_ref(i)? {
            rusqlite::types::ValueRef::Blob(b) if b.len() <= MAX_BLOB_BYTES => {
                Outputs::from_blob(b)
            }
            _ => None,
        })
    };
    let count = |i: usize| -> Result<Option<u32>, SqlError> {
        Ok(r.get::<_, Option<i64>>(i)?
            .and_then(|v| u32::try_from(v).ok()))
    };
    Ok(Sides {
        outputs: outputs(18)?,
        by_outputs: outputs(19)?,
        inputs: count(20)?,
        by_inputs: count(21)?,
        shared: count(22)?,
    })
}

/// The newest `keep` links, oldest first, to put back into a record.
pub async fn load(store: &Store, keep: usize) -> Result<Vec<Link>, Error> {
    Ok(load_kept(store, keep)
        .await?
        .into_iter()
        .map(|(l, _)| l)
        .collect())
}

/// [`load`] with what each link keeps beside its figures ([`super::Replacements::restore_with`]).
pub async fn load_kept(store: &Store, keep: usize) -> Result<Vec<(Link, Sides)>, Error> {
    store
        .read(Read::Replacements, move |sql| {
            let mut out = sql
                .prepare(LOAD)?
                .query_map(params![int(keep as u64)], |r| {
                    Ok((read(r)?, read_sides(r)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            out.reverse();
            Ok(out)
        })
        .await
}
