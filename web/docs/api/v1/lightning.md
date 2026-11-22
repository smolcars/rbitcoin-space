# Lightning

The public Lightning network as this server's own gossip peer sees it: network totals, nodes, channels, search and rankings. Nothing here asks the node.

Every route here is under the explorer routes' base: `/api/v1/lightning` on mainnet, `/signet/api/v1/lightning` and `/testnet4/api/v1/lightning` on the others. There is no Lightning on Testnet 5. Where Lightning is off, on Testnet 5 or on a server that does not run it, a valid request answers `503` `lightning is off on this network` (parameters are checked first, so a malformed one is still `400`, and an unknown ranking `404`); `lightning` in [`GET /api/v1/backend-info`](/docs/api/v1/difficulty#get-api-v1-backend-info) says whether it is on. The shapes match mempool.space's, so a client written for it reads them unchanged. The values are this server's, and differ from mempool.space's where this page says.

## What the data covers

- **Only chain-verified channels.** A channel is listed once its funding output is found unspent on chain, six blocks deep, paying the keys it announced. A node is listed while it has such a channel open.
- **History starts when this server's peer started.** Closed channels, closed counts, `first_seen` and the series count only what it saw.
- **Answers lag the graph by up to about 30 seconds.** A close shows on the channel's own routes at once.
- **No location data.** `as_number`, `city_id`, `country_id`, `subdivision_id`, `longitude`, `latitude`, `iso_code`, `as_organization`, `city`, `country` and `subdivision` are always `null`, and `custom_records` is always `{}`.

> Aliases are text that strangers wrote. Any node can announce any name, another node's included, and search returns the impostor too. Identify a node by its public key, show the key beside the alias, and never put an alias into a page as HTML.

Answers are cached for 10 seconds (`Cache-Control: public, max-age=10`), except `/statistics/latest`, which is `Cache-Control: no-cache`.

## GET /api/v1/lightning/statistics/latest

The newest network totals, taken every ten minutes.

```sh
curl https://rbitcoin.space/api/v1/lightning/statistics/latest
```

```json
{
  "latest": {
    "id": 2992274,
    "added": "2026-11-22T16:20:00.000Z",
    "channel_count": 35920,
    "node_count": 13582,
    "total_capacity": 309660778316,
    "tor_nodes": 4541,
    "clearnet_nodes": 1375,
    "unannounced_nodes": 6592,
    "avg_capacity": 8620846,
    "avg_fee_rate": 1036,
    "avg_base_fee_mtokens": 1490,
    "med_capacity": 1000000,
    "med_fee_rate": 125,
    "med_base_fee_mtokens": 500,
    "clearnet_tor_nodes": 1074
  }
}
```

| Field                                                                    | Means                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `id`                                                                     | The snapshot's ten-minute slot                                             |
| `added`                                                                  | When it was taken                                                          |
| `channel_count`, `node_count`                                            | Verified open channels, and the nodes that have one                        |
| `total_capacity`, `avg_capacity`, `med_capacity`                         | Sats                                                                       |
| `tor_nodes`, `clearnet_nodes`, `clearnet_tor_nodes`, `unannounced_nodes` | Nodes by the addresses they announced: Tor only, clearnet only, both, none |
| `avg_fee_rate`, `med_fee_rate`                                           | Routing fee rate, parts per million                                        |
| `avg_base_fee_mtokens`, `med_base_fee_mtokens`                           | Base fee, millisatoshis                                                    |

The averages leave out policies above 1,000,000 ppm or 1,000,000 msat, which refuse to route; the medians count every policy. Every value is a whole number.

`404` `no lightning statistics yet` until there are any: until the graph first syncs or a snapshot is stored.

## GET /api/v1/lightning/statistics/:interval

The network totals over time, newest first. `:interval` is `2h`, `24h`, `1w`, `1m`, `3m`, `6m`, `1y`, `2y`, `3y`, `4y` or `all`.

