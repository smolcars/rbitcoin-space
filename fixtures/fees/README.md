# Fee fixtures

Public mainnet data, recorded read-only by `crates/engine/examples/fee_watch.rs`. The method and its evidence: [`docs/MEMPOOL.md`](../../docs/MEMPOOL.md#against-the-blocks-that-followed).

## `mainnet.json`

One moment of 2026-11-12: every effective rate in the projected blocks with its vsize, 30 minutes of arrivals, the node's minimum, the projected blocks' lowest rates, and the answer the method gave then (recorded with `FIXTURE=path`). The test checks that the tuning of that time still gives that answer, so a replay of old recordings reproduces what was served.

## `replay.json`

Three hours of mainnet, 2026-11-13 10:04 to 12:59 UTC, blocks 975,661 to 975,673. The method is replayed through it in `fees::tests::replayed_on_recorded_mainnet_each_level_is_met_often_enough`, which fails if a level is met less often than the bound beside it.

It was made from a recording with the method's inputs, then trimmed to under 100 KB:

```bash
NET=MAINNET SECS=10500 SAMPLE_SECS=10 INPUTS=1 OUT=run.jsonl cargo run --release -p engine --example fee_watch
REPLAY=run.jsonl TRIM=fixtures/fees/replay.json TRIM_EVERY=600 cargo run --release -p engine --example fee_watch
```

The trim keeps:

- **One sample every ten minutes** where our own answer was served (17), each with the node's minimum and the mempool's depth by effective rate, highest first, down to where it reaches six blocks. Below that no level the test scores can fit, so the rest changes nothing.
- **The arrivals by minute** from the replay's first minute: the vsize that entered at each rate, without arrivals under the lowest six-block cut.
- **The blocks** from the first sample to the sixth after the last, each with its clearing rate.

Rates above 0.2 sat/vB are rounded down to two significant figures throughout (depth, arrivals and clearing rates alike), so the fixture is consistent with itself. Rates at the cheap end, where one step decides, are exact. Pairs are flattened: `rate, vsize, rate, vsize …`, in sat per 1,000 vB and vB.

| Field | Holds |
|---|---|
| `start` | Unix seconds of the first minute of `minutes` |
| `minutes` | One list per minute from `start`: arrivals as flattened pairs |
| `samples` | `[time, minimum, depth]`, depth as flattened pairs |
| `blocks` | `[time seen, clearing rate or null]` |

## `score-days.json`

Three days of the live server's own fee score on mainnet, 2026-11-13 14:51 to 2026-11-16 15:30 UTC, as its `fee_samples` and `fee_blocks` tables stored them. Replayed in `fees::score::tests::the_day_floor_meets_the_day_long_horizon_on_three_days_of_mainnet` ([`docs/MEMPOOL.md`](../../docs/MEMPOOL.md#the-day-long-level)).

| Field | Holds |
|---|---|
| `blocks` | Every block recorded, by the time seen: `[height, time seen, clearing rate or null]` |
| `samples` | Every tenth sample where our own answer was served (587 of them scored at 144 blocks): `[time, high, medium, low, no_rush]` |

Rates are sat per 1,000 vB.

## `score-week.json`

The five days after `score-days.json`, 2026-11-16 15:31 to 2026-11-21 19:50 UTC, from the same tables; the day-long floor went live on the first of them, at about 23:00 UTC. Replayed in `fees::score::tests::the_day_floor_still_meets_the_day_long_horizon_on_the_week_after` ([`docs/MEMPOOL.md`](../../docs/MEMPOOL.md#the-day-long-level)). Same fields as `score-days.json`: every tenth sample where our own answer was served (1,476, of which 1,234 are scored at 144 blocks), and every block recorded from 143 heights before the first sample's tip, so the first sample has its whole day of blocks.
