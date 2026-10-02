#!/usr/bin/env bash
# Story 43.28 AC-4: make sure every machine of one Fly app is running, and optionally that the api
# answers through the web app.
#
# Fly stops a machine that crash-loops past its max restart count (10). `flyctl apps restart` only
# restarts STARTED machines, and `flyctl deploy` can update a stopped machine's config and leave it
# stopped while reporting "good state" (Fly Demo Bootstrap run 36936660869). So after a deploy or a
# reset nothing would bring the api back. This script:
#   1. lists the app's machines (`flyctl machine list --json`: an array of {id, state, ...});
#   2. starts every `stopped`/`suspended` one (destroyed/destroying ones are not the app's machines);
#   3. polls until every remaining machine is `started` (bounded);
#   4. with a web URL, polls <web-url>/ready until it stops reporting `api_unreachable` (a sealed
#      vault is fine: it re-seals on every restart), because a machine can reach `started` and
#      crash again a second later.
#
# Usage: ./scripts/fly-ensure-started.sh <app> [<web-url>]
#   FLY_MACHINE_START_TIMEOUT_S  bound for each wait (default 60)
#   FLY_MACHINE_POLL_INTERVAL_S  pause between polls (default 2)
#
# Requires: flyctl authenticated (FLY_API_TOKEN), jq, curl (only with a web URL).
# Only ever touches the app it is given; never call it for the db app (always running by design).
set -euo pipefail

APP="${1:?Usage: fly-ensure-started.sh <app> [<web-url>]}"
WEB_URL="${2:-}"
TIMEOUT_S="${FLY_MACHINE_START_TIMEOUT_S:-60}"
INTERVAL_S="${FLY_MACHINE_POLL_INTERVAL_S:-2}"

for bin in flyctl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing required binary: $bin" >&2; exit 1; }
done

# Prints one "<id> <state>" line per machine the app runs. A parse failure is an error, never
# "nothing stopped".
machine_rows() {
  local json
  if ! json="$(flyctl machine list -a "$APP" --json)"; then
    echo "fly-ensure-started: flyctl machine list failed for ${APP}" >&2
    return 1
  fi
  if ! jq -e 'type == "array"' <<<"$json" >/dev/null 2>&1; then
    echo "fly-ensure-started: could not parse machine list for ${APP}" >&2
    return 1
  fi
  jq -r '.[] | select(.state != "destroyed" and .state != "destroying") | "\(.id) \(.state)"' <<<"$json"
}

# Polls "$@" until it succeeds or TIMEOUT_S has passed (always at least one attempt).
poll() {
  local deadline=$((SECONDS + TIMEOUT_S))
  until "$@"; do
    ((SECONDS >= deadline)) && return 1
    sleep "$INTERVAL_S"
  done
  return 0
}

# Sets NOT_STARTED (ids, space-separated) and MACHINE_COUNT from one fresh machine list.
NOT_STARTED=""
MACHINE_COUNT=0
record_states() {
  NOT_STARTED="$(awk '$2 != "started" { printf "%s%s", sep, $1; sep = " " }' <<<"$1")"
  MACHINE_COUNT="$(grep -c . <<<"$1" || true)"
  return 0
}

all_started() {
  local rows
  rows="$(machine_rows)" || exit 1
  record_states "$rows"
  [[ -z "$NOT_STARTED" ]]
}

api_reachable() {
  local response body code
  response="$(curl -s --max-time 10 -w '\n%{http_code}' "${WEB_URL}/ready" 2>/dev/null || true)"
  code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  [[ "$code" == "200" ]] && return 0
  # A non-JSON body (an HTML 502 from the Fly edge) means "not reachable yet", never a crash.
  jq -e 'type == "object" and .reason != "api_unreachable"' <<<"$body" >/dev/null 2>&1
}

rows="$(machine_rows)" || exit 1
if [[ -z "$rows" ]]; then
  echo "fly-ensure-started: no machines for ${APP}" >&2
  exit 1
fi
record_states "$rows"

while read -r id state; do
  if [[ "$state" == "stopped" || "$state" == "suspended" ]]; then
    echo "== ${APP}: starting stopped machine ${id} =="
    # </dev/null: flyctl must not consume the remaining rows of this loop's stdin.
    if ! flyctl machine start "$id" -a "$APP" </dev/null; then
      echo "fly-ensure-started: failed to start machine ${id} of ${APP}" >&2
      exit 1
    fi
  fi
done <<<"$rows"

# Anything not yet `started` (just started by us, or starting/replacing/created) is polled.
if [[ -n "$NOT_STARTED" ]]; then
  if ! poll all_started; then
    echo "fly-ensure-started: machines of ${APP} never reached started: ${NOT_STARTED}" >&2
    exit 1
  fi
fi
echo "== ${APP}: all ${MACHINE_COUNT} machines started =="

if [[ -n "$WEB_URL" ]]; then
  command -v curl >/dev/null 2>&1 || { echo "missing required binary: curl" >&2; exit 1; }
  echo "== ${APP}: waiting for ${WEB_URL}/ready to stop reporting api_unreachable =="
  if ! poll api_reachable; then
    echo "api never became reachable via ${WEB_URL}/ready" >&2
    exit 1
  fi
  echo "== ${APP}: reachable via ${WEB_URL}/ready =="
fi
