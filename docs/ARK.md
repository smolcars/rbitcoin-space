# Ark

Pages for Ark VTXOs: a visitor opens `/ark`, pastes a VTXO's id without saying whose it is, and gets its amount, its expiry, the exit path drawn as a picture and the exit transactions, each with where it is on chain. An implementation is shown on a network only when the operator configured a server for it (a Bark VTXO given as its hex needs none, [below](#from-its-hex)) ([`CONFIG.md`](CONFIG.md#ark)); `/app/config` names them per network (`"ark": {"signet": ["bark"]}`), and the header's Ark item and the entry page follow that list ([`FRONTEND.md`](FRONTEND.md#the-apps-own-api)).

| Implementation | Crate | Pages | Private API | Configured by |
|---|---|---|---|---|
| Bark, by Second | `crates/bark` | `web/src/pages/ark/bark/` | `/app/ark/bark/vtxo/<txid>:<vout>`, and `POST /app/ark/bark/vtxo` for its hex | `{NET}_BARK_URL` (not for hex) |
| Arkade, by Ark Labs | `crates/arkade` | `web/src/pages/ark/arkade/` | `/app/ark/arkade/vtxo/<txid>/<vout>`, `/app/ark/arkade/address/<address>` | `{NET}_ARKADE_URL` |

The lookup's list of implementations is `IMPLEMENTATIONS` in `web/src/pages/ark/lookup.ts`; an implementation adds one entry there, one route list in `web/src/pages/ark/routes.ts`, and its name in `ark()` in `crates/server/src/app_config.rs`.

## The entry page

`/ark` is one box and an Open button. `classify` in `web/src/pages/ark/paste.ts` reads what was pasted by its form alone, trimmed, and asks nothing. Addresses follow [BOAT-1, "Ark address format"](https://github.com/ark-protocol/boats/blob/master/boat-0001.md): bech32m, `ark` on mainnet and `tark` on any test network, the first 5-bit group after the `1` the version.

| Pasted | Read as | Opens |
|---|---|---|
| `<txid>:<vout>` (hex in either case) | a VTXO: Bark's id and Arkade's outpoint look the same | `/ark/vtxo/<txid>:<vout>` |
| hex starting `0100` or `0200` (a little-endian `u16` version), whole bytes, 50 bytes or more | a serialized Bark VTXO | `/ark/bark/hex#<hex>`: in the fragment, so no server sees it |
| bech32m `ark1q…` (mainnet) or `tark1q…` (any test network), checksum verified | an Arkade address (version 0) | `/ark/arkade/address/<address>` |
| bech32m `ark1p…` or `tark1p…` | a Bark address (version 1) | nothing: "A Bark address cannot be looked up" |
| bech32m `ark1…` or `tark1…` of any other version | an Ark address we cannot read | nothing: "An Ark address of an unknown version" |
| an Ark address of the other kind of network | | nothing: "A mainnet address" or "A test network address" |
| 64 hex digits alone | a txid, never hex | nothing: "Add :vout to the txid" |
| anything else | | nothing: "Not a VTXO or an Ark address" |

`/ark/vtxo/<txid>:<vout>` asks each implementation the network's `ark` list names, through its own route, at once. When exactly one knows the VTXO (Bark's "did not verify" counts: its page says so), the page replaces its address with that implementation's page, so Back returns to the box. None: "Not found on Bark or Arkade", naming only what the network has. One could not be reached and none knows it: it is named, with a retry. Both know it, which should not happen: a choice of the two, neither preferred. It adds no server route. A lookup costs one token on each implementation's per-client limiter, and the page it opens asks once more; Bark answers that from the answer it keeps without a token, Arkade spends a second, so a visit takes two of Arkade's burst of ten.

## Bark

### Where the VTXO comes from

A VTXO's id is the outpoint of its last exit transaction's output, `<txid>:<vout>`. The server, never the browser, asks the network's Bark server for it: one gRPC unary call over HTTP/2, `POST {server}/bark_server.ArkService/GetVtxo` with `content-type: application/grpc` and `te: trailers`. The body is one gRPC message (a zero byte, a big-endian u32 length, the protobuf bytes) whose field 1 is the id as 36 bytes: the txid in internal byte order, then the vout as a little-endian u32. The reply's field 1 is the serialized VTXO. An unknown id is `grpc-status: 5` with no message. The call needs no proof of ownership.

**Whether a VTXO was spent cannot be known.** Bark's `GetVtxoStatus` asks the caller to prove it owns the VTXO, so the page never says a VTXO is unspent, only where its exit transactions are on chain.

### The wire format

ark-lib 0.8.1's encoding (MIT), which `crates/bark/src/decode.rs` reads with our own code. Every integer is little-endian:

```text
u16 version (1 or 2) | u64 amount | u32 expiry height | 33 server key | u16 exit delta
| 36 anchor outpoint | compact-size n | n genesis items | policy | 36 point (the id)
```

- A **genesis item** is one exit transaction: a transition, `u8` outputs, `u8` our output's index (below the outputs; never the fee anchor), the other outputs consensus-encoded, then a `u64` fee in version 2.
- A **transition** says how its one input is signed: `1` cosigned (a compact-size count of 33-byte keys, a 64-byte signature), a tree branch or a board; `2` arkoor (the client cosigners, a 32-byte tap tweak, a signature), an out-of-round transfer; `3` and `4` hash-locked cosigned, first and current form (a user key, a signature, `0` and a 32-byte preimage or `1` and its hash), a tree leaf. A signature of 64 zero bytes is none yet.
- The **policy** is who may spend the VTXO's own output: `0x00` a key; `0x01`/`0x09` and `0x02`/`0x08` Lightning payments out and in (first and current form). Any other type is read as "other": the point is the last 36 bytes, so the rest still decodes.
- Caps: 256 exit transactions, 256 keys on a transition, 10,000 bytes of script on an output, heights and deltas within Bark's own limits, and nothing left over.

### What the server checks

Nothing the Bark server sends is shown until it checks out (`crates/bark/src/check.rs`):

1. The VTXO's point must be the id asked for. A VTXO sent as hex was asked for by nothing, so its id is its own point and the checks below do the work.
2. Each exit transaction is rebuilt: version 3, lock time 0, one input at sequence 0 spending the last one's output, the other outputs with ours put at its index, then a pay-to-anchor output holding the fee. Our output's script is not sent: it is the next transition's spending conditions (a MuSig2 aggregate of the cosigners, BIP 327 over the sorted keys, and for arkoor the tweak added; or a taproot over the expiry clause and the leaf's hash lock), or for the last one the policy's taproot. Amounts are checked as they go: no overflow, no output worth more than its input.
3. The anchor output, the VTXO's amount plus everything paid out along the way, must be the one the node holds at the anchor outpoint. A node that does not know the anchor transaction leaves the VTXO unverified, and says so.
4. The last rebuilt transaction's output must be the id.
5. The expiry height and server key must be bound to the anchor: the first transition is cosigned or hash-locked, whose spending conditions hold the expiry clause. An arkoor transition's tweak is opaque and a policy holds no expiry, so a chain that starts with one, or a VTXO with no exit transactions, could state any expiry and still check out: `expiry_bound` is false and the VTXO is not called verified. (Found in review: a cosigned board restated as arkoor, the server's key dropped from the cosigners and its tweak given as is, keeps the same output key and signature.)
6. Every signature present must verify against its rebuilt transaction: a key spend for cosigned and arkoor, the hash lock's script spend for a leaf with its preimage. A leaf without its preimage, or any missing signature, is "not signed yet"; an invalid one refuses the answer.

