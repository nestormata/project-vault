#!/usr/bin/env bash
# One-time provisioning for the project-vault Fly.io demo (self-hosted db, per the
# managed-vs-self-hosted decision — see conversation/CLAUDE memory, not re-litigated here).
#
# Creates 3 Fly apps (db private, api private, web public), a Postgres volume, and every
# secret the api/web apps need at boot. Safe to re-run: `flyctl apps create`/`flyctl volumes
# create`/`flyctl secrets set` are all idempotent or explicitly guarded below.
#
# Usage: FLY_ORG=personal VAULT_APP_PASSWORD=... VAULT_ADMIN_PASSWORD=... \
#          FLY_INTERNAL_CA_CERT_B64=... FLY_INTERNAL_CA_KEY_B64=... ./scripts/fly-setup.sh
#
# Story 43.16: the internal hops are TLS 1.3 with a private CA (web -> api mTLS, api/operator -> db
# with client certificates). FLY_INTERNAL_CA_*_B64 are the GitHub secrets
# FLY_DEMO_INTERNAL_CA_CERT_B64 / FLY_DEMO_INTERNAL_CA_KEY_B64 (docs/runbooks/fly-internal-tls.md);
# scripts/fly-internal-tls.sh issues and stages every leaf from them.
#
# Requires: flyctl authenticated (`flyctl auth login`), openssl.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DB_APP="${FLY_DB_APP:-project-vault-demo-db}"
API_APP="${FLY_API_APP:-project-vault-demo-api}"
WEB_APP="${FLY_WEB_APP:-project-vault-demo-web}"
REGION="${FLY_REGION:-iad}"
ORG="${FLY_ORG:?Set FLY_ORG to your Fly.io org slug (flyctl orgs list)}"
# Required, checked before any flyctl call: there is no default, because the only possible one is
# the migration's publicly known dev password (see the api secrets section below).
: "${VAULT_APP_PASSWORD:?Set VAULT_APP_PASSWORD to the vault_app password (fly-reset.sh ALTERs vault_app to this value; it must match)}"
# Required, checked before any flyctl call (Story 43.16): without the CA no internal leaf can be
# issued, and the db image and api refuse to start without their TLS material.
: "${FLY_INTERNAL_CA_CERT_B64:?Set FLY_INTERNAL_CA_CERT_B64 (GitHub secret FLY_DEMO_INTERNAL_CA_CERT_B64; see docs/runbooks/fly-internal-tls.md)}"
: "${FLY_INTERNAL_CA_KEY_B64:?Set FLY_INTERNAL_CA_KEY_B64 (GitHub secret FLY_DEMO_INTERNAL_CA_KEY_B64; see docs/runbooks/fly-internal-tls.md)}"

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
: "${VAULT_ADMIN_PASSWORD:?Set VAULT_ADMIN_PASSWORD to the provisioned vault_admin credential}"
flyctl secrets set -a "$DB_APP" \
  POSTGRES_USER=postgres \
  POSTGRES_PASSWORD="$PG_PASSWORD"

echo "== internal TLS: issue + stage leaves for db, api and web =="
# Before the db deploy: the db image (deploy/fly/db) fails closed without DB_TLS_*. Staged secrets
# apply on each app's next deploy.
FLY_API_APP="$API_APP" FLY_WEB_APP="$WEB_APP" FLY_DB_APP="$DB_APP" \
  "${SCRIPT_DIR}/fly-internal-tls.sh" issue-leaves

echo "== db: deploy =="
flyctl deploy -c fly.db.toml -a "$DB_APP" --ha=false --remote-only

echo "== api: secrets =="
# NODE_ENV=production (fly.api.toml) means apps/api/src/config/env.ts enforces distinct,
# non-placeholder secrets for every one of these — generate fresh randoms rather than
# reusing docker-compose.yml's dev letter-repeated placeholders.
VAULT_PASSPHRASE="${DEMO_VAULT_PASSPHRASE:-$(openssl rand -base64 24)}"
# POST /api/v1/vault/init requires this exact header (apps/api/src/modules/vault routes) —
# generated once and reused by fly-reset.sh on every subsequent reset, same override
# pattern as VAULT_PASSPHRASE above.
BOOTSTRAP_TOKEN="${VAULT_BOOTSTRAP_TOKEN:-$(openssl rand -base64 32)}"
# vault_app doesn't exist yet — db:migrate creates it (packages/db/src/migrations/
# 0001_rls_and_triggers.sql) with a hardcoded 'dev-only-change-in-prod' password.
# scripts/fly-reset.sh ALTERs it to VAULT_APP_PASSWORD right after every migrate run, so
# DATABASE_URL below points at the final password from the start. VAULT_APP_PASSWORD is
# required (checked at the top): it must be the value you pass to fly-reset.sh (and, if you're
# wiring up the nightly cron, FLY_DEMO_VAULT_APP_PASSWORD).
# sslmode=verify-full documents intent; the pin itself is DATABASE_TLS_CA_B64 (plus the api's DB
# client certificate), staged above and applied by packages/db's pgTlsOptions (Story 43.16).
# NOTE: unlike the staged TLS secrets, these apply immediately and restart running api machines —
# on a live demo, run the full deploy (db -> api -> web) right after (see the runbook).
flyctl secrets set -a "$API_APP" \
  DATABASE_URL="postgresql://vault_app:${VAULT_APP_PASSWORD}@${DB_APP}.internal:5432/project_vault?sslmode=verify-full" \
  ADMIN_DATABASE_URL="postgresql://vault_admin:${VAULT_ADMIN_PASSWORD}@${DB_APP}.internal:5432/project_vault?sslmode=verify-full" \
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
  OPERATIONAL_STATUS_TOKEN_HMAC_SECRET="$(openssl rand -hex 32)" \
  SSO_STATE_HMAC_SECRET="$(openssl rand -hex 32)" \
  ERASURE_EMAIL_HASH_SECRET="$(openssl rand -hex 32)" \
  VAULT_BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN" \
  DEMO_VAULT_PASSPHRASE="$VAULT_PASSPHRASE"

echo "== web: secrets =="
# The api listener terminates TLS 1.3 and requires the web's client certificate (mTLS); the web
# pins the private CA via API_TLS_CA_B64 (staged above).
flyctl secrets set -a "$WEB_APP" \
  API_BASE_URL="https://${API_APP}.internal:3000"

cat <<EOF

== Next: deploy the selected release ==
  Run the Fly Demo Bootstrap workflow with release_tag=vMAJOR.MINOR.PATCH.
  It will deploy api and web from that exact release tag.

Then run scripts/fly-reset.sh (or the Fly Demo Reset workflow) to migrate schema, seed
demo data, and init/unseal vault. It needs ADMIN_PG_PASSWORD, VAULT_APP_PASSWORD, and
VAULT_ADMIN_PASSWORD,
DEMO_VAULT_PASSPHRASE to match whatever you passed to this script (defaults were used
for any you didn't override) — if those already live in GitHub Actions secrets
(FLY_DEMO_PG_SUPERUSER_PASSWORD etc.), prefer running the workflow via workflow_dispatch
over reconstructing them locally, since GitHub secrets can't be read back once set.
EOF
