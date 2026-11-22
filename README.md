<p align="center">
  <img src="assets/icon.svg" width="96" height="96" alt="">
</p>

<h1 align="center">rbitcoin.space</h1>

<p align="center">
  A fast block explorer for <a href="https://github.com/rbitcoin-org/rbitcoin">rbitcoin</a>: live mempool, blocks, mining and Lightning.<br>
  <a href="https://rbitcoin.space">rbitcoin.space</a> · <a href="docs/DEPLOY.md">Run your own</a> · <a href="docs/API.md">API</a><br>
  Over Tor: <a href="http://7zsiqhi2bnfvwxwpvxu7zfjqra7boz6xahhjaq3nr4dehepfgt2sjtqd.onion"><code>7zsiqhi2bnfvwxwpvxu7zfjqra7boz6xahhjaq3nr4dehepfgt2sjtqd.onion</code></a>
</p>

## What it is

One Rust server beside a stock rbitcoin node (v0.9.2), serving a Solid frontend and an Esplora-compatible API for mainnet, signet, testnet4 and Testnet 5 (regtest for development; Testnet 5 needs a newer rbitcoin, [`docs/DEPLOY.md`](docs/DEPLOY.md#testnet-5)). It shows blocks, the live mempool with projected blocks and fee recommendations, transactions, addresses, replacements, mining pools and block audits, and the Lightning graph.

rbitcoin already keeps the transaction index, the address index, the cluster mempool and per-transaction fees in one process. So there is no second indexer, no second copy of the mempool and no database server: the explorer talks to the node over Esplora, Electrum and JSON-RPC, keeps the little the node does not store in SQLite, and follows Lightning through a gossip-only LDK peer that holds no funds.

Its latest release is `v0.5.0`. What is planned next is in [`docs/COMPAT.md`](docs/COMPAT.md#what-is-left).

## Run it

On a Linux host with Docker and Compose (amd64 or arm64), [`deploy/compose.yml`](deploy/compose.yml) runs rbitcoin v0.9.2 and the explorer side by side. [`docs/DEPLOY.md`](docs/DEPLOY.md#same-host-with-the-compose-file) has the commands, then TLS, the first backfill, upgrades and what to watch. To try it first, the same compose file runs a private regtest chain ([`docs/DEPLOY.md`](docs/DEPLOY.md#try-it-on-regtest-first)).

## Develop

Needs Rust (`rust-toolchain.toml` installs itself through rustup), [bun](https://bun.sh), and, for the regtest node, Docker with Compose v2.23 or later and `python3`.

```sh
# A private regtest node with a known chain (docs/REGTEST.md), and a .env pointing at it.
# For a node of your own, fill in the MAINNET_ lines of .env.example instead (docs/CONFIG.md).
dev/regtest/regtest.py scenario > /dev/null
grep -v '^MAINNET_' .env.example > .env && dev/regtest/regtest.py env >> .env

# Build the frontend and run the server on it: http://127.0.0.1:8080/regtest/
(cd web && bun install && bun run build)
set -a && . ./.env && set +a         # the server reads the environment, never .env itself
cargo run -p rbitcoin-space

# Frontend with hot reload, proxying the server above
(cd web && bun run dev)

# What CI runs
cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test
(cd web && bun run typecheck && bun run lint && bun run test && bun run build && bun run size)
(cd web && bun run format)            # oxfmt rewrites files; `lint` only checks them
(cd web && bun run e2e)               # browser tests; needs Docker
```

Read [`AGENTS.md`](AGENTS.md) before opening a pull request.

## Documentation

| Doc | Covers |
|---|---|
| [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the pieces fit together |
| [`PLAN.md`](docs/PLAN.md) | Milestones |
| [`TODO.md`](docs/TODO.md) | The task list |
| [`API.md`](docs/API.md) | The public Esplora API at `/api` and how it differs from the node |
| [`COMPAT.md`](docs/COMPAT.md) | Feature parity with mempool.space |
| [`RBITCOIN.md`](docs/RBITCOIN.md) | What we rely on from rbitcoin, measured |
| [`MEMPOOL.md`](docs/MEMPOOL.md) | Mempool tracking, removals and projected blocks |
| [`SECURITY.md`](docs/SECURITY.md) | Threat model and its rules |
| [`WS.md`](docs/WS.md) | The WebSocket protocol at `/app/ws` |
| [`MCP.md`](docs/MCP.md) | The MCP server at `/mcp`, for chat bots and coding agents |
| [`CONFIG.md`](docs/CONFIG.md) | Every environment variable and its default |
| [`CI.md`](docs/CI.md) | CI speed budget and test layers |
| [`REGTEST.md`](docs/REGTEST.md) | The private regtest node and its known chain |
| [`PERFORMANCE.md`](docs/PERFORMANCE.md) | Speed against the budgets, and how it was measured |
| [`STORE.md`](docs/STORE.md) | The SQLite store: migrations, writes, reads, backup |
| [`LOGGING.md`](docs/LOGGING.md) | Structured logging and its event catalogue |
| [`LIGHTNING.md`](docs/LIGHTNING.md) | The Lightning explorer |
| [`ARK.md`](docs/ARK.md) | Ark VTXO pages: Bark, its wire format and what the server checks |
| [`DEPLOY.md`](docs/DEPLOY.md) | Running it in production |
| [`DESIGN.md`](docs/DESIGN.md) | Visual design |
| [`FRONTEND.md`](docs/FRONTEND.md) | Frontend structure, data layer and shared components |
| [`AGENTS.md`](AGENTS.md) | Rules for contributors, human or agent |

## License

[MIT](LICENSE).
