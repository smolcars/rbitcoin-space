# Blocks and audits

Blocks with the `extras` mempool.space adds: who mined each one, what it paid, its fee rates and how it compared with the block the server expected. Also every transaction of a block in short form, and the audits behind that comparison.

Every route here is under the explorer routes' base: `/api/v1` on mainnet, `/signet/api/v1`, `/testnet4/api/v1` and `/testnet5/api/v1` on the others. The shapes match mempool.space's, so a client written for it reads them unchanged.

## GET /api/v1/blocks[/:start_height]

Up to 15 blocks, from `:start_height` down, newest first. Leave the height off, `GET /api/v1/blocks`, for the newest 15. Each block has the shape of `GET /api/v1/block/:hash` below.

```sh
curl https://rbitcoin.space/api/v1/blocks/976000
```

The answer is an array of 15 blocks, 976000 first and 975986 last. These headers came with it:

```http
cache-control: public, max-age=86400
x-bitcoin-chain-tip: 000000000000000000018d6041be5052b4646a3e6490fca8d500e748b8181ce4
x-bitcoin-chain-tip-height: 977073
x-data-complete: true
x-data-from-height: 975986
x-data-from-time: 1794760368
```

A start height above the chain tip is `[]`.

The server fills its block history newest first, so a server that has just started may not hold older blocks yet. A list never has a hole in it: it stops at the first height the server does not hold, and three headers say how far it reaches.

| Header                                   | Value                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `X-Data-From-Height`, `X-Data-From-Time` | The lowest block in the list, and its timestamp in Unix seconds          |
| `X-Data-Complete`                        | `true` when the list holds all 15 blocks, or every block down to genesis |

`X-Bitcoin-Chain-Tip` names the newest block the answer can include.

A list is settled when every block in it has at least 100 blocks on top, every block has its fee rates, and the list is complete. A settled list is cached with `public, max-age=86400`; anything else with `public, max-age=1`. It is not `immutable`, because a later release with a newer pool list can name a block's miner differently.

## GET /api/v1/block/:hash

One block with its `extras`. The header fields are the node's.

```sh
curl https://rbitcoin.space/api/v1/block/0000000000000000000169e2a41d88fc4452e4437d006aae584b38bb6bb42e39
```

```json
{
  "id": "0000000000000000000169e2a41d88fc4452e4437d006aae584b38bb6bb42e39",
  "height": 977070,
  "version": 973078528,
  "timestamp": 1795362682,
  "bits": 386012787,
  "nonce": 793848050,
  "difficulty": 134823837323272.66,
  "merkle_root": "4048380ff3ced6f6e95a34e534c1563b5a683b89a15625ab13eebe37ef7d4fdb",
  "tx_count": 2565,
  "size": 1357929,
  "weight": 3286950,
  "previousblockhash": "000000000000000000000e0ad899286ba280952b928dbd7ea2f242dcfcb3207f",
  "mediantime": 1795356385,
  "stale": false,
  "extras": {
    "reward": 313512178,
    "coinbaseRaw": "03aee80e162f5669614254432f4d696e656420627920626f74652f2cfabe6d6d0d7a0aaffbabc3f115a1ab224e4a07e41b971c809c5783645fda5e88f54954461000000000000000100566e903cea3cc91b174f016ba74000000000000",
    "medianFee": 1.0,
    "feeRange": [0.151, 1.0, 1.0, 1.0, 1.009, 1.7, 75.246],
    "totalFees": 1012178,
    "avgFee": 394,
    "avgFeeRate": 1.232,
    "feePercentiles": null,
    "virtualSize": 821737.5,
    "coinbaseAddress": "1PuJjnF476W3zXfVYmJfGnouzFDAXakkL4",
    "coinbaseAddresses": ["1PuJjnF476W3zXfVYmJfGnouzFDAXakkL4"],
    "coinbaseSignature": "OP_DUP OP_HASH160 OP_PUSHBYTES_20 fb37342f6275b13936799def06f2eb4c0f201515 OP_EQUALVERIFY OP_CHECKSIG",
    "coinbaseSignatureAscii": "\u0003\u00ae\u00e8\u000e\u0016/ViaBTC/Mined by bote/,\u00fa\u00bemm\rz\n\u00af\u00fb\u00ab\u00c3\u00f1\u0015\u00a1\u00ab\"NJ\u0007\u00e4\u001b\u0097\u001c\u0080\u009cW\u0083d_\u00da^\u0088\u00f5ITF\u0010\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0010\u0005f\u00e9\u0003\u00ce\u00a3\u00cc\u0091\u00b1t\u00f0\u0016\u00bat\u0000\u0000\u0000\u0000\u0000\u0000",
    "header": "0000003a7f20b3fcdc42f2a27ebd8d922b9580a26b2899d80a0e00000000000000000000db4f7def37beee13ab2556a1893b685a3b56c134e5345ae9f6d6cef30f3848407a0f036b73160217f228512f",
    "utxoSetSize": null,
    "totalInputAmt": null,
    "pool": { "id": 110, "name": "ViaBTC", "slug": "viabtc", "minerNames": null },
    "matchRate": 82.76,
    "expectedFees": 1136678,
    "expectedWeight": 3991819,
    "firstSeen": null
  }
}
```

