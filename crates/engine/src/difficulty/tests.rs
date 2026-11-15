#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::BTreeMap;

use bitcoin::block::Header;
use bitcoin::consensus::encode::deserialize_hex;
use bitcoin::params::{MAINNET, REGTEST, SIGNET, TESTNET4};

use super::*;

/// Mainnet's minimum difficulty, also testnet4's.
const LIMIT: u32 = 0x1d00_ffff;
/// A mainnet target from 2026, about 1.48e14 difficulty.
const BITS: u32 = 0x1702_32ac;
const T0: u64 = 1_790_000_000;
const NOW_MS: u64 = 1_800_000_000_000;

fn bits(b: u32) -> CompactTarget {
    CompactTarget::from_consensus(b)
}

fn block(height: u32, time: u64, b: u32) -> Block {
    Block {
        height,
        time,
        bits: bits(b),
    }
}

/// The period starting at `start` (a multiple of 2016) with the tip `mined` blocks after its
/// first, mined at `pace` seconds each, and the previous period at `previous_bits`.
fn period(
    params: &'static Params,
    start: u32,
    mined: u32,
    pace: u64,
    b: u32,
    previous_bits: u32,
) -> Period {
    let first = block(start, T0, b);
    let previous = start
        .checked_sub(INTERVAL)
        .map(|h| block(h, T0 - 1_209_600, previous_bits));
    Period::new(
        params,
        start + mined,
        T0 + u64::from(mined) * pace,
        first,
        previous,
    )
    .unwrap()
}

fn difficulty(b: u32) -> f64 {
    Target::from_compact(bits(b)).difficulty_float()
}

