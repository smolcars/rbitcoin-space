-- What each replacement keeps for comparing its two versions (docs/STORE.md, "replacements";
-- docs/MEMPOOL.md, "The replacement record"): each side's outputs, as the tracker kept them while
-- the transaction was in the mempool, and its input count, with how many inputs both spend. Rows
-- written before this migration have them all NULL: the compare view says they were not recorded.
ALTER TABLE replacements ADD COLUMN outputs BLOB;        -- the replaced transaction's outputs
ALTER TABLE replacements ADD COLUMN by_outputs BLOB;     -- the replacement's (engine::outputs)
ALTER TABLE replacements ADD COLUMN inputs INTEGER;      -- the replaced transaction's input count
ALTER TABLE replacements ADD COLUMN by_inputs INTEGER;   -- the replacement's
ALTER TABLE replacements ADD COLUMN shared INTEGER;      -- inputs both spend
