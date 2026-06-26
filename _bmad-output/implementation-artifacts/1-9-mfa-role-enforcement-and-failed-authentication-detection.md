# Story 1.9: MFA Role Enforcement & Failed Authentication Detection

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-06-24 — comprehensive developer guide for MFA role enforcement (FR57), failed authentication recording and threshold alerting (FR73), grace period handling, pg-boss detection/prune jobs, PENDING_DELIVERY security alerts, and admin visibility API. Addresses MQ-2 (PENDING_DELIVERY visibility) and MQ-3 (FR57 test boundary via mock privileged endpoint). Red Team hardening, PRD dual-threshold (IP + account), and architecture conflict resolution applied. Challenge from Critical Perspective applied 2026-06-24 (preHandler order, NFKC normalization, dedup spec, tier deferral, ADR-1.9-05). Red Team vs Blue Team applied 2026-06-24 (AC-5b route retrofit, MFA-exempt allowlist, route-audit CI, prod recording guard). Security Audit Personas applied 2026-06-24 (AC-5c/d, AC-9d, AC-11b, AC-19 compliance matrix, audit trail, payload validation). -->

## Story

As an organization owner or admin,
I want MFA to be required before my role grants me the ability to perform privileged actions, and failed authentication attempts to be detected and flagged,
so that privileged accounts are protected by a second factor before they can expand access, and brute-force attacks are visible to org administrators.

