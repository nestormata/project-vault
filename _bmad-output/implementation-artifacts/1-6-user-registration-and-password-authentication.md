# Story 1.6: User Registration & Password Authentication

Status: done

<!-- Ultimate context engine analysis completed 2026-06-24 — comprehensive developer guide for registration, login, JWT cookies, refresh rotation, and integration tests. -->
<!-- Security Audit Personas elicitation 2026-06-24 — AC-19–24, rate limits, concurrency, enumeration controls. -->
<!-- Failure Mode Analysis elicitation 2026-06-24 — AC-25–30, race handling, cookie commit order, best-effort audit. -->
<!-- Red Team vs Blue Team elicitation 2026-06-24 — AC-31–36, timing, homographs, POST-only, trustProxy. -->

## Story

As a new user,
I want to create an account with my email and password and log in to the vault,
so that I can access my organization's secrets securely.

*Covers: FR53* [Source: _bmad-output/planning-artifacts/prd.md#FR53]

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 1.4 complete — core schema + RLS | `users`, `organizations`, `org_memberships`, `user_identity_tokens`, `sessions`, `audit_log_entries` exist |
| Story 1.5 complete — vault init + unseal | Auth endpoints are blocked (`503`) while vault is sealed; Argon2id helpers live in `packages/crypto/src/passwords.ts` |
| Real PostgreSQL in integration tests | Architecture forbids DB mocks for auth flows |
| Vault unsealed in test fixture | `POST /api/v1/auth/register` and `/login` require `vaultGuard` to pass |

### Security Audit Summary (2026-06-24 Elicitation)

Three-persona review (attacker, defender, auditor) identified gaps in refresh concurrency, session fixation, register DoS, and enumeration. **AC-19 through AC-24** close critical and high findings. Residual v1 risks are documented under [Accepted Security Risks (v1)](#accepted-security-risks-v1).

### Failure Mode Analysis Summary (2026-06-24 Elicitation)

Component-level FMEA identified orphan cookie state, register unique-constraint races, deactivated-user login gaps, and best-effort vs mandatory audit boundaries. **AC-25 through AC-30** address high/medium failure modes. Ops notes (secret rotation, `trustProxy`) are in Dev Notes.

### Red Team vs Blue Team Summary (2026-06-24 Elicitation)

Adversarial review after AC-25–30 found residual gaps: register timing oracle on `409`, homograph emails, JWT alg tests, GET on auth routes, and permissive `trustProxy`. **AC-31 through AC-36** close or document these. Distributed credential stuffing remains deferred to Story 1.9.

---

## Acceptance Criteria

### AC-1: Auth Module Structure & Route Registration

**Given** the API app boots with vault unsealed,
**When** Story 1.6 is complete,
**Then** the following module exists and is registered from `apps/api/src/app.ts`:

```
apps/api/src/modules/auth/
├── routes.ts      # POST /register, /login, /refresh, /logout (logout optional stub)
├── service.ts     # registerUser(), loginUser(), refreshSession()
├── tokens.ts      # JWT sign/verify, refresh token generate/hash, cookie helpers
├── schema.ts      # Zod request/response schemas (re-export shared contracts)
└── password.ts    # Thin wrapper over @project-vault/crypto password helpers
```

**And** routes are mounted at prefix `/api/v1/auth` via `fastify.register(authRoutes, { prefix: '/api/v1/auth' })`.

**And** auth routes are added to the vault guard allowlist (unsealed vault required, but routes reachable when unsealed):

```typescript
// apps/api/src/plugins/vault-guard.ts — extend allowlist
const VAULT_GUARD_ALLOWLIST = new Set([
  '/health',
  '/ready',
  '/api/v1/vault/init',
  '/api/v1/vault/unseal',
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
])
```

**And** auth routes are added to `route-audit.test.ts` exempt paths (public — no JWT required):

```typescript
const EXEMPT_PATHS = new Set([
  '/health',
  '/ready',
  '/metrics',
  '/api/v1/vault/init',
  '/api/v1/vault/unseal',
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
])
```

#### AC-1b: Auth routes — POST-only (AC-34)

**Given** `/api/v1/auth/register`, `/login`, `/refresh`,
**When** called with `GET`, `HEAD`, `PUT`, `PATCH`, or `DELETE`,
**Then** return **`405 Method Not Allowed`** with `Allow: POST` response header.

**Rationale:** Prevents refresh cookie leakage via GET URLs, referrer headers, link prefetch, or crawler probes.

**Implementation:** Register each route with `method: 'POST'` only — no catch-all handler on auth prefix.

**Integration test:** `GET /api/v1/auth/login` → 405; `GET /api/v1/auth/refresh` → 405.

---

### AC-2: Environment Variables & Startup Validation

**Given** the API starts,
**When** required auth env vars are missing or invalid,
**Then** the process exits with code 1 and a human-readable Zod error (same pattern as Story 1.3 `env.ts`).

**Add to `apps/api/src/config/env.ts`:**

| Variable | Type | Default (dev/test) | Production rule |
|---|---|---|---|
| `SESSION_SECRET` | string | dev-only 64-char hex in `.env.example` | **Required**; min 32 bytes entropy; reject known placeholders |
| `REFRESH_TOKEN_HMAC_SECRET` | string | dev-only 64-char hex | **Required** in production; min 32 bytes; separate from `SESSION_SECRET` |
| `JWT_ACCESS_TTL_SECONDS` | number | `300` (5 min) | Must be ≤ 600 |
| `REFRESH_TOKEN_TTL_DAYS` | number | `7` | Must be 1–30 |
| `REFRESH_GRACE_WINDOW_SECONDS` | number | `30` | Architecture grace window for idempotent refresh |
| `ARGON2_MEMORY_COST` | number | `65536` | KiB; must be ≥ 19456 |
| `ARGON2_TIME_COST` | number | `3` | Must be ≥ 2 |
| `ARGON2_PARALLELISM` | number | `4` | Must be ≥ 1 |
| `AUTH_DUMMY_PASSWORD_HASH` | string | precomputed Argon2id PHC string | Used for timing-safe login on unknown emails; never a real user password |
| `AUTH_REGISTRATION_ENABLED` | boolean | `true` | When `false`, `POST /register` returns `403 registration_disabled` (invite-only prod) |
| `COOKIE_SECURE` | boolean | `false` in dev; `true` when `NODE_ENV=production` | Force `Secure` flag on auth cookies (required on HTTPS staging) |
| `TRUST_PROXY` | boolean | `false` | Set `true` only when API is behind Traefik/nginx (AC-35) |
| `TRUST_PROXY_HOPS` | number | `1` | Number of trusted proxy hops when `TRUST_PROXY=true` |

**Production guard example:**

```typescript
if (env.NODE_ENV === 'production') {
  for (const [name, value] of [
    ['SESSION_SECRET', env.SESSION_SECRET],
    ['REFRESH_TOKEN_HMAC_SECRET', env.REFRESH_TOKEN_HMAC_SECRET],
  ]) {
    if (value.includes('change-me') || value.length < 32) {
      throw new Error(`FATAL: ${name} must be a strong secret in production`)
    }
  }
}
```

**And** `.env.example` and `scripts/check-env-example.ts` CI gate are updated for every new variable.

#### AC-2b: Startup validation extensions (AC-28)

**At startup**, `env.ts` must additionally:

1. **Validate `AUTH_DUMMY_PASSWORD_HASH`:** Must be a valid Argon2 PHC string (prefix `$argon2id$` + parseable structure). Optionally boot-check with `argon2.verify(hash, knownDummyPassword)`. Invalid → exit 1 with clear message.

2. **Reject identical secrets:** If `SESSION_SECRET === REFRESH_TOKEN_HMAC_SECRET` → exit 1.

3. **Cap Argon2 memory:** Reject `ARGON2_MEMORY_COST > 262144` (256 MiB) → exit 1 — prevents OOM from env misconfig.

---

### AC-3: Database Migration — `refresh_tokens` + Session Columns

**Given** Story 1.4 migrations are applied,
**When** `pnpm --filter @project-vault/db db:migrate` runs,
**Then** migration `0003_auth_sessions_refresh.sql` (exact name may vary; journal order preserved) applies:

#### AC-3a: `refresh_tokens` table (architecture-canonical)

```sql
CREATE TABLE refresh_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  new_session_id  UUID REFERENCES sessions(id) ON DELETE SET NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_session_id ON refresh_tokens(session_id);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
```

**RLS:** `refresh_tokens` has **no `org_id`** — **do not enable RLS**. Add `'refresh_tokens'` to `EXCLUDED_TABLES` in `packages/db/src/check-rls-coverage.ts` (identity-scoped, architecture exception).

#### AC-3b: Extend `sessions` (align with Story 1.7 forward-compat)

Story 1.4 created `sessions` **with `org_id`** (active org context at login). **Keep `org_id`** — do not remove in this story (would break existing RLS policies and seed data).

Add columns missing from `0000_initial_schema.sql`:

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS jti TEXT UNIQUE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
```

**Note:** `jti` remains **nullable** until Story 1.7 backfill + `SET NOT NULL`. Story 1.6 always sets `jti` on new sessions.

#### AC-3c: Drizzle schema files

- `packages/db/src/schema/refresh-tokens.ts` — new
- `packages/db/src/schema/sessions.ts` — add `jti`, `revokedAt`
- `packages/db/src/schema/index.ts` — re-export

---

### AC-4: Password Hashing — Argon2id (Reuse Story 1.5 Module)

**Given** a plaintext password,
**When** it is hashed for storage,
**Then** use **`@project-vault/crypto`** — never import `argon2` directly in `apps/api`.

Extend `packages/crypto/src/passwords.ts` (created in Story 1.5) with user-password helpers:

```typescript
// packages/crypto/src/passwords.ts — ADD (do not duplicate ARGON2_PARAMS)

export type PasswordHashConfig = {
  memoryCost: number
  timeCost: number
  parallelism: number
}

/** Build runtime config from env — single source for Story 1.5 master KDF + Story 1.6 user passwords. */
export function passwordHashConfigFromEnv(env: PasswordHashConfig): PasswordHashConfig {
  return {
    memoryCost: env.memoryCost,
    timeCost: env.timeCost,
    parallelism: env.parallelism,
  }
}

/** Hash user password; returns PHC-encoded string (params embedded per Argon2 spec). */
export async function hashUserPassword(
  password: string,
  config: PasswordHashConfig
): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: config.memoryCost,
    timeCost: config.timeCost,
    parallelism: config.parallelism,
  })
}

