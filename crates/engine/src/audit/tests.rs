#![allow(clippy::unwrap_used, clippy::indexing_slicing)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use bitcoin::hashes::Hash;

use super::*;
use crate::projected::{BlockSummary, Placed};
use crate::store::{Options, Store, params};

fn txid(n: u32) -> Txid {
    let mut b = [0u8; 32];
    b[..4].copy_from_slice(&n.to_le_bytes());
    Txid::from_byte_array(b)
}

/// An expected block of `(n, rate in sat/kvB, vsize)`, in mining order.
fn expected(txs: &[(u32, u32, u32)]) -> ProjectedBlock {
    let txs: Vec<(Txid, Placed)> = txs
        .iter()
        .map(|&(n, rate, vsize)| {
            let fee = u64::from(rate) * u64::from(vsize) / 1000;
            (
                txid(n),
                Placed {
                    block: 0,
                    rate,
                    vsize,
                    fee,
                    flags: 0,
                },
            )
        })
        .collect();
    let summary = BlockSummary {
        txs: u32::try_from(txs.len()).unwrap(),
        weight: txs.iter().map(|(_, p)| u64::from(p.vsize) * 4).sum(),
        vsize: txs.iter().map(|(_, p)| u64::from(p.vsize)).sum(),
        fees: txs.iter().map(|(_, p)| p.fee).sum(),
        ..BlockSummary::default()
    };
    ProjectedBlock { summary, txs }
}

/// Mined transactions of `(n, rate in sat/kvB, vsize)`.
fn mined(txs: &[(u32, u32, u32)]) -> Vec<Mined> {
    txs.iter()
        .map(|&(n, rate, vsize)| Mined {
            txid: txid(n),
            fee: u64::from(rate) * u64::from(vsize) / 1000,
            vsize,
            weight: vsize * 4,
        })
        .collect()
}

const SEEN_AT: u32 = 1_800_000_000;
const OLD: u32 = SEEN_AT - 3600;

/// Ten 1,000 vB transactions fill a block in these tests.
const ROOM: u64 = 40_000;

/// `left` gets each transaction's own rate, as if every chunk held one transaction.
fn run(
    e: &ProjectedBlock,
    left: &[u32],
    m: &[Mined],
    times: &[(u32, u32)],
) -> (Totals, Vec<AuditTx>) {
    let own = |n: u32| {
        let id = txid(n);
        e.txs
            .iter()
            .find(|(t, _)| *t == id)
            .map(|(_, p)| p.rate)
            .or_else(|| {
                m.iter()
                    .find(|x| x.txid == id)
                    .map(|x| u32::try_from(x.fee * 1000 / u64::from(x.vsize)).unwrap())
            })
            .unwrap()
    };
    let left: Vec<(Txid, u32)> = left.iter().map(|n| (txid(*n), own(*n))).collect();
    run_with(e, left, m, ROOM, times)
}

fn run_with(
    e: &ProjectedBlock,
    mut left: Vec<(Txid, u32)>,
    m: &[Mined],
    room: u64,
    times: &[(u32, u32)],
) -> (Totals, Vec<AuditTx>) {
    left.sort_unstable();
    let times: HashMap<Txid, u32> = times.iter().map(|&(n, t)| (txid(n), t)).collect();
    let weights: HashMap<Txid, u32> = e.txs.iter().map(|(t, p)| (*t, p.vsize * 4)).collect();
    compare(e, &left, m, room, SEEN_AT, |t| {
        Some((
            times.get(t).copied().unwrap_or(OLD),
            weights.get(t).copied()?,
        ))
    })
}

fn kinds(txs: &[AuditTx]) -> Vec<(u32, Kind)> {
    let mut v: Vec<_> = txs
        .iter()
        .map(|t| {
            let b = t.txid.as_byte_array();
            (u32::from_le_bytes([b[0], b[1], b[2], b[3]]), t.kind)
        })
        .collect();
    v.sort_unstable_by_key(|x| x.0);
    v
}

/// A block of ten transactions, rates 10,000 down to 1,000 sat/kvB, 1,000 vB each.
fn ten() -> Vec<(u32, u32, u32)> {
    (1..=10).map(|n| (n, 11_000 - n * 1000, 1000)).collect()
}