*Covers: FR57, FR73* [Source: _bmad-output/planning-artifacts/prd.md#Functional-Requirements]

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 1.6 complete — register, login, refresh | Failed auth recording hooks into `loginUser()`; registration sets owner grace period |
| Story 1.7 complete — `authenticate` plugin, `requireOrgRole`, `AuthContext` with live `orgRole` | MFA enforcement runs after auth; role loaded from DB not JWT |
| Story 1.8 complete — `users.mfa_enrolled_at`, MFA enrollment routes | Enforcement checks `mfa_enrolled_at IS NOT NULL` |
| Story 1.4 complete — `org_memberships.grace_period_expires_at`, `security_alerts` | Grace period column pre-exists; alert destination table exists |
| Story 1.5 complete — vault unsealed, `BossService` via `setOnVaultUnsealed` | pg-boss jobs register after unseal |
| Story 1.2 complete — `BossService` lifecycle | Scheduled threshold + prune workers |
| Real PostgreSQL in integration tests | No DB mocks for failed-auth or MFA enforcement flows |

### Epic Cross-Story Context

| Story | Relationship to 1.9 |
|---|---|
| 1.6 | Login failure path — wire `recordFailedAuthAttempt()` on `401 invalid_credentials`; registration sets `grace_period_expires_at` for new owner |
| 1.7 | MFA enforcement is a **new preHandler after** `authenticate`; extends `/auth/me` with MFA grace status; **retrofits** `DELETE /org/users/:userId/sessions` with `requireMfaEnrollment()` (AC-5b) |
| 1.8 | Invalid TOTP on verify-enrollment/regenerate — record failed attempt; invalid recovery code on `/mfa/recover` — record failed attempt; export recorder for 1.12 |
| 1.10 | Structured logging — threshold job emits `eventType: 'alert.pending_epic3'`; full Pino config deferred |
| 1.11 | **Consumes** `requireMfaEnrollment()` and `SecureRouteOptions.requireMfa` contract defined here — do not duplicate MFA check in 1.11 |
| 1.12 | `POST /auth/mfa/verify-login` invalid TOTP calls exported `recordFailedAuthAttempt()` — implement export in 1.9, wire in 1.12 |
| 4.1 | Real privileged endpoints (invite members) — Epic 4 verifies business rule; 1.9 verifies enforcement mechanism via mock endpoint (MQ-3) |
| Epic 3 | Delivers `PENDING_DELIVERY` alerts via email/Slack — 1.9 creates rows + admin list API until Epic 3 ships |

---

## Architecture Conflict Resolution (Read Before Coding)

| Source wording | Canonical implementation | Rationale |
|---|---|---|
| Epics: `403 { error: "mfa_required" }` | `403 { code: "mfa_required", message: "..." }` | Story 1.6+ error shape uses `code` not `error` |
| Architecture: `403 MFA_ENROLLMENT_REQUIRED` | `code: "mfa_required"` | Map architecture enum to epics story AC code string |
| Epics: `organization_members.grace_period_expires_at` | `org_memberships.grace_period_expires_at` | Story 1.4 canonical table name |
| Architecture: roles `OrgAdmin` / `Owner` | DB values `'admin'` / `'owner'` | `org_memberships_role_check` constraint |
| Epics: `security.failed_auth_threshold` event | `alert_type: 'security.failed_auth_threshold'` | Matches existing `security_alerts.alert_type` text pattern |
| Epics AC: IP threshold only | **IP + account thresholds** | PRD FR73: "single account **or** IP address" — both required |
| Epics: middleware at SecureRoute constructor | Implement `requireMfaEnrollment()` preHandler **now**; Story 1.11 wraps into `SecureRoute({ requireMfa: true })` | 1.11 not yet implemented — export contract early |
| Architecture: MFA check in auth middleware not route handlers | Single `requireMfaEnrollment()` function — never inline per-route MFA logic | Architecture anti-pattern prevention |
| FR57: Team/Small Company tiers only | v1: enforce for all orgs where `orgRole IN ('owner','admin')` | Tier model not in schema yet; defer tier gate to subscription/tier story — **known v1 overshoot** |
| Epics AC-E1c: block at login after grace | Enforce at **privileged route** via `requireMfaEnrollment()`; hard login gate in Story 1.12 | Route-level enforcement matches SecureRoute pattern; see ADR-1.9-05 |
| Story 1.6 NFKC email normalization | Import shared `normalizeEmail()` from `./normalize.ts` — **do not** use NFC | Threshold email grouping must match login storage normalization |

---

## Acceptance Criteria

### AC Quick Reference

| Component | Trigger | Success | Key errors |
|---|---|---|---|
| `requireMfaEnrollment()` | Owner/admin, no MFA, grace expired | `next()` | `403 mfa_required` |
| Grace period active | Owner/admin, no MFA, grace not expired | Request proceeds + banner metadata | — |
| `recordFailedAuthAttempt()` | Any auth failure reason | Row inserted (best effort) | Never fails HTTP response |
| Threshold job | ≥10 failures / window per IP **or** account | `security_alerts` row + log | Dedup within window |
| `GET /org/security-alerts` | Owner/admin auth | Paginated alerts | `403 insufficient_role` |
| Mock privileged route (tests) | `requireMfa: true` chain | `200` when MFA enrolled | `403 mfa_required` when not |

---

### AC-1: Module Structure & File Layout

**Given** Stories 1.6–1.8 auth module exists,
**When** Story 1.9 is complete,
**Then** add security enforcement module files:

```
apps/api/src/modules/auth/
├── failed-auth.ts              # NEW: recordFailedAuthAttempt() — imports normalizeEmail() from ./normalize.ts
├── mfa-enforcement.ts          # NEW: requireMfaEnrollment(), isMfaEnforcementActive(), computeMfaStatus()
├── grace-period.ts             # NEW: setGracePeriodOnPrivilegedRole(), GRACE_PERIOD_DAYS constant
├── routes.ts                   # MODIFY: wire failed-auth into login; extend GET /me
└── service.ts                  # MODIFY: loginUser() calls recordFailedAuthAttempt on failure

apps/api/src/modules/org/
├── routes.ts                   # ADD: GET /security-alerts; MODIFY: DELETE /users/:userId/sessions — add requireMfaEnrollment (AC-5b)
├── security-alerts.ts          # NEW: listSecurityAlerts(), createThresholdAlert()
└── schema.ts                   # ADD: security alert list query/response + failedAuthThresholdPayloadSchema (AC-11b)

apps/api/src/plugins/
└── require-mfa-enrollment.ts   # NEW: Fastify plugin wrapping mfa-enforcement (optional decorate)

apps/api/src/lib/
└── secure-route.ts             # MODIFY: export SecureRouteOptions type + requireMfa flag contract (stub — full factory in 1.11)

apps/api/src/workers/
├── check-failed-auth-threshold.ts   # NEW: pg-boss — every 60s
└── prune-failed-auth-attempts.ts    # NEW: pg-boss — daily 02:00 UTC

apps/api/src/__tests__/helpers/
└── privileged-test-route.ts    # NEW: registers mock requireMfa endpoint for integration tests only

packages/db/src/schema/
└── failed-auth-attempts.ts     # NEW: platform-scoped table (no org_id)

packages/shared/src/constants/
├── security-alert-types.ts     # NEW: FAILED_AUTH_THRESHOLD, etc.
├── mfa-exempt-routes.ts        # NEW: MFA_ENROLLMENT_EXEMPT_ROUTES (AC-5c)
└── audit-events.ts             # MODIFY: ADD SECURITY_FAILED_AUTH_THRESHOLD (AC-9d)
```

**And** export `recordFailedAuthAttempt` from `apps/api/src/modules/auth/failed-auth.ts` for Story 1.12 import — **do not** make it an internal-only function.

**And** **no REST route** exposes `failed_auth_attempts` to tenants — platform workers and test helpers only (AC-16).

**And** update `route-audit.test.ts`:

| Route | Auth | Notes |
|---|---|---|
| `GET /api/v1/org/security-alerts` | Yes + owner/admin | MFA-exempt (ADR-1.9-04) |
| `DELETE /api/v1/org/users/:userId/sessions` | Yes + owner/admin + **requireMfa** | Retrofit in AC-5b |
| Mock privileged route | Test helper only | Never registered in production `createApp()` / `main.ts` |

**And** `route-audit.test.ts` must fail CI when:

- Any route uses `requireOrgRole` including `owner` or `admin` without `requireMfaEnrollment()` unless listed in `MFA_ENROLLMENT_EXEMPT_ROUTES` (AC-5c)
- `privileged-test-route` is imported from production `app.ts` or `main.ts`
- Any route exposes `failed_auth_attempts` data to tenants

---

### AC-2: Environment Variables

**Add to `apps/api/src/config/env.ts`:**

| Variable | Type | Default | Validation |
|---|---|---|---|
| `MFA_PRIVILEGED_ROLE_GRACE_DAYS` | number | `7` | Min `0`, max `30` — `0` = immediate enforcement (test/prod override) |
| `FAILED_AUTH_THRESHOLD_COUNT` | number | `10` | Min `3`, max `100` |
| `FAILED_AUTH_THRESHOLD_WINDOW_SECONDS` | number | `300` | Min `60`, max `3600` (5 min default) |
| `FAILED_AUTH_RETENTION_HOURS` | number | `24` | Min `1`, max `168` — prune job deletes older rows |
| `FAILED_AUTH_RECORD_ENABLED` | boolean | `true` | When `false`, skip inserts (load test escape hatch) |

**And** update `.env.example` + `scripts/check-env-example.ts`.

**Production guards:**

- Reject `FAILED_AUTH_THRESHOLD_COUNT < 3`
- Reject `MFA_PRIVILEGED_ROLE_GRACE_DAYS < 0`
- Reject startup when `NODE_ENV=production` and `FAILED_AUTH_RECORD_ENABLED=false` (load-test toggle must not ship to prod)

**When `MFA_PRIVILEGED_ROLE_GRACE_DAYS=0`:**

- Set `grace_period_expires_at = NOW()` at registration (not NULL) — enforcement active immediately after registration
- `/auth/me` returns `gracePeriodActive: false`, `enrollmentRequired: true` for new owner without MFA
- Integration test: owner blocked on mock privileged route immediately after register (see AC-14)

**Example `.env.example` snippet:**

```bash
# Story 1.9 — MFA enforcement & failed auth detection
MFA_PRIVILEGED_ROLE_GRACE_DAYS=7
FAILED_AUTH_THRESHOLD_COUNT=10
FAILED_AUTH_THRESHOLD_WINDOW_SECONDS=300
FAILED_AUTH_RETENTION_HOURS=24
FAILED_AUTH_RECORD_ENABLED=true
```

---

### AC-3: Database Migration — `failed_auth_attempts`

**Given** Story 1.8 migrations applied,
**When** `pnpm --filter @project-vault/db db:migrate` runs,
**Then** the next sequential migration after Story 1.8 migrations applies (verify `_journal.json` before naming — e.g. `0006_failed_auth_attempts.sql` or higher):

```sql
CREATE TABLE failed_auth_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  ip_address      INET NOT NULL,
  attempted_email TEXT NOT NULL,
  reason          TEXT NOT NULL
                    CHECK (reason IN (
                      'invalid_credentials',
                      'invalid_totp',
                      'invalid_recovery_code',
                      'expired_recovery_code'
                    )),
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_failed_auth_attempts_ip_time
  ON failed_auth_attempts (ip_address, attempted_at DESC);

CREATE INDEX idx_failed_auth_attempts_user_time
  ON failed_auth_attempts (user_id, attempted_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX idx_failed_auth_attempts_email_time
  ON failed_auth_attempts (lower(attempted_email), attempted_at DESC);

CREATE INDEX idx_failed_auth_attempts_prune
  ON failed_auth_attempts (attempted_at);
```

**RLS policy:** **None** — platform-scoped telemetry table (same class as `sessions` / `refresh_tokens` RLS exceptions). Access **only** via:

- `recordFailedAuthAttempt()` — insert using platform DB connection (no `withOrg()`)
- Threshold/prune workers — platform context via `withAdminAccess()` or dedicated platform tx helper
- Integration tests — direct insert for seeding threshold scenarios

**Add to `packages/db/scripts/check-rls-coverage.ts` allow-list:**

```typescript
const RLS_EXCEPTION_TABLES = [
  // ... existing ...
  'failed_auth_attempts',
]
```

**Drizzle schema:** `packages/db/src/schema/failed-auth-attempts.ts` — export `failedAuthAttempts` table; add to `schema/index.ts`.

**Access boundary:** No tenant-facing REST endpoint reads or lists `failed_auth_attempts` — workers, `recordFailedAuthAttempt()`, and integration test seed helpers only.

---

### AC-4: Grace Period Semantics

**Given** `org_memberships.grace_period_expires_at` exists (Story 1.4),
**When** a user receives `owner` or `admin` role **and** `users.mfa_enrolled_at IS NULL`,
**Then** set:

```typescript
grace_period_expires_at =
  MFA_PRIVILEGED_ROLE_GRACE_DAYS === 0
    ? now()
    : now() + MFA_PRIVILEGED_ROLE_GRACE_DAYS * 86400 * 1000
```

**Set grace period in these code paths (Story 1.9):**

| Event | Location | Behavior |
|---|---|---|
| Registration (first user = owner) | `registerUser()` in `service.ts` | Set grace on `org_memberships` insert |
| Role promotion to owner/admin | `setGracePeriodOnPrivilegedRole()` exported helper | Epic 4 calls this — implement now, wire in 1.9 register only |

**Do NOT set grace period when:**

- User already has `mfa_enrolled_at IS NOT NULL` at assignment time
- Role is `member` or `viewer`
- Grace already set and role unchanged (idempotent — do not extend on every login)

**Enforcement decision tree:**

```typescript
export function isMfaEnforcementActive(
  orgRole: 'owner' | 'admin' | 'member' | 'viewer',
  mfaEnrolledAt: Date | null,
  gracePeriodExpiresAt: Date | null,
  now = new Date()
): boolean {
  if (orgRole !== 'owner' && orgRole !== 'admin') return false
  if (mfaEnrolledAt !== null) return false
  if (gracePeriodExpiresAt !== null && gracePeriodExpiresAt > now) return false
  return true
}
```

**Examples:**

| Role | MFA enrolled | Grace expires | Enforcement active? |
|---|---|---|---|
| `owner` | No | `now + 5 days` | **No** (grace) |
| `owner` | No | `now - 1 day` | **Yes** |
| `admin` | Yes | any | **No** |
| `member` | No | any | **No** |
| `owner` | No | `NULL` (never set — legacy row) | **Yes** (treat NULL as expired) |

---

### AC-5: MFA Enforcement Middleware — `requireMfaEnrollment()`

**Given** authenticated request with `authContext` populated (Story 1.7 AC-5),
**When** route chain includes `requireMfaEnrollment()` (or future `SecureRoute({ requireMfa: true })`),
**Then** evaluate enforcement using **live DB state**:

1. Load `users.mfa_enrolled_at` for `authContext.userId` (cache in `authContext` for request lifetime if not already loaded)
2. Load `org_memberships.grace_period_expires_at` for `(authContext.orgId, authContext.userId)`
3. Call `isMfaEnforcementActive(authContext.orgRole, mfaEnrolledAt, gracePeriodExpiresAt)`

**If enforcement active:**

```json
HTTP 403
{
  "code": "mfa_required",
  "message": "MFA enrollment is required for Owner and Admin roles. Enroll at /settings/security."
}
```

**If grace period active (owner/admin, no MFA, grace not expired):**

- Allow request to proceed
- Set response header: `X-MFA-Grace-Expires-At: <ISO8601>` (optional — primary source is `/auth/me`)

**Implementation:**

```typescript
// apps/api/src/modules/auth/mfa-enforcement.ts
export function requireMfaEnrollment() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authContext) {
      throw new AppError('access_token_missing', 'Authentication required', 401)
    }
    const status = await loadMfaEnforcementStatus(request.authContext)
    if (status.enforcementActive) {
      request.log.warn({
        eventType: 'security.mfa_enrollment_required_denied',
        userId: request.authContext.userId,
        orgId: request.authContext.orgId,
        orgRole: request.authContext.orgRole,
        route: request.routeOptions.url,
        // NEVER log email, tokens, or grace timestamp
      })
      throw new AppError(
        'mfa_required',
        'MFA enrollment is required for Owner and Admin roles. Enroll at /settings/security.',
        403
      )
    }
    if (status.gracePeriodActive) {
      reply.header('X-MFA-Grace-Expires-At', status.gracePeriodExpiresAt!.toISOString())
    }
  }
}
```

**SecureRoute contract (Story 1.11 consumes — define now in stub):**

```typescript
// apps/api/src/lib/secure-route.ts
export type SecureRouteOptions = {
  requireAuth?: boolean       // default true — Story 1.11
  requireMfa?: boolean        // default false; when true → requireMfaEnrollment() after requireOrgRole
  requireOrgRole?: Array<'owner' | 'admin' | 'member' | 'viewer'>
  // ... other flags deferred to 1.11
}

/** Pre-composed preHandler chain for tests and early privileged routes */
export function buildSecurePreHandlers(
  fastify: FastifyInstance,
  options: SecureRouteOptions
): preHandlerHookHandler[] {
  const chain: preHandlerHookHandler[] = []
  // Canonical order: authenticate → requireOrgRole → requireMfaEnrollment
  if (options.requireAuth !== false) chain.push(fastify.authenticate)
  if (options.requireOrgRole?.length) chain.push(requireOrgRole(...options.requireOrgRole))
  if (options.requireMfa) chain.push(requireMfaEnrollment())
  return chain
}
```

**PreHandler order (mandatory when all three apply):** `authenticate` → `requireOrgRole` → `requireMfaEnrollment`. Role gate runs before MFA DB loads so members/viewers get `403 insufficient_role` without MFA queries.

**Anti-pattern (forbidden):** Duplicating MFA enrollment checks inside individual route handlers — always use `requireMfaEnrollment()` or `requireMfa: true`.

---

### AC-5b: Privileged Route Retrofit & MFA-Exempt Allowlist

**Given** Story 1.7 shipped admin routes before MFA enforcement,
**When** Story 1.9 is complete,
**Then** add `requireMfaEnrollment()` (after `requireOrgRole`) to these existing privileged routes:

| Route | Action |
|---|---|
| `DELETE /api/v1/org/users/:userId/sessions` | ADD `requireMfaEnrollment()` to preHandler chain |

```typescript
// apps/api/src/modules/org/routes.ts — admin session revoke
preHandler: [
  fastify.authenticate,
  requireOrgRole('admin', 'owner'),
  requireMfaEnrollment(),
],
```

**MFA-exempt allowlist** (must **NOT** use `requireMfaEnrollment()` — canonical list in AC-5c):

| Route | Reason |
|---|---|
| `GET /api/v1/org/security-alerts` | Admins in grace must see attacks (ADR-1.9-04) |
| `POST /api/v1/auth/mfa/enroll` | Enrollment itself |
| `POST /api/v1/auth/mfa/verify-enrollment` | Enrollment itself |
| `POST /api/v1/auth/mfa/regenerate-recovery-codes` | Requires valid TOTP — enrollment path |
| `GET /api/v1/auth/me` | Status/banner source |

**And** extend `route-audit.test.ts`:

- Fail if any route uses `requireOrgRole` including `owner` or `admin` without `requireMfaEnrollment()` unless listed in `MFA_ENROLLMENT_EXEMPT_ROUTES` (AC-5c)
- Fail if `privileged-test-route` is imported from production `app.ts` or `main.ts`

**Integration test:** Unenrolled admin with expired grace receives `403 mfa_required` on `DELETE /org/users/:userId/sessions`.

---

### AC-5c: MFA-Exempt Route Registry (Single Source of Truth)

**Given** MFA-exempt routes are referenced by route-audit, AC-5b docs, and Story 1.11 SecureRoute,
**When** Story 1.9 is complete,
**Then** export from `packages/shared/src/constants/mfa-exempt-routes.ts`:

```typescript
export const MFA_ENROLLMENT_EXEMPT_ROUTES = [
  'GET /api/v1/org/security-alerts',
  'POST /api/v1/auth/mfa/enroll',
  'POST /api/v1/auth/mfa/verify-enrollment',
  'POST /api/v1/auth/mfa/regenerate-recovery-codes',
  'GET /api/v1/auth/me',
] as const

export type MfaExemptRoute = (typeof MFA_ENROLLMENT_EXEMPT_ROUTES)[number]
```

**And** `route-audit.test.ts` imports `MFA_ENROLLMENT_EXEMPT_ROUTES` — do **not** duplicate allowlist strings in the test file.

**And** AC-5b table above must stay in sync with this constant (same routes, same paths).

---

### AC-5d: Structured Log on MFA Enforcement Denial

**Given** `requireMfaEnrollment()` blocks a request with `403 mfa_required`,
**When** enforcement is active for the caller,
**Then** emit structured log **before** throwing (see AC-5 implementation):

```typescript
request.log.warn({
  eventType: 'security.mfa_enrollment_required_denied',
  userId: authContext.userId,
  orgId: authContext.orgId,
  orgRole: authContext.orgRole,
  route: request.routeOptions.url,
})
```

**Invariants:**

- **Never** log email, session tokens, or `grace_period_expires_at` in this event
- Add `security.mfa_enrollment_required_denied` to Story 1.10 structured logging redaction review list

**Integration test:** Expired-grace owner hitting mock privileged route emits `security.mfa_enrollment_required_denied` (capture via test logger).

---

### AC-6: Mock Privileged Endpoint — FR57 Test Boundary (MQ-3)

**Given** Epic 4 invitation flow does not exist yet,
**When** integration tests run,
**Then** register a **test-only** route via helper `registerPrivilegedTestRoute(fastify)`:

```typescript
// apps/api/src/__tests__/helpers/privileged-test-route.ts
export function registerPrivilegedTestRoute(fastify: FastifyInstance): void {
  fastify.post('/api/v1/test/privileged-action', {
    preHandler: buildSecurePreHandlers(fastify, {
      requireMfa: true,
      requireOrgRole: ['owner', 'admin'],
    }),
    handler: async () => ({ ok: true, action: 'privileged_mock' }),
  })
}
```

**Rules:**

- Called **only** from integration test `createApp()` / `buildTestApp()` — **never** from production `app.ts`
- Verifies FR57 enforcement mechanism without Epic 4 invite endpoint
- Epic 4 Story 4.1 adds real `POST /org/invitations` with same `requireMfa: true` flag

**Integration test scenarios:**

| User state | Expected |
|---|---|
| Owner, MFA enrolled | `200 { ok: true }` |
| Owner, no MFA, grace active | `200` + `X-MFA-Grace-Expires-At` header |
| Owner, no MFA, grace expired | `403 mfa_required` |
| Admin, no MFA, grace expired | `403 mfa_required` |
| Member, no MFA | `403 insufficient_role` (role gate before MFA matters) |
| Viewer, no MFA | `403 insufficient_role` |

**Integration test (preHandler order):** Member without MFA receives `403 insufficient_role` — confirms role gate runs before `requireMfaEnrollment()` (no MFA status DB load for rejected members).

---

### AC-7: Extend `GET /api/v1/auth/me` — MFA Status Payload

**Given** authenticated user,
**When** `GET /api/v1/auth/me` is called,
**Then** extend response `data` with:

```json
{
  "userId": "...",
  "email": "owner@acme.example",
  "orgId": "...",
  "orgRole": "owner",
  "mfaEnrolled": false,
  "mfaStatus": {
    "enrollmentRequired": false,
    "gracePeriodActive": true,
    "gracePeriodExpiresAt": "2026-07-01T12:00:00.000Z",
    "gracePeriodDaysRemaining": 5,
    "bannerMessage": "MFA enrollment is required for Owner and Admin roles within 5 days. Enroll at /settings/security."
  }
}
```

**Field rules:**

| Field | Rule |
|---|---|
| `mfaEnrolled` | `users.mfa_enrolled_at IS NOT NULL` |
| `enrollmentRequired` | `isMfaEnforcementActive()` === true |
| `gracePeriodActive` | owner/admin + no MFA + grace not expired |
| `gracePeriodDaysRemaining` | `ceil((expiresAt - now) / 86400000)`; omit when not in grace |
| `bannerMessage` | Present when `gracePeriodActive` OR `enrollmentRequired`; null otherwise |

**Examples — curl:**

```bash
# Owner in grace period (no MFA yet)
curl -s -b cookies.txt http://localhost:3000/api/v1/auth/me | jq '.data.mfaStatus'

# Expected:
# {
#   "enrollmentRequired": false,
#   "gracePeriodActive": true,
#   "gracePeriodExpiresAt": "2026-07-01T...",
#   "gracePeriodDaysRemaining": 5,
#   "bannerMessage": "MFA enrollment is required..."
# }
```

---

### AC-8: Failed Auth Recording — `recordFailedAuthAttempt()`

**Given** an authentication endpoint rejects a credential,
**When** failure reason matches a recordable type,
**Then** insert into `failed_auth_attempts` via **best-effort async insert** (same pattern as Story 1.6 AC-6f failed login audit):

```typescript
export type FailedAuthReason =
  | 'invalid_credentials'
  | 'invalid_totp'
  | 'invalid_recovery_code'
  | 'expired_recovery_code'

export async function recordFailedAuthAttempt(input: {
  userId?: string | null
  ipAddress: string
  attemptedEmail: string
  reason: FailedAuthReason
}): Promise<void>
```

**Wire recording in these handlers (Story 1.9):**

| Route | Condition | reason | userId |
|---|---|---|---|
| `POST /auth/login` | `401 invalid_credentials` | `invalid_credentials` | known user id or null |
| `POST /auth/mfa/recover` | wrong password | `invalid_credentials` | null (timing-safe — same as login) |
| `POST /auth/mfa/recover` | bad recovery code | `invalid_recovery_code` | known after password ok |
| `POST /auth/mfa/recover` | expired recovery code | `expired_recovery_code` | known after password ok |
| `POST /auth/mfa/verify-enrollment` | `422 invalid_totp` | `invalid_totp` | authContext.userId |
| `POST /auth/mfa/regenerate-recovery-codes` | `422 invalid_totp` | `invalid_totp` | authContext.userId |

**Story 1.12 (deferred wiring):** `POST /auth/mfa/verify-login` invalid TOTP → `invalid_totp` — export function now, 1.12 imports.

**Email normalization:** import and call Story 1.6 `normalizeEmail()` from `./normalize.ts` (trim, lowercase, **NFKC**, ASCII-only) — do **not** introduce a separate `normalizeAttemptEmail()` or use NFC.

**IP extraction:** reuse Story 1.6/1.7 `getClientIp(request)` — respect `trustProxy` config.

**Invariants:**

- Insert failure **never** changes HTTP status code returned to client
- **Never** log `attempted_email` at info level — debug only with redaction
- **Never** include attempted email in audit payload (Story 1.6 pattern)
- Skip insert when `FAILED_AUTH_RECORD_ENABLED=false`

**Example — failed login triggers row:**

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@acme.example","password":"wrong-password-here"}'
# → 401 invalid_credentials

# DB verification (integration test):
# SELECT reason, attempted_email, ip_address FROM failed_auth_attempts ORDER BY attempted_at DESC LIMIT 1;
# → invalid_credentials | owner@acme.example | 127.0.0.1
```

---

### AC-9: Threshold Detection — pg-boss Job `security:check-failed-auth-threshold`

**Given** vault unsealed and `BossService` started,
**When** scheduled job runs on cron `* * * * *` (once per minute at `:00` UTC — up to ~59s detection latency vs rolling 60s),
**Then** evaluate two independent thresholds over `FAILED_AUTH_THRESHOLD_WINDOW_SECONDS`:

#### AC-9a: IP-based threshold

```sql
SELECT ip_address, COUNT(*) AS attempt_count
FROM failed_auth_attempts
WHERE attempted_at >= NOW() - INTERVAL ':window seconds'
GROUP BY ip_address
HAVING COUNT(*) >= :threshold
```

#### AC-9b: Account-based threshold (PRD FR73)

```sql
-- By user_id when known
SELECT user_id, COUNT(*) AS attempt_count
FROM failed_auth_attempts
WHERE attempted_at >= NOW() - INTERVAL ':window seconds'
  AND user_id IS NOT NULL
GROUP BY user_id
HAVING COUNT(*) >= :threshold

-- By email when user_id unknown (same window, separate pass)
SELECT lower(attempted_email) AS email, COUNT(*) AS attempt_count
FROM failed_auth_attempts
WHERE attempted_at >= NOW() - INTERVAL ':window seconds'
  AND user_id IS NULL
GROUP BY lower(attempted_email)
HAVING COUNT(*) >= :threshold
```

**On threshold breach, for each affected org:**

1. Resolve `org_id`(s):
   - **Account threshold:** primary org from `org_memberships` where `user_id = ?` and `status = 'active'` (v1 single-org — first row)
   - **IP threshold:** distinct `org_id` from all attempts in window where `user_id IS NOT NULL` joined to `org_memberships`
   - **IP threshold, all unknown emails:** log `warn` with `eventType: 'security.failed_auth_threshold_no_org'` — **no** `security_alerts` row (cannot satisfy org FK)

2. Insert `security_alerts` (deduplicated — see AC-9c; payload validated — AC-11b):

```typescript
{
  orgId,
  alertType: 'security.failed_auth_threshold',
  severity: 'critical',
  status: 'PENDING_DELIVERY',
  payload: {
    thresholdType: 'ip' | 'account',
    thresholdCount: 10,
    windowSeconds: 300,
    ipAddress?: string,
    userId?: string,
    attemptedEmail?: string,  // only for account+unknown-user path — no password
    attemptCount: number,
    windowStart: ISO8601,
    windowEnd: ISO8601,
  }
}
```

3. Log confirmation (Epic 3 deferral):

```typescript
request.log.warn({
  eventType: 'alert.pending_epic3',
  alertType: 'security.failed_auth_threshold',
  orgId,
  thresholdType: 'ip',
  ipAddress,
})
```

**Schedule registration** (inside `setOnVaultUnsealed`):

```typescript
await boss.registerSchedules({
  'security:check-failed-auth-threshold': { cron: '* * * * *' }, // every minute
})
await boss.registerWorkers({
  'security:check-failed-auth-threshold': checkFailedAuthThresholdHandler,
})
```

**Worker file:** `apps/api/src/workers/check-failed-auth-threshold.ts`

**On worker failure:** log `eventType: 'job.failed'`, rethrow for pg-boss retry.

---

### AC-9c: Alert deduplication

**Given** threshold job runs every minute,
**When** same IP or account remains above threshold,
**Then** do **not** create duplicate alerts within the same window:

**Dedup key (one alert per org per breach identity per window):**

| Field | Value |
|---|---|
| `orgId` | Target org for alert |
| `alertType` | `'security.failed_auth_threshold'` |
| `payload.thresholdType` | `'ip'` \| `'account'` |
| Breach identity | `payload.ipAddress` OR `payload.userId` OR `payload.attemptedEmail` (whichever applies) |
| Window | Existing row with `created_at >= windowStart` |

```typescript
// Before insert — query within transaction; prefer SELECT ... FOR UPDATE on matching row
const dedupIdentity =
  thresholdType === 'ip'
    ? { thresholdType, ipAddress }
    : userId
      ? { thresholdType, userId }
      : { thresholdType, attemptedEmail }

const existing = await findRecentThresholdAlert({
  orgId,
  alertType: 'security.failed_auth_threshold',
  payloadMatch: dedupIdentity,
  since: windowStart,
})
if (existing) return // skip

// Insert only when no matching row in window
await createThresholdAlert({ orgId, ... })
```

**Concurrency:** Two overlapping job runs must not double-insert — use transactional check + insert, or advisory lock keyed on `(orgId, alertType, dedupIdentity hash)`.

**Integration tests:**

- Trigger 15 failures in 2 minutes → exactly **1** alert row per org/threshold-type (not 15)
- Two concurrent `runThresholdJobOnce()` calls with same seeded breaches → exactly **1** alert row

---

### AC-9d: Audit Log on Threshold Alert Creation

**Given** `createThresholdAlert()` inserts a new `security_alerts` row,
**When** the insert succeeds (after AC-9c dedup check),
**Then** insert org-scoped `audit_log_entries` in the **same transaction**:

```typescript
await withOrg(orgId, async (tx) => {
  const alert = await createThresholdAlert(tx, { ... }) // validates payload via AC-11b
  await insertAuditLog(tx, {
    eventType: AuditEvent.SECURITY_FAILED_AUTH_THRESHOLD,
    orgId,
    actorUserId: null, // system-generated — no human actor
    metadata: {
      alertId: alert.id,
      thresholdType: payload.thresholdType,
      attemptCount: payload.attemptCount,
      windowSeconds: payload.windowSeconds,
    },
    // NEVER include attemptedEmail, ipAddress, or userId in audit metadata — PII; reference alert row by id
  })
})
```

**And** add to `packages/shared/src/constants/audit-events.ts`:

```typescript
SECURITY_FAILED_AUTH_THRESHOLD: 'security.failed_auth_threshold',
```

(Align with Story 1.8 `AuditEvent` enum pattern if that lands first — single export either way.)

**Integration test:** Threshold breach creates both `security_alerts` row and matching `audit_log_entries` row in same org.

---

### AC-10: Prune Job — `security:prune-failed-auth-attempts`

**Given** rows older than `FAILED_AUTH_RETENTION_HOURS`,
**When** daily job runs at **02:00 UTC**,
**Then** delete:

```sql
DELETE FROM failed_auth_attempts
WHERE attempted_at < NOW() - INTERVAL ':retention hours'
```

**Schedule:**

```typescript
await boss.registerSchedules({
  'security:prune-failed-auth-attempts': { cron: '0 2 * * *' },
})
```

**Integration test:** Seed row with `attempted_at = now() - 25 hours` → after job, row gone; row at 23 hours remains.

---

### AC-11: Admin Visibility — `GET /api/v1/org/security-alerts` (MQ-2)

**Given** Epic 3 notification delivery is not live,
**When** org owner/admin calls:

```http
GET /api/v1/org/security-alerts?status=PENDING_DELIVERY&page=1&limit=20
Cookie: access-token=<jwt>
```

**Then** return paginated org-scoped alerts:

```json
HTTP 200
{
  "data": {
    "items": [
      {
        "id": "uuid",
        "alertType": "security.failed_auth_threshold",
        "severity": "critical",
        "status": "PENDING_DELIVERY",
        "payload": {
          "thresholdType": "ip",
          "ipAddress": "203.0.113.50",
          "attemptCount": 12,
          "windowStart": "2026-06-24T10:00:00.000Z",
          "windowEnd": "2026-06-24T10:05:00.000Z"
        },
        "deliveryStatus": "pending_notification_channel",
        "createdAt": "2026-06-24T10:05:01.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 20,
    "hasNext": false
  }
}
```

**Route chain:**

```typescript
preHandler: [
  fastify.authenticate,
  requireOrgRole('owner', 'admin'),
  // NOTE: do NOT require MFA for this endpoint — admins in grace period must see alerts
]
```

**Query params:**

| Param | Values | Default |
|---|---|---|
| `status` | `PENDING_DELIVERY`, `delivered`, `dismissed`, `all` | `all` |
| `severity` | `info`, `warning`, `critical` | optional filter |
| `page` | ≥1 | `1` |
| `limit` | 1–100 | `20` |

**`deliveryStatus` computed field:**

| `status` | `deliveryStatus` |
|---|---|
| `PENDING_DELIVERY` | `pending_notification_channel` |
| `delivered` | `delivered` |
| `dismissed` | `dismissed` |

**RLS:** Query via `withOrg(authContext.orgId, tx => ...)` — org isolation enforced.

**curl example:**

```bash
curl -s -b cookies.txt \
  'http://localhost:3000/api/v1/org/security-alerts?status=PENDING_DELIVERY' | jq '.data.items[0]'
```

---

### AC-11b: Alert Payload Schema Validation

**Given** `security_alerts.payload` is JSONB and may contain PII (`ipAddress`, `attemptedEmail`),
**When** threshold alerts are created or listed,
**Then** validate with Zod in `apps/api/src/modules/org/schema.ts`:

```typescript
export const failedAuthThresholdPayloadSchema = z.object({
  thresholdType: z.enum(['ip', 'account']),
  thresholdCount: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
  attemptCount: z.number().int().min(1),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  ipAddress: z.string().optional(),
  userId: z.string().uuid().optional(),
  attemptedEmail: z.string().email().optional(),
}).strict()
```

**On insert (`createThresholdAlert`):** parse payload with `failedAuthThresholdPayloadSchema` — reject worker bugs before DB write.

**On list (`listSecurityAlerts`):** parse stored `payload` before mapping to API response — malformed rows log `warn` and omit from `items` (do not 500 the list endpoint).

**UI safety:** Payload values are **text-only** — never render as HTML (`security-alerts.ts` schema comment). Frontend must not use `{@html}` or `innerHTML` with payload fields.

**Unit test:** Invalid payload (extra keys, bad ISO date) rejected on insert; valid IP and account payloads pass.

---

### AC-12: Registration Grace Period Wiring

**Given** `POST /api/v1/auth/register` creates owner membership (Story 1.6),
**When** registration succeeds,
**Then** set on new `org_memberships` row:

```typescript
gracePeriodExpiresAt:
  env.MFA_PRIVILEGED_ROLE_GRACE_DAYS === 0
    ? new Date()
    : new Date(Date.now() + env.MFA_PRIVILEGED_ROLE_GRACE_DAYS * 86400000)
```

**Integration test:**

```typescript
it('registration sets 7-day MFA grace period for owner', async () => {
  const { userId, orgId } = await registerTestUser()
  const [membership] = await getMembership(orgId, userId)
  expect(membership.role).toBe('owner')
  expect(membership.gracePeriodExpiresAt).not.toBeNull()
  const daysUntil = daysBetween(new Date(), membership.gracePeriodExpiresAt!)
  expect(daysUntil).toBeGreaterThanOrEqual(6)
  expect(daysUntil).toBeLessThanOrEqual(7)
})
```

---

### AC-13: MFA Enrollment Clears Grace Requirement

**Given** owner/admin completes MFA enrollment (Story 1.8 `verify-enrollment`),
**When** `users.mfa_enrolled_at` is set,
**Then**:

- `requireMfaEnrollment()` allows privileged routes regardless of `grace_period_expires_at`
- `/auth/me` returns `mfaEnrolled: true`, `enrollmentRequired: false`
- **Do not** clear `grace_period_expires_at` column (keep for audit) — enforcement ignores it when MFA enrolled

**Integration test:** Owner enrolls MFA → mock privileged route returns `200`.

---

### AC-14: Integration Tests (Real DB)

**File:** `apps/api/src/__tests__/mfa-enforcement-failed-auth.integration.test.ts`

```typescript
describe.sequential('Story 1.9 — MFA enforcement & failed auth', () => {
  // Setup: ensureVaultUnsealed, registerPrivilegedTestRoute, helpers

  describe('MFA enforcement (FR57)', () => {
    it('blocks privileged action when owner has no MFA and grace expired', ...)
    it('allows privileged action during grace period', ...)
    it('allows privileged action when MFA enrolled', ...)
    it('does not enforce MFA for member role', ...)
    it('member receives insufficient_role before MFA check runs', ...)
    it('unenrolled admin with expired grace blocked from DELETE /org/users/:userId/sessions', ...)
    it('returns mfa_required error shape with code field', ...)
    it('emits security.mfa_enrollment_required_denied log on block', ...)
    it('sets X-MFA-Grace-Expires-At header during grace', ...)
  })

  describe('Grace period', () => {
    it('registration sets grace_period_expires_at for owner', ...)
    it('grace period zero days — owner blocked on privileged route after register', ...)
    it('/auth/me reports gracePeriodActive and daysRemaining', ...)
    it('/auth/me reports enrollmentRequired after grace expiry', ...)
  })

  describe('Failed auth recording (FR73)', () => {
    it('records invalid_credentials on failed login', ...)
    it('records invalid_credentials for unknown email with null user_id', ...)
    it('records invalid_recovery_code on bad recovery code', ...)
    it('records expired_recovery_code on /mfa/recover', ...)
    it('records invalid_totp on verify-enrollment failure', ...)
    it('records invalid_totp on regenerate-recovery-codes failure', ...)
    it('normalizeEmail NFKC — account threshold groups homograph variants', ...)
    it('recording failure does not change 401 response', ...)
    it('respects FAILED_AUTH_RECORD_ENABLED=false', ...)
  })

  describe('Threshold detection', () => {
    it('creates PENDING_DELIVERY alert when IP exceeds threshold', ...)
    it('creates alert when account exceeds threshold', ...)
    it('deduplicates alerts within same window', ...)
    it('concurrent threshold job runs produce single alert row', ...)
    it('split-window 9+9 failures do not trigger threshold alert', ...)
    it('single burst creates at most 2 threshold alerts per org (IP + account)', ...)
    it('logs alert.pending_epic3 on alert creation', ...)
    it('creates audit_log_entries row on threshold alert (AC-9d)', ...)
    it('does not create org alert when all attempts are unknown-email IP flood', ...)
  })

  describe('Prune job', () => {
    it('deletes attempts older than retention window', ...)
    it('retains attempts within retention window', ...)
  })

  describe('Admin visibility (MQ-2)', () => {
    it('owner can list PENDING_DELIVERY security alerts', ...)
    it('member cannot list security alerts — 403', ...)
    it('alerts are org-scoped — other org sees zero rows', ...)
    it('list response payload passes failedAuthThresholdPayloadSchema', ...)
  })
})
```

**Threshold test helper — seed rapid failures:**

```typescript
async function seedFailedAttempts(count: number, opts: { ip?: string; userId?: string; email?: string }) {
  for (let i = 0; i < count; i++) {
    await recordFailedAuthAttempt({
      userId: opts.userId ?? null,
      ipAddress: opts.ip ?? '198.51.100.10',
      attemptedEmail: opts.email ?? 'attacker@example.com',
      reason: 'invalid_credentials',
    })
  }
  await runThresholdJobOnce() // invoke worker handler directly in test
}
```

---

### AC-15: Unit Tests

| File | Coverage |
|---|---|
| `mfa-enforcement.test.ts` | `isMfaEnforcementActive()` all branches; error shape |
| `grace-period.test.ts` | `setGracePeriodOnPrivilegedRole()` idempotency; `MFA_PRIVILEGED_ROLE_GRACE_DAYS=0` sets `expiresAt = now()` |
| `failed-auth.test.ts` | `normalizeEmail()` NFKC import (no NFC); best-effort insert failure |
| `check-failed-auth-threshold.test.ts` | IP/account queries; dedup key matching; concurrent insert guard; split-window 9+9 no-alert |
| `prune-failed-auth-attempts.test.ts` | retention cutoff |
| `org/schema.test.ts` | `failedAuthThresholdPayloadSchema` valid/invalid cases (AC-11b) |

**Mutation score target:** ≥80% on `mfa-enforcement.ts` and `failed-auth.ts`.

---

### AC-16: Security & Red Team Hardening

| Threat | Mitigation | Verified by |
|---|---|---|
| MFA bypass via JWT role claim | Live `orgRole` from DB (Story 1.7) | Integration test |
| MFA bypass via 1.7 admin routes without `requireMfa` | AC-5b retrofit + route-audit exempt list | Integration test |
| Grace period extension on re-login | Set only on role assignment, not login | Unit test |
| Grace-window privileged exposure | Intentional 7-day window; shorten via `MFA_PRIVILEGED_ROLE_GRACE_DAYS` | ADR-1.9-05 + config |
| Failed-auth insert DoS | Best-effort insert; no await blocking response >50ms; 24h prune | Load test note |
| Email enumeration via failed_auth table | Same uniform login response; email stored server-side only | Story 1.6 + 1.9 |
| Slow threshold evasion (9+9 split window) | Rate limits reduce volume; fixed window (no rolling) — known v1 limit | Unit/integration test documents no alert |
| Threshold alert spam | Dedup within window + transactional insert guard | AC-9c tests (sequential + concurrent) |
| Dual IP+account alerts from single burst | Accepted — max 2 alerts/org/burst (ADR-1.9-03) | Integration test |
| Cross-org alert leakage | RLS + `withOrg()` on list endpoint | Integration test |
| Privileged test route in production | Test helper only + route-audit import guard | CI |
| `FAILED_AUTH_RECORD_ENABLED=false` in prod | Production startup guard (AC-2) | env.test.ts |
| IP threshold evasion via `trustProxy` misconfig | Story 1.7 production `trustProxy` guard | Config review |
| New admin routes ship without MFA until 1.11 | route-audit.test.ts MFA coverage + exempt list | CI |
| Tenant API exposure of `failed_auth_attempts` | No REST route; platform workers + recorder only | route-audit.test.ts |
| Malformed alert payload | Zod validation on insert (AC-11b) | Unit test |
| MFA denial blind spot | Structured log `security.mfa_enrollment_required_denied` (AC-5d) | Integration test |
| Forensic gap on alert creation | Audit log entry (AC-9d) | Integration test |
| Alert payload XSS | Text interpolation only; Zod string fields; no HTML rendering | Schema comment + AC-11b |
| `attempted_email` in logs | Redact in Pino paths (extend Story 1.10 list) | Log assertion stub |

---

### AC-17: ADRs

#### ADR-1.9-01: MFA enforcement as composable preHandler, not inline route checks

| | |
|---|---|
| **Context** | Architecture forbids per-route MFA checks; SecureRoute not available until 1.11 |
| **Decision** | Export `requireMfaEnrollment()` + `SecureRouteOptions.requireMfa` contract now; 1.11 wraps without reimplementing |
| **Consequences** | Two-step integration (1.9 middleware, 1.11 factory) — documented |

#### ADR-1.9-02: `failed_auth_attempts` is platform-scoped (no org_id, no RLS)

| | |
|---|---|
| **Context** | Unknown-email failures have no org; IP floods may span orgs |
| **Decision** | Platform table; org derived at alert creation time |
| **Consequences** | Must add to RLS coverage allow-list |

#### ADR-1.9-03: Dual threshold (IP + account) per PRD FR73

| | |
|---|---|
| **Context** | Epics AC mentions IP only; PRD explicitly includes account |
| **Decision** | Implement both; separate alert rows per threshold type |
| **Consequences** | Slightly more alerts on coordinated attack — acceptable |

#### ADR-1.9-04: Admin alert list accessible during MFA grace period

| | |
|---|---|
| **Context** | MQ-2 requires visibility before Epic 3; blocking admins in grace prevents seeing attacks |
| **Decision** | `GET /org/security-alerts` does not use `requireMfaEnrollment()` |
| **Consequences** | Unenrolled admin can see alerts — intentional for security monitoring |

#### ADR-1.9-05: Route-level MFA enforcement vs login block (Epics AC-E1c)

| | |
|---|---|
| **Context** | Epics AC-E1c says block login after grace; architecture uses SecureRoute `requireMfa`; Story 1.12 adds login MFA step |
| **Decision** | v1 blocks **privileged routes** via `requireMfaEnrollment()` + grace banner via `/auth/me`; hard login gate deferred to Story 1.12 `verify-login` |
| **Consequences** | Unenrolled owner/admin can use non-privileged routes during grace; deploy 1.8+1.9 without 1.12 still allows password-only login for MFA-enrolled users (Story 1.8 deploy warning) |

---

### AC-19: Compliance Traceability Matrix (FR57, FR73)

| FR | Requirement | Satisfied by | Status |
|---|---|---|---|
| FR57 | MFA before privileged expansion | AC-5, AC-5b, AC-6 (mechanism); Epic 4.1 `POST /org/invitations` (business flow) | **Partial** — mechanism complete; invite flow Epic 4 |
| FR57 | Team/Small Company tier scope only | Architecture conflict table — deferred | **Exception** — v1 enforces all owner/admin orgs |
| FR73 | Log all failed authentication attempts | AC-8 | **Complete** |
| FR73 | Alert when IP exceeds threshold | AC-9a, AC-11 | **Complete** (delivery deferred Epic 3) |
| FR73 | Alert when account exceeds threshold | AC-9b, AC-11 | **Complete** (delivery deferred Epic 3) |
| FR73 | Configurable threshold defaults | AC-2 (`10` / `300s`) | **Complete** |
| FR73 | Admin notification path | AC-11 list API + Epic 3 email/Slack | **Partial** — `PENDING_DELIVERY` + admin list until Epic 3 |
| FR73 | Forensic audit trail on alert | AC-9d audit log entry | **Complete** |

**Sign-off note:** Story 1.9 is **merge-ready for FR73 mechanism** and **FR57 enforcement mechanism (MQ-3)**. Full FR57 product acceptance requires Epic 4.1 invite endpoint with `requireMfa: true`.

---

### AC-18: Tasks / Subtasks

- [ ] **Task 1: Schema & migration** (AC: 3)
  - [ ] `failed-auth-attempts.ts` Drizzle schema
  - [ ] Migration SQL + journal
  - [ ] Update `check-rls-coverage.ts` allow-list
- [ ] **Task 2: Env config** (AC: 2)
  - [ ] Add variables to `env.ts` + tests
  - [ ] Update `.env.example`
- [ ] **Task 3: Grace period** (AC: 4, 12)
  - [ ] `grace-period.ts` helper
  - [ ] Wire into `registerUser()`
- [ ] **Task 4: MFA enforcement** (AC: 5, 5b, 5c, 5d, 6, 13)
  - [ ] `mfa-enforcement.ts` + `require-mfa-enrollment.ts`
  - [ ] Extend `secure-route.ts` contract
  - [ ] `mfa-exempt-routes.ts` shared constant (AC-5c)
  - [ ] Retrofit 1.7 admin routes with `requireMfaEnrollment()` (AC-5b)
  - [ ] `route-audit.test.ts` MFA coverage + exempt allowlist
  - [ ] Test helper mock privileged route
  - [ ] Extend `/auth/me`
- [ ] **Task 5: Failed auth recording** (AC: 8)
  - [ ] `failed-auth.ts`
  - [ ] Wire login, recover, verify-enrollment, regenerate
- [ ] **Task 6: Background jobs** (AC: 9, 9c, 9d, 10)
  - [ ] Threshold worker + schedule
  - [ ] Audit log on alert create (AC-9d)
  - [ ] Prune worker + schedule
  - [ ] Extend `BossService` if not done in 1.7
- [ ] **Task 7: Admin API** (AC: 11, 11b)
  - [ ] `GET /org/security-alerts`
  - [ ] `security-alerts.ts` service
  - [ ] `failedAuthThresholdPayloadSchema` (AC-11b)
- [ ] **Task 8: Tests** (AC: 14, 15, 16)
  - [ ] Integration test file
  - [ ] Unit tests
- [ ] **Task 9: Shared constants** (AC: 9, 9d, 5c)
  - [ ] `security-alert-types.ts`
  - [ ] `mfa-exempt-routes.ts`
  - [ ] `AuditEvent.SECURITY_FAILED_AUTH_THRESHOLD`

---

### Out of Scope (Explicit)

| Item | Owner story |
|---|---|
| SecureRoute full factory + ESLint `no-raw-fastify-route` | 1.11 |
| `POST /auth/mfa/verify-login` failed TOTP wiring | 1.12 (uses exported recorder) |
| Real invite-member endpoint MFA gate | Epic 4.1 |
| Email/Slack alert delivery | Epic 3 |
| Web UI MFA banner / security alerts panel | Architecture step 7 |
| Account lockout / exponential backoff beyond recording | Future — rate limits remain in 1.6/1.8 |
| Per-session refresh rate cap | Deferred from 1.7 — optional enhancement |
| Cross-IP distributed credential stuffing detection | Future — IP threshold only in v1 |
| Rolling-window threshold detection (slow 9+9 stuffing) | Future — v1 uses fixed window + rate limits |
| FR57 org-tier gate (Solo/Indie exempt) | Subscription/tier story — v1 enforces all owner/admin roles |
| Epic 2+ write route MFA gating | Each Epic 2 story adds `requireMfa: true` on privileged write routes |
| Full FR57 business compliance (invite flow) | Epic 4.1 |
| Dismiss security alert endpoint | Epic 3 or 8 |

---

### Anti-Patterns (Do Not)

- Check MFA enrollment inside individual route handlers — use `requireMfaEnrollment()`
- Trust JWT role claim for MFA enforcement — use live DB `orgRole` + `mfa_enrolled_at`
- Use `{ error: 'mfa_required' }` — use `{ code: 'mfa_required' }`
- Block `GET /org/security-alerts` with `requireMfaEnrollment()` — admins in grace must see alerts
- Fail login with `500` when failed_auth insert fails — best effort only
- Store plaintext passwords or TOTP in `failed_auth_attempts`
- Add `org_id` to `failed_auth_attempts` — derive at alert time
- Register `/api/v1/test/privileged-action` in production `app.ts`
- Extend grace period on every login
- Clear `grace_period_expires_at` on MFA enrollment — leave for audit
- Create duplicate threshold alerts every minute — dedup required
- Query `security_alerts` without `withOrg()`
- Skip `alert.pending_epic3` log when creating PENDING_DELIVERY rows
- Use `organization_members` table name — canonical is `org_memberships`
- Use NFC or a separate `normalizeAttemptEmail()` — import Story 1.6 `normalizeEmail()` (NFKC + ASCII-only)
- Put `requireMfaEnrollment()` before `requireOrgRole` in preHandler chains — canonical order is auth → role → MFA
- Ship owner/admin route with `requireOrgRole` but without `requireMfaEnrollment()` unless on MFA-exempt allowlist (AC-5b)
- Set `FAILED_AUTH_RECORD_ENABLED=false` in production
- Expose `failed_auth_attempts` via any tenant REST route
- Insert threshold alert without `failedAuthThresholdPayloadSchema` validation
- Include `attemptedEmail` or `ipAddress` in AC-9d audit log metadata

---

### Manual QA Checklist

```bash
# 1. Register owner — verify grace period in /me
curl -s -c cookies.txt -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@test.com","password":"twelve-characters","organizationName":"Test Org"}'

curl -s -c cookies.txt -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@test.com","password":"twelve-characters"}'

curl -s -b cookies.txt http://localhost:3000/api/v1/auth/me | jq '.data.mfaStatus'

# 2. Trigger failed logins (run 11 times)
for i in $(seq 1 11); do
  curl -s -o /dev/null -X POST http://localhost:3000/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"owner@test.com","password":"wrong-password"}'
done

# Wait up to 60s for threshold job, then:
curl -s -b cookies.txt \
  'http://localhost:3000/api/v1/org/security-alerts?status=PENDING_DELIVERY' | jq '.data.items'

# 3. Enroll MFA (Story 1.8 flow), then verify privileged access
curl -s -b cookies.txt -X POST http://localhost:3000/api/v1/auth/mfa/enroll \
  -H 'Content-Type: application/json' -d '{}'
# ... verify enrollment with TOTP ...

curl -s -b cookies.txt http://localhost:3000/api/v1/auth/me | jq '.data.mfaEnrolled'
# → true

# 4. Force grace expiry (test DB only):
# UPDATE org_memberships SET grace_period_expires_at = NOW() - INTERVAL '1 day' WHERE ...
# Retry privileged mock route → 403 mfa_required
```

**Operator note — IP flood with unknown emails:**

When all failed attempts in a window use unknown emails (no resolvable `org_id`), the threshold job logs `eventType: 'security.failed_auth_threshold_no_org'` and creates **no** `security_alerts` row. This is visible in structured logs only — not in `GET /org/security-alerts`. Monitor platform logs until platform-level alerting exists.

---

### Project Structure Notes

| What | Where |
|---|---|
| MFA enforcement logic | `apps/api/src/modules/auth/mfa-enforcement.ts` |
| Failed auth recorder | `apps/api/src/modules/auth/failed-auth.ts` |
| Grace period helper | `apps/api/src/modules/auth/grace-period.ts` |
| SecureRoute options stub | `apps/api/src/lib/secure-route.ts` |
| Threshold worker | `apps/api/src/workers/check-failed-auth-threshold.ts` |
| Prune worker | `apps/api/src/workers/prune-failed-auth-attempts.ts` |
| Admin alerts API | `apps/api/src/modules/org/routes.ts` |
| MFA-exempt allowlist | `packages/shared/src/constants/mfa-exempt-routes.ts` (AC-5c) |
| Alert payload schema | `apps/api/src/modules/org/schema.ts` — `failedAuthThresholdPayloadSchema` (AC-11b) |
| Compliance matrix | AC-19 |
| failed_auth schema | `packages/db/src/schema/failed-auth-attempts.ts` |
| Alert type constants | `packages/shared/src/constants/security-alert-types.ts` |
| Integration tests | `apps/api/src/__tests__/mfa-enforcement-failed-auth.integration.test.ts` |
| Test privileged route | `apps/api/src/__tests__/helpers/privileged-test-route.ts` |

**BossService pattern:** Register schedules/workers inside `setOnVaultUnsealed` callback (Story 1.7 AC-14). Extend `BossService` with `registerWorkers` / `registerSchedules` if not already present from 1.7.

**Do NOT** implement SvelteKit MFA banner UI — backend returns `mfaStatus` for frontend consumption in Architecture step 7.

---

### Previous Story Intelligence

#### From Story 1.6 (Auth foundation)

- Login uses uniform `401 invalid_credentials` — record failure without distinguishing unknown email in response
- `normalizeEmail()` for all email inputs
- Failed login audit is best-effort separate transaction — **same pattern** for `recordFailedAuthAttempt()`
- Rate limit on `/login`: 60/min/IP — threshold detection is **additive**, not replacement

#### From Story 1.7 (Sessions & middleware)

- `AuthContext.orgRole` loaded live from DB on every request — MFA enforcement must use this, not JWT claims
- `requireOrgRole('owner', 'admin')` pattern for org admin routes
- `BossService` extension with `registerSchedules` / `registerWorkers`
- pg-boss jobs register only after vault unseal

#### From Story 1.8 (MFA enrollment)

- `users.mfa_enrolled_at` timestamptz — NULL means not enrolled
- Invalid TOTP returns `422 { code: 'invalid_totp' }` — wire recorder here
- `/mfa/recover` dual rate limits — failed attempts still recorded within limits
- `security_alerts` optional insert with `PENDING_DELIVERY` already documented — 1.9 owns threshold alerts

---

### Git Intelligence Summary

Recent commits (`d8e82e1`, `b97e481`) established database foundation with RLS, `org_memberships.grace_period_expires_at`, and `security_alerts`. Story 1.9 builds on this schema without migration conflicts. Auth module files (1.6–1.8) are specified in story artifacts but may be in feature branch — follow story file paths, not empty `apps/api/src/modules/` on main.

---

### Latest Tech Information

| Technology | Version / note | Story impact |
|---|---|---|
| pg-boss | 12.x (monorepo) | `schedule(name, cron, null, { tz: 'UTC' })`; `* * * * *` = once/minute at `:00` UTC (not rolling 60s interval) |
| PostgreSQL `INET` | Native type | Store `ip_address` — cast from string on insert |
| Fastify preHandler chain | v5 | Order: `authenticate` → `requireOrgRole` → `requireMfaEnrollment` when all apply |
| Drizzle ORM | 0.45.x | Platform inserts on `failed_auth_attempts` bypass `withOrg()` |

---

### References

- Epic AC: [_bmad-output/planning-artifacts/epics.md#Story-1.9-MFA-Role-Enforcement--Failed-Authentication-Detection_]
- FR57, FR73: [_bmad-output/planning-artifacts/prd.md#Functional-Requirements_]
- MFA enforcement invariant: [_bmad-output/planning-artifacts/architecture.md#Authentication--Security_]
- MQ-2, MQ-3: [_bmad-output/planning-artifacts/implementation-readiness-report-2026-05-31.md_]
- Grace period column: [_bmad-output/implementation-artifacts/1-4-database-foundation-with-postgresql-rls-and-core-schema.md_]
- Auth middleware: [_bmad-output/implementation-artifacts/1-7-jwt-session-management-and-security-controls.md_]
- MFA enrollment: [_bmad-output/implementation-artifacts/1-8-totp-mfa-enrollment-and-recovery-codes.md_]
- UX security events: [_bmad-output/planning-artifacts/ux-design-specification.md_]

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
