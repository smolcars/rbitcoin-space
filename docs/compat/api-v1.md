# mempool.space REST (`/api/v1`)

Part of the parity inventory in [`../COMPAT.md`](../COMPAT.md), which defines the columns, status values and the `Live` legend.

rbitcoin serves none of these; this project is that surface ([`RBITCOIN.md`](../RBITCOIN.md)). "Engine" means our in-memory mempool tracker and projected blocks; "store" means our SQLite file. A route marked `served` is served at `/api/v1/…` in the shape observed on the reference backend. Our own frontend may read the same data through `/app` in another shape.

## General

| Endpoint | Returns | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| `GET /v1/difficulty-adjustment` | Progress through the epoch, expected change, estimated retarget time, blocks left | Esplora: the first blocks of this period and the last, once per new tip; engine | served | M2 | ref | Same fields, order and types. Projects from block timestamps, so `timeAvg` and `difficultyChange` differ from the reference; regtest reports no change ([`API.md`](../API.md#difficulty-adjustment)) |
| `GET /v1/prices` | Latest BTC price in seven fiat currencies | Store, from a price feed | planned | M3 | ref | Not served (404). Needs a price feed, which the owner has parked; off switch per [`PLAN.md`](../PLAN.md) |
| `GET /v1/historical-price[?currency=&timestamp=]` | Price history, or the price nearest a time, plus exchange rates | Store | planned | M3 | ref | Not served (404); waits on the price feed, as above. The unfiltered form is 300 KB |
| `GET /v1/validate-address/:address` | Validity, script, witness version and program | Our own address parser; rbitcoin `validateaddress` matches field for field | served | M5 | ref | No node call. Equal to the reference's answers byte for byte on nine recorded mainnet cases; another network's address is `{"isvalid": false}` on both. For pay-to-anchor the node, and so we, name no program ([`API.md`](../API.md#address-validation)) |
| `GET /v1/statistics/:interval` | Mempool samples over 2h, 24h, 1w … all: count, vB/s, fee-band vsizes, min fee | Store (sampled once a minute, rolled into hours and days) | served | M3 | ref | Same fields, order and types; `1w` and longer drop `total_fee` and `mempool_byte_weight`, as the reference does. Our ten fee bands go whole into the range of their lower edge, so the 39 ranges are exact at 1, 2, 3, 5 and 10 sat/vB only. History starts when our server first sampled; `X-Data-*` headers say how far it reaches ([`API.md`](../API.md#mempool-statistics)) |
| `GET /v1/transaction-times?txId[]=` | First-seen time for each txid, `0` when unknown | Engine (the node's accept time); the replacement record (store) for replaced ones | served | M2 | ref | At most 100 txids. Times for the mempool and for transactions the replacement record holds; confirmed ones read `0`, as on the reference. Ours are the node's own, about a second before the reference's ([`API.md`](../API.md#first-seen-times)) |
| `GET /v1/backend-info` | Backend kind, version, commit, and the host's name and OS | Server build info | served | M5 | ref, pub | Same fields and order. The version, the build's commit as `/healthz` reports it (`null` without one), whether Lightning is on and `backend` `esplora`; host name, OS and node version `null` ([`API.md`](../API.md#backend-info)) |
| `GET /v1/init-data` | One snapshot of everything the home page needs | Engine | different | M2 | ref | Not served (404). Our frontend gets the same parts from each topic's first message on `/app/ws` ([`WS.md`](../WS.md#topics)) |
| `GET /v1/address-prefix/:prefix` | Address autocomplete | — | skipped | — | ref, pub | Out of scope. 404 on the reference |
| `/v1/donations`, `/v1/contributors`, `/v1/translators` | mempool.space's own sponsor and contributor lists | — | skipped | — | ref | Data about another project |

## Fees

| Endpoint | Returns | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| `GET /v1/fees/recommended` | Five fee levels in whole sat/vB: fastest, half hour, hour, economy, minimum | Engine (projected blocks and recent arrivals) | served | M2 | ref | Whole numbers rounded up, at least 1: on a 0.1 sat/vB mempool the floor alone overstates the minimum tenfold. Kept for old clients; `X-Fee-Source` says when it is the node's estimate ([`API.md`](../API.md#fees)) |
| `GET /v1/fees/precise` | The same five levels with sub-sat precision | Engine | served | M2 | ref | Three decimals, the node's resolution. The honest one on rbitcoin. Our own method; values beside the reference's in [`MEMPOOL.md`](../MEMPOOL.md#against-the-node-and-the-reference) |
| `GET /v1/fees/mempool-blocks` | Projected blocks: size, vsize, tx count, total fees, median fee, fee range | Engine (projected blocks from cluster chunks) | served | M2 | ref | Eight blocks at most, the last holding the rest of the mempool; empty ones left out. `feeRange` is always seven rates by vsize |

## Mempool, RBF and CPFP

| Endpoint | Returns | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| `GET /v1/replacements` | Recent replacement trees: new tx, time, what it replaced | Engine; the replacement record, kept in the store | served | M2 | ref | The 25 newest trees, also at `/v1/replacements/`, which the reference's frontend asks. A tree also lists the descendants a replacement removed. Survives a restart with a `DATA_DIR` ([`API.md`](../API.md#replacement-trees)) |
| `GET /v1/fullrbf/replacements` | Only trees where a replaced tx did not signal | Engine; store | served | M2 | ref | Also at `/v1/fullrbf/replacements/`, which the reference's frontend asks. rbitcoin is always full-RBF, so this is a filter on signalling (BIP 125, the transaction's own inputs), not on policy |
| `GET /v1/tx/:txid/rbf` | The replacement tree around one transaction | Engine; store for history | served | M2 | ref | `null` fields when there is none. A root the tracker never held (mined in the block that removed the original) has `null` figures |
| `GET /v1/cpfp/:txid` | Ancestors, descendants, best descendant, effective fee rate, sigops | Engine: the projected blocks' copy of the node's cluster chunks (`getmempoolcluster`) and the tracker's inputs | served | M2 | ref | No node call per request. The effective fee rate is the node's own chunk rate, which mining uses. Every ancestor and descendant in the cluster, where the reference listed fewer. No `sigops`. Confirmed or unknown: `{"ancestors": []}`, as on the reference ([`API.md`](../API.md#cpfp)) |
| `POST /v1/cpfp` | CPFP data for several transactions at once | Engine | planned | M5 | ref | Not served (404). Listed on the public docs page; the reference rejected our body format with 400, so the request shape is unconfirmed |
| `GET /v1/tx/:txid/cached` | Whether the backend holds the tx in its cache | — | skipped | — | ref | A frontend helper with no meaning outside it; 204 on the reference |
| `POST /v1/prevouts` | Prevout and unconfirmed flag for a list of outpoints | rbitcoin `GET /tx/:txid/out/:vout`, and `GET /tx/:txid` for unconfirmed ones | served | M5 | ref | At most 100 outpoints in a 16 KiB body; at most two reads per distinct outpoint, under the batch routes' cost limit. An output without an address has no `scriptpubkey_address`, where the reference wrote `""` ([`API.md`](../API.md#prevouts)) |
| `POST /v1/psbt/addparents` | A PSBT with its parents' data filled in | rbitcoin Esplora `/tx/:txid/hex` | planned | M5 | ref | Not served (404). Route exists on the reference: its handler refused an invalid PSBT. PSBT parsing is untrusted input |
| `POST /v1/tx/push` | Broadcast through the `/v1` prefix | rbitcoin `POST /tx` | different | — | — | Not served (404); use `POST /api/tx`. Not confirmed on the reference: a malformed body fails JSON parsing before routing there, and a valid one would broadcast |
| `POST /v1/txs/package` | Package submit through the `/v1` prefix | rbitcoin `POST /txs/package` | skipped | — | ref | Not served (404), and neither is `POST /api/txs/package` ([`esplora.md`](esplora.md#transactions)): a second write path, which the owner decided on 2026-11-13 not to add for now. Route exists on the reference |

## Blocks

| Endpoint | Returns | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| `GET /v1/blocks[/:start_height]` | 15 blocks with `extras`: pool, reward, fee range, median fee, totals, coinbase, audit scores | Esplora for headers, kept by hash; store for extras | served | M3 | ref | Reference shows `avgFeeRate: 0` and a `feeRange` floor of 0.12: whole-sat rounding. We compute our own. Eleven `extras` fields the store lacks are left out; a list stops at the first block the backfill has not reached, with the coverage headers ([`API.md`](../API.md#blocks)) |
| `GET /v1/block/:hash` | One block with `extras` | As above | served | M3 | ref | Reference leaves `utxoSetSize`, `totalInputAmt`, `matchRate` null; we leave the first two null and give our audit's score. `404 block not indexed yet` before the backfill reaches it, `404 not found` for a hash no block has |
| `GET /v1/block/:hash/summary` | Every tx in the block: txid, fee, vsize, value, rate, flags | The block listing ([`RBITCOIN.md`](../RBITCOIN.md#listing-a-blocks-transactions)) and the raw block, the block summary cache | served | M2 | ref | Feeds the mined-block view. 1.2 MB for a full block. `getblock` v2 has per-tx fees: 0.8 s and 11 MB per full block over TCP. One listing and one raw block per block, shared with `/app`. `flags` are ours, the bits we derive ([`API.md`](../API.md#transaction-flags)): CPFP by our plain rule, which marks fewer than the reference's, and replacement by our own record; no `time`; `rate` is the tx's own, not its package's |
| `GET /v1/block/:hash/tx/:txid/summary` | One tx's summary row in a block | As above | served | M2 | ref | The same row; `404` for a txid not in the block |
| `GET /v1/block/:hash/audit-summary` | Expected template against the mined block: added, missing, fresh, sigop, prioritized txs, match rate | Engine at block time; store | served | M3 | pub | 404 `Audit not available` on the reference. Our categories, no `template`, and only the lists we can detect ([`API.md`](../API.md#block-audits)) |
| `GET /v1/block/:hash/tx/:txid/audit` | Whether one tx was expected, seen, added, conflicting, prioritized | Store | served | M3 | pub | `prioritized` and `accelerated` always `false`; a txid in none of our lists reads as matched |
| `GET /v1/mining/blocks/timestamp/:timestamp` | The newest block stamped at or before a Unix time | Store | served | M3 | ref | Not the nearest: the reference answered the block 252 s before rather than the one 17 s after. `404` before the stored history ([`API.md`](../API.md#mining)) |
| `GET /v1/blocks/tip/height` | Tip height | rbitcoin Esplora | served | M5 | ref | An alias of `/api/blocks/tip/height`, sharing its calls and cache |
| `GET /v1/blocks-bulk/:min[/:max]` | Many blocks with extras | — | skipped | — | ref, pub | Disabled on the reference and on mempool.space. Revisit if asked for |

## Mining

Every mining route is served from the block table in our store (MI1, MI2), never from the node. The reference backend took 14–54 s for most of these; ours answer in under 2 ms once computed, and in under a second cold on a mainnet-sized table ([`API.md`](../API.md#mining)). The audit routes are served from the audits table (MI4), for the blocks we watched arrive ([`API.md`](../API.md#block-audits)).

| Endpoint | Returns | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| `GET /v1/mining/pools` | Every known pool: name, slug, id | Pool list (bitcoin-data/mining-pools, MIT) | served | M3 | ref | Ids and some slugs differ from the reference's own list (`oceanxyz` for `ocean`, `btccom` for `cloverpool`) |
| `GET /v1/mining/pools/:interval` | Pool ranking for a period, block count, estimated hashrates | Store | served | M3 | ref | 24 s on the reference. Same 895 blocks over a week; 891 attributed alike ([`API.md`](../API.md#mining)). `avgMatchRate` is over the period's blocks we audited, `null` without one; `avgFeeDelta` `null` |
| `GET /v1/mining/pool/:slug` | One pool's share, blocks, hashrate, reward, block health | Store; audits | served | M3 | ref | 54 s on the reference. `avgBlockHealth` is the mean match rate of the pool's blocks we audited, which are only those this server watched arrive; `null` without one, as on the reference ([`API.md`](../API.md#block-health)) |
| `GET /v1/mining/pool/:slug/hashrate` | One pool's hashrate share over time | Store | served | M3 | ref | Weekly |
| `GET /v1/mining/pool/:slug/blocks[/:height]` | One pool's blocks, with extras, paged by height | Store | served | M3 | ref | 100 a page, strictly below `:height`. Header and per-transaction fields the table lacks are left out |
| `GET /v1/mining/hashrate[/:interval]` | Network hashrate and difficulty over time | Store | served | M3 | ref | Our own estimate; within 0.01 % of the node's `getnetworkhashps` over the same blocks. A 7-day window per daily point |
| `GET /v1/mining/hashrate/pools[/:interval]` | Hashrate share per pool over time | Store | served | M3 | ref | Weekly |
| `GET /v1/mining/difficulty-adjustments[/:interval]` | Past retargets: time, height, difficulty, change | Store | served | M3 | ref | Identical to the reference for the month compared |
| `GET /v1/mining/reward-stats/:block_count` | Total reward, fees and tx count over the last N blocks | Store | served | M3 | ref | N from 1 to 52,560 |
| `GET /v1/mining/blocks/fees/:interval` | Average block fees over time, with USD | Store | served | M3 | ref | No `USD` until prices exist (M3), as the reference answers on a network without prices |
| `GET /v1/mining/blocks/rewards/:interval` | Average block reward over time, with USD | Store | served | M3 | ref | No `USD`, as above |
| `GET /v1/mining/blocks/fee-rates/:interval` | Fee-rate percentiles per block over time | Store | served | M3 | ref | Our own percentiles rounded to whole sat/vB; only points whose every block is rated |
| `GET /v1/mining/blocks/fee-rates/:interval/precise` | The same percentiles with sub-sat precision | Store | served | M3 | pub | 404 on the reference (older release). The useful form on rbitcoin's sub-sat mempool. Three decimals, as mempool.space |
| `GET /v1/mining/blocks/sizes-weights/:interval` | Block size and weight over time | Store | served | M3 | ref | |
| `GET /v1/mining/blocks/predictions/:interval` | Audit match rate per block over time | Store (audits) | served | M3 | ref, pub | Empty on the reference (no audits). Only blocks we watched arrive |
| `GET /v1/mining/blocks/audit/score/:hash` | One block's match rate, expected fees and weight | Store (audits) | served | M3 | ref, pub | `404` without an audit, where the public API answers `"null"` |
| `GET /v1/mining/blocks/audit/scores[/:height]` | Match rates for a page of blocks | Store (audits) | served | M3 | ref, pub | 16 heights ending at `:height`, lowest first |
| `GET /v1/mining/blocks/audit/:hash` | Per-block audit detail | Store (audits) | served | M3 | ref, pub | 204 with no body on the reference; on the public API the same body as `audit-summary`, and so here |

## Lightning

The reference backend runs with Lightning off, so shapes here were observed on mempool.space's public API. All come from our gossip peer and Lightning store (LN1–LN4). We list only channels whose funding output we verified on chain, where the reference lists what gossip claims, and our history starts when our peer started.

| Endpoint | Returns | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| `GET /v1/lightning/statistics/latest` | Network totals: nodes by network type, channels, capacity, fee-rate and base-fee averages and medians | Lightning store (a snapshot of the verified graph every ten minutes) | served | M4 | pub | Same fields, order and types. Counts only channels whose funding output we verified; `id` is the snapshot's ten-minute slot ([`API.md`](../API.md#lightning)) |
| `GET /v1/lightning/statistics/:interval` | Network totals over time | Lightning store | served | M4 | pub | Same seven fields, newest first. The reference sends a point a day; ours have the interval's step, never under ten minutes. History starts when our peer first ran; `X-Data-*` headers say how far it reaches |
| `GET /v1/lightning/search?searchText=` | Matching nodes and channels | Lightning store | served | M4 | pub | Same fields, order and types. Public key by prefix, alias by substring, channel by either id form; at most 10 nodes. Only chain-verified channels and the nodes that have one ([`API.md`](../API.md#nodes-channels-search-and-rankings)) |
| `GET /v1/lightning/nodes/rankings` | Top nodes by capacity and by channel count | Lightning store | served | M4 | pub | Same fields, order and types, 6 of each. Location `null` ([`API.md`](../API.md#nodes-channels-search-and-rankings)) |
| `GET /v1/lightning/nodes/rankings/liquidity` | Top 100 by capacity | Lightning store | served | M4 | pub | Same fields, order and types, 100 nodes. Location fields `null` without GeoIP; `firstSeen` is the oldest funding among channels we hold |
| `GET /v1/lightning/nodes/rankings/connectivity` | Top 100 by channels | Lightning store | served | M4 | pub | As above |
| `GET /v1/lightning/nodes/rankings/age` | Oldest 100 nodes | Lightning store | served | M4 | pub | As above. "First seen" is bounded by our own history: the oldest funding among the channels we hold, open or closed |
| `GET /v1/lightning/nodes/:pubkey` | One node: alias, color, sockets, features, capacity, channel counts | Lightning store | served | M4 | pub | Same fields, order and types. Location fields `null`, `custom_records` `{}`. Closed counts start with our history ([`API.md`](../API.md#nodes-channels-search-and-rankings)) |
| `GET /v1/lightning/nodes/:pubkey/statistics` | One node's capacity and channels over time | Lightning store | served | M4 | pub | Same fields, order and types. Rebuilt from our record of opens and closes, nothing new stored: a point per UTC midnight since our first statistics snapshot, and now ([`API.md`](../API.md#nodes-channels-search-and-rankings)) |
| `GET /v1/lightning/nodes/:pubkey/fees/histogram` | Distribution of one node's incoming and outgoing fee rates | Lightning store | served | M4 | pub | Same fields, order and types, buckets as the reference's (exact under 10 ppm, then tens, hundreds, thousands) |
| `GET /v1/lightning/channels?public_key=&status=` | A node's channels, open, active or closed, paged, or the first 1,000 at once for the node page's map | Lightning store | served | M4 | pub | Same fields, order and types, 10 a page from `index`, `X-Total-Count`. `index=-1`: the compact shape, at most 1,000, as there. Closed channels from our history only; their `fee_rate` is `null` |
| `GET /v1/lightning/channels/:short_id` | One channel: both ends, policies, capacity, funding and closing tx | Lightning store; rbitcoin position routes | served | M4 | pub | Same fields, order and types, except `single_funded` and the ends' balances, which we cannot know. Takes the decimal id, as the reference does, and `<h>x<i>x<o>`. `node_left` is node one ([`API.md`](../API.md#nodes-channels-search-and-rankings)) |
| `GET /v1/lightning/channels/txids?txId[]=` | Channels opened or closed by given transactions | Lightning store | served | M4 | pub | Same fields, order and types; also at `/v1/lightning/channels/txids/`, which the reference's frontend asks. Funding txids are asked of the node once per channel in the background; until then a channel is not found by it. A close that spends more than the funding output (`other`) is left out of `inputs` |
| `GET /v1/lightning/penalties` | Channels closed by a penalty transaction | Lightning store (LN3 close classification) | skipped | — | pub | Its rows are the reference's database records of a closed channel (each end's last policy, balances, outputs, resolution state), which we do not keep. Our breaches show in `/app/lightning/channels/closed` (`penalty`) |
| `GET /v1/lightning/nodes/countries` | Node counts and capacity per country | — | skipped | — | pub | Needs GeoIP. `404` |
| `GET /v1/lightning/nodes/country/:code` | Nodes in a country | — | skipped | — | pub | Needs GeoIP |
| `GET /v1/lightning/nodes/isp-ranking`: the capacities | Capacity by clearnet, Tor and unknown | Lightning store (each index build) | served | M4 | pub | Same fields and types. Our split of the verified graph by its nodes' addresses ([`API.md`](../API.md#apiv1lightning)) |
| `GET /v1/lightning/nodes/isp-ranking`: `ispRanking` | Capacity per hosting provider | — | skipped | — | pub | Needs an ASN database. Always `[]` |
| `GET /v1/lightning/nodes/isp/:asn` | Nodes at one provider | — | skipped | — | pub | Needs an ASN database |
| `GET /v1/lightning/nodes/world` | Node coordinates for the world map | — | skipped | — | pub | World map is out of scope. `404` |
| `GET /v1/lightning/channels-geo[/:pubkey]`: the route | Channel endpoints with coordinates | — | served | M4 | pub | Always `[]`, as the reference answers for a node with no known place, so the frontend's maps say "No data to display yet" and log nothing. A `:pubkey` that is not 66 hex digits is `400` |
| `GET /v1/lightning/channels-geo[/:pubkey]`: the coordinates | Where each channel's ends are | — | skipped | — | pub | Needs GeoIP |
| `GET /v1/lightning/nodes/group/:name` | A curated group of nodes | — | skipped | — | pub | The groups are mempool.space's own curation |

## Paid services and Liquid

| Endpoint | Returns | Status | Live | Why |
|---|---|---|---|---|
| `/v1/accelerations*`, `/v1/services/*` | Accelerator state and quotes | skipped | ref | Out of scope. The reference answers 400 "not available" |
| `/v1/assets/*` | Liquid assets | skipped | ref | Out of scope |
