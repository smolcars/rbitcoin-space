# Parity with mempool.space

This page tracks every mempool.space feature: whether we serve it, how, and if not, why.

## Policy

1. **Feature parity is the goal; being a drop-in is not.** Where rbitcoin lets us do something better, we do it our way and note the difference here.
2. **Esplora is served as rbitcoin serves it,** under `/api`. Clients written for Esplora or electrs work unchanged.
3. **mempool.space-shaped endpoints under `/api/v1` are served when they are cheap** to derive from what we already compute. Each one is a row in the inventory.
4. **Our own frontend uses `/app`,** a private API with no compatibility promise.
5. **This inventory is written clean-room.** It describes observable behaviour in our own words. No mempool.space source code is read, and no text or example payload is copied from its documentation.

## Out of scope

| Feature | Why |
|---|---|
| Liquid and its assets | Different chain; rbitcoin does not serve it |
| Accelerator and other paid services | A commercial service, not explorer functionality |
| Translations | English only for now |
| Lightning world map | Needs a GeoIP database |
| Address-prefix search | rbitcoin has no prefix index; search is exact match |

## Status values

| Value | Meaning |
|---|---|
| `served` | Works today |
| `planned` | Assigned to a milestone |
| `different` | We offer the feature another way; the row says how |
| `skipped` | Not planned; the row says why |

## Inventory

One table per group, each on its own page:

| Group | Page | Rows | served | planned | different | skipped | Confirmed live |
|---|---|---|---|---|---|---|---|
| Esplora REST (`/api`) | [`compat/esplora.md`](compat/esplora.md) | 56 | 44 | 0 | 0 | 12 | 48 |
| mempool.space REST (`/api/v1`) | [`compat/api-v1.md`](compat/api-v1.md) | 74 | 53 | 4 | 2 | 15 | 73 |
| WebSocket | [`compat/websocket.md`](compat/websocket.md) | 48 | 28 | 1 | 3 | 16 | 43 |
| Pages and visible features | [`compat/pages.md`](compat/pages.md) | 55 | 33 | 9 | 5 | 8 | 31 |
| **Total** | | **233** | **158** | **14** | **10** | **51** | **195** |

Every row's status was checked against `master` on 2026-11-12 (task C1), and the rows of `vBytesPerSecond`, `live-2h-chart` and `backend-info` again when they were built (task G1), the Lightning node's fee histogram and history when they were (task G3), the three mining rows of the pages when they were (task G2), the two replacements rows of the pages when they were (task G4), the five rows of broadcast, test-accept and package submission when the owner decided on them (2026-11-13), the socket's `init`, `backend` and block rows when they were built (task WS3, 2026-11-15), its `track-mempool-block` and `projected-block-transactions` rows when they were (task WS4, 2026-11-15), its replacement feeds and `init` rows when they were (task WS5, 2026-11-15), and the Lightning `channels`, `isp-ranking` and `channels-geo` rows when they were (task WS7, 2026-11-15): routes by request to a server on regtest and, read-only, on mainnet, signet and testnet4; pages by loading them in headless Chromium on each network. A page is `served` only when it shows everything its row names; a part it lacks has a row of its own.

Each row gives the feature, what it returns, where our answer comes from (an rbitcoin Esplora route or RPC method, our engine, our store, or Lightning), its status, its milestone from [`PLAN.md`](PLAN.md) and how it was checked.

### The `Live` column

| Value | Meaning |
|---|---|
| `node` | Requested from a synced rbitcoin v0.9.1 node (mainnet; signet and testnet4 spot-checked) |
| `ref` | Requested from the reference backend: a stock mempool backend (v3.3.2, Esplora mode, Lightning off) in front of that node. For pages, rendered from its frontend in headless Chromium |
| `pub` | Requested from mempool.space's public API, used where the reference has the feature off (Lightning, audits) |
| `doc` | Not requested: from rbitcoin's v0.9.1 documentation. Writes and very large responses are in this group |
| `—` | Not confirmed: known from the public site, but not observed during the probe window |

