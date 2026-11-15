# Ark

Pages for Ark VTXOs: a visitor opens `/ark`, pastes a VTXO's id, and gets its amount, its expiry, the exit path drawn as a picture and the exit transactions, each with where it is on chain. An implementation is shown on a network only when the operator configured a server for it ([`CONFIG.md`](CONFIG.md#ark)); `/app/config` names them per network (`"ark": {"signet": ["bark"]}`), and the header's Ark item and the entry page follow that list ([`FRONTEND.md`](FRONTEND.md#the-apps-own-api)).

| Implementation | Crate | Pages | Private API | Configured by |
|---|---|---|---|---|
| Bark, by Second | `crates/bark` | `web/src/pages/ark/bark/` | `/app/ark/bark/vtxo/<txid>:<vout>` | `{NET}_BARK_URL` |

The entry page's list of implementations is `web/src/pages/ark/implementations.ts`; an implementation adds one entry there, one route list in `web/src/pages/ark/routes.ts`, and its name in `ark()` in `crates/server/src/app_config.rs`.

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

1. The VTXO's point must be the id asked for.
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

`/ark/bark/vtxo/<txid>:<vout>` on any network. The design is in [`DESIGN.md`](DESIGN.md#ark). It asks the tip and, in broadcast order, each transaction's status from the public API, stopping at the first the node does not know (a later one spends it), again on every block and every 30 s.