export async function verifyUserPassword(
  password: string,
  encodedHash: string
): Promise<boolean> {
  return argon2.verify(encodedHash, password)
}
```

**Parameter storage:** The PHC-encoded `password_hash` column **already embeds** salt + memory/time/parallelism params. No separate JSON column required. Document in code comment that future param upgrades re-hash on successful login (Story 1.7+ enhancement — optional hook stub only in 1.6).

**Canonical params (defaults):**

```typescript
memoryCost: 65536  // 64 MiB
timeCost: 3
parallelism: 4
type: argon2id
```

**And** env overrides: `ARGON2_MEMORY_COST`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM`.

---

### AC-5: Registration — `POST /api/v1/auth/register`

**Given** vault is **unsealed** and no user exists with the submitted email,
**When** client sends:

```http
POST /api/v1/auth/register HTTP/1.1
Content-Type: application/json

{
  "email": "owner@acme.example",
  "password": "correct-horse-battery-staple",
  "orgName": "Acme Corp"
}
```

**Then** response is **`201 Created`**:

```json
{
  "data": {
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "orgId": "660e8400-e29b-41d4-a716-446655440001",
    "email": "owner@acme.example",
    "orgName": "Acme Corp",
    "role": "owner"
  }
}
```

**And** in a **single database transaction** (atomic — any failure rolls back all inserts):

1. Insert `organizations` — `name = orgName`, `slug = slugify(orgName)` unique
2. Insert `users` — normalized email (lowercase trim), `password_hash = await hashUserPassword(...)`
3. Insert `org_memberships` — `role = 'owner'`, `status = 'active'`
4. Insert `user_identity_tokens` — `user_id`, `display_name = email` (PII externalization for future audit)
5. Insert `audit_log_entries` — `event_type = AuditEvent.USER_REGISTERED` (see AC-5f)

**Slug generation examples:**

| orgName | slug |
|---|---|
| `"Acme Corp"` | `acme-corp` |
| `"Acme Corp"` (duplicate) | `acme-corp-2`, `acme-corp-3`, … |
| `"  Foo & Bar!!!  "` | `foo-bar` |

Implement `slugify()` in `apps/api/src/modules/auth/service.ts` or `packages/shared` if reused later — lowercase, alphanumeric + hyphens, max 64 chars.

**And** registration does **not** auto-login by default (explicit product choice for 1.6 — keeps register test independent). Client calls `/login` separately. Optional `?autoLogin=true` query flag is **out of scope**.

#### AC-5a: Validation rejections

| Condition | HTTP | Response body |
|---|---|---|
| Password `< 12` chars | `422` | `{ "code": "validation_error", "message": "...", "details": { "password": ["min 12 characters"] } }` |
| Invalid email (not RFC 5322) | `422` | `{ "code": "validation_error", ... }` |
| Non-ASCII email (homograph) | `422` | `{ "code": "validation_error", "details": { "email": ["ASCII characters only"] } }` |
| Duplicate email | `409` | `{ "code": "email_taken", "message": "An account with this email already exists" }` |
| Slug exhausted after 5 retries (concurrent org names) | `409` | `{ "code": "org_name_unavailable", "message": "Organization name could not be allocated" }` |
| Registration disabled (`AUTH_REGISTRATION_ENABLED=false`) | `403` | `{ "code": "registration_disabled", "message": "Registration is disabled on this vault" }` |
| Missing `orgName` or empty | `422` | validation error |
| Vault sealed | `503` | `{ "status": "sealed", "message": "Vault not initialized" }` (vault guard) |

**Email normalization (AC-32):** Apply in order before validation and storage:

```typescript
function normalizeEmail(input: string): string {
  const normalized = input.trim().toLowerCase().normalize('NFKC')
  // v1: ASCII-only — prevents Cyrillic/Greek homograph lookalikes in a secrets vault
  if (!/^[\x21-\x7E]+$/.test(normalized)) {
    throw validationError('email', 'Email must contain ASCII characters only')
  }
  return normalized
}
// Then: z.email().parse(normalized)
```

**Email validation:** Zod `z.email()` on normalized ASCII email.

#### AC-5b2: Registration timing equalization on duplicate (AC-31)

**Given** register detects duplicate email (pre-insert check or Postgres `23505`),
**When** returning `409 email_taken`,
**Then** still run `verifyUserPassword(password, AUTH_DUMMY_PASSWORD_HASH)` **before** sending the response — same timing-hardening as login unknown-email path.