A refusal is `502 bark server answer did not verify`, never a page. A policy the server does not build leaves the last transaction unrebuilt: the page shows what decodes, and no claim that it verified.

The tests run every ark-lib vector in both encodings (fixtures in [`fixtures/bark/`](../fixtures/bark/)), and tamper with each field the chain commits to.

### The route

`GET /app/ark/bark/vtxo/<txid>:<vout>` answers:

```json
{
  "id": "125985e9…b7567:0", "version": 2, "amount": 10000, "expiry_height": 101010, "exit_delta": 2016,
  "server_pubkey": "0365a8…2b62", "policy": { "kind": "pubkey", "user_pubkey": "02ed13…1f97" },
  "anchor": { "txid": "abd5d3…c2a3", "vout": 0, "value": 45000, "found": true },
  "rebuilt": true, "expiry_bound": true, "signatures": "valid",
  "txs": [{ "txid": "09f89b…1825", "kind": "branch", "bark": "cosigned", "output": 3, "value": 30000,
            "siblings": [5000, 5000, 5000], "fee": 0, "signature": "valid" }, …]
}
```

Amounts in sats, keys and txids as hex. `kind` is `branch`, `leaf` or `transfer`; `bark` is Bark's own word. `signatures` is `valid` only when the chain was rebuilt whole, anchored on the node, its expiry bound (`expiry_bound`) and every signature verified; otherwise `missing` or `unchecked`. The whole answer for ark-lib's `arkoor3_vtxo` is [`fixtures/bark/answer-arkoor3.json`](../fixtures/bark/answer-arkoor3.json), which a test holds equal to what the server writes.

