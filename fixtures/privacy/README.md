# Privacy check fixtures

`mainnet.json` holds 29 mainnet transactions and `signet.json` one signet transaction, read from a node's Esplora API (`GET /api/tx/:txid`) in November 2026, at mainnet heights 976,695 to 976,793 and signet height 331,766, trimmed to the fields the privacy rules read: each input's outpoint and previous output, each output's script, type, address and value. They are public chain data. `web/src/lib/privacy.test.ts` names each by the start of its txid and the case it covers (docs/FRONTEND.md "Privacy check").
