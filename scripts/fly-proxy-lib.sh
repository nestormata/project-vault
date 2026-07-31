#!/usr/bin/env bash
# Shared by scripts/fly-migrate.sh and scripts/fly-reset.sh: opens a WireGuard proxy to a Fly.io
# Postgres app's internal :5432 and blocks until it's reachable. Source this file, then call
# open_fly_db_proxy "$DB_APP" "$PROXY_PORT" — it sets PROXY_PID and installs an EXIT trap that
# kills the proxy, matching both scripts' existing `cleanup`/`trap - EXIT` convention (callers
# still call `cleanup` + `trap - EXIT` themselves once they're done with the proxy, same as before).

open_fly_db_proxy() {
  local db_app="$1"
  local proxy_port="$2"

  echo "== Opening WireGuard proxy to ${db_app}.internal:5432 =="
  flyctl proxy "${proxy_port}:5432" -a "$db_app" &
  PROXY_PID=$!
  cleanup() { kill "$PROXY_PID" 2>/dev/null || true; return 0; }
  trap cleanup EXIT

  for ((i = 1; i <= 30; i++)); do
    pg_isready -h localhost -p "$proxy_port" -U postgres >/dev/null 2>&1 && break
    sleep 1
    [[ $i -eq 30 ]] && { echo "flyctl proxy never became reachable" >&2; exit 1; }
  done

  return 0
}
