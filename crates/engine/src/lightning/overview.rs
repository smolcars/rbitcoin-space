//! The Lightning overview's movers and closes by day (`docs/LIGHTNING.md`, "The overview"), worked
//! out from `ln_channels` alone: a channel's funding and closing block times say when it counted.

use std::collections::HashMap;

use super::{DAY, Kind};
use crate::store::{Error, Read, SqlError, Store};

/// Nodes in each list of [`Movers`].
pub const MOVERS: usize = 10;

/// One stored channel, as the overview needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Row {
    pub nodes: [[u8; 33]; 2],
    pub capacity: u64,
    /// The funding block's time.
    pub open: u64,
    /// The closing block's time and the kind: `Penalty` once a breach was swept.
    pub close: Option<(u64, Kind)>,
}

/// Every stored channel: one pass over the table.
pub async fn rows(store: &Store) -> Result<Vec<Row>, Error> {
    store
        .read(Read::LightningIndex, |sql| {
            let mut s = sql.prepare(
                "SELECT node_one, node_two, capacity, open_time, close_time, \
                 CASE WHEN penalty_txid IS NOT NULL THEN 2 ELSE close_kind END FROM ln_channels",
            )?;
            let mut q = s.query([])?;
            let mut out = Vec::new();
            while let Some(r) = q.next()? {
                let key = |i: usize| -> Result<[u8; 33], SqlError> {
                    let v: Vec<u8> = r.get(i)?;
                    v.try_into().map_err(|_| {
                        SqlError::InvalidColumnType(i, "blob".into(), rusqlite::types::Type::Blob)
                    })
                };
                let num = |i: usize| -> Result<u64, SqlError> {
                    let v: i64 = r.get(i)?;
                    u64::try_from(v).map_err(|_| SqlError::IntegralValueOutOfRange(i, v))
                };
                let close = match (r.get::<_, Option<i64>>(4)?, r.get::<_, Option<i64>>(5)?) {
                    (Some(t), Some(k)) => Some((
                        u64::try_from(t).unwrap_or(0),
                        Kind::from_code(k).unwrap_or(Kind::Other),
                    )),
                    _ => None,
                };
                out.push(Row {
                    nodes: [key(0)?, key(1)?],
                    capacity: num(2)?,
                    open: num(3)?,
                    close,
                });
            }
            Ok(out)
        })
        .await
}

/// A node's change over a period: what opened in it less what closed in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mover {
    pub id: [u8; 33],
    /// Sats and channels.
    pub capacity: i64,
    pub channels: i64,
    /// For a new node its first funding time, for one that left its last close; else `None`.
    pub time: Option<u64>,
}

/// The nodes that moved most over one period, [`MOVERS`] in each list.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Movers {
    pub capacity_up: Vec<Mover>,
    pub capacity_down: Vec<Mover>,
    pub channels_up: Vec<Mover>,
    pub channels_down: Vec<Mover>,
    /// First channel funded in the period, newest first.
    pub new: Vec<Mover>,
    /// No channel stored open, the last closed in the period, newest close first.
    pub left: Vec<Mover>,
}

#[derive(Default)]
struct Tally {
    capacity: i64,
    channels: i64,
    first_open: u64,
    last_close: u64,
    open: u32,
}

