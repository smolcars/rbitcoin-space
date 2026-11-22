# Regtest harness

A private rbitcoin node on regtest, the build the explorer requires ([`RBITCOIN.md`](RBITCOIN.md)), in Docker, for every test that writes: mining, broadcasting, replacing. The shared nodes are read-only ([`AGENTS.md`](../AGENTS.md)).

It needs Docker with Compose v2.23 or later, and `python3`. Nothing else: the script uses only the Python standard library.

## Quick start

```bash
dev/regtest/regtest.py up         # start, wait until ready, print .env lines
dev/regtest/regtest.py scenario   # empty chain, then the known chain below; prints a JSON manifest
dev/regtest/regtest.py down       # remove the node and its chain
```

| Command | Does |
|---|---|
| `up` | Starts the node (or keeps it running), waits until RPC, Esplora and Electrum all answer, prints the `.env` lines |
| `stop` | Stops the node and keeps its chain. `up` starts it again |
| `down` | Removes the container, network and volume |
| `reset` | `down`, then `up`: an empty chain at height 0 |
| `env` | Prints the `.env` lines for the running node |
| `mine N` | Mines N blocks, prints their hashes |
| `send ADDRESS SATS [--feerate R]` | Pays SATS to a regtest address from a mature coinbase, prints the txid. Default 2 sat/vB |
| `rbf [--gap S]` | Broadcasts a transaction at 1 sat/vB and a replacement at 5 sat/vB, `S` seconds apart (default 0), prints both txids |
| `cpfp` | Broadcasts a parent at 1 sat/vB and a child at 25 sat/vB, prints both txids |
| `scenario` | `reset`, then builds the known chain, checks it, prints its manifest. Stdout is only the JSON manifest; progress and the `.env` lines go to stderr |
| `hostile` | Mines a transaction whose OP_RETURN outputs hold markup, a `javascript:` URL, bidi overrides, ANSI escapes and NUL, with a payment to the scenario's P2WPKH address, and a commit and taproot script-path reveal of three inscriptions (HTML markup, JSON and an SVG with a script; the leaf ends in `OP_TRUE`, so nothing is signed); then submits an empty block, built by hand, whose coinbase tag is `<script>` markup with a right-to-left override and which claims 1,000 sats less than the subsidy. Prints the txid, the reveal's txid, the block hash and its coinbase txid. Mines on top of whatever chain is there, so the scenario's hashes are unchanged; the browser tests run it from a `*.mine.e2e.ts` file |
| `tagged TEXT… [--extranonce N]` | Submits one empty block per TEXT, built by hand like `hostile`'s: its coinbase script is the height, then one push of TEXT (UTF-8, at most 75 bytes), then, with `--extranonce N`, one push of N zero bytes. `tagged --extranonce 20 'Sv2/pool/miner/'` is the layout of the Stratum V2 reference implementation ([`API.md`](API.md#who-mined-a-block)). Prints each block's hash and coinbase txid. Needs no mature coinbase, but a chain past height 16: the height is written as a data push, which the node refuses at heights 1 to 16 (`bad-cb-height`), so on a new chain `mine 16` first. The browser tests run it from `sv2.mine.e2e.ts`, after the known chain |

`send`, `rbf`, `cpfp` and `hostile` need a mature coinbase, so mine at least 101 blocks first (or run `scenario`).

## Point the server at it

`up` and `env` print the variables from [`.env.example`](../.env.example) for the running node:

```text
REGTEST_RPC_HOST=127.0.0.1
REGTEST_RPC_PORT=32808
REGTEST_RPC_USER=regtest
REGTEST_RPC_PASSWORD=regtest
REGTEST_ESPLORA_URL=http://127.0.0.1:32807
REGTEST_ELECTRUM_ADDR=127.0.0.1:32809
```

The ports are picked by Docker on every start, including after `stop` and `up`, so read them again each time: `eval "$(dev/regtest/regtest.py env | sed 's/^/export /')"`.

The credentials are throwaway and fixed in [`dev/regtest/compose.yml`](../dev/regtest/compose.yml). RPC takes them as HTTP Basic through rbitcoin's `--rpc-cookie-file`. Every port is bound to `127.0.0.1` only.

## The node

