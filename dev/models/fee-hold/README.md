# A fee message waiting for its block

When a block is found, the `blocks` topic announces it and the fee recommendations move to it, in either order. A `fees` message on another block than the one last announced is held until the two agree, for at most three seconds (`HOLD`), so a client never reads fees for a block it has not been told of ([`docs/WS.md`](../../../docs/WS.md#when-a-block-is-found)). The loop of `run` and `serve` in [`crates/server/src/ws/fees.rs`](../../../crates/server/src/ws/fees.rs) does this with a tick, a timer for the hold's end and two event streams in one `select!`. [`FeeHold.tla`](FeeHold.tla) is that loop as a model, checked in every order of its events for two blocks, with a tick longer than the hold and one shorter ([`docs/CI.md`](../../../docs/CI.md#models)).

## The rules

| Rule | In plain words | What breaking it costs |
|---|---|---|
| `NeverAheadOfItsBlock` | A fee message on another block than the one announced never goes out before it has waited `HOLD` | A client reads fees for a block it has not been told of, or for the block before the one it was just told of |
| `OutByTheDeadline` | A message never waits longer than `HOLD` | Fees stay stale until the next tick whenever a block's announcement is late: up to a minute, by `WS_MEMPOOL_INTERVAL_MS` |
| `ADeadlineEndsTheHold` | A pass of the loop that the hold's deadline woke ends the hold | The deadline is still due on the next pass, and the one after: the loop spins a core, and on a paused clock a test never returns |

## The steps and the code

One action in the model is one pass of the loop, or something outside it. Time passes only while no branch of the `select!` is ready.

| Model | Code |
|---|---|
| `Announce`, `Project`, `Change` | Outside the loop: the `blocks` topic announcing a block, the projection reaching one, the mempool changing the answer |
| `SeeAnnounced` | the `announced.changed()` branch: `tick.reset_immediately()` while a message waits |
| `SeeProjected` | the projection's branch: `tick.reset_immediately()` on a new tip |
| `Tick` | `tick.tick()` winning the last branch, then the work down to `serve` |
| `Deadline` | `sleep_until(held + HOLD)` winning the last branch, then the same work. `release` is armed afresh on each pass from `held` |
| `Serve` | `serve`: nothing when the answer is the one last published; held when it is on another block and has waited less than `HOLD`; published otherwise, and `held` cleared |

`early` and `woke` are the model's own, for the rules to read.

## The mistakes it must catch

Each is the model with one step written as it once was, and the check fails unless each still breaks its rule.

1. **No hold** (`Variant = "nohold"`, the code before #67). The projection reaches block 1 before the `blocks` topic announces it, the tick fires, and fees for block 1 go out first.

2. **Only the tick ends a hold** (`Variant = "norelease"`, #67 as first written, found in its review):

   1. The projection reaches block 1. The tick fires and the message is held.
   2. The block is not announced. Three seconds pass, and a fourth.
   3. The message still waits: nothing wakes the loop before the next tick.

3. **The deadline only resets the tick** (`Variant = "resetonly"`, the code before #76):

   1. The projection reaches block 1. The tick fires and the message is held.
   2. Three seconds pass and the deadline wakes the loop. The pass resets the tick and ends.
   3. The message is still held and its deadline still past, so the timer made for the next pass is due at once.

   In the code, `a_held_fee_answer_goes_out_after_its_block_or_at_the_deadline_exactly_once` (`crates/server/src/ws/mempool/tests.rs`) walks the second and third on a paused clock.

## What it does not cover

- **The three other holds.** The projected feed (`projected_feed` in `ws/mempool.rs`) and the two `/api/v1/ws` publishers (`mempool_blocks` and `drawings` in `ws/v1.rs`) each hold their messages for a block in code of their own. They differ from this one: `serve` and `mempool_blocks` start a new hold for each message, while `projected_feed` and `drawings` hold once per disagreement and then let every message through until the block is announced.
- **A loop that runs late.** In the model the clock stops while a branch of the `select!` is ready. The real task can be busy with a batch of arrivals, or not scheduled, when the deadline comes, so a message can wait a little past `HOLD` by the wall clock. `OutByTheDeadline` says the loop never chooses to wait longer; when the late pass does run, `serve` sees the hold has ended and publishes.
- **That a message goes out at all.** The model checks what may never happen. A loop that stopped is the server's shutdown.
- **What the answer says**, the fallback to the node's estimates (which is on no block, so never held) and the route's stored answer.
- **Lagged streams.** A lagged projection stream resubscribes and resets the tick, which the model reads as `SeeProjected`.
- **Whether the code is the model**: see the `verify-models` skill.
