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
freshly_created=0
if [[ ! -f "$ENV_FILE" && -f .env.example ]]; then
  cp .env.example "$ENV_FILE"
  freshly_created=1
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

# Deterministic per-worktree default: a hash of this worktree's own absolute path, offset into a
# private range per key so DB/API/WEB never collide with each other for the same worktree. This
# replaces a fixed literal (5432/3000/5173 — identical for every worktree until someone manually
# ran `fix`) as the *starting point*, so a fresh checkout, or a worktree whose .env was deleted or
# regenerated from .env.example, lands on an already-isolated port instead of the one every other
# worktree also defaults to. Genuine collisions (two worktrees hashing to the same value, or an
# unrelated process squatting the derived port) are still caught and bumped below, same as before.
# Must match the Makefile's own DB_HOST_PORT derivation exactly (same base, same `cksum` formula).
derive_port() {
  local base="$1" seed
  seed="$(printf '%s' "$ROOT" | cksum | cut -d' ' -f1)"
  echo $((base + seed % 10000))
}

base_for_key() {
  case "$1" in
    DB_HOST_PORT) echo 20000 ;;
    API_HOST_PORT) echo 30000 ;;
    WEB_HOST_PORT) echo 40000 ;;
  esac
}

shared_default_for_key() {
  case "$1" in
    DB_HOST_PORT) echo 5432 ;;
    API_HOST_PORT) echo 3000 ;;
    WEB_HOST_PORT) echo 5173 ;;
  esac
}

if [[ "$freshly_created" -eq 1 ]]; then
  # Stamp deterministic ports immediately instead of leaving the literal 5432/3000/5173 copied
  # from .env.example in place — otherwise a fresh worktree only gets isolated once someone
  # remembers to run `fix`, and until then it's sitting at the exact default every other worktree
  # also starts with.
  for key in DB_HOST_PORT API_HOST_PORT WEB_HOST_PORT; do
    set_env_value "$key" "$(derive_port "$(base_for_key "$key")")"
  done
  echo "==> assigned this worktree's own deterministic DB/API/WEB ports"
fi

conflicts=0
for key in DB_HOST_PORT API_HOST_PORT WEB_HOST_PORT; do
  derived="$(derive_port "$(base_for_key "$key")")"
  shared_default="$(shared_default_for_key "$key")"

  current="$(env_value "$key" "$derived")"

  if [[ "$MODE" == "fix" && "$current" == "$shared_default" ]]; then
    # Still at the un-isolated shared default — either a stale .env from before this worktree-
    # local derivation existed, or one freshly copied from .env.example. Migrate it to this
    # worktree's own deterministic port even if it isn't busy *right now* — the goal is that two
    # worktrees never share a default in the first place, not just that today's snapshot is free.
    set_env_value "$key" "$derived"
    echo "ISOLATED ${key}=${current} -> ${derived} (was the shared, non-isolated default)"
    current="$derived"
  fi

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
