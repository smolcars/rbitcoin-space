#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::BTreeMap;

use bitcoin::BlockHash;
use bitcoin::hashes::Hash;

use super::*;
use crate::projected::Projection;

const B: u64 = BLOCK_VSIZE;

/// A mempool of bands: `(rate, vsize)`, as many 250 vB transactions as fill each.
fn depth(bands: &[(u32, u64)]) -> Depth {
    Depth::new(bands.iter().flat_map(|&(rate, vsize)| {
        std::iter::repeat_n((rate, 250), usize::try_from(vsize / 250).unwrap())
    }))
}

/// Arrivals: one list of `(rate, vsize)` per whole minute, oldest first.
fn inflow(minutes: &[Vec<(u32, u32)>]) -> Inflow {
    let mut i = Inflow::default();
    i.roll(0);
    for (m, arrivals) in minutes.iter().enumerate() {
        let t = m as u64 * 60;
        for &(rate, vsize) in arrivals {
            i.record(t, rate, vsize);
        }
    }
    i.roll(minutes.len() as u64 * 60);
    i
}

fn levels(r: Rates) -> [u32; 4] {
    r.levels
}

#[test]
fn a_mempool_many_blocks_deep_asks_one_step_above_each_boundary() {
    // Twenty bands just under a block each, 20, 19.5, 19 … sat/vB.
    let bands: Vec<(u32, u64)> = (0..20).map(|k| (20_000 - k * 500, 990_000)).collect();
    let r = recommend(&depth(&bands), &Inflow::default(), 100);
    // Block N ends inside band N: pay one step above that band.
    assert_eq!(levels(r), [19_501, 18_501, 17_001, 100]);
    assert_eq!(r.minimum, 100);
}

#[test]
fn exactly_one_block_must_outbid_its_ties_and_the_rest_is_the_minimum() {
    let r = recommend(&depth(&[(5_000, B)]), &Inflow::default(), 100);
    assert_eq!(levels(r), [5_001, 100, 100, 100]);
}

#[test]
fn less_than_a_block_or_nothing_at_all_is_the_minimum() {
    for d in [depth(&[(3_000, B / 2), (150, B / 4)]), Depth::default()] {
        let r = recommend(&d, &Inflow::default(), 100);
        assert_eq!(levels(r), [100; 4]);
    }
}

#[test]
fn the_floor_is_the_nodes_minimum_and_never_under_the_relay_floor() {
    let r = recommend(&Depth::default(), &Inflow::default(), 1_500);
    assert_eq!((levels(r), r.minimum), ([1_500; 4], 1_500));
    let r = recommend(&Depth::default(), &Inflow::default(), 0);
    assert_eq!((levels(r), r.minimum), ([RELAY_FLOOR; 4], RELAY_FLOOR));
}

#[test]
fn a_boundary_full_of_equal_rates_is_outbid_by_one_step() {
    // Half a block at 2 sat/vB, then three blocks of 0.124 sat/vB ties.
    let r = recommend(
        &depth(&[(2_000, B / 2), (124, 3 * B)]),
        &Inflow::default(),
        100,
    );
    assert_eq!(levels(r), [125, 125, 100, 100]);
}

#[test]
fn one_absurd_transaction_moves_nothing() {
    let base = depth(&[(1_000, 3 * B)]);
    let calm = recommend(&base, &Inflow::default(), 100);
    // A 100 kvB transaction at 10,000 sat/vB in the mempool…
    let mut pairs: Vec<(u32, u64)> = (0..(3 * B / 250)).map(|_| (1_000, 250)).collect();
    pairs.push((10_000_000, 100_000));
    let r = recommend(&Depth::new(pairs), &Inflow::default(), 100);
    assert_eq!(levels(r), levels(calm));
    assert_eq!(levels(r), [1_001, 1_001, 100, 100]);
    // …or arriving once among quiet minutes.
    let mut minutes = vec![vec![(1_000, 250)]; 10];
    minutes[4].push((10_000_000, 100_000));
    let r = recommend(&base, &inflow(&minutes), 100);
    assert_eq!(levels(r), [1_001, 1_001, 100, 100]);
}

