# Transactions

What wallets ask about unconfirmed transactions: was it replaced and by what, what does it really pay given its relatives, when was it first seen, is this address valid, and what does an input spend.

Every route here is under the explorer routes' base: `/api/v1` on mainnet, `/signet/api/v1`, `/testnet4/api/v1` and `/testnet5/api/v1` on the others. The shapes match mempool.space's, so a client written for it reads them unchanged. A transaction itself, its status and its outputs are Esplora routes, in [Transactions](/docs/api/transactions).

All but `validate-address` and `prevouts` answer from the server's own view of the mempool and never wait on the node. Where the server does not track the mempool they answer `503` `the mempool engine is off on this server`.

## GET /api/v1/replacements

The 25 newest replacement trees, newest first. A tree is a replacement and everything it removed, recursively: its root is the newest transaction, and each entry's `replaces` lists what that one pushed out of the mempool. The same list is also served at `/api/v1/replacements/`, with a trailing slash.

```sh
curl https://rbitcoin.space/api/v1/replacements
```

The answer, cut to the first of 25 trees:

```json
[
  {
    "tx": {
      "txid": "76c3cac6a48279004df0b56e46df63003751dfbcb3070fe0cbeb36fb6fbe0b34",
      "fee": 345,
      "vsize": 171.25,
      "value": 3258155,
      "rate": 2.0145985401459856,
      "time": 1795364491,
      "rbf": true,
      "fullRbf": false
    },
    "time": 1795364491,
    "fullRbf": false,
    "replaces": [
      {
        "tx": {
          "txid": "e09fb8a04f20fd476235f1c8b4d154be9554c09362f0b894d30b5dceccd0bcd4",
          "fee": 282,
          "vsize": 140.25,
          "value": 3258218,
          "rate": 2.0106951871657754,
          "time": 1795364461,
          "rbf": true
        },
        "time": 1795364461,
        "interval": 30,
        "fullRbf": false,
        "replaces": []
      }
    ]
  }
]
```

