# Bark VTXO test vectors

`vectors.json` holds the test vectors of ark-lib 0.8.1 (`src/test_util/vectors.rs`), the VTXO library of Bark, by Team Second (https://gitlab.com/ark-bitcoin/bark), MIT licensed. They are deterministically generated VTXOs with the transactions they hang from, not coins on any chain: `v2` is the current encoding and `v1` the one without fees.

- `anchor_tx` anchors `board_vtxo`, `arkoor_htlc_out_vtxo` and `arkoor2_vtxo`.
- `round_tx` anchors `round1_vtxo`, `round2_vtxo` and `arkoor3_vtxo`.

`crates/bark` decodes and checks them in its tests.
