#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::fees::db::{self, Batch};
use crate::fees::{Depth, Inflow, recommend};
use crate::store::{Options, Store};

fn store() -> (std::path::PathBuf, Store) {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "rbitcoin-space-fee-score-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let store = Store::open(&dir, "regtest", Options::default()).unwrap();
    (dir, store)
}

/// `fixtures/fees/replay.json` replayed as its own test does, every sample's answer and every
/// block recorded through the store as the server records them, read back and scored: the
/// same met shares as PR #97's scorer gave for that file (14 of 17, 15 of 15, 8 of 9).
#[tokio::test]
async fn the_recorded_fixture_scores_as_the_recorder_scored_it() {
    let f: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../fixtures/fees/replay.json")).unwrap();
    let pairs = |v: &serde_json::Value| -> Vec<(u32, u64)> {
        v.as_array()
            .unwrap()
            .chunks(2)
            .map(|p| (p[0].as_u64().unwrap() as u32, p[1].as_u64().unwrap()))
            .collect()
    };
    let start = f["start"].as_u64().unwrap();
    let minutes = f["minutes"].as_array().unwrap();
    let mut inflow = Inflow::default();
    inflow.roll(start);
    let mut next = 0;
    let mut samples = Vec::new();
    for s in f["samples"].as_array().unwrap() {
        let t = s[0].as_u64().unwrap();
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
        let r = recommend(
            &Depth::new(pairs(&s[2])),
            &inflow,
            s[1].as_u64().unwrap() as u32,
        );
        samples.push(Sample {
            t,
            served: Served::Ours(r.levels),
        });
    }
    let blocks: Vec<Block> = f["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .zip(975_661..)
        .map(|(b, height)| Block {
            height,
            t: b[0].as_u64().unwrap(),
            clearing: b[1].as_u64().map(|c| c as u32),
        })
        .collect();
    let now = blocks.last().unwrap().t;

    let (dir, store) = store();
    store.set_gate(crate::store::Gate::Open);
    // One write per sample and per block, as the server sends them.
    for s in &samples {
        let batch = Batch {
            samples: vec![*s],
            blocks: Vec::new(),
        };
        db::write(&store, store.generation(), batch, now)
            .await
            .unwrap();
    }
    for b in &blocks {
        let batch = Batch {
            samples: Vec::new(),
            blocks: vec![*b],
        };
        db::write(&store, store.generation(), batch, now)
            .await
            .unwrap();
    }
    let (s, b) = db::load(&store, now).await.unwrap();
    assert_eq!((s.len(), b.len()), (samples.len(), blocks.len()));
    let record = Record::new(s, b);
    let report = record.report(&[(0, u64::MAX)]).pop().unwrap();
    let met: Vec<(usize, usize)> = report.levels[..3]
        .iter()
        .map(|t| (t.met, t.total))
        .collect();
    assert_eq!(met, [(14, 17), (15, 15), (8, 9)]);
    // The day-long horizons have not finished.
    assert_eq!(report.levels[3].unfinished, 17);

    // A month and a day on, the next block's write deletes every row that aged.
    let later = now + db::KEEP_BLOCKS + 1;
    let batch = Batch {
        samples: Vec::new(),
        blocks: vec![block(975_700, later, None)],
    };
    db::write(&store, store.generation(), batch, later)
        .await
        .unwrap();
    let (s, b) = db::load(&store, now).await.unwrap();
    assert!(s.is_empty());
    assert_eq!(b, [block(975_700, later, None)]);
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

fn block(height: u32, t: u64, clearing: Option<u32>) -> Block {
    Block {
        height,
        t,
        clearing,
    }
}

#[test]
fn outages_reorgs_and_age_are_handled() {
    let ours = |t, r| Sample {
        t,
        served: Served::Ours([r; 4]),
    };
    let mut rec = Record::default();
    for t in [0, 100, 200, 9_000, 9_100] {
        assert!(rec.sample(ours(t, 1_000)));
    }
    // A clock that went back is not a sample.
    assert!(!rec.sample(ours(50, 1_000)));
    assert!(rec.sample(Sample {
        t: 9_200,
        served: Served::Node,
    }));
    rec.block(block(1, 300, Some(500)));
    // Over two hours later: the node had lost the network.
    rec.block(block(2, 8_000, Some(2_000)));
    rec.block(block(3, 9_500, None));
    // A reorg replaces the block at its height.
    rec.block(block(3, 9_600, Some(999)));
    assert_eq!(rec.blocks().len(), 3);
    let r = rec.report(&[(0, 10_000)]).pop().unwrap();
    let high = &r.levels[0];
    // 0, 100 and 200 waited for block 1 and met it; 9,000 and 9,100 waited for block 3, inside
    // the outage's aftermath.
    assert_eq!((high.met, high.total, high.left_out), (3, 3, 2));
    assert_eq!(r.node, 1);
    assert!(high.interval().0.is_nan(), "one block is no interval");
    rec.prune(150, 500);
    assert_eq!(rec.samples().first().unwrap().t, 200);
    assert_eq!(rec.last_height(), Some(3));
    assert_eq!(rec.blocks().len(), 2);
}

#[test]
fn the_day_floor_is_three_steps_over_the_last_days_cheapest_block() {
    assert_eq!(day_floor(&[]), None);
    assert_eq!(day_floor(&[block(10, 0, None)]), None);
    let mut rec = Record::default();
    rec.block(block(1_000, 0, Some(120)));
    rec.block(block(1_001, 600, Some(2_000)));
    assert_eq!(rec.day_floor(), Some(123));
    // 1,000 is 144 heights below 1,144: out of the day.
    rec.block(block(1_144, 86_400, Some(125)));
    assert_eq!(rec.day_floor(), Some(128));
    // A block with no clearing rate is no evidence; the highest height sets the day.
    rec.block(block(1_200, 90_000, None));
    assert_eq!(rec.day_floor(), Some(128));
    assert_eq!(day_floor(&[block(1, 0, Some(u32::MAX))]), Some(u32::MAX));
}

/// The blocks and our own served answers of a `fixtures/fees/score-*.json` file.
fn recorded(json: &str) -> (Vec<Block>, Vec<(u64, [u32; 4])>) {
    let f: serde_json::Value = serde_json::from_str(json).unwrap();
    let rate = |v: &serde_json::Value| u32::try_from(v.as_u64().unwrap()).unwrap();
    let blocks = f["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| {
            block(
                rate(&b[0]),
                b[1].as_u64().unwrap(),
                b[2].as_u64().map(|c| c as u32),
            )
        })
        .collect();
    let samples = f["samples"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let t = s[0].as_u64().unwrap();
            (t, [rate(&s[1]), rate(&s[2]), rate(&s[3]), rate(&s[4])])
        })
        .collect();
    (blocks, samples)
}

