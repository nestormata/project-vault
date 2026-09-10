#!/usr/bin/env bash
# End-to-end Docker smoke test: build, start, curl /health + /ready, tear down.
# Resolves host port conflicts first so this can run alongside another
# worktree's stack — see docs/development.md "Docker port isolation".
#
# SIDE EFFECT: this script runs `docker compose down` on exit (success or failure), stopping
# whatever stack is currently up for this checkout. Named volumes (db_data, backup_data) are
# kept, so no data is destroyed — but a stack you were using is stopped. The script announces
# this before it starts and again when it tears down.
#
# /ready outcome: on a brand-new db_data volume the vault has never been initialized, so /ready
# answers 503 with reason `uninitialized` (or `sealed` after a restart). That is a healthy,
# expected state for a freshly built stack — this script reports it as a distinct
# "READY-PENDING" outcome and still exits 0. Any other /ready failure (e.g. reason `db`) is a
# real failure and exits non-zero.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

"$ROOT/scripts/docker-ports.sh" fix

API_HOST_PORT="$(grep -m1 '^API_HOST_PORT=' .env 2>/dev/null | cut -d= -f2)"
API_HOST_PORT="${API_HOST_PORT:-3000}"
API_URL="http://localhost:${API_HOST_PORT}"
MAX_ATTEMPTS=20
RETRY_SLEEP_SECONDS=3

dump_diagnostics() {
  echo "[docker-smoke] container status:" >&2
  docker compose ps >&2 || true
  echo "[docker-smoke] recent API logs:" >&2
  docker compose logs --no-color --tail=100 api >&2 || true
}

teardown() {
  echo "[docker-smoke] tearing down: docker compose down (named volumes are kept)"
  docker compose down
}
trap teardown EXIT

echo "[docker-smoke] NOTE: this will \`docker compose down\` this checkout's stack when it finishes."
echo "[docker-smoke] API base URL: ${API_URL}"
docker compose up --build -d
health_code=1
for i in $(seq 1 "$MAX_ATTEMPTS"); do
  code=0
  curl -sf "${API_URL}/health" >/dev/null || code=$?
  if [[ "$code" -eq 0 ]]; then
    health_code=0
    break
  fi
  health_code="$code"
  case "$code" in
    7|52|56)
      echo "[docker-smoke] health attempt ${i}/${MAX_ATTEMPTS} returned curl ${code}; retrying" >&2
      ;;
    *)
      echo "[docker-smoke] health check failed with non-retryable curl ${code}" >&2
      dump_diagnostics
      exit "$code"
      ;;
  esac
  if [[ "$i" -lt "$MAX_ATTEMPTS" ]]; then sleep "$RETRY_SLEEP_SECONDS"; fi
done
if [[ "$health_code" -ne 0 ]]; then
  echo "[docker-smoke] health check failed after ${MAX_ATTEMPTS} attempts" >&2
  dump_diagnostics
  exit "$health_code"
fi
echo "[docker-smoke] /health:"
curl -f "${API_URL}/health"
echo

# /ready is a gate, not a liveness probe: 503 + reason uninitialized/sealed simply means no vault
# ceremony has been performed on this db_data volume yet. Report it distinctly instead of failing
# the smoke test (see this file's header).
ready_body="$(curl -s -w '\n%{http_code}' "${API_URL}/ready" || true)"
ready_code="${ready_body##*$'\n'}"
ready_json="${ready_body%$'\n'*}"
ready_reason="$(printf '%s' "$ready_json" |
  sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

echo "[docker-smoke] /ready: HTTP ${ready_code} ${ready_json}"
case "$ready_code" in
  200)
    echo "[docker-smoke] RESULT: READY — stack is fully up and the vault is unsealed."
    ;;
  503)
    case "$ready_reason" in
      uninitialized | sealed)
        echo "[docker-smoke] RESULT: READY-PENDING — the stack is healthy but the vault is"
        echo "[docker-smoke]   '${ready_reason}' on this db_data volume. Initialize/unseal it once"
        echo "[docker-smoke]   (web UI, or scripts/operator-bootstrap.sh --docker --init-vault)"
        echo "[docker-smoke]   for a full READY result. Treated as success."
        ;;
      *)
        echo "[docker-smoke] RESULT: FAIL — /ready 503 with reason '${ready_reason:-unknown}'" >&2
        dump_diagnostics
        exit 1
        ;;
    esac
    ;;
  *)
    echo "[docker-smoke] RESULT: FAIL — unexpected /ready status '${ready_code:-none}'" >&2
    dump_diagnostics
    exit 1
    ;;
esac
