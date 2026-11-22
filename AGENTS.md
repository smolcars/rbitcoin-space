# Rules for contributors

rbitcoin.space is a block explorer built for rbitcoin `nightly-20261122` (commit `e0b2c68`) or later ([`docs/RBITCOIN.md`](docs/RBITCOIN.md)). Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before writing code, and the doc for the area you touch (see the table in [`README.md`](README.md)).

## Never

1. **Never commit secrets or private infrastructure details.** That means `.env`, credentials, private hostnames, IP addresses and local file paths. The repo is public. Use the variable names from `.env.example`.
2. **Never broadcast a transaction on mainnet, and never call a write RPC on a shared node.** That includes probing a write route with a malformed body to see whether it exists: the request still reaches the node. Test writes on regtest ([`docs/REGTEST.md`](docs/REGTEST.md)).
3. **Never read or copy mempool.space source code.** It is AGPL and this project is MIT. Work from its observable API behaviour and write everything in your own words.
4. **Never weaken a rule in [`docs/SECURITY.md`](docs/SECURITY.md) to make something work.** If a rule blocks you, say so in the PR.
5. **Never push CI over its budget.** A PR must finish its checks in under 4 minutes with a warm cache ([`docs/CI.md`](docs/CI.md)).
6. **Never edit [`docs/TODO.md`](docs/TODO.md).** The orchestrator owns it.

## Workflow

- Branch from `master`. One task is one PR. Keep PRs small enough to review in one sitting.
- Stay inside the files your task names. If you need to change something outside them, keep it minimal and call it out in the PR.
- Merges are squash merges. The PR title becomes the commit message, so make it a plain sentence describing the change.
- Update the doc that owns a fact when your change makes it wrong. Each fact lives in one doc.

## Prove it works

- Run what you built. Passing unit tests alone is not proof.
- **UI changes are verified in a real headless browser** (Playwright with Chromium) at a desktop and a phone width, in light and dark themes. Attach the screenshots to the PR. Do not commit them.
- Backend changes that talk to a node are verified against a real rbitcoin: regtest in Docker, or a synced node through `.env`.
- State in the PR what you checked and what you could not check.

## Code

- **Rust:** edition 2024, `cargo fmt`, `cargo clippy -- -D warnings`. No `unsafe`. No panic on untrusted input: no `unwrap`, `expect` or unchecked indexing on anything that came from a client or the network.
- **Lint, format and type checks are strict on both sides, and CI enforces them.** Rust: `cargo fmt`, clippy with warnings denied, and a clean build. Frontend: OXC only (`oxlint` to lint, `oxfmt` to format) and the strictest TypeScript settings we can hold. Never add Biome, ESLint or Prettier. Warnings fail the check like errors, and a lint rule is switched off only with its reason written beside it ([`docs/FRONTEND.md`](docs/FRONTEND.md#checks)).
- **TypeScript:** strict mode, no `any`. Never put chain data into the page as HTML. Transaction data, coinbase tags and Lightning aliases are attacker-controlled text.
- **Dependencies are a cost.** Each one adds build time and another party to trust. Do not add one for something a few lines can do: write the function. A new dependency, Rust or JavaScript, needs a case in the PR: what it does, why writing it ourselves is unreasonable, how many crates or packages it pulls in, and its features trimmed to the minimum. Prefer the standard library and what is already in the tree.
- **Logging is structured.** Server and library code records what happened as typed events through the `logging` crate ([`docs/LOGGING.md`](docs/LOGGING.md)). No `println!`, `eprintln!`, `dbg!` or free-text message strings scattered through the code. When something is worth recording, add an event with named fields; when it is not, do not log it.
- **Ports:** never hardcode a port in a test or script. Bind port 0 or take the port from the environment, because several agents work on one machine at once.
- **Shared nodes are shared load.** A running server with the mempool engine on polls its node continuously (about 150 MB a minute on mainnet). When you run the server against a shared node, turn the mainnet engine off (`MAINNET_MEMPOOL_ENABLED=false`) unless your task needs the live mempool, and never leave a server running when you are done.
- **Processes and containers:** stop only what you started, by its process id or container name. Never kill by a name pattern (`pkill`, `killall`): it also matches other builders' servers on the same machine.
- **Fixtures:** small, public chain data only, under `fixtures/`.
- **Comments:** explain why, in one line, when the code cannot.

## Design

UI work follows [`docs/DESIGN.md`](docs/DESIGN.md) and uses the `frontend-design` skill.

## Repo layout

| Path | Holds |
|---|---|
| `crates/` | Rust workspace: the server and its libraries |
| `web/` | Solid frontend |
| `deploy/` | The compose files and `.env.example` for running the release image ([`docs/DEPLOY.md`](docs/DEPLOY.md)) |
| `dev/` | Local development tooling, including the regtest harness |
| `design/` | The design tokens, logo and font the frontend builds with, and the static prototype |
| `fixtures/` | Recorded public chain data for tests |
| `assets/` | The project's icon, for the README |
| `docs/` | Plans, architecture and rules |