| Field                | Means                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tx.txid`            | The transaction                                                                                                                                                                               |
| `tx.fee`, `tx.value` | Its own fee and its total output value, in sats                                                                                                                                               |
| `tx.vsize`           | Its weight over four, not rounded                                                                                                                                                             |
| `tx.rate`            | Its own fee over `tx.vsize`, in sat/vB. Not adjusted for unconfirmed parents: for that, ask `/api/v1/cpfp/:txid` below                                                                        |
| `tx.time`, `time`    | When the node accepted it, Unix seconds                                                                                                                                                       |
| `tx.rbf`             | It signalled replaceability itself (BIP 125: an input's sequence below `0xfffffffe`). Signalling inherited from a parent is not counted                                                       |
| `tx.fullRbf`         | On an entry that replaced something: whether one of the transactions it replaced directly did not signal. Absent on an entry that replaced nothing                                            |
| `fullRbf`            | Whether this entry, or anything below it, was replaced without signalling                                                                                                                     |
| `interval`           | Seconds from this transaction's arrival to the arrival of the one that replaced it. Absent on the root                                                                                        |
| `replaces`           | What this one replaced, each an entry of the same shape                                                                                                                                       |
| `mined`, `tx.mined`  | On the root only. `true` while the root is in a block on the best chain. `null` when a reorg took its block away and where it is now is not known yet; read it as not mined. Absent otherwise |

A tree also lists the descendants a replacement removed: a child leaves with its parent and is recorded as replaced by the same transaction.

A tree holds at most 100 transactions, the root included. It is filled from the root down, one branch at a time, oldest replacement first; past 100 the rest is left out, and nothing in the answer marks the cut.

The root's `fee`, `vsize`, `value`, `rate` and `rbf` are `null` when the server never held it in its mempool, and `time` is then when the replacement was seen. That happens when the replacement was mined in the block that removed the original. When a miner confirms the transaction the server had seen replaced, the mined one becomes the root, as the transaction that pushed out the other, with `null` figures.

The server keeps the newest 10,000 replacements, so a tree older than that is gone.

## GET /api/v1/fullrbf/replacements

The 25 newest trees in which something was replaced without signalling, in the same shape. Also served with a trailing slash.

```sh
curl https://rbitcoin.space/api/v1/fullrbf/replacements
```

rbitcoin replaces a transaction whether or not it signals, so every replacement on this network is a full-RBF replacement in the policy sense. This list is a filter on signalling: the trees whose root `fullRbf` is `true`.

## GET /api/v1/tx/:txid/rbf

The replacement tree around one transaction.

```sh
curl https://rbitcoin.space/api/v1/tx/76c3cac6a48279004df0b56e46df63003751dfbcb3070fe0cbeb36fb6fbe0b34/rbf
```

```json
{
  "replacements": {
    "tx": {
      "txid": "76c3cac6a48279004df0b56e46df63003751dfbcb3070fe0cbeb36fb6fbe0b34",
      "fee": 345,
      "vsize": 171.25,
      "value": 3258155,
      "rate": 2.0145985401459856,
      "time": 1795364491,
      "rbf": true,
      "fullRbf": false
    },
    "time": 1795364491,
    "fullRbf": false,
    "replaces": [
      {
        "tx": {
          "txid": "e09fb8a04f20fd476235f1c8b4d154be9554c09362f0b894d30b5dceccd0bcd4",
          "fee": 282,
          "vsize": 140.25,
          "value": 3258218,
          "rate": 2.0106951871657754,
          "time": 1795364461,
          "rbf": true
        },
        "time": 1795364461,
        "interval": 30,
        "fullRbf": false,
        "replaces": []
      }
    ]
  },
  "replaces": ["e09fb8a04f20fd476235f1c8b4d154be9554c09362f0b894d30b5dceccd0bcd4"]
}
```

| Field          | Means                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `replacements` | The tree that holds `txid`, from its newest root, in the shape above and cut at 100 transactions. `null` when `txid` is in none |
| `replaces`     | The txids `txid` itself replaced directly, its victims' descendants included. `null` when it replaced nothing                   |

Asked about the replaced transaction instead (`e09fb8a0...`), the answer has the same tree and `"replaces":null`. A transaction never replaced and never replacing is `{"replacements":null,"replaces":null}`.

`400` `invalid txid` when `:txid` is not exactly 64 hex digits.

## GET /api/v1/cpfp/:txid

What an unconfirmed transaction really pays once its relatives in the mempool are counted, and who they are.

```sh
curl https://rbitcoin.space/api/v1/cpfp/e63bd3aa96235798810d3e532191d331bf0bca211bb91fd0b03466c45d05d9f0
```

The answer, with `ancestors` cut to the first of five and `descendants` to the first of three:

```json
{
  "ancestors": [
    {
      "txid": "94e9bdbf18cbf4075afd55b81c970a7db71939ea91214ff12c62f6c0ebbfb4eb",
      "fee": 17,
      "weight": 564
    }
  ],
  "bestDescendant": null,
  "descendants": [
    {
      "txid": "0629391876e4e0e943113d050a85a16659541ee388ed86c2048f4220d085e608",
      "fee": 17,
      "weight": 564
    }
  ],
  "effectiveFeePerVsize": 0.12056737588652482,
  "fee": 17,
  "adjustedVsize": 141
}
```

| Field                  | Means                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ancestors`            | Every mempool transaction it spends from, directly or not, as `{txid, fee, weight}`, in mining order                                              |
| `descendants`          | Every mempool transaction that spends from it, directly or not, the same way                                                                      |
| `bestDescendant`       | The child whose fee lifts it: the descendant mined last in its own chunk. `null` unless that chunk pays more per vbyte than the transaction alone |
| `effectiveFeePerVsize` | The rate it is mined at, in sat/vB: the node's own chunk rate, which is what mining selection uses on rbitcoin                                    |
| `fee`                  | Its own fee, in sats                                                                                                                              |
| `adjustedVsize`        | Its sigop-adjusted vsize, a whole number                                                                                                          |

There is no `sigops` field; treat it as unknown. Ancestors and descendants are those in the transaction's cluster, at most 64 transactions.

A transaction not in the mempool (confirmed, replaced or never seen), or one that arrived in the last second or so, answers `{"ancestors":[]}`. So does this example once it confirms.

`400` `invalid txid` when `:txid` is not exactly 64 hex digits.

## GET /api/v1/transaction-times

When each transaction was first seen, in Unix seconds, in the order asked. Pass up to 100 txids as `txId[]`. Use `-g` so curl leaves the brackets alone, or write them `txId%5B%5D`.

```sh
curl -g 'https://rbitcoin.space/api/v1/transaction-times?txId[]=e63bd3aa96235798810d3e532191d331bf0bca211bb91fd0b03466c45d05d9f0&txId[]=e09fb8a04f20fd476235f1c8b4d154be9554c09362f0b894d30b5dceccd0bcd4&txId[]=4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
```

```json
[1795364517, 1795364461, 0]
```

A time is known for a transaction in the mempool now, and for one the server recorded as replaced or replacing, even after it left. Everything else is `0`: a confirmed transaction (the genesis coinbase above), one that left the mempool for another reason, or one never seen. The time is when the node accepted it, so it reads about a second earlier than mempool.space's, which stamps when it saw the transaction.