#[test]
fn steady_arrivals_raise_a_level_that_would_otherwise_be_the_minimum() {
    let d = depth(&[(1_000, B / 2)]);
    assert_eq!(levels(recommend(&d, &Inflow::default(), 100)), [100; 4]);
    // 50 kvB a minute at 2 sat/vB: 1.15 MvB before the next block at 90%, more than a block:
    // outbid the arrivals too. Three blocks hold 2.66 MvB of them but not the 1 sat/vB half as
    // well: outbid that half. Six blocks hold everything.
    let minutes = vec![vec![(2_000, 50_000)]; 10];
    let r = recommend(&d, &inflow(&minutes), 100);
    assert_eq!(levels(r), [2_001, 1_001, 100, 100]);
}

#[test]
fn a_sudden_burst_counts_where_it_is_and_is_not_extrapolated() {
    let steady = vec![vec![(2_000, 10_000)]; 10];
    let base = depth(&[(2_000, B / 2), (500, 4 * B)]);
    let before = recommend(&base, &inflow(&steady), 100);
    // Five blocks at 50 sat/vB land in one minute.
    let mut minutes = steady;
    minutes[9].push((50_000, 5 * u32::try_from(B).unwrap()));
    let with_burst = depth(&[(50_000, 5 * B), (2_000, B / 2), (500, 4 * B)]);
    let r = recommend(&with_burst, &inflow(&minutes), 100);
    // The next three blocks are the burst's: outbid it. Six blocks hold it and the 2 sat/vB
    // half block, but not the arrivals at 2 sat/vB as well: outbid those too.
    assert_eq!(levels(before), [501, 501, 100, 100]);
    assert_eq!(levels(r), [50_001, 50_001, 2_001, 100]);
    // The burst's minute is the busiest, so it is left out of the arrivals.
    let i = inflow(&minutes);
    assert!((i.per_minute_at_or_above(2_000, &TUNING) - 10_000.0).abs() < 1e-9);
}

#[test]
fn one_burst_on_a_quiet_network_is_not_taken_for_a_trend() {
    // Eight minutes, one a burst, the rest silent: as on regtest or signet.
    let mut minutes = vec![Vec::new(); 8];
    minutes[2] = vec![(10_000, 720_000), (5_000, 720_000), (2_000, 720_000)];
    let i = inflow(&minutes);
    assert_eq!(i.per_minute_at_or_above(100, &TUNING), 0.0);
    let r = recommend(&depth(&[(2_000, B), (3_000, B / 4)]), &i, 100);
    assert_eq!(levels(r), [2_001, 100, 100, 100]);
    // A second burst is a flow that recurs, and is counted over the minutes watched.
    minutes[6] = vec![(3_000, 900_000)];
    let i = inflow(&minutes);
    assert!((i.per_minute_at_or_above(100, &TUNING) - 900_000.0 / 7.0).abs() < 1e-6);
}

#[test]
fn whole_numbers_round_up_and_never_go_under_one() {
    assert_eq!(whole(0), 1);
    assert_eq!(whole(100), 1);
    assert_eq!(whole(1_000), 1);
    assert_eq!(whole(1_001), 2);
    assert_eq!(whole(2_633), 3);
    assert_eq!(whole(u32::MAX), 4_294_968);
}

#[test]
fn the_nodes_estimates_map_to_levels_in_order_and_above_the_floor() {
    let est: BTreeMap<u16, f64> = [(1, 4.299), (2, 2.453), (3, 1.799), (6, 1.597), (144, 0.128)]
        .into_iter()
        .collect();
    let r = from_node(&est, 100).unwrap();
    assert_eq!(levels(r), [4_299, 1_799, 1_597, 128]);
    // Missing targets take the next longer one; out-of-order answers are lifted; the floor wins.
    let est: BTreeMap<u16, f64> = [(2, 1.0), (5, 3.0), (1008, 0.05)].into_iter().collect();
    let r = from_node(&est, 100).unwrap();
    assert_eq!(levels(r), [3_000, 3_000, 100, 100]);
    assert_eq!(from_node(&BTreeMap::new(), 100), None);
    let nan: BTreeMap<u16, f64> = [(1, f64::NAN)].into_iter().collect();
    assert_eq!(from_node(&nan, 100), None);
}

#[test]
fn a_higher_minimum_seen_later_lifts_every_level() {
    let r = Rates {
        levels: [3_000, 150, 100, 100],
        minimum: 100,
    };
    let lifted = r.at_least(2_000);
    assert_eq!(
        (levels(lifted), lifted.minimum),
        ([3_000, 2_000, 2_000, 2_000], 2_000)
    );
    assert_eq!(r.at_least(50), r);
}

