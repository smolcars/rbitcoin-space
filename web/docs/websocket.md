# WebSocket

Live data without polling: new blocks, mempool statistics and fees, the projected blocks, replacements, and one transaction's or a few addresses' activity as it happens. It speaks mempool.space's socket protocol, so a client written for it mostly works unchanged; the differences that matter are at the end.

The socket is `wss://rbitcoin.space/api/v1/ws` on mainnet, and `wss://rbitcoin.space/signet/api/v1/ws`, `wss://rbitcoin.space/testnet4/api/v1/ws` and `wss://rbitcoin.space/testnet5/api/v1/ws` on the others. Each socket speaks for its own network. There is no key and no account, and any website may open it.

## Messages

A client sends text frames, each one JSON object. An object may hold several of the keys below; each is handled. The server answers with text frames, each one JSON object, named below by its key. Most have one key; the answer to `init` and each `stats` message carry several.

| Send                                             | Does                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `{"action":"ping"}`                              | Answered `{"pong":true}`                                                               |
| `{"action":"init"}`                              | Answered with the backend's details and the difficulty adjustment                      |
| `{"action":"want","data":[...]}`                 | Sets which live parts to receive: `blocks`, `stats`, `mempool-blocks`, `live-2h-chart` |
| `{"track-tx":"<txid>"}`                          | Follows one transaction                                                                |
| `{"track-address":"<address>"}`                  | Follows one address                                                                    |
| `{"track-addresses":["<address>", ...]}`         | Follows a set of addresses                                                             |
| `{"track-mempool-block":<n>}`                    | Lists the transactions of projected block `n`, then its changes                        |
| `{"track-rbf":"all"}`, `{"track-rbf":"fullRbf"}` | The newest replacement trees, then each change                                         |
| `{"track-rbf-summary":true}`                     | The newest replacements in short, then each change                                     |

## Example session

A few lines of JavaScript, for a browser, Bun, Deno or Node 22:

```js
const ws = new WebSocket("wss://rbitcoin.space/api/v1/ws");
ws.onopen = () => {
  ws.send(JSON.stringify({ action: "want", data: ["blocks", "stats", "mempool-blocks"] }));
  ws.send(
    JSON.stringify({
      "track-tx": "8696cba8b90ec4386be3c49ce0fa36d45b72d882b67c3b281433a6241f427cef",
    }),
  );
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if ("block" in msg) console.log("new block", msg.block.height);
  if ("fees" in msg) console.log("fees", msg.fees);
  if ("txPosition" in msg) console.log("position", msg.txPosition.position);
  if ("txConfirmed" in msg) console.log("confirmed", msg.txConfirmed);
};
```

Or from a terminal with `websocat`, typing one message a line:

```sh
websocat wss://rbitcoin.space/api/v1/ws
```

```text
{"action":"ping"}
{"pong":true}
```

Read every key of every message: this server sends each part in its own frame, where mempool.space puts several in one.

## Ping

```json
{ "action": "ping" }
```

```json
{ "pong": true }
```

The server also sends a protocol-level ping after 30 seconds of silence, and closes a socket that has been silent for 60. Browsers and most libraries answer those pings on their own. A `ping` message every 30 seconds or so tells a client that a socket died without a close.

## Init

```json
{ "action": "init" }
```

The backend's details, as `GET /api/v1/backend-info` gives them, and the difficulty adjustment, as `GET /api/v1/difficulty-adjustment` gives it ([Difficulty](/docs/api/v1/difficulty)):

```json
{
  "backend": "esplora",
  "backendInfo": {
    "backend": "esplora",
    "coreVersion": null,
    "gitCommit": "1634ce2260d9bfc2baaa375fdd65cad523e89bca",
    "hostname": null,
    "lightning": true,
    "osVersion": null,
    "version": "0.5.0"
  },
  "da": {
    "adjustedTimeAvg": 550385,
    "difficultyChange": 9.065182905928392,
    "estimatedRetargetDate": 1795742187434,
    "expectedBlocks": 1220.0889166665077,
    "nextRetargetHeight": 977760,
    "previousRetarget": -9.126656385443543,
    "previousTime": 1794632570,
    "progressPercent": 65.97222222222221,
    "remainingBlocks": 686,
    "remainingTime": 377564084,
    "timeAvg": 550385,
    "timeOffset": 0
  },
  "loadingIndicators": {}
}
```

