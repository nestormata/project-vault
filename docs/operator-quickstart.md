# Operator Quickstart — Zero to Eval-Ready

This is the single source of truth for setting up Project Vault. Four paths:

| Path | For | Time |
|------|-----|------|
| [**A — Local dev**](#path-a--local-dev-fastest-for-ui-work) | Hot reload, UI work, running the test suite | ~5 min |
| [**B — Full Docker stack**](#path-b--full-docker-stack) | Evaluating production-like images, built from this checkout | ~10 min (first build) |
| [**C — Prebuilt GHCR images**](#path-c--prebuilt-ghcr-images) | Running a release without building anything | ~3 min |
| [**D — Production**](#path-d--production) | Any non-dev deployment | plan for an hour |

Every key the app understands is documented in [docs/configuration.md](configuration.md); the
copyable file is [`.env.example`](../.env.example). Day-to-day dev commands live in the
[Development guide](development.md); operating a live instance is [docs/runbook.md](runbook.md).

---

## Ports and URLs (read this before copying any command)

**Ports are per-checkout.** `make bootstrap`, `make bootstrap-docker`, `make docker-up`,
`make docker-smoke` and `make e2e` all run `scripts/docker-ports.sh fix`, which rewrites
`DB_HOST_PORT` / `API_HOST_PORT` / `WEB_HOST_PORT` in `.env` to values derived from this
checkout's path (roughly `2xxxx` / `3xxxx` / `4xxxx`) — **even when 5432/3000/5173 are free**.
That is deliberate: several worktrees have to be able to run at once. It also means the classic
port numbers are usually wrong for your checkout.

Read the real values, and build every URL from them:

```bash
set -a; source <(grep -E '^(DB|API|WEB)_HOST_PORT=' .env); set +a
echo "db=$DB_HOST_PORT api=http://localhost:$API_HOST_PORT web=http://localhost:$WEB_HOST_PORT"
```

Re-run that snippet in each new shell — the rest of this guide assumes those three variables are
exported, and never writes a literal port.

**Opt out (single checkout):** export `DOCKER_PORTS_KEEP_DEFAULTS=1` and the script keeps
5432/3000/5173. It still moves a port that is genuinely in use by something else, and prints
`FIXED …(was already in use)` when it does. Put it in your shell profile, or prefix each command:

```bash
DOCKER_PORTS_KEEP_DEFAULTS=1 make bootstrap
```

Do **not** set it when you run several worktrees of this repo concurrently — that is exactly the
collision the remapping exists to prevent.

---

## Two database roles (read this first)

| Role | Connection string (local default) | Use for |
|------|-----------------------------------|---------|
| **`postgres`** (superuser) | `postgresql://postgres:password@localhost:${DB_HOST_PORT}/project_vault` | **Migrations only** — creates `vault_app`, `vault_admin`, RLS policies, triggers |
| **`vault_app`** (app role) | `postgresql://vault_app:dev-only-change-in-prod@localhost:${DB_HOST_PORT}/project_vault` | **`DATABASE_URL`** — the API, tests, `check-rls`, `pnpm turbo dev` |
| **`vault_admin`** (admin pool) | `postgresql://vault_admin:password@localhost:${DB_HOST_PORT}/project_vault` | **`ADMIN_DATABASE_URL`** — reviewed cross-org / pre-auth reads. Non-superuser but `BYPASSRLS`. **Must be provisioned** — see below |

Using `postgres` for the app or tests **bypasses Row-Level Security** and produces false-green
isolation results. The API refuses to start if `DATABASE_URL` names `postgres`, or if
`ADMIN_DATABASE_URL` is missing or names the same role as `DATABASE_URL`.

**`vault_admin` has no password until something provisions one.** Migration
`0071_admin_pool_role.sql` creates the role deliberately without a usable password. It is set by:

* the Compose `admin-provision` service (runs automatically in `make docker-up` /
  `make bootstrap-docker`), or
* `make bootstrap`, which runs the equivalent `ALTER ROLE` after migrating, or
* `make ci-inner` / CI, for the test database.

If you migrate a database by hand and skip all three, the API fails with
`password authentication failed for user "vault_admin"`.

Inside Docker Compose, the API uses hostname `db` instead of `localhost`:

```text
postgresql://vault_app:dev-only-change-in-prod@db:5432/project_vault
```

---

## Path A — Local dev (fastest for UI work)

Hot reload for both apps (`pnpm turbo dev`), with Postgres in Docker.

### Prerequisites

* Node.js 24 LTS (`.nvmrc` pins 24 — `nvm use`)
* pnpm **11.21.0+** — `corepack enable && corepack prepare pnpm@11.21.0 --activate` picks up the
  version pinned in `package.json`. pnpm 9 will refuse this lockfile.
* Docker 24+ (Compose v2.24+ for the prebuilt-image path)
* `curl`, `openssl`, and `jq` (only `--init-vault` needs `jq`)
* macOS or Linux. Windows: WSL2 with the Docker Desktop WSL2 backend —
  `scripts/docker-ports.sh` uses bash's `/dev/tcp`, so run it from bash, not PowerShell.

### Steps

```bash
corepack enable && corepack prepare pnpm@11.21.0 --activate
pnpm install

cp .env.example .env
make bootstrap          # starts Postgres, migrates, provisions vault_admin, checks RLS
```

`make bootstrap` prints a "Next steps" block containing the two export lines below with **this
checkout's** ports already filled in. Copy them from its output, or rebuild them yourself:

```bash
set -a; source <(grep -E '^(DB|API|WEB)_HOST_PORT=' .env); set +a
export DATABASE_URL="postgresql://vault_app:dev-only-change-in-prod@localhost:${DB_HOST_PORT}/project_vault"
export ADMIN_DATABASE_URL="postgresql://vault_admin:password@localhost:${DB_HOST_PORT}/project_vault"
export VAULT_ALLOW_REMOTE_INIT=true   # local dev only — never in production
pnpm turbo dev
```

Both URLs are mandatory. Nothing auto-loads `.env` for turbo tasks, so they must be exported in
the same shell that runs `pnpm turbo dev`; without `ADMIN_DATABASE_URL` the API exits with
`FATAL: ADMIN_DATABASE_URL is required`.

**Turbo env passthrough:** vault operator variables are not in `turbo.json`'s `globalEnv` (they
are secrets). They are listed in `globalPassThroughEnv`, so a parent-shell export reaches the API
dev task:

| Variable | Purpose |
|----------|---------|
| `VAULT_BOOTSTRAP_TOKEN` | Required for `POST /api/v1/vault/init` when `VAULT_ALLOW_REMOTE_INIT` is not `true`. Minimum 32 characters |
| `VAULT_ENVELOPE_KEY_HALF` | Envelope KMS mode (production-style split key) |
| `VAULT_ALLOW_REMOTE_INIT` | `true` only on local dev — skips the bootstrap token on init |

If you change these exports, **restart** `pnpm turbo dev` (Turbo reads env at task start).

#### Optional: let the script do the vault ceremony

```bash
export VAULT_BOOTSTRAP_TOKEN="$(openssl rand -base64 32)"
export VAULT_DEV_PASSPHRASE='your-local-vault-passphrase-min-12'
make bootstrap ARGS="--start-api --init-vault"
```

* `ARGS="…"` is the only supported form — `make bootstrap -- --init-vault` fails with
  `No rule to make target '--init-vault'`.
* `--start-api` is required in dev mode: `--init-vault` needs a reachable API, and it starts the
  **container** API/web on `API_HOST_PORT`/`WEB_HOST_PORT` (not `pnpm turbo dev`).
* `VAULT_DEV_PASSPHRASE` **is the vault's permanent unseal passphrase**, not a throwaway. Minimum
  12 characters. Keep it: you need it after every restart until the vault is unsealed. `jq` is
  required for this flag.

### Vault ceremony (web UI)

Open `http://localhost:${WEB_HOST_PORT}`.

1. **Uninitialized** → **Initialize vault** → Passphrase mode → choose a passphrase (reused for
   unseal). With `VAULT_ALLOW_REMOTE_INIT=true` (set above) the **bootstrap-token field may be
   left blank** — the token is what production uses instead, see Path D.
2. **Sealed** → **Unseal vault** → same passphrase.
3. **Ready** → **Register** the first user → **Sign in** (registration does not auto-login). The
   first registered user becomes the platform operator.

### Expected result

```bash
curl -s -i "http://localhost:${API_HOST_PORT}/health"   # HTTP/1.1 200, {"status":"ok",...}
curl -s -i "http://localhost:${API_HOST_PORT}/ready"    # HTTP/1.1 200, {"status":"ready"}
```

`pnpm turbo dev` prints `API startup complete` and a `Local:` line carrying the web dev server's
own port. That port is chosen by Vite and is independent of the Compose port mapping, so if it
differs from `WEB_HOST_PORT`, browse the address the `Local:` line actually printed.

### Path A troubleshooting

See the [Troubleshooting](#troubleshooting) section — the entries for
`FATAL: ADMIN_DATABASE_URL is required`,
`password authentication failed for user "vault_admin"` and `ECONNREFUSED` cover almost every
Path A failure.

---

## Path B — Full Docker stack

Production-like images built from this checkout. No local Node required.

### Prerequisites

Docker 24+ with Compose v2, `curl`, `openssl`. Several GB of free disk for the first build.

### Steps

```bash
cp .env.example .env

# REQUIRED — without it every POST /api/v1/vault/init returns 403 BOOTSTRAP_FORBIDDEN,
# including from the web UI. Minimum 32 characters.
printf 'VAULT_BOOTSTRAP_TOKEN=%s\n' "$(openssl rand -base64 32)" >> .env

export VAULT_DEV_PASSPHRASE='your-local-vault-passphrase-min-12'
make bootstrap-docker ARGS="--init-vault"      # drop ARGS to do the ceremony in the web UI
```

The API container reads `VAULT_BOOTSTRAP_TOKEN` from `.env` via Compose interpolation, or from
your shell — the shell wins. Writing it to `.env` is what makes it survive a new terminal.

> **First build takes several minutes.** The API image is a multi-stage build that compiles the
> native `argon2` addon. Subsequent starts reuse the cached layers.

### Expected result

```bash
set -a; source <(grep -E '^(DB|API|WEB)_HOST_PORT=' .env); set +a
docker compose ps
```

```text
NAME                       SERVICE           STATUS
<project>-db-1             db                Up (healthy)
<project>-migrate-1        migrate           Exited (0)
<project>-admin-provision-1 admin-provision  Exited (0)
<project>-api-1            api               Up (healthy)
<project>-web-1            web               Up
<project>-mailpit-1        mailpit           Up
```

`migrate` and `admin-provision` are one-shot jobs — `Exited (0)` is success, not a failure.

```bash
curl -s -i "http://localhost:${API_HOST_PORT}/health"
curl -s -i "http://localhost:${API_HOST_PORT}/ready"
```

Use `curl -s -i`, not `curl -sf`: `-f` suppresses the response body, which is where the reason
lives. Before the vault ceremony `/ready` answers:

```text
HTTP/1.1 503 Service Unavailable
{"status":"unavailable","reason":"uninitialized"}
```

That is the expected state on a fresh `db_data` volume, not a broken stack. Finish the ceremony
(web UI at `http://localhost:${WEB_HOST_PORT}`, or re-run `make bootstrap-docker
ARGS="--init-vault"`) and `/ready` turns into `200 {"status":"ready"}`.

`make docker-smoke` reports the same distinction: `RESULT: READY`, or `RESULT: READY-PENDING`
when the vault has not been initialized on this volume yet. Note that it runs
`docker compose down` when it finishes — it stops the stack (named volumes are kept).

### Path B troubleshooting

`BOOTSTRAP_FORBIDDEN`, the `X is required in production` secret errors and the migration-drift
500s are all covered under [Troubleshooting](#troubleshooting).

---

## Path C — Prebuilt GHCR images

Run a published release without building anything. See
[docs/container-images.md](container-images.md) for tags, digests and multi-arch details.

### Prerequisites

* Docker Compose **v2.24 or newer** — `docker compose version`. The overlay uses `!reset`, which
  older versions do not understand.
* Network access to `ghcr.io` (the images are public; no registry credential needed).

### Steps

```bash
cp .env.example .env
printf 'VAULT_BOOTSTRAP_TOKEN=%s\n' "$(openssl rand -base64 32)" >> .env

# Pin the release you want (default: latest)
printf 'VAULT_IMAGE_TAG=%s\n' '1.2.3' >> .env

make fix-ports    # or DOCKER_PORTS_KEEP_DEFAULTS=1 make fix-ports

docker compose -f docker-compose.yml -f docker-compose.images.yml pull
docker compose -f docker-compose.yml -f docker-compose.images.yml up -d
```

**File order matters.** `docker-compose.images.yml` comes after `docker-compose.yml`; if you also
use the production overlay it stays last:

```bash
docker compose -f docker-compose.yml -f docker-compose.images.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.images.yml -f docker-compose.prod.yml up -d
```

The overlay sets `build: !reset null` on `migrate`, `api` and `web`, which removes the base file's
`build:` blocks entirely — so a stray `--build` (or `make docker-up`, which always passes it) can
no longer silently rebuild from source behind your back.

### Expected result

Identical to Path B's `docker compose ps` table, except the images are `ghcr.io/…` rather than
locally built. Verify what you are actually running:

```bash
docker compose -f docker-compose.yml -f docker-compose.images.yml images
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
  ghcr.io/nestormata/project-vault/api:1.2.3
```

Then complete the vault ceremony exactly as in Path B.

### Path C troubleshooting

* `unknown tag !reset` — your Compose is older than v2.24. Upgrade, or build from source (Path B).
* Services still rebuild — the images overlay was omitted, or listed before `docker-compose.yml`.
* `manifest unknown` — that `VAULT_IMAGE_TAG` was never published; check the repository releases.

---

## Path D — Production

Everything below is required for a deployment reachable by anyone other than you on localhost.

### Prerequisites

* A host with Docker Compose v2, and a reverse proxy terminating TLS (Traefik, nginx, Caddy).
* A DNS name for the instance. Deciding it up front matters: it goes into `PUBLIC_WEB_ORIGIN`.
* A password manager or secret store for the values generated below — they cannot be recovered.

### Step 1 — Generate the 12 production secrets

Each must be a distinct, 32+ byte random value. The app rejects placeholder-looking values, the
repo's own dev values, and any duplicate between two of these keys, at startup.

| Variable | Purpose | Generate with |
|----------|---------|---------------|
| `SESSION_SECRET` | Signs human session JWTs | `openssl rand -hex 32` |
| `REFRESH_TOKEN_HMAC_SECRET` | Keys the refresh-token hash | `openssl rand -hex 32` |
| `TOTP_REPLAY_HMAC_SECRET` | Keys the TOTP replay cache (must differ from the refresh secret — equality is rejected) | `openssl rand -hex 32` |
| `MFA_PENDING_SESSION_HMAC_SECRET` | Signs the pending-MFA session between password and TOTP step | `openssl rand -hex 32` |
| `INVITATION_TOKEN_HMAC_SECRET` | Keys team-invitation acceptance tokens | `openssl rand -hex 32` |
| `RECOVERY_TOKEN_HMAC_SECRET` | Keys account-recovery / reactivation tokens | `openssl rand -hex 32` |
| `API_KEY_HMAC_SECRET` | Keys the machine-user API-key hash | `openssl rand -hex 32` |
| `MACHINE_JWT_SECRET` | Signs the machine token-exchange JWT | `openssl rand -hex 32` |
| `STATUS_PAGE_TOKEN_HMAC_SECRET` | Signs public status-page opaque tokens | `openssl rand -hex 32` |
| `ERASURE_EMAIL_HASH_SECRET` | Keys `data_erasure_requests.original_email_hash` | `openssl rand -hex 32` |
| `SSO_STATE_HMAC_SECRET` | Signs the SSO login-state cookie/param | `openssl rand -hex 32` |
| `OPERATIONAL_STATUS_TOKEN_HMAC_SECRET` | Keys the `GET /status` bearer-token hash | `openssl rand -hex 32` |

```bash
cp .env.example .env
for v in SESSION_SECRET REFRESH_TOKEN_HMAC_SECRET TOTP_REPLAY_HMAC_SECRET \
         MFA_PENDING_SESSION_HMAC_SECRET INVITATION_TOKEN_HMAC_SECRET \
         RECOVERY_TOKEN_HMAC_SECRET API_KEY_HMAC_SECRET MACHINE_JWT_SECRET \
         STATUS_PAGE_TOKEN_HMAC_SECRET ERASURE_EMAIL_HASH_SECRET SSO_STATE_HMAC_SECRET \
         OPERATIONAL_STATUS_TOKEN_HMAC_SECRET; do
  sed -i "s|^$v=.*|$v=$(openssl rand -hex 32)|" .env
done

sed -i "s|^VAULT_BOOTSTRAP_TOKEN=.*|VAULT_BOOTSTRAP_TOKEN=$(openssl rand -base64 32)|" .env
```

### Step 2 — Fail fast before deploying

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config >/dev/null && echo OK
```

`docker-compose.prod.yml` turns all 12 keys from `${VAR:-<public dev fallback>}` into
`${VAR:?<message>}`, so this command names every variable still unset and exits non-zero. It must
be the **last** `-f` argument: Compose merges `environment:` key-by-key with the last file
winning, so any other order silently leaves the public dev values in place.

`VAULT_ENVELOPE_KEY_HALF` is deliberately **not** in that hard-required set — it applies only to
envelope-mode vaults, and Compose cannot express "required only if the vault was initialized in
envelope mode" (the KMS type is database state, not an env var). If you use envelope mode, set it
(`openssl rand -hex 16`, 32 hex chars) and confirm at startup: the API logs
`[vault] WARN: vault is sealed (envelope mode) but VAULT_ENVELOPE_KEY_HALF is not configured —
unseal will fail until set`, and unseal fails with `VAULT_ENVELOPE_KEY_HALF is not configured`.

### Step 3 — Public origin and reverse proxy

The stack has no TLS of its own. Terminate TLS at your proxy and forward to the `web` service
(and, if you expose it, `api`).

| Variable | Set to |
|----------|--------|
| `PUBLIC_WEB_ORIGIN` | The exact `scheme://host[:port]` browsers use, e.g. `https://vault.example.com`. Compose feeds it to the api's `CORS_ALLOWED_ORIGINS`, the web service's `ORIGIN` (adapter-node's CSRF same-origin check) and `WEB_BASE_URL` |
| `WEB_BASE_URL` | Only if invitation/recovery email links must use a different host from `PUBLIC_WEB_ORIGIN`; otherwise leave it empty and it follows |
| `COOKIE_SECURE` | `true` (the default under `NODE_ENV=production`, which Compose always sets). Only set `false` if you are deliberately serving plain HTTP on a LAN address — a `Secure` cookie is dropped there, and nobody can log in |
| `TRUST_PROXY` | `true` when a proxy is in front of the API |
| `TRUST_PROXY_HOPS` | The number of proxies, so rate limiting and audit logging record the real client IP instead of the proxy's |

Without `PUBLIC_WEB_ORIGIN` the stack advertises `http://localhost:${WEB_HOST_PORT}` — logins fail
with CORS errors, form actions return 403, and invitation links point at localhost.

### Step 4 — Key material and database passwords

* **Key material lives in the `vault_keys` volume.** `docker-compose.prod.yml` replaces the
  repo's `./dev-secrets` bind mount with the empty named volume `vault_keys`, mounted read-only at
  `/run/secrets` (`VAULT_KEY_DIR`). Populate it before first unseal — see
  [docs/runbook.md](runbook.md) § First-time deployment. Back it up: losing it with an
  envelope/file-mode vault means losing the data.
* **Change both database role passwords**, not just one:

  ```sql
  ALTER ROLE vault_app   PASSWORD '<secure-random>';
  ALTER ROLE vault_admin PASSWORD '<different-secure-random>';
  ```

  Then set `VAULT_ADMIN_PASSWORD` in `.env` (Compose builds the api service's
  `ADMIN_DATABASE_URL` from it) and update `DATABASE_URL` / `ADMIN_DATABASE_URL` for any host-run
  tooling. `VAULT_ADMIN_PASSWORD` is a Compose-only variable — it is not part of the API schema,
  so no CI check will remind you.
* Rotate `POSTGRES_PASSWORD` too if the `db` service is reachable beyond the Compose network.

### Step 5 — Start

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
# or, with prebuilt images:
docker compose -f docker-compose.yml -f docker-compose.images.yml -f docker-compose.prod.yml up -d
# NFS-backed backups (requires BACKUP_NFS_PATH):
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.nfs.yml up -d
```

`make docker-prod` is the two-file form of the first command.

### Expected result

`docker compose ps` matches Path B. `/ready` reports `uninitialized` until the vault ceremony is
done with `VAULT_BOOTSTRAP_TOKEN` supplied as the `X-Vault-Bootstrap-Token` header (the web UI's
init form asks for it). `VAULT_ALLOW_REMOTE_INIT` must stay `false`.

### Production hardening (before non-dev deploy)

1. Change **both** `vault_app` and `vault_admin` passwords (Step 4).
2. Set distinct 32+ byte values for all 12 secrets (Step 1). Never reuse a value across two of
   them; never keep `docker-compose.yml`'s public dev fallbacks.
3. Set `VAULT_BOOTSTRAP_TOKEN`; never set `VAULT_ALLOW_REMOTE_INIT=true`.
4. Pass `docker-compose.prod.yml` **last** (Step 2) — Postgres is then not exposed on a public
   interface and every secret is hard-required.
5. Set `PUBLIC_WEB_ORIGIN`, `TRUST_PROXY`/`TRUST_PROXY_HOPS`, and terminate TLS (Step 3).
6. **Upgrading an already-deployed instance?** This validation only makes a *missing* secret loud
   on the *next* restart — it does nothing to rotate a secret your instance may already be running
   on. If any of the 12 was ever left unset before this upgrade (i.e. your deployment was silently
   running on the public `docker-compose.yml` dev value), generate a fresh value for **every one
   of the 12** and set them explicitly before restarting. Pulling a new image or compose file does
   not rotate an already-compromised secret, and every session/token signed with the old value
   should be treated as forgeable until rotated.
7. Full operational procedures — backups, restore, upgrades, incident response:
   [docs/runbook.md](runbook.md).

---

## Email

Docker Compose ships [Mailpit](https://mailpit.axllent.org/) as a local SMTP sink so invitation,
recovery and notification mail is visible without a real provider.

```bash
docker compose up -d mailpit
set -a; source <(grep -E '^MAILPIT_UI_HOST_PORT=' .env); set +a
open "http://localhost:${MAILPIT_UI_HOST_PORT:-8025}"   # inbox UI
```

* The API container reaches it at `SMTP_HOST=mailpit`, `SMTP_PORT=1025` (the Compose defaults).
* A **host-run** API (Path A) must use `SMTP_HOST=127.0.0.1` and
  `SMTP_PORT=${MAILPIT_SMTP_HOST_PORT}` (default 1025) instead.
* For production, replace `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`
  with your provider's values — set them together; a partial transport config is rejected.

---

## Readiness states (`GET /ready`)

| `reason` | Meaning | Action |
|----------|---------|--------|
| *(200 `ready`)* | DB up, vault unsealed | Register / login |
| `db` | Postgres unreachable | Docker: `docker compose ps db`. Host-run: check `DATABASE_URL` and that its port matches `DB_HOST_PORT` |
| `uninitialized` | Vault never initialized on this volume | Web UI, or `POST /api/v1/vault/init` |
| `sealed` | Vault locked (e.g. after a restart) | Web UI, or `POST /api/v1/vault/unseal` |

---

## Troubleshooting

### `FATAL: ADMIN_DATABASE_URL is required`

The API's Zod schema rejected startup. `ADMIN_DATABASE_URL` is mandatory and nothing loads `.env`
for a host-run API — export it in the same shell as `DATABASE_URL` (Path A steps). It must name
`vault_admin`, never `postgres`, and never the same role as `DATABASE_URL`.

### `password authentication failed for user "vault_admin"`

Migration 0071 creates `vault_admin` without a usable password; something has to provision it.
Run `make bootstrap` (which now does it), or bring up the Compose service, or do it by hand:

```bash
docker compose up -d admin-provision
# or
docker compose exec -T db psql -U postgres -d project_vault \
  -c "ALTER ROLE vault_admin PASSWORD 'password'"
```

The same cause makes a bare `make test` fail after a hand-migrated database.

### `BOOTSTRAP_FORBIDDEN` (403) on vault init

`VAULT_BOOTSTRAP_TOKEN` is unset in the API's environment and `VAULT_ALLOW_REMOTE_INIT` is not
`true`, so **every** `POST /api/v1/vault/init` is refused — the web UI cannot bypass it. Set a
32+ character token in `.env` (Compose interpolates it into the api service) and send it as
`X-Vault-Bootstrap-Token`, or, for local dev only, set `VAULT_ALLOW_REMOTE_INIT=true`.

### `SESSION_SECRET required in production` (or any of the other 11)

You are running with `docker-compose.prod.yml` layered on, which hard-requires all 12 secrets.
Generate them (Path D Step 1) and re-run `docker compose … config` to confirm. If you are *not*
using the prod overlay and still see `X is required in production`, you have set one of these vars
to an **empty string** in `.env` — an empty value overrides Compose's dev fallback with nothing.
Remove the line rather than leaving it blank.

### `ECONNREFUSED` when reaching the database, API, or web port

If the address you tried was one of the shared defaults, your checkout is almost certainly on
remapped ports. Re-read them and rebuild the URL:

```bash
grep -E '^(DB|API|WEB)_HOST_PORT=' .env
```

To keep the classic numbers, use `DOCKER_PORTS_KEEP_DEFAULTS=1` (see
[Ports and URLs](#ports-and-urls-read-this-before-copying-any-command)).

### Browser console shows `Not allowed by CORS` on login/register

The origin the browser is using does not match what the API allows. Under Compose the allowlist is
`PUBLIC_WEB_ORIGIN`, falling back to `http://localhost:${WEB_HOST_PORT}`. If you reach the app on
any other host — a LAN IP, a domain, a proxy — set `PUBLIC_WEB_ORIGIN` to exactly that origin and
recreate the stack.

### `pnpm turbo dev` cannot init the vault

Export `VAULT_BOOTSTRAP_TOKEN` / `VAULT_ALLOW_REMOTE_INIT` in the **same shell** before starting
Turbo, and restart it after changing them (see the passthrough table in Path A).

### Migrations fail / `vault_app` does not exist

Run migrations as the **superuser**, not `vault_app`:

```bash
make db-migrate
# or
DATABASE_URL="postgresql://postgres:password@localhost:${DB_HOST_PORT}/project_vault" pnpm db:migrate
```

### `check-rls` or tests pass but production RLS is broken

You are connected as `postgres`. Re-export `DATABASE_URL` with `vault_app` and re-run.

### First `docker compose up` is slow

The API image is a multi-stage build compiling the native `argon2` addon; the `migrate` service
builds the `db-builder` stage of that same Dockerfile, so it is one build, not two. Subsequent
starts reuse cached layers.

### API boots but registration / `/me` queries return 500

Compare applied migrations against the checkout:

```bash
docker compose exec db psql -U postgres -d project_vault \
  -c 'select count(*) from drizzle.__drizzle_migrations;'
ls packages/db/src/migrations/*.sql | wc -l
```

A mismatch means the `db_data` volume holds schema state from a different migration history (e.g.
reused from an older worktree or branch). `make docker-down-v` then `make docker-up` wipes and
re-migrates cleanly — this destroys the local dev data in that volume.

---

## Related docs

- [Configuration reference](configuration.md) — every environment variable
- [Development guide](development.md) — quality gates, compose overlays, E2E
- [Published container images](container-images.md)
- [Operational runbook](runbook.md)
- [README](../README.md)