| Status | Body | When |
|---|---|---|
| 400 | `invalid vtxo id` | Not exactly 64 hex digits, a colon and a vout without leading zeros |
| 404 | `bark is not set up on this network` | No `{NET}_BARK_URL` |
| 404 | `vtxo not found` | The Bark server does not know it |
| 502 | `bark server unavailable` | No connection, no TLS, no HTTP/2 answer, or past 6 s |
| 502 | `bark server answer unreadable` | Not a gRPC reply, over 256 KiB, or a VTXO that does not decode |
| 502 | `bark server answer did not verify` | A check above failed |
| 502 | `upstream unavailable` | The node did not answer about the anchor |
| 503 | `bark lookups busy` | Four lookups already running on the network |
| 429 | `too many requests` | This client started ten lookups at once, then one every 3 s |

**Bounds.** Identical lookups in flight share one call, which runs in its own task so a client leaving does not cancel it for the rest. Answers are kept by id, at most 256: a checked VTXO 10 minutes (a leaf's preimage can still arrive), an unknown id or a refused answer 30 s, a failure to connect not at all. Only a lookup the server does not hold costs a client one of its tokens (`route_rate`) and takes one of the network's four slots (`bark_busy`). Each lookup is one new HTTPS connection (TLS 1.3, rustls with Mozilla's roots), at most 256 KiB read, then one node request for the anchor. Successful answers carry `Cache-Control: public, max-age=60`.

**Logs.** The request event names the route template, never the id ([`LOGGING.md`](LOGGING.md)); `endpoint` is `bark_vtxo`, `source` says whether it was kept, coalesced or asked, and `upstream_error` labels a failure (`not_found`, `timeout`, `unavailable`, `response_too_big`, `decode`, `invalid`, `node_unavailable`).

### The page

`/ark/bark/vtxo/<txid>:<vout>` on any network, and `/ark/bark/hex#<hex>` for a VTXO from its hex. The design is in [`DESIGN.md`](DESIGN.md#ark-not-in-the-prototype). It asks the tip and, in broadcast order, each transaction's status from the public API, stopping at the first the node does not know (a later one spends it), again on every block and every 30 s.

### From its hex

A VTXO can exist only as its serialized bytes: a wallet exports them as hex (barkd's `GET /api/v1/wallet/vtxos/{id}/encoded`), the Bark server may no longer hold it, or it may come from another Bark server. The page `/ark/bark/hex#<hex>` shows it with the same picture, figures and checks as by id. The hex travels in the URL's **fragment**, which a browser never sends, so it reaches no server in a URL, a log or a link preview; the page sends it in the body of `POST /app/ark/bark/vtxo`, which answers as the `GET` does. Nothing asks a Bark server, so the route and the page work on every network, with or without `{NET}_BARK_URL`.

The body is the hex and nothing else: digits in either case, whole bytes, no spaces or line breaks (the page takes those out of a paste). The VTXO is decoded, its anchor asked of the node, and every check above run with the VTXO's own point as its id; "Signatures OK" means what it means by id. A VTXO that cannot be on our chain (its anchor's output index past the anchor's outputs) or whose chain does not hold together is refused.

| Status | Body | When |
|---|---|---|
| 400 | `invalid vtxo hex` | Empty, odd, or anything but hex digits |
| 400 | `vtxo does not decode` | Hex, but not a VTXO in the wire format above |
| 413 | `vtxo too large` | Over 131,072 hex digits |
| 422 | `vtxo did not verify` | A check above failed |
| 502 | `upstream unavailable` | The node did not answer about the anchor |
| 503 | `bark lookups busy` | Four checks already running on the network |
| 429 | `too many requests` | This client started ten checks at once, then one every 3 s |

**Bounds.** At most 64 KiB of VTXO (131,072 hex digits): room for the decoder's cap of 256 exit transactions at 256 bytes each, where real VTXOs have a handful and are 0.3 to 1.5 KB. Hex and decoding are checked first, linear in that body and free. Then one node request for the anchor, and the checks on a blocking thread: at the cap, about 40 ms of key aggregation at worst. Each network has its own four slots and per-client budget for these (`bark_sent`), apart from lookups by id; an answer is kept by the SHA-256 of the bytes, as answers by id are (10 minutes checked, 30 s refused, at most 256), and identical checks in flight share one, so a reload costs nothing.

**Logs.** The request event names the route, `/app/ark/bark/vtxo`, never the body ([`LOGGING.md`](LOGGING.md#rules), rule 5); `endpoint` is `bark_vtxo_hex`, and `upstream_error` is `invalid` or `node_unavailable`.

## Arkade

### Where the VTXO comes from

The server, never the browser, asks the network's Arkade server (`arkd`) through its public REST indexer. `crates/arkade` is a typed client with six named routes and no pass-through: `/v1/info`, `/v1/indexer/vtxos?outpoints=`, `/v1/indexer/vtxos?scripts=` (an address's list), `/v1/indexer/vtxo/{txid}/{vout}/chain`, `/v1/indexer/commitmentTx/{txid}` and `/v1/indexer/batch/{txid}/{vout}/tree`. Every call is a GET and needs no proof of ownership.

**Nothing arkd says is checked.** Its amounts, its states (unspent, spent, swept, preconfirmed) and its signatures are shown as it reported them, and no wording on the page suggests otherwise. Only "on chain" is ours: each exit transaction's status comes from our node. The server checks one thing: arkd's own network (`/v1/info`) must be the one it is configured for, or the lookup fails (`wrong_network`).

### The route

`GET /app/ark/arkade/vtxo/<txid>/<vout>` answers the VTXO, the server's info, its chain, its batches and their trees as arkd gave them, strictly re-typed, plus `onchain`: per chain transaction, where our node has it, or `null`. Recorded answers are in [`fixtures/arkade/`](../fixtures/arkade/).

| Status | Body | When |
|---|---|---|
| 400 | `invalid txid`, `invalid output index`, `unexpected query parameter` | Not 64 hex digits; not a decimal `u32` without sign or padding; any query string |
| 404 | `arkade is not available here` | No `{NET}_ARKADE_URL` |
| 404 | `vtxo not found` | arkd does not know it |
| 502 | `arkade is not answering` | No connection, a body over its cap, a decode failure, or the wrong network |
| 504 | `arkade did not answer in time` | The lookup took over 8 s |
| 503 | `server busy` | 16 lookups already running on the network |
| 429 | `too many requests` | This client asked ten at once, then one every 2 s |

**Bounds.** One lookup is at most 9 calls: the VTXO, the server's info (kept 10 minutes), its chain, then for at most 2 commitments its batches and at most 2 trees. An unknown outpoint costs 1 call. Each call times out at 4 s, the lookup at 8 s. Bodies are capped per route, 16 to 256 KiB; results at 128 chain transactions, 512 tree nodes (a larger tree falls back to this VTXO's own branch and a count), 2 trees and 64 inputs a transaction. Identical lookups in flight share one, answers are kept 30 s and failures not at all, at most 1,024 kept (an unanswered one is let go after 2 minutes). Then at most 128 status reads on our node, 8 at a time, shared by requests that arrive together and kept 10 s or until the next block. Each client has its own `route_rate` table. Answers carry `Cache-Control: no-store`.

**Logs.** The request event names the route template, never the outpoint. `arkade_failed` and `arkade_recovered` carry a fixed label and a count, at the 1st, 2nd, 4th, 8th… failure; arkd's error text is never logged ([`LOGGING.md`](LOGGING.md)).

### The page

`/ark/arkade/vtxo/<txid>:<vout>` on any network. The design is in [`DESIGN.md`](DESIGN.md#ark-not-in-the-prototype). It asks the route again on every block and every 30 s while in view.

### An address's VTXOs

The format is [BOAT-1, "Ark address format"](https://github.com/ark-protocol/boats/blob/master/boat-0001.md) (Steven Roose): bech32m with the prefix `ark` on mainnet and `tark` on any test network, the first 5-bit field element the version. Version 0 is Arkade's: its whole data part, version bits included, decodes to 65 bytes, `arkade_version` (1 byte, only `0` defined), `server_key` (32 bytes, the server's x-only key) and `p2tr_key` (32 bytes, the taproot output key); the script it pays to is `5120<p2tr_key>`. Version 1 is Bark's (`tark1p…`), recognised and not listed; any other version, or an `arkade_version` other than 0, is unknown. `crates/arkade/src/address.rs` parses it, checked against arkd's own test vector (`pkg/ark-lib/encoding_test.go`), a test that pins the 65-byte layout, and a round trip: signet's signer key and a recorded VTXO's script, encoded, list that VTXO.

`GET /app/ark/arkade/address/<address>?page=n` answers one page of 25, as arkd lists them, newest first:

```json
{ "page": 1, "pages": 11, "vtxos": [{ "txid": "5362156e…f50c", "vout": 0, "amount": 1000, "swept": true, … }] }
```

Each VTXO is shaped as `vtxo` in the VTXO route's answer. `pages` is arkd's count, `0` for an address with none; a page past the end lists none. Recorded answers: [`fixtures/arkade/answer-address.json`](../fixtures/arkade/answer-address.json) and `answer-address-last.json`, which a test holds equal to what the server writes.

| Status | Body | When |
|---|---|---|
| 400 | `invalid address` | Over 128 characters, not bech32m, a bad checksum, mixed case, version 0 not 104 data characters, or a key not on the curve |
| 400 | `address is for another network` | `ark` on a test network, `tark` on mainnet |
| 400 | `bark address` | BOAT-1 version 1, Bark's |
| 400 | `unknown ark address version` | Any other version, or an `arkade_version` other than 0 |
| 400 | `invalid page`, `unexpected query parameter` | `page` not 1 to 1,000 without sign or padding; any other query |
| 422 | `address belongs to another arkade server` | Its signer key is neither the server's `signerPubkey` nor one of its `deprecatedSigners` |
| 404, 502, 503, 504, 429 | as the VTXO route | |

**Bounds.** The address is parsed before anything is asked; only the script derived from it reaches arkd, with a fixed page size. One page view is at most 2 calls: the server's info (kept 10 minutes, shared with the VTXO route) and the page. Another server's address costs the info only. Identical pages in flight share one lookup, the info call and its failure included; pages, and another server's answer, are kept 30 s by address and page, at most 1,024; failures are not kept. The body is capped at 256 KiB, the page at 25 VTXOs, each paying to the address's script, or the answer is refused. The route shares the VTXO route's per-client table, its 16 slots per network (a VTXO lookup holds its slot through its node reads) and its 8 s timeout. Answers carry `Cache-Control: no-store`.

**Logs.** The request event names the route template, never the address.

**The page.** `/ark/arkade/address/<address>`, with `?page=n` past the first. The design is in [`DESIGN.md`](DESIGN.md#ark-not-in-the-prototype). It is reached by its URL.