#[test]
fn the_day_long_floor_raises_only_no_rush_and_never_past_low() {
    let r = Rates {
        levels: [3_000, 1_000, 130, 100],
        minimum: 100,
    };
    // No block history: unchanged.
    assert_eq!(r.no_rush_at_least(None), r);
    let raised = r.no_rush_at_least(Some(123));
    assert_eq!(
        (levels(raised), raised.minimum),
        ([3_000, 1_000, 130, 123], 100)
    );
    // Never above the 6-block level: a quiet mempool keeps the minimum.
    let quiet = Rates {
        levels: [100; 4],
        minimum: 100,
    };
    assert_eq!(quiet.no_rush_at_least(Some(1_003)), quiet);
    // A floor under the answer changes nothing.
    assert_eq!(raised.no_rush_at_least(Some(110)), raised);
    // Busy, then falling: a day whose cheapest block took 20 sat/vB, and a mempool that now
    // clears at 2 within six blocks. The floor costs no more than the 6-block level.
    let falling = Rates {
        levels: [8_000, 4_000, 2_000, 1_500],
        minimum: 1_000,
    };
    assert_eq!(
        levels(falling.no_rush_at_least(Some(20_003))),
        [8_000, 4_000, 2_000, 2_000]
    );
}

#[test]
fn inflow_counts_whole_minutes_and_quiet_ones_as_zero() {
    let mut i = Inflow::default();
    i.record(1_000, 2_000, 400);
    assert_eq!(i.minutes(), 0);
    assert!(!i.ready());
    i.roll(1_059);
    assert_eq!(i.minutes(), 0);
    // Three minutes later: the busy one and two quiet ones.
    i.roll(1_000 + 180);
    assert_eq!(i.minutes(), 3);
    assert!((i.per_minute_at_or_above(1, &TUNING) - 400.0 / 3.0).abs() < 1e-9);
    i.roll(1_000 + 300);
    assert!(i.ready());
    // Never more than the window, however long the silence.
    i.roll(1_000_000);
    assert_eq!(i.minutes(), INFLOW_MINUTES);
    assert_eq!(i.per_minute_at_or_above(1, &TUNING), 0.0);
    // A gap drops the minute in progress.
    i.record(1_000_010, 2_000, 999);
    i.gap(1_000_020);
    i.roll(1_000_080);
    assert_eq!(i.per_minute_at_or_above(1, &TUNING), 0.0);
}

fn tip(n: u8) -> Option<ChainTip> {
    Some(ChainTip {
        hash: BlockHash::from_byte_array([n; 32]),
        height: u32::from(n),
    })
}

fn rates(l: [u32; 4]) -> Rates {
    Rates {
        levels: l,
        minimum: 100,
    }
}

#[test]
fn smoothing_rises_at_once_falls_after_a_minute_and_starts_over_on_a_block() {
    let mut s = Smoother::default();
    assert_eq!(levels(s.push(0, tip(1), rates([500; 4]))), [500; 4]);
    assert_eq!(
        levels(s.push(2, tip(1), rates([900, 400, 400, 400]))),
        [900, 500, 500, 500]
    );
    assert_eq!(
        levels(s.push(30, tip(1), rates([300; 4]))),
        [900, 500, 500, 500]
    );
    assert_eq!(
        levels(s.push(61, tip(1), rates([300; 4]))),
        [900, 400, 400, 400]
    );
    assert_eq!(levels(s.push(62, tip(1), rates([300; 4]))), [300; 4]);
    s.push(63, tip(1), rates([800; 4]));
    // A new block: the old highs are gone.
    assert_eq!(levels(s.push(64, tip(2), rates([200; 4]))), [200; 4]);
}

#[test]
fn fee_range_is_seven_rates_by_vsize() {
    assert!(fee_range([]).is_empty());
    let txs = (1..=100u32).map(|r| (r * 10, 100));
    assert_eq!(fee_range(txs), vec![10, 100, 250, 500, 750, 900, 1_000]);
    assert_eq!(fee_range([(7, 1)]), vec![7; 7]);
}

