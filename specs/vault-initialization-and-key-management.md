# Vault Initialization & Master Key Management — Project Vault

**Version:** 1.2  
**Date:** 2026-06-24  
**Status:** Story 1.5 ready-for-dev (includes Red Team AC-23–25 + FMEA AC-26–30)  
**Story:** `_bmad-output/implementation-artifacts/1-5-vault-initialization-and-master-key-management.md`  
**FR:** FR60  
**Related:** `specs/cryptographic-architecture.md` (research baseline), `specs/multi-tenancy-data-model.md` (`vault_app` role)

---

## Overview

Project Vault seals on startup and after process termination. While sealed, only health, readiness, and vault management endpoints respond. All secret operations require an **unsealed** vault with derived encryption keys loaded in memory.

v1 implements three **custody models** for deriving the master IKM (Input Key Material) before HKDF splits it into primary and audit keys:

| `kms_type` | Use case | v1 recommendation |
|---|---|---|
| `passphrase` | Dev / small teams | Primary for local development |
| `envelope` | Production self-host | **Recommended for production** — split storage |
| `file` | Legacy / migration | Downgraded — requires explicit operator acknowledgment |

**Stack:** Node.js 24, `packages/crypto` (`node:crypto` + `argon2`), PostgreSQL 16, Fastify API (`apps/api`).

**Out of v1 scope:** Shamir SSS, cloud KMS auto-unseal.

**v1 init auth:** Bootstrap token (`VAULT_BOOTSTRAP_TOKEN`) + network/firewall restriction — not open init on first deploy.

---

## Vault State Machine

```
API start (no vault_state row)
       │
  ┌────▼──────────┐
  │ uninitialized │  GET /health → 200   GET /ready → 503
  └────┬──────────┘  all other routes → 503
       │ POST /api/v1/vault/init
  ┌────▼──────────┐
  │   unsealed    │  GET /health → 200   GET /ready → 200 (if DB up)
  └────┬──────────┘  all routes available
       │ SIGTERM / SIGINT / crash / SIGKILL
  ┌────▼──────────┐
  │    sealed     │  GET /health → 200   GET /ready → 503
  └────┬──────────┘  all other routes → 503
       │ POST /api/v1/vault/unseal (credentials match stored kms_type)
       └──────────► unsealed
```

**Invariants:**
- Auto-unseal on restart is **not** implemented in v1.
- In-memory keys are zeroed on SIGTERM/SIGINT before `fastify.close()`.
- `GET /health` and `GET /health/` (trailing slash normalized) always return 200 — liveness probes work while sealed.
- `GET /ready` reflects vault + DB state — use for readiness probes.
- If PostgreSQL is unreachable at startup, the API **exits before listening** — no HTTP with unknown vault state (AC-27).
- `pg-boss` starts only after vault is unsealed via `setOnVaultUnsealed()` callback (AC-29).

---

## Cryptographic Pipeline

```
Custody input (passphrase | envelope halves | file bytes)
       │
       ▼
  32-byte IKM
       │
       ├── HKDF-SHA256(info: "project-vault-v1")           → primary encryption key
       └── HKDF-SHA256(info: "project-vault-audit-log-v1")  → audit log encryption key
       │
       ▼
  AES-256-GCM encrypt sentinel "project-vault-sentinel-v1"
       │
       ▼
  Stored in vault_state.encrypted_sentinel (JSON EncryptedValue)
```

### Ciphertext format (`EncryptedValue`)

```typescript
{ version: 1, iv: string, ciphertext: string, tag: string }  // iv/tag/ciphertext as hex
```

- IV: 12 bytes random per encryption (never reuse with same key).
- Tag: 16 bytes (GCM default).
- Plaintext access outside `packages/crypto` **only** via `withSecret()` — bare `decrypt()` forbidden (`no-bare-decrypt` ESLint rule).

### Passphrase mode — Argon2id

| Parameter | Value |
|---|---|
| Algorithm | Argon2id (`argon2` npm package) |
| memoryCost | 65536 (64 MiB) |
| timeCost | 3 |
| parallelism | 4 |
| hashLength | 32 bytes (used as IKM) |
| Salt | 16 bytes random, stored in `vault_state.key_derivation_params` |

Module: `packages/crypto/src/passwords.ts` — shared with Story 1.6 user password hashing.

### Envelope mode — split key

