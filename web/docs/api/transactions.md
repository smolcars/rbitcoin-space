# Transactions

One transaction by its txid: its fields, raw bytes, confirmation, merkle proofs and what spent its outputs. Also outputs looked up by their place in a block, which needs no address index. These are rbitcoin's Esplora routes. A successful answer is the node's own body. Parameters are checked here first, and an error is this server's own JSON, for example `400` `{"error": "invalid txid"}` for a malformed txid.

Every route here is under the REST base: `/api` on mainnet, `/signet/api`, `/testnet4/api` and `/testnet5/api` on the others. To send a transaction, see [Broadcast](/docs/api/broadcast).

## GET /api/tx/:txid

The whole transaction, with the output each input spends, its fee and its status. It answers for a transaction in the mempool too.

```sh
curl https://rbitcoin.space/api/tx/f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16
```

The answer, with `vin` and the second output left out here:

```json
{
  "fee": 0,
  "locktime": 0,
  "sigops": 8,
  "size": 275,
  "status": {
    "block_hash": "00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee",
    "block_height": 170,
    "block_time": 1231731025,
    "confirmed": true
  },
  "txid": "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16",
  "version": 1,
  "vout": [
    {
      "scriptpubkey": "4104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac",
      "scriptpubkey_asm": "OP_PUSHBYTES_65 04ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84c OP_CHECKSIG",
      "scriptpubkey_type": "p2pk",
      "value": 1000000000
    }
  ],
  "weight": 1100
}
```

| Field                 | Means                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `txid`                | The transaction's id                                                                                                                                           |
| `version`, `locktime` | As in the transaction                                                                                                                                          |
| `size`                | Bytes, witness included                                                                                                                                        |
| `weight`              | Weight units. Virtual size is this divided by 4, rounded up                                                                                                    |
| `sigops`              | Signature operations                                                                                                                                           |
| `fee`                 | Satoshis. 0 for a coinbase                                                                                                                                     |
| `status`              | Where it is confirmed: `confirmed`, `block_height`, `block_hash`, `block_time`. Only `{"confirmed":false}` while in the mempool                                |
| `vin`                 | The inputs: `txid` and `vout` of the output spent, `prevout` (that output), `scriptsig`, `scriptsig_asm`, `witness` when it has one, `is_coinbase`, `sequence` |
| `vout`                | The outputs: `scriptpubkey`, `scriptpubkey_asm`, `scriptpubkey_type`, `scriptpubkey_address` when the script has an address, `value` in satoshis               |

| Parameter | Format                          |
| --------- | ------------------------------- |
| `txid`    | Exactly 64 hex digits, any case |