#[test]
fn time_without_a_projection_is_not_counted_as_quiet_minutes() {
    let current = Projection {
        tip: tip(1),
        ..Projection::default()
    };
    let stale = Projection {
        stale: true,
        ..current.clone()
    };
    let mut r = Recommender::default();
    // Down from the start for ten minutes: nothing was watched, so no warm-up passed.
    for t in (0..600).step_by(2) {
        assert_eq!(r.update(t, &Projection::default(), 100), None);
    }
    assert_eq!(r.update(600, &current, 100), None);
    assert_eq!(r.update(600 + 299, &current, 100), None);
    assert!(r.update(600 + 300, &current, 100).is_some());
    // A blip under a minute keeps what was watched…
    assert_eq!(r.update(1_000, &stale, 100), None);
    assert!(r.update(1_030, &current, 100).is_some());
    // …a longer outage starts the warm-up over.
    assert_eq!(r.update(1_100, &stale, 100), None);
    assert_eq!(r.update(1_200, &current, 100), None);
    assert_eq!(r.update(1_499, &current, 100), None);
    assert!(r.update(1_500, &current, 100).is_some());
}

/// A current projection on tip 1 holding `(rate, vsize)` transactions: all [`Depth::of`] reads.
fn projection(pairs: &[(u32, u64)]) -> Projection {
    let txs = pairs
        .iter()
        .enumerate()
        .map(|(i, &(rate, vsize))| {
            let mut id = [0u8; 32];
            id[..8].copy_from_slice(&(i as u64).to_le_bytes());
            let placed = crate::projected::Placed {
                block: 0,
                rate,
                vsize: u32::try_from(vsize).unwrap(),
                fee: 0,
                flags: 0,
            };
            (bitcoin::Txid::from_byte_array(id), placed)
        })
        .collect();
    Projection {
        tip: tip(1),
        blocks: vec![std::sync::Arc::new(crate::projected::ProjectedBlock {
            summary: crate::projected::BlockSummary::default(),
            txs,
        })],
        ..Projection::default()
    }
}

/// The node's `/fee-estimates` for targets 1, 2, 3, 6 and 144, in sat/vB, as the server takes them.
fn node(est: [f64; 5], floor: u32) -> Rates {
    let est: BTreeMap<u16, f64> = [1, 2, 3, 6, 144].into_iter().zip(est).collect();
    from_node(&est, floor).unwrap()
}

/// One tick of [`restart`].
struct Tick {
    t: u64,
    cap: Option<Rates>,
    /// What the warming-up rule serves of the node's estimates: `None` is nothing yet.
    served: Option<Rates>,
    ours: Option<Rates>,
}

/// From a restart at `t0`, every 2 s as the server ticks.
fn restart(
    r: &mut Recommender,
    p: &Projection,
    t0: u64,
    until: u64,
    mut arrivals: impl FnMut(&mut Recommender, u64),
    node: Rates,
) -> Vec<Tick> {
    (t0..until)
        .step_by(2)
        .map(|t| {
            arrivals(r, t);
            let ours = r.update(t, p, node.minimum);
            Tick {
                t,
                cap: r.cap(),
                served: r.cap().map(|c| node.at_most(&c)),
                ours,
            }
        })
        .collect()
}

#[test]
fn while_warming_up_a_quiet_network_is_served_no_more_than_its_mempool_needs() {
    // Signet on the live site: 126 transactions, 40 kvB, a few paying hundreds of sat/vB; the
    // node's next-block estimate a high quantile of old blocks, 89 sat/vB.
    let p = projection(&[
        (3_900_000, 182),
        (246_000, 183),
        (20_042, 212),
        (9_000, 6_092),
        (3_000, 11_724),
        (1_000, 20_000),
    ]);
    let node = node([89.11, 1.098, 1.091, 1.081, 1.0], 1_000);
    assert_eq!(node.levels, [89_110, 1_091, 1_081, 1_000]);
    // A 200 vB payment at 3 sat/vB every 20 s.
    let trickle = |r: &mut Recommender, t: u64| {
        if t.is_multiple_of(20) {
            r.arrived(t, 600, 200);
        }
    };
    let mut r = Recommender::default();
    let t0 = 1_800_000_000;
    for Tick {
        t, served, ours, ..
    } in restart(&mut r, &p, t0, t0 + 400, trickle, node)
    {
        match t - t0 {
            // Nothing watched yet: nothing is served rather than 89 sat/vB.
            0..60 => assert_eq!((served, ours), (None, None), "at {t}"),
            // A minute watched: the mempool and its arrivals need the minimum, so no more is served.
            60..300 => {
                assert_eq!(served.map(levels), Some([1_000; 4]), "at {t}");
                assert_eq!(ours, None);
            }
            // Ours, which says the same.
            _ => assert_eq!(
                (served, ours.map(levels)),
                (None, Some([1_000; 4])),
                "at {t}"
            ),
        }
    }
}

