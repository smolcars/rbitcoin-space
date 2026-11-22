//! The history consumer against a scripted peer: the same records, arriving live, as a backlog,
//! past a lagging receiver, across a restart or past a gap, leave the same table.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::AtomicUsize;

use bitcoin::hashes::Hash;
use bitcoin::{BlockHash, Txid};
use engine::store::Options;
use ln::{BlockRef, Closed, NodeId, Opened};

use super::*;

struct Temp {
    dir: PathBuf,
    store: Store,
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn temp() -> Temp {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "rbitcoin-space-ln-consumer-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let store = Store::open(&dir, "regtest", Options::default()).unwrap();
    Temp { dir, store }
}

fn lightning() -> Lightning {
    let config = LightningConfig {
        peers: Vec::new(),
        max_peers: 1,
        max_channels: 10,
    };
    Lightning::new(&config, &std::env::temp_dir(), Network::Regtest)
}

/// A peer that sends what the test scripts: it numbers records, keeps the newest `keep` for
/// `recent`, streams them with room for `room`, and tracks the open set as the real one does.
struct Scripted {
    tx: Mutex<Option<broadcast::Sender<Record>>>,
    kept: Mutex<VecDeque<Record>>,
    keep: usize,
    open: Mutex<HashMap<u64, Opened>>,
    seq: Mutex<u64>,
}

impl Scripted {
    fn new(keep: usize, room: usize) -> (Self, broadcast::Receiver<Record>) {
        let (tx, rx) = broadcast::channel(room);
        let s = Self {
            tx: Mutex::new(Some(tx)),
            kept: Mutex::new(VecDeque::new()),
            keep,
            open: Mutex::new(HashMap::new()),
            seq: Mutex::new(0),
        };
        (s, rx)
    }

    fn send(&self, change: &History) {
        let mut seq = self.seq.lock().unwrap();
        *seq += 1;
        let mut open = self.open.lock().unwrap();
        match change {
            History::Opened(o) => {
                open.insert(o.scid, o.clone());
            }
            History::Closed(c) => {
                open.remove(&c.scid);
            }
            History::OpenUndone { scid } => {
                open.remove(scid);
            }
            History::CloseUndone { scid } => {
                if let Some(o) = opens().into_iter().find(|o| o.scid == *scid) {
                    open.insert(*scid, o);
                }
            }
            _ => {}
        }
        let r = Record {
            seq: *seq,
            change: change.clone(),
        };
        let mut kept = self.kept.lock().unwrap();
        if kept.len() == self.keep {
            kept.pop_front();
        }
        kept.push_back(r.clone());
        if let Some(tx) = &*self.tx.lock().unwrap() {
            let _ = tx.send(r);
        }
    }

    /// The peer stopped: the stream closes.
    fn close(&self) {
        self.tx.lock().unwrap().take();
    }
}

impl HistorySource for Scripted {
    fn recent(&self, after: u64) -> Vec<Record> {
        let kept = self.kept.lock().unwrap();
        kept.iter().filter(|r| r.seq > after).cloned().collect()
    }

