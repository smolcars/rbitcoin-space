//! Each open channel's fee history (`ln_fees`, `docs/STORE.md`): the newest [`KEPT`] changes of
//! what each end charges, found by comparing every index of the graph with the newest record kept
//! ([`Heads::diff`]), and the stretches the server was watching (`ln_watched`).

use std::collections::HashMap;

use super::{GraphChannel, Inbound, Policy};
use crate::store::{Error, Read, SqlError, Store, params};

/// Records kept per direction.
pub const KEPT: usize = 50;
/// Runs kept in `ln_watched`.
const RUNS: i64 = 100;

/// What one end charges: what a record holds, and what must differ for a change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fees {
    /// Parts per million.
    pub fee_rate: u32,
    pub base_fee_msat: u32,
    pub inbound: Option<Inbound>,
}

impl Policy {
    pub fn fees(&self) -> Fees {
        Fees {
            fee_rate: self.fee_rate,
            base_fee_msat: self.base_fee_msat,
            inbound: self.inbound,
        }
    }
}

/// One kept record: the fees an end set, at its channel update's own time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeeRecord {
    pub time: u32,
    pub fees: Fees,
}

/// The newest record kept for one direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Head {
    record: FeeRecord,
    /// The direction has an older record too, so this one is a change.
    changed: bool,
}

/// The newest record kept for each direction of each channel, `(scid, side)`: what a round
/// compares the graph with, and what a node's newest changes are looked up by. Mirrors the
/// table: changed only by what a write reports it stored or found.
#[derive(Debug, Default)]
pub struct Heads(HashMap<(u64, u8), Head>, Epoch);

/// Moves at every [`Heads::forget`]: a write's outcomes from before it may predate a deleted
/// history, so [`Heads::apply`] drops them with their heads, and the next round asks the table
/// again.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Epoch(u64);

/// What [`record`] did with one record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Stored: the direction's newest now. `before` is the newest kept until then, so `Some` is
    /// a change and `None` a starting point.
    Stored { before: Option<FeeRecord> },
    /// Not stored: the newest kept, which is as new or has the same fees, and whether an older
    /// one is kept too.
    Kept { record: FeeRecord, changed: bool },
    /// Not stored: the channel is not stored open (closed, its open undone by a reorg, or not
    /// stored yet), so it has no history. Tried again at the next round while the graph holds it.
    NotOpen,
}

impl Heads {
    /// Each direction of `channels` whose policy should be recorded: one never recorded (its
    /// starting point), or one whose fees differ from the newest kept and that is newer than it.
    /// Enabling or disabling, and a change of anything but the fees, is not a change.
    pub fn diff(&self, channels: &[GraphChannel]) -> Vec<(u64, u8, FeeRecord)> {
        let mut out = Vec::new();
        for c in channels {
            for (side, p) in (0u8..).zip(&c.policies) {
                let Some(p) = p else { continue };
                let r = FeeRecord {
                    time: p.last_update,
                    fees: p.fees(),
                };
                let due = self
                    .0
                    .get(&(c.scid, side))
                    .is_none_or(|h| h.record.fees != r.fees && r.time > h.record.time);
                if due {
                    out.push((c.scid, side, r));
                }
            }
        }
        out
    }

    /// The epoch to hand [`Heads::apply`] with a [`Heads::diff`] taken now.
    pub fn epoch(&self) -> Epoch {
        self.1
    }

    /// Takes in what a write did with each record of a [`Heads::diff`] taken at `epoch`. If a
    /// history was forgotten since, which the write may have raced, the records' heads are
    /// dropped instead: the next round sends them again and the table says where they stand.
    pub fn apply(&mut self, epoch: Epoch, records: &[(u64, u8, FeeRecord)], outcomes: &[Outcome]) {
        if epoch != self.1 {
            for (scid, side, _) in records {
                self.0.remove(&(*scid, *side));
            }
            return;
        }
        for (&(scid, side, record), o) in records.iter().zip(outcomes) {
            match *o {
                Outcome::Stored { before } => {
                    let changed = before.is_some();
                    self.0.insert((scid, side), Head { record, changed });
                }
                Outcome::Kept { record, changed } => {
                    self.0.insert((scid, side), Head { record, changed });
                }
                Outcome::NotOpen => {
                    self.0.remove(&(scid, side));
                }
            }
        }
    }

    /// Forgets the channels `open` does not hold (closed, or gone from the graph), so memory
    /// follows the graph. Their rows go when the channel closes.
    pub fn retain(&mut self, open: impl Fn(u64) -> bool) {
        self.0.retain(|(scid, _), _| open(*scid));
    }

