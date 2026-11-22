# Mempool statistics

The mempool through time: how many transactions waited, how fast virtual size arrived, the minimum fee, and how much waited at each fee rate. The server samples its mempool once a minute and keeps the samples, rolled into hours after 8 days and into days after 400.

Every route here is under the explorer routes' base: `/api/v1` on mainnet, `/signet/api/v1`, `/testnet4/api/v1` and `/testnet5/api/v1` on the others. The shapes match mempool.space's, so a client written for it reads them unchanged.

## GET /api/v1/statistics/:interval

The samples over the interval, newest first. `:interval` is exactly one of `2h`, `24h`, `1w`, `1m` (30 days), `3m`, `6m`, `1y` (365 days), `2y`, `3y`, `4y` or `all`.

```sh
curl https://rbitcoin.space/api/v1/statistics/2h
```

Cut to the first, newest, of 117 points:

```json
[
  {
    "added": 1795364520,
    "count": 68346,
    "vbytes_per_second": 3192.4,
    "mempool_byte_weight": 120692120,
    "total_fee": 3907964,
    "min_fee": 0.1,
    "vsizes": [
      29960790, 128812, 43363, 28224, 0, 7333, 0, 0, 4508, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ]
  }
]
```

| Field                 | Means                                                               |
| --------------------- | ------------------------------------------------------------------- |
| `added`               | The start of the point, Unix seconds                                |
| `count`               | Transactions in the mempool                                         |
| `vbytes_per_second`   | Virtual size arriving per second, averaged over each minute         |
| `mempool_byte_weight` | Four times the mempool's virtual size. `2h` and `24h` only          |
| `total_fee`           | Fees waiting in the mempool, in sats. `2h` and `24h` only           |
| `min_fee`             | The node's minimum fee to enter the mempool, in sat/vB              |
| `vsizes`              | 39 numbers: the virtual size waiting in each fee-rate range (below) |

A point is the mean of the minutes sampled in it. Whole numbers are written as integers and means to three decimals.

Each interval has a fixed step, so no answer holds more than 1,460 points:

| Interval | A point                                                      | Points |
| -------- | ------------------------------------------------------------ | ------ |
| `2h`     | 1 minute                                                     | 120    |
| `24h`    | 1 minute                                                     | 1,440  |
| `1w`     | 10 minutes                                                   | 1,008  |
| `1m`     | 1 hour                                                       | 720    |
| `3m`     | 2 hours                                                      | 1,080  |
| `6m`     | 4 hours                                                      | 1,080  |
| `1y`     | 8 hours                                                      | 1,095  |
| `2y`     | 1 day                                                        | 730    |
| `3y`     | 1 day                                                        | 1,095  |
| `4y`     | 2 days                                                       | 730    |
| `all`    | Whole days, at most about 1,000 points from the first sample |        |

Points are aligned to multiples of the step in UTC, and the newest point is the step in progress. A step with no sample has no point, so an answer can hold fewer points than the table says.

## The fee ranges

`vsizes` follows mempool.space's 39 ranges in whole sat/vB: `[0, 1)`, `[1, 2)`, `[2, 3)`, `[3, 4)`, `[4, 5)`, `[5, 6)`, `[6, 8)`, `[8, 10)`, `[10, 12)`, and wider from there. The server counts the mempool in its own finer bands and puts each band whole into the range that holds its lower edge:

| The server's bands (sat/vB) | Range in `vsizes`   |
| --------------------------- | ------------------- |
| under 1                     | `[0, 1)`, index 0   |
| 1 to 2                      | `[1, 2)`, index 1   |
| 2 to 3                      | `[2, 3)`, index 2   |
| 3 to 5                      | `[3, 4)`, index 3   |
| 5 to 10                     | `[5, 6)`, index 5   |
| 10 and up                   | `[10, 12)`, index 8 |

Every other range reads `0`. So the virtual size at or above 1, 2, 3, 5 and 10 sat/vB is exact and the ranges sum to the whole mempool, but what pays 3 to 5, 5 to 10 or over 10 sat/vB shows in the lowest range of its band. A point that averages several samples rounds each range on its own, so its ranges can sum to a few vbytes more or less than the mean mempool size. A rate counts as it prints at two decimals, so 0.996 sat/vB is in `[1, 2)`, and a transaction counts at the rate of the package it would be mined in.

## Coverage

History begins when the server first sampled, and has holes wherever it did not sample. Two headers say how far an answer reaches, and a page on another site can read them:

| Header             | Value                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `X-Data-From-Time` | The time of the earliest point in the answer, Unix seconds. Absent when it has none                                                                                |
| `X-Data-Complete`  | `true` when every minute of the period, from its start to the last whole minute, was sampled; `false` otherwise. For `all`, the period starts at the oldest sample |

A sample belongs to a minute, not a block, so `X-Data-From-Height` and the chain-tip headers are not sent.

A new sample is written each minute, and an answer is worked out on the first request after it; until then a request is a lookup. `Cache-Control: public, max-age=1`. To follow the newest sample as it comes, subscribe to `live-2h-chart` on the [WebSocket](/docs/websocket): each push is one `statistics/2h` point.

## Differs from mempool.space

- `vsizes` comes from coarser bands above 1 sat/vB, as described above. Under 1 sat/vB, where most of this network's mempool waits, there is one range.
- History starts when this server first sampled. Use the coverage headers rather than reading a short history as an empty mempool.
- `added` is the start of the point's step. mempool.space stamps the second it sampled.
- mempool.space was seen answering `2h`, `24h`, `1w`, `1m`, `1y`, `3y` and `all`; this server also answers `3m`, `6m`, `2y` and `4y`.

## Errors

`400` `invalid interval` for an interval not listed above. A server run without a data directory answers `503` `mempool history needs a data directory on this server`. The other errors are in [Limits and errors](/docs/limits).
