# Esplora REST (`/api`)

Part of the parity inventory in [`../COMPAT.md`](../COMPAT.md), which defines the columns, status values and the `Live` legend.

Every row here is answered by rbitcoin's own Esplora. We pass the route through an allow-list with typed parameters (task S2); we never rebuild these answers. What we refuse or change is in [`API.md`](../API.md). JSON field names matched mempool.space's public Esplora key for key on every route compared (block, block list, block status, tx, tx status, outspends, merkle proof, address, address summary, mempool, recent, fee estimates).

## Tip and blocks

| Endpoint | Returns | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| `GET /blocks/tip/height` | Tip height as plain text | rbitcoin Esplora | served | M1 | node | |
| `GET /blocks/tip/hash` | Tip hash as plain text | rbitcoin Esplora | served | M1 | node | |
| `GET /blocks[/:start_height]` | Ten block summaries, newest first | rbitcoin Esplora | served | M1 | node | mempool.space's richer list is `/api/v1/blocks` ([`api-v1.md`](api-v1.md)) |
| `GET /block-height/:height` | Block hash at a height, plain text | rbitcoin Esplora | served | M1 | node | |
| `GET /block/:hash` | Block header fields, tx count, size, weight | rbitcoin Esplora | served | M1 | node | `bits` is the compact target as an integer |
| `GET /block/:hash/header` | 80-byte header as hex | rbitcoin Esplora | served | M1 | node | |
| `GET /block/:hash/status` | Whether the block is on the best chain, and the next block | rbitcoin Esplora | served | M1 | node | |
| `GET /block/:hash/raw` | Whole block as binary | rbitcoin Esplora | served | M1 | node | 1.6 MB for a full block; cache as immutable once buried |
| `GET /block/:hash/txids` | Every txid in the block | rbitcoin Esplora | served | M1 | node | 450 KB for a full block |
| `GET /block/:hash/txid/:index` | One txid by position | rbitcoin Esplora | served | M1 | node | |
| `GET /block/:hash/txs[/:start_index]` | 25 full transactions per page | rbitcoin Esplora | served | M1 | node | An index past the end is `404 not found`, our error body in place of the node's text ([`API.md`](../API.md#error-bodies-are-ours)); one that is not a multiple of 25 is `400` |
| `GET /block-template` | The node's `getblocktemplate` as JSON | rbitcoin Esplora (opt-in flag) | skipped | — | node | Off on a stock node (404), 4.9 MB, and not explorer data. Our engine reads the template over RPC instead |

## Transactions