```sh
curl https://rbitcoin.space/api/v1/lightning/statistics/24h
```

The answer, cut to the first of 144 points:

```json
[
  {
    "added": 1795364400,
    "channel_count": 35920,
    "total_capacity": 309660778316,
    "tor_nodes": 4541,
    "clearnet_nodes": 1375,
    "unannounced_nodes": 6592,
    "clearnet_tor_nodes": 1074
  }
]
```

`added` is the point's start in Unix seconds. A point is the mean of the snapshots in its step, and no step is finer than ten minutes, so `2h` has 12 points and `24h` 144. A step with no snapshot has no point. mempool.space sends a point a day; these follow the interval's step.

`X-Data-From-Time` gives the first second the answer covers and `X-Data-Complete` whether the whole interval is covered. History starts when this server first ran its peer.

## GET /api/v1/lightning/search

Nodes and channels matching `searchText`: public keys by prefix, then aliases by substring, most capacity first, at most 10 nodes. A `searchText` that reads as a channel id also returns that channel, open or closed.

| Parameter    | Format                       |
| ------------ | ---------------------------- |
| `searchText` | Required. 3 to 66 characters |

```sh
curl 'https://rbitcoin.space/api/v1/lightning/search?searchText=acinq'
```

```json
{
  "nodes": [
    {
      "public_key": "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f",
      "alias": "ACINQ",
      "capacity": 24412518399,
      "channels": 1801,
      "status": 1
    }
  ],
  "channels": []
}
```

```sh
curl 'https://rbitcoin.space/api/v1/lightning/search?searchText=811984x2037x0'
```

```json
{
  "nodes": [],
  "channels": [
    { "id": "892785849701564416", "short_id": "811984x2037x0", "capacity": 500000000, "status": 1 }
  ]
}
```

A node's `status` is 1 when one of its channels is active. `searchText` is 3 to 66 characters once percent-decoded and trimmed, with no control characters; otherwise `400` `search text is 3 to 66 characters, without control characters`.

## GET /api/v1/lightning/nodes/rankings

The top 6 nodes by capacity and the top 6 by open channels.

```sh
curl https://rbitcoin.space/api/v1/lightning/nodes/rankings
```

The answer, each list cut to its first node:

```json
{
  "topByCapacity": [
    {
      "publicKey": "033d8656219478701227199cbd6f670335c8d408a92ae88b962c49d4dc0e83e025",
      "alias": "bfx-lnd0",
      "capacity": 29928451515
    }
  ],
  "topByChannels": [
    {
      "publicKey": "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f",
      "alias": "ACINQ",
      "channels": 1801,
      "city": null,
      "country": null,
      "iso_code": null,
      "subdivision": null
    }
  ]
}
```

## GET /api/v1/lightning/nodes/rankings/liquidity

The top 100 nodes by capacity.

```sh
curl https://rbitcoin.space/api/v1/lightning/nodes/rankings/liquidity
```

The answer, cut to the first of 100:

```json
[
  {
    "publicKey": "033d8656219478701227199cbd6f670335c8d408a92ae88b962c49d4dc0e83e025",
    "alias": "bfx-lnd0",
    "capacity": 29928451515,
    "channels": 530,
    "firstSeen": 1574813156,
    "updatedAt": 1795362463,
    "city": null,
    "country": null,
    "iso_code": null,
    "subdivision": null
  }
]
```

`firstSeen` is the funding time of the oldest channel this server holds for the node, open or closed, so it is bounded by this server's history. `updatedAt` is `null` for a node that announced nothing.

## GET /api/v1/lightning/nodes/rankings/connectivity

The top 100 nodes by open channels. The rows are those of `liquidity`, with `channels` before `capacity`.

```sh
curl https://rbitcoin.space/api/v1/lightning/nodes/rankings/connectivity
```

The answer, cut to the first of 100:

