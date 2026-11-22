# Blocks

The chain tip, lists of recent blocks, and one block by its hash or height: its fields, header, raw bytes and transactions. These are rbitcoin's Esplora routes, and any Esplora client reads them unchanged. A successful answer is the node's own body. Parameters are checked here first, and an error is this server's own JSON, for example `400` `{"error": "invalid block hash"}` for a malformed hash.

Every route here is under the REST base: `/api` on mainnet, `/signet/api`, `/testnet4/api` and `/testnet5/api` on the others.

## GET /api/blocks/tip/height

The height of the newest block on the best chain, as plain text.

```sh
curl https://rbitcoin.space/api/blocks/tip/height
```

```text
977073
```

## GET /api/blocks/tip/hash

The hash of the newest block, as plain text.

```sh
curl https://rbitcoin.space/api/blocks/tip/hash
```

```text
000000000000000000018d6041be5052b4646a3e6490fca8d500e748b8181ce4
```

## GET /api/blocks

The ten newest blocks, newest first, each in the shape of [`/api/block/:hash`](#get-api-block-hash).

```sh
curl https://rbitcoin.space/api/blocks
```

## GET /api/blocks/:start_height

Up to ten blocks, newest first, starting at `:start_height` and going down. Near the start of the chain there are fewer: `/api/blocks/2` gives heights 2, 1 and 0. A start above the tip is read as the tip. Page backwards by asking again from the lowest height you got, minus one, and stop once you have block 0.

```sh
curl https://rbitcoin.space/api/blocks/170
```

The answer holds blocks 170 down to 161. The first:

```json
[
  {
    "bits": 486604799,
    "difficulty": 1.0,
    "height": 170,
    "id": "00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee",
    "mediantime": 1231716245,
    "merkle_root": "7dac2c5666815c17a3b36427de37bb9d2e2c5ccec3f8633eb91a4205cb4c10ff",
    "nonce": 1889418792,
    "previousblockhash": "000000002a22cfee1f2c846adbd12b3e183d4f97683f85dad08a79780a84bd55",
    "size": 490,
    "timestamp": 1231731025,
    "tx_count": 2,
    "version": 1,
    "weight": 1960
  }
]
```

| Parameter      | Format         |
| -------------- | -------------- |
| `start_height` | Decimal digits |

For blocks with their miner, fees and fee rates, use [the explorer's block routes](/docs/api/v1/blocks) instead.

## GET /api/block-height/:height

The hash of the block at a height on the best chain, as plain text.

```sh
curl https://rbitcoin.space/api/block-height/170
```

```text
00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee
```

`404` `not found` above the tip. A reorg can change the answer, so it is cached for one second.

## GET /api/block/:hash

One block's header fields and size. The transactions are in [`/txs`](#get-api-block-hash-txs) and [`/txids`](#get-api-block-hash-txids).

```sh
curl https://rbitcoin.space/api/block/00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee
```

```json
{
  "bits": 486604799,
  "difficulty": 1.0,
  "height": 170,
  "id": "00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee",
  "mediantime": 1231716245,
  "merkle_root": "7dac2c5666815c17a3b36427de37bb9d2e2c5ccec3f8633eb91a4205cb4c10ff",
  "nonce": 1889418792,
  "previousblockhash": "000000002a22cfee1f2c846adbd12b3e183d4f97683f85dad08a79780a84bd55",
  "size": 490,
  "timestamp": 1231731025,
  "tx_count": 2,
  "version": 1,
  "weight": 1960
}
```

| Field               | Means                                                         |
| ------------------- | ------------------------------------------------------------- |
| `id`                | The block hash                                                |
| `height`            | Its height                                                    |
| `version`           | The header's version field                                    |
| `timestamp`         | The header's time, Unix seconds                               |
| `mediantime`        | The median time of the 11 blocks up to this one, Unix seconds |
| `bits`              | The compact target, as an integer                             |
| `difficulty`        | The difficulty that target means                              |
| `nonce`             | The header's nonce                                            |
| `merkle_root`       | The root of the block's transactions                          |
| `previousblockhash` | The block before it                                           |
| `tx_count`          | Transactions, the coinbase included                           |
| `size`              | Bytes                                                         |
| `weight`            | Weight units, at most 4,000,000                               |

The answer says nothing about confirmation, so it never changes: it is cached as `public, max-age=31536000, immutable`. The node serves no block off its best chain: a block that has left it after a reorg is `404` `not found`.

| Parameter | Format                          |
| --------- | ------------------------------- |
| `hash`    | Exactly 64 hex digits, any case |

## GET /api/block/:hash/status

Whether the block is on the best chain, and the block after it.

```sh
curl https://rbitcoin.space/api/block/00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee/status
```

```json
{
  "height": 170,
  "in_best_chain": true,
  "next_best": "00000000c9ec538cab7f38ef9c67a95742f56ab07b0a37c5be6b02808dbfb4e0"
}
```

The answer changes with a reorg, so it is cached for one second.

## GET /api/block/:hash/header

The 80-byte block header, as hex text.

```sh
curl https://rbitcoin.space/api/block/00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee/header
```

```text
0100000055bd840a78798ad0da853f68974f3d183e2bd1db6a842c1feecf222a00000000ff104ccb05421ab93e63f8c3ce5c2c2e9dbb37de2764b3a3175c8166562cac7d51b96a49ffff001d283e9e70
```

## GET /api/block/:hash/raw

The whole block in its network serialization, as binary (`application/octet-stream`). A full mainnet block is 1 to 4 MB; block 170 is 490 bytes.

```sh
curl -o block.bin https://rbitcoin.space/api/block/00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee/raw
```

## GET /api/block/:hash/txids

Every txid in the block, in block order, the coinbase first. A full block's list is about 450 KB.

```sh
curl https://rbitcoin.space/api/block/00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee/txids
```

```json
[
  "b1fea52486ce0c62bb442b530a3f0132b826c74e473d1f2c220bfa78111c5082",
  "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16"
]
```

## GET /api/block/:hash/txid/:index

The txid at one position in the block, as plain text. Position 0 is the coinbase.

```sh
curl https://rbitcoin.space/api/block/00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee/txid/1
```

```text
f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16
```

| Parameter | Format         |
| --------- | -------------- |
| `index`   | Decimal digits |

`404` `not found` past the last transaction.

## GET /api/block/:hash/txs

The block's first 25 transactions, in block order, each in the shape of [`/api/tx/:txid`](/docs/api/transactions) with its prevouts, fee and status.

```sh
curl https://rbitcoin.space/api/block/00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee/txs
```

Block 170 has two transactions, so the answer is a list of two. Each carries a status, so the answer is cached for one second.

## GET /api/block/:hash/txs/:start_index

The next 25 transactions from position `:start_index`.

```sh
curl https://rbitcoin.space/api/block/00000000000000000001d9ed66ca43dc7765b3d6e9767304247fca17a4b085da/txs/25
```

| Parameter     | Format                           |
| ------------- | -------------------------------- |
| `start_index` | Decimal digits, a multiple of 25 |

`400` `start index must be a multiple of 25` for any other number. `404` `not found` at or past the block's last transaction. `/txs` and `/txs/0` are the same page.

## Caching

| Route                                                                        | `Cache-Control`                       |
| ---------------------------------------------------------------------------- | ------------------------------------- |
| `/block/:hash`, `/header`, `/raw`, `/txids`, `/txid/:index`                  | `public, max-age=31536000, immutable` |
| `/block/:hash/status`, `/txs`, `/txs/:start_index`                           | `public, max-age=1`                   |
| `/blocks`, `/blocks/:start_height`, `/blocks/tip/*`, `/block-height/:height` | `public, max-age=1`                   |

Answers that depend on the chain carry `X-Bitcoin-Chain-Tip` and `X-Bitcoin-Chain-Tip-Height`, the tip they were read at.

## Not served

`GET /api/block-template` is `404`. For a projection of the next blocks, use [`/api/v1/fees/mempool-blocks`](/docs/api/v1/fees).

## Errors

| Status | Message                                                  | When                                                        |
| ------ | -------------------------------------------------------- | ----------------------------------------------------------- |
| `400`  | `invalid block hash`                                     | `:hash` is not exactly 64 hex digits                        |
| `400`  | `invalid height`, `invalid index`, `invalid start index` | Not decimal digits, or too large                            |
| `404`  | `not found`                                              | No such block on the best chain, or a position past the end |

The rest, and how to retry, are in [Limits and errors](/docs/limits).
