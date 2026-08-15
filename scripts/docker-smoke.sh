#!/usr/bin/env bash
# End-to-end Docker smoke test: build, start, curl /health + /ready, tear down.
# Resolves host port conflicts first so this can run alongside another
# worktree's stack — see docs/development.md "Docker port isolation".
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

trap 'docker compose down' EXIT
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
curl -f "${API_URL}/health"
curl -f "${API_URL}/ready"
