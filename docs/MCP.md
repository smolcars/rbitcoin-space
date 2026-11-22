# MCP server

`POST /mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server: a chat bot or a coding agent connects to it and looks things up on this explorer through a few tools. It is read-only, needs no sign-in, and is **off by default**: `MCP_ENABLED=true` turns it on ([`CONFIG.md`](CONFIG.md#mcp)). It is served once for the whole server, like `/app/decode`; a tool takes the network as an argument. The code is `crates/server/src/mcp.rs` (the protocol) and `crates/server/src/mcp/tools.rs` (the tools). There is no SDK behind it: the protocol is JSON-RPC over one HTTP route, and what is served of it fits in those two files.

## Connecting

Give the client the URL `https://<your host>/mcp` and the transport "Streamable HTTP". Nothing else is needed: no key, no OAuth. The public docs' [`/docs/agents`](https://rbitcoin.space/docs/agents) page has the setup for each client, and each docs page's menu offers it where `/app/config` says `mcp: true`.

## Protocol

| Revision | Served how |
|---|---|
| `2026-07-28`, the stateless one ("MCP v2") | As written: each request carries its version and capabilities in `params._meta`, and mirrors the version, the method and a called tool's name in the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers |
| `2025-11-25`, `2025-06-18` | Their `initialize` is answered and no session is made: later requests are served one by one, with or without the `MCP-Protocol-Version` header. An `initialize` asking for any other revision is answered `2025-11-25`. Most clients still open this way: the official Inspector does by default |

The server keeps nothing between requests in either. An `Mcp-Session-Id` a client sends is ignored and none is ever given.