/// Each sample as served, and with the day floor of the blocks recorded before it applied.
fn served_and_floored(blocks: &[Block], samples: &[(u64, [u32; 4])]) -> (Vec<Sample>, Vec<Sample>) {
    let (mut served, mut floored) = (Vec::new(), Vec::new());
    for &(t, levels) in samples {
        let seen = blocks.partition_point(|b| b.t <= t);
        let r = crate::fees::Rates {
            levels,
            minimum: 100,
        }
        .no_rush_at_least(day_floor(&blocks[..seen]));
        assert_eq!(r.levels[..3], levels[..3]);
        assert!(r.levels[3] <= r.levels[2] && r.levels[3] >= levels[3]);
        served.push(Sample {
            t,
            served: Served::Ours(levels),
        });
        floored.push(Sample {
            t,
            served: Served::Ours(r.levels),
        });
    }
    (served, floored)
}

fn score(samples: Vec<Sample>, blocks: &[Block]) -> Report {
    Record::new(samples, blocks.to_vec())
        .report(&[(0, u64::MAX)])
        .pop()
        .unwrap()
}

/// `fixtures/fees/score-days.json`, three days of the live server's own answers on mainnet
/// (every tenth sample of ours) and every block it recorded: served, the day-long level met its
/// horizon about 31% of the time; with each sample's floor taken from the blocks recorded before
/// it, at least 85%, and the other levels' answers are untouched.
#[test]
fn the_day_floor_meets_the_day_long_horizon_on_three_days_of_mainnet() {
    let (blocks, samples) = recorded(include_str!("../../../../../fixtures/fees/score-days.json"));
    let (served, floored) = served_and_floored(&blocks, &samples);
    let (before, after) = (score(served, &blocks), score(floored, &blocks));
    let (b, a) = (&before.levels[3], &after.levels[3]);
    assert_eq!((b.met, b.total), (181, 587));
    assert_eq!((a.met, a.total), (584, 587));
    assert!(
        a.blocks() >= MIN_BLOCKS && a.interval().0 >= 0.85,
        "{:?}",
        a.interval()
    );
    // What it costs: under 0.03 sat/vB over what sufficed, on average.
    assert!(a.mean_over() < 0.03, "{}", a.mean_over());
    for l in 0..3 {
        assert_eq!(before.levels[l].met, after.levels[l].met);
        assert_eq!(before.levels[l].total, after.levels[l].total);
    }
}

