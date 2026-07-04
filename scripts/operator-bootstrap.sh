#!/usr/bin/env bash
# Operator bootstrap — database migrate + optional vault init/unseal (Epic 1 retro D2).
# See docs/operator-quickstart.md
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Auto-resolve host port conflicts (concurrent worktrees, standalone test stacks) before
# computing any localhost:<port> URLs below. See AGENTS.md "Docker port isolation".
"$ROOT/scripts/docker-ports.sh" fix

env_port() {
  local key="$1" default="$2" line
  line="$(grep -m1 "^${key}=" "$ROOT/.env" 2>/dev/null || true)"
  if [[ -n "$line" ]]; then echo "${line#*=}"; else echo "$default"; fi
}

DB_HOST_PORT="$(env_port DB_HOST_PORT 5432)"
API_HOST_PORT="$(env_port API_HOST_PORT 3000)"
WEB_HOST_PORT="$(env_port WEB_HOST_PORT 5173)"

DB_URL_SUPERUSER="${DB_URL_SUPERUSER:-postgresql://postgres:password@localhost:${DB_HOST_PORT}/project_vault}"
DB_URL_APP="${DB_URL_APP:-postgresql://vault_app:dev-only-change-in-prod@localhost:${DB_HOST_PORT}/project_vault}"
API_URL="${API_URL:-http://localhost:${API_HOST_PORT}}"
MODE="dev"
INIT_VAULT=false
START_API=false

usage() {
  cat <<'EOF'
Usage: scripts/operator-bootstrap.sh [options]

  --dev              Start Postgres only, run migrations (default)
  --docker           docker compose up --build -d (full stack)
  --init-vault       If API is up: init (passphrase) + unseal when uninitialized/sealed
  --start-api        After --dev migrate, also docker compose up -d api web
  -h, --help         Show this help

Environment:
  DB_URL_SUPERUSER   Superuser URL for migrations (default: local postgres)
  DB_URL_APP         App role URL for check-rls (default: local vault_app)
  API_URL            API base URL (default: http://localhost:3000)
  VAULT_BOOTSTRAP_TOKEN   Required for init unless API has VAULT_ALLOW_REMOTE_INIT=true
  VAULT_DEV_PASSPHRASE    Passphrase for dev init/unseal (min 12 chars)

Examples:
  scripts/operator-bootstrap.sh
  VAULT_BOOTSTRAP_TOKEN=$(openssl rand -base64 32) VAULT_DEV_PASSPHRASE='local-dev-vault-pass' \
    scripts/operator-bootstrap.sh --dev --start-api --init-vault
  scripts/operator-bootstrap.sh --docker --init-vault
EOF
}

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

wait_for_postgres() {
  local tries="${1:-60}"
  log "Waiting for Postgres at localhost:${DB_HOST_PORT}..."
  for ((i = 1; i <= tries; i++)); do
    if docker compose exec -T db pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-project_vault}" >/dev/null 2>&1; then
      log "Postgres is ready"
      return 0
    fi
    sleep 1
  done
  die "Postgres did not become ready in ${tries}s"
}

wait_for_api_health() {
  local tries="${1:-90}"
  log "Waiting for API health at ${API_URL}/health..."
  for ((i = 1; i <= tries; i++)); do
    if curl -sf "${API_URL}/health" >/dev/null 2>&1; then
      log "API health OK"
      return 0
    fi
    sleep 2
  done
  die "API did not become healthy in $((tries * 2))s"
}

ready_reason() {
  curl -sf "${API_URL}/ready" 2>/dev/null | sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true
}

ready_status() {
  if curl -sf "${API_URL}/ready" >/dev/null 2>&1; then
    echo "ready"
  else
    ready_reason
  fi
}

