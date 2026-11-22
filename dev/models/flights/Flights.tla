---------------------------- MODULE Flights ----------------------------
(* Requests for one upstream path sharing one call: `Flights` in
   crates/server/src/esplora.rs. Each action is one hold of the map's lock
   there, or one step that needs no lock. README.md beside this file says
   which lines each action stands for, and what the model leaves out. *)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Reqs,     \* the requests, each asking for the same path once
    Variant   \* "fixed": today's code. The others are past or possible mistakes:
              \* "handles": holders counted by the call's handles (before #88)
              \* "anycall": a request leaving does not check the call is its own

ASSUME Variant \in {"fixed", "handles", "anycall"}

Calls == 1 .. Cardinality(Reqs)   \* a request starts at most one call
None == 0

VARIABLES
    hot,      \* whether the path's answers are kept for a while (`is_hot`)
    entry,    \* the map's call for the path, or None
    holders,  \* the map's count of requests holding `entry` (`InFlight::holders`)
    answer,   \* per call: "pending", "fresh" (younger than the TTL) or "stale"
    pc,       \* per request: "new", "joined", "leaving" or "gone"
    call      \* per request: the call it joined, or None

vars == <<hot, entry, holders, answer, pc, call>>

Init ==
    /\ hot \in BOOLEAN
    /\ entry = None
    /\ holders = 0
    /\ answer = [c \in Calls |-> "pending"]
    /\ pc = [r \in Reqs |-> "new"]
    /\ call = [r \in Reqs |-> None]

\* The requests inside `Flights::run` on call c, their hold not yet released.
Joined(c) == {r \in Reqs : pc[r] = "joined" /\ call[r] = c}

\* `Arc::strong_count` of call c: the map's handle and each request's.
Handles(c) ==
    Cardinality({r \in Reqs : pc[r] \in {"joined", "leaving"} /\ call[r] = c})
        + (IF entry = c THEN 1 ELSE 0)

Unused == {c \in Calls : c # entry /\ \A r \in Reqs : call[r] # c}

\* `Flights::join`: join the map's call while it is unanswered or its answer
\* is fresh; otherwise start a new one in its place.
Join(r) ==
    /\ pc[r] = "new"
    /\ pc' = [pc EXCEPT ![r] = "joined"]
    /\ IF entry # None /\ answer[entry] \in {"pending", "fresh"}
       THEN /\ call' = [call EXCEPT ![r] = entry]
            /\ holders' = holders + 1
            /\ UNCHANGED entry
       ELSE \E c \in Unused :
            /\ \A d \in Unused : c <= d
            /\ call' = [call EXCEPT ![r] = c]
            /\ entry' = c
            /\ holders' = 1
    /\ UNCHANGED <<hot, answer>>

\* The node answers the call some request is driving (`get_or_init`). Only a
\* hot path's answer is ever fresh.
Answer(c) ==
    /\ answer[c] = "pending"
    /\ Joined(c) # {}
    /\ \E a \in (IF hot THEN {"fresh", "stale"} ELSE {"stale"}) :
           answer' = [answer EXCEPT ![c] = a]
    /\ UNCHANGED <<hot, entry, holders, pc, call>>

\* The TTL passes.
Expire(c) ==
    /\ answer[c] = "fresh"
    /\ answer' = [answer EXCEPT ![c] = "stale"]
    /\ UNCHANGED <<hot, entry, holders, pc, call>>

\* `Leave::drop`, when a request ends: answered, or dropped before it was
\* (its client hung up, or it timed out).
LeaveFixed(r) ==
    /\ pc[r] = "joined"
    /\ pc' = [pc EXCEPT ![r] = "gone"]
    /\ IF entry # None /\ (Variant = "anycall" \/ entry = call[r])
       THEN LET left == IF holders > 0 THEN holders - 1 ELSE 0 IN
            IF left = 0 /\ answer[entry] # "fresh"
            THEN entry' = None /\ holders' = 0
            ELSE holders' = left /\ UNCHANGED entry
       ELSE UNCHANGED <<entry, holders>>
    /\ UNCHANGED <<hot, answer, call>>

\* Before #88, in two steps. Under the lock: remove the call when its handles
\* are the map's and this request's alone. After the lock: let go of the handle.
LeaveCountingHandles(r) ==
    /\ pc[r] = "joined"
    /\ pc' = [pc EXCEPT ![r] = "leaving"]
    /\ IF entry # None /\ entry = call[r] /\ Handles(entry) <= 2
          /\ answer[entry] # "fresh"
       THEN entry' = None
       ELSE UNCHANGED entry
    /\ UNCHANGED <<hot, holders, answer, call>>

DropHandle(r) ==
    /\ pc[r] = "leaving"
    /\ pc' = [pc EXCEPT ![r] = "gone"]
    /\ UNCHANGED <<hot, entry, holders, answer, call>>

Leave(r) == IF Variant = "handles" THEN LeaveCountingHandles(r) ELSE LeaveFixed(r)

AllGone ==
    /\ \A r \in Reqs : pc[r] = "gone"
    /\ UNCHANGED vars

Next ==
    \/ \E r \in Reqs : Join(r) \/ Leave(r) \/ DropHandle(r)
    \/ \E c \in Calls : Answer(c) \/ Expire(c)
    \/ AllGone

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The rules. *)

TypeOK ==
    /\ hot \in BOOLEAN
    /\ entry \in Calls \cup {None}
    /\ holders \in 0 .. Cardinality(Reqs)
    /\ answer \in [Calls -> {"pending", "fresh", "stale"}]
    /\ pc \in [Reqs -> {"new", "joined", "leaving", "gone"}]
    /\ call \in [Reqs -> Calls \cup {None}]

\* The map never keeps a call nobody holds, except a hot path's last answer:
\* its size is bounded by the requests in flight plus the fixed set of hot paths.
NothingLeftBehind ==
    (entry # None /\ ~hot) => Joined(entry) # {}

\* Requests for one path never wait on two node calls at once (docs/SECURITY.md
\* rule 8: concurrent identical requests share one upstream call).
OneCallAtATime ==
    \A c, d \in Calls :
        (answer[c] = "pending" /\ Joined(c) # {} /\
         answer[d] = "pending" /\ Joined(d) # {}) => c = d
=============================================================================
