# Public API

The server serves rbitcoin's Esplora REST API under `/api`: the same routes, status codes, body bytes and content types as the node, behind an allow-list of parsed routes ([`SECURITY.md`](SECURITY.md) rules 1–3). Wallets and tools that speak Esplora can point at it unchanged. This page lists the routes and every way we differ from the node. The code is `crates/server/src/esplora.rs`. The mempool.space-shaped routes under `/api/v1` are [their own section](#mempoolspace-shaped-routes-apiv1).

| Network | Base URL |
|---|---|
| Mainnet | `/api` |
| Signet | `/signet/api` |
| Testnet4 | `/testnet4/api` |
| Regtest | `/regtest/api` |

A disabled network's base is a `404`.

## The contract

Request and response shapes are rbitcoin v0.9.2's: [`docs/esplora-openapi.yaml`](https://github.com/rbitcoin-org/rbitcoin/blob/v0.9.2/docs/esplora-openapi.yaml) and the "Esplora REST surface" section of its [`COMPAT.md`](https://github.com/rbitcoin-org/rbitcoin/blob/v0.9.2/COMPAT.md#esplora-rest-surface). Address and scripthash routes need the node's `--sh-index`.

## Routes

`asof` marks the routes that take `?asof=<blockhash>`.

| Group | Routes |
|---|---|
| Tip | `GET /blocks/tip/height`, `GET /blocks/tip/hash` |
| Blocks | `GET /blocks`, `GET /blocks/:start_height`, `GET /block-height/:height` |
| Block | `GET /block/:hash`, `/header`, `/status`, `/raw`, `/txids`, `/txid/:index`, `/txs`, `/txs/:start_index` |
| Transaction | `GET /tx/:txid`, `/hex`, `/raw`, `/status` (asof), `/merkle-proof`, `/merkleblock-proof`, `/outspend/:vout` (asof), `/outspends` (asof); `GET /txs/outspends?txids=` |
| Output by position | `GET /block-height/:height/tx/:index` (asof), `GET /block-height/:height/tx/:index/out/:vout` (asof), `GET /tx/:txid/out/:vout` (asof), `POST /block-heights/txs/outs` (asof) |
| Address and scripthash | `GET /address/:address` and `GET /scripthash/:hash`, each bare (asof), `/utxo` (asof), `/txs` (asof, `?after_txid=`), `/txs/chain[/:last_seen_txid]` (asof), `/txs/mempool`, `/txs/summary[/:last_seen_txid]` (asof, `?after_txid=` without the path cursor) |
| Mempool | `GET /mempool`, `/mempool/txids`, `/mempool/txids/page[/:last_txid]` (`?max_txs=`), `/mempool/recent` |
| Fees | `GET /fee-estimates` |
| Broadcast | `POST /tx` |

`HEAD` is accepted wherever `GET` is. Any other path under `/api` is a `404`, and a known path with the wrong method is a `405` with `Allow`.

### Not served

| Route | Why |
|---|---|
| `/internal/*` | Bulk routes for the server's own use. They exist only on the node's unix socket and are never reachable from outside |
| `POST /addresses/txs`, `POST /scripthashes/txs` and their `/summary` | One request can ask for up to 300 address-index joins. That is unbounded load for one client to cause (rule 11). Ask per address instead |
| `POST /txs/test`, `POST /txs/package` | Broadcast is the only write we serve (rule 5). Package relay and test-accept may come later with their own limits |
| `GET /block-template` | Off on the node by default, about 5 MB, and the server uses RPC for templates |
| `/blindbit/v1/*` | Silent-payments oracle; not part of the Esplora surface |

## Differences from the node

### Parameters are parsed strictly

Every parameter is parsed into a typed value before the node is asked, and the node is sent a path we wrote from that value. A request that does not parse never reaches the node.

| Input | Node | Here |
|---|---|---|
| Txid or block hash | 64 hex digits, optional `0x`; a bad one is `404` | Exactly 64 hex digits, any case; a bad one is `400` |
| Height, index, vout, `max_txs` | integer | Decimal digits only, at most `u32::MAX`; anything else is `400` |
| Address | Parsed by the node; a bad or wrong-network one is `404` | Parsed for the network in the URL: `400 invalid address` or `400 address is for another network` |
| `?asof=` on a route that does not take it, any other unknown query parameter, or one given twice | `404` for `asof`; others ignored | `400` |
| `/txs/outspends?txids=` | Up to 50; a token that is not a hash gets an empty slot | Up to 50; any token that is not a txid is `400`. `%2C` is accepted as the comma |
| `/block/:hash/txs/:start_index` not a multiple of 25 | `400` | `400`, before asking the node |
| `POST /block-heights/txs/outs` | More than 300 is `422` | Same, and the body is rebuilt from the parsed positions; it must fit in `MAX_BODY_BYTES` |
| Trailing or doubled slash | `404` | `404` |

The node is sent canonical forms: lowercase hex, lowercase bech32 addresses, `/block/:hash/txs` as `/txs/0`, and `/txs/summary?after_txid=X` as `/txs/summary/X`. The node answers each pair the same.

### Error bodies are ours

A successful answer is forwarded byte for byte. Any other answer is replaced by `{"error": "<message>"}` with `Content-Type: application/json`, because the node's error text can name operator flags and internal paths (rule 17). Errors carry no chain-tip headers.