`loadingIndicators` is always empty. `da` is left out in the first moments after the server starts. Unlike mempool.space, the answer holds nothing else: the blocks, mempool and fees come with `want`.

## Want

```json
{ "action": "want", "data": ["blocks", "stats", "mempool-blocks", "live-2h-chart"] }
```

Replaces the set of parts this socket receives; other names are ignored, and `"data":[]` stops them all. Each newly wanted part sends its current state at once, then every change. A part already wanted sends nothing again. `live-2h-chart` sends nothing until its next sample.

### blocks

`{"blocks":[...]}` at once: the last 8 blocks, oldest first, each as `GET /api/v1/blocks` lists it ([Blocks](/docs/api/v1/blocks)). Then `{"block":{...}}` for each new block, in the same shape. On a server without a block table (one run without a data directory), both carry the node's Esplora block JSON instead, as [`GET /api/block/:hash`](/docs/api/blocks) serves it, with no `extras` or `stale`. One block, with `extras` cut to four of its fields:

```json
{
  "bits": 386012787,
  "difficulty": 134823837323272.66,
  "extras": {
    "totalFees": 721728,
    "medianFee": 0.122,
    "reward": 313221728,
    "pool": { "id": 22, "minerNames": null, "name": "F2Pool", "slug": "f2pool" }
  },
  "height": 977074,
  "id": "000000000000000000007cd31adb9b10f12d662a5636b2467abd32b53478731b",
  "mediantime": 1795362622,
  "merkle_root": "0f430da59c22011659741b276ae6268c8bc8f02b035faca239ee7d67bba2b37e",
  "nonce": 3686031363,
  "previousblockhash": "000000000000000000018d6041be5052b4646a3e6490fca8d500e748b8181ce4",
  "size": 1684420,
  "stale": false,
  "timestamp": 1795364582,
  "tx_count": 5862,
  "version": 536870912,
  "weight": 3997552
}
```

Where the server has a block table, a `block` is sent once the server has worked out its extras, a few seconds after the block arrives, and never without them. Several new blocks at once come as one `block` each, oldest first. A reorg, or 8 or more new blocks at once, sends one `blocks` with the new list instead. Only best-chain blocks are sent, and none twice. The `extras` lack some of mempool.space's fields (`orphans`, `utxoSetChange`, `avgTxSize`, `totalInputs`, `totalOutputs`, `totalOutputAmt`, `segwitTotalTxs`, `segwitTotalSize`, `segwitTotalWeight`, `coinbaseBip54`, `similarity`).

The coinbase fields in `extras` are text a miner chose. Never put them into a page as HTML.

### stats

One message at once, then one every 2 seconds. The example has `transactions` cut to the first of 10:

```json
{
  "da": {
    "adjustedTimeAvg": 550385,
    "difficultyChange": 9.065182905928392,
    "estimatedRetargetDate": 1795742186979,
    "expectedBlocks": 1220.0881583333016,
    "nextRetargetHeight": 977760,
    "previousRetarget": -9.126656385443543,
    "previousTime": 1794632570,
    "progressPercent": 65.97222222222221,
    "remainingBlocks": 686,
    "remainingTime": 377564084,
    "timeAvg": 550385,
    "timeOffset": 0
  },
  "fees": {
    "economyFee": 0.123,
    "fastestFee": 1.099,
    "halfHourFee": 0.202,
    "hourFee": 0.123,
    "minimumFee": 0.1
  },
  "mempoolInfo": {
    "bytes": 29424391,
    "fullrbf": true,
    "incrementalrelayfee": 1e-6,
    "limitclustercount": 64,
    "limitclustersize": 101000,
    "loaded": true,
    "maxmempool": 75000000,
    "mempoolminfee": 1e-6,
    "minrelaytxfee": 1e-6,
    "size": 63836,
    "total_fee": 0.03431191,
    "unbroadcastcount": 0,
    "usage": 29424391
  },
  "transactions": [
    {
      "fee": 224,
      "rate": 1.8360655737704918,
      "time": 1795364621,
      "txid": "e1ca8f42799ab6487b4c0db0ac29a2470d2285040aac7db8290e8fc3aa63550b",
      "value": 78332,
      "vsize": 122
    }
  ],
  "vBytesPerSecond": 2492
}
```

