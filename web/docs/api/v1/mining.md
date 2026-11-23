# Mining

Who mined each block, each pool's share, the network's hashrate and difficulty over time, and series of block fees, rewards, fee rates and sizes. The server works these out from its own table of blocks and keeps the answers in memory, so a request never waits on the node.

Every route here is under the explorer routes' base: `/api/v1` on mainnet, `/signet/api/v1`, `/testnet4/api/v1` and `/testnet5/api/v1` on the others. The shapes match mempool.space's, so a client written for it reads them unchanged.

## Parameters

- `:interval` is exactly one of `24h`, `3d`, `1w`, `1m` (30 days), `3m`, `6m`, `1y` (365 days), `2y`, `3y` or `all`, counted back from now. Anything else is `400` `invalid interval`.
- `:slug` is a pool's slug from `GET /api/v1/mining/pools`. An unknown one is `404` `not found`.
- Heights, counts and timestamps are decimal digits only; anything else is `400`.

Hashrates are whole hashes a second and pass 2^64 (mainnet's is about 1 x 10^21), so they are written as integers of up to 39 digits. Read them as floating point.

The block series (fees, rewards, fee rates, sizes and weights) average a fixed number of blocks per point, so no answer holds more than about a thousand points:

| Interval       | `24h`, `3d`, `1w` | `1m` | `3m` | `6m` | `1y` | `2y` | `3y` | `all` |
| -------------- | ----------------- | ---- | ---- | ---- | ---- | ---- | ---- | ----- |
| Blocks a point | 1                 | 6    | 18   | 36   | 72   | 144  | 216  | 1,008 |

`avgHeight` is the middle height of a point and `timestamp` the middle of its blocks' times, in Unix seconds. The network hashrate has a point a day up to `1y` and a point a week (Monday 00:00 UTC) beyond. Pool shares are weekly.

## Coverage

The server fills its block history newest first, so a server that has just started may not hold all of it yet. An answer uses only the unbroken run of blocks from the tip down; blocks below a gap are left out, so a chart never shows a hole as a dip. Three headers say how far each answer reaches, and a page on another site can read them:

| Header                                   | Value                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Data-From-Height`, `X-Data-From-Time` | The earliest block the answer includes, and its timestamp in Unix seconds. Absent when it includes none                                  |
| `X-Data-Complete`                        | `true` when the answer covers the whole period asked for (from genesis for `all`, a pool's statistics and its blocks); `false` otherwise |

Every route below carries them except `GET /api/v1/mining/pools`, the fixed list of pools, which sends none. On a pool's blocks (`/mining/pool/:slug/blocks` and `/blocks/:height`) and on `/mining/blocks/timestamp/:timestamp`, they describe the span of block history the server holds, not the rows returned: `X-Data-From-Height` is the lowest block held, which can be below every row in the answer, and `X-Data-Complete` is `true` when that history reaches genesis.

When `X-Data-Complete` is `false`, say "data from ... onward" rather than drawing zeros. Fee rates are kept for about the last year of blocks: a fee-rate point appears only when every block in it has its fee rates, and a period reaching further back is `false`.

## GET /api/v1/mining/pools

Every pool the server can name, `Unknown` (id 0) first.

```sh
curl https://rbitcoin.space/api/v1/mining/pools
```

Cut to the first three of 153:

```json
[
  { "name": "Unknown", "slug": "unknown", "unique_id": 0 },
  { "name": "Bitcoin Affiliate Network", "slug": "bitcoinaffiliatenetwork", "unique_id": 1 },
  { "name": "8baochi", "slug": "8baochi", "unique_id": 2 }
]
```

## GET /api/v1/mining/pools/:interval

Each pool that mined a block in the period, most blocks first, and the network's estimated hashrate.

```sh
curl https://rbitcoin.space/api/v1/mining/pools/1w
```

With `pools` cut to the first two of 15:

```json
{
  "pools": [
    {
      "poolId": 88,
      "name": "Foundry USA",
      "link": "https://foundrydigital.com",
      "blockCount": 266,
      "rank": 1,
      "emptyBlocks": 0,
      "slug": "foundryusa",
      "avgMatchRate": 99.26,
      "avgFeeDelta": null,
      "poolUniqueId": 88
    },
    {
      "poolId": 61,
      "name": "AntPool",
      "link": "https://www.antpool.com",
      "blockCount": 221,
      "rank": 2,
      "emptyBlocks": 0,
      "slug": "antpool",
      "avgMatchRate": 90.23,
      "avgFeeDelta": null,
      "poolUniqueId": 61
    }
  ],
  "blockCount": 1089,
  "lastEstimatedHashrate": 989488815506567593984,
  "lastEstimatedHashrate3d": 1048057632086900473856,
  "lastEstimatedHashrate1w": 1033975033171503480832
}
```

| Field                                                                         | Means                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `poolId`, `poolUniqueId`                                                      | Both the pool's id in the list                                                                                                                   |
| `blockCount`, `rank`, `emptyBlocks`                                           | The pool's blocks in the period, its place, and how many of them held only the coinbase                                                          |
| `avgMatchRate`                                                                | The pool's block health in the period (below); `null` with no audited block                                                                      |
| `avgFeeDelta`                                                                 | Always `null`                                                                                                                                    |
| `blockCount` (top level)                                                      | Every block in the period                                                                                                                        |
| `lastEstimatedHashrate`, `lastEstimatedHashrate3d`, `lastEstimatedHashrate1w` | The network's hashrate over the blocks of the last 24 hours, 3 days and 7 days. `null` until the whole window is held, or when it holds no block |

## GET /api/v1/mining/pool/:slug

One pool: its list entry, its blocks and share over all time, the last day and the last week, its hashrate and its block health.

```sh
curl https://rbitcoin.space/api/v1/mining/pool/foundryusa
```

```json
{
  "pool": {
    "id": 88,
    "name": "Foundry USA",
    "link": "https://foundrydigital.com",
    "addresses": [
      "12KKDt4Mj7N5UAkQMN7LtPZMayenXHa8KL",
      "1FFxkVijzvUPUeHgkFjBk2Qw8j3wQY2cDw",
      "bc1qwzrryqr3ja8w7hnja2spmkgfdcgvqwp5swz4af4ngsjecfz0w0pqud7k38"
    ],
    "regexes": ["/2cDw/", "Foundry USA Pool"],
    "slug": "foundryusa",
    "unique_id": 88
  },
  "blockCount": { "all": 76831, "24h": 24, "1w": 266 },
  "blockShare": {
    "all": 0.07863375752501858,
    "24h": 0.1610738255033557,
    "1w": 0.24426078971533516
  },
  "estimatedHashrate": 159903526884576624640,
  "reportedHashrate": null,
  "avgBlockHealth": 99.2,
  "totalReward": "36915467878274"
}
```

| Field                            | Means                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pool.addresses`, `pool.regexes` | The payout addresses and coinbase tags the list names the pool by. `regexes` are matched as literal text, not as patterns |
| `blockShare`                     | The pool's blocks over every block in that span                                                                           |
| `estimatedHashrate`              | The pool's share of the last 24 hours' blocks times the network's hashrate over them. `null` until the whole day is held  |
| `reportedHashrate`               | Always `null`                                                                                                             |
| `avgBlockHealth`                 | The pool's block health over all the blocks the server holds (below); `null` with no audited block                        |
| `totalReward`                    | Every reward the pool has earned, in sats, as a string                                                                    |

## GET /api/v1/mining/pool/:slug/hashrate

One pool's hashrate and share, a point a week, oldest first.

```sh
curl https://rbitcoin.space/api/v1/mining/pool/foundryusa/hashrate
```

Cut to the first two of 315:

```json
[
  {
    "timestamp": 1604275200,
    "avgHashrate": 368047785606173440,
    "share": 0.003067,
    "poolName": "Foundry USA"
  },
  {
    "timestamp": 1605484800,
    "avgHashrate": 622084569654285312,
    "share": 0.004409,
    "poolName": "Foundry USA"
  }
]
```

`avgHashrate` is the pool's share of the week's blocks times the network's hashrate that week.

## GET /api/v1/mining/pool/:slug/blocks[/:height]

Up to 100 of the pool's blocks strictly below `:height`, newest first. Leave the height off, `GET /api/v1/mining/pool/:slug/blocks`, to start at the tip. To page back, pass the height of the last block you got.

```sh
curl https://rbitcoin.space/api/v1/mining/pool/foundryusa/blocks/977070
```

Cut to the first of 100 blocks:

```json
[
  {
    "id": "000000000000000000004aa2645c95734e2855a5a5e1c9110f6384ba0007bb87",
    "height": 977062,
    "timestamp": 1795355617,
    "difficulty": 134823837323272.66,
    "tx_count": 6749,
    "size": 1641350,
    "weight": 3992684,
    "extras": {
      "totalFees": 843233,
      "medianFee": 0.12,
      "feeRange": [0.101, 0.104, 0.12, 0.12, 0.127, 1.11, 202.643],
      "reward": 313343233,
      "pool": { "id": 88, "name": "Foundry USA", "slug": "foundryusa", "minerNames": null },
      "avgFee": 124,
      "avgFeeRate": 0.845,
      "coinbaseRaw": "03a6e80e05108f9ff2002f466f756e6472792055534120506f6f6c202364726f70676f6c642f3e364fd02ff7170000000000",
      "coinbaseAddress": "bc1qtm7ye0wm085hhv88japwkalmwkt3amec5z9c7a3unv05tfg6y2pstr3xfz",
      "coinbaseAddresses": ["bc1qtm7ye0wm085hhv88japwkalmwkt3amec5z9c7a3unv05tfg6y2pstr3xfz"],
      "coinbaseSignature": "OP_0 OP_PUSHBYTES_32 5efc4cbddb79e97bb0e79742eb77fb75971eef38a08b8f763c9b1f45a51a2283",
      "coinbaseSignatureAscii": "\u0003\u00a6\u00e8\u000e\u0005\u0010\u008f\u009f\u00f2\u0000/Foundry USA Pool #dropgold/>6O\u00d0/\u00f7\u0017\u0000\u0000\u0000\u0000\u0000"
    }
  }
]
```

The `extras` fields mean what they mean on [a block](/docs/api/v1/blocks); `coinbaseSignatureAscii` is written here with JSON escapes. `medianFee` and `feeRange` are `null` for a block whose fee rates the server has not worked out.

Differs from mempool.space: a block here has only the fields shown. The header fields (`version`, `bits`, `nonce`, `merkle_root`, `previousblockhash`, `mediantime`) and the per-transaction totals are absent. Use `GET /api/v1/block/:hash` for a whole block.

## GET /api/v1/mining/hashrate[/:interval]

The network's hashrate and every difficulty adjustment in the period, and the current hashrate and difficulty. Leave the interval off, `GET /api/v1/mining/hashrate`, for `all`.

```sh
curl https://rbitcoin.space/api/v1/mining/hashrate/1m
```

With `hashrates` cut to the first two of 31:

```json
{
  "hashrates": [
    { "timestamp": 1792713600, "avgHashrate": 1064007839061215019008 },
    { "timestamp": 1792800000, "avgHashrate": 1073267805672644411392 }
  ],
  "difficulty": [
    {
      "time": 1793301298,
      "height": 973728,
      "difficulty": 148364561003867.4,
      "adjustment": 1.055392014927774
    },
    {
      "time": 1794632570,
      "height": 975744,
      "difficulty": 134823837323272.66,
      "adjustment": 0.9087334361455646
    }
  ],
  "currentHashrate": 1033975033171503480832,
  "currentDifficulty": 134823837323272.66
}
```

| Field               | Means                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hashrates`         | Oldest first. A daily point is the hashrate over the 7 days up to it; a weekly point, over its week. A point appears only when its whole window is held                                                                  |
| `difficulty`        | Each adjustment in the period, oldest first: its first block's time and height, the new difficulty, and `adjustment`, the new difficulty over the old. `[]` when there was none                                          |
| `currentHashrate`   | The hashrate over the last 1,008 blocks, however long they took. On a network whose blocks slowed down, the ranking's `lastEstimatedHashrate` and `lastEstimatedHashrate1w` say the rate of the last 24 hours and 7 days |
| `currentDifficulty` | The tip's difficulty                                                                                                                                                                                                     |

The hashrate is the work of the blocks over the time they took, the estimate the node's `getnetworkhashps` makes. Its daily points use a 7-day window because a single day's count of blocks varies by about 8% from luck alone.

## GET /api/v1/mining/hashrate/pools[/:interval]

Each pool's hashrate and share, a point a week: every pool with a block that week, most blocks first. Leave the interval off for `all`.

```sh
curl https://rbitcoin.space/api/v1/mining/hashrate/pools/1w
```

Cut to the first three of 15:

```json
[
  {
    "timestamp": 1794787200,
    "avgHashrate": 246802968082870730752,
    "share": 0.236538,
    "poolName": "Foundry USA"
  },
  {
    "timestamp": 1794787200,
    "avgHashrate": 212691988754343886848,
    "share": 0.203846,
    "poolName": "AntPool"
  },
  {
    "timestamp": 1794787200,
    "avgHashrate": 183597329915306311680,
    "share": 0.175962,
    "poolName": "F2Pool"
  }
]
```

## GET /api/v1/mining/difficulty-adjustments[/:interval]

Past difficulty adjustments as `[time, height, difficulty, adjustment]`, newest first. `adjustment` is the new difficulty over the old, five decimals: `0.90873` is a 9.1% drop. Leave the interval off for `all`.

```sh
curl https://rbitcoin.space/api/v1/mining/difficulty-adjustments/3m
```

```json
[
  [1794632570, 975744, 134823837323272.66, 0.90873],
  [1793301298, 973728, 148364561003867.4, 1.05539],
  [1792154251, 971712, 140577680051919.62, 1.05924],
  [1791011796, 969696, 132716002350731.28, 0.99969],
  [1789801745, 967680, 132757073449487.52, 1.04163],
  [1788640367, 965664, 127450789715843.14, 1.01307]
]
```

For where the current period stands, use [`GET /api/v1/difficulty-adjustment`](/docs/api/v1/difficulty).

## GET /api/v1/mining/reward-stats/:count

Totals over the last `:count` blocks, 1 to 52,560. The totals are strings.

```sh
curl https://rbitcoin.space/api/v1/mining/reward-stats/144
```

```json
{
  "startBlock": 976930,
  "endBlock": 977073,
  "totalReward": "45220454454",
  "totalFee": "220454454",
  "totalTx": "685961"
}
```

`totalReward` and `totalFee` are in sats. Asked for more blocks than the server holds, it starts at the earliest it holds; `startBlock` says where.

## GET /api/v1/mining/blocks/fees/:interval

The average fees a block paid, in sats, per point.

```sh
curl https://rbitcoin.space/api/v1/mining/blocks/fees/24h
```

Cut to the first two of 149:

```json
[
  { "avgHeight": 976925, "timestamp": 1795278770, "avgFees": 3816640 },
  { "avgHeight": 976926, "timestamp": 1795279096, "avgFees": 2426748 }
]
```

## GET /api/v1/mining/blocks/rewards/:interval

The average reward a block paid, subsidy and fees, in sats, per point.

```sh
curl https://rbitcoin.space/api/v1/mining/blocks/rewards/24h
```

Cut to the first two of 149:

```json
[
  { "avgHeight": 976925, "timestamp": 1795278770, "avgRewards": 316316640 },
  { "avgHeight": 976926, "timestamp": 1795279096, "avgRewards": 314926748 }
]
```

## GET /api/v1/mining/blocks/fee-rates/:interval

Block fee-rate percentiles per point in sat/vB, rounded to whole numbers: `avgFee_0` is the lowest, then the 10th, 25th, 50th, 75th and 90th percentiles, and `avgFee_100` the highest. Each block's percentiles are weighted by virtual size.

```sh
curl https://rbitcoin.space/api/v1/mining/blocks/fee-rates/24h
```

Cut to the first two of 147:

```json
[
  {
    "avgHeight": 976925,
    "timestamp": 1795278770,
    "avgFee_0": 0,
    "avgFee_10": 1,
    "avgFee_25": 2,
    "avgFee_50": 3,
    "avgFee_75": 4,
    "avgFee_90": 5,
    "avgFee_100": 300
  },
  {
    "avgHeight": 976926,
    "timestamp": 1795279096,
    "avgFee_0": 0,
    "avgFee_10": 0,
    "avgFee_25": 1,
    "avgFee_50": 1,
    "avgFee_75": 2,
    "avgFee_90": 4,
    "avgFee_100": 413
  }
]
```

On this network most transactions pay under 1 sat/vB, which rounds to `0`. Use `/precise`.

## GET /api/v1/mining/blocks/fee-rates/:interval/precise

The same percentiles with three decimals.

```sh
curl https://rbitcoin.space/api/v1/mining/blocks/fee-rates/24h/precise
```

Cut to the first two of 147:

```json
[
  {
    "avgHeight": 976925,
    "timestamp": 1795278770,
    "avgFee_0": 0.0,
    "avgFee_10": 1.418,
    "avgFee_25": 2.0,
    "avgFee_50": 2.941,
    "avgFee_75": 3.653,
    "avgFee_90": 5.208,
    "avgFee_100": 300.0
  },
  {
    "avgHeight": 976926,
    "timestamp": 1795279096,
    "avgFee_0": 0.12,
    "avgFee_10": 0.302,
    "avgFee_25": 1.0,
    "avgFee_50": 1.197,
    "avgFee_75": 2.02,
    "avgFee_90": 4.009,
    "avgFee_100": 413.381
  }
]
```

## GET /api/v1/mining/blocks/sizes-weights/:interval

The average block size in bytes and weight in weight units, per point.

```sh
curl https://rbitcoin.space/api/v1/mining/blocks/sizes-weights/24h
```

With each array cut to the first two of 149:

```json
{
  "sizes": [
    { "avgHeight": 976925, "timestamp": 1795278770, "avgSize": 1640315 },
    { "avgHeight": 976926, "timestamp": 1795279096, "avgSize": 1656337 }
  ],
  "weights": [
    { "avgHeight": 976925, "timestamp": 1795278770, "avgWeight": 3994004 },
    { "avgHeight": 976926, "timestamp": 1795279096, "avgWeight": 3997426 }
  ]
}
```

## GET /api/v1/mining/blocks/timestamp/:timestamp

The newest block stamped at or before a Unix time, in seconds. Its `timestamp` is ISO 8601.

```sh
curl https://rbitcoin.space/api/v1/mining/blocks/timestamp/1795362682
```

```json
{
  "height": 977070,
  "hash": "0000000000000000000169e2a41d88fc4452e4437d006aae584b38bb6bb42e39",
  "timestamp": "2026-11-22T15:51:22.000Z"
}
```

It is the block at or before the time, not the nearest one, as on mempool.space. A time before the server's held history is `404` `no indexed block at or before that time`.

## How a block's miner is named

The pool list is [bitcoin-data/mining-pools](https://github.com/bitcoin-data/mining-pools), with a few pools and tags of the server's own added. A block goes to the first rule that matches:

1. A coinbase tag: the longest listed tag found anywhere in the coinbase script, ignoring case. In a Stratum V2 coinbase (`Sv2/<pool tag>/<miner tag>/`), only the pool tag is searched, so a miner's own words cannot claim a pool's block.
2. A payout to a pool's listed address, the first such output deciding.
3. Otherwise `Unknown`, id 0, counted and ranked like any pool.

The tag comes first because it names who built the block, while a payout only shows who was paid: some pools pay their miners straight from the coinbase.

## Block health

`avgMatchRate` (`/pools/:interval`) and `avgBlockHealth` (`/pool/:slug`) are the mean audit score of the pool's audited blocks, two decimals: in the period, or for `avgBlockHealth` over every block the server holds. Only blocks on the best chain count. The scores, and how they are worked out, are on [Blocks and audits](/docs/api/v1/blocks).

A block is audited only when this server watched it arrive, and that cannot be done later. So the mean covers only the blocks since the server started auditing, less any it missed, which for most pools is a small part of their blocks; the answer cannot say how many. A pool with no audited block in the period is `null`, never `0` or `100`. To weigh the figure, count the audited blocks: `GET /api/v1/mining/blocks/predictions/:interval` lists them by height, and `GET /api/v1/mining/pool/:slug/blocks` lists the pool's heights.

## Freshness

Answers are worked out when a new block arrives, and at least every 10 minutes, so a `24h` answer drops blocks older than a day. Between those, a request is a lookup. Every answer carries `Cache-Control: public, max-age=1` and the chain-tip headers naming the tip it is as of; `Age` appears when the node's tip has moved past it. If the chain moves while an answer is read, the request gets `503` `not ready yet; retry`.

## Differs from mempool.space

| Field or route                                   | Here                                                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `poolId`, `poolUniqueId`, `unique_id`, `pool.id` | All the list's id, so they differ from mempool.space's. Two slugs differ too: `oceanxyz` (theirs `ocean`) and `btccom` (theirs `cloverpool`) |
| `regexes`                                        | The list's tags, matched as literal text                                                                                                     |
| `avgFeeDelta`, `reportedHashrate`, `minerNames`  | Always `null`                                                                                                                                |
| `avgMatchRate`, `avgBlockHealth`                 | This server's own audits, of the blocks it watched arrive                                                                                    |
| `USD` in the fee and reward series               | Absent: the server has no price feed                                                                                                         |
| Block series points                              | A fixed number of blocks a point; mempool.space merges blocks mined close together                                                           |
| `avgFee_*`                                       | Size-weighted percentiles of each transaction's own rate, rounded; use `/precise`                                                            |
| Pool blocks                                      | Only the fields shown above                                                                                                                  |
| Coverage                                         | The `X-Data-*` headers, which mempool.space does not send                                                                                    |

## Errors

- `400` `invalid interval` for an interval not listed above.
- `404` `not found` for an unknown pool slug.
- `404` `no indexed block at or before that time` on `blocks/timestamp`.
- `503` `not ready yet; retry` with `Retry-After: 1` before the first answer, or when the chain moved while it was read. Ask again after the second it names.

A server run without its block table answers `503` on every route here. The other errors are in [Limits and errors](/docs/limits).