| Setting | Value |
|---|---|
| Image | `ghcr.io/rbitcoin-org/rbitcoin:nightly-20261122`, pinned by digest (`sha256:1a7208ea…5d34d7a`). Published by rbitcoin's nightly workflow for linux/amd64 and linux/arm64; its revision label is commit `e0b2c688487b7699c9d64bcf678b308cf34978b7`. The pin moves to rbitcoin's next release |
| Interfaces | JSON-RPC (`--rpc-listen`), Electrum (`--electrum-listen`), Esplora (`--esplora-listen`), all over TCP |
| Address index | On (`--sh-index`) |
| Peers | None: `--no-seeds --no-listen` |
| Tip age | `--max-tip-age` set to about 30 years, so relay stays on although scenario blocks carry past timestamps |
| Data | A named volume, removed by `down` and `reset` |

The image is `FROM scratch` with only `rbitcoin-node` and `rbitcoin-cli`: there is no shell in the container. The CLI works through Compose: `REGTEST_PROJECT=<name> docker compose -f dev/regtest/compose.yml exec node rbitcoin-cli --network regtest getblockcount`.

`REGTEST_IMAGE` overrides the pin, for example with an image built locally with rbitcoin's `Dockerfile`; only the pinned image is tested. A node older than `nightly-20261122` fails `ledger::tests::regtest::a_script_asked_by_hash_answers_as_its_address`.

## Running several at once

Every instance is a Compose project with its own container, network, volume and host ports. The project name defaults to `regtest-` plus a hash of the checkout's path, so each worktree gets its own instance without configuration. Set `REGTEST_PROJECT` to run more than one from the same checkout:

```bash
REGTEST_PROJECT=regtest-b dev/regtest/regtest.py scenario
REGTEST_PROJECT=regtest-b dev/regtest/regtest.py down
```

`compose.yml` refuses to start without a project name, so a bare `docker compose up` cannot claim a shared default. Without the script: `REGTEST_PROJECT=mine docker compose -f dev/regtest/compose.yml up -d`, then `docker compose -p mine port node 3000` for a port.

## How transactions are made without a wallet

rbitcoin has no wallet RPCs, so the script holds no keys and signs nothing. Instead every coin it spends sits in a script that anyone can spend:

| Script | Spent with |
|---|---|
| P2WSH of `OP_TRUE`, the "miner script". Every coinbase pays here, and so does change | Witness `[OP_TRUE]` |
| P2SH of `OP_TRUE` | scriptSig pushing `OP_TRUE` |
| Pay-to-anchor (P2A) | Nothing |

The script picks the oldest unspent mature coinbase (it asks `gettxout` with the mempool included), serializes a version 2 transaction by hand, pays a fee from the transaction's virtual size, and broadcasts with `sendrawtransaction`. Inputs signal replaceability (sequence `0xfffffffd`), though rbitcoin replaces regardless. Outputs to other script types pay to made-up hashes and keys that nobody holds.

So inputs come in three types only: P2WSH, P2SH and P2A. P2PKH, P2WPKH and P2TR **inputs** would need real signatures and are not produced. Those types appear as outputs.

## The scenario

`scenario` starts from an empty chain and needs about 6 seconds. Block times are fixed (block *h* is at 2026-01-01T00:00:00Z plus *h* × 10 minutes), so every block hash and txid is the same on every run and on both architectures. Tests may hard-code them.

| Height | Contents |
|---|---|
| 1–105 | Coinbase only, 50 BTC each to the miner script |
| 106 | `script_types`: coinbase 1 to one output each of P2PKH (1 BTC), P2SH (0.5), P2WPKH (1), P2WSH (1), P2TR (1), P2A (10,000 sat) and OP_RETURN (`mempool.based regtest`), plus change. `consolidation`: coinbases 2 and 3 to 90 BTC at the same P2WPKH address, plus change |
| 107 | `spend_p2sh_p2a`: spends the P2SH and P2A outputs of `script_types` to 0.49 BTC at P2TR |
| 108–110 | Coinbase only |
| Mempool | `payment`: 0.5 BTC to the P2WPKH address at 2 sat/vB. `rbf_replacement` at 5 sat/vB, which replaced `rbf_original` at 1 sat/vB. `cpfp_parent` at 1 sat/vB and `cpfp_child` at 25 sat/vB, which pays to the P2WPKH address |

After the mempool step the node's clock returns to the wall clock, so blocks mined later carry the current time.

Before it prints, the scenario checks that the mempool holds exactly the four live transactions, and that the P2WPKH address history from Esplora (`/address/:addr/txs`) and Electrum (`blockchain.scripthash.get_history`) contains the transactions paying it.

The manifest it prints:

