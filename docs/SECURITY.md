# Security

The server sits between the public internet and a Bitcoin node. A client must never be able to make the server, or the node behind it, do something the operator did not intend.

## Trust

| Party | Trust |
|---|---|
| Browsers and API clients | **Untrusted.** Assume every byte is hostile |
| Chain data (scripts, `OP_RETURN` text, coinbase tags) | **Untrusted content.** Valid on chain does not mean safe to render |
| Lightning gossip (aliases, addresses, colors) | **Untrusted content** |
| Price feeds and other third-party APIs | **Untrusted content** |
| The rbitcoin node | Trusted for chain facts; its responses are still parsed defensively |
| Operator configuration | Trusted |

## Rules

### Reaching the node

1. **Clients never choose where the server connects.** Upstream addresses come from configuration only. No request parameter is ever used as a host, port, URL or socket path.
2. **Every parameter is parsed into a strict type before any upstream call:** a txid is 64 hex characters, a height is a `u32`, an address is parsed for the configured network. Raw client strings are never spliced into an upstream path or RPC call.
3. **Routes are an allow-list.** The Esplora pass-through forwards only named routes. There is no generic proxy and no path forwarding.
4. **RPC is called with a fixed set of read-only methods.** Credentials never leave the server and never appear in a response, log line or error.
5. **Broadcast is the only write.** It is size-capped, rate-limited, and can be switched off.

### Bounding work

6. **Every request has a body limit, a timeout and a concurrency limit.** Defaults are small; raise them per route with a reason.
7. **Rate limits are per client address.** Behind a reverse proxy, the client address comes only from a header the operator configured as trusted, and only on connections from addresses the operator named as proxies; from anyone else the header is ignored ([`CONFIG.md`](CONFIG.md#client-addresses)). Naming a header without naming who may send it is refused at startup.
8. **Expensive answers are computed once.** Concurrent identical requests share one upstream call, results are cached, and list endpoints are paged with a hard cap.
9. **WebSocket connections are bounded in every dimension:** total connections, connections per address, inbound message size, messages per second, subscriptions per connection, tracked addresses and transactions per connection, new address follows per client, and send-queue length. A slow client is disconnected.
10. **Client subscriptions never map one-to-one onto node resources.** Tracked scripts are multiplexed onto shared Electrum subscriptions with a global cap and reference counts.
11. **Untrusted inputs cannot drive unbounded node load.** Lightning gossip triggers funding-output lookups; those are batched, rate-limited and deduplicated. Requests whose cost grows with the data behind them (address histories, batches) have a cost limit of their own, globally and per client, that counts a call until the node has really finished it, not until we stop waiting ([`CONFIG.md`](CONFIG.md#address-and-batch-routes)). Following an address on a WebSocket is the same kind of work, so each client has a budget for starting to follow addresses the node is not already asked about, on both sockets together: 30 at once, then 2 a second by default ([`WS.md`](WS.md#following-a-transaction-or-an-address)). What the server learns about histories the node will not finish applies to every path that reads one, the WebSockets included ([`API.md`](API.md#very-large-addresses)). Totals of an address the server does not know to be small, which on a node with a raised cap, or through its socket's uncapped totals route, can be one join of millions of transactions, go one at a time for the whole server, and a large one is never asked of the node twice: the server keeps its totals itself ([`API.md`](API.md#very-large-addresses)).

<!-- Numbered 22, after the last rule, so the rules below keep the numbers the code cites. -->

22. **Clients cannot drive unbounded writes to disk or unbounded logging.** A refusal is counted, not logged one by one; every event a client can cause at will is one per request served or a summary; and the log has a ceiling past which events that may be dropped are dropped and counted ([`LOGGING.md`](LOGGING.md#what-a-client-can-make-us-write)). No client, and no number of clients, makes the server write in proportion to how hard it pushes.

23. **A Lightning peer is a stranger, and so is the gossip it relays.** Nothing a peer sends makes the server ask the node for more than one request at a time, four a second and a quarter of its time; store anything on disk or in SQLite for a channel without a real, unspent, six-deep funding output; hold more memory than a fixed bound (about 40 MB for one peer) beyond what its real channels earn in the graph; cost more than 5,000 signature checks a second on average after a burst of 300,000 (it is then not read, and nothing it sent is dropped); write a log line per message; keep the graph from being shown; or keep from it a channel another connected peer listed (a withheld channel is asked of that peer, each channel of each peer at most once a connection, and withheld batches are counted in the log). Every map and queue keyed by something a peer chose has a bound, and text a peer chose (aliases) is cleaned once and served only as data. The numbers, and the hostile peer that checks them, are in [`LIGHTNING.md`](LIGHTNING.md#hostile-peers).

### Handling data

12. **SQL is always parameterized.** Request handlers get read-only connections.
13. **Responses are serialized, never string-built.** The one exception is a page's head ([`FRONTEND.md`](FRONTEND.md#link-previews)): the server writes it into the shell's HTML from parsed identifiers, numbers and its own words, and HTML-escapes the one piece of text it did not write, a Lightning alias (`crates/server/src/pages.rs`).
14. **The frontend renders chain and gossip data as text.** No `innerHTML`, no building markup from data, no data-derived URLs in `href` or `src` without a scheme allow-list.
15. **A strict Content-Security-Policy is always sent:** `default-src 'self'`, no inline scripts, no third-party origins. Fonts and assets are self-hosted.
16. **Static files are served from one fixed directory** with no path traversal.
17. **Errors tell the client what was wrong with its request and nothing about the server:** no stack traces, upstream URLs, file paths or SQL.

### Process

18. **No panic on untrusted input.** A malformed request, upstream response or gossip message is an error value, never a crash.
19. **No `unsafe`.**
20. **Dependencies are audited in CI** against the advisory database ([`CI.md`](CI.md#dependency-audit)).

### Browsers

21. **The private `/app` API serves only this site's pages.** A WebSocket upgrade on `/app/ws` whose `Origin` is not this site (its host and port equal to the request's `Host`) is refused with `403`, before it takes any slot. Otherwise any website could open sockets from each of its visitors until their per-client cap is reached and lock them out of ours. An upgrade without `Origin` comes from a program, not a browser, and cannot be forced on a third party's visitor, so it is allowed and bounded like any client. The public `/api/v1/ws` accepts any `Origin`; its sockets come from pools of their own, so another site can use up only those, never a slot of `/app/ws` ([`WS.md`](WS.md#why-other-sites-may-open-it)).

## Reviewing a change

Every PR that adds or changes a route, a WebSocket message or a parser answers four questions in its description:

1. What can a client send here, and what is the largest and most malformed version of it?
2. What upstream work can one request cause, and what bounds it?
3. What data in the response did we not produce ourselves, and how is it encoded?
4. Which rule above was the closest call?

## Reporting

Report vulnerabilities privately through GitHub's security advisories on this repository.
