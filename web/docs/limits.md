# Limits and errors

Every client gets the same allowance, counted by IPv4 address or IPv6 /64. Past it, the server answers at once with an error that says when to try again, so a client never has to guess.

## Rate limits

These are the server's defaults.

| What                                                                                                             | Allowance                                                                      | Past it                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Any `/api` or `/app` request                                                                                     | 20 a second, after a burst of 120; 48 in flight at once                        | `429` with `Retry-After: 1`                                                                           |
| Address and scripthash routes, `/api/txs/outspends`, `POST /api/block-heights/txs/outs`, `POST /api/v1/prevouts` | 30 at once, then 2 a second; 4 running or waiting at once                      | `429`, or `503` `node busy; retry`, with `Retry-After: 1`                                             |
| Broadcast, `POST /api/tx`                                                                                        | 5 at once, then one every 10 seconds                                           | `429` with `Retry-After: 10`                                                                          |
| Following new addresses on the WebSocket                                                                         | 30 tokens at once, then 2 a second; an address no socket follows yet takes two | A `track-address-error` or `track-addresses-error` saying it is going too fast; the socket stays open |
| The whole server                                                                                                 | 256 requests in flight                                                         | `503`                                                                                                 |

A request may take at most 10 seconds; past that it is `504`. A request body may be at most 16 KiB, except a broadcast, which may carry a transaction of up to 400,000 bytes.

Many callers behind one address share its allowance. That includes every user of one hosted chat bot, who all reach the server from the bot provider's addresses.

## Retrying

- On `429` or `503`, wait the seconds in `Retry-After`, then ask again. A web page calling from another site cannot read that header, as browsers hide it across origins: wait one second, or ten after a broadcast.
- On `504`, ask again once. An address with a very long history may be refused for a few minutes; its error says so.
- Poll no faster than a new answer can come. Most answers are cached for one second, and a new block arrives about every ten minutes. For live data, use the WebSocket.

## Error bodies

Every error is JSON with one field, and the message is fixed text:

```json
{ "error": "invalid txid" }
```

| Status | Means                                                    | Example message                        |
| ------ | -------------------------------------------------------- | -------------------------------------- |
| `400`  | A parameter did not parse, or a transaction was rejected | `invalid txid`, `min relay fee`        |
| `403`  | Turned off on this server                                | `broadcast is disabled on this server` |
| `404`  | No such block, transaction or route                      | `not found`                            |
| `405`  | The route exists for other methods; `Allow` lists them   | `method not allowed`                   |
| `413`  | The body is too large                                    | `body too large`                       |
| `422`  | A paging cursor is not in that history                   | `after_txid not found`                 |
| `429`  | Over your allowance                                      | `too many requests`                    |
| `502`  | The node could not be reached                            | `upstream unavailable`                 |
| `503`  | Busy, warming up, or the chain moved during the request  | `node busy; retry`, `server busy`      |
| `504`  | The node took too long                                   | `request timed out`                    |

## Caching

Every answer says how long it may be kept in `Cache-Control`: read it rather than assume. Most successful reads are `public, max-age=1`, and errors are `no-store`. These are kept longer:

| Answers                                                                      | `Cache-Control`                       |
| ---------------------------------------------------------------------------- | ------------------------------------- |
| A block by its hash under `/api`: the block, its header, raw bytes and txids | `public, max-age=31536000, immutable` |
| The hex or raw bytes of a transaction without witness data                   | `public, max-age=31536000, immutable` |
| Some `/api/v1` answers, such as a settled block or a block's audit           | up to a year                          |

And some are not kept at all (`no-store`), such as a broadcast and some address answers.

## From a browser

Every `/api` answer carries `Access-Control-Allow-Origin: *`, and exposes the chain-tip headers and `X-Request-Id`, so a web page on any site can call it, broadcast included. No cookie or credential is ever read. Quote `X-Request-Id` when you report a problem.
