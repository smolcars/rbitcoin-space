# Configuration

The server reads its configuration from the environment once, at startup. Invalid or half-set configuration stops it with a message naming the variable; values are never echoed, so a mistyped password does not land in a log. The error is written as a `config_invalid` event ([`LOGGING.md`](LOGGING.md)). An empty value counts as unset.

[`.env.example`](../.env.example) is a starting point. The server does not read `.env` itself; load it into the environment (`set -a; . ./.env; set +a`) or pass the variables through your process manager.

## Server

| Variable | Default | What it does |
|---|---|---|
| `LISTEN_ADDR` | `127.0.0.1:8080` | Address and port to listen on. Port `0` picks a free one; the `listening` event shows which |
| `WEB_DIR` | `web/dist` | The built frontend. Nothing outside it is served |
| `DATA_DIR` | unset | Where each network's SQLite file lives (`<DATA_DIR>/mainnet.sqlite`, …). Created if missing; must be writable. It holds only derived and observed data ([`STORE.md`](STORE.md)). Unset, the server runs without a store: everything is asked of the node, and the block table below, the mining routes ([`API.md`](API.md#mining)), the mempool history ([`API.md`](API.md#mempool-statistics)) and Lightning ([below](#lightning)) do not exist. A file that will not open is a `store_open_failed` event, and that network runs without one |

## Networks

A network is enabled when all six of its variables are set, and disabled when none are. Setting only some is an error. `{NET}` is one of `MAINNET`, `SIGNET`, `TESTNET4`, `REGTEST`. Mainnet is served at `/`, the others under `/signet`, `/testnet4` and `/regtest`; a disabled network's paths are a 404.

| Variable | Format |
|---|---|
| `{NET}_RPC_HOST` | Host name or IP address of rbitcoin's JSON-RPC (`--rpc-listen`) |
| `{NET}_RPC_PORT` | Port, 1 to 65535 |
| `{NET}_RPC_USER` | HTTP Basic user |
| `{NET}_RPC_PASSWORD` | HTTP Basic password. Held in a type that prints as `<redacted>` and never leaves the server |
| `{NET}_ESPLORA_URL` | `http://` base URL of rbitcoin's Esplora (`--esplora-listen`), or an absolute unix socket path. The node speaks plain HTTP, so `https://` is refused. Credentials in the URL are refused, since URLs end up in logs |
| `{NET}_ELECTRUM_ADDR` | `host:port` of rbitcoin's Electrum server (`--electrum-listen`), plain TCP |

### The live mempool

