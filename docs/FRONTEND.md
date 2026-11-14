# Frontend

How the Solid 2 app in `web/` is put together (solid-js and @solidjs/web 2.0.0-rc.21, @solidjs/router 2.0.0-next.44, @solidjs/vite-plugin 3.0.0-next.57: pre-releases, pinned exactly), and the rules that let several people build pages at once without colliding. The visual rules are in [`DESIGN.md`](DESIGN.md); this file is about code.

## Layout

```text
web/
  .oxlintrc.json        Lint rules, and the reason for every rule that is off (see "Checks")
  .oxfmtrc.json         Formatter settings
  tsconfig.json         Shared compiler options; tsconfig.app.json (browser) and tsconfig.node.json extend it
  index.html            The shell document: preloads the font, runs public/boot.js, loads src/index.tsx
  public/boot.js        Runs before first paint: applies a stored theme and the network (see "Theme")
  scripts/check-size.js First-load budget check (`bun run size`)
  scripts/e2e.sh        Browser tests in one command (`bun run e2e`)
  e2e/                  Browser tests (Playwright) and their fixtures
  src/
    index.tsx           Waits briefly for the font, then mounts the router
    routes.ts           The route table: every page, on every network
    styles/global.css   Layer order, reset, base and layout. Imports nothing; tokens come from design/
    lib/                Pure logic and hooks, no markup
      format.ts         Amounts, fee rates and bands, sizes, hashes, times
      network.ts        Networks, prefixes, `paths` for every page
      address.ts        An address's type and networks from its form (the address page and search)
      api.ts            HTTP client, and `createApi` and `createRequest` for components
      live.ts           The WebSocket client: `useTopic`, `useLiveStatus` (see "Live data")
      blocks-topic.ts   The `blocks` topic: its messages and how to keep a block list current
      projected-topic.ts The `projected` topic: every projected block's totals and the tip they sit on
      projected-txs.ts  The `projected-txs:N` topics: binary frames, and a block's transactions kept from them
      mempool-topics.ts The `mempool` and `transactions` topics: their messages, rates in sat/vB
      track-topics.ts   The `tx:<txid>` and `address:<address>` topics: following one transaction or address
      replacements.ts   Replacement trees read as stories, the `replacements` topic, and the list kept current
      summary.ts        Block summaries: their type, a check, a page-wide cache and the batch fetch
      fakes.ts          Test stand-ins: a fake WebSocket and made-up blocks
      esplora.ts        Types for the Esplora replies pages use
      page.ts           `useNetwork`, `usePageTitle`
      clock.ts          Shared ticking clock for relative times
      difficulty.ts     The difficulty-adjustment reply and how it reads (the home and mining pages)
      config.ts         Reads `/app/config`
      chunks.ts         A page's code and styles that failed to download, and asking for them again
      theme.ts          Theme toggle state
    components/         Shared components, one CSS file each
      txgrid/           The transaction grid: decoder, layout, animation, WebGL2 renderer (see "Transaction grid")
      chart/            Time-series charts in SVG: scales, ticks, paths, the component (see "Charts")
      audit/            A block's audit: the block page's section, its list loaded on demand, the reader (see "Block audits")
    shell/              Header, network switch, theme toggle, band, footer, the frame around pages
    search/             What a query is (query.ts) and where it leads (search.ts); loaded on first use
    pages/<page>/       One directory per page: its routes, component, CSS and tests
```

## Routing

`@solidjs/router`. `index.tsx` makes the router with `createRouter({ routes, scrollRestoration: false })` (the browser restores scroll on back and forward) and renders the shell as its render-prop child. Mainnet pages are at the root and the other networks under `/signet`, `/testnet4` and `/regtest`, matching the server ([`ARCHITECTURE.md`](ARCHITECTURE.md)). `src/routes.ts` mounts every page's routes under all four prefixes, so a page is written once with network-free paths (`/tx/:txid`) and works on every network. The server sends the app shell for any page path, so deep links and reloads work; a disabled network's paths are a 404 from the server.

The network comes from the path. `useNetwork()` returns it; never keep it anywhere else.

| Page | Path | Directory | Built in |
|---|---|---|---|
| Home | `/` | `pages/home` | W2 |
| Block | `/block/:id` (hash or height) | `pages/block` | W3 |
| Blocks | `/blocks`, `/blocks/:from` (paging back from a height) | `pages/blocks` | W3 |
| Projected block | `/block/next`, `/block/next/:n` (2 to 8 places from now; 8 is the rest of the mempool) | `pages/projected` | W8 |
| Transaction | `/tx/:txid` | `pages/tx` | W4 |
| Address | `/address/:address` | `pages/address` | W5 |
| Mining | `/mining`, `/mining?period=24h\|1w\|1m\|1y\|all` | `pages/mining` | W9 |
| Mining pool | `/mining/pool/:slug` | `pages/mining` | W9 |
| Lightning | `/lightning`, `/lightning?interval=24h\|1w\|1m\|3m\|1y\|all` | `pages/lightning` | W11 |
| Lightning node, channel | `/lightning/node/:key`, `/lightning/channel/:id` | `pages/lightning` | W11 |
| Lightning search, rankings | `/lightning/search?q=`, `/lightning/rankings?by=capacity\|channels\|age` | `pages/lightning` | W11 |
| Mempool history | `/mempool`, `/mempool?interval=2h\|24h\|1w\|1m\|3m\|6m\|1y\|2y\|3y\|4y\|all` | `pages/mempool` | FE9 |
| Replacements | `/rbf`, `/rbf?view=full-rbf` | `pages/mempool` | G4 |
| Not found | anything else | `pages/not-found` | shell |

Every page is loaded lazily.

### Adding a page or a route

1. Create `pages/<page>/` with `<Name>Page.tsx` (default export) and `routes.ts`:

   ```ts
   export const routes: RouteDefinition[] = [
     { path: "/blocks", component: lazy(() => import("./BlocksPage")) },
   ];
   ```

2. Spread `routes` into the list in `src/routes.ts`, before `notFound`. That one line is the only edit outside your directory.

Sub-pages (`/mining/pool/:slug`) go in the same `routes.ts`; you never touch `src/routes.ts` again.

### Links

Internal links stay on the current network. Use `<Link href={paths.tx(txid)}>` from `components/Link.tsx`; it adds the prefix and the router handles the click. The router handles every same-origin `<a>` and marks the ones that match the location: `aria-current="page"` on an exact match (it never touches an `aria-current` you set) and `data-active` on a match by path. Give an in-page `#` link `rel="external"`, as the skip link has, so the browser scrolls to it and it is not announced as the current page. Build every path with `paths` in `lib/network.ts`, which encodes chain data into a single path segment so it can never change the route or the scheme ([`SECURITY.md`](SECURITY.md) rule 14). Add a function to `paths` for a new page rather than writing the path by hand. To navigate from code: `navigate(onNetwork(network(), paths.block(h)))`.

### Page title

Call `usePageTitle(() => "Block 975 411")`. Test networks get their name in front, and every title ends in `| rbitcoin.space`.

### Link previews

A chat app or site that a link is pasted into fetches the page and reads its head without running any script. So the server fills in the shell's head per path (`crates/server/src/pages.rs`): it replaces the build's `<title>` element with the page's title and a one-line description, as `<title>`, `<meta name="description">`, `og:title`, `og:description`, `og:type` (`website`), `og:site_name` and `twitter:card` (`summary`, as there is no image yet). Those are the names Open Graph readers (most chat apps) and summary-card readers look for. Every other byte of the shell is the build's, and the app replaces the title as it does on any load.

- **The wording is in two places, held equal by a test.** A page's title comes from its own `usePageTitle` call; the server's table in `pages.rs` writes the same title for each page kind, and `e2e/preview.e2e.ts` loads every page with the served title blanked and checks the page sets back exactly the server's. Change a page's title and that test fails until `pages.rs` says the same. The descriptions are the server's alone.
- **Nothing is asked of the node.** A description uses the path's parsed identifier, the network, and what the server already holds: a block's time, miner, transaction count and fees from the block table, and a Lightning node's alias, channels and capacity from the graph in memory. A block by hash the table does not hold is named by its hash, as its page is until it loads; past two table reads at once, server-wide, a block's head goes without its facts.
- **Identifiers are parsed, then escaped.** Each is parsed into its type with the API's own parsers (a txid or block hash is 64 hex digits, a height 1 to 10 digits within `u32`, an address parsed for the network, a key 66 hex digits, a channel id in its canonical forms, a pool slug the pool list knows) and only that value is written, through an HTML escaper. A path that does not parse gets the shell as built. An alias is cleaned as `cleanAlias` cleans it (control and format characters to U+FFFD, stacked marks thinned, with tables in `pages.rs` generated from the JavaScript engine's own `\p{Cf}` and `\p{M}` (Unicode 17.0)), then escaped; with no name left the title uses the key's first 20 digits, as the page does. The rankings page's `by` is read decoded, first one only, as `URLSearchParams` reads it.
- **No absolute URL.** The server is not told its public address and never takes one from `Host`, so there is no `og:url` or canonical link. An image, when there is one, will need the address as a setting.
- **Caching.** Pages are `Cache-Control: no-cache`, as the shell was: the head depends on the URL alone, which every cache keys on, so no cache shows one page's head on another, and a deploy shows at once. The shell is read once at start and templated per request in microseconds; a new frontend means a restart, which a new image is. Pages are not sent precompressed any more: the shell is about 1.3 KB.

## Data

### The public API

`lib/api.ts` is the only way pages talk to `/api`. Paths are relative to the network's API, so the same code works on every network.

```tsx
const params = useParams<{ id: string }>();
const [block] = createApi<Block>(() => `/block/${encodeURIComponent(params.id)}`);

<Show when={block()} fallback={<Loading label="Loading block" />}>
  {(b) => <h1>Block {groupDigits(b().height)}</h1>}
</Show>
```