#[test]
fn while_warming_up_a_busy_network_is_never_capped_below_our_own_answer() {
    // The recorded mainnet moment: its mempool, and its arrivals replayed minute by minute
    // from a restart.
    let f: serde_json::Value =
        serde_json::from_str(include_str!("../../../../fixtures/fees/mainnet.json")).unwrap();
    let pairs = |v: &serde_json::Value| -> Vec<(u32, u64)> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|p| (p[0].as_u64().unwrap() as u32, p[1].as_u64().unwrap()))
            .collect()
    };
    let p = projection(&pairs(&f["depth"]));
    let minutes: Vec<Vec<(u32, u64)>> = f["inflow"].as_array().unwrap().iter().map(pairs).collect();
    let floor = f["floor"].as_u64().unwrap() as u32;
    // Ours with all 30 minutes, and the node's estimates of that day.
    let ours_then = levels(recommend(
        &Depth::new(pairs(&f["depth"])),
        &inflow(
            &minutes
                .iter()
                .map(|m| m.iter().map(|&(r, v)| (r, v as u32)).collect())
                .collect::<Vec<_>>(),
        ),
        floor,
    ));
    assert_eq!(ours_then, [2_008, 1_141, 1_001, 100]);
    let node = node([2.664, 0.891, 0.666, 0.651, 0.307], floor);
    let t0 = 1_800_000_000;
    // Each minute's arrivals in its second second, at no less than their recorded rate.
    let replay = |r: &mut Recommender, t: u64| {
        let m = usize::try_from((t - t0) / 60).unwrap();
        if (t - t0) % 60 == 2
            && let Some(m) = minutes.get(m)
        {
            for &(rate, vsize) in m {
                let vsize = u32::try_from(vsize).unwrap();
                r.arrived(
                    t,
                    (u64::from(rate) * u64::from(vsize)).div_ceil(1000),
                    vsize,
                );
            }
        }
    };
    let mut r = Recommender::default();
    let mut capped = 0;
    for Tick { t, cap, served, .. } in restart(&mut r, &p, t0, t0 + 300, replay, node) {
        let (Some(cap), Some(served)) = (cap, served) else {
            assert!(t - t0 < 60, "nothing served at {t}");
            continue;
        };
        // The node's level or the cap, whichever is lower; the cap never below ours.
        for (((s, n), c), o) in served
            .levels
            .iter()
            .zip(node.levels)
            .zip(cap.levels)
            .zip(ours_then)
        {
            assert_eq!(*s, n.min(c), "at {t}");
            assert!(c >= o, "at {t}: {cap:?}");
        }
        capped += 1;
    }
    assert!(capped > 100);
}