fn signed(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

/// [`Movers`] for the period from `since`. A channel opened and closed inside it counts nothing.
pub fn movers(rows: &[Row], since: u64) -> Movers {
    let mut nodes: HashMap<[u8; 33], Tally> = HashMap::new();
    for r in rows {
        for id in r.nodes {
            let t = nodes.entry(id).or_insert_with(|| Tally {
                first_open: u64::MAX,
                ..Tally::default()
            });
            t.first_open = t.first_open.min(r.open);
            if r.open >= since {
                t.capacity = t.capacity.saturating_add(signed(r.capacity));
                t.channels += 1;
            }
            match r.close {
                None => t.open += 1,
                Some((time, _)) => {
                    t.last_close = t.last_close.max(time);
                    if time >= since {
                        t.capacity = t.capacity.saturating_sub(signed(r.capacity));
                        t.channels -= 1;
                    }
                }
            }
        }
    }
    let all: Vec<(Mover, &Tally)> = nodes
        .iter()
        .map(|(id, t)| {
            let m = Mover {
                id: *id,
                capacity: t.capacity,
                channels: t.channels,
                time: None,
            };
            (m, t)
        })
        .collect();
    // The ten highest by `key` among those `keep` admits, ties by key so answers are stable.
    let top = |keep: &dyn Fn(&Mover, &Tally) -> bool,
               key: &dyn Fn(&Mover, &Tally) -> i64,
               time: &dyn Fn(&Tally) -> Option<u64>| {
        let mut v: Vec<(i64, Mover)> = all
            .iter()
            .filter(|(m, t)| keep(m, t))
            .map(|(m, t)| {
                let mut m = *m;
                m.time = time(t);
                (key(&m, t), m)
            })
            .collect();
        v.sort_unstable_by(|(a, x), (b, y)| b.cmp(a).then(x.id.cmp(&y.id)));
        v.truncate(MOVERS);
        v.into_iter().map(|(_, m)| m).collect::<Vec<_>>()
    };
    let none = |_: &Tally| None;
    Movers {
        capacity_up: top(&|m, _| m.capacity > 0, &|m, _| m.capacity, &none),
        capacity_down: top(
            &|m, _| m.capacity < 0,
            &|m, _| m.capacity.saturating_neg(),
            &none,
        ),
        channels_up: top(&|m, _| m.channels > 0, &|m, _| m.channels, &none),
        channels_down: top(
            &|m, _| m.channels < 0,
            &|m, _| m.channels.saturating_neg(),
            &none,
        ),
        new: top(
            &|_, t| t.first_open >= since,
            &|_, t| signed(t.first_open),
            &|t| Some(t.first_open),
        ),
        left: top(
            &|_, t| t.open == 0 && t.last_close >= since,
            &|_, t| signed(t.last_close),
            &|t| Some(t.last_close),
        ),
    }
}

/// One UTC day's closes: how many of each kind (by [`Kind`]'s code) and the capacity closed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Day {
    /// The day's midnight, Unix seconds.
    pub time: u64,
    pub closes: [u32; 4],
    pub capacity: u64,
}

/// The `days` UTC days up to the one holding `now`, oldest first, every day present.
pub fn closes(rows: &[Row], now: u64, days: u64) -> Vec<Day> {
    let today = now / DAY * DAY;
    let from = today.saturating_sub(days.saturating_sub(1) * DAY);
    let mut out: Vec<Day> = (0..days)
        .map(|i| Day {
            time: from + i * DAY,
            ..Day::default()
        })
        .collect();
    for r in rows {
        let Some((time, kind)) = r.close else {
            continue;
        };
        let Some(day) = time
            .checked_sub(from)
            .and_then(|d| usize::try_from(d / DAY).ok())
            .and_then(|i| out.get_mut(i))
        else {
            continue;
        };
        if let Some(n) = day.closes.get_mut(kind as usize) {
            *n = n.saturating_add(1);
        }
        day.capacity = day.capacity.saturating_add(r.capacity);
    }
    out
}

#[cfg(test)]
mod tests {
    #![allow(clippy::indexing_slicing)]

    use super::*;

    fn key(n: u8) -> [u8; 33] {
        [n; 33]
    }

    fn row(a: u8, b: u8, capacity: u64, open: u64, close: Option<(u64, Kind)>) -> Row {
        Row {
            nodes: [key(a), key(b)],
            capacity,
            open,
            close,
        }
    }

    fn ids(v: &[Mover]) -> Vec<(u8, i64, i64, Option<u64>)> {
        v.iter()
            .map(|m| (m.id[0], m.capacity, m.channels, m.time))
            .collect()
    }