A txid may repeat and is answered each time. Other query parameters are ignored.

| Status | Body                | When                                         |
| ------ | ------------------- | -------------------------------------------- |
| `400`  | `invalid txId`      | A `txId[]` that is not exactly 64 hex digits |
| `400`  | `at most 100 txids` | More than 100                                |
| `431`  |                     | The request head is over 16 KiB              |

## GET /api/v1/validate-address/:address

Whether `:address` is a valid address of the network in the URL, and its script. The server parses it itself and never asks the node. Cached for a day.

```sh
curl https://rbitcoin.space/api/v1/validate-address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq
```

```json
{
  "address": "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  "isscript": false,
  "isvalid": true,
  "iswitness": true,
  "scriptPubKey": "0014e8df018c7e326cc253faac7e46cdc51e68542c42",
  "witness_program": "e8df018c7e326cc253faac7e46cdc51e68542c42",
  "witness_version": 0
}
```

| Field                                | Means                                                      |
| ------------------------------------ | ---------------------------------------------------------- |
| `address`                            | The address as the server writes it: bech32 in lower case  |
| `isvalid`                            | Always present                                             |
| `isscript`                           | `true` for P2SH, P2WSH, P2TR and pay-to-anchor             |
| `iswitness`                          | A SegWit or Taproot address                                |
| `scriptPubKey`                       | The output script it pays, in hex                          |
| `witness_version`, `witness_program` | Only for a witness address. Pay-to-anchor names no program |

The fields and their order are those of rbitcoin's `validateaddress`. Anything that is not an address of this network answers `200` `{"isvalid":false}`, a valid address of another network and a string over 128 characters included:

```sh
curl https://rbitcoin.space/api/v1/validate-address/tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx
```

```json
{ "isvalid": false }
```

A path that is not UTF-8 once percent-decoded is `400`.

## POST /api/v1/prevouts

The output each listed outpoint spends, and whether its transaction is confirmed. The body is a JSON array of `{"txid": <64 hex digits>, "vout": <number>}`, with no other fields, at most 100 items and 16 KiB.

```sh
curl -X POST https://rbitcoin.space/api/v1/prevouts \
  -H 'Content-Type: application/json' \
  -d '[{"txid":"0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098","vout":0},{"txid":"2192fb5d563e49685be2eb128c8e1580539c6ef670d7563e37087da56f088391","vout":0},{"txid":"2192fb5d563e49685be2eb128c8e1580539c6ef670d7563e37087da56f088391","vout":9}]'
```

```json
[
  {
    "prevout": {
      "scriptpubkey": "410496b538e853519c726a2c91e61ec11600ae1390813a627c66fb8be7947be63c52da7589379515d4e0a604f8141781e62294721166bf621e73a82cbf2342c858eeac",
      "scriptpubkey_asm": "OP_PUSHBYTES_65 0496b538e853519c726a2c91e61ec11600ae1390813a627c66fb8be7947be63c52da7589379515d4e0a604f8141781e62294721166bf621e73a82cbf2342c858ee OP_CHECKSIG",
      "scriptpubkey_type": "p2pk",
      "value": 5000000000
    },
    "unconfirmed": false
  },
  {
    "prevout": {
      "scriptpubkey": "001460448e31a217dcfbcc638d26321da4ff531d800f",
      "scriptpubkey_address": "bc1qvpzguvdzzlw0hnrr35nry8dylaf3mqq0n76jga",
      "scriptpubkey_asm": "OP_0 OP_PUSHBYTES_20 60448e31a217dcfbcc638d26321da4ff531d800f",
      "scriptpubkey_type": "v0_p2wpkh",
      "value": 161936
    },
    "unconfirmed": false
  },
  null
]
```