```json
[
  {
    "publicKey": "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f",
    "alias": "ACINQ",
    "channels": 1804,
    "capacity": 24414418399,
    "firstSeen": 1551152144,
    "updatedAt": 1795197712,
    "city": null,
    "country": null,
    "iso_code": null,
    "subdivision": null
  }
]
```

## GET /api/v1/lightning/nodes/rankings/age

The 100 oldest nodes, by `firstSeen`, oldest first. The rows are those of `connectivity`.

```sh
curl https://rbitcoin.space/api/v1/lightning/nodes/rankings/age
```

The answer, cut to the first of 100:

```json
[
  {
    "publicKey": "03bd3466efd4a7306b539e2314e69efc6b1eaee29734fcedd78cf81b1dde9fedf8",
    "alias": "03bd3466efd4a7306b53",
    "channels": 3,
    "capacity": 247200,
    "firstSeen": 1515732563,
    "updatedAt": null,
    "city": null,
    "country": null,
    "iso_code": null,
    "subdivision": null
  }
]
```

## GET /api/v1/lightning/nodes/:key

One node. `:key` is its public key, 66 hex digits.

```sh
curl https://rbitcoin.space/api/v1/lightning/nodes/03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f
```

The answer, with `features` cut to its first two of 20:

```json
{
  "public_key": "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f",
  "alias": "ACINQ",
  "first_seen": 1551152144,
  "updated_at": 1795197712,
  "color": "#49daaa",
  "sockets": "3.33.236.230:9735,of7husrflx7sforh3fw6yqlpwstee3wg5imvvmkp4bz6rbjxtg5nljad.onion:9735",
  "as_number": null,
  "city_id": null,
  "country_id": null,
  "subdivision_id": null,
  "longitude": null,
  "latitude": null,
  "iso_code": null,
  "as_organization": null,
  "city": null,
  "country": null,
  "subdivision": null,
  "features": [
    { "bit": 0, "name": "data-loss-protect", "is_required": true, "is_known": true },
    { "bit": 7, "name": "gossip-queries", "is_required": false, "is_known": true }
  ],
  "featuresBits": "a00098a82a8a6981",
  "active_channel_count": 1736,
  "capacity": "24412518399",
  "opened_channel_count": 1801,
  "closed_channel_count": 91,
  "custom_records": {}
}
```

| Field                  | Means                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| `first_seen`           | Funding time of the oldest channel this server holds for it, Unix seconds |
| `updated_at`           | Its last announcement, Unix seconds                                       |
| `sockets`              | The addresses it announced, comma-separated                               |
| `features`             | Its feature bits, named by BOLT 9                                         |
| `featuresBits`         | The same bits in hex                                                      |
| `active_channel_count` | Open channels with a policy enabled in some direction                     |
| `capacity`             | Sats, as a string                                                         |
| `opened_channel_count` | Its open channels                                                         |
| `closed_channel_count` | Closes this server saw                                                    |

A node that announced nothing has `null` for `color` and `updated_at`, `""` for `featuresBits`, and the first 20 hex digits of its key as its `alias`.

## GET /api/v1/lightning/nodes/:key/statistics

One node's capacity and open channels over time, newest first: now, then each UTC midnight back to this server's first statistics snapshot.

```sh
curl https://rbitcoin.space/api/v1/lightning/nodes/03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f/statistics
```

The answer, cut to the first three of 11 points:

```json
[
  { "added": 1795364583, "capacity": 24412518399, "channels": 1801 },
  { "added": 1795305600, "capacity": 24405868399, "channels": 1803 },
  { "added": 1795219200, "capacity": 25118989911, "channels": 1807 }
]
```

## GET /api/v1/lightning/nodes/:key/fees/histogram

How the fee rates on one node's open channels are spread: `incoming` the rates its peers charge into it, `outgoing` the rates it charges.

```sh
curl https://rbitcoin.space/api/v1/lightning/nodes/03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f/fees/histogram
```