| Method | Answer |
|---|---|
| `server/discover` | The revisions above, `{"tools": {}}` as capabilities, and instructions for the model that name the networks this server has on |
| `tools/list` | The [tools](#tools), always in the same order. `ttlMs` is an hour and `cacheScope` `public`: the list changes only with a restart |
| `tools/call` | The tool's answer as `structuredContent`, and the same JSON as one text block. A tool that could not answer gives `isError: true` and one line saying why, which a model can read and act on |
| `initialize`, `ping` | For the earlier revisions |
| A notification (a message without `id`) | `202`, no body. The only one a client sends is `notifications/initialized` |

Every answer is one JSON object, `Cache-Control: no-store`. There are no streams: no `text/event-stream` answer, no `subscriptions/listen`, and `GET` and `DELETE` are `405`. Resources, prompts, sampling, elicitation and the extensions are not served.

| Wrong with the request | Status | JSON-RPC code |
|---|---|---|
| Not JSON | `400` | `-32700` |
| Not one message with `"jsonrpc": "2.0"`, a `method`, an `id` that is a string or a whole number and `params` that is an object. A batch is not one message | `400` | `-32600` |
| A header that does not equal the body's value, or a `_meta` version with no header | `400` | `-32020` |
| A `2026-07-28` request without the version or the capabilities in `_meta` | `400` | `-32602` |
| A revision not served. `data` lists the ones that are | `400` | `-32022` |
| An unknown method | `404` for `2026-07-28`, as it asks; `200` for an earlier revision, to which a `404` would mean a lost session | `-32601` |
| An unknown tool, or `arguments` that is not an object | `200` | `-32602` |
| A body over 16 KiB | `413` | our `{"error": …}` |
| An `Origin` that is not this site | `403` | our `{"error": …}` |
| A refusal by the request limits | `429`, `503`, `504` | our `{"error": …}` |

Messages are fixed text. Nothing a client sent is said back, except the revision it asked for, cut to 32 characters.

## Tools

Chain tools take `network`, one of the networks this server has on; without it the first is asked (mainnet, when it is on). Each answer names the network it came from. Amounts are in satoshis, fee rates in sat/vB, times in Unix seconds.

| Tool | Arguments | Asks | Answers |
|---|---|---|---|
| `decode` | `string`; `detail` | `POST /app/decode` ([`API.md`](API.md#decoding)) | That answer, with `expires_at` and `expired` for an invoice or an offer that ends. Route hints, blinded paths and feature bits only with `detail: true`: they can be 13 KB |
| `get_fees` | | `/api/v1/fees/precise` | `next_block`, `half_hour`, `hour`, `day`, `minimum`, and `source` (`projected`: ours; `node`: the node's estimate) |
| `get_mempool` | | `/api/mempool`, `/api/v1/fees/mempool-blocks` | Transactions, vsize and fees waiting, and the projected blocks with their fee rates; `projected_blocks` is `null` with the mempool engine off |
| `get_transaction` | `txid` | `/api/tx/:txid` | Confirmed or not and how deep, fee, fee rate, sizes, counts, and the first 10 inputs and outputs as address, value and script type |
| `decode_transaction` | `hex` | `POST /app/tx/check` ([`API.md`](API.md#checking-a-transaction)) | What a raw transaction does before anyone sends it, in `get_transaction`'s shape: the fee and fee rate when the outputs it spends are found, and `known`, whether the node already has it (`confirmations` is then `null` for a confirmed one: the check does not say how deep). Nothing is broadcast. The 16 KiB request leaves room for a transaction of about 7 kB; a longer one is `413` |
| `get_address` | `address`: an address, or a public key in its place ([`API.md`](API.md#public-keys)) | `/api/address/:a`, `/api/address/:a/txs/summary` | Balance, received, sent, counts, the unconfirmed change, and the 10 newest confirmed transactions with their net value for the address; `recent_transactions` is `null` when the history is refused, as for a very large address |
| `get_block` | `height` or `hash`, or neither for the newest | `/api/blocks/tip/hash` or `/api/block-height/:h`, then `/api/v1/block/:hash`, else `/api/block/:hash` | Hash, height, time, size, transactions, difficulty; miner, reward, fees and fee rates where the block table has them, else `null` |
| `get_difficulty_adjustment` | | `/api/v1/difficulty-adjustment` | Progress, blocks left, the expected change and when |
| `get_lightning_node` | `node`: a public key, or 3 to 66 characters | `/api/v1/lightning/nodes/:key`, or `/api/v1/lightning/search` | The node, or up to 10 matches by alias or key |

There is no tool that writes. Broadcast is not one.

## What a tool can cause

A tool does nothing of its own at the node. It sends a request to the routes in the table, inside the server, with the caller's address on it, and reads the answer ([`SECURITY.md`](SECURITY.md) rule 24). So everything those routes have applies unchanged: the allow-list, the strict parsing, the address routes' cost limit and the large-address guard, the shared calls and kept answers, and the decoder's budget of 30 decodes then 2 a second, which a client spends the same on `/app/decode` and on the tool.

- **Before a route is asked,** each argument is parsed: a txid or block hash is 64 hex digits, a height a `u32`, an address at most 100 letters and digits (the route then parses it for the network), a network one of the enabled ones, a search text percent-encoded whole, a raw transaction hex digits only (it goes in the route's body, and the route decodes it). A route's path is written from those values only.
- **The request itself** is an API request like any other: the per-client rate and concurrency, the global concurrency and the timeout of [`CONFIG.md`](CONFIG.md#limits) count it once, and a tool asks at most three routes.
- **Bots share addresses.** Limits are per client address, and every user of one hosted bot reaches us from that provider's addresses, so they share one allowance. A provider that needs more is a case for a higher `CLIENT_RATE_PER_SEC`, not for a key.
- **An answer of a route is read up to 4 MiB,** and parsed into the fields the tool keeps, not into a tree. A transaction whose JSON is larger is `isError`.
- **A limit that refuses a tool's route** is counted with the other refusals (`requests_refused`, [`LOGGING.md`](LOGGING.md#refusals)), though the tool's answer is a `200`.

## Text someone else wrote

A model reads a tool's answer, so text a stranger chose is a way to talk to it. Two things are done about it.

- **Left out:** scripts and their text forms, witnesses and coinbase tags. A transaction's inputs and outputs are an address, a value and a script type.
- **Named:** an answer that carries such text lists its field names in `untrusted_text`: an invoice's `description`, an offer's `issuer`, a refund's `payer_note`, a Lightning node's `alias` and announced `sockets`, an LNURL's `url`. The server's instructions tell the model to read those as data. That is a request to the model, not a guarantee: the client decides what it does with a tool's answer.

## Privacy

- **Nothing of a call is logged.** The request event names the route, `/mcp`, and never the tool, its arguments or its answer ([`LOGGING.md`](LOGGING.md#rules)).
- **The bot's provider sees what the user asks.** A string sent to `decode` reaches the provider before it reaches us, and an `lnurlw` link can be spent by whoever holds it; the tool's description says so. A transaction sent to `decode_transaction` is seen the same way, before it is public.
- **Nothing is fetched for a decoded string,** as on the decoder's page.

## Browsers

A browser may call `/mcp` only from this site's own pages: a request whose `Origin` is not this site is `403`, by the check `/app/ws` uses ([`SECURITY.md`](SECURITY.md) rule 21), so another site cannot spend its visitors' allowance. No CORS headers are sent. A program sends no `Origin` and is served.
