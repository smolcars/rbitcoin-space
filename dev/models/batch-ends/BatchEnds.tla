--------------------------- MODULE BatchEnds ---------------------------
(* One Lightning peer answering our batches of channel queries: `PeerRange`
   in crates/ln/src/gossip.rs. An end marker does not say which batch it
   ends, so we must work that out. README.md beside this file maps each
   action to the code and says what the model leaves out. *)
EXTENDS Naturals, Sequences

CONSTANTS
    Batches,  \* how many batches we ask of the peer
    Variant   \* "fixed": today's code.
              \* "uncounted": a timed-out batch's marker is not expected (before #103)

ASSUME Variant \in {"fixed", "uncounted"}

Ids == 1 .. Batches
None == 0
TimedOut == Batches + 1

VARIABLES
    sent,      \* how many batches we have asked
    inFlight,  \* the batch awaited (`PeerRange::in_flight`), or None
    lateEnds,  \* markers still due for batches that timed out (`PeerRange::late_ends`)
    asked,     \* batches the peer has received and not answered, oldest first
    wire,      \* end markers on their way to us, oldest first, each with its batch
    endedBy    \* per batch: None while it runs, TimedOut, or the batch whose marker ended it

vars == <<sent, inFlight, lateEnds, asked, wire, endedBy>>

Init ==
    /\ sent = 0
    /\ inFlight = None
    /\ lateEnds = 0
    /\ asked = <<>>
    /\ wire = <<>>
    /\ endedBy = [b \in Ids |-> None]

\* `next_batch`: the peer is idle, so its next batch is asked.
Ask ==
    /\ inFlight = None
    /\ sent < Batches
    /\ sent' = sent + 1
    /\ inFlight' = sent + 1
    /\ asked' = Append(asked, sent + 1)
    /\ UNCHANGED <<lateEnds, wire, endedBy>>

\* The peer finishes a batch, however late, and sends its end marker. It
\* answers every batch, in the order asked: the connection keeps the order.
PeerEnds ==
    /\ asked # <<>>
    /\ wire' = Append(wire, Head(asked))
    /\ asked' = Tail(asked)
    /\ UNCHANGED <<sent, inFlight, lateEnds, endedBy>>

\* `range_tick`: the batch awaited is older than BATCH_TIMEOUT.
TimeOut ==
    /\ inFlight # None
    /\ endedBy' = [endedBy EXCEPT ![inFlight] = TimedOut]
    /\ inFlight' = None
    /\ lateEnds' = IF Variant = "fixed" THEN lateEnds + 1 ELSE lateEnds
    /\ UNCHANGED <<sent, asked, wire>>

\* `handle_reply_short_channel_ids_end`: a marker arrives. Its batch, the head
\* of `wire`, is what the code cannot see.
MarkerArrives ==
    /\ wire # <<>>
    /\ wire' = Tail(wire)
    /\ IF lateEnds > 0
       THEN /\ lateEnds' = lateEnds - 1
            /\ UNCHANGED <<inFlight, endedBy>>
       ELSE /\ IF inFlight # None
               THEN /\ endedBy' = [endedBy EXCEPT ![inFlight] = Head(wire)]
                    /\ inFlight' = None
               ELSE UNCHANGED <<inFlight, endedBy>>
            /\ UNCHANGED lateEnds
    /\ UNCHANGED <<sent, asked>>

Finished ==
    /\ sent = Batches /\ inFlight = None /\ asked = <<>> /\ wire = <<>>
    /\ UNCHANGED vars

Next == Ask \/ PeerEnds \/ TimeOut \/ MarkerArrives \/ Finished

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The rules. *)

TypeOK ==
    /\ sent \in 0 .. Batches
    /\ inFlight \in Ids \cup {None}
    /\ lateEnds \in 0 .. Batches
    /\ endedBy \in [Ids -> Ids \cup {None, TimedOut}]

\* A marker ends only the batch it answers. Otherwise a batch is judged before
\* the peer delivered it: one slow batch costs an honest peer two strikes and
\* its turn, and its channels are asked of another peer for nothing.
AMarkerEndsItsOwnBatch ==
    \A b \in Ids : endedBy[b] \in {None, TimedOut, b}

=============================================================================