The answer, each list cut to its first three buckets:

```json
{
  "incoming": [
    { "bucket": null, "count": 65, "capacity": "144286788" },
    { "bucket": "0.0", "count": 56, "capacity": "874522491" },
    { "bucket": "1.0", "count": 574, "capacity": "6091866504" }
  ],
  "outgoing": [
    { "bucket": null, "count": 65, "capacity": "135186788" },
    { "bucket": "400.0", "count": 1464, "capacity": "6303289880" },
    { "bucket": "600.0", "count": 2, "capacity": "53000000" }
  ]
}
```

`bucket` is a rate in ppm, as a string: exact under 10, then rounded down to tens, hundreds and, from 1,000, thousands. `null` counts channels with no policy in that direction. `count` is channels and `capacity` their sats, as a string.

## GET /api/v1/lightning/channels

One node's channels, 10 at a time.

| Parameter    | Means                                                                          |
| ------------ | ------------------------------------------------------------------------------ |
| `public_key` | The node, 66 hex digits. Required                                              |
| `status`     | `open` (the default), `active` (open channels with `status` 1) or `closed`     |
| `index`      | Offset, 0 to 100,000. `-1` returns the first 1,000 at once, in a shorter shape |

```sh
curl 'https://rbitcoin.space/api/v1/lightning/channels?public_key=03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f&status=open&index=0'
```

The answer, cut to the first of 10:

```json
[
  {
    "status": 1,
    "closing_reason": null,
    "closing_date": null,
    "capacity": 500000000,
    "short_id": "811984x2037x0",
    "id": "892785849701564416",
    "fee_rate": 2499,
    "node": {
      "alias": "bfx-lnd0",
      "public_key": "033d8656219478701227199cbd6f670335c8d408a92ae88b962c49d4dc0e83e025",
      "channels": 530,
      "capacity": "29928451515"
    }
  }
]
```

Open channels come largest first, closed ones newest close first. `node` is the peer at the other end, and `fee_rate` is what the asked node charges on the channel, in ppm; it is `null` on a closed channel. `X-Total-Count` gives the node's total channels of that status, whatever the page. A script on another website cannot read it: the server does not expose it to cross-origin requests. A page past the end is `[]`.

With `index=-1` each item is `{capacity, short_id, id, node: {alias, public_key}}`.

## GET /api/v1/lightning/channels/:id

One channel, open or closed. `:id` is the 64-bit short channel id in decimal (`892785849701564416`) or `<height>x<index>x<output>` (`811984x2037x0`).

```sh
curl https://rbitcoin.space/api/v1/lightning/channels/811984x2037x0
```

```json
{
  "id": "892785849701564416",
  "short_id": "811984x2037x0",
  "capacity": 500000000,
  "transaction_id": "a7f10c2595c8ea0cc85c3183709d10aada60c7b87fe0c405f3f5b8a44150d4f5",
  "transaction_vout": 0,
  "closing_transaction_id": null,
  "closing_fee": null,
  "closing_reason": null,
  "closing_date": null,
  "updated_at": "2026-11-22T07:31:54.000Z",
  "created": "2023-10-13T09:32:44.000Z",
  "status": 1,
  "funding_ratio": null,
  "closed_by": null,
  "node_left": {
    "alias": "bfx-lnd0",
    "public_key": "033d8656219478701227199cbd6f670335c8d408a92ae88b962c49d4dc0e83e025",
    "channels": 530,
    "capacity": 29928451515,
    "base_fee_mtokens": 1000,
    "cltv_delta": 80,
    "fee_rate": 1,
    "is_disabled": 0,
    "max_htlc_mtokens": 20000000000,
    "min_htlc_mtokens": 1000,
    "updated_at": "2026-11-21T18:37:58.000Z",
    "longitude": null,
    "latitude": null
  },
  "node_right": {
    "alias": "ACINQ",
    "public_key": "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f",
    "channels": 1801,
    "capacity": 24412518399,
    "base_fee_mtokens": 1000,
    "cltv_delta": 144,
    "fee_rate": 2499,
    "is_disabled": 0,
    "max_htlc_mtokens": 20000000000,
    "min_htlc_mtokens": 1,
    "updated_at": "2026-11-22T07:31:54.000Z",
    "longitude": null,
    "latitude": null
  }
}
```