/// The percent change from `from` to `to`, read from the bits the way the API reports it.
fn change(from: u32, to: u32) -> f64 {
    (difficulty(to) / difficulty(from) - 1.0) * 100.0
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn mid_period() {
    // 1000 blocks after the first, at 540 s: faster than 600, so difficulty goes up.
    let e = period(&MAINNET, 2016 * 480, 1000, 540, BITS, BITS).estimate(NOW_MS);
    assert!(close(e.progress_percent, 1000.0 / 2016.0 * 100.0));
    assert_eq!(e.remaining_blocks, 1016);
    assert_eq!(e.next_retarget_height, 2016 * 481);
    assert_eq!(e.time_avg_ms, 540_000);
    assert_eq!(e.remaining_ms, 1016 * 540_000);
    assert_eq!(e.previous_time, T0);
    assert_eq!(e.previous_retarget, 0.0);
    // The tip is in the past at NOW_MS, so the rest of the period is projected from now.
    assert_eq!(e.estimated_retarget_ms, NOW_MS + 1016 * 540_000);
    let last = NOW_MS / 1000 + 1015 * 540;
    let expected = next_bits(&MAINNET, bits(BITS), (last - T0) as i64).unwrap();
    assert!(close(
        e.difficulty_change,
        change(BITS, expected.to_consensus())
    ));
    assert!(close(
        e.expected_blocks,
        (NOW_MS / 1000 - T0) as f64 / 600.0
    ));
}

#[test]
fn a_tip_ahead_of_the_clock_moves_the_timespan_not_the_date() {
    // Testnet4 tips often carry timestamps hours ahead of wall-clock time (up to two hours is
    // valid). The retarget measures those timestamps, so the projection starts from the tip;
    // the estimated date is still wall-clock.
    let p = period(&TESTNET4, 0, 10, 600, LIMIT, LIMIT);
    let now = T0 + 6000 - 3600;
    let e = p.estimate(now * 1000);
    assert_eq!(e.estimated_retarget_ms, now * 1000 + 2006 * 600_000);
    let at_tip = p.estimate((T0 + 6000) * 1000);
    assert_eq!(e.difficulty_change, at_tip.difficulty_change);
    assert!(e.expected_blocks < 5.0);
}

#[test]
fn first_block_of_a_period_shows_the_off_by_one() {
    // The tip is the first block: nothing measured yet, so the pace is the target spacing.
    // Even at exactly 600 s a block the retarget measures 2015 intervals against two weeks, so
    // difficulty would still rise by 1209600 / 1209000.
    let p = period(&MAINNET, 2016 * 400, 0, 600, BITS, BITS);
    let e = p.estimate(T0 * 1000);
    assert_eq!(e.progress_percent, 0.0);
    assert_eq!(e.remaining_blocks, 2016);
    assert_eq!(e.time_avg_ms, 600_000);
    assert_eq!(e.remaining_ms, 2016 * 600_000);
    let expected = next_bits(&MAINNET, bits(BITS), 2015 * 600).unwrap();
    assert!(close(
        e.difficulty_change,
        change(BITS, expected.to_consensus())
    ));
    assert!((e.difficulty_change - (1_209_600.0 / 1_209_000.0 - 1.0) * 100.0).abs() < 1e-3);
    assert!(e.difficulty_change > 0.0);
}

#[test]
fn block_after_an_adjustment_reports_the_adjustment() {
    // The first period's adjustment raised difficulty from LIMIT to BITS.
    let e = period(&MAINNET, 2016, 1, 600, BITS, LIMIT).estimate(NOW_MS);
    assert_eq!(e.remaining_blocks, 2015);
    assert!(close(e.previous_retarget, change(LIMIT, BITS)));
    assert!(e.previous_retarget > 1e10);
    // The first period has no previous adjustment.
    let first = period(&MAINNET, 0, 1, 600, LIMIT, LIMIT).estimate(NOW_MS);
    assert_eq!(first.previous_retarget, 0.0);
}

#[test]
fn last_block_of_a_period_is_exact() {
    // The tip is the period's last block: the timespan is known, the clock plays no part.
    let p = period(&MAINNET, 2016 * 300, 2015, 610, BITS, BITS);
    let a = p.estimate(NOW_MS);
    let b = p.estimate(NOW_MS + 3_600_000);
    assert_eq!(a.difficulty_change, b.difficulty_change);
    assert_eq!(a.remaining_blocks, 1);
    let expected = next_bits(&MAINNET, bits(BITS), 2015 * 610).unwrap();
    assert!(close(
        a.difficulty_change,
        change(BITS, expected.to_consensus())
    ));
    assert!(a.difficulty_change < 0.0);
}

#[test]
fn clamped_at_four_times_either_way() {
    // Very fast: 60 s blocks would be a tenfold rise; consensus allows fourfold.
    let fast = period(&MAINNET, 2016 * 300, 2015, 60, BITS, BITS).estimate(NOW_MS);
    assert!((fast.difficulty_change - 300.0).abs() < 1e-3, "{fast:?}");
    // Very slow: 6000 s blocks would be a tenfold drop; consensus allows a quarter.
    let slow = period(&MAINNET, 2016 * 300, 2015, 6000, BITS, BITS).estimate(NOW_MS);
    assert!((slow.difficulty_change + 75.0).abs() < 1e-3, "{slow:?}");
    // Exactly at the clamp edges.
    let span = 1_209_600i64;
    assert_eq!(
        next_bits(&MAINNET, bits(BITS), span / 4),
        next_bits(&MAINNET, bits(BITS), 1)
    );
    assert_eq!(
        next_bits(&MAINNET, bits(BITS), span * 4),
        next_bits(&MAINNET, bits(BITS), i64::MAX)
    );
    // Timestamps out of order give a negative span: the lower clamp, never a panic.
    assert_eq!(
        next_bits(&MAINNET, bits(BITS), -5),
        next_bits(&MAINNET, bits(BITS), span / 4)
    );
}

#[test]
fn never_below_minimum_difficulty() {
    // At the minimum, a slow period cannot lower difficulty further.
    let e = period(&MAINNET, 2016 * 5, 2015, 1200, LIMIT, LIMIT).estimate(NOW_MS);
    assert_eq!(e.difficulty_change, 0.0);
    assert_eq!(
        next_bits(&MAINNET, bits(LIMIT), 4 * 1_209_600),
        Some(bits(LIMIT))
    );
    // At difficulty 2, a fourfold drop is cut to a halving.
    let two = 0x1c7f_ff80;
    assert!((difficulty(two) - 2.0).abs() < 1e-3);
    let e = period(&MAINNET, 2016 * 5, 2015, 6000, two, two).estimate(NOW_MS);
    assert!((e.difficulty_change + 50.0).abs() < 0.01, "{e:?}");
    // Signet has its own, lower limit.
    let signet = 0x1e03_77ae;
    assert_eq!(
        next_bits(&SIGNET, bits(signet), 4 * 1_209_600),
        Some(bits(signet))
    );
    assert_eq!(next_bits(&MAINNET, bits(signet), 600), None);
}

#[test]
fn very_fast_and_very_slow_periods_mid_way() {
    // Half way through at 30 s a block: the projection hits the fourfold clamp.
    let fast = period(&MAINNET, 2016 * 7, 1008, 30, BITS, BITS).estimate(T0 * 1000 + 1008 * 30_000);
    assert!((fast.difficulty_change - 300.0).abs() < 1e-3);
    assert_eq!(fast.time_avg_ms, 30_000);
    assert!(fast.expected_blocks < 51.0);
    // Half way through at an hour a block.
    let slow =
        period(&MAINNET, 2016 * 7, 1008, 3600, BITS, BITS).estimate(T0 * 1000 + 1008 * 3_600_000);
    assert!((slow.difficulty_change + 75.0).abs() < 1e-3);
    assert_eq!(slow.remaining_ms, 1008 * 3_600_000);
}

#[test]
fn testnet4_uses_the_first_block_and_ignores_minimum_difficulty_blocks() {
    // Testnet4 tips are often minimum-difficulty blocks mined after a 20-minute gap. Only the
    // period's first block's bits count; the tip's bits are not an input at all.
    let real = 0x1901_2345;
    let e = period(&TESTNET4, 2016 * 70, 1500, 300, real, real).estimate((T0 + 1500 * 300) * 1000);
    assert!(
        e.difficulty_change > 0.0,
        "fast blocks raise the real difficulty"
    );
    // A retarget scaled from the minimum-difficulty last block instead would be wildly wrong.
    let from_last = next_bits(&TESTNET4, bits(LIMIT), 2015 * 300).unwrap();
    let from_first = next_bits(&TESTNET4, bits(real), 2015 * 300).unwrap();
    assert!(difficulty(from_first.to_consensus()) > 1000.0 * difficulty(from_last.to_consensus()));
}

#[test]
fn regtest_never_retargets() {
    let limit = 0x207f_ffff;
    let p = period(&REGTEST, 2016 * 3, 2015, 1, limit, limit);
    let e = p.estimate(NOW_MS);
    assert_eq!(e.difficulty_change, 0.0);
    assert_eq!(e.previous_retarget, 0.0);
    assert_eq!(e.remaining_blocks, 1);
    assert_eq!(e.next_retarget_height, 2016 * 4);
    assert_eq!(next_bits(&REGTEST, bits(limit), 1), Some(bits(limit)));
    // Fixed harder bits (rbitcoin's --regtest-pow-bits) after a genesis at the limit are not an
    // adjustment either.
    let fixed = period(&REGTEST, 2016, 10, 1, 0x1f00_ffff, limit).estimate(NOW_MS);
    assert_eq!(fixed.previous_retarget, 0.0);
    assert_eq!(fixed.difficulty_change, 0.0);
}

#[test]
fn testnet5_floors_at_its_genesis_bits() {
    // Testnet 5's lowest difficulty is its genesis block's bits, about 1,048,561, not 1.
    let floor = 0x1a0f_ffff;
    assert_eq!(difficulty(floor).round(), 1_048_561.0);
    let e = period(&TESTNET5, 2016, 2015, 6000, floor, floor).estimate(NOW_MS);
    assert_eq!(e.difficulty_change, 0.0);
    assert_eq!(
        next_bits(&TESTNET5, bits(floor), 4 * 1_209_600),
        Some(bits(floor))
    );
    // Difficulty 1 is valid on testnet4 but below Testnet 5's floor, so no block of it carries it.
    assert!(next_bits(&TESTNET4, bits(LIMIT), 600).is_some());
    assert_eq!(next_bits(&TESTNET5, bits(LIMIT), 600), None);
    // Above the floor it retargets as mainnet does: a slow period from twice the floor stops at it.
    let two = 0x1a07_ffff;
    let e = period(&TESTNET5, 2016, 2015, 6000, two, two).estimate(NOW_MS);
    assert!((e.difficulty_change + 50.0).abs() < 0.01, "{e:?}");
    let fast = period(&TESTNET5, 2016, 2015, 300, floor, floor).estimate(NOW_MS);
    assert!((fast.difficulty_change - 100.0).abs() < 0.1, "{fast:?}");
}

#[test]
fn refuses_the_wrong_blocks_and_impossible_bits() {
    let ok = |b| block(2016, T0, b);
    let prev = Some(block(0, T0 - 1, LIMIT));
    assert!(Period::new(&MAINNET, 2100, T0, ok(LIMIT), prev).is_ok());
    // Not the tip's period, or not the period before.
    assert_eq!(
        Period::new(&MAINNET, 4100, T0, ok(LIMIT), prev).err(),
        Some(Invalid::Height)
    );
    assert_eq!(
        Period::new(&MAINNET, 2100, T0, ok(LIMIT), None).err(),
        Some(Invalid::Height)
    );
    assert_eq!(
        Period::new(&MAINNET, 100, T0, block(0, T0, LIMIT), prev).err(),
        Some(Invalid::Height)
    );
    // A height whose next period boundary does not fit a u32.
    let top = period_start(u32::MAX);
    assert_eq!(
        Period::new(
            &MAINNET,
            u32::MAX,
            T0,
            block(top, T0, LIMIT),
            Some(block(top - INTERVAL, T0, LIMIT))
        )
        .err(),
        Some(Invalid::Height)
    );
    for bad in [
        0,           // zero
        0x0100_0000, // zero mantissa
        0x1d80_ffff, // negative
        0x1d01_0000, // above the limit
        0xff7f_ffff, // overflows 256 bits
        0x2100_0001, // overflows 256 bits
    ] {
        assert_eq!(
            Period::new(&MAINNET, 2100, T0, ok(bad), prev).err(),
            Some(Invalid::Bits),
            "{bad:#x}"
        );
        assert_eq!(next_bits(&MAINNET, bits(bad), 600), None);
    }
    assert_eq!(
        Period::new(&MAINNET, 2100, T0, ok(LIMIT), Some(block(0, T0, 0))).err(),
        Some(Invalid::Bits)
    );
    // A tip timestamp before the period's first block does not panic.
    let p = Period::new(&MAINNET, 2100, T0 - 7200, ok(LIMIT), prev).unwrap();
    assert_eq!(p.estimate(0).time_avg_ms, 0);
}

// Real period boundaries: `fixtures/difficulty/<network>.json` maps heights to raw headers, for
// the first block, the last block and the next period's first block of a few past periods.

fn fixture(json: &str) -> BTreeMap<u32, Header> {
    json.lines()
        .filter_map(|l| {
            let mut parts = l.split('"').skip(1).step_by(2);
            Some((
                parts.next()?.parse().ok()?,
                deserialize_hex(parts.next()?).unwrap(),
            ))
        })
        .collect()
}

/// Checks every retarget the fixture holds both ends of, and returns how many there were.
fn replay(params: &'static Params, json: &str) -> usize {
    let h = fixture(json);
    let mut checked = 0;
    for (&start, first) in h.iter().filter(|(height, _)| *height % INTERVAL == 0) {
        let (Some(last), Some(next)) = (h.get(&(start + INTERVAL - 1)), h.get(&(start + INTERVAL)))
        else {
            continue;
        };
        let span = i64::from(last.time) - i64::from(first.time);
        assert_eq!(
            next_bits(params, first.bits, span),
            Some(next.bits),
            "{} retarget at {}",
            params.network,
            start + INTERVAL
        );
        checked += 1;
        // The estimate on the period's last block is exactly the change that happened.
        let p = Period::new(
            params,
            start + INTERVAL - 1,
            u64::from(last.time),
            Block {
                height: start,
                time: u64::from(first.time),
                bits: first.bits,
            },
            h.get(&(start - INTERVAL)).map(|b| Block {
                height: start - INTERVAL,
                time: u64::from(b.time),
                bits: b.bits,
            }),
        );
        let p = match p {
            Ok(p) => p,
            // The fixture lacks the period before's first block.
            Err(Invalid::Height) => continue,
            Err(e) => panic!("{e:?}"),
        };
        let actual = change(first.bits.to_consensus(), next.bits.to_consensus());
        assert!(close(p.estimate(NOW_MS).difficulty_change, actual));
    }
    checked
}

#[test]
fn mainnet_history() {
    let json = include_str!("../../../../fixtures/difficulty/mainnet.json");
    assert_eq!(replay(&MAINNET, json), 4);
    let h = fixture(json);
    // The next period's view of the same adjustment.
    let after = Period::new(
        &MAINNET,
        973_728,
        u64::from(h[&973_728].time),
        Block {
            height: 973_728,
            time: u64::from(h[&973_728].time),
            bits: h[&973_728].bits,
        },
        Some(Block {
            height: 971_712,
            time: u64::from(h[&971_712].time),
            bits: h[&971_712].bits,
        }),
    )
    .unwrap();
    let actual = change(
        h[&971_712].bits.to_consensus(),
        h[&973_728].bits.to_consensus(),
    );
    assert!(close(after.estimate(NOW_MS).previous_retarget, actual));
}

#[test]
fn signet_history() {
    let json = include_str!("../../../../fixtures/difficulty/signet.json");
    assert_eq!(replay(&SIGNET, json), 3);
}

#[test]
fn testnet4_history() {
    let json = include_str!("../../../../fixtures/difficulty/testnet4.json");
    assert_eq!(replay(&TESTNET4, json), 3);
    // In each recorded period the last block is a minimum-difficulty block, so the rule that
    // scales the last block's bits (testnet3's) would have got every one wrong.
    let h = fixture(json);
    for start in [153_216, 155_232, 157_248] {
        let last = h[&(start + INTERVAL - 1)];
        assert_eq!(last.bits.to_consensus(), LIMIT);
        let span = i64::from(last.time) - i64::from(h[&start].time);
        assert_ne!(
            next_bits(&TESTNET4, last.bits, span),
            Some(h[&(start + INTERVAL)].bits)
        );
    }
}
