# Operator Quickstart — Zero to Eval-Ready

Single path for self-hosted evaluators and developers. For the full variable reference see [`.env.example`](../.env.example). For day-to-day dev commands see the [README](../README.md).

**Automated bootstrap:** `make bootstrap` (or `scripts/operator-bootstrap.sh`) runs database setup and optional vault init/unseal when the API is reachable.

---

## Two database roles (read this first)

| Role | Connection string (local default) | Use for |
|------|-----------------------------------|---------|
| **`postgres`** (superuser) | `postgresql://postgres:password@localhost:5432/project_vault` | **Migrations only** — creates `vault_app`, RLS policies, triggers |
| **`vault_app`** (app role) | `postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault` | **Everything else** — API, tests, `check-rls`, `pnpm turbo dev` |

Using `postgres` for the app or tests **bypasses Row-Level Security** and produces false-green isolation results.

Inside Docker Compose, the API uses hostname `db` instead of `localhost`:

```text
postgresql://vault_app:dev-only-change-in-prod@db:5432/project_vault
```

---

## Path A — Local dev (fastest for UI work)

Best when you want hot reload (`pnpm turbo dev`) and the Story 2.x web shell.

### 1. Prerequisites

- Node.js 24 LTS, pnpm 9+, Docker 24+
- macOS or Linux (Windows: WSL2)

### 2. One-shot bootstrap

```bash
cp .env.example .env    # optional; defaults work for local eval
make bootstrap          # starts Postgres, runs migrations, prints next steps
```

Or with vault auto-init when the API is already running:

```bash
export VAULT_BOOTSTRAP_TOKEN="$(openssl rand -base64 32)"
export VAULT_DEV_PASSPHRASE='your-local-vault-passphrase-min-12'
make bootstrap -- --init-vault
```

### 3. Start API + web

```bash
export DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault
export VAULT_BOOTSTRAP_TOKEN="${VAULT_BOOTSTRAP_TOKEN:-$(openssl rand -base64 32)}"
export VAULT_ALLOW_REMOTE_INIT=true   # local dev only — never in production
pnpm turbo dev
```

**Turbo env passthrough:** Vault operator variables are **not** in `turbo.json` `globalEnv` (they are secrets). They are listed in `globalPassThroughEnv` so a parent shell export reaches the API dev task:

| Variable | Purpose |
|----------|---------|
| `VAULT_BOOTSTRAP_TOKEN` | Required for `POST /api/v1/vault/init` when `VAULT_ALLOW_REMOTE_INIT` is not `true` |
| `VAULT_ENVELOPE_KEY_HALF` | Envelope KMS mode (production-style split key) |
| `VAULT_ALLOW_REMOTE_INIT` | `true` only on local dev — skips bootstrap token on init |

If you change these exports, **restart** `pnpm turbo dev` (Turbo reads env at task start).

### 4. Vault ceremony (web UI)

Open http://localhost:5173

1. **Uninitialized** → **Initialize vault** → Passphrase mode → paste `VAULT_BOOTSTRAP_TOKEN` → choose a passphrase (reuse for unseal).
2. **Sealed** → **Unseal vault** → same passphrase.
3. **Ready** → **Register** first user → **Sign in** (registration does not auto-login).

### 5. Verify

```bash
curl -sf http://localhost:3000/health
curl -sf http://localhost:3000/ready    # expect {"status":"ready"}
```

---

## Path B — Full Docker stack

Best when validating production-like images without local Node.

```bash
cp .env.example .env
export VAULT_BOOTSTRAP_TOKEN="$(openssl rand -base64 32)"
export VAULT_DEV_PASSPHRASE='your-local-vault-passphrase-min-12'
make bootstrap-docker    # compose up + migrate + optional vault init/unseal
```

Services:

| Service | URL |
|---------|-----|
| Web | http://localhost:5173 |
| API | http://localhost:3000 |
| Health | http://localhost:3000/health |
| Readiness | http://localhost:3000/ready |

Then complete vault init/unseal in the web UI if the script reports `uninitialized` or `sealed`, or re-run bootstrap with `--init-vault` after the API is healthy.

---

## Readiness states (`GET /ready`)

| `reason` | Meaning | Action |
|----------|---------|--------|
| *(200 `ready`)* | DB up, vault unsealed | Register / login |
| `db` | Postgres unreachable | `make db-up` or check `DATABASE_URL` |
| `uninitialized` | Vault never initialized | Web UI or `POST /api/v1/vault/init` |
| `sealed` | Vault locked | Web UI or `POST /api/v1/vault/unseal` |

---

## Common failures

### `FATAL: missing required environment variables`

The API Zod schema failed at startup. Run `pnpm tsx scripts/check-env-example.ts` and align `.env` with `.env.example`.

### Migrations fail / `vault_app` does not exist

Run migrations as **superuser**, not `vault_app`:

```bash
make db-migrate
# or
DATABASE_URL=postgresql://postgres:password@localhost:5432/project_vault pnpm db:migrate
```

### `check-rls` or tests pass but production RLS is broken

You are connected as `postgres`. Re-export `DATABASE_URL` with `vault_app` and re-run.

### `403` on vault init

Set `VAULT_BOOTSTRAP_TOKEN` in the API environment and pass header `X-Vault-Bootstrap-Token: <same value>`, or set `VAULT_ALLOW_REMOTE_INIT=true` for local dev only.

### `pnpm turbo dev` cannot init vault

Export `VAULT_BOOTSTRAP_TOKEN` / `VAULT_ALLOW_REMOTE_INIT` in the **same shell** before starting Turbo (see passthrough table above).

### First `docker compose up` is slow

The `migrate` service rebuilds the API builder image to run `pnpm db:migrate` (known tradeoff — see `deferred-work.md` D4). Subsequent starts are faster if images are cached.

---

## Production hardening (before non-dev deploy)

1. Change `vault_app` password: `ALTER ROLE vault_app PASSWORD '…'` after migrate.
2. Set distinct 32+ byte secrets for `SESSION_SECRET`, `REFRESH_TOKEN_HMAC_SECRET`, `MFA_PENDING_SESSION_HMAC_SECRET`, `TOTP_REPLAY_HMAC_SECRET`.
3. Set `VAULT_BOOTSTRAP_TOKEN`; never set `VAULT_ALLOW_REMOTE_INIT=true`.
4. Use `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` (Postgres not exposed on public interface).
5. Full runbook: Epic 9 Story 9.5 (planned).

---

## Related docs

- [MFA Policy Matrix](../_bmad-output/planning-artifacts/mfa-policy-matrix.md) — when MFA applies (login vs privileged routes vs invites)
- [README — Getting Started](../README.md)
- [Epic 1 retrospective](../_bmad-output/implementation-artifacts/epic-1-retro-2026-06-30.md)
