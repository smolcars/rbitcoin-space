# Broadcast

Send a signed transaction to the network through the server's node. It is the only write the API serves. This is rbitcoin's Esplora route. A success is the node's own answer; an error is this server's own JSON, below.

The route is under the REST base: `/api` on mainnet, `/signet/api`, `/testnet4/api` and `/testnet5/api` on the others. Try a transaction on signet or a testnet before mainnet.

## POST /api/tx

The body is the raw transaction as hex, optionally with whitespace around it. On success the answer is its txid as plain text, and the node relays it to its peers.

```sh
curl -X POST --data-binary @tx.hex https://rbitcoin.space/api/tx
```

The answer is the txid, for example:

```text
f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16
```

Here `tx.hex` is a file holding the signed transaction's hex.

| Body            | Format                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| The transaction | Hex of exactly one transaction, at most 800,000 hex digits (400,000 bytes, the most a standard transaction can be) |

- The body must decode as exactly one transaction; anything else is `400` `body must be one raw transaction in hex`, before the node is asked. The node is sent the transaction as the server encodes it, never the body's own bytes.
- A larger body is `413` `body too large`.
- Every answer is `Cache-Control: no-store`.
- Any web page may call it: like every `/api` route it allows any origin, and no cookie or credential is read.
- A `GET` on this path is `405` `method not allowed` with `Allow: POST`.

## Rate limit

Separate from, and stricter than, the limit on reads: a burst of 5 per client, then one every 10 seconds, on each network. Past it, `429` `too many requests` with `Retry-After: 10`. A refused body counts too, so check a transaction before sending it again. [`POST /api/blindbit/v1/forward-tx`](/docs/api/blindbit) shares this allowance.

## Reject reasons

When the node refuses the transaction, the answer is `400` with a fixed reason. rbitcoin's own reason is passed on when it is one of these: `min relay fee`, `mempool min fee`, `mempool full`, `rbf insufficient fee`, `mempool double-spend`, `bad-txns-spends-conflicting-tx`, `txn-same-nonwitness-data-in-mempool`, `adds unconfirmed input`, `too-large-cluster`, `negative fee`, `dust`, `scriptpubkey`, `tx weight`, `libre annex`, `not final`, `non-BIP68-final`, `coinbase`, `coinbase immature`, `inputs-duplicate`, `bad-txns-too-many-sigops`, `bad-txns-vin-empty`, `bad-txns-vout-empty`, `bad-txns-oversize`, `bad-txns-vout-negative`, `bad-txns-vout-toolarge`, `bad-txns-txouttotal-toolarge`, `bad-txns-inputs-duplicate`, `bad-cb-length`, `bad-txns-prevout-null`, `bad-txns-in-belowout`.

Any other refusal is one of four:

| Reason                                        | Means                                                 |
| --------------------------------------------- | ----------------------------------------------------- |
| `transaction already in the mempool or chain` | It was sent before. Nothing to do                     |
| `missing or spent inputs`                     | An input's output does not exist, or is already spent |
| `script verification failed`                  | A signature or script does not check                  |
| `transaction rejected`                        | Any other reason                                      |

## Off switch

A server may turn broadcast off on every network. Then this route, and BlindBit's `forward-tx`, answer `403` `broadcast is disabled on this server`.

## Not served

`POST /api/txs/test` and `POST /api/txs/package` are `404`: broadcast of one transaction is the only write served. So is `GET /api/broadcast`.

## Errors

| Status | Message                                   | When                                                                                     |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `400`  | `body must be one raw transaction in hex` | The body is not one transaction                                                          |
| `400`  | A reason above                            | The node refused it                                                                      |
| `403`  | `broadcast is disabled on this server`    | Broadcast is off here                                                                    |
| `413`  | `body too large`                          | Over 400,000 bytes of transaction                                                        |
| `429`  | `too many requests`                       | Over the broadcast allowance; see `Retry-After`                                          |
| `502`  | `upstream unavailable`                    | The node could not be reached or failed. Ask `/api/tx/:txid/status` before sending again |

The rest, and how to retry, are in [Limits and errors](/docs/limits).
