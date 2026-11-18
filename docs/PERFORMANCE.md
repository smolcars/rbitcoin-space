# Performance

How fast the server and the site are, how that was measured, how they compare with the stock mempool backend and with mempool.space, and where we miss a budget. The budgets themselves are in [`ARCHITECTURE.md`](ARCHITECTURE.md#performance-budgets). Measured on 2026-11-12 from `master` at `b58df2b`, release build; the regtest page loads again the same day after [task 4](#4-shorten-the-pages-request-chain-on-slow-networks-done). The scripts are in [`dev/perf/`](../dev/perf/) and [`dev/load/`](../dev/load/), and [How to reproduce](#how-to-reproduce) gives one command for each table. Everything above [On Linux](#on-linux) was measured on macOS; that section is the server on Linux, measured on 2026-11-12 and 13.

## Summary

| Budget | Measured | Verdict |
|---|---|---|
| First-load JavaScript, home page: 100 KB gzipped | 68.1 KB gzipped (`bun run size`, 2026-11-13), in 10 files with the home page's styles (the check fails past 10); 62 KB on the wire with Brotli in Chromium | **Pass** |
| New block, from the node's Electrum announcement to the `block` message on the WebSocket: 50 ms on a node with rbitcoin PR 1577 (on v0.9.2, from when the node can serve the block) | Regtest: 0.7 to 6.1 ms from the node's notification to the last subscriber's queue, 6.1 ms with 9,962 subscribers. Mainnet, here: 12 and 91 ms after the node's upgrade (the only two blocks); on rbitcoin v0.9.2, 13 ms to over 3 s, mostly waiting for the node's Esplora, which we could not separate from our own time. Measured since in [#67](https://github.com/smolcars/rbitcoin-space/pull/67) on upgraded nodes: our `block` message 16 to 44 ms after the node's announcement on mainnet (four blocks) and 6 to 25 ms on signet, the node's own serving included ([details](#the-new-block-on-mainnet)) | **Pass** on regtest and, by #67's measurement, on upgraded mainnet nodes. Of the two upgraded-node blocks in this run, on the code before #67, one took 91 ms |
| Cached or immutable API response, server time: 10 ms at p99 | Answers from memory: p99 0.04 ms (1 client), 0.4 ms (100), 0.8 ms (1,000). Since [the answers kept in memory](#answers-kept-in-memory), a buried block's `/api/block/:hash` and the store-backed routes are among them: p99 at most 0.04, 3.2 and 4.7 ms at 1, 100 and 1,000 clients, where they were 3.1, 156 and 132 ms. Blocks within 100 of the tip are still passed through to the node: p99 1.8 ms (1 client), 16 ms (100), 49 ms (1,000) on regtest; 75 to 89 ms on mainnet over the network to the node (v0.9.2) | **Pass** for answers from memory, store-backed answers and buried blocks. **Miss** for the newest 100 blocks' immutable answers under concurrency or with the node a network hop away, which only a CDN in front absorbs |
| Frame rate during block and mempool animations: 60 fps on a mid-range laptop | No frame interval over 16.8 ms (every frame of a 60 Hz display) through a new block on the home page and through a 601-transaction grid loading, on the machine's GPU. At 4× CPU slowdown: the block the same; the grid load had 1 or 2 intervals of 33 ms or more per run, and one run of three a 224 ms long task that four profiled runs did not reproduce. A slower CPU is not a slower GPU, so this does not stand in for a mid-range laptop | **Pass on this machine; not established on a mid-range laptop** |

| Comparison | In one line |
|---|---|
| The stock mempool backend, same node, same routes | Client-side, paced, over unequal paths: ours answered its `/api/v1` routes in 0.2 to 0.7 ms median on loopback; the reference in 10 to 17 ms median and 450 to 820 ms p99 over the network to its host. These are not server times. Its mining routes took 14 to 54 s, ours under 2 ms (recorded earlier, [`API.md`](API.md#mining)) |
| mempool.space's public site, page loads | Ours moves 115 to 231 KB per cold page, 61 to 72 KB of it JavaScript; mempool.space 838 to 1,351 KB, 714 to 1,220 KB of it JavaScript. As a slow phone (4× CPU, Slow 4G): our first contentful paint at 1.7 s and data at 3.5 to 4.2 s (6.2 s for the next block's 3,400 transactions); on regtest since [task 4](#4-shorten-the-pages-request-chain-on-slow-networks-done), data at 2.9 to 3.5 s with 107 to 239 KB; mempool.space's first contentful paint at 6.3 to 9.1 s. Unthrottled: ours paints in 32 to 48 ms on loopback, mempool.space in 0.5 to 1.1 s across the internet |

The three results that matter most:

1. **Answers from memory hold up; answers that touch the store or the node did not stay under 10 ms with many clients.** One process served 70,000 requests a second from memory at 100 concurrent clients with server time under 0.5 ms at p99. Routes that read the store (`/api/v1/blocks`, a block's summary) cost 8 ms of server time at 100 clients and 46 ms at 1,000, almost all of it building and serializing the same answer again for every request ([task 2](#2-build-store-answers-once-per-tip)). Since then those answers, and a buried block's immutable ones, are kept in memory until they can change: 0.01 ms median at every load, and 80,000 to 130,000 requests a second at 1,000 clients where 11,000 to 28,000 were answered before ([Answers kept in memory](#answers-kept-in-memory)).
2. **On Linux every update reached every reader at every step up to 20,000 sockets, the most measured; the stall seen past 8,000 belongs to the macOS host.** A block reached its last reader 54 ms (median) after the server started queueing it with 20,000 sockets, on a quarter of a core. What stops a Linux deployment first is a limit an operator sets: `WS_MAX_SOCKETS`, then the process's open-file limit, at which the server stopped accepting without a word in the log (it now logs `accept_failed`). The server also asked the kernel for a listen queue of 128 whatever the host allowed, so a burst of 10,000 connections overflowed it 12,000 to 18,000 times; it now asks for the host's maximum ([On Linux](#on-linux), [task 5](#5-find-what-stops-websocket-delivery-past-8000-sockets)).
3. **A single client that floods the API costs us 17 to 27 µs of CPU per refusal, and almost no log.** The limits work: the flood's 103,000 to 126,000 requests a second were refused in 0.005 ms of server time each, and ordinary clients beside it were never refused. That is still 3.4 to 3.8 cores, which only a proxy or firewall in front can save. The log, which grew by 772 to 911 MB in 30 s while each refusal was a line, now grows by under 1 MB: refusals are counted ([task 3](#3-count-refusals-instead-of-logging-each)).

## Where we miss, and what to do

No budget miss had a fix small and clear enough to make in this change: the one budget miss needs a new cache in the Esplora pass-through, and the other findings are not budgets. Every task below has been done since, each saying how; they stay here as the evidence. The first is a bug the mainnet run found, fixed by [#67](https://github.com/smolcars/rbitcoin-space/pull/67).

### 0. Follow the block table when a new block's JSON comes late (done in #67)

- **Evidence.** At 13:54:23 UTC the node (still rbitcoin v0.9.2, before the upgrade below) announced block 975,560 over Electrum and its Esplora did not serve the block within the hub's 3 s (`block_unavailable`), so the hub told subscribers to `resync`. The block table follows the tip only when the hub reports a new tip to the summaries ([`blocks.rs`](../crates/server/src/blocks.rs), `follow` waits on `summaries.tips()`), and the hub reports it only after a successful fetch ([`ws/hub.rs`](../crates/server/src/ws/hub.rs), `block`). So the table stayed one block behind until the next block, 13 minutes later: at 14:01, `/api/v1/block/:hash` for the tip answered `503 not ready yet` to all 51 requests, `/api/v1/blocks` left the tip out, and the block got no summary and no audit. The upgraded node fixes the stall that made its Esplora late, so this should now be rare, but any block the hub cannot fetch within 3 s still leaves the table behind.
- **Expected gain.** The table catches up within its retry pause (1 to 5 s) instead of a block interval.
- **Touches.** `crates/server/src/ws/hub.rs` (on the failure path, still wake the table's follower, without starting a summary for a block that was not announced, which the hub's ordering rules out), a test in `crates/server/src/ws/tests.rs`.

### 1. Hold immutable node answers in memory

- **Evidence.** `/api/block/:hash` is immutable (served `immutable`, [`API.md`](API.md#cache-headers)) but every request is a node call. Server p99 on regtest: 1.8 ms at 1 client, 16 ms at 100, 49 ms at 1,000. On mainnet (node on v0.9.2), paced at 5 a second: median 9.2 ms and p99 75 ms, where the same block from memory would be 0.2 ms. The `v1` block routes already keep these headers by hash (`v1_blocks::Headers`, 4,096 of them).
- **Expected gain.** Immutable answers at memory speed: p99 under 1 ms at 100 clients, and no node round trip. The design leaves immutable answers to a CDN in front ([`ARCHITECTURE.md`](ARCHITECTURE.md#http-surface)); without one, the budget is missed.
- **Touches.** `crates/server/src/esplora.rs` (a bounded cache for the routes it marks immutable, keyed by path), its tests, [`API.md`](API.md#protection-for-the-node).
- **Done since,** for blocks at least 100 under the tip, the block table's follow zone: a block within it may still leave the chain, so it is not kept. A buried block's `/api/block/:hash` went from p99 0.7, 4.3 and 36 ms at 1, 100 and 1,000 clients to 0.04, 3.2 and 0.3 ms, with no node call after the first ([Answers kept in memory](#answers-kept-in-memory)).

### 2. Build store answers once per tip

- **Evidence.** `/api/v1/blocks` and `/api/v1/block/:hash` make four store reads each (the table's top, the page, the audits, the top again) and serialize 15 blocks (19 KB) per request; a block's summary makes two. At 100 concurrent clients their server median was 8 ms against 0.01 ms for routes answered from memory, and the server spent 4 cores for 22,000 requests a second. A sample of the process under that load shows the time in `serde_json` and hex formatting of hashes, with the runtime threads mostly idle. Giving the store 10 reader connections instead of 4 changed nothing at 100 clients and gained 30% throughput at 1,000 (35 against 46 ms median), so the pool is not the cause.
- **Expected gain.** These routes at memory speed between blocks: the answer for the tip list changes once a block, like the mining answers, which are already computed once and served from memory (0.01 ms).
- **Touches.** `crates/server/src/v1_blocks.rs` and `summary.rs` (keep the serialized answer keyed by the table's top), [`API.md`](API.md#blocks).
- **Done since,** keyed by a version the store keeps per table rather than by the top, so a backfilled row or a new audit counts too: `/api/v1/blocks` went from a median of 8.8 and 49 ms at 100 and 1,000 clients to 0.01 ms, and the store class from 21,000 to 114,000 requests a second at 100 clients ([Answers kept in memory](#answers-kept-in-memory)).

### 3. Count refusals instead of logging each

- **Evidence.** One client at 64 connections sent 103,000 requests a second. All but 32 a second were refused with `429` in 0.005 ms of server time, and 100 ordinary clients beside it kept a median of 2 ms and were never refused. But the server used 3 cores (busiest second 4) and wrote 3.1 million `http_request` events, 772 MB in 30 s, and dropped some (`log_events_dropped`). `LOG_REQUESTS=failures` would log the same lines, since a `429` is a failure. With `LOG_REQUESTS=off` the same flood still took 3.4 cores against 3.8 with logging, so the log costs about 0.4 cores and the disk (911 MB in that run); the rest is the HTTP work of refusing, which only a proxy or firewall in front can save.
- **Expected gain.** A flood costs the refusal only, and the log stays useful and its disk bounded. Count `client_rate` refusals per client and log the count at 1, 2, 4, 8… as `connections_refused` already does.
- **Touches.** `crates/server/src/request_log.rs`, `limits.rs`, the event catalogue in [`LOGGING.md`](LOGGING.md).
- **Done since.** Refusals are counted in one `requests_refused` a minute, the whole log has a ceiling, and an over-limit request is refused before it is routed ([`LOGGING.md`](LOGGING.md#what-a-client-can-make-us-write)). The same flood on the same machine, back to back with the build before: 27 to 17 µs of CPU per refusal, and 1,080 MB of log in 30 s to under 1 MB.

### 4. Shorten the page's request chain on slow networks (done)

- **Evidence.** As a slow phone every page shows its data 1.9 to 2.5 s after the load event. The home page's waterfall: the HTML (0.58 s), then the entry script, font and styles (to 1.66 s), then the home chunk and 15 small JavaScript and CSS chunks requested together at 1.68 s, which fill the browser's six HTTP/1.1 connections, so `/app/config`, requested at 1.70 s, is answered only at 3.46 s. The socket opens after it and its first message arrives at 4.09 s, then the block summaries at 4.69 s. Each step costs a round trip of about 0.56 s on this profile.
- **Expected gain.** About 1 to 1.5 s on a slow network: fetch `/app/config` from `index.html` (a preload, or the values inlined at build time), and merge the home page's small chunks. Behind a proxy that speaks HTTP/2, which a TLS deployment usually does, the six-connection queue disappears without code; these measurements are plain HTTP/1.1 to the server.
- **Done since (PF4).** The cause was the number of files, not the config. Nothing a page shows waits for `/app/config` (the shell reads it for the network switch and the footer only); it was answered late because it queued behind the chunks, and the page's own code was queued with it. The shell, the small components most pages use and the clock now travel as one chunk with one stylesheet ([`FRONTEND.md`](FRONTEND.md#chunks)), so a cold home page needs 10 files instead of 23, and `bun run size` fails past 10. Everything that queued now fits the six connections in one round. Measured back to back on regtest from `master` at `3e28d25` and the same with this change, five cold loads each, as a slow phone (median, with the range):

  | Page | Data shown ms, before | after | Longest chain, before | after | Config answered ms, before | after | Requests | KB transferred (JavaScript) |
  |---|---|---|---|---|---|---|---|---|
  | home | 4,157 (4,137–4,170) | 3,073 (3,059–3,082) | 6 | 4 | 3,526 | 2,302 | 26 → 13 | 129 (69) → 118 (62) |
  | block | 4,184 (4,181–4,187) | 3,079 (3,075–3,091) | 6 | 4 | 4,003 | 2,302 | 32 → 18 | 136 (74) → 124 (66) |
  | tx | 4,077 (4,066–4,085) | 3,066 (3,060–3,090) | 6 | 4 | 3,446 | 2,295 | 24 → 14 | 128 (72) → 120 (67) |

  First contentful paint did not move (1.72 to 1.75 s), nor did anything unthrottled beyond the runs' spread. "Longest chain" is the longest run of requests each sent, on the wire, only after the one before it had finished, among those done before the data showed: a wait for a free connection counts as a step. Every page moves fewer bytes, because the headers of 10 to 14 fewer responses outweigh the code a page now loads without using (`DataTable` and `Strata` on the transaction page, about 2 KB). `bun run size`: 69.3 KB of first-load JavaScript before, 65.7 KB after. The pages look the same: 10 pages at 1280 and 393 px in light and dark, captured from both builds on one node, matched pixel for pixel except the mempool page's chart at its live edge, which differs as much between two servers on the old build (each records its own history).
- **Left out.** Sending `/app/config` earlier (a preload, or the values in the HTML) would change nothing a reader sees: it is now answered 0.8 s before the data on every measured page. What remains is three round trips in a row: the entry script, the page's chunk (the entry asks for it once it runs), then the socket or the API call the page makes. Asking for the page's chunk from `boot.js` could start it one round trip earlier (about 0.5 s on this profile, not measured), but `boot.js` would need its own copy of the route table and the build's file names; not tried.
- **HTTP/2.** Behind a proxy that speaks HTTP/2 to browsers, what is left of the connection queue goes too; the round trips stay. Not measured here.

### 5. Find what stops WebSocket delivery past 8,000 sockets

- **Evidence.** Up to 8,000 sockets every message reached every reader (57 ms for the last reader of a block). At 10,000, on this Mac with the clients on the same machine, many readers had not received messages by the end of each run, whether one client process held the sockets or two held 5,000 each, while the server queued each block to all of them in 2.3 to 5.8 ms. Kernel network buffers went from 10,900 in use at 8,000 sockets to 80,000 of 89,450 at 10,000, past macOS's 80% pressure threshold; but the count of buffer requests denied did not move, and nothing measured the server's per-socket writers, so a delay there is not ruled out. Connection storms also overflow the listen backlog (`kern.ipc.somaxconn` 128 on macOS): 37 to 354 of 10,000 connections opened 200 at a time were reset.
- **Expected gain.** Knowing whether the server or the host limits a deployment, and the kernel settings an operator needs for thousands of sockets.
- **Touches.** A run with the clients on another machine; a measure of how far each socket's writer lags behind its queue (a field on an existing event, [`LOGGING.md`](LOGGING.md)); then [`DEPLOY.md`](DEPLOY.md). Not measured on Linux, where the defaults differ.
- **Done since (PF5), on Linux** ([On Linux](#on-linux)). No stall up to 20,000 sockets: every message of every run reached every reader, whether the load generator ran as one process beside the server, one process in a network namespace of its own or four. The server's writers did not lag: a block's last reader at 20,000 sockets was 54 ms (median) after the server started queueing it, and one runtime worker instead of four made that 126 ms, so delivery is the server's CPU writing to each socket and scales with cores. What stops a deployment first is a limit: `WS_MAX_SOCKETS` (`503`, logged in `requests_refused`), then the open-file limit, where the server stopped accepting and logged nothing, while its own connections to the node failed too (a mempool refresh took 13.9 s); it now logs `accept_failed`. On the client side, one source address reaches one server port at most 28,232 times at Linux's default port range, connections in `TIME_WAIT` included, which a reverse proxy in front meets too. And the server asked for a listen queue of 128 whatever the host allowed (tokio's `bind` does), so 10,000 sockets opened at once overflowed it 12,178 and 18,453 times; it now asks for the host's maximum: 0 and 212 overflows, every socket open in 0.3 and 1.2 s instead of 2.8 and 3.3 s. Host settings are in [`DEPLOY.md`](DEPLOY.md#many-websockets).
- **The macOS stall was not measured again.** The same server and load generator deliver everything on Linux, so it is a property of that host: both ends of 20,000 connections on one machine, with macOS's network buffers 89% in use. The load generator made it worse there: it read no socket until every socket had opened, so messages piled up in kernel buffers while the slower ones connected (33 MB in one Linux run whose connections took three minutes). It now reads each socket from the moment it opens.

### 6. Reads that grew with the block table (done)

- **Evidence.** Once the demo server's mainnet block table was full (975,660 rows, a 547 MB file), its log showed store reads hitting their 2 s limit on 2026-11-13: `store_read_timed_out` with `read: mining` 5, 3 and 10 times in the hours from 10:00 to 12:21 UTC, and with `read: block_counts` 4, 2 and 3 times, each `mining` one beside a `mining_failed` (`task: refresh`). Signet (330,000 rows) and testnet4 had one each. The machine ran other builds at load 10 to 20 then; on a quiet moment the same reads were well inside the limit. They cost a full pass over the table each, and ran on every block or every minute.
- **Done.** The block table keeps running totals per day, per block series point and per pool per 1,008 heights and per week, recomputed from their rows in the same write as any change ([`STORE.md`](STORE.md#totals)). Reads over long ranges add up buckets; the ends of a range are scanned. Proved exact against a full scan through a long random run of every kind of change.

Every read that runs on a schedule or per block, measured on a copy of that mainnet store (975,672 rows) on 2026-11-13, median of five, with `table_reads_benchmark` and `answers_benchmark` ([How to reproduce](#how-to-reproduce)). Load average 8 to 13 for the reads before, 13 to 50 after (other builders on the machine); before, the same reads with a writer committing 10,000-row writes back to back were 4 to 7% slower; after, no different.

| Read | Runs | Statement and plan before | Before | After | How |
|---|---|---|---|---|---|
| `span`: how far the stored history reaches | Every minute and after every `follow` write (the mining refresh's fingerprint) | `SELECT height, time … WHERE height BETWEEN` 10,000 at a time: `SEARCH blocks USING INTEGER PRIMARY KEY`, every row | 93 ms | 0.08 ms | Read less: skip the full 1,008-height buckets, walk only the first that is not full |
| `row_counts` and the backfill's progress counts | Every minute in the mining refresh; every minute for good in the backfill, done or not | `count(*)`: `SCAN blocks USING COVERING INDEX blocks_pool`; `count(*) WHERE rated = 0`: `SCAN … blocks_unrated` | 11 ms | 0.06 ms | A sum of the buckets; and the backfill stops reporting once it is done |
| The backfill's pass over the table | Every new tip, done or not | `SELECT height … WHERE height BETWEEN` 10,000 at a time over every height: `SEARCH blocks USING INTEGER PRIMARY KEY` | 98 ms | 0.05 to 3 ms | Skip the 1,008-height buckets that hold every height |
| `pool_counts` over all of history | Every refresh (`pools/all`, every pool's statistics) | `GROUP BY pool`: primary-key range, `USE TEMP B-TREE FOR GROUP BY`, `… ORDER BY` | 228 ms | 2.2 ms | Totals per pool per 1,008 heights |
| `pool_weeks` over all of history | Every refresh (`hashrate/pools/all`, every pool's weekly shares) | `GROUP BY w, pool`: primary-key range, temp B-tree | 260 ms | 3.0 ms | Totals per pool per week |
| `periods` by day, all of history (three years) | Every refresh (`hashrate/…` for `1y` and over, every pool's shares) | `GROUP BY k`: primary-key range, temp B-tree | 568 ms (89) | 3.8 ms (0.8) | Totals per day |
| `periods` by 1,008 (all), 216 (`3y`), 144 (`2y`), 72 (`1y`), 36 (`6m`) heights | Every refresh (the five block series) | The same | 573, 87, 59, 34, 17 ms | 0.5 to 0.6 ms each | Totals per series point |
| `first_since` three years back | Every refresh, about five times per interval | `min(height)` over `blocks_time` from the time on: `SEARCH … COVERING INDEX blocks_time (time>?)` | 3.3 ms | 0.09 ms | The rest of the day from the index, the later days from their totals |
| `audit::pool_health` over all of history (the audits' averages) | Every refresh (`pools/:interval`, every pool's statistics) | `SEARCH b USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)` then the audit by hash: every block row, for 129 audits | 164 ms | 0.10 ms | Read less: driven from the audits (`CROSS JOIN`): `SEARCH a USING INDEX audits_height` |
| `retargets`, `work` | Every refresh | `json_each` of the retarget heights; a 1,008-row primary-key range | 0.6, 0.07 ms | the same | Already bounded |
| The answers kept in memory ([#77](https://github.com/smolcars/rbitcoin-space/pull/77)): block pages, summaries, audit pages | The first request after the block table or the audits change | Pages by height and lookups by hash | 0.04 to 0.3 ms | the same | Already bounded. `predictions/:interval` scans the audits, which grow by about 52,000 rows a year, not with the block table |
| `follow`'s reads, `reattribute`'s check | Every new tip; at start | The newest 100 rows; the list version and the top row | under 1 ms | the same | Already bounded |

**What a new block costs now,** with every mining route and every interval asked for (52 computations, 391 answers), measured with `answers_benchmark` on the same copy:

| Work per new block | Before | After |
|---|---|---|
| The row's write, its totals settled in it | 0.3 to 0.4 ms | 1.1 to 1.9 ms (4 ms in a burst) |
| The refresh's fingerprint (`span` and the counts) | 119 to 136 ms | 0.2 ms |
| The backfill's pass, once it is done | 98 ms | 0.05 to 3 ms |
| Recomputing every mining answer | 9.5 to 11.3 s | 47 to 53 ms, at load 7 as at load 50 (66 to 135 ms during bursts of other builds) |
| The first answer of each mining route after a start | up to 1,395 ms (every pool's statistics), 998 ms (`hashrate/pools/all`) | at most 14.6 ms (every pool's statistics); 9 ms (`hashrate/pools/all`) |

Recomputing every answer shares the reads its answers have in common (the network's hashrate points, the pools' weekly counts, the hashrate of the newest blocks) and computes an interval's five block series from one read. What is left is spread over the 52 computations, about 1 ms each: scanning the rows of the periods kept as rows (a month or less), the two ends of each range, and serializing 391 answers, most of whose bytes are every pool's weekly shares.

**How each scales,** on generated tables of 100,000 and 1,000,000 rows (`TABLE_BENCH_ROWS`), median ms:

| Read | Before, 100k | Before, 1M | After, 100k | After, 1M |
|---|---|---|---|---|
| `span` | 6.7 | 64 | 0.03 | 0.07 |
| `row_counts` | 0.2 | 7.8 | 0.02 | 0.06 |
| The backfill's pass | 6.6 | 64 | 1.6 | 0.05 |
| `pool_counts`, all | 20 | 205 | 0.29 | 3.1 |
| `pool_weeks`, all | 26 | 244 | 0.37 | 3.9 |
| `periods` by day, all | 53 | 543 | 0.45 | 4.2 |
| `periods` by 1,008, all | 55 | 545 | 0.08 | 0.62 |
| `audit::pool_health`, all | 5.2 | 50 | 0.02 | 0.02 |

Before, every one grew with the rows, ten times for ten times the rows. After, a read over all of history grows with its buckets: days (about 6,500 on mainnet) for the daily and weekly ones, 1,008-height buckets (968) for the others, and pools in each. Ten years more of blocks add about 3,650 days. The backfill's pass costs what is still missing, not what is there (the 100k table's top bucket was part-filled, so its pass read those heights).

**Targets** (on the full-size store, this machine, quiet):

| Target | Result |
|---|---|
| The work done per new block under 50 ms in total | **Met for the store's own work**: write, settle, fingerprint and the backfill's pass take 1.3 to 5 ms. **At the line with every answer asked**: the refresh of all 391 answers took 47 to 53 ms, so the total is 49 to 58 ms. The quietest the machine got was load 7, and the figure was the same there; bursts of other builds gave 66 to 135 ms. By computation: every pool's statistics 13 ms, the ten pool rankings 11 ms, the ten block series families 11 ms, the hashrate charts 15 ms. With the answers a real page asks for (a few routes), it is a few milliseconds. To leave a margin with everything asked: keep the 6-height series (`1m`, 162,000 more rows) and a slimmer daily read for the hashrate points, about 5 ms between them |
| No scheduled read over 250 ms | **Met**: the slowest is 4.2 ms (`periods` by day over all of a million rows). During the one-time fill after the upgrade (4.6 s on mainnet) reads scan as before |
| The first answer of every mining route after a start under 250 ms | **Met**: at most 14.6 ms. Until the fill is done, on the first start after the upgrade, they cost what they did before |

## The machine and the method

- **Hardware.** Apple M4 (10 cores: 4 performance, 6 efficiency), 24 GB, APFS SSD, macOS 27.0.1. Server, node, load generator and browser all on this machine.
- **Shared.** Other builders compiled and tested on the same machine throughout: the 1-minute load average was 5 to 50 (median 16) during the first pass of the server measurements. Every server figure here is therefore pessimistic and noisier than on a quiet machine; where two passes were run, tables give the range across them.
- **Builds.** `cargo build --release --locked`, Rust 1.99.1; the frontend from `bun run build`, served with its precompressed `.br` files.
- **Nodes.** Load ran only against a private rbitcoin v0.9.2 regtest node in Docker ([`REGTEST.md`](REGTEST.md)) with transactions arriving from [`activity.py`](../dev/perf/activity.py). Mainnet was used for the 30-minute footprint, light paced timings (5 requests a second, 51 per route) and page loads, read-only. **The shared mainnet node changed during the measurements:** it ran rbitcoin v0.9.2 until 14:03 UTC, then was restarted on a build of rbitcoin's `master` that fixes the node stalling Electrum and Esplora after a new tip. The paced timings (13:30 and 14:00 UTC), our mainnet page loads (13:33 to 13:41 UTC) and the first footprint run were against v0.9.2; the second footprint run was against v0.9.2 for its first 13 minutes and the new build after.
- **Percentiles** are nearest-rank. Client times are measured by the load generator from sending a request to reading the whole body; server times are the server's own `duration_ms` (until the response head is ready) from its log, read by [`serverlog.py`](../dev/perf/serverlog.py).
- **Limits.** Clients name themselves in `X-Forwarded-For`, trusted from 127.0.0.1 only, so each virtual client is a client of its own to the limiter, as it would be from its own address. The HTTP throughput runs raise `CLIENT_RATE_PER_SEC` and `CLIENT_BURST` to 1,000,000 through settings, so the server, not one client's allowance, is measured; every other limit is at its default, including `MAX_CONCURRENT_REQUESTS` (256). The WebSocket runs raise `WS_MAX_SOCKETS` to 20,000. The limits runs use every default. Defaults in the code are unchanged.
- **When.** Load bursts were at most two minutes, 15 s apart, one at a time: pass 1 from 12:47 to 13:10 UTC, pass 2 from 13:56 to 14:18 UTC (load average 4 to 12), and the experiments between and after them (store readers, the flood without logging, 2,000 to 10,000 sockets), made by hand with the same settings and since added to `bench.sh`. After review, the load generator was changed to bound every run, to report a message's last reader only when every subscriber got it, and to time frames over the recorded window; Docker on the machine was stopped at 16:59 UTC, before the affected steps could be run again, so the figures below come from the earlier runs and are reported only where those changes do not alter them. The mainnet footprint ran twice: 13:20 to 13:47 UTC (stopped by a time limit at 27 minutes) and 13:50 to 14:23 UTC (33 minutes).

## The server under load

### Route classes

Each run is 15 s of closed-loop clients, each on its own connection, cycling through the class's routes:

| Class | Routes |
|---|---|
| memory | `/api/v1/fees/mempool-blocks`, `/api/v1/difficulty-adjustment`, `/api/blocks/tip/height` (held for 1 s), `/app/block/:hash/summary` (the summary is cached in memory, but the route reads the store twice) |
| immutable | `/api/block/:hash` (block 106 in the runs below; `bench.sh` now asks for block 1, which is buried, [Answers kept in memory](#answers-kept-in-memory)) |
| store | `/api/v1/blocks`, `/api/v1/mining/pools/1w`, `/api/v1/statistics/24h`, `/api/v1/block/:hash` |
| node | `/api/tx/:txid`, `/api/block/:hash/txs`, `/api/tx/:txid/outspends`, `/api/address/:address` |

Two passes (12:47 and 13:56 UTC); each cell is the range across them. Client times are over loopback; CPU is the server's mean over the run, in cores.

| Class | Clients | Answered per second | Refused | Client p50 / p99 ms | Server CPU | Server RSS MB |
|---|---|---|---|---|---|---|
| memory | 1 | 11,948–21,604 | 0% | 0.03–0.05 / 0.14–0.54 | 0.6–0.8 | 35–36 |
| memory | 100 | 70,399–83,435 | 0% | 0.74–0.87 / 5.2–6.5 | 4.2–4.8 | 20–42 |
| memory | 1,000 | 29,026–45,126 | 56–58% | 7.9–11.8 / 46–104 | 2.7–4.5 | 40–65 |
| immutable | 1 | 2,101–4,862 | 0% | 0.19–0.30 / 0.51–2.8 | 0.2–0.3 | 14–65 |
| immutable | 100 | 27,093–94,225 | 0% | 1.0–2.2 / 2.8–26 | 1.2–4.2 | 18–44 |
| immutable | 1,000 | 18,459–27,999 | 76–81% | 13–19 / 43–68 | 3.2–3.9 | 41–46 |
| store | 1 | 7,546–11,106 | 0% | 0.08–0.09 / 0.26–0.71 | 0.8–0.9 | 15–47 |
| store | 100 | 22,645–26,446 | 0% | 3.8–4.9 / 10–13 | 4.0–4.4 | 21–50 |
| store | 1,000 | 10,594–11,047 | 89% | 32–36 / 84–92 | 4.1–4.2 | 45–53 |
| node | 1 | 1,419–1,580 | 0% | 0.35–0.39 / 1.9–2.3 | 0.1 | 45–51 |
| node | 100 | 41,851–51,289 | 0% | 1.6–1.7 / 7.1–13 | 2.0–2.3 | 35–49 |
| node | 1,000 | 14,060–24,403 | 78–84% | 14–23 / 50–92 | 2.8–3.6 | 42–51 |

Server time per route, p50 / p99 ms, at 1, 100 and 1,000 clients (answered requests only):

| Route | 1 | 100 | 1,000 |
|---|---|---|---|
| `/api/v1/difficulty-adjustment` | 0.00–0.01 / 0.02–0.04 | 0.01 / 0.40–0.42 | 0.01 / 0.49–0.82 |
| `/api/v1/fees/mempool-blocks` | 0.00 / 0.02–0.04 | 0.01 / 0.39–0.42 | 0.01 / 0.46–0.80 |
| `/api/v1/mining/pools/1w` | 0.01 / 0.01–0.04 | 0.01 / 0.09–0.14 | 0.01 / 0.62–0.74 |
| `/api/v1/statistics/24h` | 0.00 / 0.01–0.04 | 0.01 / 0.08–0.12 | 0.01 / 0.69–0.90 |
| `/api/blocks/tip/height` (held 1 s) | 0.00 / 0.02–0.04 | 0.01 / 0.46 | 0.01 / 1.5–6.5 |
| `/app/block/:hash/summary` | 0.04 / 0.13–0.54 | 2.0–2.2 / 5.8–7.5 | 22–31 / 38–96 |
| `/api/v1/blocks` | 0.15 / 0.27–0.73 | 7.2–8.3 / 11–14 | 46 / 72–87 |
| `/api/v1/block/:hash` | 0.07 / 0.15–0.51 | 7.0–8.0 / 10–13 | 45–46 / 71–85 |
| `/api/block/:hash` (node) | 0.16–0.25 / 0.44–1.8 | 0.53–1.2 / 1.8–16 | 6.8–11 / 31–49 |
| `/api/tx/:txid` (node) | 0.25–0.28 / 0.59–0.87 | 0.79–0.80 / 4.4–8.5 | 7.5–14 / 37–73 |
| `/api/block/:hash/txs` (node) | 0.32–0.35 / 0.65–0.99 | 0.84–0.86 / 4.8–7.0 | 7.5–14 / 39–64 |
| `/api/tx/:txid/outspends` (node) | 0.22–0.25 / 0.46–0.73 | 0.74 / 4.7–7.6 | 7.2–14 / 33–66 |
| `/api/address/:address` (node, cost-limited) | 1.4–1.5 / 2.3–2.9 | 1.7–1.9 / 6.0–10 | 9.9–16 / 41–81 |

The regtest node is on the same machine; on mainnet a node call adds the network to the node and the node's own work ([`RBITCOIN.md`](RBITCOIN.md#measurements)).

At 1,000 clients every class is refused in part: with 1,000 requests in flight and `MAX_CONCURRENT_REQUESTS` at 256, the rest get `503` at once, as designed. The answered throughput then falls below the 100-client figure because the refusals and their log lines take a share of the cores. Address routes are additionally held to four running and eight waiting per network ([`API.md`](API.md#protection-for-the-node)).

### What the limits do

Every limit at its default; two passes, ranges across them.

| Run, 30 s each | Sent per second | Answered per second | Refused (`429`) | Client p50 / p99 ms, answered | Server CPU |
|---|---|---|---|---|---|
| A heavy user: one address, 6 connections, 4 a second each | 24 | 24 | 7–8 | 1.0–1.1 / 10–12 | under 0.01 |
| 100 ordinary clients, 2 a second each, alone | 203 | 203 | 0 | 1.3–1.4 / 8.7–8.8 | under 0.01 |
| The same 100, beside a flood | 203 | 203 | 0 | 1.3–2.0 / 6.2–11 | 3.0–3.8 |
| The flood: one address, 64 connections, no pause | 103,000–121,000 | 28–32 | 3.1–3.6 million | 0.6–0.7 / 2.6–12 | (in the line above) |

- **An honest heavy user**, a script sending 24 requests a second in all, just over `CLIENT_RATE_PER_SEC` (20): 7 or 8 of about 730 requests in 30 s were refused, after the burst of 120 was spent, each with `Retry-After: 1`; every other answer came at full speed. A browser user does not come near this: the heaviest page makes 13 API requests ([`CONFIG.md`](CONFIG.md#per-client-defaults)).
- **A client that hits the limits** is refused in 0.005 ms of server time (the server's own `duration_ms`, p50) and leaves everyone else's answers alone: the 100 ordinary clients beside it were never refused and kept their median within 0.7 ms. It costs us CPU: about 28 µs per refusal, so the flood took 3.4 to 3.8 cores. With `LOG_REQUESTS=off` the same flood took 3.4 cores against 3.8 with the default, so most of that is the HTTP work of refusing and about 0.4 cores is the log, which grew by 911 MB in 30 s ([proposed task 3](#3-count-refusals-instead-of-logging-each)). Across the internet one client rarely reaches loopback rates; a proxy or firewall in front is the place to stop a flood before it costs anything.

### The WebSocket

Every socket subscribes to `blocks`, `mempool`, `projected` and `transactions` (the home page), and one in ten also to `projected-txs:0`. Regtest takes 20 transactions a second and a block every 30 s; each step runs 90 s. Each message is identified by its bytes, which every subscriber shares, so the load generator knows which sockets read it and when the first and the last did; for blocks it joins that with the server's `ws_fanout` event, which says when the message was queued (log timestamps are to the millisecond). A last-reader time means something only if every subscriber got the message: in every run up to 8,000 sockets, every message reached every reader (checked from the recorded counts); in the 10,000-socket runs they did not, so that row gives counts instead.

Two passes of 90 s for 100, 1,000 and 10,000 sockets. The 2,000, 5,000 and 8,000 rows are single 40-second runs made afterwards to find the knee, under the same activity but with the home page's topics only: no socket subscribed to `projected-txs:0`, so those rows carry less traffic than the others and are not directly comparable with them. `bench.sh` now runs every step with the same subscriptions. "Queued" is the server's own time to put a block on every subscriber's queue (`fanout_ms`); the reader times are as the load generator saw them.

| Sockets | Block queued to all, ms | Block, queued → last reader, ms (max) | Mempool update, first → last reader, ms (median / max) | Server CPU, mean / busiest second | Server RSS MB |
|---|---|---|---|---|---|
| 100 | 0.01–0.07 | 1.3 | 0.5 / 2.0–4.5 | 0.003 / 0.02 cores | 17–35 |
| 1,000 | 0.12–1.1 | 7.3–7.5 | 6.2 / 12–15 | 0.02 / 0.10 | 23–35 |
| 2,000, home topics only | 1.0 | 11 | 16 / 29 | | |
| 5,000, home topics only | 2.4 | 34 | 28 / 49 | | |
| 8,000 (7,929 opened), home topics only | 9.3 | 57 | 45 / 69 | 0.13 / 0.65 | 76 |
| 10,000 (9,646 to 10,000 opened) | 2.3–5.8 | Incomplete: blocks reached 2 to 9,012 of 9,962 readers (pass 1) and 372 to 8,306 of 10,000 (pass 2) by the end of the run | Incomplete: some updates reached a single reader | 0.06–0.15 / 0.6–1.0 | 81–96 |

A `projected-txs:0` delta reached its last reader within 7 ms at 100 sockets and 24 ms at 1,000. Resident memory is the process's high-water mark and carries over from earlier steps on the same server; at 9,962 sockets it was 81 MB against 17 MB at 100, about 6.5 KB a socket. The load generator used under 0.1 core throughout.

- **Where it stops scaling.** Between 8,000 and 10,000 sockets on this machine. Up to 8,000 the last reader had a block 57 ms after it was queued, the time growing with the sockets, each of which has its own writer task and its own write. At 10,000 the queueing was still fast (2.3 to 5.8 ms, under a sixth of one core on average, one core at the busiest second), but delivery was not: the readers that were reached got messages up to 26 s after the first, and many were not reached before the run ended, whether one client process held all the sockets or two held 5,000 each. **Why is not established** ([proposed task 5](#5-find-what-stops-websocket-delivery-past-8000-sockets)): the kernel's network buffers were 89% in use, which points at the host, but the count of denied buffer requests did not grow and the server's per-socket writers were not timed. A server with its clients elsewhere holds half as many sockets on its host; this was not measured.
- **A slow client.** 50 sockets that subscribed to the two largest topics and never read, beside 1,000 that did. Nobody else was slowed (the block reached the last of the 1,000 within 12 ms). The 50 were not closed for a full send queue: the kernel's socket buffers took what was sent to them, so their queues never filled. They were closed after 61 s for silence (`4004`, `WS_IDLE_TIMEOUT_SECS`), since a client that reads nothing answers no ping.

### Footprint

| | CPU, share of one core | Resident memory |
|---|---|---|
| Regtest, idle, no clients | 0.0% | 10 MB |
| Regtest, 20 transactions a second, no clients | 0.1% | 13 MB |
| Mainnet, mempool engine off, 3 minutes, two runs | 0.2 to 0.3% | 78 to 122 MB |
| Mainnet, live mempool, 33 minutes, across the node's upgrade (59,000 to 63,000 transactions) | 4.0% mean; 0.2 to 6.2% by the minute | 107 to 175 MB; 145 to 175 MB in the last 10 minutes |
| Mainnet, live mempool, the 27-minute run, rbitcoin v0.9.2 (60,000 to 66,000 transactions) | 4.2% mean; 3.6 to 5.5% by the minute | 105 to 186 MB |

On mainnet the engine read 103 to 230 MB a minute from the node (25 to 54 tracker cycles a minute), more at times than the 150 MB [`CONFIG.md`](CONFIG.md#the-live-mempool) states for a 54,000-transaction mempool; the initial sync read 258 to 263 MB in 11 to 15 s for 61,000 to 64,000 transactions. Memory did not grow over the 33 minutes beyond the mempool's own size. The node's upgrade restarted it during the second run (14:03 to 14:04 UTC); the server reported it unreachable, recovered on its own and went on, so the footprint covers both node versions.

The mainnet runs above predate keeping each mempool transaction's outputs for the compare view, which adds 45 to 68 bytes a transaction in a synthetic 300,000-transaction mempool (2.5 to 3.7 MB at 55,000), capped at 32 MiB per network ([`MEMPOOL.md`](MEMPOOL.md#outputs-kept-for-the-compare-view)); not yet measured on mainnet.

### The new block on mainnet

The server's `ws_fanout` event times a block from the node's Electrum notification to the last subscriber's queue. After the node's upgrade two blocks arrived, at 12 and 91 ms. Before it, on rbitcoin v0.9.2 (five blocks over the two runs), 13 ms, then 0.40, 1.10 and 1.61 s, and once over 3 s (the blocks already there when the server started are not counted). The hub asks the node's Esplora for the block every 25 ms until it is served, and one fetch costs about a round trip to the node (9 to 10 ms from here), so the long times are almost all waiting for the node. But the server does not record how many fetches a block took or when the node first could have served it, so the budget's own measure (from that moment to the send) cannot be taken from these runs: the 12 and 13 ms blocks are within it, the 91 ms block may or may not be, and the verdict on mainnet is open. Recording the fetch count in `ws_fanout` would settle it. [#67](https://github.com/smolcars/rbitcoin-space/pull/67), which changed how the hub waits for a late block, measured upgraded nodes with a probe of its own: every block served at the first request (11 to 25 ms after the announcement), and our `block` message out 16 to 44 ms after the announcement on mainnet and 6 to 25 ms on signet. That is within the budget, which on an upgraded node runs from the announcement ([`ARCHITECTURE.md`](ARCHITECTURE.md#performance-budgets)); the 91 ms block above, on the code before #67, was not. The v0.9.2 waits of up to 1.6 s, and the one over 3 s, are longer than the 320 to 470 ms [`RBITCOIN.md`](RBITCOIN.md#rules-that-follow) records for signet; that is the stall the upgrade fixes.

### Answers kept in memory

Store-backed answers are computed once per write to the tables they read, and a buried block's immutable answers from the node once, then served from memory ([`API.md`](API.md#answers-kept-in-memory)). Measured with the same `bench.sh OUT http` on 2026-11-12, release builds of `master` at `3aa0afe` and of the change, one straight after the other (18:37 to 18:52 UTC) on the same regtest image, the machine shared as above (load average 7 to 15). The `immutable` class now asks for block 1, about 130 under the tip, so that it is buried; on `master` that makes no difference, since every request goes to the node (a first `master` run with block 106 gave p99 0.6, 1.7 and 33 ms). Server time, p50 / p99 ms:

| Route | Clients | Before | After |
|---|---|---|---|
| `/api/v1/blocks` (15 blocks, the heaviest) | 1 | 0.17 / 2.9 | 0.00 / 0.01 |
| | 100 | 8.8 / 64 | 0.01 / 0.45 |
| | 1,000 | 49 / 132 | 0.01 / 4.7 |
| `/api/v1/block/:hash` | 1 | 0.09 / 3.1 | 0.00 / 0.01 |
| | 100 | 8.1 / 67 | 0.01 / 0.39 |
| | 1,000 | 49 / 132 | 0.01 / 1.6 |
| `/app/block/:hash/summary` (two small reads) | 1 | 0.04 / 1.1 | 0.00 / 0.03 |
| | 100 | 3.3 / 156 | 0.01 / 0.43 |
| | 1,000 | 24 / 84 | 0.01 / 0.26 |
| `/api/block/:hash`, a buried block | 1 | 0.17 / 0.72 | 0.00 / 0.04 |
| | 100 | 0.63 / 4.3 | 0.01 / 3.2 |
| | 1,000 | 7.8 / 36 | 0.01 / 0.34 |
| `/api/v1/difficulty-adjustment` (from memory before and after: the control) | 1 | 0.00 / 0.04 | 0.00 / 0.04 |
| | 100 | 0.01 / 0.33 | 0.01 / 0.36 |
| | 1,000 | 0.01 / 1.8 | 0.01 / 0.27 |

| Class, answered per second (refused) | 1 client | 100 | 1,000 |
|---|---|---|---|
| memory, before | 17,961 | 76,103 | 40,095 (63%) |
| memory, after | 31,816 | 123,743 | 127,013 (0%) |
| immutable, before | 4,674 | 88,405 | 28,306 (77%) |
| immutable, after | 27,905 | 79,719 | 129,701 (0%) |
| store, before | 6,537 | 20,881 | 10,901 (90%) |
| store, after | 30,768 | 114,325 | 80,251 (0%) |

- **At 1,000 clients nothing was refused any more.** Before, a request held one of the 256 slots (`MAX_CONCURRENT_REQUESTS`) for tens of milliseconds and three in four were refused; now each slot is free again in microseconds. The memory class gained too because it holds `/app/block/:hash/summary`.
- **Memory.** Resident memory across the twelve steps was 14 to 51 MB before and 12 to 45 MB after: the kept answers here are a handful, a few tens of KB. The bound is `ANSWER_CACHE_MB` per network (32 MB, about 25,000 blocks' JSON at mainnet's sizes, [`CONFIG.md`](CONFIG.md#answers-kept-in-memory)).
- **Not changed:** the `node` class (0.3 to 0.4 ms median at one client, as before), and the newest 100 blocks' immutable answers, still one node call per request.
- **Noise.** The `immutable` class at 100 clients answered fewer requests after than before (79,700 against 88,400), with a p99 of 3.2 ms where the other kept routes had under 0.5: one run each on a shared machine, not a slower path.

## On Linux

The server will run on Linux, so the WebSocket steps and the HTTP profile were run again there. **Linux in a VM on shared hardware:** the Docker engine on this Mac runs a real Linux kernel (7.2) in a VM, and the measurements ran in containers limited to 4 CPUs and 8 GB while other builders used the machine. Read the ratios and the ceilings, not the absolute speeds. Build: `cargo build --release --locked` in the `rust:1.99.1-bookworm` image, from `master` at `5679035` with this change's load generator; the listen-queue, `accept_failed` and HTTP figures from the change itself, rebased on `ea2e67e`.

### The method

One container for the server (`--cpus 4 --memory 8g`), the regtest node sharing its network namespace, so [`regtest.py`](../dev/regtest/regtest.py) and [`activity.py`](../dev/perf/activity.py) reach it on its fixed ports, and a second container for load from a network namespace of its own:

```sh
docker network create pfnet
docker run -d --name srv --network pfnet --cpus 4 --memory 8g -v build:/build -v "$PWD":/src:ro rust:1.99.1-bookworm sleep infinity
docker run -d --name node --network container:srv --cpus 1 --memory 1g -v "$PWD/cookie":/run/rpc.cookie:ro \
  ghcr.io/rbitcoin-org/rbitcoin:0.9.2 --network=regtest --no-seeds --no-listen --sh-index --max-tip-age=1000000000 \
  --rpc-listen=0.0.0.0:18443 --rpc-cookie-file=/run/rpc.cookie --rpc-cookie-perms=all \
  --electrum-listen=0.0.0.0:50001 --esplora-listen=0.0.0.0:3000          # cookie: regtest:regtest
docker run -d --name load --network pfnet --pid container:srv --cpus 4 --memory 4g -v build:/build:ro rust:1.99.1-bookworm sleep infinity
```

In `srv`: build into `/build`; run `regtest.py scenario` and `activity.py prepare --outputs 30000` from a Python wrapper that sets `regtest._ports` to `{rpc: 18443, esplora: 3000, electrum: 50001}` and replaces `cmd_reset` with `wait_ready` (the scripts otherwise ask `docker compose` for the ports); start the server as [`server.sh`](../dev/perf/server.sh) does, with `LISTEN_ADDR=0.0.0.0:0`, `TRUSTED_PROXIES=127.0.0.1,<the network's prefix>` and `WS_MAX_SOCKETS` raised; then `activity.py flow --rate 20 --block-every 15`. Each WebSocket step is one `load ws` run of 60 or 75 s (`--block-every 10 --drain 10` or `15`, as `bench.sh`), sockets subscribed as the home page is, one in ten also to `projected-txs:0`. Beside it, every 2 s: `/proc/net/sockstat`, the server's resident memory, threads and descriptors, and `ss -tn` summed by side (the bytes waiting in the server's send queues and in the clients' receive queues); `nstat` before and after for listen-queue overflows. The HTTP profile is `bench.sh`'s `http` phase, run in `srv`. Every container was removed afterwards.

### The WebSocket

One load process beside the server, one fresh server for the steps up to 24,000, five blocks or more per step, 20 transactions a second. Every message of every step up to 20,000 reached every reader (checked from the recorded counts, about 167 distinct messages a step). "Queued to all" is the server's `fanout_ms`; the block's reader times run from when that queueing started, so they include it; reader times as the load generator saw them; CPU in shares of one core.

| Sockets | Block queued to all, ms | Block, start of queueing → last reader, ms (median / max) | Mempool update, first → last reader, ms (median / max) | Server CPU, mean / busiest second | Server RSS MB, start → peak | Kernel socket buffers at the peak, both ends |
|---|---|---|---|---|---|---|
| 2,000 | 0.3–2.1 | 9.6 / 17 | 6.0 / 42 | 2.6% / 100% | 16 → 30 | 3 MB |
| 4,000 | 0.8–5.5 | 11 / 22 | 10 / 22 | 5.2% / 99% | 31 → 40 | 15 MB |
| 8,000 | 1.8–6.2 | 24 / 37 | 21 / 66 | 10% / 100% | 40 → 62 | 4 MB |
| 10,000 | 3.2–18 | 26 / 67 | 26 / 50 | 13% / 99% | 62 → 77 | 17 MB |
| 12,000 | 3.0–8.7 | 33 / 35 | 31 / 234 | 16% / 99% | 78 → 86 | 4 MB |
| 16,000 | 5.5–22 | 58 / 138 | 51 / 123 | 22% / 196% | 85 → 105 | 8 MB |
| 20,000 | 5.4–17 | 54 / 88 | 58 / 130 | 26% / 198% | 105 → 128 | 6 MB |
| 24,000 asked, `WS_MAX_SOCKETS` 20,000 | 6.4–18 | 70 / 81 | 61 / 155 | 28% / 194% | 128 → 138 | 15 MB |

The busiest second is the connections opening. The last row opened 20,000 and refused 4,000 with `503`, logged as one `requests_refused` with `server_sockets` (4,000). Against macOS, where 8,000 sockets gave 57 ms and 10,000 stalled: 20,000 here with all delivered.

**What was ruled out**, each by changing one thing (16,000 sockets, fresh servers with this change, 60 s runs):

| Changed | Block, start of queueing → last reader, ms (median / max) | Mempool, ms (median / max) | Every message to every reader |
|---|---|---|---|
| Load generator: one process beside the server | 45 / 197 | 43 / 183 | yes |
| One process in a network namespace of its own | 43 / 80 | 46 / 76 | yes |
| Four processes of 4,000, own namespace | 47 / 53 | 52 / 122 | yes |
| One process, own namespace, four runtime workers (the default here) | 44 / 45 | 47 / 96 | yes |
| The same with one worker (`TOKIO_WORKER_THREADS=1`) | 126 / 142 | 186 / 227 | yes |
| 10,000 readers and 50 sockets that never read | 26 / 26 | 35 / 53 | yes |

- **The load generator** moves only the slowest reader (197 ms to 53 ms when split); it used 0.1 to 0.2 of a core at most. Not the ceiling.
- **The server's fan-out** puts one shared, already-encoded frame on each socket's queue: queueing a block to 20,000 sockets took 5 to 17 ms, under the topics' lock and never across a write. Writing is each socket's own task, and the time to the last reader is CPU: one worker is three times slower than four. Nothing is serialised per socket.
- **Kernel socket memory** (`/proc/net/sockstat`) peaked at 17 MB in the steps above and 52 MB with four client processes, both ends together, and the clients' receive queues were empty at nearly every sample. `net.ipv4.tcp_mem` is not exposed on this VM's kernel, so its pressure threshold could not be read or reached; a Linux host with a few GB has a default far above these figures.
- **Slow clients** did not slow anyone.
- **The listen queue.** tokio's `bind` asks for a queue of 128 (`ss -ltn` showed 128 while `net.core.somaxconn` was 4,096), and a client retries a dropped handshake after 1 s, then 2 s. 10,000 sockets opened at once, before and after this change, which asks for 65,535 and gets the host's maximum: 12,178 and 18,453 overflows (`TcpExtListenOverflows`), every socket open after 2.8 and 3.3 s, connection p99 2.7 and 3.0 s; after, 0 and 212 overflows, 0.3 and 1.2 s, p99 0.17 and 1.0 s. Nothing failed on Linux either way, unlike macOS, which resets.
- **The open-file limit** (20,480 in these containers, `ulimit -n`), with `WS_MAX_SOCKETS` at 40,000 and 24,000 sockets asked for: 20,453 opened and the rest timed out after 10 s each. The server's descriptors stayed at 20,480, connections waited in the listen queue (24,963 overflows) and its own new connections to the node failed too: a mempool refresh took 13.9 s. Nothing in the log said why; this change adds `accept_failed` (`Too many open files (os error 24)`, at a total of 1, 2, 4, 8…), checked with a limit of 1,100 and 1,500 sockets.
- **Ephemeral ports.** Four load processes, started 15 s after a run of 16,000 from the same address to the same server port, opened 2,623 to 3,329 of their 4,000 each; the rest failed with `address not available`. The 16,000 earlier connections were in `TIME_WAIT` and the default range, 32768 to 60999, has 28,232 ports for one source address and one server address and port. A minute later the same run opened all 16,000. A reverse proxy on the server's host meets the same limit, once per socket.
- **Memory per socket.** The server's resident memory grew by 4.1 to 5.2 KB a socket on fresh servers (18 to 22 MB at start, 64 to 65 MB at 10,000; 22 to 105 MB at 16,000). The kernel's slab memory, which the VM counts for every container together, grew by about 5.7 KB per connection end (301 to 485 MB with both ends of 16,000 in one namespace). Socket buffers in flight came on top: at most 52 MB for 16,000 sockets, both ends together.

### The HTTP profile

`bench.sh`'s `http` phase in `srv`, once, on a quiet machine (load average 4 to 9), against the release build of this change. The server and the load generator share the container's 4 CPUs, where on macOS they shared 10 with other builders; at 1,000 clients the server used 2.4 to 2.7 cores and the generator the rest. The node class asks for the `p2sh` address instead of `p2wpkh`, which the activity script had paid 50,000 times and which the server rightly refuses as too large (`history_too_large`). Server time, p50 / p99 ms:

| Route | 1 client | 100 | 1,000 | macOS, 1,000 ([Answers kept in memory](#answers-kept-in-memory)) |
|---|---|---|---|---|
| `/api/v1/difficulty-adjustment` | 0.004 / 0.017 | 0.005 / 0.10 | 0.005 / 0.30 | 0.01 / 0.27 |
| `/api/v1/fees/mempool-blocks` | 0.004 / 0.016 | 0.005 / 0.08 | 0.004 / 0.48 | 0.01 / 0.46–0.80 (first pass) |
| `/api/blocks/tip/height` | 0.003 / 0.014 | 0.004 / 0.08 | 0.004 / 3.3 | 0.01 / 1.5–6.5 (first pass) |
| `/app/block/:hash/summary` | 0.003 / 0.09 | 0.004 / 0.12 | 0.004 / 1.4 | 0.01 / 0.26 |
| `/api/v1/blocks` | 0.003 / 0.005 | 0.007 / 0.26 | 0.004 / 3.6 | 0.01 / 4.7 |
| `/api/v1/block/:hash` | 0.002 / 0.005 | 0.007 / 0.24 | 0.004 / 4.5 | 0.01 / 1.6 |
| `/api/v1/mining/pools/1w` | 0.003 / 0.007 | 0.008 / 0.35 | 0.005 / 5.6 | 0.01 / 0.62–0.74 (first pass) |
| `/api/v1/statistics/24h` | 0.003 / 0.006 | 0.006 / 0.19 | 0.004 / 0.31 | 0.01 / 0.69–0.90 (first pass) |
| `/api/block/:hash`, a buried block | 0.004 / 0.007 | 0.005 / 0.06 | 0.005 / **10.7** | 0.01 / 0.34 |
| `/api/tx/:txid` (node) | 0.08 / 0.17 | 0.52 / 3.6 | 9.5 / 56 | 7.5–14 / 37–73 (first pass) |
| `/api/block/:hash/txs` (node) | 0.11 / 0.25 | 0.53 / 3.9 | 9.9 / 41 | 7.5–14 / 39–64 (first pass) |
| `/api/tx/:txid/outspends` (node) | 0.06 / 0.17 | 0.49 / 5.4 | 11 / 88 | 7.2–14 / 33–66 (first pass) |
| `/api/address/:address` (node, cost-limited) | 0.06 / 0.15 | 0.49 / 3.2 | 10 / 49 | 9.9–16 / 41–81 (first pass) |

| Class, answered per second (refused) | 1 client | 100 | 1,000 | Linux ÷ macOS, by column |
|---|---|---|---|---|
| memory | 51,431 | 235,949 | 212,132 (0.1%) | 1.6, 1.9, 1.7 |
| immutable | 42,407 | 248,218 | 203,527 (0%) | 1.5, 3.1, 1.6 |
| store | 71,450 | 198,672 | 190,165 (0%) | 2.3, 1.7, 2.4 |
| node | 9,863 | 121,554 | 23,099 (83%) | 6.2–7.0, 2.4–2.9, 0.9–1.6 (first pass) |

**Against the budget** (cached or immutable answer, server time, 10 ms at p99): every answer kept in memory passes at every load but one. **Miss:** a buried block's `/api/block/:hash` at 1,000 clients, p99 10.7 ms (0.34 on macOS); its median is 0.005 ms, so the tail is waiting for a core with 1,000 connections on 4 CPUs shared with the load generator, not work, but it is over the line. The node routes have no budget; at 1,000 clients 83% of node requests got `503` from `MAX_CONCURRENT_REQUESTS` (256), as designed, as on macOS. Nothing was tuned for this run. Linux answered 1.5 to 3 times as many requests a second on 4 cores as macOS did on 10, on a quieter machine.

## The site in a browser

Each page is loaded cold (a fresh browser context) in headless Chromium 156 at 1280×800, five times on regtest and three on mainnet, by [`pages.mjs`](../dev/perf/pages.mjs). "Data shown" is when the page's main content shows its data (the stats and projected blocks on the home page, a known value on the others); "JS run" is Chromium's `ScriptDuration`. The slow-phone profile is Lighthouse's Slow 4G as DevTools applies it (562.5 ms per request, 1.47 Mbps down, 675 kbps up) with the CPU slowed 4×. WebGL runs on the machine's GPU through ANGLE's Metal backend; without flags headless Chromium draws it in software.

**Regtest, unthrottled** (five loads each; median, with the range). Measured again with [task 4](#4-shorten-the-pages-request-chain-on-slow-networks-done), on the same day and machine, before the address page's balance chart; the mainnet tables below are from before it. The address page moved more data than in the first pass (239 against 150 KB, with less JavaScript: 57 against 62 KB) and a varying number of requests; the extra is its API answers, whose cause was not looked into:

| Page | First contentful paint ms | Data shown ms | Largest contentful paint ms | KB transferred | of it JavaScript | Requests | JS run ms |
|---|---|---|---|---|---|---|---|
| home | 36 (32–68) | 63 (59–75) | 76 (64–84) | 118 | 62 | 13 | 13 (11–16) |
| block | 48 (32–48) | 75 (50–134) | 80 (56–148) | 123 | 65 | 18 | 13 (13–18) |
| tx | 40 (32–48) | 57 (48–84) | 56 (52–68) | 120 | 66 | 14 | 10 (10–14) |
| address | 40 (32–56) | 63 (48–106) | 76 (60–112) | 239 | 57 | 21 (21–25) | 26 (20–31) |
| mining | 36 (32–60) | 53 (47–79) | 60 (52–72) | 128 | 67 | 22 | 8 (8–12) |
| projected | 32 (32–60) | 65 (57–82) | 64 (56–96) | 111 | 63 | 13 | 22 (17–26) |
| mempool | 36 (36–60) | 43 (40–48) | 52 (48–60) | 107 | 59 | 14 | 5 |

**Regtest, as a slow phone:**

| Page | First contentful paint ms | Data shown ms | Largest contentful paint ms | KB transferred | of it JavaScript | Requests | JS run ms |
|---|---|---|---|---|---|---|---|
| home | 1,740 (1,720–1,764) | 3,080 (3,054–3,113) | 3,120 (3,080–3,128) | 118 | 62 | 13 | 98 (74–107) |
| block | 1,728 (1,724–1,748) | 3,061 (3,047–3,094) | 3,072 (3,056–3,108) | 123 | 65 | 18 | 58 (53–69) |
| tx | 1,748 (1,720–1,788) | 3,082 (3,066–3,116) | 2,444 (2,424–2,464) | 120 | 66 | 14 | 49 (46–66) |
| address | 1,728 (1,712–1,732) | 2,969 (2,956–2,982) | 2,972 (2,960–2,984) | 209 | 57 | 25 (21–35) | 86 (45–95) |
| mining | 1,724 (1,720–1,728) | 3,486 (3,470–3,504) | 2,908 (2,900–2,924) | 128 | 67 | 22 | 43 (37–44) |
| projected | 1,724 (1,720–1,780) | 3,073 (3,008–3,172) | 2,384 (2,372–2,392) | 111 | 63 | 13 | 116 (76–156) |
| mempool | 1,728 (1,728–1,736) | 2,933 (2,915–2,960) | 2,936 (2,916–2,964) | 107 | 59 | 14 | 26 (24–27) |

**Mainnet, unthrottled** (our server on the mainnet node, three loads each; the block is 840,000 with 3,050 transactions, the next block about 3,400):

| Page | First contentful paint ms | Data shown ms | Largest contentful paint ms | KB transferred | of it JavaScript | Requests | JS run ms |
|---|---|---|---|---|---|---|---|
| home | 36 (32–60) | 60 (50–67) | 60 (52–68) | 131 | 67 | 27 | 13 (11–16) |
| block | 48 (32–64) | 48 (47–60) | 216 (156–296) | 231 | 72 | 31 | 23 (18–36) |
| tx | 36 (32–36) | 65 (62–150) | 60 (36–64) | 124 | 70 | 22 | 8 (7–8) |
| address | 36 (32–36) | 59 (43–66) | 76 (52–76) | 118 | 62 | 27 | 5 (5–6) |
| mining | 32 (32–36) | 45 (43–50) | 64 (60–64) | 146 | 71 | 33 | 8 (8–11) |
| projected | 36 (32–36) | 121 (108–159) | 88 (80–96) | 121 | 70 | 26 | 94 (86–134) |
| mempool | 40 (36–56) | 42 (30–43) | 52 (40–68) | 114 | 61 | 20 | 3 (3–4) |

**Mainnet, as a slow phone:**

| Page | First contentful paint ms | Data shown ms | Largest contentful paint ms | KB transferred | of it JavaScript | Requests | JS run ms |
|---|---|---|---|---|---|---|---|
| home | 1,752 (1,716–1,764) | 4,191 (4,145–4,196) | 3,528 (3,500–3,536) | 131 | 67 | 27 | 107 (95–119) |
| block | 1,732 (1,728–1,748) | 3,505 (3,505–3,517) | 4,672 (4,648–4,708) | 231 | 72 | 31 | 102 (90–118) |
| tx | 1,720 (1,712–1,724) | 3,603 (3,603–3,611) | 2,988 (2,976–2,996) | 124 | 70 | 22 | 39 (37–43) |
| address | 1,728 (1,724–1,728) | 4,064 (4,043–4,065) | 4,068 (4,044–4,068) | 120 | 62 | 27 | 30 (25–32) |
| mining | 1,724 (1,720–1,736) | 4,061 (4,051–4,081) | 4,064 (4,056–4,084) | 146 | 71 | 33 | 45 (45–47) |
| projected | 1,724 (1,724–1,732) | 6,234 (6,135–6,245) | 3,476 (3,476–3,484) | 121 | 70 | 26 | 434 (293–602) |
| mempool | 1,716 (1,712–1,736) | 3,548 (3,524–3,564) | 3,556 (3,532–3,576) | 114 | 61 | 20 | 39 (36–42) |

As a slow phone every regtest page now shows its data 2.9 to 3.5 s after it was asked for, 0.6 to 1.1 s sooner than before [task 4](#4-shorten-the-pages-request-chain-on-slow-networks-done); the mainnet tables still show the earlier chain. The mainnet next-block page is the slowest: its 166 to 378 KB snapshot of about 3,400 transactions arrives over the socket and is decoded and listed, 94 ms of JavaScript unthrottled and 434 ms at 4×.

**Frame times.** These say the animations run smoothly on this machine's GPU; they do not establish the budget's mid-range laptop, whose GPU was not measured, and the 4× CPU runs show the grid's load does stall on a slow CPU (50 to 250 ms). `requestAnimationFrame` intervals for 6 s, three times each: from mining a block while the home page is open (the new block slides in, the projected blocks and stats update), and from an in-app navigation to a block of 601 transactions until its grid has drawn.

| | Through a new block on the home page | Through a block's grid loading (601 transactions) |
|---|---|---|
| Unthrottled | 16.8 / 0, 16.8 / 0, 16.8 / 0 | 16.8 / 0, 16.8 / 0, 16.8 / 0 |
| CPU 4× slower | 16.8 / 0, 16.8 / 0, 16.8 / 0 | 83.3 / 2, 50.1 / 1, 250 / 1 |

Each cell is three runs: the longest interval between frames in ms, and the intervals of 33 ms or more (each a dropped frame or more). The p99 interval was 16.8 ms in every run. Frames per second are not given: these runs divided by the 6 s window, although recording also covered the mining call, which overstated them slightly (60.7 to 61); `pages.mjs` now divides by the time the frames cover. In every run the new block or the grid was on the page at the end (checked). One 4× grid run had one long task of 224 ms; four further profiled runs had none.

`requestAnimationFrame` in headless Chromium ticks at 60 Hz, so a dropped frame shows as an interval of 33 ms or more. The M4 is faster than a mid-range laptop; the 4× slowdown stands for something slower than one. The largest JavaScript costs of a grid navigation at 4× were reading computed styles (22 to 30 ms) and focusing the heading (14 ms).

## Side by side

### The stock mempool backend

[`COMPAT.md`](COMPAT.md) calls it the reference backend: a stock mempool backend (v3.3.2, Esplora mode) in front of the same mainnet node. It was not run on this machine: its images and a database for it are not here, and its first start would sync the whole mainnet mempool from the shared node. The instance the compatibility work used, already running beside the node, was asked the same routes in the same way as ours instead: one client, 5 requests a second, 51 per route, at 13:30 and 13:31 UTC, with the node on v0.9.2. Ours ran on this machine against the node over the network, with the mempool engine on.

| Route | Ours, p50 / p99 ms | Reference, p50 / p99 ms |
|---|---|---|
| `/api/v1/fees/recommended` | 0.19 / 0.63 | 10.44 / 801.49 |
| `/api/v1/fees/mempool-blocks` | 0.21 / 1.25 | 10.84 / 642.23 |
| `/api/v1/difficulty-adjustment` | 0.21 / 0.51 | 13.59 / 686.36 |
| `/api/v1/blocks` | 0.65 / 27.5 | 13.05 / 448.35 |
| `/api/v1/block/:hash` | 0.4 / 1.18 | 11.02 / 819.5 |
| `/api/v1/statistics/2h` | 0.23 / 0.88 | 16.98 / 514.68 |
| `/api/blocks/tip/height` | 0.21 / 20.11 | 6.97 / 100.37 |
| `/api/block/:hash` | 9.16 / 75.07 | 6.32 / 141.35 |

All 816 requests, 51 per route on each side, were answered `200`. Recorded earlier on the same pair, the reference's mining routes took 14 to 54 s each where ours answer from memory in under 2 ms, and two unrecognised mining paths hung until its proxy's 60 s timeout ([`API.md`](API.md#mining), [`COMPAT.md`](COMPAT.md#reference-backend-against-rbitcoins-esplora)); those figures are older and were not taken again.

These are client-side times over unequal paths: ours on loopback to a server on this machine, the reference over the network to its host (a new TCP connection there took 9 to 10 ms, measured separately; its fastest medians are below that because a kept-alive connection does not pay it again). They are not server times, and nothing here says where the reference's slowest requests spent their time: in the backend, its proxy or the network. `/api/block/:hash` on its host is answered by the node's Esplora directly, not by the backend. With 51 requests a route, p99 is the slowest request.

### mempool.space

Its public site, the same seven pages with the same data (block 840,000, a transaction in it and its address), the same browser and profiles, two cold loads each: 28 page loads between 13:42 and 13:45 UTC, and no API requests. Its JavaScript differs, so "data shown" is not measured there; compare first contentful paint, largest contentful paint, bytes and JavaScript run.

**Unthrottled:**

| Page | First contentful paint ms | Largest contentful paint ms | KB transferred | of it JavaScript | Requests | JS run ms |
|---|---|---|---|---|---|---|
| home | 580 (580–1,120) | 580 (580–1,120) | 1,281 | 1,172 | 25 (25–39) | 120 (120–213) |
| block | 596 (596–620) | 596 (596–620) | 838 | 714 | 45 | 98 (98–135) |
| tx | 952 (952–972) | 952 (952–972) | 1,335 | 1,220 | 47 | 99 (99–106) |
| address | 656 (656–880) | 756 (756–900) | 1,351 | 1,144 | 29 | 155 (155–165) |
| mining | 752 (752–808) | 752 (752–808) | 1,265 | 1,144 | 44 | 131 (131–132) |
| projected | 512 (512–828) | 1,128 (1,128–1,152) | 1,245 | 1,144 | 38 | 204 (204–214) |
| mempool | 616 (616–980) | 616 (616–980) | 1,195 | 1,144 | 24 | 107 (107–114) |

**As a slow phone:**

| Page | First contentful paint ms | Largest contentful paint ms | KB transferred | of it JavaScript | Requests | JS run ms |
|---|---|---|---|---|---|---|
| home | 8,588 (8,588–8,616) | 8,588 (8,588–8,616) | 1,507 | 1,398 | 39 | 545 (545–549) |
| block | 6,288 (6,288–6,300) | 6,288 (6,288–6,300) | 927 | 805 | 45 | 430 (430–437) |
| tx | 9,012 (9,012–9,108) | 9,012 (9,012–9,108) | 1,512 | 1,398 | 47 | 456 (456–474) |
| address | 8,532 (8,532–8,556) | 9,688 (9,688–9,700) | 1,445 | 1,398 | 29 | 311 (311–321) |
| mining | 8,568 (8,568–8,572) | 8,568 (8,568–8,572) | 1,518 | 1,398 | 44 | 584 (584–651) |
| projected | 8,620 (8,620–8,676) | 9,452 (9,452–9,628) | 1,498 | 1,398 | 38 | 527 (527–531) |
| mempool | 8,540 (8,540–8,548) | 8,540 (8,540–8,548) | 1,448 | 1,398 | 24 | 462 (462–466) |

With two loads the median shown is the lower of the two.

How far the comparison can be trusted:

- **mempool.space is a fleet behind a CDN; we are one process on loopback.** Unthrottled, its times include the internet round trips from this machine and ours include none, which flatters us. As a slow phone both pay the same 562.5 ms a request on top, and the difference is dominated by the bytes: 1.4 MB of JavaScript at 1.47 Mbps takes about 8 s, our 70 KB under half a second. That part holds whatever the hosting.
- **Its CDN holds every file close and serves HTTP/2 or 3;** we served HTTP/1.1 with no proxy, which cost us the six-connection queue that [task 4](#4-shorten-the-pages-request-chain-on-slow-networks-done) has since shortened. A deployment of ours behind a TLS proxy would load faster than measured here.
- **Under load the comparison runs the other way.** The fleet absorbs traffic one process cannot; [The server under load](#the-server-under-load) is all we can say about ours, and nothing here says how many clients mempool.space serves.
- Two loads per page is a small sample; the spread between them is in the table.

## Regression guard

`bun run size` already fails a PR whose first-load JavaScript passes 100 KB, or whose cold home page needs more than 10 files (task 4), at no cost. A latency check in the PR path would fail on noise: GitHub's shared runners, like this machine, vary by tens of percent from run to run, and the [rules](CI.md#rules-for-tests) treat a flaky check as a failing one. Proposed instead, not added: run `dev/perf/bench.sh OUT http` weekly or by hand in a scheduled workflow outside the PR path (about 8 minutes of a runner, nothing added to a PR's 3 minutes) and post the summary, so a regression shows as a trend.

## What was not measured

- A quiet machine: every server number carries the noise of other builds.
- Linux on real hardware: [On Linux](#on-linux) is a VM on this shared machine. A server whose clients are on other machines (the closest is a client in another network namespace of the same VM), and TLS or HTTP/2 through a proxy.
- The reference backend under load, or on this machine: see above.
- A mid-range laptop's GPU, or a real phone. The slow-phone profile slows the CPU and the network only.
- The `/api/v1/ws` socket, the Lightning pages, and Firefox or Safari.
- Signet and testnet4.

## How to reproduce

From the repository root, after `cargo build --release --locked -p rbitcoin-space -p load` and `(cd web && bun install && bun run build)`:

| Measures | Command |
|---|---|
| The server under load, on a private regtest node, including the 2,000 to 8,000-socket steps, the kernel buffer snapshots and the flood with logging off (about 35 minutes) | `dev/perf/bench.sh OUT [idle] [http] [limits] [ws]`, then `dev/perf/summary.py OUT [OUT2 …]` |
| Page loads and frame times on regtest | `dev/perf/browser.sh OUT [--runs N]`, then `dev/perf/summary.py --pages OUT/pages.json` |
| Store readers, 4 against 10 | Set `readers: 10` in the store `Options` in `crates/server/src/blocks.rs`, build into another target directory (`CARGO_TARGET_DIR=DIR cargo build --release --locked -p rbitcoin-space -p load`), then run `CARGO_TARGET_DIR=DIR dev/perf/bench.sh OUT http` and compare the `store` steps with an unchanged build's |
| Mainnet footprint and paced timings (reads `.env`) | `dev/perf/mainnet.sh OUT MINUTES [REFERENCE_URL]` |
| Another site's pages | `cd web && node ../dev/perf/pages.mjs reference https://SITE --runs 2 --tx TXID --address ADDRESS` |
| The block table's scheduled reads, on a copy of a store or a generated one (fills its totals first, and reports what reads cost meanwhile) | `TABLE_BENCH_DIR=DIR [TABLE_BENCH_NET=mainnet] [TABLE_BENCH_ROWS=N] [TABLE_BENCH_WRITER=1] cargo test --release -p engine -- --ignored --nocapture table_reads_benchmark`. Copy a live store with `sqlite3 FILE ".backup COPY"`; never point it at a server's own file, it writes |
| Every mining answer's first computation, and a new block's refresh of them all | `MINING_BENCH_DIR=DIR MINING_BENCH_NET=mainnet cargo test --release -p rbitcoin-space -- --ignored --nocapture answers_benchmark`, on a copy: it writes three blocks and deletes them |

The Linux runs have their own method, with the commands, in [On Linux](#on-linux).

`bench.sh` and `browser.sh` start their own regtest node (`REGTEST_PROJECT`, default `perf-` and their process id), stop what they started by its process id and remove the node when they end; set `REGTEST_IMAGE` where the pinned image cannot be pulled ([`REGTEST.md`](REGTEST.md)). `server.sh` on its own only starts a server against a node already running: it prints `ADDR PID`; stop the server with `kill PID` and the node with `dev/regtest/regtest.py down`. The load generator is `dev/load` (`cargo run --release -p load -- http|ws …`); its options are in its header.