One item per outpoint, in order: `{"prevout": <the output>, "unconfirmed": <bool>}`, or `null` when the transaction or the output does not exist (the third: that transaction has two outputs). The output has `scriptpubkey`, `scriptpubkey_address` (only when the output has an address; the block 1 coinbase's pays a bare public key), `scriptpubkey_asm`, `scriptpubkey_type` and `value` in sats, as the Esplora routes write them.

This route reads the node, one or two reads per distinct outpoint, so it counts against the same allowance as the address routes ([Limits and errors](/docs/limits)). The answer is not cached (`no-store`) and carries no chain-tip headers: the reads may straddle a block.

| Status | Body                                            | When                                            |
| ------ | ----------------------------------------------- | ----------------------------------------------- |
| `400`  | `body must be a JSON array of {"txid", "vout"}` | The body is not that shape, or has other fields |
| `400`  | `invalid txid`                                  | A txid that is not exactly 64 hex digits        |
| `400`  | `at most 100 outpoints`                         | More than 100 items                             |
| `413`  | `body too large`                                | Over 16 KiB                                     |
| `502`  | `upstream unavailable`                          | The node failed a read                          |
| `504`  | `request timed out`                             | The node took too long                          |

## Transaction flags

The `flags` number in a mined block's transaction rows, `/api/v1/block/:hash/summary` and `/api/v1/block/:hash/tx/:txid/summary` ([Blocks](/docs/api/v1/blocks)), and in the projected blocks on the [WebSocket](/docs/websocket). It is a bit field with mempool.space's layout: bit N is the value 2 to the power N, so a client can pass it through.

```sh
curl https://rbitcoin.space/api/v1/block/000000000000000000018d6041be5052b4646a3e6490fca8d500e748b8181ce4/tx/2192fb5d563e49685be2eb128c8e1580539c6ef670d7563e37087da56f088391/summary
```

```json
{
  "txid": "2192fb5d563e49685be2eb128c8e1580539c6ef670d7563e37087da56f088391",
  "fee": 21150,
  "vsize": 140.25,
  "value": 637420,
  "rate": 150.0,
  "flags": 1099511631881
}
```

`1099511631881` is bits 0, 3, 12 and 40: it signals RBF, is version 2, has a P2WPKH input or output, and carries a `SIGHASH_ALL` signature.

| Bit     | Meaning                | Set when                                                                      |
| ------- | ---------------------- | ----------------------------------------------------------------------------- |
| 0       | Signals RBF            | An input's sequence is below `0xfffffffe`; the coinbase's counts              |
| 1       | Does not signal RBF    | Not bit 0                                                                     |
| 2, 3, 4 | Version 1, 2, 3        | `version` is 1, 2 or 3; any other sets none                                   |
| 8       | P2PK                   | An output is P2PK, or an input is judged to spend one                         |
| 9       | Bare multisig          | The same, for a bare multisig script                                          |
| 10      | P2PKH                  | The same                                                                      |
| 11      | P2SH                   | The same; a wrapped SegWit spend is P2SH                                      |
| 12      | P2WPKH                 | The same                                                                      |
| 13      | P2WSH                  | The same                                                                      |
| 14      | Taproot                | The same                                                                      |
| 16      | Paid for by a child    | See below                                                                     |
| 17      | Pays for a parent      | See below                                                                     |
| 18      | Replacement            | It replaced a transaction while this server watched the mempool               |
| 24      | `OP_RETURN`            | An output script starts with `OP_RETURN`                                      |
| 25      | Fake public key        | A bare multisig output holds a key that is not a point on the curve           |
| 26      | Inscription            | A Taproot script-path input whose script holds `OP_FALSE OP_IF`, any envelope |
| 33      | Consolidation          | Not the coinbase, and at least five inputs per output                         |
| 34      | Batch payment          | At least five outputs per input                                               |
| 40      | `SIGHASH_ALL`          | A signature's type is ALL                                                     |
| 41      | `SIGHASH_NONE`         | A signature's type is NONE                                                    |
| 42      | `SIGHASH_SINGLE`       | A signature's type is SINGLE                                                  |
| 43      | `SIGHASH_DEFAULT`      | A 64-byte Taproot signature                                                   |
| 44      | `SIGHASH_ANYONECANPAY` | A signature's type has `0x80` set                                             |

Input types are judged from the scriptSig and witness alone, without the previous outputs. A spend that cannot be placed sets no type bit rather than a guess. A pay-to-anchor output sets no type bit, and neither does spending one, as on mempool.space.

Bits 16 and 17 are this server's own rule, with a 10% margin so that tiny differences do not flag most of a block. In a projected block: bit 16 when the transaction is mined in a chunk of two or more whose rate is more than 10% above its own, bit 17 when its own rate is more than 10% above its chunk's; never both. In a mined block: bit 16 when a child in the same block pays a rate more than 10% above its own, bit 17 when its rate is more than 10% above a parent's in the same block, direct relatives only. mempool.space follows its own clusters and flags more transactions, so these two bits differ from its answers.

Bit 18 is this server's own record. A transaction that replaced another before the server started watching, or so long ago that the record dropped it, does not have it.

Bits 5 to 7, 15, 27 and 32 (coinjoin) are never set here.

## Errors

`503` `not ready yet; retry` with `Retry-After: 1` on `transaction-times` and `cpfp` in the first moments after the server starts, before it has read the mempool. Ask again after the second it names. `503` `the mempool engine is off on this server` where the server does not track the mempool. The other errors are in [Limits and errors](/docs/limits).
