# Difficulty and server info

Where the chain stands in its difficulty period and what the next adjustment is expected to do, and what software answers these routes.

Every route here is under the explorer routes' base: `/api/v1` on mainnet, `/signet/api/v1`, `/testnet4/api/v1` and `/testnet5/api/v1` on the others. The shapes match mempool.space's, so a client written for it reads them unchanged.

## GET /api/v1/difficulty-adjustment

Progress through the current 2016-block period and the expected change at the next adjustment. The period's blocks are read once per new block, and the fields that depend on the time, such as `estimatedRetargetDate` and `expectedBlocks`, are worked out again on each request.

```sh
curl https://rbitcoin.space/api/v1/difficulty-adjustment
```

```json
{
  "progressPercent": 65.92261904761905,
  "difficultyChange": 9.007831858054537,
  "estimatedRetargetDate": 1795742770972,
  "remainingBlocks": 687,
  "remainingTime": 378281637,
  "previousRetarget": -9.126656385443543,
  "previousTime": 1794632570,
  "nextRetargetHeight": 977760,
  "timeAvg": 550628,
  "adjustedTimeAvg": 550628,
  "timeOffset": 0,
  "expectedBlocks": 1219.8655583333968
}
```

| Field                   | Means                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `progressPercent`       | Blocks mined after the period's first block, out of 2016, in percent                                                                                             |
| `difficultyChange`      | The expected change at the next adjustment, in percent, if the rest of the period goes at its average pace so far. Exact once the tip is the period's last block |
| `estimatedRetargetDate` | When the next period's first block is expected, Unix milliseconds: the wall clock now plus `remainingTime`                                                       |
| `remainingBlocks`       | Blocks still to mine, up to and including the next period's first block                                                                                          |
| `remainingTime`         | `remainingBlocks` times `timeAvg`, milliseconds                                                                                                                  |
| `previousRetarget`      | The change at the adjustment that started this period, in percent                                                                                                |
| `previousTime`          | The timestamp of this period's first block, Unix seconds                                                                                                         |
| `nextRetargetHeight`    | The height of the next period's first block                                                                                                                      |
| `timeAvg`               | The average time between this period's blocks so far, from their timestamps, in milliseconds. 600000 while the tip is the period's first block                   |
| `adjustedTimeAvg`       | Always equal to `timeAvg`                                                                                                                                        |
| `timeOffset`            | Always `0`                                                                                                                                                       |
| `expectedBlocks`        | The blocks the period would have by now at one every 10 minutes                                                                                                  |

The projection follows the consensus rule: the adjustment measures the time from the period's first block to its last, clamps it to between a quarter of and four times two weeks, and stops at the network's minimum difficulty. Because it measures block timestamps, the projected next difficulty counts the rest of the period from now, or from the tip's timestamp when that is later. `estimatedRetargetDate` is always counted from the wall clock now.

| Network         | What differs                                                                                                                                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mainnet, signet | Nothing. Signet has its own, lower minimum difficulty                                                                                                                                                                                                                                                                  |
| Testnet4        | BIP94: an adjustment scales the difficulty of the period's first block, because its last is often a minimum-difficulty block. `difficultyChange` and `previousRetarget` describe that real difficulty. Miners often stamp blocks up to two hours ahead, which is why the projection can start from the tip's timestamp |
| Testnet 5       | As mainnet, with no minimum-difficulty blocks. Its minimum difficulty is about 1,048,561, its genesis block's                                                                                                                                                                                                          |

The answer carries the chain-tip headers naming the tip it was worked out on. `Age` gives its age in seconds when the server cannot confirm it is current; the last answer is still served. `Cache-Control: public, max-age=1`.

For past adjustments, use [`GET /api/v1/mining/difficulty-adjustments/:interval`](/docs/api/v1/mining).

### Differs from mempool.space

mempool.space's `timeAvg` divides the time from the period's first block to now by the blocks mined, so it grows between blocks and goes wrong when the tip is stamped ahead of the clock. This one uses the tip's timestamp. `difficultyChange`, `estimatedRetargetDate` and `remainingTime` follow from it: within 0.01 percentage points of mempool.space's on mainnet and signet, but about two points apart on testnet4, where tips run hours ahead. Progress, heights, block counts, `previousTime` and `previousRetarget` agree.

## GET /api/v1/backend-info

What is running behind the API. The answer is fixed while the server runs.

```sh
curl https://rbitcoin.space/api/v1/backend-info
```

```json
{
  "hostname": null,
  "version": "0.5.0",
  "gitCommit": "1634ce2260d9bfc2baaa375fdd65cad523e89bca",
  "lightning": true,
  "backend": "esplora",
  "coreVersion": null,
  "osVersion": null
}
```

| Field         | Means                                                                           |
| ------------- | ------------------------------------------------------------------------------- |
| `hostname`    | Always `null`                                                                   |
| `version`     | The explorer server's version                                                   |
| `gitCommit`   | The 40-digit commit the server was built from; `null` for a build without one   |
| `lightning`   | Whether this network serves the [Lightning routes](/docs/api/v1/lightning)      |
| `backend`     | Always `"esplora"`: transactions and addresses come from the node's Esplora API |
| `coreVersion` | Always `null`                                                                   |
| `osVersion`   | Always `null`                                                                   |

It carries no chain-tip headers, since it is not about a block. `Cache-Control: public, max-age=1`.

Differs from mempool.space: `hostname`, `coreVersion` and `osVersion` are `null`, where mempool.space names its host, node and operating system. Its `gitCommit` has 9 digits; this one has 40.

## Errors

`503` `not ready yet; retry` with `Retry-After: 1` on `difficulty-adjustment` before the server has its first answer, in the first moments after a start. Ask again after the second it names. The other errors are in [Limits and errors](/docs/limits).