| Endpoint | Returns | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| `GET /tx/:txid` | Full transaction with prevouts, fee and status | rbitcoin Esplora | served | M1 | node | Also answers for mempool-only transactions |
| `GET /tx/:txid/hex` | Raw transaction as hex | rbitcoin Esplora | served | M1 | node | |
| `GET /tx/:txid/raw` | Raw transaction as binary | rbitcoin Esplora | served | M1 | node | |
| `GET /tx/:txid/status` | Confirmed flag, block hash, height, time | rbitcoin Esplora | served | M1 | node | |
| `GET /tx/:txid/merkle-proof` | Electrum-style merkle branch | rbitcoin Esplora | served | M1 | node | |
| `GET /tx/:txid/merkleblock-proof` | BIP37 merkle block as hex | rbitcoin Esplora | served | M1 | node | |
| `GET /tx/:txid/outspend/:vout` | Whether one output is spent, and by what | rbitcoin Esplora | served | M1 | node | Includes mempool spends |
| `GET /tx/:txid/outspends` | Spend status of every output | rbitcoin Esplora | served | M1 | node | |
| `GET /txs/outspends?txids=` | Spend status for several transactions at once | rbitcoin Esplora | served | M1 | node | Cap the list length at our edge |
| `POST /tx` | Broadcasts a raw transaction, returns its txid | rbitcoin Esplora | served | M1 | doc | Not probed on a shared node: it is a write. Ours checked on regtest only. The only write we allow; size-capped, rate-limited, switchable ([`SECURITY.md`](../SECURITY.md) rule 5) |
| `POST /txs/test` | Test-accepts up to 25 raw transactions without admitting them | rbitcoin Esplora | skipped | — | node | Backs the "test transactions" page. Answered 400 for a malformed body. Not served (404): broadcast is the only write we allow ([`API.md`](../API.md#not-served)), and the owner decided on 2026-11-13 to leave it out, kept when the broadcast page was built on 2026-11-16 (it sends one transaction) |
| `POST /txs/package` | Submits a package of up to 25 transactions | rbitcoin Esplora | skipped | — | doc | A broadcast, so the same caps and switch as `POST /tx`. Not served (404): broadcast is the only write we allow ([`API.md`](../API.md#not-served)), and the owner decided on 2026-11-13 to leave it out, kept when the broadcast page was built on 2026-11-16 (it sends one transaction) |

## Outputs by position (rbitcoin extension)

Not in Blockstream's Esplora. They need no address index, which makes them the cheapest way to look up an output.

| Endpoint | Returns | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| `GET /tx/:txid/out/:vout` | One confirmed output with `spent` and creating status | rbitcoin Esplora | served | M1 | node | Better than `/outspend` plus `/tx` when only one output is needed |
| `GET /block-height/:height/tx/:index` | The transaction at a block position | rbitcoin Esplora | served | M1 | node | Resolves Lightning short channel ids |
| `GET /block-height/:height/tx/:index/out/:vout` | One output by block position | rbitcoin Esplora | served | M1 | node | Lightning funding-output check ([`LIGHTNING.md`](../LIGHTNING.md)) |
| `POST /block-heights/txs/outs` | Up to 300 outputs by position, `null` for a miss | rbitcoin Esplora | served | M1 | node | Batch form; over 300 is 422 |

## Addresses and scripthashes

All of these need `--sh-index` on the node. Unpaged stats and `/utxo` answer 503 above the node's `--max-sh-creates` cap; paged history still works ([`RBITCOIN.md`](../RBITCOIN.md)).

| Endpoint | Returns | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| `GET /address/:address` | Funded and spent counts and sums, confirmed and mempool | rbitcoin Esplora | served | M1 | node | 503 on a large address (mainnet payout address with 16,276 outputs) |
| `GET /address/:address/utxo` | Unspent outputs | rbitcoin Esplora | served | M1 | node | Same 503 rule |
| `GET /address/:address/txs` | Mempool transactions, then the first 25 confirmed | rbitcoin Esplora | served | M1 | node | Works on the large address |
| `GET /address/:address/txs/chain[/:last_seen_txid]` | 25 confirmed transactions per page | rbitcoin Esplora | served | M1 | node | |
| `GET /address/:address/txs/mempool` | Unconfirmed transactions | rbitcoin Esplora | served | M1 | node | |
| `GET /address/:address/txs/summary[/:last_seen_txid]` | Compact rows: txid, net value, height, time, position | rbitcoin Esplora | served | M1 | node | Same keys as mempool.space's route of that name. Cheap way to draw a balance chart |
| `GET /scripthash/:hash` | As `/address/:address`, keyed by scripthash | rbitcoin Esplora | served | M1 | node | |
| `GET /scripthash/:hash/utxo` | Unspent outputs | rbitcoin Esplora | served | M1 | node | |
| `GET /scripthash/:hash/txs` | Mempool, then first confirmed page | rbitcoin Esplora | served | M1 | node | |
| `GET /scripthash/:hash/txs/chain[/:last_seen_txid]` | Confirmed page | rbitcoin Esplora | served | M1 | doc | |
| `GET /scripthash/:hash/txs/mempool` | Unconfirmed transactions | rbitcoin Esplora | served | M1 | doc | |
| `GET /scripthash/:hash/txs/summary[/:last_seen_txid]` | Compact rows | rbitcoin Esplora | served | M1 | doc | |
| `POST /addresses/txs` | One merged history page for up to 300 addresses | rbitcoin Esplora | skipped | — | node | Multi-address wallets and xpub views. mempool.space's REST surface has no equivalent we found. Not served (404): one request asks for up to 300 address-index joins, more load than one client should cause ([`API.md`](../API.md#not-served), [`SECURITY.md`](../SECURITY.md) rule 11). Ask per address |
| `POST /addresses/txs/summary` | Merged compact rows for up to 300 addresses | rbitcoin Esplora | skipped | — | node | Not served, as `POST /addresses/txs` |
| `POST /scripthashes/txs` | As above, by scripthash | rbitcoin Esplora | skipped | — | doc | Not served, as `POST /addresses/txs` |
| `POST /scripthashes/txs/summary` | As above, compact | rbitcoin Esplora | skipped | — | doc | Not served, as `POST /addresses/txs` |

## Mempool and fees

| Endpoint | Returns | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| `GET /mempool` | Count, vsize, total fee, fee histogram | rbitcoin Esplora | served | M1 | node | 220 ms on mainnet; cache for a second or two |
| `GET /mempool/txids` | Every mempool txid | rbitcoin Esplora | served | M1 | doc | Not fetched: 3.6 MB on mainnet. Cache hard or prefer the paged form |
| `GET /mempool/txids/page[/:last_txid]` | Txids in sorted pages | rbitcoin Esplora | served | M1 | node | 670 KB a page |
| `GET /mempool/recent` | The last few accepted transactions, compact | rbitcoin Esplora | served | M1 | node | Returns 10 entries; not a change feed |
| `GET /fee-estimates` | Fee rate by confirmation target, 28 targets | rbitcoin Esplora | served | M1 | node | rbitcoin's 10-minute inclusion product with sub-sat precision. Values differ from mempool.space's (target 1 read 2.18 here and 1 there at the same moment); keys match |

## Parameters and headers

| Feature | Behaviour | Source | Status | M | Live | Note |
|---|---|---|---|---|---|---|
| `X-Bitcoin-Chain-Tip`, `X-Bitcoin-Chain-Tip-Height` | Names the chain view a response was read at | rbitcoin Esplora | served | M1 | node | Block, tx and header routes stamp the live tip; address and scripthash routes stamp the address-index watermark, which can lag the tip. Unstamped: `/mempool`, `/mempool/txids`, `/mempool/recent`, `/fee-estimates`, `POST /tx`, `POST /txs/package` and `/address/:address/txs/mempool` (and its scripthash form). The paged `/mempool/txids/page[/:last_txid]` is stamped with the live tip. Pass through and expose to browsers. mempool.space has nothing like it |
| `?asof=<blockhash>` | Pins a status, outspend, position or address read to an ancestor block | rbitcoin Esplora | served | M1 | node | `/tx/:txid?asof=` is 404 by design; `/tx/:txid/status?asof=` works |

## BlindBit v1

The maintainer-approved routes under `/api/blindbit/v1` are served: info,
block-height, block-hash, tweaks, tweak-index, utxos, spent-index, both filters,
and forward-tx. The node requires `--sp-tweaks`; the original comparison node
had it off, so the original probe returned 404. The allowed routes, parameters
and limits now live in [`API.md`](../API.md#blindbit-v1-silent-payments).

## Not served by rbitcoin

| Endpoint | What it is | Status | M | Live | Why |
|---|---|---|---|---|---|
| `/internal/*` bulk routes | Whole-block and whole-mempool transaction lists | skipped | — | node | 404 over TCP; unix socket only. We may use them server-side when co-located, never expose them |
| `GET /address-prefix/:prefix` | Address autocomplete | skipped | — | node | 404. Out of scope (no prefix index) |
| `/asset/*`, `/assets/*` | Liquid assets | skipped | — | node | 404. Out of scope |
| `GET /broadcast?tx=` | Broadcast through a GET | skipped | — | node | 404 on rbitcoin. A write behind a GET is cacheable and cross-site triggerable |
