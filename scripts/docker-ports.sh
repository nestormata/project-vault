#!/usr/bin/env bash
# Check (or auto-fix) the host ports docker-compose.yml publishes, so multiple
# worktrees of this repo — or a standalone test stack — can run concurrently
# without a `docker compose up` silently failing to bind.
#
# See AGENTS.md "Docker port isolation" for the workflow this supports.
#
# Usage:
#   scripts/docker-ports.sh check   # report BUSY/OK for each port (default); exits 1 on conflict
#   scripts/docker-ports.sh fix     # bump any busy port to the next free one and write .env
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE=".env"
if [[ ! -f "$ENV_FILE" && -f .env.example ]]; then
  cp .env.example "$ENV_FILE"
  echo "==> created .env from .env.example"
fi

MODE="${1:-check}"
case "$MODE" in
  check|fix) ;;
  *) echo "Usage: $0 [check|fix]" >&2; exit 2 ;;
esac

port_is_free() {
  # Bash's /dev/tcp pseudo-device: connecting succeeds iff something is listening.
  ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

env_value() {
  local key="$1" default="$2" line
  line="$(grep -m1 "^${key}=" "$ENV_FILE" 2>/dev/null || true)"
  if [[ -n "$line" ]]; then echo "${line#*=}"; else echo "$default"; fi
}

set_env_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i.bak "s/^${key}=.*/${key}=${value}/" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

next_free_port() {
  local port="$1"
  while ! port_is_free "$port"; do
    port=$((port + 1))
  done
  echo "$port"
}

conflicts=0
for key in DB_HOST_PORT API_HOST_PORT WEB_HOST_PORT; do
  default=5432
  [[ "$key" == "API_HOST_PORT" ]] && default=3000
  [[ "$key" == "WEB_HOST_PORT" ]] && default=5173

  current="$(env_value "$key" "$default")"
  if port_is_free "$current"; then
    echo "OK    ${key}=${current}"
    continue
  fi

  conflicts=1
  if [[ "$MODE" == "fix" ]]; then
    new_port="$(next_free_port "$((current + 1))")"
    set_env_value "$key" "$new_port"
    echo "FIXED ${key}=${current} -> ${new_port} (was already in use)"
  else
    echo "BUSY  ${key}=${current} — already in use on this host"
  fi
done

if [[ "$conflicts" -eq 1 && "$MODE" == "check" ]]; then
  echo "==> run 'scripts/docker-ports.sh fix' (or 'make fix-ports') to auto-assign free ports in .env" >&2
  exit 1
fi