| Half | Source | Size | Stored in DB? |
|---|---|---|---|
| Env half | `VAULT_ENVELOPE_KEY_HALF` env var **or** file at `/run/secrets/envelope-env-half` | 16 bytes (32 hex chars) | No |
| File half | `envelopeKeyPath` under `VAULT_KEY_DIR` | 16 bytes | No |

Combination: `Buffer.concat([envHalf, fileHalf])` → 32-byte IKM.

Generate:

```bash
openssl rand -hex 16                              # → VAULT_ENVELOPE_KEY_HALF
openssl rand -out dev-secrets/envelope-half.bin 16
```

### File mode (downgraded)

- Raw binary file ≥ 32 bytes at `masterKeyPath` within `VAULT_KEY_DIR`.
- Init requires `"acknowledgeCoLocationRisk": true`.
- Full host compromise exposes key + data — document in operator runbook.

---

## Database: `vault_state`

Platform-level single-row table (no `org_id`, no RLS). Migration: `packages/db/src/migrations/0002_vault_state.sql`.

| Column | Type | Notes |
|---|---|---|
| `id` | SMALLINT PK | Always `1`; CHECK enforces single row |
| `key_version` | INTEGER | Primary key lifecycle; starts at 1 |
| `audit_key_version` | INTEGER | Independent audit key lifecycle |
| `encrypted_sentinel` | TEXT | JSON `EncryptedValue` |
| `kms_type` | TEXT | `passphrase` \| `envelope` \| `file` \| `kms` (kms reserved) |
| `key_derivation_params` | TEXT | JSON Argon2 params + salt; **passphrase mode only** |
| `initialized_at` | TIMESTAMPTZ | |

Exempt from RLS coverage check: add `vault_state` to `EXCLUDED_TABLES` in `packages/db/src/check-rls-coverage.ts`.

**Append-only:** Migration includes triggers blocking UPDATE/DELETE on `vault_state` — prevents sentinel tampering via DB write access.

Queries use `getDb()` from `@project-vault/db` — not the postgres superuser. API connects as `vault_app`.

---

## API Endpoints

Base URL: `http://localhost:3000` (dev).

### Bootstrap protection (first init only)

Prevents **init squatting** — an attacker initializing before the operator on a fresh deploy.

| Control | Detail |
|---|---|
| Production | Set `VAULT_BOOTSTRAP_TOKEN` (≥32 chars). Pass header `X-Vault-Bootstrap-Token` on `POST /api/v1/vault/init` |
| Dev | Set `VAULT_ALLOW_REMOTE_INIT=true` (never in production) |
| Failure | `403 {"error":"bootstrap_forbidden",...}` — same message for missing/wrong token |

Generate token: `openssl rand -base64 32`

```bash
curl -s -X POST http://localhost:3000/api/v1/vault/init \
  -H 'Content-Type: application/json' \
  -H "X-Vault-Bootstrap-Token: $VAULT_BOOTSTRAP_TOKEN" \
  -d '{"kmsType":"passphrase","passphrase":"correct-horse-battery-staple"}'
```

Unseal does **not** require bootstrap token — only first init while `vault_state` is empty.

### Allowlisted while sealed

```
GET  /health
GET  /ready
POST /api/v1/vault/init
POST /api/v1/vault/unseal
```

Vault guard normalizes paths: strips query string, removes trailing slash (`/health/` → `/health`).

### POST `/api/v1/vault/init`

**Passphrase (dev):**

```bash
curl -s -X POST http://localhost:3000/api/v1/vault/init \
  -H 'Content-Type: application/json' \
  -d '{"kmsType":"passphrase","passphrase":"correct-horse-battery-staple"}'
# → {"initialized":true,"keyVersion":1,"kmsType":"passphrase"}
```

**Envelope (production):**

```bash
curl -s -X POST http://localhost:3000/api/v1/vault/init \
  -H 'Content-Type: application/json' \
  -d '{"kmsType":"envelope","envelopeKeyPath":"/run/secrets/envelope-half.bin","acknowledgeSplitKeyModel":true}'
```

**File (downgraded):**

```bash
curl -s -X POST http://localhost:3000/api/v1/vault/init \
  -H 'Content-Type: application/json' \
  -d '{"kmsType":"file","masterKeyPath":"/run/secrets/vault-key.bin","acknowledgeCoLocationRisk":true}'
```

Second init → `409 {"error":"already_initialized",...}`

### POST `/api/v1/vault/unseal`

Server reads stored `kms_type`; client sends **one** credential field:

