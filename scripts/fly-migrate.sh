#!/usr/bin/env bash
# Applies pending migrations to the Fly.io demo Postgres app in place, without wiping data,
# reseeding, or touching Vault — unlike scripts/fly-reset.sh's destructive full reset. Meant to
# run on every deploy (see .github/workflows/fly-deploy.yml) so the demo API's code and the
# demo DB's schema never drift apart between deploys and the once-daily fly-reset.yml cron.
#
# guarded-migrate.ts (behind `pnpm --filter @project-vault/db db:migrate`) already refuses any
# pending migration containing a destructive operation unless --allow-destructive is passed
# (Story 9.3 AC-3) — this script deliberately never passes that flag, so a destructive migration
# fails this step (and the deploy) loudly rather than running unattended against the live demo.
#
# Requires: flyctl authenticated, pnpm (repo installed — pnpm install), packages/db (and its
# shared/crypto deps) already built, psql (for the readiness probe only).
# Run from the repo root.
#
# Required env:
#   ADMIN_PG_PASSWORD  postgres superuser password (scripts/fly-setup.sh printed it; same value
#                      as fly-reset.sh's ADMIN_PG_PASSWORD / the FLY_DEMO_PG_SUPERUSER_PASSWORD
#                      GitHub Actions secret)
#   VAULT_APP_PASSWORD  vault_app password (FLY_DEMO_VAULT_APP_PASSWORD in CI). Story 43.28: vault_app
#                       is ALTERed to it after every migrate run, like vault_admin, so the api's
#                       DATABASE_URL matches the db before any api boots. Always required;
#                       RLS_CHECK_DATABASE_URL only overrides the RLS-check connection string.
#   VAULT_ADMIN_PASSWORD vault_admin password provisioned for ADMIN_DATABASE_URL.
#   FLY_INTERNAL_CA_CERT_B64 / FLY_INTERNAL_CA_KEY_B64  the internal CA (Story 43.16); a 1-day
#                       operator client certificate is minted from it for this run only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./fly-proxy-lib.sh
source "${SCRIPT_DIR}/fly-proxy-lib.sh"

DB_APP="${FLY_DB_APP:-project-vault-demo-db}"
PROXY_PORT="${FLY_DB_PROXY_PORT:-15432}"

: "${ADMIN_PG_PASSWORD:?Set ADMIN_PG_PASSWORD (postgres superuser password)}"
: "${VAULT_ADMIN_PASSWORD:?Set VAULT_ADMIN_PASSWORD (vault_admin password)}"
: "${VAULT_APP_PASSWORD:?Set VAULT_APP_PASSWORD (vault_app password; this script ALTERs vault_app to it)}"
# Story 43.16: the db requires a client certificate; one is minted per run from the internal CA
# (GitHub secrets FLY_DEMO_INTERNAL_CA_CERT_B64 / FLY_DEMO_INTERNAL_CA_KEY_B64).
: "${FLY_INTERNAL_CA_CERT_B64:?Set FLY_INTERNAL_CA_CERT_B64 (see docs/runbooks/fly-internal-tls.md)}"
: "${FLY_INTERNAL_CA_KEY_B64:?Set FLY_INTERNAL_CA_KEY_B64 (see docs/runbooks/fly-internal-tls.md)}"

for bin in flyctl pnpm psql; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing required binary: $bin" >&2; exit 1; }
done

open_fly_db_proxy "$DB_APP" "$PROXY_PORT"
issue_operator_tls "$SCRIPT_DIR"

SUPERUSER_URL="postgresql://postgres:${ADMIN_PG_PASSWORD}@localhost:${PROXY_PORT}/project_vault?sslmode=verify-full"
SUPERUSER_PSQL_URL="$(operator_psql_url postgres "$ADMIN_PG_PASSWORD" "$PROXY_PORT")"
RLS_CHECK_URL="${RLS_CHECK_DATABASE_URL:-postgresql://vault_app:${VAULT_APP_PASSWORD}@localhost:${PROXY_PORT}/project_vault?sslmode=verify-full}"

echo "== Applying pending migrations =="
DATABASE_URL="$SUPERUSER_URL" with_operator_tls pnpm --filter @project-vault/db db:migrate

echo "== Provisioning vault_admin credential =="
psql "$SUPERUSER_PSQL_URL" -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE vault_admin PASSWORD '${VAULT_ADMIN_PASSWORD}';"

# Story 43.28: after the migrate (on a fresh db, migration 0001 creates vault_app) and before the
# RLS check, which connects as vault_app. Same psql -c mechanism as vault_admin above, so the
# password is on psql's argv on the runner for the call's lifetime, exactly as before.
echo "== Provisioning vault_app credential =="
psql "$SUPERUSER_PSQL_URL" -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE vault_app PASSWORD '${VAULT_APP_PASSWORD}';"

echo "== Verifying RLS as vault_app =="
DATABASE_URL="$RLS_CHECK_URL" with_operator_tls pnpm check-rls

echo "== Closing db proxy =="
cleanup
trap - EXIT

echo "Migrations up to date on ${DB_APP}"
