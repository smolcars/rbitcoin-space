#!/usr/bin/env bash
# Browser tests in one command: a private regtest node with the known chain, the server and the
# frontend built from this checkout, the server on a free port, then Playwright. Everything it
# starts is named for this run, so runs on one machine never collide. Arguments go to Playwright.
set -euo pipefail

web=$(cd "$(dirname "$0")/.." && pwd)
root=$(dirname "$web")
regtest="$root/dev/regtest/regtest.py"
run=$(mktemp -d "${TMPDIR:-/tmp}/rbitcoin-space-e2e.XXXXXX")
# Never a node the caller set up: scenario resets the chain it is pointed at.
export REGTEST_PROJECT="e2e-$$"
server=""

cleanup() {
  local status=$?
  if [ -n "$server" ]; then kill "$server" 2>/dev/null || true; fi
  # A scenario still starting would bring the node back up after `down`, so let it finish first.
  wait || true
  python3 "$regtest" down >/dev/null 2>&1 || true
  if [ "$status" -eq 0 ]; then
    rm -rf "$run"
  else
    [ -f "$run/server.log" ] && tail -n 20 "$run/server.log" >&2
    echo "e2e: failed; logs and traces are in $run" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# The node builds its chain while the server and frontend compile.
# Each wait logs when it ended, so a CI log shows which one the run waited on.
{ python3 "$regtest" scenario >"$run/manifest.json" 2>"$run/regtest.log" &&
  echo "e2e: node ready at ${SECONDS}s" >&2; } &
node_pid=$!

cd "$web"
[ -d node_modules ] || bun install --frozen-lockfile
# E2E_ENGINE picks the browser (playwright.config.ts); Chromium needs only its headless shell.
engine=${E2E_ENGINE:-chromium}
if [ "$engine" = chromium ]; then
  { node_modules/.bin/playwright install --only-shell chromium &&
    echo "e2e: browser ready at ${SECONDS}s" >&2; } &
else
  { node_modules/.bin/playwright install "$engine" && echo "e2e: browser ready at ${SECONDS}s" >&2; } &
fi
browser_pid=$!
bun run build --outDir "$run/dist" --emptyOutDir --logLevel warn
# One build: the seeder shares the server's features, so the engine is compiled once.
(cd "$root" && cargo build --locked --quiet -p rbitcoin-space -p engine \
  --bin rbitcoin-space --bin history_seed)
echo "e2e: built at ${SECONDS}s" >&2
bin="${CARGO_TARGET_DIR:-$root/target}/debug/rbitcoin-space"
case "$bin" in /*) ;; *) bin="$root/$bin" ;; esac
# The server records its first minute 60 to 120 s after it starts, so it starts with some history.
"$(dirname "$bin")/history_seed" "$run/data"

wait "$node_pid" || { cat "$run/regtest.log" >&2; exit 1; }
wait "$browser_pid"
eval "$(python3 "$regtest" env | sed 's/^/export /')"

# Only the regtest network, whatever the caller's environment holds: tests never reach a shared
# node. Every limit is at its default: each test names itself as a separate client in
# X-Forwarded-For (e2e/fixtures.ts), which the server reads only from the proxy named here. The block
# table lives in the run's directory, so the mining pages have data and nothing outlives the run.
env -i PATH="$PATH" LISTEN_ADDR=127.0.0.1:0 WEB_DIR="$run/dist" DATA_DIR="$run/data" LOG_FORMAT=json \
  TRUSTED_PROXY_HEADER=X-Forwarded-For TRUSTED_PROXIES=127.0.0.1 LOG_CLIENT_ADDR=true \
  REGTEST_RPC_HOST="$REGTEST_RPC_HOST" REGTEST_RPC_PORT="$REGTEST_RPC_PORT" \
  REGTEST_RPC_USER="$REGTEST_RPC_USER" REGTEST_RPC_PASSWORD="$REGTEST_RPC_PASSWORD" \
  REGTEST_ESPLORA_URL="$REGTEST_ESPLORA_URL" REGTEST_ELECTRUM_ADDR="$REGTEST_ELECTRUM_ADDR" \
  "$bin" >"$run/server.log" 2>&1 &
server=$!

# Port 0 picks a free port; the server logs which in its `listening` event.
addr=""
for _ in $(seq 100); do
  addr=$(grep '"event":"listening"' "$run/server.log" | grep -oE '127\.0\.0\.1:[0-9]+' || true)
  [ -n "$addr" ] && break
  kill -0 "$server" 2>/dev/null || { echo "e2e: the server exited" >&2; exit 1; }
  sleep 0.1
done
[ -n "$addr" ] || { echo "e2e: the server did not start" >&2; exit 1; }

echo "e2e: ready in ${SECONDS}s, server at http://$addr" >&2
status=0
run_tests() { E2E_BASE_URL="http://$addr" node_modules/.bin/playwright test "$@" || status=$?; }
if [ -n "${E2E_SHARD:-}" ]; then
  # E2E_SHARD=i/n runs one CI shard (docs/CI.md). Playwright runs a dependency project whole in
  # every shard, so each project is sharded in a run of its own: the tests that share the node,
  # then, if they passed, the tests that mine, as playwright.config.ts orders them.
  project=$engine
  [ "${E2E_PHONE:-}" != 1 ] || project="$engine-phone"
  E2E_OUTPUT_DIR="$run/results" run_tests --project="$project" --shard="$E2E_SHARD" "$@"
  # A JUnit report of its own beside the first, which the second run would overwrite.
  junit=${PLAYWRIGHT_JUNIT_OUTPUT_NAME:-}
  [ -z "$junit" ] || export PLAYWRIGHT_JUNIT_OUTPUT_NAME="${junit%.xml}-mines.xml"
  [ "$status" -ne 0 ] ||
    E2E_OUTPUT_DIR="$run/results-mines" run_tests --project=mines --no-deps --shard="$E2E_SHARD" "$@"
else
  E2E_OUTPUT_DIR="$run/results" run_tests "$@"
fi
# Stopping the server flushes its log, which it writes from a queue.
kill "$server" 2>/dev/null || true
wait "$server" 2>/dev/null || true
server=""
# No page load may trip a limit at the defaults, even one a test tolerates: name them.
# A request's limit is a string; `tracking_summary` counts its own refusals as a number, every minute.
refused=$(grep -E '"refused":"|"event":"connections_refused"' "$run/server.log" || true)
if [ -n "$refused" ]; then
  echo "e2e: the server's limits refused $(echo "$refused" | wc -l | tr -d ' ') requests (docs/CONFIG.md \"Limits\"); the first:" >&2
  echo "$refused" | head -n 10 >&2
  [ "$status" -ne 0 ] || status=1
fi
exit "$status"
