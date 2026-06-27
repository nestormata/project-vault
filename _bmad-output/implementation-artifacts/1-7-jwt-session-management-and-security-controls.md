# Story 1.7: JWT Session Management & Security Controls

Status: in-progress

<!-- Ultimate context engine analysis completed 2026-06-24 — comprehensive developer guide for session list/revoke, idle timeout, revoked_tokens, auth middleware, admin revocation, and pg-boss cleanup. Red Team hardening applied 2026-06-24 (AC-4a, AC-10c, AC-15b, AC-30b). ADR review applied 2026-06-24 (ADR-1.7-01–07; AC-15b aligned to Story 1.6 new-session-row rotation). Security Audit Personas applied 2026-06-24 (AC-5a, AC-15c, live orgRole, idle audit). FMA applied 2026-06-24 (AC-4b, AC-5b/c, AC-9a, AC-14b, AC-7f). -->

## Story

As a user managing my account security,
I want to view all my active sessions and revoke any of them — including org admins being able to revoke any user's sessions — with idle timeout enforced automatically,
so that compromised or abandoned sessions cannot be used to access vault secrets.

*Covers: FR83, FR84, FR85* [Source: _bmad-output/planning-artifacts/prd.md#Functional-Requirements]

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 1.6 complete — register, login, refresh, JWT cookies | Session rows, refresh tokens, `jti`, and cookie auth must exist before list/revoke |
| Story 1.5 complete — vault unsealed | Auth routes blocked while sealed |
| Story 1.4 complete — `sessions`, `org_memberships`, audit tables | Schema + RLS patterns |
| Story 1.2 complete — `BossService` lifecycle | pg-boss starts after unseal (Story 1.5 AC-29); this story registers first real scheduled job |
| Real PostgreSQL in integration tests | No DB mocks for session flows |

### Epic Cross-Story Context

| Story | Relationship to 1.7 |
|---|---|
| 1.6 | Creates sessions at login; 1.7 extends auth module with list/revoke/logout and auth middleware |
| 1.8 | MFA enrollment requires authenticated user — uses 1.7 middleware |
| 1.9 | Failed auth detection — independent; do not block 1.7 |
| 1.11 | SecureRoute factory **consumes** `authenticateRequest` from this story — do not duplicate JWT validation |
| 4.3 | Account deactivation calls `revokeAllUserSessionsInOrg()` exported from this story (FR84 path) |
| 4.2 | `DELETE /api/v1/org/users/:userId` invalidates sessions via same service function |

---

## Acceptance Criteria

### AC-1: Module Structure & Route Registration

**Given** Story 1.6 auth module exists,
**When** Story 1.7 is complete,
**Then** extend auth and add org admin routes:

```
apps/api/src/modules/auth/
├── routes.ts           # ADD: GET /sessions, DELETE /sessions, DELETE /sessions/:id, POST /logout, GET /me
├── service.ts          # ADD: listSessions(), revokeSession(), revokeAllOtherSessions(), logoutCurrent()
├── session-revoke.ts   # NEW: revokeSessionById(), revokeAllUserSessionsInOrg(), cleanupExpiredSession() — reusable by Epic 4
├── tokens.ts           # unchanged signing; ADD: parseAccessTokenClaims()
└── schema.ts           # ADD session list/revoke Zod schemas

apps/api/src/modules/org/
├── routes.ts           # NEW: DELETE /users/:userId/sessions (admin only)
└── schema.ts           # NEW: param schemas

apps/api/src/plugins/
├── authenticate.ts     # NEW: JWT verify + sessionVersion + revoked_tokens + idle + last_active debounce
└── require-org-role.ts # NEW: minimum org_memberships.role check (admin|owner for FR84)

apps/api/src/workers/
└── prune-revoked-tokens.ts   # NEW: pg-boss handler
```

**And** mount org routes at `/api/v1/org` from `app.ts`:

```typescript
await fastify.register(orgRoutes, { prefix: '/api/v1/org' })
```

**And** session management routes require authentication (see AC-5) — **not** on vault guard allowlist.

**And** update `route-audit.test.ts` exempt paths — remove session routes from public exempt set; only register/login/refresh stay public.

---

### AC-2: Environment Variables

**Add to `apps/api/src/config/env.ts`:**

| Variable | Type | Default | Validation |
|---|---|---|---|
| `SESSION_IDLE_TIMEOUT_MINUTES` | number | `30` | Min `1`, max `1440` (24h) |
| `SESSION_ACTIVITY_DEBOUNCE_SECONDS` | number | `60` | Min `10`, max `300` — max one `last_active_at` write per session per window |
| `MAX_SESSIONS_PER_USER` | number | `0` | `0` = unlimited (v1 default); if `> 0`, oldest sessions revoked on new login (Story 1.6 hook) |
| `JWT_ACCESS_TTL_SECONDS` | number | `300` | Already from 1.6 — used to compute `revoked_tokens.expires_at` |
| `JWT_MAX_CLOCK_SKEW_SECONDS` | number | `30` | Min `0`, max `300` — reject access JWT where `iat > now() + skew` (AC-5a) |

**Production guard:** `SESSION_IDLE_TIMEOUT_MINUTES` must be ≥ 1 — reject `0`.

**And** update `.env.example` and `scripts/check-env-example.ts`.

---

### AC-3: Database Migration — `revoked_tokens` + Session Hardening

**Given** Story 1.6 migrations applied,
**When** `pnpm --filter @project-vault/db db:migrate` runs,
**Then** migration `0004_session_revocation.sql` (name may vary) applies:

#### AC-3a: `revoked_tokens` table

```sql
CREATE TABLE revoked_tokens (
  jti           TEXT PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_revoked_tokens_expires_at ON revoked_tokens (expires_at);
CREATE INDEX idx_revoked_tokens_user_id ON revoked_tokens (user_id);
```

**RLS:** No `org_id` — add `'revoked_tokens'` to `EXCLUDED_TABLES` in `check-rls-coverage.ts`.

**Semantics:** Row exists while a revoked JWT might still be valid (until original JWT `exp`). `expires_at` = JWT `exp` claim as timestamptz (not `now() + 5min` — use actual token exp when known at revoke time).

#### AC-3b: Finalize `sessions` columns (from 1.6 partial)

```sql
-- Backfill any NULL jti (should not exist post-1.6; defensive)
UPDATE sessions SET jti = gen_random_uuid()::text WHERE jti IS NULL;

ALTER TABLE sessions ALTER COLUMN jti SET NOT NULL;
-- revoked_at may already exist from 1.6 migration
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_jti ON sessions (jti);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_last_active_at ON sessions (last_active_at);
```

#### AC-3c: Drizzle schema

- `packages/db/src/schema/revoked-tokens.ts` — new
- `packages/db/src/schema/sessions.ts` — add `jti`, `revokedAt`
- `packages/db/src/schema/index.ts` — re-export

---

### AC-4: Architecture Decision — `session_version` Lives on the Session Row

**Epics.md says** "increment `session_version` on the user record" — **incorrect for this codebase.**

**Canonical (Story 1.6 + architecture):** `sessions.session_version` is per-session. JWT claim `sessionVersion` must match the **live** value on the session row identified by `jti`.

**On revoke:**

1. Set `sessions.revoked_at = NOW()`
2. Increment `sessions.session_version` by 1 for that session row
3. Revoke all `refresh_tokens` linked to that `session_id` (`revoked_at = NOW()`)
4. Insert `revoked_tokens` row with `(jti, user_id, expires_at)` — see **`expires_at` rules** below

**Do NOT** add a `users.session_version` column.

#### AC-4a: `revoked_tokens.expires_at` when victim JWT is unavailable

Session row revocation (steps 1–3) is **authoritative** for immediate reject. `revoked_tokens` is a belt-and-suspenders cache keyed by `jti` for fast middleware lookup.

| Revoke target | `revoked_tokens.expires_at` |
|---|---|
| Current session (logout, revoke-self) | Parse `exp` from request access JWT |
| Other session (remote revoke, admin, bulk) | `min(now() + JWT_ACCESS_TTL_SECONDS, active_refresh_token.expires_at)` — conservative upper bound when victim access JWT is not available |

Implement via shared helper `computeRevokedTokenExpiresAt({ accessTokenExp?, refreshTokenExpiresAt? })` used by revoke and refresh rotation paths.

#### AC-4b: `cleanupExpiredSession()` canonical spec

Shared function used by AC-5 step 6, AC-10 refresh path, and AC-15 idle check:

```typescript
export async function cleanupExpiredSession(
  sessionId: string,
  options?: { tx?: Tx },
): Promise<void>
```

In one transaction (idempotent — return early if session missing or `revoked_at` already set):

1. `SELECT … FOR UPDATE` on session row
2. Select active refresh `expires_at` **before** revoking refresh rows (same order as AC-4 revoke pattern)
3. Set `sessions.revoked_at`, increment `session_version`
4. Revoke all `refresh_tokens` for `session_id`
5. Insert `revoked_tokens` for session `jti` via `computeRevokedTokenExpiresAt()` (AC-4a)
6. Write `SESSION_REVOKED` audit with `scope: 'idle_expiry'`, `actorUserId: session.userId` (AC-16)
7. Evict `sessionId` from debounce Map (AC-10a)

If `options.tx` provided, participate in caller transaction; otherwise open own transaction.

**Integration test:** Call twice for same idle session → second call is no-op; exactly one audit row.

---

### AC-5: Authentication Plugin — `authenticateRequest`

**Given** a request with `access-token` HttpOnly cookie (Story 1.6),
**When** `authenticateRequest` preHandler runs on protected routes,
**Then** perform checks in this **exact order** (fail fast):

| Step | Check | Failure response |
|---|---|---|
| 1 | Cookie present | `401 { "code": "access_token_missing", "message": "..." }` |
| 2 | JWT signature valid (HS256, `@fastify/jwt`) — **must reject expired tokens** (`exp < now()`); see AC-5a | `401 { "code": "access_token_invalid", "message": "..." }` |
| 3 | Required claims present: `sub`, `orgId`, `jti`, `sessionVersion` | `401 access_token_invalid` |
| 4 | `revoked_tokens` row exists for `jti` | `401 { "code": "session_revoked", "message": "..." }` |
| 5 | Session row lookup by `jti` (platform tx, no RLS) | `401 session_revoked` if missing, `revoked_at` set, or `sessionVersion` mismatch |
| 6 | Idle timeout: `now - last_active_at > SESSION_IDLE_TIMEOUT_MINUTES` | `401 { "code": "session_expired", "message": "..." }` + **await** synchronous cleanup (AC-10c) before returning |
| 7 | Live org membership for JWT `orgId` | `403 { "code": "account_deactivated", "message": "..." }` if no active membership; **load `orgRole` from `org_memberships.role`** into `authContext` — do not trust JWT role claim |
| 8 | Debounced `last_active_at` update (AC-10) | — |
| 9 | Attach `request.authContext` | — |

**Check-order rationale (ADR-1.7-02):** Steps 4→5 — `revoked_tokens` PK lookup rejects known-revoked `jti` first (cheap fail-fast); session row is authoritative for `sessionVersion`, `revoked_at`, and idle timeout.

**AuthContext shape:**

```typescript
// apps/api/src/@types/fastify.d.ts — extend FastifyRequest
export type AuthContext = {
  userId: string
  orgId: string
  sessionId: string      // sessions.id uuid
  jti: string
  sessionVersion: number
  orgRole: 'owner' | 'admin' | 'member' | 'viewer'
}
```

**Register plugin in `app.ts` after `@fastify/jwt` and `@fastify/cookie`.**

**Story 1.11 note:** SecureRoute will call `authenticateRequest` internally — export as reusable `fastify.decorate('authenticate', ...)` or standalone async function.

#### AC-5a: JWT temporal validation

**Given** step 2 JWT verify via `@fastify/jwt`,
**Then** reject tokens where `exp < now()` with `401 access_token_invalid`.

**And** reject tokens where `iat > now() + 30s` (clock skew cap — constant `JWT_MAX_CLOCK_SKEW_SECONDS`, default `30`).

**Integration test:** Manually sign access JWT with `exp` in the past → `GET /auth/me` → `401 access_token_invalid`.

#### AC-5b: Auth DB errors fail closed as 503

If steps 4–7 throw **infrastructure** errors (DB connectivity, timeout, unexpected query failure) — not business-rule rejects:

**Then** return `503 { "code": "service_unavailable", "message": "..." }` — never `401` or `403`.

**Integration test:** Simulate DB error during session lookup → `GET /auth/me` → `503 service_unavailable`.

#### AC-5c: Non-blocking activity touch

Step 8 `touchSessionActivity` failures must **not** fail authentication. Log at `warn`:

```typescript
logger.warn({ eventType: 'session.activity_touch_failed', sessionId, err })
```

Proceed to step 9 regardless.

---

### AC-6: Protected Sanity Route — `GET /api/v1/auth/me`

**Given** valid authenticated session,
**When** `GET /api/v1/auth/me`,
**Then** `200`:

```json
{
  "data": {
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "orgId": "660e8400-e29b-41d4-a716-446655440001",
    "sessionId": "770e8400-e29b-41d4-a716-446655440002",
    "orgRole": "owner"
  }
}
```

**Purpose:** Integration test target for auth middleware before Story 1.11 ships real secret routes.

**And** `GET /api/v1/auth/me` without cookie → `401 access_token_missing`.

---

### AC-7: List Sessions — `GET /api/v1/auth/sessions`

**Given** user authenticated with valid session,
**When** `GET /api/v1/auth/sessions`,
**Then** `200`:

```json
{
  "data": [
    {
      "sessionId": "770e8400-e29b-41d4-a716-446655440002",
      "createdAt": "2026-06-24T10:00:00.000Z",
      "lastActiveAt": "2026-06-24T10:25:00.000Z",
      "ipAddress": "192.168.1.10",
      "userAgent": "Mozilla/5.0 (X11; Linux x86_64)...",
      "isCurrent": true
    },
    {
      "sessionId": "880e8400-e29b-41d4-a716-446655440003",
      "createdAt": "2026-06-23T08:00:00.000Z",
      "lastActiveAt": "2026-06-23T18:00:00.000Z",
      "ipAddress": "203.0.113.42",
      "userAgent": "curl/8.5.0",
      "isCurrent": false
    }
  ]
}
```

#### AC-7a: Active session definition

Include sessions where **all** of:
- `sessions.user_id = authContext.userId`
- `sessions.revoked_at IS NULL`
- At least one `refresh_tokens` row for `session_id` with `revoked_at IS NULL` AND `expires_at > NOW()`
- `last_active_at` within idle timeout window (or `created_at` if never updated — treat as active until idle expires)

**Exclude** fully expired idle sessions from list (they are dead).

#### AC-7b: Sort order

`lastActiveAt DESC` — most recently used first.

#### AC-7c: `isCurrent`

`true` when `sessions.jti === authContext.jti`.

#### AC-7d: IP / user agent privacy

Return stored values as-is (user viewing own sessions). Never return refresh token hashes or JWT strings.

#### AC-7e: curl example

```bash
curl -s -b cookies.txt http://localhost:3000/api/v1/auth/sessions | jq .
```

#### AC-7f: Stale `sessionId` after refresh rotation

After refresh rotation (AC-15b), the session list reflects the **new** active session row. Clients holding a stale `sessionId` from a pre-rotation list will get `404 session_not_found` on revoke — expected behavior.

**Guidance:** Clients should re-fetch `GET /auth/sessions` after refresh or before revoke actions.

---

### AC-8: Revoke Single Session — `DELETE /api/v1/auth/sessions/:sessionId`

**Given** authenticated user,
**When** `DELETE /api/v1/auth/sessions/:sessionId` for a session they own,
**Then** `204 No Content` on success.

**And** in one transaction:
- Revoke session (AC-4 steps)
- Write audit `SESSION_REVOKED` (AC-16)

**Failure cases:**

| Condition | HTTP | code |
|---|---|---|
| Session not found | `404` | `session_not_found` |
| Session belongs to another user | `404` | `session_not_found` (no enumeration) |
| Session already revoked | `404` | `session_not_found` |
| Invalid UUID param | `422` | `validation_error` |

#### AC-8a: Revoking current session

When user revokes **current** session (`sessionId` matches authContext):
- Perform revoke (AC-4)
- Clear auth cookies in response (`clearCookie` access + refresh)
- Return `204` (client must re-login)

#### AC-8b: curl example

```bash
# Revoke other device
curl -s -o /dev/null -w '%{http_code}\n' -b cookies.txt \
  -X DELETE http://localhost:3000/api/v1/auth/sessions/880e8400-e29b-41d4-a716-446655440003
# → 204

# Revoke current — cookies cleared
curl -s -D - -b cookies.txt -X DELETE \
  http://localhost:3000/api/v1/auth/sessions/770e8400-e29b-41d4-a716-446655440002
```

#### AC-8c: Post-revoke JWT rejection

Integration test:
1. Login device A and device B (two sessions)
2. Revoke device B from device A
3. Use device B's saved access cookie on `GET /auth/me` → `401 session_revoked` **immediately** (via `revoked_tokens` + version mismatch)

---

### AC-9: Revoke All Other Sessions — `DELETE /api/v1/auth/sessions`

**Given** authenticated user with multiple active sessions,
**When** `DELETE /api/v1/auth/sessions` (no `:sessionId`),
**Then** revoke **all** sessions for `user_id` **except** current (`jti !== authContext.jti`).

**And** return `200`:

```json
{
  "data": {
    "revokedCount": 3
  }
}
```

**And** current session remains valid — `GET /auth/me` still works.

**And** audit: one `SESSION_REVOKED` event with `payload: { bulk: true, revokedCount: 3, scope: "all_except_current" }`.

**Edge case:** User has only current session → `revokedCount: 0`, `200`.

#### AC-9a: Bulk revoke transaction semantics

`DELETE /auth/sessions` (all except current) and `revokeAllUserSessionsInOrg()` when `tx` is **not** provided:

- Run all revokes inside **one outer transaction**
- On any per-session failure → full rollback, return `503 service_unavailable`
- `revokedCount` in response reflects committed revokes only (all targets on success)
- Single summary audit event (AC-9) with accurate `revokedCount`

When `tx` **is** provided (Epic 4 deactivation — AC-28), participate in caller transaction; rollback propagates to caller.

---

### AC-10: Idle Session Timeout — Server-Side Enforcement

**Given** `SESSION_IDLE_TIMEOUT_MINUTES=30` (default),
**When** idle timeout elapses since `last_active_at`,
**Then** reject at **both** refresh and authenticated request paths:

| Path | Behavior |
|---|---|
| `POST /api/v1/auth/refresh` | `401 { "code": "session_expired", "message": "..." }`; **await** synchronous cleanup (AC-10c) |
| `authenticateRequest` (any protected route) | Same `401 session_expired`; **await** synchronous cleanup (AC-10c) |

**Refresh path extension (modify Story 1.6 `refreshSession()`):**

After loading session by refresh token chain, before issuing new tokens:

```typescript
const idleMs = env.SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000
if (Date.now() - session.lastActiveAt.getTime() > idleMs) {
  await cleanupExpiredSession(session.id)
  throw new AppError('session_expired', 'Session expired due to inactivity', 401)
}
```

#### AC-10a: Debounced `last_active_at` updates

On successful auth (step 8 of AC-5):

```typescript
// Module-level Map — acceptable v1 single-instance constraint (same as rate-limit note)
const lastActivityWrite = new Map<string, number>() // sessionId → last write epoch ms

async function touchSessionActivity(sessionId: string, debounceSec: number): Promise<void> {
  const now = Date.now()
  const last = lastActivityWrite.get(sessionId) ?? 0
  if (now - last < debounceSec * 1000) return
  lastActivityWrite.set(sessionId, now)
  await getDb().update(sessions)
    .set({ lastActiveAt: new Date(), updatedAt: new Date() })
    .where(eq(sessions.id, sessionId))
}
```

**On session revoke, idle cleanup, and refresh rotation (AC-15b):** delete `sessionId` from `lastActivityWrite` Map — including **predecessor** `sessionId` on rotation — to prevent memory growth and stale debounce state.

**Integration test with fake timers:**
1. Login; call `/auth/me` twice within 30s → one DB `last_active_at` update
2. Advance clock 61s; call `/auth/me` → second update

#### AC-10c: Idle expiry cleanup is synchronous

When idle timeout fires in `authenticateRequest` or `refreshSession()`, **await** `cleanupExpiredSession(sessionId)` (AC-4b) in the **same request** before returning `401 session_expired`. Do not fire-and-forget cleanup.

**Rationale:** Prevents replay of access JWT between 401 response and cleanup, and keeps `GET /auth/sessions` list consistent with auth rejection.

Optional pg-boss orphan cleanup remains Story 1.10 scope — not the primary idle path.

(See AC-4b for full `cleanupExpiredSession()` steps including audit and debounce eviction.)

#### AC-10b: Idle timeout integration test

1. Set `SESSION_IDLE_TIMEOUT_MINUTES=1` in test env
2. Login; advance fake clock +61 minutes without activity
3. `POST /refresh` → `401 session_expired`
4. Session row deleted or marked revoked

---

### AC-11: Org Admin Session Revocation — FR84

**Given** caller has live `orgRole IN ('admin', 'owner')` from AC-5 step 7 (not JWT claim),
**When** `DELETE /api/v1/org/users/:userId/sessions`,
**Then** revoke **all** active sessions where:
- `sessions.user_id = :userId`
- `sessions.org_id = authContext.orgId` (org-scoped revocation per FR84)

**And** return `200`:

```json
{
  "data": {
    "revokedCount": 2,
    "userId": "990e8400-e29b-41d4-a716-446655440004"
  }
}
```

**Authorization failures:**

| Condition | HTTP | code |
|---|---|---|
| Caller not admin/owner | `403` | `insufficient_role` |
| Target user not in org | `404` | `user_not_found` |
| Admin revokes own sessions | `200` — allowed (same as bulk revoke) |
| Member/viewer attempts | `403 insufficient_role` |

**And** implement via exported service:

```typescript
// apps/api/src/modules/auth/session-revoke.ts
export async function revokeAllUserSessionsInOrg(
  params: { userId: string; orgId: string; actorUserId: string; reason: 'admin_action' | 'deactivation' | 'security' },
): Promise<{ revokedCount: number }>
```

**Epic 4.3 will call this from deactivation transaction** — document export; do not implement deactivation here.

#### AC-11a: Admin cannot revoke users outside org

User in Org A only; admin in Org B calls revoke → `404 user_not_found`.

#### AC-11b: curl example

```bash
# As org owner/admin
curl -s -b admin-cookies.txt -X DELETE \
  http://localhost:3000/api/v1/org/users/990e8400-e29b-41d4-a716-446655440004/sessions | jq .
```

---

### AC-12: Logout — `POST /api/v1/auth/logout`

**Given** authenticated user,
**When** `POST /api/v1/auth/logout`,
**Then** revoke **current** session (same as AC-8 for current session):
- `204 No Content`
- Clear `access-token` and `refresh-token` cookies
- Audit `SESSION_REVOKED` with `payload: { scope: "logout" }`

**And** POST-only (405 for GET) — same rule as Story 1.6 auth routes.

---

### AC-13: `revoked_tokens` Immediate JWT Invalidation

**Given** a session revoked while its access JWT still has remaining TTL (up to 5 min),
**When** any authenticated request uses that JWT,
**Then** step 4 of AC-5 rejects with `401 session_revoked` **without waiting for JWT exp**.

**Insert on revoke** (and on refresh rotation — AC-15b):

```typescript
await tx.insert(revokedTokens).values({
  jti: session.jti,
  userId: session.userId,
  expiresAt: computeRevokedTokenExpiresAt({
    accessTokenExp,           // when revoking current session / logout
    refreshTokenExpiresAt,    // when revoking remote session (AC-4a fallback)
  }),
})
.onConflictDoNothing() // idempotent re-revoke
```

**Lookup on auth (indexed PK):**

```typescript
const [revoked] = await getDb()
  .select({ jti: revokedTokens.jti })
  .from(revokedTokens)
  .where(eq(revokedTokens.jti, claims.jti))
  .limit(1)
if (revoked) throw new AppError('session_revoked', 'Session has been revoked', 401)
```

---

### AC-14: pg-boss Job — `prune-revoked-tokens`

**Given** vault is unsealed and `BossService` started,
**When** hourly cron fires,
**Then** delete all `revoked_tokens` where `expires_at < NOW()`.

**Worker:** `apps/api/src/workers/prune-revoked-tokens.ts`

**Register in `main.ts` after boss start:**

```typescript
// Extend BossService — add registerSchedules() called from setOnVaultUnsealed
await boss.registerSchedules({
  'prune-revoked-tokens': { cron: '0 * * * *', handler: pruneRevokedTokens },
})
```

**pg-boss 12.x API pattern:**

```typescript
await boss.schedule('prune-revoked-tokens', '0 * * * *')
await boss.work('prune-revoked-tokens', async () => {
  try {
    const deleted = await getDb().delete(revokedTokens)
      .where(lt(revokedTokens.expiresAt, new Date()))
    logger.info({ eventType: 'job.completed', jobName: 'prune-revoked-tokens', deletedCount: deleted.rowCount })
  } catch (err) {
    logger.error({ eventType: 'job.failed', jobName: 'prune-revoked-tokens', err })
    throw err // pg-boss retry (AC-14b)
  }
})
```

**Integration test:**
1. Insert revoked_tokens with `expires_at` in past and future
2. Run handler directly
3. Assert past rows deleted, future rows preserved

**Note:** `session:cleanup` worker (purge old expired sessions) is **Story 1.10** scope — do not block 1.7 on it.

#### AC-14b: Prune job resilience

- Handler must be **idempotent** — safe to re-run after partial failure
- On success: log `eventType: job.completed` with `deletedCount` (existing)
- On failure: log `eventType: job.failed` with error, **rethrow** for pg-boss retry
- Unit test: handler throws → error logged; second run completes successfully

---

### AC-15: Refresh Flow — Idle + Revoked Session Integration

**Extend Story 1.6 refresh** (do not rewrite rotation logic):

| Case | HTTP | code |
|---|---|---|
| Session `revoked_at` set | `401` | `refresh_token_revoked` |
| Idle timeout exceeded | `401` | `session_expired` |
| Valid refresh within idle window | `200` | (unchanged rotation) |

**After successful refresh:** update `last_active_at` on the **new** session row immediately (not debounced — refresh is explicit activity).

#### AC-15b: Predecessor session retirement on refresh rotation (ADR-1.7-03)

Story 1.6 AC-7a creates a **new** `sessions` row on every refresh — do **not** mutate `jti` in-place on the predecessor row.

**Full rotation path** (not grace-window retry), in the **same transaction** after `SELECT … FOR UPDATE` on the refresh token row (AC-30b):

1. Parse outgoing access JWT `jti` and `exp` from request cookie when present
1b. **Fallback:** if access cookie missing, expired, or unparsable, resolve predecessor via `refresh_tokens.session_id → sessions.id` from the consumed refresh token row
2. Resolve **predecessor** session row by outgoing `jti` or fallback `session_id`
3. Retire predecessor: set `revoked_at`, increment `session_version`, revoke linked refresh tokens
4. Insert `revoked_tokens` for outgoing `jti` with `expires_at` from parsed `exp` (AC-4a)
5. Create **new** `sessions` row + new `refresh_tokens` row (Story 1.6 AC-7a steps 3–4)
6. Set `refresh_tokens.used_at`, `refresh_tokens.new_session_id` on the consumed refresh token
7. Issue new cookies from the **new** session's `jti`
8. Evict predecessor `sessionId` from debounce Map (AC-10a)

**All steps 1–7 in a single transaction** — any failure rolls back entirely (no orphaned predecessor or new session rows).

**Grace window retry** (Story 1.6 AC-7b — `used_at` set, within `REFRESH_GRACE_WINDOW_SECONDS`):

- Lookup existing `new_session_id` → re-sign JWT from that session's `jti` with fresh `iat`/`exp`
- **Do not** create another session row or retire the predecessor again
- **Do not** insert duplicate `revoked_tokens` rows

**Integration tests:**

1. Save pre-refresh access cookie → `POST /refresh` → pre-refresh cookie on `GET /me` → `401 session_revoked`
2. Refresh twice within 30s grace window → both succeed; same `new_session_id`; no duplicate predecessor revoke

#### AC-15c: Refresh path `revoked_tokens` check

After loading session by refresh token chain, **before** rotation or grace retry:

```typescript
const [revoked] = await tx
  .select({ jti: revokedTokens.jti })
  .from(revokedTokens)
  .where(eq(revokedTokens.jti, session.jti))
  .limit(1)
if (revoked) throw new AppError('refresh_token_revoked', 'Session has been revoked', 401)
```

**Integration test:** Insert `revoked_tokens` row for session `jti` with `revoked_at` still null on session (simulated partial failure) → `POST /refresh` → `401 refresh_token_revoked`.

---

### AC-16: Audit Events

**Add to `packages/shared/src/constants/audit-events.ts`:**

```typescript
SESSION_REVOKED: 'SESSION_REVOKED',
SESSION_LIST_VIEWED: 'SESSION_LIST_VIEWED', // optional — omit if too noisy; default: omit list audit
```

**SESSION_REVOKED payload (never include jti in logs if high entropy concern — use sessionId uuid):**

```typescript
{
  sessionId: string,
  scope: 'single' | 'all_except_current' | 'admin_action' | 'logout' | 'idle_expiry',
  actorUserId: string,      // always — who triggered revoke (session.userId for idle_expiry)
  targetUserId?: string,    // admin revoke only
}
```

Write audit in **same transaction** as revoke when org-scoped context exists; use `withOrg(orgId, tx => ...)` for audit insert. Idle expiry audit (AC-10c) uses session's `org_id`.

---

### AC-17: Shared API Schemas

**Add to `packages/shared/src/schemas/auth.ts`:**

```typescript
export const SessionSummarySchema = z.object({
  sessionId: z.uuid(),
  createdAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  isCurrent: z.boolean(),
})

export const SessionListResponseSchema = z.array(SessionSummarySchema)

export const RevokeSessionsResponseSchema = z.object({
  revokedCount: z.number().int().nonnegative(),
})

export const AdminRevokeSessionsResponseSchema = z.object({
  revokedCount: z.number().int().nonnegative(),
  userId: z.uuid(),
})
```

Regenerate OpenAPI via `pnpm --filter @project-vault/api generate-spec`.

---

### AC-18: Rate Limiting

| Route | Limit |
|---|---|
| `GET /auth/sessions` | 30 req/min per user (by `sub` after auth) |
| `DELETE /auth/sessions*` | 10 req/min per user |
| `POST /auth/logout` | 30 req/min per user |
| `DELETE /org/users/:userId/sessions` | 20 req/min per admin user |

Apply **after** authentication on protected routes (key by `authContext.userId`).

---

### AC-19: Error Response Shape

Use Story 1.6 `ApiError` with `code` field — **not** epics `{ error: "session_revoked" }`:

```json
{ "code": "session_revoked", "message": "Session has been revoked" }
```

| code | HTTP | When |
|---|---|---|
| `session_revoked` | 401 | Revoked session or version mismatch |
| `session_expired` | 401 | Idle timeout |
| `session_not_found` | 404 | Unknown or unauthorized session id |
| `access_token_missing` | 401 | No cookie |
| `access_token_invalid` | 401 | Bad JWT |
| `insufficient_role` | 403 | Admin route without admin/owner |
| `user_not_found` | 404 | Target not in org |
| `service_unavailable` | 503 | DB infrastructure failure on auth path (AC-5b); bulk revoke tx failure (AC-9a) |

---

### AC-20: Optional — `MAX_SESSIONS_PER_USER` on Login

**If** `MAX_SESSIONS_PER_USER > 0` (Story 1.6 AC-36 deferred hook),
**When** new login would exceed cap,
**Then** revoke oldest sessions (by `last_active_at ASC`) until under cap **before** creating new session.

**Default `0`:** no cap — document only; implement hook if env set (low effort, high security value).

---

### AC-21: `requireOrgRole` Plugin

```typescript
export function requireOrgRole(...roles: Array<'owner' | 'admin' | 'member' | 'viewer'>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authContext) throw new AppError('access_token_missing', '...', 401)
    if (!roles.includes(request.authContext.orgRole)) {
      throw new AppError('insufficient_role', 'Insufficient permissions', 403)
    }
  }
}
```

**Admin session revoke route chain** — `requireOrgRole` checks DB-loaded `authContext.orgRole` from AC-5 step 7:

```typescript
fastify.delete('/users/:userId/sessions', {
  preHandler: [fastify.authenticate, requireOrgRole('admin', 'owner')],
  ...
})
```

---

### AC-22: Integration Tests (Real DB)

**File:** `apps/api/src/__tests__/sessions.integration.test.ts`

```typescript
describe.sequential('Session management', () => {
  // Setup: ensureVaultUnsealed, register+login helper, multi-session helper

  it('lists active sessions with isCurrent flag', ...)
  it('revokes single other session — target gets 401 on /me', ...)
  it('revoking current session clears cookies', ...)
  it('DELETE /sessions revokes all except current', ...)
  it('admin revokes all sessions for user in org', ...)
  it('member cannot call admin revoke — 403', ...)
  it('admin cannot revoke user outside org — 404', ...)
  it('session_version mismatch after revoke — 401 session_revoked', ...)
  it('revoked_tokens blocks JWT until exp window pruned', ...)
  it('idle timeout rejects refresh — 401 session_expired', ...)
  it('idle timeout rejects /me — 401 session_expired', ...)
  it('last_active_at debounced — max 1 write per 60s', ...)
  it('logout revokes current session', ...)
  it('prune-revoked-tokens deletes expired rows only', ...)
  it('pre-refresh access cookie rejected after refresh rotation', ...)
  it('refresh rotation retires predecessor session — old access cookie rejected', ...)
  it('grace window retry does not create duplicate session rows', ...)
  it('concurrent refresh and revoke — exactly one wins', ...)
  it('idle expiry cleanup is synchronous — list excludes expired session', ...)
  it('demoted admin cannot revoke sessions — live role from DB', ...)
  it('refresh succeeds when access cookie absent — predecessor via refresh chain', ...)
  it('expired access JWT rejected at authenticate', ...)
  it('idle expiry writes SESSION_REVOKED audit with idle_expiry scope', ...)
  it('refresh rejected when session jti in revoked_tokens', ...)
  it('DB error during auth lookup returns 503 not 401', ...)
  it('activity touch failure does not block authentication', ...)
  it('cleanupExpiredSession is idempotent — double call safe', ...)
  it('bulk revoke rolls back on mid-loop failure', ...)
  it('revoke selects refresh expires_at before revoking refresh rows', ...)
})
```

**Also extend `auth.integration.test.ts`:** refresh + idle interaction smoke test.

**Use `fastify.inject()` with cookie jar pattern from Story 1.6.**

**Fake timers:** `@vitest/fake-timers` for idle tests — restore after each test.

---

### AC-23: Unit Tests

| File | Coverage |
|---|---|
| `session-revoke.test.ts` | Revoke increments version, inserts revoked_tokens, revokes refresh rows, `computeRevokedTokenExpiresAt` fallback, refresh expiry selected before revoke |
| `authenticate.test.ts` | Claim validation order, debounce skip logic, debounce map eviction on revoke, expired JWT rejection, live orgRole load, DB error → 503, non-blocking activity touch |
| `prune-revoked-tokens.test.ts` | SQL delete predicate, idempotent retry after failure |
| `workers/prune-revoked-tokens.test.ts` | Handler idempotency |

**Mutation score:** ≥80% on `modules/auth/session-revoke.ts` and `plugins/authenticate.ts`.

---

### AC-24: Logging & Redaction

**Never log:** refresh tokens, access JWTs, `jti` at info level (debug ok in dev only).

**Structured log on revoke:**

```typescript
logger.info({
  eventType: 'session.revoked',
  userId,
  sessionId,
  scope: 'single',
  actorUserId: request.authContext.userId,
})
```

Extend Pino redact paths if needed — cookies already redacted from Story 1.6.

---

### AC-25: OpenAPI / generate-spec

OpenAPI includes:
- `GET /api/v1/auth/sessions`
- `DELETE /api/v1/auth/sessions`
- `DELETE /api/v1/auth/sessions/{sessionId}`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `DELETE /api/v1/org/users/{userId}/sessions`

All require cookie auth security scheme (document `cookieAuth: access-token`).

---

### AC-26: Regression — Story 1.6 Flows Unchanged

**Given** Story 1.7 complete,
**When** running Story 1.6 integration tests,
**Then** all pass without modification except:
- Refresh may need idle check — tests must keep sessions active (call `/me` or mock time)
- Optional: add shared test helper `touchSession(userId)` to prevent idle flake

---

### AC-27: Sealed Vault Behavior

Session routes return **503** when vault sealed (vault guard applies to all non-allowlist routes including `/auth/sessions`).

Allowlist remains: register, login, refresh only.

---

### AC-28: Cross-Story Export Contract for Epic 4

**Export and document:**

```typescript
// apps/api/src/modules/auth/session-revoke.ts
export async function revokeAllUserSessionsInOrg(options: {
  userId: string
  orgId: string
  actorUserId: string
  reason: 'admin_action' | 'deactivation' | 'security'
  tx?: Tx // optional — participate in caller transaction (Epic 4 deactivation)
}): Promise<{ revokedCount: number }>
```

**Epic 4.3 AC requirement:** deactivation must call this **synchronously in same transaction** — design API now to accept optional `tx`.

#### AC-28a: `revokeAllUserSessionsInOrg()` count integrity

**Given** successful completion,
**Then** returned `revokedCount` must equal the number of sessions actually revoked in the transaction.

**And** when `tx` is provided, all revokes run in caller's transaction — any failure rolls back entire caller tx.

---

### AC-29: Session List — Empty State

**Given** user with only current session,
**When** `GET /auth/sessions`,
**Then** `200` with array length 1, `isCurrent: true`.

**Given** user with zero active sessions (edge: all expired),
**Then** `200` with `[]` — not 404.

---

### AC-30: Concurrent Revoke Idempotency

**Given** two concurrent `DELETE /sessions/:sessionId` for same session,
**When** both complete,
**Then** one returns `204`, other returns `404 session_not_found` — no double audit spam (second is no-op).

Use `SELECT FOR UPDATE` on session row inside revoke transaction.

---

### AC-30b: Refresh ↔ revoke concurrency

**Given** concurrent `POST /auth/refresh` and `DELETE /auth/sessions/:sessionId` (or admin revoke) for the same session,
**When** both complete,
**Then** exactly one succeeds:

| Winner | Loser response |
|---|---|
| Revoke completes first | Refresh → `401 refresh_token_revoked` |
| Refresh completes first | Revoke → `404 session_not_found` (already rotated/revoked) |

**Implementation:** Both `refreshSession()` and `revokeSessionById()` must acquire row locks at transaction start. Refresh path: `SELECT … FOR UPDATE` on `refresh_tokens` row (Story 1.6 AC-7a/AC-21), then predecessor session row. Revoke path: `SELECT … FOR UPDATE` on target session row (AC-30). Same lock ordering when both touch the same session: refresh token row first, then session row.

**Integration test:** Fire refresh and revoke concurrently via `Promise.allSettled` — assert outcomes above, no double audit for losing revoke.

---

## Tasks / Subtasks

- [x] **Task 1: Migration & schema** (AC: 3, 4)
  - [x] `revoked_tokens` Drizzle schema + SQL migration
  - [x] Finalize `sessions.jti` NOT NULL + indexes
  - [x] Update `check-rls-coverage.ts` EXCLUDED_TABLES
- [x] **Task 2: Env config** (AC: 2, 5a, 20)
  - [x] `SESSION_IDLE_TIMEOUT_MINUTES`, debounce, `MAX_SESSIONS_PER_USER`, `JWT_MAX_CLOCK_SKEW_SECONDS`
  - [x] `.env.example` + CI check
- [x] **Task 3: Session revoke service** (AC: 4, 4a, 4b, 8, 9, 9a, 11, 12, 28, 28a, 30, 30b)
  - [x] `session-revoke.ts` with transactional revoke + audit
  - [x] `cleanupExpiredSession()` shared helper (AC-4b)
  - [x] `computeRevokedTokenExpiresAt()` helper (AC-4a)
  - [x] Export `revokeAllUserSessionsInOrg()` for Epic 4
- [x] **Task 4: Auth plugin** (AC: 5, 5a, 5b, 5c, 6, 10, 10a, 10c, 13, 21)
  - [x] `plugins/authenticate.ts` — live orgRole from DB, JWT exp/skew validation
  - [x] `plugins/require-org-role.ts`
  - [x] `GET /auth/me` route
  - [x] Extend `@types/fastify.d.ts` with AuthContext
- [x] **Task 5: Session routes** (AC: 7, 8, 9, 12, 18, 29)
  - [x] Extend `auth/routes.ts`
  - [x] Rate limits on protected auth routes
- [x] **Task 6: Org admin routes** (AC: 11, 21)
  - [x] `modules/org/routes.ts` + mount in app.ts
- [x] **Task 7: Refresh idle integration** (AC: 10, 15, 15b, 15c, 26, 30b)
  - [x] Extend `refreshSession()` — idle check, revoked_tokens check, predecessor retirement + fallback, new session row (1.6 AC-7a), grace window exception
- [x] **Task 8: pg-boss worker** (AC: 14, 14b)
  - [x] Extend `BossService` with schedule/work registration
  - [x] `workers/prune-revoked-tokens.ts`
  - [x] Wire in `main.ts` after unseal
- [x] **Task 9: Shared schemas & audit** (AC: 16, 17, 25)
  - [x] Session Zod schemas + AuditEvent constants
  - [x] Regenerate OpenAPI
- [ ] **Task 10: Tests** (AC: 22, 23, 26, 27, 30b)
  - [ ] `sessions.integration.test.ts` — include rotation, concurrency, sync cleanup tests
  - [x] Unit tests for revoke + authenticate + worker
  - [x] Verify Story 1.6 regression suite green

---

## Dev Notes

### Architecture Compliance — Critical Decisions

| Topic | Epics.md says | Architecture / 1.6 says | **Story 1.7 decision** |
|---|---|---|---|
| JWT signing | RS256 | HMAC-SHA256 (`SESSION_SECRET`) | **HMAC-SHA256** — unchanged |
| session_version location | User record | `sessions.session_version` per row | **Per session row** — increment on revoke |
| Error shape | `{ error: "..." }` | `ApiError` with `code` | **`code` field** |
| Admin role name | "Org Admin" | `org_memberships.role = 'admin'` | **`admin` or `owner`** |
| Token in JSON | `{ accessToken }` | HttpOnly cookies | **Cookies only** — list/revoke use cookies |
| sessions.org_id | Ambiguous | Kept in 1.4/1.6 with RLS | **Filter admin revoke by org_id** |
| revoked_tokens.jti type | uuid PK | TEXT in RBAC spec | **TEXT PK** (JWT jti string) |
| Auth middleware owner | Story 1.11 | Needed before 1.11 for session routes | **Implement in 1.7** — 1.11 wraps it in SecureRoute |
| Refresh rotation model | In-place `jti` update | New session row per refresh (1.6 AC-7a) | **New session row + predecessor retirement** (AC-15b, ADR-1.7-03) |

[Source: _bmad-output/implementation-artifacts/1-6-user-registration-and-password-authentication.md#Architecture-Compliance]
[Source: _bmad-output/planning-artifacts/architecture.md#Session/Token-Revocation]

---

### Architecture Decision Records (ADR)

Formal decisions for Story 1.7. Status values: **Accepted** = implement as specified; **Superseded** = replaced by later story.

#### ADR-1.7-01: `session_version` on session row (not user record)

| | |
|---|---|
| **Status** | Accepted |
| **Context** | Epics.md increments `session_version` on user record; FR83 requires per-device session management |
| **Decision** | `sessions.session_version` per row; JWT `sessionVersion` must match live value for that `jti` |
| **Consequences** | Granular revoke per device; Epic 4 bulk revoke via `revokeAllUserSessionsInOrg()` |
| **Rejected** | User-level version (over-revokes all devices); hybrid user+session (dual semantics, extra check) |

#### ADR-1.7-02: Dual-layer revocation (`revoked_tokens` + session row)

| | |
|---|---|
| **Status** | Accepted |
| **Context** | 5-minute JWT TTL means revoked access tokens remain valid until `exp` without explicit invalidation |
| **Decision** | AC-5 steps 4→5: `revoked_tokens` PK lookup first, then session row authoritative check |
| **Consequences** | Two indexed reads per authenticated request — acceptable at v1 scale (architecture.md) |
| **Rejected** | `revoked_tokens` only (misses version mismatch); session row only (orphan `jti` after rotation) |

#### ADR-1.7-03: Refresh rotation via new session row (inherits Story 1.6)

| | |
|---|---|
| **Status** | Accepted |
| **Context** | Story 1.6 AC-7a creates new `sessions` row on refresh; grace window (AC-7b) re-signs from `new_session_id` |
| **Decision** | Retire predecessor session + insert `revoked_tokens` for outgoing access `jti`; create new session row (AC-15b). Grace retry re-signs only — no duplicate rotation |
| **Consequences** | Predecessor `revoked_at` + `revoked_tokens` blocks stolen pre-refresh access cookie; rotation chain preserved |
| **Rejected** | In-place `jti` mutation (breaks 1.6 grace window and `new_session_id` chain) |

#### ADR-1.7-04: In-memory debounce map for `last_active_at`

| | |
|---|---|
| **Status** | Accepted (v1 single-instance constraint) |
| **Context** | Per-request `last_active_at` writes cause DB amplification; Redis out of v1 scope |
| **Decision** | Module-level `Map` with `SESSION_ACTIVITY_DEBOUNCE_SECONDS`; evict on revoke/idle cleanup |
| **Consequences** | Debounce state lost on restart (worst case: one extra write); incompatible with multi-instance without revisit |
| **Rejected** | Redis debounce (infra); write every request (amplification); deferred to Story 1.10+ if multi-instance |

#### ADR-1.7-05: Org-scoped admin session revocation

| | |
|---|---|
| **Status** | Accepted |
| **Context** | FR84 org admin revoke; `sessions.org_id` exists for RLS |
| **Decision** | Admin revoke filters `sessions.org_id = authContext.orgId`; user self-service list/revoke filters by `user_id` |
| **Consequences** | Org admin cannot revoke sessions in other orgs; forward-compatible with multi-org |
| **Rejected** | Global user-scoped admin revoke (cross-org privilege escalation risk) |

#### ADR-1.7-06: Auth middleware in 1.7, SecureRoute wrapper in 1.11

| | |
|---|---|
| **Status** | Accepted |
| **Context** | Session routes, MFA (1.8), and `/auth/me` need auth before SecureRoute factory exists |
| **Decision** | Implement `authenticate` plugin in 1.7; Story 1.11 wraps — does not duplicate JWT validation |
| **Consequences** | Two stories touch auth pipeline; export contract prevents drift |
| **Rejected** | Defer middleware to 1.11 (blocks 1.7 and 1.8 entirely) |

#### ADR-1.7-07: Live `orgRole` from database (not JWT claim)

| | |
|---|---|
| **Status** | Accepted |
| **Context** | JWT TTL up to 5 min; role demotion must take effect on next authenticated request, not at JWT expiry |
| **Decision** | AC-5 step 7 loads `orgRole` from `org_memberships.role`; `requireOrgRole` checks `authContext.orgRole` from DB |
| **Consequences** | Demoted admin blocked immediately on admin routes; one extra column read in membership query (already required for deactivation check) |
| **Rejected** | Trust JWT role claim (5-minute privilege escalation window after demotion) |

---

### Session Revoke Transaction Pattern

```typescript
export async function revokeSessionById(
  sessionId: string,
  options: { actorUserId: string; reason: string; accessTokenExp?: Date; tx?: Tx }
): Promise<void> {
  const run = async (tx: Tx) => {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('update')

    if (!session || session.revokedAt) return // idempotent

    const [activeRefresh] = await tx
      .select({ expiresAt: refreshTokens.expiresAt })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)))
      .limit(1)

    await tx.update(sessions)
      .set({
        revokedAt: new Date(),
        sessionVersion: session.sessionVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, sessionId))

    await tx.update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)))

    await tx.insert(revokedTokens).values({
      jti: session.jti,
      userId: session.userId,
      expiresAt: computeRevokedTokenExpiresAt({
        accessTokenExp: options.accessTokenExp,
        refreshTokenExpiresAt: activeRefresh?.expiresAt,
      }),
    }).onConflictDoNothing()

    await writeAuditEntry(tx, {
      orgId: session.orgId,
      eventType: AuditEvent.SESSION_REVOKED,
      // ...
    })
  }

  if (options.tx) return run(options.tx)
  return getDb().transaction(run)
}
```

---

### Authenticate Plugin Registration

```typescript
// apps/api/src/plugins/authenticate.ts
import fp from 'fastify-plugin'

export default fp(async (fastify) => {
  fastify.decorate('authenticate', async (request, reply) => {
    // AC-5 steps 1–9
  })
}, { name: 'authenticate', dependencies: ['@fastify/jwt', '@fastify/cookie'] })
```

---

### BossService Extension Pattern

```typescript
// apps/api/src/lib/boss.ts — extend without breaking 1.2 tests
export class BossService {
  // ... existing start/stop ...

  async registerWorkers(handlers: Record<string, () => Promise<void>>): Promise<void> {
    if (!this.#boss) throw new Error('BossService not started')
    for (const [name, handler] of Object.entries(handlers)) {
      await (this.#boss as PgBoss).work(name, handler)
    }
  }

  async registerSchedules(schedules: Record<string, { cron: string; jobId?: string }>): Promise<void> {
    if (!this.#boss) throw new Error('BossService not started')
    for (const [name, { cron }] of Object.entries(schedules)) {
      await (this.#boss as PgBoss).schedule(name, cron, null, { tz: 'UTC' })
    }
  }
}
```

Call from `main.ts`:

```typescript
setOnVaultUnsealed(async () => {
  await boss.start()
  await boss.registerSchedules({ 'prune-revoked-tokens': { cron: '0 * * * *' } })
  await boss.registerWorkers({ 'prune-revoked-tokens': pruneRevokedTokensHandler })
})
```

---

### Query Patterns — Sessions Are Identity-Scoped

**List sessions for user** — platform transaction (sessions have org_id but user owns rows across orgs in v1 single-org):

```typescript
const rows = await getDb()
  .select({ ... })
  .from(sessions)
  .innerJoin(refreshTokens, eq(refreshTokens.sessionId, sessions.id))
  .where(and(
    eq(sessions.userId, userId),
    isNull(sessions.revokedAt),
    isNull(refreshTokens.revokedAt),
    gt(refreshTokens.expiresAt, new Date()),
  ))
```

**Admin revoke** — add `eq(sessions.orgId, orgId)`.

**Only `modules/auth/` and `modules/org/`** may query `sessions` and `refresh_tokens` directly.

---

### Project Structure Notes

| What | Where |
|---|---|
| Auth middleware | `apps/api/src/plugins/authenticate.ts` |
| Role gate | `apps/api/src/plugins/require-org-role.ts` |
| Revoke logic | `apps/api/src/modules/auth/session-revoke.ts` |
| Session routes | `apps/api/src/modules/auth/routes.ts` |
| Org admin routes | `apps/api/src/modules/org/routes.ts` |
| Cleanup worker | `apps/api/src/workers/prune-revoked-tokens.ts` |
| revoked_tokens schema | `packages/db/src/schema/revoked-tokens.ts` |
| Session schemas | `packages/shared/src/schemas/auth.ts` |
| Integration tests | `apps/api/src/__tests__/sessions.integration.test.ts` |

**Do NOT** implement SvelteKit sessions UI — backend-only story.

---

### Testing Standards

- **Real PostgreSQL** — `vault_app` role, same as Story 1.4/1.6
- **Vitest** `describe.sequential` — session tests mutate shared user state
- **Multi-session helper:**

```typescript
async function loginAs(email: string, password: string, label: string): Promise<CookieJar> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } })
  return parseCookies(res, label)
}
```

- **Fake timers** for idle timeout — set `SESSION_IDLE_TIMEOUT_MINUTES=1` in test env overlay
- **Cleanup order:** `revoked_tokens` → `refresh_tokens` → `sessions` → (rest from 1.6)
- **RLS audit deletes:** wrap in `withOrg(orgId, ...)` per Story 1.4 learnings

[Source: _bmad-output/implementation-artifacts/1-6-user-registration-and-password-authentication.md#Testing-Standards]

---

### Previous Story Intelligence

#### From Story 1.6 (Auth Foundation)

- JWT payload: `{ sub, orgId, jti, sessionVersion, iat, exp }` — HS256, cookie `access-token`
- Refresh token in cookie `refresh-token`, path `/api/v1/auth/refresh`
- `sessions.jti` set on every login/refresh rotation
- `refresh_tokens` table with HMAC hash — query only from auth service
- Error shape uses `code` not `error`
- POST-only auth routes — extend to logout
- Cookie clear pattern on login — reuse for revoke-current/logout
- `AUTH_DUMMY_PASSWORD_HASH`, timing-safe patterns — do not regress

#### From Story 1.5 (Vault)

- pg-boss starts only after unseal — worker registration must happen inside `setOnVaultUnsealed`
- Audit HMAC via `getAuditKey()` + `write-entry.ts`

#### From Story 1.4 (Database)

- Table: `org_memberships` roles: `owner`, `admin`, `member`, `viewer`
- `sessions` has `org_id` + RLS — but auth queries use platform path for jti lookup
- `audit_log_entries` not `audit_events`

#### From Story 1.2 (BossService)

- Single integration point for pg-boss — extend `BossService`, do not instantiate PgBoss elsewhere

---

### Git Intelligence

Branch `feature/1-5-vault-initialization-and-master-key-management` has vault modules and crypto in progress; Story 1.6 file is `ready-for-dev` but auth module may not be merged yet.

**Before starting 1.7:** verify Story 1.6 implementation exists (`apps/api/src/modules/auth/`). If missing, complete 1.6 first — 1.7 is not standalone.

Recent commits focus on database foundation (1.4) and vault (1.5) — session story builds on auth module from 1.6 spec.

---

### Latest Technical Notes

**pg-boss 12.18.2:** `schedule(name, cron, data, options)` + `work(name, handler)`. Cron uses standard 5-field syntax. Timezone via `{ tz: 'UTC' }`.

**@fastify/jwt v9:** Read cookie via `request.cookies['access-token']` then `fastify.jwt.verify(token)`. Do not accept `Authorization: Bearer` for browser session routes in v1.

**Drizzle 0.45.x:** Use `.for('update')` on revoke for concurrency (AC-30).

---

### Accepted Security Risks (v1)

| Risk | Mitigation | Owner |
|---|---|---|
| Debounce map is in-memory (lost on restart) | Worst case: extra `last_active_at` write after restart | 1.7 |
| Up to 5 min JWT usable without revoked_tokens insert if revoke tx fails | Revoke + revoked_tokens in same transaction | 1.7 |
| No CSRF token on session DELETE | SameSite=Strict + CORS allowlist | Architecture |
| Admin sees user session IP/UA | By design for FR83/FR84 security UX | Product |
| `session:cleanup` deferred | Expired rows accumulate until 1.10 | 1.10 |
| Refresh-only activity keeps session alive | Refresh updates `last_active_at` (AC-15); true idle requires no refresh **and** no authenticated API calls. Max absolute session TTL deferred to Story 1.10 | 1.7 doc / 1.10 |
| Per-session refresh rate not capped beyond IP limit | Story 1.6 caps refresh at 120/min per IP; per-session cap deferred to Story 1.9 failed-auth / anomaly detection | 1.9 |

---

### Out of Scope (Explicit)

| Item | Owner story |
|---|---|
| SecureRoute factory + ESLint `no-raw-fastify-route` | 1.11 |
| MFA-protected session routes | 1.8, 1.12 |
| SvelteKit sessions settings UI | Architecture step 7 / Epic 4 UI |
| Account deactivation calling revoke | Epic 4.3 (API exported here) |
| `session:cleanup` pg-boss worker | 1.10 |
| `failed_auth_attempts` threshold | 1.9 |
| Machine user JWT revocation | Epic 7 |
| Redis-backed session store | Not planned v1 |

---

### Anti-Patterns (Do Not)

- Add `users.session_version` column — use per-session version
- Validate JWT only in route handlers — centralize in `authenticate` plugin
- Skip `revoked_tokens` insert on revoke — breaks immediate invalidation
- Use `{ error: 'session_revoked' }` — use `{ code: 'session_revoked' }`
- Query `sessions`/`refresh_tokens` from non-auth modules
- Run idle check only on refresh — also enforce in authenticate middleware
- Block revoke transaction waiting for pg-boss prune job
- Use RS256 or store JWT keys in vault_state
- Return 403 for wrong-user session id — use 404 (no enumeration)
- Allow member/viewer to call admin session revoke
- Register prune job before vault unsealed
- Store raw JWT in `revoked_tokens` — store `jti` only
- Update `last_active_at` on every request without debounce — write amplification
- Implement full org user management — only `DELETE .../sessions` in this story
- Issue new access `jti` on refresh without revoking previous access `jti` (AC-15b)
- Mutate session `jti` in-place on refresh — use Story 1.6 new-row rotation + predecessor retirement (ADR-1.7-03)
- Return `401 session_expired` before session/refresh cleanup completes (AC-10c)
- Use victim's unknown JWT `exp` without AC-4a fallback for remote revoke
- Fire-and-forget idle cleanup — always await `cleanupExpiredSession()`
- Trust JWT `orgRole` claim for authorization — always load from `org_memberships` (AC-5 step 7)
- Resolve refresh predecessor only via access cookie — fallback to refresh token chain (AC-15b step 1b)
- Skip `revoked_tokens` check on refresh path (AC-15c)
- Return `401` for DB infrastructure failures on auth path — use `503 service_unavailable` (AC-5b)
- Query refresh token expiry after setting `revoked_at` on refresh rows — select **before** revoke
- Fail authentication when debounced `last_active_at` write fails — log and continue (AC-5c)
- Partial bulk revoke without transaction rollback (AC-9a)

---

### Manual QA Checklist

```bash
# 1. Login from two browsers; list sessions
curl -s -b cookies-a.txt http://localhost:3000/api/v1/auth/sessions | jq '.data[] | {sessionId,isCurrent}'

# 2. Revoke other session; verify 401 on other browser
curl -s -b cookies-b.txt http://localhost:3000/api/v1/auth/me
# → 401 session_revoked

# 3. Logout clears cookies
curl -s -D - -b cookies-a.txt -X POST http://localhost:3000/api/v1/auth/logout | grep -i set-cookie

# 4. Admin revoke (as owner)
curl -s -b owner.txt -X DELETE http://localhost:3000/api/v1/org/users/USER_UUID/sessions | jq .

# 5. Member denied
curl -s -w '\nHTTP %{http_code}\n' -b member.txt -X DELETE \
  http://localhost:3000/api/v1/org/users/USER_UUID/sessions
# → 403
```

---

### References

- Epic AC: [_bmad-output/planning-artifacts/epics.md#Story-1.7-JWT-Session-Management--Security-Controls_]
- FR83–FR85: [_bmad-output/planning-artifacts/prd.md#Functional-Requirements_]
- Session revocation architecture: [_bmad-output/planning-artifacts/architecture.md#Session/Token-Revocation_]
- revoked_tokens research: [specs/rbac-permission-architecture.md#JWT-revocation-list_]
- Story 1.6 auth patterns: [_bmad-output/implementation-artifacts/1-6-user-registration-and-password-authentication.md_]
- BossService lifecycle: [_bmad-output/implementation-artifacts/1-5-vault-initialization-and-master-key-management.md#AC-29_]
- Epic 4 deactivation dependency: [_bmad-output/planning-artifacts/epics.md#Story-4.3_]
- org_memberships roles: [packages/db/src/schema/org-memberships.ts]

---

## Dev Agent Record

### Agent Model Used

GPT-5.5

### Debug Log References
- 2026-06-26: `pnpm --filter @project-vault/db exec vitest run src/schema/auth-sessions-schema.test.ts` failed before Task 1 implementation on missing `revokedTokens` export, then passed after adding schema/export/RLS exception.
- 2026-06-26: `pnpm --filter @project-vault/db db:migrate` passed after adding `0007_session_revocation.sql`.
- 2026-06-26: `pnpm --filter @project-vault/db test` still fails on pre-existing local RLS/permission expectation failures (`rls-isolation`, `audit-log-immutability`, `api-instances-privileges`); Story 1.7 schema-specific failures were fixed by adding `jti` values to legacy session test fixtures.
- 2026-06-26: `pnpm --filter @project-vault/api exec vitest run src/config/env.test.ts` failed before Task 2 implementation on missing Story 1.7 session controls, then passed after adding env schema validation.
- 2026-06-26: `pnpm exec tsx scripts/check-env-example.ts` passed after adding Story 1.7 env keys to `.env.example`.
- 2026-06-26: `pnpm --filter @project-vault/api exec vitest run src/modules/auth/session-revoke.test.ts` failed before Task 3 implementation on missing `session-revoke.ts`, then passed after adding revoke helper/service.
- 2026-06-26: `pnpm --filter @project-vault/shared exec vitest run src/constants/audit-events.test.ts` passed after adding `SESSION_REVOKED`.
- 2026-06-26: `pnpm --filter @project-vault/db build`, `pnpm --filter @project-vault/shared build`, and `pnpm --filter @project-vault/api typecheck` passed after refreshing package declarations.
- 2026-06-26: `pnpm --filter @project-vault/api exec vitest run src/plugins/authenticate.test.ts` failed before Task 4 implementation with `/auth/me` 404, then passed after adding authenticate plugin and route.
- 2026-06-26: `pnpm --filter @project-vault/api typecheck` passed after adding auth middleware/types and aligning vault-guard plugin typing.
- 2026-06-26: `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api exec vitest run src/modules/auth/tokens.test.ts src/modules/auth/routes.test.ts` passed.
- 2026-06-26: `pnpm --filter @project-vault/api exec vitest run src/plugins/vault-guard.test.ts` passed.
- 2026-06-26: `pnpm --filter @project-vault/api typecheck` passed after adding session management routes.
- 2026-06-26: `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api exec vitest run src/modules/auth/routes.test.ts src/plugins/authenticate.test.ts` passed after Task 5 route wiring.
- 2026-06-26: `pnpm --filter @project-vault/api typecheck` passed after adding org admin session revocation route.
- 2026-06-26: `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api exec vitest run src/plugins/authenticate.test.ts src/modules/auth/routes.test.ts` passed after mounting org routes.
- 2026-06-26: `pnpm --filter @project-vault/api typecheck` passed after refresh idle/revoked-token/predecessor-retirement integration.
- 2026-06-26: `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api exec vitest run src/modules/auth/tokens.test.ts src/modules/auth/routes.test.ts src/plugins/authenticate.test.ts` passed after Task 7 changes.
- 2026-06-26: `pnpm --filter @project-vault/api exec vitest run src/lib/boss.test.ts` passed after adding schedule/worker registration coverage.
- 2026-06-26: `pnpm --filter @project-vault/api typecheck` passed after adding `prune-revoked-tokens` worker and unseal lifecycle registration.
- 2026-06-26: `pnpm --filter @project-vault/shared exec vitest run src/schemas/auth.test.ts src/constants/audit-events.test.ts` passed after adding Story 1.7 shared schemas and audit constant.
- 2026-06-26: `pnpm --filter @project-vault/shared build`, `pnpm --filter @project-vault/api typecheck`, and `pnpm --filter @project-vault/api generate-spec` passed after Task 9 changes.
- 2026-06-26: `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/api test` passed: 22 files passed, 98 tests passed, 1 route-audit todo skipped.
- 2026-06-26: `pnpm --filter @project-vault/shared test` passed: 3 files passed, 11 tests passed.
- 2026-06-26: `pnpm --filter @project-vault/db exec vitest run src/schema/auth-sessions-schema.test.ts` passed.
- 2026-06-26: Full `pnpm --filter @project-vault/db test` remains blocked by local pre-existing RLS/permission expectation failures unrelated to Story 1.7 schema (`rls-isolation`, `audit-log-immutability`, `api-instances-privileges`).

### Completion Notes List
- Task 1 complete: added `revoked_tokens` Drizzle schema/migration, enforced non-null `sessions.jti`, added session indexes, and registered `revoked_tokens` as an intentional RLS coverage exception.
- Task 2 complete: added idle timeout, activity debounce, max-session cap, and JWT clock-skew env controls with defaults and bounds.
- Task 3 complete: added transaction-aware session revocation helpers, revoked-token expiry calculation, refresh-token/session retirement, same-transaction audit writing, idle cleanup, and Epic 4 org-scoped bulk revoke export.
- Task 4 complete: added reusable authenticate plugin, live org role lookup, revoked token/session/idle checks, debounced activity touch, role guard helper, typed `authContext`, and protected `/auth/me`.
- Task 5 complete: added authenticated session list, revoke single/current, revoke all other sessions, logout handlers, and route-level rate limit configuration.
- Task 6 complete: added org admin route `DELETE /api/v1/org/users/:userId/sessions` with live role guard, target membership check, org-scoped bulk revoke, and app mount.
- Task 7 complete: refresh now checks `revoked_tokens`, synchronously cleans idle sessions, retires predecessor sessions during full rotation, inserts predecessor `revoked_tokens`, and preserves grace-window retry.
- Task 8 complete: extended BossService with schedule/worker registration, added hourly revoked-token pruning worker, and registered it after vault unseal/restart-unsealed startup.
- Task 9 complete: added shared session management schemas, added `SESSION_REVOKED`, and regenerated OpenAPI with all Story 1.7 protected endpoints and cookie auth security scheme.
- Task 10 partially complete: focused unit tests, API regression suite, shared suite, and db schema regression pass; dedicated real-DB `sessions.integration.test.ts` lifecycle/concurrency coverage remains outstanding.

### File List

**Expected new/modified files:**

| File | Action |
|---|---|
| `packages/db/src/schema/revoked-tokens.ts` | CREATE |
| `packages/db/src/schema/sessions.ts` | MODIFY — jti, revokedAt |
| `packages/db/src/migrations/0007_session_revocation.sql` | CREATE |
| `packages/db/src/check-rls-coverage.ts` | MODIFY — EXCLUDED_TABLES |
| `packages/shared/src/schemas/auth.ts` | MODIFY — session schemas |
| `packages/shared/src/constants/audit-events.ts` | MODIFY — SESSION_REVOKED |
| `apps/api/src/config/env.ts` | MODIFY — idle timeout vars |
| `apps/api/src/plugins/authenticate.ts` | CREATE |
| `apps/api/src/plugins/require-org-role.ts` | CREATE |
| `apps/api/src/modules/auth/session-revoke.ts` | CREATE |
| `apps/api/src/modules/auth/routes.ts` | MODIFY |
| `apps/api/src/modules/auth/service.ts` | MODIFY — list/revoke/logout, refresh idle |
| `apps/api/src/modules/auth/schema.ts` | MODIFY |
| `apps/api/src/modules/org/routes.ts` | CREATE |
| `apps/api/src/modules/org/schema.ts` | CREATE |
| `apps/api/src/workers/prune-revoked-tokens.ts` | CREATE |
| `apps/api/src/lib/boss.ts` | MODIFY — registerWorkers/Schedules |
| `apps/api/src/@types/fastify.d.ts` | MODIFY — AuthContext |
| `apps/api/src/app.ts` | MODIFY — register plugins + org routes |
| `apps/api/src/main.ts` | MODIFY — worker registration |
| `apps/api/src/__tests__/sessions.integration.test.ts` | CREATE |
| `apps/api/src/modules/auth/session-revoke.test.ts` | CREATE |
| `apps/api/src/plugins/authenticate.test.ts` | CREATE |
| `apps/api/src/workers/prune-revoked-tokens.test.ts` | CREATE |
| `.env.example` | MODIFY |
| `packages/shared/openapi.json` | MODIFY — via generate-spec |

---

*Ultimate context engine analysis completed — comprehensive developer guide created.*
