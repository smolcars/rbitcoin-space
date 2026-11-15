# Transaction flag fixtures

## `mainnet.json`

68 public mainnet transactions, each `{txid, block, index, flags, hex}`: `flags` is the reference's answer from its `/api/v1/block/:hash/summary`, `index` the transaction's place in its block (0 is the coinbase). Together they set every bit `engine::flags` sets but `SIGHASH_NONE`, which the sample never showed. `flags::tests` holds `flags::of` equal to `flags` on those bits. The layout and the rules: [`docs/API.md`](../../docs/API.md#transaction-flags).