| Key               | Means                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `da`              | `GET /api/v1/difficulty-adjustment`'s answer                                                                                                                                      |
| `fees`            | `GET /api/v1/fees/precise`'s answer, in sat/vB with decimals ([Fees](/docs/api/v1/fees))                                                                                          |
| `mempoolInfo`     | The node's `getmempoolinfo`, amounts in BTC. rbitcoin's has `fullrbf`, `limitclustercount` and `limitclustersize`, and no `permitbaremultisig`, `maxdatacarriersize` or `optimal` |
| `transactions`    | The 10 newest transactions seen: `fee` in sats, `vsize` the sigop-adjusted whole vsize, `value` in sats, `rate` in sat/vB, `time` in Unix seconds                                 |
| `vBytesPerSecond` | What entered the mempool per second over the last whole minute sampled. It changes once a minute, and is left out until the server has a sample from the last two minutes         |

A key the server has nothing for yet is left out.

### mempool-blocks

`GET /api/v1/fees/mempool-blocks`' answer at once, then each time the projected blocks change. Cut to the first of 8 blocks:

```json
{
  "mempool-blocks": [
    {
      "blockSize": 1611118,
      "blockVSize": 998454,
      "feeRange": [0.121, 0.121, 0.121, 0.121, 0.121, 0.121, 50.709],
      "medianFee": 0.121,
      "nTx": 7565,
      "totalFees": 194650
    }
  ]
}
```

After a `block`, the next `mempool-blocks` is normally the projection on top of that block. A projection on another block than the last `block` sent waits for that block's message about 3 seconds (up to about 5 with the default mempool interval of 2 seconds), then goes out anyway, so a `mempool-blocks` cannot always be paired with the last `block`.

### live-2h-chart

Nothing at once. Then one sample a minute, the same object `GET /api/v1/statistics/2h` lists ([Statistics](/docs/api/v1/statistics)), for example:

```json
{
  "live-2h-chart": {
    "added": 1795364700,
    "count": 64347,
    "vbytes_per_second": 996.217,
    "mempool_byte_weight": 118158208,
    "total_fee": 3647227,
    "min_fee": 0.1,
    "vsizes": [
      29418270, 73012, 24891, 15488, 0, 5859, 0, 0, 2032, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ]
  }
}
```

Read the series over HTTP first, then append these. `added` is a whole minute.

## Following a transaction

```json
{ "track-tx": "8696cba8b90ec4386be3c49ce0fa36d45b72d882b67c3b281433a6241f427cef" }
```

The txid is 64 hex digits in lower case. A new `track-tx` replaces the last, and `{"track-tx":"stop"}` ends it. While it waits in the mempool:

```json
{
  "txPosition": {
    "position": { "block": 0, "vsize": 44116 },
    "txid": "8696cba8b90ec4386be3c49ce0fa36d45b72d882b67c3b281433a6241f427cef"
  }
}
```

`block` is its projected block, 0 for the next, and `vsize` what is mined before it inside that block. It comes at once, then when the position changes; a mere shuffle at most once every 10 seconds. There is nothing while the server has not seen the transaction.

When it is replaced, the replacement's txid:

```json
{ "txReplaced": { "txid": "<replacement txid>" } }
```

When it is mined:

```json
{ "txConfirmed": "<txid>" }
```

A reorg can send either again. For the CPFP details mempool.space adds to `txPosition`, ask `GET /api/v1/cpfp/:txid` ([Transactions](/docs/api/v1/transactions)).

## Following addresses

```json
{ "track-address": "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" }
```

Follows one address of this network, bech32 in either case. A new one replaces the last, and `{"track-address":"stop"}` ends it. Nothing comes at once: read the address's history over HTTP ([Addresses](/docs/api/addresses)). Then, when transactions paying or spending it enter the mempool, `{"address-transactions":[...]}`, and when they confirm, `{"block-transactions":[...]}`. Each transaction is Esplora JSON, as `GET /api/tx/:txid` serves it ([Transactions](/docs/api/transactions)), without mempool.space's added fields (`order`, `vsize`, `adjustedVsize`, `feePerVsize`, `effectiveFeePerVsize`, `firstSeen` and the rest).

```json
{ "track-addresses": ["bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"] }
```

Follows a set, replacing the last set; `[]` stops it. Duplicates count once, but a list of more than 2 entries is refused before duplicates are removed. Each change comes as one message per address:

```json
{"multi-address-transactions":{"<address>":{"mempool":[...],"confirmed":[...],"removed":[]}}}
```

The address is written in lower case for bech32, and `removed` is always empty.

What a client should know:

