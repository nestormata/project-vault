#!/usr/bin/env bash
# Nightly (or on-demand) reset for the project-vault Fly.io demo: wipes the self-hosted
# Postgres app back to empty, re-runs migrations, reseeds demo data, and re-initializes +
# unseals Vault (fresh DB means Vault is always "uninitialized" after this, unlike
# scripts/operator-bootstrap.sh's --init-vault which also tolerates an already-ready vault).
#
# Deliberately drop-and-recreate rather than pg_dump/restore-from-snapshot: the schema is
# small and `db:migrate` + `db:seed:test` take seconds, so a golden-snapshot restore isn't
# worth the extra artifact to maintain for a demo.
#
# Requires: flyctl authenticated, pnpm (repo installed — pnpm install), jq, psql.
# Run from the repo root.
#
# Required env:
#   ADMIN_PG_PASSWORD     postgres superuser password (scripts/fly-setup.sh printed it)
#   VAULT_APP_PASSWORD    vault_app role password (default matches pre-hardening compose value)
#   DEMO_VAULT_PASSPHRASE passphrase used for vault init/unseal (scripts/fly-setup.sh printed it)
#   DEMO_LOGIN_EMAIL      email for the one real, login-able seeded user
#   DEMO_LOGIN_PASSWORD   its password — never written to Fly secrets or committed anywhere;
#                         lives only as a GitHub Actions secret, piped through to the seed
#                         process (packages/db/src/seed-demo.ts), which argon2-hashes it
#                         before it ever touches the database
set -euo pipefail

DB_APP="${FLY_DB_APP:-project-vault-demo-db}"
API_APP="${FLY_API_APP:-project-vault-demo-api}"
WEB_APP="${FLY_WEB_APP:-project-vault-demo-web}"
WEB_URL="https://${WEB_APP}.fly.dev"
PROXY_PORT="${FLY_DB_PROXY_PORT:-15432}"

: "${ADMIN_PG_PASSWORD:?Set ADMIN_PG_PASSWORD (postgres superuser password)}"
: "${DEMO_VAULT_PASSPHRASE:?Set DEMO_VAULT_PASSPHRASE}"
: "${DEMO_LOGIN_EMAIL:?Set DEMO_LOGIN_EMAIL}"
: "${DEMO_LOGIN_PASSWORD:?Set DEMO_LOGIN_PASSWORD}"
VAULT_APP_PASSWORD="${VAULT_APP_PASSWORD:-dev-only-change-in-prod}"

for bin in flyctl pnpm jq psql curl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing required binary: $bin" >&2; exit 1; }
done

echo "== Opening WireGuard proxy to ${DB_APP}.internal:5432 =="
flyctl proxy "${PROXY_PORT}:5432" -a "$DB_APP" &
PROXY_PID=$!
cleanup() { kill "$PROXY_PID" 2>/dev/null || true; }
trap cleanup EXIT

for ((i = 1; i <= 30; i++)); do
  pg_isready -h localhost -p "$PROXY_PORT" -U postgres >/dev/null 2>&1 && break
  sleep 1
  [[ $i -eq 30 ]] && { echo "flyctl proxy never became reachable" >&2; exit 1; }
done

SUPERUSER_URL="postgresql://postgres:${ADMIN_PG_PASSWORD}@localhost:${PROXY_PORT}/project_vault"
APP_URL="postgresql://vault_app:${VAULT_APP_PASSWORD}@localhost:${PROXY_PORT}/project_vault"

echo "== Wiping schema =="
psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
-- drizzle-kit tracks applied migrations in its own 'drizzle' schema (default
-- __drizzle_migrations table), separate from 'public'. Without dropping it too, the next
-- db:migrate sees every migration already recorded as applied and does nothing — even
-- though 'public' (and vault_app) was just wiped — so the role never gets recreated.
DROP SCHEMA IF EXISTS drizzle CASCADE;
-- DROP SCHEMA CASCADE only removes objects owned BY vault_app inside that schema; it
-- doesn't revoke database-level privileges GRANTed TO vault_app (e.g. from db:migrate's
-- own GRANT statements), which blocks DROP ROLE with "cannot be dropped because some
-- objects depend on it". DROP OWNED BY clears both.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vault_app') THEN
    EXECUTE 'DROP OWNED BY vault_app';
    EXECUTE 'DROP ROLE vault_app';
  END IF;
END $$;
SQL

echo "== Running migrations (creates vault_app role + RLS + schema) =="
DATABASE_URL="$SUPERUSER_URL" pnpm --filter @project-vault/db db:migrate

echo "== Hardening vault_app password to match VAULT_APP_PASSWORD =="
psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE vault_app PASSWORD '${VAULT_APP_PASSWORD}';"

echo "== Seeding demo data (including a login-able user) =="
DATABASE_URL="$APP_URL" DEMO_LOGIN_EMAIL="$DEMO_LOGIN_EMAIL" DEMO_LOGIN_PASSWORD="$DEMO_LOGIN_PASSWORD" \
  pnpm --filter @project-vault/db db:seed:demo

echo "== Closing db proxy =="
cleanup
trap - EXIT

echo "== Waiting for api to be reachable via ${WEB_URL} =="
# The api machine can be mid-restart (Fly machine lifecycle, or a leftover crash-loop
# from a first-ever deploy racing db:migrate) exactly when this script reaches here — a
# bare vault/init call at the wrong moment gets api_unreachable. Poll /ready (proxied
# through web) until it reports anything other than that specific reason.
for ((i = 1; i <= 30; i++)); do
  ready_reason="$(curl -s "${WEB_URL}/ready" 2>/dev/null | jq -r '.reason // empty')"
  [[ "$ready_reason" != "api_unreachable" ]] && break
  sleep 2
  [[ $i -eq 30 ]] && { echo "api never became reachable via ${WEB_URL}/ready" >&2; exit 1; }
done

echo "== Initializing + unsealing vault via ${WEB_URL} =="
init_body="$(jq -n --arg p "$DEMO_VAULT_PASSPHRASE" '{kmsType:"passphrase",passphrase:$p}')"
init_code="$(curl -s -o /tmp/fly-vault-init.json -w '%{http_code}' -X POST "${WEB_URL}/api/v1/vault/init" \
  -H 'Content-Type: application/json' -d "$init_body")"
if [[ "$init_code" != "200" ]]; then
  cat /tmp/fly-vault-init.json >&2
  echo "vault init failed (HTTP ${init_code})" >&2
  exit 1
fi

unseal_body="$(jq -n --arg p "$DEMO_VAULT_PASSPHRASE" '{passphrase:$p}')"
unseal_code="$(curl -s -o /tmp/fly-vault-unseal.json -w '%{http_code}' -X POST "${WEB_URL}/api/v1/vault/unseal" \
  -H 'Content-Type: application/json' -d "$unseal_body")"
if [[ "$unseal_code" != "200" ]]; then
  cat /tmp/fly-vault-unseal.json >&2
  echo "vault unseal failed (HTTP ${unseal_code})" >&2
  exit 1
fi

if ! curl -sf "${WEB_URL}/ready" >/dev/null 2>&1; then
  echo "vault initialized/unsealed but /ready still failing — check api logs" >&2
  exit 1
fi

echo "== Restarting api app (clears any stale DB pool/session state) =="
flyctl apps restart "$API_APP"

echo "Reset complete: ${WEB_URL}"