init_and_unseal_vault() {
  local passphrase="${VAULT_DEV_PASSPHRASE:-}"
  [[ -n "$passphrase" ]] || die "Set VAULT_DEV_PASSPHRASE (min 12 characters) for --init-vault"
  command -v jq >/dev/null 2>&1 || die "jq is required for --init-vault (install jq)"

  local status
  status="$(ready_status)"
  log "Vault readiness: ${status:-unreachable}"

  if [[ "$status" == "ready" ]]; then
    log "Vault already initialized and unsealed"
    return 0
  fi

  local bootstrap_header=()
  if [[ -n "${VAULT_BOOTSTRAP_TOKEN:-}" ]]; then
    bootstrap_header=(-H "X-Vault-Bootstrap-Token: ${VAULT_BOOTSTRAP_TOKEN}")
  fi

  if [[ "$status" == "uninitialized" ]]; then
    log "Initializing vault (passphrase mode)..."
    local init_body
    init_body="$(jq -n --arg p "$passphrase" '{kmsType:"passphrase",passphrase:$p}')"
    local init_code
    init_code="$(curl -s -o /tmp/vault-init.json -w '%{http_code}' -X POST "${API_URL}/api/v1/vault/init" \
      -H 'Content-Type: application/json' \
      "${bootstrap_header[@]}" \
      -d "$init_body")"
    if [[ "$init_code" != "200" ]]; then
      cat /tmp/vault-init.json >&2 || true
      die "vault init failed (HTTP ${init_code})"
    fi
    log "Vault initialized"
  fi

  status="$(ready_status)"
  if [[ "$status" == "sealed" || "$status" == "uninitialized" ]]; then
    log "Unsealing vault..."
    local unseal_body
    unseal_body="$(jq -n --arg p "$passphrase" '{passphrase:$p}')"
    local unseal_code
    unseal_code="$(curl -s -o /tmp/vault-unseal.json -w '%{http_code}' -X POST "${API_URL}/api/v1/vault/unseal" \
      -H 'Content-Type: application/json' \
      -d "$unseal_body")"
    if [[ "$unseal_code" != "200" ]]; then
      cat /tmp/vault-unseal.json >&2 || true
      die "vault unseal failed (HTTP ${unseal_code})"
    fi
    log "Vault unsealed"
  fi

  if curl -sf "${API_URL}/ready" >/dev/null 2>&1; then
    log "Vault ready"
  else
    die "Vault still not ready after init/unseal — check API logs"
  fi
}

run_migrate() {
  log "Running migrations as postgres superuser..."
  DATABASE_URL="$DB_URL_SUPERUSER" pnpm db:migrate
  log "Migrations complete"
}

run_check_rls() {
  log "Verifying RLS coverage as vault_app..."
  DATABASE_URL="$DB_URL_APP" pnpm check-rls
  log "RLS check passed"
}

print_next_steps() {
  local token_hint="${VAULT_BOOTSTRAP_TOKEN:-}"
  if [[ -z "$token_hint" ]]; then
    token_hint="$(openssl rand -base64 32 2>/dev/null || echo 'GENERATE_WITH_openssl_rand_base64_32')"
  fi
  cat <<EOF

Bootstrap complete.

Next steps:
  1. Web UI:  http://localhost:${WEB_HOST_PORT}
  2. API:     ${API_URL}
  3. Readiness: curl -sf ${API_URL}/ready

Local dev (hot reload):
  export DATABASE_URL='${DB_URL_APP}'
  export VAULT_BOOTSTRAP_TOKEN='${token_hint}'
  export VAULT_ALLOW_REMOTE_INIT=true
  pnpm turbo dev

Full guide: docs/operator-quickstart.md
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev) MODE=dev; shift ;;
    --docker) MODE=docker; shift ;;
    --init-vault) INIT_VAULT=true; shift ;;
    --start-api) START_API=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

need_cmd docker
need_cmd pnpm
need_cmd curl

if [[ "$MODE" == "docker" ]]; then
  log "Starting full Docker stack..."
  docker compose up --build -d
  wait_for_postgres 120
  wait_for_api_health 120
else
  log "Starting Postgres container..."
  docker compose up -d db
  wait_for_postgres 60
  run_migrate
  run_check_rls
  if [[ "$START_API" == true ]]; then
    log "Starting api + web containers..."
    docker compose up -d api web
    wait_for_api_health 120
  fi
fi

if [[ "$INIT_VAULT" == true ]]; then
  if ! curl -sf "${API_URL}/health" >/dev/null 2>&1; then
    die "API not reachable at ${API_URL} — use --start-api or start the stack before --init-vault"
  fi
  init_and_unseal_vault
elif curl -sf "${API_URL}/health" >/dev/null 2>&1; then
  status="$(ready_status)"
  log "API vault state: ${status:-unknown}"
  if [[ "$status" != "ready" ]]; then
    log "Hint: export VAULT_DEV_PASSPHRASE and re-run with --init-vault, or use the web UI"
  fi
fi

print_next_steps
