#!/usr/bin/env bash
# Shared by scripts/fly-migrate.sh and scripts/fly-reset.sh: opens a WireGuard proxy to a Fly.io
# Postgres app's internal :5432 and blocks until it's reachable. Source this file, then call
# open_fly_db_proxy "$DB_APP" "$PROXY_PORT" — it sets PROXY_PID and installs an EXIT trap that
# kills the proxy, matching both scripts' existing `cleanup`/`trap - EXIT` convention (callers
# still call `cleanup` + `trap - EXIT` themselves once they're done with the proxy, same as before).
#
# Story 43.16: the db only accepts TLS 1.3 with a client certificate chained to the private CA.
# After opening the proxy, call issue_operator_tls "$SCRIPT_DIR": it mints a short-lived operator
# certificate into a mktemp -d directory (OP_DIR) that `cleanup` removes. Then use
# operator_psql_url for psql and with_operator_tls for postgres.js children (db:migrate,
# db:seed:demo, check-rls), whose URLs carry only ?sslmode=verify-full — postgres.js would send any
# other query parameter to the server as a startup parameter.

open_fly_db_proxy() {
  local db_app="$1"
  local proxy_port="$2"

  echo "== Opening WireGuard proxy to ${db_app}.internal:5432 =="
  flyctl proxy "${proxy_port}:5432" -a "$db_app" &
  PROXY_PID=$!
  cleanup() {
    kill "$PROXY_PID" 2>/dev/null || true
    if [[ -n "${OP_DIR:-}" ]]; then rm -rf "$OP_DIR"; fi
    return 0
  }
  trap cleanup EXIT

  for ((i = 1; i <= 30; i++)); do
    pg_isready -h localhost -p "$proxy_port" -U postgres >/dev/null 2>&1 && break
    sleep 1
    [[ $i -eq 30 ]] && { echo "flyctl proxy never became reachable" >&2; exit 1; }
  done

  return 0
}

# issue_operator_tls <script-dir>: needs FLY_INTERNAL_CA_CERT_B64 / FLY_INTERNAL_CA_KEY_B64.
# Once the operator certificate is minted the CA is no longer needed, so both variables are
# unset: no later child (pnpm/postgres.js, psql, flyctl, curl) ever inherits the CA key.
issue_operator_tls() {
  local script_dir="$1"
  OP_DIR="$(mktemp -d)"
  "${script_dir}/fly-internal-tls.sh" issue-operator --out "$OP_DIR"
  unset FLY_INTERNAL_CA_CERT_B64 FLY_INTERNAL_CA_KEY_B64
  return 0
}

# operator_psql_url <user> <password> <port>: verify-full + the operator client certificate.
operator_psql_url() {
  local user="$1" password="$2" port="$3"
  printf 'postgresql://%s:%s@localhost:%s/project_vault?sslmode=verify-full&sslrootcert=%s&sslcert=%s&sslkey=%s' \
    "$user" "$password" "$port" "${OP_DIR}/ca.crt" "${OP_DIR}/operator.crt" "${OP_DIR}/operator.key"
}

# with_operator_tls <command...>: runs a postgres.js child with the operator TLS material in the
# DATABASE_TLS_*_B64 variables packages/db's pgTlsOptions reads — for that child only.
with_operator_tls() {
  DATABASE_TLS_CA_B64="$(base64 -w0 <"${OP_DIR}/ca.crt")" \
    DATABASE_TLS_CLIENT_CERT_B64="$(base64 -w0 <"${OP_DIR}/operator.crt")" \
    DATABASE_TLS_CLIENT_KEY_B64="$(base64 -w0 <"${OP_DIR}/operator.key")" \
    "$@"
}
