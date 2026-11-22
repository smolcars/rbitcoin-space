# WebSocket protocol

The live channel between the server and the frontend: one socket per browser tab at `/app/ws`, or under a network's prefix (`/signet/app/ws`, `/testnet4/app/ws`, `/testnet5/app/ws`, `/regtest/app/ws`). A socket belongs to one network. This page is the contract the frontend and every topic are written against. The code is `crates/server/src/ws.rs` and `crates/server/src/ws/`. Wallets and bots written for mempool.space have [their own socket](#the-mempoolspace-shaped-socket-apiv1ws) at `/api/v1/ws`, on the same hub.

The socket is part of the private `/app` API: it may change in any release, since the frontend and server ship together. Breaking changes bump the protocol version.

## Frames

| Frame | Carries |
|---|---|
| Text | One JSON object: control messages and small state |
| Binary | A projected block's transactions ([below](#binary-frames)). Byte 0 is a kind code naming the format of the rest, byte 1 that format's version. A client ignores a binary frame whose kind or version it does not know |

A client sends text frames only. The server ignores the `Sec-WebSocket-Protocol` header and negotiates no extensions, so frames are never compressed.

## Messages

Every server message is an object with a `type`. Messages that belong to a topic also carry `topic`; the others are about the connection. New fields may be added to any message: a client ignores fields it does not know.

### Client to server

| Message | Does |
|---|---|
| `{"op":"subscribe","topics":["blocks"]}` | Subscribes to each topic. The server first sends the topic's current state, if it has one, then every change. Subscribing to a topic already subscribed does nothing |
| `{"op":"unsubscribe","topics":["blocks"]}` | Stops the topics. Unknown to this connection is not an error |
| `{"op":"ping"}` | The server answers `{"type":"pong"}`. For a browser, which cannot send WebSocket pings, to check the socket is alive |

Anything else (not JSON, an unknown `op`, a missing or misspelled field, an unknown topic) closes the socket with `4000`.

### Server to client

| Message | When |
|---|---|
| `{"type":"hello","v":1,"network":"mainnet","tip":{"height":975516,"hash":"…"}}` | First, on every connection. `tip` is the node's best block, or `null` before the server has reached the node |
| `{"type":"pong"}` | Answer to `ping` |
| Topic messages | Below |

## Topics

### `blocks`

| Message | Meaning |
|---|---|
| `{"topic":"blocks","type":"block","block":{…}}` | A block joined the best chain. `block` is the node's Esplora JSON for it, exactly as `GET /api/block/:hash` returns it (`id`, `height`, `previousblockhash`, `timestamp`, `tx_count`, `size`, `weight`, …). Also the snapshot sent on subscribe: the current tip's block |
| `{"topic":"blocks","type":"summary","summary":{…}}` | A block's fee facts, its miner and its audit, exactly as `GET /app/block/:hash/summary` returns them ([`FRONTEND.md`](FRONTEND.md#block-summaries)); `summary.id` names the block, `summary.miner` who mined it, `summary.sv2` whether its coinbase is laid out as Stratum V2 writes it, and `summary.audit` its health (`null` when it has no audit), so a new tile names its miner and shows its health without asking. A new block's audit is computed before this message is sent: at once on mainnet, at most 5 s later than without it. Sent after the `block` message for each new tip, once it is computed (well under a second on mainnet), and for older blocks the server fills in after a gap or at startup. Never a snapshot: a new subscriber fetches the facts of the tiles it shows over HTTP, from the batch route |
| `{"topic":"blocks","type":"reorg","fork_height":N}` | Every block above `N` left the best chain. `block` messages for the new branch follow, in height order |
| `{"topic":"blocks","type":"resync","tip":{"height":…,"hash":"…"}}` | Blocks may have been missed: the server lost and regained the node, or the node did not serve a block it announced within `WS_BLOCK_WAIT_SECS` (60 s). `tip` is the best block now, or `null`. After a block the node did not serve it is also the snapshot, until the next `block` |

**Keeping up.** Keep the height and hash of the newest block shown. On `block`:

- `height` is one more and `previousblockhash` is the kept hash: append it.
- `height` is at or below the kept height: a reorg replaced blocks. Drop those at and above `height`, then append.
- Anything else is a gap: fetch the recent blocks over HTTP (`GET /api/blocks`).

On `reorg`, drop blocks above `fork_height`. On `resync`, compare `tip` with what is shown and, if it differs, fetch over HTTP. After a reconnect, `hello` and the subscribe snapshot give the tip again; compare as for `resync`.

A `block` message is about 500 bytes whatever the block's size: transactions are not included. The server fetches each new block's JSON in one loop, whatever the number of subscribers, the oldest block announced and not sent first: from the node's Esplora every 25 ms for the first 200 ms, then every eighth of the time waited so far, at most once a second, until the block is served or `WS_BLOCK_WAIT_SECS` (60 s) have passed since the node announced it. A fixed node serves a new block at the first request ([`RBITCOIN.md`](RBITCOIN.md#rules-that-follow)); rbitcoin v0.9.2, no longer supported, took a second or more, and a block served late goes out at most an eighth of its delay later than it could, with its `summary` after it as usual. A block never served costs about 90 requests in the minute; then the server sends `resync` instead, and the block table keeps looking for it on its own retries, so the tip routes still get it whenever the node serves it. Blocks announced in a burst go out in height order, each once. A block that a reorg removes while it is waited for is dropped, not waited out; so is every block still waited for when the server reconnects to the node, since a reorg may have been missed: clients get `resync`, and the block table checks the chain on its own. A `summary` message is about 700 bytes with its audit. Key it by `summary.id`; one whose block is not shown can be dropped.

### Mempool topics

Fed by the network's mempool tracker and projected blocks ([`MEMPOOL.md`](MEMPOOL.md#in-the-server)). Each topic sends at most one message per `WS_MEMPOOL_INTERVAL_MS` (2 s), always the latest state, so changes in between are merged. The exception is a new block: the state on it goes out at once ([below](#when-a-block-is-found)). Nothing is sent before the tracker's first complete cycle; a subscriber then gets the current state on subscribe, as for `blocks`.

