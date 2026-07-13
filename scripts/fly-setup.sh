#!/usr/bin/env bash
# One-time provisioning for the project-vault Fly.io demo (self-hosted db, per the
# managed-vs-self-hosted decision — see conversation/CLAUDE memory, not re-litigated here).
#
# Creates 3 Fly apps (db private, api private, web public), a Postgres volume, and every
# secret the api/web apps need at boot. Safe to re-run: `flyctl apps create`/`flyctl volumes
# create`/`flyctl secrets set` are all idempotent or explicitly guarded below.
#
# Usage: FLY_ORG=personal ./scripts/fly-setup.sh
#
# Requires: flyctl authenticated (`flyctl auth login`), openssl.
set -euo pipefail

DB_APP="${FLY_DB_APP:-project-vault-demo-db}"
API_APP="${FLY_API_APP:-project-vault-demo-api}"
WEB_APP="${FLY_WEB_APP:-project-vault-demo-web}"
REGION="${FLY_REGION:-iad}"
ORG="${FLY_ORG:?Set FLY_ORG to your Fly.io org slug (flyctl orgs list)}"

command -v flyctl >/dev/null 2>&1 || { echo "flyctl not found — see https://fly.io/docs/flyctl/install/" >&2; exit 1; }

echo "== Creating apps (region=${REGION}, org=${ORG}) =="
for app in "$DB_APP" "$API_APP" "$WEB_APP"; do
  flyctl apps create "$app" --org "$ORG" 2>&1 | grep -v "Name has already been taken" || true
done

echo "== db: volume =="
flyctl volumes list -a "$DB_APP" --json 2>/dev/null | grep -q project_vault_demo_db_data \
  || flyctl volumes create project_vault_demo_db_data -a "$DB_APP" --region "$REGION" --size 3 --yes

echo "== db: secrets =="
# Respects ADMIN_PG_PASSWORD if you already minted one (e.g. it's already stored as the
# FLY_DEMO_PG_SUPERUSER_PASSWORD GitHub Actions secret) — Fly and GitHub must agree on this
# value, and GitHub secrets can't be read back once set, so pass the same value you used
# there rather than letting this script mint a second, different one.
PG_PASSWORD="${ADMIN_PG_PASSWORD:-$(openssl rand -hex 24)}"
flyctl secrets set -a "$DB_APP" \
  POSTGRES_USER=postgres \
  POSTGRES_PASSWORD="$PG_PASSWORD"

echo "== db: deploy =="
flyctl deploy -c fly.db.toml -a "$DB_APP" --ha=false

echo "== api: secrets =="
# NODE_ENV=production (fly.api.toml) means apps/api/src/config/env.ts enforces distinct,
# non-placeholder secrets for every one of these — generate fresh randoms rather than
# reusing docker-compose.yml's dev letter-repeated placeholders.
VAULT_PASSPHRASE="${DEMO_VAULT_PASSPHRASE:-$(openssl rand -base64 24)}"
# vault_app doesn't exist yet — db:migrate creates it (packages/db/src/migrations/
# 0001_rls_and_triggers.sql) with a hardcoded 'dev-only-change-in-prod' password.
# scripts/fly-reset.sh ALTERs it to this same value right after every migrate run, so
# DATABASE_URL below can point at the final password from the start; no separate manual
# hardening step needed as long as VAULT_APP_PASSWORD here matches what you pass to
# fly-reset.sh (and, if you're wiring up the nightly cron, FLY_DEMO_VAULT_APP_PASSWORD).
flyctl secrets set -a "$API_APP" \
  DATABASE_URL="postgresql://vault_app:${VAULT_APP_PASSWORD:-dev-only-change-in-prod}@${DB_APP}.internal:5432/project_vault" \
  ADMIN_DATABASE_URL="postgresql://postgres:${PG_PASSWORD}@${DB_APP}.internal:5432/project_vault" \
  CORS_ALLOWED_ORIGINS="https://${WEB_APP}.fly.dev" \
  SESSION_SECRET="$(openssl rand -hex 32)" \
  REFRESH_TOKEN_HMAC_SECRET="$(openssl rand -hex 32)" \
  TOTP_REPLAY_HMAC_SECRET="$(openssl rand -hex 32)" \
  MFA_PENDING_SESSION_HMAC_SECRET="$(openssl rand -hex 32)" \
  INVITATION_TOKEN_HMAC_SECRET="$(openssl rand -hex 32)" \
  RECOVERY_TOKEN_HMAC_SECRET="$(openssl rand -hex 32)" \
  API_KEY_HMAC_SECRET="$(openssl rand -hex 32)" \
  MACHINE_JWT_SECRET="$(openssl rand -hex 32)" \
  STATUS_PAGE_TOKEN_HMAC_SECRET="$(openssl rand -hex 32)" \
  ERASURE_EMAIL_HASH_SECRET="$(openssl rand -hex 32)" \
  VAULT_BOOTSTRAP_TOKEN="$(openssl rand -base64 32)" \
  DEMO_VAULT_PASSPHRASE="$VAULT_PASSPHRASE"

echo "== web: secrets =="
flyctl secrets set -a "$WEB_APP" \
  API_BASE_URL="http://${API_APP}.internal:3000"

cat <<EOF

== Next: deploy api and web ==
  flyctl deploy -c fly.api.toml -a ${API_APP} --ha=false
  flyctl deploy -c fly.web.toml -a ${WEB_APP} --ha=false

Then run scripts/fly-reset.sh (or the Fly Demo Reset workflow) to migrate schema, seed
demo data, and init/unseal vault. It needs ADMIN_PG_PASSWORD, VAULT_APP_PASSWORD, and
DEMO_VAULT_PASSPHRASE to match whatever you passed to this script (defaults were used
for any you didn't override) — if those already live in GitHub Actions secrets
(FLY_DEMO_PG_SUPERUSER_PASSWORD etc.), prefer running the workflow via workflow_dispatch
over reconstructing them locally, since GitHub secrets can't be read back once set.
EOF
