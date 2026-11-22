# Architecture

rbitcoin.space is a sidecar: one Rust server beside a stock rbitcoin node, a static frontend, and a SQLite file per network. It does not embed or patch the node.

```text
 browser ──HTTP/WS──► rbitcoin-space ─Esplora REST──► rbitcoin nightly-20261122
                        │   │   │  ──Electrum TCP──►   (unmodified)
                        │   │   └──JSON-RPC────────►
                        │   └── SQLite (derived data only)
                        ├── LDK gossip peer ──► Lightning network
                        ├── gRPC over HTTPS ──► Bark server (Ark VTXOs)
                        └── HTTPS ────────────► Arkade server (Ark indexer)
```

## Principles

1. **The node is the source of truth.** Anything rbitcoin can answer is asked of rbitcoin, never copied into our own store. Blocks, transactions, addresses and spends stay in the node.
2. **We store only derived or observed data:** per-block mining summaries, block audits, mempool history, replacements, fee-recommendation scores, Lightning graph history, and running totals and transaction lists for a bounded set of large addresses, whose totals the node refuses or takes long to give and whose history it can only page at full cost each page, kept from each block ([`STORE.md`](STORE.md#ledger)).
3. **Push where the node pushes, poll where it does not.** Blocks and tracked scripts arrive by Electrum subscription. The mempool is polled, because rbitcoin has no mempool event stream ([`RBITCOIN.md`](RBITCOIN.md)).
4. **Clients are untrusted.** The browser never reaches the node directly. Every request goes through typed, bounded handlers ([`SECURITY.md`](SECURITY.md)).
5. **Compatibility is a bonus, not a constraint.** We serve rbitcoin's Esplora API as it is, and mempool.space-shaped endpoints where they are cheap. Where rbitcoin lets us do better, we do it our own way ([`COMPAT.md`](COMPAT.md)).

## Rust workspace

| Crate | Path | Owns |
|---|---|---|
| `rbitcoin-space` (binary) | `crates/server` | Config, HTTP routes, WebSocket hub, middleware, static file serving, wiring |
| `node` | `crates/node` | Typed clients for rbitcoin: Esplora (TCP and unix socket), Electrum with subscriptions, JSON-RPC |
| `engine` | `crates/engine` | Mempool tracking, projected blocks, block summaries, the SQLite store. Pure logic is kept separate from I/O so it can be unit-tested |
| `ln` | `crates/ln` | The gossip-only LDK peer and Lightning graph tracking |
| `arkade` | `crates/arkade` | A typed client for an Arkade server's public indexer, over HTTPS: the bounded lookup behind the Arkade VTXO page |
| `bark` | `crates/bark` | Bark VTXOs: the Bark server's `GetVtxo` call over HTTP/2 and TLS, our own decoder of its wire format, and the exit chain rebuilt and checked ([`ARK.md`](ARK.md)) |
| `card` | `crates/card` | Link preview cards: a transaction's or block's figures drawn as a PNG from a typed value, with no I/O, clock or node, in the site's font ([`FRONTEND.md`](FRONTEND.md#link-previews)) |
| `logging` | `crates/logging` | Typed log events, their catalogue and the non-blocking writer ([`LOGGING.md`](LOGGING.md)). Only the server emits; libraries report through values |
| `lint` | `crates/lint` | Checks on the workspace's own source that clippy cannot express, run as its tests: none of it ships ([`CI.md`](CI.md#rules-for-tests)) |

Dependencies point one way: `server` → `engine` and `ln` → `node`, `server` → `arkade`, `bark` and `card`, and only `server` uses `logging`. A crate may be split when it earns it, not before.

Runtime is tokio with axum. SQLite is accessed through `rusqlite` with the bundled library.

## Networks

One process serves every configured network. Each network gets its own context: node clients, engine, SQLite file. They share nothing mutable, so a failing network does not affect the others.

A network is enabled by setting its variables (`.env.example`). Mainnet is served at the root; other networks under a prefix:

| Network | Pages | APIs |
|---|---|---|
| Mainnet | `/…` | `/api/…`, `/app/…` |
| Signet | `/signet/…` | `/signet/api/…`, `/signet/app/…` |
| Testnet4 | `/testnet4/…` | `/testnet4/api/…`, `/testnet4/app/…` |
| Testnet 5 | `/testnet5/…` | `/testnet5/api/…`, `/testnet5/app/…` |
| Regtest | `/regtest/…` | `/regtest/api/…`, `/regtest/app/…` |

## HTTP surface

| Prefix | Contract | Notes |
|---|---|---|
| `/api/*` | Esplora REST and the approved BlindBit v1 surface, as rbitcoin serves them | Passed through an allow-list of routes with typed parameters. Public and stable |
| `/api/v1/*` | mempool.space-shaped subset | Only the endpoints listed as served in [`COMPAT.md`](COMPAT.md) |
| `/app/*` | Private API for our frontend | May change in any release; the frontend and server ship together. Also the link preview cards' pictures, `/app/card/…` ([`FRONTEND.md`](FRONTEND.md#link-previews)) |
| `/app/ws` | WebSocket for live updates | See below |
| `/api/v1/ws` | mempool.space-shaped WebSocket | For wallets and bots; the same hub ([`WS.md`](WS.md#the-mempoolspace-shaped-socket-apiv1ws)) |
| `/mcp` | Model Context Protocol, for chat bots and coding agents | Off by default. Read-only tools that ask the routes above ([`MCP.md`](MCP.md)) |
| `/healthz` | Liveness | No upstream calls |
| everything else | The frontend | Static files from a configured directory, with the app shell as fallback; the shell's head names the page for link previews, with the site's picture when `SITE_URL` is set ([`FRONTEND.md`](FRONTEND.md#link-previews)) |

Confirmed data that can no longer change (a block or transaction buried deep enough) is served with long-lived cache headers so a reverse proxy or CDN can absorb it. Without one the server holds a buried block's answers in memory itself, and answers from our store are computed once per change to the tables they read ([`API.md`](API.md#answers-kept-in-memory)).

## Live updates

One WebSocket per browser tab.

- **Text frames (JSON)** carry control messages and small state: subscribe, unsubscribe, track a transaction or address, new block, mempool totals, fee recommendations.
- **Binary frames** carry projected-block transaction data as fixed-width records, sent as deltas (added, removed, changed) after an initial snapshot.
- The server computes each update once and fans the same bytes out to every subscriber.
- Every connection has a bounded send queue. A client that cannot keep up is dropped, never buffered without limit.

The protocol, its topics and its limits are in [`WS.md`](WS.md).

## Mempool tracking

1. Poll `getrawmempool` with `mempool_sequence` and diff the txid set against the last one.
2. Fetch details only for new txids, in JSON-RPC batches.
3. Take every chunk of every cluster from the node (`getmempoolcluster`, asked again only for clusters that changed), and pack them into projected blocks by the node's own template rule, instead of linearizing clusters ourselves.
4. Classify removals: confirmed, replaced (naming the replacement) or evicted.

The tracker's and the projected blocks' design, cadence and accuracy limits are in [`MEMPOOL.md`](MEMPOOL.md); node costs in [`RBITCOIN.md`](RBITCOIN.md).

## Storage

One SQLite file per network, in WAL mode.

- **One writer task** owns all writes. API handlers read through separate read-only connections.
- **Migrations** are numbered SQL files applied in order, tracked with `user_version`.
- **Everything derivable is rebuildable.** Dropping the file loses only what was observed live: mempool history, block audits (with the first-seen times they list), the replacement record, the fee score and Lightning history.

## Frontend

Solid with TypeScript, built by Vite into static files. No server rendering and no Node at runtime.

- **Routes** mirror the network prefixes above.
- **State** comes from the WebSocket for anything live and from HTTP for everything else.
- **Rendering:** the transaction grids of blocks and projected blocks are drawn with WebGL2 instanced quads; charts are our own SVG ([`FRONTEND.md`](FRONTEND.md#charts)).
- **Styling:** design tokens as CSS custom properties, no CSS-in-JS runtime ([`DESIGN.md`](DESIGN.md)).

## Performance budgets

| What | Budget |
|---|---|
| First load, JavaScript | 100 KB gzipped for the app shell and home page |
| New block, from the node's Electrum announcement to the `block` message on `/app/ws` (the compatible socket's waits for the block's extras, [`WS.md`](WS.md#blocks-and-their-extras)) | 50 ms on a node with rbitcoin PR 1577 (measured 11–43 ms on mainnet and signet). A node without it (rbitcoin v0.9.2, no longer supported) held a new block for a second or more after announcing it ([`RBITCOIN.md`](RBITCOIN.md)): there the budget ran from when the node can serve the block, plus at most an eighth of the hold, the hub's retry spacing |
| Cached or immutable API response, server time | 10 ms at p99 |
| Frame rate during block and mempool animations | 60 fps on a mid-range laptop |

A change that breaks a budget needs a stated reason in its PR. Where we stand against each, and how it was measured: [`PERFORMANCE.md`](PERFORMANCE.md).

## Deployment

The deliverable is a Docker image and a compose file that runs the server next to rbitcoin. On the same host the server can use rbitcoin's unix sockets, which unlocks the bulk `/internal/*` Esplora routes. TLS is terminated by a reverse proxy.