#[test]
fn a_perfect_match_scores_100() {
    let e = expected(&ten());
    let ids: Vec<u32> = (1..=10).collect();
    let (t, txs) = run(&e, &ids, &mined(&ten()), &[]);
    assert_eq!(t.match_rate, 100.0);
    assert_eq!(
        t.matched,
        Tally {
            txs: 10,
            vsize: 10_000
        }
    );
    assert!(txs.is_empty());
    assert_eq!(t.expected, t.actual);
    assert_eq!(t.listed(), 0);
}

#[test]
fn leaving_out_the_cheapest_lowers_the_score_by_their_share() {
    let e = expected(&ten());
    let m = mined(&ten()[..8]);
    let (t, txs) = run(&e, &[1, 2, 3, 4, 5, 6, 7, 8], &m, &[]);
    assert_eq!(
        t.missing,
        Tally {
            txs: 2,
            vsize: 2000
        }
    );
    assert_eq!(t.match_rate, 80.0);
    assert_eq!(kinds(&txs), vec![(9, Kind::Missing), (10, Kind::Missing)]);
    assert_eq!(t.actual.fees, t.expected.fees - 3000);
}

#[test]
fn unseen_transactions_paying_more_displace_but_cheaper_ones_do_not() {
    let e = expected(&ten());
    // The two cheapest were left for two we never saw: one paying more than both, one less.
    let mut m = ten()[..8].to_vec();
    m.push((100, 50_000, 1000));
    m.push((101, 500, 1000));
    let (t, txs) = run(&e, &(1..=8).collect::<Vec<_>>(), &mined(&m), &[]);
    assert_eq!(
        t.unseen,
        Tally {
            txs: 2,
            vsize: 2000
        }
    );
    // The higher-rate one goes first and uses the only room that pays enough.
    assert_eq!(
        t.displaced,
        Tally {
            txs: 1,
            vsize: 1000
        }
    );
    assert_eq!(
        t.missing,
        Tally {
            txs: 1,
            vsize: 1000
        }
    );
    assert_eq!(t.match_rate, 90.0);
    assert_eq!(
        kinds(&txs),
        vec![
            (9, Kind::Displaced),
            (10, Kind::Missing),
            (100, Kind::Unseen),
            (101, Kind::Unseen)
        ]
    );
    // The most telling first.
    assert_eq!(txs[0].kind, Kind::Missing);
}

#[test]
fn an_addition_excuses_nothing_when_both_would_have_fitted() {
    // One old 100,000 vB transaction at 1 sat/vB left out for 100 vB at 10 sat/vB, in a block
    // with room for both.
    let e = expected(&[(1, 1000, 100_000)]);
    let (t, txs) = run_with(&e, vec![], &mined(&[(2, 10_000, 100)]), BLOCK_WEIGHT, &[]);
    assert_eq!(
        t.missing,
        Tally {
            txs: 1,
            vsize: 100_000
        }
    );
    assert_eq!(t.displaced, Tally::default());
    assert_eq!(t.match_rate, 0.0);
    assert_eq!(kinds(&txs), vec![(1, Kind::Missing), (2, Kind::Unseen)]);
}

#[test]
fn room_is_counted_in_weight_not_sigop_adjusted_size() {
    // Two left-out transactions of 5,000 vB on the chain whose sigops make them 50,000 vB for
    // mining, and 100,000 vB we did not expect paying more, in a block of 950,000 vB: both would
    // have fitted, so neither is excused.
    let mut ours: Vec<(u32, u32, u32)> = (1..=85).map(|n| (n, 5000, 10_000)).collect();
    ours.extend([(90, 1000, 50_000), (91, 1000, 50_000)]);
    let e = expected(&ours);
    let mut m = mined(&ours[..85]);
    m.extend(mined(&[(99, 9000, 100_000)]));
    let left: Vec<(Txid, u32)> = (1..=85).map(|n| (txid(n), 5000)).collect();
    let mut left = left;
    left.sort_unstable();
    let (t, _) = compare(&e, &left, &m, BLOCK_WEIGHT, SEEN_AT, |t| {
        (*t == txid(90) || *t == txid(91)).then_some((OLD, 20_000))
    });
    assert_eq!((t.displaced.txs, t.missing.txs), (0, 2));
    // One of them gone from the tracker since: its weight is unknown, so it adds no overflow
    // that could excuse the other.
    let (t, _) = compare(&e, &left, &m, BLOCK_WEIGHT, SEEN_AT, |t| {
        (*t == txid(91)).then_some((OLD, 20_000))
    });
    assert_eq!((t.displaced.txs, t.missing.txs), (0, 2));
}