```json
{
  "tip": { "height": 110, "hash": "3fa932c75119e4a4f4c4f5f43afe8fec03c5f3bc9b84fbadd1e96dd34bc6654d" },
  "blocks": {
    "1": "55c72c83b6934bee3a62540b5bc7f0438e9dcefb03779b87e8456bc545171960",
    "106": "2ac64444e3172ee94aeeff3b09014b1d69b4daeccddac025d493332d54f6f145"
  },
  "txs": {
    "script_types": "44c64894ca2125fb361f286005f8e27d1c1846bfe00c692925ab4d6844721bbd",
    "consolidation": "f8580c086f549b53145643e6b846d617aef17305ec2af34125e41faa74bfd787",
    "spend_p2sh_p2a": "aa4652e9b6189d3569c54d148016f38538fea374c22965dbbe472ffef5c25f5f",
    "payment": "0def111d15485da613e9dc24a587a9657d3726772dcc68e0c55c2daa67b1dca9",
    "rbf_original": "c465329ca476d6454a42d21372a3461c2753426a8a07c46e0f2a5d6a731b756d",
    "rbf_replacement": "39134afd670713636c838ddb195e1c9d45cd2625b01d19fc73f4cae5ba51a9f8",
    "cpfp_parent": "7621473f23691b3acc681cada96b25a64e64ff298d8f95fd4818855ea886abbd",
    "cpfp_child": "ad853f8771d8e8f764d362723b23fe758654432f52da63baa993ffc66af93f51"
  },
  "addresses": {
    "p2pkh": "mwLW3XDqcAYmYKp8VDEYXweSBJ5mTUAuat",
    "p2sh": "2ND8PB9RrfCaAcjfjP1Y6nAgFd9zWHYX4DN",
    "p2wpkh": "bcrt1qw5puevk8wgy5t9d2qjg6frpfmesuqnnpx95u7s",
    "p2wsh": "bcrt1qgpsh04whvyp5fvrul6rr8384qt0mf4a7h507m5ed79d72euknpgqpmza40",
    "p2tr": "bcrt1pz9ml8p3h96z9hlvz0esm3uwdq9pxssmykz209jrg57znrdvx5y0shy3atk",
    "p2a": "bcrt1pfeesnyr2tx",
    "miner": "bcrt1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqseac85"
  }
}
```

The mempool entries' acceptance times are the wall clock and differ between runs; nothing else does.

## Measurements

Measured 2026-11-11 with the v0.9.1 image, on an Apple Silicon Mac (Docker in a Linux VM). The amd64 numbers ran the amd64 image under emulation.

| What | linux/arm64 | linux/amd64 |
|---|---|---|
| Image, compressed | 10.0 MB | 10.4 MB |
| Image, unpacked | 20.5 MB | 23.0 MB |
| Layer download from ghcr.io | — | 0.53 s |
| `up` on an empty volume, until RPC, Esplora and Electrum answer | 0.6–1.1 s | 0.6 s |
| `scenario`, including the reset | 6.2 s | not timed; same chain |

`docker pull` itself was not timed: on the measuring machine the Docker daemon's pull from ghcr.io stalled behind a local proxy while a direct download of the same blobs took half a second. The image was loaded with `docker load` instead.

## In CI

The browser tests' `e2e` job runs this harness through [`web/scripts/e2e.sh`](../web/scripts/e2e.sh) ([`CI.md`](CI.md#how-it-stays-fast)):

- **Through Compose and `regtest.py`, not a GitHub service container.** A service container cannot pass arguments to the image's entrypoint, and this node needs its flags. Services also start before checkout, so `compose.yml` would not exist yet.
- **The image is pulled, not cached.** It is 11 MB compressed (`nightly-20261122`, linux/amd64; v0.9.2's was 10.4 MB), pinned by digest, and served from ghcr.io next to GitHub's runners; restoring a cached `docker save` would cost about as much as the pull.
- **In parallel with the build.** The script starts `scenario` in the background, builds the server and frontend, then waits for it and `eval`s the output of `env`, so the node is off the critical path.
- **One instance per run,** named `e2e-` and the script's process id with `REGTEST_PROJECT`, so runs on one machine never share a node. Tests that change the chain are the `*.mine.e2e.ts` files: they mine and pay through the node's RPC with helpers in [`web/e2e/regtest.ts`](../web/e2e/regtest.ts) that build transactions the harness's way, the hostile test runs `hostile` and the Stratum V2 test `tagged`.
