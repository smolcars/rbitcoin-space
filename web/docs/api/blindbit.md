# Silent payments

The BlindBit v1 oracle routes, which a silent payments wallet scans to find payments to it: each block's tweaks, its taproot outputs, what it spent, and two compact filters. They are rbitcoin's own BlindBit v1 handlers, with the node's bodies and content types. Point a BlindBit v1 client at the prefix and it reads them unchanged.

Every route here is under `/api/blindbit/v1` on mainnet, `/signet/api/blindbit/v1`, `/testnet4/api/blindbit/v1` and `/testnet5/api/blindbit/v1` on the others. They need the node's silent payments index. A height the index does not hold is `404`; while it holds none, `/info` and `/block-height` are `503`.

## GET /api/blindbit/v1/info

What the server indexes, and up to which height.

```sh
curl https://rbitcoin.space/api/blindbit/v1/info
```

```json
{
  "height": 977073,
  "network": "main",
  "tweaks_cut_through_with_dust_filter": true,
  "tweaks_full_basic": true,
  "tweaks_full_with_dust_filter": true,
  "tweaks_only": false
}
```

| Field      | Means                                                                  |
| ---------- | ---------------------------------------------------------------------- |
| `height`   | The newest height every route here can answer                          |
| `network`  | The chain's name as Bitcoin Core writes it: `main` on mainnet          |
| `tweaks_*` | Which forms of the tweak lists are served, as BlindBit v1 defines them |

## GET /api/blindbit/v1/block-height

The newest height every route here can answer.

```sh
curl https://rbitcoin.space/api/blindbit/v1/block-height
```

```json
{ "block_height": 977073 }
```

## GET /api/blindbit/v1/block-hash/:height

The hash of the block at a height.

```sh
curl https://rbitcoin.space/api/blindbit/v1/block-hash/977000
```

```json
{ "block_hash": "00000000000000000001d9ed66ca43dc7765b3d6e9767304247fca17a4b085da" }
```

| Parameter | Format                             |
| --------- | ---------------------------------- |
| `height`  | Decimal digits, at most 4294967295 |

## GET /api/blindbit/v1/tweaks/:height

The tweak of each transaction in the block that could pay a silent payment, as 33-byte compressed points in hex. The list is cut through: a transaction is dropped once its taproot outputs are all spent, so the list for an old block shrinks over time.

```sh
curl https://rbitcoin.space/api/blindbit/v1/tweaks/977000
```

The first two of 75 when this page was written:

```json
[
  "039820aa741ff72573cc71d88b024bd50df11fc899f315d47fe8fe82d216c19df2",
  "032c53d8bfe2f115d9322c2e2f9230dd1a73f5d4c31969b730e531986f983bdb6d"
]
```

| Parameter   | Format                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `height`    | Decimal digits                                                                                         |
| `dustLimit` | Optional. Decimal satoshis: keep only transactions whose largest taproot output is worth at least this |

With `?dustLimit=1000` the same block gave 55.

## GET /api/blindbit/v1/tweak-index/:height

Every eligible transaction's tweak, none dropped for being spent. Takes `?dustLimit=` as `/tweaks` does.

```sh
curl https://rbitcoin.space/api/blindbit/v1/tweak-index/977000
```

The same block gave 155 here, against 75 in `/tweaks`.

## GET /api/blindbit/v1/utxos/:height

Every taproot output of the block's eligible transactions, with whether it is spent.

```sh
curl https://rbitcoin.space/api/blindbit/v1/utxos/977000
```

The first of 266:

```json
[
  {
    "block_hash": "00000000000000000001d9ed66ca43dc7765b3d6e9767304247fca17a4b085da",
    "block_height": 977000,
    "scriptpubkey": "51202a58c42aa2c9a86bea9863398ea71bd570b775e5d5c45e33eebc8bb5b8a9c2f3",
    "spent": false,
    "timestamp": 1795323741,
    "txid": "f550a87c673588015751ff883f0acc77dc0a42ab9389a28461a8e2f70a916253",
    "value": 50185700,
    "vout": 3
  }
]
```

## GET /api/blindbit/v1/spent-index/:height

Short hashes of the outputs the block spends, 8 bytes each in hex, as BlindBit v1 builds them, so a wallet can tell which of its outputs were spent there.

```sh
curl https://rbitcoin.space/api/blindbit/v1/spent-index/977000
```

The first three of 8,106:

```json
{
  "block_hash": "00000000000000000001d9ed66ca43dc7765b3d6e9767304247fca17a4b085da",
  "data": ["5e6e80a1bf7b34cd", "070b4859be545e02", "fca8ea78b1b99ae2"]
}
```

## GET /api/blindbit/v1/filter/new-utxos/:height

A compact filter of the taproot output keys the block creates. A wallet tests its own keys against it before it asks for the block's outputs.

```sh
curl https://rbitcoin.space/api/blindbit/v1/filter/new-utxos/977000
```

The answer, with `data`, the filter in hex, left out here:

```json
{
  "block_hash": "00000000000000000001d9ed66ca43dc7765b3d6e9767304247fca17a4b085da",
  "block_height": 977000,
  "filter_type": 4
}
```

## GET /api/blindbit/v1/filter/spent/:height

A compact filter of the outputs the block spends, in the same shape. A wallet tests its own outputs against it.

```sh
curl https://rbitcoin.space/api/blindbit/v1/filter/spent/977000
```

## POST /api/blindbit/v1/forward-tx

Broadcast for BlindBit clients. The body is JSON with one field, `data`, the raw transaction in hex; the answer is its txid as a JSON string.

```sh
curl -X POST -H "Content-Type: application/json" --data-binary @tx.json https://rbitcoin.space/api/blindbit/v1/forward-tx
```

Here `tx.json` holds `{"data":"<raw transaction hex>"}`.

- Any other field, or a body that is not that object, is `400` `body must be a JSON object with data transaction hex`. The body may be at most 800,016 bytes.
- It is [`POST /api/tx`](/docs/api/broadcast) by another name: the same 400,000-byte transaction cap, the same reject reasons, and the same per-client allowance on each network, a burst of 5 then one every 10 seconds, shared between the two routes. Past it, `429` with `Retry-After: 10`.
- Where broadcast is off, `403` `broadcast is disabled on this server`.
- Answers are `Cache-Control: no-store`.

## Caching and limits

Every read is cached for one second, height-keyed ones too: a reorg or a later spend can change them. The reads have the ordinary per-client limits, not the address routes'.

## Errors

| Status | Message                                                  | When                                                                           |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `400`  | `invalid height`, `invalid dustLimit`                    | Not decimal digits, or too large                                               |
| `400`  | `unexpected query parameter`, `repeated query parameter` | A query parameter other than `dustLimit` where it is taken, or one given twice |
| `404`  | `not found`                                              | A height the index does not hold, or a path that is not one of these routes    |
| `405`  | `method not allowed`                                     | Any method but `GET` and `HEAD` on a read, or but `POST` on `forward-tx`       |
| `503`  | `node unavailable`                                       | The index holds no height yet                                                  |

The rest, and how to retry, are in [Limits and errors](/docs/limits).
