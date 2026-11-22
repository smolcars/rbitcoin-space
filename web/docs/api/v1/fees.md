# Fees

What to pay to be mined within a given time, and the projected blocks behind it. The server works these out from its own projection of the next blocks, refreshed every two seconds.

Every route here is under the explorer routes' base: `/api/v1` on mainnet, `/signet/api/v1`, `/testnet4/api/v1` and `/testnet5/api/v1` on the others. The shapes match mempool.space's, so a client written for it reads them unchanged.

## GET /api/v1/fees/precise

Five levels in sat/vB with three decimals, the node's own resolution. Use this one.

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

| Field         | Mined within                                          |
| ------------- | ----------------------------------------------------- |
| `fastestFee`  | the next block                                        |
| `halfHourFee` | 3 blocks, about half an hour                          |
| `hourFee`     | 6 blocks, about an hour                               |
| `economyFee`  | 144 blocks, about a day                               |
| `minimumFee`  | the lowest rate the node accepts now, never under 0.1 |

A faster level is never lower than a slower one, and none is below `minimumFee`.

## GET /api/v1/fees/recommended

The same five levels, each rounded up to a whole sat/vB with a floor of 1, the shape older wallets read. On this network most transactions pay under 1 sat/vB, so the floor alone can be ten times what is needed. Prefer `/fees/precise`.

```sh
curl https://rbitcoin.space/api/v1/fees/recommended
```

```json
{ "fastestFee": 2, "halfHourFee": 1, "hourFee": 1, "economyFee": 1, "minimumFee": 1 }
```

## GET /api/v1/fees/mempool-blocks

The projected blocks, the next one first; the last holds the rest of the mempool. Empty ones are left out.

```sh
curl https://rbitcoin.space/api/v1/fees/mempool-blocks
```

```json
[
  {
    "blockSize": 1658395,
    "blockVSize": 999185,
    "nTx": 7137,
    "totalFees": 242831,
    "medianFee": 0.122,
    "feeRange": [0.12, 0.121, 0.121, 0.122, 0.131, 0.131, 11.021]
  }
]
```

| Field        | Means                                                                                                                                                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blockSize`  | Bytes                                                                                                                                                                                                                                                                                        |
| `blockVSize` | The sum of its transactions' sigop-adjusted vsizes. Every block but the last is filled up to 3,992,000 weight units, so this can be well over or under 1,000,000: over when sigops count, under when what is left cannot fill a block. The last holds the rest of the mempool, with no bound |
| `nTx`        | Transactions                                                                                                                                                                                                                                                                                 |
| `totalFees`  | Satoshis                                                                                                                                                                                                                                                                                     |
| `medianFee`  | sat/vB                                                                                                                                                                                                                                                                                       |
| `feeRange`   | sat/vB: the lowest, then the 10th, 25th, 50th, 75th and 90th percentiles, then the highest                                                                                                                                                                                                   |

`503` `the mempool engine is off on this server` where the server does not track the mempool.

## Where the answer came from

`X-Fee-Source` says which:

| `X-Fee-Source` | Means                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projected`    | Worked out from the projected blocks on the tip named in `X-Bitcoin-Chain-Tip`                                                                                                   |
| `node`         | The node's own estimate, used while the projection cannot be: in the first minutes after a start, or where the server does not track the mempool. `Age` gives its age in seconds |

## Errors

`503` `not ready yet; retry` with `Retry-After: 1` while there is no answer yet that can be trusted, for example the first request after a quiet spell. Ask again after the second it names. The other errors are in [Limits and errors](/docs/limits).