#[test]
fn only_whole_transactions_are_displaced() {
    // A full block: 9 of ours, then 500 vB we did not expect at a higher rate in place of our
    // last, which is 1,000 vB. It would not have fitted whole, and half of it is not excused.
    let mut m = ten()[..9].to_vec();
    m.push((50, 20_000, 500));
    let (t, _) = run(&e10(), &(1..=9).collect::<Vec<_>>(), &mined(&m), &[]);
    assert_eq!((t.displaced.txs, t.missing.txs), (0, 1));
}

fn e10() -> ProjectedBlock {
    expected(&ten())
}

#[test]
fn a_package_we_placed_counts_at_its_chunk_rate() {
    // Ten 100 vB transactions at 10 sat/vB fill the block's last 1,000 vB in our projection; the
    // miner took a 900 vB parent paying 1 sat/vB with a 100 vB child paying 91, which our node
    // had as one chunk at 10 sat/vB for a later block. Same space, same pay.
    let ours: Vec<(u32, u32, u32)> = (1..=10).map(|n| (n, 10_000, 100)).collect();
    let e = expected(&ours);
    let m = mined(&[(20, 1000, 900), (21, 91_000, 100)]);
    let left = vec![(txid(20), 10_000), (txid(21), 10_000)];
    let (t, txs) = run_with(&e, left, &m, 4000, &[]);
    assert_eq!(
        t.added,
        Tally {
            txs: 2,
            vsize: 1000
        }
    );
    assert_eq!(
        t.displaced,
        Tally {
            txs: 10,
            vsize: 1000
        }
    );
    assert_eq!(t.match_rate, 100.0);
    assert!(
        txs.iter()
            .filter(|x| x.kind == Kind::Added)
            .all(|x| x.rate == 10_000)
    );
}

#[test]
fn a_tie_at_the_boundary_is_not_held_against_the_miner() {
    // Our last two and two we placed in the next block all pay 1,000 sat/kvB; the miner took
    // the other two.
    let mut ours = ten()[..8].to_vec();
    ours.extend([(9, 1000, 1000), (10, 1000, 1000)]);
    let e = expected(&ours);
    let mut m = ours[..8].to_vec();
    m.extend([(20, 1000, 1000), (21, 1000, 1000)]);
    let left: Vec<u32> = (1..=8).chain([20, 21]).collect();
    let (t, txs) = run(&e, &left, &mined(&m), &[]);
    assert_eq!(
        t.added,
        Tally {
            txs: 2,
            vsize: 2000
        }
    );
    assert_eq!(
        t.displaced,
        Tally {
            txs: 2,
            vsize: 2000
        }
    );
    assert_eq!(t.missing, Tally::default());
    assert_eq!(t.match_rate, 100.0);
    assert!(kinds(&txs).contains(&(20, Kind::Added)));
}

#[test]
fn transactions_seconds_old_are_excused_and_leave_the_score() {
    let e = expected(&ten());
    let m = mined(&ten()[..8]);
    // 9 arrived 5 s before the block; 10 a minute and a half before.
    let (t, txs) = run(
        &e,
        &(1..=8).collect::<Vec<_>>(),
        &m,
        &[(9, SEEN_AT - 5), (10, SEEN_AT - 90)],
    );
    assert_eq!(
        t.fresh,
        Tally {
            txs: 1,
            vsize: 1000
        }
    );
    assert_eq!(
        t.missing,
        Tally {
            txs: 1,
            vsize: 1000
        }
    );
    // 1,000 of the 9,000 vB that could count.
    assert_eq!(t.match_rate, 88.88);
    let fresh = txs.iter().find(|x| x.kind == Kind::Fresh).unwrap();
    assert_eq!(fresh.first_seen, Some(SEEN_AT - 5));
    // Exactly at the threshold it counts.
    let (t, _) = run(
        &e,
        &(1..=8).collect::<Vec<_>>(),
        &m,
        &[(9, SEEN_AT - RECENT_SECS)],
    );
    assert_eq!(t.fresh.txs, 0);
    // An accept time after the block is a newer record (evicted and sent again): not fresh.
    let (t, _) = run(&e, &(1..=8).collect::<Vec<_>>(), &m, &[(9, SEEN_AT + 1)]);
    assert_eq!(t.fresh.txs, 0);
}

