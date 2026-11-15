# Lightning

The Lightning explorer shows the public channel graph: nodes, channels, capacity and their history. It does this with a **gossip-only peer** built from LDK's `lightning` crates, running inside the server.

## What it is not

It is not a Lightning node in the usual sense. It never opens a channel, holds no funds and has no wallet. Its only key is a node identity with nothing behind it.

We do not run LND or Core Lightning (a second daemon with a wallet and channel database, polled for graph dumps), and we do not use `ldk-node` (it bundles an on-chain wallet and channel manager we would never use).

## How it works

1. **Connect.** The peer connects out to a small set of well-connected public Lightning nodes. Channel requests from peers are refused.
2. **Sync.** Peers send the full graph, then live updates. LDK verifies every signature and maintains the network graph.
3. **Validate.** For each announced channel, LDK asks whether the funding output exists, is unspent, is six blocks deep and pays the announced script. We answer from rbitcoin's position routes ([`RBITCOIN.md`](RBITCOIN.md)), which also give the capacity. A channel enters the graph only once it passes ([Validation](#validation)).
4. **Track opens and closes.** Every new block's inputs are checked against the set of verified channels' funding outputs. A match is a channel close: the channel leaves the graph, and the spending transaction's shape classifies it: cooperative, force or (later) penalty. Opens and closes are kept as a history ([Opens and closes](#opens-and-closes)).
5. **Store.** Every open and close, and the network's totals every ten minutes, go to the network's SQLite file ([In the server](#in-the-server)). Nodes and open channels are served from the live graph, which LDK's own serialized file brings back quickly after a restart ([Files](#files)).

Steps 1 to 4 and the graph file are the `ln` crate (`crates/ln`). It is a library and does not log; the server runs it, stores what it reports and logs its events ([In the server](#in-the-server)).

## Pieces of LDK used

| Piece | Role |
|---|---|
| `PeerManager::new_routing_only` | The wire protocol, outbound only. Its sockets are driven by our own small driver (`crates/ln/src/socket.rs`), which reads each peer at its [signature-check budget](#bounds) |
| `ErroringMessageHandler` | The channel handler: answers every channel message, `open_channel` included, with an error. There is no channel manager |
| `P2PGossipSync` and `NetworkGraph` | Signature checks and the graph, behind our own routing handler (below) |
| `UtxoLookup` and `UtxoFuture` | The hook for funding-output validation: ours answers from its cache at once, or later through a batched lookup ([Validation](#validation)) |
| `KeysManager` | Derives the node identity from the seed file; nothing else is signed |

`lightning` 0.2.8 (the newest release; 0.3 is a release candidate). `lightning-net-tokio` 0.2.0, LDK's own socket driver, serves only the hostile peer in the tests: it reads every peer as fast as it sends, with no way to hold one back.

Our routing handler wraps `P2PGossipSync`. It passes gossip through to LDK and counts it, enforces the [bounds](#bounds), never relays (it tells the peer manager not to forward, and drops LDK's broadcast requests), never serves the graph (no initial dump to peers; a `query_channel_range` gets an empty reply, as the spec requires), adds the channel-range sync below, and answers LDK's `processing_queue_high` from our own lookup queue ([Validation](#validation)).

## The gossip peer

### Sync

LDK asks each peer for gossip with a `gossip_timestamp_filter` set two weeks back, which Core Lightning and most LND nodes answer with their whole graph. On mainnet the default peers did not: eclair (ACINQ) and the Bitfinex LND nodes sent only new gossip. So the peer also asks every peer that supports gossip queries for every channel id it knows (`query_channel_range`), and requests the channels it lacks (`query_short_channel_ids`), 2,000 ids per batch, one batch at a time per peer and never the same channel from two peers at once. A peer's channel list is complete when a reply reaches the end of the queried range (the `sync_complete` flag is not an end marker), or when its replies stop for a minute. A batch ends at its end marker, or 2 minutes after it was asked; a peer whose batch timed out still owes that batch's end marker, so the next one it sends ends nothing. Channels then neither in the graph nor being checked (not sent, or sent and refused), and those a peer that left still owed, are asked of another connected peer that listed them, ahead of that peer's own list; with none, they come back at the next range sync, which happens on every connection. Channels still being checked stay the peer's to answer for: checked again every second, and asked elsewhere the same way if their lookup refuses them. A channel is asked of each peer at most once a connection. A peer that has withheld two batches loses its turn: what another peer listed goes to that peer instead, and it is asked only for channels nobody else listed. `lightning_summary` counts withheld batches (`withheld_batches`), so a graph missing channels some peer has is visible. A reply that arrives once a peer's list has ended is refused, and each peer's list is capped at the ceiling on its own, so one peer listing invented ids cannot crowd out another's.

Peers' graphs differ: alone, ACINQ listed 21,600 channels and Bitfinex 30,250. Asking every peer gives the union.

Channels we already hold whose nodes have sent no announcement are requested too, once per node per process. A timestamp filter brings only the last two weeks of node announcements and most nodes announce less often, while a peer answering for a channel also sends its nodes' announcements. Without this, a sync from LND peers left 3,900 of 13,600 nodes with an alias; with it, 7,560. The rest never announce.

**"Synced"** (`Status::synced`, `Event::Synced`) means the graph is complete enough to show: validation is caught up (the replay is over and every lookup that waited at the previous check has been answered), and either every connected peer's channel list has arrived, every channel on them has been received or given up on, and no new channel has arrived for 30 seconds, or the graph was loaded from a file caught up within the last 13 days and every channel in it has been checked again. The channel lists count only for the first 10 minutes after the first peer connected (mainnet's first sync took four): a peer whose list never ends, or that never sends what it listed, cannot hold the graph back for ever, and neither can one that keeps sending new invented channels so that the lookup queue is never empty ([Hostile peers](#hostile-peers)).

The graph file's modification time is set to the last moment the peer was **caught up**: connected, with every listed channel requested, no new channel for 30 seconds and validation caught up. It is not the time of writing, so a graph saved after a week offline does not pass for fresh. After a restart the timestamp filter starts an hour before that moment instead of two weeks back (LDK's own window for peers it does not fully sync), so peers that honour it resend only what is new. A day's margin would be most of the graph again: nodes refresh their channel updates about daily.

### Peers

Peers come only from configuration, never from gossip, so gossip cannot choose where the server connects ([`SECURITY.md`](SECURITY.md) rule 1). `Config::max_peers` (3) are kept connected. A failed or short-lived connection (under a minute) counts as a failure; a peer is retried after 2 s, doubling per failure up to 10 minutes. The next peer to dial is the due one with the fewest failures, in list order, so a peer that stays unreachable gives its slot to the next one in the list.

Default mainnet peers, all `<pubkey>@<ip>:9735`-style clearnet addresses:

| Node | Why |
|---|---|
| ACINQ | Runs eclair; long-lived; answers range queries at full speed (its whole graph in about 20 s) |
| Bitfinex `bfx-lnd0`, `bfx-lnd1` | Long-lived exchange nodes (LND, by their names); two keys on one host |
| CoinGate | Long-lived payment processor |
| Bitstamp | Exchange |
| NiceHash | Exchange |

They were picked from the live graph on 2026-11-12: the best-connected nodes that announce a clearnet address and are run by companies that have operated Lightning nodes for years, with the address in the list matching the node's own announcement. Several nodes picked from memory (Kraken, River, Wallet of Satoshi, Boltz) were unreachable at their old addresses and were dropped. Only the first three are dialled while they stay up. An operator replaces the list with `{NET}_LIGHTNING_PEERS` ([`CONFIG.md`](CONFIG.md#lightning)). Signet has its own defaults (below); on testnet4 and regtest there are none, and the server will not start Lightning there without a list.

Default signet peers:

| Node | Why |
|---|---|
| `lndus1-signet.dev.zaphq.io` | Among the best-connected nodes on the default signet; answers from a clearnet address |
| `lndeu1-signet.dev.zaphq.io` | The same operator's second node, on another address |

They are two nodes of one operator, chosen by the project's owner on 2026-11-13, when both were among the best-connected on the default signet and accepted connections. Test-network nodes come and go: when these stop answering, `lightning_peer_unreachable` repeats for them ([`LOGGING.md`](LOGGING.md#lightning)), and an operator sets `SIGNET_LIGHTNING_PEERS` to nodes that answer ([Finding peers](#test-networks)); the setting replaces both.

**Tor-only nodes are out of reach:** the peer makes plain TCP connections and does not use Tor.

### Files

Both live in `Config::data_dir`, which the server sets to `<DATA_DIR>/lightning/<network>/`, beside the network's SQLite file.

| File | Holds | Size |
|---|---|---|
| `node_key` | The 32-byte identity seed. Created on first run from `/dev/urandom` with mode `0600`; a seed readable by group or others is refused at start | 32 bytes |
| `graph` | LDK's own serialization of the network graph | about 31 MB at 30,000 channels |
| `verified` | The saved answers: the newest block the close-watcher had read, and each channel it watched with its funding output's value, program and block ([Restart](#restart)) | 92 bytes a channel: 3.3 MB at 36,000 |

The graph, then the saved answers, are written every 10 minutes when the graph changed (a failed write is retried at the next period), and at shutdown, except while a loaded graph is still being checked again ([Restart](#restart)), through a temporary file that is synced, renamed over the old one and followed by a sync of the directory, so a crash leaves the old file or the new one, never half of one. Writing it takes about 0.1 s. At start a file for another network, one that does not decode, one larger than 8 KB per channel of the ceiling (the most one channel's gossip can occupy, with its nodes), or one holding more channels than the ceiling (saved under a higher one), is reported (`GraphLoad::Unreadable`) and replaced at the next save.

### Interface

For the tasks that follow, coded against `ln::Peer`:

| Call | Gives |
|---|---|
| `Peer::start(Config, impl Chain)` | The running peer and what was loaded (`GraphLoad`). `Chain` is where funding outputs are looked up and blocks and spends are read: implemented for `node::esplora::Esplora` |
| `read(\|graph\| …)` | LDK's `ReadOnlyNetworkGraph`: nodes with alias, colour, addresses, features, last update; channels with both policies, short channel id and capacity (`capacity_sats`, always `Some`: every channel in it was verified). Gossip waits while the closure runs |
| `changes()` | A stream of `Change::Channel(scid)` and `Change::Node(id)`: read the entry again; a missing entry was removed. A receiver that lags rescans |
| `status()` | A watch of `Status`: `Validation` ([below](#states)), `Closes` ([below](#status-and-events)), synced, counts, ceiling, every peer's connection and failures |
| `history()` | A stream of `Record`s: each channel opened, closed, swept as a penalty, or undone by a reorg ([Opens and closes](#history)) |
| `recent(after)` | The newest `Config::history` (10,000) records after a sequence number |
| `events()` | `Event`s as data: periodic `Stats` (counts, validation, messages and bytes per second, totals), sync, peer, ceiling, save, prune and failed-lookup events, and LDK's own log records |
| `open()` | Every channel open now as an `Opened` record, and the sequence number that set is current at: what a consumer that fell past `recent` stores instead |
| `shutdown()` | Disconnects and writes the graph. Dropping the peer does the same in the background |

**LDK's log records** (`Event::Ldk`) carry the level, module, line, peer and message, cut to 512 bytes; the message is LDK's free text and may quote what a peer sent. Records below `Config::log_level` (`Info`) are not formatted. At most 20 a second are sent; the rest are counted in `Event::LdkSuppressed`. At `Info`, LDK says one line per connection.

## Validation

A signature proves that four keys agreed to announce a channel, not that it exists. A channel is real only if its funding output is on the chain, unspent, and pays the two-of-two P2WSH script of the two announced bitcoin keys. Every channel is checked before it enters the graph, so the graph the crate exposes holds only verified channels, each with its capacity: the funding output's value.

### How a lookup travels

1. A peer sends a `channel_announcement`. Our handler refuses one for another chain, checks the ceiling, computes the script the announced bitcoin keys require and passes the message to LDK, which checks the four signatures and calls our `UtxoLookup` with the short channel id.
2. **Cached:** if the id was looked up within the last hour, the answer is given at once (`UtxoResult::Sync`): the output if its script matches, otherwise a refusal. A channel LDK already holds as chain-validated with the same nodes is not looked up at all.
3. **Otherwise the answer comes later** (`UtxoResult::Async`): LDK keeps the announcement waiting on a `UtxoFuture`, and holds the channel's updates and its nodes' announcements with it as they arrive. Asynchronous answers are what let lookups be batched without blocking gossip processing. The lookup joins a queue; a second announcement of the same id joins the same entry.
4. **One task sends the queue** to `POST /block-heights/txs/outs`, up to 100 positions per request (the short channel id is the block height, transaction index and output index), through the gate every Lightning request to the node shares ([Load on the node](#load-on-the-node)). The batch is taken when its turn comes, so what arrived while it waited goes with it. A first lookup waits 50 ms so that a burst leaves as one batch.
5. **The answer is classified** against the tip height stamped on the response, and every waiting announcement is resolved through LDK. LDK then adds the channel with `capacity_sats` set and applies the updates and node announcements it held; the handler reports the changes. The peer manager is told to read again.

### States

A channel is in exactly one of these. `Status::validation` (`Validation`) counts them.

| State | Meaning | In the graph | Counted in |
|---|---|---|---|
| Unchecked | In the graph file at start, not yet sent for checking ([Restart](#restart)) | No | `unchecked` |
| Pending | Waiting for a lookup, or in one | No | `pending` |
| Early | Its output is less than six blocks deep (BOLT 7), or missing from a block at most six past the node's tip, which may only mean the node is behind. Checked again once the node's tip reaches the funding height plus five | No | `early` |
| Verified | Unspent, at least six deep, pays the announced keys | Yes, with its capacity | `verified` (the graph's channel count) |
| Refused | One of the reasons below | No | `rejected`, by reason |

Refusal reasons (`Rejected`):

| Reason | What it means |
|---|---|
| `missing` | No output at that position, also once an early one is deep enough: an invented channel |
| `spent` | The output exists but is spent: a **closed channel still being gossiped**, counted apart from an invented one. It never enters the graph. A channel from the graph file found spent closed while the peer was down; its close is looked up ([Catch-up](#catch-up)) |
| `wrong_script` | The output does not pay the announced keys: someone announced a real output as theirs |
| `wrong_chain` | Announced for another chain's genesis |
| `shallow` | Early while `max_early` announcements already waited |
| `queue_full` | Refused unchecked because the queue held `max_pending` plus 64. Peers send it again at the next channel-range sync |

`missing`, `spent` and `shallow` count lookups: an id is looked up at most once while its result is cached, so a channel refused and announced again within the hour is not counted twice. `wrong_script`, `wrong_chain` and `queue_full` count announcements. A mempool spend of a funding output counts as unspent, as rbitcoin reports it. `caught_up` is true when a loaded graph has been fully replayed and every lookup that waited at the previous check (the supervisor's, once a second, or the last one that came true) has been answered since; early channels do not hold it back, since they wait for blocks. It is not "nothing pending": a peer sending a steady trickle of invented channels keeps the queue from ever emptying, but the backlog of a moment ago is always answered within one drain of the queue (5,000 lookups at 400 a second: 12.5 s). `node_failures`, `requests` and `outputs` report the node side.

LDK reports a message it holds for a lookup as an error; the handler counts it as `Totals::held` instead of `rejected`.

### Settings and bounds

Lightning gossip triggers these lookups, so they are bounded ([`SECURITY.md`](SECURITY.md) rule 11):

| Setting | Default | Bound |
|---|---|---|
| `Config::lookup_interval` | 250 ms | Least time between the starts of two requests to the node, for all of Lightning together, one at a time: at most 4 a second, so at most 400 outputs a second, whatever arrives, and fewer when the node is slow ([Load on the node](#load-on-the-node)) |
| `Config::max_pending` | 5,000 | Announcements waiting for a lookup. At this many, `processing_queue_high` turns true and LDK holds each peer's next gossip message and stops reading from it (it also pauses its ping timeout, so the peer is not dropped) until lookups drain. Nothing is dropped; a burst is paced to the lookup rate. LDK can still hand in a message already read, so the hard limit is 64 more, beyond which announcements from peers are refused as `queue_full`. A restart's stored channels are never refused: they keep at most half of `max_pending` of their own waiting ([Restart](#restart)), so the queue holds at most 7,564, and up to 1,000 more for a moment when early ones whose block is now deep enough move back into it: 8,564 |
| `Config::max_early` | 1,000 | Announcements held as early |
| `Config::cache_entries` | 100,000 | Lookup results kept, found or not, oldest evicted first |
| `Config::cache_ttl` | 1 hour | How long a result is trusted |
| Batch size | 100 | A third of rbitcoin's limit of 300 for the batch route, so one request stays short and the node's other callers never wait long behind it |
| Request timeout | the client's (10 s), and 30 s at most | A request that does not answer counts as failed |

A held announcement costs LDK a copy of it plus the latest update per direction and node announcement per node, at most about 4 KB, so `max_pending` bounds that memory at about 20 MB. The ceiling (`max_channels`) counts channels in the graph plus those unchecked, pending, being resolved and early, so the graph cannot overshoot it when lookups resolve.

**When the node is down or slow**, a failed or timed-out request puts its batch back at the head of the queue and is retried after 1 s, doubling to 60 s, and no Lightning request reaches the node for three times as long as the failed one took (30 s after the client's 10 s timeout). `Event::LookupFailed` reports each failure with the backlog, and `Validation::node_failures` counts them in a row. The queue fills, gossip from peers waits, and once the node answers it drains. Announcements are not lost and the peer does not wedge: connections stay up and reading resumes on its own.

**A hostile peer cycling invented channels** costs at most one request every 250 ms to the node and a quarter of its time, at most `max_pending` waiting announcements, `max_early` early ones and `cache_entries` cached results; meanwhile honest gossip is paced along with it. It can fill the cache with its own refused ids and evict honest results, which only costs lookups again at the same bounded rate. Honest LDK, LND and CLN peers validate before relaying, so invented channels reach us only from a peer that does not.

### Load on the node

The node is shared: the explorer's own pages, other users and the backfill all ask it too, so Lightning must never be what makes it slow. Every request Lightning sends it goes through one gate (`crates/ln/src/pace.rs`): validation's lookups, the close-watcher's reads and catch-up, and the server's funding txids ([Funding transactions](#funding-transactions)).

- **One request at a time** for all of Lightning, in the order they ask.
- **At least `Config::lookup_interval` (250 ms) between two starts:** at most 4 requests a second.
- **The node left alone three times as long as each request took:** Lightning keeps the node busy at most a quarter of the time, and a node that slows down is asked less, by itself. A request that took 1 s is followed by 3 s of nothing; one that timed out after 10 s, by 30 s.
- **A failure** is also retried after the loop's own backoff (1 s, doubling to 60 s), and the funding fill waits while validation has lookups queued.
- **A restart repeats nothing** the [saved answers](#restart) hold.

On 2026-11-12, at a first start, `lightning_lookup_failed` reported `pending` 5,000: that is announcements waiting, not calls. Gossip delivers about 34,000 channel announcements in its first 20 s; the queue holds them up to `max_pending` and sends them a batch at a time. Two of those requests timed out, as did two funding-txid requests during the first fill, on a host at load 20 to 33.

| | Before 2026-11-12 | Now |
|---|---|---|
| Requests in flight | Up to 3: validation, the close-watcher and the funding fill each paced only itself | 1 for all of Lightning |
| Requests a second | Up to 24 (2, 2 and 20) | At most 4 |
| Funding outputs a second | Up to 600, 300 a request | At most 400, 100 a request; 25 when a request takes a second |
| Node time taken | Not bounded: each loop sent its next request as soon as its interval allowed, however long the last took | At most a quarter |
| After a timeout | The same 300 positions again 1 s later | Nothing for 30 s, then the backoff |
| Restart | Every stored channel checked again: 121 requests, 36,226 outputs, 62 s at the limit, twice that day | Nothing asked for the saved channels; one block read for each mined since the save |
| First sync, 36,000 channels | Verified in 84 s, at 600 a second | 360 requests: at least 90 s; on the node measured below, whose 300-position requests took under 0.5 s, about 4 minutes; longer on a busier node, by design |
| Funding txids, first fill | 33 minutes at 18 a second, beside validation | About 2.5 hours at 4 a second, after validation |

The figures for now are the gate's bounds, proven by tests against a fake node that counts requests in flight and per second, fast and slow, and a restart with the answers saved (`crates/ln/src/tests/closes.rs`, `crates/ln/src/pace.rs`). They were not measured against mainnet: a first sync is exactly the load this is about, on a node others use.

### Restart

A graph file is not trusted as it is: a file written by the unverified peer of earlier versions holds channels that were never checked, and any file may hold channels closed while the peer was down. So a loaded graph is not shown. Its channels, with their stored announcements and latest updates, and its node announcements, are taken out, and the peer starts with an empty graph. On each one-second tick, while fewer than half of `max_pending` stored channels wait for their lookups, whatever live gossip holds (live gossip pauses at `max_pending` in all, so under load each gets half, and a peer keeping the queue full cannot starve the replay), up to 2,000 stored channels are sent through the same check as gossip; their updates wait in LDK with them, and a node's stored announcement is applied once one of its channels is verified. Until then, gossip that arrives for a stored channel or node is kept with it if newer (an oversized node announcement trimmed first), and the channel-range sync does not ask peers for channels already stored or pending. A channel enters the graph only once it passes, so after a restart nothing unverified can pass as verified.

**Saved answers.** Passing does not mean asking the node again. Every save writes `verified` after the graph ([Files](#files)): the newest block the close-watcher had read, and each channel it watched and was not about to check again, with its funding output's value, program and block. Each of those is unspent up to that block, because the watcher read every block since the channel was verified. At start, with a graph to replay, the file answers those channels' lookups, from a table of its own that neither the cache's size nor its hour evicts, and the watcher resumes from that block: the replay hands those channels back before any other, up to 2,000 a second whatever the lookup queue holds, since they never enter it (18 s for 36,000); the watcher waits until all are through, with no deadline that a slow machine could lose a race against; it then forgets the saved answers, so a channel announced later is asked of the node, and reads the blocks mined since, as it reads any new block, so a channel closed while the server was down is found in the block that closed it. A restart therefore asks the node nothing for the channels it had verified, only the blocks since the save; channels the file does not hold are looked up as before. Down for more than ten blocks, or with the saved block no longer on the best chain, the watcher checks every watched output by position, as after any [gap](#catch-up). Either file can be the older one, and both stay true. A `verified` file for another network, with more channels than the ceiling, or whose length does not add up is ignored, and every channel is then asked of the node as on a first start.

While stored channels are still to be checked or answered, early ones included (until their output is six deep: twelve blocks at most), the replay stays open: neither file is saved, at shutdown included, since the files on disk are the better copy, and `caught_up` stays false. A restart in the middle of a check therefore starts over from the same files.

The alternative, discarding the file and resyncing from peers, was measured as the first sync below. Replaying costs only the lookups the saved answers do not cover; a resync costs every lookup plus the full gossip download.

### Measured on mainnet

2026-11-12, the example program `crates/ln/examples/ln_watch.rs` on an Apple M4, release build, the default peers, before validation existed. Bandwidth is the process's own traffic (`nettop`), memory its physical footprint. The gossip figures still hold; for sync and restart times with validation, see [below](#validation-measured-on-mainnet).

| | |
|---|---|
| Initial sync | Synced 84 s after start: 36,247 channels, 13,649 nodes. The first 20 s bring 34,000 channels at 1.5–2.7 MB/s; LND peers then send at their own rate limit, about 51 kB/s |
| Bandwidth | 49.7 MB in and 0.23 MB out for the initial sync. Afterwards 1 to 20 gossip messages a second, about 1–2 kB/s |
| Memory | 160–195 MB, flat over 20 minutes. LDK's graph takes about 4 KB per channel; the same footprint is reached right after loading the file |
| Graph file | 32.8 MB at 36,248 channels. Written in 0.14 s, loaded in 0.07 s |
| Restart | Synced from the file 1.1 s after start, unchecked. Catching up took 6.2 MB of gossip, quiet after a minute |
| Peers | All three first choices connected within 3 s and stayed up for 20 minutes; restarts reconnected within 2 s. No peer dropped us, so live reconnection with backoff is proven by the tests only |

**Against public figures.** Sites built on mempool.space reported about 41,000 channels and 17,400 nodes in mid-2026; CoinPaprika reported 28,900 channels and 15,900 nodes for 4 November 2026; 1ML about 20,000 active channels. Ours sits between them. The node count is lower because LDK keeps a node only while it has a channel in the graph. Of the channels, 21,600 have a policy in both directions, 5,100 in one and 9,500 none yet: LDK refuses policies older than two weeks and drops channels left without one after two weeks, so counts differ by how long each site keeps silent channels. Peers also differ (see [Sync](#sync)).

### Validation measured on mainnet

2026-11-12, the same program and peers, release build, lookups against a synced rbitcoin v0.9.2 mainnet node on the same private network, the settings of the time: 500 ms between requests of 300 positions, with no gate shared with the other loops and no saved answers, so a restart checked every channel again. [Load on the node](#load-on-the-node) has what changed and today's figures. Memory is the process's resident size; macOS compresses an idle process's pages on this busy machine, so only peaks are given.

| | First sync, empty directory | Restart from the file it saved |
|---|---|---|
| Fully verified | 84 s: 36,184 channels. Lookups ran at their limit, 600 a second; the queue sat at its 5,000 bound from 10 s to 74 s, pacing gossip | 62 s: all 36,226 stored channels checked again, same rate |
| Synced | 235 s. Validation was done at 84 s, as was most of the graph; the LND peers' last range batches, sent at their 51 kB/s and delayed by the pacing, ended on their 2-minute timeout | 62 s |
| Node cost | 125 requests and 18.0 MB of responses (about 500 bytes an output) to be verified; 165 requests and 36,227 outputs by the end of the sync | 121 requests, 36,227 outputs, 18.0 MB |
| Steady state | No request at all in the 4 minutes after the sync, nor in the 2 after the restart: a new channel is announced a few times an hour, and channels LDK already holds as verified are not looked up again | |
| Memory | Peak 186 MB | Peak 234 MB, while the loaded graph's messages and the new graph coexist |
| Refused | 1 spent (a closed channel still gossiped). None missing, wrong-script, wrong-chain or early | The same spent one, announced again |

A restart stopped 4 s into the replay (1,800 channels checked again) wrote nothing: the graph file was byte-identical afterwards.

**Capacity.** The verified graph holds 3,231.11 BTC in 36,226 channels. CoinPaprika, from mempool.emzy.de, gave 3,203 BTC in 28,939 channels for 4 November 2026; Coinglass 3,456 BTC for 27 October. Capacity agrees within 1 % of the first, though our channel count is higher for the reasons above. Five channels sampled across the graph (from block 611,038 to 975,065, 100,000 to 10,000,000 sats) were checked by hand against their funding outputs on the node: each is an unspent P2WSH output at the announced height whose value is the capacity shown.

## Opens and closes

A graph is a snapshot; gossip is slow and unreliable about saying a channel ended. The chain is not: a channel ends when its funding output is spent, and the spending transaction says how. The crate watches every verified channel's funding output, removes a channel from the graph in the block that spends it, and keeps a history of opens and closes. It is `crates/ln/src/closes.rs`.

### How closes are found

A funding output pays the P2WSH hash of `2 <key1> <key2> 2 OP_CHECKMULTISIG`, and spending it reveals that 71-byte script as the last witness item. So the watcher reads each new block once (the raw block, one request) and, for every input whose witness ends with a two-of-two of compressed keys, hashes the script and looks the hash up in the set of watched outputs. There is no work per channel: the cost is one block, whatever the number of channels.

A match is checked once more: a script can be paid twice (a splice may keep the funding keys, and anyone can send coins to a funding address), so the spent transaction's position is asked of the node (`/tx/:txid/merkle-proof`, one small request per match) and must be the short channel id's block and index, and the input's output index its own.

**Why the script and not the outpoint.** Matching inputs by outpoint needs each channel's funding txid, which a short channel id does not contain, and the position route validation uses answers with the output (script, value, spent, block) but not its txid. Learning the txid costs two requests per channel (`/block-height/:h`, then `/block/:hash/txid/:index`): 72,000 requests for mainnet's 36,000 channels at every start, an hour and more at validation's pace. The script needs nothing: validation already holds it, since it checked the output pays it. Taproot channels have no such script, but they are not announced through today's gossip, so none is ever in the graph.

The alternative, asking the node about every channel's output at each block, costs 121 requests and 18 MB per block at mainnet's size; reading the block costs one request and 1.7 MB.

The newest block is learned by asking the node's tip every `Config::tip_every` (10 s, 64 bytes). A new tip brings one page of headers (4.4 KB, ten headers), which also shows a reorg, then each new block in turn.

### How a close is classified

| Kind | Recognised by | How sure |
|---|---|---|
| `Force` | The spending transaction is a commitment: BOLT 3 sets the top byte of its locktime to `0x20` and of its input's sequence to `0x80` (the obscured commitment number fills the rest) | Certain. Every LN-penalty implementation builds commitments this way, and no other transaction of the protocol carries both markers. Anchor channels change the outputs (two 330-sat anchors, a delayed `to_remote`), not the markers |
| `Penalty` | Later: an output of that commitment is spent through its revocation path. `to_local` with witness `<sig> 1 <script>` (the script starts `OP_IF <revocation key>`); an HTLC output with `<sig> <revocation key> <script>`, the key hashing to the one its script names | Certain once seen: only the victim holds the revocation key, and only for a revoked commitment. Recorded as a `Penalty` record in the sweep's block; until then the close reads `Force` |
| `Cooperative` | Not a commitment, and its only input is the funding output | Certain that both sides signed a transaction that is not a commitment. Likely a mutual close (legacy `closing_signed`, sequence `0xffffffff`, locktime 0; or `option_simple_close`, sequence `0xfffffffd`). A splice that only takes funds out has the same shape; when the closing transaction funded a channel between the same two nodes, the channel route names it (`continued_as`, [`API.md`](API.md#applightning)), without calling it a splice |
| `Other` | Not a commitment, and more inputs than the funding output | Certain that it is not a close by either protocol: closing transactions spend the funding output alone. Most likely a splice that adds funds. It ends the channel id all the same |

**What the chain cannot say:** which side forced the close (the commitment's keys are per-commitment, not the node keys), why, or whether a cooperative close was a splice. A penalty is recognised only if its sweep confirms within 2,016 blocks of the force close (the longest `to_self_delay` implementations accept), while the peer runs: force closes found by the catch-up, and those older than the watcher's memory, are not watched. Sweeps of the second-level HTLC transactions are not watched; a breach almost always shows on `to_local` first.

The fee is the funding value less the outputs when the funding output is the only input; otherwise the node's fee for the transaction (one more request).

### History

Records, in order, each with a sequence number that grows by one:

| Record | Carries | When |
|---|---|---|
| `Opened` | Channel id, both nodes, capacity, funding block (height, hash, time) | A channel is verified: its first time in the graph since start, including every channel at start, with its real funding block time |
| `Closed` | Channel id, both nodes, capacity, funding block, closing block, closing txid, kind, fee | Its funding output is spent in a block |
| `Penalty` | Channel id, sweep txid, block | A force close turns out to be a breach |
| `OpenUndone` | Channel id | The funding block left the chain. An `Opened` with the new block follows if the output is still at the same position |
| `CloseUndone`, `PenaltyUndone` | Channel id | The closing or sweeping block left the chain |

`Peer::history()` streams them; its room is `Config::history` records (rounded up to a power of two), so a receiver that falls further behind gets a lag error, then reads `Peer::recent(last_seq)` for the newest `Config::history` records, and rescans the graph if those do not reach back. At start the stream carries one `Opened` per channel as validation verifies it (36,000 on mainnet in about a minute).

### Removal from the graph

A closed channel leaves the graph in the block that spends it, once: the watched set is the gate, and a channel is removed from it before anything else happens. Its funding position is stored as spent in the lookup cache first, then LDK removes it (with nodes left without a channel), which also makes LDK refuse its announcement for a week. Gossip for it keeps arriving for days; an announcement is answered from the cache (spent) for an hour, then by the node (spent), and its updates are refused for an unknown channel, so it cannot come back. `Change::Channel` and `Change::Node` report the removal.

### Catch-up

Blocks are not read before the watcher's first tip or across a gap; the node's spend records are asked instead:

- **After downtime.** With saved answers, the watcher reads on from the block it had read before the restart, so a close while down is found in its block like any other ([Restart](#restart)). Without them, the graph file's channels are all checked again at start, and one found spent closed while the peer was down. Its spend is found in four requests: the funding block's hash and the txid at the channel's index (the funding txid), the output's spender (`/tx/:txid/outspend/:vout`, which gives the block), and the spending transaction. Its fee may need a fifth.
- **A gap.** More than ten new blocks at once (the node was unreachable, or the server was suspended): reading them would cost more than checking every watched output by position (18 MB at mainnet's size, ten blocks' worth), so the watcher starts again from the tip and checks every watched output, 100 per request. Spent ones are looked up as above.
- **A late answer.** A channel whose lookup was answered at a tip older than the newest block read (or the block being read), or at a tip on another branch than the block read at that height, is checked again the same way, so a close in a block read before the channel was watched is not missed.

A spend the catch-up finds in a block the watcher has not read on its own branch (a newer block, or another branch at a height it read) is not recorded there: the channel is watched, and reading that block records the close, with what undoes it. On another branch, the channel is also checked again, in case the watcher's branch wins. A channel queued for checking is queued once.

The catch-up goes through the same gate as every Lightning request ([Load on the node](#load-on-the-node)), behind the tip check. A check that fails stays queued and is retried after a backoff. `Closes::catch_up` counts what waits.

### Reorgs

The watcher keeps the newest 100 blocks it read with what each changed (its closes, with what puts the channel back in the graph, and its penalties). At each new tip it walks headers down from the tip to the newest block it still holds on the node's best chain (the fork), undoes every block above it newest first, then reads the new blocks in order, as the block table does ([`STORE.md`](STORE.md#blocks)). A block whose parent is not the last one read stops the step, to be retried.

- **A close undone:** the channel is watched again and put back in the graph with its capacity, policies and node announcements (through LDK's partial-announcement call, since LDK refuses an announcement of a channel it removed; the restored channel has no stored announcement, so after a restart it returns through gossip). `CloseUndone` is recorded; if the new chain spends it, it closes again, perhaps differently.
- **An open undone:** every channel funded above the fork is checked again by position. Still at its position in another block: `OpenUndone`, then `Opened` with the new block. Gone: `OpenUndone`, and it leaves the graph. A funding output is six blocks deep before a channel is verified, so this takes a reorg of seven blocks or more.
- **Deeper than the window**, or no common block at all: everything held is undone, the watcher starts again from the tip and checks every watched output, as after a gap. Closes found by the catch-up are undone only while their block is in the window.

`Event::Reorg` reports the fork and how many blocks were undone; `Event::CloseWatchReset` a start from the tip after a gap.

### Status and events

`Status::closes` (`Closes`): the newest block read; `caught_up` (the node had no newer block at the last look, and nothing waits for the catch-up or the replay); funding outputs and force closes watched; the catch-up backlog; counts since start of opens, closes by kind, undone records and reorgs; blocks read, requests and failures in a row. `Event::CloseWatchFailed` reports a failed request (retried after 1 s, doubling to 60 s).

### Bounds and cost

Nothing gossip sends changes what the watcher asks of the node: a channel enters the watched set only once its funding output was found on the chain.

| | Bound |
|---|---|
| Per block | The tip every 10 s (64 bytes), one page of headers, the raw block (about 1.7 MB on mainnet), one position request per input that spends a watched script, and one fee request per such input that is not alone in its transaction. Inputs that spend a watched script require that channel's keys, so this is one request per real close |
| Rate | Through the gate every Lightning request shares: one at a time, at most 4 a second and a quarter of the node's time for all of Lightning together ([Load on the node](#load-on-the-node)) |
| Catch-up | The same gate. Four or five requests per channel closed while down without saved answers; 100 outputs per request when checking every watched output |
| Watched outputs | One entry per verified channel, so bounded by the graph's ceiling: about 200 bytes each with the script index, 7 MB at 36,000 channels, 20 MB at the 100,000 ceiling |
| Force closes watched for a penalty | At most 10,000, the oldest dropped first, for 2,016 blocks each |
| Block window | 100 blocks with their closes (a few hundred bytes each) |
| History | `Config::history` (10,000) records of about 250 bytes: 2.5 MB |

### Closes measured on mainnet

2026-11-12, `crates/ln/examples/ln_watch.rs`, release build, the default peers, a synced rbitcoin v0.9.2 mainnet node on the same private network. A first start from an empty directory ran 15 minutes; the peer was then stopped for 44 minutes (three blocks), and restarted from the graph file it saved for 75 minutes.

| | |
|---|---|
| First start | The watcher started from the tip; every channel was verified at that tip, so nothing needed checking again. 36,222 channels watched, one `Opened` each |
| Catch-up after 44 minutes down | The restart's replay found 2 stored channels spent; both closes (blocks 975,537 and 975,539) were found from spend records 72 and 74 s after start, 8 requests in all. The replay itself costs what [Validation measured on mainnet](#validation-measured-on-mainnet) says |
| Closes seen | 27 in 13 blocks (975,537 to 975,549): 26 cooperative, 1 force (with anchors). 11 in one block (975,541). No penalty, no reorg |
| Checked by hand | Four closes against the node: each spends the output at its channel id's position, in the block recorded, with the fee and capacity recorded. The three cooperative ones have the `closing_signed` shape (sequence `0xffffffff`, locktime 0); the force close carries both commitment markers and two 330-sat anchors |
| Node cost per block | One page of headers (4.4 KB), the raw block (1.7 MB on average over 8 blocks) and one 0.3 KB position request per close; besides, the tip every 10 s. 388 requests and 13.6 MB in the last hour |
| Memory | Peak 175 MB on the first start, 301 MB on the restart while the loaded graph and the new one coexist (234 MB before the watcher existed: macOS's figures on this busy machine vary by tens of MB) |

**Across a day's blocks.** Every spend of a two-of-two in the 144 blocks before 975,536 (229 MB read): 209 commitments (206 with anchors), 1,720 single-input non-commitment spends and 3,070 multi-input ones, no revocation sweep. Commitments are Lightning's alone, so about 200 force closes a day, private channels included; the other two counts include ordinary two-of-two wallets (consolidations of up to 224 such inputs, sequence 0), which is why the watcher matches only announced channels' outputs. No public source gives a daily close count to compare: Glassnode charts only the net daily change in channels, mempool.space and Coinglass only totals.

## In the server

With `{NET}_LIGHTNING_ENABLED=true` ([`CONFIG.md`](CONFIG.md#lightning)) the server runs one peer per network, in `crates/server/src/lightning.rs`.

### What runs

One task per network owns the peer. It is spawned after the routes are built, and nothing else waits on it: the graph file is read inside that task, so a large or corrupt file, an unreachable peer or a slow node never delays startup, readiness, block handling or the mempool engine. The task starts the peer, then runs three loops until shutdown: the history consumer, the event reporter and the statistics sampler. A peer that cannot start (the store did not open, the data directory or node key is unusable) is logged as `lightning_failed` and shows as `failed`. So does one whose server task panics, which tokio confines to that task, and one that went silent: the peer sends its statistics every ten seconds, and its supervisor stops if the lookup worker or the close-watcher ended (they end only by panicking), so two minutes without them mean it can no longer validate or watch (`error` `stalled`). None of this stops anything else, and nothing restarts the peer: fix the cause and restart the server.

At shutdown, after the last request, the server stops each peer (which writes its graph: `lightning_stopped`, 0.1 s on mainnet), then stores every history record it had not stored yet, the ones still on the stream included, so a close the peer found is never lost to the graph file that no longer holds its channel. All of it within 10 s.

**Readiness.** `/readyz` reports each network's `lightning` state (`off`, `starting`, `syncing`, `synced`, `failed`, `stopped`). `synced` means the routes answer: the graph is synced and its first [index](#routes) built. A synced graph is `syncing` for the second or so its first index takes, and `failed` while that index cannot be built (`lightning_index_failed` says why), until a build works. It does not count towards `ready`: the explorer is ready whatever Lightning does ([`DEPLOY.md`](DEPLOY.md#health)). `/app/lightning/status` has the detail ([`API.md`](API.md#lightning)).

### What is stored

| Table | Holds | Written |
|---|---|---|
| [`ln_channels`](STORE.md#ln_channels) | Every channel the peer verified and how it closed: kind, block, txid and fee, kept consistent through reorgs by the `…Undone` records | As the [history](#history) arrives, in writes of up to 2,000 records |
| [`ln_statistics`](STORE.md#ln_statistics) | Channels, nodes (by address kind), capacity and fee policies every ten minutes, rolled into hours and days | At every whole ten minutes while the graph is synced |

Both are written with `try_write`: when the store's queue is full the Lightning side waits and retries instead of taking a slot, so block and mempool history writes never queue behind it. Nodes, aliases and open channels' policies are not stored: they are in the live graph, and come back from the graph file after a restart.

### What is served

The peer's status, the latest statistics (until the first snapshot after a start is stored, up to ten minutes after the sync, the totals taken once when the first index is built: one read of the whole graph, as a snapshot is) and the series over an interval, the newest opens and closes, and nodes, channels, search and rankings ([Routes](#routes)), under `/app/lightning/…` and in the reference's shapes under `/api/v1/lightning/…` ([`API.md`](API.md#lightning)). Every answer comes from the store or the server's memory; none asks the node, and none takes the graph's lock.

### Routes

The node, channel, search and ranking routes read an **index** of the verified graph (`engine::lightning::Index`, built by `crates/server/src/lightning/index.rs`), never the graph itself, so a request costs a lookup whatever the graph's size and gossip never waits for one.

**Built every 30 s while the graph is synced.** The task copies the graph out of LDK in chunks of 2,000 entries, taking and releasing the graph's lock for each (25 holds on mainnet, the longest 1.05 ms), then indexes the copy on a blocking thread with no lock at all and swaps the new index in behind an `Arc`. The copy runs on the peer's own task (11 ms of one worker every 30 s), so nothing outside it ever holds the peer, and a shutdown during a build still stops the peer in order and writes its graph. A request clones the `Arc` and lets go; nothing it does can make the peer or the store's writer wait. Gossip that lands between two chunks is in the copy or not; a channel or node gone by its chunk is skipped, and the next build has it right. A graph that has never been synced is not indexed: until then the routes answer that they are syncing, rather than from a half-loaded graph. A round that fails (the store's read, or a build that panics) is logged as `lightning_index_failed` at the 1st, 2nd, 4th… in a row and tried again in 5 s while there is no index, at the next 30 s round once there is one; with no index yet the state is `failed` and the routes say the graph `cannot be indexed`, never that it is still syncing. With one, they keep answering from it. Before 2026-11-14 a failed read was dropped without a word: the first deployment's mainnet routes said "still syncing" for as long as it ran ([`STORE.md`](STORE.md#temporary-data)).

| Held per build | From |
|---|---|
| Every channel by short channel id, with both ends, capacity and both policies | The graph |
| Every node with a channel, by public key, with its announcement, capacity, open and active channel counts, and its channels ordered largest first | The graph |
| Each node's lowercased alias, for search | The graph |
| The top 100 nodes by capacity, by open channels and by age, and each node's place by capacity and by open channels | Both |
| Each open channel's funding block time, for sorting a node's channels by age | The store, in a second read of `ln_channels` by short channel id |
| Each node's oldest funding block time and its closed channels by kind, and when our history starts (the oldest statistics row) | The store, in one grouped read of `ln_channels`, done again, with the funding times, only after new history or statistics rows were stored |

**Stale by at most 30 s plus a build.** A channel's own routes also read its row from the store, so a close shows there at once. Measured on mainnet (36,223 channels, 13,639 nodes, release build): the copy 10.8 ms, a whole build 24 to 41 ms, so about 0.1 % of one core. After a restart from the graph file the first index came 4 s after the graph synced (111 s from start), and the answers were those before it but for one channel whose policy had changed. **Memory**, estimated from the structures' sizes: about 200 bytes a channel and 330 a node, and 80 a node and 16 a stored channel for the store's part: about 13 MB at mainnet's size, twice that while a new index is built beside the old, and at most about 85 MB at the 100,000-channel ceiling (200,000 nodes). It is not measured apart: the process's footprint after the first build, 249 MB, is within the variation of the figures [measured](#measured-in-the-server) before the index existed.

**Search** is bounded whatever the query: 3 to 66 characters, a binary search over the public keys for a prefix and one pass over at most 2 × the ceiling aliases of at most 32 bytes, 10 results. Aliases are kept as the index cleans them (LDK's printing: up to the first NUL, control and format characters as U+FFFD; then runs of combining marks cut to two; so at most 96 bytes), matched lowercased, served as JSON strings and never interpreted; an alias proves nothing, so the impostor of a well-known name is found too, ranked by capacity ([`API.md`](API.md#nodes-channels-search-and-rankings)).

**A node's past** (`/app/lightning/nodes/:key/history`, `/api/v1/lightning/nodes/:key/statistics`) is rebuilt from `ln_channels`, which already holds every channel's funding and closing block times: the node's channels open at each UTC midnight are a sweep over its rows (one indexed read, 1.6 ms for ACINQ's 1,807). Nothing new is stored. Snapshotting every node's totals instead would add 13,600 rows every period (150 MB a year at one a day) for the same numbers. Before our history starts the table does not know the channels that had already closed, so the series begins at the first statistics snapshot. A channel LDK pruned keeps its row as open ([Still missing](#still-missing)) and is counted open.

### Funding transactions

The peer never learns a channel's funding txid ([Why the script and not the outpoint](#how-closes-are-found)), but the transaction page needs to find the channels a transaction opened. So a background task asks the node once per stored channel, `/block/:hash/txid/:index` with the funding block's hash the table already holds, and stores the answer in `ln_channels.open_txid`, indexed. The requests go through the gate every Lightning request shares, and only while validation has no lookup queued, which goes first ([Load on the node](#load-on-the-node)): at most 4 a second, so a first fill of mainnet's 36,000 channels takes about 2.5 hours, and after that it asks for a few hundred new channels a day. Before the gate, at 18 a second beside validation, the first start filled all 36,227 channels in 33 minutes; two requests failed on a dropped connection and were retried; the three channels spot-checked against the reference carry the same funding txids. A failure is retried after 1 s, doubling to 64 s (`lightning_funding_failed`); a block that left the chain is skipped until the history moves the row. A txid is stored only while the row names the block it was read from, and an open that moves the channel to another block clears it. Requests never wait for this: until a channel's txid is known, its routes say `null` and a lookup by that txid does not find it. Closing txids come with the close and are indexed the same way.

### Still missing

- `/api/v1/lightning/penalties`: its rows are the reference's database records of a closed channel (each end's last policy, balances, outputs, resolution state), which we do not keep ([`compat/api-v1.md`](compat/api-v1.md#lightning)). Breaches show in our closed-channel lists.
- A channel's close is lost when the history store falls past the peer's memory ([`STORE.md`](STORE.md#ln_channels)), and channels the peer stops watching (pruned) keep their row as open.

### Measured in the server

2026-11-12, the release server on an Apple M4, mainnet only, read-only against a synced rbitcoin v0.9.2 on the same private network, mempool engine and backfill off, the default peers, an empty data directory. It ran 16 minutes, was stopped (SIGTERM) and restarted from the files it left, then ran on. Footprint is the process's physical footprint (`footprint`), sampled every 10 s; the same server with Lightning off sat at 90 MB.

| | First start | Restart from the graph file |
|---|---|---|
| Startup | The peer started 25 ms after the server listened; three peers connected 2 s later. Nothing else waited: the first block summaries and the difficulty answer went out meanwhile | The 35 MB graph file loaded in 63 ms, inside the peer's task |
| Graph usable | All 36,193 channels verified after 128 s; `synced` after 238 s (36,219 channels, 13,639 nodes) | 36,219 channels checked again; `synced` after 68 s |
| Node load | 165 funding-output requests (36,220 outputs) by the sync, none after | 123 requests (36,223 outputs) |
| History stored | One row per channel as it was verified, in step: 30,930 of 30,930 records after a minute, 36,219 rows (5.5 MB) by the sync | The 36,219 `Opened` records arrived again; the table was identical after them (same row count, capacity and funding-time sums) |
| Footprint | 270 MB at its peak, so the peer adds about 180 MB | 380 MB while the loaded graph and the new one coexist; over the next 2.5 hours a median of 334 MB and at most 423 MB: plan for 250 to 330 MB more than without Lightning |
| Shutdown | Graph written (35 MB) in 124 ms, then the server exited | After 2.5 hours: graph written (33 MB) in 1.2 s, nothing left unstored |

**Steady state.** The close-watcher's requests are the tip every 10 s, a page of headers and the raw block per block, and one position request per close: 962 requests and 15 blocks read in 2.5 hours, about 385 an hour, nearly all of them the tip. Validation asked for 28 more outputs (new channels) in that time. When the node's proxy answered `502` for a few seconds, `lightning_watch_failed` was logged three times and the watcher went on by itself. A statistics snapshot took 0.3 to 2.1 ms to store; 16 were stored. The routes answered in 0.03 to 1.1 ms of server time (a list of 100 channels with aliases 1.0 ms).

**Closes.** 30 closes in the 13 blocks from 975,557 to 975,569 (the first 45 minutes of the run had no block at all): 27 cooperative and 3 force, no penalty, no reorg. The table held exactly those 30 closed rows. Four were checked by hand against the node: each spending transaction is the funding output's spender in the block recorded, with the fee and capacity recorded; the cooperative ones have the `closing_signed` shape (one input, sequence `0xffffffff`, locktime 0) and the force close both commitment markers and a 330-sat anchor.

**Against the reference.** `GET /api/v1/lightning/statistics/latest` at 13:50 UTC said 36,219 channels, 13,639 nodes, 3,232.02 BTC, average capacity 8,923,540 sats, median 1,000,000, average fee rate 981 ppm and base fee 1,439 msat, medians 130 ppm and 500 msat. mempool.space's public answer was still dated 2026-08-30 and its series were empty, so there is no same-moment figure: there it read 32,518 channels, 16,225 nodes, 3,753.7 BTC, average 11,543,473 sats, median 2,010,000, 823 ppm and 904 msat, medians 100 ppm and 500 msat. Its newest point in the three-month series, 2026-11-03, read 28,940 channels and 3,194.7 BTC. The differences:

- **Channels and capacity:** we count only channels whose funding output we found unspent, six deep and paying the announced keys, as of now; they count what gossip claims, in their own database. Their own series moved from 32,500 to 28,900 channels between August and November, and the capacity agrees within 1.2 % with their November point.
- **Nodes and their kinds:** LDK keeps a node only while it has a channel in the graph, and 6,628 of ours sent no announcement we received (so no address: `unannounced`), against their 2,022. Their database keeps nodes and their last announcement much longer. Tor, clearnet and both are counted the same way from the addresses announced.
- **Fees:** ours leave policies over 1,000,000 ppm or 1,000,000 msat out of the averages (118 and 274 on mainnet; [`STORE.md`](STORE.md#ln_statistics)); we do not know their rule. Our medians count every policy, disabled ones included.

## Bounds

Gossip is untrusted input ([`SECURITY.md`](SECURITY.md)). Validation makes a channel cost an attacker a real funding output, but the graph is bounded anyway, and so is the validation itself.

- **Ceiling.** At most `Config::max_channels` (100,000) channels; announcements of new channels beyond it are refused and `Event::CeilingReached` is sent. The check and the insert happen under one lock, so concurrent peers cannot overshoot it. Nodes enter the graph only through channels, so they are bounded by twice that.
- **Message size.** Gossip messages over 1 KB are refused; real ones are under 500 bytes. The exception is node announcements: about 50 real nodes announce one onion address tens to a thousand times (up to 38 KB). Those are checked against their signature and kept with at most 8 distinct addresses and no unknown fields, unsigned (which only matters for relaying, and we do not relay).
- **Memory.** So each channel and node held is bounded, and with the ceiling so are the graph's memory and its file. At mainnet's mix, 4 KB per channel, the ceiling is about 400 MB; filled by an attacker with the largest messages accepted, about twice that, and a file of at most 8 KB per channel. `Stats` reports the counts, and `Event::GraphSaved` the file's size.
- **Disk.** Nothing gossip sends is written anywhere but the graph file, whose size follows from the ceiling.
- **Range sync.** The channel ids wanted from each peer are capped at the ceiling, per peer: at most 100,000 ids, about 4 MB, per connected peer.
- **Funding-output lookups** are deduplicated, cached, batched (up to 100 per request), queued in a bounded queue that pauses gossip when full, and paced through one gate ([Load on the node](#load-on-the-node)), so no amount of gossip can load the node beyond one request per `lookup_interval` and a quarter of its time.
- **The close-watcher** asks the node for each block once, and for one small request per real close, whatever gossip says ([Bounds and cost](#bounds-and-cost)).
- Aliases, colours and addresses are kept as LDK decoded them and never interpreted. Aliases are cleaned once, when the server's index is built (LDK's printing, then the page's own cleaning: `clean_alias` in `crates/server/src/pages.rs`), so the API, search and the node page's title serve the same text; addresses can only hold IP numbers, onion keys and hostnames of `[A-Za-z0-9._-]` (LDK refuses any other byte). All are served as JSON strings or HTML-escaped, and rendered as plain text.
- The peer makes outbound connections only, never listens, never announces itself and never relays.

## Hostile peers

The peer talks to strangers by design: anyone can run a Lightning node, and anyone with real coins can announce real channels with any alias. A configured peer is reached only at its configured key (the Noise handshake proves it), but what it sends is untrusted, and so is the gossip it relays. Nothing a peer sends may hurt the server or, through it, the node ([`SECURITY.md`](SECURITY.md) rule 23).

`crates/ln/src/tests/hostile.rs` is a hostile peer our peer dials like any other: LDK's own peer manager completes the real handshake, then it sends whatever a test queues (any message type with any body, signed or not) as fast as we read, through a proxy that can stop reading what we send or pass what it sends one byte at a time. The fast attacks run with the normal suite; the floods and the regtest attack are `#[ignore]`d, with the command beside them:

```bash
cargo test -p ln --release -- --ignored --nocapture hostile::flood   # each under two minutes
cargo test -p ln -- --ignored --nocapture hostile::regtest          # needs dev/regtest/regtest.py up
```

### Bounds

| | Bound |
|---|---|
| Node work gossip can cause | One request at a time, at most 4 a second of at most 100 positions (400 outputs a second), and at most a quarter of the node's time, through the [gate](#load-on-the-node) every Lightning request shares; plus one tip read a minute while only early announcements wait. An id is looked up at most once while its result is cached (an hour, unless 100,000 newer results evict it first); the request bound holds either way. Measured under a flood of invented channels: 3.8 requests and 387 outputs a second |
| Stored by a stranger with no coins | Nothing on disk: no row in SQLite, nothing in the graph file or the saved answers (only verified channels and their nodes are kept). Nothing in the log at `info`. In memory, shared by all peers: up to 100,000 cached refusals (about 10 MB, evicted oldest first, an hour each), 5,064 announcements waiting for a lookup (about 20 MB; 7,564 with a restart's own share), 1,000 early ones (about 4 MB) |
| Stored by a stranger with one real channel | One `ln_channels` row (about 150 bytes) and its history record; one channel and two nodes in the graph (at most 8 KB in the file, about 4 KB in memory). Its updates and node announcements replace the last one, so they add nothing: at most one accepted update a second per direction after a burst of up to a day's worth of future timestamps (LDK refuses more than a day ahead). One funding-txid request, and one position request when it closes |
| Memory one peer can hold | Its share of the queues above (about 34 MB with all of them full), its channel list (at most 100,000 ids, about 4 MB), and LDK's buffers for its connection (it stops reading a peer once 12 messages or 1 MB wait to be sent to it): about 40 MB. Measured: at most 24 MB more than before the flood |
| CPU | One peer's gossip may cost at most `Config::checks_per_sec` (5,000) signature checks a second on average (a channel announcement counts eight: four on arrival and four again when a lookup answers it; an update or node announcement one), after a burst of 60 s worth (300,000; mainnet's first 20 s, 34,000 channels with their updates and nodes, is about 350,000). Past that it is not read until it is back within the rate: TCP holds its messages back, nothing is dropped, and other peers are read as before. The budget is kept across reconnections. So one peer can take about a sixth of a core (a busy Apple M4 checks about 31,000 a second), where without the budget it took a whole one. Channel announcements are checked under one lock, so several peers together do not take more for them. Measured: [below](#what-each-attack-did) |
| Channels listed and withheld | Asked of another connected peer that listed them, at the end marker or 2 minutes after the request (a channel sent and still being checked then, as soon as its lookup refuses it), ahead of that peer's own list (so within 2 more minutes, its batch in flight). A channel is asked of each peer at most once a connection: three times at most with three peers. A peer that withholds 2 batches is asked only for channels no other connected peer listed. It is not disconnected: peers come only from configuration, so the same peer would be back after its backoff, and it may be the only one with some channels. Withheld batches are counted in `lightning_summary` (`withheld_batches`) |
| The log | No event per message: gossip is counted in `lightning_summary`. Connections: `lightning_peer_connected` and `lightning_peer_lost` at most twice a minute per peer (a connection under a minute doubles the backoff). LDK's own lines are `debug`, at most 20 a second |

### What each attack did

| Attack | What happened |
|---|---|
| Announcements with bad signatures (2,000; a 40 s flood as fast as we read) | Refused by LDK before any lookup: no node request, nothing stored, peer kept. Without the budget we read 38,500 to 39,600 a second and the process used 1.23 cores; with it, past its burst, 625 a second on average (333 to 688 over three 30 s windows on a loaded machine) and 0.03 to 0.06 cores |
| An honest peer sending 34,000 real channels at once, each with both updates, then 150 node announcements (102,150 messages) | Every channel in the graph 22.8 s after the first message without the budget, 22.7 and 23.0 s with it: the budget does not slow a dump of mainnet's size |
| Real channels listed by a hostile peer first and an honest one after; the hostile one ends its batch without them, never answers, or answers with announcements signed by keys of its own that the funding outputs do not pay (also while the node is down, so they are refused only after the batch ended, the honest peer's list arriving meanwhile) | Before: none of the 50 arrived (after 30 s), and nothing in the log said so. Now the honest peer is asked for them: all in the graph 0.25 s after the end marker, 2 s after the false announcements (their lookups settle first), 3 to 4 s after the request (the tests' 2 s timeout), or about 1 s after the node answered again; `withheld_batches` 1 |
| A peer withholding batch after batch | After its second, everything else it was to be asked that another peer listed goes to that peer; it is asked only for what nobody else listed |
| Good signatures over an output that is missing, spent, or pays another script, each 500 times | One output looked up each, refused as `missing`, `spent`, `wrong_script`; the repeats answered from the cache. An announcement carries no amount: the capacity is the output's own value, so there is no wrong amount to send |
| One announcement repeated 980,000 times (67 s, before the budget; with it, 625 a second) | One lookup in all; 17 MB more at the end |
| Distinct invented channels, signed as fast as the peer could (30 s, far faster than lookups drain), beside an honest peer | Read at the lookup rate: the queue held at its 5,000 bound, nothing refused as `queue_full`, nothing dropped (LDK stops reading); both peers stayed connected. A real channel the honest peer announced halfway waited 12.9 s, behind the queue. Refused ids are not retried: they are cached as `missing` for an hour |
| Node announcements: the largest feature field, 200 addresses and 60 KB of extra data; aliases with control characters, ANSI escapes, a right-to-left override, markup, invalid UTF-8 | The oversized one kept with 8 addresses and no extra data; one for a node with no channel not kept. LDK prints control and format characters, the override included, as U+FFFD, and invalid UTF-8 as its printable ASCII; markup stays text |
| Channel updates for 1,000 unknown channels, two days ahead, three weeks old, flapping 1,000 times | Unknown, ahead and old refused, no node request; the flapping ones replaced each other in place |
| An unknown odd message type (a megabyte of it) / an unknown even type | Ignored / the connection closed and redialled after the backoff (BOLT 1) |
| 2,000 `query_channel_range`, 50 `query_short_channel_ids` of 8,000 ids | One empty reply each to the first, nothing to the second |
| Pings asking for 65 KB pongs, and range queries, at a peer that never reads | We stopped reading it (LDK), and dropped it four ticks later (40 s at the production tick); the honest peer stayed up. At most 16 MB more in that minute |
| A peer sending one byte every 300 ms | Its handshake never completed; dropped at the second tick and redialled after the backoff |
| A peer that drops every connection after the handshake | Redialled after 50, 100, 200 ms... (2 s, doubling, by default): a few dials, not hundreds |
| A `reply_channel_range` after the list ended, or that never ends | Refused after the end; a list that never ends stops holding back `synced` after 10 minutes |
| A steady trickle of invented channels, so the lookup queue is never empty | `synced` still comes (it once never did), and a restart's replay still ends (it once never did, so the graph was never saved) |
| Ids past the tip, height 16,777,215, index 16,777,215, output 65,535, block 0 (also against rbitcoin on regtest) | rbitcoin answers `null` for such a position and never fails the batch: `missing`, one output each. An id up to six blocks past the tip waits as early, then is refused once its block is five deep without it |
| A real channel whose funding block is reorged away (regtest, `invalidateblock` and seven empty blocks) | The close-watcher's reorg check finds the output gone: `OpenUndone`, and the channel leaves the graph |

## Limits

- **History starts when the peer first runs.** Channels that closed before then are not in gossip, and a channel gossiped after it closed is refused as `spent` without a close record. After that, closes during downtime are found from the graph file ([Catch-up](#catch-up)), for channels the file held.
- **A channel that closes before it is six blocks deep is never announced,** so it is never seen, like a private one.
- **A channel LDK prunes** (no update in either direction for two weeks) is no longer watched, so its later close is not recorded. It comes back, watched again, if gossip announces it again.
- **Private channels are invisible,** as on every explorer.
- **Tor-only nodes cannot be peers.** Their gossip still arrives through clearnet peers.
- **No world map.** That needs a GeoIP database and is out of scope.

## Test networks

Signet and testnet4 run the same code as mainnet: the network decides only the chain hash, which every gossip message and peer must carry, and the default peers: mainnet and signet have them ([Peers](#peers)), testnet4 and regtest do not. Testnet 5 has no Lightning: LDK does not know the network, so the server refuses `TESTNET5_LIGHTNING_ENABLED=true` at startup ([`CONFIG.md`](CONFIG.md#lightning)).

**What is needed:** `{NET}_LIGHTNING_ENABLED=true`, `DATA_DIR`, the network's node configured as for its blocks, and, on testnet4 and regtest, `{NET}_LIGHTNING_PEERS` ([`CONFIG.md`](CONFIG.md#lightning)). Without a peer list the server does not start there: `config_invalid` with `TESTNET4_LIGHTNING_PEERS must list 1 to 64 peers as <pubkey>@<ip>:<port>, comma-separated (only mainnet and signet have defaults)`. Signet needs no list: the default peers are dialled.

**A custom signet needs its own list.** The signet defaults are nodes of the default signet, and the server cannot tell a custom signet from it: every signet shares one genesis block, so the chain hash in gossip and in a peer's `init` is the same, and the server does not read the node's signet challenge. On a custom signet, set `SIGNET_LIGHTNING_PEERS` to that network's nodes. Left on the defaults, it would connect to them and refuse their channels, whose funding outputs its node does not have.

**Finding peers.** Any public Lightning node of that network that announces a clearnet address and answers from your host; your own node on that network is the best one. Public explorers' node rankings for the network list candidates; take the address the node announces itself, and check that a TCP connection to it opens. List four or five: three are kept connected, and an unreachable one gives its slot to the next ([Peers](#peers)).

**A peer on the wrong network** is told apart by the chains it names when it connects (BOLT 1 `init` `networks`): one that names only others, a mainnet node in a signet list for one, is disconnected at once, `lightning_peer_wrong_chain` names its key (once per peer), and `lightning_peer_unreachable` follows as it is redialled after the backoff ([`LOGGING.md`](LOGGING.md#lightning)). Nothing it sends is stored. A peer that names no chain cannot be told apart: it stays connected, and its gossip for another chain is refused as `wrong_chain`.

### Signet, measured

2026-11-13, the release server on an Apple M4, signet only, read-only against a synced rbitcoin signet node on the same private network, four public signet peers.

| | First start, empty directory | Restart from its files |
|---|---|---|
| Graph | 1,065 channels and 218 nodes 20 s after start; `synced` at 44 s (the 30 s without a new channel). None refused | 1,065 channels from the graph file (1 MB, loaded in 3 ms), `synced` after 1 s |
| Node load | 45 requests for 1,065 funding outputs; the funding txids after, at most 4 a second | No lookup: the saved answers covered every channel |
| Gossip | 2.3 MB | 70 kB in the first minute |
| Footprint | 34 MB | 53 MB |

**A small graph looks thin, and that is right.** Of 218 nodes, 112 announced no address and many no name (LND's default alias is its key's first 20 hex digits); many nodes have one or two channels, so the rankings' lower half is near ties; many channels are inactive; closes are rare (none in the hours watched). The statistics start at the first sync ([`API.md`](API.md#lightning)) and the history at the first snapshot, so the charts have minutes of data on the first day.

**Against the reference.** mempool.space's public signet API read 223 channels and 44 nodes in its newest statistics, dated 2024-09-09, and its node records were last updated between 2024 and December 2025. Sampled on 2026-11-13, a node's channel list there and here differed both ways, and every differing channel was checked against the node:

- **Listed there, not here** (18 sampled): every one an unspent P2WSH output of the listed value. Their last policy there is from 2024 or early 2025: their nodes went silent without closing them, so no peer gossips them now, and a channel no one has updated for two weeks is not kept ([Limits](#limits)). They are real outputs but not live channels.
- **Listed here, not there:** channels opened after its data stops, such as 330627x13x0 from the day before, which it does not know. Four older ones missing from its paged list of the same node were known to it by id.

So the counts differ because the reference's graph stopped in 2024–2025 and keeps silent channels, not because either checks less. At the first sync, 38 of the 1,045 channels walked here (4 %) had no policy in either direction yet; LDK drops a channel with no update two weeks after receiving it, so expect the count to fall by about that much in the first two weeks.

### Testnet4

Not run: no public testnet4 Lightning node was known to answer, and mempool.space serves no testnet4 Lightning API (`404`) to find one through. The code path is signet's with testnet4's chain hash (from the `bitcoin` crate, whose own test checks it against the genesis block). Trying it needs one or more testnet4 peers as `<pubkey>@<ip>:<port>` and a synced testnet4 node configured for the server.

## Switch

Lightning is optional and off by default: a network runs it only with `{NET}_LIGHTNING_ENABLED=true` and a `DATA_DIR` ([`CONFIG.md`](CONFIG.md#lightning)).