`404` `not found` when the node knows no such transaction, in a block or in the mempool. This route does not take `?asof=`; ask [`/status`](#get-api-tx-txid-status) for that.

## GET /api/tx/:txid/hex

The raw transaction, as hex text.

```sh
curl https://rbitcoin.space/api/tx/f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16/hex
```

```text
0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000
```

A transaction without witness data is cached as `public, max-age=31536000, immutable`. A segwit one is cached for one second: its txid does not commit to the witness, so the bytes can change while it is unconfirmed or after a reorg.

## GET /api/tx/:txid/raw

The same bytes as binary (`application/octet-stream`), cached the same way as `/hex`.

```sh
curl -o tx.bin https://rbitcoin.space/api/tx/f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16/raw
```

## GET /api/tx/:txid/status

Whether the transaction is confirmed, and where. Takes `?asof=` ([below](#pinning-an-answer-to-a-block)).

```sh
curl https://rbitcoin.space/api/tx/f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16/status
```

```json
{
  "block_hash": "00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee",
  "block_height": 170,
  "block_time": 1231731025,
  "confirmed": true
}
```

An unconfirmed transaction is `{"confirmed":false}`.

## GET /api/tx/:txid/merkle-proof

An Electrum-style proof that the transaction is in its block: the block's height, the sibling hashes from the transaction up to the merkle root, and its position in the block.

```sh
curl https://rbitcoin.space/api/tx/f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16/merkle-proof
```

```json
{
  "block_height": 170,
  "merkle": ["b1fea52486ce0c62bb442b530a3f0132b826c74e473d1f2c220bfa78111c5082"],
  "pos": 1
}
```

## GET /api/tx/:txid/merkleblock-proof

The same proof as a BIP37 merkle block, in hex text: the block header followed by the partial merkle tree.

```sh
curl https://rbitcoin.space/api/tx/f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16/merkleblock-proof
```

```text
0100000055bd840a78798ad0da853f68974f3d183e2bd1db6a842c1feecf222a00000000ff104ccb05421ab93e63f8c3ce5c2c2e9dbb37de2764b3a3175c8166562cac7d51b96a49ffff001d283e9e70020000000282501c1178fa0b222c1f3d474ec726b832013f0a532b44bb620cce8624a5feb1169e1e83e930853391bc6f35f605c6754cfead57cf8387639d3b4096c54f18f40105
```

Both proofs change with a reorg, so they are cached for one second.

## GET /api/tx/:txid/outspend/:vout

Whether one output is spent, and by which input of which transaction. A spend still in the mempool counts. Takes `?asof=`.

```sh
curl https://rbitcoin.space/api/tx/f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16/outspend/0
```

```json
{
  "spent": true,
  "status": {
    "block_hash": "0000000000077430a94a5376bf2af42d4b1aebdecedfa9e4f7e3f0465a84d891",
    "block_height": 92240,
    "block_time": 1289939967,
    "confirmed": true
  },
  "txid": "ea44e97271691990157559d0bdd9959e02790c34db6c006d779e82fa5aee708e",
  "vin": 0
}
```

| Field    | Means                                                            |
| -------- | ---------------------------------------------------------------- |
| `spent`  | Whether it is spent. An unspent output is only `{"spent":false}` |
| `txid`   | The spending transaction                                         |
| `vin`    | Which of its inputs spends the output                            |
| `status` | The spending transaction's status, as `/status` gives it         |

| Parameter | Format                                       |
| --------- | -------------------------------------------- |
| `vout`    | Decimal digits, the output's position from 0 |

An output index the transaction does not have is not an error: it answers `200` `{"spent":false}` too. To know an output exists, read the transaction or [`/tx/:txid/out/:vout`](#get-api-tx-txid-out-vout).

## GET /api/tx/:txid/outspends

The same for every output of the transaction, in output order. Takes `?asof=`.

```sh
curl https://rbitcoin.space/api/tx/f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16/outspends
```

```json
[
  {
    "spent": true,
    "status": {
      "block_hash": "0000000000077430a94a5376bf2af42d4b1aebdecedfa9e4f7e3f0465a84d891",
      "block_height": 92240,
      "block_time": 1289939967,
      "confirmed": true
    },
    "txid": "ea44e97271691990157559d0bdd9959e02790c34db6c006d779e82fa5aee708e",
    "vin": 0
  },
  {
    "spent": true,
    "status": {
      "block_hash": "00000000dc55860c8a29c58d45209318fa9e9dc2c1833a7226d86bc465afc6e5",
      "block_height": 181,
      "block_time": 1231740133,
      "confirmed": true
    },
    "txid": "a16f3ce4dd5deb92d98ef5cf8afeaf0775ebca408f708b2146c4fb42b41e14be",
    "vin": 0
  }
]
```

## GET /api/txs/outspends

`/outspends` for several transactions in one request: one list per txid, in the order asked.

```sh
curl "https://rbitcoin.space/api/txs/outspends?txids=f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16,b1fea52486ce0c62bb442b530a3f0132b826c74e473d1f2c220bfa78111c5082"
```

The second transaction, block 170's coinbase, has one output and it is unspent. The first list is cut here:

```json
[
  [
    {
      "spent": true,
      "status": {
        "block_hash": "0000000000077430a94a5376bf2af42d4b1aebdecedfa9e4f7e3f0465a84d891",
        "block_height": 92240,
        "block_time": 1289939967,
        "confirmed": true
      },
      "txid": "ea44e97271691990157559d0bdd9959e02790c34db6c006d779e82fa5aee708e",
      "vin": 0
    }
  ],
  [{ "spent": false }]
]
```

| Parameter | Format                                                   |
| --------- | -------------------------------------------------------- |
| `txids`   | 1 to 50 txids, comma-separated. `%2C` is read as a comma |

`400` `txids is required` without it, `400` `at most 50 txids` past 50, and `400` `invalid txid` when any one is not a txid. This route can cost the node far more than a single lookup, so it shares the address routes' per-client limit: 30 at once, then 2 a second, and 4 running or waiting at once. Past it, `429`, or `503` `node busy; retry`, with `Retry-After: 1`.

## Outputs by position

rbitcoin adds these to Esplora. They find a confirmed output without an address index, which makes them the cheapest way to check one. A position is a block height, the transaction's index in that block, and the output's index in the transaction: the three parts of a Lightning short channel id.

## GET /api/tx/:txid/out/:vout

One confirmed output, with whether it is spent and the status of the transaction that created it. Takes `?asof=`.

```sh
curl https://rbitcoin.space/api/tx/f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16/out/0
```

```json
{
  "scriptpubkey": "4104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac",
  "scriptpubkey_asm": "OP_PUSHBYTES_65 04ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84c OP_CHECKSIG",
  "scriptpubkey_type": "p2pk",
  "spent": true,
  "status": {
    "block_hash": "00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee",
    "block_height": 170,
    "block_time": 1231731025,
    "confirmed": true
  },
  "value": 1000000000
}
```

When you need one output, this is cheaper than `/outspend` and `/tx` together. An output that does not exist is `404` `not found`, and so is the genesis block's coinbase output, which was never spendable and is not indexed.

## GET /api/block-height/:height/tx/:index

The transaction at a position in a block on the best chain, in the shape of [`/api/tx/:txid`](#get-api-tx-txid). Takes `?asof=`.

```sh
curl https://rbitcoin.space/api/block-height/170/tx/1
```

The answer is transaction `f4184fc5...9e16`, the same as `/api/tx/f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16`.

## GET /api/block-height/:height/tx/:index/out/:vout

One output by its position, in the shape of `/api/tx/:txid/out/:vout`. Takes `?asof=`.

```sh
curl https://rbitcoin.space/api/block-height/170/tx/1/out/0
```

```json
{
  "scriptpubkey": "4104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac",
  "scriptpubkey_asm": "OP_PUSHBYTES_65 04ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84c OP_CHECKSIG",
  "scriptpubkey_type": "p2pk",
  "spent": true,
  "status": {
    "block_hash": "00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee",
    "block_height": 170,
    "block_time": 1231731025,
    "confirmed": true
  },
  "value": 1000000000
}
```

| Parameter | Format                                                         |
| --------- | -------------------------------------------------------------- |
| `height`  | Decimal digits                                                 |
| `index`   | Decimal digits, the transaction's position in the block from 0 |
| `vout`    | Decimal digits, the output's position from 0                   |

`404` `not found` when no output is at that position.

## POST /api/block-heights/txs/outs

Up to 300 outputs by position in one request. The body is a JSON array of `[height, index, vout]` triples. The answer is a list in the same order: each slot is the output, as `/block-height/:height/tx/:index/out/:vout` gives it, or `null` where there is none. Takes `?asof=`. It only reads.

```sh
curl -X POST -H "Content-Type: application/json" -d '[[170,1,0],[170,1,1]]' https://rbitcoin.space/api/block-heights/txs/outs
```

`400` `body must be a JSON array of [height, index, vout]` for any other body, and `422` `at most 300 positions` past 300. The body may be at most 16 KiB. It shares the address routes' per-client limit, as `/txs/outspends` does.

## Pinning an answer to a block

`?asof=<blockhash>` answers as the chain stood at that block, so a client can read several answers against the same view. These routes take it:

- `/tx/:txid/status`, `/tx/:txid/outspend/:vout`, `/tx/:txid/outspends`
- `/tx/:txid/out/:vout`, `/block-height/:height/tx/:index`, `/block-height/:height/tx/:index/out/:vout`, `POST /block-heights/txs/outs`
- The address and scripthash routes but `/txs/mempool` ([Addresses](/docs/api/addresses))

An output spent after the pinned block reads as unspent:

```sh
curl "https://rbitcoin.space/api/tx/f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16/outspend/0?asof=00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee"
```

```json
{ "spent": false }
```

`X-Bitcoin-Chain-Tip` and `X-Bitcoin-Chain-Tip-Height` then name the pinned block, here height 170. A block that is not on the best chain is `404` `not found`. `400` `invalid asof` when it is not a block hash, and `400` `unexpected query parameter` on a route that does not take it, `/tx/:txid` included. If the pinned block leaves the best chain during the request, the answer is `503` `chain tip moved during the request; retry`.

## Errors

| Status | Message                                                  | When                                                                                                                    |
| ------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `400`  | `invalid txid`                                           | Not exactly 64 hex digits                                                                                               |
| `400`  | `invalid vout`, `invalid height`, `invalid index`        | Not decimal digits, or too large                                                                                        |
| `400`  | `unexpected query parameter`, `repeated query parameter` | A query parameter the route does not take, or one given twice                                                           |
| `404`  | `not found`                                              | No such transaction, or no such output on the `/out` routes. `/outspend` answers `{"spent":false}` for a missing output |

The rest, and how to retry, are in [Limits and errors](/docs/limits).
