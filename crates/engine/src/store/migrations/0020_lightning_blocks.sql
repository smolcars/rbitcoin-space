-- The channels a block opened and closed (docs/STORE.md, "ln_channels"), by the block's hash, so a
-- block that left the chain finds none. Closes only in the second, so it stays small.
CREATE INDEX ln_channels_open_hash ON ln_channels (open_hash);
CREATE INDEX ln_channels_close_hash ON ln_channels (close_hash) WHERE close_hash IS NOT NULL;
