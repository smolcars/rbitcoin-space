# Plan

Six milestones. Each ends with something a person can open in a browser and check. Tasks and their state are in [`TODO.md`](TODO.md).

## Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Node coupling | Sidecar beside a stock rbitcoin (`nightly-20261122` or later) | Ships separately from the node; a web-facing bug cannot take the node down |
| Backend | Rust, tokio, axum | Same stack as rbitcoin; fast and one binary |
| Frontend | Solid 2.0 (a pre-release, chosen knowingly), TypeScript, Vite, static build | Small bundles, fine-grained updates, no Node at runtime |
| Storage | SQLite, one file per network | Data is small, one writer and many readers, no database server to run |
| Lightning | Gossip-only LDK inside the server | An explorer needs the public graph, not channels or funds |
| Compatibility | Esplora as rbitcoin serves it; mempool.space-shaped endpoints where cheap | Being a drop-in is welcome but never a reason to be worse on rbitcoin |
| License | MIT, written clean-room | No mempool.space source is read or copied |
| Networks | Mainnet, signet, testnet4, Testnet 5; regtest for development | |
| Styling | Plain CSS with design tokens, no utility framework | The design is built on tokens already; a framework would be one more build dependency for little gain |
| Frontend tooling | OXC for lint and format (`oxlint`, `oxfmt`), with strict rules and strict type checking; no Biome, ESLint or Prettier | The owner's choice |
| Dependencies | As few as possible; none for what a few lines can do | Build time, and fewer outside parties to trust |
| Logging | Structured, as typed events in our own small crate | Logs are an interface for the operator, and they stay maintainable when every line is a declared type |

## Out of scope

Liquid, the accelerator, translations, the Lightning world map, and address-prefix search.

## Milestones

### M0 — Foundation
The repository builds, tests and merges quickly.
- Rust workspace and a server that answers `/healthz` and serves the frontend.
- Frontend skeleton.
- CI inside its 4-minute budget.
- A regtest harness: rbitcoin in Docker with scripts to mine and transact.
- The parity inventory in [`COMPAT.md`](COMPAT.md).
- A design language and a static prototype.

**Done when:** a change to either the server or the frontend goes from push to green in under 4 minutes, and `dev/regtest/regtest.py up` gives a working regtest node.

### M1 — Explorer skeleton
A usable explorer for confirmed data.
- Clients for Esplora, Electrum and RPC.
- The Esplora pass-through at `/api`.
- The WebSocket hub, pushing new blocks.
- Pages: home, block, transaction, address, and exact-match search.
- All three networks behind one server.
- Docker image and compose file.

**Done when:** on mainnet, signet and testnet4 a new block appears on the home page without a reload, and block, transaction and address pages load from the node.

### M2 — Live mempool
The part people watch.
- Mempool tracking by polling and diffing.
- Projected blocks from the node's cluster chunks.
- Binary WebSocket deltas and the WebGL block view.
- Fee recommendations.
- Transaction and address tracking, with RBF and CPFP shown.

**Done when:** the projected blocks on the home page update live on mainnet at 60 fps, and a tracked transaction shows its position, replacement and confirmation as they happen.

### M3 — Mining and history
- SQLite store with migrations.
- Per-block summaries with backfill: pool, reward, fees, fee-rate percentiles.
- Hashrate, difficulty adjustment, pool pages.
- Block audit: the template we expected against the block that was mined.
- Mempool history charts.
- Fiat prices, with an off switch.

**Done when:** the mining dashboard and charts show full history on mainnet after a backfill, and a new block gets its audit within seconds.

### M4 — Lightning
- The gossip peer, with graph persistence.
- Funding-output validation through rbitcoin's position routes.
- Channel opens and closes tracked from blocks.
- Node, channel and network-statistics pages.

**Done when:** the Lightning pages show the live public graph on mainnet, and a channel close appears within one block.

### M5 — Parity and polish
- The remaining rows of [`COMPAT.md`](COMPAT.md) marked for delivery.
- Link previews, accessibility pass, performance pass against the budgets.
- Operator guide and a release workflow.

**Done when:** every row in [`COMPAT.md`](COMPAT.md) is either served or marked skipped with a reason, and all performance budgets in [`ARCHITECTURE.md`](ARCHITECTURE.md) are met.

## How work is run

- An orchestrator assigns tasks from [`TODO.md`](TODO.md) to builder agents, at most five at a time.
- Each builder takes one task to a merged pull request: build, prove, review, rebase, merge.
- Later milestones are listed coarsely on purpose. Their tasks are refined when the milestone before them lands, using what was learned.