#[test]
fn a_transaction_the_block_conflicted_with_is_excused() {
    let e = expected(&ten());
    // 10 left our mempool with the block without being in it: a double spend of its input.
    let mut m = ten()[..9].to_vec();
    m.push((50, 1000, 1000));
    let left: Vec<u32> = (1..=10).collect();
    let (t, txs) = run(&e, &left, &mined(&m), &[]);
    assert_eq!(
        t.conflicted,
        Tally {
            txs: 1,
            vsize: 1000
        }
    );
    assert_eq!(t.unseen.txs, 1);
    assert_eq!(t.match_rate, 100.0);
    assert!(kinds(&txs).contains(&(10, Kind::Conflicted)));
}

#[test]
fn an_empty_block_against_a_full_expectation_scores_0() {
    let e = expected(&ten());
    let (t, txs) = run(&e, &[], &[], &[]);
    assert_eq!(t.match_rate, 0.0);
    assert_eq!(
        t.missing,
        Tally {
            txs: 10,
            vsize: 10_000
        }
    );
    assert_eq!(t.actual, Side::default());
    assert_eq!(txs.len(), 10);
    // Highest rate first among the missing.
    assert_eq!(txs[0].rate, 10_000);
}

#[test]
fn a_full_block_against_an_empty_expectation_scores_100() {
    let e = ProjectedBlock::default();
    let m = mined(&ten());
    let (t, txs) = run(&e, &[1, 2, 3], &m, &[]);
    assert_eq!(t.match_rate, 100.0);
    assert_eq!(
        t.added,
        Tally {
            txs: 3,
            vsize: 3000
        }
    );
    assert_eq!(
        t.unseen,
        Tally {
            txs: 7,
            vsize: 7000
        }
    );
    assert_eq!(txs.len(), 10);
    assert_eq!(t.actual.txs, 10);
}

#[test]
fn every_fresh_or_conflicted_still_scores_100() {
    let e = expected(&ten()[..2]);
    let (t, _) = run(&e, &[1], &[], &[(2, SEEN_AT)]);
    assert_eq!((t.conflicted.txs, t.fresh.txs), (1, 1));
    assert_eq!(t.match_rate, 100.0);
}

#[test]
fn the_score_rounds_down_so_100_means_nothing_missing() {
    let mut big: Vec<(u32, u32, u32)> = (1..=9999).map(|n| (n, 5000, 100)).collect();
    big.push((10_000, 1000, 1));
    let e = expected(&big);
    let m = mined(&big[..9999]);
    let left: Vec<u32> = (1..=9999).collect();
    let (t, _) = run(&e, &left, &m, &[]);
    assert_eq!(t.missing.txs, 1);
    assert_eq!(t.match_rate, 99.99);
}

#[test]
fn lists_are_capped_and_records_round_trip() {
    let many: Vec<(u32, u32, u32)> = (1..=1500).map(|n| (n, 2000 + n, 100)).collect();
    let e = expected(&many);
    let (t, txs) = run(&e, &[], &[], &[(7, SEEN_AT)]);
    assert_eq!(t.listed(), 1500);
    assert_eq!(txs.len(), MAX_TXS);
    // Missing before fresh, highest rate first.
    assert_eq!(txs[0].rate, 3500);
    assert!(txs.iter().all(|x| x.kind == Kind::Missing));
    let bytes = encode(&txs);
    assert_eq!(bytes.len(), MAX_TXS * RECORD);
    assert_eq!(decode(&bytes).unwrap(), txs);
    assert!(decode(&bytes[1..]).is_none());
    let mut bad = bytes.clone();
    bad[32] = 0;
    assert!(decode(&bad).is_none());
}

struct Temp(std::path::PathBuf, Store);

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp() -> Temp {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "rbitcoin-space-audit-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let store = Store::open(&dir, "regtest", Options::default()).unwrap();
    Temp(dir, store)
}

fn hash(n: u8) -> BlockHash {
    BlockHash::from_byte_array([n; 32])
}

