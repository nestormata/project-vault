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
set -euo pipefail

DB_APP="${FLY_DB_APP:-project-vault-demo-db}"
PROXY_PORT="${FLY_DB_PROXY_PORT:-15432}"

: "${ADMIN_PG_PASSWORD:?Set ADMIN_PG_PASSWORD (postgres superuser password)}"

for bin in flyctl pnpm psql; do
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

echo "== Applying pending migrations =="
DATABASE_URL="$SUPERUSER_URL" pnpm --filter @project-vault/db db:migrate

echo "== Closing db proxy =="
cleanup
trap - EXIT

echo "Migrations up to date on ${DB_APP}"