- A socket follows at most 2 addresses, `track-address` and `track-addresses` together; mempool.space allows 10. Over it, `track-addresses` is answered `{"track-addresses-error":"..."}` and changes nothing, and `track-address` is answered `{"track-address-error":"..."}`.
- Starting to follow addresses is limited per client address, both kinds together: 30 tokens at once, then 2 a second. Following an address no socket follows yet takes two tokens, so fresh addresses go 15 at once, then 1 a second. Over it the error says `too many new addresses from this client; retry in a moment`, and the socket stays open.
- Between two changes at most 50 mempool and 25 confirmed transactions are read, so a burst larger than that is not all sent.
- A transaction that leaves the mempool without confirming is not reported.
- An address whose history is too large for the node to watch gets no messages.

## Projected block transactions

```json
{ "track-mempool-block": 0 }
```

Blocks 0 to 6 are served; 0 is the next block. A new one replaces the last, and a negative number stops it. First the whole list, in mining order:

```json
{"projected-block-transactions":{"index":0,"sequence":1,"blockTransactions":[["<txid>",fee,vsize,value,rate,flags,firstSeen]]}}
```

Then at most one change every 2 seconds, at once on a new block, and none when nothing changed:

```json
{"projected-block-transactions":{"index":0,"sequence":2,"delta":{"added":[["<txid>",fee,vsize,value,rate,flags,firstSeen]],"removed":["<txid>"],"changed":[["<txid>",rate,flags,0]]}}}
```

A later message can also carry the whole list again, `blockTransactions` in place of `delta`, for example when a new block changes most of the projected block. Handle both: on `blockTransactions`, replace the list you hold.

Each transaction is its fee in sats, its sigop-adjusted vsize, its total output value in sats, its effective rate in sat/vB, its [flags](/docs/api/v1/transactions) as a number, and when it was first seen in Unix seconds. `sequence` rises by one with each message for that block; when one does not follow, ask for the block again. A message with `blockTransactions` is the whole block: take its `sequence` as the new start, as asking again replays the last whole block and the deltas after it with their own numbers. The same block asked for again is sent at most once per mempool interval (2 seconds by default); a request sooner is ignored. Block 7 holds the rest of the mempool with no bound and is answered `{"track-mempool-block-error":"projected blocks 0 to 6 are served"}`, as is any number above it.

## Replacements

```json
{ "track-rbf": "all" }
```

`{"rbfLatest":[...]}` at once, then the whole list again each time the record of replacements changes, checked every 2 seconds. It is what `GET /api/v1/replacements` answers at that moment: the 25 newest trees ([Transactions](/docs/api/v1/transactions)). `{"track-rbf":"fullRbf"}` sends `GET /api/v1/fullrbf/replacements`' list instead. One replaces the other, and any other value, such as `"stop"`, stops it.

```json
{ "track-rbf-summary": true }
```

`{"rbfLatestSummary":[...]}` at once and on each change: the 6 newest trees in short. Cut to the first two:

```json
{
  "rbfLatestSummary": [
    {
      "txid": "654605931475870e5feca8825d5295d134b6df8d1c659cca172f1f8074c97e4e",
      "mined": false,
      "fullRbf": true,
      "oldFee": 16,
      "oldVsize": 152.25,
      "newFee": 49,
      "newVsize": 152.25
    },
    {
      "txid": "795dd0d90021284f5257a7f181df2712cd3cc2b06fe92d3265dd0ddd41614ae7",
      "mined": true,
      "fullRbf": true,
      "oldFee": 304,
      "oldVsize": 3009.5,
      "newFee": null,
      "newVsize": null
    }
  ]
}
```

`txid`, `newFee` and `newVsize` are the newest transaction's; `oldFee` and `oldVsize` are summed over what it directly replaced. Any value but `true` stops it.

Where the server does not track the mempool, neither feed sends anything.

## What else a client may get

| A client sends                                                                                                                             | It gets                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Text that is not JSON                                                                                                                      | Close `4000`                                                                                                                            |
| JSON it does not understand: an unknown key or `action`, a value of the wrong type, a txid or address that does not parse for this network | Nothing; the socket stays open                                                                                                          |
| `track-mempool`, `track-mempool-txids`, `track-txs`, `track-scripthashes`, `track-accelerations`                                           | `{"<key>-error":"not served by this server"}`, for example `{"track-mempool-error":"not served by this server"}`; the socket stays open |
| `refresh-blocks` and mempool.space's other keys                                                                                            | Nothing. To get the block list again, send `want` without `blocks`, then with it, or reconnect. The same `want` again sends nothing     |