    /// Forgets a channel whose history was deleted, so the next round records its starting
    /// point again if the graph still holds it (an open moved by a reorg).
    pub fn forget(&mut self, scid: u64) {
        self.0.remove(&(scid, 0));
        self.0.remove(&(scid, 1));
        self.1 = Epoch(self.1.0.wrapping_add(1));
    }

    /// When the newest change of this direction was made, if its newest record is a change.
    pub fn changed(&self, scid: u64, side: u8) -> Option<u32> {
        self.0
            .get(&(scid, side))
            .filter(|h| h.changed)
            .map(|h| h.record.time)
    }

    /// The `n` directions whose newest change is newest, newest first: the newest `n` changes
    /// of the whole graph are all among them.
    pub fn newest_changed(&self, n: usize) -> Vec<(u64, u8)> {
        let mut v: Vec<(u32, u64, u8)> = self
            .0
            .iter()
            .filter(|(_, h)| h.changed)
            .map(|(&(scid, side), h)| (h.record.time, scid, side))
            .collect();
        v.sort_unstable_by(|a, b| b.cmp(a));
        v.into_iter()
            .take(n)
            .map(|(_, scid, side)| (scid, side))
            .collect()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

fn int(r: &rusqlite::Row, i: usize) -> Result<u32, SqlError> {
    let v: i64 = r.get(i)?;
    u32::try_from(v).map_err(|_| SqlError::IntegralValueOutOfRange(i, v))
}

/// A record from columns `time, fee_rate, base_fee, inbound_base, inbound_rate` at `at`.
fn record_at(r: &rusqlite::Row, at: usize) -> Result<FeeRecord, SqlError> {
    let small = |i: usize| -> Result<Option<i32>, SqlError> {
        r.get::<_, Option<i64>>(i)?
            .map(|v| i32::try_from(v).map_err(|_| SqlError::IntegralValueOutOfRange(i, v)))
            .transpose()
    };
    let inbound = match (small(at + 3)?, small(at + 4)?) {
        (Some(base_fee_msat), Some(fee_rate)) => Some(Inbound {
            base_fee_msat,
            fee_rate,
        }),
        _ => None,
    };
    Ok(FeeRecord {
        time: int(r, at)?,
        fees: Fees {
            fee_rate: int(r, at + 1)?,
            base_fee_msat: int(r, at + 2)?,
            inbound,
        },
    })
}

fn scid_value(scid: u64) -> i64 {
    i64::try_from(scid).unwrap_or(i64::MAX)
}

/// The heads the table holds: each direction's newest record and whether it has an older one.
/// One pass over the table, at start.
pub async fn heads(store: &Store) -> Result<Heads, Error> {
    store
        .read(Read::LightningIndex, |sql| {
            let mut out = HashMap::new();
            let mut s = sql.prepare(
                "SELECT scid, side, max(time), fee_rate, base_fee, inbound_base, inbound_rate, \
                 count(*) FROM ln_fees GROUP BY scid, side",
            )?;
            let mut q = s.query([])?;
            while let Some(r) = q.next()? {
                let scid: i64 = r.get(0)?;
                let side: i64 = r.get(1)?;
                let (Ok(scid), Ok(side)) = (u64::try_from(scid), u8::try_from(side)) else {
                    continue;
                };
                let count: i64 = r.get(7)?;
                let head = Head {
                    record: record_at(r, 2)?,
                    changed: count > 1,
                };
                out.insert((scid, side), head);
            }
            Ok(Heads(out, Epoch::default()))
        })
        .await
}

/// Stores `records` in one write, each only if the newest kept for its direction is older and
/// has other fees and the channel is stored open, then keeps the newest [`KEPT`] of each
/// direction; and marks the server as watching from `run` to `now` (`ln_watched`, the newest
/// [`RUNS`] runs kept). Fails with [`Error::Full`] rather than wait behind a full write queue.
pub async fn record(
    store: &Store,
    records: Vec<(u64, u8, FeeRecord)>,
    run: u64,
    now: u64,
) -> Result<Vec<Outcome>, Error> {
    store
        .try_write(move |sql| {
            let mut out = Vec::with_capacity(records.len());
            // A stale round must not write for a channel whose close or undone open was stored
            // after the round read the graph: those deleted its history.
            let mut open =
                sql.prepare("SELECT 1 FROM ln_channels WHERE scid = ?1 AND close_height IS NULL")?;
            let mut newest = sql.prepare(
                "SELECT time, fee_rate, base_fee, inbound_base, inbound_rate FROM ln_fees \
                 WHERE scid = ?1 AND side = ?2 ORDER BY time DESC LIMIT 2",
            )?;
            let mut insert = sql.prepare(
                "INSERT INTO ln_fees (scid, side, time, fee_rate, base_fee, inbound_base, \
                 inbound_rate) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            let mut trim = sql.prepare(
                "DELETE FROM ln_fees WHERE scid = ?1 AND side = ?2 AND time < (SELECT time \
                 FROM ln_fees WHERE scid = ?1 AND side = ?2 ORDER BY time DESC LIMIT 1 OFFSET ?3)",
            )?;
            for &(scid, side, r) in &records {
                let scid = scid_value(scid);
                if !open.exists(params![scid])? {
                    out.push(Outcome::NotOpen);
                    continue;
                }
                let two = newest
                    .query_map(params![scid, side], |row| record_at(row, 0))?
                    .collect::<Result<Vec<_>, _>>()?;
                let kept = two.first().copied();
                if let Some(k) = kept
                    && (k.time >= r.time || k.fees == r.fees)
                {
                    out.push(Outcome::Kept {
                        record: k,
                        changed: two.len() > 1,
                    });
                    continue;
                }
                let inbound = r.fees.inbound;
                insert.execute(params![
                    scid,
                    side,
                    r.time,
                    r.fees.fee_rate,
                    r.fees.base_fee_msat,
                    inbound.map(|i| i.base_fee_msat),
                    inbound.map(|i| i.fee_rate),
                ])?;
                trim.execute(params![scid, side, KEPT as i64 - 1])?;
                out.push(Outcome::Stored { before: kept });
            }
            let (run, now) = (scid_value(run), scid_value(now));
            sql.prepare(
                "INSERT INTO ln_watched (start, end) VALUES (?1, ?2) \
                 ON CONFLICT (start) DO UPDATE SET end = excluded.end",
            )?
            .execute(params![run, now])?;
            sql.prepare(
                "DELETE FROM ln_watched WHERE start < (SELECT start FROM ln_watched \
                 ORDER BY start DESC LIMIT 1 OFFSET ?1)",
            )?
            .execute(params![RUNS - 1])?;
            Ok(out)
        })
        .await
}

/// A channel's kept records, node one's and node two's, oldest first, and the runs that end
/// after the oldest of them began, oldest first.
pub type History = ([Vec<FeeRecord>; 2], Vec<(u64, u64)>);

/// [`History`] of one channel: one indexed read of at most 2 × [`KEPT`] rows, and the runs.
pub async fn history(store: &Store, scid: u64) -> Result<History, Error> {
    store
        .read(Read::Lightning, move |sql| {
            let mut sides: [Vec<FeeRecord>; 2] = [Vec::new(), Vec::new()];
            let mut s = sql.prepare(
                "SELECT side, time, fee_rate, base_fee, inbound_base, inbound_rate FROM ln_fees \
                 WHERE scid = ?1 ORDER BY side, time",
            )?;
            let mut q = s.query(params![scid_value(scid)])?;
            while let Some(r) = q.next()? {
                let side: i64 = r.get(0)?;
                if let Some(v) = usize::try_from(side).ok().and_then(|i| sides.get_mut(i)) {
                    v.push(record_at(r, 1)?);
                }
            }
            let Some(from) = sides.iter().filter_map(|v| v.first()).map(|r| r.time).min() else {
                return Ok((sides, Vec::new()));
            };
            let runs = sql
                .prepare("SELECT start, end FROM ln_watched WHERE end >= ?1 ORDER BY start")?
                .query_map(params![from], |r| {
                    let (a, b): (i64, i64) = (r.get(0)?, r.get(1)?);
                    Ok((u64::try_from(a).unwrap_or(0), u64::try_from(b).unwrap_or(0)))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok((sides, runs))
        })
        .await
}

/// The newest `limit` + 1 records of each direction asked, newest first: enough for its newest
/// `limit` changes. One indexed read per direction.
pub async fn newest(
    store: &Store,
    directions: Vec<(u64, u8)>,
    limit: usize,
) -> Result<Vec<Vec<FeeRecord>>, Error> {
    store
        .read(Read::Lightning, move |sql| {
            let mut s = sql.prepare(
                "SELECT time, fee_rate, base_fee, inbound_base, inbound_rate FROM ln_fees \
                 WHERE scid = ?1 AND side = ?2 ORDER BY time DESC LIMIT ?3",
            )?;
            let take = i64::try_from(limit).unwrap_or(i64::MAX).saturating_add(1);
            directions
                .iter()
                .map(|&(scid, side)| {
                    s.query_map(params![scid_value(scid), side, take], |r| record_at(r, 0))?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(Error::from)
                })
                .collect()
        })
        .await
}