| Field                                                   | Means                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `short_id`                                        | The channel id in decimal, as a string, and as `<height>x<index>x<output>`                                                                                                |
| `capacity`                                              | Sats                                                                                                                                                                      |
| `transaction_id`, `transaction_vout`                    | The funding output. `transaction_id` is `null` until the server has read the funding transaction                                                                          |
| `closing_transaction_id`, `closing_fee`, `closing_date` | The close, when there is one. `closing_date` is the closing block's time, an ISO 8601 string here but Unix seconds on `/channels`; `closing_fee` is `null` when not known |
| `closing_reason`                                        | 1 cooperative, 2 force, 3 a breach, `null` for a close that is none of those or for an open channel                                                                       |
| `status`                                                | 1 when some direction has an enabled policy, 0 when none does, 2 closed                                                                                                   |
| `created`                                               | The funding block's time                                                                                                                                                  |
| `updated_at`                                            | The newer of the two policies                                                                                                                                             |
| `funding_ratio`, `closed_by`                            | Always `null`: not known here                                                                                                                                             |
| `node_left`, `node_right`                               | Each end with its own policy: fees (`base_fee_mtokens` in msat, `fee_rate` in ppm), `cltv_delta`, HTLC limits in msat, `is_disabled`                                      |

`node_left` is always the lower public key, the channel's first node in BOLT 7's order; mempool.space's left end is not always that one. A closed channel's policies are `null`, since gossip forgets them. `single_funded` and each end's `funding_balance` and `closing_balance` are left out: they cannot be known from the chain and gossip. Status 0 includes channels whose policies went unrefreshed for two weeks and were dropped.

`404` `channel not found` for a channel this server does not hold.

## GET /api/v1/lightning/channels/txids

The channels that transactions opened or closed. Pass up to 100 txids as `txId[]`. Also served at `/api/v1/lightning/channels/txids/`, with a trailing slash.

| Parameter | Format                                                                 |
| --------- | ---------------------------------------------------------------------- |
| `txId[]`  | A txid; repeat it for each, up to 100. Without any, the answer is `[]` |

```sh
curl -g 'https://rbitcoin.space/api/v1/lightning/channels/txids?txId[]=a7f10c2595c8ea0cc85c3183709d10aada60c7b87fe0c405f3f5b8a44150d4f5'
```

```json
[
  {
    "inputs": {},
    "outputs": {
      "0": {
        "id": "892785849701564416",
        "short_id": "811984x2037x0",
        "capacity": 500000000,
        "transaction_id": "a7f10c2595c8ea0cc85c3183709d10aada60c7b87fe0c405f3f5b8a44150d4f5",
        "transaction_vout": 0,
        "closing_transaction_id": null,
        "closing_fee": null,
        "closing_reason": null,
        "closing_date": null,
        "updated_at": "2026-11-22T07:31:54.000Z",
        "created": "2023-10-13T09:32:44.000Z",
        "status": 1,
        "funding_ratio": null,
        "closed_by": null,
        "node_left": {
          "alias": "bfx-lnd0",
          "public_key": "033d8656219478701227199cbd6f670335c8d408a92ae88b962c49d4dc0e83e025",
          "base_fee_mtokens": 1000,
          "cltv_delta": 80,
          "fee_rate": 1,
          "is_disabled": 0,
          "max_htlc_mtokens": 20000000000,
          "min_htlc_mtokens": 1000,
          "updated_at": "2026-11-21T18:37:58.000Z"
        },
        "node_right": {
          "alias": "ACINQ",
          "public_key": "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f",
          "base_fee_mtokens": 1000,
          "cltv_delta": 144,
          "fee_rate": 2499,
          "is_disabled": 0,
          "max_htlc_mtokens": 20000000000,
          "min_htlc_mtokens": 1,
          "updated_at": "2026-11-22T07:31:54.000Z"
        }
      }
    }
  }
]
```

