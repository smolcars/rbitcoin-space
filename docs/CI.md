# CI and testing

## Budget

**A pull request finishes its checks in under 4 minutes with a warm cache.** This is a hard rule, measured as wall-clock time from push to the `ci-ok` check. Runners are GitHub's free hosted runners.

A PR that adds a slower step must make room for it or move it out of the PR path (to a scheduled or post-merge job).

**Each job has a limit of its own,** a little above its time on the day it was set (the `e2e` shards' with room for the pages being added, [below](#browser-test-shards)), so a job that drifts is named the moment it does, not after thirty merges have each added a little:

| Job | Limit | Warm, 2026-11-13 |
|---|---|---|
| `rust` | 170 s | 92 to 121 s |
| `e2e`, each of its five shards | 180 s | 62 to 93 s with three; 68 to 106 s with four, on 2026-11-14; 97 to 162 s with five, on 2026-11-21 ([below](#browser-test-shards)) |
| `web` | 75 s | 30 to 39 s |
| `models` | 30 s | 16 s on its first run, 2026-11-22 |
| `doc-pointers` | 20 s | 6 s on its first run, 2026-11-22: the check takes 0.5 s and the rest is the checkout |

The owner raised the budget from 3 to 4 minutes on 2026-11-15, and each limit by about a quarter (from 135, 145 and 60 s), as the project grew: a `rust` job 2 s over its limit had failed a pull request that added one small test. The whole run is `changes`, the slowest job and `ci-ok`, so the 180 s shard limit leaves about a minute of the four.

The job's last step, [`.github/job-limit.sh`](../.github/job-limit.sh), writes the job's time to the run's summary and fails a pull request's job that went over, when its Rust cache was a warm, exact hit. A cold run (a new lockfile or toolchain) and a `master` push only warn: failing them would stop `rust-cache` from saving the cache that makes the next run warm. The `rust` and `e2e` jobs also list their ten slowest tests in the summary ([`.github/slowest.py`](../.github/slowest.py), from nextest's and Playwright's JUnit reports).

### When a job goes over

Make room in the same pull request; never raise a limit to pass. In order: shrink or delete a test that re-proves something slowly (a random test runs a few steps in the suite and its long form behind `#[ignore]`, with the command beside it); replace a real wait with an event or a paused clock; stop building what no test needs. Read the summary's slowest tests first. Raise a limit only in a pull request that does nothing else and says why the time is worth it.

**An `e2e` shard is a job like any other:** each has the limit above and fails alone, and each lists its own slowest tests. Make room the same way. Moving tests from one shard to another is not making room: Playwright cuts the list by count, in file order, so every test added moves the cut. When one shard stays far above the others, or every shard is near its limit with its tests a small part of its time, another shard is a limit change, made the same way: in a pull request that does nothing else, with three warm runs measured.

## How it stays fast

1. **One workflow, one required check.** `ci.yml` ends in a `ci-ok` job that depends on every other job. Branch protection requires only `ci-ok`, so skipped jobs never block a merge.
2. **Run only what changed.** A first `changes` job maps changed paths to jobs. A docs-only PR runs nothing but [`doc-pointers`](#doc-pointers) and `ci-ok`. On `master`, a push that touches code runs every job, which verifies the merge and refreshes the caches; a docs-only push runs nothing but `changes`, `doc-pointers` and `ci-ok`.
3. **Jobs run in parallel,** never chained unless one needs another's output.
4. **Caches are written on `master` and read on PRs.** GitHub scopes caches by branch: a PR can read `master`'s cache but not another PR's. So `master` pushes save caches and PR runs only restore them. The `rust` and `e2e` jobs each cache the cargo registry and `target/`. The `e2e` shards share one key, so only the first saves it: a second save of the same key fails with a warning. `rust-cache`'s key leaves out the `[profile]` sections of `Cargo.toml`, so the workflow puts a checksum of the profiles, as cargo parses them, in its `key` input (`.github/profiles-key.py`). Without that, a changed profile restores the old cache as an exact hit, every run rebuilds what the profile touches and no run saves it. `bun install` from the registry is faster than restoring a cache, and so is downloading Playwright's headless Chromium, which `e2e` does while it compiles.
5. **Cancel superseded PR runs; queue every `master` run.** A new push to a PR cancels its run in progress. Each push to `master` gets a run that is not cancelled: they wait in one queue (`queue: max`, up to 100 waiting, which a burst of merges never nears) and run one at a time in the order they joined it, so every merge is verified and each run restores the cache the one before it saved. Side by side (a group per commit), two runs that missed the cache would both save the same new key, and the second save is refused with a warning. `cancel-in-progress: false` alone, the earlier setting, protects only the run in progress: GitHub keeps one *pending* run per concurrency group and cancels it when a newer one is queued ([GitHub's docs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)). On 2026-11-13 that cancelled the runs of two merges pushed seconds apart while a run was in progress; only the docs-only pushes after them ran, and `master` looked green. The release workflow queues the same way, since each `master` run publishes its commit's image; the audit and the other-browser tests let a newer run cancel an older one, since the newer run checks a tree that holds the older one's changes.
6. **No compiling tools in CI.** Tools are installed as prebuilt binaries.
7. **Slow waits overlap.** The `e2e` job starts the regtest node and the browser download in the background, then compiles while the node mines.
8. **Lean debug builds.** CI builds without full debug info to cut compile time and cache size. Some code is optimised even there: secp256k1's C library, which at `-O0` made signature checks most of the Lightning tests' time (a test of 1,500 announcements took 6.9 s; optimised, 0.3 s), and the link preview cards' drawing (`card`, its rasterizer and its compressor), which unoptimised took about a second a card. They build once into the cache.
9. **The test binaries run at once.** [cargo-nextest](https://nexte.st) runs every test as its own process, eight at a time on the runner's four cores, since most slow tests wait on a socket or a timer ([`.config/nextest.toml`](../.config/nextest.toml)). `cargo test` ran the 28 test binaries one after another, each waiting for its slowest test. nextest is a prebuilt binary checked against a pinned checksum; it adds nothing to the product or the lockfile. Doc tests, which nextest does not run, run after it with `cargo test --doc`. Examples are not built for the tests: clippy already checks they compile.
10. **Browser tests run as five shards, each on its runner's four cores.** The `e2e` job is a matrix of five runners. Each builds the server and frontend, starts its own node and server, and runs a fifth of the tests with four Playwright workers (`E2E_SHARD=i/n` in [`web/scripts/e2e.sh`](../web/scripts/e2e.sh), passed to Playwright's `--shard`). Playwright runs a project another depends on whole in every shard, so the script runs Playwright twice: the tests that share the node, sharded, then the tests that mine, sharded and with `--no-deps`. Each run writes a JUnit report, and the summary reads both.
11. **Every job has a timeout of 10 minutes.** A hung job fails fast; a test past 30 s fails too (nextest's `slow-timeout`).

## Jobs

| Job | Runs when | Does |
|---|---|---|
| `changes` | always | Decides which jobs below run. Pull requests run only the jobs their paths need; a `master` push runs every job when it touches code and none when it touches only docs |
| `rust` | Rust (`crates/`, the cards' pictures in `fixtures/cards/`, and the load generator in `dev/load/`), lockfile, `.config/nextest.toml` or workflow changes | Format check, clippy with warnings denied, tests with nextest, doc tests |
| `web` | `web/`, the files the frontend imports from `design/` (`tokens.css`, `logo.svg`, `fonts/`) or workflow changes | Type check (both tsconfigs), `oxlint` with type-aware rules and the `oxfmt` format check, unit tests, production build, bundle-size check |
| `e2e` | anything `rust` or `web` runs for, or `dev/regtest/` | `bun run e2e` ([`FRONTEND.md`](FRONTEND.md#browser-tests)): the server and frontend built from the PR, a regtest node with the known chain, Playwright in headless Chromium. Five shards, each on a runner of its own |
| `image` | anything `web` runs for, any `Cargo.toml`, `rust-toolchain.toml`, `Dockerfile` or `.dockerignore`; pull requests only | Builds the Docker image's frontend stage, so a Dockerfile that cannot build the frontend fails before merge. The Rust stage is left to the post-merge build, so [`.github/image-inputs.py`](../.github/image-inputs.py) checks what that build needs first: every workspace member is let into the build, copied and touched, and the image's Rust and Bun are the versions `rust-toolchain.toml` and `web/package.json` pin |
| `models` | Rust (`crates/`), `dev/models/` or workflow changes | The [models](#models) of concurrent code: each checked in every order of its steps, each past mistake shown to break it, and the code each describes compared with what it was last read against |
| `doc-pointers` | always, without waiting for `changes` | Fails on a link or a doc citation whose file, heading or section does not exist ([below](#doc-pointers)) |
| `ci-ok` | always | Fails if any job above failed |

Outside the PR path, daily and when a lockfile changes on `master`: the [dependency audit](#dependency-audit) (`audit.yml`). Weekly: the browser tests in [other browsers](#other-browsers) (`browsers.yml`). After merge to `master`, and on a version tag: the [release workflow](#releases) (`release.yml`).

## Models

A test tries the orders of events its author thought of. Where requests or tasks share state, the bug is an order nobody thought of: two requests leaving one shared node call together left it in memory for good (#88). The test written for that fix runs 20,000 rounds on eight threads to meet the order by chance: with the bug put back it left 1 to 10 calls behind in each of ten runs, and passed once on a busy machine. A model checker tries every order, and finds this one in six steps.

Each folder under [`dev/models/`](../dev/models) holds one model: a TLA+ spec of a piece of bookkeeping, a `README.md` that maps each step of the spec to the code and says what the model leaves out, and a `model.json` for the check. [`dev/models/check.py`](../dev/models/check.py) runs them all with TLC, a prebuilt checker held to a pinned checksum, on the Java the runner already has:

- **The rules hold on today's design,** in every order of its steps, for the number of actors `model.json` names.
- **Each recorded mistake breaks its rule.** A mistake is the spec with one step written as it once wrongly was. A rule that no mistake breaks was never seen to fail, and a spec changed until it no longer catches a past bug fails here.
- **The code is the code the spec was read against.** `model.json` records a checksum of the lines each spec describes. Change them and the check fails until someone has compared the two and recorded the new text (`--pin`). A model does not read the code; this is what keeps it from describing code that is gone.

| Model | Describes | Rules |
|---|---|---|
| [`flights`](../dev/models/flights/README.md) | Identical requests sharing one call: a node call (`Flights` in `crates/server/src/esplora.rs`), a kept answer's computation (`Answers` in `answers.rs`) and a card's build (`Cards` in `cards.rs`) | A call nobody holds never stays in the map; requests for one key never wait on two calls at once |
| [`batch-ends`](../dev/models/batch-ends/README.md) | A Lightning peer's end markers for our batches of channel queries (`PeerRange` in `crates/ln/src/gossip.rs`) | A marker ends only the batch it answers |
| [`fee-hold`](../dev/models/fee-hold/README.md) | A `fees` message waiting for its block's announcement (`run` and `serve` in `crates/server/src/ws/fees.rs`) | A message never goes out ahead of its block, never waits longer than the hold, and the hold's deadline ends the hold |

How to read a failure, change a model with its code, or add one: the `verify-models` skill ([`.claude/skills/verify-models/SKILL.md`](../.claude/skills/verify-models/SKILL.md)).

## Doc pointers

[`dev/doc-pointers/check.py`](../dev/doc-pointers/check.py) fails on a pointer whose target is gone, and prints its file and line, the dead target and the nearest heading or file that exists. It reads every file git tracks and checks:

- **Every relative link in a `.md` file,** to a file and to its `#anchor`. An anchor is checked as the page it lands on is rendered: under GitHub's rule for the repository's files, and under the public docs' own rule (`slug` in `web/src/docs/markdown.ts`) for a `/docs/...` link or a `#anchor` in `web/docs/`.
- **Every citation of a doc elsewhere,** in code, comments, scripts and workflows: `docs/<NAME>.md`, `docs/<NAME>.md#anchor`, and one or more section names quoted after it (`docs/<NAME>.md "Section"`, `docs/<NAME>.md, "Section"`, `docs/<NAME>.md ("One", "Two")`, a name running on to the next comment line). A section is a heading, a heading's words before a colon or a bracket ("Idea" for "Idea: sediment, quietly"), or the bold words a paragraph or list item opens with.

It runs on every pull request and push, docs-only ones too, since a pointer goes stale from either end. It does not read `docs/TODO.md`, which no pull request edits, or the shipped migrations, which `CHECKSUMS` freezes. It does not check external links, a numbered rule (`docs/SECURITY.md rule 14`), a section quoted after other words, or a doc named without `docs/`. Run it, and its tests, from the repository root:

```sh
python3 -I dev/doc-pointers/check.py && python3 -I dev/doc-pointers/test_check.py
```

## Dependency audit

`audit.yml` checks what we ship against the advisory databases ([`SECURITY.md`](SECURITY.md) rule 20). It runs daily, on manual dispatch, and on a push to `master` that changes `Cargo.lock`, `web/bun.lock`, `dev/audit/` or the workflow. Never on a pull request: a new advisory can land on any day, whether or not anyone opens a PR, and the PR budget has no room for it.

[`dev/audit/audit.py`](../dev/audit/audit.py) runs both checks:

- `Cargo.lock` against RustSec with `cargo-audit`, a pinned release binary whose checksum the workflow verifies. Every RustSec finding fails it: vulnerabilities, and the `unsound`, `unmaintained` and `yanked` warnings.
- `web/bun.lock`, dev dependencies included, with `bun audit`, at the version `web/package.json` pins. It asks the npm registry, which serves GitHub's advisories; the fixed versions, which `bun audit` does not report, come from GitHub's advisory API.

A clean run takes about 30 s, 13 of them for the audit itself, most of that fetching the advisory database. That is too little to be worth a cache.

**On a finding** the run fails and its `report` job opens one issue, *Dependency audit found advisories*. The issue names each advisory, the package and version, how we depend on it (direct, or the chain of packages that pulls it in), and the fixed versions. While that issue is open, a later run edits it and adds one comment only when the findings change; otherwise it says nothing. A clean run says nothing and closes nothing: close the issue once its findings are fixed or accepted. Closing it with a finding still open brings it back on the next run. The `audit` job holds only a read token; `report`, which runs no third-party code, alone may write issues. If a tool itself fails (the database unreachable, say), the run fails without an issue, and GitHub's failed-run notification is the signal.

**To accept a finding on purpose,** add it to [`dev/audit/ignore.toml`](../dev/audit/ignore.toml) with its id, the reason it does not apply to how we use the package, and the date it was reviewed. An entry without all three fails the audit, so an ignore is never silent. Remove the entry once the dependency is upgraded. A `yanked` release has no advisory id: upgrade it.

**Locally,** from the repository root, with Python 3.11 or later, and [`cargo-audit`](https://github.com/rustsec/rustsec/releases) and `bun` on `PATH`:

```sh
python3 -I dev/audit/audit.py   # exit 0: clean; 1: the issue's Markdown on stdout; 2: a tool failed
```

`CARGO_LOCK=<file>` and `WEB_DIR=<directory with package.json and bun.lock>` point it at a temporary copy, for trying a change to the script.

## Other browsers

`browsers.yml` runs `bun run e2e` in Playwright's WebKit and Firefox, each at desktop and phone width: four jobs at once ([`FRONTEND.md`](FRONTEND.md#other-engines)). It runs every Monday and on manual dispatch (`gh workflow run browsers.yml`), never on a pull request, whose budget has no room for it. Its token reads only. Its jobs restore the cargo cache the `e2e` job saves on `master` and save none of their own; each engine's browser build is cached under the Playwright version, and its system libraries come from apt on every run. Each job times out at 20 minutes. Firefox runs under Xvfb, still headless: without a display on Linux it finds no GL driver and has no WebGL at all, so the transaction grid would only ever show its stand-in.

A failure here means a page broke in an engine Chromium hides, or a test assumed Chromium. It is not Safari on a Mac or an iPhone: Playwright builds its own WebKit, here on Linux, so a green run does not replace a look in real Safari.

## Releases

`release.yml` builds the server's image ([`DEPLOY.md`](DEPLOY.md#the-image)) for linux/amd64 and linux/arm64, each natively on a runner of its architecture, and joins them into one multi-architecture image. Never on a pull request.

| Trigger | Does |
|---|---|
| A push to `master` touching anything that goes into the image, `deploy/` or the workflow | Build, check and join both architectures, then publish the image as `sha-<commit>` and `master` |
| A pushed tag `vX.Y.Z` | The same, then publish the image as `X.Y.Z` and `latest`, and create the release |
| A manual dispatch, on any ref, a tag's included | A dry run: build, check and join. Publishes nothing |

Runs are never cancelled: each ref's runs wait in one queue (`queue: max`) and run in the order they joined it, which is usually but not always the order they were pushed, so every merge's image is published.

| Job | Permissions | Does |
|---|---|---|
| `build`, once per architecture | `contents: read` | Fails a tag that is not `v` and the version in `Cargo.toml` (the server reports that version). `docker build` with the OCI `source`, `revision`, `version` and `licenses` labels. Checks the image runs as 65532, holds no program but the server and no `.env`, `rpc.cookie` or `.git`, and turns healthy started read-only with no capabilities. Then the same hardened container against a mainnet-sized store with every store task that needs no node running: every route that answers from the store must answer `200` and no store read or write may fail (`dev/bigstore/hardened.py`, about a minute; [`STORE.md`](STORE.md#temporary-data)). Checks that `deploy/compose.yml` validates, alone, with `compose.tunnel.yml`, and with both overlays and `compose.onion.yml`. Saves the image as an artifact |
| `join` | none | With `skopeo` and `jq`, which GitHub's Ubuntu runners have: copies both images into one OCI layout, gzipping their layers, and writes an image index over them, annotated like the labels. Takes the image for its own platform back out of the index and runs it until healthy. Writes each platform's compressed size to the run's summary, and uploads the layout |
| `publish`, pushed tags and `master` pushes | `contents: read`, `packages: write`, `id-token: write`, `attestations: write` | One at a time across all tags and `master`, queued so none is dropped, and stops on any registry error other than "not there". Pushes exactly that layout to `ghcr.io/<owner>/<repo>` with its digests unchanged, checks the registry's digest is the joined index's, and attests its provenance with GitHub's `attest-build-provenance` (signed through Sigstore, pushed beside the image). A tag: as `X.Y.Z`, and as `latest` when it is the newest version there; refuses a version already in the registry, so re-running an old release changes nothing. A `master` push: as `sha-<full commit>`, refused if that tag holds another digest (re-running only this job pushes the same bytes, a rebuild is refused), and as `master` only when the commit `master` points at (the index's `revision`) is this commit or older, by GitHub's compare API, so a run that finishes late or is re-run never moves it back |
| `tor-build`, once per architecture | `contents: read`, `packages: write` | The onion service's Tor image ([`deploy/tor/Dockerfile`](../deploy/tor/Dockerfile)), versioned by its pinned `tor` package. Stops at once if `ghcr.io/<owner>/<repo>-tor:<version>` is already published. Otherwise builds it natively, checks it runs as `tor`, has that Tor version and the proof-of-work module under the overlay's hardening, and on a push pushes it as `<version>-<arch>` and hands its digest to `tor` |
| `tor`, pushes of a version not yet published | `packages: write`, `id-token: write`, `attestations: write` | One at a time. Joins both architectures' digests from this run as `<version>` with `docker buildx imagetools` and attests it like `publish`. A version is published once, so its digest never changes |
| `release`, pushed tags only | `contents: write` | Creates the GitHub release: the image and its digest, how to verify the attestation, a pointer to the upgrade steps, then GitHub's generated list of changes |

The only token is the built-in `GITHUB_TOKEN`; third-party actions are pinned by commit. Every job has a timeout. There is no layer cache between runs: the Dockerfile's cache mounts live only as long as the runner, and a cold build of both architectures fits in a few minutes.

Measured on 2026-11-12, a run with no cache: `build` 1 min 47 s on amd64 and 2 min 0 s on arm64, side by side, `join` 13 s, 2 min 22 s from start to end. Each image is about 17 MB compressed.

**The packages must be public** (`rbitcoin-space` and `rbitcoin-space-tor`), since operators pull them without logging in. A package first published by a workflow can start private, and no token the workflow holds can change that: an organisation owner sets it once in each package's settings on GitHub (Danger Zone, Change visibility).

**What accumulates:** one `sha-<commit>` tag per merge that touches the image, with its attestation beside it: about 30 a day while the site is being built (108 from 2026-11-11 to 2026-11-13), so several hundred a month. Nothing deletes them. Public packages on ghcr.io cost nothing to store, the layers they share are stored once, and a deleted version breaks every deployment pinned to its digest, while GitHub restores one only within 30 days. So a clean-up is not worth the risk of removing an image someone pinned. Revisit it if the package's version list becomes hard to use.

**To release:** set `version` in the root `Cargo.toml` to the new version in a PR, merge it, then tag that commit `vX.Y.Z` on `master` and push the tag. A pushed tag cannot be taken back quietly: the release is public at once.

## Test layers

| Layer | Tests | Speed |
|---|---|---|
| Unit | Pure logic: parsing, diffing, projected blocks, fee math, classification. No I/O | Milliseconds |
| Fixture | Decoding and mapping against recorded public chain data in `fixtures/` | Milliseconds |
| Integration | Node clients and the engine against rbitcoin on regtest in Docker ([`REGTEST.md`](REGTEST.md)) | Seconds |
| End to end | The built server and frontend in headless Chromium; WebKit and Firefox weekly | Seconds |

Most coverage belongs in the first two layers. Integration and end-to-end tests cover the paths where the layers meet, not every case.

## Rules for tests

- **Tests never reach the public internet or a shared node.** CI has no access to either.
- **Tests bind port 0** or take their port from the environment.
- **A flaky test is a failing test.** Fix it or delete it; do not retry it.
- **A test never passes or fails on how long something took on the machine that runs it,** in time passed or in processor time: CI's runner is shared and slow, and a busy laptop is slower. A speed budget is a benchmark that runs on request, beside a test of the same answers in the suite. Two checks hold this, each naming the fix: in Rust, `crates/lint` fails on an assertion that bounds real time from above, unless it is a polling loop's ceiling or on a paused clock; in the frontend's unit tests, oxlint refuses a clock read, and `budget()` (`web/src/lib/budget.ts`) checks a speed only on a `BENCH=1` run. Neither sees a sleep before an assertion, a lower bound, or data built from the real calendar: wait for the event, or pin the time. The Rust check reads source as text, without a parser, so it also loses a span that crosses a function call, such as one a helper returns in a tuple, or measures on `std`'s clock for a paused test; it takes a file's last `use` of `Instant` for every module in the file; it takes a `for` loop for a polling loop when any loop inside it can `break`; and it does not carry a clock reset at the foot of a loop's body round to a bound at its head. The frontend's rule does not follow a clock held under another name.
- **Browser tests run at the server's production limits** and fail on any refusal, naming the limit and the request ([`FRONTEND.md`](FRONTEND.md#browser-tests)). A test that trips one has found a page that asks for too much, or a test that does; never raise a limit to make it pass.
- **New logic with a branch, a loop or a parser ships with a test.**

## Measuring

When a PR changes the workflow, its description states the cold and warm wall-clock time of the run, from its creation to the last job's end.

**Measured 2026-11-13**, on the pull request that set the limits above, which touches Rust and the frontend, so every job ran. Warm: the caches were an exact hit.

| | Before (three PRs that day) | After |
|---|---|---|
| Whole run | 180 to 208 s | 106, 138 and 126 s (three runs in a row of one commit) |
| `rust` | 148 to 191 s | 94 to 121 s |
| `e2e` | 101 to 113 s | 80 to 101 s |
| `web` | 30 to 39 s | 30 to 39 s |
| `image` | 15 to 20 s | 14 to 18 s |

Before, in `rust`, setup took 18 s (checkout, `rustup toolchain install` 8 s, the cache 4 to 8 s), clippy 9 to 12 s, building the tests 41 s, and running them 113 s: `cargo test` ran 28 binaries one after another, the Lightning one alone 37 s, the server's unit tests 16 s, the engine's 15 s, the WebSocket tests 11 s. Signature checks by secp256k1 compiled at `-O0` were a large part: optimising it alone took the tests' summed time from 295 s to 260 s on a laptop. After: setup 18 s, clippy 9 to 13 s, building the tests 26 s (examples no longer built), the tests 36 to 50 s with nextest, doc tests 1 s. The tests together take about 290 s; most of it is waiting on sockets and timers, which eight at a time overlap. The longest single tests, about 10 s each, are a random test of the mempool topics and two hostile-peer tests of the Lightning peer.

In `e2e`, setup takes 16 to 24 s, the build and the regtest node are both ready at 24 to 25 s, then the 103 browser tests took 59 s on two workers before and 43 to 47 s on four after: about 33 s for the tests that share the node, then 12 s for the ones that mine, one at a time.

### Browser test shards

**Measured 2026-11-13**, on the pull request that split `e2e` into shards, 143 browser tests, warm. A shard's time is what the limit counts, from the job's first step to its last.

| | One job | Two shards | Three shards |
|---|---|---|---|
| `e2e` | 111 and 142 s (two runs of another PR) | 79 and 74, 97 and 77, 95 and 94 s | 71, 62 and 86; 71, 75 and 85; 70, 75 and 93 s |
| Whole run | | 111, 116 and 135 s | 129, 123 and 124 s |

Each shard pays the job's fixed cost again, so sharding divides only the tests' time. Setup takes 14 to 16 s (`rustup toolchain install` 8 to 10 s, the cache 2 to 3 s, bun 2 s). Then `e2e.sh` logs each wait: the browser is ready at 4 to 8 s, the node at 11 to 25 s and the build at 20 to 28 s, so the build is the last to finish, by 1 to 15 s. Playwright then starts twice, about 1.5 s each. That makes about 40 s before the first test and 45 s in all. The tests that share the node take 20 to 42 s on a shard and the tests that mine 2.5 to 9.5 s: the shard holding `tables.e2e.ts`, the slowest file, runs longest.

Two shards would leave too little room. Their slowest was 97 s, and a limit with 40 % to spare (about 160 s), plus `changes` and `ci-ok`, takes the whole three minutes. Three shards' slowest was 93 s, 64 % of a 145 s limit, which leaves room for the pages in progress to add their tests; a higher limit would leave the whole run too little of its three minutes. A fourth would save about 10 s more for another runner's 45 s. Little of the fixed cost is cheap to cut: `rustup` also installs `rustfmt` and `clippy`, which `e2e` does not use, for a second or two; the build already starts from the cache; and sharing one build across shards would chain jobs (rule 3).

**A fourth shard, measured 2026-11-14**, 301 browser tests, warm. By then the first shard went over its limit on pull requests that touch no browser test: 150 to 162 s, its tests 232 to 368 s of summed time, against 157 to 204 s in each of the others. Making room came first ([#143](https://github.com/smolcars/rbitcoin-space/pull/143)): the accessibility sweep's keyboard walk noted its stops in the page instead of a round trip each, three tests that waited out real polls moved to a paused clock, and the seeder became a binary built with the server, which had compiled the engine a second time. Its tests then took 165 to 250 s of summed time, but every shard still took 98 to 133 s of its 145, with its tests about half of that: setup is 20 to 25 s, and the server is ready 15 to 25 s into `e2e.sh`. So three shards left the first 20 to 46 s of room, and four left it 52 to 56 s. Three runs of each, each set of one commit whose changes include Rust, so every job ran:

| | Three shards | Four shards |
|---|---|---|
| `e2e`, each shard | 99, 98 and 121 s; 125, 108 and 99 s; 109, 107 and 103 s | 93, 98, 74 and 95 s; 89, 100, 68 and 106 s; 93, 104, 80 and 93 s |
| Whole run, from its creation | 136, 137 and 137 s | 125, 130 and 128 s |

The cut by count was not what made the first shard heavy: its slow file was. With four, the first shard's tests took 132 to 151 s of summed time and the others' 92 to 181 s, which shard is heaviest changing from run to run. The tests that mine run one at a time after the rest, so the shard holding `live.mine.e2e.ts` adds 20 to 25 s.

**A fifth shard, measured 2026-11-21**, 559 browser tests, warm. In the week since the fourth the tests had nearly doubled, and a shard on a slow runner no longer fitted its limit with every test passing: pull request #266, which adds no browser test, failed at 186 s on a second attempt; #269 failed at 183 s on a shard that ran 13 of the tests it adds (its `web` job failed too, on a unit test since fixed in #271); and on the push of `f0d3ce7` to `master` a shard took 185 s, which a push only warns of (that run's failure was its `web` job's, on a unit test's speed limit). A shard's time as the limit counts it:

| | Four shards (`master` at `5a47b6a`, `2da1a1e`, `f818fd8` and `f0d3ce7`) | Five shards (three runs of [#270](https://github.com/smolcars/rbitcoin-space/pull/270), and a fourth after its rebase onto `f0d3ce7`) |
|---|---|---|
| `e2e`, each shard | 127, 153, 126 and 118 s; 110, 142, 191 and 127 s; 128, 145, 121 and 144 s; 119, 185, 133 and 148 s | 102, 102, 140, 114 and 116 s; 133, 124, 142, 119 and 133 s; 120, 125, 139, 108 and 103 s; 97, 99, 162, 110 and 114 s |
| Whole run, from its start to its last job's end | not comparable: a push to `master` waits for the run before it | 170, 174, 162 and about 180 s |

With five, a shard runs 105 or 106 of the tests that share the node, in 40 to 70 s on three of the runs and up to 88 s on the fourth, and 2 to 10 of those that mine, in 4 to 24 s. Four of the five shards then have 47 s or more under their limit. The third does not: it was the slowest every time, at 139 to 162 s, so it has 18 to 41 s.

**What made a shard slow was the runner, during the tests, and no one test.** The summary's slowest tests were read first, as the rule above asks. The 191 s shard reached its first test in about 56 s, against 36 to 45 s on the pushes either side, but its tests then took 130 s where the same tests took 77 and 81 s: every file in it ran about 1.6 times as long (`palette.e2e.ts`, 46 tests, 198 s of summed time against 121 s; `policies.e2e.ts`, 9 tests, 103 s against 68 s; and so on down the list), and its slowest single test took 19 s against 9 s. There was no test to shrink that would have brought that run under its limit, which is why this is a shard and not a trimmed test. With five shards the cut falls differently: all 46 of the palette's tests are in the third shard, the one with 18 s to spare, and the policy pages' nine are in the fourth. So `palette.e2e.ts` is where room is to be made next, before a sixth shard.

**Cold** (no cache: a new lockfile, toolchain or `rust-cache` key), `rust` took 165 s and `e2e` 107 to 150 s, so a run that rebuilds its dependencies can pass three minutes. The limits are not enforced on it; the next `master` push saves the cache.
