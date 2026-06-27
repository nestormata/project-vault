# Story 1.12: MFA Login Verification Flow

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-06-27 — comprehensive developer guide for the MFA second-factor login step (FR55/FR57 hard login gate). Adds `pending_mfa_sessions` table, two-step login (`POST /auth/login` → `mfaRequired` challenge; `POST /auth/mfa/verify-login` → full session), hourly pg-boss cleanup, failed-auth threshold integration (Story 1.9 deferred wiring), brute-force attempt capping, and TOTP replay protection reuse. Architecture conflict resolution (boolean `mfa_enrolled` → `mfa_enrolled_at`, cookie session vs raw JWT body), Red Team hardening, and ADRs applied. -->

## Story

As a user who has enrolled MFA,
I want the login flow to require my TOTP code as a second step before issuing a full access token,
so that my enrolled MFA actually protects my account — not just my ability to invite others.

*Covers: FR55 (MFA second-factor at login), completes FR57 hard login gate deferred from Story 1.9 (ADR-1.9-05).* [Source: _bmad-output/planning-artifacts/epics.md#Story-1.12-MFA-Login-Verification-Flow]

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 1.6 complete — register / `loginUser()` / cookie session issuance | `verify-login` reuses `createLoginSessionInTx()` and the `sendAuthSession()` cookie pattern; login branch is added inside `loginUser()` |
| Story 1.7 complete — `setAuthCookies()`/`clearAuthCookies()`, `BossService` via `setOnVaultUnsealed` | Full session issued via existing cookie helpers; hourly cleanup job registers after unseal |
| Story 1.8 complete — `mfa_enrollments` (confirmed secret), `validateTotpCode()`, `recordTotpUse()` replay protection, `users.mfa_enrolled_at` | TOTP verification at login decrypts the **confirmed** enrollment secret and reuses the replay table |
| Story 1.9 complete — `recordFailedAuthAttempt()` exported recorder + `invalid_totp` reason + threshold worker | Invalid TOTP at login records a `failed_auth_attempts` row (1.9 explicitly deferred this wiring to 1.12) |
| Story 1.4 complete — `organizations`, `org_memberships`, RLS, `audit_log_entries` | `pending_mfa_sessions.org_id` FK; session-created audit entry |
| Real PostgreSQL in integration tests | No DB mocks for the login/verify-login flow or cleanup job |

### Epic Cross-Story Context

| Story | Relationship to 1.12 |
|---|---|
| 1.6 | `loginUser()` is **modified** to branch on `users.mfa_enrolled_at`; non-MFA path is unchanged. `verify-login` reuses `createLoginSessionInTx()` |
| 1.8 | Reuses confirmed-enrollment secret decrypt + `validateTotpCode()` + `recordTotpUse()`. Same TOTP semantics (6 digits, 30s, window ±1, replay-protected) |
| 1.9 | Consumes the **exported** `recordFailedAuthAttempt({ reason: 'invalid_totp' })`. Brute-forcing TOTP via repeated `verify-login` feeds the same IP/account threshold detection. Replayed codes do **not** count (Story 1.9 review fix) |
| 1.10 | Structured logging — add `verify-login` events to the redaction review list; never log `mfaToken`, `totp`, or `secret` |
| 1.11 | SecureRoute / `no-raw-fastify-route` ESLint rule (ready-for-dev, not merged). Public auth routes (`/login`, `/register`, `/refresh`, `/mfa/recover`, and new `/mfa/verify-login`) follow the **existing raw-fastify pattern** in `auth/routes.ts`; 1.11 must add them to its raw-route exemption allowlist — coordinate, do not refactor auth routes in this story |
| 2.0 | MVP frontend shell consumes the `mfaRequired` login response + verify-login step (Epics Story 2.0 AC explicitly gates its MFA login UI on Story 1.12). Keep the response shape stable |

---

## Architecture Conflict Resolution (Read Before Coding)

| Source wording | Canonical implementation | Rationale |
|---|---|---|
| Epics: `users.mfa_enrolled = true` | `users.mfa_enrolled_at IS NOT NULL` | No boolean column exists; Story 1.8 canonical column is `mfa_enrolled_at TIMESTAMPTZ` |
| Epics: `200 { mfaRequired: true, mfaToken }` (top-level) | `200 { data: { mfaRequired: true, mfaToken } }` | Story 1.6+ envelopes all success bodies in `{ data: ... }` |
| Epics: "issue full JWT + refresh token (same response shape as Story 1.6)" | Set `access-token` + `refresh-token` **HttpOnly cookies** via `setAuthCookies()`; body returns `{ data: { userId, orgId, expiresAt } }` | Story 1.6 issues tokens as HttpOnly cookies, **not** in the JSON body. "Same response shape" = the cookie+`AuthSessionResponse` shape, not raw tokens |
| Epics: `pending_mfa_sessions` "stored hashed" | HMAC-SHA256 of the opaque token (keyed by `MFA_PENDING_SESSION_HMAC_SECRET`); never store the raw token | Matches the refresh-token convention (`hashRefreshToken()`); keyed HMAC for high-entropy bearer tokens |
| Epics: `401 { code: "mfa_token_expired" }` | `401 { code: "mfa_token_expired", message }` | Story 1.6+ error shape is `{ code, message }` |
| Epics: `POST /auth/mfa/verify-login` invalid TOTP behavior unspecified for status | Invalid TOTP → `422 { code: "invalid_totp" }` (matches Story 1.8 `verify-enrollment`); expired/used/too-many-attempts token → `401 { code: "mfa_token_expired" }` | Distinguish "wrong code, retry allowed" (422) from "token dead, restart login" (401) |
| Epics: "single-use token" | Consume by **atomic delete-on-success** (`SELECT … FOR UPDATE` then delete in same tx); invalid TOTP keeps the row for retry until TTL/attempt cap | Single-use = cannot be reused after a successful verification |
| FR57 hard login gate (ADR-1.9-05 deferral) | Implemented here for **MFA-enrolled** users only; unenrolled owner/admin enforcement stays route-level via Story 1.9 `requireMfaEnrollment()` | This story gates login for users who **have** MFA; it does not force unenrolled users to enroll at login (that remains grace-period + route enforcement) |

---

## Acceptance Criteria

### AC Quick Reference

| Component | Trigger | Success | Key errors |
|---|---|---|---|
| `POST /auth/login` (MFA user) | valid email+password, `mfa_enrolled_at IS NOT NULL` | `200 { data: { mfaRequired: true, mfaToken } }`, **no** auth cookies | `401 invalid_credentials` (bad password) |
| `POST /auth/login` (non-MFA user) | valid email+password, `mfa_enrolled_at IS NULL` | `200 { data: { userId, orgId, expiresAt } }` + auth cookies (unchanged 1.6 flow) | `401 invalid_credentials` |
| `POST /auth/mfa/verify-login` | valid `mfaToken` + valid `totp` | `200 { data: { userId, orgId, expiresAt } }` + auth cookies; pending row deleted | — |
| `POST /auth/mfa/verify-login` | valid `mfaToken` + **invalid** `totp` | row kept, `attempt_count++` | `422 invalid_totp` |
| `POST /auth/mfa/verify-login` | expired / consumed / attempt-capped `mfaToken` | — | `401 mfa_token_expired` |
| pg-boss `mfa:prune-pending-mfa-sessions` | hourly | expired rows deleted | logs `job.completed` |

---

### AC-1: Module Structure & File Layout

**Given** the Stories 1.6–1.9 auth module exists,
**When** Story 1.12 is complete,
**Then** the following files are added/modified:

```
packages/db/src/schema/
├── pending-mfa-sessions.ts        # NEW: identity-scoped pending login table (no RLS)
└── index.ts                       # MODIFY: export * from './pending-mfa-sessions.js'

packages/db/src/migrations/
├── 0011_pending_mfa_sessions.sql  # NEW: sequential migration (verify _journal.json before naming)
└── meta/_journal.json             # MODIFY: append entry idx 11

packages/db/src/
└── check-rls-coverage.ts          # MODIFY: add 'pending_mfa_sessions' to EXCLUDED_TABLES

apps/api/src/modules/auth/
├── mfa-login.ts                   # NEW: createPendingMfaSession(), verifyLogin() service
├── tokens.ts                      # MODIFY: add generatePendingMfaToken() + hashPendingMfaToken()
├── service.ts                     # MODIFY: loginUser() branches on mfa_enrolled_at → returns LoginResult | MfaChallengeResult
├── totp.ts (or mfa.ts)            # MODIFY: export reusable verifyConfirmedTotp() for login (refactor from validateEnrollmentTotp)
├── routes.ts                      # MODIFY: /login branch; ADD POST /mfa/verify-login + method-not-allowed guard
└── schema.ts                      # MODIFY: add mfaLoginRequired + verify-login request/response schemas

apps/api/src/workers/
└── prune-pending-mfa-sessions.ts  # NEW: pg-boss hourly cleanup

apps/api/src/main.ts               # MODIFY: register 'mfa:prune-pending-mfa-sessions' schedule + worker

apps/api/src/config/env.ts         # MODIFY: add MFA_PENDING_SESSION_* + MFA_LOGIN_MAX_ATTEMPTS
.env.example                       # MODIFY: document new vars (keep check-env-example.ts in sync)

packages/shared/src/schemas/auth.ts # MODIFY (optional): export MfaVerifyLogin request/response types if shared with frontend

apps/api/src/__tests__/
├── mfa-login.integration.test.ts  # NEW: full two-step login flow (real DB)
└── route-audit.test.ts            # MODIFY: register the new public verify-login route in the audit map
```

**And** name the new module file `mfa-login.ts` (not folded into `mfa.ts`) — `mfa.ts` is already large (enrollment/recovery/regenerate); keep login-verification concerns isolated.

**And** **do not** create a new TOTP validator — reuse Story 1.8 `validateTotpCode()` + `recordTotpUse()`. Extract the confirmed-enrollment verification (currently private inside `mfa.ts`) into an exported helper rather than duplicating it.

---

### AC-2: Environment Variables

**Add to `apps/api/src/config/env.ts`** (follow the bounded-default + production-guard pattern already used for `TOTP_REPLAY_HMAC_SECRET` and `FAILED_AUTH_*`):

| Variable | Type | Default | Validation |
|---|---|---|---|
| `MFA_PENDING_SESSION_TTL_SECONDS` | number | `300` | int, min `60`, max `900` (5-min default per epic) |
| `MFA_LOGIN_MAX_ATTEMPTS` | number | `5` | int, min `1`, max `10` — invalid-TOTP attempts allowed per `mfaToken` before it is consumed |
| `MFA_PENDING_SESSION_HMAC_SECRET` | string (optional) | non-prod: dedicated dev constant; prod: **required** | Min 32 chars; in prod must be set, must differ from `REFRESH_TOKEN_HMAC_SECRET`, `SESSION_SECRET`, and `TOTP_REPLAY_HMAC_SECRET`; must not match `PLACEHOLDER_SECRET_PATTERN` |

**Production guards (mirror existing `assertProductionSecrets` block):**

- Reject startup in production when `MFA_PENDING_SESSION_HMAC_SECRET` is unset, a placeholder, or equal to another auth secret.
- Non-production: fall back to a dedicated dev constant (e.g. `DEV_MFA_PENDING_SESSION_HMAC_SECRET = 'd'.repeat(64)`) and emit the same one-time stderr warning style used for `TOTP_REPLAY_HMAC_SECRET`. **Do not** silently reuse `REFRESH_TOKEN_HMAC_SECRET` for hashing pending tokens.

**Cross-field guard:** `MFA_PENDING_SESSION_TTL_SECONDS` must be ≥ `(MFA_TOTP_WINDOW + 1) * MFA_TOTP_PERIOD_SECONDS` so a freshly issued token can always accept at least one full TOTP step (defensive; default 300 ≫ 60 satisfies this).

**`.env.example` snippet:**

```bash
# Story 1.12 — MFA login verification
MFA_PENDING_SESSION_TTL_SECONDS=300
MFA_LOGIN_MAX_ATTEMPTS=5
# Required in production; must differ from SESSION_SECRET / REFRESH_TOKEN_HMAC_SECRET / TOTP_REPLAY_HMAC_SECRET
MFA_PENDING_SESSION_HMAC_SECRET=
```

**And** update `scripts/check-env-example.ts` coverage and `apps/api/src/config/env.test.ts` (new fields + production guards + cross-field guard).

---

### AC-3: Database Migration — `pending_mfa_sessions`

**Given** Story 1.9 migration `0010_failed_auth_attempts` is the latest (verify `meta/_journal.json` — the next sequential tag is `0011`),
**When** `pnpm --filter @project-vault/db db:migrate` runs,
**Then** create `packages/db/src/migrations/0011_pending_mfa_sessions.sql`:

```sql
-- Migration 0011: Pending MFA login sessions
-- Story 1.12 stores short-lived, single-use tokens between the password step and
-- the TOTP verification step. Identity-scoped: org_id is stored for session
-- issuance but the table intentionally has NO RLS policy (created pre-session,
-- before any auth/org context exists). Stores HMAC token hashes only, never raw tokens.

CREATE TABLE IF NOT EXISTS pending_mfa_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ip_address    INET,
  user_agent    TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pending_mfa_sessions_expires_after_created_check
    CHECK (expires_at > created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_mfa_sessions_token_hash
  ON pending_mfa_sessions (token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pending_mfa_sessions_expires_at
  ON pending_mfa_sessions (expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pending_mfa_sessions_user_id
  ON pending_mfa_sessions (user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_mfa_sessions_user_org
  ON pending_mfa_sessions (user_id, org_id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON pending_mfa_sessions TO vault_app;
--> statement-breakpoint
COMMENT ON TABLE pending_mfa_sessions IS
  'Short-lived single-use MFA login challenge tokens. Stores HMAC hashes only. org_id present for session issuance but NO RLS by design (created before any session/org context exists).';
```

**And** append to `meta/_journal.json` (use a `when` timestamp greater than `0010`'s `1782540960000`, e.g. `1782544560000`):

```json
{
  "idx": 11,
  "version": "7",
  "when": 1782544560000,
  "tag": "0011_pending_mfa_sessions",
  "breakpoints": true
}
```

**RLS policy:** **None** — same class as `mfa_enrollments` / `totp_used_codes`. Access **only** via `createPendingMfaSession()`, `verifyLogin()`, the cleanup worker, and integration-test seed helpers. **No tenant-facing REST endpoint** reads or lists `pending_mfa_sessions`.

**Add `'pending_mfa_sessions'` to `EXCLUDED_TABLES`** in `packages/db/src/check-rls-coverage.ts` (the `org_id` column would otherwise trip the coverage check).

**Drizzle schema** — `packages/db/src/schema/pending-mfa-sessions.ts`:

```typescript
import { index, inet, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { organizations } from './organizations.js'

// Identity-scoped pending login table. org_id stored for session issuance; NO RLS by design.
export const pendingMfaSessions = pgTable(
  'pending_mfa_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('idx_pending_mfa_sessions_token_hash').on(t.tokenHash),
    expiresAtIdx: index('idx_pending_mfa_sessions_expires_at').on(t.expiresAt),
    userIdIdx: index('idx_pending_mfa_sessions_user_id').on(t.userId),
    userOrgIdx: uniqueIndex('idx_pending_mfa_sessions_user_org').on(t.userId, t.orgId),
  })
)

export type PendingMfaSession = typeof pendingMfaSessions.$inferSelect
export type NewPendingMfaSession = typeof pendingMfaSessions.$inferInsert
```

**And** extend `packages/db/src/schema/auth-sessions-schema.test.ts` with a Story 1.12 block asserting the columns exist and `EXCLUDED_TABLES.has('pending_mfa_sessions') === true`.

**And** add migration/schema coverage for the DB integrity checks:

- `token_hash` must be 64 lowercase hex characters (`^[0-9a-f]{64}$`, HMAC-SHA256 digest).
- `attempt_count` must never be negative.
- `expires_at` must be greater than `created_at`.
- `(user_id, org_id)` must be unique so each account/org has at most one live pending challenge at the database level.

---

### AC-4: Token Generation & Hashing

**Given** the `mfaToken` is an opaque bearer credential the client holds between the two login steps,
**When** it is created and looked up,
**Then** add to `apps/api/src/modules/auth/tokens.ts` (alongside the existing `generateRefreshToken()` / `hashRefreshToken()`):

```typescript
// 128-bit opaque token, base64url (matches epic "opaque 128-bit token")
export function generatePendingMfaToken(): string {
  return randomBytes(16).toString('base64url')
}

// Keyed HMAC-SHA256 — never store the raw token (same convention as hashRefreshToken)
export function hashPendingMfaToken(opaque: string): string {
  return createHmac('sha256', env.MFA_PENDING_SESSION_HMAC_SECRET)
    .update(opaque)
    .digest('hex')
}
```

**Invariants:**

- The raw `mfaToken` is returned **once** in the `POST /auth/login` response body and **never** stored, logged, or written to a cookie.
- Only `hashPendingMfaToken(mfaToken)` is stored in `pending_mfa_sessions.token_hash`.
- Lookups compute the hash and query by `token_hash` (unique index) — never scan-and-compare raw values.
- `MFA_PENDING_SESSION_HMAC_SECRET` is distinct from all other auth secrets (AC-2).

**Unit test (`tokens.test.ts`):** `generatePendingMfaToken()` returns a 22-char base64url string (16 bytes), is unique across calls; `hashPendingMfaToken()` is deterministic, 64-hex, and changes if the secret changes.

---

### AC-5: `POST /api/v1/auth/login` — MFA Branch

**Given** valid `{ email, password }` for a user whose `users.mfa_enrolled_at IS NOT NULL`,
**When** `POST /api/v1/auth/login` is called,
**Then** instead of issuing a session, return an MFA challenge:

```json
HTTP 200
{
  "data": {
    "mfaRequired": true,
    "mfaToken": "u8Jx2k4mQ1pZr7sV9aBcDe"
  }
}
```

- **No** `access-token` or `refresh-token` cookie is set on this response.
- The challenge response must call `clearAuthCookies(reply)` before sending `{ data: { mfaRequired, mfaToken } }`. This may emit clearing `Set-Cookie` headers, but must not set a usable `access-token` or `refresh-token`.
- Before inserting the challenge row, enforce latest-challenge-wins inside **one transaction**:
  1. Acquire a transaction-level advisory lock keyed on `(user_id, org_id)` (or use an equivalent serialized upsert strategy).
  2. Delete existing `pending_mfa_sessions` rows for that pair.
  3. Insert the new row.
  4. Commit, then return the raw token to the client.
  The DB unique index on `(user_id, org_id)` is the backstop; concurrent valid-password logins must not create two live pending rows.
- A `pending_mfa_sessions` row is created: `{ userId, orgId: <resolved active org>, tokenHash: hashPendingMfaToken(raw), attemptCount: 0, ipAddress, userAgent: meta.userAgent?.slice(0, 512) ?? null, expiresAt: <database NOW() + MFA_PENDING_SESSION_TTL_SECONDS> }`.
- `orgId` is the same active membership org `loginUser()` already resolves today (`activeMembership.orgId`).
- Compute `expires_at` with database time where possible (`NOW() + make_interval(secs => MFA_PENDING_SESSION_TTL_SECONDS)` or equivalent SQL through Drizzle) so multi-instance app clock skew cannot shorten or extend challenges unpredictably.
- If inserting `token_hash` hits the unique token-hash index, generate a new token and retry up to 2 times before failing with `503 service_unavailable`; never return the collided token to the client.

**Given** valid credentials for a user with `mfa_enrolled_at IS NULL`,
**When** `POST /auth/login` is called,
**Then** the **existing Story 1.6 flow is unchanged** — full session cookies set, body `{ data: { userId, orgId, expiresAt } }`.

**Given** invalid credentials (any user),
**Then** the existing uniform `401 invalid_credentials` + `recordFailedAuthAttempt({ reason: 'invalid_credentials' })` path is unchanged. The MFA branch is evaluated **only after** password + active-membership verification succeeds.

**Implementation shape (`service.ts`):**

```typescript
export type MfaChallengeResult = { mfaRequired: true; mfaToken: string }

export async function loginUser(
  input: LoginInput,
  meta: RequestMeta = {}
): Promise<LoginResult | MfaChallengeResult> {
  const email = normalizeLoginEmail(input.email, meta)
  const rows = await findLoginUser(email)
  const user = rows[0]
  const activeMembership = rows.find((row) => row.membershipStatus === 'active' && row.orgId)
  const valid = await verifyLoginPassword(input, user)

  if (!user || !valid || !activeMembership?.orgId) {
    void recordFailedAuthAttempt({ userId: user?.id ?? null, ipAddress: meta.ipAddress ?? '0.0.0.0', attemptedEmail: email, reason: 'invalid_credentials' })
    await recordLoginFailed(failedLoginAuditSubject(user, rows, activeMembership?.orgId), email, meta)
    throw invalidCredentials()
  }

  // NEW (1.12): users.mfa_enrolled_at — load it in findLoginUser() select or a focused query
  if (user.mfaEnrolledAt) {
    return createPendingMfaSession({ userId: user.id, orgId: activeMembership.orgId }, meta)
  }

  return createLoginSession(user, activeMembership.orgId, meta)
}
```

> **Note:** `findLoginUser()` does not currently select `users.mfa_enrolled_at`. Add it to that select (preferred — one round trip) rather than issuing a second query.

**Route handler (`routes.ts`, existing `/login` raw-fastify route):** branch on the return type — if `mfaRequired`, call `clearAuthCookies(reply as CookieReply)` and then `reply.send({ data: result })` with **no** session-setting cookie helpers; otherwise keep the current `sendAuthSession(fastify, reply, result)` call.

**Anti-pattern:** Do **not** issue the access/refresh cookies and *also* return `mfaRequired` — the whole point is that **no usable session exists** until TOTP is verified.

---

### AC-6: `POST /api/v1/auth/mfa/verify-login` — Complete Login

**Given** a client holding a valid `mfaToken` from AC-5,
**When** it calls:

```http
POST /api/v1/auth/mfa/verify-login
Content-Type: application/json

{ "mfaToken": "u8Jx2k4mQ1pZr7sV9aBcDe", "totp": "123456" }
```

**Then** the server, inside a single transaction:

1. Computes `hashPendingMfaToken(mfaToken)` and `SELECT … FOR UPDATE` the matching `pending_mfa_sessions` row (serializes concurrent attempts on the same token).
2. If **no row**, or `expires_at <= NOW()` using database time inside the transaction, or `attempt_count >= MFA_LOGIN_MAX_ATTEMPTS` → delete any matching row and return `401 { code: "mfa_token_expired" }`.
3. Loads the user's **confirmed** MFA enrollment secret and validates `totp` via the reused Story 1.8 verifier (`validateTotpCode()` + `recordTotpUse()` replay check):
   - **Valid & not replayed** → issue a full session via `createLoginSessionInTx()` (sets `access-token` + `refresh-token` cookies, body `{ data: { userId, orgId, expiresAt } }`) and delete the pending row in the same transaction. Identical shape to a non-MFA Story 1.6 login.
   - **Invalid code** → increment `attempt_count`, record `recordFailedAuthAttempt({ reason: 'invalid_totp' })`, and return `422 { code: "invalid_totp" }` while attempts remain. If the increment reaches `MFA_LOGIN_MAX_ATTEMPTS`, delete the pending row and return `401 { code: "mfa_token_expired" }` immediately on that same request.
   - **Replayed code** (valid TOTP already used per `totp_used_codes`) → increment `attempt_count` and return `422 { code: "invalid_totp" }` while attempts remain, but do **NOT** call `recordFailedAuthAttempt` (matches Story 1.9 review fix: replays don't feed the threshold counter). If the increment reaches `MFA_LOGIN_MAX_ATTEMPTS`, delete the pending row and return `401 { code: "mfa_token_expired" }` immediately.

**Success response:**

```json
HTTP 200
{ "data": { "userId": "…", "orgId": "…", "expiresAt": "2026-06-27T18:05:00.000Z" } }
```
plus `Set-Cookie: access-token=…; HttpOnly; SameSite=Strict; Path=/` and `Set-Cookie: refresh-token=…; HttpOnly; SameSite=Strict; Path=/api/v1/auth/refresh`.

**Error responses:**

| Condition | Status | Body |
|---|---|---|
| Token unknown / expired / consumed / attempt-capped | `401` | `{ "code": "mfa_token_expired", "message": "Your login session expired. Please sign in again." }` |
| Wrong or replayed TOTP (token still alive) | `422` | `{ "code": "invalid_totp", "message": "The authenticator code is incorrect." }` |
| Malformed body | `422` | `{ "code": "validation_error", "message": "Request validation failed", "details": { … } }` |
| Wrong HTTP method | `405` | `{ "code": "method_not_allowed", "message": "Method Not Allowed" }` (+ `Allow: POST`) |

**Atomicity (single-use guarantee):** the `SELECT … FOR UPDATE`, `createLoginSessionInTx()`, and pending-row delete must be in the same transaction so two concurrent `verify-login` calls with the same valid `mfaToken`+`totp` can issue **at most one** session. Delete the pending row only after the session insert, refresh-token insert, and session audit write succeed inside that transaction. If session creation fails, the transaction rolls back and the pending row remains until TTL or attempt cap. The second concurrent request waits on the row lock, finds it deleted after the successful transaction commits, and returns `401 mfa_token_expired`.

**Edge case — user disabled enrollment between steps:** if the confirmed enrollment is missing at verify time (e.g., row deleted), treat as `401 mfa_token_expired` (cannot complete; restart login). Do not 500.

**Service signature (`mfa-login.ts`):**

```typescript
export async function createPendingMfaSession(
  user: { userId: string; orgId: string },
  meta: RequestMeta
): Promise<MfaChallengeResult>

export async function verifyLogin(
  input: { mfaToken: string; totp: string },
  meta: RequestMeta
): Promise<LoginResult>   // throws AppError('mfa_token_expired', …, 401) or AppError('invalid_totp', …, 422)
```

---

### AC-7: Route Registration & Request Schema

**Given** auth routes use the existing raw-fastify pattern (`/login`, `/register`, `/refresh`, `/mfa/recover`),
**When** Story 1.12 registers `POST /mfa/verify-login`,
**Then** in `apps/api/src/modules/auth/routes.ts`:

- Add `registerMethodNotAllowed(fastify, '/mfa/verify-login')` alongside the existing guards.
- Register the route as a raw `fastify.route({ method: 'POST', url: '/mfa/verify-login', bodyLimit: 4096, … })` — **public/unauthenticated** (the user has no session yet). It is naturally MFA-exempt (no `requireOrgRole`/`requireMfaEnrollment`).
- Apply rate limiting consistent with the auth plugin: the plugin already registers `@fastify/rate-limit` (60/min/IP). Add a **tighter per-route** cap to blunt TOTP brute force, e.g. `config: { rateLimit: { max: 20, timeWindow: '1 minute' } }` keyed by IP. Document the chosen value.
- The authoritative brute-force control is the DB-backed `attempt_count` on the pending session; do **not** rely on route rate limiting alone. If customizing the Fastify rate-limit `keyGenerator`, use a composite of `req.ip + ':' + hashPendingMfaToken(body.mfaToken)` when the body parses, and fall back to IP-only for malformed requests. This keeps the IP limit as a broad shield while avoiding accidental dependence on NAT-sensitive IP-only throttling.

**Request schema (`schema.ts`):**

```typescript
export const mfaVerifyLoginBodySchema = z.object({
  mfaToken: z.string().min(16).max(64),
  totp: z.string().regex(/^\s*\d(?:\s*\d){5}\s*$/, 'TOTP must be exactly 6 digits'),
})

export const mfaLoginRequiredResponseSchema = z.object({
  data: z.object({
    mfaRequired: z.literal(true),
    mfaToken: z.string(),
  }),
})

// verify-login success reuses the existing AuthSessionResponse shape:
export const mfaVerifyLoginResponseSchema = z.object({
  data: z.object({
    userId: z.uuid(),
    orgId: z.uuid(),
    expiresAt: z.iso.datetime(),
  }),
})
```

**And** the `/login` route response schema (if declared) must accept the **union** of the existing session shape and `mfaLoginRequiredResponseSchema`.

**And** normalize/validate the `totp` exactly as Story 1.8 does (strip whitespace before validation; reuse the same regex). Reject malformed bodies with `422 validation_error` via the existing `validationError()` helper.

**And** update `apps/api/src/__tests__/route-audit.test.ts` to include `POST /api/v1/auth/mfa/verify-login` in its known-route map as a public, unauthenticated, MFA-exempt route (so the audit does not flag it as an unguarded privileged route, and so a future accidental auth/role requirement is caught).

---

### AC-8: TOTP Verification Reuse (No Duplication)

**Given** Story 1.8 already verifies confirmed-enrollment TOTP inside `mfa.ts` (`loadConfirmedEnrollmentForUpdate()` + `validateEnrollmentTotp()` + `recordTotpUse()`),
**When** `verify-login` validates the second factor,
**Then** reuse that logic — **do not** re-implement TOTP validation or replay protection.

Extract the confirmed-secret verification into an exported helper (refactor, keep behavior identical):

```typescript
// apps/api/src/modules/auth/mfa-login.ts (or exported from mfa.ts)
// Returns 'valid' | 'invalid_code' | 'replayed_code' — same 3-way result as validateEnrollmentTotp
export async function verifyConfirmedLoginTotp(
  tx: Tx,
  userId: string,
  totp: string
): Promise<'valid' | 'invalid_code' | 'replayed_code' | 'no_enrollment'>
```

- Loads the **confirmed** enrollment (`status = 'confirmed'`) for `userId` (reuse `loadConfirmedEnrollmentForUpdate`).
- Returns `'no_enrollment'` when none exists → caller maps to `401 mfa_token_expired` (AC-6 edge case).
- Decrypts the secret with `decryptEnrollmentSecret()`, validates via `validateTotpCode()`, records replay via `recordTotpUse()`; zero the plaintext buffer in `finally`.
- TOTP window/period/digits come from `env.MFA_TOTP_*` (window ±1, 30s, 6 digits) — identical to enrollment verification.

**Invariants:**

- Replay protection: a valid TOTP code is single-use across **all** flows (enrollment, regenerate, **and** login) because `totp_used_codes` is keyed on `(user_id, code_hash)` — a code accepted at login cannot be replayed at verify-login or vice versa.
- Never log the decrypted secret, the `totp`, or the `mfaToken`.

---

### AC-9: Failed-Auth Threshold Integration (Story 1.9 Deferred Wiring)

**Given** Story 1.9 exported `recordFailedAuthAttempt()` and explicitly deferred the `verify-login` wiring to 1.12 (Story 1.9 AC-8: *"`POST /auth/mfa/verify-login` invalid TOTP → `invalid_totp` — export function now, 1.12 imports"*),
**When** an invalid (non-replayed) TOTP is submitted to `verify-login`,
**Then** call:

```typescript
void recordFailedAuthAttempt({
  userId,                         // known — from the pending session row
  ipAddress: meta.ipAddress ?? '0.0.0.0',
  attemptedEmail,                 // resolve from users table for the userId (NFKC-normalized)
  reason: 'invalid_totp',
})
```

**Behavior:**

- Fire-and-forget (`void`) — a recording failure **never** changes the HTTP response (matches Story 1.9 AC-16 fix making all call sites fire-and-forget).
- Brute-forcing TOTP via repeated `verify-login` therefore feeds the **same** per-IP and per-account threshold detection as password failures (Story 1.9 worker `security:check-failed-auth-threshold`). No new worker is required.
- **Replayed** codes do **not** record a failed attempt (consistent with Story 1.9; a replay is not a guess).
- The `MFA_LOGIN_MAX_ATTEMPTS` per-token cap (AC-6) is the **local** brute-force defense; the threshold worker is the **global** cross-attempt defense. Both apply.

**Integration test:** N invalid TOTP submissions across fresh logins from one IP push that IP over `FAILED_AUTH_THRESHOLD_COUNT` → `security:check-failed-auth-threshold` creates a `PENDING_DELIVERY` alert (assert via the Story 1.9 path).

---

### AC-10: Cleanup Job — `mfa:prune-pending-mfa-sessions`

**Given** expired/abandoned pending login sessions accumulate,
**When** the hourly pg-boss job runs,
**Then** delete expired rows (mirror `prune-totp-used-codes.ts` / `prune-mfa-pending.ts` exactly):

```typescript
// apps/api/src/workers/prune-pending-mfa-sessions.ts
import { gte, lt, or, sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { pendingMfaSessions } from '@project-vault/db/schema'
import { env } from '../config/env.js'
import { runPruneJob, type WorkerLogger } from './prune-utils.js'

export async function prunePendingMfaSessions(logger?: WorkerLogger): Promise<void> {
  await runPruneJob(
    'mfa:prune-pending-mfa-sessions',
    () =>
      getDb()
        .delete(pendingMfaSessions)
        .where(
          or(
            lt(pendingMfaSessions.expiresAt, sql`NOW()`),
            gte(pendingMfaSessions.attemptCount, env.MFA_LOGIN_MAX_ATTEMPTS)
          )
        ),
    logger
  )
}
```

**Wire into `apps/api/src/main.ts`** inside `startBossAndRegisterWorkers()` (the `setOnVaultUnsealed` callback):

```typescript
await boss.registerSchedules({
  // … existing …
  'mfa:prune-pending-mfa-sessions': { cron: '0 * * * *' }, // hourly at :00 UTC
})
await boss.registerWorkers({
  // … existing …
  'mfa:prune-pending-mfa-sessions': () => prunePendingMfaSessions(),
})
```

**Note:** the cleanup job is a backstop for storage hygiene only — correctness does **not** depend on it. `verify-login` already treats `expires_at <= NOW()` or `attempt_count >= MFA_LOGIN_MAX_ATTEMPTS` rows as `401 mfa_token_expired` regardless of whether they've been pruned (AC-6 step 2). Deleting capped rows as well as expired rows protects against crash/future-bug leftovers where a capped token was not immediately deleted.

**Integration/unit test:** seed a row with `expires_at = now() - 1 minute`, a capped row with `attempt_count = MFA_LOGIN_MAX_ATTEMPTS`, and one live uncapped row with `now() + 5 minutes` → after `prunePendingMfaSessions()`, only the live uncapped row remains; job logs `{ eventType: 'job.completed', jobName: 'mfa:prune-pending-mfa-sessions', deletedCount: 2 }`.

---

### AC-11: Audit Trail

**Given** the existing auth flows write org-scoped `audit_log_entries` (e.g. `SESSION_CREATED`, `LOGIN_FAILED`),
**When** the MFA login flow runs,
**Then** add one audit event constant to `packages/shared/src/constants/audit-events.ts` and emit it only after TOTP success:

```typescript
export const AuditEvent = {
  // … existing …
  MFA_LOGIN_VERIFIED: 'MFA_LOGIN_VERIFIED',     // TOTP verified, full session issued
} as const
```

| Event | When | Payload (no PII) |
|---|---|---|
| `MFA_LOGIN_VERIFIED` | `verifyLogin()` issues the session (in addition to the existing `SESSION_CREATED` from `createLoginSessionInTx`) | `{ method: 'totp' }` |
| `LOGIN_FAILED` (existing) | invalid TOTP at verify-login | `{ method: 'totp_login' }` |

**Rules:**

- Write via the existing `insertAuditEntry`/`writeAuditEntry` helpers using the resolved `orgId` and the user's identity token id (`actorTokenIdForUser()` / the `userIdentityTokens` join already used in `service.ts`).
- **Never** include `email`, `mfaToken`, `totp`, IP-as-identity, or the TOTP secret in audit payloads.
- Do **not** write `MFA_LOGIN_CHALLENGED` to `audit_log_entries` by default. Challenge issuance is pre-session and can be high-volume; emit a redacted structured operational log instead, e.g. `{ eventType: 'auth.mfa_login_challenged', userId, orgId, method: 'totp' }`, with no token, token hash, email, TOTP, or secret.
- Emit redacted structured operational logs for lifecycle outcomes:
  - `auth.mfa_login_challenged`
  - `auth.mfa_login_verified`
  - `auth.mfa_login_failed` with `reason` limited to `expired_token`, `invalid_totp`, `replayed_totp`, `attempt_capped`, `missing_enrollment`, or `session_create_failed`
- Lifecycle logs may include `userId`, `orgId`, `method: 'totp'`, and failure `reason`; they must not include `mfaToken`, `tokenHash`, `totp`, decrypted TOTP secret, or email.
- Audit writes are best-effort for the failure path (wrap like `tryWriteFailedRecoverAudit`) — never fail the HTTP response because an audit insert failed.
- Update `packages/shared/src/constants/audit-events.test.ts` for the new constants.

---

### AC-12: Integration Tests (Real DB)

**File:** `apps/api/src/__tests__/mfa-login.integration.test.ts` (pattern: `describe.sequential`, real PostgreSQL, `ensureVaultUnsealed`, helpers from `auth-test-helpers.ts`).

**Helper — enroll MFA and capture the confirmed secret so tests can compute live TOTP codes:**

```typescript
import * as OTPAuth from 'otpauth'
// 1) register + login (cookies)  2) POST /mfa/enroll → { secret }  3) POST /mfa/verify-enrollment with current code
// Keep the base32 `secret` to generate codes during login tests:
function totpNow(secretBase32: string, atMs = Date.now()): string {
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secretBase32) })
  return totp.generate({ timestamp: atMs })
}
```

**Scenarios (must all be covered):**

```typescript
describe.sequential('Story 1.12 — MFA login verification', () => {
  describe('login MFA branch', () => {
    it('MFA-enrolled login returns { mfaRequired: true, mfaToken } and sets NO auth cookies', ...)
    it('MFA-enrolled login clears any pre-existing auth cookies before returning the challenge', ...)
    it('non-MFA user login still returns full session + cookies (1.6 unchanged)', ...)
    it('invalid password for MFA user returns 401 invalid_credentials (no mfaToken leaked)', ...)
    it('creates exactly one pending_mfa_sessions row per MFA login', ...)
    it('creating a second MFA challenge deletes the first pending row and invalidates the first mfaToken', ...)
    it('concurrent MFA challenges for the same user/org leave exactly one pending row (latest challenge wins)', ...)
    it('token_hash unique collision retries token generation and never returns the collided token', ...)
    it('pending row stores only an HMAC hash — raw mfaToken is not present in the table', ...)
    it('sets expires_at using database time and verifies expiry with database NOW()', ...)
  })

  describe('verify-login success', () => {
    it('valid mfaToken + valid TOTP issues full session (cookies + { userId, orgId, expiresAt })', ...)
    it('deletes the pending_mfa_sessions row on success (single-use)', ...)
    it('issued session can call GET /auth/me successfully', ...)
    it('reusing the same mfaToken after success returns 401 mfa_token_expired', ...)
  })

  describe('verify-login failures', () => {
    it('invalid TOTP returns 422 invalid_totp and keeps the pending row (attempt_count increments)', ...)
    it('records invalid_totp in failed_auth_attempts on wrong code (AC-9)', ...)
    it('does NOT record failed_auth on a replayed valid code', ...)
    it('expired mfaToken returns 401 mfa_token_expired', ...)
    it('unknown mfaToken returns 401 mfa_token_expired', ...)
    it('the invalid TOTP attempt that reaches MFA_LOGIN_MAX_ATTEMPTS consumes the token and returns 401 mfa_token_expired immediately', ...)
    it('replayed TOTP (already used at enrollment/login) returns 422 invalid_totp', ...)
    it('missing confirmed enrollment at verify time returns 401 mfa_token_expired (no 500)', ...)
  })

  describe('cleanup job', () => {
    it('prunePendingMfaSessions deletes expired rows and attempt-capped rows, retaining live uncapped rows', ...)
  })

  describe('threshold integration (Story 1.9)', () => {
    it('repeated invalid TOTP from one IP crosses FAILED_AUTH_THRESHOLD_COUNT → PENDING_DELIVERY alert', ...)
  })

  describe('logging and redaction', () => {
    it('does not emit mfaToken, tokenHash, totp, or TOTP secret in structured logs for login challenge or verify-login failure', ...)
    it('emits auth.mfa_login_failed with only the allowed reason enum values', ...)
  })
})
```

**Concurrency test (single-use):** fire two `verify-login` requests with the same valid `mfaToken`+TOTP simultaneously (`Promise.all`) → exactly one returns `200` (session), the other returns `401 mfa_token_expired`; exactly zero or one session rows beyond the expected single login.

**Test env:** set `MFA_PENDING_SESSION_TTL_SECONDS` low (e.g. `1`) in a focused test to assert expiry without sleeping the full default; use `MFA_LOGIN_MAX_ATTEMPTS=2` in the attempt-cap test via `vi.stubEnv` + the `process.env` re-read pattern used in `failed-auth.ts` if the value is read from the parsed `env` singleton.

---

### AC-13: Unit Tests

| File | Coverage |
|---|---|
| `tokens.test.ts` | `generatePendingMfaToken()` length/uniqueness; `hashPendingMfaToken()` determinism + secret sensitivity (AC-4) |
| `config/env.test.ts` | new vars defaults/bounds; production guards (unset/placeholder/duplicate secret); cross-field TTL guard (AC-2) |
| `mfa-login.test.ts` | `verifyConfirmedLoginTotp()` 4-way result mapping incl. `no_enrollment`; attempt-cap → consume; expiry → 401 mapping; token-hash collision retry; DB-time expiry behavior (mock `tx`/db where practical) |
| `prune-pending-mfa-sessions.test.ts` | expiry cutoff and capped-row cleanup; logs `job.completed` |
| `auth-sessions-schema.test.ts` | `pendingMfaSessions` columns + `EXCLUDED_TABLES` membership + DB integrity checks for `token_hash`, `attempt_count`, `expires_at`, and unique `(user_id, org_id)` (AC-3) |
| `auth-log-redaction.test.ts` or `mfa-login.integration.test.ts` | no `mfaToken`, `tokenHash`, `totp`, or decrypted TOTP secret in structured logs; failure `reason` limited to allowed enum (AC-11, AC-14) |
| `audit-events.test.ts` | `MFA_LOGIN_VERIFIED` constant only; no `MFA_LOGIN_CHALLENGED` audit constant by default (AC-11) |

**Mutation score target:** ≥80% on `mfa-login.ts` and the new `tokens.ts` functions.

---

### AC-14: Security & Red Team Hardening

| Threat | Mitigation | Verified by |
|---|---|---|
| MFA bypass — session issued before TOTP | Login returns `mfaRequired` with **no** cookies; session only via `verify-login` after valid TOTP | Integration test (no cookies on challenge) |
| Old session remains active after MFA challenge | Challenge branch calls `clearAuthCookies(reply)` before returning `mfaRequired` | Integration test with pre-existing cookie jar |
| `mfaToken` theft / replay after use | Single-use: deleted on success; HMAC-hashed at rest; 5-min TTL | Integration test (reuse → 401) |
| Many concurrent pending tokens for one account | Latest challenge wins: delete existing `(user_id, org_id)` rows before insert | Integration test: second challenge invalidates first token |
| Concurrent password-verified logins create duplicate pending rows | Unique `(user_id, org_id)` index plus transaction-level advisory lock or serialized upsert | Integration test with concurrent challenges |
| App server clock skew changes TTL semantics | Insert and verify expiry with database `NOW()` inside transactions | Boundary test / implementation review |
| Token-hash unique collision returns a failed or duplicate challenge | Regenerate token and retry unique-conflict insert up to 2 times; never return collided token | Unit test |
| TOTP brute force via repeated `verify-login` | Per-token `MFA_LOGIN_MAX_ATTEMPTS` cap **and** per-IP/account `failed_auth` threshold (Story 1.9) **and** per-route rate limit | Integration tests (cap + threshold) |
| TOTP replay across flows | Shared `totp_used_codes` (user_id, code_hash) replay table reused | Integration test (replayed code → 422, no failed-auth record) |
| Concurrent double-spend of one token | `SELECT … FOR UPDATE` + delete in one tx | Concurrency integration test |
| Raw token in logs/storage/cookie | Only HMAC stored; token returned once in body; never logged/cookied | Code review + log-redaction list |
| Challenge or verify failure leaks sensitive fields in logs | Structured-log redaction assertions for `mfaToken`, `tokenHash`, `totp`, and decrypted TOTP secret | Log capture test |
| MFA-enrollment status enumeration | `mfaRequired` revealed **only** after a valid password — same as having credentials | Documented (ADR-1.12-02) |
| Token entropy | 128-bit (`randomBytes(16)`) base64url | Unit test |
| Secret reuse weakening hashing | `MFA_PENDING_SESSION_HMAC_SECRET` required + distinct in prod | env.test.ts guard |
| Pending rows leaking to tenants | No org_id RLS but **no REST endpoint** exposes the table; not in any list API | route-audit + code review |
| Abandoned-token accumulation (storage DoS) | Hourly prune job + verify-time expiry check | prune test |
| TOTP/secret/PII in audit payloads | Audit payloads carry only `{ method }` | AC-11 + code review |
| Timing oracle on token lookup | Lookup by unique `token_hash` index; non-existent vs expired both → identical `401 mfa_token_expired` | Integration test (unknown vs expired same response) |
| Malformed token hashes or negative attempts in DB | DB CHECK constraints on `token_hash`, `attempt_count`, and `expires_at` | Migration/schema tests |
| Capped token row survives due to crash/future bug | Cleanup job prunes `attempt_count >= MFA_LOGIN_MAX_ATTEMPTS` as well as expired rows | Cleanup test |

---

### AC-15: ADRs

#### ADR-1.12-01: `pending_mfa_sessions` is identity-scoped (org_id column, no RLS)

| | |
|---|---|
| **Context** | The pending row is created during `POST /auth/login` — before any session, JWT, or `app.current_org_id` exists, so RLS scoping is impossible at write time. The resolved `org_id` is still needed at `verify-login` to issue the session. |
| **Decision** | Store `org_id` as a plain FK column; **no** RLS policy (same class as `mfa_enrollments`/`totp_used_codes`). Add to `EXCLUDED_TABLES`. Access only via service code + workers; never via tenant REST. |
| **Consequences** | Must keep the table out of every list/search endpoint; documented in AC-3/AC-14. |

#### ADR-1.12-02: `mfaRequired` revealed only after valid password

| | |
|---|---|
| **Context** | Returning `mfaRequired` discloses that the account exists and has MFA. |
| **Decision** | The MFA branch runs **after** password + active-membership verification; an attacker without valid credentials gets the uniform `401 invalid_credentials` and learns nothing. |
| **Consequences** | Acceptable, standard MFA UX; no additional enumeration surface beyond knowing the password. |

#### ADR-1.12-03: Two distinct failure codes (422 vs 401)

| | |
|---|---|
| **Context** | "Wrong code, try again" and "token dead, start over" are different UX states. |
| **Decision** | `422 invalid_totp` while the token is alive (retry allowed); `401 mfa_token_expired` once the token is expired/consumed/attempt-capped (must restart from `/auth/login`). |
| **Consequences** | Frontend (Story 2.0) branches on these codes; documented in the response tables. |

#### ADR-1.12-04: Keyed HMAC (not bcrypt, not plain SHA) for `mfaToken`

| | |
|---|---|
| **Context** | The token is high-entropy (128-bit) and looked up on every verify. |
| **Decision** | HMAC-SHA256 with a dedicated secret — matches the refresh-token convention (`hashRefreshToken`), constant-time index lookup, no per-row salt cost (unlike bcrypt, which is for low-entropy secrets). |
| **Consequences** | One new required production secret (`MFA_PENDING_SESSION_HMAC_SECRET`). |

#### ADR-1.12-05: Latest MFA login challenge wins

| | |
|---|---|
| **Context** | A valid password submission for an MFA-enrolled account creates a bearer `mfaToken`. Allowing multiple live pending tokens for the same `(user_id, org_id)` increases replay/theft surface and complicates attempt counting. |
| **Decision** | Before inserting a new `pending_mfa_sessions` row, delete existing rows for the same `(user_id, org_id)`. The latest password-verified challenge is the only valid one. |
| **Consequences** | A user who opens multiple login tabs may invalidate an older challenge by submitting credentials again. This is acceptable for v1 because the UX recovery is simple: submit the password again and enter the newest TOTP challenge. |

#### ADR-1.12-06: MFA challenge issuance is logged operationally, not audited by default

| | |
|---|---|
| **Context** | `POST /auth/login` for an MFA-enrolled user can create high-volume challenge events before a session exists. Auditing every challenge may add noise and reveal valid-password attempts for MFA users even when the second factor fails. |
| **Decision** | Do not write `MFA_LOGIN_CHALLENGED` to `audit_log_entries` by default. Emit a redacted structured operational log for challenge issuance, and reserve audit entries for `MFA_LOGIN_VERIFIED` plus existing `LOGIN_FAILED` paths. |
| **Consequences** | Security operators still have operational visibility without turning every pre-session challenge into durable org audit history. If compliance later requires challenge audit, add it behind an explicit product/compliance story. |

#### ADR-1.12-07: Attempt cap consumes token on the capped request

| | |
|---|---|
| **Context** | Returning one final `422 invalid_totp` after the token reaches `MFA_LOGIN_MAX_ATTEMPTS` gives the client an extra oracle edge and leaves capped-token behavior split across two requests. |
| **Decision** | When an invalid or replayed TOTP increments `attempt_count` to `MFA_LOGIN_MAX_ATTEMPTS`, delete the pending row and return `401 mfa_token_expired` immediately. |
| **Consequences** | Frontend sees a clear “restart login” state as soon as the token is capped. Users who mistype too many times must re-enter password, which is acceptable for v1. |

#### ADR-1.12-08: MFA challenge clears existing auth cookies

| | |
|---|---|
| **Context** | A browser may hold a valid session for one user while starting a new MFA login for another user. Returning `mfaRequired` without clearing old cookies can leave the previous session active in the same jar. |
| **Decision** | The MFA challenge branch calls `clearAuthCookies(reply)` before returning `mfaRequired`. It may emit clearing `Set-Cookie` headers, but must not set usable auth cookies. |
| **Consequences** | Starting an MFA login cleanly transitions the browser into an unauthenticated challenge state. Account switching is safer, and a failed or abandoned MFA challenge does not leave stale session cookies behind. |

#### ADR-1.12-09: DB-backed pending-session attempts are the authoritative TOTP brute-force control

| | |
|---|---|
| **Context** | Route rate limits can be bypassed or cause NAT collateral damage, while failed-auth thresholding detects broader attack patterns asynchronously. Neither is a precise per-challenge control. |
| **Decision** | `pending_mfa_sessions.attempt_count` is the authoritative per-token TOTP brute-force control. Route rate limiting is a broad shield; Story 1.9 failed-auth thresholding is the cross-token/account/IP detection layer. |
| **Consequences** | Correctness does not depend on Fastify rate-limit configuration. The DB row lock and attempt counter enforce the cap consistently across instances. |

#### ADR-1.12-10: Pending MFA correctness uses database serialization and database time

| | |
|---|---|
| **Context** | MFA challenges are created and verified across potentially multiple API instances. App clock skew and concurrent password-verified logins can create inconsistent expiry or duplicate challenge state. |
| **Decision** | Use database `NOW()` for expiry creation/verification, a unique `(user_id, org_id)` index, and transaction-level advisory locking or equivalent serialization for latest-challenge-wins. |
| **Consequences** | Correctness is enforced by the database rather than by per-process timing or in-memory locks. The implementation is slightly more complex but safe across horizontally scaled API instances. |

---

### AC-16: Tasks / Subtasks

> Follow repo TDD red-green (AGENTS.md): write/extend the failing test first, confirm it fails for the right reason, implement the minimal change, re-run.

- [ ] **Task 1: Schema & migration** (AC: 3)
  - [ ] `pending-mfa-sessions.ts` Drizzle schema + export from `schema/index.ts`
  - [ ] `0011_pending_mfa_sessions.sql` + `_journal.json` entry (verify next index)
  - [ ] DB integrity checks for 64-hex `token_hash`, nonnegative `attempt_count`, and `expires_at > created_at`
  - [ ] Unique `(user_id, org_id)` index for latest-challenge-wins concurrency safety
  - [ ] Add `'pending_mfa_sessions'` to `EXCLUDED_TABLES`
  - [ ] Extend `auth-sessions-schema.test.ts`
- [ ] **Task 2: Env config** (AC: 2)
  - [ ] Add `MFA_PENDING_SESSION_TTL_SECONDS`, `MFA_LOGIN_MAX_ATTEMPTS`, `MFA_PENDING_SESSION_HMAC_SECRET` + prod/cross-field guards
  - [ ] `.env.example` + `check-env-example.ts` + `env.test.ts`
- [ ] **Task 3: Token helpers** (AC: 4)
  - [ ] `generatePendingMfaToken()` + `hashPendingMfaToken()` in `tokens.ts` + `tokens.test.ts`
- [ ] **Task 4: TOTP reuse** (AC: 8)
  - [ ] Extract/export `verifyConfirmedLoginTotp()` (refactor from `mfa.ts`, behavior-preserving)
- [ ] **Task 5: Login branch + verify-login service** (AC: 5, 6)
  - [ ] `findLoginUser()` selects `mfa_enrolled_at`; `loginUser()` returns union
  - [ ] `createPendingMfaSession()` + `verifyLogin()` in `mfa-login.ts`
  - [ ] Challenge branch clears existing auth cookies and enforces latest-challenge-wins per `(user_id, org_id)` with DB concurrency protection
  - [ ] DB-time expiry on insert/verify and token-hash unique-collision retry
- [ ] **Task 6: Routes & schemas** (AC: 5, 6, 7)
  - [ ] `/login` handler branch (no cookies on challenge)
  - [ ] `POST /mfa/verify-login` + method-not-allowed + rate limit + Zod schemas
  - [ ] `route-audit.test.ts` map update
- [ ] **Task 7: Failed-auth wiring** (AC: 9)
  - [ ] `recordFailedAuthAttempt({ reason: 'invalid_totp' })` on invalid (non-replayed) code
- [ ] **Task 8: Cleanup job** (AC: 10)
  - [ ] `prune-pending-mfa-sessions.ts` deletes expired and attempt-capped rows + schedule/worker in `main.ts` + test
- [ ] **Task 9: Audit events** (AC: 11)
  - [ ] `MFA_LOGIN_VERIFIED` constant + emit + `audit-events.test.ts`
  - [ ] Redacted structured operational logs for challenge, verified, and failed outcomes (no challenge audit event by default)
- [ ] **Task 10: Tests** (AC: 12, 13, 14)
  - [ ] `mfa-login.integration.test.ts` (all scenarios + concurrency)
  - [ ] Log-redaction test for `mfaToken`, `tokenHash`, `totp`, and TOTP secret
  - [ ] Unit tests per AC-13

---

### Out of Scope (Explicit)

| Item | Owner |
|---|---|
| MFA login via **recovery code** at the second step | Already covered by `POST /auth/mfa/recover` (Story 1.8) — do not duplicate inside verify-login |
| Forcing **unenrolled** owner/admin to enroll at login | Story 1.9 grace period + `requireMfaEnrollment()` route enforcement (ADR-1.9-05) |
| Remembering a trusted device / "skip MFA for 30 days" | Future enhancement |
| WebAuthn / hardware-key second factor | Future (v1 is TOTP-only) |
| SvelteKit MFA login UI (challenge + code entry screens) | Story 2.0 (consumes this API) |
| Email/SMS step-up or push approval | Out of v1 scope |
| Account lockout (beyond attempt cap + threshold detection) | Future — recording + capping only |
| Disabling MFA / removing enrollment | Not supported in v1 (Story 1.8 `mfa_already_enrolled`) |

---

### Anti-Patterns (Do Not)

- Set auth cookies on the `mfaRequired` response — no session until TOTP verified.
- Leave old auth cookies intact on the `mfaRequired` response — clear them before returning the challenge.
- Allow unlimited parallel pending MFA login rows for the same `(user_id, org_id)` — latest challenge wins.
- Use `users.mfa_enrolled` (boolean) — the column is `mfa_enrolled_at TIMESTAMPTZ`.
- Return raw tokens in the JSON body for the success step — Story 1.6 issues HttpOnly cookies; body is `{ data: { userId, orgId, expiresAt } }`.
- Store the raw `mfaToken` — store only `hashPendingMfaToken(token)`.
- Store unbounded `user_agent` values — truncate to 512 characters before inserting.
- Log `mfaToken`, `totp`, the decrypted TOTP secret, or the user's email.
- Re-implement TOTP validation or replay protection — reuse Story 1.8 `validateTotpCode()` + `recordTotpUse()`.
- Record a `failed_auth_attempts` row for a **replayed** code (only genuine wrong guesses).
- Consume the `mfaToken` on an invalid TOTP — keep it for retry until TTL/attempt-cap.
- Add an `org_id` RLS policy to `pending_mfa_sessions` (created pre-session) — add to `EXCLUDED_TABLES` instead.
- Expose `pending_mfa_sessions` via any tenant REST route.
- Reuse `REFRESH_TOKEN_HMAC_SECRET` (or any other auth secret) to hash pending tokens.
- Block on `await recordFailedAuthAttempt(...)` — fire-and-forget so recording never changes the response.
- Add `MFA_LOGIN_CHALLENGED` to `AuditEvent` or `audit_log_entries` in this story — challenge issuance is operational logging only unless a future compliance story changes it.
- Refactor the existing public auth routes onto SecureRoute in this story (1.11 not merged) — follow the current raw-fastify pattern and let 1.11 allowlist them.

---

### Manual QA Checklist

```bash
BASE=http://localhost:3000/api/v1

# 1. Register + login a user, enroll MFA (Story 1.8) — capture the base32 secret to compute codes.
curl -s -c jar.txt -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"mfa@test.com","password":"twelve-characters","orgName":"MFA Org"}'
curl -s -c jar.txt -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"mfa@test.com","password":"twelve-characters"}'
curl -s -b jar.txt -X POST $BASE/auth/mfa/enroll -H 'Content-Type: application/json' -d '{}'   # → { secret, otpauthUrl, ... }
# verify enrollment with a current TOTP code for that secret:
curl -s -b jar.txt -X POST $BASE/auth/mfa/verify-enrollment -H 'Content-Type: application/json' -d '{"totp":"<code>"}'

# 2. Log in again — now MFA is required (NO cookies set, mfaToken returned):
curl -s -i -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"mfa@test.com","password":"twelve-characters"}'
# Expect: 200 { "data": { "mfaRequired": true, "mfaToken": "..." } } and NO Set-Cookie

# 3. Complete login with a fresh TOTP code:
curl -s -i -c jar2.txt -X POST $BASE/auth/mfa/verify-login -H 'Content-Type: application/json' \
  -d '{"mfaToken":"<from step 2>","totp":"<current code>"}'
# Expect: 200 { "data": { userId, orgId, expiresAt } } + Set-Cookie access-token & refresh-token
curl -s -b jar2.txt $BASE/auth/me | jq '.data.mfaEnrolled'   # → true

# 4. Reuse the same mfaToken → 401 mfa_token_expired
# 5. Wrong TOTP with a fresh mfaToken → 422 invalid_totp (retry allowed until attempt cap / TTL)
# 6. Wait > MFA_PENDING_SESSION_TTL_SECONDS then verify → 401 mfa_token_expired
```

**Operator note:** The non-MFA login path is unchanged — users without enrollment still receive a session directly from `POST /auth/login`. Deploying 1.12 only changes behavior for users who have completed Story 1.8 enrollment.

---

### Project Structure Notes

| What | Where |
|---|---|
| Pending session schema | `packages/db/src/schema/pending-mfa-sessions.ts` |
| Migration | `packages/db/src/migrations/0011_pending_mfa_sessions.sql` |
| RLS exception list | `packages/db/src/check-rls-coverage.ts` (`EXCLUDED_TABLES`) |
| Login branch | `apps/api/src/modules/auth/service.ts` (`loginUser`) |
| MFA login service | `apps/api/src/modules/auth/mfa-login.ts` |
| Token hashing | `apps/api/src/modules/auth/tokens.ts` |
| Routes & schemas | `apps/api/src/modules/auth/routes.ts`, `schema.ts` |
| Cleanup worker | `apps/api/src/workers/prune-pending-mfa-sessions.ts` (wired in `main.ts`) |
| Failed-auth recorder (reuse) | `apps/api/src/modules/auth/failed-auth.ts` |
| TOTP validate/replay (reuse) | `apps/api/src/modules/auth/totp.ts`, `mfa.ts` |
| Audit constants | `packages/shared/src/constants/audit-events.ts` |
| Integration tests | `apps/api/src/__tests__/mfa-login.integration.test.ts` |

**BossService pattern:** register the new schedule + worker inside the existing `startBossAndRegisterWorkers()` callback in `main.ts` (jobs only start after vault unseal).

**Do NOT** implement SvelteKit MFA login screens — backend returns the challenge/verify contract for Story 2.0.

---

### Previous Story Intelligence

#### From Story 1.6 (Auth foundation)
- Login issues tokens as **HttpOnly cookies** via `setAuthCookies()`; response body is `{ data: { userId, orgId, expiresAt } }`. Reuse `sendAuthSession()` for the verify-login success path.
- Uniform `401 invalid_credentials`; email normalized via `normalizeEmail()` (NFKC, ASCII-only).
- Active org resolved via `findLoginUser()` + `activeMembership` — reuse, don't reinvent.

#### From Story 1.8 (MFA enrollment)
- Confirmed secret lives in `mfa_enrollments` (`status='confirmed'`), AES-encrypted via `encryptTotpSecret`/`decryptEnrollmentSecret` (vault primary key). Zero plaintext buffers in `finally`.
- `validateTotpCode()` returns `{ valid, counter }`; `recordTotpUse()` returns `false` on replay (uses `ON CONFLICT DO NOTHING`). The 3-way `valid`/`invalid_code`/`replayed_code` distinction (added in 1.9) is the contract to reuse.
- Invalid TOTP → `422 { code: 'invalid_totp' }`.

#### From Story 1.9 (Failed auth + threshold)
- `recordFailedAuthAttempt()` is exported and best-effort/fire-and-forget; this story is its **last** deferred wiring point (`reason: 'invalid_totp'` at login).
- Replayed codes must NOT feed the threshold counter (review patch in 1.9).
- Threshold worker runs every minute; no new detection logic needed here.

#### From Story 1.7 (Sessions/jobs)
- pg-boss schedules/workers register inside `setOnVaultUnsealed` (`startBossAndRegisterWorkers`). Add the prune job there.

---

### Git Intelligence Summary

Recent Epic 1 commits implemented Stories 1.7–1.10 on this branch (structured logging, failed-auth threshold, MFA enrollment, sessions). The auth module (`apps/api/src/modules/auth/`) and migrations through `0010` are present. Story 1.12 extends — no migration conflicts expected; confirm `_journal.json` ends at `0010` before adding `0011`. The exported `recordFailedAuthAttempt` and the `validateEnrollmentTotp` 3-way result were introduced precisely so 1.12 could wire login TOTP without duplication — use them.

---

### Latest Tech Information

| Technology | Version / note | Story impact |
|---|---|---|
| pg-boss | repo `pg-boss` v12 wrapper (`BossService`) | `schedule(name, '0 * * * *', null, { tz: 'UTC' })` for hourly cleanup |
| otpauth | repo dependency (TOTP) | Reuse `validateTotpCode()`; do not add a new OTP lib |
| Drizzle ORM | 0.45.x | `SELECT … FOR UPDATE` via `.for('update')`; identity-scoped insert bypasses `withOrg()` |
| Fastify | v5 + `@fastify/rate-limit` | Per-route `config: { rateLimit: { max, timeWindow } }` already used on `/register` |
| node:crypto | `randomBytes(16)` + `createHmac('sha256', …)` | 128-bit token + keyed hash (matches `tokens.ts`) |
| Zod | `zod/v4` | Reuse the Story 1.8 TOTP regex and `validationError()` helper |

---

### References

- Epic AC: [_bmad-output/planning-artifacts/epics.md#Story-1.12-MFA-Login-Verification-Flow]
- Story 2.0 dependency on this flow: [_bmad-output/planning-artifacts/epics.md#Story-2.0-MVP-Frontend-Shell--Empty-Project-Dashboard]
- Deferred login gate (ADR-1.9-05) + exported recorder: [_bmad-output/implementation-artifacts/1-9-mfa-role-enforcement-and-failed-authentication-detection.md]
- MFA enrollment & TOTP reuse: [_bmad-output/implementation-artifacts/1-8-totp-mfa-enrollment-and-recovery-codes.md]
- Cookie session issuance: [_bmad-output/implementation-artifacts/1-7-jwt-session-management-and-security-controls.md]
- Auth foundation / login: [_bmad-output/implementation-artifacts/1-6-user-registration-and-password-authentication.md]
- RLS exception convention: [packages/db/src/check-rls-coverage.ts]

---

## Dev Agent Record

### Agent Model Used

_(to be filled by dev agent)_

### Debug Log References

### Completion Notes List

### File List

