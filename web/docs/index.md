# rbitcoin.space API

rbitcoin.space is a block explorer for [rbitcoin](https://github.com/rbitcoin-org/rbitcoin), and everything it shows comes from a public API you can call too. There is no key and no account. Answers are JSON, plain text, or raw bytes for the routes that end in `/raw`, over HTTPS.

## Base URLs

Each network has its own prefix. Drop the prefix for mainnet.

| Network   | REST (Esplora)  | Explorer routes    | WebSocket             |
| --------- | --------------- | ------------------ | --------------------- |
| Mainnet   | `/api`          | `/api/v1`          | `/api/v1/ws`          |
| Signet    | `/signet/api`   | `/signet/api/v1`   | `/signet/api/v1/ws`   |
| Testnet4  | `/testnet4/api` | `/testnet4/api/v1` | `/testnet4/api/v1/ws` |
| Testnet 5 | `/testnet5/api` | `/testnet5/api/v1` | `/testnet5/api/v1/ws` |

All of them live on `https://rbitcoin.space`. A server you run yourself serves the same paths for the networks it has turned on.

## First requests

The height of the newest block:

```sh
curl https://rbitcoin.space/api/blocks/tip/height
```

```text
977071
```

What to pay to be mined soon, in sat/vB:

```sh
curl https://rbitcoin.space/api/v1/fees/precise
```

```json
{
  "fastestFee": 1.058,
  "halfHourFee": 0.129,
  "hourFee": 0.122,
  "economyFee": 0.122,
  "minimumFee": 0.1
}
```

A transaction, on signet:

```sh
curl https://rbitcoin.space/signet/api/tx/8bfc5a82630f9fea0808f9a83a07f0a394e497a009bec9780bde4bf92cdc1f5c
```

## Which part to use

| You want                                                                                                                                                                                                                                     | Use                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What any Esplora wallet or library already reads: [blocks](/docs/api/blocks), [transactions](/docs/api/transactions), [addresses](/docs/api/addresses), the [mempool](/docs/api/mempool), [broadcast](/docs/api/broadcast)                   | REST at `/api`. Same routes and successful bodies as rbitcoin's Esplora server, but for [very large addresses](/docs/api/addresses#very-large-addresses). Parameters are checked here first, and errors are this server's own JSON, `{"error": ...}` |
| [Fee recommendations](/docs/api/v1/fees), [blocks with their miner and fees](/docs/api/v1/blocks), [mining pools and hashrate](/docs/api/v1/mining), [replacements and CPFP](/docs/api/v1/transactions), [Lightning](/docs/api/v1/lightning) | Explorer routes at `/api/v1`, shaped like mempool.space's                                                                                                                                                                                            |
| New blocks, mempool changes and an address's activity as they happen                                                                                                                                                                         | The [WebSocket](/docs/websocket) at `/api/v1/ws`                                                                                                                                                                                                     |
| A chat bot or a coding agent that looks things up                                                                                                                                                                                            | The MCP server at `/mcp`. See [Use with an agent](/docs/agents)                                                                                                                                                                                      |

## Conventions

- Amounts are in satoshis, fee rates in sat/vB, sizes in virtual bytes, and times in Unix seconds.
- Transaction ids and block hashes are 64 hex digits, written the way block explorers show them.
- A parameter that does not parse is a `400` that names it, for example `invalid txid`. Nothing is guessed.
- Answers that change with the chain say which tip they were read at, in `X-Bitcoin-Chain-Tip` and `X-Bitcoin-Chain-Tip-Height`.

## Fair use

The API is open to anyone, from any website: every `/api` answer allows any origin. Limits apply per client address so one caller cannot slow the node for everyone. [Limits and errors](/docs/limits) says what they are and how to retry.
