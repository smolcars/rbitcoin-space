-- The penalties list (docs/STORE.md, "ln_channels"): newest sweep first, and their count, through
-- this. Breached rows only, so it holds a handful of entries.
CREATE INDEX ln_channels_penalties ON ln_channels (penalty_height, scid) WHERE penalty_txid IS NOT NULL;