    fn open(&self) -> (u64, Vec<Opened>) {
        let seq = *self.seq.lock().unwrap();
        (seq, self.open.lock().unwrap().values().cloned().collect())
    }
}

fn at(height: u32, tag: u8) -> BlockRef {
    BlockRef {
        height,
        hash: BlockHash::from_byte_array([tag; 32]),
        time: 1_700_000_000 + u64::from(height),
    }
}

fn id(n: u8) -> NodeId {
    // Any 33 bytes make a NodeId; the table stores them as they are.
    NodeId::from_slice(&[n; 33]).unwrap()
}

const A: u64 = 800_000 << 40 | 5 << 16;
const B: u64 = 800_001 << 40 | 1 << 16 | 1;
const C: u64 = 800_002 << 40;
const D: u64 = 800_003 << 40;

fn opened(scid: u64, tag: u8) -> Opened {
    Opened {
        scid,
        node_one: id(2),
        node_two: id(3),
        capacity_sats: 1_000 + scid % 1_000,
        block: at(u32::try_from(scid >> 40).unwrap(), tag),
    }
}

fn opens() -> Vec<Opened> {
    vec![opened(A, 1), opened(B, 1), opened(C, 1), opened(D, 1)]
}

fn closed(o: &Opened, height: u32, kind: CloseKind, tx: u8) -> History {
    History::Closed(Closed {
        scid: o.scid,
        node_one: o.node_one,
        node_two: o.node_two,
        capacity_sats: o.capacity_sats,
        opened: o.block,
        closed: at(height, 0xc0),
        txid: Txid::from_byte_array([tx; 32]),
        kind,
        fee_sats: Some(200),
    })
}

/// Opens, closes of every kind, a penalty, and each kind of undoing, in the order a reorg sends
/// them.
fn script() -> Vec<History> {
    let o = opens();
    vec![
        History::Opened(o[0].clone()),
        History::Opened(o[1].clone()),
        History::Opened(o[2].clone()),
        closed(&o[0], 800_010, CloseKind::Force, 7),
        History::Penalty {
            scid: A,
            txid: Txid::from_byte_array([9; 32]),
            block: at(800_012, 0xd0),
        },
        closed(&o[1], 800_011, CloseKind::Cooperative, 8),
        History::Opened(o[3].clone()),
        // A reorg back to 800,001: the sweep, B's close and C's open leave the chain.
        History::PenaltyUndone { scid: A },
        History::CloseUndone { scid: B },
        History::OpenUndone { scid: C },
        // The new branch: C again in another block, B closes otherwise, D closes as a splice.
        History::Opened(opened(C, 2)),
        closed(&o[1], 800_013, CloseKind::Other, 10),
        closed(&o[3], 800_013, CloseKind::Force, 11),
    ]
}

/// The table after applying the script directly, in one write.
async fn want() -> Vec<store_ln::Channel> {
    let t = temp();
    store_ln::apply(&t.store, script().iter().map(change).collect())
        .await
        .unwrap();
    rows(&t.store).await
}

async fn rows(store: &Store) -> Vec<store_ln::Channel> {
    store_ln::opened(store, 1_000).await.unwrap()
}

/// The consumer from a fresh start until the stream closes.
async fn run(src: &Scripted, mut rx: broadcast::Receiver<Record>, store: &Store, l: &Lightning) {
    consume(src, &mut rx, &mut Pending::default(), store, l, "regtest").await;
}

#[tokio::test]
async fn records_sent_live_one_by_one() {
    let t = temp();
    let (peer, rx) = Scripted::new(100, 100);
    let l = lightning();
    tokio::join!(run(&peer, rx, &t.store, &l), async {
        for h in script() {
            peer.send(&h);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        peer.close();
    });
    assert_eq!(rows(&t.store).await, want().await);
    assert_eq!(l.seq.load(Ordering::Relaxed), 13);
    assert_eq!(l.records.load(Ordering::Relaxed), 13);
}

#[tokio::test]
async fn records_kept_before_the_consumer_started_are_stored_once() {
    let t = temp();
    // Everything is both in the peer's memory and on the stream: each is taken once.
    let (peer, rx) = Scripted::new(100, 100);
    for h in script() {
        peer.send(&h);
    }
    peer.close();
    let l = lightning();
    run(&peer, rx, &t.store, &l).await;
    assert_eq!(rows(&t.store).await, want().await);
    assert_eq!(l.records.load(Ordering::Relaxed), 13);
}

#[tokio::test]
async fn a_lagging_receiver_reads_the_peer_s_memory() {
    let t = temp();
    // The stream holds two; the peer keeps everything.
    let (peer, rx) = Scripted::new(100, 2);
    let l = lightning();
    let first = script().len() / 2;
    tokio::join!(run(&peer, rx, &t.store, &l), async {
        // Half while the consumer runs, then a burst that overruns the stream.
        for h in &script()[..first] {
            peer.send(h);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        for h in &script()[first..] {
            peer.send(h);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        peer.close();
    });
    assert_eq!(rows(&t.store).await, want().await);
    assert_eq!(l.seq.load(Ordering::Relaxed), 13);
}

#[tokio::test]
async fn a_restart_in_the_middle_resumes_without_gaps_or_duplicates() {
    let t = temp();
    let split = 6;
    let (before, rx) = Scripted::new(100, 100);
    for h in &script()[..split] {
        before.send(h);
    }
    before.close();
    run(&before, rx, &t.store, &lightning()).await;

    // The new process numbers from 1 again and first opens every channel still open (its graph
    // file replayed), then goes on.
    let (after, rx) = Scripted::new(100, 100);
    let mut still_open: Vec<Opened> = before.open().1;
    still_open.sort_by_key(|o| o.scid);
    for o in still_open {
        after.send(&History::Opened(o));
    }
    for h in &script()[split..] {
        after.send(h);
    }
    after.close();
    run(&after, rx, &t.store, &lightning()).await;
    assert_eq!(rows(&t.store).await, want().await);
}

#[tokio::test]
async fn a_gap_past_the_peer_s_memory_stores_the_open_set_and_goes_on() {
    let t = temp();
    // The peer keeps two records and the stream two: four opens leave the first two unseen.
    let (peer, rx) = Scripted::new(2, 2);
    for o in opens() {
        peer.send(&History::Opened(o));
    }
    let l = lightning();
    let o = opens();
    tokio::join!(run(&peer, rx, &t.store, &l), async {
        tokio::time::sleep(Duration::from_millis(20)).await;
        peer.send(&closed(&o[0], 800_010, CloseKind::Cooperative, 7));
        tokio::time::sleep(Duration::from_millis(20)).await;
        peer.close();
    });
    let want = {
        let w = temp();
        let mut changes: Vec<Change> = o.iter().map(|o| Change::Opened(open(o))).collect();
        changes.push(change(&closed(&o[0], 800_010, CloseKind::Cooperative, 7)));
        store_ln::apply(&w.store, changes).await.unwrap();
        rows(&w.store).await
    };
    assert_eq!(rows(&t.store).await, want);
    assert_eq!(l.seq.load(Ordering::Relaxed), 5);
}

#[tokio::test]
async fn a_backlog_is_stored_in_bounded_writes_and_kept_until_committed() {
    let t = temp();
    let l = lightning();
    let mut p = Pending::default();
    let records: Vec<Record> = (1..=5_000u64)
        .map(|seq| Record {
            seq,
            change: History::Opened(opened(seq << 40, 1)),
        })
        .collect();
    let (peer, _rx) = Scripted::new(0, 1);
    p.extend(&peer, records, "regtest");
    assert_eq!(p.changes.len(), 5_000);
    p.store_front(&t.store, &l).await.unwrap();
    // One write took the first 2,000 and no more.
    assert_eq!(p.changes.len(), 5_000 - BATCH);
    assert_eq!(l.seq.load(Ordering::Relaxed), BATCH as u64);
    assert_eq!(
        store_ln::opened(&t.store, 5_000).await.unwrap().len(),
        BATCH
    );
    // A write that fails leaves its records pending.
    t.store
        .write(|sql| {
            sql.prepare(
                "CREATE TEMP TRIGGER fail BEFORE INSERT ON ln_channels BEGIN SELECT RAISE(ABORT, 'no'); END",
            )?
            .execute([])?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(p.store_front(&t.store, &l).await.is_err());
    assert_eq!(p.changes.len(), 5_000 - BATCH);
}

#[tokio::test]
async fn at_shutdown_what_is_pending_and_still_on_the_stream_is_stored() {
    let t = temp();
    let l = lightning();
    let (peer, mut rx) = Scripted::new(100, 100);
    let script = script();
    let (first, rest) = script.split_at(6);
    for h in first {
        peer.send(h);
    }
    // The consumer took the first records but was stopped before storing them (as when
    // shutdown wins while a write waits for a full queue).
    let mut p = Pending::default();
    while let Ok(r) = rx.try_recv() {
        p.extend(&peer, vec![r], "regtest");
    }
    // The peer sent the rest before it stopped.
    for h in rest {
        peer.send(h);
    }
    peer.close();
    let deadline = Instant::now() + Duration::from_secs(5);
    flush(&mut rx, &mut p, &t.store, &l, "regtest", deadline).await;
    assert!(p.changes.is_empty());
    assert_eq!(rows(&t.store).await, want().await);
    assert_eq!(l.seq.load(Ordering::Relaxed), 13);
}

#[tokio::test]
async fn the_shutdown_flush_gives_up_at_its_deadline_behind_a_busy_writer() {
    let t = temp();
    let l = lightning();
    let (peer, mut rx) = Scripted::new(100, 100);
    for o in opens() {
        peer.send(&History::Opened(o));
    }
    peer.close();
    // Another write holds the writer for a second.
    let busy = t.store.write(|_| {
        std::thread::sleep(Duration::from_secs(1));
        Ok(())
    });
    let mut p = Pending::default();
    let deadline = Instant::now() + Duration::from_millis(200);
    let flushed = flush(&mut rx, &mut p, &t.store, &l, "regtest", deadline);
    // The busy write is queued first: polled first.
    let (done, ()) = tokio::join!(busy, flushed);
    done.unwrap();
    // It stopped waiting at the deadline, with the records still pending, not stored: one that
    // waited for the busy writer would have stored them.
    assert_eq!(p.changes.len(), 4);
    assert_eq!(l.records.load(Ordering::Relaxed), 0);
}

#[test]
fn error_texts_are_cut_to_one_short_line() {
    let page = "esplora unavailable: 502 Bad Gateway: <html>\r\n<head><title>502</title></head>";
    assert_eq!(short(page), "esplora unavailable: 502 Bad Gateway: <html>");
    let long = "é".repeat(100);
    assert_eq!(short(&long).len(), 120);
    assert_eq!(short(""), "");
}

#[test]
fn short_channel_ids_print_as_lightning_writes_them() {
    assert_eq!(scid_text(A), "800000x5x0");
    assert_eq!(scid_text(B), "800001x1x1");
}

#[test]
fn list_limits_are_strict() {
    let uri = |q: &str| q.parse::<Uri>().unwrap();
    assert_eq!(limit(&uri("/x")), Ok(DEFAULT_LIST));
    assert_eq!(limit(&uri("/x?limit=100")), Ok(100));
    assert_eq!(limit(&uri("/x?limit=1")), Ok(1));
    for bad in [
        "/x?limit=0",
        "/x?limit=101",
        "/x?limit=-1",
        "/x?limit=1e2",
        "/x?limit=",
        "/x?limit=0001",
        "/x?limit=5&limit=6",
        "/x?offset=5",
        "/x?limit=5&x=1",
    ] {
        assert!(limit(&uri(bad)).is_err(), "{bad}");
    }
}

#[tokio::test]
async fn records_sent_while_the_node_was_on_another_chain_are_never_stored() {
    let t = temp();
    let dir = t.dir.join("gated");
    let store = Store::open(
        &dir,
        "regtest",
        Options {
            genesis: Some([1; 32]),
            ..Options::default()
        },
    )
    .unwrap();
    store.set_gate(engine::store::Gate::Open);
    // Room for two on the stream, so what arrives during the hold overflows it.
    let (peer, rx) = Scripted::new(100, 2);
    let l = lightning();
    let wait = || tokio::time::sleep(Duration::from_millis(50));
    tokio::join!(run(&peer, rx, &store, &l), async {
        peer.send(&History::Opened(opened(A, 1)));
        wait().await;
        // Found on another chain: the consumer waits on its next write while more arrive.
        store.set_gate(engine::store::Gate::Held);
        peer.send(&History::Opened(opened(B, 1)));
        wait().await;
        for scid in [C, B + 1, C + 1, B + 2, C + 2] {
            peer.send(&History::Opened(opened(scid, 1)));
        }
        wait().await;
        store.set_gate(engine::store::Gate::Open);
        wait().await;
        peer.send(&History::Opened(opened(D, 1)));
        wait().await;
        peer.close();
    });
    let mut scids: Vec<u64> = rows(&store).await.iter().map(|c| c.open.scid).collect();
    scids.sort_unstable();
    assert_eq!(scids, [A, D]);
}

/// [`Scripted`], whose memory, read once during a hold, sends one more record before the gate
/// reopens: the race between the consumer's discard and the end of the hold.
struct ReopenOnRead<'a> {
    peer: &'a Scripted,
    store: &'a Store,
    late: Mutex<Option<History>>,
}

impl HistorySource for ReopenOnRead<'_> {
    fn recent(&self, after: u64) -> Vec<Record> {
        let kept = self.peer.recent(after);
        if self.store.gate() == engine::store::Gate::Held
            && let Some(h) = self.late.lock().unwrap().take()
        {
            self.peer.send(&h);
            self.store.set_gate(engine::store::Gate::Open);
        }
        kept
    }

    fn open(&self) -> (u64, Vec<Opened>) {
        self.peer.open()
    }
}

#[tokio::test]
async fn a_record_sent_as_the_hold_ends_is_never_stored() {
    let t = temp();
    let store = Arc::new(
        Store::open(
            &t.dir.join("gated"),
            "regtest",
            Options {
                genesis: Some([1; 32]),
                ..Options::default()
            },
        )
        .unwrap(),
    );
    store.set_gate(engine::store::Gate::Open);
    let (peer, mut rx) = Scripted::new(100, 100);
    let src = ReopenOnRead {
        peer: &peer,
        store: &store,
        late: Mutex::new(Some(History::Opened(opened(C, 1)))),
    };
    let l = lightning();
    let wait = || tokio::time::sleep(Duration::from_millis(50));
    let mut p = Pending::default();
    // Each step waits for the one before; one that never comes fails the test, not hangs it.
    let scenario = async {
        tokio::join!(
            consume(&src, &mut rx, &mut p, &store, &l, "regtest"),
            async {
                peer.send(&History::Opened(opened(A, 1)));
                while rows(&store).await.is_empty() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                // The writer is busy, so the next write passes the gate and queues; the node is
                // found on another chain before the writer reaches it, which rejects it while
                // still held.
                let (go, stop) = std::sync::mpsc::channel::<()>();
                let (running, started) = std::sync::mpsc::channel::<()>();
                let busy = tokio::spawn({
                    let s = Arc::clone(&store);
                    async move {
                        s.write(move |_| {
                            running.send(()).ok();
                            stop.recv().ok();
                            Ok(())
                        })
                        .await
                    }
                });
                while started.try_recv().is_err() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                peer.send(&History::Opened(opened(B, 1)));
                while store.queue_depth() == 0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                store.set_gate(engine::store::Gate::Held);
                go.send(()).unwrap();
                busy.await.unwrap().unwrap();
                wait().await;
                peer.send(&History::Opened(opened(D, 1)));
                wait().await;
                peer.close();
            }
        )
    };
    tokio::time::timeout(Duration::from_secs(10), scenario)
        .await
        .expect("a step of the scenario never came");
    let mut scids: Vec<u64> = rows(&store).await.iter().map(|c| c.open.scid).collect();
    scids.sort_unstable();
    assert_eq!(scids, [A, D]);
}

#[tokio::test]
async fn the_totals_at_the_first_sync_stand_in_until_a_newer_snapshot_is_stored() {
    let t = temp();
    let l = lightning();
    let point = |time, channels| Point {
        time,
        samples: 1,
        sums: Stats {
            channels,
            ..Stats::default()
        },
    };
    // Not synced yet: nothing, so the routes say there are no statistics.
    assert_eq!(newest(&l, &t.store).await.unwrap(), None);
    // Synced, before its first ten minutes: the live totals, not a 404 or nulls.
    *l.live.lock().unwrap() = Some(point(1_000_100, 1_065));
    assert_eq!(
        newest(&l, &t.store).await.unwrap(),
        Some(point(1_000_100, 1_065))
    );
    // A snapshot from before this start (a restart after downtime) is older: still the live ones.
    store_ln::insert(&t.store, store_ln::Level::Minute, vec![point(999_600, 900)])
        .await
        .unwrap();
    assert_eq!(
        newest(&l, &t.store).await.unwrap(),
        Some(point(1_000_100, 1_065))
    );
    // The first snapshot since: the stored one.
    store_ln::insert(
        &t.store,
        store_ln::Level::Minute,
        vec![point(1_000_200, 1_066)],
    )
    .await
    .unwrap();
    assert_eq!(
        newest(&l, &t.store).await.unwrap(),
        Some(point(1_000_200, 1_066))
    );
}

/// A node's channels as its operator reads them: sorts, filters, counts, refusals, rank and
/// figures, straight from an index, without a server.
mod operators {
    #![allow(clippy::panic)]

    use super::nodes::{
        ClosedQuery, ClosedSort, OpState, OpenQuery, OpenSort, Text, View, channel_view,
        closed_list, figures, open_list, open_page,
    };
    use super::*;
    use engine::lightning::{
        Announcement, Block, Close, GraphChannel, GraphNode, Index, Kind, Open, Past, Penalty,
        Policy,
    };

    const T: u64 = 1_790_000_000;
    const U: u32 = 1_790_000_000;
    const DAY: u64 = 86_400;

    fn key(n: u8) -> [u8; 33] {
        let mut k = [n; 33];
        k[0] = 3;
        k
    }

    fn pol(fee_rate: u32, enabled: bool, cltv: u16, max_htlc: u64, update: u32) -> Option<Policy> {
        Some(Policy {
            fee_rate,
            base_fee_msat: 1_000,
            cltv_delta: cltv,
            min_htlc_msat: 1_000,
            max_htlc_msat: max_htlc,
            enabled,
            last_update: U + update,
            inbound: None,
        })
    }

    fn sc(n: u64) -> u64 {
        (800_000 + n) << 40
    }

    /// Node 1 with five channels: c1 and c4 with peer 2 ("Bitfinex"), c2 with 3 (markup for a
    /// name), c3 with 4 (no name, no funding time stored), c5 with 6 (announced as node one, no
    /// policies). Peers 2 and 3 share c6. Node 4 has one channel; node 6 none with a policy.
    fn index() -> Index {
        let ch = |n: u64, nodes, capacity, policies| GraphChannel {
            scid: sc(n),
            nodes,
            capacity,
            policies,
        };
        let channels = vec![
            ch(
                1,
                [key(1), key(2)],
                5_000_000,
                [pol(100, true, 40, 1_000_000, 5), pol(10, true, 9, 9, 1)],
            ),
            ch(
                2,
                [key(1), key(3)],
                2_000_000,
                [pol(500, false, 144, 5_000_000, 2), pol(1, true, 9, 9, 9)],
            ),
            ch(
                3,
                [key(1), key(4)],
                2_000_000,
                [None, pol(2_000, true, 9, 9, 3)],
            ),
            ch(
                4,
                [key(1), key(2)],
                1_000_000,
                [pol(100, true, 80, 2_000_000, 4), pol(5, false, 9, 9, 1)],
            ),
            ch(5, [key(6), key(1)], 3_000_000, [None, None]),
            ch(6, [key(2), key(3)], 10_000_000, [None, None]),
        ];
        let named = |n: u8, alias: &str| GraphNode {
            id: key(n),
            announcement: Some(Announcement {
                alias: alias.to_owned(),
                color: [0; 3],
                addresses: Vec::new(),
                features: Vec::new(),
                last_update: U,
            }),
        };
        let nodes = vec![named(2, "Bitfinex"), named(3, "<b>Kraken</b>")];
        let past = Past {
            funded: [1, 2, 4, 5, 6]
                .iter()
                .map(|n| (sc(*n), T + (n - 1) * DAY))
                .collect(),
            ..Past::default()
        };
        Index::build(nodes, channels, &past)
    }

    fn ids(list: &[engine::lightning::Link<'_>]) -> Vec<u64> {
        list.iter()
            .map(|l| (l.channel.scid >> 40) - 800_000)
            .collect()
    }

    fn view(raw: &str) -> Result<View, ApiError> {
        channel_view(Some(raw)).map(|v| v.0)
    }

    fn open(raw: &str) -> OpenQuery {
        match view(raw) {
            Ok(View::Open(q)) => q,
            other => panic!("{raw}: {other:?}"),
        }
    }

    #[test]
    fn every_sort_goes_both_ways_with_missing_figures_last_and_ties_by_id() {
        let i = index();
        let n = i.node(&key(1)).unwrap();
        for (sort, desc, asc) in [
            ("capacity", [1, 5, 2, 3, 4], [4, 2, 3, 5, 1]),
            // Oldest first; c3 has no funding time.
            ("age", [1, 2, 4, 5, 3], [5, 4, 2, 1, 3]),
            ("out", [2, 1, 4, 3, 5], [1, 4, 2, 3, 5]),
            ("in", [3, 1, 4, 2, 5], [2, 4, 1, 3, 5]),
            ("cltv", [2, 4, 1, 3, 5], [1, 4, 2, 3, 5]),
            ("htlc", [2, 4, 1, 3, 5], [1, 4, 2, 3, 5]),
            ("update", [2, 1, 4, 3, 5], [3, 4, 1, 2, 5]),
            ("peer", [1, 4, 2, 5, 3], [3, 5, 2, 1, 4]),
        ] {
            for (dir, want) in [("desc", desc), ("asc", asc)] {
                let q = open(&format!("sort={sort}&dir={dir}"));
                assert_eq!(ids(&open_list(&i, n, &q).0), want, "{sort} {dir}");
            }
        }
        // Without `dir`, each sort's own first direction; the default is today's order.
        assert_eq!(open(""), OpenQuery::default());
        assert!(!open("sort=out").desc);
        assert!(open("sort=age").desc);
    }

    #[test]
    fn filters_combine_and_the_state_counts_follow_the_other_filters() {
        let i = index();
        let n = i.node(&key(1)).unwrap();
        let list = |raw: &str| {
            let (l, counts) = open_list(&i, n, &open(raw));
            (ids(&l), counts)
        };
        // Both ends on, this end off (disabled, or no policy), the peer's off, both off.
        assert_eq!(list(""), (vec![1, 5, 2, 3, 4], [1, 2, 1, 1]));
        assert_eq!(list("state=here"), (vec![2, 3], [1, 2, 1, 1]));
        assert_eq!(list("state=inactive"), (vec![5], [1, 2, 1, 1]));
        // Text: an alias in any case, a key prefix, a channel id in either form, markup as text.
        assert_eq!(list("q=BITF").0, [1, 4]);
        assert_eq!(list("q=030303").0, [2]);
        assert_eq!(list(&format!("q={}", scid_text(sc(3)))).0, [3]);
        assert_eq!(list(&format!("q={}", sc(3))).0, [3]);
        assert_eq!(list("q=%3Cb%3Ekr").0, [2]);
        assert_eq!(list("q=nobody").0, Vec::<u64>::new());
        // One peer, then with a state: counts are within the peer.
        let two = hex(&key(2));
        assert_eq!(list(&format!("peer={two}")), (vec![1, 4], [1, 0, 1, 0]));
        assert_eq!(
            list(&format!("peer={two}&state=peer")),
            (vec![4], [1, 0, 1, 0])
        );
        // A bar of the fee histogram, each way, "no policy" included.
        assert_eq!(list("fee=out:100").0, [1, 4]);
        assert_eq!(list("fee=out:none").0, [5, 3]);
        assert_eq!(list("fee=in:2000").0, [3]);
        assert_eq!(list("fee=in:none").0, [5]);
        assert_eq!(list("fee=in:1&state=here&q=kraken").0, [2]);
        assert_eq!(list("fee=in:1&state=active").0, Vec::<u64>::new());
        // A run of bars, as the page groups them into rows: every rate between, no policy apart.
        assert_eq!(list("fee=out:100-100").0, [1, 4]);
        let priced: Vec<u64> = list("")
            .0
            .into_iter()
            .filter(|c| ![5, 3].contains(c))
            .collect();
        assert_eq!(list("fee=out:0-4294967000").0, priced);
        // A page past the end: empty, with the total.
        let p = open_page(&i, n, &OpenQuery::default(), 4_000);
        assert_eq!(
            (p["total"].clone(), p["channels"].clone()),
            (5.into(), serde_json::json!([]))
        );
        let p = open_page(&i, n, &OpenQuery::default(), 0);
        assert_eq!(
            p["states"],
            serde_json::json!({"active": 1, "here": 2, "peer": 1, "inactive": 1})
        );
        // c5 names node 1 second: its own end is still found.
        let c5 = &p["channels"][1];
        assert_eq!(
            (c5["id"].as_str(), c5["op_state"].as_str()),
            (Some(scid_text(sc(5)).as_str()), Some("inactive"))
        );
        assert_eq!(p["channels"][0]["with_peer"], 2);
        assert_eq!(p["channels"][0]["peer"]["capacity"], 16_000_000);
    }

    #[test]
    fn bad_parameters_are_refused_before_anything_is_read() {
        let long = "a".repeat(67);
        for raw in [
            "sort=fee",
            "sort=capacity&sort=age",
            "dir=up",
            "state=on",
            "state=Active",
            "fee=out:150",
            "fee=out:-1",
            "fee=up:100",
            "fee=out",
            "fee=out:4294967296",
            "fee=out:40-10",
            "fee=out:10-15",
            "fee=out:10-",
            "fee=out:none-10",
            "fee=out:1-2-3",
            "peer=03",
            "q=",
            "q=+++",
            "q=a%07b",
            "q=a%0Ab",
            &format!("q={long}"),
            "q=%FF",
            "x=1",
            "page=4001",
            "status=all",
            "status=closed&state=active",
            "status=closed&fee=in:none",
            "status=closed&sort=age",
            "status=open&kind=force",
            "status=closed&kind=breach",
        ] {
            assert!(view(raw).is_err(), "{raw}");
        }
        // Errors say what was wrong, and nothing about the server.
        assert_eq!(
            view("state=on").unwrap_err(),
            ApiError::bad_request("state is active, here, peer or inactive")
        );
        assert_eq!(
            view("q=a&q=b").unwrap_err(),
            ApiError::bad_request("query parameter given twice")
        );
        assert_eq!(
            view("x=1").unwrap_err(),
            ApiError::bad_request("unknown query parameter")
        );
        // Text is trimmed and up to 66 characters, any script.
        assert!(view(&format!("q={}", "é".repeat(66))).is_ok());
        assert_eq!(
            view("status=closed&sort=lived&dir=asc&kind=penalty"),
            Ok(View::Closed(ClosedQuery {
                sort: ClosedSort::Lived,
                desc: false,
                text: None,
                peer: None,
                kind: Some(Kind::Penalty),
            }))
        );
        assert_eq!(open("sort=peer&dir=asc").sort, OpenSort::Peer);
        assert_eq!(open("state=peer").state, Some(OpState::Peer));
        assert_eq!(open("q=+Bit+").text, Text::parse("bit").ok());
    }

    fn closed(
        scid: u64,
        peer: u8,
        capacity: u64,
        height: u32,
        kind: Kind,
        fee: Option<u64>,
    ) -> Channel {
        let block = |height: u32, time: u64| Block {
            height,
            hash: bitcoin::BlockHash::from_byte_array([1; 32]),
            time,
        };
        Channel {
            open: Open {
                scid,
                node_one: key(1),
                node_two: key(peer),
                capacity,
                block: block(u32::try_from(scid >> 40).unwrap(), T),
            },
            close: Some(Close {
                block: block(height, T + u64::from(height - 800_000) * DAY),
                txid: Txid::from_byte_array([9; 32]),
                kind,
                fee,
            }),
            penalty: None,
            funding_txid: None,
        }
    }

    #[test]
    fn closed_channels_sort_and_filter_with_ties_newest_first() {
        let i = index();
        let mut breach = closed(sc(13), 4, 300, 800_050, Kind::Force, None);
        breach.penalty = Some(Penalty {
            block: breach.close.unwrap().block,
            txid: Txid::from_byte_array([8; 32]),
        });
        // Newest close first, as the store reads them.
        let rows = vec![
            closed(sc(12), 3, 200, 800_060, Kind::Force, Some(50)),
            breach,
            closed(sc(14), 2, 500, 800_050, Kind::Other, Some(900)),
            closed(sc(11), 2, 200, 800_040, Kind::Cooperative, Some(50)),
        ];
        let q = |raw: &str| match view(&format!("status=closed&{raw}")) {
            Ok(View::Closed(q)) => q,
            other => panic!("{raw}: {other:?}"),
        };
        let list = |raw: &str| -> Vec<u64> {
            closed_list(&i, &key(1), rows.clone(), &q(raw))
                .iter()
                .map(|c| (c.open.scid >> 40) - 800_000)
                .collect()
        };
        assert_eq!(list("page=0"), [12, 14, 13, 11]);
        assert_eq!(list("dir=asc"), [11, 14, 13, 12]);
        assert_eq!(list("sort=capacity"), [14, 13, 12, 11]);
        assert_eq!(list("sort=capacity&dir=asc"), [12, 11, 13, 14]);
        // No fee known: last either way.
        assert_eq!(list("sort=fee"), [14, 12, 11, 13]);
        assert_eq!(list("sort=fee&dir=asc"), [12, 11, 14, 13]);
        assert_eq!(list("sort=lived"), [12, 14, 13, 11]);
        assert_eq!(list("sort=lived&dir=asc"), [11, 14, 13, 12]);
        // A breach is a penalty, whatever its close looked like.
        assert_eq!(list("kind=penalty"), [13]);
        assert_eq!(list("kind=force"), [12]);
        assert_eq!(list(&format!("peer={}", hex(&key(2)))), [14, 11]);
        assert_eq!(list(&format!("peer={}&kind=other", hex(&key(2)))), [14]);
        assert_eq!(list("q=bitfinex"), [14, 11]);
        assert_eq!(list("q=030404"), [13]);
        assert_eq!(list(&format!("q={}", scid_text(sc(12)))), [12]);
    }

    #[test]
    fn rank_and_figures_for_a_large_node_one_channel_and_no_policies() {
        let i = index();
        let rank = |n: u8| i.node(&key(n)).unwrap().rank;
        // Capacity: 2 16M, 3 12M, 1 13M; channels: 1 five, 2 three, 3 two.
        assert_eq!(rank(2), [1, 2]);
        assert_eq!(rank(1), [2, 1]);
        assert_eq!(rank(3), [3, 3]);
        assert_eq!(rank(6), [4, 4]);
        assert_eq!(rank(4), [5, 5]);
        let f = |n: u8| figures(&i, i.node(&key(n)).unwrap());
        let one = f(1);
        assert_eq!(
            one["capacity"],
            serde_json::json!({"median": 2_000_000, "smallest": 1_000_000, "largest": 5_000_000})
        );
        assert_eq!(
            one["funded"],
            serde_json::json!({"median": T + DAY, "oldest": T, "youngest": T + 4 * DAY})
        );
        assert_eq!(
            one["states"],
            serde_json::json!({"active": 1, "here": 2, "peer": 1, "inactive": 1})
        );
        // 100 on 5M and 1M, 500 on 2M: (500M + 100M + 1,000M) / 8M = 200.
        assert_eq!(
            one["fee_rates"]["outgoing"],
            serde_json::json!({"median": 100, "weighted": 200, "lowest": 100, "highest": 500, "policies": 3})
        );
        assert_eq!(one["fee_rates"]["incoming"]["policies"], 4);
        // The newest policy either way over its channels: its peer's on c2.
        assert_eq!(one["last_policy_update"], U + 9);
        assert_eq!(f(4)["last_policy_update"], U + 3);
        // One channel, no funding time stored, and no policy toward it.
        let four = f(4);
        assert_eq!(
            four["capacity"],
            serde_json::json!({"median": 2_000_000, "smallest": 2_000_000, "largest": 2_000_000})
        );
        assert_eq!(
            four["funded"],
            serde_json::json!({"median": null, "oldest": null, "youngest": null})
        );
        assert_eq!(
            four["fee_rates"]["outgoing"],
            serde_json::json!({"median": 2_000, "weighted": 2_000, "lowest": 2_000, "highest": 2_000, "policies": 1})
        );
        let none = serde_json::json!({"median": null, "weighted": null, "lowest": null, "highest": null, "policies": 0});
        assert_eq!(four["fee_rates"]["incoming"], none);
        // No policies at all.
        let six = f(6);
        assert_eq!(
            six["fee_rates"],
            serde_json::json!({"outgoing": none, "incoming": none})
        );
        assert_eq!(
            six["states"],
            serde_json::json!({"active": 0, "here": 0, "peer": 0, "inactive": 1})
        );
        assert_eq!(six["last_policy_update"], serde_json::Value::Null);
    }
}