One `{inputs, outputs}` per txid, in the order asked. `outputs` maps an output index to the channel it funded; `inputs` maps `"0"` to the channel the transaction closed. Each channel is as above without the ends' `channels`, `capacity`, `longitude` and `latitude`. A close that spends more than the funding output is left out of `inputs`. A channel is found by its funding txid only once the server has read that transaction, shortly after the channel is first seen.

## GET /api/v1/lightning/nodes/isp-ranking

The network's capacity split by the addresses its nodes announced.

```sh
curl https://rbitcoin.space/api/v1/lightning/nodes/isp-ranking
```

```json
{
  "clearnetCapacity": 260301045699,
  "torCapacity": 6347413854,
  "unknownCapacity": 43262318763,
  "ispRanking": []
}
```

The three capacities are sats and add up to the whole network. `ispRanking`, capacity per hosting provider, is always `[]`: this server has no provider database.

## GET /api/v1/lightning/channels-geo[/:key]

Where the ends of every channel, or of one node's channels, are on a map. Always an empty list: this server has no location data. `:key`, when given, is a node's public key, 66 hex digits.

```sh
curl https://rbitcoin.space/api/v1/lightning/channels-geo
```

```json
[]
```

mempool.space answers the same for a node with no known place, so a client written for it draws an empty map instead of failing.

## Not served

These mempool.space routes are `404` here: `/nodes/countries`, `/nodes/country/:code`, `/nodes/isp/:asn` and `/nodes/world`, which need location data; `/penalties`; and `/nodes/group/:name`, which is mempool.space's own curation.

## Errors

Parameters are checked before anything is read. Unknown query parameters are ignored, so cache-busting works. A parameter given twice is `400` `query parameter given twice`, except `txId[]` on `/channels/txids`, which takes up to 100 values and answers one slot for each.

| Status | Body                                                                                  | When                                                                                                        |
| ------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `400`  | `invalid public key: 66 hex digits`                                                   | `:key` or `public_key` is not 66 hex digits                                                                 |
| `400`  | `invalid channel id: ...`                                                             | `:id` is not a channel id in either form, or a part is out of range or has a leading zero                   |
| `400`  | `invalid txId`                                                                        | A `txId[]` is not 64 hex digits                                                                             |
| `400`  | `at most 100 txids`                                                                   | More than 100 `txId[]`                                                                                      |
| `400`  | `invalid interval`                                                                    | `:interval` is not one of those listed                                                                      |
| `400`  | `public_key is required`, `status is open, active or closed`, `index is -1 to 100000` | On `/channels`: no `public_key`, or a bad `status` or `index`                                               |
| `404`  | `not found`                                                                           | A `:ranking` that is not `liquidity`, `connectivity` or `age`                                               |
| `404`  | `no lightning statistics yet`                                                         | `/statistics/latest` before there are any                                                                   |
| `404`  | `node not found`                                                                      | A node with no verified open channel here                                                                   |
| `404`  | `channel not found`                                                                   | A channel this server does not hold                                                                         |
| `503`  | `lightning graph is still syncing; retry`                                             | Before the first full view of the graph, a few minutes after the server starts. Comes with `Retry-After: 1` |
| `503`  | `lightning graph is synced but cannot be indexed; retry later`                        | The server cannot answer from the graph for now                                                             |
| `503`  | `lightning is off on this network`                                                    | The server does not run Lightning for this network                                                          |

The other errors are in [Limits and errors](/docs/limits). mempool.space answers some of these in plain text (`Channel not found`); this server always answers with its JSON error body.