| Stored type | Body |
|---|---|
| `passphrase` | `{ "passphrase": "..." }` |
| `envelope` | `{ "envelopeKeyPath": "/run/secrets/envelope-half.bin" }` |
| `file` | `{ "masterKeyPath": "/run/secrets/vault-key.bin" }` |

Wrong credentials → `401 {"error":"unseal_failed",...}` (same message for all modes — no oracle).

Corrupt `encrypted_sentinel` or tampered `key_derivation_params` → `503 {"error":"vault_corrupted",...}` (not 500).

Rate limit: **5 requests/minute/IP** on unseal → `429 {"error":"rate_limited","retryAfter":N}`.

Passphrase mode: always run full Argon2id before returning 401 (no early-exit timing oracle).

### Error format (canonical)

JSON `error` field: **lowercase snake_case**. Internal `AppError.code`: SCREAMING_SNAKE.

Examples: `unseal_failed`, `already_initialized`, `invalid_passphrase`, `bootstrap_forbidden`, `rate_limited`, `vault_corrupted`

---

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | Must use `vault_app` (not `postgres` superuser) |
| `VAULT_KEY_DIR` | No | `/run/secrets` | Allowed directory for envelope/file key halves |
| `VAULT_ENVELOPE_KEY_HALF` | Envelope mode | — | 32 hex chars (16-byte env half); prefer file mount in prod |
| `VAULT_ENVELOPE_KEY_HALF_FILE` | No | `/run/secrets/envelope-env-half` | Fallback file read if env var unset |
| `VAULT_BOOTSTRAP_TOKEN` | Prod init | — | First-init auth; header `X-Vault-Bootstrap-Token` |
| `VAULT_ALLOW_REMOTE_INIT` | No | `false` | Dev-only: skip bootstrap token |

`.env.example` snippet:

```bash
DATABASE_URL=postgresql://vault_app:change-me@localhost:5432/project_vault
VAULT_KEY_DIR=/run/secrets
# VAULT_BOOTSTRAP_TOKEN=$(openssl rand -base64 32)   # required for prod init
# VAULT_ALLOW_REMOTE_INIT=true                        # dev only — NEVER in production
# VAULT_ENVELOPE_KEY_HALF=$(openssl rand -hex 16)     # envelope mode
```

---

## Docker Compose

### Development (`docker-compose.yml`)

```yaml
api:
  volumes:
    - ./dev-secrets:/run/secrets:ro
  environment:
    VAULT_KEY_DIR: /run/secrets
    VAULT_ENVELOPE_KEY_HALF: ${VAULT_ENVELOPE_KEY_HALF:-}
```

Add `dev-secrets/` to `.gitignore`.

### Production (`docker-compose.prod.yml`)

```yaml
api:
  volumes:
    - vault_keys:/run/secrets:ro
  environment:
    VAULT_KEY_DIR: /run/secrets
    VAULT_ENVELOPE_KEY_HALF: ${VAULT_ENVELOPE_KEY_HALF:?required for envelope mode}
```

Volume `vault_keys` was reserved in Story 1.3; Story 1.5 mounts it into the API service.

**Migrate service:** One-shot `migrate` container runs as `postgres` superuser; `api` waits for it, then connects as `vault_app`.

---

## Key Source Files

| Path | Role |
|---|---|
| `packages/crypto/src/aes.ts` | AES-256-GCM encrypt / internal decrypt |
| `packages/crypto/src/kdf.ts` | HKDF-SHA256 + `HKDF_INFO` constants |
| `packages/crypto/src/passwords.ts` | Argon2id IKM from passphrase |
| `packages/crypto/src/envelope.ts` | Split-key combination |
| `packages/crypto/src/secret-value.ts` | `withSecret()`, `setVaultKey()`, buffer zeroing |
| `apps/api/src/modules/vault/key-service.ts` | State machine, init/unseal |
| `apps/api/src/modules/vault/routes.ts` | HTTP handlers |
| `apps/api/src/plugins/redact-secrets.ts` | Log redaction for passphrase/paths |
| `apps/api/src/plugins/vault-guard.ts` | Sealed middleware |
| `apps/api/src/routes/health.ts` | `/ready` vault awareness |
| `packages/db/src/schema/vault-state.ts` | Drizzle schema |

---

## Security Controls

