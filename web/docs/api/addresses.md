# Addresses

What an address, a public key or a script has received and spent: its totals, its unspent outputs and its transactions, newest first. These are rbitcoin's Esplora routes. A successful answer is the node's own body, except for an address so large that this server keeps its history itself ([Very large addresses](#very-large-addresses)). Parameters are checked here first, and an error is this server's own JSON, for example `400` `{"error": "invalid address"}` for a malformed address.

Every route here is under the REST base: `/api` on mainnet, `/signet/api`, `/testnet4/api` and `/testnet5/api` on the others. They need the node's address index; where it is off, every one answers `503` `address index is disabled on this server`, except `/txs/mempool`, which reads only the mempool and is served without it.

## What can name a script

| Form                                             | Route                   | Example                                                            |
| ------------------------------------------------ | ----------------------- | ------------------------------------------------------------------ |
| An address of the network in the URL             | `/api/address/:address` | `12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S`                               |
| A public key, for outputs paid to the key itself | `/api/address/:address` | `04ae1a62...e6cd84c`, 130 hex digits                               |
| The SHA-256 of the output script                 | `/api/scripthash/:hash` | `799c48c4482e6a9726b0ee7f1609fb83c52a0d63b9c1d0b3fd8770f26e1c4677` |

Every route below exists in both forms, `/api/address/:address/...` and `/api/scripthash/:hash/...`, with the same answers.

An address is read for the network in the URL. `400` `invalid address` when it does not parse, and `400` `address is for another network` for, say, a testnet address under `/api`.

### Public keys in place of addresses

An output paid to a public key itself (P2PK, `<key> OP_CHECKSIG`, as most early coinbases are) has no address, so the key stands in for one. Every `/api/address/:address` route takes it.

- 66 hex digits starting `02` or `03` (compressed), or 130 starting `04` (uncompressed), any case, and a point on the curve. Anything else of that shape is `400` `invalid address`.
- The compressed and uncompressed forms of one key are paid by two different scripts, so they have two different histories. Hybrid keys (`06`, `07`) are refused.
- A key belongs to no network: it is valid under every prefix, and answers zeros where nothing paid it.
- The answer is the script's: totals carry `"scripthash"` where an address's carry `"address"`.

```sh
curl https://rbitcoin.space/api/address/04ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84c
```

```json
{
  "chain_stats": {
    "funded_txo_count": 1,
    "funded_txo_sum": 1000000000,
    "spent_txo_count": 1,
    "spent_txo_sum": 1000000000,
    "tx_count": 2
  },
  "mempool_stats": {
    "funded_txo_count": 0,
    "funded_txo_sum": 0,
    "spent_txo_count": 0,
    "spent_txo_sum": 0,
    "tx_count": 0
  },
  "scripthash": "799c48c4482e6a9726b0ee7f1609fb83c52a0d63b9c1d0b3fd8770f26e1c4677"
}
```

### Scripthashes

`:hash` is the SHA-256 of the output script, in digest order: the hash as computed, as electrs, Blockstream's Esplora and mempool.space take it. It is not Electrum's byte-reversed form; a reversed hash names another script and gets an empty history. For the P2PK script above:

```sh
printf '%s' 4104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac | xxd -r -p | sha256sum
```

```text
799c48c4482e6a9726b0ee7f1609fb83c52a0d63b9c1d0b3fd8770f26e1c4677  -
```

`400` `invalid scripthash` when it is not 64 hex digits.

## GET /api/address/:address

What the address has received and spent, confirmed and in the mempool. Takes `?asof=`.

```sh
curl https://rbitcoin.space/api/address/12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S
```

```json
{
  "address": "12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S",
  "chain_stats": {
    "funded_txo_count": 136,
    "funded_txo_sum": 44410901,
    "spent_txo_count": 0,
    "spent_txo_sum": 0,
    "tx_count": 133
  },
  "mempool_stats": {
    "funded_txo_count": 0,
    "funded_txo_sum": 0,
    "spent_txo_count": 0,
    "spent_txo_sum": 0,
    "tx_count": 0
  }
}
```

`chain_stats` counts confirmed transactions and `mempool_stats` unconfirmed ones, each with:

| Field              | Means                                     |
| ------------------ | ----------------------------------------- |
| `funded_txo_count` | Outputs paid to it                        |
| `funded_txo_sum`   | Their value, satoshis                     |
| `spent_txo_count`  | Of its outputs, those spent               |
| `spent_txo_sum`    | Their value, satoshis                     |
| `tx_count`         | Transactions that pay it or spend from it |

The balance is `funded_txo_sum - spent_txo_sum`, summed over both.

## GET /api/scripthash/:hash

The same totals, named by scripthash. The answer carries `"scripthash"` in place of `"address"`; for this hash it is the answer shown for the public key above, byte for byte. Takes `?asof=`.

```sh
curl https://rbitcoin.space/api/scripthash/799c48c4482e6a9726b0ee7f1609fb83c52a0d63b9c1d0b3fd8770f26e1c4677
```

## GET /api/address/:address/utxo

Every unspent output of the address. Takes `?asof=`.

```sh
curl https://rbitcoin.space/api/address/12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S/utxo
```

The answer lists 136 outputs. The first:

```json
[
  {
    "status": {
      "block_hash": "00000000000001c8cc67817c69a81e54dd1cf589456552beacaeb2e53725ea01",
      "block_height": 220151,
      "block_time": 1360299643,
      "confirmed": true
    },
    "txid": "1554a02d4eb1c7a73e3736922ed99530e360784e709896c42e5756e65b2da341",
    "value": 1,
    "vout": 2
  }
]
```

| Field          | Means                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `txid`, `vout` | The output                                                                                      |
| `value`        | Satoshis                                                                                        |
| `status`       | The creating transaction's status, as [`/api/tx/:txid/status`](/docs/api/transactions) gives it |

## GET /api/address/:address/txs

The address's unconfirmed transactions, at most 50, then its 25 newest confirmed ones, each in the shape of [`/api/tx/:txid`](/docs/api/transactions). Takes `?asof=` and `?after_txid=`. With `?asof=` the unconfirmed part is left out.

```sh
curl https://rbitcoin.space/api/address/12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S/txs
```

## GET /api/address/:address/txs/chain

25 confirmed transactions, newest first. Takes `?asof=`.

```sh
curl https://rbitcoin.space/api/address/12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S/txs/chain
```

## GET /api/address/:address/txs/chain/:last_seen_txid

The next 25 confirmed transactions after `:last_seen_txid`, the last txid of the page before. Takes `?asof=`.

```sh
curl https://rbitcoin.space/api/address/12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S/txs/chain/db69b82c2389cb4af3fad1c189bac315b0977741770ee4bbc08d8b1b9791597f
```

## GET /api/address/:address/txs/mempool

The address's unconfirmed transactions, at most 50. It does not take `?asof=`, and its answer carries no chain-tip headers.

```sh
curl https://rbitcoin.space/api/address/12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S/txs/mempool
```

```json
[]
```

## GET /api/address/:address/txs/summary

The same history as compact rows, 25 a page, newest first: the cheap way to draw a balance chart. Takes `?asof=` and `?after_txid=`.

```sh
curl https://rbitcoin.space/api/address/12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S/txs/summary
```

The first two rows:

```json
[
  {
    "height": 975804,
    "time": 1794665318,
    "tx_position": 634,
    "txid": "34b2c6677fc52c8facfbafed6a206adb7e48db2b3e69b5030d00c8253620bc0a",
    "value": 1497
  },
  {
    "height": 973714,
    "time": 1793291275,
    "tx_position": 331,
    "txid": "448f3b960c99ae65462d9440479fadd52ce817971f754fc9ed2030f3d56f1b36",
    "value": 1229
  }
]
```

| Field         | Means                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| `txid`        | The transaction                                                                        |
| `value`       | Net satoshis for this address in it: received minus spent, negative when it spent more |
| `height`      | Its block's height                                                                     |
| `time`        | Its block's time, Unix seconds                                                         |
| `tx_position` | Its position in the block. It may be left out                                          |

The scripthash form of the public key above shows a spend:

```sh
curl https://rbitcoin.space/api/scripthash/799c48c4482e6a9726b0ee7f1609fb83c52a0d63b9c1d0b3fd8770f26e1c4677/txs/summary
```

```json
[
  {
    "height": 92240,
    "time": 1289939967,
    "tx_position": 6,
    "txid": "ea44e97271691990157559d0bdd9959e02790c34db6c006d779e82fa5aee708e",
    "value": -1000000000
  },
  {
    "height": 170,
    "time": 1231731025,
    "tx_position": 1,
    "txid": "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16",
    "value": 1000000000
  }
]
```

## GET /api/address/:address/txs/summary/:last_seen_txid

The next 25 rows after `:last_seen_txid`. Takes `?asof=`, not `?after_txid=`.

```sh
curl https://rbitcoin.space/api/address/12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S/txs/summary/db69b82c2389cb4af3fad1c189bac315b0977741770ee4bbc08d8b1b9791597f
```

## Scripthash routes

Each address route above has a scripthash form, with the same answers for the script whose SHA-256 is `:hash` ([Scripthashes](#scripthashes)).

### GET /api/scripthash/:hash/utxo

As `/api/address/:address/utxo`. Takes `?asof=`.

### GET /api/scripthash/:hash/txs

As `/api/address/:address/txs`. Takes `?asof=` and `?after_txid=`.

### GET /api/scripthash/:hash/txs/chain[/:last_seen_txid]

As `/api/address/:address/txs/chain`, and the page after `:last_seen_txid`. Takes `?asof=`.

### GET /api/scripthash/:hash/txs/mempool

As `/api/address/:address/txs/mempool`.

### GET /api/scripthash/:hash/txs/summary

As `/api/address/:address/txs/summary`. Takes `?asof=` and `?after_txid=`.

### GET /api/scripthash/:hash/txs/summary/:last_seen_txid

The page after `:last_seen_txid`. Takes `?asof=`, not `?after_txid=`.

## Paging through a history

1. Ask `/txs/chain` for the newest 25 confirmed transactions.
2. Ask `/txs/chain/:last_seen_txid`, with the last txid of that page as the cursor.
3. Repeat with the last txid of each new page. Stop when a page holds fewer than 25.

`/txs/summary` pages the same way, with `/txs/summary/:last_seen_txid` or `?after_txid=`. The 25-row rule counts confirmed rows: the first `/txs` page also starts with up to 50 unconfirmed transactions, so page through `/txs/chain` rather than `/txs`.

Pass the same `?asof=<blockhash>` on every page, for example the `X-Bitcoin-Chain-Tip` of the first answer, and a new block cannot shift the pages under you. From the node, a block not on the best chain is `404` `not found`. For an address this server keeps ([Very large addresses](#very-large-addresses)) the answer can instead be `503`: `unspent outputs and older history are not kept for an address this large` for a block it does not hold (more than 100 blocks below its newest, one it never saw, or one a reorg removed and it has rolled back), `address history too large for this server` where it keeps only the totals, or `chain tip moved during the request; retry` for a block the node has dropped in a reorg while this server still holds it.

| Parameter                      | Format                                        |
| ------------------------------ | --------------------------------------------- |
| `last_seen_txid`, `after_txid` | A txid in this history: exactly 64 hex digits |
| `asof`                         | A block hash on the best chain                |

`422` `after_txid not found` when the cursor is a txid but not one in this address's history. When it is not a txid, a path cursor is `400` `invalid txid` and `?after_txid=` is `400` `invalid after_txid`.

The chain-tip headers on these routes name the height the node's address index has reached, which can be a moment behind the tip.

## Very large addresses

Some addresses have been paid by millions of transactions. Adding one up can take the node minutes, so the server limits what it asks, and a client sees these answers:

| Answer                                                                           | When                                                                                                                                                           | What to do                                                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `503` `address history too large for this server`                                | The node refuses to add up an address this large, for its totals, unspent outputs or a history page                                                            | Ask again in a few minutes, or use `/txs/mempool`, which is never refused for size |
| `504` `request timed out`                                                        | The node took over 5 s on a page of history or on totals. The same page asked again within 5 minutes gets this at once                                         | Wait a few minutes before asking that page again                                   |
| `503` `node busy; retry` with `Retry-After: 1`                                   | The totals or unspent outputs of an address not yet known to be small wait their turn behind one such call at a time for the whole server; this one waited 5 s | Retry after a second                                                               |
| `503` `unspent outputs and older history are not kept for an address this large` | `/utxo`, totals with `?asof=`, or a history page with `?asof=` older than the last 100 blocks, of a very large address whose totals the server keeps itself    | Not served for that address                                                        |

rbitcoin.space keeps its own running totals for many very large addresses. For those, `/api/address/:address` answers in the usual shape without asking the node: `chain_stats` is exact at the block named by `X-Bitcoin-Chain-Tip`, `mempool_stats` is counted from at most 50 unconfirmed transactions (with 50, `X-Mempool-Stats-Partial: true` says there may be more), and the answer is `Cache-Control: no-store`. Where the server also holds the address's whole history, its history pages answer from it in the node's shapes and order, with `tx_position` left out of summary rows, and take `?asof=` for any of the last 100 blocks.

## Limits

These routes can cost the node far more than a lookup, so each client has a smaller allowance for them, on top of the general one:

| Allowance                                                  | Past it                                        |
| ---------------------------------------------------------- | ---------------------------------------------- |
| 30 at once, then 2 a second                                | `429` with `Retry-After: 1`                    |
| 4 running or waiting at once                               | `429` with `Retry-After: 1`                    |
| 4 running and 8 waiting per network, for everyone together | `503` `node busy; retry` with `Retry-After: 1` |

`/api/txs/outspends` and `POST /api/block-heights/txs/outs` ([Transactions](/docs/api/transactions)), and [`POST /api/v1/prevouts`](/docs/api/v1/transactions), share the allowance.

## Not served

`POST /api/addresses/txs`, `POST /api/scripthashes/txs` and their `/summary` forms are `404`: one request could ask for up to 300 address histories. Ask per address. `GET /api/address-prefix/:prefix` is `404` too.

## Errors

| Status | Message                                                                   | When                                                     |
| ------ | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| `400`  | `invalid address`, `address is for another network`, `invalid scripthash` | The address, key or hash does not parse for this network |
| `400`  | `invalid txid`, `invalid after_txid`, `invalid asof`                      | A path cursor, `?after_txid=` or pin that is not a hash  |
| `422`  | `after_txid not found`                                                    | The cursor is not in this history                        |
| `503`  | `address index is disabled on this server`                                | The node has no address index                            |
| `503`  | `chain tip moved during the request; retry`                               | The chain moved under a pinned read. Ask again           |

The rest, and how to retry, are in [Limits and errors](/docs/limits).