/// `fixtures/fees/score-week.json`, the five days after `score-days.json` (to 2026-11-21): the
/// floor went live part-way through its first day. Replayed, the floor meets the horizon on
/// every scored sample; served, every answer after it went live already was the floor's, and
/// met. The route's week read under 85% then because its window still held the days before.
#[test]
fn the_day_floor_still_meets_the_day_long_horizon_on_the_week_after() {
    let (blocks, samples) = recorded(include_str!("../../../../../fixtures/fees/score-week.json"));
    let (served, floored) = served_and_floored(&blocks, &samples);
    // The last sample the floor would have raised: 2026-11-16 22:16 UTC, before it went live.
    let live = served
        .iter()
        .zip(&floored)
        .filter(|(s, f)| s.served != f.served)
        .map(|(s, _)| s.t)
        .max()
        .unwrap();
    assert_eq!(live, 1_794_867_373);
    let since: Vec<Sample> = served.iter().filter(|s| s.t > live).copied().collect();
    let (before, after, since) = (
        score(served, &blocks),
        score(floored, &blocks),
        score(since, &blocks),
    );
    let (b, a, s) = (&before.levels[3], &after.levels[3], &since.levels[3]);
    assert_eq!((b.met, b.total), (1_217, 1_234));
    assert_eq!((a.met, a.total), (1_234, 1_234));
    assert_eq!((s.met, s.total), (1_152, 1_152));
    for t in [a, s] {
        assert!(
            t.blocks() >= MIN_BLOCKS && t.interval().0 >= 0.85,
            "{:?}",
            t.interval()
        );
    }
}

#[test]
fn the_clearing_rate_is_the_first_percentile_by_size() {
    // One cheap outlier under 1% of the block does not set it.
    let mut rates = vec![(10, 5), (1_000, 600), (2_000, 400)];
    assert_eq!(clearing(&mut rates), Some(1_000));
    assert_eq!(clearing(&mut []), None);
}

#[test]
fn the_rate_given_is_kept_for_every_sample_scored_and_only_those() {
    let scored = |rate, need, met| Outcome::Scored {
        met,
        rate,
        need,
        waited_for: 0,
        faster: true,
    };
    let mut t = Tally::default();
    assert!(t.median_given().is_nan());
    t.count(scored(1_000, 1_500, false));
    t.count(scored(3_000, 1_500, true));
    t.count(scored(2_000, 1_500, true));
    // Not scored: none of these is a rate the level was judged on.
    t.count(Outcome::Unfinished);
    t.count(Outcome::LeftOut);
    t.count(Outcome::Unscored);
    assert_eq!(t.given, [1.0, 3.0, 2.0]);
    assert_eq!(t.median_given(), 2.0);
    // The upper middle, never the mean of the two middle values: [1, 3] gives 3, not 2.
    let mut two = Tally::default();
    two.count(scored(1_000, 500, true));
    two.count(scored(3_000, 500, true));
    assert_eq!(two.median_given(), 3.0);
    // One sample is its own median.
    let mut one = Tally::default();
    one.count(scored(1_500, 500, true));
    assert_eq!(one.median_given(), 1.5);
}