- `createApi<T>(path, { as: "text" })` returns `[request, { refetch }]`. `request()` is the answer: undefined before the first, the last one while it asks again, and it throws once the last attempt failed, so read `request.state` (`unresolved`, `pending`, `ready`, `refreshing`, `errored`) first where a failure is expected; `request.error`, `request.loading` and `request.latest` are there too. It asks again when the path or the network changes, aborts the request it replaces and the one in flight when the page unmounts, answers from the cache without a network request, and stays loading while a busy refusal waits to be retried. Return a falsy path to wait for something else first. With `{ fresh: true }` every answer comes from the server, never from the browser's HTTP cache, for a request a live message prompted ([Following live data](#following-live-data)); without it, `refetch` of the same path is fresh and a first ask may come from the cache. `createRequest(source, (source, signal) => …)` is the same for a fetcher of your own (the block page's summary and transaction records).
- `fetchApi<T>(network, path, { as, signal, fresh })` is the same call as a promise, for event handlers and loops. `fetchApp<T>` is the same for the app's own API under the network's `/app`.
- **Chain-tip stamps.** `createApi<T>(path, { stamped: true })` and `fetchStamped<T>(network, path)` give `{ value, tip }`, where `tip` is the `X-Bitcoin-Chain-Tip` and its height that the reply is as of (undefined for an unstamped or cached reply). Take every figure that depends on the tip from one stamped reply, or compare the stamps of two: the block page counts confirmations from its status reply's stamp, and the home page's difficulty panel asks again while its answer's stamp trails the strip's tip.
- **Busy servers.** Every call above retries a 503 or 429 by itself, no sooner than its `Retry-After` (kept on `ApiError.retryAfter`), backing off from 1 to 30 s with a little jitter, six times, then rejects with the last error. They are all GETs, safe to repeat. Five 503s are not retried, because a retry cannot change them: an address too large to total, an address index that is off ([`API.md`](API.md#error-bodies-are-ours)), mining history on a server without a block table ([`API.md`](API.md#mining)), mempool history on a server without a data directory ([below](#mempool-history)), and the relatives and replacements routes (`/app`'s and `/api/v1`'s) on a network whose mempool engine is switched off. Show a loading state, not an error, while a call is pending. `withRetry(call, signal)` is the loop itself, for a call that does not go through `api.ts`; only wrap a call that is safe to repeat. A refusal it already gave up on is never retried by a loop around it. The browser still logs each refused request to the console; browser tests that may meet one allow `/status of (429|503)/`.
- **Coverage.** A history answer (the mining routes) says how far back its data reaches in `X-Data-From-Height`, `X-Data-From-Time` and `X-Data-Complete` ([`API.md`](API.md#coverage)). A stamped reply carries them as `coverage: { fromHeight, fromTime, complete }` when sent (`readCoverage` reads them). Say "data from … onward" where `complete` is false; never draw the missing stretch as zero.
- `as: "text"` reads plain-text replies (`/blocks/tip/height`, `/block-height/:h`, `/tx/:txid/hex`), and `as: "bytes"` binary ones as an `ArrayBuffer` (`fetchApp(n, "/block/<hash>/txs", { as: "bytes" })`). The default is JSON.
- Failures are `ApiError` with `status` (0 when the server cannot be reached, with a message that says so when the browser is offline) and a message fit to show. `isNotFound(e)` tests for 404. An abort is passed through as the abort error, not as an `ApiError`.
- Replies the server marks as never changing (`immutable`, or `max-age` of a day or more) are kept in memory, at most 256, for the life of the page. Everything else is fetched every time and left to the browser's HTTP cache.
- A request never suspends: the page frame shows at once and each section fills from `state` as its data arrives. Pages do not use Solid 2's async memos (`createMemo` returning a promise): read inside the shell's `<Loading>`, one would hold the whole page until it loads. The shell's `<Loading>` waits only for a page's code.
- An error thrown while rendering reaches the shell's `<Errored>` boundary, which shows "This page could not be shown". Catch expected failures (not found, node unavailable) in the page with `<ErrorState>` instead.

### When a page's files fail to load

Every page, and the transaction grid, is a chunk of code with its own stylesheet, downloaded on first use. A download can fail: a dropped connection, a busy proxy, or a deploy that replaced the files while a tab was open. Vite never asks for a failed stylesheet again by itself, so `lib/chunks.ts` notes every `<link rel="stylesheet">` and `<link rel="modulepreload">` (Vite preloads a page's code and its imports with one) that fails (`watchFiles`, started in `index.tsx`), and `retryFiles()` asks for each stylesheet again through a fresh `<link>` and for each script with a request that skips the cache, which proves it downloads now. The script itself is loaded again when its `import()` runs again, which the router's `lazy()` does on the next render. WebKit never does: once a script's preload or import failed, it answers every later `import()` of that script, and of any module that imports it, with the same failure and no request, for the life of the document (Playwright's WebKit 2370, checked against a 503 from a real server). Chromium and Firefox ask again.

The shell's `<Errored>` boundary handles both. On a chunk error it shows "Loading this page" and tries again after 1, 2 and 4 s: before each attempt it asks `/app/config` (never from a cache) whether the server's version changed since the tab loaded, then asks again for the failed files, and renders the page again only once they are in, so a page never appears unstyled. If the page fails to load again within 2 s of an attempt that proved its scripts download, the browser is holding on to the failure, and the page reloads (`reloadOnce`): that is how WebKit recovers. It reloads at most once a minute per tab, kept in session storage, so a file that downloads but never runs cannot loop; without session storage it does not reload, and the reader gets "Try again" as before. When the attempts run out it says that part of the page could not be downloaded, with "Try again", which asks for everything again. When the version changed, the files this tab needs were replaced by a deploy: it says the site has been updated and offers "Reload" rather than retrying files that are gone. A navigation starts the count afresh.

`lib/esplora.ts` has hand-written types for the replies pages use, from rbitcoin v0.9.2's `docs/esplora-openapi.yaml`. Add a type when you use a new route; keep the field names exactly as the API sends them. Amounts are integer sats and times are unix seconds throughout.

During development, `bun run dev` proxies `/api`, `/app` and `/healthz` to the Rust server at `LISTEN_ADDR`.

### The app's own API

`GET /app/config` answers `{"networks": ["mainnet", "signet"], "version": "0.1.0"}`: the enabled networks in server order, and the server version. It is server-wide, so it is served at the root only, whichever networks are enabled (`crates/server/src/app_config.rs`). The shell reads it once for the network switch and the footer. If the root's network (mainnet) is disabled, the shell moves to the same page on the first enabled network.

#### Block summaries

What the public API cannot give cheaply: a mined block's fee facts and every transaction's fee and size. Per network, under its `/app` (`crates/server/src/summary.rs`).

| Route | Answer |
|---|---|
| `GET /app/block/:hash/summary` | The block's facts, JSON (below) |
| `GET /app/block/:hash/txs` | Every transaction as a fixed-width binary record (below) |
| `GET /app/blocks/summary?hashes=<hash>,<hash>,…` | 1 to 10 blocks' facts, a JSON array in the order asked. Repeats are allowed |

```json
{
  "id": "00000000000000000000e13ad5e424f6ba7208b0c1a9a687e9ccc4d62b3b094c", "height": 975511,
  "tx_count": 4198, "fees": 1475029, "vsize": 999391, "weight": 3991349,
  "fee_rate": {"min": 0.10071942446043165, "p10": 0.12, "p25": 0.12698412698412698,
    "median": 1.0850888512305468, "p75": 2.007012551450785, "p90": 3.150749063670412, "max": 62.10091743119266},
  "fee_bands": [301870, 52011, 13132, 9447, 153, 5069, 233233, 20986, 238267, 102460, 17310, 5453],
  "miner": {"name": "Foundry USA", "slug": "foundryusa"},
  "audit": {"match_rate": 99.87, "expected": {"txs": 3100, "vsize": 998000, "weight": 3991200, "fees": 1500000}, …}
}
```

- `tx_count` counts every transaction. Everything else leaves the coinbase out, as `getblockstats` does: `fees` in sats, `vsize` and `weight` summed over the paying transactions.
- `fee_rate` is in sat/vB, unrounded, `null` for a block holding only its coinbase. Percentiles are weighted by virtual size: `p25` is the rate of the transaction where the cheapest quarter of the block's vbytes ends. Print them with `formatFeeRate`.
- `miner` is who mined the block, by the pool list's rules ([`API.md`](API.md#who-mined-a-block)): a payout to a listed address first, then a listed tag, else `{"name": "Unknown", "slug": "unknown"}`. `name` is the list's spelling and `slug` its pool page (`paths.pool`); a coinbase tag only selects one of the list's names and is never itself the answer. It comes from the stored row's coinbase, or from the coinbase the summary's block listing already reads, so it costs no extra node call and a server without a block table names miners too. A server older than this field leaves it out: say the miner is not known.
- `audit` is the block's health: its audit's totals ([Block audits](#block-audits) below), or `null` when it has none. A new block's summary is computed with its audit, so the `summary` message and the first fetch already carry it; `null` stays `null`. A server older than this field leaves it out: treat that as `null`.
- `fee_bands` is the virtual size paying in each of the twelve design bands, cheapest first: the strata. A block stored before the lowest band was split carries ten, all under 0.2 sat/vB in the first; `widenBands` (`lib/format.ts`) reads either, and the strata name that first band "under 0.20 sat/vB" ([`DESIGN.md`](DESIGN.md#fee-scale)). They sum to `vsize`. Each transaction is banded on its rate as printed, as `feeBand` does, so a stratum's color agrees with the numbers beside it. How full the block is comes from the block's own `weight` (Esplora) over 4,000,000.

`/txs` is `application/octet-stream`, little-endian: an 8-byte header, then one 20-byte record per transaction in block order, the coinbase first.

| Offset | Size | Field |
|---|---|---|
| 0 | `u32` | Format version, `1` |
| 4 | `u32` | Record count, `tx_count` |
| 8 + 20·i | `u32` | Virtual size of transaction `i` |
| 12 + 20·i | `u64` | Fee in sats; 0 for the coinbase |
| 20 + 20·i | `u64` | Total output value in sats |

Read it with a `DataView`; a `u64` here is below 2^53, so `Number(view.getBigUint64(o, true))` is exact. A record has no txid: when a square is hovered or clicked, ask `/api/block/:hash/txid/:index`, which is cached for good. Mainnet block 975 511, 4,198 transactions, is 83,968 bytes: 16.6 KB gzipped and 12.7 KB with brotli, if the proxy in front compresses (the server itself does not). The facts are about 400 bytes. Check the version before reading; a different one means a newer server and a page that needs a reload.

**In the frontend.** `lib/summary.ts` has the type, `isSummary`, and `fetchSummaries(network, hashes, signal)`, which asks for up to ten at a time with `withRetry` and keeps every summary it sees, fetched or pushed, for the life of the page (`knownSummary`). The home page asks for its ten tiles in one batch on first paint and then takes each new block's from the WebSocket, asking over HTTP only if the push has not come within 4 s. Older tiles, as the strip scrolls into the past, are asked for once it stops ([The block strip's past](#the-block-strips-past)). The blocks list (25 a page, from three of the API's ten-block answers) asks per row, two at a time, so an old page fills in row by row. Draw the bands with `Strata`, and the records with the transaction grid below. The home strip's and the mining page's tiles put `miner.name` on the line under each tile (`aria-hidden`, its space always kept) and in the tile link's text; the block page links it to the pool's page.

**Caching.** A summary is fixed by its hash, so success is `Cache-Control: public, max-age=31536000, immutable`, and `api.ts`-style in-memory caching is right. Errors are `no-store`.

**Cost and limits.** A block in the block table with its fee rates ([`STORE.md`](STORE.md#blocks)) costs nothing: once backfilled, the facts of the last year's blocks come from there. `/txs` always needs the node. An uncached block costs the node a block listing: about 60 ms and 0.3 MB on mainnet where the node has the listing route, a heavy call (about 0.7 s and 10 MB) where it does not ([`RBITCOIN.md`](RBITCOIN.md#listing-a-blocks-transactions)), so:

- Concurrent requests for one block share one computation, and the facts and the records come from the same one.
- The newest ten blocks are computed as they arrive, so the home page's tiles are always cached. A new block's facts are also pushed on the WebSocket as a `summary` message; use that rather than fetching.
- Each network computes one block at a time, and holds at most six started by clients. Past that the answer is `503` with `Retry-After: 1`. Retry: the work already admitted goes on, so a retry finds more of it cached. A cold batch of ten needs a retry or two.
- Each client may start ten computations at once, then one every 2 s; past that `429` with `Retry-After: 2`. Cached blocks never count. A page walking back through history should fetch tiles lazily, as they scroll into view.
- `404` is an unknown block, `400` a malformed hash or query, `502` and `504` the node failing. All are worth a "Try again".

#### Block audits

How a block compared with the block we expected on its parent, for the block page's expected-against-mined view and a tile's health. The method and the meaning of each category are in [`MEMPOOL.md`](MEMPOOL.md#block-audits); read it before labelling anything. Per network, under its `/app` (`crates/server/src/audits.rs`).

| Route | Answer |
|---|---|
| `GET /app/block/:hash/audit` | The whole audit, JSON (below). `404` when the block has none, `503` on a server without a block table |

The totals, the same object as the facts' `audit` (which leaves out `id`, `height`, `time`, `seen_at`, `txs` and `complete`):

```json
{
  "id": "…", "height": 975540, "time": 1794480000, "seen_at": 1794480003,
  "match_rate": 99.87,
  "expected": {"txs": 3100, "vsize": 998000, "weight": 3991200, "fees": 1500000},
  "actual": {"txs": 3150, "vsize": 997500, "weight": 3990000, "fees": 1498000},
  "matched": {"txs": 2900, "vsize": 950000},
  "missing": {"txs": 3, "vsize": 1200}, "displaced": {"txs": 40, "vsize": 9000},
  "fresh": {"txs": 150, "vsize": 35000}, "conflicted": {"txs": 7, "vsize": 2000},
  "added": {"txs": 60, "vsize": 9500}, "unseen": {"txs": 1, "vsize": 200},
  "txs": [{"txid": "…", "kind": "missing", "vsize": 400, "rate": 1250, "first_seen": 1794479000}],
  "complete": true
}
```

- `match_rate` is percent with two decimals, rounded down: 100 means nothing was left out without an innocent cause. Only `missing` lowers it. Print it as is; do not round it up.
- `expected` is our first projected block on the parent; `actual` the mined block without its coinbase. `vsize` is sigop-adjusted on the expected side and `ceil(weight / 4)` on the mined side, so the two can differ by a little for the same transactions. Fees in sats.
- Each category is `{txs, vsize}`. `matched` + `missing` + `displaced` + `fresh` + `conflicted` is the expected block; `matched` + `added` + `unseen` the mined one.
- `txs` lists every transaction in a category other than `matched`, the most telling first (`missing`, `unseen`, `added`, `displaced`, `conflicted`, `fresh`), highest rate first within each, at most 1,000. `complete` is `false` when that cap cut the list. `kind` is the category. `rate` is sat per 1,000 vB: the rate we placed it at for the expected kinds, its own fee over its size for `added` and `unseen`. `first_seen` (Unix seconds) is our node's accept time, present only for expected kinds still in our mempool after the block. Matched transactions are not listed: draw them from the block's own records (`/txs`) and the txids from `/api/block/:hash/txids`.
- No audit is a state to show, not an error: "not audited: this server was not watching when it was mined" (or the projection was stale). It never appears later.

**In the frontend** (`components/audit/`). `model.ts` reads the totals with `readAudit(summary.audit)`, which gives `null` for `null`, a missing field (an older server) or a shape it cannot draw, and the detail route with `readAuditDetail`, which drops entries it cannot read. It also holds each category's name and plain-words meaning (`CATEGORIES`), the same words as [`MEMPOOL.md`](MEMPOOL.md#categories): use them wherever a category is named. `formatMatchRate` prints the score as sent, two decimals, never rounded up.

- **The block page** shows `AuditSection` below the map and facts, from the summary it already has: the match rate, the expected block against the mined one (transactions, virtual size, fees), the two laid side by side with their matched parts lined up, and every category with its count and size ("None" when empty) and what it means; on a phone the meanings wait behind one "What each kind means" button, the counts in sight. Without an audit it says so in one muted line, with no figures. A new block's facts can reach the page over the WebSocket before its own request answers, so while the facts are on their way the page listens to `blocks` and takes a `summary` for its block from there.
- **The list** (`AuditList.tsx`) is a lazy chunk, fetched with `/app/block/:hash/audit` only when the reader asks. It shows one category at a time, the server's most telling first, each transaction linked to its page, and says when the server cut it at 1,000 and how many of a category it lists.
- **The blocks list** has a "Match rate, %" column, blank for a block without an audit, on wide screens; a phone keeps the miner and the transaction count instead.
- **The mining page's block health** (`pages/mining/Health.tsx`) charts each audited block's match rate over the page's period, from the public `/api/v1/mining/blocks/predictions/:interval`, on an axis from 0 to 100%, so a block that matched badly is a notch down from the top. A block without an audit between two that have one is a gap, never a line drawn across it, however long miners took; past 1,000 blocks in the period a point is the lowest of a run of blocks, so a bad one still shows, and opens that one; a run missing a block breaks the line after it, and its readout says how many of the run were audited. The route says nothing of coverage, so the page says it from the answer: the caption counts the audited blocks in the period, one short line gives their share of the period's blocks (the pools' count, only when that answer covers the whole period: a history still filling in counts fewer) and the first one's time, and the period before it is hatched. A point opens its block: a click, a second tap on the point a finger picked, or Enter on the focused chart; its row in the figures links there too.
- **Past difficulty adjustments** (`pages/mining/Adjustments.tsx`) list `/api/v1/mining/difficulty-adjustments` newest first, the latest ten and then all of them a press away (mainnet has about 480, so one list, not pages), under the next adjustment's expected change from `/api/v1/difficulty-adjustment`. A change reads as an arrow and a word ("↑ Up 5.54%"), as the home page's does; each row opens the block that began the period. They do not follow the period: they are every retarget stored. Regtest's list is empty and says the network never adjusts.
- **The grid is not tinted by category.** Its records have no txids, so marking audited transactions would mean fetching every txid of the block, and color in the grid carries fee and nothing else ([`DESIGN.md`](DESIGN.md#principles)). The list is the way in.

**Caching.** An audit is fixed once written: success is immutable, and a `404` is `no-store` but final in practice.

**Cost.** One indexed read, no node call, kept in memory until the next write to the audits or the block table ([`API.md`](API.md#answers-kept-in-memory)); at most about 60 KB of JSON for a capped list.

#### A transaction's relatives and replacements

For the transaction page: who it will be mined with, and what replaced what. Per network, under its `/app` (`crates/server/src/relatives.rs`, `crates/server/src/replacements.rs`). Both answer from the server's memory and never ask the node, so they are cheap and need no caps beyond the ordinary request limits. Both are `Cache-Control: no-store`: the mempool moves.

| Route | Answer |
|---|---|
| `GET /app/tx/:txid/relatives` | A mempool transaction's cluster, its chunks and its parents and children (below) |
| `GET /app/tx/:txid/replacements` | What this transaction replaced and what replaced it, as far as the server remembers (below) |

**Relatives.** The cluster is the node's own (`getmempoolcluster`), as the projected blocks last asked for it: at most one mempool update behind. Which member spends which is read from the transactions' inputs.

```json
{"txid":"<parent>","stale":false,"chunk":0,
 "parents":[],"children":["<child>"],
 "chunks":[{"fee":3314,"vsize":265,"rate":12505,"txs":["<parent>","<child>"]}],
 "txs":[{"txid":"<parent>","chunk":0,"time":1794467650,"fee":139,"vsize":139,"block":0,"parents":[]},
        {"txid":"<child>","chunk":0,"time":1794467650,"fee":3175,"vsize":126,"block":0,"parents":["<parent>"]}]}
```

- `chunks` are the cluster's mining chunks in the node's order, best first; `chunk` is the index of the one holding this transaction. A chunk is mined whole, at its `rate`: that is the "effective fee rate" (CPFP). `fee` is the node's chunk fee, `prioritisetransaction` included; `vsize` is the chunk's sigop-adjusted size. A chunk can count a member the server has not seen yet, in the moment after it arrived, so `fee` and `vsize` can exceed the sum of `txs`.
- `txs` are the members in mining order with their own figures, the chunk they are in, their projected block (`null` before the projection places them) and their parents inside the cluster. `time`, `fee` and `vsize` are `null` for a member that left a moment ago.
- `parents` and `children` are this transaction's own unconfirmed ones. Their parents and children are in `txs`: draw the graph from there. A cluster holds at most 64 transactions.
- `404` `{"error":"not in the mempool"}`; `503` with `Retry-After: 1` for `mempool is syncing` (the server just started), `not placed yet` (it arrived a moment ago) or `mempool is switched off` (no retry will help); `400` for a malformed txid.

**Replacements.** A bounded record per network: the most recent `REPLACEMENTS_KEPT` (10,000) replacements, oldest out first, kept in memory and, with a `DATA_DIR`, in the store, so it survives a restart ([`MEMPOOL.md`](MEMPOOL.md#following-a-transaction)). Someone who opens a replaced transaction's page later still learns what replaced it.

```json
{"txid":"<B>","truncated":false,
 "replaced_by":[{"txid":"<B>","by":"<C>","seen":1794467700,"fee":695,"vsize":139,"rate":5000,"by_fee":2000,"by_vsize":139,"by_rate":14388}],
 "replaces":[{"txid":"<A>","by":"<B>","seen":1794467643,"fee":139,"vsize":139,"rate":1000,"by_fee":695,"by_vsize":139,"by_rate":5000}]}
```

- `replaced_by` follows this transaction forward to the newest replacement known, oldest link first. The last link's `by` is the one to show.
- `replaces` walks backward: what this one replaced, and what those replaced, newest first. A replacement can replace several transactions at once (a transaction and its children: a child leaves with its replaced parent and carries the same replacement).
- Each link: `seen` is when the server saw it (Unix seconds); `fee`, `vsize` and `rate` are the replaced transaction's own, `by_*` the replacement's, `null` when the replacement was confirmed in the block that removed the original. At most 32 links each way; `truncated` says there were more.
- Empty lists mean the server saw no replacement since it started, not that there was none. `503` with the mempool engine switched off; `400` for a malformed txid.

#### Mempool history

For the mempool chart: the mempool's size by fee band through the day, the week and the year, and what flowed through it. Per network, under its `/app` (`crates/server/src/statistics.rs`), from the server's history table, never the node ([`STORE.md`](STORE.md#mempool_history)). The public form in the reference's shape is `/api/v1/statistics/:interval` ([`API.md`](API.md#mempool-statistics)); this one keeps our twelve bands, which the public one cannot.

| Route | Answer |
|---|---|
| `GET /app/mempool/history/:interval` | `interval` is `2h`, `24h`, `1w`, `1m`, `3m`, `6m`, `1y`, `2y`, `3y`, `4y` or `all`; anything else is `400` |

```json
{"interval":"2h","from":1794471360,"to":1794478503,"step":60,"first":1794477420,
 "minutes":119,"sampled":18,"complete":false,
 "points":[…,
  {"time":1794478500,"samples":1,"count":77664,"vsize":35034159,"fees":12561492,"min_fee_rate":100,
   "bands":[31473971,42955,44248,93275,1645692,162368,510336,793829,206603,60882],
   "in_count":111,"in_vsize":32392,"out_count":7,"out_vsize":2054,"mined_count":0,"mined_vsize":0}]}
```

A mainnet server 18 minutes after its first sample (keys are sent in another order).

- `points` are oldest first, one per `step` seconds (60 for `2h` and `24h`, 600 for `1w`, 3,600 for `1m`, up to whole days for `all`; never more than 1,460). `time` is the step's start, Unix seconds. **A step the server did not sample has no point**: draw a gap where consecutive `time`s differ by more than `step`, never a line across it and never a zero.
- Every value is the **mean over the minutes sampled in the point**, and `samples` says how many (at most `step / 60`). A point with fewer samples than that is partly covered; it is still a fair mean of what was seen.
- `count`, `vsize` (sigop-adjusted vB) and `fees` (sats) are the whole mempool. `bands` is the virtual size in each of the twelve fee bands of [`DESIGN.md`](DESIGN.md#fee-scale), cheapest first, by effective rate: stack them, colored with the fee scale, and they sum to `vsize`. A point recorded before the lowest band was split has ten, all under 0.2 sat/vB in the first: `seriesOf` keeps that as its own layer, drawn until the three finer ones begin. `min_fee_rate` is the node's minimum, sat per 1,000 vB like every rate the WebSocket sends (`100` is 0.1 sat/vB).
- The flow is per minute: `in_count` and `in_vsize` entered the mempool, `out_count` and `out_vsize` left it for any reason, and `mined_count` and `mined_vsize` are the part of what left that a block confirmed. Arrival in vB/s is `in_vsize / 60`. Over a minute, `vsize` moves by about what entered less what left (the totals come from the projected blocks, a moment behind the flow).
- **Coverage.** `first` is the oldest time stored (`null` with none): history begins when the server first ran with its mempool engine on. `from` and `to` are the period answered; `minutes` is how many whole minutes it owes and `sampled` how many it has; `complete` is `true` only when none is missing. The same is in `X-Data-From-Time` and `X-Data-Complete`. Say "since …" when `first` is after `from`, and show holes as holes.
- A new sample lands each minute, about a second after the minute turns; polling a chart every minute is plenty. The first minute after the server starts is never stored (its flow was not watched whole), so the first point appears 60 to 120 s after a start. `Cache-Control: public, max-age=1`. `503` with `Retry-After: 1` when the server has no data directory (`mempool history needs a data directory on this server`; no retry helps) or its store is busy; an empty `points` with `first: null` when it has stored nothing yet.

**In the frontend** (`pages/mempool/`): `history.ts` has the type, `isHistory`, the intervals, the coverage and flow sentences, and `seriesOf`, which turns an answer into the charts' arrays; the page and its tests are beside it.

- **The page is `/mempool`**, the interval in `?interval=` (24 hours by default), so a link reproduces the view. The header's Mempool section and the home page's mempool panel link to it. Its foot is the recent replacements panel ([below](#replacements)), the way to `/rbf`. With no interval in the address, a view whose records begin inside it starts where they do (`fit`), says "Recorded since …", and the picker marks a "Recorded" choice as current; a chosen interval keeps its whole width and hatches the time before the records.
- **Two charts.** The size, stacked by fee band in the fee colors with the total as a line on top, and the count, the node's minimum rate and (for steps over a minute) the minutes behind the point in the readout only (`notes`). Then the flow in vB a second: what arrived as a line over what blocks mined and what left otherwise as stacked layers, so a line above the layers is a filling mempool; a sentence above says which way the whole period went, weighted by the minutes behind each point.
- **Gaps** are the chart's `gap`, five steps here: up to five missing minutes are drawn across, a longer pause breaks the line into two runs. A lone minute is a sliver, not nothing. Before the step that holds `first` (its point is drawn at the step's start), the chart hatches the period, and a sentence says since when and how many of the period's minutes it holds; when recording began before the period, it says the gaps are times the server was not recording. `all` begins at the day holding `first` and owes only the minutes since it, so it always says since when, even when `complete`.
- **The live edge** is a refetch 3 s after each minute turns, not the `mempool` topic: the newest point is then exactly what the server stored, a mean of the minute, with no second model of it to keep in step. The last answer stays on screen, dimmed, while the next loads.
- **States:** loading; `503` without a data directory, said as such and not retried; nothing stored yet (the first minute appears by itself); nothing in this period, with the time records begin and a link to all of them.
- **Cost,** measured in Chromium at 4× CPU throttling on an Apple M4: 62 to 93 ms from the reply to the drawn chart for 1,415 points, 37 to 55 ms to redraw them on a width change, and the readout holds 60 fps while the pointer sweeps the chart.

#### Replacements

`/rbf` and the recent replacements panel (the home page's last panel, and the foot of `/mempool`) read the public `/api/v1/replacements` and `/api/v1/fullrbf/replacements` ([`API.md`](API.md#replacement-trees)); `pages/mempool/` holds the page (`RbfPage.tsx`), the panel (`RecentReplacements.tsx`) and the mined status they share (`Status.tsx`), and `lib/replacements.ts` the rest. The home page loads the panel's code lazily: it is the last panel, below the fold at every width, and its list waits for the topic anyway, so a cold home page stays at ten files.

- **A tree is read as a story** (`storyOf`): its line of versions, oldest first, following from the newest back the replaced transaction whose own history runs deepest (the earliest on a tie), so a chain of bumps is one line; everything else the tree removed (children that left with a replaced parent, other conflicts) is listed as also replaced. Each version carries how long it stood (the tree's `interval`). `rise` is the newest rate less the oldest. `mined` is `mined`, `waiting` (the field absent) or `unknown` (`null`: a reorg took its block away). `readTree` drops a list entry it cannot read; it reads trees as deep as the server sends them (at most 100 transactions).
- **Live** (`createReplacements`): the page subscribes to the `replacements` topic ([`WS.md`](WS.md#replacements)) and asks for the list when the version changes, from the server, never the browser's cache ([Following live data](#following-live-data)), and no sooner than `gapMs` after that list was last asked for or answered by any feed on the page (1.5 s on `/rbf`, 10 s for the panel, a glance), so a burst of replacements costs one ask; the topic's next version after `off` (a restart with the engine on) clears the switched-off state; with no topic message after 3 s, or while the socket is down (every 30 s), it asks anyway. A story that did not change keeps its object, so its row keeps its element; a new one flashes once. On `/rbf`, a reader scrolled into the list keeps their place: the first story in sight stays at the same height on screen as stories come in above it (the browser's own scroll anchoring is off there, so it is not done twice); with the list's top in sight, new stories come in at the top.
- **States:** the table's rows held while loading; nothing yet; the server's refusal with Try again; the engine switched off (the topic says `off`, or the route `503 the mempool engine is off`, which is not retried).

#### Lightning pages

`pages/lightning/` reads the `/app/lightning/…` routes ([`API.md`](API.md#lightning)); `lightning.ts` has their types, shape checks, the close kinds' words and how sure each is (the words of [`LIGHTNING.md`](LIGHTNING.md#how-a-close-is-classified): use them wherever a kind is named), and the name cleaner. `testdata.ts` holds answers for tests, from the mainnet examples.

- **Status first.** Every Lightning page sits inside `Gate` (`parts.tsx`), which asks `/app/lightning/status` before anything else. That route always answers, so a network without Lightning costs one small request and no refusal: the other routes answer `503 lightning is off`, which the browser logs and `withRetry` would retry. `off` says Lightning is switched off on the network; `starting` and `syncing` show how far validation has come (channels checked, waiting, peers) and ask again every 5 s until `synced`, then draw the page without a reload; `failed` with `synced: true` says the server could not index the graph yet and asks again every 5 s, since the server retries by itself; any other `failed`, and `stopped`, say the peer is not running. `synced` means the routes' index exists, and it never goes back.
- **The overview** is `/app/lightning/overview` (one request: the snapshot, the top nodes, the newest opens and closes) and, beside it, the chart's series from `/app/lightning/statistics/:interval` (a week by default, the interval in `?interval=`). It shows the figures, the chart, then five-row previews of the top nodes and of the newest opens and closes; with no interval in the address the chart starts at the first snapshot when that is inside the week, says so, and its picker marks "Recorded". `LightningNav` (Overview, Rankings) heads every Lightning page; the overview, the rankings and the search remember themselves (`rememberList`) so a node or channel leads back to the list the reader came from. The chart is channels (area, left) and capacity (dashed, right), nodes and the median fee rate in the readout; both series are samples (`marks`), so a short record shows a dot at each. A step without a snapshot is a gap (`gap={step}`); before the first snapshot it is hatched, and a sentence says since when. The series' `sampled` leaves out the ten minutes still running, so the page quotes it only for gaps inside a period it spans.
- **A node** is one request (`/app/lightning/nodes/:key`, its first page of open channels and its fee histogram included); other pages and its closed channels are asked for as the reader moves, and its past (`/nodes/:key/history`) once the node has answered. `NodeCharts.tsx` draws both, side by side after the figures on a wide screen and before what it announces, so a phone meets the channels after about a screen and a half. **Its past** is channels (a step with its area, left) and capacity (a dashed step, right), both from zero, from the first point of the record (no period choice: the record is short). Its points are each midnight UTC, each open and close at its block's time, and now, so a count holds flat and changes at the moment the record has, never on a slope between midnights; before two points there is nothing to draw and it says when the record began. **Its fee rates** are a row per range of ppm (`feeRows` in `lightning.ts`: 0, 1–9, 10–49, …, 10 000+, then "No policy"), each a union of the server's buckets, trimmed to the cheapest and dearest rows held, so a one-channel node has one row and a node with thousands at most twelve. In each row two bars on one scale, what it charges and what its peers charge towards it, with their counts: one above the other on a phone, side by side where the panel is at least 30rem wide (a container query), the key heading them in the same order; a sentence over them names the row of the median channel each way, and "Show the figures" gives two tables, "It charges" and "Its peers charge" (the chart's words, with its key), each with the rate, the channels and their capacity, side by side only where the panel holds both at their own width (they wrap, so the room decides, not the viewport) and one over the other otherwise; each fits whole at every width from 320 px, in wider fallback faces too (`tables.e2e.ts`). **A channel** is one request; its close names the kind, how sure that is, and why, and links the closing transaction and block.
- **Search** is the section's own field (on the overview and the search page), not the header's. The header's search leads one query to one page and works on every network; a name matches many nodes, so it needs a list, and the server's index answers it in one request (`/app/lightning/search`). The field refuses what the server would (under 3 or over 66 characters, control characters) without asking.
- **The transaction page's note** (`TxLightning.tsx`, the one import the transaction page takes from here) asks for a confirmed transaction only: the status, then `/app/lightning/tx/:txid` when it is `synced`. A network whose status said `off` is not asked again in that tab. The part that draws the note (`TxChannels.tsx`) is a lazy chunk loaded only when the answer lists a channel, and it sits after everything else on the page, so its arrival moves nothing.
- **Names are attacker-controlled text** ([`SECURITY.md`](SECURITY.md) rule 14). `cleanAlias` turns control characters and invisible format characters (bidi overrides and isolates, zero-width spaces; not the joiner emoji are built with) into U+FFFD, so a reader sees something is there, and thins stacked combining marks to two. `Alias` isolates the name in `<bdi>`, cuts it to 32 characters in lists (64 as a node page's title, with "Show the whole name"), counted as a reader counts them (`Intl.Segmenter`), and puts at most 512 in its `title`. The public key is always beside the name, and the node page says the key is the identity. Addresses are text chips, never links.
- **Node colours are left out.** A colour is the node operator's choice, color on this site carries fee and nothing else, and the Content-Security-Policy forbids a `style` attribute: there is nothing a colour would tell a reader that is worth a mapping onto classes.

### Live data

`lib/live.ts` holds one WebSocket per tab and network to `/app/ws` ([`WS.md`](WS.md)). It opens while any component is subscribed to a topic and closes when none is. It checks the greeting's protocol version and network, subscribes after it, reconnects with exponential backoff and jitter (0.5 to 30 s), resubscribes, pings every 30 s to find a dead socket, sends subscription changes at most every 250 ms (unsubscribes before it subscribes, so switching between capped topics never holds one too many), and ignores message types it does not know. Binary frames are read as `ArrayBuffer`s and offered to every subscribed topic that has a `binary` reader; the others never see them. A hidden tab keeps its socket; a socket that drops while hidden, or while the browser is offline, waits until the tab is visible and online again. After close codes 1002–4002 or a greeting from another protocol version it stops for good: the page is out of date.

A topic is a name and a parser, and a binary reader if it sends binary frames. Write one per topic in `lib/`, as `blocks-topic.ts` does; the client never changes for a new topic:

```ts
export const mempoolTopic: Topic<MempoolMessage> = {
  name: "mempool",
  // Return undefined for a type or shape this page does not know: it is ignored.
  parse: (m) => (m.type === "delta" && isDelta(m.delta) ? { type: "delta", delta: m.delta } : undefined),
};
```

A component uses it for as long as it is mounted, on the page's network:

```ts
useTopic(blocksTopic, {
  message: (m) => { /* every message, in order; the first is the topic's current state */ },
  resync: () => { /* the socket reconnected and messages may be lost: refetch over HTTP */ },
});
const status = useLiveStatus(); // "connecting" | "live" | "reconnecting" | "offline"
```

- **Load over HTTP, then keep up over the socket.** The socket only reports changes. Fetch the state with `fetchApi`, apply messages on top, and treat a gap, a `resync` message that disagrees and the `resync` handler the same way: fetch again. Messages that arrive while that fetch is in flight are held and replayed on its answer (`pages/home/feeds.ts`, `createBlockFeed`).
- **The mempool topics** exist now ([`WS.md`](WS.md#mempool-topics)): `mempool` for the mempool panel and bar, `projected` for the projected tiles, `transactions` for the latest transactions, and `projected-txs:N` for one projected block's grid. The first three are JSON and each message is the whole state, so a page keeps the last one; `projectedTopic` in `lib/projected-topic.ts` reads `projected`, with rates turned into sat/vB. `lib/mempool-topics.ts` reads `mempool` and `transactions` the same way. On a server with the mempool switched off each topic sends `{"type":"off"}` once. Rates on the wire are in sat per 1,000 vB.
- **A projected block's transactions** (`lib/projected-txs.ts`). `projectedTxsTopic(n)` reads block `n`'s frames with `decodeFrame`, which never throws: a frame of another kind is ignored, one in a newer format version comes back as `version` (ask for a reload), and one that is cut short, too long, has nonzero padding or a fee beyond 2^53 comes back as `malformed`. `BlockTxs` keeps the block as a `Map` from txid to a `GridTx`-shaped record (`{ id, vsize, fee, rate }`, rate in sat/vB), the same object until its record changes. `apply(frame)` answers `changed` (with the txids that came in and went out), `lost`, `ignored` or `version`. On `lost`, call the function `useTopic` returns: it unsubscribes and subscribes again in the next batch (`LiveConnection.restart`), and the snapshot that follows starts the block over. Until it comes the model keeps the last picture and ignores the old subscription's deltas still in flight, so one gap never becomes a loop. Call `expectSnapshot()` from the topic's `resync` handler: a reconnect subscribes afresh. A page holds at most two of these topics at once, and leaving the page unsubscribes. `fakes.ts` builds frames for tests (`snapshotFrame`, `deltaFrame`, `fakeTxid`).
- **A new block and the mempool topics arrive in a promised order** ([`WS.md`](WS.md#when-a-block-is-found)). For a new block, the `block` message comes first, then the mempool topics already on that block, sent at once rather than at the 2 s rate. No mempool message on an older tip follows the `block` message. The next `projected` after a `block` is on that block within milliseconds on regtest and about 0.6 s on mainnet, and the server sends an older one after a block's message only if its engine is still behind 3 s later; that message's `tip` says so. A transaction leaves the projection at the same moment, and a followed transaction's `tx:` topic says `confirmed` at the same moment, not at the next interval. `fees` on our own projection keeps the same order. So the home page draws a block as it is announced, crossing from the projection on its parent, and takes the next projection as the state after it; it holds back a projection on a block it has not shown (`HOLD_MS`, 3 s, `pages/home/projection.ts`) only while the strip catches up over HTTP after a gap or a reconnect, where the order does not reach: one `/blocks` request and, behind the server's one-second tip cache, one retry (`STALE_RETRY_MS`, 1.2 s, `pages/home/feeds.ts`). A new tile's facts are asked for over HTTP only when its `summary` has not come `PUSH_GRACE_MS` (4 s, `pages/home/summaries.ts`) after the block; on mainnet it came 1.6 to 3.4 s after it, audit included. The projected-block page waits at most `FOUND_WAIT_MS` (`pages/projected/state.ts`) for the block's new picture, which follows the projection at once, before saying the block was found.
- **The home page's fees** (`pages/home/fees.ts`) come from the `fees` topic alone while the socket is live: the levels the server gives, printed rounded up at a fee rate's usual precision (`formatFeeRateUp`), neighbouring levels that print the same rate shown as one answer (`groupLevels`), the node's fallback (`source: "node"`) said so beside them, and `unavailable` shown as no number. While the socket is down, or when the topic has said nothing 5 s after the page opened, the page asks `/v1/fees/precise` at once and every 30 s instead, keeping the topic's last answer until a reply replaces it (an HTTP answer the next ask cannot confirm within 2 s is taken down); that answer is ours when it carries a chain-tip stamp and the node's when it does not ([`API.md`](API.md#fees)).
- **The home page's mempool** (`pages/home/live-mempool.ts`) takes the panels and the strip from those topics and asks `/api` for nothing they send. It polls `/mempool` and `/mempool/recent` instead only when the server says `off`, while the socket is down, or when the topics have said nothing 5 s after the page opened (a server still making its first mempool cycle). `stale: true` keeps the last state on screen and turns the live indicator to "Node not answering".
- **Following one transaction or address:** `tx:<txid>` says where a transaction is and what happened to it (in the mempool with its projected block, replaced with the whole chain of replacements, confirmed, evicted, or unknown), and `address:<address>` sends a token that changes whenever the address's history does, so the page refetches. Each message is the whole state. The messages, what each state means for the page, how to phrase the position without false precision, and the bounds (four transactions and two addresses per socket) are in [`WS.md`](WS.md#following-a-transaction-or-an-address). On `unknown`, ask `GET /api/tx/:txid/status`: the topic never asks the node. On `refused` with `server_full`, fall back to polling the HTTP status and try the topic again later.
- **`lib/track-topics.ts`** reads both: `txTopic(txid)` gives `TxMessage` (a state with `stale`, or `off`, or `refused`), rates in sat/vB; `addressTopic(address)` gives `watching` with its status, `unavailable` or `refused` with a reason, and names the topic as the server does (bech32 in lower case). `linksOf` reads replacement links, which the topic and `/app/tx/:txid/replacements` share.
- **The transaction page's state** is a pure model in `pages/tx/state.ts`: the topic and the HTTP status route are two witnesses, and the newest word wins. A topic message decides only when it is live, not `stale` and not `unknown`; an HTTP "waiting" never hides the topic's position, since both agree; a 404 keeps what the topic or the replacement record knew about why it left. The page follows its transaction (and `blocks`, for confirmations) only while something can still change, and the newest replacement's topic when it was replaced: at most two `tx:` topics. A young confirmed transaction's first `unknown` asks nothing more; a later one, a first one after an answer that it waits (it left the mempool before the page followed it), or one on a new block, asks the status route. An HTTP answer counts as of when it was asked, so a topic message heard while it was in flight wins. A live socket whose topic has said nothing for 5 s (a server still making its first mempool cycle) counts as not live, and the page checks over HTTP. A transaction the node did not know when the page opened is checked for until it appears.
- **The address page follows first, then asks.** It asks for the totals and the first page of history only once the `address:` topic's first message has come (a few milliseconds when the socket is open), so a payment made before that status is in what it asks for, and one made after it changes the status. With no message within a second (the socket still opening, or a tab opened in the background), or when the first message is `unavailable` or a refusal, it asks anyway, and then takes the first status that comes for a change. Its address requests skip the browser's HTTP cache (`createApi(…, { fresh: true })`): an answer kept for its `max-age=1` second can predate the change the page was told of, and when the history came from the cache while the totals came from the server, the refresh stopped with the totals new and the new row missing (on regtest, 27 of 80 page loads timed to a second's turn, none of 50 once fixed). A refresh that still brings nothing new is asked again after 1, 2 and 4 s, in case the node's index trails its status: on regtest the node's address routes already showed the change when its Electrum notification came, in 210 of 210 payments and blocks. Each of those refreshes also brings the balance chart up to date with one summary page ([below](#the-address-balance-chart)). While a request waits out a busy refusal (429, or a 503 that says to wait), the page says so in one quiet line (`busyRetrying`); one that gives up shows as busy, with Try again, never as an error (`ErrorState` for `isBusy`). A change heard while a fetch is in flight restarts it. A later page that lands after a refresh changed the first page is dropped, since it may continue rows that are gone, and the page asks again after the rows the refresh left, so "Show 25 more" always shows more.
- **An address's history waits for its totals.** The first history page is asked once the totals have answered, or after `HISTORY_WAITS_MS` (1 s) if they have not, and never after a "too large" answer: the node refuses those totals within tens of milliseconds, and a page of such an address's history can keep it busy for a minute or more (95 to 102 s measured on the largest found, [`API.md`](API.md#very-large-addresses)). The history section then says the transactions are not available, as it does when the server refuses the history itself.
- **An address above the node's cap** (`pages/address/Large.tsx`) shows, in place of the totals, chart and history: how many transactions have paid it and the node's cap from `/app/address/:a/size` (checked by `readSize`; without them it says the same in words), its unconfirmed transactions from `/txs/mempool`, then what is not shown and why in two sentences. The node will not watch it, so the list is asked again every `POLL_MS` (10 s, `poll.ts`) while the tab is in view and at once when it comes back; newcomers go on top with the usual flash and rows already shown keep their elements (`arrivals`), so focus survives a refresh. A failed check keeps the last list and says so. It never asks for the address's history, balance history or unspent outputs ([`API.md`](API.md#what-the-page-shows-of-such-an-address)).
- **An address the server adds up and keeps** (`pages/address/Kept.tsx`, `ledger.ts`; [`API.md`](API.md#very-large-addresses)). Once the totals have answered, the page asks `/app/address/:a/ledger` (from the server's memory and store, never the node) and parses it strictly (`readLedger`: anything unexpected reads as nothing known). Its first history page waits for that answer too, so a kept address never asks for a history the server would refuse.
  - **Being added up** (`queued`, `seeding` or `busy`, after totals refused for size or slower than 5 s): the large page above, led by a panel that says it is being added up once and will then be instant, with real progress: its place in line, or the seconds since the server began, counted on by the page between asks. The page asks again every `LEDGER_POLL_MS` (3 s) while it waits and is in view, which also keeps its place (the server drops a seed nobody asks about for 2 minutes). `failed` says so; `refused` (the node's cap is in force) leaves the large page exactly as before the ledger.
  - **Kept** (`tracked`): the totals, which the server now answers from its ledger through the page's usual request; a line saying since which block the server has kept it and which block the totals are exact at; the balance chart from when tracking began (the ledger's points, one a day or so); then its transactions, by where its whole history stands (the ledger's `history`):
    - **`whole`:** every confirmed transaction, from the server's own pages ([`API.md`](API.md#paging-a-kept-history)): the history list of an ordinary address (`History` with `kept`), headed "Transactions" without the unspent outputs view (the server keeps none), its first page from `/txs/chain` and "Show 25 more" from `/txs/chain/:last`, the count out of the confirmed total.
    - **Otherwise** its newest confirmed transactions, at most 200, 25 at a time ("Show 25 more"), with time, amount and block, and one sentence saying why the list stops there: the server is getting the whole history from its node (`none`, `taking`: the page's own ask is what makes it), the node declines to list it (`refused`), the server let it go to make room for addresses viewed more lately and is getting it again, or takes it again when the page is open after a given time (`dropped`, with `history_again`), or it is larger than the server keeps (`too_large`). While `filling`, that sentence (or the empty list) also says the transactions from before the block it began keeping it at are added once the node has listed them.

    And its unconfirmed transactions as on the large page. While the page is open and in view it asks for the ledger again every `KEPT_POLL_MS` (5 minutes, `asksAgain` in `ledger.ts`), one read of the server's store: the server takes (or takes again) a whole history only for an address being viewed, and drops none viewed in the last 30 minutes, so a reader paging a long history keeps it. The topic says `ledger` with the new height when a block changes it, or when a fill or the whole history is done, and the page asks for the ledger and the totals again, and its first history page when the history is whole.
  - The figures wrap: between 40em and 80em at least 12rem a column, on phones two abreast where each has 9.5rem and one below, so an exchange's millions fit at 320 px in wide faces.
- **Say when it is not live.** While `status()` is not `live`, poll what the socket would have sent, no faster than every few seconds, and tell the reader (the home page's indicator).
- In tests, stub the global `WebSocket` with `FakeSocket` from `lib/fakes.ts` and play the server: `FakeSocket.last().hello()`, `.receive({...})`, `.drop(1006)`.
- **The block page follows the newest block.** From its first ask until its status names a next block, the page hears `blocks`. Once the status says nothing comes after it, a tip that is another block, heard before that answer or after, a reorg or a resync asks the status again, from the server, and the next block's link and the confirmations come with it. An older block follows nothing: its next block and confirmations are as of the page's load.

#### The block strip's past

The home page's mined lane goes on to the right through every block down to block 0, loaded as the visitor scrolls (`pages/home/past.ts`, drawn by `BlockStrip.tsx`).

- **One lane, a window over it.** Every slot has the same pitch (`--tile-w` plus `--tile-gap`), so the lane is as wide as all its blocks and holds only the tiles near the view: those in view and `OVERSCAN` (6) beyond each edge, each after a margin of the empty slots before it (`--skip`). The newest tile and a focused tile with its two neighbours stay in the page wherever the strip is. In the DOM: 24 mined tiles at most on a 1,440 px desktop, 17 on a 390 px phone, measured. Before the strip is laid out it holds the live list's ten. The lane is laid out 200 slots past the deepest one seen, so a fling never meets its end, and stops at `MAX_DEPTH` (50,000 blocks, about a year) with a link to the Blocks page, because browsers cap an element's width near 17.9 million px.
- **Pages.** Older blocks come from `GET /api/v1/blocks/:start_height` ([`API.md`](API.md#blocks)), 15 a page, from pages of fixed heights asked for from their top (from 104 down to 90, from 89 to 75), so one request serves every visitor and is cached a day once settled. One page is in flight at a time: the one nearest the middle of the view that misses a block within the view or `LOAD_AHEAD` (30) blocks past its far edge. A server without a block table, or a page it has not indexed yet, is asked of the node's `/blocks/:height` instead (ten a page, from the highest block missing). A page that fails is one dashed run in the lane with its error and Try again, its note kept in view while any of it is; it is not asked again until then.
- **Memory.** Blocks more than `KEEP` (90) beyond either edge of the view are let go, so the page holds at most about 260; coming back to them asks again, which the browser or the page-wide answer cache (256 answers) usually serves. A long scroll of 2,000 blocks with the wheel (desktop and phone width, Chromium) drew every frame within 34 ms, with 136 requests and the JS heap from 3.8 to 5.7 MB.
- **Fee facts.** The live list's come as before. Older tiles' come from the batch summary route once the strip has stopped scrolling for `SETTLE_MS` (250 ms), for the older tiles in the page only, so a fling asks nothing; a tile whose facts failed keeps its gauge until it leaves the page and comes back.
- **The live edge.** At "now" a new block crosses the line as before, and the tiles it moves past the live list's ten glide on into the past instead of fading. When the "now" line is out of view, a new block, a reorg or a refetch plays nothing and moves the scroll position by the change in the tip, so the tiles in view stay where they are; the announcement is still made. A reorg below the live list (its oldest block's parent is not the block kept below it) drops everything kept below it.
- **Back to now.** While the line is out of view a button, "← Now" (named "Back to now"), sits in the strip's head, a thumb high on touch screens without changing the head's height. It glides back when the line is within three widths of the view and motion is welcome, and jumps otherwise. Activated from the keyboard, it moves focus to the newest tile.
- **Keyboard and readers.** Tab and Shift+Tab walk tile by tile into the past and back, the strip following focus. A focused tile stays in the page however far the strip is scrolled, so focus is never lost. Home on a tile goes back to now and focuses the newest block. Each tile carries its place among all the blocks (`aria-posinset`, `aria-setsize`); loading, pages and scrolling announce nothing.

#### Following live data

How a page keeps a fetched answer current from a topic. The address page once missed a payment for good in each of the two orderings below, and so could the transaction page, the newest block's page and the replacements list; `e2e/live.mine.e2e.ts` and `e2e/address-live.mine.e2e.ts` build each ordering on purpose on regtest, for every page that follows a live event with a request. A new page follows the same three rules:

1. **Listen from the first ask, and treat the topic's first message as news.** It is the state as it is now, so anything that happened between the page's first answer and its subscription taking effect is in it: compare it with the answer, never take it as "the watch has started". Better still, subscribe first and ask once it has come (the address page). A listener added while another part of the page already follows the topic gets no first message (`lib/live.ts` replays nothing), so mount it with the first ask, not once the answer has come.
2. **A request a live message prompts skips the browser's cache:** pass `fresh: true` to `fetchApi`, `fetchApp` or `fetchStamped`; `createApi`'s `refetch` does it by itself. Our answers that change with an event are `max-age=1`, and the browser shares its HTTP cache between tabs: a copy kept from the second before the event is the old answer, and a page that takes it for the new one has caught up with nothing and stops asking. It adds no request: the ask the event prompted was going to be made anyway, and only a stale copy is refused. A first load does not need it.
3. **Decide that you have caught up from the answer, not from having asked.** Where a server-side cache can trail the event, compare the answer with what the event said (a height, a chain-tip stamp, a status) and ask again a few times: the block strip and its one-second tip cache (`STALE_RETRY_MS`), the difficulty panel's stamp, the address page's catch-up.

Pages whose topic carries the whole state (`mempool`, `projected`, `transactions`, `fees`, `projected-txs:N`, `tx:` positions) ask nothing on an event and need none of this. Summaries and audits are fixed by their hash: a new block's summary is served only once its audit is decided, so it is cached for good from its first answer.

## Shared components

Import from `components/`. All of them render chain data as text only.

| Component | Use |
|---|---|
| `Exact class title? figure` | A short figure whose exact value (its children) a tap or key opens in a pop-up fixed over the page, placed above the figure inside the screen. It opens below the figure where the room above is under the sticky header. One pop-up is open at a time and a press outside, Escape or a scroll closes it (`components/pop.ts`, which the network menu uses too). A press outside either only closes it: the press's release and click are swallowed, so nothing under it fires, and the next press works; a press on another exact amount's figure opens that one in the same press. Not the browser's popover: while a top-layer element shows, iOS Safari stops the page above its toolbar (WebKit bug 302272). Its children are the exact value and a copy button (`CopyButton`), read by screen readers too |
| `Amount sats unit? signed? short? approx?` | BTC with eight decimals, trailing zeros dimmed (same weight), sats in the title. `signed` adds `+` to incoming amounts; the sign, not a colour, carries the direction. `short` prints a summary's magnitude (`formatBtcShort`), the exact amount in the title; `approx` adds `~`. `unit={false}` hides the unit from sight only, for a table that names it in its header: screen readers still read it |
| `Sats sats unit?` | Grouped sats. `unit` as for `Amount` |
| `FeeRate rate unit? approx? up? swatch?` | A fee rate. `approx` adds `~`. `up` prints a recommendation rounded up. `swatch` puts its band's colour beside it: only where it is the key to a drawing (the map's tooltip), as fee colour belongs to the drawings. `unit` as for `Amount` |
| `FeeKey` | The twelve bands with their lower bounds. Beside a drawing that needs a key, not where figures already name the bands |
| `More label? children` | The second reading layer: methodology and longer notes behind a `<details>` disclosure ("How these figures are made"). Keep the one sentence that changes a number's meaning outside it |
| `Strata layers settle? from?` | A block's fee bands as stacked layers, cheapest at the bottom, filling the box it is put in. Compute `layers` with `strataLayers(fee_bands, fill, min)`: `fill` is how full the block is, `min` the thinnest layer as a share of the box (about 2 px). `settle` drops the layers in, cheapest first; `from` grows each layer out of the same band's layer in another set (a projected block becoming the mined one), a band it lacks from nothing; reduced motion fades either. Decorative: give the figures, or `describeBands(fee_bands)`, as text beside it. Block tiles draw it inside a box the size of the block's capacity |
| `DifficultyAdjustment network tip` | The difficulty period's progress bar and the expected, next and previous change, refetched when `tip` (a block hash) changes. On regtest it says the network never retargets. The home and mining pages put it in their own section |
| `Chart …` | A time-series chart in SVG, in `components/chart/`. Load it with `lazy()`; see "Charts" |
| `AuditSection hash audit error? retry?` | A block's audit, in `components/audit/`: `audit` is the totals from `readAudit`, `null` for none, undefined while loading; its list loads lazily (see "Block audits") |
| `TxGrid txs capacity label txid highlight? onState?` | Transactions as a packed map of rectangles in WebGL2, in `components/txgrid/`. Load it with `lazy()`; see "Transaction grid" |
| `Hash value href? head? tail? copy? copyLabel? whole? fit?` | Hash or address, shortened in the middle (or `whole`, wrapping; or `fit`, as much as its column allows, the last eight characters always kept), linked when given a `paths` result, with copy |
| `HashFull value copyLabel?` | A page subject's hash in full, grouped by eight, with copy |
| `CopyButton value label?` | The copy button on its own |
| `TimeAgo time suffix?` | Relative time that keeps itself current, UTC in the title |
| `TimeUtc time` | Absolute UTC time |
| `DataTable caption columns rows empty? rowClass?` | Table with units in headers, a gutter on both sides of every column, numeric columns in the monospace. Columns: `header`, `cell(row, i)`, `numeric`, `optional` (dropped on phones), `drop: n` (dropped, step 1 first, while the table is wider than its panel at any width; never on the column that names a row or the one the list is sorted by), `short` (a shorter header shown on phones; screen readers keep the full one). A table that still does not fit scrolls inside itself with its cut edge faded and takes keyboard focus (`scrollCue`); no header is cut mid-word. `rowHref(row)` makes a whole row one target that opens its item: an empty link under the cells' own links and buttons, in the first column never dropped, hidden from the keyboard and screen readers, so the row's own link stays its one stop. Every list on the site uses it; `e2e/rows.ts` checks both rules on every list. `rowClass(row)` classes one row, such as a highlight for a new one |
| `Periods choices current fitted href` | A chart's periods as one row of links, the current one pressed in, with "Recorded" first when the view is `fitted` to what is stored. It never wraps: where it does not fit it scrolls sideways, its far edge faded (`scrollCue`), and keeps the chosen period in sight. The mempool history and the Lightning overview use it; `e2e/periods.e2e.ts` holds every chart with period choices to the rule |
| `SectionHeader title id? children?` | A section's `h2`; `children` sit at the right. A `section` whose first child it is becomes a panel (`global.css`); the class `panel` does the same for any other group |
| `Loading label?` | Waiting. Fades in only after 300 ms, so fast loads show nothing |
| `Empty title children?` | Nothing to show, and what to do about it |
| `ErrorState title error? message? retry?` | What failed, the API's message (or `message`), and "Try again" |
| `Pagination page pageCount? hasNext? onPage label` | Previous and next. Esplora's cursor-paged lists pass `hasNext` instead of `pageCount` |
| `SearchField id?` | The search: reads the query as it is typed, opens its page on Enter or says why there is none. The header owns the main one; another (the not-found page's) passes its own `id`. On a phone its hint is one word, "Search" |
| `Link href` | Internal link on the current network |

Buttons are `<button class="btn">` (or `btn btn--accent`) with `components/Button.css`; toggles add `aria-pressed`. On touch screens buttons are 44 px tall. Small icon buttons (copy, expand, theme, the network switch) are 44 px boxes that draw a smaller shape inside and take only the smaller one's room through negative margins, so a target never moves what is beside it.

For a figure without a component, use `lib/format.ts` directly: `formatBtc`, `formatSats`, `formatFeeRate`, `formatFeeRateUp` (a recommendation: a fee rate's usual precision, never rounded down), `formatBtcShort` (a summary's BTC, magnitude first: `2 793`, `3.15`, `0.0225`), `feeBand` and `feeColor`, `formatSize`, `groupDigits`, `formatPowerOfTen` (a number too small or large to write out: `4.66 × 10⁻¹⁰`), `truncateMiddle`, `formatUtc`, `formatRelative`. They never throw and print `–` for a value that is missing or malformed. Fee bands always come from `feeBand`, which bands the rate as printed.

## Transaction grid

`components/txgrid/` draws transactions as a packed map of rectangles in WebGL2: area by virtual size, colour by fee band, the dearest at the top left, one clean block on the floor of the frame as high as the block is full ([`DESIGN.md`](DESIGN.md#the-transaction-grid)). The block page and the projected-block page use it.

| File | Holds |
|---|---|
| `TxGrid.tsx` | The component (default export, so `lazy()` can load it) |
| `decode.ts` | `decodeTxs(buffer)`: the `/txs` records as `GridTx[]`. Throws `TxsFormatError` (`kind: "version"` asks for a reload) |
| `layout.ts` | `GridTx`, `layout(txs, aspect, capacity)` and `hitTest`. Pure |
| `scene.ts` | Where each rectangle comes from and goes to, and when. Pure |
| `gl.ts` | The WebGL2 program: one instanced draw call, animated in the vertex shader |

**Load it lazily.** It is about 7 KB gzipped and only pages that draw it should fetch it. Import types with `import type`, which costs nothing, and the component with `lazy()` inside its own `<Loading>`, so it never holds the page. Call `.preload()` in the page's `onSettled`, so the code downloads while the data does. `decode.ts` is small and may be imported statically.

```tsx
const TxGrid = lazy(() => import("../../components/txgrid/TxGrid"));

<div class="my-frame">{/* position: relative, with a size: the grid fills it */}
  <Loading>
    <TxGrid
      txs={txs()}                       // GridTx[]: { id, vsize, fee, value?, rate?, coinbase? }
      capacity={1_000_000}              // vB the frame stands for; more than that shrinks to fit
      label="Map of the block's 4 198 transactions, …"   // the canvas's text alternative
      txid={(tx) => fetchApi(network(), `/block/${hash}/txid/${tx.id}`, { as: "text" })}
      highlight={rowHovered()}          // an id to ring, or undefined
      onState={setGridState}            // "drawn" | "lost" | "unsupported"
    />
  </Loading>
</div>
```

**A whole block** is one array. **Changes** are a new array: the grid matches it to the last by `id`, so keep ids stable (the block index for a mined block, the txid for a projected one) and keep each unchanged transaction the same object (the grid caches its band per object). Squares that stay travel to their new places, new ones drop in, gone ones fade out where they stood, and a change that arrives mid-animation starts from where each square is. For a projected block (`projected-txs:N`, [`WS.md`](WS.md#binary-frames)), make each record `{ id: txid, vsize, fee, rate: effectiveRate / 1000 }`: `rate`, in sat/vB, orders and colors the square by the chunk it is mined in rather than by its own fee, and `value` is left out because the record does not carry it. `BlockTxs` in `lib/projected-txs.ts` keeps that map: apply the snapshot and each delta to it, and pass `[...model.txs.values()]`; order does not matter, because the layout sorts. Keep the grid mounted when the block empties, so the last squares fade out instead of vanishing. A transaction whose fee rate changed is a new object with the same id: it moves. Changes that arrive while the tab is hidden are applied without animation.

- **Layout** (`layout.ts`). An ordered squarified treemap in fractions of a cell: the coinbase, then fee band by band, dearest first, the largest first within a band; each run of rectangles is laid along the shorter side of the space still free and grows while its worst rectangle gets closer to square. Every area is its vsize over the vB a cell stands for (the frame is the weight limit), at least `MIN_AREA` cells, so the rectangles tile one rectangle exactly, as high as the block is full; a nearly empty block keeps at least `MIN_ROWS` of height and is narrower instead. The grid has about 160 000 cells, shaped to the frame in 4% steps, so a frame that changes size by a pixel keeps its picture and is only rescaled. More than the capacity scales everything to fit. A full mainnet block lays out in a few ms, on the main thread.
- **Hit testing** walks the runs (a few dozen) to the one holding the point, then searches it: exact, and for where rectangles are going, not where an animation has them.
- **Instances** are 14 floats: where a rectangle comes from and goes to (x, y, width, height each), its start, duration, curve and colour, and its alpha from and to. The vertex shader mixes them, snaps a rectangle at rest to whole device pixels and leaves a one-pixel seam on any side wide enough to spare it.
- **Colors and motion come from the tokens** at run time: `--fee-1` to `--fee-10`, `--color-text-muted` for the coinbase, the durations and curves. A theme switch repaints; reduced motion leaves only fades.
- **States.** `onState("drawn")` after the first frame; `"lost"` when the WebGL context is lost (the canvas hides; show your stand-in until `"drawn"` comes again on restore); `"unsupported"` when the browser has no WebGL2 (keep your stand-in and say why). Keep a stand-in in the frame until `"drawn"`.
- **Accessibility.** The canvas is `role="img"` with `label` as its name, and is not focusable. Put the same transactions in a list beside it and pass the hovered or focused row's id as `highlight`.
- **Measures.** It records `txgrid layout` and `txgrid first frame` with `performance.measure`, for profiling and browser tests.

## Charts

`components/chart/` draws the time series the mining, mempool-history and address-balance pages need, in SVG: a line, a filled area or a step on one value axis or two; percentile bands; and stacked shares. It is written here rather than taken from a library (the comparison with uPlot is in the PR that added it): about 4 KB gzipped, colors straight from the tokens, so a theme switch needs no repaint code.

| File | Holds |
|---|---|
| `Chart.tsx` | The component (default export, so `lazy()` can load it) |
| `scale.ts` | Linear and log scales, round value ticks, time ticks from hours to decades, `formatSi`, `formatHashrate`, `formatShare`, `formatDay`, `describeSeries`. Pure |
| `geometry.ts` | Paths broken at gaps, `stackLayout`, `nearestIndex` and `layerAt` for hit testing, `extent`, `sorted`. Pure |

**Load it lazily,** as the grid: `const Chart = lazy(() => import("../../components/chart/Chart"))`, call `Chart.preload()` in `onSettled`, and hold its height while it loads (`pages/mining/parts.tsx`, `ChartSlot`, holds `height` + 5.75rem: readout, plot and caption). Import types and the pure modules statically; they cost nothing until used.

```tsx
<Chart
  label="Hashrate and difficulty, the last year"   // its accessible name
  x={times}                                        // unix seconds, ascending
  domain={[yearAgo, now]}                          // optional: the time range drawn
  dataFrom={answer.coverage?.fromTime}             // optional: hatches what is not stored
  height={260}
  left={{ format: (v) => formatHashrate(v), log: "auto" }}
  right={{ format: (v) => formatSi(v, "") }}        // optional second scale
  series={[
    { name: "Hashrate", values: hashrates, draw: "area", format: (v) => formatHashrate(v, 4) },
    { name: "Difficulty", values: difficulty, draw: "step", axis: "right", tone: 2, format },
    // until: a step holds its last value on to this time (the address balance, to now)
    // draw: "step-area" is a step with its area; unit: "BTC" goes after the readout's figure
    // and into the figures' header; marks: true dots each sample while samples are sparse
  ]}
  bands={[{ name: "10th to 90th percentile", lo, hi, tone: 1, format }]}   // optional
  layers={[{ name: "Foundry USA", values: shares }, …]}                     // optional, 0–1
  layerFormat={formatShare}
  time={(t) => `Week of ${formatDay(t)}`}           // optional: how a point's time reads
  summary="…"                                       // optional: replaces the written summary
/>
```

- **Values** are numbers or `null`. A `null`, or two points more than three times the median step apart, breaks the line: missing data is a gap, never a dip to zero. Data with a fixed step passes `gap={step}`, so a single missing step breaks it too. A point alone between gaps is a short tick on a line; with `gap` given it is also a 2 px sliver in an area, which without it draws nothing (the mining charts, unchanged). Points before `dataFrom` do not exist; the part of `domain` before it is hatched and labelled "No data stored".
- **Axes.** `log: "auto"` turns a log scale on when the data spans more than three decades (hashrate over all of history). `zero` keeps 0 in view; `domain` fixes the range (`[0, 1]` for shares). `fee: true` runs the fee colors along a fee-rate axis, as its key. Ticks are round numbers; time ticks step by hours, days, Mondays, months or years, at most one per 84 px. Each value axis is as wide as its longest tick label needs, measured in the labels' font when the chart lays out (regtest's fees read `0.0000002 BTC`), and never narrower than its usual 66 px (58 on the right), so no label is ever cut; `periods.e2e.ts` checks every label stays on its plot.
- **Tones,** never fee colours: tone 1 is `--series-1` (the main series, solid, over an area of it at 14%, drawn only when its axis starts at zero), tone 2 `--series-2`, dashed. A layer with `pool: n` (1–6, 0 for the rest) takes that pool's colour (`--pool-n`). Bands are series 1 at 18% and 36%; stacked layers are shades of it with a seam of the panel between them, the first at the bottom. A layer with `fee: n` (1–10) is amounts in fee band `n` instead, filled with that band's fee color (the mempool's size by fee rate), and can give the readout a `short` name (`0.2–0.3`) while `name` is what is read aloud and heads the table. The layer under the pointer or finger keeps its colour and takes an outline in the text colour while the others fade; the accent is never drawn in a plot, and a tap outside the plot lets the layer go.
- **Notes** (`notes={[{ name, values, format }]}`) are figures the readout, `aria-valuetext` and the table show at each point without drawing them: a count beside a size.
- **The axis** names its first and last moment instead of ticks when the plot is under 420 px wide (`endLabels`), as months and years (`Nov 2020`) when the ends fall in different years and the plot is under 170 px. On a chart under 480 px wide (a container query) the readout leaves out a fee chart's bands except the one under the finger, which has a line of its own held by "Tap a layer to name it" until a finger picks one, so a tap never moves the plot.
- **The readout** sits above the plot at a fixed height and shows the latest point, or the one under the pointer or finger (a tap keeps it). The plot is a `slider`: it takes focus, the arrow keys, Page Up and Down, Home and End move through the points, Escape returns to the latest, and `aria-valuetext` reads the point's time and every figure.
- **Points that are items** (`href={(i) => paths.block(…)}`): a point opens its item on a click, on a second tap within 22 px of the point a finger picked (a 44 px target) (the first only reads it, so a tap never navigates by surprise), or on Enter; each row of the figures links to it and opens it from anywhere on the row. The block health chart uses it.
- **Text alternative.** A summary written from the series (where each went, its lowest and highest) describes the slider, and "Show the figures" opens every point as a table. Pass `summary` when the series alone would not say it (stacked shares). A series or band with a `unit` has it in its column's header and bare figures in the cells (a band's range may break before its upper end on a phone, and a band can give a `narrow` name for a phone's header: "Middle 80%"); times that end in UTC say it once, in the header ("Time, UTC"), and on a phone take two lines, the day over the time of day.
- **Samples** (`marks: true`): a series whose points are moments something was looked at gets a dot at each while they stand at least 24 px apart (`MARK_SPACING`), so two looks joined by a line read as two looks. A value whose changes the record dates exactly is a step instead ([`DESIGN.md`](DESIGN.md#charts)).
- **Cost.** It draws the paths again only when the data or its width changes, never on hover: 1.5 ms for a year of daily points and 5 ms for ten years, with a line, an area and eight stacked layers. Hovering a 967-point chart holds 60 fps.

### The address balance chart

`pages/address/BalanceChart.tsx` draws an address's confirmed balance after each block as a `step` series held on to now (`until`), with the block and its net change as notes; `pages/address/balance.ts` is the logic, pure but for `loadHistory`, which takes its fetcher. The data is the node's `/address/:address/txs/summary` ([`API.md`](API.md#routes)): 25 rows a page, newest first, each a confirmed transaction's net effect on the address (unconfirmed ones are not listed, so they stay in the page's "Unconfirmed" figure).

- **When it asks.** Only once it is within 300 px of the screen (its summary pages are most of an address page's requests), after the page's own totals and first history page have answered, and only when the totals count a confirmed transaction: an address with no history asks nothing and has no chart, and one whose totals the node refuses as too large asks nothing and says so in a sentence. That check matters: the node can spend over a minute on the first summary page of the largest addresses (95 to 102 s measured on mainnet's largest, whose totals it refuses in tens of milliseconds). The chart's code is preloaded at the same moment, so neither costs an ordinary page view anything before its main content is in. The section holds its height from the first render (the plot, the readout and the caption: three readout lines on a phone), so nothing moves when it arrives.
- **How much.** At most `MAX_PAGES` (8) summary pages, so the newest 200 transactions, every page after the first pinned with `?asof=` to the block the first is stamped with. A history that does not end within them is anchored by one more request, the address's totals as of the same block, and the balance is walked back from that; the header then says "The last 200 of 5 598 confirmed transactions" and the oldest block's change reads "no data" (its other rows may be on a page not loaded). A later page that fails is not an error: the pages already in are anchored the same way. So one page view makes at most 9 of the chart's requests, inside a client's share of the address routes ([`CONFIG.md`](CONFIG.md#address-and-batch-routes)).
- **Live.** The page's refresh on an address change also asks for the newest summary page, once. `advance` joins it to what is loaded by txid and block (taking the page's own rows where they overlap, so a block re-mined at the same height brings its new time) and carries the balance by what is new and what a reorg took away. When the page does not meet the rows loaded (more new transactions than a page holds), that page alone is anchored by the pinned totals: two requests at most, never the whole history again. A change heard while a load is running queues one more update after it, never a second chain.
- **The axis** keeps zero in view for a whole history (it rose from nothing) and fits the data for a partial one, where zero would flatten every step into one line.

## CSS

- Plain CSS with the tokens in `design/tokens.css`, imported once in `index.tsx`. Never copy a token value; use the custom property.
- Cascade layers, in this order: `reset, base, layout, components, pages`. Shared components write in `@layer components`, pages in `@layer pages`.
- One CSS file per component, next to it, imported by the component. BEM-style names: `block`, `block__part`, `block--variant`. Prefix a page's classes with the page name (`tx-flow`, `block-grid`) so pages never share a class by accident.
- Per-element values (a fee color, a position) are custom properties set through Solid's `style` object, with a value that comes from props or a signal: `style={{ "--swatch": feeColor(rate) }}`. Solid applies those through the CSSOM, which the Content-Security-Policy allows. Never write a `style` string, and never put a literal value in a `style` object: Solid 2's compiler writes the literal entries of an object into the element's `style` attribute in its template, even beside dynamic ones, and the policy blocks that.
- Breakpoints: 1040 px and 640 px ([`DESIGN.md`](DESIGN.md)).

## Theme

Light by default, dark when the OS asks, either one forced by the toggle. A forced choice is stored under `theme` in `localStorage`. Choosing the scheme the OS already shows clears the stored choice, so the page follows the OS again.

The stored theme must apply before first paint, and the Content-Security-Policy forbids inline script. So `index.html` loads `public/boot.js` as a small blocking same-origin script in the head: it sets `data-theme` and `data-network` on `<html>` before the body is drawn. It is fetched alongside the render-blocking stylesheet, so it adds no round trip.

Prose is set in the system font, which needs no download. The web font (Recursive Mono, for hashes, addresses and numeric columns, and the narrow space between digit groups everywhere) is preloaded, and `index.tsx` waits up to 1 s for it before the first render, so text is laid out once. If it is not there in time, the app takes both Recursive faces out of `--font-sans` and `--font-mono` for that page load (read from the tokens, not restated), so a late font never swaps in and reflows text; the next load finds it in the browser's cache. Anything that appears after the first render must not move what is already on screen: reserve its space, or put it where nothing follows it.

## Rules for page builders

1. **Stay in your directory.** A page owns `pages/<page>/` and nothing else. Its only edit outside is the one line in `src/routes.ts`, plus a function in `paths` and types in `lib/esplora.ts` when it needs them; those are append-only.
2. **Shared code changes in its own PR.** `components/`, `lib/`, `shell/` and `styles/` are shared. If a page needs a change there (a new prop, a fix, a new component), make it a small separate PR, or ask whoever is working on the shell. A component used by one page lives in that page's directory until a second page needs it.
3. **Chain data is text.** No `innerHTML`, no markup built from data, no data in `href` or `src` except through `paths` ([`SECURITY.md`](SECURITY.md) rule 14).
4. **No style attributes.** Custom properties through the `style` object, every value dynamic (see "CSS").
5. **Numbers through `lib/format.ts`.** Never `toFixed` a BTC amount or a fee rate in a page. Every amount, rate and size reaches a screen reader with its unit: in a table cell whose unit is in the header, use the components' `unit={false}`, or a `visually-hidden` unit after a number you format yourself.
6. **No layout shift.** Reserve space for what loads later.
7. **Stay in budget.** The shell and the home page together load at most 100 KB of gzipped JavaScript (`bun run size`). Other pages load on demand and should stay small too; a heavy component (the WebGL grid, the charts) loads only on the page that uses it.
8. **Plain HTTP is a real deployment.** A self-hosted explorer is often reached over HTTP at a private address, where browsers hide APIs they keep for secure contexts (`navigator.clipboard`, `crypto.subtle`, `crypto.randomUUID`, service workers). Code that uses one has a fallback that works without it, and a browser test from an insecure origin (`e2e/copy.e2e.ts` shows how); `CopyButton` falls back to the copy command and says when nothing was copied.
9. **Test what has logic.** Pure functions get unit tests next to them. Components can be tested in Vitest's DOM: `mount()` in `components/test-utils.tsx` renders inside a router (`createRouter` with `memoryHistory(url)`) at a given URL.
10. **Write for Solid 2.** Its migration guide and RFCs are in the solid repository under `documentation/solid-2.0/`; these are the rules that bite in this app:
   - **A write is seen after the flush.** `setX(v); x()` still gives the old value until the update is applied (the next microtask, or `flush()`). Code that writes and then reads in the same turn keeps the value in a plain variable that the signal mirrors (`createBlockFeed`'s list, the pool page's count), or uses the updater form `setX((n) => n + 1)`. `batch` is gone: writes in one turn are applied together.
   - **Effects are split.** `createEffect(() => source(), (value, previous) => { …; return cleanup })`: the first function tracks and only reads, the second does the work untracked and returns its cleanup. `on()` is gone: the first function is the dependency list, and `{ defer: true }` skips the first run. The first function runs when the effect is created, so declare an effect below everything it reads.
   - **`onSettled` replaces `onMount`.** It returns its cleanup; `onCleanup` inside it throws. It runs once, untracked.
   - **No writes from a component body or a memo** (development throws). Write in handlers, effects' second function, `onSettled`, or async callbacks. A value derived from another and also written (the address history's later pages) is a function-form `createSignal((prev) => …)`; `createComputed` is gone.
   - **Boolean attributes are presence.** `true` writes an empty attribute and `false` removes it, so `aria-*` and other true/false attributes take the strings: `aria-busy={loading() ? "true" : "false"}`, `spellcheck="false"`. Attribute names are lowercase (`maxlength`, `tabindex`).
   - **Classes and lists.** `classList` is gone: `class={["base", { "base--on": on() }]}`. `Index` is `<For keyed={false}>`, `splitProps` is `omit`, `Suspense` is `Loading`, `ErrorBoundary` is `Errored`.
   - **Read props in JSX or a memo.** A read at the top of a component body is not tracked and warns in development; wrap a deliberate one-time read in `untrack`.
   - **In tests, flush before you look.** After an event, a timer or a write the test made, call `flush()` before reading signals or the DOM. `FakeSocket` flushes after each message and close, as a browser's task boundary would.

## Accessibility

The bar is WCAG 2.2 AA. What a new page must do:

- **One `h1`, headings in order, the title from `usePageTitle`.** Chain data stays text (rule 3 above), read aloud as text.
- **Every control reachable by Tab in reading order, with the global focus ring.** No positive `tabindex`; never `outline: none` without another ring. Escape closes anything that opens over the page (`components/pop.ts` does it for you). The sticky header never covers focus: `Header.tsx` keeps `--header-h` current for the page's `scroll-padding-top`.
- **A name for every control, table and drawing.** Icon-only buttons take `aria-label`; tables a caption (`DataTable` does it; a column whose rows name themselves takes `hidden` for a header read only aloud); a canvas or chart a text alternative carrying the same figures (`Chart`'s "Show the figures", the list beside `TxGrid`).
- **Live updates said once, politely.** A polite region for a new block, a state change or a copy; never one that changes on every tick.
- **Never colour alone,** and colours only from the tokens: `src/styles/contrast.test.ts` measures every text, mark and surface pair in both themes.
- **Breakpoints in `em`,** so a large text size reaches the narrow layouts. At 18.75em and below, stack what sits two to a row.
- **Motion from the duration tokens,** so reduced motion stops it.

`e2e/a11y.e2e.ts` holds these on every page type: [axe-core](https://github.com/dequelabs/axe-core) (a pinned development dependency, injected by Playwright, never served) in light and dark, a keyboard walk down and back up the page (the skip link first, every control reached, a ring at every stop, none under the header; Option-Tab in WebKit, as in Safari), no movement under reduced motion, Escape on the pop-ups and the search's answer, and the shell and the transaction page at 320 px, at a phone's large text and at 200% text (the text sizes in Chromium only, the one engine a test can set them in). Add a new page type to its list. One axe rule is off, with its reason in the file. axe holds targets at 24 px; `e2e/targets.e2e.ts` holds the design's 44 ([`DESIGN.md`](DESIGN.md#space-shape-and-layout) "Touch") on every page type in `e2e/pages.ts`, at 390 and 320 px on a touch screen, with an exact amount's pop-up open: for every control in sight it measures, from the control's centre, how far a tap still reaches it, by what the browser finds under the finger (`elementFromPoint`), so a neighbour drawn over it counts against it. A link to the same place counts as the same target, as a list's row and its first cell's link are. Give a new small control `.tap` or `.tap-line`.

Checked by hand in November 2026 and not by a test: that no live region speaks on a mempool tick (eight seconds on every live page, mainnet); that the canvas drawings and charts have their text alternatives; the contrast of fades and loading states, which dim content on purpose while it is replaced. A screen reader has not been run; with VoiceOver, check first the home page's block strip and its new-block announcement, a transaction confirming, the search's answer, the exact-amount pop-up, and a chart's slider and figures.

## Checks

Lint, format and type checks are strict, and CI fails on any finding. OXC is the only linter and formatter: never add Biome, ESLint or Prettier.

| Command | Runs | Covers |
|---|---|---|
| `bun run typecheck` | `tsc` on `tsconfig.app.json`, then `tsconfig.node.json` | Everything: the app and its unit tests (browser types only, so app code cannot reach Node's `process` or `Buffer`); browser tests, scripts and configs (Node types) |
| `bun run lint` | `oxlint`, then `oxfmt --check` | What CI's lint step checks |
| `bun run format` | `oxfmt` | Rewrites files in place. `bun run format:check` checks without writing |

- **Lint.** Every `oxlint` category is an error (correctness, suspicious, perf, pedantic, style and restriction), with the TypeScript, unicorn, oxc, import, promise and JSX accessibility plugins, and Vitest's for unit tests. Rules that need types (unawaited promises, promises passed where a callback returns nothing, unsafe `any`) run through `oxlint-tsgolint` on the same tsconfig. Nothing is set to warn. A rule is off in `.oxlintrc.json` only with its reason beside it. An exception for one line is `// oxlint-disable-next-line <rule> -- <why>`; a disable that no longer matches anything fails the check.
- **Format.** `oxfmt` formats everything in `web/` it can parse: TypeScript, JavaScript, JSON, CSS and HTML, at 100 columns. It cannot format `scripts/e2e.sh`.
- **Types.** On top of `strict`: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` (an index signature is read as `x["key"]`, a reminder it may be missing), `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode` and `allowUnusedLabels` off, `noUncheckedSideEffectImports`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, and `checkJs` for the JavaScript files. Left off: `isolatedDeclarations`, which is for publishing type declarations; and `skipLibCheck` stays on, so dependencies' own type errors are not ours to fix.

## Testing

`bun run test` runs Vitest in a happy-dom document, so logic and components are tested the same way. `bun run size` checks the first load after `bun run build`, and fails on any of three things:

- **JavaScript over 100 KB gzipped:** the scripts `index.html` loads, the home page's chunk, and everything they import statically.
- **More than 10 files on a cold home page:** the document, `boot.js`, the font, the shell's scripts and stylesheet, and the home page's code and styles as the shell's preload list names them. On a slow network each file waits for one of the browser's six connections to a site over HTTP/1.1, so a page that needs 23 small files shows its data about a second later than one that needs 10 ([`PERFORMANCE.md`](PERFORMANCE.md#4-shorten-the-pages-request-chain-on-slow-networks-done)). Raise the number only with a measurement that says the new file is worth its wait.
- **A first stylesheet that does not open with the `reset` layer** (see [below](#chunks)).

### Chunks

How the build splits the code decides how many files a cold page waits for. `vite.config.ts` puts one group, `app`, in front of everything: `index.html` loads a small entry script that only imports it, a `modulepreload` for it and its one stylesheet, all at once.

- **In `app`:** the entry module and the shell it imports (Solid's runtime among it), the live channel and the topics the home page reads (`live.ts`, `blocks-topic.ts`, `projected-topic.ts`), the clock, and the small components most pages use (`Amount`, `DataTable`, `FeeRate`, `Hash`, `SectionHeader`, `Strata`, `Time`). Left to the bundler, the components split by which pages share them into 14 more files of under 1.5 KB each on a cold page.
- **One stylesheet for the shell.** With the entry module in the group, the tokens, the global styles and every style the group imports land in `app`'s stylesheet, the only one `index.html` links. It opens with the layer order from `global.css`; layers are ordered by where each first appears, so a stylesheet linked before it that opened with `@layer components` would make every component lose to the reset. `bun run size` checks it.
- **Everything else stays lazy:** each page with what only it uses, and the heavy parts (the transaction grid, the charts, the audit list, the Lightning pages) only where they are used. A cold home page is 10 files ([`CONFIG.md`](CONFIG.md#per-client-defaults) has every page).
- **The cost:** a page loads the whole group, used or not. The transaction page loads `DataTable` and `Strata` (about 2 KB) without drawing them; that is less than the headers of the files it no longer asks for. And the components' styles now come with the shell's stylesheet, which, like the shell's styles before, is not asked for again if it fails to download ([above](#when-a-pages-files-fail-to-load) covers a page's own files).

Add a component to the group only when most pages use it and it would otherwise be a file of its own on their first load.

CI runs typecheck, lint, test, build and size, and the browser tests below ([`CI.md`](CI.md)).

## Browser tests

`bun run e2e` runs the Playwright tests in `web/e2e/` in headless Chromium ([or another engine](#other-engines)) against the real server and a private rbitcoin node on regtest ([`REGTEST.md`](REGTEST.md)). It needs Docker, `python3`, Rust and bun, and does everything else itself: starts the node and builds the known chain, builds the frontend and the server from your checkout, starts the server on a free port with only regtest enabled and its block table in the run's directory (with some mempool history already in it, [below](#adding-a-test)), runs the tests and removes all of it. A second run takes about 10 seconds. Every run uses its own node, port and output directory, so any number can run at once. On a failure it keeps the server log and Playwright's traces and prints where.

Arguments go to Playwright: `bun run e2e tx.e2e.ts`, `bun run e2e -g "deep link"`, `bun run e2e --headed`.

**The server runs with every limit at its production default** ([`CONFIG.md`](CONFIG.md#limits)), so each run also proves that real page loads stay inside them. The tests all come from one address, so each test poses as its own visitor, as its fresh browser context (empty cache, no cookies) is: the server trusts `X-Forwarded-For` from `127.0.0.1` only, and the fixture sends an address of the test's own (`198.18.<worker>.<test>`) on every page, file, API call, WebSocket handshake and `request` call. One address per worker would be one person making a dozen cold loads in seconds, which the block summary route's per-client limit rightly refuses. A test that sets `extraHTTPHeaders` itself must keep that header.

**A limit that refuses anything fails the run, and says which.** A page or static file answered `429` or `503` ends its test at once with the request named, instead of a later assertion timing out. After the tests, `bun run e2e` fails if the server's log holds any refusal, even of an API call a page retried, and prints them: each line names the route, the limit (`refused`) and the worker's address (`client`).

### Other engines

```sh
E2E_ENGINE=webkit bun run e2e              # or firefox; chromium is the default
E2E_ENGINE=webkit E2E_PHONE=1 bun run e2e  # at a phone's width
```

`E2E_ENGINE` picks Playwright's Chromium, WebKit or Firefox, and `E2E_PHONE=1` a phone: Chromium as a Pixel 7, WebKit as an iPhone 15 (mobile viewport, touch, three device pixels per CSS pixel), and Firefox, which has no mobile emulation, as a 393 × 659 window with touch and three device pixels per CSS pixel. The script downloads the engine into Playwright's own cache on first use; on Linux, `node_modules/.bin/playwright install-deps <engine>` (as root) adds its system libraries once. Pull requests run Chromium at desktop width only; the weekly Browsers workflow runs WebKit and Firefox at both widths ([`CI.md`](CI.md#other-browsers)).

What it proves: the pages work in the WebKit and Gecko engines. What it does not: Playwright builds its own WebKit, so a pass is not Safari on a Mac or an iPhone (other graphics, fonts, network stack and settings), least of all on CI's Linux. Check a change that depends on the engine by hand in Safari too.

Differences found so far (2026-11, Playwright 1.64):

- **Closing a socket that is still connecting** is logged as a failed connection by WebKit and Firefox, not by Chromium. Leaving a page often does that, so `lib/live.ts` closes such a socket once it opens instead.
- **A page whose script failed to download** cannot be loaded again in the same document in WebKit, which keeps the failure ([above](#when-a-pages-files-fail-to-load)). WebKit recovers by reloading the page, Chromium and Firefox in place; `chunks.e2e.ts` covers all three.
- **A character the font lacks** is drawn from another font, chosen differently by each engine: the narrow no-break space that groups digits was 0.15 em in Chromium, 0.12 em in Firefox and 0.05 em in WebKit (`1 293` read as `1293`) until it was added to the subset ([`DESIGN.md`](DESIGN.md#type)). Give any new character a glyph in the subset; `shell.e2e.ts` measures the digit-group gap in every engine. Since prose moved to the system font, a face limited by `unicode-range` supplies that space: Chromium and WebKit use it, while Firefox takes a space from the font of its neighbours (the system font's: 0.10 em on a Mac, 0.20 em in DejaVu Sans on Linux).
- **A font download cut short by leaving the page** is a console error in Firefox ("downloadable font: download failed … status=2152398850", which is `NS_BINDING_ABORTED`), and silent in Chromium and WebKit. Firefox asks for a `unicode-range` face only once a page shows one of its characters, so the digit-gap face used to start downloading after render, and a test that moved on quickly failed about one run in twenty on Linux. The page now loads both faces before its first render (`index.tsx`).
- **A module script runs before a stylesheet linked after it has loaded** in WebKit; Chromium and Firefox wait. The build links ours after the script, so on a slow load the tokens read the empty string and the browser's toolbar took the light colour over a dark page. `index.tsx` waits for the linked stylesheets before it reads tokens and renders; `shell.e2e.ts` delays them to prove it.
- **An SVG of `height: auto` takes its viewBox's ratio** in WebKit even under `contain: size`, so the transaction flow's ribbons held the row at the height they were last drawn at. They are sized by the row instead (`height: 0; min-height: 100%`).
- **A fetch that leaving a page cut off,** and one the page starts while it unloads, is an error of its own in WebKit on Linux ("Fetch API cannot load … due to access control checks"), even when the page caught the rejection. The test fixture holds errors in that wording for our own origin from a page's navigation request, and drops them once the next document starts; a navigation that keeps the page (no content, or aborted) starts none, so they count (`console.e2e.ts`).
- **On Linux** (the Browsers workflow, [`CI.md`](CI.md#other-browsers)), Firefox without a display has no WebGL at all ("Exhausted GL driver options"), so the workflow runs it under Xvfb, where Mesa draws. Firefox there also decides once, at launch, whether to allow WebGL2: only if its GPU probe (`gfxtest`) answers within 4 s. On a busy runner it sometimes did not, and that browser refused WebGL2 for its whole life ("AllowWebgl2:false restricts context creation on this system"), so the first grid tests it ran found the page's no-WebGL2 stand-in, correctly shown, and timed out; the worker Playwright started after the failure worked. The tests launch Firefox with `webgl.force-enabled`, which skips that check. A visitor's Firefox that refuses the same way gets the fee layers and the note that the map needs WebGL2. WebKit there shows a WebGL frame drawn without antialiasing only once the next frame is drawn, so the grid draws its last frame twice; otherwise a single frame (a restored context, a resize, a theme switch) never appears.
- **Safari's Tab** reaches only form fields unless the reader has turned on "Press Tab to highlight each item"; Option-Tab reaches the skip link and every link. Playwright's WebKit does the same.
- **WebKit shows a JSON reply** (`/healthz`, an API route opened as a page) in a viewer the Content-Security-Policy refuses, which logs a violation that is not the site's.
- Same in all three: `ws:` and `wss:` to the page's own host under `default-src 'self'`, the `Origin` check on `/app/ws`, WebGL2 and the page without it, the charts' pointer, touch and keyboard read-outs, reduced motion. Numbers and dates are formatted by our own code, not `Intl`, so they read the same everywhere.

Write browser tests so they hold in every engine:

- **Read a screenshot at the device's scale.** Desktop Safari has two device pixels per CSS pixel and the iPhone three: divide by the ratio, never assume 1 (`grid.e2e.ts`).
- **CSP violations are reported by the page,** through `securitypolicyviolation`, since each engine words its console message differently. In WebKit, every Playwright screenshot adds a style the policy refuses, reported against the document rather than an element; the fixture names that one and drops it. `csp.e2e.ts` proves a style of the site's still fails its test, screenshot or not.
- **A test that depends on width checks it** (`page.viewportSize()`), as the home page's test does for the note a phone hides.
- **Wait for the page's frames, not a clock.** WebKit at phone width on a busy runner went over 3 s without a frame after a resize, so a check that gave the page 3 s to fit its tables failed. `tablesFit` (`e2e/rows.ts`) waits until two frames pass with no resize of what the tables watch, then checks once.
- **Phone screenshots for a UI change come from WebKit** as an iPhone, besides Chromium: the owner's first device is a phone.

### Other systems' fonts

Prose is set in the reader's system font, and most readers are not on a Mac ([`DESIGN.md`](DESIGN.md#type)). The browser tests can set prose in a stand-in for another system's font instead, on any machine, with nothing installed and no font file in the product: `e2e/fixtures.ts` registers local faces (`FontFace` with `local()`) before the app runs and points `--font-sans` at them, keeping "Recursive Gap" first as the real stack does. A run whose machine has none of a stand-in's faces fails, rather than measure in the wrong font.

| Stand-in | Faces, the first this system has | Stands for |
|---|---|---|
| `wide` | DejaVu Sans (Linux), Verdana (Mac, Windows) | DejaVu Sans, Linux's usual default and the widest measured |
| `narrow` | Liberation Sans (Linux), Arial (Mac, Windows) | Roboto, Cantarell, Segoe UI and other narrow faces |

Widths of 20 of the site's own strings ("Fees waiting", "0.0000426 BTC", "Lowest accepted", the section names, a fee rate, a sentence), 16 px, in Chromium, against San Francisco; the Linux fonts measured in an Ubuntu 24.04 container (2026-11):

| Font | Regular | Bold (600) |
|---|---|---|
| DejaVu Sans | +10.0% | +18.6% |
| Verdana (the `wide` stand-in on a Mac) | +10.2%, each string within −1.4 to +3.2% of DejaVu's | +18.4%, within −1.7 to +4.9% |
| Noto Sans | +2.8% | +4.5% |
| Roboto | −2.1% | −5.3% |
| Cantarell | −2.2% | −3.6% |
| Liberation Sans, Arial (`narrow`) | −2.7% | −0.2% |

Segoe UI, Windows' default, could not be measured here (it is not free to install); its published metrics put it among the narrow faces.

```sh
E2E_PROSE=wide bun run e2e tables.e2e.ts amounts.e2e.ts shell.e2e.ts   # the rule tests in a stand-in
E2E_SWEEP=1 bun run e2e fonts.e2e.ts                                   # the whole sweep, wide
E2E_SWEEP=1 E2E_PROSE=narrow bun run e2e fonts.e2e.ts                  # or narrow, or system
```

`fonts.e2e.ts` loads every page type once and resizes it through the widths, checking at each that no text runs into other text, nothing is cut, on any edge, by a box that scrolling cannot move (a cut name or hash keeps its whole in its title, and a short form such as `mwLW3XD…UAuat` never loses what follows its "…"), no control's label wraps when it has room to grow, no figure wraps or leaves its field (`amountsIntact`), every table fits or shows that it scrolls (`tablesFit`), and the page is no wider than the window (`layoutFaults` in `e2e/layout.ts`). It lists every fault of a run at once. With `E2E_SWEEP=1` it takes the design's widths, 640 and 1040 either side, and every 40 px from 320 to 1440, each in both schemes: about 5 s a page. Pull requests run it in the wide stand-in at the widths where it found faults, 320, 400, 641 and 1100 px, one scheme each: about half a second a page.

To see the real fonts rather than a stand-in, run the same tests in a Linux container with `fonts-dejavu-core` and `fonts-noto-core` and Playwright 1.64.1's Chromium, with `E2E_PROSE=system` and `E2E_BASE_URL` pointing at a `bun run e2e`-style server the container can reach. On 2026-11-13, in that container (Ubuntu 24.04, Chromium), the whole sweep on the build before the fixes failed in all ten places the `wide` stand-in found on a Mac with DejaVu Sans as the system font, and in six of them with Noto Sans; after the fixes it passed with both.

### Adding a test

Put it beside the others as `web/e2e/<page>.e2e.ts` (the `.e2e.ts` suffix keeps Vitest away from it), and import from `./fixtures`, never from `@playwright/test`:

```ts
import { chain, expect, test } from "./fixtures";

test("a block page shows its height", async ({ page }) => {
  await page.goto(`/regtest/block/${chain.blocks[106]}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("106");
});
```

- **Pages are under `/regtest/`.** Only regtest is enabled, so the root is a 404.
- **`chain`** in `e2e/fixtures.ts` is the scenario's manifest: tip, block hashes, txids and addresses of every script type. They are the same on every run.
- **Every test fails on a console error, an uncaught exception or a Content-Security-Policy violation** on any page it opens. The fixture does this by itself. If your test causes an error on purpose, such as a request that is meant to 404, name it: `test.use({ consoleErrorsAllowed: [/status of 404/] })`. A CSP violation cannot be allowed.
- **Find elements by role and text,** as a reader would (`getByRole`, `getByText`), not by class names.
- **Tests share one node and run in parallel, so only `*.mine.e2e.ts` files mine.** A new block changes the tip every other test reads. Playwright runs those files in a separate `mines` project that starts after every other test has finished and runs one test at a time; only there does the `mine(n)` fixture work (it returns the new block hashes). Anything else that changes the chain belongs there too. The broadcast test in `api.e2e.ts` adds one transaction to the mempool, so do not assert the mempool's exact size.

  ```ts
  test("a new block lands without a reload", async ({ page, mine }) => {
    await page.goto("/regtest/");
    const [hash] = await mine(1);
    const strip = page.getByRole("list", { name: "Mined blocks, newest first" });
    await expect(strip.getByRole("link").first()).toHaveAttribute("href", `/regtest/block/${hash}`);
  });
  ```

- **Hostile chain data.** `hostile.mine.e2e.ts` puts markup, a `javascript:` URL, bidi overrides, ANSI escapes and NUL on the chain (`regtest.py hostile`: OP_RETURN outputs and a hand-built coinbase tag) and checks the transaction, block and address pages show them as visible, inert text: no injected element, no dialog, no unexpected link scheme. A new page that shows chain data belongs in it.
- **Wait on the page's own bounds, by name.** The projected blocks can trail the node by up to `PROJECTION_LAG_MS` (in `e2e/fixtures.ts`, with its reasoning): a new transaction until the tracker's next cycle and the topic's next send, a new block until its projection, which follows the `block` message at once unless the node is slow to serve the block; the next block's page then holds its notice for up to `FOUND_WAIT_MS` (`src/pages/projected/state.ts`). Import those constants rather than writing a timeout, so the test and the page cannot drift apart. Each wait ends as soon as the page catches up. Before a mining test starts, the `mine` fixture waits until the server's `blocks` and `projected` topics both sit on the node's tip, at most `PROJECTION_LAG_MS`, and fails naming what lagged; otherwise blocks an earlier test mined would arrive together with this test's.
- **Mempool history is stored before the server starts.** The server records its first minute 60 to 120 s after it starts, so `bun run e2e` first writes 15 minutes an hour old, with a five-minute gap, through the sampler's own writer (`crates/engine/src/bin/history_seed.rs`), and `mempool.e2e.ts` checks the page shows exactly those. Never wait for a live minute in a browser test: the sampler's timing, skipped minutes and roll-ups are proved by the engine's tests on a paused clock (`crates/engine/src/history/tests.rs`), and the page's refetch at each minute by its unit tests.
- **Pages regtest cannot fill** (Lightning is off on regtest) are driven from recorded answers: `lightning.e2e.ts` serves `/regtest/app/lightning/…` with `page.route` from mainnet answers in `fixtures/lightning/app/`, so the built pages are drawn from real data with no test-only route on the server. Its own status route still answers `off`, which the same file checks.
- **Keep the suite fast.** Browser tests cover what only a browser can show: that the page renders real data, links work and nothing errors. Logic belongs in unit tests.