**Integration test:** p50 latency of successful `201` vs duplicate `409` within **25%** (register tx makes 201 inherently slower; threshold is intentionally looser than login's 10%).

#### AC-5b: Password rules

- Minimum **12 characters** (matches Story 1.5 master passphrase minimum)
- No maximum below 128 (prevent DoS); cap at **256** chars in Zod
- Password never logged, never in error messages, never in audit payload

#### AC-5c: Duplicate email — case insensitive

```typescript
// Register attempt 2 with Owner@ACME.example after owner@acme.example exists
// → 409 email_taken
```

#### AC-5c2: Unique constraint race handling (AC-25)

**Given** two concurrent `POST /register` with the same normalized email,
**When** both pass the pre-insert existence check,
**Then** exactly one returns `201`; the other returns `409 { code: "email_taken" }` by catching Postgres error `23505` on `users_email_unique`.

**And** on `organizations_slug_unique` violation during slug insert, retry with next suffix (`acme-corp-2`, `-3`, …) up to **5 attempts** inside the same transaction; if all fail → `409 { code: "org_name_unavailable" }`.

**Integration test:** `Promise.all([register, register])` same email → one 201, one 409.

#### AC-5d: Transaction isolation test

Integration test: force audit insert failure mid-transaction → assert **zero** rows in `users`, `organizations`, `org_memberships`.

#### AC-5e: RLS — registration uses elevated path

Registration creates org-scoped rows **before** an authenticated org context exists. Use **`getDb().transaction()`** without `withOrg()` for the registration transaction, **or** a dedicated `withBootstrapTx()` helper that does not set `app.current_org_id` (platform bootstrap). Document: registration is the **only** user-facing flow allowed to insert org+user without prior auth.

#### AC-5f: Audit event on registration

Add to `packages/shared/src/constants/audit-events.ts`:

```typescript
export const AuditEvent = {
  // ... existing ...
  USER_REGISTERED: 'USER_REGISTERED',
  SESSION_CREATED: 'SESSION_CREATED',
  LOGIN_FAILED: 'LOGIN_FAILED',
} as const
```

Write audit row in same transaction with:
- `actor_type = 'human'`
- `actor_token_id` = newly created identity token
- `event_type = AuditEvent.USER_REGISTERED`
- `payload = { emailDomain: 'acme.example' }` — **never** full email or password
- `key_version` = current `vault_state.audit_key_version`
- `hmac` = computed per AC-5g

#### AC-5g: Audit HMAC (minimal — full tamper chain in Story 8.1)

Story 8.1 implements the complete audit HMAC chain. Story 1.6 **must still insert non-null `hmac`** (column is `NOT NULL`).

Implement `apps/api/src/modules/audit/write-entry.ts`:

```typescript
import { createHmac } from 'node:crypto'
import { getAuditKey } from '../vault/key-service.js'

/** Canonical JSON: sorted keys, no whitespace — matches architecture Story 8.1 spec. */
export function computeAuditHmac(fields: Record<string, unknown>, auditKey: Buffer): string {
  const canonical = JSON.stringify(sortKeys(fields))
  return createHmac('sha256', auditKey).update(canonical).digest('hex')
}
```

Use `getAuditKey()` from Story 1.5 `key-service.ts`. If vault sealed during registration → registration blocked by vault guard anyway.

---

### AC-6: Login — `POST /api/v1/auth/login`

**Given** vault unsealed and user exists with verified password,
**When** client sends:

```http
POST /api/v1/auth/login HTTP/1.1
Content-Type: application/json

{
  "email": "owner@acme.example",
  "password": "correct-horse-battery-staple"
}
```

**Then** response is **`200 OK`** with **Set-Cookie** headers (architecture-authoritative — tokens NOT in JSON body):

```http
HTTP/1.1 200 OK
Set-Cookie: access-token=eyJhbG...; HttpOnly; Path=/; SameSite=Strict; Max-Age=300
Set-Cookie: refresh-token=<opaque>; HttpOnly; Path=/api/v1/auth/refresh; SameSite=Strict; Max-Age=604800
Content-Type: application/json

{
  "data": {
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "orgId": "660e8400-e29b-41d4-a716-446655440001",
    "expiresAt": "2026-06-24T12:05:00.000Z"
  }
}
```

**Cookie flags:**
- `HttpOnly` — always
- `SameSite=Strict` — always
- `Secure` — when `env.COOKIE_SECURE === true` (default: `true` in production, `false` in dev)
- `access-token` Path=`/`
- `refresh-token` Path=`/api/v1/auth/refresh` (architecture — limits cookie scope)

**Session fixation prevention (AC-22):** Before setting new cookies on login, clear any stale auth cookies:

```typescript
reply.clearCookie('access-token', { path: '/' })
reply.clearCookie('refresh-token', { path: '/api/v1/auth/refresh' })
setAuthCookies(reply, tokens)
```

**And** `@fastify/cookie` registered in `app.ts` before auth routes.

#### AC-6h: Cookie issuance only after transaction commit (AC-27)

**Given** login succeeds at the service layer,
**When** the route handler responds,
**Then** `setAuthCookies()` is called **only after** the service transaction commits — token material returned from `loginUser()`, cookies set in the route handler.

**Failure mode prevented:** Client receives `Set-Cookie` but DB has no session row (orphan auth state).

```typescript
// routes.ts — CORRECT
const result = await loginUser(input, meta) // tx commits inside service
setAuthCookies(reply, result.tokens)
return reply.send({ data: { userId: result.userId, orgId: result.orgId, expiresAt: result.expiresAt } })

// WRONG — cookies inside service before tx commit
```

**Same pattern for refresh:** `refreshSession()` commits first, then route sets cookies.

**Integration test:** Simulate tx failure after token generation → response must have **no** `Set-Cookie` headers.

#### AC-6i: Deactivated / orphan account rejection (AC-26)

**Given** a user record exists,
**When** `POST /login` is called,
**Then** return `401 { code: "invalid_credentials" }` (uniform — do not reveal deactivation) if:
- User has **no** `org_memberships` row, **or**
- **All** memberships have `status = 'deactivated'`

**Do not** create session or refresh token rows for rejected logins.

**Integration test:** Seed user with `org_memberships.status = 'deactivated'` → login returns 401 `invalid_credentials`.

#### AC-6j: Corrupt password hash handling (AC-29)

**Given** `users.password_hash` is malformed (not valid Argon2 PHC),
**When** login calls `verifyUserPassword`,
**Then** catch verify errors → return `401 invalid_credentials` (uniform); log at `error` level with `{ userId, eventType: 'auth.password_hash_corrupt' }` — **never** log hash or password.

**Unit test:** User with `password_hash: 'not-a-hash'` → 401, not 500.

#### AC-6a: JWT claims (HMAC-SHA256 — NOT RS256)

**Architecture wins over epics.md RS256 text.** Sign with `@fastify/jwt` + `SESSION_SECRET`.

```typescript
// JWT payload — issued at login
{
  sub: userId,           // uuid string
  orgId: activeOrgId,    // user's org from membership (see AC-6b)
  jti: sessionJti,       // uuid v4 — matches sessions.jti
  sessionVersion: 1,     // matches sessions.session_version
  iat: number,           // unix seconds
  exp: number            // iat + JWT_ACCESS_TTL_SECONDS (default 300)
}
```

**Do NOT** generate RS256 key pair. **Do NOT** store JWT signing keys in `vault_state`.

#### AC-6b: Active org selection at login

For v1 registration flow, user has exactly one org membership (the one created at register). Login sets `sessions.org_id` to that org's id.

Future multi-org users (Epic 4): login accepts optional `orgId` in body — **out of scope for 1.6**; document TODO in service.

#### AC-6c: Session + refresh token persistence

In one transaction (`withOrg(orgId, ...)` for session row + audit; refresh token insert via platform tx):

1. Insert `sessions` row: `user_id`, `org_id`, `jti`, `session_version=1`, `expires_at` (access token exp), `ip_address`, `user_agent`, `last_active_at=now()`
2. Generate refresh token: `crypto.randomBytes(32)` → base64url opaque string
3. Store `refresh_tokens.token_hash = hashRefreshToken(opaqueToken)` — HMAC-SHA256, **not Argon2**; compare with `timingSafeEqual` (see AC-21)
4. `refresh_tokens.expires_at = now() + REFRESH_TOKEN_TTL_DAYS`
5. Audit: `AuditEvent.SESSION_CREATED` in same transaction

**Never store plaintext refresh token in DB.**

#### AC-6d: Failed login — uniform response

Wrong password OR unknown email → **identical** response:

```json
HTTP 401
{ "code": "invalid_credentials", "message": "Invalid email or password" }
```

**No** `"user not found"` vs `"wrong password"` distinction.

#### AC-6e: Timing oracle protection

On unknown email, still run:

```typescript
await verifyUserPassword(submittedPassword, env.AUTH_DUMMY_PASSWORD_HASH)
```

Measure and test: p50 latency difference between known-user wrong-password vs unknown-email ≤ **10%** (generous CI threshold; same Argon2 params required).

Precompute dummy hash at build/test setup:

```bash
# Generate once, commit to .env.example as AUTH_DUMMY_PASSWORD_HASH
node -e "import('argon2').then(a => a.default.hash('dummy-timing-safe-password-12chars', {type: a.default.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4}).then(console.log))"
```

#### AC-6f: Failed login audit — best effort (AC-30)

On failed login, insert audit via **separate short transaction** (best effort — not coupled to the 401 response):
- `AuditEvent.LOGIN_FAILED`
- `actor_token_id = null` if unknown email; else identity token if known user
- `payload = { reason: 'invalid_credentials' }` — no email in payload

**If audit insert fails:** still return `401 invalid_credentials` to client; log server-side `error` — **never** convert failed login into `500`.

**Contrast:** Successful login `SESSION_CREATED` audit remains in the **same transaction** as session insert (AC-6c invariant).

**Integration test:** Mock audit insert failure on failed login → client still receives 401.

#### AC-6g: Login examples — curl

```bash
# Success
curl -s -c cookies.txt -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@acme.example","password":"correct-horse-battery-staple"}' | jq .

# Wrong password — same shape as unknown user
curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@acme.example","password":"wrong-password-here"}'

# Unknown email
curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"nobody@example.com","password":"any-password-12chars"}'
# Both → 401 invalid_credentials
```

---

### AC-7: Refresh — `POST /api/v1/auth/refresh`

**Given** valid refresh token cookie,
**When** client sends:

```http
POST /api/v1/auth/refresh HTTP/1.1
Cookie: refresh-token=<opaque>
```

**Then** response **`200 OK`** with rotated cookies (new access + new refresh) and:

```json
{
  "data": {
    "expiresAt": "2026-06-24T12:10:00.000Z"
  }
}
```

#### AC-7a: Token rotation (every refresh)

1. Lookup `refresh_tokens` by `token_hash` with **`SELECT FOR UPDATE`** inside transaction (AC-21 — prevents double-rotation race)
2. Reject if: expired, `revoked_at` set, or `used_at` set **> REFRESH_GRACE_WINDOW_SECONDS ago**
3. Set `used_at = now()`, `new_session_id = <new session uuid>` **before** issuing new tokens
4. Create new `sessions` row + new `refresh_tokens` row
5. Return new cookies

#### AC-7b: Grace window idempotency (architecture)

If `used_at` is set and `now - used_at ≤ 30s`, lookup `new_session_id` → re-sign JWT from that session's `jti` with **fresh `iat`/`exp`** (`iat = now()`, not session `created_at`).

```typescript
// CORRECT JWT re-sign on grace retry
const now = Math.floor(Date.now() / 1000)
await reply.jwtSign(
  { sub, orgId, jti, sessionVersion },
  { jti, expiresIn: env.JWT_ACCESS_TTL_SECONDS }
)
```

#### AC-7c: Refresh failure cases

| Case | HTTP | code |
|---|---|---|
| Missing cookie | `401` | `refresh_token_missing` |
| Invalid hash / not found | `401` | `refresh_token_invalid` |
| Expired | `401` | `refresh_token_expired` |
| Used outside grace window | `401` | `refresh_token_revoked` |

#### AC-7d: Refresh curl example

```bash
curl -s -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/v1/auth/refresh
```

#### AC-7e: Double refresh within grace window

Integration test: refresh twice within 30s → both succeed; same `new_session_id`; second JWT has newer `iat`.

---

### AC-8: Logout Stub (Optional Minimum)

**Out of full scope** (Story 1.7 owns session list/revoke). If implemented as stub:

`POST /api/v1/auth/logout` — clears cookies, sets `refresh_tokens.revoked_at`, `sessions.revoked_at`. Otherwise document deferral in Dev Notes.

---

### AC-9: Rate Limiting on Auth Endpoints

**Given** `@fastify/rate-limit` (dependency exists),
**When** unauthenticated client exceeds limits on `/api/v1/auth/*`,
**Then** `429` with `{ "code": "rate_limit_exceeded", "message": "..." }`.

| Endpoint group | Limit |
|---|---|
| `/register` | **10 req/min per IP** (AC-19 — stricter; expensive tx + org sprawl) |
| `/login` | 60 req/min per IP (architecture unauthenticated default) |
| `/refresh` | 120 req/min per IP |

Use separate rate limit config on auth route plugin — do not weaken global limits.

**And** auth plugin sets `bodyLimit: 4096` (4 KB) on all auth routes — reject oversized bodies **before** Argon2 (AC-23).

---

### AC-10: Logging & Secret Redaction

**Given** Pino logger on Fastify,
**When** any auth request is processed,
**Then** configure redaction (Story 1.10 expands; minimum for 1.6):

```typescript
// apps/api/src/app.ts logger config
redact: {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.body.password',
    'req.body.passphrase',
  ],
  censor: '[REDACTED]',
}
```

**And** global error handler never serializes `request.body.password` into logs on validation failure.

**And** integration test `apps/api/src/__tests__/auth-log-redaction.test.ts`:
- Triggers Zod validation error on login with password field
- Asserts log output (capture via Pino destination stream) does **not** contain submitted password string

**And** `eslint-plugin-no-secrets` remains enabled (Story 1.1) — no high-entropy literals in auth source.

---

### AC-11: Shared API Contracts (Zod)

Add to `packages/shared/src/schemas/auth.ts`:

```typescript
export const RegisterRequestSchema = z.object({
  email: z.email().max(254), // validated AFTER normalizeEmail() in service — see AC-32
  password: z.string().min(12).max(256),
  orgName: z.string().min(1).max(128).trim(),
})

export const LoginRequestSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256), // min 1 on login — don't leak registration rules
})

export const AuthSessionResponseSchema = z.object({
  userId: z.uuid(),
  orgId: z.uuid(),
  expiresAt: z.iso.datetime(),
})

export const RegisterResponseSchema = z.object({
  userId: z.uuid(),
  orgId: z.uuid(),
  email: z.email(),
  orgName: z.string(),
  role: z.enum(['owner']), // v1 first user only
})
```

Export from `packages/shared/src/index.ts`. Run `pnpm --filter @project-vault/api generate-spec` — OpenAPI updated.

---

### AC-12: `@fastify/jwt` Plugin Registration

```typescript
// apps/api/src/plugins/jwt.ts
import fjwt from '@fastify/jwt'

await fastify.register(fjwt, {
  secret: env.SESSION_SECRET,
  sign: { algorithm: 'HS256' },
  verify: { algorithms: ['HS256'] },
  cookie: {
    cookieName: 'access-token',
    signed: false, // httpOnly cookie; integrity via JWT sig
  },
})
```

JWT verification middleware for **protected routes** is Story 1.11 — Story 1.6 only **signs** tokens at login/refresh.

#### AC-12b: JWT algorithm lockdown tests (AC-33)

**Given** the JWT plugin configuration,
**When** unit tests run in `apps/api/src/modules/auth/tokens.test.ts`,
**Then** assert:
- Token with tampered `alg: none` payload → **rejected** on verify
- Token signed with wrong `SESSION_SECRET` → **rejected**
- Valid HS256 token with correct secret → **accepted**

**Plugin config invariant (NEVER relax):**

```typescript
verify: { algorithms: ['HS256'] }  // NEVER add 'none', 'RS256', or multi-alg arrays
```

These tests prepare verification behavior before Story 1.11 middleware; signing path must use the same constraints.

---

### AC-13: CORS + Credentials

**Given** browser client on `http://localhost:5173`,
**When** login with `credentials: 'include'`,
**Then** CORS response includes `Access-Control-Allow-Credentials: true` and specific origin (not `*`).

Update `@fastify/cors` registration:

```typescript
await fastify.register(cors, {
  origin: /* existing allowlist */,
  credentials: true,
})
```

Integration test: login response includes `Access-Control-Allow-Credentials: true` for allowed origin.

---

### AC-14: Integration Tests (Real DB — No Mocks)

File: `apps/api/src/__tests__/auth.integration.test.ts`

**Test harness requirements:**

```typescript
describe.sequential('Auth flows', () => {
  beforeAll(async () => {
    await ensureVaultUnsealedForTests() // init+unseal passphrase fixture OR mock key-service in test mode
    await resetAuthTestData()           // truncate users/orgs/sessions/refresh_tokens in FK order
  })

  // Registration
  it('registers org + owner atomically', async () => { ... })
  it('rejects duplicate email with 409', async () => { ... })
  it('rejects password under 12 chars', async () => { ... })
  it('rejects invalid email', async () => { ... })

  // Login
  it('login sets HttpOnly cookies and returns expiresAt', async () => { ... })
  it('wrong password returns 401 invalid_credentials', async () => { ... })
  it('unknown email returns same 401 invalid_credentials', async () => { ... })
  it('timing-safe path executes dummy hash for unknown email', async () => { ... })

  // Refresh
  it('refresh rotates tokens', async () => { ... })
  it('grace window allows duplicate refresh', async () => { ... })
  it('refresh after grace window fails', async () => { ... })

  // Vault guard
  it('register returns 503 when vault sealed', async () => { ... })

  // Audit
  it('registration writes USER_REGISTERED audit row', async () => { ... })
  it('successful login writes SESSION_CREATED audit row', async () => { ... })

  // Security hardening (AC-19–24)
  it('register rate limit returns 429 after 10 requests/min', async () => { ... })
  it('registration disabled when AUTH_REGISTRATION_ENABLED=false', async () => { ... })
  it('concurrent refresh does not create duplicate token rows', async () => { ... })
  it('login always issues new jti (session fixation prevention)', async () => { ... })
  it('oversized login body rejected before Argon2', async () => { ... })

  // Failure mode analysis (AC-25–30)
  it('concurrent register same email: one 201 one 409', async () => { ... })
  it('deactivated membership cannot login', async () => { ... })
  it('cookies not set when login transaction fails', async () => { ... })
  it('corrupt password_hash returns 401 not 500', async () => { ... })
  it('failed login returns 401 even when audit write fails', async () => { ... })

  // Red team hardening (AC-31–35)
  it('409 register still runs dummy Argon2 verify (timing equalization)', async () => { ... })
  it('rejects non-ASCII email after NFKC normalization', async () => { ... })
  it('GET auth/login returns 405 Method Not Allowed', async () => { ... })
  it('X-Forwarded-For ignored when TRUST_PROXY=false for rate limit', async () => { ... })
})
```

**Unit tests:**
- `apps/api/src/modules/auth/tokens.test.ts` — `refreshTokensMatch()` uses `timingSafeEqual` (AC-21); JWT alg-none / wrong-secret rejection (AC-33)
- `apps/api/src/modules/audit/write-entry.test.ts` — `computeAuditHmac()` deterministic regardless of input key order (AC-5g)
```

Use `fastify.inject()` with cookie headers — no HTTP server required.

**Mutation score:** ≥80% on `apps/api/src/modules/auth/**` (security-critical).

---

### AC-15: Dependencies to Add

| Package | Where | Purpose |
|---|---|---|
| `@fastify/cookie` | `apps/api` | Parse/set HttpOnly cookies |
| `argon2` | `packages/crypto` only | Already added in Story 1.5 — do not duplicate in api |

---

### AC-16: Error Response Shape (Unified)

All auth errors use `ApiErrorSchema` from `@project-vault/shared`:

```typescript
{ "code": "email_taken", "message": "Human-readable message" }
```

**Not** `{ "error": "email_taken" }` (legacy epic wording — use `code` field).

Validation errors:

```typescript
{
  "code": "validation_error",
  "message": "Request validation failed",
  "details": { "password": ["String must contain at least 12 character(s)"] }
}
```

Wire through centralized error handler in `apps/api/src/lib/errors.ts` (extend if needed).

---

### AC-17: Sealed Vault Behavior (Regression)

Auth endpoints return **503** when vault sealed (same as Story 1.5 AC-17):

```bash
# After docker compose restart api (vault sealed)
curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"x@y.com","password":"twelve-characters","orgName":"Test"}'
# → 503
```

---

### AC-18: OpenAPI / generate-spec

`pnpm --filter @project-vault/api generate-spec` succeeds; `packages/shared/openapi.json` includes:

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`

Request/response schemas reference shared Zod meta IDs.

---

### AC-19: Registration Rate Limit (Stricter Than Login)

**Given** an unauthenticated client,
**When** calling `POST /api/v1/auth/register` repeatedly from the same IP,
**Then** the limit is **10 requests per minute per IP** (stricter than login's 60/min).

**Rationale:** Registration runs multi-table transactions, Argon2id, and audit writes — it is both costlier and enables org sprawl if abused.

**And** the 11th register attempt within 60 seconds from the same IP returns `429 { "code": "rate_limit_exceeded", "message": "..." }`.

**Integration test:** Assert 11th request returns 429.

---

### AC-20: Account Enumeration Hardening

**Given** registration attempts,
**When** email already exists,
**Then** return `409 { "code": "email_taken", "message": "An account with this email already exists" }`.

**Accepted v1 product risk:** Register path **may** reveal email existence (unlike login, which is uniform). Mitigation for production deployments:

| Variable | Default | Production recommendation |
|---|---|---|
| `AUTH_REGISTRATION_ENABLED` | `true` | Set `false` for invite-only deployments |

**When** `AUTH_REGISTRATION_ENABLED=false`:
- `POST /api/v1/auth/register` returns `403 { "code": "registration_disabled", "message": "Registration is disabled on this vault" }`
- Login and refresh unaffected

**Integration test:** With `AUTH_REGISTRATION_ENABLED=false`, register returns 403.

**Login path invariant (unchanged):** Wrong password and unknown email both return `401 invalid_credentials` — never distinguish.

---

### AC-21: Refresh Token Rotation — Concurrency & Constant-Time

**Given** two concurrent `POST /api/v1/auth/refresh` requests with the same valid refresh cookie,
**When** both hit the server simultaneously,
**Then** exactly one rotation succeeds; the other either:
- Receives idempotent success within the grace window (same `new_session_id`, fresh JWT `iat`), **or**
- Returns `401 { "code": "refresh_token_revoked" }` after grace — **never** creates duplicate active refresh rows for the same rotation chain.

**Implementation requirements:**

```typescript
// Inside refresh transaction — REQUIRED
const [row] = await tx
  .select()
  .from(refreshTokens)
  .where(eq(refreshTokens.tokenHash, hash))
  .for('update')  // SELECT FOR UPDATE — prevents double-rotation race

import { timingSafeEqual, createHmac } from 'node:crypto'

export function hashRefreshToken(opaque: string): string {
  return createHmac('sha256', env.REFRESH_TOKEN_HMAC_SECRET)
    .update(opaque)
    .digest('hex')
}

export function refreshTokensMatch(storedHash: string, opaque: string): boolean {
  const computed = hashRefreshToken(opaque)
  if (storedHash.length !== computed.length) return false
  return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(computed, 'hex'))
}
```

**Anti-pattern:** Never compare refresh hashes with `===` or bare string equality.

**Integration test:**

```typescript
const [r1, r2] = await Promise.all([
  app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies }),
  app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies }),
])
// Assert: both 200 OR one 200 + one 401/revoked; DB has exactly one active refresh row in new chain
```

---

### AC-22: Session Fixation Prevention

**Given** a successful login,
**When** session tokens are issued,
**Then** always generate a **new** `jti` (uuid v4) and **new** opaque refresh token — never reuse pre-login session identifiers.

**And** clear stale auth cookies before setting new ones (see AC-6 cookie flags).

**And** each login creates a distinct `sessions.jti` even for the same user logging in twice.

**Integration test:** Login twice as same user → two rows in `sessions` with different `jti` values.

---

### AC-23: Request Body Size Limit on Auth Routes

**Given** any auth route (`/register`, `/login`, `/refresh`),
**When** request body exceeds **4096 bytes (4 KB)**,
**Then** Fastify rejects with payload error (`413` or `400`) **before** Argon2 or HMAC work runs.

Register auth routes with `bodyLimit: 4096` on the auth plugin encapsulation.

**Integration test:** POST login with >4 KB JSON body → rejected; assert Argon2 verify was not invoked (mock/spy on `verifyUserPassword`).

---

### AC-24: Production & Staging Cookie Security

**Given** `COOKIE_SECURE=true` (default when `NODE_ENV=production`),
**When** setting auth cookies,
**Then** both `access-token` and `refresh-token` include `Secure: true`.

**Staging note:** Vault instances behind Traefik/HTTPS **must** set `COOKIE_SECURE=true` or browsers will not persist cookies. Local HTTP dev uses `COOKIE_SECURE=false`.

**Optional hardening (document only — defer to Story 1.7):** `__Host-` cookie prefix for access-token requires `Secure`, `Path=/`, no `Domain` attribute.

**Update cookie helper:**

```typescript
const secure = env.COOKIE_SECURE
reply.setCookie('access-token', tokens.accessJwt, { httpOnly: true, sameSite: 'strict', secure, path: '/', ... })
```

---

### AC-25: Register Unique-Constraint Race Handling

*(Detailed in AC-5c2 — this AC is the canonical reference for Task tracking.)*

**Given** concurrent registration requests,
**When** Postgres raises `23505` on `users_email_unique` or `organizations_slug_unique`,
**Then** map to `409 email_taken` or retry slug suffix (max 5) → `409 org_name_unavailable`.

---

### AC-26: Deactivated / Orphan Account Login Rejection

*(Detailed in AC-6i.)*

---

### AC-27: Cookie Issuance Only After Transaction Commit

*(Detailed in AC-6h.)*

---

### AC-28: Startup Validation — Dummy Hash, Secret Separation, Argon2 Cap

*(Detailed in AC-2b.)*

---

### AC-29: Corrupt Password Hash Handling

*(Detailed in AC-6j.)*

---

### AC-30: Failed-Login Audit — Best Effort

*(Detailed in AC-6f.)*

---

### AC-31: Registration Timing Equalization on 409

*(Detailed in AC-5b2.)*

---

### AC-32: Email Normalization — ASCII-Only Homograph Hardening

*(Detailed in AC-5 email normalization — NFKC + ASCII-only rule.)*

**Integration test:** Register with Cyrillic lookalike (`аdmin@test.com` — Cyrillic `а`) → `422 validation_error`.

---

### AC-33: JWT Algorithm Lockdown Tests

*(Detailed in AC-12b.)*

---

### AC-34: Auth Routes — POST-Only

*(Detailed in AC-1b.)*

---

### AC-35: Trust Proxy — Explicit & Restricted

**Given** the API runs behind a reverse proxy,
**When** `TRUST_PROXY=true`,
**Then** Fastify uses restricted proxy trust:

```typescript
// apps/api/src/app.ts
const fastify = Fastify({
  logger,
  trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY_HOPS : false,
})
```

**Default:** `TRUST_PROXY=false` — `request.ip` is the socket IP; **`X-Forwarded-For` is ignored** for rate limiting and `sessions.ip_address`.

**Never** set `TRUST_PROXY=true` on a directly internet-exposed API — enables rate-limit bypass via spoofed `X-Forwarded-For`.

**Integration test:** With `TRUST_PROXY=false`, send `X-Forwarded-For: 203.0.113.1` — rate limit bucket uses socket IP, not spoofed header.

**Replaces** earlier Dev Notes guidance of unconditional `trustProxy: production`.

---

### AC-36: Session Proliferation — v1 Policy

**Given** repeated successful logins by the same user,
**When** Story 1.6 is complete,
**Then** each login creates a **new** session + refresh token row (AC-22) — **no max-session cap**.

**Accepted v1 risk:** Stolen password enables unlimited parallel sessions until password change (Epic 4) or admin revoke (Story 1.7).

**Optional env (Story 1.7 — document only in 1.6):** `MAX_SESSIONS_PER_USER` — when implemented, oldest sessions revoked on new login.

---

## Tasks / Subtasks

- [x] **Task 1: Schema & migration** (AC: 3)
  - [x] Create `refresh_tokens` Drizzle schema + migration
  - [x] Add `jti`, `revoked_at` to sessions schema + migration
  - [x] Update `check-rls-coverage.ts` EXCLUDED_TABLES for `refresh_tokens`
  - [x] Run `db:migrate` idempotency check
- [x] **Task 2: Crypto password helpers** (AC: 4)
  - [x] Extend `packages/crypto/src/passwords.ts` with `hashUserPassword` / `verifyUserPassword`
  - [x] Unit tests in `packages/crypto`
- [x] **Task 3: Env & config** (AC: 2, 2b, 15, 20, 24, 28, 35)
  - [x] Extend `env.ts` — add `AUTH_REGISTRATION_ENABLED`, `COOKIE_SECURE`, `TRUST_PROXY`, `TRUST_PROXY_HOPS`
  - [x] AC-2b: validate dummy hash PHC, reject identical secrets, cap Argon2 memory
  - [x] Update `.env.example`, check-env-example CI
- [x] **Task 4: Audit write helper** (AC: 5f, 5g)
  - [x] `modules/audit/write-entry.ts` + expand `AuditEvent` constants
- [x] **Task 5: Auth service** (AC: 5, 6, 7, 25–32, 36)
  - [x] `normalizeEmail()` — NFKC + ASCII-only (AC-32)
  - [x] `registerUser()` — unique violation catch + slug retry (AC-25); dummy hash on 409 (AC-31)
  - [x] `loginUser()` — deactivated check, corrupt hash catch, cookies after commit (AC-26–27, 29)
  - [x] `refreshSession()` — cookies after commit (AC-27)
  - [x] `recordLoginFailed()` — best-effort audit tx (AC-30)
  - [x] `tokens.ts` — JWT + refresh HMAC + cookie helpers
  - [x] `slugify()`, timing-safe login
- [x] **Task 6: Auth routes + plugins** (AC: 1, 1b, 6, 7, 9, 12, 12b, 13, 19, 23, 27, 34, 35)
  - [x] Register `@fastify/cookie`, `@fastify/jwt`, rate limit (register 10/min, login 60/min)
  - [x] Set `bodyLimit: 4096` on auth plugin
  - [x] `trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY_HOPS : false` (AC-35)
  - [x] POST-only auth routes (AC-34)
  - [x] Mount routes; update vault guard allowlist
  - [x] Route handlers: set cookies **after** service returns (AC-27)
  - [x] `AUTH_REGISTRATION_ENABLED` guard on register route
- [x] **Task 7: Shared schemas** (AC: 11, 16)
  - [x] `packages/shared/src/schemas/auth.ts`
  - [x] Regenerate OpenAPI
- [x] **Task 8: Tests** (AC: 10, 14, 17, 19–36)
  - [x] Integration test suite (security + failure mode + red team cases)
  - [x] `tokens.test.ts` — timingSafeEqual + JWT alg rejection (AC-21, AC-33)
  - [x] `write-entry.test.ts` — audit HMAC determinism
  - [x] Log redaction test
  - [x] Update route-audit exempt list
- [x] **Task 9: Documentation touchpoints**
  - [x] README auth section (minimal — env vars + curl examples)

### Review Findings

- [x] [Review][Patch] Registration audit bootstrap contradicts RLS/bootstrap constraints [apps/api/src/modules/auth/service.ts:198]
- [x] [Review][Patch] Auth routes bypass sealed-vault protection [apps/api/src/plugins/vault-guard.ts:17]
- [x] [Review][Patch] Grace-window refresh returns an unstored refresh token [apps/api/src/modules/auth/service.ts:407]
- [x] [Review][Patch] Failed-login audit skips unknown, orphan, and deactivated users [apps/api/src/modules/auth/service.ts:224] — resolved with org audit for known org subjects and `platform_security_events` for unknown/orphan subjects.
- [x] [Review][Patch] Dummy password hash validation accepts non-verifiable or wrong-cost hashes [apps/api/src/config/env.ts:62]
- [x] [Review][Patch] Non-ASCII email validation runs after `z.email()` and returns the wrong error detail [apps/api/src/modules/auth/routes.ts:93]
- [x] [Review][Patch] Required real-DB auth integration coverage is missing [apps/api/src/__tests__/auth.integration.test.ts]

---

## Dev Notes

### Architecture Compliance — Critical Decisions

| Topic | Epics.md says | Architecture says | **Story 1.6 decision** |
|---|---|---|---|
| JWT signing | RS256, keys in vault_state | HMAC-SHA256 via `@fastify/jwt` | **Architecture wins** — `SESSION_SECRET` env var |
| Token delivery | `{ accessToken, expiresAt }` JSON | HttpOnly cookies only for browser | **Cookies for tokens**; JSON returns metadata only (`expiresAt`, ids) |
| Refresh storage | Hashed in `sessions` table | Separate `refresh_tokens` table | **`refresh_tokens` table** (architecture) |
| `sessions.org_id` | Present (Story 1.4) | Absent (RLS exception) | **Keep `org_id`** — implemented schema + RLS policies; represents active org context |
| Error shape | `{ error: "email_taken" }` | `ApiErrorSchema` with `code` | **`code` field** (shared schema) |
| Argon2 for tokens | — | HMAC-SHA256 for high-entropy tokens | **Argon2id = passwords only**; refresh token = HMAC-SHA256 |

[Source: _bmad-output/implementation-artifacts/1-5-vault-initialization-and-master-key-management.md#RS256-vs-HMAC-SHA256-Conflict]
[Source: _bmad-output/planning-artifacts/architecture.md#Authentication--Security]

---

### Bootstrap Transaction Pattern (Registration)

Registration cannot use `withOrg(orgId)` before org exists. Pattern:

```typescript
export async function registerUser(input: RegisterInput): Promise<RegisterResult> {
  return getDb().transaction(async (tx) => {
    const orgId = crypto.randomUUID()
    const userId = crypto.randomUUID()
    // inserts: organizations, users, org_memberships, user_identity_tokens, audit_log_entries
    // NO set_config('app.current_org_id') — platform bootstrap
    return { userId, orgId, ... }
  })
}
```

Post-registration queries from authenticated routes use `withOrg(orgId, ...)`.

---

### Login Transaction Pattern

```typescript
export async function loginUser(input: LoginInput, meta: RequestMeta): Promise<LoginResult> {
  const user = await findUserByEmail(input.email) // platform-level read on users — no RLS on users table
  const hash = user?.passwordHash ?? env.AUTH_DUMMY_PASSWORD_HASH
  const valid = await verifyUserPassword(input.password, hash)
  if (!user || !valid) {
    await recordLoginFailed(...)
    throw new AppError('invalid_credentials', 'Invalid email or password', 401)
  }
  const membership = await findPrimaryMembership(user.id) // first org for v1
  return withOrg(membership.orgId, async (tx) => {
    const jti = crypto.randomUUID()
    // insert session, refresh_token, audit SESSION_CREATED
    return { cookies, expiresAt, userId: user.id, orgId: membership.orgId }
  })
}
```

**Note:** `users` table has **no RLS** (platform table). Query directly via `getDb()`.

---

### Refresh Token Lookup (No RLS)

`refresh_tokens` has no org context. Query with platform transaction:

```typescript
const row = await getDb()
  .select()
  .from(refreshTokens)
  .where(eq(refreshTokens.tokenHash, hash))
  .limit(1)
```

Only `modules/auth/service.ts` may query `refresh_tokens` directly — document in file header.

---

### Reverse Proxy & Rate Limit Client IP (AC-35)

When the API runs behind Traefik/nginx, set **`TRUST_PROXY=true`** and **`TRUST_PROXY_HOPS=1`** (or hop count matching your infra). Do **not** enable on directly exposed APIs.

```typescript
// apps/api/src/app.ts
const fastify = Fastify({
  logger,
  trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY_HOPS : false,
})
```

**Default (`TRUST_PROXY=false`):** `request.ip` is socket IP; spoofed `X-Forwarded-For` does **not** affect rate limits or audit `ip_address`.

**v1 multi-instance note:** `@fastify/rate-limit` in-memory store means per-instance limits (60/min becomes 60×N across N replicas). Acceptable for v1 single-instance constraint; document for horizontal scaling (Redis store deferred).

---

### Secret Rotation Runbook (Ops)

| Secret rotated | Immediate effect |
|---|---|
| `SESSION_SECRET` | All access JWTs invalid; clients must refresh or re-login |
| `REFRESH_TOKEN_HMAC_SECRET` | All refresh token hashes invalid; forced re-login for all users |
| Both | Full session wipe — all users must re-authenticate |

Document in README auth section. Rotation procedure (dual-key grace) is Story 1.7+ scope.

---

### Cookie Helper Example

```typescript
export function setAuthCookies(
  reply: FastifyReply,
  tokens: { accessJwt: string; refreshOpaque: string; refreshMaxAgeSec: number; accessMaxAgeSec: number }
): void {
  const secure = env.COOKIE_SECURE
  reply.setCookie('access-token', tokens.accessJwt, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: tokens.accessMaxAgeSec,
  })
  reply.setCookie('refresh-token', tokens.refreshOpaque, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/api/v1/auth/refresh',
    maxAge: tokens.refreshMaxAgeSec,
  })
}
```

---

### Project Structure Notes

| What | Where |
|---|---|
| Auth routes | `apps/api/src/modules/auth/routes.ts` |
| Auth business logic | `apps/api/src/modules/auth/service.ts` |
| JWT + cookie helpers | `apps/api/src/modules/auth/tokens.ts` |
| Zod API contracts | `packages/shared/src/schemas/auth.ts` |
| Password hashing | `packages/crypto/src/passwords.ts` |
| Refresh tokens schema | `packages/db/src/schema/refresh-tokens.ts` |
| Audit constants | `packages/shared/src/constants/audit-events.ts` |
| Audit HMAC helper | `apps/api/src/modules/audit/write-entry.ts` |
| Env validation | `apps/api/src/config/env.ts` |
| Integration tests | `apps/api/src/__tests__/auth.integration.test.ts` |

**Do NOT** put auth logic in `apps/web` — backend-only story. SvelteKit auth UI is Epic 1 Story 1.7+ / architecture step 7.

---

### Testing Standards

- **Real PostgreSQL** — use `DATABASE_URL` with `vault_app` role (same as Story 1.4)
- **Vitest** `describe.sequential` for auth tests — avoid parallel collisions on email uniqueness
- **fastify.inject()** — preferred over supertest
- **`withTestOrg()`** not applicable for registration (creates own org) — use dedicated cleanup
- **Vault fixture:** reuse Story 1.5 `resetVaultForTest()` + init+unseal passphrase `"test-passphrase-12chars"` in `beforeAll`
- **Cleanup order:** `refresh_tokens` → `sessions` → `audit_log_entries` → `org_memberships` → `user_identity_tokens` → `users` → `organizations`
- **RLS on audit delete:** wrap deletes in `withOrg(orgId, ...)` per Story 1.4 learnings — bare delete is a silent no-op

[Source: _bmad-output/implementation-artifacts/1-4-database-foundation-with-postgresql-rls-and-core-schema.md#Audit-Completeness-Invariant]

---

### Previous Story Intelligence

#### From Story 1.5 (Vault Init)

- Reuse `packages/crypto/src/passwords.ts` — **same Argon2 params** as master passphrase KDF
- Auth routes blocked at vault guard until unsealed — extend allowlist when implementing
- `getAuditKey()` available after unseal — use for audit HMAC
- `SESSION_SECRET` wired in **this story**, not 1.5
- RS256 explicitly **rejected** — do not generate asymmetric JWT keys

#### From Story 1.4 (Database)

- Table names: `org_memberships` (not `organization_members`), `audit_log_entries` (not `audit_events`)
- `refresh_tokens` **did not exist** — create now
- `sessions` exists with `org_id`, `session_version` — extend with `jti`
- Audit writes **same transaction** as operation — mandatory
- `users` has no RLS — app-layer protection only

#### From Story 1.3 (Docker/API)

- CORS allowlist from env — add `credentials: true` for cookie auth
- Helmet already registered — cookies compatible
- Error handler pattern: `AppError` → structured JSON

#### From Story 1.1 (Quality gates)

- `eslint-plugin-no-secrets` — entropy threshold 4.5
- Route audit test stub exists — update exempt list
- Integration tests required for DoD

---

### Git Intelligence

Recent commits (2026-06-24):

```
d8e82e1 feat(setup): improvement to database foundation
b97e481 feat(setup): 1-4 database foundation with postgresql rls and core schema
```

Story 1.5 file exists (`ready-for-dev`) but crypto/vault code may still be stubbed on branch — **verify Story 1.5 implementation status before starting**. If `packages/crypto/src/passwords.ts` missing, implement Task 2 first or complete Story 1.5.

Patterns established:
- Manual SQL migrations alongside Drizzle (`0001_rls_and_triggers.sql` pattern)
- `vault_app` DB role in all environments
- Test helpers in `packages/db/src/test-helpers.ts`

---

### Latest Technical Notes

**@fastify/jwt v9** (already in `apps/api/package.json`): Use `fastify.jwt.sign()` / `verify()` with `{ algorithm: 'HS256' }` only.

**argon2 npm package:** Use `argon2.hash` / `argon2.verify` — PHC string format stores params. Compatible with Story 1.5 `raw: true` for master KDF but user passwords use encoded string format.

**Zod v4:** Project uses `zod/v4` import path — `z.email()`, `z.uuid()`, `z.iso.datetime()`.

**@fastify/cookie:** Register before JWT plugin when using cookie integration.

---

### Accepted Security Risks (v1)

| Risk | Mitigation | Owner |
|---|---|---|
| Register returns `409 email_taken` (enumeration) | Set `AUTH_REGISTRATION_ENABLED=false` for invite-only prod | Story 1.6 |
| No CSRF token on refresh endpoint | `SameSite=Strict` + CORS allowlist (no wildcard) | Architecture |
| `users` table has no RLS — email readable via compromised query path | Restrict email lookups to `modules/auth/` only; future column-level security | Epic 4+ |
| Minimal audit HMAC (not full tamper chain) | Story 8.1 completes chain verification | Story 8.1 |
| `__Host-` cookie prefix not required | Document; evaluate in Story 1.7 | Story 1.7 |
| `failed_auth_attempts` table + threshold alerts | Story 1.9 | Story 1.9 |
| Distributed credential stuffing (cross-IP) | Rate limit per IP only | Story 1.9 |
| Unlimited sessions per user (password stolen) | Document; `MAX_SESSIONS_PER_USER` in 1.7 | Story 1.7 (AC-36) |

---

### Red Team Manual QA Checklist (Story 1.6)

```bash
# POST-only (AC-34)
curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/v1/auth/login
# → 405

# Homograph rejection (AC-32) — Cyrillic 'а' in admin
curl -s -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"аdmin@test.com","password":"twelve-characters","orgName":"Test"}'
# → 422

# trustProxy off — rate limit uses socket IP (AC-35)
# Send X-Forwarded-For with TRUST_PROXY=false; verify 429 still keyed to real connection IP in test
```

---

### Out of Scope (Explicit)

| Item | Owner story |
|---|---|
| JWT auth middleware on protected routes | Story 1.11 SecureRoute |
| Session list / revoke / idle timeout | Story 1.7 |
| MFA enrollment / login | Story 1.8, 1.12 |
| SvelteKit login UI + silent refresh hooks | Architecture step 7 |
| Full audit HMAC chain / tamper verification | Story 8.1 |
| `session:cleanup` pg-boss worker | Story 1.7 / 1.10 |
| Multi-org login selection | Epic 4 |
| Email verification / invite-only registration | Future |

---

### Anti-Patterns (Do Not)

- Import `argon2` in `apps/api` — use `@project-vault/crypto`
- Return `accessToken` in JSON response body for browser clients
- Use RS256 or store JWT keys in `vault_state`
- Use Argon2id for refresh token hashing — use HMAC-SHA256
- Log `req.body.password` on validation errors
- Skip dummy hash on unknown-email login (timing oracle)
- Query `refresh_tokens` from modules other than auth
- Hardcode audit event type strings — use `AuditEvent.*`
- Use `{ error: '...' }` response shape — use `{ code: '...' }`
- Bare `db.insert()` for org-scoped post-auth writes outside `withOrg()`
- Compare refresh token hashes with `===` — use `timingSafeEqual` via `refreshTokensMatch()`
- Refresh rotation without `SELECT FOR UPDATE` — allows duplicate session rows under concurrency
- Skip `clearCookie` before login cookie set — session fixation risk
- Run Argon2 before body size validation — Argon2 DoS vector
- Set cookies inside service before transaction commit — orphan session state (AC-27)
- Return 500 on failed login when audit write fails — must stay 401 (AC-30)
- Let unique constraint violations on register bubble as 500 — map to 409 (AC-25)
- Allow login for `deactivated` memberships — check `status = 'active'` (AC-26)
- Enable `TRUST_PROXY=true` on directly exposed API — rate-limit bypass via spoofed X-Forwarded-For (AC-35)
- Register GET/HEAD handlers on auth routes — cookie leakage risk (AC-34)
- Skip dummy Argon2 on register 409 path — timing oracle (AC-31)
- Accept non-ASCII emails without NFKC + ASCII check — homograph phishing (AC-32)
- Relax JWT `verify.algorithms` to include `none` or RS256 (AC-33)

---

### References

- Story epics AC: [_bmad-output/planning-artifacts/epics.md#Story-1.6-User-Registration--Password-Authentication_]
- FR53: [_bmad-output/planning-artifacts/prd.md#FR53_]
- JWT + cookies + refresh: [_bmad-output/planning-artifacts/architecture.md#Authentication--Security_]
- Token hashing: [_bmad-output/planning-artifacts/architecture.md — Token Hashing vs Password Hashing_]
- Sessions + refresh_tokens schema: [_bmad-output/planning-artifacts/architecture.md#Canonical-Schema-Entity-Names_]
- RS256 conflict resolution: [_bmad-output/implementation-artifacts/1-5-vault-initialization-and-master-key-management.md#RS256-vs-HMAC-SHA256-Conflict_]
- refresh_tokens deferred from 1.4: [_bmad-output/implementation-artifacts/1-4-database-foundation-with-postgresql-rls-and-core-schema.md#Sessions-Schema_]
- Audit transaction invariant: [_bmad-output/implementation-artifacts/1-4-database-foundation-with-postgresql-rls-and-core-schema.md#Audit-Completeness-Invariant_]
- ApiError schema: [packages/shared/src/schemas/api.ts]
- Existing sessions schema: [packages/db/src/schema/sessions.ts]
- Vault guard allowlist pattern: [_bmad-output/implementation-artifacts/1-5-vault-initialization-and-master-key-management.md#AC-17_]

---

## Dev Agent Record

### Agent Model Used

GPT-5.5

### Debug Log References
- 2026-06-26: `pnpm --filter @project-vault/db test -- --runInBand` confirmed new Task 1 red test failed before implementation; same run also showed unrelated pre-existing local DB RLS/permission expectation failures.
- 2026-06-26: `pnpm --filter @project-vault/db exec vitest run src/schema/auth-sessions-schema.test.ts` passed after Task 1 implementation.
- 2026-06-26: `pnpm --filter @project-vault/db db:migrate` passed twice, covering migration application and idempotency.
- 2026-06-26: `pnpm --filter @project-vault/crypto exec vitest run src/passwords.test.ts` failed before Task 2 implementation on missing helper exports, then passed after implementation.
- 2026-06-26: `pnpm --filter @project-vault/crypto test` passed.
- 2026-06-26: `pnpm --filter @project-vault/api exec vitest run src/config/env.test.ts` failed before Task 3 implementation on missing auth env defaults/validation, then passed after implementation.
- 2026-06-26: `pnpm exec tsx scripts/check-env-example.ts` passed.
- 2026-06-26: `pnpm --filter @project-vault/api test` failed without `DATABASE_URL`; rerun with `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault` passed.
- 2026-06-26: `pnpm --filter @project-vault/shared exec vitest run src/constants/audit-events.test.ts` and `pnpm --filter @project-vault/api exec vitest run src/modules/audit/write-entry.test.ts` failed before Task 4 implementation, then passed after implementation.
- 2026-06-26: `pnpm --filter @project-vault/shared test` passed.
- 2026-06-26: `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api test` passed after Task 4 implementation.
- 2026-06-26: `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api exec vitest run src/modules/auth/normalize.test.ts`, `tokens.test.ts`, and `service.test.ts` failed before each Task 5 helper existed, then passed after implementation.
- 2026-06-26: `pnpm --filter @project-vault/crypto build`, `pnpm --filter @project-vault/db build`, and `pnpm --filter @project-vault/shared build` refreshed workspace package outputs for API typecheck.
- 2026-06-26: `pnpm --filter @project-vault/api typecheck` passed after Task 5 implementation.
- 2026-06-26: `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api test` passed after Task 5 implementation.
- 2026-06-26: `pnpm --filter @project-vault/api add @fastify/cookie` added the Story 1.6 cookie dependency.
- 2026-06-26: `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api exec vitest run src/modules/auth/routes.test.ts` failed before Task 6 implementation with 404, then passed with POST-only 405 handling.
- 2026-06-26: `pnpm --filter @project-vault/api typecheck` passed after Task 6 implementation.
- 2026-06-26: `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api test` passed after Task 6 implementation.
- 2026-06-26: `pnpm --filter @project-vault/shared exec vitest run src/schemas/auth.test.ts` failed before Task 7 implementation, then passed after shared auth schemas were added.
- 2026-06-26: `pnpm --filter @project-vault/shared test && pnpm --filter @project-vault/shared build` passed.
- 2026-06-26: `pnpm --filter @project-vault/api generate-spec && pnpm --filter @project-vault/api typecheck && DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api test` passed.
- 2026-06-26: `pnpm --filter @project-vault/api typecheck && DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api test` passed after Task 8 redaction/route-audit updates.
- 2026-06-26: `pnpm turbo lint` passed after lint cleanup; remaining output is warnings from existing security rules.
- 2026-06-26: `pnpm turbo typecheck` passed.
- 2026-06-26: `pnpm --filter @project-vault/crypto test`, `pnpm --filter @project-vault/shared test`, `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/db test`, and `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api test` passed.
- 2026-06-26: `pnpm turbo build` passed.
- 2026-06-26: Applied review patch batch. `DATABASE_URL=postgresql://postgres:password@localhost:5432/project_vault pnpm --filter @project-vault/db db:migrate` applied `0005_auth_bootstrap_audit_policy`.
- 2026-06-26: `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api exec vitest run src/plugins/vault-guard.test.ts src/modules/auth/tokens.test.ts src/config/env.test.ts src/__tests__/auth.integration.test.ts src/modules/auth/routes.test.ts src/modules/auth/service.test.ts` passed after review patches.
- 2026-06-26: `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api test` passed after review patches.
- 2026-06-26: `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/db test` passed after tightening RLS coverage checks for bootstrap insert policies.
- 2026-06-26: `pnpm --filter @project-vault/api typecheck && pnpm --filter @project-vault/db typecheck && pnpm turbo lint` passed; lint output contains existing warnings only.
- 2026-06-26: `DATABASE_URL=postgresql://postgres:password@localhost:5432/project_vault pnpm --filter @project-vault/db db:migrate` applied `0006_platform_security_events`.
- 2026-06-26: `pnpm --filter @project-vault/db build && DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api exec vitest run src/modules/auth/service-platform-events.test.ts src/modules/auth/service.test.ts` passed.
- 2026-06-26: `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/db test` and `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api test` passed after platform security event implementation.
- 2026-06-26: `pnpm --filter @project-vault/db build && pnpm --filter @project-vault/api typecheck && pnpm --filter @project-vault/db typecheck && pnpm turbo lint` passed; lint output contains existing warnings only.

### Completion Notes List
- Task 1 complete: added Story 1.6 session columns, `refresh_tokens` schema/migration, RLS coverage exception, and focused schema coverage.
- Task 2 complete: added Argon2id PHC user-password hash/verify helpers in `@project-vault/crypto`, exported their config type/API, and covered matching/non-matching password verification.
- Task 3 complete: added auth startup env defaults and production hardening, including dummy PHC shape validation, separated secrets, Argon2 memory cap, registration/cookie/proxy controls, and `.env.example` coverage.
- Task 4 complete: added auth audit event constants and deterministic sorted-key HMAC helper for audit log rows.
- Task 5 complete: added auth service registration/login/refresh flows, email normalization, password wrapper, refresh token HMAC helpers, cookie helpers, slug generation, and focused auth helper tests.
- Task 6 complete: registered cookie/JWT/rate-limit infrastructure, mounted POST-only auth routes, enabled CORS credentials and restricted trust proxy, updated vault guard allowlist, and added route coverage.
- Task 7 complete: added shared auth Zod contracts, re-exported them through the shared package, wired API auth schemas to shared contracts, and regenerated `openapi.json` with auth paths.
- Task 8 complete: added/updated auth helper, route, audit HMAC, log redaction, and route-audit tests; API regression suite passes with the expected `vault_app` database URL.
- Task 9 complete: documented auth env variables, cookie/proxy settings, curl registration/login/refresh examples, and secret rotation effects in README.
- Final DoD complete: all story tasks/subtasks checked, focused tests and package suites pass, lint/typecheck/build pass, File List updated, and story status moved to review.
- Review patch batch complete: added bootstrap audit insert policy, sealed-vault auth guard enforcement, no-refresh-cookie grace retry behavior, parent-session revocation rejection, stricter dummy hash/cookie production validation, normalized email route validation, oversized refresh-cookie rejection, and focused integration coverage.
- Platform security event follow-up complete: unknown/orphan failed-login attempts now write keyed, no-raw-email telemetry to `platform_security_events` while known org subjects continue using org-scoped `audit_log_entries`.

### File List

**Expected new/modified files:**

| File | Action |
|---|---|
| `packages/db/src/schema/refresh-tokens.ts` | CREATE |
| `packages/db/src/schema/sessions.ts` | MODIFY |
| `packages/db/src/migrations/0003_auth_sessions_refresh.sql` | CREATE |
| `packages/db/src/check-rls-coverage.ts` | MODIFY |
| `packages/crypto/src/passwords.ts` | MODIFY |
| `packages/shared/src/schemas/auth.ts` | CREATE |
| `packages/shared/src/constants/audit-events.ts` | MODIFY |
| `apps/api/src/config/env.ts` | MODIFY |
| `apps/api/src/plugins/jwt.ts` | CREATE |
| `apps/api/src/modules/auth/routes.ts` | CREATE |
| `apps/api/src/modules/auth/service.ts` | CREATE |
| `apps/api/src/modules/auth/tokens.ts` | CREATE |
| `apps/api/src/modules/auth/schema.ts` | CREATE |
| `apps/api/src/modules/auth/password.ts` | CREATE |
| `apps/api/src/modules/auth/normalize.ts` | CREATE — `normalizeEmail()` NFKC + ASCII (AC-32) |
| `apps/api/src/modules/auth/tokens.test.ts` | CREATE |
| `apps/api/src/modules/audit/write-entry.ts` | CREATE |
| `apps/api/src/modules/audit/write-entry.test.ts` | CREATE |
| `apps/api/src/app.ts` | MODIFY |
| `apps/api/src/plugins/vault-guard.ts` | MODIFY |
| `apps/api/src/__tests__/auth.integration.test.ts` | CREATE |
| `apps/api/src/__tests__/auth-log-redaction.test.ts` | CREATE |
| `apps/api/src/__tests__/route-audit.test.ts` | MODIFY |
| `apps/api/package.json` | MODIFY — add `@fastify/cookie` |
| `.env.example` | MODIFY |
| `packages/shared/openapi.json` | MODIFY — via generate-spec |

**Actual files changed:**

- `packages/db/src/schema/auth-sessions-schema.test.ts`
- `packages/db/src/schema/refresh-tokens.ts`
- `packages/db/src/schema/platform-security-events.ts`
- `packages/db/src/schema/sessions.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/check-rls-coverage.ts`
- `packages/db/src/migrations/0004_auth_sessions_refresh.sql`
- `packages/db/src/migrations/0005_auth_bootstrap_audit_policy.sql`
- `packages/db/src/migrations/0006_platform_security_events.sql`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/crypto/src/passwords.ts`
- `packages/crypto/src/passwords.test.ts`
- `packages/crypto/src/index.ts`
- `apps/api/src/config/env.ts`
- `apps/api/src/config/env.test.ts`
- `apps/api/src/__tests__/auth.integration.test.ts`
- `apps/api/src/modules/audit/write-entry.ts`
- `apps/api/src/modules/audit/write-entry.test.ts`
- `apps/api/src/modules/auth/normalize.ts`
- `apps/api/src/modules/auth/normalize.test.ts`
- `apps/api/src/modules/auth/password.ts`
- `apps/api/src/modules/auth/service.ts`
- `apps/api/src/modules/auth/service-platform-events.test.ts`
- `apps/api/src/modules/auth/service.test.ts`
- `apps/api/src/modules/auth/routes.ts`
- `apps/api/src/modules/auth/routes.test.ts`
- `apps/api/src/modules/auth/schema.ts`
- `apps/api/src/modules/auth/tokens.ts`
- `apps/api/src/modules/auth/tokens.test.ts`
- `apps/api/src/plugins/jwt.ts`
- `apps/api/src/plugins/vault-guard.ts`
- `apps/api/src/plugins/vault-guard.test.ts`
- `apps/api/src/app.ts`
- `apps/api/package.json`
- `pnpm-lock.yaml`
- `packages/shared/src/constants/audit-events.ts`
- `packages/shared/src/constants/audit-events.test.ts`
- `packages/shared/src/schemas/auth.ts`
- `packages/shared/src/schemas/auth.test.ts`
- `packages/shared/src/index.ts`
- `packages/shared/openapi.json`
- `apps/api/src/scripts/generate-spec.ts`
- `apps/api/src/__tests__/auth-log-redaction.test.ts`
- `apps/api/src/__tests__/route-audit.test.ts`
- `apps/api/src/plugins/redact-secrets.ts`
- `README.md`
- `.env.example`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/1-6-user-registration-and-password-authentication.md`

---

*Ultimate context engine analysis completed — comprehensive developer guide created.*