| Control | Implementation |
|---|---|
| Init squatting | `VAULT_BOOTSTRAP_TOKEN` + `X-Vault-Bootstrap-Token` (or dev `VAULT_ALLOW_REMOTE_INIT`) |
| Path confinement | Key files must be under `VAULT_KEY_DIR` |
| Symlink hardening | `lstatSync` (no follow) + `O_NOFOLLOW` open; regular files only |
| File size limit | Max 4096 bytes before read |
| Memory zeroing | `keyMaterial.fill(0)`, `withSecret()` zeros plaintext in `finally` |
| Shutdown | `zeroKeys()` before `fastify.close()` on SIGTERM/SIGINT |
| Log redaction | `redactBodyForLog()` — never log `passphrase`; paths redacted |
| Bare decrypt ban | ESLint `no-bare-decrypt`; exception: `bootstrapDecrypt` in `key-service.ts` only |
| Unseal rate limit | `@fastify/rate-limit`: 5 req/min/IP on unseal route |
| vault_state integrity | PostgreSQL trigger blocks UPDATE/DELETE after insert |
| Corrupt vault_state | `503 vault_corrupted` — parse/validation failure on sentinel or Argon2 params |
| Startup DB failure | Fail-fast exit 1 before HTTP listen — no sealed/unsealed guesswork |
| pg-boss deferral | Job queue starts only after unseal via `setOnVaultUnsealed()` |
| Argon2 native module | Dockerfile builder: `python3`, `make`, `g++`; CI tests passphrase path |
| Argon2 param tampering | `validateKeyDerivationParams()` rejects non-canonical costs on read |
| Network exposure | Firewall/VLAN for init/unseal in production (defense in depth) |

**Sentinel is not secret** — GCM auth tag prevents key guessing. **DB write access to `vault_state`** is equivalent to vault compromise if an attacker can replace the sentinel.

---

## Testing

### Integration tests (`apps/api/src/__tests__/vault-lifecycle.test.ts`)

**Recommended isolation strategy:**

1. `describe.sequential` — tests depend on init order (409 after first init).
2. `beforeEach(resetVaultForTest())` — `zeroKeys()` + `DELETE FROM vault_state` + **`loadInitialVaultState()`** to resync in-memory `_status` (AC-26).
3. Primary fixture: **passphrase mode** — set `VAULT_ALLOW_REMOTE_INIT=true` or pass bootstrap header.
4. CI: ephemeral Postgres per job — safe to truncate `vault_state`.
5. Log redaction test: assert test passphrase never appears in captured pino output.

**Avoid:** global truncate in shared setup (breaks parallel workers); transaction rollback (in-memory vault state cannot roll back with PG).

### Unit tests

- `packages/crypto/src/index.test.ts` — AES round-trip, HKDF determinism, Argon2id, envelope combine, `withSecret()` zeroing.

---

## Operator Runbook (Quick Reference)

```bash
# 1. Migrate DB (includes vault_app role)
pnpm --filter @project-vault/db db:migrate

# 2. Start stack
docker compose up -d

# 3. Check liveness (works while sealed)
curl -s http://localhost:3000/health/

# 4. Check readiness (503 until initialized + unsealed)
curl -s http://localhost:3000/ready | jq .

# 5. Initialize (requires bootstrap token in prod)
export VAULT_BOOTSTRAP_TOKEN=$(openssl rand -base64 32)
curl -s -X POST http://localhost:3000/api/v1/vault/init \
  -H 'Content-Type: application/json' \
  -H "X-Vault-Bootstrap-Token: $VAULT_BOOTSTRAP_TOKEN" \
  -d '{"kmsType":"passphrase","passphrase":"correct-horse-battery-staple"}'

# 6. After restart, unseal with matching credentials
docker compose restart api
curl -s -X POST http://localhost:3000/api/v1/vault/unseal \
  -H 'Content-Type: application/json' \
  -d '{"passphrase":"correct-horse-battery-staple"}'
```

---

## Product Decisions (2026-06-24)

