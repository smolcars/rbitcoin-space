-- What each end of an open channel charged, as gossip showed it (docs/STORE.md, "ln_fees"):
-- the newest 50 changes a direction, deleted when the channel closes.
CREATE TABLE ln_fees (
    scid INTEGER NOT NULL,
    -- 0 node one's policy, 1 node two's, as the channel route's node_one and node_two.
    side INTEGER NOT NULL,
    -- The channel update's own timestamp, Unix seconds: when the end set these fees.
    time INTEGER NOT NULL,
    -- Fee rate, ppm, and base fee, msat.
    fee_rate INTEGER NOT NULL,
    base_fee INTEGER NOT NULL,
    -- lnd's inbound fee, signed (a discount is negative): null when the update carries none.
    inbound_base INTEGER,
    inbound_rate INTEGER,
    PRIMARY KEY (scid, side, time)
) STRICT, WITHOUT ROWID;

-- The stretches the server was recording fee changes: one row per run, its end moved forward at
-- every round. A page draws no fee line across the time between two rows.
CREATE TABLE ln_watched (
    start INTEGER PRIMARY KEY,
    end INTEGER NOT NULL
) STRICT;
