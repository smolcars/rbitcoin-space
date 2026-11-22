---------------------------- MODULE FeeHold ----------------------------
(* The `fees` topic waiting for its block: the loop of `run` and `serve` in
   crates/server/src/ws/fees.rs. A fee message on another tip than the block
   last announced is held until the two agree, for at most `Hold`. Each action
   is one pass of the loop, or something outside it. README.md beside this
   file maps each action to the code and says what the model leaves out. *)
EXTENDS Naturals

CONSTANTS
    Hold,      \* how long a message waits for its block (`HOLD`)
    Interval,  \* the publisher's tick (`WS_MEMPOOL_INTERVAL_MS`), in the same unit
    MaxTime,   \* how long the model runs
    Tips,      \* how many blocks are found
    Variant    \* "fixed": today's code. The others are past mistakes:
               \* "nohold": a message goes out whatever block was announced (before #67)
               \* "norelease": only the tick ends a hold (#67 before its review)
               \* "resetonly": the hold's deadline only resets the tick (before #76)

ASSUME Variant \in {"fixed", "nohold", "norelease", "resetonly"}

None == MaxTime + Hold + 1   \* no time, for `held`

VARIABLES
    now,          \* the clock
    announced,    \* the block the `blocks` topic last announced
    projected,    \* the block the fee answer is worked out on
    version,      \* the answer's content, which changes as the mempool does
    published,    \* the answer last published: its block and its content
    held,         \* since when a message has waited for its block (`held`), or None
    tickDue,      \* when the tick fires next
    annPending,   \* an announcement the loop has not seen yet (`announced.changed()`)
    projPending,  \* a projection on a new tip the loop has not seen yet
    woke,         \* what woke the loop's last pass
    early         \* whether a message ever went out ahead of its block

vars == <<now, announced, projected, version, published, held, tickDue,
          annPending, projPending, woke, early>>

Init ==
    /\ now = 0
    /\ announced = 0
    /\ projected = 0
    /\ version = 0
    /\ published = <<0, 0>>
    /\ held = None
    /\ tickDue = 0
    /\ annPending = FALSE
    /\ projPending = FALSE
    /\ woke = "nothing"
    /\ early = FALSE

HoldTimer == Variant \in {"fixed", "resetonly"}
ReleaseDue == HoldTimer /\ held # None /\ now >= held + Hold

-----------------------------------------------------------------------------
(* Outside the loop. *)

\* The `blocks` topic announces the next block.
Announce ==
    /\ announced < Tips
    /\ announced' = announced + 1
    /\ annPending' = TRUE
    /\ UNCHANGED <<now, projected, version, published, held, tickDue, projPending, woke, early>>

\* The projection reaches the next block, before or after its announcement.
Project ==
    /\ projected < Tips
    /\ projected' = projected + 1
    /\ projPending' = TRUE
    /\ UNCHANGED <<now, announced, version, published, held, tickDue, annPending, woke, early>>

\* The mempool changes, and the fee answer with it.
Change ==
    /\ version < 1
    /\ version' = version + 1
    /\ UNCHANGED <<now, announced, projected, published, held, tickDue,
                   annPending, projPending, woke, early>>

\* Time passes only while nothing is due: a ready branch of `select!` runs
\* before the clock moves.
TimePasses ==
    /\ now < MaxTime
    /\ ~annPending /\ ~projPending
    /\ now < tickDue
    /\ ~ReleaseDue
    /\ now' = now + 1
    /\ UNCHANGED <<announced, projected, version, published, held, tickDue,
                   annPending, projPending, woke, early>>

-----------------------------------------------------------------------------
(* The loop: one action is one pass. *)

\* `announced.changed()`: a block announced while a message waits brings the tick forward.
SeeAnnounced ==
    /\ annPending
    /\ annPending' = FALSE
    /\ tickDue' = IF held # None THEN now ELSE tickDue
    /\ woke' = "event"
    /\ UNCHANGED <<now, announced, projected, version, published, held, projPending, early>>

\* The projection's stream: one on a new tip brings the tick forward.
SeeProjected ==
    /\ projPending
    /\ projPending' = FALSE
    /\ tickDue' = now
    /\ woke' = "event"
    /\ UNCHANGED <<now, announced, projected, version, published, held, annPending, early>>

\* `serve`: the answer goes out unless it is the one last published, or it is
\* on another block than the one announced and has not waited `Hold`.
Serve ==
    LET msg == <<projected, version>>
        agrees == announced = projected
        since == IF held = None THEN now ELSE held
        waits == Variant # "nohold" /\ ~agrees /\ now - since < Hold
    IN  IF published = msg
        THEN held' = None /\ UNCHANGED <<published, early>>
        ELSE IF waits
             THEN held' = since /\ UNCHANGED <<published, early>>
             ELSE /\ held' = None
                  /\ published' = msg
                  /\ early' = (early \/ (~agrees /\ now - since < Hold))

\* The tick.
Tick ==
    /\ now >= tickDue
    /\ tickDue' = now + Interval
    /\ Serve
    /\ woke' = "tick"
    /\ UNCHANGED <<now, announced, projected, version, annPending, projPending>>

\* The hold's deadline: `sleep_until(held + HOLD)`, armed on each pass while a
\* message waits. Today it runs the tick's work.
Deadline ==
    /\ ReleaseDue
    /\ woke' = "deadline"
    /\ IF Variant = "resetonly"
       THEN tickDue' = now /\ UNCHANGED <<published, held, early>>
       ELSE Serve /\ UNCHANGED tickDue
    /\ UNCHANGED <<now, announced, projected, version, annPending, projPending>>

Finished ==
    /\ now = MaxTime
    /\ UNCHANGED vars

Next ==
    \/ Announce \/ Project \/ Change \/ TimePasses
    \/ SeeAnnounced \/ SeeProjected \/ Tick \/ Deadline
    \/ Finished

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The rules. *)

TypeOK ==
    /\ now \in 0 .. MaxTime
    /\ announced \in 0 .. Tips
    /\ projected \in 0 .. Tips
    /\ version \in 0 .. 1
    /\ published \in (0 .. Tips) \X (0 .. 1)
    /\ held \in (0 .. MaxTime) \cup {None}
    /\ tickDue \in 0 .. MaxTime + Interval
    /\ woke \in {"nothing", "event", "tick", "deadline"}

\* A fee message on another block than the one announced never goes out before
\* it has waited `Hold`. Otherwise a client reads fees for a block it has not
\* been told of, or for the block before the one it was just told of.
NeverAheadOfItsBlock == ~early

\* A message never waits longer than `Hold`. Otherwise fees stay stale for as
\* long as the tick's interval, up to a minute, whenever the block is late.
OutByTheDeadline == held # None => now <= held + Hold

\* A pass the hold's deadline woke ends the hold. Otherwise the deadline is
\* still due on the next pass and the one after: the loop spins a core, and
\* never returns on a paused clock.
ADeadlineEndsTheHold == woke = "deadline" => ~ReleaseDue

=============================================================================