| Decision | Resolution |
|---|---|
| Master key input | Passphrase + Argon2id KDF as primary UX; file mode retained as downgraded |
| Envelope encryption | Minimal envelope mode in v1 (env half + file half) |
| Init/unseal auth | Bootstrap token for first init + firewall/network restriction |
| Trailing slash | `/health/` allowed — normalized before allowlist check |
| Test DB reset | `describe.sequential` + `beforeEach(resetVaultForTest())` |
| API error codes | Lowercase snake_case in JSON |
| Init squatting (Red Team) | Bootstrap token required for first init |
| Unseal brute force | Server-side 5 req/min/IP rate limit |
| Key file symlinks | lstat + O_NOFOLLOW |
| vault_state tampering | Append-only DB trigger |
| Test state desync (FMEA) | `resetVaultForTest()` calls `loadInitialVaultState()` after truncate |
| DB down at startup (FMEA) | Fail-fast exit 1 — no HTTP without known vault state |
| Corrupt vault_state (FMEA) | `503 vault_corrupted` for bad sentinel/params |
| pg-boss while sealed (FMEA) | Defer `boss.start()` until unsealed |
| argon2 native / tampered params (FMEA) | Docker build deps + `validateKeyDerivationParams()` |

---

## Failure Mode Analysis (FMEA Summary)

| Component | Failure | Effect | Mitigation |
|---|---|---|---|
| `loadInitialVaultState` | DB down at startup | Crash loop | AC-27 fail-fast; fix DB before restart |
| `zeroKeys` + test reset | `_status` desync | Wrong `/ready` message | AC-26 reload after truncate |
| `encrypted_sentinel` | Corrupt JSON | 500 → ops confusion | AC-28 `503 vault_corrupted` |
| `key_derivation_params` | Tampered low Argon2 cost | Faster brute-force | AC-30 validate on read |
| `argon2` native module | Missing in Docker | Crash on passphrase op | AC-30 builder deps + CI test |
| Argon2id CPU | Event loop blocked ~1s | Request latency spike | *Accepted v1* — rate limit unseal |
| `pg-boss` | Starts while sealed | Future worker crypto errors | AC-29 defer until unsealed |
| SIGKILL | No `zeroKeys()` | Keys in memory until GC | *Accepted v1* — restart seals vault |
| Envelope env half | Missing after restart | Unseal 503 | AC-29 stderr warning at startup |
| Dual postgres pools | `main.ts` + `getDb()` | Connection pressure | *Accepted v1* — consolidate later |

---

## Gotchas

1. **Migration order:** `0002_vault_state.sql` is manual SQL like `0001_rls_and_triggers.sql` — do not append to `0000_initial_schema.sql` or `drizzle-kit generate` will drift.
2. **`postgres` superuser bypasses RLS** — API `DATABASE_URL` guard rejects `username=postgres` at startup.
3. **Passphrase salt is in DB** — only the passphrase itself is secret; wrong passphrase fails at GCM tag check.
4. **Envelope requires both halves at every unseal** — losing either half is unrecoverable.
5. **File mode newline trap** — `readFileSync` includes trailing newline if present; use binary writes (`openssl rand -out ...`).
6. **RS256 JWT at init** — Story 1.6 uses HMAC-SHA256 via `@fastify/jwt`; no JWT keys generated at vault init.
8. **Init squatting:** Without bootstrap token, anyone on the network can own a fresh vault — always set `VAULT_BOOTSTRAP_TOKEN` in prod.
9. **Envelope env half in process env:** Prefer file mount at `/run/secrets/envelope-env-half` over `VAULT_ENVELOPE_KEY_HALF` — visible via `docker exec` / `/proc/self/environ`.
10. **Test truncate without reload:** Deleting `vault_state` without `loadInitialVaultState()` leaves in-memory `_status` stale — always call reload in `resetVaultForTest()`.
11. **Corrupt sentinel looks like 500:** Operators cannot distinguish infra failure from data corruption — use `vault_corrupted` (503).
12. **argon2 in Alpine/slim images:** Missing `python3`/`g++` causes native module load failure at runtime — add builder deps in Dockerfile.

---

## Deferred (post-v1)

- Shamir's Secret Sharing unseal ceremony
- Cloud KMS auto-unseal (AWS/GCP/Azure)
- Application-layer init token (superseded by `VAULT_BOOTSTRAP_TOKEN` in v1)
- Dedicated management port for vault routes
- Key history table for rotation (Story 9.x)
- `kms_type: 'kms'` implementation

---

## Changelog

| Date | Change |
|---|---|
| 2026-06-24 | FMEA hardening: test state sync, startup fail-fast, vault_corrupted, pg-boss defer, argon2 validation |
| 2026-06-24 | Red Team hardening: bootstrap token, unseal rate limit, O_NOFOLLOW key reads, vault_state immutable trigger, log redaction |
| 2026-06-24 | Initial operational spec from Story 1.5 product decisions |
