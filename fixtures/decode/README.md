# Payment string test vectors

Public specification examples, for the decoder (`crates/ln/src/decode.rs`, docs/API.md "Decoding").

- `bolt11.json`: every example of BOLT 11 ("Examples" and "Examples of Invalid Invoices" in `11-payment-encoding.md`), taken from the `lightning/bolts` repository at commit `191462825ae341f0a27098765c075f01ca9bc6c2`, each with its heading as `comment`.
- `offers-test.json`, `format-string-test.json`: BOLT 12's offer and string-format vectors, `bolt12/` in the same repository and commit, unchanged.
- The LNURL example is LUD-01's, from `lnurl/luds` at commit `913c49e5b65081473eed7889eee5f806dd30f049`; it is inline in the tests, as are the Lightning addresses (LUD-16's forms).
- The Bark addresses are the test vectors of ark-lib 0.8.1 (`ark/address.rs`), Bark's VTXO library by Team Second, MIT licensed; inline in `crates/bark`'s tests.
