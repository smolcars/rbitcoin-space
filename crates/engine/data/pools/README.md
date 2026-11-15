# Mining pool list

`pool-list.json` is the list of known Bitcoin mining pools, their coinbase tags and payout addresses, from [bitcoin-data/mining-pools](https://github.com/bitcoin-data/mining-pools) (the `generated` branch, commit `0158b59ac47ac1b6f1df2704c98f2576f6d5391d` of 2026-06-30, generated from `master` at `75d54404acc21656dcf6bd79d5b393e8c5ca97c9`). It is copied unchanged.

`local-pools.json` holds this project's own additions (MIT, ours), same format, ids from 10000 so they never meet upstream's sequential ids. When a refresh from upstream adds the same pool, drop ours: a shared id or name refuses the whole list, and the engine's `shipped_list_parses_whole` test fails.

It is distributed under the MIT License; its copyright notice and permission notice are in [`LICENSE`](LICENSE) beside it, as that licence requires:

> Copyright (c) 2019-2021 btc.com
> Copyright (c) 2021-     0xB10C and contributors

How the server uses it, and how to update it, is in [`docs/API.md`](../../../../docs/API.md#mining).
