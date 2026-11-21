-- A node's closed channels newest first (docs/STORE.md, "ln_channels"): its close record reads only
-- its newest closes, from either end, and stops there, whatever the node's history. These serve
-- 0017's lookups by node too, so they replace its indexes.
DROP INDEX ln_channels_closed_one;
DROP INDEX ln_channels_closed_two;
CREATE INDEX ln_channels_closed_one ON ln_channels (node_one, close_height, scid) WHERE close_height IS NOT NULL;
CREATE INDEX ln_channels_closed_two ON ln_channels (node_two, close_height, scid) WHERE close_height IS NOT NULL;