| Topic | For | Format | Size on mainnet |
|---|---|---|---|
| `mempool` | The home page's mempool panel | JSON, the whole state each time | about 200 bytes |
| `projected` | The block strip's projected tiles | JSON, the whole state each time | about 1.4 KB |
| `transactions` | The home page's latest transactions | JSON, the whole list each time | about 1.4 KB |
| `fees` | The home page's "Fee to pay now" panel | JSON, the whole state each time, only when it changed, and at once on a new block | about 390 bytes, one or two a minute |
| `projected-txs:0` to `projected-txs:6` | One projected block's grid; `0` also the home page's next-block map | Binary: a snapshot, then deltas | snapshot 56 bytes a transaction; see [Cost](#cost-of-the-mempool-topics) |

With `{NET}_MEMPOOL_ENABLED=false` every one of them but `fees` (and [`replacements`](#replacements) too) answers subscribe with `{"topic":"…","type":"off"}` and nothing else; `fees` then carries the node's own estimates.

Rates are integers in **sat per 1,000 vB**, the node's own unit and resolution (`1234` is 1.234 sat/vB); sizes are sigop-adjusted virtual bytes; amounts are satoshis.

**`mempool`**

```json
{"topic":"mempool","type":"mempool","seq":812,"count":55210,"vsize":41503331,"fees":20125872,
 "min_fee_rate":1000,"bands":[3104211,9872001,12434022,…12 values],"stale":false}
```

`count`, `vsize` and `fees` are the whole mempool. `min_fee_rate` is the node's `mempoolminfee`, the lowest rate it accepts now (`null` before the first answer). `bands` is the virtual size in each of the 12 fee bands of [`DESIGN.md`](DESIGN.md#fee-scale), cheapest first, by each transaction's effective rate: the mempool bar. `stale` is true while the node is failing: the numbers are the last good ones. `seq` is the projection they come from.

**`projected`**

```json
{"topic":"projected","type":"projected","seq":812,"tip":{"height":975530,"hash":"…"},"stale":false,
 "blocks":[{"txs":3214,"weight":3991876,"vsize":997969,"fees":1543210,"min_rate":1012,
            "median_rate":1500,"max_rate":250000,"bands":[0,0,0,0,0,0,312000,…12 values]}, … 8 blocks]}
```

Eight blocks, the next first; the last holds everything beyond the other seven (the "+N blocks" tile). `tip` is the block they were projected on. `median_rate` is the rate at the block's middle vbyte; `bands` are its strata, 12 as above. A mined block's `fee_bands` can be ten ([`STORE.md`](STORE.md#fee-bands)). `stale` as above. Key the tiles by position: block 0 is always "next".

**`transactions`**

```json
{"topic":"transactions","type":"transactions",
 "txs":[{"txid":"…","time":1794461221,"fee":381,"vsize":127,"value":4999999619}, …]}
```

The newest `WS_LATEST_TXS` (10) transactions the server has seen, newest first by the node's acceptance `time` (Unix seconds). `value` is the total output value. A transaction stays in the list after it confirms or is replaced; it leaves when newer ones push it out. Rows already shown keep their place: diff by `txid` to find the new ones.

**`fees`**

```json
{"topic":"fees","type":"fees","source":"projected","tip":{"height":975530,"hash":"…"},
 "levels":[{"name":"high","blocks":1,"minutes":10,"rate":2001},
           {"name":"medium","blocks":3,"minutes":30,"rate":1031},
           {"name":"low","blocks":6,"minutes":60,"rate":126},
           {"name":"no_rush","blocks":144,"minutes":1440,"rate":100}],
 "min_fee_rate":100}
```

What to pay to be mined within each horizon ([`MEMPOOL.md`](MEMPOOL.md#fee-recommendations)). `levels` is always these four, fastest first, each with its horizon in blocks and in minutes at one block per ten; `rate` is in sat per 1,000 vB like every rate here, never below `min_fee_rate` (the node's minimum) and never below a slower level's. `source` is `projected` for our own, or `node` for the node's own estimates, which are served while the projection is stale, with the engine off, and from the second to the fifth minute after the server starts (or after an outage), capped at what the mempool and the arrivals watched justify ([`MEMPOOL.md`](MEMPOOL.md#while-warming-up)); `tip` is the block ours was projected on, `null` for the node's. When neither can be served, including that first minute, the message is `{"topic":"fees","type":"unavailable"}` and stays until one can: show no number then rather than an old one. Each message replaces the last; nothing needs to be kept between them.

**`projected-txs:N`**

Block `N` of `projected`, 0 to 6. The last block has no topic: it is the rest of the mempool and has no size bound. One socket holds at most `WS_MAX_BLOCK_SUBSCRIPTIONS` (2) of these; switch by subscribing to the new one and unsubscribing from the old. The first message is a snapshot (kind 1), possibly followed at once by up to 16 deltas (kind 2) that bring it to the current state; then a delta whenever the block's transactions change, or a snapshot when that is smaller (a new block usually replaces block 0 whole).

### `replacements`

For pages that list replacements (`/rbf` and the recent replacements on the home and mempool pages): it says when the replacement record changed, and the page asks `GET /api/v1/replacements` (or `/fullrbf/replacements`) again. The lists are built once per change and kept ([`API.md`](API.md#cost-and-comparison)), so a change costs each page one cheap request rather than every subscriber a copy of 25 trees.

| Message | Meaning |
|---|---|
| `{"topic":"replacements","type":"replacements","version":812}` | The record's version: it changes with every replacement recorded, every replacement confirmed, and every change a reorg makes. Sent from the tracker's first cycle and then on each change, at most once per tracker cycle (one delta), and kept as the snapshot for new subscribers. Compare it with the last one seen; it means nothing else. It starts again from a low number when the server restarts |
| `{"topic":"replacements","type":"off"}` | The mempool engine is switched off on this network: there is no record |

About 70 bytes a message. On mainnet in November 2026 a replacement arrived every six seconds or so. The reply to `/api/v1/replacements` is `max-age=1`, so a page asks for it from the server, skipping the browser's cache, which can hold the list from before the change ([`FRONTEND.md`](FRONTEND.md#following-live-data)).

### `lightning-feed`

For the Lightning overview: channels opened, channels closed and fee changes, as the server finds them ([`LIGHTNING.md`](LIGHTNING.md#the-overview)). Nothing is sent while Lightning is off or its graph is not synced, nor before the first index build after the close-watcher caught up: a restart's catch-up is kept, not pushed.

| Message | Meaning |
|---|---|
| `{"topic":"lightning-feed","type":"recent","events":[…]}` | The snapshot on subscribe: the newest 20 events of each kind, newest first, exactly as `GET /app/lightning/feed` answers them ([`API.md`](API.md#applightning)). Not sent before the feed has filled |
| `{"topic":"lightning-feed","type":"events","events":[…],"more":0}` | What one index build found, sent once per build that found something (one every 30 s at most): at most 50 of each kind, newest first, and `more`, how many were left out, for "and N more". At once folded into the snapshot; a socket that subscribes in that instant gets the older `recent` and then this message |

An event is the route's: `event` (`opened`, `closed` or `fee`), `time`, `id`, `scid`, `capacity`, `node_one` and `node_two` (`{id, alias}`, the alias a plain string or `null`), then for an open or close `height` (the funding or closing block) and for a close `kind`, and for a fee change `by` (`node_one` or `node_two`, whose policy changed) and `before` and `after` (`{fee_rate, base_fee_msat, inbound_fee}`).

**Keeping up.** Keep the snapshot, put each `events` message's events in front, and drop duplicates by `event`, `scid`, `time` and `by`. A missed message is not resent: after a reconnect the snapshot again holds the newest 20 of each kind. The events' order is by `time`, not by arrival: an open is dated by its funding block, an hour or more before it reaches the feed.

**Cost.** One subscriber, mainnet, 18 minutes: 36 frames, the median 5.2 KB and the largest 24 KB (the 50 fee changes of a capped burst), 12 KB a minute, plus the `recent` snapshot on subscribe: 24.5 KB with 60 events, measured on the recorded mainnet store (the socket never compresses, so this is what every visitor to the overview receives). Each frame is encoded once per build whatever the number of subscribers, and the snapshot once per build that found something. No upstream work: the events come from what the index task and the history consumer already do ([`LIGHTNING.md`](LIGHTNING.md#the-overview)).

### When a block is found

What a socket subscribed to `blocks` and the mempool topics receives for each new block B, in this order:

1. **`block` for B.**
2. **The mempool topics on B**: `mempool`, `projected` with `tip` B, each `projected-txs:N` that changed, and `fees` when it is our own (`source` `projected`, `tip` B). They hold nothing B confirmed, nothing that spent what a transaction in B spent, and none of those transactions' descendants. They are sent as soon as the server has them, without waiting for the rate limit.
3. **`summary` for B**, whenever it is computed: before, between or after the messages of step 2.

The server keeps that order for every message it sends to subscribers. A mempool message on B, `fees` included, is never sent before B's `block`, and after B's `block` no mempool message on an older tip is sent. `fees` with the node's estimates (`source` `node`) and `unavailable` are on no block, so they are outside the order. One case is outside it: a topic's state sent on subscribe is the latest the server holds. A socket that subscribes in the moment between B's `block` and the projection on B gets the mempool topics' state on the parent. `projected.tip` names that block, and the state on B follows as an ordinary message. A page can therefore say "Block B was found" on the `block` message, and treat the next `projected` (and the `mempool`, `projected-txs:N` and `fees` that come with it) as the state after B. That includes a quiet or empty mempool, where only the tip moves. The `transactions` topic is not tied to blocks.

**How soon.** Step 2 follows step 1 within milliseconds when the node serves the block at once: 2 ms median and 6 ms at most after the `block` message over 22 blocks on regtest. On mainnet it was 592 ms after the `block` message (one block, 68,000 transactions in the mempool; [`MEMPOOL.md`](MEMPOOL.md#when-a-block-is-found) has the breakdown). The wait is the tracker's poll in progress, if any, reading the new block from the node, asking it for the clusters the block touched, and packing.

**When it cannot.** The server holds a mempool message that disagrees with the announced block for at most 3 s, the time the tracker gives the node to serve a new block. If the mempool engine has not reached B by then (the node is failing, or serves the block late), it sends what it has. That message's `tip` says which block it is on, and `stale` is usually set. After a `reorg` or a `resync` there is no announced block to agree with, so nothing is held until the next `block`.

**Then the refresh.** About a second later on mainnet, the server has asked the node for every cluster again. The few records that refresh corrects (transactions whose chunk changed in ways the block alone does not show) arrive as ordinary changes, at the normal rate.

### Binary frames

Integers are little-endian. A txid is 32 bytes in the order it is written in hex, so hex-encoding the bytes gives the usual txid string.

**Record**, 56 bytes, one transaction:

| Offset | Bytes | Field |
|---|---|---|
| 0 | 32 | txid |
| 32 | 4 | effective fee rate, sat per 1,000 vB: the rate of the chunk it is mined in |
| 36 | 4 | sigop-adjusted vsize |
| 40 | 8 | its own fee, satoshis |
| 48 | 8 | its flags: the bits of [`API.md`](API.md#transaction-flags) that its own bytes show, replacement, and paid for by a child or pays for a parent: its chunk in this projection more than 10% from its own rate |

**Kind 1, snapshot**: the block's whole state.

| Offset | Bytes | Field |
|---|---|---|
| 0 | 1 | kind, `1` |
| 1 | 1 | version, `2` |
| 2 | 1 | block `N` |
| 3 | 1 | zero |
| 4 | 4 | record count |
| 8 | 8 | `seq`: the projection this is |
| 16 | 56 × count | records, in mining order |

**Kind 2, delta**: changes since the previous frame of this topic.

| Offset | Bytes | Field |
|---|---|---|
| 0 | 1 | kind, `2` |
| 1 | 1 | version, `2` |
| 2 | 1 | block `N` |
| 3 | 1 | zero |
| 4 | 4 | removed count |
| 8 | 8 | `seq`: the projection this brings the block to |
| 16 | 8 | `prev`: the `seq` of the frame it follows |
| 24 | 4 | set count |
| 28 | 4 | zero |
| 32 | 32 × removed | txids that left the block: confirmed, replaced, evicted, or moved to another block |
| … | 56 × set | records that entered the block or changed rate, size, fee or flags |

**Versions.** Version 2 added the flags; version 1's records were 48 bytes. A page that meets a version it does not read draws nothing from the frame and asks the reader to reload, which brings the frontend that matches the server ([`FRONTEND.md`](FRONTEND.md#live-data)).

**Applying them.** Hold, per block, a map from txid to record and the `seq` of the last frame applied.

- On a snapshot, replace the map and the `seq`, whenever it comes.
- On a delta whose `prev` equals the held `seq`: delete each removed txid, then insert or overwrite each set record, then hold the delta's `seq`. The map is now exactly the server's block.
- On a delta whose `prev` is anything else, or before any snapshot, or one that removes a txid the map does not hold: the client has lost its place. Unsubscribe and subscribe again; the snapshot that follows starts it over.

The server never skips a frame for a subscriber: one that cannot keep up is closed with `4003` instead. So a lost place means a client bug or a reconnect without a fresh subscribe, never a normal event. Draw the grid by sorting on rate, highest first; ties have no meaningful order ([`MEMPOOL.md`](MEMPOOL.md#limits)).

**Falling behind.** A slow client is dropped, not resynchronised: its send queue fills (`WS_SEND_QUEUE` frames) and it is closed with `4003`, as on every topic. Resynchronising would mean holding, per client, what it has missed and sending a slow client a snapshot of up to 930 KB on top; dropping it costs nothing, and its reconnect gets one snapshot through the normal path. Frames are shared, so a full queue holds 64 references, not 64 copies.

### Cost of the mempool topics

**Per client, mainnet,** 2026-11-12, one script client on every mempool topic for 943 s, a mempool of 57,000 to 59,000 transactions, read-only against a synced node:

| Topics | Bytes a second | Messages |
|---|---|---|
| `mempool` | 98 | one per 2.1 s |
| `projected` | 654 | one per 2.1 s |
| `transactions` | 671 | one per 2.1 s |
| **The home page, all three** | **1.4 KB/s** | |
| `projected-txs:0` | 321 after a 166 KB snapshot (3,458 transactions; 194 KB at today's 56 bytes, computed) | a delta per 2.1 s |
| `projected-txs:1` | 582 after a 378 KB snapshot (7,880 transactions; 441 KB at 56 bytes, computed) | a delta per 2.1 s |

These runs sent 48-byte records, before the flags; a delta's records grow by a sixth with them.

The home page takes `projected-txs:0` too, for its next-block map, once its mempool panel nears the view. Measured on mainnet, 2026-11-16, a cold page in Chromium at 1440 px with 72,000 to 75,000 transactions waiting: the socket brought about 24 KB in its first 15 s before the map and 140 to 225 KB with it (the snapshot of about 3,300 transactions), and 269 KB in its first 60 s, about 1.9 KB/s after the snapshot for every topic together.

The context bits (paid for by a child, pays for a parent) flip as chunks change, and each flip is a set record. Measured on mainnet, 2026-11-15, 75,000 transactions, two servers side by side for the same 240 s with no block: `projected-txs:0` sent 4,727 B/s and 110 records a delta with them, 4,693 B/s and 112 without. No measurable cost, and that was before the 10% margin, which flags far fewer.

A second run of 1,760 s, which included block 975,526 (3,663 transactions confirmed), gave the same rates (1.4 KB/s for the home page; 278 and 602 B/s for blocks 0 and 1). At the block each projected block's change was larger than its new state, so both topics sent a snapshot instead: 87 KB for block 0 (1,822 transactions) and 270 KB for block 1 (102 KB and 315 KB at 56 bytes, computed). A client watching a block pays that once per block. Throughout, our counts matched the node's `getmempoolinfo` to within 10 transactions (the ones that arrived between our cycle and the check), and our block 0 matched the node's template above 99.7% by weight, tie-aware, at every one of 46 checks.

**Server, at scale,** measured locally only: the release build against a regtest node taking 20 new transactions a second (a block every 3 minutes, mempool up to 3,600 transactions), clients in Python on the same machine (Apple M4, shared with other work). One client in ten also watched `projected-txs:0`.

| Clients | Server CPU | Peak RSS | Queued to clients | Slowest fan-out | Dropped |
|---|---|---|---|---|---|
| none | 0.2–0.3% of one core | 14–37 MB | | | |
| 1,000 | 2.2% | 18 MB | | | 0 |
| 5,000 | 8.0% | 64 MB | 7 MB/s | 21 ms | 0 |

CPU and memory grow with the clients, not with the topics: each message is encoded once (in that run 139 KB a minute encoded, 424 MB a minute queued) and each client's queue holds references to the same bytes. With one client on mainnet the whole server, engines included, used 2.8% of one core and 80 MB.

### Following a transaction or an address

Two families of topics with a parameter, for the transaction and address pages (`crates/server/src/ws/track.rs`). Each message is the topic's whole state, so a client keeps the last one; the first is sent on subscribe. A client never needs to order or merge them.

| Topic | For | Format |
|---|---|---|
| `tx:<txid>` | Where a transaction is and what happened to it | JSON, the whole state each time, about 300 bytes |
| `address:<address>` | A signal that an address's history changed, so the page refetches | JSON, about 150 bytes |

**Names are parsed strictly.** A txid is exactly 64 hex digits in lower case. An address must be one of this network's; it is echoed in `topic` as the server writes it, with bech32 in lower case (an address typed in upper case comes back lower case), so a page should lower-case a bech32 address before subscribing. Anything else closes the socket with `4000`, like any unknown topic.

**`tx:<txid>`**

Rates are sat per 1,000 vB, as everywhere. `stale` is true while the node is failing: the state is the last good one. One of:

```json
{"topic":"tx:…","type":"tx","stale":false,"state":"mempool","time":1794461221,"fee":381,"vsize":127,"rate":3000,
 "position":{"block":0,"blocks":8,"effective_rate":3000,"ahead_vsize":412311,"ahead_txs":1022}}
{"topic":"tx:…","type":"tx","stale":false,"state":"replaced","by":"<txid>","truncated":false,
 "chain":[{"txid":"<this>","by":"<B>","seen":1794461300,"fee":381,"vsize":127,"rate":3000,"by_fee":900,"by_vsize":127,"by_rate":7086,
           "mined":true,"block":{"height":975530,"hash":"…"}},
          {"txid":"<B>","by":"<C>", …}]}
{"topic":"tx:…","type":"tx","stale":false,"state":"confirmed","height":975530,"hash":"…"}
{"topic":"tx:…","type":"tx","stale":false,"state":"evicted"}
{"topic":"tx:…","type":"tx","stale":false,"state":"unknown"}
```

| `state` | Means | The page |
|---|---|---|
| `mempool` | In the node's mempool. `time` is when the node accepted it; `fee`, `vsize` and `rate` are its own. `position` is where the projected blocks put it, `null` for the moment before they have placed it | Shows the position (below) |
| `replaced` | It left because `by` spent one of its inputs, or one of its ancestors' (a child leaves with its replaced parent and carries the same replacement). `chain` runs from this transaction to the newest replacement known: follow the last link's `by`, and subscribe to that one to see where it is. A later replacement of the end grows the chain, and the server sends the longer one. Figures are as the tracker knew them; `by_fee` and `by_vsize` are `null` when the replacement was confirmed in the block that removed this one. `mined` says whether the link's replacement `by` is confirmed: `true` with its `block` (`null` for a link stored before blocks were recorded), `false`, or `null` when a reorg took its block away and the server does not know yet where it is ([`MEMPOOL.md`](MEMPOOL.md#following-a-transaction)). A reorg that changes it sends the message again. A link known only from the tracker's reason, after the record dropped it, has only `txid` and `by`. At most 32 links; `truncated` says there were more | Offers the newest replacement |
| `confirmed` | Mined in block `hash` at `height`. A reorg that takes the block away brings it back to `mempool`, or to `unknown` if the node does not take it back. A replaced transaction that a reorg's new block confirms after all goes from `replaced` to `confirmed`. After the server lost track of the chain (a reconnect to the node, a reorg deeper than it follows) it also says `unknown` rather than vouch for an old confirmation | Shows the block |
| `evicted` | It left the mempool for a reason the node does not report: evicted for size, expired after two weeks, dropped after a reorg, or replaced by a transaction we did not see ([`MEMPOOL.md`](MEMPOOL.md#where-it-can-only-infer)) | Says it is no longer in the mempool |
| `unknown` | Not in the mempool, and the server has no record of why: confirmed before anyone followed it here, never seen, or gone while the server was not following it. The server asks the node nothing to find out | Asks `GET /api/tx/:txid/status`, the page's own route for confirmed data, and again on each new block. The topic says `mempool` if it arrives later |

**The position.** `block` is the projected block, 0 for the next; the last one (`blocks` − 1) holds everything beyond the others. `ahead_vsize` and `ahead_txs` are what would be mined before it, earlier blocks included. Say "in the next block" for block 0, "in about N blocks" (N = `block` + 1) for the others, and "in more than `blocks` − 1 blocks" for the last; never a time to the minute. The projection is the node's own template rule applied to its own chunks and matched the node's template above 99.7% by weight in every check ([`MEMPOOL.md`](MEMPOOL.md#agreement-with-the-node)), but miners pick their own blocks and break ties their own way. On mainnet, a transaction in the large class of identical cheap chunks moves between later blocks every few seconds: that is the projection's honest uncertainty. `effective_rate` is the rate of the chunk it will be mined in, so a parent lifted by a child shows the child's chunk rate here and its own in `rate`.

**How often.** The server reconsiders every followed transaction at most once per `WS_MEMPOOL_INTERVAL_MS`, from the same projection the other mempool topics use, and a newly followed one at once (its first message comes within milliseconds). It publishes only from a view of the engines that matches the removal reasons it has folded in, so a transaction never reads as waiting after the server has seen it leave. A change of state, a new effective rate, or entering or leaving the next block goes out at once. A change of only how much is ahead of it, or of which later block it is in, goes out at most once per `WS_POSITION_INTERVAL_MS` (10 s): enough for a page to keep its estimate fresh, without a message for every shuffle.

**`address:<address>`** (or a public key in the address's place, for the outputs paid to the key itself: [`API.md`](API.md#public-keys))

```json
{"topic":"address:bc1q…","type":"address","state":"watching","status":"6c3e…"}
{"topic":"address:bc1q…","type":"address","state":"unavailable"}
{"topic":"address:bc1q…","type":"address","state":"refused","reason":"too_large"}
{"topic":"address:bc1q…","type":"address","state":"ledger","height":975700}
```

**Before the node is asked to watch an address,** the server must know it is small: watching makes the node join the address's whole history. An address it does not know is checked first, a totals request in the server's one large-address lane ([`API.md`](API.md#very-large-addresses)); a large one is answered `ledger` when the ledger keeps it and `refused` `too_large` otherwise, without the node watching it. A check that cannot run within 5 s (the lane is busy) or that the node fails is answered `unavailable` and tried again 10 s later. So following a new small address costs the node one light totals join besides the subscription.

| `state` | Means |
|---|---|
| `watching` | The node watches it. `status` is the node's Electrum status of the address's history (`null` for an address with none): it changes whenever a payment to or from it enters the mempool or confirms, and with a reorg. Refetch what the page shows when it differs from the last one. Subscribe first, then fetch, so nothing falls between |
| `unavailable` | The node cannot be reached, or the connection to it dropped: the last status may be out of date. When the connection is back the server asks again and sends `watching` with the status as it is then |
| `ledger` | The server's own ledger keeps it ([`API.md`](API.md#very-large-addresses)); the node is not asked to watch it. `height` is the block its totals are exact at, and a new message comes whenever a block changes them, or the server is done adding the transactions from before it began keeping it, or taking its whole history (the same `height`): refetch `/app/address/:address/ledger` then. Unconfirmed transactions are polled as for `too_large` |
| `refused` | The node will not watch it. `reason` is `too_large` (more history than the node's `--max-sh-creates`: no live signal; the address page polls the address's unconfirmed transactions instead, [`API.md`](API.md#what-the-page-shows-of-such-an-address)), `no_index` (the node runs without `--sh-index`), `server_full` (the node's own subscription cap) or `refused` (any other refusal). Final until the page subscribes again |

No message is sent until the node has answered, normally a few milliseconds after subscribing. One node subscription serves every socket following the address, and it is dropped when the last one leaves; one whose request is still in flight then keeps its place under `WS_TRACKED_ADDRESSES_TOTAL` until the node answers, so sockets subscribing and leaving fast cannot pile up requests on the node.

**Bounds.** One socket may follow `WS_MAX_TRACKED_TXS` (4) transactions and `WS_MAX_TRACKED_ADDRESSES` (2) addresses, inside `WS_MAX_SUBSCRIPTIONS`; over either, close `4001`. A network follows at most `WS_TRACKED_TXS_TOTAL` (10,000) distinct transactions and `WS_TRACKED_ADDRESSES_TOTAL` (1,000) distinct addresses. Past those the socket is sent `{"topic":"tx:…","type":"refused","reason":"server_full"}` (or the same for an address), is not subscribed, and stays open: try again later. When the last socket following a transaction or address unsubscribes or closes, the server forgets it, its stored message and, for an address, the node's subscription.

**New addresses per client.** Each new node subscription makes the node hash the address's whole history, so a client may start them only so fast: one token each from a per-client budget, by default 30 at once, then 2 a second, the address routes' numbers ([`CONFIG.md`](CONFIG.md#address-and-batch-routes)) in a bucket of their own. Only following that asks the node something costs a token: an address another socket already follows, of this client or any other, or one whose node request is still in flight after its last socket left, is free; one the node has stopped watching costs a token again. Transactions never cost one: following them asks the node nothing. The client is the one the per-client limits key on (IPv4 address or IPv6 /64, behind a trusted proxy as in [`CONFIG.md`](CONFIG.md#client-addresses)), and its sockets on both `/app/ws` and `/api/v1/ws` share the budget. Over it, the socket is sent `{"topic":"address:…","type":"refused","reason":"follow_rate"}`, is not subscribed, and stays open; the refusal is counted in `requests_refused` (reason `follow_rate`), never written on its own line. The site's pages follow at most one address each (the address page), so a visitor clicking from address to address, or restoring sixteen address tabs, stays well inside it; the address routes those pages also call run out first. One client can make the node start at most 30 address subscriptions at once and 2 a second after, where it could start about 160 a second before the budget.

**With the mempool engine off** (`{NET}_MEMPOOL_ENABLED=false`), `tx:<txid>` answers `{"topic":"tx:…","type":"off"}` and nothing else. Addresses do not need the engine and work either way. Before the tracker's first complete cycle a `tx:` topic sends nothing, rather than a state it cannot vouch for.

**Recovery.** Nothing to do: every message is complete. After a reconnect, subscribe again and the first message is the current state.

**Cost.** A followed transaction asks the node nothing: its state comes from the tracker's records and removal reasons, the projected blocks and the replacement record ([`MEMPOOL.md`](MEMPOOL.md#following-a-transaction)), all already in memory. Measured locally on the release build against regtest (5,000 transactions in the mempool, Apple M4 shared with other work), 5,000 sockets each following a different transaction:

| | |
|---|---|
| Node calls a minute, nobody connected | 18 (2.01 MB), no cluster requests |
| Node calls a minute, 5,000 followers, mempool unchanged | 18 (2.01 MB), no cluster requests: the same |
| Every socket has its first message | within the 5 s it took to open them |
| Server RSS | 17 MB idle, 38 MB with the 5,000 sockets open, 70 MB at the peak of the next two minutes |
| Server CPU | 14% of one core while the sockets opened, 0–4% after |
| A minute of churn (a child paying 100 sat/vB for one of them every 0.5 s) | 29,973 messages, 8.2 MB encoded once, about 6 per transaction: one per position interval |
| The block that confirmed all 5,000 | 5,000 `confirmed` messages; no client dropped |

## Connection rules

| Rule | Default | Setting |
|---|---|---|
| Sockets open at once, every network together | 1,024 | `WS_MAX_SOCKETS` |
| Sockets per client address | 16 | `WS_CLIENT_MAX_SOCKETS` |
| Largest message from a client, after reassembling fragments | 1,024 bytes | `WS_MAX_MESSAGE_BYTES` |
| Frames per second from a client, every kind counted; a burst of the same size is allowed | 10 | `WS_MESSAGES_PER_SEC` |
| Topics subscribed at once | 8 | `WS_MAX_SUBSCRIPTIONS` |
| Of those, `projected-txs:N` topics | 2 | `WS_MAX_BLOCK_SUBSCRIPTIONS` |
| Of those, `tx:<txid>` topics | 4 | `WS_MAX_TRACKED_TXS` |
| Of those, `address:<address>` topics | 2 | `WS_MAX_TRACKED_ADDRESSES` |
| Distinct transactions and addresses followed, per network | 10,000 and 1,000 | `WS_TRACKED_TXS_TOTAL`, `WS_TRACKED_ADDRESSES_TOTAL` |
| New address follows that ask the node, per client and network, both sockets together | 30 at once, then 2 a second | `CLIENT_BURST / 4`, `CLIENT_RATE_PER_SEC / 10` |
| Messages about a followed transaction that only moved | one per 10 s | `WS_POSITION_INTERVAL_MS` |
| Messages per mempool topic | one per 2 s | `WS_MEMPOOL_INTERVAL_MS` |
| Transactions in the `transactions` list | 10 | `WS_LATEST_TXS` |
| Messages queued for a client that is not reading | 64 | `WS_SEND_QUEUE` |
| Silence before the socket is closed; the server pings at half of it | 60 s | `WS_IDLE_TIMEOUT_SECS` |

Over a cap at upgrade time, the request is refused before it becomes a socket: `429` past the per-client cap, `503` past the total. Clients are counted as in [`CONFIG.md`](CONFIG.md#client-addresses) (IPv6 by /64, the trusted proxy header only from a trusted proxy). The upgrade request also passes the ordinary request limits.

**Only this site's pages may open a socket** ([`SECURITY.md`](SECURITY.md) rule 21). A browser always sends `Origin` with an upgrade; the server accepts it only when its host and port equal the request's `Host` (letter case and the scheme's default port ignored), and refuses anything else with `403` `{"error":"websocket refused: Origin is not this site"}` before any socket slot is taken. Without the rule, any website could open sockets from each of its visitors until their per-client cap was reached and lock them out of this one. `Host` is the name the browser used, so every host name the site answers to works without a setting, as long as the reverse proxy passes `Host` through unchanged, port included (nginx: `proxy_set_header Host $http_host`, since `$host` drops a non-default port; Caddy does by default). A proxy that rewrites `Host` to the server's own address makes every browser socket fail: the refusals are counted in `requests_refused`, the first after a quiet minute is an `http_request` with `refused: "origin"`, and a `ws_origin_refused` warning naming the origin and host seen ([`LOGGING.md`](LOGGING.md#websocket-hub)). An upgrade without `Origin` is a program, not a browser page, and is allowed: no third party can make a visitor's browser send one.

Browsers answer pings on their own, so a live tab is never closed for silence. A client may send `{"op":"ping"}` every 30 seconds or so to learn that a socket died without a close.

## Close codes

| Code | Reason text | Why |
|---|---|---|
| 1000 | `closed by client` | Answer to the client's close |
| 1001 | `server shutting down` | Shutdown. Reconnect with backoff |
| 1002 | `protocol error` | Bad framing: unmasked, reserved bits set, unknown opcode, a fragmented or oversized control frame, a continuation out of place, a close frame with a status an endpoint may not send |
| 1003 | `binary messages are not accepted` | The client sent a binary message |
| 1007 | `invalid utf-8` | A text message, or a close frame's reason, that is not UTF-8 |
| 1009 | `message too big` | A message over `WS_MAX_MESSAGE_BYTES`, refused from the frame header before the payload is read |
| 4000 | `bad message` | Not a message listed above |
| 4001 | `too many subscriptions` | Over `WS_MAX_SUBSCRIPTIONS`, `WS_MAX_BLOCK_SUBSCRIPTIONS`, `WS_MAX_TRACKED_TXS` or `WS_MAX_TRACKED_ADDRESSES` |
| 4002 | `too many messages` | Over `WS_MESSAGES_PER_SEC` |
| 4003 | `too slow` | The send queue was full: the client is not reading |
| 4004 | `idle timeout` | Nothing received for `WS_IDLE_TIMEOUT_SECS`, ping unanswered |

A client closed for 1002 to 4002 has a bug; reconnecting will not help. After 4003 or 4004, reconnect with backoff. The close frame is written after any frame in progress and the queued messages are dropped. When a client has stopped reading, the close frame may never reach it: the write gives up after `REQUEST_TIMEOUT_SECS` without progress and the connection is dropped.

**A client that never reads** holds, at most, its kernel socket buffers and `WS_SEND_QUEUE` (64) messages, for at most `REQUEST_TIMEOUT_SECS` after its buffers fill, even if it keeps sending pings so it is never idle. The messages are references to frames every subscriber shares, so what it pins is the frames its topics have moved past since: with a busy synthetic mempool replacing a quarter of a 4,000-transaction block every step, one such socket on two projected blocks and the other mempool topics held 1.5 MB in 64 messages (the largest 224 KB) when it was closed with `4003`, and sixteen of them, one address's allowance, stalled at the same moment, held the same 1.5 MB between them (`subscribers_that_never_read_hold_at_most_their_queues`). The largest message is a full projected block's snapshot, about 930 KB, so one socket can pin at most about 60 MB. Sockets add only the frames they do not share: ones that stall at different moments, or follow different projected blocks, can each pin frames the others do not, up to sixteen times that in the worst case, each for at most `REQUEST_TIMEOUT_SECS` after it stalls. Over TCP with a 4 KB receive window and a 2 s write timeout, a pinging client that never read 256 KB blocks, each sent as soon as the last was fetched, was dropped 3.4 to 3.7 s after the first (`a_client_that_never_reads_but_pings_is_dropped_once_its_writes_stall`).

## The mempool.space-shaped socket (`/api/v1/ws`)

For wallets and bots written against mempool.space's WebSocket: `/api/v1/ws` on each network (`/signet/api/v1/ws`, `/testnet4/api/v1/ws`, `/testnet5/api/v1/ws`, `/regtest/api/v1/ws`). It runs on the same hub, framing, limits and tracking as `/app/ws` and speaks the reference's JSON, observed from mempool.space ([`compat/websocket.md`](compat/websocket.md)) and held to recorded messages by a test (`every_message_has_the_reference_shape`, against [`fixtures/websocket/reference.json`](../fixtures/websocket/reference.json)). It is a public API: unlike `/app/ws` it may change only to add, and other sites' pages may open it ([below](#why-other-sites-may-open-it)). It is not a drop-in replacement: what it leaves out is [listed](#differences-from-the-reference). The code is `crates/server/src/ws/v1.rs`.

### What a client sends

Text frames with one JSON object. An object may hold several of these keys; each is handled.

| Message | Does |
|---|---|
| `{"action":"ping"}` | Answered `{"pong":true}` |
| `{"action":"init"}` | Answered `{"loadingIndicators":{},"backend":"esplora","backendInfo":{…},"da":{…}}`: what no part carries, and `da`, which the reference's transaction page reads for its ETA without wanting `stats`. `backendInfo` is `GET /api/v1/backend-info`'s answer; `loadingIndicators` is always empty; `da` is `stats`' (below), left out before the server has read a tip. The parts' state comes with `want`, not here |
| `{"action":"want","data":["blocks","stats","mempool-blocks","live-2h-chart"]}` | Replaces the set of parts wanted; other names are ignored. Each newly wanted part first sends its current state, then every change; `live-2h-chart` has no state and sends each new sample, as on the reference. `"data":[]` stops them all |
| `{"track-tx":"<txid>"}` | Follows one transaction, 64 hex digits in lower case. A new one replaces the last; `{"track-tx":"stop"}` ends it |
| `{"track-address":"<address>"}` | Follows one address of this network (bech32 in either case). A new one replaces the last; `"stop"` ends it |
| `{"track-addresses":["<address>", …]}` | Follows a set of addresses, replacing the last set; `[]` stops it. Duplicates count once |
| `{"track-mempool-block":<n>}` | Draws projected block `n` ([below](#projected-block-drawings)). A new one replaces the last; a negative `n` stops it, as the reference's frontend sends (`-1`) when it leaves the page |
| `{"track-rbf":"all"}`, `{"track-rbf":"fullRbf"}` | The newest replacement trees, all or only those with a full-RBF replacement ([below](#replacement-feeds)). One replaces the other; any other value stops it, as `"stop"` does when the reference's frontend leaves `/rbf` |
| `{"track-rbf-summary":true}` | The newest replacements in short. Any other value stops it, as `false` does when the reference's frontend leaves its home page |

What else happens, as on the reference unless it says otherwise:

| A client sends | It gets |
|---|---|
| Text that is not JSON | Close `4000` (the reference closes too, without a status) |
| JSON it does not understand: another type, an unknown key or `action`, a value of the wrong type, a txid or address that does not parse for this network | Nothing; the socket stays |
| `track-mempool`, `track-mempool-txids`, `track-txs`, `track-scripthashes`, `track-accelerations` | `{"<key>-error":"not served by this server"}`, and the socket stays. Ours: the reference serves them |
| `refresh-blocks` and the reference's other keys | Nothing |

### What the server sends

Every message is one JSON object in its own frame, with the key named here.

| Message | When | What |
|---|---|---|
| `{"blocks":[…]}` | On `want` | The last 8 blocks, oldest first, each as `GET /api/v1/blocks` lists it, with `extras` ([below](#blocks-and-their-extras)) |
| `{"block":{…}}` | Each new block, once its row is in the block table | The same JSON |
| `{"da":{…},"fees":{…},"mempoolInfo":{…},"transactions":[…],"vBytesPerSecond":1422}` | On `want` of `stats`, then every `WS_MEMPOOL_INTERVAL_MS` (2 s) | Whatever of these the server has: `mempoolInfo` is the node's `getmempoolinfo` as the mempool tracker last read it, amounts in BTC; `vBytesPerSecond` is the mempool's inflow ([below](#the-inflow-rate)); `fees` is `GET /api/v1/fees/precise`'s answer and `da` `GET /api/v1/difficulty-adjustment`'s ([`API.md`](API.md#mempoolspace-shaped-routes-apiv1)); `transactions` is the newest `WS_LATEST_TXS` transactions seen, `{txid, fee, vsize, value, rate, time}` with `rate` in sat/vB |
| `{"mempool-blocks":[…]}` | On `want`, then when the projected blocks change | `GET /api/v1/fees/mempool-blocks`' answer. After a `block`, the next one is on that block: right behind it when the projected blocks on it are ready first, or as soon as they are. One on another block than the last `block` waits for it for at most 3 s, as on `/app/ws` |
| `{"live-2h-chart":{"added":…,"count":…,"vbytes_per_second":…,"mempool_byte_weight":…,"total_fee":…,"min_fee":…,"vsizes":[…]}}` | Each minute's mempool history sample, as it is stored | The point `GET /api/v1/statistics/2h` lists first from then on, written by the same function ([`API.md`](API.md#mempool-statistics)). Nothing on `want`: a client reads the series over HTTP and appends these. Needs a data directory and the mempool engine; without them the part is accepted and sends nothing |
| `{"txPosition":{"txid":"…","position":{"block":0,"vsize":1078}}}` | The followed transaction waits | `block` is the projected block, 0 for the next; `vsize` is what is mined before it inside that block. Sent when it changes, a mere shuffle at most once per `WS_POSITION_INTERVAL_MS`, from the same pass as `tx:<txid>` ([above](#following-a-transaction-or-an-address)) |
| `{"txReplaced":{"txid":"<replacement>"}}` | It was replaced | The transaction that replaced it. The reference's message says nothing of whether the replacement is mined; a change to that (a reorg) sends the same message again |
| `{"txConfirmed":"<txid>"}` | It was mined | Also when a reorg's new block confirms a transaction that had been replaced |
| `{"address-transactions":[…]}` | `track-address`: transactions paying or spending it entered the mempool | The node's Esplora JSON for each, as `GET /api/tx/:txid` serves it |
| `{"block-transactions":[…]}` | `track-address`: transactions of it confirmed | As above |
| `{"projected-block-transactions":{"index":0,"sequence":1,"blockTransactions":[…]}}` | `track-mempool-block`, and when a block found changes most of it | The block's transactions in mining order, each `[txid, fee, vsize, value, rate, flags, first seen]`: sats, the sigop-adjusted vsize, total output value in sats, effective rate in sat/vB, its flags as in the binary records ([`API.md`](API.md#transaction-flags), a number), Unix seconds |
| `{"projected-block-transactions":{"index":0,"sequence":2,"delta":{"added":[…],"removed":[…],"changed":[…]}}}` | Its changes, at most once per `WS_MEMPOOL_INTERVAL_MS` (2 s), at once on a new tip | `added` as above; `removed` txids; `changed` `[txid, rate, flags, 0]` for a transaction whose rate or flags moved |
| `{"rbfLatest":[…]}` | `track-rbf`, then when the record of replacements changes, checked every `WS_MEMPOOL_INTERVAL_MS` (2 s) | The bytes `GET /api/v1/replacements` (or `/fullrbf/replacements`) answers at that moment: the 25 newest trees |
| `{"rbfLatestSummary":[{"txid","mined","fullRbf","oldFee","oldVsize","newFee","newVsize"},…]}` | `track-rbf-summary`, then as `rbfLatest` | The 6 newest trees of `/replacements`, each its newest transaction (`txid`, `new…`, `mined` `false` when not mined) and the sums of fee and vsize of what it directly replaced (`old…`), as the reference adds them |
| `{"multi-address-transactions":{"<address>":{"mempool":[…],"confirmed":[…],"removed":[]}}}` | `track-addresses`: the same events | One address per message, written as the server writes it (bech32 in lower case); `removed` is always empty |
| `{"<key>-error":"…"}` | `track-tx`, `track-address`, `track-addresses` or `track-mempool-block` over a limit below, or a block that is not served | The socket stays. What the message asked to stop is stopped: a refused `track-tx` or `track-address` has still ended the previous one, and a `track-addresses` set keeps the addresses the server could take |

A part wanted, or a transaction followed, gets its current message at once (a transaction gets none while no message applies: not seen yet, evicted). `live-2h-chart` and an address get nothing until the next sample or change, as on the reference. After a reconnect, send everything again.

#### Projected block drawings

| Case | Answer |
|---|---|
| `n` 0 to 6 | The block's list, then its changes; a block the projection does not have is an empty list |
| `n` 7, the last block | `track-mempool-block-error`: it holds the rest of the mempool, 42,064 transactions and 4.2 MB a list on mainnet (2026-11-15), with no bound. `/app/ws` has no topic for it either |
| `n` 8 or more | The same error. The reference sends nothing |
| Not an integer | Nothing |
| The block already drawn, again | Its stored state again (frames already encoded), at most once per `WS_MEMPOOL_INTERVAL_MS`; the rest are ignored. The frontend asks again when it loses its place, hundreds of times a second |

`sequence` rises by exactly one with each message of a block, for every socket: one that joins gets the list and up to 16 changes since, one higher each, and then the same messages as everyone. The frontend asks for the block again when a `sequence` does not follow. The order against `block` is `mempool-blocks`' ([above](#what-the-server-sends)), with the exception every topic has: the state a socket gets when it joins, or asks again, is the latest held, possibly on the parent of the last `block`, and the drawing on that block follows as a change ([When a block is found](#when-a-block-is-found)). A slow client is dropped (`4003`), as on every topic.

#### Replacement feeds

Observed on mempool.space's public socket and frontend, 2026-11-15, and served the same way:

| Case | Answer |
|---|---|
| A feed started | Its list at once: the stored one, or, if no socket held the feed, one the server builds within `WS_MEMPOOL_INTERVAL_MS` |
| The record changed (a replacement, one mined, a reorg) | Every followed list again, whole, both trees lists even if one did not change, as the reference does. On mainnet the reference sent one every 3 to 20 s |
| The same feed asked again | Its stored list again (a frame already encoded), at most once per `WS_MEMPOOL_INTERVAL_MS`; the rest are ignored |
| A feed stopped and started again, or switched | Its stored list at once each time, so at most one list per message the socket sends: `WS_MESSAGES_PER_SEC` (10) bounds it, and a faster socket is closed. A frame already encoded, as switching `track-mempool-block` sends a block's |
| The mempool engine off | Nothing: there is no record (`/replacements` answers 503) |

A list does not depend on the projected blocks, so it is not held against `block`: a tree's `mined` can turn `true` just before or after its block's `block` message. A slow client is dropped (`4003`), as on every topic.

#### Blocks and their extras

The blocks come from the block table, by the code that writes `GET /api/v1/blocks` ([`API.md`](API.md#blocks)), read again each time the table follows the chain. A new block's row is written after its summary and audit, so its `block` follows `/app/ws`'s:

| Network | `block` after `/app/ws`'s |
|---|---|
| regtest, empty blocks | under 3 ms (3 blocks) |
| mainnet, 2026-11-15, 975,974 to 975,977 | 1.1 to 3.5 s: the summary's `getblock`, then the audit |

| Case | Sent |
|---|---|
| The row is not written yet (the node's Esplora late, the table behind) | Nothing until it is: a block is never sent without its extras |
| Rows for several new blocks at once | Each as a `block`, oldest first |
| 8 or more new rows at once, or a reorg | One `blocks` with the new list |
| A row rated later | Nothing; the next `want` gets the new extras |
| No data directory (no block table) | The node's Esplora JSON as `GET /api/block/:hash` serves it, no `extras` or `stale`, at the same moment as `/app/ws`'s `block`. Without extras, mempool.space's frontend cannot draw a block page |

No block is sent twice. The table is read once per follow for every socket, and a new block's header costs the node one request, shared with `GET /api/v1/blocks`.

#### The inflow rate

`vBytesPerSecond` is what entered the mempool over the last minute the history sampled, per second: the sigop-adjusted virtual size of every transaction the tracker saw accepted from one whole minute of the clock to the next, over 60, as a whole number. It is that sample's `vbytes_per_second` rounded, and so it changes once a minute, when the sample is written, and is the same in every `stats` message until the next. It is sent while that sample is at most two minutes old, and left out otherwise: before the first sample after start (the first whole minute is not sampled, so allow up to two), without a data directory or with the mempool engine off (nothing is sampled), and while the sampler skips minutes because the node is failing ([`STORE.md`](STORE.md#mempool_history)). Never a zero it did not measure.

The reference's moves a little in every frame, about once a second: a rate over a moving window, whose length its answers do not show. Its `live-2h-chart` sample carried the same number as the `vBytesPerSecond` sent beside it. Side by side on mainnet: [below](#cost-of-a-compatible-socket).

**Addresses.** When an address is first followed, the server reads its newest history page once from the node (up to 50 mempool and the 25 newest confirmed transactions, `/scripthash/:hash/txs`) and says nothing: that is what the client could already see. On each change of the node's Electrum status for it, the server reads the page again and sends what is new in it. One read per address and change, whatever the number of sockets; changes during a read make one more read; at most two reads per network at once, each counted until the node answers or 60 s pass, as the address routes' calls are ([`SECURITY.md`](SECURITY.md) rule 11), and capped at 8 MB. The address routes' verdicts hold here too ([`API.md`](API.md#very-large-addresses)): an address whose totals or history page the node refused as too large, or whose first page ran past 5 s, is not read for 5 minutes, and a read that runs past 5 s is remembered as such for the HTTP routes and every socket. A read still waiting its turn is dropped when no socket follows the address any more. So more than 50 mempool or 25 confirmed transactions between two changes are not all sent, and a transaction that leaves the mempool unconfirmed is not said. An address the node will not watch (more history than its `--max-sh-creates`) gets no messages; `/app/ws` says why, this socket does not. A first follow, which reads the page, takes a token from the client's budget for new addresses, shared with `/app/ws` ([above](#following-a-transaction-or-an-address)), and so does its node subscription if no socket has one: two for an address nobody follows. Over the budget the key's error is `too many new addresses from this client; retry in a moment` and the socket stays.

### Limits

Every rule in [Connection rules](#connection-rules) applies, with the same settings and close codes, except the socket counts:

| Rule | Default | Setting |
|---|---|---|
| `/api/v1/ws` sockets open at once, every network together | 256 | `WS_V1_MAX_SOCKETS` |
| `/api/v1/ws` sockets per client address | 4 | `WS_V1_CLIENT_MAX_SOCKETS` |

They are pools of their own: a compatible socket never takes one of `WS_MAX_SOCKETS` or a client's `WS_CLIENT_MAX_SOCKETS`, and the reverse. Over a cap at upgrade, `503` or `429` as for `/app/ws`, logged with `refused` `v1_server_sockets` or `v1_client_sockets`.

Per socket, the parts wanted (four at most), the block drawn and the two replacement feeds count inside `WS_MAX_SUBSCRIPTIONS`; the `track-tx` transaction inside `WS_MAX_TRACKED_TXS`; the `track-address` address and the `track-addresses` set together inside `WS_MAX_TRACKED_ADDRESSES` (2; the reference allows 10). Over it, `track-addresses` is answered `track-addresses-error` and changes nothing; `track-tx` and `track-address` answer `track-tx-error` and `track-address-error`. Past the network's `WS_TRACKED_TXS_TOTAL` or `WS_TRACKED_ADDRESSES_TOTAL`, shared with `/app/ws`, the same keys say the server is full, for the transaction or each address it could not take; past the client's budget for new addresses, that it is going too fast. A message is at most `WS_MAX_MESSAGE_BYTES` (1,024 bytes, about twenty addresses).

### Why other sites may open it

`/app/ws` refuses another site's page ([`SECURITY.md`](SECURITY.md) rule 21), because that page could otherwise open sockets from each of its visitors until their allowance was used up and lock them out of our pages. A public API socket is meant to be opened from other sites, so the same attack is closed another way: its sockets come from the pools above. Another site can use up a visitor's 4 compatible sockets, and with enough visitors all 256, but never one `/app/ws` socket, so our pages keep working. Each pool bounds its own memory and file descriptors.

### Differences from the reference

| What | Here | Why |
|---|---|---|
| Key order | Alphabetical in every object the server builds, nested ones included; `rbfLatest` keeps `GET /api/v1/replacements`' order | Messages are built as `serde_json::Value`, whose objects keep their keys sorted. JSON objects are unordered: read keys by name |
| Frames | One part per message | The reference puts several in one frame (a block with `mempool-blocks`, `fees`, `da`, `txConfirmed`, …). Each of ours is encoded once and shared by every subscriber; bundling would mean a frame per combination. A client reads every key of every message |
| `blocks`, `block` | `GET /api/v1/blocks`' JSON: its `extras` lack `orphans`, `utxoSetChange`, `avgTxSize`, `totalInputs`, `totalOutputs`, `totalOutputAmt`, `segwitTotalTxs`, `segwitTotalSize`, `segwitTotalWeight`, `coinbaseBip54`, `similarity`. Sent once the block's row is written ([above](#blocks-and-their-extras)); without a data directory, the node's Esplora JSON | The extras are what our block table holds. Only best-chain blocks are sent |
| `init` | `loadingIndicators`, `backend`, `backendInfo`, `da` only; no `rbfSummary` | The rest is each part's state, sent on `want`. `track-rbf-summary` brings the replacements: the reference's home page fills its list from `rbfLatestSummary` alone |
| `rbfLatest`, `rbfLatestSummary` | Their own messages, within 2 s of a change | The reference sends them in the stats frame when `stats` is wanted, alone otherwise |
| `vBytesPerSecond` | The last sampled minute's inflow, once a minute; absent without a recent sample | From the stored samples rather than a second, faster count ([above](#the-inflow-rate)) |
| `live-2h-chart` | Once a minute, stamped with the minute (`added` a multiple of 60); none after a block | The sample as stored. The reference stamps the second it sampled, and sent one more sample, off the minute, when a block arrived |
| `mempoolInfo` | rbitcoin's `getmempoolinfo`: has `fullrbf`, `limitclustercount`, `limitclustersize`; no `permitbaremultisig`, `maxdatacarriersize` or `optimal` | The node's own answer |
| `stats` cadence | Every 2 s | The reference sends about once a second; `WS_MEMPOOL_INTERVAL_MS` bounds every mempool topic |
| `transactions` | `vsize` is the sigop-adjusted integer | The tracker's unit |
| `txPosition` | No `cpfp`; sent when it changes | The CPFP details are `GET /app/tx/:txid/relatives`; the reference repeats the position in every stats frame |
| `txConfirmed` | Its own message | As above |
| Transactions in address messages | The node's Esplora JSON, without the reference's own fields (`order`, `vsize`, `adjustedVsize`, `feePerVsize`, `adjustedFeePerVsize`, `effectiveFeePerVsize`, `firstSeen`, `cpfpDirty`, `clusterId`, `chunkIndex`, `cpfpChecked`, …) | Passed through from the node, never rebuilt |
| `track-addresses` | 2 addresses per socket by default | Each address is a node subscription; raise `WS_MAX_TRACKED_ADDRESSES` to allow more |
| `multi-address-transactions` | One address per message; `removed` always empty | Each address's message is encoded once for every socket following it |
| `projected-block-transactions` | Paid for by a child and pays for a parent by our own rule, from the chunk; replacement only for what this server saw replace ([`API.md`](API.md#transaction-flags)); vsize the sigop-adjusted integer; changes at most every 2 s and none when nothing changed; block 7 not served ([above](#projected-block-drawings)) | The reference's CPFP bits follow its own clusters and it flags fewer of a block. The reference sends a change about once a second, empty ones too |
| Not served | `refresh-blocks`, `conversions`, `track-txs`, `track-mempool`, `track-mempool-txids`, `utxoSpent`, `address-removed-transactions`, `rbfTransaction`, `rbfInfo` | Status and reason per message in [`compat/websocket.md`](compat/websocket.md) |

### Cost of a compatible socket

A compatible socket costs what an `/app/ws` socket costs: every message is encoded once per network and each socket's queue holds references to the same bytes. The replacement lists are the bytes the `/replacements` routes keep, built once per change of the record for both; while no socket follows a feed, its list is dropped and nothing is built for it. A change costs about 90 µs for both tree lists (25 trees, 17 KB) and the summary (1 KB), release build. On mainnet, 2026-11-15, over the same 200 s: ours sent 12 lists, at most one per 2 s, the reference 18, at matching moments. `live-2h-chart` is encoded once per sample, in the sampler's own report of the write, and `vBytesPerSecond` is read from that sample in memory: neither reads the store or the node. The blocks are one read of the block table per change of it, for every socket. Nothing it sends reaches the node except a new block's header, once and shared with `GET /api/v1/blocks`, and following an address, which reads one history page per change of the address, shared by every socket following it.

A projected block is encoded only while a compatible socket draws it, once per message for all of them, by one task per network. Block 0 on mainnet, 2026-11-15, release build:

| | JSON here | Binary, `projected-txs:0` |
|---|---|---|
| Whole list | 613 KB (6,096 transactions), 3.2 ms to encode | 293 KB |
| A change, one per 2.0 s | median 2.8 KB, at most 29 KB; 0.4 ms (at most 2.3 ms) with the diff | median 1.4 KB, at most 12 KB |

Measured locally on the release build against the regtest node (Apple M4 shared with other work, clients in Bun on the same machine), every socket wanting `blocks`, `stats` and `mempool-blocks` and following the same transaction and address, under the same activity in each step (a payment to the address every 15 s, a block a minute), 60 s a step:

| Sockets | Server CPU | Server RSS | Sent to clients | RPC calls a minute | Address reads a minute |
|---|---|---|---|---|---|
| 1 | 0.05% of one core | 8 MB | 1.2 KB/s | 29–37 | 5 |
| 100 | 0.15% | 9 MB | 131 KB/s | 29–37 | 5 |
| 1,000 | 1.0% | 15 MB | 1.3 MB/s | 29–37 | 5 |

The node's work does not change with the sockets: the RPC calls are the mempool tracker's, and the address is read once per payment or block whatever the number of sockets following it. Memory grows by about 6 KB a socket. No socket was dropped.

**Against the reference, on mainnet,** 2026-11-12, 15 minutes and three blocks (975,542 to 975,544): our server read-only against a synced node with the mempool engine on, one client to it and one to mempool.space's socket, each wanting every part and following the same transaction and its address.

| | Here | Reference |
|---|---|---|
| `block`, after the reference's | +0.43 s, +2.5 s, −0.63 s | |
| Of which our own wait | 0.9 s each: the node's Esplora had not caught up with its announcement, as for `/app/ws` | |
| The tracked transaction's `block-transactions` and `txConfirmed`, after the reference's | +0.46 s and +1.3 s | In the `block` frame |
| First `mempool-blocks` on the new block, after its `block` | 3.7 to 4.2 s | In the same frame |
| `stats` | one per 2.0 s | one per 1.1 s |
| Traffic for these parts | 1.7 KB/s | 3.5 KB/s |

**`vBytesPerSecond` and `live-2h-chart` against the reference,** mainnet, 2026-11-12, 19:55 to 20:10 UTC (two blocks): the release build read-only with the mempool engine on and no backfill, one client to it and one to mempool.space's socket, each wanting `stats` and `live-2h-chart`.

| | Here | Reference |
|---|---|---|
| First `vBytesPerSecond` | 2 min 6 s after start: the engine synced in 16 s, the first two minutes were not sampled; the 63 `stats` messages before it left the key out | At once |
| `vBytesPerSecond`, the same 13 minutes | 812 to 4,814 minute by minute, mean 2,257 | 1,667 to 2,852 as a mean per minute, moving by a median 7 vB/s a frame; mean 2,316 |
| `live-2h-chart` | 13, each 1 to 15 ms after its minute | 19: one a minute at :35, and two more within seconds of each block, before and after it |
| `count` in the samples | 54,755 to 58,617 | 65,381 to 70,533 |

The rates agree over the window (3 %) and disagree minute by minute because ours is one minute's arrivals and theirs a moving window; both rose in the minute after each block (ours to 4,814 and 4,433). The counts differ because the mempools do: mempool.space runs its own Bitcoin Core node, ours is the rbitcoin node. Its sample's `vbytes_per_second` equalled the `vBytesPerSecond` sent beside it every time.

Shapes matched as the conformance test says, and only where the table of differences says. The `mempool-blocks` on a new block waits for the fee task's next projection read and then this socket's own, each once per `WS_MEMPOOL_INTERVAL_MS`; `/app/ws` sends its projection about 2 s after the block. The whole server, engines included, used 3.3% of one core and 83 MB.

## How it works

- **Fan-out.** A topic message is encoded once into a complete WebSocket frame (header and payload) held behind a reference count. Sending it to a subscriber puts a reference on that subscriber's bounded queue; the subscriber's writer puts the same bytes on the wire. Nothing is copied or encoded per connection.
- **Cost per connection** is one task, its queue and its subscriptions: about 5 KB of server memory measured with 5,000 open sockets, plus kernel socket buffers. Memory grows linearly with connections. Queued messages are shared, so a full queue costs 64 references, not 64 copies.
- **Cost per message** is one `O(subscribers)` pass of non-blocking queue pushes under the topic's lock, then one write per subscriber on its own task. Measured: about 2 ms to queue a block to 5,000 sockets, and about 35 ms until 5,000 local clients had all read it.
- **Upstream work is shared and capped.** No client message reaches the node, but for following an address, which joins one shared Electrum subscription per address, capped per network with requests in flight counted, and started by each client only within its budget ([above](#following-a-transaction-or-an-address)). The only other upstream calls are the block fetch for each new block, made by one task per network (normally one request, about 90 in a minute at most), the block's summary, computed once by the summary routes' own capped worker, and the mempool engine's polling, which runs whatever the number of subscribers. The full fetch is also the existence check, since a missing block is a short 404 and a separate check would add a round trip once the block is there. `hello` and the snapshots come from memory.
- **Mempool topics** are produced by one task per network that reads the latest projection, compares each block with what it last published, and encodes each message once. A topic's stored state for new subscribers is its last snapshot plus the deltas appended since; after 16 deltas, or when they outweigh the snapshot, they are folded into a fresh snapshot, which is stored but sent to nobody.
- **Shutdown.** Every socket is sent `1001` and given up to `REQUEST_TIMEOUT_SECS`, counted from the signal, to finish, together with the HTTP connections. Sockets still open then are dropped, and the server waits for them to release their slots.
- **Behind TLS.** The reverse proxy must pass `Upgrade` and `Connection` through (nginx: `proxy_http_version 1.1`, `proxy_set_header Upgrade $http_upgrade`, `proxy_set_header Connection "upgrade"`), pass `Host` through for the origin check above and keep idle connections open longer than `WS_IDLE_TIMEOUT_SECS / 2`, the ping interval. The page connects to `wss://` on its own host, which the Content-Security-Policy's `default-src 'self'` allows in current Chromium, Firefox and WebKit (Playwright's builds, over plain HTTP and behind TLS, 2026-11). Older WebKit did not match `ws:`/`wss:` with `'self'` ([WebKit bug 201591](https://bugs.webkit.org/show_bug.cgi?id=201591)); if a user of an old Safari cannot connect, that is the cause.

## Conformance

The server side of RFC 6455 (handshake, framing, masking, fragmentation, control frames, close, SHA-1 and base64 for the accept key) is our own code in `ws/frame.rs` and `ws.rs`, about 300 lines in place of a library and its 22 crates. Two checks hold it to the standard:

- **[Autobahn TestSuite](https://github.com/crossbario/autobahn-testsuite)**, the standard conformance suite, run by `dev/autobahn/autobahn.py`. It builds the server with the `autobahn` feature, which makes the hub echo text messages and skip `hello`, raises the size, rate and queue limits to the most the config allows, and runs every case in Docker against it. It takes about a minute, too slow for CI: rerun it after changing `ws/`.
- **A fuzz test** in the normal test suite (`the_parser_survives_random_and_mutated_streams`) feeds 50,000 generated byte streams through the reader: valid and invalid frames, truncation, bit flips, absurd and non-minimal lengths, missing masks, interleaved control frames and fragments that never end. Each must end in a defined close code, and no payload buffer may exceed the message limit (or 125 bytes for a control frame). It takes about 0.6 s.

Autobahn results, 2026-11-12, every case:

| Cases | OK | Non-strict | Informational | Unimplemented | Failed |
|---|---|---|---|---|---|
| 1 Framing | 8 | | | | 8 |
| 2 Ping and pong | 11 | | | | |
| 3 Reserved bits | 5 | 2 | | | |
| 4 Opcodes | 6 | 4 | | | |
| 5 Fragmentation | 19 | 1 | | | |
| 6 UTF-8 | 141 | 4 | | | |
| 7 Close | 34 | | 3 | | |
| 9 Large messages | 15 | | | | 39 |
| 10 Auto-fragmentation | 1 | | | | |
| 12, 13 Compression | | | | 216 | |
| **All** | **240** | **11** | **3** | **216** | **47** |

No case shows a protocol violation. The rest, and why each stays:

| Result | Cases | Why |
|---|---|---|
| Failed | 1.2.*, and the binary cases of 9.* | Binary messages are refused with `1003` by design; the suite expects them echoed |
| Failed | The 9.* cases over 1 MiB, the most `WS_MAX_MESSAGE_BYTES` allows | Refused with `1009` from the frame header. When the suite is still sending (8 and 16 MiB), the server has stopped reading and drops the connection, so the suite never sees the close frame. RFC 6455 section 7.1.7 lets an endpoint that fails a connection stop processing data |
| Non-strict | 3.2, 3.3, 4.1.3, 4.1.4, 4.2.3, 4.2.4, 5.15 | A valid message, then a broken frame. The connection closes with `1002` without echoing the valid message first, because the close frame goes ahead of queued messages. Strict order would mean flushing a queue that a slow client may have filled |
| Non-strict | 6.4.1–6.4.4 | Invalid UTF-8 in a fragmented message is caught when the message is complete, not at the fragment that broke it. The message is capped at `WS_MAX_MESSAGE_BYTES`, so the cost is reading at most that much |
| Informational | 7.1.6, 7.13.1, 7.13.2 | Behaviour the RFC leaves open: a close handled before a large earlier echo went out, and close codes 5000 and above answered with `1002` |
| Unimplemented | 12.*, 13.* | Compression (`permessage-deflate`), which the server never negotiates |

## Adding a topic

1. Add a variant to `Topic` in `crates/server/src/ws.rs` and its name to `Topic::parse` and `Topic::name`. A topic with a parameter (a tracked transaction) takes it as a parsed value in the variant, never a raw string.
2. Produce its messages in one task per network, as `feed` in `ws/hub.rs` does for `blocks` and `ws/mempool.rs` for the mempool topics: build the JSON with `serde_json` (or a binary payload with `Frame::encode`), then call `Hub::announce` (or `Hub::publish`) once per change. `Snapshot::Replace` makes the message the topic's current state for new subscribers; `Clear` and `Keep` are for messages that invalidate it or leave it alone; `Append` is for a change new subscribers must also get after the state, and `Hub::set_snapshot` folds those into a new state without sending it. `announce` logs a `ws_fanout` line per message: use `publish` and a periodic summary for a topic that sends every few seconds.
3. If the topic needs upstream work per subscribed value, start it on the first subscriber and stop it on the last, through the shared, capped Electrum subscriptions ([`SECURITY.md`](SECURITY.md) rule 10), and add its own per-connection cap. A topic family with a parameter that costs more to send (`projected-txs:N`) also gets a per-connection cap.
4. Rate-limit a topic whose source changes often, and keep each message bounded in size.
5. Document it here under Topics, with how a client recovers from a missed message, and its cost.