All requests were read-only and sequential. Three `/api/v1` rows (`POST /v1/cpfp`, `/v1/psbt/addparents`, `/v1/txs/package`) confirm only that the route exists: each handler refused a malformed body. A body that is not JSON is refused before routing on the reference, so such a refusal proves nothing; `POST /v1/tx/push` is unconfirmed for that reason.

## What is left

Every `planned` row, as of the count above, and the rows the owner has decided. "Needs" is what we do not have yet; "nothing" means the data is already served and only the page or message is missing. Sizes are rough: an hour, a day, several days. Rows marked `different` are settled and not listed.

### Pages

| Item | What it is | Needs | Size | Recommendation |
|---|---|---|---|---|
| Lightning graphs by network type | Clearnet, Tor and unannounced nodes over time | Nothing: the stored snapshots and `/api/v1/lightning/statistics/:interval` have them | A few hours | Build later |
| Units | BTC or sats | Nothing: one setting read by the amount component | A day | Build later |
| Clock `/clock` | Full-screen tip height, fee and mempool size | Nothing, without the price | A few hours | Build later; leave the price out |
| TV `/tv` | Full-screen block strip and mempool chart | Nothing | A day | Skip: the home page in full screen is the same view |
| Preview `/tx/preview` | Decodes a pasted transaction or PSBT | A transaction and PSBT parser in the browser, for untrusted input | Several days | An idea for later: with no broadcast page (the owner's decision), nothing is scheduled |
| Mempool goggles | Filters the block drawing by transaction kind | Per-transaction flags: computed in the engine and served for mined blocks (`/v1/block/:hash/summary`, the grid's records). Left: our own filter UI. CPFP in a mined block is our plain child-pays-more rule, narrower than the reference's | Several days | Build the filter UI later |

### REST routes

| Item | What it is | Needs | Size | Recommendation |
|---|---|---|---|---|
| `POST /api/v1/cpfp` | CPFP data for several transactions | Nothing: the engine answers `/v1/cpfp/:txid` | An hour | Skip until a client asks: the reference's request shape is unconfirmed, and one request per transaction already works |
| `POST /api/v1/psbt/addparents` | A PSBT with its parents filled in | A PSBT parser on the server for untrusted input, and a node read per input | Several days | Skip: a wallet tool, not explorer data, with a large untrusted-input surface |

### Decided by the owner

| Item | Rows | Decision |
|---|---|---|
| Fiat prices | `/v1/prices`, `/v1/historical-price`, `conversions`, fiat currency choice, the calculator, block fees in fiat | Parked: a price feed is a new outside source with its own trust and off switch. The rows stay `planned` |
| Broadcast page `/tx/push` | Pages: broadcast | No broadcast page for now (2026-11-13). `POST /api/tx` stays served under its rules ([`SECURITY.md`](SECURITY.md) rule 5). Skipped |
| Package submission | `POST /api/txs/package`, `POST /api/v1/txs/package`, packages on `/tx/push` | Not served, with no broadcast page to use it (2026-11-13). Skipped |
| Test-accept | `POST /api/txs/test`, `/tx/test` | Not served, for the same reason (2026-11-13). Skipped |

## mempool.space's frontend on this server

mempool.space's public frontend in headless Chromium, its API and socket answered by this server, 2026-11-15, mainnet (rerun after task WS5 the same day). The server was fresh: its own data directory, mempool engine on, backfill and Lightning off. The Lightning rows are signet with Lightning on (task WS7); a fresh server's history charts stay empty until it has stored a few statistics snapshots. Rerun (only GET requests are forwarded; `--control` uses mempool.space's own backend):

```bash
cd web && node ../dev/compat/probe.mjs http://127.0.0.1:<port> <out dir>
cd web && node ../dev/compat/probe.mjs http://127.0.0.1:<port> <out dir> --network signet --only lightning,lightning-node
```

| Page | Works | Missing |
|---|---|---|
| Home `/` | Fee panel, projected and mined blocks with fees and pools, difficulty, mempool figures and chart, goggles drawing, recent replacements, live | Goggles filters on the projected blocks (no flags there yet; a mined block's are served) |
| Block `/block/:hash` | Everything, drawing included | Audit of a block the server did not watch |
| Transaction, confirmed | Everything | Per-transaction audit of an unwatched block |
| Transaction, unconfirmed | Everything, with its position, ETA and the projected blocks above it | |
| Address | Everything | |
| Next block `/mempool-block/0` | Figures, drawing and fee chart | |
| Blocks `/blocks` | Everything; health where audited | |
| Mining `/mining` | Rewards, pools, difficulty | Charts wait on a backfilled table |
| Mempool graph `/graphs/mempool` | The live chart | History before the server started |
| RBF `/rbf` | Replacement trees, live, in "All" and "Full RBF" | |
| Lightning `/lightning` (signet, Lightning on) | Figures, rankings, history, the capacity panel's three figures | The provider chart ("Indexing in progress") and the world map ("No data to display yet"): both need IP data |
| Lightning node `/lightning/node/:key` (signet) | Everything but places: figures, history, active channels map, fee distribution, channel lists. No error | Location, provider and the map of its channels' places |

Every page asks `/api/v1/services/version` (404, mempool.space's own service) and logs one error for it. Prices (parked, [above](#decided-by-the-owner)) and accelerations (out of scope) answer 404.

## Reference backend against rbitcoin's Esplora

What differs between the two answers to the same question, from live requests on mainnet.

1. **Esplora shapes match exactly.** On 12 routes compared key by key (block, block list, block status, tx, tx status, outspends, merkle proof, address, address summary, mempool, recent, fee estimates), rbitcoin's JSON and mempool.space's public Esplora JSON had the same fields. The pass-through needs no reshaping.
2. **The reference stack serves no Esplora under `/api/v1`.** `/api/v1/tx/:txid` and `/api/v1/address/:address` are 404; Esplora lives only under `/api`. Only `/api/v1/blocks/tip/height` is duplicated.
3. **Fee estimates come from different products.** rbitcoin's `/fee-estimates` is a 10-minute inclusion estimate with sub-sat precision. The reference derives its own from projected blocks: `recommended` rounds to whole sat/vB with a floor of 1, while `precise` gave 2.633 / 1.38 / 0.628 / 0.2 / 0.1 at the same moment. The mempool floor was 0.1 sat/vB.
4. **The reference's block extras are degraded on rbitcoin.** `avgFeeRate` is 0 and `feeRange` starts at 0.12, from whole-sat rounding. `utxoSetSize` and `totalInputAmt` are null; rbitcoin has no `gettxoutsetinfo`, so the UTXO set size cannot come from the node.
5. **The reference has no block audits.** `audit-summary` is 404 "Audit not available", `matchRate` is null and `predictions` is empty. mempool.space's public API has all three.
6. **The reference's mining routes are slow.** Most took 15–58 s per request; two unrecognised paths under `/api/v1/mining/` hung until the proxy's 60 s timeout. Block, fee and mempool routes answered in under 0.1 s.
7. **`mempoolInfo` carries rbitcoin's cluster limits** (`limitclustercount`, `limitclustersize`) and `fullrbf: true`, passed straight through from `getmempoolinfo`.
8. **Only rbitcoin offers** the chain-tip headers, `?asof=`, the output-by-position routes and multi-address `POST` history. Address totals and UTXOs answer 503 above the node's `--max-sh-creates` cap (a mainnet payout address with 16,276 outputs), while its paged history still works.
9. **Networks differ by operator settings, not by software.** All three test nodes serve address routes; the signet node's cap is high enough to total an address with 118,307 outputs.

## Findings for the plan

Proposals for [`PLAN.md`](PLAN.md) and [`TODO.md`](TODO.md); this task does not edit them.

### Cheaper than expected

1. **CPFP needs no graph of our own** (done: `/v1/cpfp/:txid` is served from the projected blocks' chunks). `getmempoolcluster` returned a transaction's cluster and chunk fee rate in 20 ms, and `getmempoolancestors` 10 ms. The cluster call lists chunks without edges, so relationships come from `getmempoolancestors`, `getmempooldescendants` or `getmempoolentry`'s `depends`; the effective fee rate is the node's own chunk rate.
2. **The Esplora pass-through is pure routing.** Shapes match (above), so S2 is an allow-list, typed parameters and cache headers. Done: successful answers pass byte for byte; error bodies are our own ([`API.md`](API.md#error-bodies-are-ours)).
3. **Difficulty adjustment is cheap** (two headers and arithmetic). Done in M2; the home page has it.
4. **`getblockstats` gives totals in 40 ms,** including `utxo_increase` for the UTXO-change extra. Its fee-rate percentiles are truncated to whole sat/vB (they read `[0,0,0,0,2]` for the probed block), so they cannot feed any fee-rate history.

### More expensive than expected

5. **Per-transaction block data needs `getblock` verbosity 2.** The mined-block drawing (`/v1/block/:hash/summary`, W7) and our own fee percentiles (MI1) need every transaction's fee and size. Over TCP that is 0.8 s and 11 MB per full block; the paged Esplora route would take about 270 requests. A sequential full-history backfill at that rate takes days. Proposal: take totals from `getblockstats`; backfill percentiles from `getblock` verbosity 2 newest first, in the background, with a few requests in parallel; prefer the unix-socket `/internal/block/:hash/txs` when co-located. Add `getblock` to N3's method set.
6. **Block audits depend on keeping the template.** The reference cannot audit at all. MI4 needs MP2 to retain the last template (about 0.4 s and 4.9 MB from `getblocktemplate`) at each block arrival; audits cannot be backfilled for blocks we did not watch.
7. **Mining pool identification needs a dataset.** Pool names come from coinbase tags and payout addresses. We need a list under a licence compatible with MIT, or our own. Decide before MI2. Decided in MI2: bitcoin-data/mining-pools, MIT ([`API.md`](API.md#mining)).
8. **`RBITCOIN.md` overstated the chain-tip stamp.** `/mempool`, `/mempool/txids`, `/mempool/recent`, `/fee-estimates`, broadcast and the address mempool-history routes carry none (the paged `/mempool/txids/page` is stamped), and address routes stamp the address-index watermark ([`compat/esplora.md`](compat/esplora.md)). Corrected there since.
9. **Large addresses need a product answer.** Totals and UTXOs are refused above the node's cap. The address page (W5) shows history without totals and says why. A paged or capped stats route is a candidate for the rbitcoin wishlist in [`RBITCOIN.md`](RBITCOIN.md).

### Cannot be supported, or not worth it

10. **UTXO set size** (`utxoSetSize` in block extras): rbitcoin has no `gettxoutsetinfo`.
11. **Lightning location features** (countries, ISPs, world and channel maps, node groups): nine rows skipped for GeoIP, ASN or curation. Lightning node responses carry their location fields as `null`. `penalties` is skipped too: its rows are the reference's own records of closed channels, which we do not keep.
12. **`blocks-bulk`** is disabled on both the reference and mempool.space; skip until someone asks.

### Third-party dependence

13. **A compatible WebSocket is worth a task.** [`ARCHITECTURE.md`](ARCHITECTURE.md) defines only `/app/ws`. Wallets and bots that follow transactions or addresses speak `/api/v1/ws` (`want`, `track-tx`, `track-address`, `track-addresses`, `ping`). Proposal: a task in M2, after S3 and MP5, that serves this JSON subset from the same hub, with the heavy `track-mempool` topic rate-limited. Done in WS1 without the heavy topics, which are answered as not served ([`WS.md`](WS.md#the-mempoolspace-shaped-socket-apiv1ws)).
14. **Endpoints most likely relied on by others** (from what wallets and tools are publicly known to call, not measured here): Esplora `/api/tx`, `/api/tx/:txid/status`, `/api/address/*`, `/api/blocks/tip/height`; `/api/v1/fees/recommended`, `/api/v1/fees/mempool-blocks`, `/api/v1/prices`, `/api/v1/historical-price`, `/api/v1/difficulty-adjustment`, `/api/v1/cpfp/:txid`. Every one is served except the two price routes, which wait on the price feed ([below](#what-is-left)).
15. **Serve both fee shapes.** `fees/recommended` keeps its whole-number contract for old clients; on a 0.1 sat/vB mempool it overstates the minimum tenfold, so `fees/precise` and our frontend use sub-sat values. Done.
