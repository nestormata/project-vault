# Vault Initialization & Master Key Management — Project Vault

**Version:** 1.1  
**Date:** 2026-06-24  
**Status:** Story 1.5 ready-for-dev (includes Red Team hardening AC-23–25)  
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

### Error format (canonical)

JSON `error` field: **lowercase snake_case**. Internal `AppError.code`: SCREAMING_SNAKE.

Examples: `unseal_failed`, `already_initialized`, `invalid_passphrase`, `envelope_env_half_missing`

---

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | Must use `vault_app` (not `postgres` superuser) |
| `VAULT_KEY_DIR` | No | `/run/secrets` | Allowed directory for envelope/file key halves |
| `VAULT_ENVELOPE_KEY_HALF` | Envelope mode | — | 32 lowercase hex chars (16-byte env half) |

`.env.example` snippet:

```bash
DATABASE_URL=postgresql://vault_app:change-me@localhost:5432/project_vault
VAULT_KEY_DIR=/run/secrets
# VAULT_ENVELOPE_KEY_HALF=$(openssl rand -hex 16)  # envelope mode only
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
| `apps/api/src/plugins/vault-guard.ts` | Sealed middleware |
| `apps/api/src/routes/health.ts` | `/ready` vault awareness |
| `packages/db/src/schema/vault-state.ts` | Drizzle schema |

---

## Security Controls

| Control | Implementation |
|---|---|
| Path confinement | `readKeyFile()` rejects paths outside `VAULT_KEY_DIR` |
| File size limit | `statSync` before read; max 4096 bytes |
| Memory zeroing | `keyMaterial.fill(0)`, `withSecret()` zeros plaintext in `finally` |
| Shutdown | `zeroKeys()` before `fastify.close()` on SIGTERM/SIGINT |
| No secrets in logs | Never log passphrase, key paths, or key bytes |
| Bare decrypt ban | ESLint `no-bare-decrypt`; exception: `bootstrapDecrypt` in `key-service.ts` only |
| Network exposure | Init/unseal reachable only on trusted network (v1) |
| Rate limiting | Reverse proxy on `/api/v1/vault/unseal` (recommended ≤5 req/min/IP) |

**Sentinel is not secret** — GCM auth tag prevents key guessing. **DB write access to `vault_state`** is equivalent to vault compromise if an attacker can replace the sentinel.

---

## Testing

### Integration tests (`apps/api/src/__tests__/vault-lifecycle.test.ts`)

**Recommended isolation strategy:**

1. `describe.sequential` — tests depend on init order (409 after first init).
2. `beforeEach(resetVaultForTest())` — `zeroKeys()` + `DELETE FROM vault_state`.
3. Primary fixture: **passphrase mode** (`"test-passphrase-12chars"`) — no filesystem setup.
4. CI: ephemeral Postgres per job (`.github/workflows/ci.yml`) — safe to truncate `vault_state`.

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

# 5. Initialize (pick one custody model — see API section above)

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
| Init/unseal auth | Firewall/network restriction sufficient for v1 |
| Trailing slash | `/health/` allowed — normalized before allowlist check |
| Test DB reset | `describe.sequential` + `beforeEach(resetVaultForTest())` |
| API error codes | Lowercase snake_case in JSON |

---

## Gotchas

1. **Migration order:** `0002_vault_state.sql` is manual SQL like `0001_rls_and_triggers.sql` — do not append to `0000_initial_schema.sql` or `drizzle-kit generate` will drift.
2. **`postgres` superuser bypasses RLS** — API `DATABASE_URL` guard rejects `username=postgres` at startup.
3. **Passphrase salt is in DB** — only the passphrase itself is secret; wrong passphrase fails at GCM tag check.
4. **Envelope requires both halves at every unseal** — losing either half is unrecoverable.
5. **File mode newline trap** — `readFileSync` includes trailing newline if present; use binary writes (`openssl rand -out ...`).
6. **RS256 JWT at init** — Story 1.6 uses HMAC-SHA256 via `@fastify/jwt`; no JWT keys generated at vault init.
7. **`generate-spec.ts`** — currently stub; vault routes still register Zod schemas for future OpenAPI dump.

---

## Deferred (post-v1)

- Shamir's Secret Sharing unseal ceremony
- Cloud KMS auto-unseal (AWS/GCP/Azure)
- Application-layer init token (`VAULT_INIT_TOKEN`)
- Dedicated management port for vault routes
- Key history table for rotation (Story 9.x)
- `kms_type: 'kms'` implementation

---

## Changelog

| Date | Change |
|---|---|
| 2026-06-24 | Initial operational spec from Story 1.5 product decisions and architecture alignment |