async fn block_row(store: &Store, height: u32, h: BlockHash) {
    store
        .write(move |sql| {
            sql.prepare(
                "INSERT OR REPLACE INTO blocks (height, hash, time, tx_count, size, weight, \
                 paying_weight, fees, subsidy, reward, difficulty, coinbase_tag, payouts) \
                 VALUES (?1, ?2, ?3, 1, 1, 1, 1, 0, 0, 0, 1.0, x'', x'')",
            )?
            .execute(params![height, &h.as_byte_array()[..], 1000 + height])?;
            Ok(())
        })
        .await
        .unwrap();
}

fn audit(height: u32, h: BlockHash, rate: f64) -> Audit {
    let e = expected(&ten());
    let (mut totals, txs) = run(&e, &[], &mined(&ten()[..5]), &[]);
    totals.match_rate = rate;
    Audit {
        id: h,
        height,
        time: 1000 + height,
        seen_at: SEEN_AT,
        totals,
        txs,
    }
}

#[tokio::test]
async fn stored_audits_read_back_and_a_reorged_block_leaves_the_pages() {
    let t = temp();
    let s = &t.1;
    for h in 1..=3u8 {
        block_row(s, u32::from(h), hash(h)).await;
        assert!(
            write(s, audit(u32::from(h), hash(h), f64::from(h)))
                .await
                .unwrap()
        );
    }
    // The first audit stands.
    assert!(!write(s, audit(1, hash(1), 55.0)).await.unwrap());
    let a = by_hash(s, hash(2)).await.unwrap().unwrap();
    assert_eq!(a, audit(2, hash(2), 2.0));
    assert_eq!(a.txs.len(), 5);
    let rows = by_hashes(s, vec![hash(3), hash(9)]).await.unwrap();
    assert_eq!(rows[0].as_ref().unwrap().totals.match_rate, 3.0);
    assert!(rows[0].as_ref().unwrap().txs.is_empty());
    assert!(rows[1].is_none());
    let page = scored_between(s, 0, 10).await.unwrap();
    assert_eq!(
        page.iter().map(|x| x.height).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(
        page[0].expected_fees,
        audit(1, hash(1), 1.0).totals.expected.fees
    );

    // Block 2 is replaced by another: its audit is kept by hash but leaves every page.
    block_row(s, 2, hash(20)).await;
    let page = scored_between(s, 0, 10).await.unwrap();
    assert_eq!(
        page.iter().map(|x| x.height).collect::<Vec<_>>(),
        vec![1, 3]
    );
    assert_eq!(scored_since(s, 1003).await.unwrap().len(), 1);
    assert!(by_hash(s, hash(2)).await.unwrap().is_some());
}

async fn set_pool(store: &Store, height: u32, pool: u16) {
    store
        .write(move |sql| {
            sql.prepare("UPDATE blocks SET pool = ?2 WHERE height = ?1")?
                .execute(params![height, pool])?;
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn a_pool_s_health_averages_only_its_audited_best_chain_blocks() {
    let t = temp();
    let s = &t.1;
    // None audited yet: no pool has a figure.
    for h in 1..=6u8 {
        block_row(s, u32::from(h), hash(h)).await;
        set_pool(s, u32::from(h), if h % 2 == 0 { 7 } else { 9 }).await;
    }
    assert_eq!(pool_health(s, 0, 10).await.unwrap(), vec![]);
    // Pool 7 mined 2, 4 and 6, three audited; pool 9 mined 1, 3 and 5, only 3 audited.
    for (h, rate) in [(2u8, 99.5), (4, 98.0), (6, 96.5), (3, 90.25)] {
        assert!(write(s, audit(u32::from(h), hash(h), rate)).await.unwrap());
    }
    let health = |pool, audited, match_rate| PoolHealth {
        pool,
        audited,
        match_rate,
    };
    assert_eq!(
        pool_health(s, 0, 10).await.unwrap(),
        vec![health(7, 3, 98.0), health(9, 1, 90.25)]
    );
    // A range counts only its own heights.
    assert_eq!(
        pool_health(s, 4, 5).await.unwrap(),
        vec![health(7, 1, 98.0)]
    );
    // A reorg replaces block 6 with another pool's: its audit counts for nobody now.
    block_row(s, 6, hash(60)).await;
    set_pool(s, 6, 9).await;
    assert_eq!(
        pool_health(s, 0, 10).await.unwrap(),
        vec![health(7, 2, 98.75), health(9, 1, 90.25)]
    );
}
