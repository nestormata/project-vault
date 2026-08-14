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
#   VAULT_APP_PASSWORD  vault_app password used for the post-migration RLS guard. In CI this is
#                       FLY_DEMO_VAULT_APP_PASSWORD; alternatively set RLS_CHECK_DATABASE_URL to
#                       an arbitrary vault_app connection string.
#   VAULT_ADMIN_PASSWORD vault_admin password provisioned for ADMIN_DATABASE_URL.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./fly-proxy-lib.sh
source "${SCRIPT_DIR}/fly-proxy-lib.sh"

DB_APP="${FLY_DB_APP:-project-vault-demo-db}"
PROXY_PORT="${FLY_DB_PROXY_PORT:-15432}"

: "${ADMIN_PG_PASSWORD:?Set ADMIN_PG_PASSWORD (postgres superuser password)}"
: "${VAULT_ADMIN_PASSWORD:?Set VAULT_ADMIN_PASSWORD (vault_admin password)}"

for bin in flyctl pnpm psql; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing required binary: $bin" >&2; exit 1; }
done

open_fly_db_proxy "$DB_APP" "$PROXY_PORT"

SUPERUSER_URL="postgresql://postgres:${ADMIN_PG_PASSWORD}@localhost:${PROXY_PORT}/project_vault"
RLS_CHECK_URL="${RLS_CHECK_DATABASE_URL:-postgresql://vault_app:${VAULT_APP_PASSWORD:?Set VAULT_APP_PASSWORD or RLS_CHECK_DATABASE_URL}@localhost:${PROXY_PORT}/project_vault}"

echo "== Applying pending migrations =="
DATABASE_URL="$SUPERUSER_URL" pnpm --filter @project-vault/db db:migrate

echo "== Provisioning vault_admin credential =="
psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE vault_admin PASSWORD '${VAULT_ADMIN_PASSWORD}';"

echo "== Verifying RLS as vault_app =="
DATABASE_URL="$RLS_CHECK_URL" pnpm check-rls

echo "== Closing db proxy =="
cleanup
trap - EXIT

echo "Migrations up to date on ${DB_APP}"