| Cause | Status | Message |
|---|---|---|
| Unknown object, or an `asof` block not on the best chain | `404` | `not found` |
| Bad parameter | `400` | names the parameter, for example `invalid txid` |
| Cursor txid not in that history | `422` | `after_txid not found` |
| Node runs without `--sh-index` | `503` | `address index is disabled on this server` |
| Address above the node's `--max-sh-creates`: its totals, unspent outputs and history ([below](#very-large-addresses)) | `503` | `address history too large for this server` |
| Tip moved under a pinned read | `503` | `chain tip moved during the request; retry` |
| The network's address and batch calls are all running ([below](#protection-for-the-node)) | `503` | `node busy; retry` |
| Node answered `503` for another reason (no tip, no fee estimates yet) | `503` | `node unavailable` |
| Node unreachable, failed, or answered nonsense | `502` | `upstream unavailable` |
| Node too slow, or a page of address history it took over 5 s on moments ago ([below](#very-large-addresses)) | `504` | `request timed out` |

`503` and `429` carry `Retry-After`.

### Headers

- `X-Bitcoin-Chain-Tip` and `X-Bitcoin-Chain-Tip-Height` are copied from the node's answer when it has them.
- `Content-Type` is the node's. No other node header is copied (`X-Powered-By` is dropped).
- **CORS:** every `/api` response carries `Access-Control-Allow-Origin: *` and exposes the two chain-tip headers, `X-Request-Id` ([`LOGGING.md`](LOGGING.md#request-ids)) and the mining routes' coverage headers ([below](#coverage)), including refusals (`429`, `503`, `504`), so a web client can read why it was refused. A preflight `OPTIONS` is answered with `204`, methods `GET, HEAD, POST`, header `Content-Type`, cached for a day. Broadcast is included: it needs no credentials and no cookie ever applies, so a cross-origin page can do nothing a plain `curl` cannot, and refusing CORS would only break browser wallets.

### Cache headers

A wrong `immutable` cannot be recalled from a cache, so it is used only where the URL's hash fixes the whole answer and the answer says nothing about confirmation.

| Routes | `Cache-Control` |
|---|---|
| `/block/:hash`, `/header`, `/raw`, `/txids`, `/txid/:index` | `public, max-age=31536000, immutable` |
| `/tx/:txid/hex` and `/raw` of a transaction **without** witness data | `public, max-age=31536000, immutable` |
| `/tx/:txid/hex` and `/raw` of a segwit transaction | `public, max-age=1`. A txid does not commit to the witness, so the bytes can change while unconfirmed or after a reorg |
| Every other successful read | `public, max-age=1` |
| Broadcast, and every error or refusal | `no-store` |

Block JSON has no confirmation status (the node drops a block that leaves the best chain rather than flagging it), so it is immutable. `/block/:hash/status`, `/block/:hash/txs` (each transaction carries a status), `/block-height/:height` and merkle proofs change with a reorg and are not.

## Protection for the node

- **Identical requests share one call** (rule 8). Requests that arrive while the same upstream call is in flight wait for it and get its answer. Once answered, the next request asks the node again. Measured: 300 concurrent identical requests made one upstream call.
- **Hot answers are held for one second:** `/blocks/tip/height`, `/blocks/tip/hash`, `/blocks`, `/mempool`, `/mempool/txids`, `/mempool/recent` and `/fee-estimates`. Their keys are fixed, so this cache holds at most seven answers per network. Measured: 20,303 sequential `/blocks/tip/height` requests in 3 seconds made three upstream calls.
- **Address and batch routes have a cost limit** (rules 8 and 11). Every address and scripthash route, `/txs/outspends` and `POST /block-heights/txs/outs` can cost the node far more than a lookup: totals for one busy signet address took 9.7 s. At most four run at once per network, and eight more wait for a slot; a client has a share of those and a rate of its own ([`CONFIG.md`](CONFIG.md#address-and-batch-routes)). Past that the answer is immediate, `503` `node busy; retry` or `429`, with `Retry-After: 1`. Joining an identical call already running is free. A call runs in a task of its own that holds its slots until the node has answered, or 60 seconds have passed, even after the request has timed out (`504` at `REQUEST_TIMEOUT_SECS`): retrying a slow query cannot pile more work onto the node than the limit allows. On a regtest node, rbitcoin v0.9.2 stopped using CPU within half a second of its clients hanging up on 200 large address answers, but that work was mostly encoding the answer; nothing shows that a long index scan is abandoned, so the limit assumes it is not.
- **Address histories the node will not finish are refused at once** ([below](#very-large-addresses)).
- **`?asof=` is served, under that limit.** It pins an answer to a block and makes every request a distinct key, so sharing calls never helps; but the limit counts calls started, not keys, so distinct keys buy nothing. Dropping it would break Esplora clients that page consistently through a history, for no protection the limit does not already give.
- **Every request** passes the server-wide limits in [`CONFIG.md`](CONFIG.md): body size, timeout, per-client rate and concurrency.
- **A buried block's immutable answers are kept in memory** ([below](#answers-kept-in-memory)): after the first, no request for them reaches the node.

## Answers kept in memory

Some answers are the same for every client until something specific changes. The server computes each once and serves it from memory until then: one cache per network, `crates/server/src/answers.rs`. The mining answers, the mempool statistics and the block summaries keep their own answers, refreshed on their own terms (their sections say how).

| Answers | Kept until |
|---|---|
| `/api/v1/blocks[/:start_height]`, `/api/v1/block/:hash`, `/app/block/:hash/summary`, `/app/blocks/summary` | The next write to the block table or the audits: a new block, a backfilled or rated row, a reorg, a new audit, a pool-list change |
| The [audit routes](#block-audits) but `predictions`, whose window moves with the clock | The same |
| `/api/block/:hash`, `/header`, `/raw`, `/txids` and `/txid/:index` of a block at least 100 blocks under the node's tip | For good; they leave only to make room |

- **Never older than the store.** The store keeps a version per table ([`STORE.md`](STORE.md#using-it)). A write marks each table it will change before its first statement on it runs, and clears the mark once it has committed or rolled back, before the writer is told it is done. A request reads the versions of its route's tables before anything else; while one is marked, the answer is computed as before and not kept. A kept answer is served only while the versions are the ones it was computed under, so the first request after a write computes afresh and sees it. The coverage headers (`X-Data-From-Height`, `X-Data-From-Time`, `X-Data-Complete`), the chain-tip headers and `Cache-Control` are part of the kept answer. Only a `200` is kept, and not one that rests on the node's tip as well (a list from past the table's top). Every other input of these answers is fixed by a hash (a block's header, its summary) or by the build (the pool list).
- **Immutable node answers.** The pass-through keeps a `200` it serves `immutable` ([Cache headers](#cache-headers)) from a block hash's routes once the block is at least 100 blocks under the tip the node stamped the answer with: the block table's follow zone ([`STORE.md`](STORE.md#blocks)), below which the table never rewrites a row. The height is the block JSON's own, or the one the `/api/v1` block routes learnt from it; a route whose block's height the server does not know yet is not kept, nor is a transaction's raw form, whose answer does not say how deep it is. **Reorgs:** the node serves no block off its best chain (it answers `404`), so a `200` says the block was on the best chain when it was answered. A block within 100 of the tip is never kept, so one that leaves the chain before it is buried was never kept, and the next request gets the node's `404`. A kept block would need a reorg deeper than 100 blocks, deeper than the block table itself repairs; mainnet has not had one. A kept answer is stamped with the tip the node last announced over Electrum each time it is served, or with no tip headers while there is none.
- **Bounds.** `ANSWER_CACHE_MB` per network (32 by default, [`CONFIG.md`](CONFIG.md#answers-kept-in-memory)), counting each answer's body, headers and key and about 200 bytes more. An answer over a 64th of it (512 KB by default) is not kept: a raw mainnet block, 1 to 4 MB, is always passed through, and a busy block's `txids`, about 250 KB, is kept. New answers enter a probation segment and move to a protected one, at most four fifths of the budget, when asked for again; the least recently used of probation leaves first. So a client walking many distinct keys only churns probation and cannot push out answers in use.
- **What a miss costs.** Exactly what the request cost before: the same store reads, the same node calls under the same limits and call sharing. A key asked once buys nothing for the next distinct one. Concurrent identical misses share one computation (rule 8); one whose computation ended in an error, a refusal or an answer not kept computes its own, as before, so one client's refusal is never another's answer. `/api/v1` keys leave out the query string, which those routes ignore; `/app` keys include it.
- The request log names a kept answer's source `cached`.

### Very large addresses

**What "large" means here, the one place it is defined.** rbitcoin counts an address's size in *creates*: transactions paying it, each counted once however many of its outputs pay it ([`RBITCOIN.md`](RBITCOIN.md#address-history-cost)). Its `--heavy-sh-creates` (10,000 by default) lets one totals join above that size run at a time across the node, and its `--max-sh-creates` (10,000 by default; the operator may raise it, or set `0` for none) refuses totals above that size at once, saying how many creates the address has. The server calls an address **large** when:

- the node refused its totals for size (more creates than the node's cap), or
- the node answered its totals with more than 10,000 funded outputs (`ledger::LARGE`): a totals answer does not give creates, and every paying transaction pays at least one output, so funded outputs are never fewer than creates and the server never takes a large address for a small one, or
- the node took longer than 5 s (the history deadline) to answer its totals.

Anything the node answered within 5 s with at most 10,000 funded outputs, in its current totals (not totals at an old block, nor a list of unspent outputs), is **small**. So there are three kinds of address, by paying transactions: up to the node's heavy threshold, answered as any address; above it and up to the node's cap, answered by the node once, one at a time, and from then on by the server's own ledger; above the cap, refused by the node's ordinary routes: added up once through the node's Esplora socket where it has the uncapped totals route (rbitcoin PR 1628, [`RBITCOIN.md`](RBITCOIN.md#totals-of-large-addresses)), and from then on answered by the ledger; otherwise shown as below. Code: `crates/server/src/ledger.rs` (the guard and the ledger), `verdicts.rs` (what is remembered), `esplora.rs` (the routes), `crates/engine/src/ledger/` (the running totals, [`STORE.md`](STORE.md#ledger)).

**The guard: one unseeded large join at the node at a time, whatever the cap.** An address's totals or unspent outputs (`/address/:a`, `/utxo`, either with `?asof=`, address or scripthash form) for a script the server does not know to be small go through **one lane for the whole server**, every network together: one such call at the node at a time, held until the node answers or 15 minutes pass (the node cannot be stopped, so the lane is not given back while it may still be working). Seeds, the WebSocket's size check before following an address ([`WS.md`](WS.md#following-a-transaction-or-an-address)) and discovery take the same lane. A request waits for the lane at most 5 s, then gets `503 node busy; retry` with `Retry-After: 1`; identical requests share one call and only its leader waits. The reader of a call the node takes longer than 5 s over gets `504 request timed out` at 5 s, and from that moment the address is known large. Each answer teaches the server the size, remembered per network in the verdict table (at most 4,096 entries): **small** for an hour, then asked through the lane again (an address grows); **large** for 30 days, never sent to the node again except to seed it; **refused for size** for 5 minutes, then asked again (a refusal costs the node 10–35 ms, and the operator may have raised the cap). A script known small is asked as before, four at once per network under the address routes' cost limit ([above](#protection-for-the-node)). So with no cap at all on the node, one visitor or a thousand make it run at most one join the server has not seen answer quickly, and never the same large one twice; the first visit of each new address waits its turn in the lane.

**The ledger** (with `DATA_DIR`). Once added up, a large address is answered by the server from its store without asking the node, exact at the ledger's block ([`STORE.md`](STORE.md#ledger)):

| Request | Answer for an address the ledger keeps | Node work |
|---|---|---|
| `/api/address/:a`, `/api/scripthash/:h` | The node's shape: `chain_stats` from the ledger; `mempool_stats` counted from the node's unconfirmed rows for the script (`/txs/mempool`, at most 50; with 50 there may be more, and the answer carries `X-Mempool-Stats-Partial: true`). `X-Bitcoin-Chain-Tip` and `-Height` name the ledger's block. `Cache-Control: no-store` | One cheap mempool lookup, shared and under the cost limit |
| `/utxo`, totals with `?asof=` | `503 unspent outputs and older history are not kept for an address this large` | None |
| Any history page (`/txs`, `/txs/chain[/:last_seen]`, `/txs/summary[/:last_seen]`, any cursor), once its whole history is kept | The node's shapes and order, the rows from the store ([below](#paging-a-kept-history)) | One call under the cost limit: the page's transactions by txid, at most 25, one at a time, the cursor's status and the block's |
| Any history page while its whole history is not kept (being taken, refused, dropped for the bound) | `503 address history too large for this server`; the newest transactions are in `/app/address/:a/ledger` | None |
| `/txs/mempool` | Asked as before | Cheap |

A large address not yet added up is refused the same way, at once, without the node.

**Adding one up (seeding).** The node's totals for the address, pinned with `?asof=` to a block the ledger already holds, then the blocks since applied to it alone; and the node's newest page of history at that block, so its newest transactions are not empty on the first day. Three ways start one:

- **The answer itself.** A totals answer that showed the address is large is taken as its seed when its chain-tip stamp names a block the ledger holds (or the node's tip, when nothing is tracked yet): no second join. Its history page follows as a fill (below).
- **A reader.** The address page asks `/app/address/:a/ledger` (below); for an address known large and not kept, that queues a seed.
- **Discovery** (`LEDGER_DISCOVER`, on by default). For each new block the ledger reads, the three scripts paid by the most transactions in it (each paid by at least two) are candidates; at most 16 wait, and at most 12 an hour are checked, each through the lane like a reader's totals, and not again for a week. A large one is taken as tracked from that answer; one refused for size is queued as a discovered seed when the node's socket has the uncapped totals route, and otherwise not checked again for an hour. An address nobody pays any more is never a candidate: it is found only when a reader opens it. On signet, a day's 144 blocks gave 54 distinct candidates, 10 of them large; checking all 54 cost the node 58 s in all, the slowest 21 s (2026-11-14, read-only).

**The whole history.** A kept address that a reader views (its page asks `/app/address/:a/ledger`, and asks again every 5 minutes while open) then takes the list of all its confirmed transactions from the node, once ([`STORE.md`](STORE.md#ledger)); one nobody views, such as most of discovery's, keeps only its totals, newest 200 and chart, so the node is not made to list the busiest scripts for nobody. The list is one Electrum `get_history` pinned to a block the ledger holds ([`RBITCOIN.md`](RBITCOIN.md#the-whole-history-of-a-large-address)), streamed into the store, then kept from each block and across reorgs. Lists run in the lane after the readers' seeds and the fills and before discovered seeds, one at a time, and only while the address was viewed in the last hour; the lane is held until the node has answered or 15 minutes pass. A list that fails is tried again after 10 minutes, doubling at each failure up to a day; one the node refuses for size (its cap is in force), after a day, since a refusal costs it milliseconds. The stored histories have a bound per network, `LEDGER_MAX_HISTORY_ROWS` ([`CONFIG.md`](CONFIG.md#very-large-addresses)): the least recently viewed address's history is dropped to make room, never one viewed in the last 30 minutes (a reader may be paging it; when only those could make room, the list waits and is tried again later), and an address larger than the whole bound is never asked. A dropped history is taken again when a reader views the address, at most once a day per address, counted from when it was last taken: the lists are heavy for the node (up to about 5 GB of its memory and minutes for the largest on mainnet, [`RBITCOIN.md`](RBITCOIN.md#the-whole-history-of-a-large-address)), so readers moving between addresses cannot make it list them in turn. Followers of the address hear `ledger` again when its list is done ([`WS.md`](WS.md#following-a-transaction-or-an-address)). From then on its history pages are served from the store (below).

**Filling in the past.** An address whose whole history is not kept, added up without the history page (from an answer, or a seed whose page failed), and any kept before this existed, takes it later, once. It waits while its whole list may still come (the address was viewed in the last hour), so the node does not do two large joins where one suffices: it goes ahead for an address nobody views, and once the node refused the list, the bound dropped it, or two lists failed; a whole history never needs it: the node's newest page pinned with `?asof=` to the seed block, joined below the transactions kept since ([`STORE.md`](STORE.md#ledger)). That block is often older than the ledger's last 100, so it is the node's block at that height, checked to lie below the ledger's own tip on the node's chain. When the transactions kept since the seed already fill the 200, or some of them may be missing (see `STORE.md`), the node is not asked and the address is marked done. Fills run in the lane after the readers' seeds and before discovered ones, one at a time; whether an address has had its page is in the store, so no address is asked for twice, across restarts too. A failed fill is tried again after 10 minutes, doubling at each failure up to a day. The page costs the node about 100 s for the largest mainnet address and seconds for most ([`RBITCOIN.md`](RBITCOIN.md#address-history-cost)); pages further back are never asked, since each costs as much as the first. Followers of the address hear `ledger` again when a fill is done, rows added or not ([`WS.md`](WS.md#following-a-transaction-or-an-address)).

Seeds run one at a time for the whole server, in the lane. Each network's queue holds at most 16 readers' seeds and 16 discovered ones, readers' first; a client holds at most 2 places in it, the one running included; a reader's seed nobody has asked about for 2 minutes is dropped before it starts (the page asks every few seconds while it waits); a seed the node takes 15 minutes over is given up and not tried again for 10 minutes. Where the server reaches the node's Esplora over its unix socket and the node has the uncapped totals route, a seed asks that route, so the node's cap does not refuse it ([`RBITCOIN.md`](RBITCOIN.md#totals-of-large-addresses) says how the server finds out, at startup and after every reconnect). Otherwise, a seed the node refuses for size (its cap is in force for that address) leaves the address as it was, is not tried again for an hour, and is logged once (`ledger_seed_refused`) until a seed works again. The ledger keeps at most `LEDGER_MAX_ADDRESSES` (1,000) per network, dropping the least recently viewed; a dropped address that is asked for again is seeded again ([`CONFIG.md`](CONFIG.md#very-large-addresses)).

**Live changes.** The node is not asked to watch a kept address; the ledger tells its followers when a block changes it ([`WS.md`](WS.md#following-a-transaction-or-an-address)). Unconfirmed transactions come from the mempool route, as below.

**History pages of other addresses.** Unchanged from before the ledger:

| Request | Answer | Node work |
|---|---|---|
| Any history page of an address refused for size (`/txs`, `/txs/chain[/:last]`, `/txs/summary[/:last]`, any cursor or `?asof=`, address or scripthash form) for 5 minutes after | `503 address history too large for this server`, at once | None |
| A history page whose node call has run 5 s | `504 request timed out`, at 5 s. The call keeps its place under the cost limit until the node answers or 60 s pass ([above](#protection-for-the-node)) | The call already running |
| That page again (same script, cursor and `?asof=`; its `/txs`, `/txs/chain` and `/txs/summary` forms alike) for 5 minutes after | `504 request timed out`, at once | None |

- **5 s for a page of history, or for totals,** counts from when the node call starts. Ordinary pages answer in 0.3 to 0.5 s on mainnet; every slower page measured took over 10 s.
- **Logged** as refusals, counted in `requests_refused` with the reasons `history_too_large`, `history_slow` and `lane_busy`, never one line per request ([`LOGGING.md`](LOGGING.md#refusals)).
- **The `/api/v1/ws` address follow** reads the same first page ([`WS.md`](WS.md#the-mempoolspace-shaped-socket-apiv1ws)). It skips an address the server knows to be large, and a read of its that runs past 5 s teaches a verdict.
- **Not served:** the unspent outputs of a large address, and its history older than the ledger's 200 newest transactions unless its whole history is kept.

#### Paging a kept history

Once a kept address's whole history is in the store, `/api/address/:a/txs`, `/txs/chain[/:last_seen]` and `/txs/summary[/:last_seen]` (and the scripthash forms) answer from it in the node's own shapes, so the address page's "Show 25 more" and any Esplora client work unchanged. Code: `crates/server/src/kept.rs`, rows from `ledger::history_page`.

- **Rows and order.** 25 a page, newest first in the node's order: height, then txid bytes, both descending ([`RBITCOIN.md`](RBITCOIN.md#the-whole-history-of-a-large-address)). A `last_seen_txid` (or `?after_txid=`) continues after that transaction; its height comes from the node's `/tx/:txid/status`. A cursor the node does not know, or not in this history, is `422 after_txid not found`, as the node answers. On `/txs` an unconfirmed cursor among the address's unconfirmed rows keeps the rows after it, then the first chain page; another unconfirmed one starts the chain page again, as the node does.
- **Transactions.** Each row's transaction is asked of the node by txid (`/tx/:txid`) and passed on as the node gives it; one not confirmed at the stored height, or the ledger's block no longer on the node's best chain (`/block/:hash/status`, asked after the lookups), means the node's chain moved under the ledger's block, and the page is `503 chain tip moved during the request; retry` until the ledger follows. `/txs/summary` rows are counted from the same transactions: `value` (net sats for the address), `height`, `time`; `tx_position`, which the store does not hold, is left out (it is optional in the node's answers too). A pruned transaction (inputs below the node's prune point) cannot be counted, and its summary page is `502`.
- **Unconfirmed.** `/txs` starts with the node's unconfirmed rows for the address (`/txs/mempool`, at most 50), as the node's does.
- **Exact at** the ledger's block, named by `X-Bitcoin-Chain-Tip` and `-Height`. `?asof=` is served for any of the ledger's last 100 blocks (rows up to that block, no unconfirmed rows); an older one is `503 unspent outputs and older history are not kept for an address this large`.
- **Cost.** Each page is one call under the address routes' cost limit ([above](#protection-for-the-node)), shared by identical requests: at most one unconfirmed list, one cursor status, 25 lookups by txid and one block status at the node, one at a time, and one indexed read of the store that seeks straight to the cursor, so a page deep in a history costs what the first does. The node is never asked for a page of the address itself.

#### What the page shows of such an address

**`GET /app/address/:address/ledger`** says what the ledger holds or where its seed stands, from the store and memory only. For an address the server knows to be large and does not keep, it queues a seed for this client, within the bounds above. `Cache-Control: no-store`. `404 this server keeps no ledger` without `DATA_DIR`; `400` as `/api` for a malformed or other network's address.

| `state` | Fields | Means |
|---|---|---|
| `tracked` | `chain_stats` (as the node's), `balance` (sats), `at` (`height`, `hash`, `time` of the block the totals are exact at), `seeded` (`height`, `time`: tracking began after that block), `window` (200), `filling` (`true` until the transactions from before `seeded` have been added, or found not to fit, and never while the whole history is kept; until then `txs` holds only those since), `history` (where its whole history stands: `none` not taken yet or the last try failed, `taking`, `whole`, `refused` by the node, `dropped` for the bound, to be taken again when viewed, `too_large` for the bound), `history_again` (for a `dropped` history, Unix seconds from which it is taken again when viewed; `null` once it may be, or in any other state), `txs` (the newest transactions, newest first in block order, at most `window`, each `txid`, `height`, `position`, `value` net sats for the address, `time`), `points` (the balance chart from when tracking began, oldest first, each `height`, `time`, `balance`) | Kept |
| `queued` | `position` | Waiting its turn |
| `seeding` | `seconds` | Being added up now |
| `refused` | `creates`, `cap` (or `null`) | The node refused to add it up: its cap is in force, and its socket has no uncapped totals route |
| `failed` | | The last seed failed; tried again in 10 minutes |
| `busy` | | Large, but the queue is full or this client holds its share: ask again later |
| `none` | | Not known to be large |

**`GET /app/address/:address/size`** answers `{"creates": 3665660, "cap": 10000}`: the counts of the node's last refusal of that address's totals (`creates` is transactions paying the address), `scripthash join exceeds --max-sh-creates (3665660 creates, cap 10000)` on mainnet (2026-11-14, 58 ms). From memory only, kept 5 minutes; `404 size not known` otherwise. Read defensively: only exactly that message, with plain decimal counts that fit a `u64` and more creates than the cap, gives a size. Code: `ScriptSize` in `crates/node/src/esplora/error.rs`. `/api/address/:a` is unchanged byte for byte: its refusal stays the fixed `{"error": …}`.

**Unconfirmed transactions** come from `/api/address/:a/txs/mempool`, which the cap never applies to: the mempool's rows for that one script, at most 50, answered in under a millisecond on mainnet. The page asks again every 10 s while it is in view (`POLL_MS`, `web/src/pages/address/poll.ts`). **Cost:** one sub-millisecond node lookup per open, visible page every 10 s, under the address routes' cost limit; identical asks at the same moment share one call.

## Broadcast

`POST /tx` with the raw transaction as hex in the body, optionally surrounded by whitespace. The answer is the txid as `text/plain`.

- **Parsed before sending:** the body must decode as exactly one transaction. The node is sent our own serialization of it, never the client's bytes.
- **Size cap:** 400,000 bytes of transaction (800,000 hex characters), the most a standard transaction can be. Larger is `413`.
- **Rate limit,** separate from and stricter than reads: a burst of 5 per client, then one every 10 seconds; past it, `429` with `Retry-After: 10`. Refused bodies count.
- **Rejects** are `400` with a fixed reason: rbitcoin's own reason when it is on our list of known policy and consensus reasons (`min relay fee`, `dust`, `mempool double-spend`, `bad-txns-inputs-duplicate`, …), otherwise `transaction already in the mempool or chain`, `missing or spent inputs`, `script verification failed` or `transaction rejected`.
- **Off switch:** `BROADCAST_ENABLED=false` turns it off for every network; it then answers `403 broadcast is disabled on this server`.

## mempool.space-shaped routes (`/api/v1`)

A subset of mempool.space's own API, for wallets and tools written against it, under each network's `/api/v1` (`/api/v1`, `/signet/api/v1`, …). Which routes exist is the `served` rows of [`compat/api-v1.md`](compat/api-v1.md). Any other path under `/api/v1` is a `404`. Its WebSocket, `/api/v1/ws`, is in [`WS.md`](WS.md#the-mempoolspace-shaped-socket-apiv1ws).

### How every route here works

New routes follow this pattern; the code is `crates/server/src/api_v1.rs`.

- **Same shape, our numbers.** Field names, their order and their JSON types match the reference backend ([`COMPAT.md`](COMPAT.md)). The values are computed by us, from the node; where they differ from the reference's, the route's section says how and why. Clean room: shapes are observed from responses, never read from mempool.space's code or docs.
- **Answered from memory.** A task per network keeps the answer current, woken by the Electrum events the WebSocket hub follows, and does the node fetches. A request never causes a node call (rule 8), except on the block routes, which read headers and blocks once each and keep them ([Blocks](#blocks)), and `POST /prevouts`, which reads each outpoint asked under the batch routes' cost limit ([Prevouts](#prevouts)). Pure logic lives in `engine`, the task in its own server module.
- **Before the first answer:** `503` `{"error": "not ready yet; retry"}` with `Retry-After: 1`.
- **Headers:** `X-Bitcoin-Chain-Tip` and `X-Bitcoin-Chain-Tip-Height` name the tip the answer is as of. When the node cannot confirm the answer is current (Electrum is disconnected, or a newer tip could not be computed yet), `Age` gives the seconds since it was computed; the last answer is still served. `Cache-Control: public, max-age=1`. CORS is that of `/api`.
- **Requests:** `GET` and `HEAD`, and `POST` for `/prevouts`. Query strings are ignored, so cache-busting parameters work, except `txId[]` on `/transaction-times`. Errors use the model above.

### Difficulty adjustment

`GET /api/v1/difficulty-adjustment`: where the chain is in its 2016-block difficulty period and what the next retarget is expected to do. Code: `crates/engine/src/difficulty.rs` for the arithmetic, `crates/server/src/difficulty.rs` for the task.

| Field | Type | Meaning |
|---|---|---|
| `progressPercent` | number | Blocks mined after the period's first block, out of 2016 |
| `difficultyChange` | number | Expected change at the next retarget, in percent, if the rest of the period is mined at its average pace so far. Exact once the tip is the period's last block |
| `estimatedRetargetDate` | integer | When the next period's first block is expected, Unix milliseconds: now plus `remainingTime` |
| `remainingBlocks` | integer | Blocks still to mine, up to and including the next period's first block |
| `remainingTime` | integer | `remainingBlocks` × `timeAvg`, milliseconds |
| `previousRetarget` | number | The change at the adjustment that started this period, in percent. `0` in the first period |
| `previousTime` | integer | Timestamp of this period's first block, Unix seconds |
| `nextRetargetHeight` | integer | Height of the next period's first block |
| `timeAvg` | integer | Average time between this period's blocks so far, from their timestamps, in milliseconds. The target spacing (600,000) while the tip is the period's first block |
| `adjustedTimeAvg` | integer | Always equal to `timeAvg` |
| `timeOffset` | integer | Always `0` |
| `expectedBlocks` | number | Blocks the period would have by now at one per 10 minutes |

The projection follows consensus exactly: the retarget measures the time from the period's first block to its last (2015 intervals, so a period at exactly 10 minutes a block still raises difficulty by 0.05%), clamps it to between a quarter and four times two weeks, scales the target and stops at the network's minimum difficulty. Replaying 6 recent retargets on each of mainnet, signet and testnet4 from a synced node gave the bits the next period actually carried, every time; fixtures in `fixtures/difficulty/` keep 10 of them as tests.

The remaining blocks are projected from now, or from the tip's timestamp if that is later, because the retarget measures block timestamps rather than our clock. It is recomputed once per new tip (two small Esplora reads: this period's first block and the previous period's) and on a reorg. A read stamped with a different tip than the one being computed is discarded and retried, so blocks from two branches are never combined.

| Network | What the answer means |
|---|---|
| Mainnet, signet | As above. Signet has its own, lower minimum difficulty |
| Testnet4 | BIP94: a retarget scales the bits of the period's *first* block, because its last is usually a minimum-difficulty block mined after a 20-minute gap. `difficultyChange` and `previousRetarget` describe that real difficulty; minimum-difficulty blocks count toward the period and the average like any other. Miners often stamp blocks up to two hours ahead of the clock, which is why the projection starts from the tip's timestamp |
| Regtest | Never retargets. `difficultyChange` and `previousRetarget` are always `0`; the period fields still count toward height multiples of 2016, where nothing happens. Blocks mined in bulk make `timeAvg` near zero, and the first period's average starts at the 2011 genesis block |

How we differ from the reference backend, measured side by side: progress, heights, block counts and `previousTime` match exactly and `previousRetarget` up to floating-point rounding. The reference's `timeAvg` divides the time from the period's first block to *now* by the blocks mined, so it grows between blocks and is wrong when the tip is ahead of the clock; ours uses the tip's timestamp. Its `difficultyChange` follows from that average: within 0.01 percentage points of ours on mainnet and signet, but about two points off on testnet4, where tips run hours ahead. `estimatedRetargetDate` and `remainingTime` differ accordingly.

### Backend info

`GET /api/v1/backend-info` says what is running, in the reference's shape and field order, with only what is true here and safe to tell a client. Code: `crates/server/src/api_v1.rs`.

| Field | Here | The reference's |
|---|---|---|
| `hostname` | `null` | Its host's name. Private ([`SECURITY.md`](SECURITY.md) rule 17) |
| `version` | The server's version (`0.1.0`), as `/healthz` and `/app/config` say it | Its own release |
| `gitCommit` | The commit the binary was built from, the 40 digits `/healthz` reports as `revision` ([`DEPLOY.md`](DEPLOY.md#health)); `null` for a build without one | 9 digits of its own commit |
| `lightning` | Whether this network serves the Lightning routes | The same |
| `backend` | `"esplora"`: transactions and addresses come from the node's Esplora | Its address backend: `esplora`, `electrum` or `none` |
| `coreVersion` | `null` | Its node's user agent. Asking ours would be a node call per request, and it is the node's to say |
| `osVersion` | `null` | Its host's operating system. Private |

The answer is fixed for the life of the process: no node call, `Cache-Control: public, max-age=1` as every route here. The chain-tip headers are not sent: it is not about a block.

### Fees

What to pay to be mined within a horizon, and the projected blocks behind it. Computed by us from the projected blocks ([`MEMPOOL.md`](MEMPOOL.md#fee-recommendations) has the method and its measured record); code: `crates/engine/src/fees.rs` for the method, `crates/server/src/ws/fees.rs` for the task, `crates/server/src/api_v1.rs` for the routes.

| Route | Answer |
|---|---|
| `GET /api/v1/fees/precise` | `{fastestFee, halfHourFee, hourFee, economyFee, minimumFee}` in sat/vB with three decimals: the node's own resolution (sat per 1,000 vB). **The one to use** |
| `GET /api/v1/fees/recommended` | The same five, each rounded **up** to a whole sat/vB, at least `1` |
| `GET /api/v1/fees/mempool-blocks` | `[{blockSize, blockVSize, nTx, totalFees, medianFee, feeRange}]`: the projected blocks, the next first, the last holding the rest of the mempool. Empty ones are left out |

| Field | Level | Horizon |
|---|---|---|
| `fastestFee` | `high` | the next block |
| `halfHourFee` | `medium` | within 3 blocks, about half an hour |
| `hourFee` | `low` | within 6 blocks, about an hour |
| `economyFee` | `no_rush` | within 144 blocks, about a day |
| `minimumFee` | | the lowest rate the node accepts now (`mempoolminfee`, never under 0.1 sat/vB) |

A faster level is never lower than a slower one, and none is below `minimumFee`.

**The whole-number route overstates.** Its shape, whole sat/vB with a floor of 1, is what old wallets parse, so it is kept. Rounding is always up, so a whole number never pays less than the precise rate it stands for. On rbitcoin's mempool, where most transactions pay under 1 sat/vB, that floor alone is up to ten times the minimum (`1` for a 0.1 sat/vB `minimumFee`), and any level under 1 sat/vB reads `1`. Use `/fees/precise`.

**Where the answer came from** is in the `X-Fee-Source` header, exposed to cross-origin callers like the chain-tip headers:

| `X-Fee-Source` | Meaning |
|---|---|
| `projected` | Ours, from the projected blocks on the tip in `X-Bitcoin-Chain-Tip` |
| `node` | The node's own `/fee-estimates` (targets 1, 3, 6 and 144 blocks), lifted to the node's minimum and put in order. Served while ours cannot be: while the projection is stale (the node is failing), always with `{NET}_MEMPOOL_ENABLED=false`, and in a warm-up (the first five minutes after start or after an outage) from its second minute, with each level no higher than the mempool and the arrivals watched so far justify ([`MEMPOOL.md`](MEMPOOL.md#while-warming-up)). No chain-tip headers; `Age` gives the seconds since the node answered |

When neither is available (the node's estimates are older than 90 s or never came, or a warm-up is in its first minute, when nothing yet says whether the node's estimate is sound: on a quiet network it can be a hundred times what is needed), the fee routes answer `503 not ready yet; retry` rather than such a number. `mempool-blocks` is `503 the mempool engine is off on this server` with the engine off, and otherwise serves the last projection, with `Age` while it is stale.

**Answered from memory.** A task per network recomputes the recommendation once per `WS_MEMPOOL_INTERVAL_MS` (2 s) from the latest projection, and the projected blocks once per new projection; a request reads the result. The only node calls are the task's `/fee-estimates` and `getmempoolinfo` (for the node's minimum now), at most once per 30 s, and only while the node's estimates are what is served and a fee route was asked in the last ten minutes (or the `fees` topic has a subscriber). After a quiet spell the first request is therefore a `503` with `Retry-After: 1`, and the answer follows within a few seconds.

#### The score kept

`GET /app/fees/score?window=24h|1w|1m|all` (per network prefix; `all` without the parameter) says how our own recommendations fared against the blocks that followed them, over the samples taken in the window: what the server records and how it scores it are in [`MEMPOOL.md`](MEMPOOL.md#the-score-the-server-keeps). Any other parameter, value, or a repeated one is `400`. It is answered from memory, rebuilt after every 30 s sample, so it costs a request nothing; with the mempool engine off it is `503 the mempool engine is off on this server`, and in the moment after start `503 not ready yet; retry`.

```json
{
  "window": "1w", "from": 1794577621, "to": 1794580127, "min_blocks": 30,
  "levels": [
    { "name": "high", "blocks": 1, "scored": 62, "outcomes": 31, "enough": true,
      "met": 0.4194, "interval": [0.2605, 0.5948],
      "overpay": { "mean": 4.12, "median": 2.0 }, "shortfall": 0.613,
      "left_out": { "outage": 0, "unfinished": 1, "no_clearing": 0 } },
    { "name": "no_rush", "blocks": 144, "scored": 0, "outcomes": 0, "enough": false,
      "met": null, "interval": null, "overpay": null, "shortfall": null,
      "left_out": { "outage": 0, "unfinished": 63, "no_clearing": 0 } }
  ],
  "not_ours": { "node": 10, "nothing": 1 }
}
```

| Field | Meaning |
|---|---|
| `from`, `to` | Unix seconds: the oldest sample in the window (none: `null`) and the moment of the answer |
| `levels[].blocks` | The level's horizon in blocks |
| `scored` | Samples whose horizon finished and was judged |
| `outcomes` | Distinct blocks that decided them. Samples waiting for one block share its fate, so this, not `scored`, is how much evidence there is |
| `enough` | `outcomes` is at least `min_blocks` (30). When it is not, `met`, `interval`, `overpay` and `shortfall` are `null`: no percentage from a handful of blocks |
| `met`, `interval` | The share met, and its 95% interval, as fractions |
| `overpay`, `shortfall` | sat/vB: the mean and median paid above what sufficed when met, the mean short of it when missed |
| `left_out` | Samples not judged: the horizon reached into an `outage`, is `unfinished`, or had `no_clearing` rate |
| `not_ours` | Samples in the window when the node's estimates, or nothing, were served instead of ours |

#### Differences from the reference

Shapes observed on the reference backend; values side by side in [`MEMPOOL.md`](MEMPOOL.md#against-the-node-and-the-reference).

| Field or route | Here | Why |
|---|---|---|
| Every rate | Our own method on rbitcoin's chunks, three decimals | The reference's own method is not ours to copy; rates are the node's sat per 1,000 vB, so more decimals would be noise |
| `economyFee` | About a day (144 blocks) | Our definition; the reference's was 0.2 when its minimum was 0.1, at every observation |
| `X-Fee-Source`, `Age` | Added | Says when the answer is the node's estimate, not ours |
| `blockSize` | The serialized sizes the tracker read, summed | Same meaning |
| `blockVSize` | Summed sigop-adjusted vsize, an integer | The reference's has quarters (weight over four) |
| `medianFee`, `feeRange` | The effective (chunk) rate at the middle vbyte; seven rates by vsize: lowest, 10th, 25th, 50th, 75th, 90th percentile, highest | The reference's last block carried eleven `feeRange` values; ours always seven |
| An empty projected block | Left out | |
| Whole numbers | Rounded up | The reference rounded to the nearest (1.557 to `1`, 3.505 to `4`), so its whole number can be below its own precise rate |

Side by side on mainnet (2026-11-12, tip 975,533, three moments a minute apart, the server's engine warmed up): `mempool-blocks` agreed with the reference's block for block: the next block had the same transaction count (2,049, 2,187, 2,209 against 2,049, 2,187, 2,210), the same `blockSize` to the byte and the same `totalFees` within a few satoshis; our `blockVSize` is up to 0.1% higher (sigop-adjusted), and the deeper blocks differ by tens of transactions where they cut through the 0.12 sat/vB ties. `precise` read 2.022 / 1.001 / 0.125 / 0.1 / 0.1 against the reference's 2.919 / 1.557 / 0.716 / 0.2 / 0.1, and `recommended` 3 / 2 / 1 / 1 / 1 against 3 / 1 / 1 / 1 / 1. How each fared against the blocks that followed is in [`MEMPOOL.md`](MEMPOOL.md#against-the-blocks-that-followed).

### Blocks

Blocks with the reference's `extras`, and every transaction of a block, for tools that list and inspect blocks. The home page's block strip pages back through the past with `blocks/:start_height` ([`FRONTEND.md`](FRONTEND.md#the-block-strips-past)). Code: `crates/server/src/v1_blocks.rs` for the block routes, `crates/server/src/summary.rs` for the two summary routes.

| Route | Answer | `Cache-Control` |
|---|---|---|
| `GET /api/v1/blocks[/:start_height]` | Up to 15 blocks from `start_height` (the block table's top without it) down, newest first, each as below | a day when settled (below), else `max-age=1` |
| `GET /api/v1/block/:hash` | One block: `{id, height, version, timestamp, bits, nonce, difficulty, merkle_root, tx_count, size, weight, previousblockhash, mediantime, stale, extras}` | as above |
| `GET /api/v1/block/:hash/summary` | Every transaction in block order: `[{txid, fee, vsize, value, rate}]` | immutable |
| `GET /api/v1/block/:hash/tx/:txid/summary` | That transaction's row | immutable |
| `GET /api/v1/blocks/tip/height` | `/api/blocks/tip/height`'s answer, sharing its calls and its one-second cache | as that route |

**Where each part comes from.** The header fields are the node's Esplora block JSON. `extras` come from the block table's row ([`STORE.md`](STORE.md#blocks)) and the block's audit ([Block audits](#block-audits)); they never cost a node call. The summaries come from the same cached block listing as `/app/block/:hash/txs` ([`FRONTEND.md`](FRONTEND.md#block-summaries)): `/block/:hash/txs/summary` where the node serves it, else `getblock` at verbosity 2 ([`RBITCOIN.md`](RBITCOIN.md#listing-a-blocks-transactions)).

`extras`, in the reference's order:

| Field | Here |
|---|---|
| `reward`, `totalFees` | The coinbase's outputs summed, and the block's fees, in sats |
| `coinbaseRaw`, `coinbaseSignatureAscii` | The coinbase input's script as hex, and as one Latin-1 character per byte. Chain data, serialized as JSON strings |
| `medianFee`, `feeRange` | Our size-weighted fee-rate percentiles (lowest, 10th, 25th, 50th, 75th, 90th, highest) to three decimals; `medianFee` is the 50th. `null` until the block is rated |
| `avgFee`, `avgFeeRate` | Fees over the paying transactions; fees over their weight / 4, three decimals |
| `virtualSize` | Weight / 4 |
| `coinbaseAddress`, `coinbaseAddresses`, `coinbaseSignature` | The coinbase's paying outputs as addresses, the first of them, and the first output's script assembly |
| `header` | The 80-byte header as hex, rebuilt from Esplora's fields and checked against the block's id |
| `pool` | `{id, name, slug, minerNames: null}` by the rules in [Who mined a block](#who-mined-a-block) |
| `matchRate`, `expectedFees`, `expectedWeight` | The block's audit; `null` when we did not watch it arrive |
| `feePercentiles`, `utxoSetSize`, `totalInputAmt`, `firstSeen` | `null`, as on the reference |

`stale` is always `false`: only a block on the best chain has a row. In the summaries, `vsize` is weight / 4, unrounded, and `rate` is the fee over the node's vsize in whole vbytes (weight / 4 rounded up), as the reference rates a transaction on its own; the coinbase's `fee` and `rate` are `0`.

#### What the table does not hold yet

The backfill fills the table newest first ([`STORE.md`](STORE.md#backfill)), so on a fresh install older blocks have no row for a while. A client never gets a hole or a block without its extras:

- **A list is the run of stored rows from its start down,** cut at the first height the backfill has not reached. `X-Data-From-Height` and `X-Data-From-Time` name its lowest block and `X-Data-Complete` is `true` when it holds all 15, or every block down to genesis ([Coverage](#coverage)).
- **A start height or block without a row** is `404 {"error": "block not indexed yet"}`.
- **A block the table has yet to follow:** a start height between the table's top and the node's tip, or the node's new best block while the table still holds the one it replaced, is `503 not ready yet; retry` with `Retry-After: 1`. The table follows each new tip within about a second.
- **A block that left the best chain** is `404 {"error": "block is not on the best chain"}`.
- **A start height past the node's tip** is `[]`, as on the reference. The node's tip height is asked through `/api/blocks/tip/height`'s one-second cache, so this costs at most one call a second.
- **Rows without fee rates** (rated within `BACKFILL_FEE_RATE_DEPTH`, a year by default, and never below it) have `medianFee` and `feeRange` `null`, never `0`.
- Without a block table (`DATA_DIR` unset) the three block routes answer `503 block extras need a block table on this server`; the summaries still work.

#### Caching and reorgs

An answer is computed once per write to the table or the audits and kept in memory until the next ([Answers kept in memory](#answers-kept-in-memory)), so a list never holds a block the table has replaced: once `follow` repairs a reorg, the next answer has the new block. The table's top is read again after the rows; if it moved meanwhile, the answer is `503 not ready yet; retry` rather than rows from one chain under the tip of another. `X-Bitcoin-Chain-Tip` names the table's top, the newest block the answer can include. An answer is **settled** when every block in it is buried under at least 100 more (below `follow`'s zone, where rows are no longer rewritten), is rated, and the list is complete; it is then `public, max-age=86400`. Not `immutable`: a release with a new pool list can name a block's miner differently. Everything else is `max-age=1`. The summaries are fixed by the block's hash and immutable, as `/app/block/:hash/txs`.

#### Differences from the reference

| Field or route | Here | Why |
|---|---|---|
| `orphans`, `utxoSetChange`, `avgTxSize`, `totalInputs`, `totalOutputs`, `totalOutputAmt`, `segwitTotalTxs`, `segwitTotalSize`, `segwitTotalWeight`, `coinbaseBip54`, `similarity` | Absent | The table does not hold them and asking the node per block would cost a `getblockstats` or a `getblock` per request. Absent rather than `null` or `[]`, so a client cannot read them as zero or as "no orphans" |
| `medianFee`, `feeRange` | Our percentiles of each transaction's own rate, weighted by virtual size, three decimals | Another method: the reference's are close in the middle (2.126 against 2.131) and apart at the low end (0.151 against 1.012), where it rates packages together. On older blocks it gave whole numbers (`[0, 1, 1, 1, 2, 3, 217]`) |
| `feePercentiles`, `utxoSetSize`, `totalInputAmt`, `medianFeeAmt` on older blocks | `null`, and `medianFeeAmt` absent | The reference filled these for blocks indexed under an older release (at 974,000) and left them `null` for recent ones. The node has no `gettxoutsetinfo` and the table no input totals |
| `avgFeeRate` | Three decimals | The reference's is a whole number (1 for 1.77) |
| `matchRate`, `expectedFees`, `expectedWeight` | Our audit's score | The reference audits by its own method ([Block audits](#block-audits)) |
| `coinbaseAddresses` | At most the first 8 paying outputs | The table keeps at most 8 payout scripts ([`STORE.md`](STORE.md#blocks)); the reference listed all 17 of one block's |
| `pool` | The list's id, name and slug; `minerNames` always `null` | As the mining routes ([Differences](#differences-from-the-reference-2)): other ids, `SecPool` for `SECPOOL`, `oceanxyz` for `ocean`. The reference names OCEAN's miners from their tags; we do not |
| `firstSeen` | `null` | The reference gave `null` too |
| `stale` | Always `false` | A block off the best chain is a `404` here |
| Holes and unrated rows | Cut lists, `404` and `null` fee fields, with the coverage headers | Not on the reference, whose history is complete |

Side by side on mainnet (2026-11-12, tip 975,545; the tip list, the list from 974,000, block 975,541's summary and one recent full block, compared field by field): every header field, `reward`, `totalFees`, `avgFee`, the coinbase fields, `header` and `virtualSize` were identical in every block; the differences are the rows above. The summary had the same 2,077 transactions in the same order with the same `fee`, `vsize` and `value`; `rate` differed only for the 145 transactions the reference rated as packages.
| Summary `time` | Absent | The reference adds when it first saw a transaction, for some; we keep accept times only for an audit's listed transactions |
| Summary `flags` | Absent | The reference's bit field of transaction features (script types, RBF and the like) needs every input's previous output, which neither block listing gives (`getblock` at verbosity 2 or the summary route). A `0` would claim none |
| Summary `rate` | The transaction's own rate | The reference gives a transaction mined with its ancestors or descendants their package's rate (three transactions at 16.861 where their own were 5.34, 6.00 and 33.10). In one mainnet block, 1,931 of 2,076 rates were equal and the other 145 were such packages |
| `tx/:txid/summary` of a txid not in the block | `404 {"error": "transaction not found in this block"}` | The reference answers `404` too |

#### Cost

A request never fetches a block for `extras`. Headers are kept by hash in memory (up to 4,096 per network; a hash fixes its header), so a block costs one Esplora request the first time any of these routes shows it, and none after: a list of 15 not seen before is two `/blocks/:height` pages of ten, and the tip list costs one page per new block. Identical requests in flight share one call, with the `/api` pass-through. A table that is behind a reorg is asked for that block by hash. Explaining a missing row costs one `/block/:hash` and, where the table holds another block at that height, one `/block/:hash/status`.

Measured on mainnet through a synced node over a private network (release build, a table of 3,401 rows, `curl` on the same machine; server time from the request log):

| Route | First | Then | Node calls the first time |
|---|---|---|---|
| `blocks/:height` | 22.6 ms | 0.3 ms | two `/blocks/:height` |
| `blocks` (tip) | | 0.35 ms | one `/blocks/:height` per new block |
| `block/:hash` | 16.7 ms | 0.19 ms | one `/block/:hash` |
| `block/:hash/summary` (2,300 transactions, 370 KB) | 2.28 s | 0.64 ms | one `getblock` |
| `block/:hash/summary` (1,796 to 3,806 transactions, 245 to 522 KB), measured later on a node with the listing route | 39 to 64 ms; through `getblock` on the same node, 653 to 851 ms | 0.8 to 1.5 ms | the listing: three Esplora calls, or one `getblock` |
| `block/:hash/summary` (4,000 transactions, 636 KB) | | 1.15 ms | |
| `block/:hash/tx/:txid/summary` | as the summary | 0.02 ms | none once the summary is cached |
| `blocks/tip/height` | 12.7 ms | 0.02 ms | one `/blocks/tip/height` a second at most |

The table's part is a `top`, a `page` of 15 or a `by_hash`, and one audit read: on a 975,000-row table (`read_benchmark`, [`STORE.md`](STORE.md#reading)), 0.11 to 0.17 ms for the newest page of 15, 0.09 to 0.24 ms for one deep in history and 0.03 to 0.09 ms by hash, so a full table adds about 0.1 ms to the times above.

The summaries share the block summary cache and its limits ([`FRONTEND.md`](FRONTEND.md#block-summaries)): a block in the cache costs nothing, and one that is not costs one block listing (the summary route and two small Esplora calls, or a `getblock` at verbosity 2 on a node without the route), counted under the same per-network and per-client limits as `/app/block/:hash/txs`. Asking for a block's summary, any of its transactions' rows and its records costs one listing in all. A cache entry now also holds each transaction's txid and weight, 36 bytes more per transaction.

### Mining

Who mined each block, each pool's share, the network's hashrate and difficulty over time, and the block fee, reward, fee-rate and size series, all from the block table ([`STORE.md`](STORE.md#blocks)), never from the node. They need `DATA_DIR`; without a table every route answers `503`. Code: `crates/engine/src/mining/` for the pool list, attribution and hashrate arithmetic, `crates/engine/src/blocks/mining.rs` for the table's statements, `crates/server/src/mining.rs` for the routes and their cache.

| Route | Answer | Cached |
|---|---|---|
| `GET /api/v1/mining/pools` | `[{name, slug, unique_id}]`, `Unknown` (id 0) first | yes |
| `GET /api/v1/mining/pools/:interval` | `{pools: [{poolId, name, link, blockCount, rank, emptyBlocks, slug, avgMatchRate, avgFeeDelta, poolUniqueId}], blockCount, lastEstimatedHashrate, lastEstimatedHashrate3d, lastEstimatedHashrate1w}`, most blocks first | yes |
| `GET /api/v1/mining/pool/:slug` | `{pool: {id, name, link, addresses, regexes, slug, unique_id}, blockCount: {all, 24h, 1w}, blockShare: {…}, estimatedHashrate, reportedHashrate, avgBlockHealth, totalReward}` | yes |
| `GET /api/v1/mining/pool/:slug/hashrate` | `[{timestamp, avgHashrate, share, poolName}]`, one a week | yes |
| `GET /api/v1/mining/pool/:slug/blocks[/:height]` | Up to 100 of the pool's blocks strictly below `:height` (from the tip without it), newest first, with `extras` | no: one indexed read |
| `GET /api/v1/mining/hashrate[/:interval]` | `{hashrates: [{timestamp, avgHashrate}], difficulty: [{time, height, difficulty, adjustment}], currentHashrate, currentDifficulty}`; no interval is `all` | yes |
| `GET /api/v1/mining/hashrate/pools[/:interval]` | `[{timestamp, avgHashrate, share, poolName}]`, every pool with a block that week, most blocks first | yes |
| `GET /api/v1/mining/difficulty-adjustments[/:interval]` | `[[time, height, difficulty, adjustment]]`, newest first, the ratio to five decimals | yes |
| `GET /api/v1/mining/reward-stats/:count` | `{startBlock, endBlock, totalReward, totalFee, totalTx}` over the last `count` blocks (1 to 52,560), totals as strings | no: one range sum |
| `GET /api/v1/mining/blocks/fees/:interval` | `[{avgHeight, timestamp, avgFees}]` | yes |
| `GET /api/v1/mining/blocks/rewards/:interval` | `[{avgHeight, timestamp, avgRewards}]` | yes |
| `GET /api/v1/mining/blocks/fee-rates/:interval[/precise]` | `[{avgHeight, timestamp, avgFee_0, avgFee_10, avgFee_25, avgFee_50, avgFee_75, avgFee_90, avgFee_100}]` in sat/vB: whole numbers, or three decimals with `/precise` | yes |
| `GET /api/v1/mining/blocks/sizes-weights/:interval` | `{sizes: [{avgHeight, timestamp, avgSize}], weights: [{avgHeight, timestamp, avgWeight}]}` | yes |
| `GET /api/v1/mining/blocks/timestamp/:timestamp` | `{height, hash, timestamp}`: the newest block stamped at or before a Unix time, its time as ISO 8601 | no: one indexed read |

Hashrates are whole hashes a second and can pass 2⁶⁴ (mainnet's is about 9.5 × 10²⁰), so they are written as integers of up to 39 digits, as the reference writes them. Read them as floating point.

#### Parameters

- **Intervals** are exactly `24h`, `3d`, `1w`, `1m` (30 days), `3m`, `6m`, `1y` (365 days), `2y`, `3y` or `all`, counted back from now. Anything else is `400 invalid interval`.
- **Slugs** are looked up in the list; an unknown one is `404`. **Heights, counts and timestamps** are decimal digits only (`400` otherwise); `reward-stats` takes 1 to 52,560.
- **Points.** The block series average this many blocks a point, so no answer holds more than about a thousand: one up to `1w`, then 6 (`1m`), 18, 36, 72 (`1y`), 144, 216 and 1,008 (`all`), grouped by height. `avgHeight` is the middle height of a point and `timestamp` the middle of its blocks' times. The hashrate chart has a point a day up to `1y` and a week (Monday 00:00 UTC) beyond; the per-pool shares are weekly.

#### Coverage

The table is only as complete as the backfill ([`STORE.md`](STORE.md#backfill)), and on a fresh install it is still filling in, newest first. Every answer rests only on the run of rows from the tip down to the first missing height; rows below a gap are left out, so a chart never shows a hole as a dip. Three headers say how far an answer reaches, exposed to cross-origin callers like the chain-tip headers:

| Header | Value |
|---|---|
| `X-Data-From-Height`, `X-Data-From-Time` | The earliest block the answer includes, and its timestamp (Unix seconds). Absent when it includes none |
| `X-Data-Complete` | `true` when the answer covers the whole period asked for: the stored history begins before the period does (with the genesis block for `all`, a pool's statistics and its blocks); `false` otherwise |

A chart can then say "data from … onward" instead of drawing a false zero. Fee rates exist only for rated rows, the last year by default: a fee-rate point appears only when every block in it is rated, so an average of some is never presented as the whole, and a gap leaves `X-Data-Complete` `false`. A timestamp before the stored history is `404` (`no indexed block at or before that time`) rather than a wrong block. `reward-stats` starts at the stored history when asked for more (`startBlock` says where).

#### Who mined a block

**The list.** `crates/engine/data/pools/pool-list.json` is [bitcoin-data/mining-pools](https://github.com/bitcoin-data/mining-pools)' generated list (149 pools, 174 tags, 201 addresses), copied unchanged from the `generated` branch at commit `0158b59` (2026-06-30). Its licence is MIT, read in its `LICENSE` file: copyright btc.com (2019–2021), whose list it forked, and 0xB10C and contributors since. MIT allows redistribution in this MIT project on the one condition that the notice travels with it, so `LICENSE` and a `README.md` naming the source and commit sit beside the file. mempool.space's own pool list was not used or opened. Pool ids are the list's; slugs are each name's ASCII letters and digits, lowercased.

**The rules,** in order (`Pools::attribute`):

1. **A payout to a pool's listed address wins.** Only the pool holds that address's key; anyone can write any tag. A block tagged for one pool that pays another's address is the other's. Among several payouts, the first in output order decides.
2. **Otherwise the coinbase tag:** the longest listed tag found anywhere in the coinbase script, ignoring ASCII case. Longest first, so a tag that contains another (`/ViaBTC/TATMAS Pool/` holds `/ViaBTC/`, `/solo.ckpool.org/` holds `ckpool`) wins over it. At equal length, the one earlier in the script, then the lower id.
3. **Otherwise `Unknown`** (id 0), counted and ranked like any pool, never dropped.

A tag is a claim without proof: a block that writes a pool's tag and pays an address not on the list is that pool's. Pools move payout addresses more often than lists follow (in the sample below, 3,615 of the 3,883 blocks attributed by tag belong to pools whose listed addresses they did not pay), so refusing would turn most of them into `Unknown`.

**Hostile input.** The tag and payout scripts are written by whoever mined the block and are stored bounded (at most 100 bytes, eight scripts of 128): matching is a byte comparison of at most 174 tags of at most 30 bytes over 100 bytes and eight map lookups, allocates nothing per block and cannot panic. Invalid UTF-8 is just bytes. Names, tags and addresses in answers are the list's; the only chain bytes in an answer are a pool block's coinbase, as hex and as one Latin-1 character per byte, serialized as JSON strings. The private block facts (`/app/block/:hash/summary`, [`FRONTEND.md`](FRONTEND.md#block-summaries)) name each block's miner by the same rules, as the list's name and slug only.

**Stored, not computed per request.** The block table keeps each row's pool (`pool` column, [`STORE.md`](STORE.md#blocks)), set when the row is written. Measured on a 975,000-row table: counting blocks per pool over all of history takes 0.2 s from the column, while attributing at query time means reading and matching every coinbase, 1.8 s, past the store's 2 s read limit under any load. Writing costs 2 µs a row more. The table records which list and rules (`pool_list.version`, a hash of the file and a rules number) its rows were attributed with; when a build ships another list, the first start redoes every row in batches of 10,000 (1.8 s for 975,000 rows, no node call) before the mining routes answer.

**Quality,** over a bounded mainnet sample of 7,851 blocks (heights 967,676 to 975,526, 54 days): 99.69 % identified, 3,944 by address and 3,883 by tag; 24 `Unknown` (blocks with no readable tag, a `j://<uuid>` tag, or `Sv2/MARA`). No block in the sample had a tag and an address naming different listed pools. For the same week the reference ranked 895 blocks and so did we; 891 were attributed alike. The 4 others carry the tag `/trustpool/` but pay ViaBTC's listed address: the reference says TrustPool, we say ViaBTC by rule 1, and the list has no TrustPool. Two pools are named differently from the reference's list: `Ocean.xyz` (`oceanxyz`, theirs `ocean`) and `BTC.com` (`btccom`, theirs `cloverpool`).

#### Hashrate

A block at difficulty *d* takes *d* × 2³² hashes on average, so the hashrate over a stretch of chain is the work of its blocks over the time they took: the sum of their difficulties × 2³², divided by the seconds from the last block before them to the last of them. This is the estimate `getnetworkhashps` makes.

- **Daily points use the trailing 7 days.** A day's ~144 blocks vary by ±8 % from luck alone; a week's 1,008 by ±3 %, and a change still shows within days. A point appears only when its whole window is stored. Weekly points use the week itself.
- `currentHashrate` and `lastEstimatedHashrate1w` are the last 1,008 blocks; `lastEstimatedHashrate` 144 and `lastEstimatedHashrate3d` 432. A pool's `estimatedHashrate` is its share of the last 24 hours' blocks times the network's hashrate over them; its weekly `avgHashrate` is its share of the week times the week's.
- **Against the node:** on mainnet, `getnetworkhashps 1008` gave 9.51382 × 10²⁰ and ours 9.51368 × 10²⁰; over 144 blocks 9.47105 × 10²⁰ and 9.47091 × 10²⁰ (the node times from the earliest timestamp in the window rather than the block before it). The node's value does not fit a `u64` either, and asking it would be a node call per request; ours is computed from the table.
- **Against the reference:** `currentHashrate` within 0.3 % (its window is not stated). Its daily points move 9 % from day to day on average, ours 1.2 %: it uses one day per point.
- **Retargets** come from the table: the first block of each 2,016-block period against the first of the period before (on testnet4 the last block of a period may be a minimum-difficulty one), both inside the stored history. Identical to the reference for the month compared.

#### Differences from the reference

| Field or route | Here | Why |
|---|---|---|
| `poolId`, `poolUniqueId`, `unique_id`, `pool.id` | All the list's id | The reference numbers its own database rows; we have one id |
| `regexes` | The list's tags, matched as literal text | The list has tags, not patterns |
| `avgMatchRate`, `avgBlockHealth` | The mean match rate of the pool's audited blocks, two decimals: in the period for `avgMatchRate`, in the whole stored history for `avgBlockHealth`; `null` when it has none | Only blocks this server watched arrive are audited ([Block health](#block-health)). The reference answers `null` for a pool with no audited block too |
| `avgFeeDelta`, `reportedHashrate`, `minerNames` | `null` | The reference's fee delta is a string whose unit we could not tell from its answers; no pool reports hashrate to us |
| `USD` in the fee and reward series | Absent | No price feed yet (M3). The reference leaves it out the same way on a network without prices (observed on mempool.space's signet) |
| Block series points | A fixed number of blocks a point (above) | The reference merges blocks mined close together into one point (its 715 points for a week's 895 blocks); where its point is one block, the values are equal |
| `avgFee_*` (whole numbers) | Our size-weighted percentiles, rounded | rbitcoin's sub-sat rates round to `0`; use `/precise` |
| Pool blocks | `id`, `height`, `timestamp`, `difficulty`, `tx_count`, `size`, `weight`, and `extras` with `totalFees`, `medianFee`, `feeRange`, `reward`, `pool`, `avgFee`, `avgFeeRate`, `coinbaseRaw`, `coinbaseAddress`, `coinbaseAddresses`, `coinbaseSignature` (the first payout script's assembly) and `coinbaseSignatureAscii` | The block table holds no header fields (version, bits, nonce, merkle root, previous hash, median time) and no per-transaction totals; asking the node would be a call per request. `medianFee` and `feeRange` are `null` until the block is rated, with three decimals |
| `blocks/timestamp` | At or before the time | The reference answered the same way, not with the nearest block |
| Coverage | `X-Data-*` headers | Not on the reference, whose history is complete |

#### Block health

`avgMatchRate` (`/pools/:interval`) and `avgBlockHealth` (`/pool/:slug`) are the mean of the match rates ([Block audits](#block-audits)) of the pool's audited blocks: in the period asked for, or for `avgBlockHealth` in everything the table holds. Only best-chain blocks count: an audited block that a reorg replaced counts for nobody, as in the audit pages. Two decimals, as the reference writes them.

**What it covers.** A block is audited only when this server watched it arrive with the mempool engine on and a projection ready ([Block audits](#block-audits)); audits cannot be made afterwards. So the average covers the blocks since the server first ran with the engine, less any it missed, which for most pools and most periods is a small part of their blocks: a pool with two blocks audited out of hundreds gets the mean of those two. The reference's shape has no place for the count, so the answer cannot say it. A pool with no audited block in the period answers `null`, as the reference answers for one (`avgBlockHealth` of a pool whose blocks all predate its audits), never `0` or `100`. To weigh the figure, count the pool's audited blocks: `/api/v1/mining/blocks/audit/scores` and `/predictions/:interval` list every audited block by height and time, and `/pool/:slug/blocks` lists the pool's heights.

**Cost.** One grouped read over the audits table joined to the block table by height and hash, done with each answer's other reads and cached with it: the audits table holds one row per block watched (about 52,000 a year), so it adds well under a millisecond to a computation and nothing to a request.

#### Freshness and cost

An answer is computed once per change to the table and served from memory. A task per network recomputes the answers clients have asked for whenever `follow` writes a new block, at most once a minute while the backfill adds rows, and at least every 10 minutes even without either, so a day's answer drops blocks older than a day; between those, a request is a lookup. An answer's reads are separate statements, so one whose chain tip changed while it was read is thrown away (a request then gets `503` and retries; the refresh starts over at the new tip), never published with blocks from two chains. An answer nobody has asked for is computed by the first request, one computation at a time per network. A pool's statistics and weekly shares are computed for every pool together, and an interval's five block series (fees, rewards, fee rates whole and precise, sizes and weights) together. Over long periods the reads add up the block table's running totals rather than its rows ([`STORE.md`](STORE.md#totals)), so their cost does not grow with the table; within one refresh, answers that need the same network hashrate points or weekly pool counts read them once. The routes marked "no" above are a single bounded indexed read each. Headers as for every `/api/v1` route; `Age` appears while the node's tip is not the one the answer was computed at.

Measured on the Apple M4 under the load described in [`STORE.md`](STORE.md#measurements), release build, from `curl` on the same machine. The reference backend (a stock mempool backend in front of the same node) was asked once per route, over the network; the pool routes for Foundry USA.

| Route | Reference | Ours, 7,851 mainnet rows: first / then | Ours, 975,000 rows before the totals: first / then | Mainnet's 975,672 rows with the totals: first |
|---|---|---|---|---|
| `pools` | 0.09 s | 0.8 / 0.4 ms | | 0.7 ms |
| `pools/1w` | 23.7 s | 1.2 / 0.3 ms | 1.4 / 0.4 ms | 0.5 ms |
| `pools/all` | | 2.0 / 0.3 ms | 222 / 0.5 ms | 2.8 ms |
| `pool/:slug` | 54.2 s | 7.1 / 0.4 ms | 999 / 0.3 ms (every pool's at once) | 14.6 ms (every pool's at once) |
| `pool/:slug/hashrate` | 24.0 s | 0.5 / 0.4 ms (computed with the above) | 0.5 / 0.5 ms | (computed with the above) |
| `pool/:slug/blocks` | 13.9 s | 0.9 ms | 0.9 ms |  |
| `hashrate/1m` | 23.4 s | 3.4 / 0.4 ms | 4.1 / 0.4 ms | 0.3 ms |
| `hashrate/all` | | 4.0 / 0.3 ms | 597 / 0.4 ms | 6.5 ms |
| `hashrate/pools/1m` | 24.4 s | 3.2 / 0.3 ms | 3.6 / 0.3 ms | 0.2 ms |
| `hashrate/pools/all` | | | 836 / 1.8 ms (2 MB) | 8.9 ms |
| `difficulty-adjustments/1m` | 0.01 s | 0.8 / 0.3 ms | 0.7 / 0.4 ms | 0.07 ms |
| `reward-stats/144` | 0.08 s | 0.7 ms | 0.6 ms; 31 ms for 52,560 |  |
| `blocks/fees/1w` | 23.9 s | 1.4 / 0.4 ms | 1.6 / 0.5 ms | 1.5 ms (all five series of the week) |
| `blocks/fees/all` | | | 565 / 0.5 ms | 0.9 ms (all five series) |
| `blocks/rewards/1w` | 23.9 s | 1.6 / 0.5 ms | 1.7 / 0.4 ms | (with fees) |
| `blocks/fee-rates/1w` | 23.9 s | 1.5 / 0.4 ms | 1.7 / 0.5 ms | (with fees) |
| `blocks/fee-rates/all/precise` | 404 | | 591 / 0.4 ms | (with fees) |
| `blocks/sizes-weights/1w` | 24.0 s | 1.6 / 0.4 ms | 68 / 1.2 ms (a busy moment) | (with fees) |
| `blocks/sizes-weights/all` | | | 560 / 0.6 ms | (with fees) |
| `blocks/timestamp/:t` | 0.02 s | 0.6 ms | 0.4 ms |  |

The 975,000-row table is synthetic (realistic sizes, the list's tags, the last year rated): `MINING_BENCH_DIR=<dir> cargo test --release -p engine -- --ignored --nocapture mining_benchmark` fills it and times the statements; the server then runs over it as regtest with no reachable node. The last column is each answer's first computation, without HTTP, on a copy of a synced mainnet store with its totals filled: `MINING_BENCH_DIR=<dir> MINING_BENCH_NET=mainnet cargo test --release -p rbitcoin-space -- --ignored --nocapture answers_benchmark`, which also times a new block's refresh of every answer. With every route and interval asked for, that refresh took 9.5 to 11.3 s before the totals and 47 to 53 ms with them ([`PERFORMANCE.md`](PERFORMANCE.md#6-reads-that-grew-with-the-block-table-done)).

### Block audits

How each block we watched arrive compared with the block we expected on its parent: the method, the categories and the score are in [`MEMPOOL.md`](MEMPOOL.md#block-audits), the table in [`STORE.md`](STORE.md#audits). Code: `crates/engine/src/audit/` for the comparison and its statements, `crates/server/src/audits.rs` for the routes. They need `DATA_DIR`; without a table every route answers `503 block audits need a block table on this server`. Shapes observed on mempool.space's public API, the reference backend having audits off; never from its code.

| Route | Answer | Cache |
|---|---|---|
| `GET /api/v1/mining/blocks/audit/score/:hash` | `{hash, matchRate, expectedFees, expectedWeight}` | immutable |
| `GET /api/v1/mining/blocks/audit/scores[/:height]` | The same for the 16 heights ending at `:height` (the block table's top without it), lowest first; heights without an audit, or whose audit is of a block no longer on the best chain, are left out | 1 s |
| `GET /api/v1/mining/blocks/predictions/:interval` | `[[timestamp, height, matchRate]]`, lowest height first: the audited best-chain blocks stamped within the interval (`24h` … `all`, as the mining routes) | 1 s |
| `GET /api/v1/mining/blocks/audit/:hash`, `GET /api/v1/block/:hash/audit-summary` | `{height, id, timestamp, unseenTxs, missingTxs, addedTxs, freshTxs, displacedTxs, conflictedTxs, listsComplete, matchRate, expectedFees, expectedWeight}`, the lists as txids | immutable |
| `GET /api/v1/block/:hash/tx/:txid/audit` | `{seen, expected, added, prioritized, conflict, accelerated, firstSeen}`, `firstSeen` only when known | immutable |

`matchRate` is our score in percent, two decimals, rounded down. `expectedFees` and `expectedWeight` are our expected block's total base fees (sats) and raw weight. A block with no audit is `404 audit not available`: it arrived while the server was not watching, before it had a projection, or from a projection that was stale or for another block. Every answer that exists is fixed, so it is cached for good; a `404` is not, though it never turns into an audit later. An answer is one indexed read, made once per write to the audits or the block table and kept in memory until the next ([Answers kept in memory](#answers-kept-in-memory)), `predictions` excepted; none asks the node.

#### Differences from the reference

| Field or route | Here | Why |
|---|---|---|
| No audit | `404 {"error": "audit not available"}` on every route | The reference answers a block without an audit with `200` and the JSON string `"null"` on `score/:hash`, and `404 Audit not available` on the summary. One honest status everywhere |
| `template`, `version`, `templateAlgorithm` | Absent | We keep our expected block's totals and the transactions that differ from the mined block, not the whole template (a full one would be 135 KB a block) |
| `missingTxs` | Only those our score counts against the miner (`missing`) | The left-out transactions we excuse are in `freshTxs`, `conflictedTxs` and our own `displacedTxs` |
| `freshTxs` | Expected, left out, and accepted within 60 s of the block | On the reference the list also held transactions that were mined |
| `addedTxs`, `unseenTxs` | Mined and not expected: in our projection for a later block, or not in it at all | Same meaning as far as observed |
| `displacedTxs`, `conflictedTxs`, `listsComplete` | Added | Our categories with no field of theirs to put them in. `listsComplete` is `false` when the lists were capped at 1,000 transactions |
| `prioritizedTxs`, `sigopTxs`, `fullrbfTxs`, `acceleratedTxs` | Absent | We cannot detect them (no signal reaches us, we count no sigops, rbitcoin is always full-RBF). An empty list would claim there were none |
| Per transaction: `added` | `true` for a transaction mined and not expected | The reference answered `false` for members of its own `addedTxs` list; its meaning was not observable |
| Per transaction: `prioritized`, `accelerated` | Always `false` | As above |
| Per transaction: a txid in none of the lists | Answered as matched: `seen` and `expected` `true` | We keep only the lists. Like the reference, the route does not check that the transaction is in the block |
| `scores` without a height | The 16 heights ending at the block table's top | Same as the reference |
| `predictions` with an unknown interval | `400 invalid interval` | The reference answered every audit it had |

### Mempool statistics

The mempool through time, from the history table ([`STORE.md`](STORE.md#mempool_history)), never from the node: a sample a minute while the mempool engine runs, rolled into hours after 8 days and days after 400. It needs `DATA_DIR`; without a store both routes answer `503` `mempool history needs a data directory on this server`. With the engine off they serve whatever was stored before. Code: `crates/engine/src/history/` for sampling, storage and the query, `crates/server/src/statistics.rs` for the routes.

| Route | Answer |
|---|---|
| `GET /api/v1/statistics/:interval` | `[{added, count, vbytes_per_second, mempool_byte_weight, total_fee, min_fee, vsizes}]`, newest first, the reference's shape (below) |
| `GET /app/mempool/history/:interval` | Our own shape for our chart, with our bands and the flow ([`FRONTEND.md`](FRONTEND.md#mempool-history)). A point's `bands` is 12 numbers, or 10 when its lowest band's split was not recorded ([`STORE.md`](STORE.md#fee-bands)) |

Each new sample is also pushed as `live-2h-chart` on `/api/v1/ws`, serialized by the same function as a `/statistics/2h` point, and its inflow is that socket's `vBytesPerSecond` ([`WS.md`](WS.md#what-the-server-sends)).

**Intervals** are exactly `2h`, `24h`, `1w`, `1m` (30 days), `3m`, `6m`, `1y` (365 days), `2y`, `3y`, `4y` or `all`; anything else is `400 invalid interval`. The reference answered `2h`, `24h`, `1w`, `1m`, `1y`, `3y` and `all` and refused `5h` (the others were not asked). Each has a fixed step, so no answer holds more than 1,460 points, and a point never mixes rows coarser than itself:

| Interval | `2h` | `24h` | `1w` | `1m` | `3m` | `6m` | `1y` | `2y`, `3y` | `4y` | `all` |
|---|---|---|---|---|---|---|---|---|---|---|
| A point | 1 min | 1 min | 10 min | 1 h | 2 h | 4 h | 8 h | 1 day | 2 days | whole days, at most about 1,000 points from the first sample |
| Points | 120 | 1,440 | 1,008 | 720 | 1,080 | 1,080 | 1,095 | 730, 1,095 | 730 | |

Points are aligned to multiples of the step in UTC (Unix time), and the period starts at the first whole step after now less the interval, so the newest point is the step in progress. A point is the mean of the minutes sampled in it; a step with none has no point.

**Fields,** observed on the reference backend and computed by us:

| Field | Here |
|---|---|
| `added` | The point's start, Unix seconds (the reference stamps the second it sampled) |
| `count` | Mean transactions in the mempool |
| `vbytes_per_second` | Mean virtual size entering per second: what entered over a minute, over 60 |
| `mempool_byte_weight` | Four times the mean virtual size. The reference's equals four times its `vsizes` summed, at every point checked. `2h` and `24h` only, as on the reference |
| `total_fee` | Mean fees in the mempool, sats. `2h` and `24h` only, as on the reference |
| `min_fee` | Mean `mempoolminfee`, sat/vB |
| `vsizes` | 39 numbers: mean virtual size per fee range (below) |

Whole numbers are written as integers and means to three decimals, as the reference writes its long intervals' averages.

**The fee ranges.** The reference's `vsizes` are 39 whole-sat/vB ranges, read from its answers: they open `[0, 1)`, `[1, 2)`, `[2, 3)`, `[3, 4)`, `[4, 5)`, `[5, 6)`, `[6, 8)`, `[8, 10)`, `[10, 12)`, and widen from there. We keep the design's 12 bands ([`DESIGN.md`](DESIGN.md#fee-scale)), with eight of their eleven edges at 2 sat/vB or under. Each band goes whole to the range that holds its lower edge:

| Our bands (sat/vB) | Range |
|---|---|
| under 0.12, 0.12–0.15, 0.15–0.2, 0.2–0.3, 0.3–0.5, 0.5–1 | `[0, 1)`, index 0 |
| 1–1.5, 1.5–2 | `[1, 2)`, index 1 |
| 2–3 | `[2, 3)`, index 2 |
| 3–5 | `[3, 4)`, index 3 |
| 5–10 | `[5, 6)`, index 5 |
| 10 and up | `[10, 12)`, index 8 |

Every other range reads 0. So the virtual size at or above 1, 2, 3, 5 and 10 sat/vB is exact, the ranges sum to the whole mempool, and nothing is split by a guess; but a chart of the reference's ranges shows the 3-to-5, 5-to-10 and over-10 vbytes at their lowest range. On rbitcoin's mempool that is little: in the reference's own answers for the last day, the vbytes this moves (paying 4 to 5, 6 to 10, or 12 sat/vB and up) were 0.03 % to 0.6 % of the mempool; in a nearly empty mempool (its oldest point, 0.4 MvB) 3.4 %. Ranges under 1 sat/vB, where most of it is, are one range there and six bands here; use `/app` for those. The ranges are summed from the stored bands, whose `band0` is all under 0.2 whether or not its split was recorded ([`STORE.md`](STORE.md#fee-bands)), so a point answers the same before and after the split. A rate is banded as it prints, at two decimals, so 0.996 sat/vB counts in `[1, 2)`; and by its effective rate (its chunk's), as the projected blocks place it.

**Coverage.** History begins when the server first ran with the engine on, and has holes wherever it did not sample ([`STORE.md`](STORE.md#mempool_history) says when). The answer says so in the mining routes' headers ([above](#coverage)):

| Header | Value |
|---|---|
| `X-Data-From-Time` | The time of the earliest point in the answer. Absent when it has none |
| `X-Data-Complete` | `true` when every minute of the period, from its start to the last whole minute, was sampled; `false` otherwise. For `all`, the period starts at the oldest stored row |

`X-Data-From-Height` is never sent, and neither are the chain-tip headers: a sample belongs to a minute, not a block.

**Freshness and cost.** An answer is computed from the store on the first request after a new sample was written or the minute turned, one computation at a time per network, and both shapes of that interval with it; until then a request is a lookup in memory. A computation is one read of at most 15 ms on a table at its ten-year bound ([`STORE.md`](STORE.md#mempool_history)), so eleven intervals cost at most about a tenth of a second of one reader a minute, however many clients ask. `Cache-Control: public, max-age=1`; CORS as for `/api`.

**Against the node and the reference,** mainnet, 2026-11-12, one 20-minute run of the release build with the engine on (75,000 to 77,700 transactions, read-only, no block found in the window), checked each minute against the node's `getmempoolinfo` read 0.3 s after the minute turned, and the `2h` answer then compared with the reference backend's for the same minutes:

- **First sample.** The server started at 09:55, the engine synced in 19 s, the first minute (09:56) was skipped as `syncing` and every minute after was stored: 19 of 19, 09:57 to 10:15.
- **Against the node:** `min_fee` equal at all 19. Count, virtual size and fees equal at 4; at the others we were 1 to 16 transactions (0.02 % at most) behind, with the vsize and fees of those transactions: what arrived between the projection's last update and the minute. The ten bands summed to `vsize` at every sample.
- **Against the reference,** whose samples fall 32 s after ours: over the 18 minutes both had, its `count` was 55 to 104 higher (about 32 s of arrivals at 2.5 a second), `mempool_byte_weight` 0.03 % to 0.1 % higher and `total_fee` 0.5 % to 1.3 % higher, both growing with the mempool over those seconds. `min_fee` equal. `vsizes[0]` (under 1 sat/vB) about 5,600 vB (0.02 %) lower here and `vsizes[1]` 2,400 vB lower to 10,000 vB higher: a rate of 0.995 sat/vB prints as `1.00` and counts at 1 to 2 here, and we band by effective (chunk) rate. `vbytes_per_second` 430 to 1,160 here and 500 to 870 there, minute by minute, and 652 against 667 on average: the same arrivals, counted over minutes that start 32 s apart.
- **Cost.** No node call: the sampler reads the engine's memory and writes about 100 bytes a minute. The routes answered in 2 to 6 ms the first time in a minute (a read and both shapes), and from memory after.

### Transactions

What wallets ask about unconfirmed transactions: was it replaced and by what, what does it really pay given its relatives, when was it first seen, is this address valid, what does this input spend. Code: `crates/server/src/transactions.rs`; the replacement record is `crates/engine/src/replacements/` ([`MEMPOOL.md`](MEMPOOL.md#following-a-transaction)). Shapes observed on the reference backend (`fixtures/api-v1/transactions.json` holds the recorded answers the tests compare against), never read from its code.

| Route | Answer | Node calls | Cache |
|---|---|---|---|
| `GET /api/v1/validate-address/:address` | `{address, isscript, isvalid, iswitness, scriptPubKey[, witness_program, witness_version]}`, or `{"isvalid": false}` | none | 1 day |
| `GET /api/v1/transaction-times?txId[]=…` | First-seen time per txid, Unix seconds, in request order; `0` when unknown | none | 1 s |
| `GET /api/v1/replacements` | The 25 newest replacement trees, newest first | none | 1 s |
| `GET /api/v1/fullrbf/replacements` | The 25 newest trees in which something was replaced without signalling | none | 1 s |
| `GET /api/v1/tx/:txid/rbf` | `{replacements, replaces}`: the tree holding `txid`, and what `txid` itself replaced; each `null` when there is none | none | 1 s |
| `GET /api/v1/cpfp/:txid` | `{ancestors, bestDescendant, descendants, effectiveFeePerVsize, fee, adjustedVsize}`, or `{"ancestors": []}` | none | 1 s |
| `POST /api/v1/prevouts` | For each `{txid, vout}` asked, `{prevout, unconfirmed}` or `null` | one or two Esplora reads per distinct outpoint, under the batch routes' cost limit | `no-store` |

Every route but `validate-address` and `prevouts` answers from the mempool engine's memory and needs it on: with `{NET}_MEMPOOL_ENABLED=false` they answer `503 the mempool engine is off on this server`, and before the tracker's first cycle `503 not ready yet; retry`. `transaction-times` and `cpfp` carry the chain-tip headers of the tracker's last cycle.

**Parameters,** each parsed before any work (rule 2):

| Input | Rule | Refused with |
|---|---|---|
| `:txid` | Exactly 64 hex digits | `400 invalid txid` |
| `txId[]` (also written `txId%5B%5D`) | Exactly 64 hex digits each, at most 100; a txid may repeat and is answered each time. Other query parameters are ignored, as everywhere under `/api/v1`. A request head is at most 16 KiB, so about 200 would not fit anyway | `400 invalid txId`, `400 at most 100 txids`, `431` from the HTTP parser past 16 KiB |
| `:address` | Our own parser, for the network in the URL, at most 128 characters | Never refused: anything that is not an address of this network is `{"isvalid": false}`. A path that is not UTF-8 once percent-decoded is `400` |
| `prevouts` body | A JSON array of `{"txid": <64 hex>, "vout": <u32>}`, no other fields, at most 100 items, at most `MAX_BODY_BYTES` (16 KiB, which holds about 190) | `400 body must be a JSON array of {"txid", "vout"}`, `400 invalid txid`, `400 at most 100 outpoints`, `413 body too large` |

#### Replacement trees

A tree is a replacement and everything it removed, recursively: its root is the newest replacement, each node's `replaces` what that one removed. Built from the replacement record, which keeps the newest `REPLACEMENTS_KEPT` (10,000) replacements and, with a `DATA_DIR`, survives restarts ([`STORE.md`](STORE.md#replacements)).

```json
{"tx": {"txid": "…", "fee": 2000, "vsize": 250, "value": 2001, "rate": 8, "time": 1794485667, "rbf": true, "fullRbf": false, "mined": true},
 "time": 1794485667, "fullRbf": true,
 "replaces": [{"tx": {"txid": "…", "fee": 500, "vsize": 200, "value": 1000, "rate": 2.5, "time": 1794485633, "rbf": false},
               "time": 1794485633, "interval": 34, "fullRbf": true, "replaces": []}],
 "mined": true}
```

| Field | Here |
|---|---|
| `tx.fee`, `tx.value` | Its own base fee and total output value, sats, as the tracker held them |
| `tx.vsize`, `tx.rate` | Weight over four, unrounded, and fee over that, sat/vB, as the reference writes them (`152.25`). A whole value is written as an integer (`125`), as the reference does |
| `tx.time`, `time` | When the node accepted it (its `getmempoolentry` time, so it survives our restarts) |
| `tx.rbf` | It signalled replaceability itself: an input's sequence below `0xfffffffe` (BIP 125). Inherited signalling is not counted |
| `tx.fullRbf` | On a node that replaced something: whether one of the transactions it replaced directly did not signal. Absent on a leaf, as on the reference |
| `fullRbf` | Whether this transaction (unless it is the root) or anything below it was replaced without signalling |
| `interval` | Seconds from this transaction's arrival to the arrival of the one that replaced it. Absent on the root |
| `mined`, `tx.mined` | `true` on the root while it is in a block on the best chain: seen confirmed, or gone straight into a block without our seeing it in the mempool, and kept true through a reorg whose new blocks hold it too. `null` when a reorg took its block away and where it is now is not known yet (the node could not be asked, or one reorg's reads ran out: [`MEMPOOL.md`](MEMPOOL.md#following-a-transaction)); a client reading it as a boolean reads not mined. Absent otherwise |

**`/fullrbf/replacements`** lists the trees whose root `fullRbf` is `true`. rbitcoin replaces whether or not a transaction signals, so on rbitcoin this is a filter on signalling, not on policy: every replacement here is a full-RBF replacement in the policy sense.

#### Differences from the reference

| Field or route | Here | Why |
|---|---|---|
| What a tree lists | Everything the replacement removed, a replaced transaction's descendants included, each as replaced by the root of its step | The tracker sees the descendants leave with their parent and records them with the same replacement ([`MEMPOOL.md`](MEMPOOL.md#why-a-transaction-left)). The reference appears to list only conflicts; not observed with descendants |
| A root the tracker never held | `fee`, `vsize`, `value`, `rate` and `rbf` are `null`, `time` is when we saw the replacement | It was confirmed in the block that removed the original, so we never read it. Rare: a replacement mined within one poll of arriving |
| `tx.rate` | The transaction's own fee over its size | The reference wrote a rate adjusted for unconfirmed ancestors where it had one (24 of 39 compared on mainnet). Ours is the transaction's alone; its effective rate is `/cpfp`'s |
| A miner confirms the transaction we saw replaced | The mined one is the newest end and replaced the other; its figures are `null` | What happened last: the block's transaction pushed out the one in our mempool. The reference keeps "B replaced A" and marks A mined |
| A reorg | A tree's `mined` follows its root to the new chain, `null` while that is not known; a replaced transaction that the new chain confirms leaves its tree | The reference's handling of a reorg was not observed |
| Order of a node's fields | `tx`, `time`, `interval`, `fullRbf`, `replaces`, then `mined` | The reference writes `interval` before `fullRbf` on a leaf and last on a node with children; we use one order |
| History | The newest 10,000 replacements, from when the server first ran with the engine on | Bounded by `REPLACEMENTS_KEPT`. The reference's own retention was not observed |
| `rbf` replaces | What `txid` replaced directly, including descendants that left with them | As above |

#### CPFP

From the projected blocks' copy of the transaction's cluster (the node's own chunks, from `getmempoolcluster`, at most one update behind) and the tracker's records and inputs, as the relatives route ([`FRONTEND.md`](FRONTEND.md#a-transactions-relatives-and-replacements)). A request costs a few hash-map lookups over at most 64 transactions under the engines' read locks, on a blocking thread because a pack can hold the projector's lock for up to about 170 ms on mainnet. It never asks the node.

| Field | Here |
|---|---|
| `ancestors`, `descendants` | Every mempool transaction it spends from or that spends from it, transitively, within its cluster, as `{txid, fee, weight}`, in the cluster's mining order. The reference listed fewer (one ancestor of 24 for one mainnet transaction) |
| `bestDescendant` | The descendant mined last in the transaction's own chunk: the child whose fee lifts it. `null` unless the chunk pays more per vbyte than the transaction alone does, so `null` when nothing lifts it |
| `effectiveFeePerVsize` | The node's own chunk rate: the chunk's fee (with `prioritisetransaction` deltas) over its sigop-adjusted weight over four. This is the rate mining selection uses on rbitcoin, not an estimate from ancestors and descendants |
| `fee` | Its own base fee |
| `adjustedVsize` | Its sigop-adjusted vsize from the node, a whole number. The reference wrote weight over four (`149.25`) |
| `sigops` | Absent: we count no sigops. A client that needs it should treat it as unknown |

Not in the mempool (confirmed, replaced, never seen), or in it but not placed by the projected blocks yet (the second or so after it arrives): `{"ancestors": []}`, as the reference answers confirmed and unknown transactions and the ones it has not processed yet. An invalid txid is `400 invalid txid` where the reference answered `501 Invalid transaction ID`.

#### First-seen times

A time is known for a transaction in the mempool now (the node's accept time, so it survives our restarts), and for a transaction the replacement record holds, replaced or replacement, even after it left the mempool. Everything else is `0`: a transaction that confirmed (the reference also answers `0` for those), one that left for another reason, or one never seen. Times listed in block audits are not looked up: they are stored per block, not by txid. Our times are the node's own, so they read about a second earlier than the reference's, which stamps when it saw the transaction.

#### Address validation

Our own parser for the network in the URL, never the node. The fields are those of rbitcoin's `validateaddress`, in its order: `isscript` is `true` for P2SH, P2WSH, P2TR and pay-to-anchor; `witness_program` and `witness_version` only for a witness address; bech32 comes back in lower case. An address of another network is `{"isvalid": false}`, as on the reference, which also answers that for anything it cannot parse. Equal to the reference's answers byte for byte on the nine mainnet cases recorded (`fixtures/api-v1/transactions.json`).

#### Prevouts

For each outpoint in the body, in order: `{"prevout": <the output>, "unconfirmed": <bool>}`, or `null` when the transaction or the output does not exist. The output has `scriptpubkey`, `scriptpubkey_address` (when the output has an address), `scriptpubkey_asm`, `scriptpubkey_type` and `value`, as Esplora writes them.

**Node work, bounded.** Per distinct outpoint, one Esplora `/tx/:txid/out/:vout` read (confirmed outputs only, a point lookup), skipped when the tracker holds the transaction; when that finds nothing, one `/tx/:txid`, shared by every outpoint of that transaction in the request. So at most 200 reads for the largest body, one at a time. The whole request is one call under the address and batch routes' cost limit ([above](#protection-for-the-node)): it waits for one of the network's four slots, counts against the twelve running or waiting and the client's share, and holds its slot until the node has answered its last read, even after the request timed out. No read starts more than 60 seconds after the batch's first, and each read is abandoned after 60 seconds, so a batch holds its slot two minutes at most; one cut short by that deadline is `504 request timed out`. Identical bodies at the same moment share one run. A read the node fails is `502 upstream unavailable` (`504` on a timeout) for the whole request.

Differences: the reference wrote `"scriptpubkey_address": ""` for an output without an address and put `value` first for a confirmed output; we leave the field out and use one order. No chain-tip headers: the reads may straddle a block.

#### Cost and comparison

Every route but `prevouts` asks the node nothing: a request is a parse and a few hash-map lookups under the engines' read locks (`cpfp` over at most 64 transactions, `transaction-times` over at most 100). The two tree lists are built once per change of the replacement record and kept, so a request between changes copies bytes. The record holds at most `REPLACEMENTS_KEPT` replacements, about 0.3 KB each in memory (3 MB at the default bound); the store holds the same rows at 205 bytes each (2.1 MB, [`STORE.md`](STORE.md#replacements)).

**Against the node and the reference,** mainnet, 2026-11-12, 12:43 to 13:30 UTC: one release build with the engine on (59,000 to 63,000 transactions, read-only, blocks 975,555 and 975,556), then a restart on the final build. Server times are from a client on the same machine; the node is on the LAN.

| Route | First request | Repeated |
|---|---|---|
| `validate-address` | 0.6 ms | 0.25 ms |
| `transaction-times`, 50 txids | 0.3 ms | 0.27 ms |
| `replacements`, `fullrbf/replacements` | 0.3 ms | 0.26 ms |
| `tx/:txid/rbf` | 0.23 ms | 0.21 ms |
| `cpfp` (a 64-transaction cluster) | 0.22 ms | 0.19 ms |
| `prevouts`, 10 mempool outpoints | 60 to 190 ms: ten `/tx/:txid` reads, one at a time | the same: no answer is kept |

- **Replacements.** After 47 minutes the record held 436 replacements (140 with their replacement mined, 16 whose replacement the tracker never held), 106 KB on disk. Of our 46 transactions in the 25 newest trees, 41 were in the reference's 25. Fee, size, value and signalling were equal for every one we both held in the mempool. Our times are the node's accept times, 1 to 2 s before the reference's own stamps; our `rate` is each transaction's own, where the reference wrote an ancestor-adjusted rate for 24 of the 39 compared in the first check. The rest differ where a miner confirmed the transaction we had seen replaced: the reference keeps "B replaced A" and marks A mined, we record that the mined A replaced B, with A as the newest end and `mined`; its figures are then `null`, since its own link, which held them, is dropped (a known gap).
- **Restart.** The final build read the 437 stored replacements back in under a millisecond, and every route answered from them.
- **CPFP**, eight transactions with unconfirmed relatives: the effective rate equal to the reference's to the last digit for four, and within 0.08 % for three, where the reference's own view of the cluster was older (it listed fewer descendants: 15 against our 18). Ancestors: equal counts for six, where the reference listed 0 of 9 for one. Descendants: ours are every descendant in the cluster, the reference's often fewer (10 of 33). `bestDescendant` was `null` on the reference for all of them; ours names one for 32 of 34 checked, because on these chains of 0.12 sat/vB transactions the chunk pays a little more than the transaction alone.
- **First-seen.** Equal to the node's `getmempoolentry` time; 1 to 2 s before the reference's, as above. Transactions that left the mempool as replaced: ours from the record, `0` on the reference.
### Lightning

What the Lightning peer knows ([`LIGHTNING.md`](LIGHTNING.md#in-the-server)), from the store or the peer's memory, never from the node. With `{NET}_LIGHTNING_ENABLED` off every route here answers `503` `lightning is off on this network`, except the status, which answers `{"state": "off"}`. Code: `crates/server/src/lightning.rs`, and `lightning/nodes.rs` for [nodes, channels, search and rankings](#nodes-channels-search-and-rankings). Which `/api/v1/lightning` routes of the inventory are served, and why the rest are not: [`compat/api-v1.md`](compat/api-v1.md#lightning).

| Route | Answer |
|---|---|
| `GET /app/lightning/status` | The peer from memory: `state` (`starting`, `syncing`, `synced`, `failed`, `stopped`, or `off`; `synced` once the routes below answer, `failed` also while the synced graph cannot be indexed: [`LIGHTNING.md`](LIGHTNING.md#in-the-server)), `peers_configured`, `peers_connected`, `synced`, `nodes`, `channels`, `at_ceiling`, `validation` (`verified`, `unchecked`, `pending`, `early`, `rejected`, `caught_up`: how far a sync has come), `closes` (the newest block read, `caught_up`, outputs `watched`, the `catch_up` backlog, closes since start by kind, `reorgs`) and `history` (records stored, last sequence number). Fields that need a running peer are `null` without one |
| `GET /app/lightning/statistics/latest` | The newest snapshot: `time`, `samples`, `channels`, `nodes`, `capacity`, `avg_capacity`, `med_capacity`, the four node kinds, `policies`, `avg_fee_rate` (ppm), `avg_base_fee_msat`, `med_fee_rate`, `med_base_fee_msat`, whole numbers. Between the graph's first sync and the first snapshot stored (up to ten minutes), and after a restart until a snapshot newer than the sync is stored, the totals taken at the sync, with their own `time`. `404` only before the graph has synced and with no snapshot stored |
| `GET /app/lightning/statistics/:interval` | `{interval, from, to, step, first, slots, sampled, complete, points}`, each point the snapshot above as a mean over its `samples`, oldest first |
| `GET /app/lightning/channels/opened` | The newest channels by funding position, closed ones included |
| `GET /app/lightning/channels/closed` | The newest closes by closing height |
| `GET /api/v1/lightning/statistics/latest` | `{"latest": {id, added, channel_count, node_count, total_capacity, tor_nodes, clearnet_nodes, unannounced_nodes, avg_capacity, avg_fee_rate, avg_base_fee_mtokens, med_capacity, med_fee_rate, med_base_fee_mtokens, clearnet_tor_nodes}}`, the reference's fields and order |
| `GET /api/v1/lightning/statistics/:interval` | `[{added, channel_count, total_capacity, tor_nodes, clearnet_nodes, unannounced_nodes, clearnet_tor_nodes}]`, newest first, as the reference sends them |

**Channels** in both lists: `id` (`<height>x<index>x<output>`), `scid` (the 64-bit id as a decimal string, since JavaScript numbers stop at 2⁵³), `node_one` and `node_two` (`{id, alias}`: the public key in hex and the alias from the live graph, `null` when the graph holds none), `capacity` in sats, `opened` (`{height, hash, time}`), `closed` (`null`, or `{block, txid, kind, fee}`, `kind` being `cooperative`, `force`, `penalty` or `other`) and `penalty` (`null`, or the sweep's `{block, txid}`). The only parameter is `limit`, 1 to 100 (default 25), written plainly: anything else, a repeated `limit` or a leading zero is `400`. An alias is what a node announced: a JSON string, never markup ([`SECURITY.md`](SECURITY.md) rule 14).

**Intervals** are those of [Mempool statistics](#mempool-statistics), with no step finer than ten minutes (`2h` has 12 points, `24h` 144). A point is the mean of the snapshots in its step; a step with none has no point. `X-Data-From-Time` and `X-Data-Complete` say what the answer covers, counted in ten-minute slots. `avg_*` are exact over the step's snapshots (sums divided); `med_*` are **the mean of the snapshots' medians**, since medians cannot be added up. The fee averages leave out policies above 1,000,000 ppm or 1,000,000 msat, which refuse to route; the medians count every policy ([`STORE.md`](STORE.md#ln_statistics)).

**Freshness and cost.** Series are computed from the store on the first request after a new snapshot or a new ten minutes, one computation at a time per network, both shapes at once; until then from memory (`Cache-Control: public, max-age=10`). The status and lists are read per request: the status from memory, a list in one indexed read of at most 100 rows (the aliases from the [index](#nodes-channels-search-and-rankings), `null` before its first build). `no-cache`. CORS as for `/api` on the `/api/v1` routes.

#### Nodes, channels, search and rankings

Answered from an index of the verified graph that the server rebuilds every 30 s while the graph is synced, and from indexed reads of the store; never from the node, and never under the graph's lock ([`LIGHTNING.md`](LIGHTNING.md#routes)). An answer lags the graph by at most 30 s plus a build (24 to 40 ms on mainnet); a close shows on the channel's own routes at once, since they read its row. `Cache-Control: public, max-age=10`; CORS as for `/api` on the `/api/v1` routes.

**Before the first index**, while the graph has never been synced (about four minutes on a first start, one after a restart), every route here answers `503` `lightning graph is still syncing; retry` with `Retry-After: 1`: an answer from a half-loaded graph would be wrong, not partial. A synced graph whose first index cannot be built (the status says `failed`) answers `503` `lightning graph is synced but cannot be indexed; retry later`. With Lightning off, `503` `lightning is off on this network`, as above.

**Parameters** are parsed before anything is read, and an error names what was wrong with the request and nothing about the server:

| Parameter | Accepted | Otherwise |
|---|---|---|
| `:key`, `public_key` | Exactly 66 hex digits, any case | `400 invalid public key: 66 hex digits` |
| `:id` (a channel) | The 64-bit id in decimal (`892785849701564416`, the only form the reference takes) or `<height>x<index>x<output>` (`811984x2037x0`), each part decimal without a leading zero and within its 24, 24 and 16 bits | `400 invalid channel id: …` |
| `:txid`, `txId[]` | 64 hex digits; `txId[]` at most 100 times | `400 invalid txid` / `invalid txId` |
| `q`, `searchText` | 3 to 66 characters once percent-decoded and trimmed, valid UTF-8, no control character | `400 search text is 3 to 66 characters, without control characters` |
| `status` | `open` (the default) or `closed` | `400` |
| `page` (ours) | 0 to 4,000, 25 channels a page | `400` |
| `index` (reference) | An offset, 0 to 100,000, 10 channels a page | `400` |
| `limit` (rankings) | 1 to 100, default 25, as for the channel lists above | `400` |

A parameter given twice is `400`. `/app` routes that take parameters (search, rankings, a node's channels, the overview, which takes none) refuse unknown ones, and the others ignore a query string; `/api/v1` routes ignore unknown parameters, like every `/api/v1` query, so cache-busting works. A node or channel we do not hold is `404` (`node not found`, `channel not found`); a page past the end is an empty list. A node is held while it has an open channel in the graph.

**Search** matches public keys by prefix (hex, any case) in key order, then aliases by substring (Unicode lowercase on both sides), most capacity first: at most 10 nodes. A query that parses as a channel id also returns that channel, open or closed. Its cost is a binary search and one pass over at most 13,600 aliases of at most 32 bytes, whatever the query: 0.5 ms on mainnet.

**An alias is a claim.** Any node can announce any 32 bytes, another node's name included: search returns the impostor too, after the larger node, and a page must show the public key beside the alias. Aliases are LDK's reading of the 32 bytes (up to the first NUL; control characters become U+FFFD) and are served as JSON strings, never markup ([`SECURITY.md`](SECURITY.md) rule 14).

##### `/app/lightning/…`

What the Lightning pages read; one request for each page's main content. Real mainnet answers, 2026-11-12, trimmed where `…`.

| Route | Answer |
|---|---|
| `GET /overview` | `{statistics, top_capacity, top_channels, opened, closed}`: the newest totals as `statistics/latest` gives them (`null` where it answers `404`), the top 10 nodes by capacity and by open channels (`{id, alias, capacity, channels}`), and the 10 newest opens and closes as in the channel lists above |
| `GET /search?q=` | `{nodes: [{id, alias, capacity, channels}], channels: [{id, scid, capacity, state}]}` |
| `GET /rankings/:by` | `by` is `capacity`, `channels` or `age` (oldest first funding first); `{by, nodes: [{id, alias, capacity, channels, first_seen, last_update}]}`, `?limit=` up to 100 |
| `GET /nodes/:key` | The node page: below |
| `GET /nodes/:key/channels?status=&page=` | `{status, page, per_page, total, channels}`: open channels largest first, from the index; closed ones newest close first, from the store |
| `GET /nodes/:key/history` | `{from, points: [{time, channels, capacity}]}`: the node's open channels and capacity at each UTC midnight since `from` (when our history starts: the first statistics snapshot; `null` before it), at the block time of each of its channels' opens and closes after the first midnight, then now, oldest first. A chart steps at the changes rather than drawing a slope between midnights |
| `GET /channels/:id` | The channel page: below. Open or closed |
| `GET /tx/:txid` | `{opened, closed}`: the channels this transaction funded and closed, each as in the channel lists above. For the transaction page |

`state` is `active` (some direction has an enabled policy), `inactive` (none: disabled, or no policy received within LDK's two weeks) or `closed`. `fee_rate` in a node's channel list is that node's own policy on the channel, ppm. Times are Unix seconds; `first_seen` is the oldest funding block time among the node's channels we hold, open or closed.

```json
GET /app/lightning/nodes/03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f
{"id": "03864ef0…3f8f", "alias": "ACINQ", "color": "#49daaa",
 "addresses": ["3.33.236.230:9735", "of7husrflx7sforh3fw6yqlpwstee3wg5imvvmkp4bz6rbjxtg5nljad.onion:9735"],
 "features": [{"bit": 0, "name": "data-loss-protect", "required": true}, {"bit": 7, "name": "gossip-queries", "required": false}, …],
 "features_hex": "a00098a82a8a6981", "last_update": 1794051404, "first_seen": 1551152144,
 "capacity": 27383219285,
 "channels": {"open": 1807, "active": 1729, "closed": 0, "cooperative": 0, "force": 0, "penalty": 0, "other": 0},
 "fees": {"incoming": [{"bucket": null, "count": 77, "capacity": 156929566}, {"bucket": 0, "count": 60, "capacity": 1146048852}, …],
          "outgoing": [{"bucket": null, "count": 60, "capacity": 91707732}, {"bucket": 400, "count": 1481, "capacity": 6377292455}, …]},
 "open_channels": {"status": "open", "page": 0, "per_page": 25, "total": 1807, "channels": [
   {"id": "811984x2037x0", "scid": "892785849701564416", "capacity": 500000000, "state": "active",
    "peer": {"id": "033d8656…e025", "alias": "bfx-lnd0"}, "fee_rate": 2499, "closed": null}, …]}}
```

`features` names a bit by BOLT 9 (`null` when it names none); `fees` buckets the fee rates others charge into the node (`incoming`) and the node charges (`outgoing`) over its open channels: exact under 10 ppm, then rounded down to tens, hundreds and, from 1,000, thousands; `null` counts channels with no policy that way. A closed channel in a list has `"fee_rate": null` and `closed` as below.

```json
GET /app/lightning/channels/811984x2037x0
{"id": "811984x2037x0", "scid": "892785849701564416", "capacity": 500000000, "state": "active", "last_update": 1794496008,
 "node_one": {"id": "033d8656…e025", "alias": "bfx-lnd0", "color": "#16b157",
              "policy": {"fee_rate": 1, "base_fee_msat": 1000, "cltv_delta": 80, "min_htlc_msat": 1000, "max_htlc_msat": 20000000000, "enabled": true, "last_update": 1794456478}},
 "node_two": {"id": "03864ef0…3f8f", "alias": "ACINQ", "color": "#49daaa", "policy": {"fee_rate": 2499, …}},
 "funding": {"txid": "a7f10c25…d4f5", "vout": 0, "block": {"height": 811984, "hash": "000000000000000000019545…fb7e", "time": 1697189564}},
 "closed": null, "penalty": null}
```

`policy` is what that node charges to forward over the channel, `null` until it sent one and for a closed channel. `funding.txid` is `null` until the server has asked the node for it ([`LIGHTNING.md`](LIGHTNING.md#funding-transactions)); `funding.block` is `null` only for a channel the store has not recorded yet. A closed channel has `closed: {block, txid, kind, fee}` and, after a breach, `penalty: {block, txid}`.

```json
GET /app/lightning/search?q=acinq
{"nodes": [{"id": "03864ef0…3f8f", "alias": "ACINQ", "capacity": 27383219285, "channels": 1807}], "channels": []}
GET /app/lightning/rankings/capacity?limit=2
{"by": "capacity", "nodes": [{"id": "033d8656…e025", "alias": "bfx-lnd0", "capacity": 32461828251, "channels": 544, "first_seen": 1574813156, "last_update": 1794504476},
                             {"id": "03a1f3af…a72f", "alias": "Binance", "capacity": 32315912432, "channels": 130, "first_seen": 1705383088, "last_update": 1794504053}]}
GET /app/lightning/nodes/03864ef0…3f8f/history   (before the first statistics snapshot)
{"from": null, "points": [{"time": 1794505190, "channels": 1807, "capacity": 27383219285}]}
```

##### `/api/v1/lightning/…`

In the reference's shapes: field names, order and JSON types as recorded from mempool.space's public API ([`fixtures/api-v1/lightning.json`](../fixtures/api-v1/lightning.json)), our values.

| Route | Answer and differences |
|---|---|
| `GET /search?searchText=` | `{nodes: [{public_key, alias, capacity, channels, status}], channels: [{id, short_id, capacity, status}]}`. At most 10 nodes. A node's `status` is 1 when one of its channels is active |
| `GET /nodes/rankings` | `{topByCapacity: [{publicKey, alias, capacity}], topByChannels: [{publicKey, alias, channels, city, country, iso_code, subdivision}]}`, 6 each |
| `GET /nodes/rankings/liquidity`, `/connectivity`, `/age` | 100 nodes: `{publicKey, alias, capacity, channels, firstSeen, updatedAt, city, country, iso_code, subdivision}` (capacity after channels for the last two) |
| `GET /nodes/:key` | `{public_key, alias, first_seen, updated_at, color, sockets, as_number, city_id, country_id, subdivision_id, longitude, latitude, iso_code, as_organization, city, country, subdivision, features, featuresBits, active_channel_count, capacity, opened_channel_count, closed_channel_count, custom_records}`. `capacity` is a string, as there |
| `GET /nodes/:key/statistics` | `[{added, capacity, channels}]`, newest first: the midnights and now of `/app/lightning/nodes/:key/history`, without the changes between |
| `GET /nodes/:key/fees/histogram` | `{incoming: [{bucket, count, capacity}], outgoing: […]}`; `bucket` a string such as `"400.0"` or `null`, `capacity` a string |
| `GET /channels?public_key=&status=&index=` | 10 channels from offset `index`: `[{status, closing_reason, closing_date, capacity, short_id, id, fee_rate, node: {alias, public_key, channels, capacity}}]`, open ones largest first, closed ones newest close first; `X-Total-Count` the node's total |
| `GET /channels/:id` | `{id, short_id, capacity, transaction_id, transaction_vout, closing_transaction_id, closing_fee, closing_reason, closing_date, updated_at, created, status, funding_ratio, closed_by, node_left, node_right}`, each end `{alias, public_key, channels, capacity, base_fee_mtokens, cltv_delta, fee_rate, is_disabled, max_htlc_mtokens, min_htlc_mtokens, updated_at, longitude, latitude}` |
| `GET /channels/txids?txId[]=` | One `{inputs, outputs}` per txid asked, in order: `outputs` maps the output index to the channel it funded, `inputs` maps `"0"` to the channel it closed; each channel as above without the ends' `channels`, `capacity`, `longitude` and `latitude`, as there |

Values and their differences from the reference:

- **Only chain-verified channels.** We list a channel only once we found its funding output unspent, six deep and paying the announced keys; the reference lists what gossip claims ([`LIGHTNING.md`](LIGHTNING.md#validation)). A node is held while it has such a channel.
- **History starts when our peer started.** `closed_channel_count`, the closed lists, `first_seen` (the oldest funding among channels we hold: for ACINQ 2019-02-26, against the reference's 2019-01-02) and `/statistics` count only what we saw. `/statistics` starts at our first statistics snapshot and adds a point for now; its points are the node's channels at each UTC midnight rebuilt from our record of opens and closes, where the reference stores a snapshot a day.
- **Location** (`as_number`, `city_id`, `country_id`, `subdivision_id`, `longitude`, `latitude`, `iso_code`, `as_organization`, `city`, `country`, `subdivision`) is always `null`: we have no GeoIP data. `custom_records` is always `{}`. The reference's location routes (`/nodes/countries`, `/nodes/country/:code`, `/nodes/isp-ranking`, `/nodes/isp/:asn`, `/nodes/world`, `/channels-geo`) are `404`, as any route we do not serve, never `400` for a key they are not.
- **Left out, because we cannot know them:** `single_funded` and each end's `funding_balance` and `closing_balance`. `funding_ratio` and `closed_by` are `null`, as the reference writes them when it does not know.
- **`node_left` is the channel's node one** (the lower key, BOLT 7's order); the reference's left end is not always that one (for `811984x2037x0` it is ACINQ, the higher). Each end carries its own policy either way.
- **Status:** 1 when some direction has an enabled policy, 0 otherwise, which includes channels whose policies LDK dropped after two weeks of silence (CoinGate: 468 of its 1,301 open channels active here, all 1,294 on the reference's August data); 2 closed. `closing_reason` is 1 cooperative, 2 force, 3 a breach, and `null` for a close that is neither (most likely a splice); `closing_date` is the closing block's time. `created` is the funding block's time; `updated_at` the newer policy's.
- **Unknown values are `null`:** `transaction_id` until the server has asked the node for the funding transaction, `closing_fee` when the node did not say, a closed channel's policies (gossip forgets them), a closed channel's `fee_rate` in the lists, `color`, `updated_at` and `featuresBits` (`""`) of a node that announced nothing. Such a node's `alias` is its key's first 20 hex digits, as the reference writes it.
- **`channels/txids` inputs:** a cooperative or force close spends the funding output alone, so it is input `"0"`; an `other` close spends more inputs and we do not keep which was the funding output, so it is left out of `inputs` (it is in our `/app/lightning/tx/:txid`).
- **Feature names** follow BOLT 9 (`gossip-queries-ex`, `route-blinding`, `dual-fund`, `quiesce`, `onion-messages` where the reference says `unknown`); implementation-specific bits the reference names (31 `amp`, 2023 `script-enforced-lease`) are `unknown` here.
- **Errors** are our `{"error": …}` model; the reference answers some with plain text (`Channel not found`).

**Cost.** Measured on mainnet (36,223 channels, 13,639 nodes), release build, a client on the same machine, three requests each: every route answered in 0.3 to 0.9 ms, first and repeated alike, except the three that read a node's rows from the store (its closed channels, `/history` and `/statistics`, 1.5 to 2.6 ms for ACINQ's 1,807 channels). The largest answers are the 100-node rankings (25 KB) and the overview (7 KB). A test builds a graph of mainnet's size and checks every route answers it without the node (`crates/server/tests/lightning.rs`); an ignored one beside it holds each under 250 ms in a debug build, on a machine with nothing else running.

## Using it from the frontend

- Call `/api/...` (mainnet) or `/<network>/api/...` with `fetch`. Same origin, so CORS does not apply.
- Treat any non-2xx as `{"error": string}` JSON. The message is safe to show; the status says what to do: `404` not found, `400` bad input, `503` retry later (or, for address pages, the index is off).
- Tip and mempool answers are at most a second old by design; poll no faster than that. For live data use the WebSocket when it exists.
- Difficulty progress is `/api/v1/difficulty-adjustment` ([above](#difficulty-adjustment)). It changes once a block; its time fields can be counted down locally between fetches.
- Fee recommendations come live from the `fees` WebSocket topic ([`WS.md`](WS.md#mempool-topics)), in the same unit as the other topics; `/api/v1/fees/precise` is the HTTP form.
- Mining charts read `/api/v1/mining/…` ([above](#mining)) and must check `X-Data-From-Time` and `X-Data-Complete`: while the backfill runs, history starts later than asked.
- The mempool chart reads `/app/mempool/history/:interval` ([`FRONTEND.md`](FRONTEND.md#mempool-history)); its body carries the same coverage.
- Read `X-Bitcoin-Chain-Tip` to detect a tip change between two fetches of one page, and refetch the page.
- Response bodies are chain data: render them as text, never as HTML (rule 14).