    #[test]
    fn movers_are_opened_less_closed_in_the_period() {
        let since = 1_000;
        let rows = [
            // 1 gains a channel; 2 gains it too, and loses one to 3.
            row(1, 2, 100, 1_500, None),
            row(3, 2, 50, 100, Some((1_200, Kind::Force))),
            // 3 keeps a channel with 4; 4 loses one to 5, which has no other: 5 left.
            row(3, 4, 10, 100, None),
            row(5, 4, 70, 100, Some((1_300, Kind::Cooperative))),
            // 6 is new: its only channel opened and closed inside the period, so it moved nothing
            // and left too. 1 is not new: it had a channel before.
            row(6, 1, 30, 1_100, Some((1_400, Kind::Other))),
            row(1, 4, 20, 50, None),
            // Before the period: counts nothing.
            row(7, 8, 500, 10, Some((900, Kind::Force))),
        ];
        let m = movers(&rows, since);
        assert_eq!(ids(&m.capacity_up), [(1, 100, 1, None), (2, 50, 0, None)]);
        assert_eq!(
            ids(&m.capacity_down),
            [(4, -70, -1, None), (5, -70, -1, None), (3, -50, -1, None)]
        );
        assert_eq!(ids(&m.channels_up), [(1, 100, 1, None)]);
        assert_eq!(
            ids(&m.channels_down)
                .iter()
                .map(|r| r.0)
                .collect::<Vec<_>>(),
            [3, 4, 5]
        );
        assert_eq!(ids(&m.new), [(6, 0, 0, Some(1_100))]);
        assert_eq!(
            ids(&m.left),
            [(6, 0, 0, Some(1_400)), (5, -70, -1, Some(1_300))]
        );
        // A longer period reaches the old close: 7 and 8 left then.
        let all = movers(&rows, 0);
        assert!(all.left.iter().any(|m| m.id == key(7)));
        assert_eq!(all.new.len(), 8, "every node's first channel is in it");
    }

    #[test]
    fn lists_hold_ten_largest_first() {
        let rows: Vec<Row> = (0..30u8)
            .map(|n| row(n, 200, 1_000 + u64::from(n), 500, None))
            .collect();
        let m = movers(&rows, 0);
        assert_eq!(m.capacity_up.len(), MOVERS);
        assert_eq!(m.capacity_up[0].id, key(200));
        assert_eq!(m.capacity_up[1].id, key(29));
        assert!(m.capacity_down.is_empty() && m.left.is_empty());
    }

    #[test]
    fn closes_fill_every_day_and_count_each_kind() {
        let now = 10 * DAY + 3_600;
        let rows = [
            row(1, 2, 100, 0, Some((10 * DAY + 60, Kind::Cooperative))),
            row(1, 2, 200, 0, Some((10 * DAY + 61, Kind::Force))),
            row(1, 2, 300, 0, Some((8 * DAY, Kind::Penalty))),
            row(1, 2, 400, 0, Some((8 * DAY + DAY - 1, Kind::Other))),
            // Before the span, after now, and open: not counted.
            row(1, 2, 999, 0, Some((7 * DAY + DAY - 1, Kind::Force))),
            row(1, 2, 999, 0, Some((11 * DAY, Kind::Force))),
            row(1, 2, 999, 0, None),
        ];
        let days = closes(&rows, now, 3);
        assert_eq!(
            days,
            [
                Day {
                    time: 8 * DAY,
                    closes: [0, 0, 1, 1],
                    capacity: 700,
                },
                Day {
                    time: 9 * DAY,
                    closes: [0; 4],
                    capacity: 0,
                },
                Day {
                    time: 10 * DAY,
                    closes: [1, 1, 0, 0],
                    capacity: 300,
                },
            ]
        );
        assert!(closes(&[], now, 90).iter().all(|d| d.closes == [0; 4]));
        assert_eq!(closes(&[], now, 90).len(), 90);
    }
}
