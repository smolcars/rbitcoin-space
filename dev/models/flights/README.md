# Requests sharing one call

Identical requests share one piece of work in three places, each with a map that holds the call while requests hold it:

| `Policy` | Code | A new request joins | The map lets go |
|---|---|---|---|
| `api` | `Flights` in [`crates/server/src/esplora.rs`](../../../crates/server/src/esplora.rs): `/api` requests sharing a node call | a call that is unanswered, or a hot path's answer within its TTL; else it starts a new call in its place | when the last holder leaves, unless the answer is still fresh |
| `kept` | `Answers` in [`crates/server/src/answers.rs`](../../../crates/server/src/answers.rs): requests sharing a computation whose answer is kept | whatever the map holds | when the last holder leaves |
| `cards` | `Cards` in [`crates/server/src/cards.rs`](../../../crates/server/src/cards.rs): requests sharing a link preview card's build | whatever the map holds | when the last holder leaves, or the first to leave a build that is drawn |

All three count the holders in the map's entry, under the map's lock. [`Flights.tla`](Flights.tla) is that bookkeeping as a model, checked for each of the three in every order its steps can happen, for four requests to one key ([`docs/CI.md`](../../../docs/CI.md#models)).

## The rules

| Rule | In plain words | What breaking it costs |
|---|---|---|
| `NothingLeftBehind` | The map never keeps a call that no request holds, except a hot path's last answer | Every key ever asked stays in memory: the map is no longer bounded by the requests in flight |
| `OneCallAtATime` | Requests for one key never wait on two calls at once | The node, the store or the card drawer does the same work twice or more for one question ([`SECURITY.md`](../../../docs/SECURITY.md) rule 8) |

## The steps and the code

A step in the model is one hold of the map's lock in the code, or something that needs no lock. If a change splits one of these into two holds of the lock, or moves work out from under it, the model must change with it.

| Model | `api` | `kept` | `cards` |
|---|---|---|---|
| `Join` | `Flights::join` | `Answers::join` | `Waiting::new` |
| `Answer` | the `get_or_init` in `Flights::run` finishing; `Done::at` is when | the one in `Answers::serve` | the one in `Cards::serve` |
| `Expire` | time passing a `Done`'s TTL, read as `d.at.elapsed() < ttl` | | |
| `Leave` (`LeaveFixed`) | `Drop for Leave` | `Drop for Leave` | `Drop for Waiting` |
| `DropHandle` | `run`'s own `cell` going out of scope after `_leave`, outside the lock | | |

`Join` and `Leave` are each one whole hold of the lock. `Leave` runs however the request ends: answered, hung up on, or timed out. Only the mistakes below read `DropHandle`.

## The mistakes it must catch

Each is the model with one step written wrongly, and the check fails unless each still breaks its rule.

1. **Counting holders by the call's handles** (`Variant = "handles"`, the code before #88). A request checked `Arc::strong_count` under the lock and let go of its own handle after it. Two requests leaving together each still saw the other's handle, and neither removed the call:

   1. Requests 1 and 2 join the same call.
   2. Request 1 leaves: three handles (the map's and both requests'), so the call stays.
   3. Request 2 leaves before request 1 has let go: still three handles, so the call stays.
   4. Both let go. Nobody holds the call and the map keeps it.

   In the code, `the_last_request_out_removes_the_call_whatever_the_order` walks these steps and `requests_leaving_together_leave_nothing_behind` meets them on real threads.

   A card's build counted handles too until this model covered it. It was safe only while every handle was taken and let go under the map's lock, which a comment asked the next editor to keep true. The model's `cards` policy with `Variant = "handles"` is that rule broken, and `a_build_goes_with_its_last_waiter_though_a_handle_outlives_it` walks it in the code.

2. **Releasing whatever call the map holds** (`Variant = "anycall"`, never shipped). Without `Arc::ptr_eq`, a request still holding an answered call releases the newer call that replaced it:

   1. Request 1 joins a call and the node answers it. On a path that is not hot the answer is stale at once.
   2. Request 2 asks: the answer is stale, so a new call replaces it.
   3. Request 1 leaves and takes request 2's call out of the map.
   4. Request 3 asks and starts a third call while request 2 still waits on the second.

## What it does not cover

- **Four requests, one key.** Keys share nothing but the map, and each step touches one key's entry.
- **That a waiting request is answered.** The model checks what may never happen, not that something does. `tokio::sync::OnceCell` hands a dropped driver's work to the next waiter; that is its promise, not checked here.
- **What a kept answer's version means.** `Answers` keys a computation by its path and the store's version, so the model's one key is one version.
- **The other places that share a call.** Heavy reads (`HeavyCalls` in `esplora.rs`), block summaries (`summary.rs`), Bark lookups (`ark_bark.rs`) and the Arkade client (`crates/arkade`) share through a channel or keep no count of holders.
- **Whether the code is the model.** The check records the text of the code it was last read against, and fails when that text changes. A person or agent then compares them: the `verify-models` skill says how.
