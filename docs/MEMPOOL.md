# Mempool tracking

rbitcoin v0.9.2 has no mempool push, so `engine::mempool` polls the node, keeps its own copy of the mempool in memory and publishes the changes. Projected blocks, the live feed, fee recommendations, transaction tracking and the mempool charts are built on what it emits.

Measurements below are from a synced mainnet node on a private network, 2026-11-12, with about 55,000 transactions in its mempool. RPC and Esplora costs that other parts of the project rely on are in [`RBITCOIN.md`](RBITCOIN.md).

## Shape

| Part | File | Does |
|---|---|---|
| Model | `crates/engine/src/mempool/model.rs` | The state, the diff, removal classification and delta application. Pure: no I/O, no clock |
| Shell | `crates/engine/src/mempool/tracker.rs` | One loop that probes, lists, fetches and publishes; the subscriber API; the events |
| Proof | `crates/engine/examples/mempool_watch.rs` | Runs the tracker against a live node and prints its events |
| Projected blocks | `crates/engine/src/projected/` | The node's chunks packed into the next blocks; see [Projected blocks](#projected-blocks) |
| In the server | `crates/server/src/ws/mempool.rs` | Runs both per network and feeds the WebSocket; see [In the server](#in-the-server) |

```rust
let (tracker, task) = Tracker::start(NodeSource { rpc, esplora }, Config::default());
let (snapshot, mut sub) = tracker.subscribe(|m: &Mempool| /* copy what you need */);
while let Ok(delta) = sub.recv().await { /* delta.seq == previous + 1 */ }
tracker.block_found(tip);       // a block the node announced: what it confirms leaves at once
tracker.tip_changed();          // poll now (after a reorg or missed announcements)
tracker.read(|m| m.get(&txid)); // a point lookup
tracker.read(|m| m.links(&txids)); // which of these spends which, from the inputs held
tracker.events();               // statistics and abnormal conditions, for logging
task.abort();                   // stop polling
```

## The record

One per mempool transaction, keyed by txid:

| Field | Bytes | From | For |
|---|---|---|---|
| txid (the key) | 32 | listing | everything |
| fee | 8 | `getmempoolentry` `fees.base` | fee rates, charts, feed |
| total output value | 8 | the raw transaction | the live feed |
| vsize, sigop-adjusted | 4 | `getmempoolentry` | fee rates, projected blocks |
| weight | 4 | `getmempoolentry` | block fill |
| size | 4 | the raw transaction | the projected blocks' byte size (`/api/v1/fees/mempool-blocks`) |
| accept time | 4 | `getmempoolentry` `time` | "first seen"; it is the node's, so it survives our restarts |
| signals replaceability | 1, in padding | the raw transaction: an input's sequence below `0xfffffffe` (BIP 125) | the replacement trees' `rbf` ([`API.md`](API.md#transactions)). rbitcoin replaces regardless |
| flags | 8 | the raw transaction, and the replacement bit when the tracker sees it replace another ([`API.md`](API.md#transaction-flags)) | the projected blocks' records, so both sockets can tell transactions apart by kind |
| output count | 4 | the raw transaction | finding children of a removed transaction |
| input fingerprints | 16 + 8 per input | the raw transaction | finding what replaced it |
| outputs as kept | in the inputs' allocation, 0 in the slot | the raw transaction | saying what changed when it is replaced ([below](#outputs-kept-for-the-compare-view)) |

The value is kept for every transaction rather than only the newest: it costs 8 bytes and arrives free with the inputs, which are needed anyway.

Input fingerprints are 64-bit SipHash values of each spent outpoint under a random key chosen at startup, not the 36-byte outpoints: an attacker cannot grind a collision without the key, and a chance collision across a whole mempool is about one in 10⁸.

Everything else is fetched on demand from the node: ancestors, descendants and cluster chunks (`getmempoolcluster`), scripts and addresses (Esplora).

**Cost.** The hash-map slot is 96 bytes. At 300,000 transactions the table has 524,288 slots (one control byte each), about 51 MB, plus the inputs on the heap: about 61 to 63 MB in all, or roughly 209 to 214 bytes a transaction (measured below, without outputs). On mainnet at 55,000 transactions the whole process, runtime and HTTP clients included, measured 32–48 MB RSS over a 15-minute run.

### Outputs kept for the compare view

The node forgets a replaced transaction at once, so what changed between two versions (who was paid more or less, which output appeared or vanished) can only be told from outputs kept while it waited. Every mempool transaction's outputs are kept, for the few that are replaced (`crates/engine/src/outputs.rs`):

- **Per output:** the value as a LEB128 number (3 to 5 bytes for usual amounts), a 1-byte tag, and the script in full up to 34 bytes, which every standard address form fits (P2WPKH 22, P2SH 23, P2PKH 25, P2WSH and P2TR 34). A longer script (bare multisig, `OP_RETURN`, anything odd) is kept as its length and the first 16 bytes of its SHA-256: enough to tell two scripts apart, 128 bits so a look-alike cannot be ground out, and never more than the script itself.
- **At most 32 outputs** (`MAX_OUTPUTS`). Wallet payments and fee bumps have two or three; 32 still covers small batched payouts. Past it only the count is kept, and the compare view says this version has too many outputs to compare. One transaction's kept outputs never take more than 1,440 bytes.
- **No bigger slot, and one copy.** The outputs are packed into the end of the allocation that already holds the input fingerprints, and their length in words fits in the record's padding: `size_of::<(Txid, TxInfo)>()` stays 96, which a test holds. That allocation is an `Arc<[u64]>`, the same 16-byte pointer as a `Box`, so the map and the delta that added a record share it instead of each holding a copy (a test holds that too); it costs a 16-byte header per transaction on the heap.
- **A budget for every allocation alive:** at most 32 MiB of kept outputs per tracker (`KEPT_OUTPUTS`), decided where outputs are encoded, as each transaction's details arrive. What counts against it, at every decision: the records the map holds; the records fetched and waiting to be published (a fetch that fails keeps them for the retry, and they still count); and every record that left the map whose allocation anything still holds, found exactly: the tracker keeps a `Weak` handle on each, and drops it from the count once nothing holds it (checked at each fetch). Anything holds one: a delta in the subscribers' channel, a delta a subscriber took and keeps (the projected blocks gather a batch and pack it on another thread), a copy the transaction follower is folding in. Records still in the map are counted once, however many deltas share them. A transaction whose outputs do not fit is held without them, and their encoding is dropped at once, never stored; a replacement of it says they were not recorded. `mempool_summary` reports what the map's take (`outputs_kept_bytes`) and arrivals published without them (`outputs_unkept`) ([`LOGGING.md`](LOGGING.md#the-live-mempool)).

What it costs, **measured** with `KEPT=on|off MIX=mainnet|wallet cargo test --release -p engine --lib -- --ignored --nocapture kept_outputs_memory` (a synthetic mempool of 300,000 transactions built through the tracker's own record, each copy with its own inputs and scripts; resident memory before and after, one process per run, 2026-11-18):

| Mix | Outputs a transaction | Kept outputs | Resident, with | Resident, without | More per transaction |
|---|---|---|---|---|---|
| `mainnet`: the 48 non-coinbase public mainnet transactions of `fixtures/flags/mainnet.json` in turn (chosen for their flags, so not a fair sample of the mempool) | 1.56 | 13.3 MB, 44 bytes a transaction | 74.5 MB | 61.2 MB | 45 bytes (+22%) |
| `wallet`: one or two inputs paying two P2WPKH or P2TR outputs | 2.00 | 20.4 MB, 68 bytes a transaction | 82.4 MB | 62.5 MB | 68 bytes (+32%) |

"Without" is the shared allocation holding only the inputs: 1.0 to 2.4 MB more at 300,000 transactions than the unshared one it replaced measured (60.2 and 60.1 MB), the `Arc` header. So, **computed** from the per-transaction figures: at mainnet's usual 55,000 transactions, 2.5 to 3.7 MB more; at 300,000, 13 to 20 MB more.

**What the budget bounds, and what it does not.** Enforced by the code: the kept-output bytes in every live allocation the tracker made never exceed 32 MiB (33,554,432 bytes), whatever the mempool holds and however far behind a subscriber falls. Not counted in it, each stated with its bound:

- **The tracker's own bookkeeping** of removed records still held: 24 bytes each (a `Weak` handle and the byte count), one per removed record with outputs that something still holds, gone at the tracker's next delta or fetch after the last holder lets go (a handle kept longer would pin the record's memory: until the tracker's next cycle, and for as long as the node does not answer, since a tracker that cannot reach its node makes neither a delta nor a fetch). The list gives its own memory back once it is mostly empty, so a block or a restarted node that removes a whole mempool at once (300,000 handles, 7.2 MB) leaves no more than 1,024 handles' room (24 KB). Each such record is held by a delta, which itself holds the record's 96-byte entry and its inputs, kept outputs or not; the bookkeeping is a quarter of that or less.
- **Allocator rounding:** an allocation that holds outputs can round up by up to 15 bytes more than it would without them: at most 4.5 MB for 300,000 transactions in the map.
- **One encoding in flight:** a transaction's outputs are encoded before the budget is asked whether they fit, at most 1,440 bytes, freed at once if they do not.
- **The replacement record's copies**, bounded by `REPLACEMENTS_KEPT` ([below](#following-a-transaction)).

So the most the kept outputs can take is 32 MiB plus the rounding, about 38 MB at 300,000 transactions, plus 24 bytes for each removed record a lagging subscriber still holds. A full 300 MB mempool of output-heavy transactions reaches the budget, and the rest of it is held without outputs. No mainnet node was at hand: mainnet's real figure is to be read from `outputs_kept_bytes`.

## Initial sync

The record needs the inputs, and only a transaction's bytes have them: no listing or entry call returns them. That rules out the verbose `getrawmempool` (5.7 s and 39.5 MB on mainnet) as a shortcut, since it would still leave every transaction's bytes to fetch.

rbitcoin takes a JSON-RPC array as one request and one work-queue slot, so details are fetched in batches. Measured on mainnet:

| Way to get details | Time | Bytes |
|---|---|---|
| One `getmempoolentry` | 10 ms | 0.7 KB |
| One Esplora `/tx/:txid` | 11 ms | 1.3 KB |
| Batch of 1,000 `getmempoolentry` | 214 ms | 0.7 MB |
| Batch of 1,000 `getrawtransaction` (hex) | 305 ms | 5.0 MB |
| Both for 1,000 txids in one array | 425 ms | 5.3 MB |

One transaction at a time would take 55,000 × 10 ms: nine minutes on one connection. Batches take seconds.

The tracker sends, per batch of 500 txids, a `getmempoolentry` array and a `getrawtransaction` array in parallel, with two batches in flight: four requests, a quarter of the node's 16 work-queue slots, and the RPC client's own default limit. A batch over the client's 64 MB response cap is halved until it fits; a single transaction that still does not fit (none can: the largest is 8 MB of hex) would be skipped like a vanished one.

**Measured:** 54,509 transactions in 10.4 s: 229 calls (220 of them detail arrays, plus the probe, the listing, the tip and six blocks) and 252 MB read, about 4.6 KB a transaction, almost all of it raw transaction hex. No call failed and none answered `Busy`.

### Over a unix socket

The bulk `/internal/mempool/txs` routes exist only on rbitcoin's unix-socket Esplora listener. They are not used, because they would not save anything:

- They return Esplora's transaction JSON, which measured 6.2 times the size of the raw bytes over 30 sampled mainnet transactions.
- They carry neither the node's accept time nor its sigop-adjusted vsize, so the `getmempoolentry` batch would still be needed.
- The RPC batch already moves everything in one request per 500 transactions.

So both transports use the same RPC path. Not measured against a real unix socket: no shared node exposes one to this machine.

## Steady state

Each cycle:

1. **Probe:** Esplora's `/mempool/recent` (the ten newest arrivals' txids, 1.1 KB, 2–4 ms on regtest), then `getmempoolinfo` (10 ms, 0.4 KB). If the txids and the size, vsize total and fee total equal the ones taken before the last full cycle, and no tip hint arrived, and the last full cycle is under 10 s old, stop here. The list is read first so that a transaction arriving between the two reads is in the totals and not in the list: every later list then differs, and the next probe lists again. The other way round it would be in the list and not in the totals, and the eviction of a twin before the next probe would match both. The list is asked only after a good cycle with no failure since; otherwise the probe has none, and a probe without one never skips and is never skipped against, so the first cycle after start or after a failure is followed by one more listing, and a node that is down is not asked twice per retry.
2. **List:** `getrawmempool` with `mempool_sequence` (110–250 ms, 3.6 MB at 55,000 transactions).
3. **Tip:** Esplora's tip hash, stamped with its height (18 ms).
4. **Blocks:** the six most recent blocks on the active chain ending at that tip, fetched with Esplora's raw-block route (98 ms, 1.6 MB a block) only when not already held. Usually zero; one per new block.
5. **Diff** the listing against the model: added and removed txids.
6. **Fetch** details for the added ones, as in the initial sync.
7. **Classify** the removals, build one delta, apply it and publish it.

**Cadence.** A cycle starts at least 1 s after the previous one started, and never sooner after the previous one ended than that one took, so the tracker spends at most half its time talking to a slow node. After a cycle in which a listed transaction's details could not be read, the next cycle lists again whatever the probe says. One loop does everything in order: a cycle can never overlap another, and nothing queues behind a slow node. On failure the wait doubles from 2 s to a cap of 30 s, and comes back to 1 s on the next success. A hint (`block_found` or `tip_changed`) skips the wait but never interrupts a cycle in progress; what `block_found` does is in [When a block is found](#when-a-block-is-found).

The probe saves the 3.6 MB listing whenever the mempool did not move. On mainnet it almost always has, so the listing runs about once a second. Any change moves one half of the probe: a removal on its own moves the count, and any arrival moves the newest arrivals. The totals alone did not do: a transaction of exactly the size and fee of one a block or an eviction had just taken left them unchanged, so it went unseen until the 10 s heartbeat, often long enough to be mined before the tracker listed it (on regtest, identical payments sent just after a block: 6 of 12 never seen in the mempool, 2 more seen after 3 s; with the newest arrivals, all 12 within 1 s). A replacement alone cannot collide, since it must pay more than all it replaces. Whatever the probe still cannot see (an arrival the node does not list as recent, a probe whose `/mempool/recent` failed, which never skips) is caught by the hint, a full cycle or the 10 s heartbeat.

**What the probe costs.** Before 2026-11-14 it was `getmempoolinfo` alone; `/mempool/recent` adds one call of 1.1 KB, under 4 ms on regtest and indistinguishable from the tip height's round trip through the live site on mainnet. On an idle mempool, where most probes skip, a skipped probe reads 1.5 KB instead of 0.4 KB, about 1 KB/s more per network. On a busy one, where the 3.6 MB listing runs nearly every cycle anyway, it is 1.1 KB on top of 3.6 MB, 0.03%. The skip saves as much as before: the newest arrivals change only when something arrives, and then the totals had changed too in all but the collisions above.

**Measured** over 15 minutes on mainnet, 54,000–55,000 transactions, one block, and a node restart that nobody planned:

| | |
|---|---|
| Cycles | 610 in 900 s, one every 1.5 s on average |
| A typical cycle | 5 calls (probe, listing, tip, entry array, raw array), 3.6–3.7 MB, 170–440 ms; one more since the probe also reads `/mempool/recent` |
| The block cycle | 4 calls plus one block, 5.0 MB, 284 ms: 3,502 confirmed, 3 replaced, 0 evicted |
| Total read | 2.48 GB, the initial sync included: about 2.5 MB/s, nearly all of it the listing |
| Our count against `getmempoolinfo` | equal at 23 of 28 checks, 1–4 short at the others: transactions that arrived between our cycle and the check. Summed vsize and fees matched to the satoshi whenever the counts did |
| Removals | 3,502 confirmed, 45 replaced, 163 evicted |
| Node restart | 3 failed cycles (connection refused, retried after 2, 4 and 8 s), then `SequenceRegressed` from 110,704 to 54,650 and exact agreement on the next check |

The listing is the price of having no event stream: at one a second it is the whole steady-state cost.

## Why a transaction left

Each removal gets one reason, decided in this order:

1. **Confirmed** if its txid is in one of the six recent blocks. Exact.
2. **Replaced by X** if X spends one of its inputs, where X is a transaction in one of those blocks or one that entered the mempool in the same cycle. Exact: two transactions spending the same outpoint conflict, and the node cannot hold both, so the replacement enters in the cycle where the original leaves.
3. **Replaced by X** if it spends an output of a transaction replaced by X in the same cycle: a descendant leaves with its replaced ancestor. Repeated until no more are found.
4. **Evicted** otherwise.

A replacement that entered in the same cycle gets the replacement bit in its flags, in the delta that adds it. A restart forgets it: the tracker's first listing has no removals to classify.

The window of six blocks is there because a listing and the tip read after it are not atomic: a transaction confirmed just after a listing is removed one cycle later, and its block must still be at hand. A reorg needs nothing special: the window is walked back from the new tip, so it only ever holds the active chain, and transactions from disconnected blocks come back as additions.

### Where it can only infer

- **Evicted, expired and dropped are one reason.** The node does not say why it dropped a transaction. Size eviction, the two-week expiry, and dropping after a reorg made a transaction invalid all read as `Evicted`.
- **A replacement that came and went inside one cycle.** If A is replaced by B and B by C within one poll interval, A is shown replaced by C when C still spends one of A's inputs (the usual fee bump keeps them). If C spends none of A's inputs, the link is lost and A reads as `Evicted`.
- **A replacement whose details vanished.** If B replaced A and then left before its details were read, A reads as `Evicted`.
- **Blocks older than the window.** A transaction confirmed more than six blocks before the cycle that removes it reads as `Evicted`. This needs the tracker to have stalled for six blocks.
- **A descendant of a confirmed or evicted transaction** that leaves gets its own classification, not its parent's.

## The change stream

Every delta has a `seq` that counts up by one from 1. `Tracker::subscribe` runs a closure on the current state and registers the subscriber while holding the state's read lock, and the tracker applies and sends each delta while holding the write lock. So the first delta a subscriber receives is exactly the one after its snapshot: no gap and no duplicate.

Subscribers share one bounded ring of 64 deltas. One that falls further behind receives `Lagged`, never a growing queue; it takes a new snapshot. A large delta, such as the initial sync's, is held only until every subscriber has read it or it is pushed out of the ring.

A delta carries the added transactions with their records, the removed txids with their reasons (both sorted by txid), the records the replaced ones had (so a reader can say what a replacement replaced after it has left), the node's `mempool_sequence` for the listing, and the chain tip read after it. A cycle that changes nothing publishes nothing.

## Failures

| Condition | What happens |
|---|---|
| A call fails, times out or is `Busy` | Nothing from that cycle is published. Details already fetched are kept for the retry, so a long initial sync never starts over. The wait backs off |
| A slow node | The next cycle waits as long as the slow one took. Calls are bounded by the RPC client's timeout and concurrency limit |
| A transaction leaves between the listing and its details | It is skipped and counted as `vanished`. If it is somehow still listed, the next cycle fetches it again |
| Any single transaction answers an error | Treated like a vanished one: one odd transaction can never stall the loop |
| The node restarts, its sequence goes backwards | Reported as an event. The diff does not rely on the sequence, so nothing else changes |
| The mempool empties | Every transaction is removed, classified as above |
| A reorg | Handled by walking the block window from the new tip |

None of these panics, and each leaves the model correct after the next successful cycle.

## What is exposed for logging

The tracker logs nothing itself. `Tracker::events()` yields:

| Event | Fields |
|---|---|
| `Cycle` | per cycle: duration, response bytes, node calls, probes skipped since the last cycle, txids listed, added, vanished, removed by reason, blocks fetched, model size, `mempool_sequence`, tip, published `seq` |
| `Block` | per block applied from its own transactions: the same fields, nothing listed or added, and the time from `block_found` to the delta |
| `Synced` | once, after the first complete cycle: duration from start, transactions, bytes, calls |
| `PollFailed` | the error, consecutive failures, the wait before the retry |
| `SequenceRegressed` | old and new `mempool_sequence` |
| `SubscriberLagged` | how many deltas the subscriber missed |

Byte counts come from response-body counters in the node clients, so give the tracker its own clients if they should count only its traffic.

## With a mempool event stream

An event stream from rbitcoin (added, removed with a reason, a sequence number) is on the upstream wishlist in [`RBITCOIN.md`](RBITCOIN.md). With it:

- The 3.6 MB listing every second goes away, and with it the up-to-one-interval delay before a new transaction appears.
- Removal reasons become the node's own. `Evicted` splits into eviction, expiry and the rest; the cases above where a replacement is lost stop existing.
- The input fingerprints, output counts and block window exist only to classify removals, and could be dropped: 20 bytes plus 8 per input for each transaction, and six held blocks.
- The initial sync stays: an event stream still needs a starting snapshot, and the sequence number would let us join the two without a gap, the same way subscribers join this tracker.

## Projected blocks

`engine::projected` turns the tracked mempool into the blocks that would be mined next: the left half of the block strip, the answer to "which block will my transaction be in", and the basis of fee recommendations and block audits.

```rust
let (projector, task) = Projector::start(tracker.clone(), rpc, Config::default());
let (projection, mut sub) = projector.subscribe(); // Arc<Projection>: blocks, records, totals
while let Ok(delta) = sub.recv().await { /* delta.seq == previous + 1 */ }
projector.position(&txid);   // its block, and the vsize and transactions ahead of it
projector.group(&txid);      // its cluster as the node last told it: chunks, fees, members
projector.expected(&parent); // our first block as it stood on `parent`, for auditing the block mined on it
projector.events();          // statistics and abnormal conditions, for logging
task.abort();
```

| Part | File | Does |
|---|---|---|
| Model | `crates/engine/src/projected/model.rs` | Chunks, their order, packing into blocks, summaries. Pure: no I/O, no clock |
| Shell | `crates/engine/src/projected/projector.rs` | Follows the tracker, asks the node for changed clusters, packs off the async runtime, publishes |
| Proof | `crates/engine/examples/projected_watch.rs` | Runs both against a live node and scores the first block against the node's template and against real blocks |

### What comes from the node and what is computed

rbitcoin mines by cluster-mempool chunks: each cluster is linearized and cut into chunks, and a template takes chunks best first. Its `COMPAT.md` says how its linearization differs from Core's, which is why we ask instead of linearizing ourselves.

**From the node: every chunk.** `getmempoolcluster` answers a transaction's whole cluster as chunks, each with its fee, sigop-adjusted weight and members in mining order. The projector asks it, in batches, for:

- every transaction the tracker adds (its cluster may now include older transactions it lifts);
- the remaining members of the cluster of every transaction the tracker removes (the cluster may have split, or lost the child that lifted a parent);
- a cluster whose answer named members the tracker has not shown us yet, again at the next update;
- every cluster, once per block, right after the block's update is published and once the tracker has nothing more to fold in, so in a burst each block's own update goes out first. Anything we cannot see change, such as a `prioritisetransaction` on the node or a lost recheck, is corrected within a block.

It asks once per cluster as far as it knows them: each answer covers its members, and later rounds ask only for what is still uncovered.

**Computed: packing the chunks into blocks, by the node's own rule.** A template sorts chunks by their rate (in whole sat per 1,000 vB, rounded down, on sigop-adjusted size), then by fee, both descending; takes each chunk that still fits 3,992,000 raw weight units (4,000,000 less 8,000 for the coinbase); skips one that does not and keeps trying the rest, so small cheap transactions fill the gap at the end; leaves out chunks under `-blockmintxfee` (1 sat/kvB); and pulls in a chunk's unselected ancestors. We do the same per block, for `Config::blocks` blocks (8 by default), the last taking everything left: the "+N blocks" tile.

A transaction's **effective fee rate** is the rate of its chunk. A low-fee parent lifted by a child carries the child's chunk rate and lands where the node would put it.

Why not the other calls:

| Call | Why not, on every change |
|---|---|
| `getblocktemplate` | Only the first block, and 450 ms and 4.2 MB a call (measured). At one call per update that is about 175 MB a minute, more than the tracker's own listing, for an answer we already match (below) |
| `getmempoolfeeratediagram` | Every chunk in order, but no txids: it cannot say which transaction is where. Our chunks match it: same count at every check, and the fixture test replays its top 118 points exactly |
| `getmempoolentry` | Has the chunk's fee and weight but not its members or order; it would have to be fetched again for every transaction whose chunk changes |

### Agreement with the node

Measured on mainnet, 2026-11-12, 53,000–56,500 transactions, read-only, with `projected_watch` scoring our first block against `getblocktemplate` every 30 s (only when the node's template sits on our tip) and against every block that arrived.

**Against the node's template, 41 checks over 21 minutes:**

| | By transaction | By weight |
|---|---|---|
| Raw: share of the template in our first block | mean 90.3%, lowest 80.6% | mean 93.9%, lowest 83.2% |
| Tie-aware | mean 99.99%, lowest 99.74% | mean 99.98%, lowest 99.72% |

Everything the two disagree on sits in one fee-rate class at the block boundary: thousands of chunks with the same rate and fee (0.124 sat/vB at the time), among which the node picks in hash-map order. "Tie-aware" counts a template transaction we placed one block later as agreeing when one of ours the template left out has the same rate and fee. Above the boundary our first block is the template, transaction for transaction.

**Against real blocks** (share of the block that was in our first projected block just before it):

| Block | By transaction | By weight | Tie-aware, by weight | Never reached our mempool | We had placed later |
|---|---|---|---|---|---|
| 975,521 | 65.8% | 71.7% | not measured | 0.22% of weight | not measured |
| 975,522 | 94.9% | 95.5% | 97.6% | 0.23% | 2.1% |
| 975,523 | 84.4% | 94.8% | 98.3% | 0% | 1.7% |

A miner builds from its own mempool and its own policy, breaks the same ties its own way, and some take transactions out of band, so a real block is a looser target than the node's template.

### Cost

Same runs, the server and node on one private network.

| | |
|---|---|
| First projection | 55,400 transactions: 12 cluster requests (5,571 clusters asked), 6.0 MB, 0.88 s, on top of the tracker's initial sync |
| A typical update | one request asking about 15 clusters, a few KB, 4–6 ms; then packing, mean 19 ms, worst 172 ms, on a blocking thread |
| Each block | one update for the block (about 17 clusters), then every cluster again: about 12 requests, 6 MB, 0.5 s |
| Calls and bytes added to the node | 43 requests a minute and 340 KB a minute over 21 minutes with one block: about 40 KB a minute between blocks plus 6 MB a block. The tracker reads about 150 MB a minute |
| Deltas | mean 199 records; the block's delta set 13,926 records and removed 2,664 |
| Memory | the tracker alone 39 MB RSS; tracker and projector 80 MB at 56,469 transactions, so about 40 MB, or 700 bytes a transaction, the published projection included. Measured before the flags, which add 32 bytes a transaction across the tracker, the model and the published records (computed) |

Packing holds the projector's write lock, so a `position` lookup can wait for one pack. Nothing runs on the async runtime's threads but the network calls.

### The records and the stream

One record per transaction, 57 bytes on the wire:

| Field | Bytes | Is |
|---|---|---|
| txid | 32 | the key |
| block | 1 | projected block, 0 for the next; the last block holds the rest |
| rate | 4 | effective fee rate in sat per 1,000 vB: the rate of its chunk, the node's own number |
| vsize | 4 | sigop-adjusted virtual size |
| fee | 8 | its own base fee in satoshis |
| flags | 8 | the tracker's flags for it, and paid for by a child or pays for a parent: its own fee over vsize against its chunk's members' summed, when the chunk holds two or more and they differ by more than 10% ([`API.md`](API.md#transaction-flags)). A change to them is a change to the record |

Each block also has totals: transaction count, raw weight, vsize, fees, the lowest, median (at the middle vbyte) and highest effective rate, and the vsize in each of the 12 fee bands of `docs/DESIGN.md` (edges at 0.12, 0.15, 0.2, 0.3, 0.5, 1, 1.5, 2, 3, 5 and 10 sat/vB). A rate is banded as it prints, rounded to two decimals, so 0.1196 sat/vB takes band 2 (0.12–0.15) and 0.1996 band 4 (0.2–0.3). How the store keeps them is in [`STORE.md`](STORE.md#fee-bands).

The stream works like the tracker's: `subscribe` returns the current projection and a subscription whose first delta is the next one, deltas are numbered without gaps, and a subscriber more than 64 deltas behind gets `Lagged` and subscribes again. A delta carries the records that entered, moved to another block or changed rate or flags (`set`), the txids that left the mempool (`removed`), both sorted by txid, and every block's new totals. Applying `removed`, then `set`, to the previous projection's records gives the next one's; a test checks this against a running tracker. Order inside a block is not in the delta: it is by rate, and a client sorts by it. Ties keep no meaningful order (see below).

A new block moves nearly every record in the projected blocks one block forward: 14,000 to 25,000 records (0.8 to 1.4 MB at 57 bytes), once per block. A WebSocket hub may prefer to send a fresh snapshot then.

When the tip moves, the first block of the last projection on the old tip is kept as `Expected` (six of them), so the block mined on that tip can be audited against what we expected ([Block audits](#block-audits)). With it are whether that projection was `stale`, the tip it gave way to (`next`) and when (`at`), and `left`: every transaction it held, in any block, that the first projection on `next` no longer holds, with the rate it was placed at. That list is about one block's transactions (some 4,000, 36 bytes each on mainnet), so the six cost under a megabyte.

### Failures and odd cases

| Condition | What happens |
|---|---|
| Empty mempool | Every block is empty, with zero totals |
| Smaller than a block (signet, testnet4, Testnet 5, regtest) | Everything in the first block; the rest empty |
| A cluster request fails or answers `Busy` | The affected transactions keep their last chunks, `stale` is set on the projection and in its deltas, and nothing is asked until the backoff ends (2 s, doubling to 30 s), however often the tracker publishes. New transactions wait with the rest, placed by their own fee rate |
| The tracker's own cycles fail (the node is down) | The last good projection stays, marked `stale` until the tracker's next good cycle |
| A transaction left between the tracker's listing and our request | Its slot answers "not in mempool": it keeps its record until the tracker removes it |
| Large clusters | Up to 64 transactions (rbitcoin's limit): one answer, a few KB |
| A reorg | Handled by the tracker; transactions from disconnected blocks come back as additions and are asked about like any other |
| The projector falls behind the tracker by more than 64 deltas | It takes a fresh snapshot, diffs it against what it has, and asks the node for every cluster again |

### Limits

- **Ties at the boundary.** The node breaks ties between chunks of equal rate and fee in hash-map order, which nobody outside the node can know. Mainnet mempools now hold thousands of identical chunks at one rate, and when the block boundary falls inside such a class, which of them make the first block is arbitrary. The miner's own node picks among them by its own order anyway, so no explorer can predict that part. We break ties by age.
- **Sigops are not counted.** The template also stops at 80,000 sigop cost. We do not have each transaction's sigops; a mainnet template uses about 8,000, so the limit does not bind today.
- **Pulling ancestors.** We pull in a chunk's earlier, unplaced chunks of the same cluster, not only its ancestors, since the answer does not say which chunks depend on which. They differ only when an earlier chunk of a cluster did not fit and a later, independent one would.
- **`prioritisetransaction`** deltas are in the node's chunk fees and rates but not in the record's own `fee`, which is the base fee. A delta applied to a transaction whose cluster does not otherwise change shows at the next block's refresh.
- **One update behind.** The projection follows the tracker, so it trails the node by up to one tracker cycle (about 1.5 s) plus one cluster request. A new block is the exception: see [When a block is found](#when-a-block-is-found).

### What is exposed for logging

The projector logs nothing itself. `Projector::events()` yields:

| Event | Fields |
|---|---|
| `Update` | per update: tracker deltas folded in, clusters asked, node requests, response bytes, time waiting for the node, time packing, transactions, chunks, records set and removed, `stale`, the published `seq`, and `refresh` for the once-a-block refresh, whose records set and removed are what it corrected |
| `FetchFailed` | the error, consecutive failures, transactions pending, the wait before the retry |
| `Resynced` | the projector fell behind the tracker and rebuilt from a snapshot: transactions |
| `SubscriberLagged` | how many deltas the subscriber missed |

## In the server

`crates/server/src/ws/mempool.rs` runs one tracker and one projector per enabled network, from startup, unless `{NET}_MEMPOOL_ENABLED=false` ([`CONFIG.md`](CONFIG.md#the-live-mempool)).

- **Their own node clients.** The tracker gets its own RPC and Esplora clients and the projector its own RPC client, so the byte counts in their events are theirs alone. Each RPC client allows four calls in flight: with the shared client the API uses, at most twelve of the node's sixteen work-queue slots.
- **The tip hint.** A task follows the network's Electrum events: it hands every new block to `block_found`, and calls `tip_changed` after a reorg or when it missed events.
- **A node down at boot.** Nothing special: the tracker retries with its backoff (2 s doubling to 30 s), the projector waits for it, and the topics publish nothing until the first complete cycle. When the node comes back the initial sync runs and the topics start. A node lost later leaves the last projection in place, marked `stale`.
- **Shutdown.** When shutdown starts, the engines and their tasks are aborted, so no polling continues while sockets drain.
- **The topics** (`mempool`, `projected`, `projected-txs:N`, `transactions`, in [`WS.md`](WS.md#mempool-topics), and `tx:<txid>`, below) are fed by one task per network each from the latest projection and the tracker's change stream. No subscription asks the node for anything.
- **History.** With a `DATA_DIR`, a sampler per network (`engine::history`) stores the mempool's totals, its fee bands and the minute's flow (entered, left, confirmed, from the change stream) once a minute while the projection is current, and skips minutes when it is not. It asks the node nothing. The table, its retention and why a minute is skipped are in [`STORE.md`](STORE.md#mempool_history); the routes in [`API.md`](API.md#mempool-statistics).
- **The log.** The engines' events become typed lines ([`LOGGING.md`](LOGGING.md#the-live-mempool)): `mempool_synced` once, one `mempool_summary` a minute with the minute's totals, one `mempool_block` per block with its timings, and a line for each abnormal condition, repeats summarised at powers of two.

### Following a transaction

`crates/server/src/ws/track.rs` serves the `tx:<txid>` topic and `crates/server/src/relatives.rs` the relatives route ([`WS.md`](WS.md#following-a-transaction-or-an-address), [`FRONTEND.md`](FRONTEND.md#a-transactions-relatives-and-replacements)). Neither asks the node anything:

- **Where it is** is the tracker's record (accept time, fee, size) and the projected blocks' `position`.
- **Why it left** is the tracker's removal reason, taken from the change stream by one task per network while anyone follows the transaction, with the honesty of [Why a transaction left](#why-a-transaction-left): `evicted` also covers the cases where a replacement could not be seen. A transaction that left before anyone followed it, or while the task had fallen more than 64 deltas behind, reads `unknown` unless the replacement record knows it. A confirmation in a block that Electrum reports gone in a reorg is forgotten, and so is every remembered confirmation when Electrum reports it lost the chain's continuity (a reconnect, a reorg deeper than it follows). The task reads the engines on a blocking thread (a position lookup can wait for a pack) and publishes only from a reading at the tracker delta whose reasons it has folded in.
- **What it will be mined with** is the projected blocks' copy of its cluster (`Projector::group`), the node's own chunks, and which member spends which from the inputs the tracker holds (`Mempool::links`): one keyed hash per output of the cluster's members, at most 64 transactions.

**The replacement record** (`crates/engine/src/replacements/`, run from `crates/server/src/replacements.rs`) keeps every replacement the tracker reports, whether anyone follows it or not: the replaced txid, its replacement, when it was seen, both sides' own figures as the tracker held them (fee, size, weight, total output value, accept time, whether it signalled; the replacement's are missing when it was confirmed in the block that removed the original), each side's outputs as kept and input count, with how many inputs both spend (from the tracker's fingerprints; the compare view's evidence, below), and whether the replacement is confirmed, with its block's height and hash (seen leaving the mempool in a block, or found in one of the tracker's recent blocks: a replacement the tracker never held was in one, so its block is always known). A transaction that replaced its own replacement (a miner confirmed the original) ends the history: its old link is dropped, so every history has one newest end, and the figures that link held for it become the new link's replacement figures, so the tree's root keeps them. A transaction back in the mempool (rebroadcast, or returned by a reorg) no longer stands replaced, and what it replaced is no longer mined. Reorgs reach it as below. It is read as chains by the `tx:` topic and `/app`, and as trees (a replacement and everything it removed, recursively) by `/api/v1` ([`API.md`](API.md#transactions)). A child that left with its replaced parent is listed as replaced by the same replacement, so a tree shows everything one replacement removed, not only the transactions it conflicts with. It is bounded by `REPLACEMENTS_KEPT` (10,000 by default, about 4 MB with two-output payments): the oldest replacement goes first. A child that left with its replaced parent shares no input with the replacement: it is not an earlier version, so its link keeps no outputs on either side, and the compare view says why. Each side's outputs cost about 50 bytes a link for a two-output payment (measured below: 1.0 MB at 10,000 links); the most a link can keep is two sides of 1,440 bytes, 29 MB for 10,000 links (measured), which an attacker reaches only with 10,000 real conflicting replacements of 32-output transactions, each paying the relay fee for its size. On mainnet the tracker counted 45 replacements in 15 minutes on one run and 197 in 13 minutes on another (2026-11-12, children included, mostly in a burst), so the default reaches back between about half a day and two days; a burst shortens that.

**Versions.** Two transactions are versions of one another only if a path of version links joins them. A link is a version link unless it is known to be a child's: one whose replaced transaction shares no input with its replacement, so it left because a transaction it spent from was replaced. A link stored before shared inputs were counted (store migration 0021) counts as a version link. Being a child is a property of a link, not of a transaction: A bumped to B is a pair of versions even after Q replaces B's parent and removes B, though B's own link to Q is a child's. Each transaction has at most one link of its own, so the version links form trees, and two transactions are versions exactly when following version links forward from each ends at the same one (`Replacements::are_versions`). The line of versions the transaction page shows is that tree, oldest first, walked through version links only (`Replacements::versions`, at most 33), so no child, and nothing a child replaced, takes a place in it. A line longer than that keeps the transaction asked about, what replaced it (the pair its page compares first) and the versions nearest the newest, the newest always among them, and says versions were left out. On a transaction's page the comparison starts from its own link (this version and what replaced it), never from its neighbour in the list: where one transaction replaced two, the neighbour is a sibling. The list of links back from a transaction (`earlier`) walks every version link before any child's. The compare route answers only for two versions.

**It survives a restart when the server has a `DATA_DIR`.** Every change is also written to the store's `replacements` table ([`STORE.md`](STORE.md#replacements)), bounded by the same `REPLACEMENTS_KEPT`, and the record is read back from it when the mempool engine starts, before the first tracker delta is folded in. So the transaction page's "replaced by", the `tx:` topic and the `/api/v1` routes still know a replacement after the server restarts. Writing never slows the tracker or the task that follows it: each delta's changes are queued for one writer task per network without waiting, and dropped (memory keeps them, the log says so) if 64 writes are already waiting. Replacements that happen while the server is down are not seen: the node does not report them. Without a `DATA_DIR` the record lives in memory only and a transaction replaced before the start reads `unknown`.

**It follows reorgs from the tracker's own blocks** (`Replacements::follow`, `asks`, `answers`). Every tracker delta carries the window of recent blocks it was classified against (shared, not copied: six `Arc`s), and the task that folds deltas into the record hands it the window first. So the record learns of a reorg exactly when, and from the same chain, the tracker does; there is no second detector. A replacement is *mined* (in a block on the best chain, at the height and hash recorded), *not mined*, or *unknown* (its block left the best chain and where it is now is not known yet). With each window:

- **The usual case, a new block on the chain followed:** the window's tip is compared with the last one, and each new block's transactions are looked up in the record. A replacement there is mined there, though we never saw it leave the mempool (evicted, then mined after all). A replaced transaction there was confirmed itself (the original won, after a reorg or from a miner that never saw the replacement): it no longer stands replaced, and a client following it is told it is confirmed. Nothing is asked of the node.
- **Anything else** (a reorg, the first window after a start, more new blocks than the window) re-examines every mined replacement. Where the chains part is the highest block we knew (the last window, or any replacement's block) that the new window still shows. A replacement whose block the window shows gone is placed in the window's block that holds it; failing that, if the window shows where the chains part, it is not mined, because every best-chain block above that point is in the window; otherwise it is unknown. A one- or two-block reorg is always settled from memory.
- **What the window cannot settle is asked of the node,** one Esplora read at a time, stopping at the first failure: for each unknown replacement, its confirmation status (`/tx/:txid/status`); and, when the window does not show where the chains part, the hash at the height of the highest mined replacement below the window (`/block-height/:h`), walking down until a recorded block is still there, which proves everything below it. One reorg (or start) may cause at most `CHECKS` (100) reads, failed ones included. Past that, what is still unproven is *unknown* and stays so until the next reorg or until it leaves the record. A read that fails leaves the state as it is (unknown stays unknown; a mined replacement below the window is not called anything else until proven otherwise) and is tried again 30 s later. Answers that arrive after another reorg are dropped: that reorg re-examined everything again.
- **Readers can tell the three apart:** `mined` is `true`, `false` or `null` on the `tx:` topic's links and `/app/tx/:txid/replacements` ([`WS.md`](WS.md#following-a-transaction-or-an-address)), and `true`, absent or `null` in the `/api/v1` trees ([`API.md`](API.md#replacement-trees)). A change caused by a reorg is sent to followers at once.
- **Restarts:** the state, block included, is stored, so an unknown replacement is checked after a restart. The first window after a start cannot show where it parts from what was stored, unless a stored replacement's block is in it; then the walk down costs one read, or none.
- **Limits.** Links stored before blocks were recorded (store migration 0008) read mined with no block, and no reorg re-examines them; the record turns over within about two days. A replaced transaction confirmed by a reorg in a block below the window is not noticed: only its replacement's status is asked. Nor is a replacement that was not mined before such a reorg (it had left the mempool without confirming) and that the new chain confirms below the window: it stays not mined, as a replacement mined while the tracker was stalled for more than the window always has ([Where it can only infer](#where-it-can-only-infer)). Asking about every unmined replacement instead would cost up to `CHECKS` reads at every start, which also cannot see where the chains part, and leave the rest unknown. On mainnet a reorg cannot be arranged, so that path rests on the tests and the regtest run.

The mempool totals' `min_fee_rate` is the node's `mempoolminfee` from the tracker's own `getmempoolinfo` probe, which `Tracker::node_info` exposes; no extra call is made for it.


## Fee recommendations

`engine::fees` answers the question most people bring to an explorer: what should I pay to be mined within a given time? It reads the answer off the projected blocks and the recent arrival of competing transactions. The routes are in [`API.md`](API.md#fees), the topic in [`WS.md`](WS.md#mempool-topics).

| Part | File | Does |
|---|---|---|
| Method | `crates/engine/src/fees.rs` | Depth, arrivals, the search, smoothing, the node's fallback. Pure: no I/O, no clock |
| In the server | `crates/server/src/ws/fees.rs` | Feeds it from the tracker and projector, falls back, publishes, holds the answers |
| Proof | `crates/engine/examples/fee_watch.rs` | Records our answers, the node's and the reference's against a live node, and scores each against the blocks that follow |
| The score | `crates/engine/src/fees/score.rs`, `crates/engine/src/fees/db.rs` | The clearing rate, the scorer (shared with `fee_watch`), the record the server keeps and the day-long level's floor. Pure but for `db.rs` |
| The score in the server | `crates/server/src/ws/fees/score.rs` | Records what was served and every block, stores it, serves `/app/fees/score`, logs `fees_score` |

### Levels

| Level | Mined within | The reference's field |
|---|---|---|
| `high` | the next block | `fastestFee` |
| `medium` | 3 blocks, about half an hour | `halfHourFee` |
| `low` | 6 blocks, about an hour | `hourFee` |
| `no_rush` | 144 blocks, about a day | `economyFee` |
| minimum | accepted by the node now | `minimumFee` |

Rates are in sat per 1,000 vB, the node's unit and resolution, so every answer has three decimals in sat/vB.

### The method

For a level of `N` blocks, the answer is the lowest rate `r` for which

> (virtual size in the mempool paying `r` or more) + (virtual size expected to arrive paying `r` or more before the `N`-th block) < `N` × 998,000 vB

where 998,000 vB is a block's room for transactions (4,000,000 weight units less the 8,000 a template keeps for the coinbase), and every rate is a transaction's **effective** rate: the rate of the chunk the node will mine it in, so a parent lifted by its child counts where the node would put it. Both terms only shrink as `r` grows, so the lowest such `r` is found by bisection over whole sat per 1,000 vB, between the node's minimum and one step above the highest rate anyone pays.

Why each part is as it is:

- **The bottom of a block sets the price, not its middle.** A new transaction gets into block `N` when everything that outbids it fits in `N` blocks: that is the depth term. Reading the median of a block instead would overpay by half a block's spread on every level.
- **Ties count against us.** Transactions at exactly `r` are counted as ahead, because the node orders equal rates in an order nobody outside it can know ([Limits](#limits)). With thousands of chunks at one rate at a block boundary, as mainnet holds today, the answer is one step (0.001 sat/vB) above that rate, never the rate itself. A block exactly full of transactions at `r` likewise has no room at `r`.
- **A block that is not full means the minimum is enough,** because the depth term is already under `N` blocks at the node's minimum; so is an empty or nearly empty mempool, where every level is the minimum. Only arrivals can lift it then.
- **Arrivals.** Blocks come every ten minutes on average, and every transaction that arrives before then paying more than ours goes ahead of it. The method counts, per minute, the virtual size of transactions that entered the mempool at each rate over the last 30 minutes (from the tracker's change stream, at their own rate), and expects that rate to continue. It counts them up to the time by which the `N`-th block has come with 90% probability, block intervals being exponential (a quantile of the gamma distribution): 23.0 minutes for `high`, 53.2 for `medium`, 92.8 for `low` and 26.6 hours for `no_rush`. Not the mean, because the cost is lopsided: too low leaves a payment stuck, while too high costs a fraction of a sat/vB. Not 80%, as before: one horizon in five ran past it, and on mainnet that is most of what was missed ([the evidence](#against-the-blocks-that-followed)).
- **One burst is not a trend.** The busiest of the 30 minutes is left out of the arrivals once there are five, so a single burst (a consolidation, an exchange's batch) is not extrapolated over the horizon. It is in the mempool already, where the depth term counts it. A second burst is counted: bursts that recur are a flow. Until the tuning of 2026-11-13 the busiest quarter was left out, which predicted 20 to 40% less than then arrived.
- **Never an absurd rate.** One transaction paying 10,000 sat/vB adds its own size, at most 100 kvB, to the depth of every rate below it: it cannot fill a block. The answer is the minimum or one step above a rate some transaction pays, and only where more than the level's room pays that rate or more; it is never above one step over the highest rate seen. A test puts one in the mempool and one in the arrivals and shows nothing moves.
- **Never below the node's minimum.** Every level is at least `mempoolminfee` and at least 0.1 sat/vB, rbitcoin's relay floor, and a faster level is never below a slower one. The construction already guarantees both; the result is still put in order, as a guard.
- **Stable.** Recomputed every 2 s, each level is the highest of the last 60 seconds since the tip last moved: it rises at once and falls only after a minute, so it does not flicker with every arrival at a block's edge. The cost is freshness on the way down: after the mempool thins, a level can stay up to 60 seconds too high. A new block clears the history, because it changes the picture for real.
- **The day-long level has a floor from the blocks.** `no_rush` is never below the cheapest rate that got into a block of the last day, plus two steps, and never above `low` ([The day-long level](#the-day-long-level)): the flow above cannot see a queue that does not drain.
- **Five minutes of warm-up.** Until five whole minutes of arrivals were watched, the arrival term cannot be trusted, and the node's estimates stand in, no higher than the mempool and the arrivals watched so far justify ([below](#while-warming-up)). Only time with a current projection counts: after the projection was stale or missing for a minute or more (the node was down), the arrivals are thrown away and the warm-up starts over, so an outage is never taken for quiet minutes.

### When ours cannot be served

| Condition | Served | Why |
|---|---|---|
| The first minute of a warm-up: after start, after an outage, or before the first projection | Nothing: `503 not ready yet; retry`, and the topic says `unavailable` | Nothing watched yet to tell a sensible estimate of the node's from one a hundred times too high |
| The rest of the warm-up, to five minutes | The node's estimates, each level no higher than our method on the minutes watched so far | Arrivals partly known: enough to bound the node, not to stand alone |
| The projection is stale (the node is failing) | The node's estimates, when it still answers them | An old projection is not the mempool now |
| `{NET}_MEMPOOL_ENABLED=false` | The node's estimates | No projection at all |
| The node's estimates older than 90 s, or never received | Nothing: `503`, and the topic says `unavailable` | An old recommendation presented as current costs money; a wallet that gets nothing uses its own |

The node's estimates are rbitcoin's `/fee-estimates` (a ten-minute inclusion product, not Bitcoin Core's historical estimator, [`RBITCOIN.md`](RBITCOIN.md)): targets 1, 3, 6 and 144 blocks (or the next longer target the node gives), lifted to its minimum (`getmempoolinfo`, asked with them, since the tracker's copy is as old as its last good cycle) and put in order, and marked as the node's everywhere they appear. While they are served they are also lifted to any higher minimum the tracker sees in the meantime. The task waits at most 5 s for them, and withdraws whatever it served before it starts waiting, so a hanging node cannot keep an old answer up; the routes themselves refuse estimates past 90 s, and the topic withdraws them at the next tick after they expire, or at the moment they expire while a refresh is pending. They are asked every 30 s, and only while they are what is served and someone wants them: a fee route was requested in the last ten minutes, or the `fees` topic has a subscriber. So nobody asking means no node call, and the first request after a quiet spell is a `503` that the next one, a moment later, does not get.

#### While warming up

**Why the node's estimates alone will not do.** On the live site's first minute after a restart (2026-11-14) the node's next-block estimate was 94 sat/vB on signet and 362 on testnet4, where ours a few minutes later was the minimum; on mainnet it was 5 against our 6. A wallet reading `/api/v1/fees/recommended` then would have paid a hundred times what was needed. It is not the restart: those networks' estimates stay there (89 and 361 sat/vB an hour later, with 3 to 6 blocks at 1 sat/vB). rbitcoin v0.9.2 builds its estimate (`crates/rbitcoin-mempool/src/fee_est.rs`) as a blend of a cold quote, from the history of past blocks' rates, and a warm one, from the transactions it sees arrive, weighted by how full its inflow meter is. On a quiet network the meter never fills, so the estimate stays the cold quote; for one block that is a very high quantile of old blocks, which one block of spam keeps high. The node knows: its own `estimatesmartfee` answers target 1 with target 2 while the meter is not full. Esplora's `/fee-estimates`, which we read, does not.

**What is served instead, and why.** The mempool is known as soon as the projection is current; only the arrivals are not. So from the first whole minute of arrivals watched on a current projection, each of the node's levels is served no higher than our own method gives on the minutes watched so far (`Recommender::cap`), smoothed as ours is. Under five minutes the method leaves no minute out, so a burst counts in full. Before that minute nothing is served. The other choices:

- *The node's estimates, bounded by the mempool alone* (no arrivals): on the recorded mainnet moment (`fixtures/fees/mainnet.json`) that gives 1.101 sat/vB for the next block against our 2.008 with arrivals, so it would underpay where the node was right.
- *The last answer stored before the restart:* only with a data directory, and a claim about a mempool up to five minutes and a restart old. And it is neither ours now nor the node's, so it would need a third `source` that every client must learn.
- *Nothing until our own answer:* honest, but five minutes of `503` after every restart, on every network, where the bounded estimate is already sound after one.

A minute is enough on the evidence we have. On the recorded mainnet moment, the cap from its first one to four minutes of arrivals is at or above our answer from all thirty, on every level: 2.034 to 2.398 sat/vB for the next block against 2.008. Where it bites there (the next block, 2.664 lowered to between 2.0 and 2.4), the estimate stays at or above ours. That is one recording, not a guarantee: a minute is a small sample, and a quiet first minute followed by a rising flow can cap a sound estimate below what ours says at five minutes (a mempool under a block, nothing arriving in the first minute, then 100 kvB a minute at 2 sat/vB: the cap is the minimum, ours at five minutes 2.001). The cap follows each new minute, so such a gap lasts until the arrivals show it. On a quiet network it takes the next block from 89 to the minimum. `503` for that first minute costs a wallet nothing it cannot recover: it retries (`Retry-After: 1`) or uses its own estimate, which beats paying a hundred times too much.

**From the first second** after start, with the engine on and the node answering:

| Time | Routes (`/api/v1/fees/recommended`, `/precise`) | `fees` topic |
|---|---|---|
| Until the projection is current (the tracker's first sync: about 10 s on mainnet) | `503 not ready yet; retry` | `unavailable` |
| Until one whole minute of arrivals was watched on it | `503 not ready yet; retry` | `unavailable` |
| To five minutes | The node's estimates, capped as above, `X-Fee-Source: node` | `source: "node"`, `tip: null` |
| From five minutes | Ours, `X-Fee-Source: projected` | `source: "projected"`, with its `tip` |

Before this rule the node's estimates were served from the moment they came (seconds after the first request) until five minutes. A tick of the fee task (2 s) puts each change in place; the node is asked as before, and the cap asks it nothing.

### Against the blocks that followed

A recommendation is a claim about the future, so it is scored against what happened. `fee_watch` records, every 30 s, our answer, the node's `/fee-estimates` mapped as in the fallback, and (every ten minutes) the reference backend's `/v1/fees/precise`. For every block mined it takes the **clearing rate**: the 1st percentile by vsize of the effective rates our last projection before the block gave its transactions, so one prioritised or out-of-band transaction does not set it. A level met its horizon when it paid at least one step above the clearing rate of one of the next `N` blocks after the moment it was given; its overpay is how far above the cheapest such rate it was.

What the scorer leaves out, and how it says how sure it is:

- **Outages.** A gap between two recorded blocks longer than two hours (`MAX_GAP_SECS`; on a live chain about once in 450 years) means the recorder's node lost the network. Samples whose horizon reaches into that gap, or into the 30 minutes after it while the method's arrivals still hold the quiet and the mempool refills, are left out and counted.
- **Blocks we never saw.** A block none of whose transactions our projection held has no clearing rate. A sample whose whole horizon is such blocks is counted apart (`unsc.`), not scored as a miss.
- **One block decides many samples.** Every sample waiting for the same block shares its fate, so 2,000 samples over 100 blocks are nearer 100 outcomes than 2,000. Each met share has a 95% interval: the wider of one clustered on the block the samples waited for, and Wilson's for as many outcomes as blocks, so a share all met over four blocks is shown as 51–100%, not certain.
- **Fast and slow horizons.** Each met share is also split by whether the `N`-th block came within `N` × 10 minutes of the sample.

```bash
NET=MAINNET SECS=3900 OUT=fees.jsonl REFERENCE_URL=<reference>/v1 cargo run --release -p engine --example fee_watch
RESCORE=fees.jsonl cargo run --release -p engine --example fee_watch   # score a recorded run again
# INPUTS=1 also records what a replay needs (every arrival, each sample's depth), SAMPLE_SECS=10
REPLAY=fees.jsonl cargo run --release -p engine --example fee_watch    # replay it at several tunings
# SERVED=quarter@0.8 for a recording made before 2026-11-13: the tuning its answers came from
```

**Run of 2026-11-12,** mainnet, read-only, 65 minutes, 58,000–62,000 transactions, 131 samples (108 with our own answer after the warm-up), blocks 975,530 to 975,533:

| Level | Source | Samples | Met the horizon | Mean overpay when met | Mean shortfall when missed |
|---|---|---|---|---|---|
| next block | ours | 108 | 64.8% | 0.436 sat/vB | 0.462 sat/vB |
| | the node's estimate | 108 | 100% | 2.004 sat/vB | |
| | the reference | 5 | 60% | 1.194 sat/vB | 0.290 sat/vB |
| 3 blocks | ours | 97 | 74.2% | 0.072 sat/vB | 0.035 sat/vB |
| | the node's estimate | 97 | 100% | 0.639 sat/vB | |
| | the reference | 5 | 80% | 0.857 sat/vB | 0.030 sat/vB |

At the five moments the reference was asked, ours met the next block 4 times in 5 (mean overpay 0.331 sat/vB) and 3 blocks 4 times in 5 (0.098 sat/vB).

**How thin this is.** Four blocks came in 65 minutes, so the 108 samples are four outcomes, not 108: every sample waiting for the same block shares its fate. All of our misses are one block: 975,531 came 34 minutes after the one before (a gap that long happens about 3% of the time), and while it was awaited the market rose from about 1.1 to 2.0 sat/vB; the samples taken early in that wait were too low, those taken late were right. For the other three blocks every sample of ours met both horizons. Six blocks never followed a sample inside the run, so the hour and day levels are not scored at all, and the reference was asked only five times. The node's estimate met every horizon by paying two to four times what sufficed. A run of a day or more is the follow-up; `fee_watch` is built for it.

**Run of 2026-11-12 to 13,** mainnet, read-only, 24 hours from 09:44 UTC, 2,881 samples (2,854 with our own answer), 121 blocks (975,537 to 975,658). From about 23:11 to 03:54 UTC the node lost its internet connection: its tip stayed at 975,611 for 4.8 hours, then 16 blocks came within a minute. The scorer leaves that span and the half hour after it out (623 to 730 samples, depending on the level). The 11 blocks without a clearing rate are all from that catch-up: our mempool, cut off from the network, held none of their transactions. None was empty.

| Level | Source | Samples | Met the horizon | 95% interval | Mean overpay when met | Median overpay | Mean shortfall when missed | Met when the blocks came faster / slower than `N` × 10 min |
|---|---|---|---|---|---|---|---|---|
| next block | ours | 2,225 | 72.3% | 62.8–81.0% | 0.659 sat/vB | 0.679 | 0.799 | 99.1% / 28.6% |
| | the node's estimate | 2,225 | 93.3% | 86.6–98.3% | 1.634 | 1.694 | 0.534 | 100% / 82.2% |
| | the reference | 112 | 75.9% | 64.5–84.5% | 1.001 | 0.879 | 0.626 | 94.1% / 47.7% |
| 3 blocks | ours | 2,164 | 71.2% | 60.3–82.1% | 0.442 | 0.314 | 0.678 | 97.0% / 42.0% |
| | the node's estimate | 2,164 | 68.9% | 55.6–82.1% | 0.398 | 0.323 | 0.977 | 89.5% / 45.5% |
| | the reference | 109 | 84.4% | 73.8–91.5% | 0.758 | 0.663 | 0.592 | 100% / 67.9% |
| 6 blocks | ours | 2,063 | 64.7% | 52.0–77.4% | 0.243 | 0.008 | 0.709 | 87.8% / 40.3% |
| | the node's estimate | 2,063 | 82.5% | 70.5–94.5% | 0.428 | 0.329 | 1.085 | 100% / 63.9% |
| | the reference | 103 | 73.8% | 61.7–84.4% | 0.442 | 0.271 | 0.538 | 96.1% / 51.9% |

At the moments the reference was asked, ours met the next block 75.0% of the time, 3 blocks 67.9% and 6 blocks 61.2%. Left in, the outage flatters every level (76.8%, 76.6%, 73.9%): through it ours sat one step above the mempool's floor, and the catch-up blocks cleared at that floor.

**What the misses were.** Each missed sample was put to the first of these that explains it: a block of the horizon that had room but did not take our rate (a miner's floor); our rate tied with the clearing rate (short one step); the mempool already holding `N` blocks above our rate when we gave it (the depth term); the `N`-th block coming later than the time the method allowed for it; and otherwise arrivals, more of which came in time than were counted.

| Level | Misses | Time allowed | Arrivals | Miner's floor | Ties | Depth |
|---|---|---|---|---|---|---|
| next block | 616 | 74% | 24% | 2% | 0% | 0% |
| 3 blocks | 623 | 71% | 22% | 5% | 1% | 0% |
| 6 blocks | 728 | 56% | 27% | 7% | 10% | 0% |

- **The time allowed is most of it.** The method counted arrivals up to the time by which the `N`-th block comes with 80% probability, not the mean. So by design one horizon in five runs past it, and every level was tuned to the same 80%: that is why 3 and 6 blocks were no more reliable than one. In this recording more than one in five ran past (22% for one block, 27% for three and six) because blocks were slow: 10.8 minutes apart on average, a median gap of 7.9 minutes and a 90th percentile of 29.9, against 10.87 minutes over the difficulty period and 11.5 over the week before. A sample whose horizon ran past the allowance was met 8% (next block) to 24% of the time; one within it 91%, 89% and 80%.
- **A block that clears at 3 sat/vB is a full block after a slow gap.** All 17 blocks that came more than 20 minutes after the one before cleared at 1 sat/vB or more, 12 of them at 2 or more; after gaps under five minutes the median clearing rate was 0.123. Those blocks were full (3.99 million weight units) and their pools took 0.12 sat/vB at other times. A steady stream at 1 to 3 sat/vB arrives at about a block every ten minutes, and the cheap end of the mempool is only reached when blocks outpace it.
- **Arrivals are undercounted.** Within the time allowed, the 6-block level still missed one sample in five, mostly while demand rose (16:00 to 18:00 UTC) or a steady stream at one rate (0.125 sat/vB) kept refilling the boundary. The arrival term was the mean of the quieter three quarters of the last 30 minutes, not, as this page said, all but the busiest one.
- **A miner's floor is real but small.** Four of the 100 blocks had room and took nothing under 1.000 sat/vB while transactions at 0.12 waited (Ocean twice, ViaBTC, BTC.com). A rate under 1 sat/vB cannot get into such a block, and nothing in the mempool shows which pool finds the next one ([Limits](#limits-1)).
- **Depth and the 60-second hold never caused a miss.** The hold only raises a level.

**The change.** Arrivals are counted up to the 90% quantile of the time to the `N`-th block instead of the 80% one, and only the busiest minute is left out of them, not the busiest quarter. Both terms were tested, and nothing else was changed, because the misses above point at them and nowhere else.

**How it was tested.** The 24-hour recording holds our answers, not the mempool and arrivals they were computed from, so a changed method cannot be replayed on it. One more recording was made for that: three hours on mainnet, read-only, 2026-11-13 10:04 to 12:59 UTC (`INPUTS=1`, a sample every 10 s), 1,020 samples with our own answer, 13 blocks (975,661 to 975,673) that came slowly, 13.5 minutes apart on average with one gap of 40 minutes. `REPLAY` runs it through the method at 18 tunings: 6 confidences, from 80% to 99%, and leaving out a quarter of the minutes, one or none. The replay of the tuning that was served follows what was served to 0.015 sat/vB on average. The difference comes from smoothing over samples 10 s apart rather than ticks 2 s apart. The projection was never stale during the run. Recordings now mark when it is, and the replay then throws the arrivals away and restarts the warm-up, as the server does.

- **Fit:** the first half (samples before 11:31:35 UTC whose whole horizon ended before it, 7 blocks), the 24-hour recording's waiting times, and the arrivals themselves. The rule, written down before the second half was scored: leave out one minute, and take the lowest confidence at which every level met at least 90% on the first half. That gave 90% (97.3%, 100% and 90.6%). At 80% and 85% the 6-block level met 63% and 64%.
- **Report:** the second half, 6 blocks, never looked at while choosing.

Leaving out a quarter of the minutes undercounted what then arrived. Over the three hours, the next 30 minutes brought 21 to 39% more than the mean of the quieter three quarters of the last 30 had predicted, depending on the rate. With the busiest minute left out it was 0 to 19% more, and with nothing left out between 5% less and 14% more. One minute keeps the guard against a single burst for a few points of bias.

**After it,** on the second half of the three-hour recording (6 blocks; one block can decide half the samples, so the intervals are wide):

| Level | Source | Samples | Met the horizon | 95% interval | Mean overpay when met | Mean shortfall when missed |
|---|---|---|---|---|---|---|
| next block | ours before | 475 | 54.1% | 14.0–94.2% | 0.660 sat/vB | 1.013 sat/vB |
| | ours after | 475 | 67.4% | 28.2–100% | 1.018 | 0.841 |
| | the node's estimate | 475 | 85.9% | 46.0–100% | 1.519 | 0.334 |
| | the reference | 16 | 68.8% | 31.6–100% | 1.045 | 0.937 |
| 3 blocks | ours before | 348 | 59.2% | 20.0–89.4% | 0.099 | 0.540 |
| | ours after | 348 | 98.6% | 49.6–100% | 0.369 | 0.374 |
| | the node's estimate | 348 | 25.9% | 0–83.1% | 0.260 | 0.217 |
| | the reference | 12 | 75.0% | 30.1–97.1% | 0.778 | 0.259 |
| 6 blocks | ours before | 16 | 0% | one outcome | | 0.035 |
| | ours after | 16 | 100% | one outcome | 0.840 | |

At the moments the reference was asked in that half, ours after met the next block 11 times in 16, as the reference did, and 3 blocks 12 in 12, where the reference met 9. Over the whole run, at those moments, ours after met 84.4%, 100% and 100% against the reference's 71.9%, 82.1% and 88.2%. The 6-block level had one outcome in that half, which is not evidence either way. The next block missed through the 40-minute gap before block 975,670: a gap that long comes about once in 55 blocks, and every sample in its first 17 minutes had more wait ahead of it than the 23 minutes allowed.

Over the whole three hours, the fit half included (13 blocks):

| Level | Ours before | Ours after | The node's estimate | The reference |
|---|---|---|---|---|
| next block | 68.5%, 0.617 sat/vB | 83.0% (56.0–100%), 1.110 | 93.1%, 1.535 | 71.9% of 32, 1.092 |
| 3 blocks | 76.3%, 0.094 | 99.4% (73.2–100%), 0.578 | 55.3%, 0.178 | 82.1% of 28, 0.694 |
| 6 blocks | 36.2%, 0.000 | 97.7% (64.5–100%), 0.437 | 100%, 0.118 | 88.2% of 17, 0.213 |

On the 24-hour recording the new allowance would have covered 88.6% of the next-block horizons, 83.8% of the 3-block ones and 85.2% of the 6-block ones, against 77.7%, 73.1% and 72.9% for the old. That is the term that explained most misses. What share would then have been met cannot be known without a replay.

**What the next block's reliability costs.** The same three hours, leaving out one minute, and the share of the 24-hour horizons each allowance covers:

| Confidence | Met | Mean overpay when met | 24-hour horizons within the allowance |
|---|---|---|---|
| 80% | 75.3% | 0.711 sat/vB | 77.7% |
| 85% | 78.2% | 0.911 | 82.7% |
| **90% (chosen)** | **83.0%** | **1.110** | **88.6%** |
| 95% | 86.7% | 1.390 | 96.2% |
| 97.5% | 90.2% | 1.534 | 99.5% |
| 99% | 96.1% | 1.783 | 100% |
| the node's estimate | 93.1% | 1.535 | |

At 90% the next block pays about what the reference pays (1.110 against 1.092 on this run, 1.001 over the 24 hours) and is met more often. Each step beyond that buys 3.5 to 6 points for 0.15 to 0.28 sat/vB more, and the node's estimate is the 93% point at 0.4 sat/vB more than the chosen one. The confidence is one number for every level, and the longer levels came out well above their target on this run. A next block with its own, higher confidence is the step to take if a longer run shows it under 85%. That needs no new recording: the recorder replays it.

**Against the targets.** The aim was every level met at least 85% of the time, at least as often as the reference, for less overpay than the reference. On the three hours, 3 and 6 blocks were met more than 97% of the time. The 3-block level paid less than the reference (0.578 against 0.694). The 6-block level paid more on this run (0.437 against 0.213, from 17 reference samples), as much as the reference paid over the 24 hours (0.442). The next block met 83% overall and 67% on the report half, so its 85% is not shown. Its overpay matches the reference's, and at the moments the reference was asked it was met as often in the report half and more often over the whole run. The evidence is 13 blocks: enough to show the direction, not to pin a percentage.

**Why the cost comes in jumps.** On these days the mempool held two populations: a sea of about 20 MvB at 0.12 sat/vB and below, and a stream at 1 to 3 sat/vB arriving at about a block every ten minutes, with almost nothing between. A level either sits one step above the sea or above the stream. Moving from one to the other costs about 0.9 sat/vB, so the 6-block level's overpay is near zero when it can stay at the sea and near a sat/vB when it cannot. The reference's answers between the two (0.2 to 0.5) are met when the stream is slow and missed when it is not.

### The score the server keeps

The recordings above needed a recorder of their own, with its own tracker polling the node. A server with the mempool engine on has everything they used: the answer it serves, the projection each block is judged against, and the block. So it keeps the same score of itself, for as long as it runs, on every network, at no node cost. The earlier runs' tables are in [Against the blocks that followed](#against-the-blocks-that-followed); this is how the evidence keeps growing.

**What is recorded** (`crates/server/src/ws/fees/score.rs`, one task per network, started with the engines):

- **Every 30 s, what was served:** our four levels when ours was served, or only which stood in: the node's estimates (warming up, or the projection stale) or nothing. 30 s is what the recordings used, so the scores compare; samples waiting for the same block share its fate, so more would add rows, not evidence. The answer is read from the fee task's own (`Fees::current`), so the task that refreshes it every 2 s is not touched.
- **Every block, its clearing rate**, defined as `fee_watch` defines it and by the same code (`fees::score::held` and `clearing`): the 1st percentile by vsize of the effective rates the last projection on its parent gave the block's transactions. The block's transactions come from the tracker's own window of recent blocks, which every tracker delta carries (`Delta::blocks`), so nothing is asked of the node. Blocks are recorded as `fee_watch` records them: every height from the old tip to the new one, the new tip alone after a reorg (its row replaces the old block's), each seen at the time the projection moved. A block the window does not hold, or that came while the server was down, has no clearing rate. At start, the blocks since the highest one stored are recorded that way, up to 144 of them, so samples taken before a restart are judged against the right heights.

**What it costs.** No node request: a test on a mock node that counts every call (`the_fee_score_asks_the_node_nothing_and_survives_a_restart`) samples some fifty times with the counts of block, transaction and cluster requests unchanged, and a block costs exactly the one fetch the tracker makes anyway. The fee task was not changed by it (it now reads one number from the keeper, [the day-long floor](#the-day-long-level)); on regtest, two servers on one node under the same load refreshed in the same time with the score kept and without (means of 213 to 692 µs against 228 to 716 µs, debug build). Scoring a full month of samples, every window and level, takes about 32 ms on a blocking thread every 30 s. Storage is about 65 KB a day on mainnet ([`STORE.md`](STORE.md#fee_samples-and-fee_blocks)).

**What the score is.** `fees::score::Record::report` scores each sample's levels with the scorer the recordings used (`fees::score::outcome`, `Tally`): met when the level paid at least one step above the clearing rate of one of the next `N` blocks after it was given; overpay over the cheapest such rate when met, shortfall when missed; a 95% interval that is the wider of one clustered on the block each sample waited for and Wilson's for as many outcomes as blocks. Left out and counted, as the recordings left them out:

- **Outages:** a gap between recorded blocks over two hours, and the 30 minutes after it. Downtime of the server counts the same way: the blocks recorded at its restart end the gap.
- **Unfinished horizons:** the `N`-th block has not come yet. The day-long level needs 144 blocks after its sample.
- **No clearing rate** anywhere in the horizon.

**A block with room reads as a miss for the minimum.** A block's clearing rate is the cheapest that got in, not the cheapest that would have: a block that took the whole mempool clears at its cheapest transaction, and an answer at the node's minimum, which would have been mined too, counts as short by the gap. On mainnet blocks are full and this does not arise; on regtest, where `generatetodescriptor` mines everything, it is every sample. It is the recordings' definition, kept so the scores compare.

**Not enough evidence is said plainly.** Under 30 distinct blocks deciding a level's samples, the route and the log give no share: the interval would be wider than 13 points either side of 85%. Telling 83% from 87% for the next block, the question the three-hour run left open, takes about 400 blocks for an interval no wider than 4 points either side (scaled from the 24-hour run's interval, 62.8–81.0% from 121 blocks), about three days of our own answers on mainnet, and about 800 blocks, under a week, to tell them apart with an 80% chance.

**Proof against the earlier evidence.** `fixtures/fees/replay.json` replayed, each answer and block written through the store and read back, scores 14 of 17, 15 of 15 and 8 of 9, the shares the scorer of 2026-11-13 gives that file (`fees::score::tests`). `fee_watch` now scores with the library's code; its `RESCORE` output on recorded files is unchanged.

**Read it** at `/app/fees/score` ([`API.md`](API.md#the-score-kept)), and in the `fees_score` line logged once a day per network at midnight UTC for the day before ([`LOGGING.md`](LOGGING.md#the-live-mempool)).

#### Three days of it

Mainnet, from 2026-11-13 14:51 UTC, read on 2026-11-16 at 15:30 UTC (window `all`, 435 blocks), before the day-long floor:

| Level | Met its horizon | 95% interval | Overpay when met, mean (median) | Shortfall when missed |
|---|---|---|---|---|
| `high`, next block | 89.1% | 85.5–92.7% | 0.911 (0.893) sat/vB | 0.681 sat/vB |
| `medium`, 3 blocks | 92.2% | 88.3–96.1% | 0.586 (0.849) | 0.578 |
| `low`, 6 blocks | 92.5% | 89.4–95.7% | 0.270 (0.011) | 0.532 |
| `no_rush`, 144 blocks | **31.2%** | 25.0–37.4% | 0.062 (0.000) | 0.015 |

Left out: 6, 90, 147 and 2,410 samples whose horizon had not ended, 3 (next block) with no clearing rate, none for an outage. 428 of 8,671 samples were not ours: 245 nothing and 183 the node's estimates, all from about 45 restarts for deployments.

- **The next block's 85% is now shown.** The three-hour run could not show it (83% on 13 blocks); this interval is above 85% on 436 blocks.
- **The 6-block level costs less than it did.** Its mean overpay was 0.270 sat/vB over the three days (0.124 in the last 24 hours), against 0.437 on the three-hour run, where the reference paid 0.213 (0.442 over its 24-hour run). The reference was not sampled during these three days, so the comparison is with its earlier figures.
- **The day-long level missed its horizon.** Why, and the fix, are [below](#the-day-long-level).

### The day-long level

**What the three days showed.** In 456 recorded blocks nothing under 0.120 sat/vB got in (clearing rates: lowest 0.120, 10th percentile 0.122, median 0.124). The mempool holds some 25 MvB at 0.12 sat/vB and below, and about a block's worth arrives above it every ten minutes, so that sea does not drain. Every scored sample needed 0.121 to 0.123 sat/vB to get into one of its next 144 blocks, and the method's answer was 0.100, the minimum, for 2,255 of 5,861 of them and 0.121 for 2,401, flipping between the two. It reasoned that the whole mempool plus a day of arrivals fits in 144 blocks; that holds for a flow, not for a queue that the blocks never reach the bottom of. A transaction paying it waited days.

**The rule.** `no_rush` is at least the cheapest clearing rate among the blocks recorded in the last 144 heights, plus three steps of 0.001 sat/vB (`fees::score::day_floor`, `DAY_FLOOR_STEPS`), and never above `low` (`Rates::no_rush_at_least`). One step is what the scorer counts as getting in; the other two cover the cheapest block of the next day clearing above the cheapest of the last, which on these three days it did by up to two steps. The server's score keeper already holds each block's clearing rate, stored, so it works the floor out after each block and leaves it for the fee task, which applies it to our own answer after smoothing. The node's estimates, when they stand in, are served as they are.

- **No history** (start-up without a store, before the first block with a clearing rate): no floor, and the method's answer as it is. With a store the blocks are loaded at start, so a restart keeps it.
- **A quiet network, or regtest,** where blocks take everything: `low` is the minimum there, so `no_rush` is too, whatever the floor says. A floor from one expensive block at start-up is likewise bounded by `low`.
- **No flipping without cause.** The floor moves at most once a block. Between blocks, replayed on the three days, the level changed 125 times against 365 before: 85 times following `low` where it caps the floor, and 40 where the method's own answer rose above it. The flip between 0.100 and 0.121 is gone, since both are under the floor.

**Replayed on the stored tables** (each sample's floor from the blocks recorded before it; 5,861 samples, 298 outcomes; the tables score the served answers at 31.0%, the route's read a little later at 31.2%):

| Rule | Met | 95% interval | Overpay when met, mean (median) | Raised on average |
|---|---|---|---|---|
| As served | 31.0% | 24.9–37.2% | 0.062 (0.000) sat/vB | |
| Cheapest of the last 144 blocks + 0.001 | 71.6% | 64.9–78.3% | 0.028 (0.000) | 0.011 sat/vB |
| + 0.002 | 86.9% | 82.0–91.8% | 0.024 (0.001) | 0.012 |
| **+ 0.003 (chosen)** | **99.8%** | **98.3–100%** | **0.021 (0.002)** | **0.013** |
| Cheapest of the last 36 + 0.002 | 99.8% | 98.3–100% | 0.047 (0.001) | 0.039 |
| Cheapest of the last 6 + 0.001 | 94.8% | 91.3–98.4% | 0.298 (0.003) | 0.274 |

The 14 misses left are samples where `low` was under the floor and capped it. Taking the second to fifth cheapest of the last 144 or 36 blocks instead of the cheapest did no better (71 to 82%): the misses come from the day's cheapest block drifting up, not from one outlier. Two steps is under 85% at the bottom of its interval; three costs 0.001 sat/vB more on average. `fees::score::tests::the_day_floor_meets_the_day_long_horizon_on_three_days_of_mainnet` replays every tenth sample (`fixtures/fees/score-days.json`): 181 of 587 met as served, 584 with the floor, the other three levels' answers unchanged.

**The week after (to 2026-11-21).** The route read 79.3% for `no_rush` over the week and 71.8% over the month, against 85%. Not the rule: those windows still held the days before it went live. The server's own tables for 2026-11-13 14:51 to 2026-11-21 19:51 UTC (23,578 samples, 1,254 blocks) show the floor in every answer served from 2026-11-16 23:00 UTC, and every one of the 11,467 samples scored since met its horizon (100%, 99.4–100%, 589 outcomes). All 5,898 misses of the whole period are earlier: the method's own 0.100 or 0.121 against 0.121 to 0.123 needed. The week's share climbs as those samples leave its window, which holds only answers served with the floor from 2026-11-23 23:00 UTC; the month's from 2026-12-16.

The margin held with room: after the floor went live, the cheapest clearing rate of a sample's next 144 blocks was never above the last day's cheapest (equal for 10,849 samples, two steps below for 618), so the drift of up to two steps that set the margin did not come back. Replayed over the whole period, each sample's floor from the blocks before it:

| Rule | Met | 95% interval | Raised on average |
|---|---|---|---|
| As served (the floor for the last four and a half days) | 71.3% | 67.8–74.9% | |
| Cheapest of the last 144 blocks + 0.001 | 86.0% | 83.2–88.7% | 0.0043 sat/vB |
| + 0.002 | 93.5% | 91.6–95.5% | 0.0047 |
| **+ 0.003 (kept)** | **99.9%** | **99.5–100%** | **0.0051** |
| + 0.004 | 99.9% | 99.5–100% | 0.0058 |

The 14 misses left are all from before the floor, where `low` was under it and capped it. Two steps would also meet 85% on this period and save 0.0004 sat/vB on average (0.1 sat on a 250 vB payment), but on the three days it was tuned on its interval reached down to 82%, and a week of one quiet regime is no reason to take the margin back. So the rule is unchanged. `fees::score::tests::the_day_floor_still_meets_the_day_long_horizon_on_the_week_after` replays every tenth sample of the five days after `score-days.json` (`fixtures/fees/score-week.json`): 1,217 of 1,234 met as served, all 1,234 with the floor, and all 1,152 served after it went live.

**What a week cannot show.** Every block of the period cleared between 0.120 and 0.127 sat/vB at its cheapest but for a few hours on 2026-11-13; nothing says how far the day's cheapest block moves in a market well above the minimum. There the floor is still bounded by `low`: after a busy day whose cheapest block took 20 sat/vB, a mempool that clears at 2 within six blocks gets `no_rush` at 2, the 6-block level, and never more (`fees::tests::the_day_long_floor_raises_only_no_rush_and_never_past_low`). That overpays for a day's wait by what the six-block level asks over the day's real price, until the expensive blocks leave the last 144; it cannot reach past what an hour costs.

**What it changes on the routes.** `economyFee` in `/api/v1/fees/precise` reads 0.123 where it read 0.100 or 0.121; in `/api/v1/fees/recommended` it stays `1`, the whole number of anything under 1 sat/vB. `fastestFee`, `halfHourFee`, `hourFee` and `minimumFee` are untouched, and `economyFee` is never above `hourFee`.

### Against the node and the reference

The same moments, the three sources side by side (sat/vB; next block / 3 blocks / 6 blocks / no rush / minimum):

| Moment (tip) | Ours | The node's estimates | The reference |
|---|---|---|---|
| 975,529 | 2.001 / 1.056 / 0.126 / 0.1 / 0.1 | 3.738 / 1.574 / 1.486 / 0.128 / 0.1 | 2.5 / 1.754 / 0.815 / 0.2 / 0.1 |
| 975,530 | 2.034 / 1.099 / 0.126 / 0.1 / 0.1 | 3.263 / 1.556 / 1.47 / 0.128 / 0.1 | 1.641 / 0.971 / 0.423 / 0.2 / 0.1 |
| 975,530 | 1.303 / 1.004 / 0.125 / 0.1 / 0.1 | 3.296 / 1.376 / 1.332 / 0.128 / 0.1 | 1.803 / 1.404 / 0.64 / 0.2 / 0.1 |
| 975,530 | 2.032 / 1.099 / 0.141 / 0.1 / 0.1 | 3.929 / 1.793 / 1.389 / 0.128 / 0.1 | 2.911 / 2.005 / 1.378 / 0.2 / 0.1 |
| 975,530 | 2.626 / 1.193 / 0.141 / 0.1 / 0.1 | 4.425 / 2.001 / 1.644 / 0.128 / 0.1 | 3.527 / 2.367 / 1.56 / 0.2 / 0.1 |
| 975,533 | 1.001 / 0.125 / 0.121 / 0.1 / 0.1 | 2.152 / 0.472 / 0.472 / 0.128 / 0.1 | 1.016 / 0.571 / 0.223 / 0.2 / 0.1 |

Ours and the reference's next-block numbers are close; below that they part. The mempool at the time held about three blocks above 0.125 sat/vB and then some 25 MvB of transactions at 0.12 sat/vB and below, so a transaction at 0.126 sat/vB is ahead of all of those and, unless more than three blocks' worth arrives above it, mined within six blocks: that is our `low`, where the reference said 0.4 to 1.6. `no_rush` was the minimum because the whole mempool plus a day of arrivals at the observed pace fits in 144 blocks; three days of the server's own score showed that reasoning wrong (nothing under 0.12 got in) and gave the level a floor ([The day-long level](#the-day-long-level)). The reference's economy level read 0.2 (twice its minimum) at every moment. Neither longer level could be scored in this run.

A recorded moment of this run (the projection's rates and sizes, 30 minutes of arrivals and the answer) is `fixtures/fees/mainnet.json`, replayed by a test.

### Limits

What the method cannot know, and what it assumes:

- **A miner's floor.** Some pools at times take nothing under 1 sat/vB even when their block has room: 4 blocks in 100 on 2026-11-12 (Ocean twice, ViaBTC, BTC.com). Nothing in the mempool says which pool finds the next block, so a rate under 1 sat/vB can miss a block it would have fitted in. Over 3 or 6 blocks this seldom matters. For the next block it is part of what is missed.
- **The pace of blocks.** The method takes blocks to come every ten minutes. Between retargets they do not: 10.87 minutes on average in the difficulty period of these recordings, 11.5 in the week before. The 90% allowance was chosen on data from that slow stretch, so it errs towards being met when blocks are faster. The server already measures the period's pace for `/difficulty-adjustment`; counting with it is a possible next step, not taken because a choice made on slow blocks already covers them.
- **Bursts in the stream.** Arrivals are a 30-minute average less the busiest minute. A rise in demand is followed within half an hour, not foreseen: the misses of 16:00 to 18:00 UTC on 2026-11-12 were such a rise.
- **The tuning's evidence is a day and three hours:** 100 blocks scored from the first, 13 from the second. The rule that chose it is written above, so a longer recording can be replayed against it. The server's own score has added three days and 435 blocks since ([Three days of it](#three-days-of-it)).
- **The day-long floor is eight days of one regime:** a sea at 0.12 sat/vB that never drained ([the week after](#the-day-long-level)). Its margin of two steps was the drift seen there; a market where the day's cheapest block moves more would need more. The score shows it if so, once its window holds only answers served with the floor.

## When a block is found

The moment a block is found is when the projected blocks matter most, and when the parts above meet: Electrum announces the block, the tracker learns what left, the projector repacks, and the WebSocket sends the block, its summary and the new projection ([`WS.md`](WS.md#when-a-block-is-found) has the order clients are promised).

**What happens, in order:**

1. Electrum announces block B. The server's hint task calls `Tracker::block_found(B)`.
2. The tracker's loop takes it as soon as the cycle in progress, if any, ends. It reads the tip from Esplora, every 25 ms for up to 3 s, until Esplora serves B or a later block. The node can announce a block some hundreds of milliseconds before it serves it ([`RBITCOIN.md`](RBITCOIN.md#rules-that-follow)). It then fetches the block into its window of six, as a cycle would, and publishes one delta. That delta removes everything the window's blocks rule out: what they contain (`Confirmed`), what spent an outpoint they spend, and those transactions' descendants (`Replaced` by the block's transaction). The delta is published even when nothing left, because a new tip is a change. No listing is made.
3. The projector folds the delta in. It asks the node for the clusters the removed transactions belonged to (a child whose parent was mined now stands alone, or in a smaller chunk), packs, and publishes. Then, once the tracker has nothing more to fold in, it asks for every cluster again (the refresh).
4. The WebSocket feed sends a projection on a new tip at once, without the 2 s rate limit, and the fee task recomputes `fees` from it at once. Both hold one whose tip differs from the block the `blocks` topic last announced, for at most 3 s, so a client always sees the block first and nothing older after it.

**What keeps it right:**

- *A block lands during a poll.* The hint waits for the poll to end, and the two never overlap. A poll whose listing came before the block, but whose tip read came after, also removes what the new blocks rule out, though its listing still held it. So no delta on a new tip keeps a transaction known to be mined. The block step then finds nothing left to do. Electrum is not always first: on mainnet a poll read the new tip from Esplora 300 ms before Electrum announced it, with a listing taken just before the block.
- *The block is not served yet.* The tip is read again until it is, for up to 3 s. If it is not served by then, a full cycle runs at once. Until the tracker's tip reaches the announced height, no probe may skip a listing: an empty or quiet mempool's totals do not move with a block, and before this rule such a block went unseen until the 10 s heartbeat.
- *A burst.* Each announcement is applied in turn, each block fetched once. The refresh waits for the last. A newer announcement replaces one still waited for, which may never be served after a reorg.
- *A refresh in progress.* The projector does one thing at a time, so a block's delta that arrives while the previous block's refresh runs (27 requests and 1.6 s on mainnet) waits for it. That needs two blocks within about two seconds.
- *A reorg, or more blocks than the window.* When the new tip does not extend the chain the tracker held, the block step still removes what the new chain rules out, then a full cycle runs at once. Only a listing shows what came back.
- *The audit record.* The projection on the old tip is archived as `Expected` when the first projection on the new one is published, as before.
- *Gapless deltas and a consistent snapshot.* The block step publishes under the same write lock and with the same numbering as a cycle.

**Early against refreshed.** The projection sent for the block is built from the node's answer for every cluster the block touched. So it differs from the refreshed one only by what the block alone does not reveal: a `prioritisetransaction`, a cluster the tracker had not fully seen, ties. On regtest the refresh corrected 0 records in 19 of 20 blocks and 1 record in the other. On mainnet it moved 4,659 records of 68,000 at block 975,535. Most of those moves are not corrections: the refresh applies every cluster afresh, every chunk gets a new id, and ids break ties. So thousands of chunks of equal rate and fee change places, and some cross a block boundary. How many changed rate was not measured. Clients are not told the first projection is provisional: it is as true as anything the server sends, and the refresh's corrections arrive as ordinary changes.

**Measured on regtest** (release build, 22 blocks a few seconds apart, each mining a random ancestor-closed 60% of a mempool of 8 to 87 transactions, the rest staying behind, children of mined parents included). Times are from Electrum's announcement:

| | Before | After |
|---|---|---|
| Tracker delta that confirms the block | 4 ms median, 17 ms max | 2.8 ms median, 5 ms max |
| Projection without the block's transactions | 4 ms median, 20 ms max | about 1 ms later |
| `projected` message on the socket | 1,016 ms median, 1,921 ms max (4.7 s once) | 3.5 ms median, 10 ms max |
| From the `block` message to the `projected` message | 1,015 ms median | 2 ms median, 6 ms max |
| A `projected` on the old tip after the `block` message | none seen | none, and the server holds it back |

So on regtest the whole delay was the feed's 2 s rate limit. With the mempool's totals unchanged by a block (an empty mempool), the tracker could also miss the block until its 10 s heartbeat: the hint's cycle read the tip before Esplora served the block, and every probe after it found nothing changed. That is what made the browser tests that mine see the projection several blocks behind.

**Measured on mainnet** (2026-11-12, read-only, 68,000 transactions in the mempool, release build, one block on the final block path: 975,535). Times from Electrum's announcement:

| Step | ms |
|---|---|
| The tip read, held by the node until it serves the block (the `blocks` topic's own fetch was held as long: its `block` message left at 487 ms) | 487 |
| The raw block, 1.58 MB | 108 |
| What the window rules out (2,930 transactions) and their reasons, over 68,000 held | 61 |
| Tracker delta published | 657 |
| The projector: two cluster requests for what the block touched, while the node also serves the block summary's `getblock` | about 240 |
| Packing | 182 |
| Mempool topics sent on the block | 1,080, which is 592 ms after the `block` message |
| `summary` sent | 1,974, which is 1,487 ms after the `block` message |
| Refresh of every cluster done (12 requests, 5.9 MB) | 2,799 |

No mempool message on the old tip came after the `block` message, and none on the new tip before it. Before the change the same block would have waited for a poll, about 600 ms for the listing and the block, and then for the feed's rate limit of up to 2 s. Builders measured 3 to 6 s on mainnet. An earlier build in the same run showed a further gap: a poll read the new tip 300 ms before Electrum announced it, while its listing still held the block's 2,948 transactions. That build sent a projection on the new tip still holding them. The rule that a poll which sees a new tip drops what the block rules out closes it.

**Node cost per block,** the WebSocket's block fetch and the summary's block listing left aside (both unchanged by this):

| | Before | After |
|---|---|---|
| Tracker | the cycle that sees the block: probe, listing, tip, the raw block, details | one tip read (more only while Esplora lags: one per 25 ms), the raw block; the next cycle fetches no block |
| Projector | the block's clusters, then every cluster | the same |

So a block costs the node one more tip read (about 100 bytes) and no second fetch of its transactions. On regtest the block step made 2 calls and read 2 to 13 KB per block. On mainnet it made 2 calls and read 1.58 MB, the block the poll used to fetch, and the poll after it fetched none. The tracker's polling stayed at 210 to 255 calls and 185 to 255 MB a minute at 68,000 transactions.

## Block audits

Every block we watch arrive is compared with the block we expected on its parent: which transactions we expected and the miner left out, which it included that we did not expect, and a score for how closely the two agree, read as the block's health. The reference backend cannot do this on rbitcoin; we can, because the projection is packed from the node's own mining chunks ([Projected blocks](#projected-blocks)).

| Part | File | Does |
|---|---|---|
| Method | `crates/engine/src/audit/mod.rs` | The comparison, its categories and the score. Pure: no I/O, no clock |
| Store | `crates/engine/src/audit/db.rs` | The `audits` table ([`STORE.md`](STORE.md#audits)) |
| In the server | `crates/server/src/audits.rs` | Runs it when a new block's summary is computed; the routes ([`API.md`](API.md#block-audits), [`FRONTEND.md`](FRONTEND.md#block-audits)) |

### What is compared

- **Expected:** our first projected block as it stood on the parent, the last projection published before the projector moved onto this block (`Projector::expected`).
- **Mined:** the block's transactions, coinbase left out, with fees and sizes from the block listing the summary reads for every new block anyway: `/block/:hash/txs/summary` where the node serves it, else `getblock` at verbosity 2. Both give the same transactions, fees and sizes ([`RBITCOIN.md`](RBITCOIN.md#listing-a-blocks-transactions)).
- **What left with the block:** every transaction in that last projection, in any block, that the first projection on this block no longer holds, with the rate we had placed it at (`Expected::left`). A mined transaction in it was in our mempool; an expected one in it that is not in the block was knocked out by the block.
- **When the block came:** the moment the projector learnt of it, before it asked the node anything for the projection on it (`Expected::at`), the same for whoever computes the summary first. On mainnet that is about 0.7 s after Electrum's announcement ([When a block is found](#when-a-block-is-found)).
- **When each was seen, and its weight:** the node's accept time and the raw weight from the tracker's records, read right after the block was applied.

Nothing here asks the node anything.

### Categories

Each transaction expected or mined falls in exactly one:

| Category | Expected | Mined | Precisely | Counts against the miner |
|---|---|---|---|---|
| `matched` | yes | yes | In both | No: agreement |
| `conflicted` | yes | no | Left our mempool when the block was applied without being in it: the block spent one of its inputs (a double spend the miner saw first), or, rarely, it was replaced or evicted in that moment | No: excluded |
| `fresh` | yes | no | Still in our mempool, accepted by our node less than 60 s (`RECENT_SECS`) before the block came. An accept time after the block is a newer record (it was evicted and sent again) and is not fresh | No: excluded |
| `displaced` | yes | no | Neither of the above, could not have fitted beside everything the block holds, and the block gave its space to transactions we did not expect (`added` or `unseen`) paying at least its rate | No: agreement |
| `missing` | yes | no | Anything else expected and left out | **Yes** |
| `added` | no | yes | In our projection on the parent, but placed in a later block | No |
| `unseen` | no | yes | Not in our projection on the parent at all: we had not seen it, or it arrived in the last second or so before the block | No |

**The score** (`match_rate`) is a share of virtual size, in percent, rounded down to two decimals:

> match rate = (matched + displaced) / (expected − fresh − conflicted)

with each term the virtual size (sigop-adjusted, as the projection packs) of the expected transactions in that category. When nothing is left to count (an empty expectation, or every expected transaction fresh or conflicted) it is 100: nothing could be left out. Rounded down, so 100 is only ever a block with no `missing` transaction.

Why each choice:

- **By weight, not by count.** Block space is what a miner allocates. One 50 kvB consolidation left out costs the block what 200 small payments do; by count it would weigh as one.
- **Only leaving out lowers it.** A miner who adds transactions we did not expect, in room our block would have left empty, has left nothing out. Additions are listed (`added`, `unseen`) and counted, not scored: a miner putting its own or out-of-band transactions in the place of expected ones shows as `missing` once the replacements pay less.
- **Displacement needs a full block and an equal or better trade.** Mainnet mempools hold thousands of chunks at one rate, and at the block boundary the node and every miner pick among them in an order nobody outside can know ([Limits](#limits)). Two limits apply. First, only what could not have fitted is excused: had the miner added every left-out transaction to its block, the block would have passed its room (3,992,000 weight units, `BLOCK_WEIGHT`) by some amount, and no more than that amount is excused. This is counted in raw weight, the limit's own unit, not in the sigop-adjusted size the score weighs by, which for a sigop-heavy transaction can be many times larger. A left-out transaction the tracker no longer holds at the comparison has no known weight: it adds nothing to that amount and is never displaced. A block with space to spare excuses nothing. Second, within that, highest rates first on both sides, a left-out transaction is displaced when it fits whole in the space the block gave to transactions we did not expect paying at least its rate, less what better-paying left-out ones already took. Whole transactions only, so a small addition never excuses a large omission; the cost is at most one transaction per rate left counted against the miner. An `added` transaction counts at the rate we had placed it at, its chunk's, so a parent mined with the child that pays for it counts at their package rate. An `unseen` one counts at its own fee over its size, since we never saw its package: a parent we never saw is under-counted, never over-counted.
- **Fresh is 60 seconds.** Pools hand out new work about every 30 s, and a transaction must also reach the pool's node. A transaction our node accepted within a minute of the block cannot fairly be expected in it. Measured from when the projector moved onto the block (our clock against the node's accept time, so the two machines' clocks must agree to a second or so), not from the header's timestamp, which the miner sets.
- **The innocent causes this cannot see** are still counted as `missing`, which is why a perfectly honest block can score below 100: a transaction our node accepts but others' policy refuses (a large `OP_RETURN` some miners filter, say), one the miner's node never received, a pool that reserves block space below the 3,992,000 weight units we fill, a package we never saw whose parent pays less than what it displaced, a parent whose child lifted it into the block only seconds before (freshness is each transaction's own arrival, not its chunk's youngest member), and a `prioritisetransaction` that lowers one. Each audit's lists name the transactions, so a reader can look.

**What we do not detect,** and so never report: sigop-limited transactions (we do not count sigops, [Limits](#limits)), prioritised or accelerated transactions (no signal reaches us), and full-RBF replacements (rbitcoin is always full-RBF).

### When there is no audit

An audit exists only for a block we watched arrive with a current projection on its parent; it cannot be computed later or backfilled. The routes say "audit not available", the block facts carry `audit: null`, and the log says why (`block_audit_skipped`, [`LOGGING.md`](LOGGING.md#block-summaries)):

| Case | Why not |
|---|---|
| The projector never moved onto the block from a projection on its parent: older blocks filled in at startup or after a gap. Not logged | We did not watch it arrive |
| `no_projection`: the block is the tip, but there is no projection on its parent, because the server started after it (the first block after a start is always this), or the projector had not reached the block within 5 s of its summary being computed | Nothing to compare with |
| `stale`: the projection on the parent was marked stale (the node had stopped answering) | It was not the mempool when the block came |
| `superseded`: the projection on the parent gave way to a different block (a sibling in a reorg, or a later block in a burst), or the tracker had moved past this block before the comparison | The accept times and `left` would describe another moment |
| A summary computed and cached while the projector was more than 5 s behind the node | Its `audit: null` stays: an audit is attempted once, when the block's summary is computed |
| `store`: the write failed | |
| No `DATA_DIR`, or the network's mempool engine off | Nothing to store or compare; said once at startup, not per block |

The stale flag survives the node's recovery: when the tracker's first good cycle after an outage already carries the new block, the projector publishes that first, so the projection archived for the parent is the stale one. An audit is computed once, when its block arrives, and the first one written stands. A block that leaves the best chain keeps its audit by hash; the pages and the series by height show only the best chain's.

### Cost

None on the node: the block's transactions are the summary's listing, already fetched for every new block, and the rest is in memory. In the server, the comparison runs on a blocking thread under the tracker's read lock (0.2 to 26 ms on regtest, 0.7 and 1.8 ms on mainnet), then one write of about 300 bytes of totals plus 45 bytes per listed transaction, at most 1,000 (`MAX_TXS`, the most telling kinds first). The new block's summary waits for its audit, so its facts carry the audit from the start, at most 5 s. Through `getblock` there was no wait on mainnet: the projector had moved onto the block before the `getblock` returned. The listing route answers in tens of milliseconds, so there the summary waits for the projector instead, about 0.7 s after Electrum's announcement ([When a block is found](#when-a-block-is-found)); not yet measured with the mempool engine on, since the shared nodes run with it off.

### On regtest

With the harness node (`docs/REGTEST.md`), its `generateblock` choosing the block's transactions:

| Block | Score | Categories |
|---|---|---|
| The node's template, taking all 7 | 100 | 7 matched |
| Leaves out the 1 sat/vB one of three that waited over a minute | 66.66 | 2 matched, 1 missing |
| One transaction the node never saw, at 10 sat/vB, beside one it had, the 1 sat/vB one left out again | 50 | 1 matched, 1 unseen, 1 missing: the block had room for it, so the better-paying addition excuses nothing |
| Empty, 3 s after an 8 sat/vB arrival | 0 | 1 fresh, 1 missing (the old 1 sat/vB one) |
| 20 blocks mined at once, the mempool empty | 100 for those audited | 8 audited, 2 `superseded`, 2 `no_projection`; the other 8 were no longer the tip when their summaries were computed |
| The tip when the server started | none | `no_projection` |

### On mainnet

2026-11-12, read-only, release build, 77,000–78,000 transactions in the mempool, two blocks audited (the block current at startup was rightly `no_projection`). mempool.space's public figures for the same blocks beside ours:

| Block | Score | Matched | Missing | Displaced | Fresh | Conflicted | Added | Unseen | mempool.space |
|---|---|---|---|---|---|---|---|---|---|
| 975,537 | 99.93 | 4,130 | 5 | 6 | 21 | 9 | 28 | 9 | 99.76: 10 missing, 23 fresh, 26 added, 1 unseen |
| 975,538 (Foundry USA) | 100 | 3,414 | 0 | 0 | 27 | 1 | 20 | 4 | 100: 0 missing, 28 fresh, 20 added, 0 unseen |

The expected blocks agree: our expected fees and weight were within 0.15% of mempool.space's for both blocks (975,537: 6,401,659 sats and 3,991,807 WU against 6,400,089 and 3,991,797).

**Reading 975,537.** mempool.space's ten missing transactions are our six `displaced` and four of our five `missing`; the fifth, a child, it did not count. The six we excuse were left out for 28 transactions we had placed in the next block and 9 we had not seen, paying at least as much, in a block with no room for both: they are the boundary trade the method excuses, and the whole gap between the two scores. Our five:

- Three 99 vB transactions, each one taproot input to one P2WPKH output at exactly 6 sat/vB, first seen 3.5 to 4.7 minutes before the block, all still unconfirmed when checked. One wallet's batch; both explorers expected them. Most likely the pool's template predated them or its node had not received them.
- A parent at 1 sat/vB and its child at 9 sat/vB, one chunk at 5.03 sat/vB. The parent was 205 s old, but the child that lifted it arrived 87 s before the block, so the package was only worth mining for 87 s: an innocent miss that our per-transaction freshness counts (see the limits above). mempool.space did not count the child.

The nine `conflicted` are exactly the nine transactions the tracker saw the block replace. Of the nine `unseen`, one is a 41-output batch at exactly 5 sat/vB, which looks like a pool's own payout. mempool.space saw the others, so they show where our node was behind.

**Reading 975,538.** 100 in both, with the same 20 added. Its 27 fresh transactions arrived 1 to 7 s before the block. Of our 4 unseen, one pays nothing (0 sat/vB): a miner's own or out-of-band transaction.

**Cost, per block.** The audit made no node call: it took 1.8 ms and 0.7 ms after the summary's `getblock` returned, and that `getblock` (1.8 s and 3.1 s here, under the projector's refresh) and the tracker's and projector's block work were the same calls as without it. The projector had moved onto each block before that `getblock` returned, so nothing waited. Stored: 3.5 KB and 2.3 KB of listed transactions.
