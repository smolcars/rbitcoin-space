# End markers for batches of channel queries

The Lightning peer asks another node for channels a batch at a time (`query_short_channel_ids`) and awaits one end marker per batch (`reply_short_channel_ids_end`). The marker does not say which batch it ends. `PeerRange` in [`crates/ln/src/gossip.rs`](../../../crates/ln/src/gossip.rs) works that out from the order of events, and [`BatchEnds.tla`](BatchEnds.tla) is that reasoning as a model, checked in every order of its steps for four batches ([`docs/CI.md`](../../../docs/CI.md#models)).

## The rule

| Rule | In plain words | What breaking it costs |
|---|---|---|
| `AMarkerEndsItsOwnBatch` | A marker ends only the batch it answers | A batch is judged before the peer delivered it. One slow batch costs an honest peer two strikes of the two it has (`MAX_WITHHELD`), it loses its turn, and its channels are asked of another peer for nothing |

## The steps and the code

| Model | Code |
|---|---|
| `Ask` | `next_batch` setting `in_flight` and sending the query |
| `PeerEnds` | the peer, not our code: it answers every batch, in the order asked |
| `TimeOut` | `range_tick` taking an `in_flight` older than `BATCH_TIMEOUT`, and counting its marker as still due (`late_ends += 1`) |
| `MarkerArrives` | `handle_reply_short_channel_ids_end`: a marker that is due for a timed-out batch ends nothing; otherwise it ends `in_flight` |

`wire` and `endedBy` are the model's own: which batch each marker answers is exactly what the code cannot see.

## The mistake it must catch

**A timed-out batch's marker is not expected** (`Variant = "uncounted"`, the code before #103):

1. We ask batch 1.
2. The peer finishes it late and sends its marker.
3. Before the marker arrives, batch 1 times out: one strike.
4. The peer is idle again, so we ask batch 2.
5. Batch 1's marker arrives and ends batch 2, which the peer has not started. Whatever of batch 2 is missing counts as withheld: a second strike.

In the code, `a_late_end_marker_does_not_end_the_next_batch` (`crates/ln/src/tests/hostile.rs`) walks these steps.

## What it does not cover

- **A peer that breaks the protocol.** The model's peer answers every batch once, in order. One that skips a marker has its later markers counted as late ones, so its batches end by timeout; one that sends a marker unasked ends its own batch early. Both cost only that peer its own strikes. That is reasoning, not something this model checks.
- **A reconnect.** `peer_disconnected` drops the peer's whole `PeerRange`, and markers do not cross connections.
- **What `judge` decides** once a batch has ended, and the other peers.
- **Whether the code is the model**: see the `verify-models` skill.
