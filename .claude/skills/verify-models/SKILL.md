---
name: verify-models
description: Check a change against the formal models of rbitcoin.space's concurrent code (dev/models). Use when you touch code a model covers (today the shared /api call bookkeeping, `Flights` in crates/server/src/esplora.rs), when the CI job `models` fails, or when you add shared in-flight state, a retry or a state machine that deserves a model.
---

# Verify the models

A model under `dev/models/<name>/` is a TLA+ spec of one piece of concurrent bookkeeping. The checker tries every order of its steps, up to a stated number of actors, and reports any order that breaks a rule. A test tries the orders someone thought of.

## Does your change touch one?

Each `dev/models/*/model.json` lists the code it describes under `covers`: a file and the lines from one pattern to another. The check hashes that text. If you changed it, the check fails and tells you; you do not have to remember.

| Model | Code | Rules |
|---|---|---|
| `dev/models/flights` | `Flights`, `InFlight`, `Leave` in `crates/server/src/esplora.rs` | A call nobody holds never stays in the map; requests for one path never wait on two node calls |

## Run it

```sh
python3 -I dev/models/check.py
```

It needs Java 11 or later and the network once: it downloads the TLC checker and holds it to a pinned checksum. It takes about 2 s. CI runs the same command in the `models` job.

## Read a failure

- **"… changed in the part … describes."** You edited covered code. Open the model's `README.md`: its table maps each step of the spec to the code. Compare them. What matters is what happens under one hold of a lock, and in what order. If your change kept that (a rename, a comment, a log line), run `python3 -I dev/models/check.py --pin` and commit `model.json`. If it changed that, change the spec first to say what the code now does, run the check, and pin only when it passes. Never pin to make a failure go away without the comparison.
- **"today's design breaks RULE."** The spec, as it describes the code, allows an order of steps that breaks the rule. This is a finding about the code until shown otherwise. Read the path with the pstack `/statechart` skill, which shows the shortest path to the broken rule in plain words, or run TLC yourself on the spec for the trace. Then replay the path against the real code as a test, one step per action. If the code cannot take a step the spec allows, the spec is wrong: fix the spec. If it can, fix the code. Do not weaken the rule.
- **"the mistake … must break RULE and broke nothing."** A change to the spec made it blind to a past bug. The spec is wrong, or the rule was weakened: undo that.

## Change a model on purpose

1. Change the code and the spec together, in one pull request.
2. Keep every entry under `mistakes` in `model.json`: each is a past bug the model must still catch. Add one when you fix a new ordering bug: write the wrong step as a `Variant` of the spec, name the rule it breaks, and give the pull request that fixed it in `was`.
3. Run the check, then `--pin`, and say in the pull request what you compared.

## Add a model

Worth it for shared state that several requests or tasks change, a retry with a timer, or a state machine, when a wrong order costs a leak, a duplicate call or a lost update. Make `dev/models/<name>/` with the spec, a `model.json` like `flights/model.json` and a `README.md` like `flights/README.md`. Keep the actors few enough that the check stays within seconds: the `models` job has a time limit ([`docs/CI.md`](../../../docs/CI.md#budget)). A model with no mistake that breaks each rule is not accepted by review: a rule never seen to fail proves nothing.
