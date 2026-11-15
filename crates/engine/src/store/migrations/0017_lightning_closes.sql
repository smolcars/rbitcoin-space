-- A node's closed channels (docs/STORE.md, "ln_channels"): its closes through these, from either
-- end, without reading its open rows. Closed rows only, so they stay small.
CREATE INDEX ln_channels_closed_one ON ln_channels (node_one) WHERE close_height IS NOT NULL;
CREATE INDEX ln_channels_closed_two ON ln_channels (node_two) WHERE close_height IS NOT NULL;
