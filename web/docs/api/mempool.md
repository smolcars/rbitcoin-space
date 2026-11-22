# Mempool

The node's unconfirmed transactions: their count and fee spread, their txids, the newest arrivals, and the fee rates the node estimates. These are rbitcoin's Esplora routes. A successful answer is the node's own body. Parameters are checked here first, and an error is this server's own JSON, for example `400` `{"error": "invalid txid"}` for a malformed txid.

Every route here is under the REST base: `/api` on mainnet, `/signet/api`, `/testnet4/api` and `/testnet5/api` on the others. Answers here change every moment, so each is cached for one second.

## GET /api/mempool

How many transactions are waiting, their size and fees, and how the fee rates spread.

```sh
curl https://rbitcoin.space/api/mempool
```

The answer, with `fee_histogram` cut to its first three of 339 pairs:

```json
{
  "count": 68973,
  "fee_histogram": [
    [150.0, 141],
    [44.247, 113],
    [44.238, 113]
  ],
  "total_fee": 4011975,
  "vsize": 30295228
}
```

| Field           | Means                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `count`         | Transactions in the mempool                                                                                                              |
| `vsize`         | Their virtual size, summed                                                                                                               |
| `total_fee`     | Their fees, satoshis                                                                                                                     |
| `fee_histogram` | Pairs of a fee rate in sat/vB and a virtual size, highest rate first. Each size is what pays that rate or more, up to the pair before it |

The answer carries no chain-tip headers.

## GET /api/mempool/txids

Every txid in the mempool, as one JSON array. On mainnet that is several megabytes; prefer the paged form below.

```sh
curl https://rbitcoin.space/api/mempool/txids
```

## GET /api/mempool/txids/page

The first page of mempool txids, in txid order.

```sh
curl "https://rbitcoin.space/api/mempool/txids/page?max_txs=3"
```

```json
[
  "7f90ec439c5a0b44e784ef403fd3c153a6c3ad096f995f898c7b330559940000",
  "f00febce886db3adfcf9f12edc218e2dba6c09c6ebbf98f42af8685e3daf0000",
  "bd4410f242da074cfc8d6e8aa231374db8b69420d6ec82b40a85c1496ea80300"
]
```

| Parameter | Format                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| `max_txs` | Decimal digits. Omitted, a page holds 10,000 txids; more than 10,000 is read as 10,000, and `0` gives an empty page |

Unlike the other routes here, the answer carries `X-Bitcoin-Chain-Tip` and `X-Bitcoin-Chain-Tip-Height`.

## GET /api/mempool/txids/page/:last_txid

The next page, after `:last_txid`, the last txid of the page before. Takes `?max_txs=` too.

```sh
curl "https://rbitcoin.space/api/mempool/txids/page/bd4410f242da074cfc8d6e8aa231374db8b69420d6ec82b40a85c1496ea80300?max_txs=2"
```

```json
[
  "a9f6254a89efa5ac2b1ff0ea9fdebe6360c9c675c7387faf78ba0b1ea7250400",
  "61c41ed8c8f8704eef5757dbe098710123283a438d99b39796b994ee926b0400"
]
```

Transactions come and go between pages, so a walk through every page is not a snapshot of one moment.

## GET /api/mempool/recent

Up to ten transactions the node accepted most recently, newest first, in a compact form. It is not a change feed: for that, use [the WebSocket](/docs/websocket).

```sh
curl https://rbitcoin.space/api/mempool/recent
```

The first two of ten:

```json
[
  {
    "fee": 16428,
    "txid": "1d314814d3f3864eea924680d1fff55b9ebd5de0e9ea341fbaecfc6a9d1bc206",
    "value": 956233572,
    "vsize": 6744
  },
  {
    "fee": 1000,
    "txid": "2f8d45dc3928e0acc577b350f3ff50c083c23a87e6d1bf1eb352406c33f6fa9e",
    "value": 8044311624,
    "vsize": 220
  }
]
```

| Field   | Means                            |
| ------- | -------------------------------- |
| `txid`  | The transaction                  |
| `fee`   | Satoshis                         |
| `vsize` | Virtual bytes                    |
| `value` | The sum of its outputs, satoshis |

## GET /api/fee-estimates

The node's fee rate estimate for each confirmation target. Each key is a target in blocks, each value a rate in sat/vB with up to three decimals. A target the node has no estimate for is left out.

```sh
curl https://rbitcoin.space/api/fee-estimates
```

```json
{
  "1": 1.349,
  "10": 0.137,
  "1008": 0.11,
  "11": 0.137,
  "12": 0.137,
  "13": 0.137,
  "14": 0.137,
  "144": 0.128,
  "15": 0.137,
  "16": 0.137,
  "17": 0.137,
  "18": 0.137,
  "19": 0.137,
  "2": 0.258,
  "20": 0.137,
  "21": 0.137,
  "22": 0.137,
  "23": 0.137,
  "24": 0.137,
  "25": 0.137,
  "3": 0.189,
  "4": 0.189,
  "5": 0.189,
  "504": 0.12,
  "6": 0.173,
  "7": 0.164,
  "8": 0.155,
  "9": 0.146
}
```

The keys are the ones mempool.space serves, but the values are rbitcoin's own estimates, so they differ from its numbers. For five ready-made levels worked out from the projected next blocks, use [`/api/v1/fees/precise`](/docs/api/v1/fees).

When the node has no estimates yet, for example just after it starts, mainnet answers `503` `node unavailable`; retry after the seconds in `Retry-After`. On signet and the testnets the answer is then `200` `{}` instead. The answer carries no chain-tip headers.

## Errors

| Status | Message            | When                                      |
| ------ | ------------------ | ----------------------------------------- |
| `400`  | `invalid txid`     | `:last_txid` is not exactly 64 hex digits |
| `400`  | `invalid max_txs`  | Not decimal digits, or too large          |
| `503`  | `node unavailable` | The node cannot answer yet                |

The rest, and how to retry, are in [Limits and errors](/docs/limits).