| Variable | Default | What it does |
|---|---|---|
| `{NET}_MEMPOOL_ENABLED` | `true` | `false` stops the network's mempool tracker and projected blocks ([`MEMPOOL.md`](MEMPOOL.md#in-the-server)). The mempool topics then answer `off` ([`WS.md`](WS.md#mempool-topics)), fee recommendations are the node's own estimates and `/api/v1/fees/mempool-blocks` is `503` ([`API.md`](API.md#fees)); blocks, the rest of the API and everything else keep working. Optional, unlike the six above |

**Turn it off when you share a node.** With it on, every running server polls its node continuously: on mainnet 120 to 200 MB a minute of RPC answers, measured over a day with 39,000 to 63,000 transactions in the mempool (about 45 tracker cycles a minute, 2.6 to 4.3 MB each, [`DEPLOY.md`](DEPLOY.md#one-day-on-mainnet)), plus an initial sync of about 250 MB and 10 s. Several developers each running a server against the same node multiply that. Leave it on only on the server that serves the mempool, or while you work on it.

### Lightning

The gossip-only Lightning peer ([`LIGHTNING.md`](LIGHTNING.md#in-the-server)), per network. Off unless switched on; it needs `DATA_DIR`, where it keeps its node key, graph file and saved answers in `<DATA_DIR>/lightning/<network>/` (32 bytes, about 33 MB and 3.3 MB on mainnet) beside the history it stores in the network's SQLite file. Setting `{NET}_LIGHTNING_ENABLED=true` without `DATA_DIR` stops the server at startup.

| Variable | Default | What it does |
|---|---|---|
| `{NET}_LIGHTNING_ENABLED` | `false` | `true` runs the peer for the network: it syncs the public channel graph, checks every channel against the node, records opens and closes and serves `/app/lightning/…` and `/api/v1/lightning/…` ([`API.md`](API.md#lightning)). Everything it asks the node goes through one gate: one request at a time, at most 4 a second, and at most a quarter of the node's time ([`LIGHTNING.md`](LIGHTNING.md#load-on-the-node)). That includes each channel's funding txid, asked once: about 2.5 hours on mainnet's first start, then a few hundred a day ([`LIGHTNING.md`](LIGHTNING.md#funding-transactions)) |
| `{NET}_LIGHTNING_PEERS` | mainnet: six public nodes; signet: two public nodes of the default signet ([`LIGHTNING.md`](LIGHTNING.md#peers)); testnet4 and regtest: none | Who to dial, in order of preference: comma-separated `<pubkey>@<ip>:<port>`, 1 to 64 of them. An IP address, not a host name, so nothing is resolved. Set, it replaces the defaults entirely. Required on testnet4 and regtest, and on a custom signet ([`LIGHTNING.md`](LIGHTNING.md#test-networks)) |
| `{NET}_LIGHTNING_MAX_PEERS` | `3` | Connections kept open at once, 1 to 64. Each brings its own copy of new gossip; three cover the graph |
| `{NET}_LIGHTNING_MAX_CHANNELS` | `100000` | The graph's ceiling, at most 1,000,000: new channels beyond it are refused. It bounds the peer's memory (about 4 KB a channel at mainnet's mix, 8 KB at worst: 400 to 800 MB at the default), the routes' index of it (about 85 MB at the default) and its graph file. Mainnet had 36,000 in November 2026 |

**It connects out to the public Lightning network.** The peer opens plain TCP connections to the peers listed (port 9735 for the defaults, and 9745 for one of mainnet's) and keeps them open; it never listens, so no port needs opening. Behind a firewall that blocks outbound traffic, allow TCP to those addresses, or set `{NET}_LIGHTNING_PEERS` to nodes you can reach (your own node, for one). It does not use Tor and cannot reach `.onion` peers: under a Tor-only policy, leave Lightning off, or point it at a clearnet node of your own that relays the graph. It costs about 50 MB of download for the first sync on mainnet, then 1 to 2 kB/s.

**The node's share:** the peer checks each channel's funding output against the node, at most two requests a second whatever gossip sends, and reads each new block once to find closes ([`LIGHTNING.md`](LIGHTNING.md#bounds-and-cost)). A first start on mainnet costs about 125 requests and 18 MB; after that a block costs one raw block (about 1.7 MB) and a request per close.

## Broadcast

| Variable | Default | What it does |
|---|---|---|
| `BROADCAST_ENABLED` | `true` | `false` turns off `POST /api/tx` on every network (it answers `403`). Broadcast is the only write the server makes to the node; its size cap and per-client rate limit are fixed ([`API.md`](API.md#broadcast)) |

## Logging

What each setting changes, and the event catalogue, are in [`LOGGING.md`](LOGGING.md).

| Variable | Default | What it does |
|---|---|---|
| `LOG_FORMAT` | `json`, or `text` when stdout is a terminal | `json` or `text` |
| `LOG_LEVEL` | `info` | Lowest level written: `debug`, `info`, `warn` or `error`. Events below it are not formatted at all |
| `LOG_REQUESTS` | `all` | Which requests get an `http_request` event: `all`, `failures` (status 400 and above) or `off`. A passing `/healthz` or `/readyz` is never logged. Refused requests are counted in `requests_refused` whatever this says, and only the first of each reason after a quiet minute gets its own line ([`LOGGING.md`](LOGGING.md#refusals)) |
| `LOG_CLIENT_ADDR` | `false` | `true` adds the client address, as the rate limiter keys it (IPv4, or an IPv6 /64), to `http_request`. Off by default for privacy; the trade-off is in [`LOGGING.md`](LOGGING.md#why-client-addresses-are-off-by-default) |
| `LOG_MAX_BYTES_PER_SEC` | `262144` (256 KiB) | The log's ceiling: past it, after a burst of ten seconds' worth, request lines and debug events are dropped and counted, while warnings, errors and summaries are always written ([`LOGGING.md`](LOGGING.md#the-ceiling)). At least 1024. Lower it for a small disk: the log grows by at most this times 86,400 a day (22.6 GB at the default). Raise it only if `log_events_dropped` shows `over_budget` for traffic you want every line of |


## Limits

Every request passes these before any handler runs ([`SECURITY.md`](SECURITY.md) rules 6 and 7). Each must be a positive integer. The per-client limits below apply to requests a handler answers (`/api`, `/app`, `/healthz`, `/readyz`, under any network prefix); pages and static files have their own fixed per-client limits ([below](#static-files)), so loading the app never uses up the allowance its API calls need; API preflights have their own too ([below](#preflights)). Refusals are small JSON errors: `429` with `Retry-After: 1` when one client is over its share, `503` when the server as a whole is, `413` for a body that is too large and `504` for a request that ran out of time.

| Variable | Default | Protects against |
|---|---|---|
| `MAX_BODY_BYTES` | `16384` | Memory exhaustion from large request bodies. Enforced when a handler reads the body (axum's body extractors); a route that never reads its body ignores it, and the server discards it unread and closes the connection. A route that needs more raises it for itself; broadcast takes up to 800,000 hex characters ([`API.md`](API.md#broadcast)) |
| `REQUEST_TIMEOUT_SECS` | `10` | Slow handlers and slow uploads holding a slot forever. The same value bounds how long a connection may take to send its request headers or sit idle between requests, so half-sent requests (slowloris) and idle keep-alives are closed, and how long a write to the client may make no progress, so a client that stops reading its responses is disconnected |
| `MAX_CONNECTIONS` | `1024` | Running out of file descriptors. Past it the server stops accepting until a connection closes. Keep it below the process's open-file limit |
| `MAX_CONCURRENT_REQUESTS` | `256` | Overload. Requests past it are refused at once with `503`, not queued |
| `CLIENT_MAX_CONNECTIONS` | `64` | One address holding many open connections. Derived [below](#per-client-defaults). Past it a new connection is closed at once (the client sees a reset) and counted in a `connections_refused` event. Not applied to connections from a trusted proxy (`TRUSTED_PROXIES`), which carry many clients |
| `CLIENT_MAX_CONCURRENT_REQUESTS` | `48` | One address occupying many request slots with slow requests. Derived [below](#per-client-defaults) |
| `CLIENT_RATE_PER_SEC` | `20` | One address sending a sustained flood. Refilled continuously |
| `CLIENT_BURST` | `120` | Size of a client's token bucket: how many requests it may send at once. Derived [below](#per-client-defaults) |
| `MAX_TRACKED_CLIENTS` | `65536` | The rate limiter's own memory. A client that has been quiet long enough to refill its bucket is forgotten. If more clients than this are active within one refill period (`CLIENT_BURST / CLIENT_RATE_PER_SEC` seconds), new ones get `503` until some go quiet, and clients already tracked are still served |
| `TRUSTED_PROXY_HEADER` | unset | The header a reverse proxy writes the client's address to, for example `X-Real-IP` or `X-Forwarded-For`. Needs `TRUSTED_PROXIES`; setting one without the other stops the server at startup |
| `TRUSTED_PROXIES` | unset | Comma-separated IP addresses or CIDR prefixes (`127.0.0.1`, `172.16.0.0/12`, `::1`, at most 64, no `/0`) of the proxies allowed to send that header. The header is read only on connections from these addresses; from anyone else it is ignored and the socket address is the client. [How the address is found](#client-addresses) |

Fixed limits: a request head (request line and headers) may be at most 16 KiB. A malformed or oversized request head is refused by the HTTP parser itself with an empty `400` or `431` and the connection is closed; those responses carry no body and so no error JSON or security headers.

Clients are counted by IPv4 address or by IPv6 /64, since one host routinely holds a whole /64. Many users behind one NAT share a single client's limits; raise `CLIENT_RATE_PER_SEC`, `CLIENT_BURST` and `CLIENT_MAX_CONCURRENT_REQUESTS` if that is your audience.

### Client addresses

A header is only as trustworthy as the peer that sent it, so the server reads `TRUSTED_PROXY_HEADER` only on a connection whose socket address is in `TRUSTED_PROXIES`. Every other connection is keyed on its socket address, whatever headers it sends. On a trusted connection:

- Every instance of the header is read as one comma-separated list, in order. Entries are IP addresses, optionally with a port (`203.0.113.9:4711`, `[2001:db8::1]:443`).
- The list is walked from the right, the end the nearest proxy wrote. Entries that are themselves in `TRUSTED_PROXIES` are skipped; the first other address is the client. Anything to its left was written by the client and is never read. This is what makes a chain of proxies work (a CDN in front of nginx: list both) and a client's own `X-Forwarded-For` harmless, as long as each proxy appends to the header or overwrites it.
- If every entry is a trusted proxy, the leftmost is the client. If the header is missing, or the walk meets an entry that is not an address, the client is the last trusted address reached: the proxy itself. A misconfigured proxy then shares one allowance among all its clients, which is noticed quickly, and no client can choose another's.

The proxy must overwrite the header or append to it; a proxy that passes the client's own header through unchanged lets clients choose their address. [`DEPLOY.md`](DEPLOY.md#tls-and-the-reverse-proxy) has examples. `RFC 7239` `Forwarded` headers are not parsed.

### Per-client defaults

The defaults above are derived from what the frontend really asks for, so an ordinary user is never refused. A cold load of each page in a fresh browser, recorded by [`dev/cold-load/record.mjs`](../dev/cold-load/record.mjs) on the regtest scenario chain, last recorded 2026-11-12 after PF4 merged the small shared chunks into the shell's, with the address page's balance chart ([`FRONTEND.md`](FRONTEND.md#chunks)). The same recording of the build before it is in brackets:

| Page | Static files | API requests | WebSockets | Most API requests in flight |
|---|---|---|---|---|
| Home | 10 (23) | 3 | 1 | 1 |
| Blocks | 10 (20) | 13 | 0 | 2 |
| Block | 12 (26) | 6 | 1 | 5 |
| Transaction | 9 (19) | 5 | 1 | 3 |
| Address | 16 (27) | 10 | 1 | 4 |
| Mining | 15 (26) | 6 | 0 | 4 |
| Lightning | 10 (18) | 2 | 0 | 1 |

At most 7 static files were in flight at once on any page (18 before).

Opening a block's audit list adds two files and one API request. Since the recording, the home page's recent replacements add one API request to its cold load (`/api/v1/replacements`), and one more whenever a replacement arrives, at most every 10 s. An open home page then polls about once every 3 seconds. Static files are `/assets`, the app shell and `boot.js`; a second load takes them from the browser cache.

| Limit | Default | Derivation |
|---|---|---|
| `CLIENT_MAX_CONNECTIONS` | `64` | A browser opens up to six HTTP/1.1 connections per site, shared by its tabs, plus one per WebSocket while it upgrades, and Chrome opens spare ones ahead of need. Ten browsers behind one address: 60. The browser tests' five parallel browsers went past the old 32 in three runs of three |
| `CLIENT_MAX_CONCURRENT_REQUESTS` | `48` | Three cold loads of the heaviest page at the same moment (three browsers behind one NAT, or one restoring tabs), with every API request of each in flight together: 3 × 13 = 39, against a measured peak of 5 per page. Headroom for the page that grows next |
| `CLIENT_BURST` | `120` | A restored session of eight tabs loading one after another: 8 × 13 = 104 |
| `CLIENT_RATE_PER_SEC` | `20` | Unchanged: sixty open home pages polling, or a full burst refilled in 6 seconds |
| `WS_CLIENT_MAX_SOCKETS` | `16` | One socket per open tab; sixteen tabs |
| New address follows (derived) | 30 at once, 2 a second | Only the address page follows an address, one per page; transaction and block pages follow transactions, which cost nothing. Sixteen address tabs restored at once: 16. A visitor clicking through pages in a browser on the regtest scenario, 300 ms apart, for 26 s (an eight-output transaction's addresses, a block's transactions, every scenario address as a cold load, then eight address tabs at once): 49 follows, at most 9 in one second, none refused. That visitor was refused 150 address route calls (`route_rate`): a cold address page makes 9 of them, so the routes' share runs out after three address pages in a row, long before this one |
| Static files, fixed | 400 at once, 100 a second, 96 in flight | Set when the heaviest page needed 25 files: sixteen cold loads of it at once, and three of them with every file in flight together (75). The heaviest now needs 16 (the address page), which the same derivation would put at 256 and 48; the limits are unchanged, which leaves that much more room for a NAT or a page that grows |

`crates/server/tests/cold_load.rs` replays the recorded loads ([`fixtures/cold-load.json`](../fixtures/cold-load.json)) through the real limiter with these defaults, three tabs at once and eight in a row, and fails if any request is refused. **When the frontend changes what a page loads, re-record the fixture** (the script's header says how) and run that test; if it fails, raise the defaults here with the new numbers.

The browser tests run at these defaults too, each test as a client of its own behind a trusted proxy ([`FRONTEND.md`](FRONTEND.md#browser-tests)), and fail on any refusal. `CLIENT_MAX_CONNECTIONS` does not apply to a trusted proxy's connections, so they do not exercise it.

### Static files

Pages and the files under `/assets` are answered from memory or disk with no node work behind them; a block page's head reads at most one row of the block table, two at once server-wide ([`FRONTEND.md`](FRONTEND.md#link-previews)). They have their own per-client limits, fixed: a burst of 400, refilled at 100 a second, and 96 in flight at once, counted separately from the API's. They still pass `MAX_CONCURRENT_REQUESTS`, `MAX_CONNECTIONS`, `CLIENT_MAX_CONNECTIONS` and the timeouts like every request, so a client flooding them is refused with `429` while others are served.

There is no setting for the site's public address. Link previews ([`FRONTEND.md`](FRONTEND.md#link-previews)) leave out `og:url` and the canonical link rather than build them from the request's `Host`, which a client chooses. A preview image will need an absolute URL; that change adds the setting.

### Preflights

A browser sends an `OPTIONS` preflight before some cross-origin calls to `/api` (a `POST` with a JSON body, for one) and caches the answer for up to a day. Preflights to `/api` are counted in a per-client table of their own with the API's numbers: `CLIENT_RATE_PER_SEC`, `CLIENT_BURST` and `CLIENT_MAX_CONCURRENT_REQUESTS`, and `MAX_TRACKED_CLIENTS` entries. A page sends at most one preflight per call, so a page whose calls are allowed is never refused their preflights, and a preflight never spends the token of the call it precedes. A client flooding preflights is refused with `429` past its allowance, and the refusals are summarised like any other ([`LOGGING.md`](LOGGING.md#refusals)). An `OPTIONS` outside `/api` is no preflight we answer and is counted like any request to its path.

### Address and batch routes

The address and scripthash routes, `/txs/outspends` and `POST /block-heights/txs/outs` can cost the node seconds each ([`API.md`](API.md#protection-for-the-node)). Per network, fixed: four run at once and eight more may wait for a slot; past those twelve the answer is `503` `node busy; retry` at once. Per client, a share of its general limits, so raising those for a NAT raises this too: `CLIENT_MAX_CONCURRENT_REQUESTS / 12` running or waiting (4 by default: two address pages at once), and `CLIENT_BURST / 4` started at once then `CLIENT_RATE_PER_SEC / 10` a second (30, then 2: an address page costs two). Past those, `429`. Both refusals carry `Retry-After: 1`. A call counts as running until the node has answered or 60 seconds have passed, even when the request that started it has timed out; a request still waiting gives its place back when it times out. A page of address history is answered `504` once the node has spent 5 s on it, and addresses the node will not finish are refused at once for 5 minutes; totals of an address not known to be small wait for the server's one large-address lane; all fixed ([`API.md`](API.md#very-large-addresses)).

Following an address on either WebSocket has a per-client budget of its own with the same numbers, `CLIENT_BURST / 4` at once then `CLIENT_RATE_PER_SEC / 10` a second (30, then 2), counted only when the node is asked something: a new subscription, or the first history read on `/api/v1/ws` ([`WS.md`](WS.md#following-a-transaction-or-an-address)). Its own bucket rather than the address routes': the address page subscribes before it fetches, so sharing would let a visitor's socket spend the tokens its page needs next. So one client can start at most 60 such node calls at once and 4 a second after, per network: 30 and 2 through the routes, 30 and 2 through the sockets.

### Very large addresses

The address ledger ([`API.md`](API.md#very-large-addresses), [`STORE.md`](STORE.md#ledger)) needs `DATA_DIR`. Its other bounds are fixed: one large-address join at the node at a time for the whole server (seeds, fills and whole-history lists alike, each list at most once per address); 16 readers' seeds and 16 discovered ones waiting per network, 2 places per client; at most 12 discovery checks an hour per network. No setting chooses how an address above the node's `--max-sh-creates` is added up: through the node's uncapped socket route where `{NET}_ESPLORA_URL` is a socket and the node has it, otherwise not at all ([`RBITCOIN.md`](RBITCOIN.md#totals-of-large-addresses)).

| Variable | Default | Protects against |
|---|---|---|
| `LEDGER_MAX_ADDRESSES` | `1000` | Store size and per-block work: addresses kept per network; past it the least recently viewed is dropped. An address with a full list of newest transactions takes about 29 KB of rows and 12 KB of undo records, plus about 60 bytes a day of chart: about 50 KB after a year, so 50 MB for 1,000. Each block costs one `getblock` at verbosity 3 (1.4 MB and 115 ms on signet on average) and about 30 ms of the server's time, the same for 1 or 1,000 addresses. 1 to 100,000 |
| `LEDGER_MAX_HISTORY_ROWS` | `10000000` | Store size and node work: transactions kept in the kept addresses' whole histories, per network, about 48 bytes each on disk (about 480 MB at the default). A list is asked only for an address a reader views. Before it is, the least recently viewed addresses' histories are dropped to make room (never one viewed in the last 30 minutes), and again when blocks make them outgrow it; an address with more transactions than this is never asked for its list. An address whose history is dropped keeps its totals and newest 200 transactions, and is asked for its list again when a reader views it, at most once a day. On mainnet the default filled after ten addresses (10.18 million rows, 2026-11-14): raise it to keep more of the busiest. `0` keeps none. 0 to 1,000,000,000 |
| `LEDGER_DISCOVER` | `true` | Node work while nobody asks: each new block's most paid scripts are checked for size, at most 12 an hour, and the large ones added up. With nothing tracked it reads each new block once for it (with something tracked the ledger reads it anyway). `false`: addresses are added up only when a reader opens one, and with nothing tracked the node is asked nothing |

### Block summaries

The block summary routes ([`FRONTEND.md`](FRONTEND.md#block-summaries)) keep computed summaries in memory. Their other limits are fixed: one computation at a time per network, six started by clients running or waiting, and ten per client at once then one every 2 seconds.

| Variable | Default | Protects against |
|---|---|---|
| `BLOCK_SUMMARY_CACHE_MB` | `32` | Memory held by cached summaries, per network: the least recently used go first once it is reached. A summary takes 56 bytes per transaction (its record, txid and weight) plus about 0.5 KB: 110 to 390 KB for today's mainnet blocks, so the default holds 80 to 290 of them. Measured with the cache full: 55 MB resident for the whole process. Each summary not in the cache costs the node a block listing: about 0.3 MB on a node with `/block/:hash/txs/summary`, a `getblock` of up to 10 MB on one without ([`RBITCOIN.md`](RBITCOIN.md#listing-a-blocks-transactions)). At most 1,048,576 |

### Answers kept in memory

Answers the server computes once and keeps until they can change ([`API.md`](API.md#answers-kept-in-memory)): the store-backed block and audit routes, and a buried block's immutable answers from the node.

| Variable | Default | Protects against |
|---|---|---|
| `ANSWER_CACHE_MB` | `32` | Memory held by kept answers, per network: the least recently used go first once it is reached, and one larger than a 64th of it is never kept. At mainnet's sizes 32 MB holds about 25,000 blocks' JSON (about 1.3 KB each as counted), or 1,600 lists of 15 blocks (about 20 KB each). Lower it on a small machine; raise it when no CDN sits in front and clients walk old blocks. A request for an answer not kept costs what it did before. At most 1,048,576 |

### Block table

The block table ([`STORE.md`](STORE.md#blocks)) needs `DATA_DIR`. Its newest 100 rows follow the tip whatever these say; the backfill fills the rest. The backfill has its own RPC client with one call in flight, outside the four the rest of the server shares, and a 30 s timeout.

| Variable | Default | Protects against |
|---|---|---|
| `BACKFILL_ENABLED` | `true` | `false` pauses the backfill. The table is its progress, so the next start with `true` resumes where it stopped, redoing nothing |
| `BACKFILL_BUSY_PERCENT` | `50` | Load on the node. The share of wall time, 1 to 100, the backfill keeps its one call busy: after a step that took `t` it waits `t × (100 − p) / p`. It also backs off from 5 s to 5 minutes, doubling, whenever the node is busy or failing. How long that takes, measured on mainnet at 50 and on each kind of node, is in [`STORE.md`](STORE.md#backfill) (about a day and a half for every block's totals) |
| `BACKFILL_FEE_RATE_DEPTH` | `52560` | How far back fee rates are filled, in blocks below the tip (52,560 is about a year). Each costs a block listing: about 60 ms and 0.3 MB of node time on a node with `/block/:hash/txs/summary`, a `getblock` of up to 10 MB and 2 s on one without; `0` fills none. Rows deeper than this keep their totals and coinbase, and the block facts route computes their fee rates on demand |

### WebSocket

Bounds on `/app/ws` and `/api/v1/ws` ([`SECURITY.md`](SECURITY.md) rule 9; the protocol and its close codes are in [`WS.md`](WS.md)). Each must be a positive integer. An upgraded socket gives up its slot under `MAX_CONNECTIONS` and `CLIENT_MAX_CONNECTIONS` and counts under these instead, so keep `MAX_CONNECTIONS` plus `WS_MAX_SOCKETS` and `WS_V1_MAX_SOCKETS` below the process's open-file limit. A socket that stops reading is dropped after `REQUEST_TIMEOUT_SECS` without write progress, as for HTTP.

| Variable | Default | Protects against |
|---|---|---|
| `WS_MAX_SOCKETS` | `1024` | Memory and file descriptors held by open sockets, every network together. Past it an upgrade gets `503`. At most 1,048,576 |
| `WS_CLIENT_MAX_SOCKETS` | `16` | One address holding many sockets. Past it an upgrade gets `429`. Keyed on the client address as above, behind a trusted proxy too. Only this site's pages may open sockets, so another site cannot use up its visitors' allowance ([`WS.md`](WS.md#connection-rules)) |
| `WS_V1_MAX_SOCKETS` | `256` | Sockets on the mempool.space-shaped `/api/v1/ws`, every network together: a pool apart from `WS_MAX_SOCKETS`, so other sites' pages, which may open it, never take a slot of ours ([`WS.md`](WS.md#why-other-sites-may-open-it)). Past it an upgrade gets `503`. At most 1,048,576 |
| `WS_V1_CLIENT_MAX_SOCKETS` | `4` | One address holding many `/api/v1/ws` sockets, counted apart from `WS_CLIENT_MAX_SOCKETS`. Past it an upgrade gets `429` |
| `WS_MAX_MESSAGE_BYTES` | `1024` | Large messages from a client. Checked against the frame header before the payload is read, and against a fragmented message's total. Over it: close `1009`. At most 1,048,576 |
| `WS_MESSAGES_PER_SEC` | `10` | A client flooding the server with frames, pings and pongs included. The same number is the burst allowed. Over it: close `4002` |
| `WS_MAX_SUBSCRIPTIONS` | `8` | One socket subscribing to many topics. Over it: close `4001` |
| `WS_SEND_QUEUE` | `64` | Memory held for a client that does not read. Messages waiting for it are shared, not copied: at most 64 frames its topics have moved past, about 51 MB in the worst case of projected blocks' snapshots; sockets stalled together on the same topics share theirs ([`WS.md`](WS.md#close-codes)). When full: close `4003`. At most 65,536 |
| `WS_IDLE_TIMEOUT_SECS` | `60` | Sockets whose client vanished without closing. A socket silent for half of it is pinged, and one silent for all of it is closed with `4004` |
| `WS_MAX_BLOCK_SUBSCRIPTIONS` | `2` | One socket holding many projected blocks' transactions, the only large topics (up to about 800 KB a snapshot). Counted inside `WS_MAX_SUBSCRIPTIONS`. Over it: close `4001` |
| `WS_MEMPOOL_INTERVAL_MS` | `2000` | Traffic and fan-out work on the mempool topics: each sends at most one message per interval, always the latest state, so changes in between are merged. 100 to 60,000 |
| `WS_BLOCK_WAIT_SECS` | `60` | How long the `blocks` topic waits for the node to serve a block it announced before clients are told to `resync` instead ([`WS.md`](WS.md#blocks)). The node is asked less and less often as the wait grows: about 90 requests if it never serves the block. The block table keeps looking after it, on its own retries. 1 to 600 |
| `WS_LATEST_TXS` | `10` | Size of the `transactions` list, the newest transactions seen. At most 100 |
| `WS_MAX_TRACKED_TXS` | `4` | One socket following many transactions (`tx:<txid>` topics). Counted inside `WS_MAX_SUBSCRIPTIONS`. Over it: close `4001` |
| `WS_MAX_TRACKED_ADDRESSES` | `2` | One socket following many addresses (`address:<address>` topics). Counted inside `WS_MAX_SUBSCRIPTIONS`. Over it: close `4001` |
| `WS_TRACKED_TXS_TOTAL` | `10000` | Memory and per-update work for followed transactions: distinct transactions followed at once, per network. Past it a new one is answered `refused` and the socket stays open. Each costs under 1 KB: its entry, its last message (about 300 bytes) and its topic in the hub. At most 1,048,576 |
| `WS_TRACKED_ADDRESSES_TOTAL` | `1000` | Subscriptions on the node: distinct addresses followed at once, per network, each one Electrum subscription however many sockets follow it. Past it a new one is answered `refused`. At most 10,000, rbitcoin's own cap per Electrum connection |
| `WS_POSITION_INTERVAL_MS` | `10000` | Messages about a followed transaction that only moved: more or less ahead of it, or another block after the next. Sent at most once per interval; entering or leaving the next block, a new effective rate or any change of state goes out at once. 1,000 to 600,000 |
| `REPLACEMENTS_KEPT` | `10000` | The replacement record ([`MEMPOOL.md`](MEMPOOL.md#following-a-transaction)): the most recent replacements remembered per network, oldest out first. About 0.3 KB each in memory and, with a `DATA_DIR`, about 205 bytes each in the store's `replacements` table, which keeps the same number so the record survives a restart. At most 1,048,576 |