/// A mainnet moment recorded by `examples/fee_watch.rs`: every effective rate in the projected
/// blocks with its vsize, 30 minutes of arrivals, the node's minimum, the projected blocks'
/// lowest rates, and the answer the method gave.
#[test]
fn a_recorded_mainnet_mempool_gives_the_recorded_answer() {
    let f: serde_json::Value =
        serde_json::from_str(include_str!("../../../../fixtures/fees/mainnet.json")).unwrap();
    let pairs = |v: &serde_json::Value| -> Vec<(u32, u64)> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|p| (p[0].as_u64().unwrap() as u32, p[1].as_u64().unwrap()))
            .collect()
    };
    let d = Depth::new(pairs(&f["depth"]));
    let minutes: Vec<Vec<(u32, u32)>> = f["inflow"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| pairs(m).into_iter().map(|(r, v)| (r, v as u32)).collect())
        .collect();
    assert_eq!(minutes.len(), INFLOW_MINUTES);
    let i = inflow(&minutes);
    let floor = f["floor"].as_u64().unwrap() as u32;
    // The tuning it was recorded with gives the recorded answer, so a replay reproduces it.
    let before = Tuning {
        confidence: 0.8,
        busiest_left_out: |n| if n >= 5 { (n / 4).max(1) } else { 0 },
    };
    let then = recommend_tuned(&d, &i, floor, &before);
    let expected: Vec<u32> = f["expected"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u32)
        .collect();
    assert_eq!([&then.levels[..], &[then.minimum]].concat(), expected);
    // The tuning served since counts more arrivals for longer: every level at least as high.
    let r = recommend(&d, &i, floor);
    assert_eq!(levels(r), [2_008, 1_141, 1_001, 100]);
    // Each level outbids the bottom of the projected block after its horizon: what pays the
    // bottom of block N or less does not all fit in N blocks.
    let bottoms: Vec<u32> = f["projected_min_rates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u32)
        .collect();
    assert!(r.levels[0] > bottoms[1], "{:?} {bottoms:?}", r.levels);
    assert!(
        r.levels[1] > bottoms[3].min(bottoms[2]),
        "{:?} {bottoms:?}",
        r.levels
    );
    // Without arrivals, the next block is the one-step-above-the-boundary answer.
    let still = recommend(&d, &Inflow::default(), floor);
    assert!(still.levels[0] <= r.levels[0]);
    assert!(d.at_or_above(still.levels[0]) < BLOCK_VSIZE);
    assert!(
        d.at_or_above(still.levels[0] - 1) >= BLOCK_VSIZE
            || still.levels[0] == floor.max(RELAY_FLOOR)
    );
}

// Properties over random mempools from a deterministic generator.

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }

    /// Mostly realistic rates, sometimes absurd ones.
    fn rate(&mut self) -> u32 {
        let r = match self.below(10) {
            0 => self.below(u64::from(u32::MAX)),
            1..=5 => 100 + self.below(200),
            _ => 100 + self.below(50_000),
        };
        u32::try_from(r).unwrap()
    }
}

#[test]
fn random_mempools_are_ordered_floored_bounded_and_exactly_at_the_boundary() {
    let mut rng = Rng(0x5eed_f00d);
    for case in 0..150 {
        let txs = rng.below(if case % 4 == 0 { 50 } else { 3_000 });
        let d = Depth::new((0..txs).map(|_| (rng.rate(), 60 + rng.below(100_000))));
        let mut arrivals = Inflow::default();
        let minutes = rng.below(40);
        for m in 0..minutes {
            for _ in 0..rng.below(200) {
                let v = u32::try_from(60 + rng.below(20_000)).unwrap();
                arrivals.record(m * 60 + rng.below(60), rng.rate(), v);
            }
        }
        arrivals.roll(minutes * 60);
        let floor = u32::try_from(rng.below(3_000)).unwrap();
        let r = recommend(&d, &arrivals, floor);
        let min = floor.max(RELAY_FLOOR);
        assert_eq!(r.minimum, min);
        let top = d
            .max_rate()
            .max(arrivals.max_rate())
            .saturating_add(1)
            .max(min);
        for w in r.levels.windows(2) {
            assert!(w[0] >= w[1], "case {case}: {:?}", r.levels);
        }
        for (rate, level) in r.levels.into_iter().zip(LEVELS) {
            assert!(
                rate >= min && rate <= top,
                "case {case}: {rate} outside [{min}, {top}]"
            );
            let room = u64::from(level.blocks) * B;
            let minutes = secs(level) / 60.0;
            let fits = |x: u32| {
                d.at_or_above(x) as f64 + arrivals.per_minute_at_or_above(x, &TUNING) * minutes
                    < room as f64
            };
            // Monotonic lifting can only raise a slower level's answer to a faster one's, which
            // fits too; and the level's own answer is the lowest that fits.
            assert!(fits(rate), "case {case}: {} pays too little", level.name);
            let own = recommend_one(&d, &arrivals, min, level);
            assert!(own <= rate);
            if level.blocks == 1 {
                assert_eq!(own, rate, "case {case}");
            }
            if own > min {
                assert!(!fits(own - 1), "case {case}: {} not the lowest", level.name);
            }
        }
        for rate in r.levels {
            assert!(whole(rate) * 1000 >= u64::from(rate));
        }
    }
}

fn secs(level: Level) -> f64 {
    arrival_secs(level.blocks, TUNING.confidence) as f64
}

