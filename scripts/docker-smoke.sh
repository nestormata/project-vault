#!/usr/bin/env bash
# End-to-end Docker smoke test: build, start, curl /health + /ready, tear down.
# Resolves host port conflicts first so this can run alongside another
# worktree's stack — see AGENTS.md "Docker port isolation".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

"$ROOT/scripts/docker-ports.sh" fix

API_HOST_PORT="$(grep -m1 '^API_HOST_PORT=' .env 2>/dev/null | cut -d= -f2)"
API_HOST_PORT="${API_HOST_PORT:-3000}"
API_URL="http://localhost:${API_HOST_PORT}"

trap 'docker compose down' EXIT
docker compose up --build -d
for i in $(seq 1 15); do
  code=0
  curl -sf "${API_URL}/health" >/dev/null || code=$?
  [ "$code" -eq 0 ] && break
  if [ "$code" -ne 52 ] && [ "$code" -ne 56 ]; then exit "$code"; fi
  sleep 3
done
curl -f "${API_URL}/health"
curl -f "${API_URL}/ready"
