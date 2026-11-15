#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bitcoin::hashes::Hash;
use bitcoin::{BlockHash, Txid};

use super::*;
use crate::store::{Options, Store};

struct Temp {
    dir: PathBuf,
    store: Arc<Store>,
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn temp() -> Temp {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "rbitcoin-space-ln-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let store = Arc::new(Store::open(&dir, "regtest", Options::default()).unwrap());
    Temp { dir, store }
}

fn block(height: u32, tag: u8) -> Block {
    Block {
        height,
        hash: BlockHash::from_byte_array([tag; 32]),
        time: 1_700_000_000 + u64::from(height),
    }
}

fn open(scid: u64, tag: u8) -> Open {
    Open {
        scid,
        node_one: [2; 33],
        node_two: [3; 33],
        capacity: 1_000_000 + scid,
        block: block(u32::try_from(scid >> 40).unwrap(), tag),
    }
}

fn close(height: u32, kind: Kind, tx: u8) -> Close {
    Close {
        block: block(height, 0xc0),
        txid: Txid::from_byte_array([tx; 32]),
        kind,
        fee: Some(150),
    }
}

const A: u64 = 800_000 << 40 | 5 << 16;
const B: u64 = 800_001 << 40 | 1 << 16 | 1;
const C: u64 = 800_002 << 40;

/// Every row, newest funding first.
async fn table(store: &Store) -> Vec<Channel> {
    opened(store, 1_000).await.unwrap()
}

#[tokio::test]
async fn the_table_follows_opens_closes_penalties_and_their_undoing() {
    let t = temp();
    let s = &t.store;
    let penalty = Penalty {
        block: block(800_020, 0xd0),
        txid: Txid::from_byte_array([9; 32]),
    };
    apply(
        s,
        vec![
            Change::Opened(open(A, 1)),
            Change::Opened(open(B, 1)),
            Change::Opened(open(C, 1)),
            Change::Closed(open(A, 1), close(800_010, Kind::Force, 7)),
            Change::Closed(open(B, 1), close(800_011, Kind::Cooperative, 8)),
            Change::Penalty(A, penalty),
            // A penalty for an open channel names nothing stored.
            Change::Penalty(C, penalty),
        ],
    )
    .await
    .unwrap();
    let rows = table(s).await;
    assert_eq!(
        rows.iter().map(|c| c.open.scid).collect::<Vec<_>>(),
        [C, B, A]
    );
    assert_eq!(rows[2].close, Some(close(800_010, Kind::Force, 7)));
    assert_eq!(rows[2].penalty, Some(penalty));
    assert_eq!(rows[2].open, open(A, 1));
    assert_eq!((rows[0].close, rows[0].penalty), (None, None));
    // Newest close first.
    let closes = closed(s, 10).await.unwrap();
    assert_eq!(
        closes.iter().map(|c| c.open.scid).collect::<Vec<_>>(),
        [B, A]
    );
    assert_eq!(closed(s, 1).await.unwrap().len(), 1);

    // A reorg: the penalty, then A's close, then C's open leave the chain; C is found again in
    // another block.
    apply(
        s,
        vec![
            Change::PenaltyUndone(A),
            Change::CloseUndone(A),
            Change::OpenUndone(C),
        ],
    )
    .await
    .unwrap();
    let rows = table(s).await;
    assert_eq!(rows.iter().map(|c| c.open.scid).collect::<Vec<_>>(), [B, A]);
    assert_eq!((rows[1].close, rows[1].penalty), (None, None));
    apply(s, vec![Change::Opened(open(C, 2))]).await.unwrap();
    assert_eq!(table(s).await[0].open, open(C, 2));
}

/// What the overview's feed takes as news: a change that wrote a row. A restart's replay of an
/// open, or a close or penalty found again, writes nothing.
#[tokio::test]
async fn only_changes_the_table_did_not_hold_are_written() {
    let t = temp();
    let s = &t.store;
    let penalty = Penalty {
        block: block(800_020, 0xd0),
        txid: Txid::from_byte_array([9; 32]),
    };
    let ab = vec![Change::Opened(open(A, 1)), Change::Opened(open(B, 1))];
    let wrote = |c: Vec<Change>| apply_from(s, s.generation(), c);
    assert_eq!(wrote(ab.clone()).await.unwrap(), [true, true]);
    assert_eq!(wrote(ab).await.unwrap(), [false, false]);
    // The same channel funded in another block is news again.
    assert_eq!(
        wrote(vec![Change::Opened(open(A, 2))]).await.unwrap(),
        [true]
    );
    let closed = Change::Closed(open(A, 2), close(800_010, Kind::Force, 7));
    assert_eq!(wrote(vec![closed]).await.unwrap(), [true]);
    assert_eq!(
        wrote(vec![
            Change::Penalty(A, penalty),
            Change::Penalty(B, penalty)
        ])
        .await
        .unwrap(),
        [true, false],
        "a penalty for an open channel writes nothing"
    );
    // Found again after a restart: nothing written, and the penalty stays.
    assert_eq!(
        wrote(vec![closed, Change::Penalty(A, penalty)])
            .await
            .unwrap(),
        [false, false]
    );
    assert_eq!(channel(s, A).await.unwrap().unwrap().penalty, Some(penalty));
    let swept = penalties(s, 10).await.unwrap();
    assert_eq!(swept.iter().map(|c| c.open.scid).collect::<Vec<_>>(), [A]);
    // Another closing transaction is news.
    let other = Change::Closed(open(A, 2), close(800_010, Kind::Cooperative, 8));
    assert_eq!(wrote(vec![other]).await.unwrap(), [true]);
}

#[tokio::test]
async fn records_applied_again_or_replayed_by_a_restart_change_nothing() {
    let run = vec![
        Change::Opened(open(A, 1)),
        Change::Opened(open(B, 1)),
        Change::Closed(open(A, 1), close(800_010, Kind::Force, 7)),
        Change::Penalty(
            A,
            Penalty {
                block: block(800_020, 0xd0),
                txid: Txid::from_byte_array([9; 32]),
            },
        ),
    ];
    let once = temp();
    apply(&once.store, run.clone()).await.unwrap();
    let want = table(&once.store).await;

    let twice = temp();
    for _ in 0..2 {
        apply(&twice.store, run.clone()).await.unwrap();
    }
    // A restart: the peer opens every channel still open and finds A's close again by its spend
    // records, which do not show the penalty. The stored penalty stays with the same close.
    apply(
        &twice.store,
        vec![
            Change::Opened(open(B, 1)),
            Change::Closed(open(A, 1), close(800_010, Kind::Force, 7)),
        ],
    )
    .await
    .unwrap();
    assert_eq!(table(&twice.store).await, want);

    // An open after a stored close means the close left the chain while we were away.
    apply(&twice.store, vec![Change::Opened(open(A, 1))])
        .await
        .unwrap();
    let a = table(&twice.store).await[1];
    assert_eq!((a.close, a.penalty), (None, None));
}

/// Rows the writer's connection has changed since it opened.
async fn written(s: &Store) -> i64 {
    s.write(|sql| {
        Ok(sql
            .prepare("SELECT total_changes()")?
            .query_row([], |r| r.get(0))?)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn an_unchanged_open_is_not_written_again() {
    let t = temp();
    apply(&t.store, vec![Change::Opened(open(A, 1))])
        .await
        .unwrap();
    let before = written(&t.store).await;
    apply(&t.store, vec![Change::Opened(open(A, 1))])
        .await
        .unwrap();
    // The open matched the stored row, so nothing was written.
    assert_eq!(written(&t.store).await, before);
    apply(&t.store, vec![Change::Opened(open(A, 2))])
        .await
        .unwrap();
    assert_eq!(written(&t.store).await, before + 1);
}

fn snapshot(n: u64) -> Stats {
    Stats {
        channels: 100 * n,
        nodes: 50 * n,
        capacity: 1_000 * n,
        tor_nodes: 20 * n,
        clearnet_nodes: 10 * n,
        clearnet_tor_nodes: 5 * n,
        unannounced_nodes: 15 * n,
        med_capacity: 7 * n,
        policies: 150 * n,
        fee_rate: 3_000 * n,
        base_fee: 1_500 * n,
        med_fee_rate: n,
        med_base_fee: 2 * n,
    }
}

fn point(time: u64, n: u64) -> Point {
    Point {
        time,
        samples: 1,
        sums: snapshot(n),
    }
}

const NOW: u64 = 1_800_000_000 / DAY * DAY;

#[tokio::test]
async fn snapshots_roll_into_hours_and_days_without_losing_sums() {
    let t = temp();
    // Six snapshots of one hour ten days ago, and one an hour later.
    let old = NOW - 10 * DAY;
    let rows: Vec<Point> = (0..6).map(|i| point(old + i * EVERY, i + 1)).collect();
    insert(&t.store, Level::Minute, rows).await.unwrap();
    insert(&t.store, Level::Minute, vec![point(old + HOUR, 10)])
        .await
        .unwrap();
    let rolled = record(&t.store, point(NOW, 1), NOW).await.unwrap();
    assert_eq!(
        rolled,
        crate::history::Rolled {
            minutes: 7,
            hours: 0
        }
    );
    // Running it again changes nothing.
    let again = record(&t.store, point(NOW, 1), NOW).await.unwrap();
    assert_eq!(again, crate::history::Rolled::default());

    let s = series(&t.store, Interval::Month, NOW).await.unwrap();
    assert_eq!(s.step, HOUR);
    let first = s.points[0];
    assert_eq!((first.time, first.samples), (old, 6));
    // Sums of 1..=6, so means stay exact: 21 / 6 snapshots.
    assert_eq!(first.sums, snapshot(21));
    assert_eq!(first.mean(first.sums.channels), 350.0);
    assert_eq!(s.points[1].sums, snapshot(10));
    assert_eq!(s.points.last().unwrap().time, NOW);
    assert!(!s.complete());

    // Past 400 days hours become days, sums kept; a snapshot for a rolled-up hour is refused.
    let later = NOW + 400 * DAY;
    let rolled = record(&t.store, point(later, 1), later).await.unwrap();
    assert_eq!(rolled.hours, 2);
    assert_eq!(rolled.minutes, 1);
    let day = old / DAY * DAY;
    let all = series(&t.store, Interval::All, later).await.unwrap();
    assert_eq!(all.first, Some(day));
    assert_eq!(all.points[0].samples, 7);
    assert_eq!(all.points[0].sums, snapshot(31));
    record(&t.store, point(old + 2 * EVERY, 99), later)
        .await
        .unwrap();
    let again = series(&t.store, Interval::All, later).await.unwrap();
    assert_eq!(again.points[0].sums, snapshot(31));

    let newest = latest(&t.store).await.unwrap().unwrap();
    assert_eq!((newest.time, newest.sums), (later, snapshot(1)));
}

#[tokio::test]
async fn the_table_stays_bounded_over_the_years() {
    let t = temp();
    let years = 3;
    let start = NOW - years * 365 * DAY;
    // A snapshot an hour (every tenth would be the same roll-up, at six times the test's time),
    // written a year at a time and rolled as a running server would.
    for year in 0..years {
        let from = start + year * 365 * DAY;
        let rows: Vec<Point> = (0..365 * DAY / HOUR)
            .map(|i| point(from + i * HOUR, 1))
            .collect();
        insert(&t.store, Level::Minute, rows).await.unwrap();
        record(&t.store, point(from + 365 * DAY, 1), from + 365 * DAY)
            .await
            .unwrap();
    }
    let rows: i64 = t
        .store
        .read(crate::store::Read::Blocks, |sql| {
            Ok(sql
                .prepare("SELECT count(*) FROM ln_statistics")?
                .query_row([], |r| r.get(0))?)
        })
        .await
        .unwrap();
    // 8 days of snapshots, 392 days of hours, and a row a day before that.
    let bound = KEEP_MINUTES / HOUR + (KEEP_HOURS - KEEP_MINUTES) / HOUR + (years * 365 - 400) + 2;
    assert!(rows as u64 <= bound, "{rows} rows");
    let all = series(&t.store, Interval::All, NOW).await.unwrap();
    assert!(all.points.len() <= 1_000);
    let total: u64 = all.points.iter().map(|p| p.samples).sum();
    // No snapshot lost or counted twice in the roll-ups. Each year's last write is the next
    // year's first snapshot, stored once.
    assert_eq!(total, years * 365 * DAY / HOUR + 1);
}

#[tokio::test]
async fn an_interrupted_write_leaves_nothing_behind() {
    let t = temp();
    let old = NOW - 10 * DAY;
    insert(&t.store, Level::Minute, vec![point(old, 1)])
        .await
        .unwrap();
    // Fail the roll-up's delete: the snapshot inserted before it in the same write goes too.
    t.store
        .write(|sql| {
            sql.prepare(
                "CREATE TEMP TRIGGER fail BEFORE DELETE ON ln_statistics BEGIN SELECT RAISE(ABORT, 'no'); END",
            )?
            .execute([])?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(record(&t.store, point(NOW, 5), NOW).await.is_err());
    assert_eq!(latest(&t.store).await.unwrap().unwrap().time, old);
    t.store
        .write(|sql| {
            sql.prepare("DROP TRIGGER temp.fail")?.execute([])?;
            Ok(())
        })
        .await
        .unwrap();
    record(&t.store, point(NOW, 5), NOW).await.unwrap();
    let s = series(&t.store, Interval::Month, NOW).await.unwrap();
    assert_eq!(s.points.iter().map(|p| p.samples).sum::<u64>(), 2);
}

#[test]
fn medians_take_the_lower_middle() {
    assert_eq!(median(&mut []), 0);
    assert_eq!(median(&mut [5]), 5);
    assert_eq!(median(&mut [9, 1, 5, 3]), 3);
    assert_eq!(median(&mut [9, 1, 5]), 5);
}

#[tokio::test(start_paused = true)]
async fn snapshots_every_ten_minutes_skipping_unsynced_late_and_busy_slots() {
    // A blocking task waiting keeps tokio from jumping virtual time while the store's own
    // thread writes.
    let (release, held) = std::sync::mpsc::channel::<()>();
    let hold = tokio::task::spawn_blocking(move || held.recv());
    let t = temp();
    let wall = Duration::from_secs(NOW + 30);
    let start = tokio::time::Instant::now();
    let jump = Arc::new(Mutex::new(Duration::ZERO));
    let clock = {
        let jump = Arc::clone(&jump);
        move || wall + start.elapsed() + *jump.lock().unwrap()
    };
    let synced = Arc::new(AtomicBool::new(false));
    let events = Arc::new(Mutex::new(Vec::new()));
    let config = Config {
        clock: Arc::new(clock.clone()),
        observer: {
            let events = Arc::clone(&events);
            Arc::new(move |e: &Event| events.lock().unwrap().push(e.clone()))
        },
    };
    let task = tokio::spawn(run(
        Arc::clone(&t.store),
        {
            let synced = Arc::clone(&synced);
            move || synced.load(Ordering::SeqCst).then(|| snapshot(1))
        },
        config,
    ));
    let next = |n: u64| async move {
        // Let the loop take its time and start sleeping before time moves.
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_secs(EVERY) * u32::try_from(n).unwrap()).await;
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
    };
    let wait_for = |n: usize| {
        let events = Arc::clone(&events);
        async move {
            let waited = std::time::Instant::now();
            while events.lock().unwrap().len() < n {
                assert!(
                    waited.elapsed() < Duration::from_secs(20),
                    "no event {n}: {:?}",
                    events.lock().unwrap()
                );
                tokio::task::yield_now().await;
            }
        }
    };

    next(1).await;
    wait_for(1).await;
    synced.store(true, Ordering::SeqCst);
    next(1).await;
    wait_for(2).await;
    // The process stalls: the clock is two minutes past the slot when the loop wakes.
    *jump.lock().unwrap() = Duration::from_secs(120);
    next(1).await;
    wait_for(3).await;
    *jump.lock().unwrap() = Duration::ZERO;
    next(1).await;
    wait_for(4).await;

    let events = events.lock().unwrap().clone();
    let slot = (NOW + 30).div_ceil(EVERY) * EVERY;
    assert_eq!(
        events[0],
        Event::Skipped {
            time: slot,
            reason: Skip::Syncing
        }
    );
    assert!(matches!(events[1], Event::Written { time, .. } if time == slot + EVERY));
    assert!(matches!(
        events[2],
        Event::Skipped {
            reason: Skip::Late,
            ..
        }
    ));
    assert!(matches!(events[3], Event::Written { time, .. } if time == slot + 3 * EVERY));
    let stored = series(&t.store, Interval::Day, clock().as_secs())
        .await
        .unwrap();
    assert_eq!(
        stored.points.iter().map(|p| p.time).collect::<Vec<_>>(),
        [slot + EVERY, slot + 3 * EVERY]
    );
    task.abort();
    drop(release);
    let _ = hold.await;
}

// The derived index and the readers it and the routes use.

fn policy(fee_rate: u32, enabled: bool) -> Policy {
    Policy {
        fee_rate,
        base_fee_msat: 1_000,
        cltv_delta: 80,
        min_htlc_msat: 1,
        max_htlc_msat: 1_000_000,
        enabled,
        last_update: 1_700_000_000,
        inbound: None,
    }
}

fn key(n: u8) -> [u8; 33] {
    let mut k = [n; 33];
    k[0] = 2;
    k
}

fn gchan(scid: u64, a: u8, b: u8, capacity: u64) -> GraphChannel {
    GraphChannel {
        scid,
        nodes: [key(a), key(b)],
        capacity,
        policies: [Some(policy(100, true)), Some(policy(1, true))],
    }
}

fn gnode(n: u8, alias: &str) -> GraphNode {
    GraphNode {
        id: key(n),
        announcement: Some(Announcement {
            alias: alias.to_owned(),
            color: [n, n, n],
            addresses: vec![format!("10.0.0.{n}:9735")],
            features: vec![0b1010_0000, 0b10],
            last_update: 1_700_000_000,
        }),
    }
}

fn sopen(c: &GraphChannel, height: u32) -> Open {
    Open {
        scid: c.scid,
        node_one: c.nodes[0],
        node_two: c.nodes[1],
        capacity: c.capacity,
        block: block(height, 1),
    }
}

const D: u64 = 800_003 << 40;

/// The index as the server builds it: the graph's copy and the store's past.
async fn index(s: &Store, nodes: &[GraphNode], channels: &[GraphChannel]) -> Index {
    Index::build(nodes.to_vec(), channels.to_vec(), &past(s).await.unwrap())
}

fn ids<'a>(nodes: impl Iterator<Item = &'a Node>) -> Vec<u8> {
    nodes.map(|n| n.id[1]).collect()
}

#[test]
fn capacity_splits_by_address_once_per_channel() {
    // 1 clearnet, 2 Tor only, 3 both, 4 no address, 5 no announcement, 6 Tor only.
    let with = |n: u8, addresses: &[&str]| {
        let mut g = gnode(n, "x");
        if let Some(a) = g.announcement.as_mut() {
            a.addresses = addresses.iter().map(|a| (*a).to_owned()).collect();
        }
        g
    };
    let onion = "of7husrflx7sforh3fw6yqlpwstee3wg5imvvmkp4bz6rbjxtg5nljad.onion:9735";
    let nodes = vec![
        with(1, &["1.2.3.4:9735"]),
        with(2, &[onion]),
        with(3, &["[2001:db8::1]:9735", onion]),
        with(4, &[]),
        GraphNode {
            id: key(5),
            announcement: None,
        },
        with(6, &[onion]),
    ];
    let channels = vec![
        gchan(1, 1, 2, 1),       // clearnet and Tor: clearnet
        gchan(2, 2, 3, 10),      // Tor and both: clearnet
        gchan(3, 2, 6, 100),     // Tor and Tor: Tor
        gchan(4, 1, 4, 1_000),   // an end with no address: unknown
        gchan(5, 5, 6, 10_000),  // an end that announced nothing: unknown
        gchan(6, 1, 7, 100_000), // an end not copied: unknown
    ];
    let i = Index::build(nodes, channels, &Past::default());
    assert_eq!(i.by_address(), [11, 100, 111_000]);
    assert_eq!(i.by_address().iter().sum::<u64>(), 111_111);
}

#[tokio::test]
async fn the_index_follows_opens_closes_reorgs_policy_updates_and_departures() {
    let t = temp();
    let s = &t.store;
    let nodes = vec![gnode(1, "one"), gnode(2, "two"), gnode(3, "three")];
    let (a, b, c) = (
        gchan(A, 1, 2, 5_000_000),
        gchan(B, 1, 3, 2_000_000),
        gchan(C, 2, 3, 1_000_000),
    );
    let mut graph = vec![a.clone(), b.clone(), c.clone()];
    apply(
        s,
        graph
            .iter()
            .enumerate()
            .map(|(i, c)| Change::Opened(sopen(c, 800_000 + i as u32)))
            .collect(),
    )
    .await
    .unwrap();
    let i = index(s, &nodes, &graph).await;
    assert_eq!(i.len(), (3, 3));
    let one = i.node(&key(1)).unwrap();
    assert_eq!((one.open(), one.capacity, one.active), (2, 7_000_000, 2));
    assert_eq!(
        i.channels_of(one).map(|c| c.scid).collect::<Vec<_>>(),
        [A, B]
    );
    assert_eq!(one.past.unwrap().first_seen, block(800_000, 1).time);
    assert_eq!(ids(i.ranking(Rank::Capacity)), [1, 2, 3]);
    assert_eq!(ids(i.ranking(Rank::Channels)), [1, 2, 3]);
    assert_eq!(ids(i.ranking(Rank::Age)), [1, 2, 3]);

    // An open.
    let d = gchan(D, 3, 1, 9_000_000);
    graph.push(d.clone());
    apply(s, vec![Change::Opened(sopen(&d, 800_003))])
        .await
        .unwrap();
    let i = index(s, &nodes, &graph).await;
    assert_eq!(i.node(&key(1)).unwrap().open(), 3);
    assert_eq!(ids(i.ranking(Rank::Capacity)), [1, 3, 2]);

    // A close: gone from the graph, counted from the store.
    graph.retain(|x| x.scid != B);
    let close_b = Change::Closed(sopen(&b, 800_001), close(800_010, Kind::Cooperative, 8));
    apply(s, vec![close_b]).await.unwrap();
    let i = index(s, &nodes, &graph).await;
    assert!(i.channel(B).is_none());
    let three = i.node(&key(3)).unwrap();
    assert_eq!(
        (three.open(), three.past.unwrap().closed),
        (2, [1, 0, 0, 0])
    );

    // A reorg undoes it: back in the graph and no longer counted.
    graph.push(b.clone());
    apply(s, vec![Change::CloseUndone(B)]).await.unwrap();
    let i = index(s, &nodes, &graph).await;
    let three = i.node(&key(3)).unwrap();
    assert_eq!(
        (three.open(), three.past.unwrap().closed),
        (3, [0, 0, 0, 0])
    );

    // A policy update: node one disables A and raises its fee.
    graph.iter_mut().find(|x| x.scid == A).unwrap().policies[0] = Some(policy(2_345, false));
    let i = index(s, &nodes, &graph).await;
    let one = i.node(&key(1)).unwrap();
    let [incoming, outgoing] = i.fees(one);
    assert!(
        outgoing
            .iter()
            .any(|x| x.bucket == Some(2_000) && x.capacity == 5_000_000)
    );
    assert_eq!(incoming.iter().map(|x| x.count).sum::<u64>(), 3);
    assert!(
        i.channel(A).unwrap().active(),
        "node two's direction still forwards"
    );

    // Node two leaves: its channels close.
    graph.retain(|x| x.scid != A && x.scid != C);
    apply(
        s,
        vec![
            Change::Closed(sopen(&a, 800_000), close(800_011, Kind::Force, 9)),
            Change::Closed(sopen(&c, 800_002), close(800_011, Kind::Other, 10)),
        ],
    )
    .await
    .unwrap();
    let i = index(s, &nodes, &graph).await;
    assert!(i.node(&key(2)).is_none());
    assert!(i.search("two", 10).is_empty());
    assert_eq!(ids(i.ranking(Rank::Channels)), [1, 3]);
    assert_eq!(i.node(&key(1)).unwrap().past.unwrap().closed, [0, 1, 0, 0]);

    // A restart reads the same store into the same index.
    let again = Store::open(&t.dir, "regtest", Options::default()).unwrap();
    let j = index(&again, &nodes, &graph).await;
    assert_eq!(past(&again).await.unwrap(), past(s).await.unwrap());
    for id in [key(1), key(3)] {
        assert_eq!(j.node(&id), i.node(&id));
    }
}

#[test]
fn search_matches_keys_and_aliases_as_plain_text_within_its_cap() {
    let markup = "<script>alert(1)</script>";
    let mut nodes = vec![
        gnode(1, "ACINQ"),
        gnode(2, "acinq"),
        gnode(3, markup),
        gnode(4, "bad\u{fffd}name"),
    ];
    nodes.push(GraphNode {
        id: key(5),
        announcement: None,
    });
    let graph = vec![
        gchan(A, 1, 5, 9_000_000),
        gchan(B, 2, 5, 1_000_000),
        gchan(C, 3, 5, 1_000_000),
        gchan(D, 4, 5, 1_000_000),
    ];
    let i = Index::build(nodes, graph, &Past::default());
    // The impersonator matches too, after the larger node: an alias is a claim, not an identity.
    assert_eq!(ids(i.search("AcInQ", 10).into_iter()), [1, 2]);
    assert_eq!(ids(i.search("<script>", 10).into_iter()), [3]);
    assert_eq!(i.search("<script>", 10)[0].alias(), Some(markup));
    assert_eq!(ids(i.search("\u{fffd}", 10).into_iter()), [4]);
    // Public keys by prefix, any case, before aliases.
    assert_eq!(ids(i.search("0201", 10).into_iter()), [1]);
    assert_eq!(ids(i.search("02", 10).into_iter()), [1, 2, 3, 4, 5]);
    assert_eq!(i.search("02", 2).len(), 2);
    assert_eq!(
        ids(i.search(&hex(&key(5)).to_uppercase(), 10).into_iter()),
        [5]
    );
    assert!(i.search(&"a".repeat(10_000), 10).is_empty());
    assert!(i.search("zz", 10).is_empty());
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[test]
fn fee_buckets_follow_the_reference_s_steps() {
    let cases = [
        (0, 0),
        (7, 7),
        (10, 10),
        (99, 90),
        (137, 100),
        (999, 900),
        (1_000, 1_000),
        (137_000, 137_000),
        (2_000_499, 2_000_000),
    ];
    for (rate, want) in cases {
        assert_eq!(bucket(rate), want, "{rate}");
    }
    let mut c = gchan(A, 1, 2, 10);
    c.policies[1] = None;
    let i = Index::build(vec![], vec![c], &Past::default());
    let [incoming, outgoing] = i.fees(i.node(&key(1)).unwrap());
    assert_eq!(
        incoming,
        [Bucket {
            bucket: None,
            count: 1,
            capacity: 10
        }]
    );
    assert_eq!(
        outgoing,
        [Bucket {
            bucket: Some(100),
            count: 1,
            capacity: 10
        }]
    );
}

#[test]
fn a_node_s_past_counts_what_was_open_at_each_midnight() {
    let spans = [
        Span {
            open: 100,
            close: None,
            capacity: 5,
        },
        Span {
            open: DAY + 10,
            close: Some(2 * DAY),
            capacity: 7,
        },
        Span {
            open: 2 * DAY + 1,
            close: None,
            capacity: 1,
        },
    ];
    let s = node_series(&spans, Some(DAY / 2), 3 * DAY + 5, false);
    let got: Vec<_> = s.iter().map(|p| (p.time, p.channels, p.capacity)).collect();
    assert_eq!(
        got,
        [
            (DAY, 1, 5),
            (2 * DAY, 1, 5),
            (3 * DAY, 2, 6),
            (3 * DAY + 5, 2, 6)
        ]
    );
    // Before any statistics, the present only.
    assert_eq!(node_series(&spans, None, 9 * DAY, false).len(), 1);
    // With its changes: a step at each block time after the first midnight, the channel that
    // opened and closed within a day included, which the midnights alone never show.
    let s = node_series(&spans, Some(DAY / 2), 3 * DAY + 5, true);
    let got: Vec<_> = s.iter().map(|p| (p.time, p.channels, p.capacity)).collect();
    assert_eq!(
        got,
        [
            (DAY, 1, 5),
            (DAY + 10, 2, 12),
            (2 * DAY, 1, 5),
            (2 * DAY + 1, 2, 6),
            (3 * DAY, 2, 6),
            (3 * DAY + 5, 2, 6)
        ]
    );
}

#[tokio::test]
async fn funding_txids_lookups_and_a_node_s_closed_channels() {
    let t = temp();
    let s = &t.store;
    let (a, b) = (open(A, 1), open(B, 1));
    apply(
        s,
        vec![
            Change::Opened(a),
            Change::Opened(b),
            Change::Closed(b, close(800_010, Kind::Force, 8)),
        ],
    )
    .await
    .unwrap();
    assert_eq!(
        unfunded(s, 0, 10).await.unwrap(),
        [(A, a.block.hash), (B, b.block.hash)]
    );
    assert_eq!(unfunded(s, A, 10).await.unwrap(), [(B, b.block.hash)]);
    let fa = Txid::from_byte_array([0xfa; 32]);
    // A txid read from a block the row no longer names is not stored.
    set_funding(
        s,
        vec![
            (A, a.block.hash, fa),
            (B, BlockHash::from_byte_array([0xee; 32]), fa),
        ],
    )
    .await
    .unwrap();
    assert_eq!(unfunded(s, 0, 10).await.unwrap(), [(B, b.block.hash)]);
    assert_eq!(channel(s, A).await.unwrap().unwrap().funding_txid, Some(fa));
    assert_eq!(channel(s, 1).await.unwrap(), None);

    // By transaction: what A's funding opened and what B's close closed, each once.
    let closing = Txid::from_byte_array([8; 32]);
    let found = by_txids(s, vec![fa, closing, fa, Txid::from_byte_array([1; 32])])
        .await
        .unwrap();
    assert_eq!(
        found.iter().map(|c| c.open.scid).collect::<Vec<_>>(),
        [A, B]
    );

    // A's funding block left the chain and it was found in another: the txid goes with it.
    apply(s, vec![Change::OpenUndone(A), Change::Opened(open(A, 2))])
        .await
        .unwrap();
    assert_eq!(channel(s, A).await.unwrap().unwrap().funding_txid, None);
    set_funding(s, vec![(A, open(A, 2).block.hash, fa)])
        .await
        .unwrap();
    apply(s, vec![Change::Opened(open(A, 2))]).await.unwrap();
    assert_eq!(
        channel(s, A).await.unwrap().unwrap().funding_txid,
        Some(fa),
        "an unchanged open keeps it"
    );

    // Both rows are between nodes 2 and 3; only B is closed.
    let (total, rows) = node_closed(s, [3; 33], 0, 10).await.unwrap();
    assert_eq!((total, rows.len(), rows[0].open.scid), (1, 1, B));
    assert_eq!(node_closed(s, [3; 33], 5, 10).await.unwrap(), (1, vec![]));
    assert_eq!(node_closed(s, [9; 33], 0, 10).await.unwrap(), (0, vec![]));
    assert_eq!(node_spans(s, [2; 33]).await.unwrap().len(), 2);
}

/// A close's transaction that funded a channel between the same two nodes continues it, both
/// ways; one between other nodes does not; of several, the lowest id.
#[tokio::test]
async fn lineage_follows_a_closing_transaction_into_the_channels_it_funded() {
    let t = temp();
    let s = &t.store;
    let x = Txid::from_byte_array([0x77; 32]);
    let (a, d) = (open(A, 1), open(800_003 << 40, 1));
    // B and C are both funded by A's closing transaction; D, also funded by it, is between
    // other nodes; E is an open channel closed by nothing.
    let (b, c) = (open(B, 1), open(C, 1));
    let d = Open {
        node_one: [4; 33],
        ..d
    };
    let e = open(800_004 << 40, 1);
    apply(
        s,
        vec![
            Change::Closed(a, close(800_001, Kind::Other, 0x77)),
            Change::Opened(c),
            Change::Opened(b),
            Change::Opened(d),
            Change::Opened(e),
        ],
    )
    .await
    .unwrap();
    // Funding txids, as the background filler stores them.
    let fe = Txid::from_byte_array([0xe0; 32]);
    set_funding(
        s,
        vec![
            (B, b.block.hash, x),
            (C, c.block.hash, x),
            (d.scid, d.block.hash, x),
            (e.scid, e.block.hash, fe),
        ],
    )
    .await
    .unwrap();
    let get = |scid| async move { channel(s, scid).await.unwrap().unwrap() };
    let (next, previous) = lineage(s, get(A).await).await.unwrap();
    assert_eq!((next.map(|c| c.open.scid), previous), (Some(B), None));
    for later in [B, C] {
        let (next, previous) = lineage(s, get(later).await).await.unwrap();
        assert_eq!((next, previous.map(|c| c.open.scid)), (None, Some(A)));
    }
    // Other nodes, and a channel whose funding closed nothing: no lineage.
    assert_eq!(lineage(s, get(d.scid).await).await.unwrap(), (None, None));
    assert_eq!(lineage(s, get(e.scid).await).await.unwrap(), (None, None));
    // An open channel whose funding txid is not known yet: nothing to follow.
    apply(s, vec![Change::OpenUndone(B), Change::Opened(open(B, 2))])
        .await
        .unwrap();
    assert_eq!(lineage(s, get(B).await).await.unwrap(), (None, None));
    assert_eq!(
        lineage(s, get(A).await)
            .await
            .unwrap()
            .0
            .map(|c| c.open.scid),
        Some(C)
    );
}

/// Mainnet's size: 36,000 channels between 13,600 nodes.
fn mainnet_graph() -> (Vec<GraphNode>, Vec<GraphChannel>) {
    let id = |n: u32| {
        let mut k = [0; 33];
        k[0] = 2;
        k[1..5].copy_from_slice(&n.to_be_bytes());
        k
    };
    let nodes = (0..13_600u32)
        .map(|n| GraphNode {
            id: id(n),
            announcement: Some(Announcement {
                alias: format!("node-{n}-{}", "x".repeat((n % 20) as usize)),
                color: [1, 2, 3],
                addresses: vec![format!("10.0.{}.{}:9735", n / 256, n % 256)],
                features: vec![0xa0, 0x02, 0x09],
                last_update: 1_700_000_000,
            }),
        })
        .collect();
    // A few hubs hold many channels, as on mainnet.
    let channels = (0..36_000u32)
        .map(|c| GraphChannel {
            scid: (u64::from(c) + 600_000) << 40,
            nodes: [id(c % 50), id(50 + c % 13_550)],
            capacity: 100_000 + u64::from(c) * 997 % 50_000_000,
            policies: [Some(policy(c % 3_000, true)), Some(policy(1, c % 7 != 0))],
        })
        .collect();
    (nodes, channels)
}

/// Every query on an index of mainnet's size, checked for its answer. The time each takes is
/// `an_index_of_mainnet_s_size_answers_within_its_budget`, outside the normal suite.
fn mainnet_index_queries(i: &Index) -> Vec<Duration> {
    let hub = i.ranking(Rank::Channels).next().unwrap().id;
    let time = |f: &dyn Fn()| {
        let t = std::time::Instant::now();
        f();
        t.elapsed()
    };
    vec![
        time(&|| assert_eq!(i.node(&hub).unwrap().open(), 720)),
        time(&|| assert!(i.channel(600_000 << 40).is_some())),
        time(&|| assert_eq!(i.channels_of(i.node(&hub).unwrap()).take(25).count(), 25)),
        time(&|| assert_eq!(i.fees(i.node(&hub).unwrap())[0].len(), 1)),
        // Every alias contains "node": the longest search, capped.
        time(&|| assert_eq!(i.search("node", 10).len(), 10)),
        time(&|| assert_eq!(i.search("02", 10).len(), 10)),
        time(&|| assert_eq!(i.ranking(Rank::Capacity).count(), RANKED)),
    ]
}

#[test]
fn an_index_of_mainnet_s_size_builds_and_answers() {
    let (nodes, channels) = mainnet_graph();
    let i = Index::build(nodes, channels, &Past::default());
    assert_eq!(i.len(), (13_600, 36_000));
    mainnet_index_queries(&i);
}

/// The time budget, measured where nothing else shares the machine. Run with
/// `cargo test -p engine -- --ignored an_index_of_mainnet_s_size_answers_within_its_budget`.
#[test]
#[ignore = "a time budget: a busy machine fails it for no fault of the code"]
fn an_index_of_mainnet_s_size_answers_within_its_budget() {
    let (nodes, channels) = mainnet_graph();
    let started = std::time::Instant::now();
    let i = Index::build(nodes, channels, &Past::default());
    let build = started.elapsed();
    let worst = mainnet_index_queries(&i).into_iter().max().unwrap();
    // Debug build; release is about ten times faster (docs/API.md).
    assert!(build < Duration::from_secs(3), "{build:?}");
    assert!(worst < Duration::from_millis(50), "{worst:?}");
}

// Fee history.

fn priced(fee_rate: u32, time: u32, inbound: Option<Inbound>) -> Policy {
    Policy {
        fee_rate,
        base_fee_msat: 1_000,
        cltv_delta: 80,
        min_htlc_msat: 1,
        max_htlc_msat: 1_000_000,
        enabled: true,
        last_update: time,
        inbound,
    }
}

fn graph_channel(scid: u64, one: Option<Policy>, two: Option<Policy>) -> GraphChannel {
    GraphChannel {
        scid,
        nodes: [[2; 33], [3; 33]],
        capacity: 1_000_000,
        policies: [one, two],
    }
}

/// A round as the server runs one: diff, store, take in what was stored.
async fn fee_round(
    store: &Store,
    heads: &mut fees::Heads,
    graph: &[GraphChannel],
    run: u64,
) -> Vec<fees::Outcome> {
    let (epoch, records) = (heads.epoch(), heads.diff(graph));
    let outcomes = fees::record(store, records.clone(), run, u64::from(T) + 9_999)
        .await
        .unwrap();
    heads.apply(epoch, &records, &outcomes);
    outcomes
}

const T: u32 = 1_790_000_000;

#[tokio::test]
async fn fee_history_keeps_each_change_at_its_own_time_fifty_a_direction() {
    let t = temp();
    let mut heads = fees::Heads::default();
    // Nothing is kept for a channel not stored open yet; the next round tries again.
    let g = vec![graph_channel(A, Some(priced(100, T, None)), None)];
    assert_eq!(
        fee_round(&t.store, &mut heads, &g, 1).await,
        [fees::Outcome::NotOpen]
    );
    apply(
        &t.store,
        vec![Change::Opened(open(A, 1)), Change::Opened(open(B, 1))],
    )
    .await
    .unwrap();
    // The first policy seen is the starting point; a direction without one has nothing.
    let mut g = vec![graph_channel(A, Some(priced(100, T, None)), None)];
    let first = fee_round(&t.store, &mut heads, &g, 1).await;
    assert_eq!(first, [fees::Outcome::Stored { before: None }]);
    assert_eq!(
        heads.changed(A, 0),
        None,
        "a starting point is not a change"
    );
    assert!(fee_round(&t.store, &mut heads, &g, 1).await.is_empty());

    // Disabled, another CLTV delta, a newer update: not a fee change.
    let mut same = priced(100, T + 5, None);
    same.enabled = false;
    same.cltv_delta = 144;
    g[0].policies[0] = Some(same);
    assert!(heads.diff(&g).is_empty());

    // Another rate, then only the inbound fee: changes, at the updates' own times.
    g[0].policies[0] = Some(priced(200, T + 10, None));
    let inbound = Inbound {
        base_fee_msat: -1_000,
        fee_rate: -50,
    };
    fee_round(&t.store, &mut heads, &g, 1).await;
    g[0].policies[0] = Some(priced(200, T + 20, Some(inbound)));
    let o = fee_round(&t.store, &mut heads, &g, 1).await;
    let before = fees::FeeRecord {
        time: T + 10,
        fees: priced(200, 0, None).fees(),
    };
    assert_eq!(
        o,
        [fees::Outcome::Stored {
            before: Some(before)
        }]
    );
    assert_eq!(heads.changed(A, 0), Some(T + 20));
    let ([one, two], runs) = fees::history(&t.store, A).await.unwrap();
    assert_eq!(
        one.iter()
            .map(|r| (r.time, r.fees.fee_rate))
            .collect::<Vec<_>>(),
        [(T, 100), (T + 10, 200), (T + 20, 200)]
    );
    assert_eq!(one[2].fees.inbound, Some(inbound));
    assert!(two.is_empty());
    assert_eq!(runs, [(1, u64::from(T) + 9_999)]);

    // Sixty more changes: the newest fifty are kept, the oldest go.
    for i in 1..=60 {
        g[0].policies[0] = Some(priced(1_000 + i, T + 100 + i, None));
        fee_round(&t.store, &mut heads, &g, 1).await;
    }
    let ([one, _], _) = fees::history(&t.store, A).await.unwrap();
    assert_eq!(one.len(), fees::KEPT);
    assert_eq!(one[0].time, T + 111);
    assert_eq!(one[49].time, T + 160);
    let newest = fees::newest(&t.store, vec![(A, 0), (A, 1)], 3)
        .await
        .unwrap();
    assert_eq!(
        newest[0]
            .iter()
            .map(|r| r.fees.fee_rate)
            .collect::<Vec<_>>(),
        [1_060, 1_059, 1_058, 1_057]
    );
    assert!(newest[1].is_empty());

    // Closing the channel deletes its history, and nothing is stored for it after.
    g.push(graph_channel(B, None, Some(priced(7, T, None))));
    fee_round(&t.store, &mut heads, &g, 1).await;
    apply(
        &t.store,
        vec![Change::Closed(open(A, 1), close(800_100, Kind::Force, 9))],
    )
    .await
    .unwrap();
    let ([one, two], runs) = fees::history(&t.store, A).await.unwrap();
    assert!(one.is_empty() && two.is_empty() && runs.is_empty());
    g[0].policies[0] = Some(priced(5, T + 500, None));
    assert_eq!(
        fee_round(&t.store, &mut heads, &g[..1], 1).await,
        [fees::Outcome::NotOpen]
    );
    assert_eq!(heads.changed(A, 0), None);
    // B is untouched; a reorg that undoes its open deletes its history too, and a round that
    // read the graph before it stores nothing after it.
    assert_eq!(fees::history(&t.store, B).await.unwrap().0[1].len(), 1);
    apply(&t.store, vec![Change::OpenUndone(B)]).await.unwrap();
    assert!(fees::history(&t.store, B).await.unwrap().0[1].is_empty());
    let stale = vec![(
        B,
        1,
        fees::FeeRecord {
            time: T + 9,
            fees: priced(8, 0, None).fees(),
        },
    )];
    let o = fees::record(&t.store, stale, 1, u64::from(T))
        .await
        .unwrap();
    assert_eq!(o, [fees::Outcome::NotOpen]);
    assert!(fees::history(&t.store, B).await.unwrap().0[1].is_empty());
    // Opened again in another block: once forgotten, the next round starts it again, even when
    // a round whose write committed before the undone open takes in its outcome after.
    apply(&t.store, vec![Change::Opened(open(B, 2))])
        .await
        .unwrap();
    assert!(heads.diff(&g[1..]).is_empty());
    let raced = heads.epoch();
    let late = fees::FeeRecord {
        time: T,
        fees: priced(7, 0, None).fees(),
    };
    heads.forget(B);
    heads.apply(
        raced,
        &[(B, 1, late)],
        &[fees::Outcome::Stored { before: None }],
    );
    assert!(!heads.diff(&g[1..]).is_empty());
    assert_eq!(
        fee_round(&t.store, &mut heads, &g[1..], 1).await,
        [fees::Outcome::Stored { before: None }]
    );
}

#[tokio::test]
async fn fee_history_after_a_restart_neither_invents_nor_reorders() {
    let t = temp();
    apply(&t.store, vec![Change::Opened(open(A, 1))])
        .await
        .unwrap();
    let mut heads = fees::Heads::default();
    let mut g = vec![graph_channel(
        A,
        Some(priced(100, T, None)),
        Some(priced(1, T, None)),
    )];
    fee_round(&t.store, &mut heads, &g, 10).await;
    g[0].policies[0] = Some(priced(150, T + 10, None));
    fee_round(&t.store, &mut heads, &g, 10).await;

    // The next run starts from the table: the same graph is nothing new.
    let loaded = fees::heads(&t.store).await.unwrap();
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded.changed(A, 0), Some(T + 10));
    assert_eq!(loaded.changed(A, 1), None);
    assert!(loaded.diff(&g).is_empty());

    // A graph file older than the table (other fees, an older update) records nothing, and
    // neither does an update with the kept fees; the table says so if asked directly.
    let stale = vec![graph_channel(A, Some(priced(120, T + 5, None)), None)];
    assert!(loaded.diff(&stale).is_empty());
    let kept = fees::FeeRecord {
        time: T + 10,
        fees: priced(150, T + 10, None).fees(),
    };
    let asked = vec![
        (
            A,
            0,
            fees::FeeRecord {
                time: T + 5,
                fees: priced(120, 0, None).fees(),
            },
        ),
        (
            A,
            0,
            fees::FeeRecord {
                time: T + 99,
                fees: kept.fees,
            },
        ),
    ];
    let o = fees::record(&t.store, asked, 20, u64::from(T) + 20_000)
        .await
        .unwrap();
    assert_eq!(
        o,
        [
            fees::Outcome::Kept {
                record: kept,
                changed: true
            },
            fees::Outcome::Kept {
                record: kept,
                changed: true
            }
        ]
    );

    // Changes made while the server was down: only the last is seen, at its own time.
    g[0].policies[0] = Some(priced(300, T + 1_000, None));
    let mut fresh = fees::heads(&t.store).await.unwrap();
    fee_round(&t.store, &mut fresh, &g, 20).await;
    let ([one, _], runs) = fees::history(&t.store, A).await.unwrap();
    assert_eq!(
        one.iter()
            .map(|r| (r.time, r.fees.fee_rate))
            .collect::<Vec<_>>(),
        [(T, 100), (T + 10, 150), (T + 1_000, 300)]
    );
    // Two runs, each with the end of its last round: the time between them was not watched.
    assert_eq!(
        runs,
        [(10, u64::from(T) + 9_999), (20, u64::from(T) + 9_999)]
    );
    // A channel that left the graph is forgotten in memory, not in the table; back with the
    // same fees, its newest record is still a change, as the table says.
    fresh.retain(|_| false);
    assert!(fresh.is_empty());
    assert_eq!(fees::history(&t.store, A).await.unwrap().0[0].len(), 3);
    g[0].policies[0] = Some(priced(300, T + 2_000, None));
    fee_round(&t.store, &mut fresh, &g, 20).await;
    assert_eq!(fresh.changed(A, 0), Some(T + 1_000));
    assert_eq!(fresh.changed(A, 1), None);
}

/// A round whose outcomes are dropped (another channel's history was forgotten meanwhile) leaves
/// no stale head behind: a fee that moves back to where the head stood is still recorded.
#[tokio::test]
async fn fee_history_records_a_return_after_dropped_outcomes() {
    let t = temp();
    apply(&t.store, vec![Change::Opened(open(A, 1))])
        .await
        .unwrap();
    let mut heads = fees::Heads::default();
    let mut g = vec![graph_channel(A, Some(priced(100, T, None)), None)];
    fee_round(&t.store, &mut heads, &g, 1).await;
    g[0].policies[0] = Some(priced(200, T + 10, None));
    let (epoch, records) = (heads.epoch(), heads.diff(&g));
    let outcomes = fees::record(&t.store, records.clone(), 1, u64::from(T))
        .await
        .unwrap();
    heads.forget(C);
    heads.apply(epoch, &records, &outcomes);
    g[0].policies[0] = Some(priced(100, T + 20, None));
    fee_round(&t.store, &mut heads, &g, 1).await;
    let ([one, _], _) = fees::history(&t.store, A).await.unwrap();
    assert_eq!(
        one.iter()
            .map(|r| (r.time, r.fees.fee_rate))
            .collect::<Vec<_>>(),
        [(T, 100), (T + 10, 200), (T + 20, 100)]
    );
    assert_eq!(heads.changed(A, 0), Some(T + 20));
}
