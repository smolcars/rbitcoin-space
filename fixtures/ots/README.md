# OpenTimestamps proofs

Real proofs for the timestamp page (`web/src/pages/timestamp`, docs/FRONTEND.md "Timestamp proofs").

- `two-blocks.ots` and `pending.ots` are the test data of rust-opentimestamps (`LARGE_TEST` and `SMALL_TEST` in `src/lib.rs`), at commit `c87e3e18284fd1bb9456e50721aa4e2796aed057` of https://github.com/opentimestamps/rust-opentimestamps, written out byte for byte. That project is dual-licensed MIT or Apache-2.0; these are used under MIT.
  - `two-blocks.ots` is a complete proof for the SHA-256 digest `6fd9c1c4f096b77e6d4457bac1c7f51010d318db483f2868d3795843f098d378` (the file itself was not published). It has two Bitcoin attestations, mainnet blocks 449 397 and 449 399, and two calendars' promises from before they were kept.
  - `pending.ots` has only two calendars' promises, for the digest `a70dfe69c5a0d62816781abb6e1777854718624a0d194231adb14c32ee5438a4`.
- `blocks.json` holds mainnet's answers for those two blocks, `GET /api/block-height/:height` and `GET /api/block/:hash/header`, recorded from rbitcoin v0.9.2 on 20 November 2026. Public chain data.

## Licence of `two-blocks.ots` and `pending.ots`

They are copied from rust-opentimestamps, used under its MIT licence, whose notice follows as that project gives it (its `LICENSE`, at the commit above):

```text
MIT License
===========

Copyright (c) The OpenTimestamps Developers

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```
