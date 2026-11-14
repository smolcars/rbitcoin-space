# Pages and visible features

Part of the parity inventory in [`../COMPAT.md`](../COMPAT.md), which defines the columns, status values and the `Live` legend.

Paths are mempool.space's; ours are under the network prefixes in [`ARCHITECTURE.md`](../ARCHITECTURE.md), and where a path differs the note gives ours (the full list is in [`FRONTEND.md`](../FRONTEND.md#routing)). A page is `served` when a reader can reach it on every network it applies to and it shows what its row names; a part it lacks is a row of its own. `ref` here means the page rendered with its own title or heading on the reference frontend in headless Chromium. An unknown path there falls back to the home page, so a page that rendered as the home page is not counted.

## Explorer

| Page or feature | Shows | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| Home `/` | Projected and recent blocks, fees, mempool size, difficulty progress, latest transactions | Engine, Esplora, store | served | M1 | ref | Also the mempool's fee bands |
| Home: mempool inflow | Incoming vB/s beside the mempool's size | Store | different | M3 | — | On `/mempool` (Flow), not the home page |
| Home: recent replacements | The newest replacements | Engine | served | M2 | — | The newest five, each opening its newest version, last on the page so it pushes nothing down; also at the foot of `/mempool`. Live through the `replacements` topic ([`WS.md`](../WS.md#replacements)) |
| Block strip | Projected blocks to the left of mined blocks | Engine, Esplora | served | M2 | ref | |
| Block strip on other pages | The strip above most pages, not only the home page | Engine, Esplora | different | M2 | ref | On the home page only; the block and projected-block pages link to their neighbours instead |
| Projected block `/mempool-block/:index` | One projected block's fee range, size, and its transactions drawn | Engine | served | M2 | ref | At `/block/next` and `/block/next/:n`. With the mempool engine off it says so |
| Block `/block/:hash` or `/block/:height` | Header, pool, reward, fee range, transactions drawn, paged list, expected-versus-mined view | Esplora; RPC `getblock`; store for audit | served | M1 | ref | `/block/:id`. The audit shows for blocks this server watched arrive |
| Blocks `/blocks` | Paged block list with fees, size, health | Esplora; store | served | M1 | ref | Median fee rate, total fees, size, weight and match rate |
| Blocks list: pool column | Who mined each block in the list | Store | served | M3 | — | `/blocks`, the Miner column, linked to the pool's page |
| Transaction `/tx/:txid` | Inputs and outputs, flow diagram, fee and fee rate, status, ETA, live confirmation, RBF history, CPFP, Lightning channel links | Esplora; engine; Lightning store | served | M1 | — | Every part named, ETA as a projected block and a time. Did not finish rendering headlessly on the reference. With the mempool engine off it checks every 10 s instead of live, and shows no position, CPFP or replacements |
| Address `/address/:address` | Balance, totals, paged history, live updates | Esplora; Electrum push | served | M1 | ref | Large addresses hit the node's 503 cap on totals; the page shows history anyway and says why totals are missing |
| Address: balance chart | Balance over time | Esplora `/txs/summary` | served | M1 | — | The confirmed balance after each block, as a step line, from at most the newest 200 transactions: a longer history says so and is anchored to the true balance. An address too large for the node to total gets a sentence instead ([`FRONTEND.md`](../FRONTEND.md#the-address-balance-chart)) |
| Search | Exact txid, block hash, height, address; Lightning node and channel | Esplora; Lightning store | served | M1 | — | The header finds transactions, blocks, heights and addresses on every network. Lightning nodes and channels are found on `/lightning` and `/lightning/search`, by design ([`FRONTEND.md`](../FRONTEND.md#lightning-pages)). Prefix autocomplete is out of scope |
| RBF `/rbf` | Recent replacement trees, with a full-RBF filter | Engine | served | M2 | ref | The 25 newest trees, each drawn as its line of versions (oldest first, with how long each stood and its rate), what else it removed, the rise in rate, and whether it was mined, not, or unknown after a reorg. Full RBF only is `/rbf?view=full-rbf`. Live through the `replacements` topic |
| Mempool goggles | Filters on the block drawing by transaction kind | Engine flags | planned | M5 | — | Not built. Needs per-transaction flags, which nothing computes yet (`/v1/block/:hash/summary` has none) |

## Transaction tools

| Page | Does | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| Broadcast `/tx/push` | Broadcasts a transaction or a package, with max fee rate and burn limits | rbitcoin `POST /tx`, `POST /txs/package` | skipped | — | ref | Not built: the owner decided on 2026-11-13 against a broadcast page for now. `POST /api/tx` is served; packages are not |
| Test `/tx/test` | Test-accepts transactions without broadcasting | rbitcoin `POST /txs/test` | skipped | — | ref | Not built, and the route is not served: with no broadcast page (the owner's decision of 2026-11-13), test-accept stays unserved too |
| Preview `/tx/preview` | Decodes a pasted transaction or PSBT and shows it as a tx page | Our decoder; prevouts from Esplora | planned | M5 | ref | Not built |

## Mining

| Page | Shows | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| Mining dashboard `/mining` | Reward stats, pool share, hashrate, difficulty, recent blocks, the next and the previous adjustment | Store | served | M3 | ref | `/mining` |
| Mining dashboard: past adjustments | A table of recent retargets | Store | served | M3 | — | On `/mining`: the latest ten, newest first, under the next expected change, and all of them a press away |
| Pool `/mining/pool/:slug` | One pool's share, hashrate chart, blocks | Store | served | M3 | — | Did not finish rendering headlessly on the reference; its API took 58 s for it |
| Pool ranking (`/graphs/mining/pools`) | Pools by blocks over a period | Store | served | M3 | ref | On `/mining`, with its period |

## Graphs

mempool.space puts these under `/graphs`. Ours are hand-drawn SVG (W10) on `/mining` and `/mempool`.

| Graph | Shows | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| Mempool `/graphs/mempool` | Mempool vsize by fee band, and inflow, over time | Store (MI5) | served | M3 | ref | `/mempool`: vsize by fee band and the flow in and out |
| Hashrate and difficulty | Network hashrate and difficulty over time | Store | served | M3 | ref | On `/mining` |
| Pool dominance | Pool shares over time | Store | served | M3 | ref | On `/mining`, week by week |
| Block fees | Average fees per block over time, in BTC | Store | served | M3 | ref | On `/mining` |
| Block fees in fiat | The same, converted | Store (prices) | planned | M3 | ref | Not built; waits on prices |
| Block rewards | Average reward per block over time | Store | served | M3 | ref | On `/mining` |
| Block fee rates | Fee-rate percentiles per block over time | Store | served | M3 | ref | On `/mining`, sub-sat percentiles |
| Block sizes and weights | Size and weight over time | Store | served | M3 | ref | On `/mining` |
| Block health | Audit match rate per block over time | Store (audits) | served | M3 | ref | On `/mining`, with its period: only blocks this server watched arrive, so it says from when and draws the rest as gaps; a point opens its block |
| Lightning graphs | Nodes, channels and capacity over time | Lightning store | served | M4 | — | On `/lightning`: channels and capacity drawn, nodes in the readout |
| Lightning graphs by network type | Clearnet, Tor and unannounced nodes over time | Lightning store | planned | M4 | — | Not built; the split shows in the current totals only. The stored snapshots have it |

## Lightning

| Page | Shows | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| Lightning dashboard `/lightning` | Network totals, top nodes, recent channels, charts | Lightning store | served | M4 | ref | Also the newest closes. The reference runs with Lightning off, so only its page shell was checked |
| Node `/lightning/node/:pubkey` | Alias, sockets, features, capacity, channels | Lightning store | served | M4 | — | No location data |
| Node: fee histogram and history | A node's fee rates and its capacity and channels over time | Lightning store | served | M4 | — | On the node page, from `/app/lightning/nodes/:key` (its `fees`) and `/nodes/:key/history`, the same data as `/api/v1/lightning/nodes/:pubkey/fees/histogram` and `/statistics`. The history starts at this server's first record of the graph |
| Channel `/lightning/channel/:id` | Both policies, capacity, funding and closing transactions | Lightning store; Esplora | served | M4 | — | The funding transaction appears once the server has looked it up ([`LIGHTNING.md`](../LIGHTNING.md#funding-transactions)) |
| Rankings `/lightning/nodes/rankings` | Top nodes by liquidity and connectivity, oldest nodes | Lightning store | served | M4 | ref | `/lightning/rankings?by=capacity\|channels\|age` |
| Country, ISP and group pages | Nodes by location, hosting provider or curated group | — | skipped | — | — | Needs GeoIP or ASN data, or another project's curation |
| World map and channel map | Nodes and channels on a map | — | skipped | — | — | Out of scope |

## Other pages

| Page | Shows | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| Clock `/clock` | Full-screen tip height, price, fee and mempool size | Engine; store | planned | M5 | ref | Not built. All but the price is served today |
| TV `/tv` | Full-screen block strip and mempool chart for a wall display | Engine; store | planned | M5 | — | Not built. Rendered as the home page headlessly on the reference |
| Calculator `/tools/calculator` | Converts between BTC, sats and fiat | Store (prices) | planned | M5 | ref | Not built; the fiat half waits on prices |
| API docs `/docs/api/rest`, `/docs/api/websocket` | Endpoint reference | This inventory | different | M5 | ref | We document our own `/api`, `/api/v1` and WebSocket in our words, in the repository ([`API.md`](../API.md), [`WS.md`](../WS.md)); there is no page on the site |
| FAQ `/docs/faq` | Explainers | — | different | M5 | ref | Our own operator guide (Q4), [`DEPLOY.md`](../DEPLOY.md), in the repository; no explainers on the site |
| About, privacy, terms | Project, sponsors, policies | — | skipped | — | ref | About another project and its business |
| Accelerator pages | Paid acceleration | — | skipped | — | — | Out of scope |

## Site-wide features

| Feature | What it does | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| Network switch | Mainnet, signet, testnet4, Testnet 5 | served | M1 | ref | Plus regtest for development; it lists the networks the server enables |
| Light and dark themes | Theme choice | served | M1 | — | W1 |
| Units | BTC or sats | planned | M1 | — | Not built: amounts are in BTC, with sats beside fees |
| Fiat currency choice | Currency for converted values | planned | M3 | — | Not built. Needs prices, which the owner has parked |
| Time display | Relative or absolute times, local time zone | different | M1 | — | No switch: detail pages show the relative time and the UTC time together; lists show relative times |
| Languages | Translated interface | skipped | — | ref | Out of scope; English only |
| Link previews | Social cards for block, tx and address pages | served | M5 | — | A title and description for every page, without an image ([`FRONTEND.md`](../FRONTEND.md#link-previews)) |
| Liquid | Liquid network and assets | skipped | — | — | Out of scope |