/// One level alone, by brute force over the candidate rates.
fn recommend_one(d: &Depth, i: &Inflow, floor: u32, level: Level) -> u32 {
    let room = u64::from(level.blocks) * B;
    let minutes = secs(level) / 60.0;
    let mut candidates: Vec<u32> = d.rates.iter().map(|r| r.saturating_add(1)).collect();
    for m in &i.closed {
        candidates.extend(m.rates.iter().map(|r| r.saturating_add(1)));
    }
    candidates.push(floor);
    candidates.retain(|c| *c >= floor);
    candidates.sort_unstable();
    candidates
        .into_iter()
        .find(|&x| {
            d.at_or_above(x) as f64 + i.per_minute_at_or_above(x, &TUNING) * minutes < room as f64
        })
        .unwrap_or(floor)
}

#[test]
fn the_time_allowed_is_the_gamma_quantile_of_block_times() {
    // The constants the method used at 80% were these, rounded rather than rounded up.
    let at_80: Vec<u64> = LEVELS.iter().map(|l| arrival_secs(l.blocks, 0.8)).collect();
    assert_eq!(at_80, [966, 2_568, 4_744, 92_395]);
    // One block: -600 ln(1 - q).
    assert_eq!(arrival_secs(1, 0.95), 1_798);
    assert!(arrival_secs(6, 0.9) > arrival_secs(6, 0.8));
}

/// Each level's lowest share of samples met on `fixtures/fees/replay.json`, high, medium, low.
/// The tuning chosen on 2026-11-13 meets 14 of 17, 15 of 15 and 8 of 9; the one before it met
/// 12, 11 and 3, under every bound.
const MET_AT_LEAST: [f64; 3] = [0.8, 0.9, 0.85];

/// A stretch of mainnet recorded by `examples/fee_watch.rs` and trimmed as
/// `fixtures/fees/README.md` says: the method is replayed through it, and each level must still
/// be met as often as it was when the tuning was chosen.
#[test]
fn replayed_on_recorded_mainnet_each_level_is_met_often_enough() {
    let f: serde_json::Value =
        serde_json::from_str(include_str!("../../../../fixtures/fees/replay.json")).unwrap();
    // `rate, vsize, rate, vsize …`
    let pairs = |v: &serde_json::Value| -> Vec<(u32, u64)> {
        v.as_array()
            .unwrap()
            .chunks(2)
            .map(|p| (p[0].as_u64().unwrap() as u32, p[1].as_u64().unwrap()))
            .collect()
    };
    let start = f["start"].as_u64().unwrap();
    let minutes = f["minutes"].as_array().unwrap();
    let blocks: Vec<(u64, Option<u64>)> = f["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| (b[0].as_u64().unwrap(), b[1].as_u64()))
        .collect();
    let mut inflow = Inflow::default();
    inflow.roll(start);
    let mut next = 0;
    let (mut met, mut scored) = ([0usize; 3], [0usize; 3]);
    for s in f["samples"].as_array().unwrap() {
        let t = s[0].as_u64().unwrap();
        // Every minute begun before the sample, at its start: the minute is all that counts.
        while let Some(m) = minutes.get(next).filter(|_| start + next as u64 * 60 <= t) {
            for (rate, vsize) in pairs(m) {
                inflow.record(
                    start + next as u64 * 60,
                    rate,
                    u32::try_from(vsize).unwrap(),
                );
            }
            next += 1;
        }
        inflow.roll(t);
        assert!(inflow.ready());
        let r = recommend(
            &Depth::new(pairs(&s[2])),
            &inflow,
            s[1].as_u64().unwrap() as u32,
        );
        let after = blocks.partition_point(|b| b.0 <= t);
        for (i, level) in LEVELS.iter().take(3).enumerate() {
            let Some(horizon) = blocks.get(after..after + level.blocks as usize) else {
                continue;
            };
            // Met: one step above the clearing rate of one of the next `N` blocks.
            let Some(need) = horizon.iter().filter_map(|b| b.1).min() else {
                continue;
            };
            scored[i] += 1;
            met[i] += usize::from(u64::from(r.levels[i]) > need);
        }
    }
    let shares: Vec<f64> = met
        .iter()
        .zip(scored)
        .map(|(&m, n)| m as f64 / n as f64)
        .collect();
    for ((share, bound), level) in shares.iter().zip(MET_AT_LEAST).zip(LEVELS) {
        assert!(
            *share >= bound,
            "{} met {share:.3} of {scored:?}, under {bound}",
            level.name
        );
    }
}