After a reconnect, send everything again: the server keeps nothing for a socket that closed.

## Limits

| Rule                                              | Limit                                                                                                                        | Past it                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Sockets per client address                        | 4                                                                                                                            | The upgrade is refused with `429`                                                                           |
| Sockets on the server, every network together     | 256                                                                                                                          | The upgrade is refused with `503`                                                                           |
| A message from the client                         | 1,024 bytes, about twenty addresses                                                                                          | Close `1009`                                                                                                |
| Messages from the client                          | 10 a second, with a burst of 10. Every frame counts, pings and pongs included                                                | Close `4002`                                                                                                |
| Subscriptions per socket                          | 8 in all: the parts wanted, the followed transaction, the followed addresses, the projected block, the two replacement feeds | Close `4001` from `want`; `{"<key>-error":"too many subscriptions on this connection"}` from a `track-` key |
| Transactions followed                             | 1; a new `track-tx` replaces the last                                                                                        |                                                                                                             |
| Addresses followed                                | 2, `track-address` and `track-addresses` together. A `track-addresses` list is counted before duplicates are removed         | `track-address-error` or `track-addresses-error`                                                            |
| New addresses followed, per client address        | 30 tokens at once, then 2 a second. An address no socket follows yet takes two: 15 at once, then 1 a second                  | `track-address-error` or `track-addresses-error`                                                            |
| Messages waiting for a client that is not reading | 64                                                                                                                           | Close `4003`                                                                                                |
| Silence                                           | 60 seconds                                                                                                                   | Close `4004`                                                                                                |

Clients are counted by IPv4 address or IPv6 /64. When the server is following as many transactions or addresses as it can for a network, the same error keys say it is full. The `-error` messages leave the socket open, and what the message asked to stop is still stopped.

## Close codes

| Code   | Why                                     | What to do             |
| ------ | --------------------------------------- | ---------------------- |
| `1000` | Answer to the client's close            |                        |
| `1001` | The server is shutting down             | Reconnect with backoff |
| `1002` | Bad framing                             | Fix the client         |
| `1003` | The client sent a binary message        | Fix the client         |
| `1007` | A text message that is not UTF-8        | Fix the client         |
| `1009` | A message over 1,024 bytes              | Fix the client         |
| `4000` | Not a message this socket reads         | Fix the client         |
| `4001` | Too many subscriptions                  | Fix the client         |
| `4002` | Too many messages                       | Fix the client         |
| `4003` | The client was not reading              | Reconnect with backoff |
| `4004` | Idle: nothing received, ping unanswered | Reconnect with backoff |

## Differences from mempool.space

| What                                           | Here                                                                                                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frames                                         | One part per message, never several in one frame. Only `init` and `stats` carry several keys                                                                                                                |
| `init`                                         | Only `loadingIndicators`, `backend`, `backendInfo` and `da`; the rest comes with `want`, and the replacements with `track-rbf-summary`                                                                      |
| `stats`                                        | Every 2 seconds, not every second                                                                                                                                                                           |
| `vBytesPerSecond`                              | The last whole minute's inflow, changing once a minute                                                                                                                                                      |
| `live-2h-chart`                                | Stamped with the whole minute; no extra sample when a block arrives                                                                                                                                         |
| `txPosition`                                   | No `cpfp`, and sent when the position changes rather than in every stats frame                                                                                                                              |
| `txConfirmed`, `rbfLatest`, `rbfLatestSummary` | Each in its own message                                                                                                                                                                                     |
| `track-addresses`                              | 2 addresses per socket, not 10                                                                                                                                                                              |
| Address messages                               | Esplora JSON without mempool.space's added fields; one address per `multi-address-transactions`, `removed` always empty                                                                                     |
| `projected-block-transactions`                 | Block 7 is not served; no empty changes; the CPFP flags follow this server's own rule                                                                                                                       |
| Not served                                     | `refresh-blocks`, `conversions`, `track-txs`, `track-mempool`, `track-mempool-txids`, `track-scripthashes`, `track-accelerations`, `utxoSpent`, `address-removed-transactions`, `rbfTransaction`, `rbfInfo` |

## Errors

An upgrade over a limit is refused before it becomes a socket, with the status in the table above. The upgrade request also passes the ordinary request limits in [Limits and errors](/docs/limits).