The server sends the characters of `coinbaseSignatureAscii` as UTF-8; the example writes them as JSON escapes so it stays plain ASCII.

`stale` is always `false`: a block that is not on the best chain is a `404`.

| `extras` field                                                | Means                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reward`                                                      | The coinbase's outputs summed, in sats                                                                                                                                                                                                           |
| `totalFees`                                                   | The block's fees, in sats                                                                                                                                                                                                                        |
| `medianFee`, `feeRange`                                       | Fee rates in sat/vB, three decimals, weighted by virtual size. `feeRange` is the lowest, the 10th, 25th, 50th, 75th and 90th percentiles, and the highest; `medianFee` is the 50th. `null` until the block's fee rates are worked out, never `0` |
| `avgFee`, `avgFeeRate`                                        | Fees over the transactions that pay one, in sats; fees over their weight / 4, in sat/vB with three decimals                                                                                                                                      |
| `virtualSize`                                                 | Weight / 4                                                                                                                                                                                                                                       |
| `coinbaseRaw`, `coinbaseSignatureAscii`                       | The coinbase input's script as hex, and as one Latin-1 character per byte. Written by the miner: treat it as untrusted text                                                                                                                      |
| `coinbaseAddresses`, `coinbaseAddress`                        | The addresses the coinbase pays, at most the first 8, and the first of them. `[]` and `null` when it pays none                                                                                                                                   |
| `coinbaseSignature`                                           | The script of the first coinbase output that pays more than zero with a script of at most 128 bytes, as assembly. `null` when none does                                                                                                          |
| `header`                                                      | The 80-byte header as hex                                                                                                                                                                                                                        |
| `pool`                                                        | Who mined it: `{id, name, slug, minerNames}`, `minerNames` always `null`. See [Mining](/docs/api/v1/mining) for how a miner is named                                                                                                             |
| `matchRate`, `expectedFees`, `expectedWeight`                 | The block's audit (below). `null` when the server did not watch the block arrive                                                                                                                                                                 |
| `feePercentiles`, `utxoSetSize`, `totalInputAmt`, `firstSeen` | Always `null`                                                                                                                                                                                                                                    |

Caching is as for the list: `public, max-age=86400` once the block has 100 blocks on top and its fee rates, `public, max-age=1` before.

### Differs from mempool.space

- `orphans`, `utxoSetChange`, `avgTxSize`, `totalInputs`, `totalOutputs`, `totalOutputAmt`, `segwitTotalTxs`, `segwitTotalSize`, `segwitTotalWeight`, `coinbaseBip54` and `similarity` are absent from `extras`, not `null` or `0`. Do not read a missing field as zero.
- `medianFee`, `feeRange` and `avgFeeRate` are computed here, with three decimals. Each transaction is rated on its own, where mempool.space rates packages together, so the low end of `feeRange` can differ.
- Pool ids are those of the [bitcoin-data/mining-pools](https://github.com/bitcoin-data/mining-pools) list, and two slugs differ: `oceanxyz` and `btccom`.
- `matchRate`, `expectedFees` and `expectedWeight` are this server's own audit.

## GET /api/v1/block/:hash/summary

Every transaction in the block, in block order, the coinbase first.

```sh
curl https://rbitcoin.space/api/v1/block/0000000000000000000169e2a41d88fc4452e4437d006aae584b38bb6bb42e39/summary
```

The answer holds all 2,565 rows of the block (391,645 bytes); here it is cut to the first two:

```json
[
  {
    "txid": "4d1df319a33aa4cea0d9549d6c426791ae23af76b65193757b1658c44ca987b8",
    "fee": 0,
    "vsize": 342.0,
    "value": 313512178,
    "rate": 0.0,
    "flags": 16778246
  },
  {
    "txid": "3f120657fa1f27097aaf5af8005e755d565b3fe7fef92c1f20bde6ae79e33639",
    "fee": 8608,
    "vsize": 1051.0,
    "value": 250591267,
    "rate": 8.190294957183635,
    "flags": 1116691502089
  }
]
```

| Field   | Means                                                                                     |
| ------- | ----------------------------------------------------------------------------------------- |
| `txid`  | The transaction id                                                                        |
| `fee`   | Sats. `0` for the coinbase                                                                |
| `vsize` | Weight / 4, not rounded                                                                   |
| `value` | The outputs summed, in sats                                                               |
| `rate`  | The fee over the virtual size rounded up to whole vbytes, in sat/vB. `0` for the coinbase |
| `flags` | A bit field of the transaction's features in mempool.space's layout: bit N is `1 << N`    |

The answer for a full block can pass 1 MB. It is fixed by the block's hash: `Cache-Control: public, max-age=31536000, immutable`.

### Differs from mempool.space

- `rate` is each transaction's own rate. mempool.space gives a transaction mined with its parents or children the rate of the whole package.
- There is no `time` field.
- `flags` are worked out from the block's raw bytes. The child-pays-for-parent bits (16 and 17) follow a plain rule inside the block, a child paying more than 10% above its parent's rate, and mark fewer transactions than mempool.space does. The replacement bit (18) is set only for replacements this server saw in its own mempool.

## GET /api/v1/block/:hash/tx/:txid/summary

One transaction's row from the block's summary.

```sh
curl https://rbitcoin.space/api/v1/block/0000000000000000000169e2a41d88fc4452e4437d006aae584b38bb6bb42e39/tx/3f120657fa1f27097aaf5af8005e755d565b3fe7fef92c1f20bde6ae79e33639/summary
```

```json
{
  "txid": "3f120657fa1f27097aaf5af8005e755d565b3fe7fef92c1f20bde6ae79e33639",
  "fee": 8608,
  "vsize": 1051.0,
  "value": 250591267,
  "rate": 8.190294957183635,
  "flags": 1116691502089
}
```

A txid that is not in the block is `404` `transaction not found in this block`. Cached as the summary, `immutable`.

### Limits on summaries

A summary the server does not hold yet is worked out from the node, so the two summary routes have limits of their own, on top of the general one. Asking for a summary already held, or one being worked out for someone else, costs nothing against them.

| Allowance                                                          | Past it                                         |
| ------------------------------------------------------------------ | ----------------------------------------------- |
| Per client: 10 summaries started at once, then one every 2 seconds | `429` `too many requests` with `Retry-After: 2` |
| Per network, for everyone: 6 summaries running or waiting          | `503` `server busy` with `Retry-After: 1`       |

`503` `node busy` when the node's own queue is full. Ask again a moment later.

## GET /api/v1/blocks/tip/height

The height of the newest block, as plain text. The same answer as `GET /api/blocks/tip/height` ([Blocks](/docs/api/blocks)), sharing its one-second cache.

```sh
curl https://rbitcoin.space/api/v1/blocks/tip/height
```

```text
977073
```

## How audits work

When a block arrives, the server compares it with the block it expected on that block's parent: its own projection of the next block, built from the node's mempool. Each expected or mined transaction falls in one category:

| Category   | Means                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| matched    | Expected and mined                                                                                             |
| missing    | Expected and left out, with no excuse below. The only category that lowers the score                           |
| fresh      | Expected and left out, but the node first saw it less than 60 seconds before the block                         |
| conflicted | Expected and left out, because the block spent one of its inputs, or it was replaced or evicted at that moment |
| displaced  | Expected and left out of a full block, whose room went to unexpected transactions paying at least its rate     |
| added      | Mined, and in the projection but for a later block                                                             |
| unseen     | Mined, and not in the projection at all                                                                        |

`matchRate` is the share of the expected virtual size that was matched or displaced, leaving out fresh and conflicted transactions, in percent, two decimals, rounded down. 100 means nothing was missing. `expectedFees` and `expectedWeight` are the expected block's total fees in sats and its weight.

A block has an audit only if this server watched it arrive with a current projection. Blocks from before the server ran, from a restart or a gap have none, and an audit cannot be made later. The lookups of one block's audit (`/audit/score/:hash`, `/audit-summary`, `/mining/blocks/audit/:hash` and `/tx/:txid/audit`) answer such a block with `404` `audit not available`, which never turns into an audit later. An audit that exists never changes, so those lookups are cached with `public, max-age=31536000, immutable`; a `404` is not cached. The score lists and predictions instead leave unaudited heights out, can be `200` `[]`, and are `public, max-age=1`.

## GET /api/v1/mining/blocks/audit/score/:hash

One block's score.

```sh
curl https://rbitcoin.space/api/v1/mining/blocks/audit/score/0000000000000000000169e2a41d88fc4452e4437d006aae584b38bb6bb42e39
```

```json
{
  "hash": "0000000000000000000169e2a41d88fc4452e4437d006aae584b38bb6bb42e39",
  "matchRate": 82.76,
  "expectedFees": 1136678,
  "expectedWeight": 3991819
}
```

Differs from mempool.space: a block without an audit is `404`, where mempool.space answers `200` with the JSON string `"null"`.

## GET /api/v1/mining/blocks/audit/scores[/:height]

The scores of the 16 heights ending at `:height`, lowest first. Leave the height off, `GET /api/v1/mining/blocks/audit/scores`, for the 16 ending at the newest block. Heights without an audit are left out, so the array can be shorter than 16.

```sh
curl https://rbitcoin.space/api/v1/mining/blocks/audit/scores/977070
```

Cut to the first two of 16:

```json
[
  {
    "hash": "0000000000000000000147474a90199effd8cfd782b956c041f290851f20cf7f",
    "matchRate": 88.47,
    "expectedFees": 1874783,
    "expectedWeight": 3991945
  },
  {
    "hash": "000000000000000000009c4058f8de1b00a60894ada1c765be9aa4ced20434a2",
    "matchRate": 96.71,
    "expectedFees": 723237,
    "expectedWeight": 3991816
  }
]
```

`Cache-Control: public, max-age=1`.

## GET /api/v1/mining/blocks/predictions/:interval

Every audited block stamped within the interval, as `[timestamp, height, matchRate]`, lowest height first. Intervals are those of the [mining routes](/docs/api/v1/mining): `24h`, `3d`, `1w`, `1m`, `3m`, `6m`, `1y`, `2y`, `3y` or `all`.

```sh
curl https://rbitcoin.space/api/v1/mining/blocks/predictions/24h
```

Cut to the first three of 146:

```json
[
  [1795278770, 976925, 99.67],
  [1795279096, 976926, 100.0],
  [1795279641, 976927, 89.68]
]
```

Any other interval is `400` `invalid interval`, where mempool.space answers every audit it has. `Cache-Control: public, max-age=1`.

## GET /api/v1/block/:hash/audit-summary

The whole audit of one block: the score, and the transactions in each category that differs, as txids.

```sh
curl https://rbitcoin.space/api/v1/block/0000000000000000000169e2a41d88fc4452e4437d006aae584b38bb6bb42e39/audit-summary
```

The answer, with `missingTxs` cut from 205 txids to the first and `freshTxs` from 27 to the first:

```json
{
  "height": 977070,
  "id": "0000000000000000000169e2a41d88fc4452e4437d006aae584b38bb6bb42e39",
  "timestamp": 1795362682,
  "unseenTxs": [
    "f7c3bb0a636ceca4a505ea32477f077c87713c2209dfd8345e7239978c0c6fcf",
    "c8bf1bf3c4fbb7335ee0d3d48b8a46cad7b8373394ef3bbdfd2cb202e6099666"
  ],
  "missingTxs": ["40f4df31d14182398b2d7e9effc1f4bf19c5135adc15ace739a227aa059d4824"],
  "addedTxs": [],
  "freshTxs": ["53adf44cb079e094e9615089bf0a8109baccf6c3fc3d9a624405ac32e965fb31"],
  "displacedTxs": [],
  "conflictedTxs": [
    "ed9b7128b0d3fb91240b823a2182b3316aa2d19b1c426acac715098005837a35",
    "4a9af005fa8396ab6662e348934fbb6bca837299629e2522f695108799b724af"
  ],
  "listsComplete": true,
  "matchRate": 82.76,
  "expectedFees": 1136678,
  "expectedWeight": 3991819
}
```

| Field                                                                              | Means                                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `unseenTxs`, `missingTxs`, `addedTxs`, `freshTxs`, `displacedTxs`, `conflictedTxs` | The txids in each category above                      |
| `listsComplete`                                                                    | `false` when the lists were cut at 1,000 transactions |
| `matchRate`, `expectedFees`, `expectedWeight`                                      | As in the score                                       |

### Differs from mempool.space

- `template`, `version` and `templateAlgorithm` are absent: the server keeps the transactions that differ, not the whole expected block.
- `missingTxs` holds only what counts against the miner. The left-out transactions that are excused are in `freshTxs`, `conflictedTxs` and `displacedTxs`.
- `displacedTxs`, `conflictedTxs` and `listsComplete` are this server's additions.
- `prioritizedTxs`, `sigopTxs`, `fullrbfTxs` and `acceleratedTxs` are absent, because the server cannot detect them. An empty list would claim there were none.

## GET /api/v1/mining/blocks/audit/:hash

The same answer as `GET /api/v1/block/:hash/audit-summary`, at the path mempool.space also serves it.

```sh
curl https://rbitcoin.space/api/v1/mining/blocks/audit/0000000000000000000169e2a41d88fc4452e4437d006aae584b38bb6bb42e39
```

## GET /api/v1/block/:hash/tx/:txid/audit

How one transaction fared in a block's audit.

```sh
curl https://rbitcoin.space/api/v1/block/0000000000000000000169e2a41d88fc4452e4437d006aae584b38bb6bb42e39/tx/f7c3bb0a636ceca4a505ea32477f077c87713c2209dfd8345e7239978c0c6fcf/audit
```

```json
{
  "seen": false,
  "expected": false,
  "added": true,
  "prioritized": false,
  "conflict": false,
  "accelerated": false
}
```

| Field                        | `true` when                                   |
| ---------------------------- | --------------------------------------------- |
| `seen`                       | The transaction is not unseen                 |
| `expected`                   | It is not added or unseen                     |
| `added`                      | It is added or unseen: mined and not expected |
| `conflict`                   | It is conflicted                              |
| `prioritized`, `accelerated` | Never: the server cannot detect either        |

`firstSeen`, when present, is when the node first saw the transaction, in Unix seconds; it is left out when not known. A txid in none of the audit's lists reads as matched (`seen` and `expected` `true`), and the route does not check that the transaction is in the block, as on mempool.space.

## Errors

- `404` `not found`: no block has that hash.
- `404` `block not indexed yet`: the server's block history does not reach that block or start height yet.
- `404` `block is not on the best chain`: the block was replaced in a reorg.
- `404` `audit not available`: the block has no audit.
- `503` `not ready yet; retry` with `Retry-After: 1`: the server has not caught up with the newest block yet, or the chain moved while the answer was read. It follows a new block within about a second.
- `400` `invalid interval` on `predictions`.
- `503` `block extras need a block table on this server`: a server run without a block table, on the routes that carry `extras`.
- `503` `block audits need a block table on this server`: the same, on the audit routes.

The other errors are in [Limits and errors](/docs/limits).
