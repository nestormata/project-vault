# Story 1.11: SecureRoute Framework & Drizzle RLS Middleware

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-06-27 - comprehensive developer guide for SecureRoute, Drizzle transaction-scoped RLS, same-transaction security audit writes, route registration guardrails, background job RLS, and route audit CI enforcement. Builds on Story 1.4 RLS schema, Story 1.6 JWT/session auth, Stories 1.8-1.9 MFA enforcement and failed-auth detection, and Story 1.10 operational logging. -->

## Story

As a developer building API endpoints,
I want a `SecureRoute` handler constructor that applies RBAC, org-scoped RLS, audit writes, and rate limiting by default,
so that security concerns are structural and I cannot accidentally create an unprotected endpoint by forgetting middleware.

*Covers: FR40, FR61, FR73, NFR-SEC3, NFR-REL5, architecture cross-cutting concern composition.* [Source: _bmad-output/planning-artifacts/epics.md#Story-1.11-SecureRoute-Framework--Drizzle-RLS-Middleware]

## Prerequisites

| Prerequisite | Why it matters for Story 1.11 |
|---|---|
| Story 1.4 complete - org-aware schema, RLS policies, `withOrg()` helper, `check-rls-coverage` | 1.11 must reuse and harden existing database-level RLS, not create application-only org filters. |
| Story 1.6 complete - JWT auth, session revocation, `request.authContext` | `SecureRoute` defaults to authenticated routes and consumes the existing auth context. |
| Stories 1.8-1.9 complete - MFA enforcement and failed auth detection | Existing privileged route enforcement must be folded into `SecureRoute` defaults and options. |
| Story 1.10 in progress - structured operational logging | Security audit writes are database audit records, not Pino operational logs. Keep the two streams separate. |
| Existing placeholder `apps/api/src/lib/secure-route.ts` | Expand or replace this file in place. Do not create a second, competing SecureRoute framework. |

## Architecture Conflict Resolution

| Source wording or current state | Canonical implementation for this story | Rationale |
|---|---|---|
| Epic says `packages/api/src/middleware/rls.ts` | Use `apps/api/src/middleware/rls.ts` if a separate middleware file is needed | The actual API package is `apps/api`; there is no `packages/api`. |
| Epic says `apps/api/src/framework/secure-route.ts` | Expand `apps/api/src/lib/secure-route.ts` and optionally add small helpers under `apps/api/src/middleware/` | The repo already has `apps/api/src/lib/secure-route.ts` and tests import it. Moving is optional only if all imports/tests are updated. Do not duplicate. |
| Epic mentions `audit_events` | Use existing `audit_log_entries` table | Story 1.4 established `audit_log_entries` as the security audit table. |
| Existing auth/org routes use raw `fastify.route()` and helper wrappers | Public or method-not-allowed routes may use explicit public registration helpers; protected API routes must migrate to `SecureRoute` | This story creates the approved registration path and closes the existing `route-audit.test.ts` TODO. |
| Existing `withOrg()` opens a new Drizzle transaction | `SecureRoute` must provide a request-scoped transaction `tx` after setting `app.current_org_id` | All RLS-dependent work in a request must run in the same transaction where `set_config(..., true)` was called. |
| Story 1.10 operational event registry exists | Do not use `OperationalEvent` for security audit rows | Operational stdout logs and security audit DB rows have different classification and retention rules. |

## Acceptance Criteria

### AC-1: Module Structure and Approved File Locations

**Given** the repo already contains a placeholder `apps/api/src/lib/secure-route.ts`,
**when** Story 1.11 is implemented,
**then** the developer expands that module into the full SecureRoute framework and does not create a parallel implementation under a conflicting path.

Required file changes:

```text
apps/api/src/
├── lib/
│   ├── secure-route.ts                    # Expand: SecureRoute factory, option defaults, handler context
│   ├── secure-route.test.ts               # Expand: defaults, opt-outs, handler context, audit rollback
│   └── route-helpers.ts                   # Reduce or adapt legacy helpers; do not duplicate auth/rate logic
├── middleware/
│   ├── rls.ts                             # New if useful: setRlsOrgContext(), runWithRequestOrg()
│   └── rls.test.ts                        # New if rls.ts exists
├── __tests__/
│   ├── secure-route.integration.test.ts   # New: auth, role, RLS, audit, rate limit
│   └── route-audit.test.ts                # Replace TODO with failing route registration audit
├── modules/
│   ├── auth/routes.ts                     # Migrate protected routes to SecureRoute
│   └── org/routes.ts                      # Migrate owner/admin routes to SecureRoute
└── workers/
    └── *.ts                               # Use shared background job RLS helper where jobs touch org data

packages/db/src/
├── index.ts                               # Add transaction helper if needed; preserve withOrg()
└── __tests__/rls-isolation.test.ts        # Extend for SecureRoute/background job query paths if appropriate
```

**And** `apps/api/src/lib/secure-route.ts` remains the import path unless the developer updates every current import and test in the same story.

**And** no new dependencies are added for authorization, transactions, or audit writing. Use Fastify 5, Drizzle 0.45.x, postgres.js, `@fastify/rate-limit`, and current internal helpers.

### AC-2: SecureRoute Defaults Are Secure by Omission

**Given** a developer registers a route through `SecureRoute`,
**when** no security options are supplied,
**then** the route defaults to:

| Concern | Default | Expected behavior |
|---|---|---|
| `requireAuth` | `true` | Missing or invalid JWT returns `401 { code: "access_token_missing" }` or `401 { code: "access_token_invalid" }`. |
| `requireOrgScope` | `true` | Handler receives a Drizzle transaction with `app.current_org_id` set to `request.authContext.orgId`. |
| `minimumRole` | `"viewer"` | Any active org member can access unless a higher role is configured. |
| `requireMfa` | `false` | Only elevated routes opt in, matching Story 1.9. |
| `writeAuditEvent` | `true` for mutating routes, `false` for pure reads unless explicitly configured | Protected writes create security audit rows in the same DB transaction. |
| `rateLimit` | enabled | Per-account limit applies to authenticated routes; public routes use existing IP-based Fastify rate limits. |

**And** public endpoints must opt out explicitly:

```typescript
secureRoute(fastify, {
  method: 'GET',
  url: '/health',
  security: {
    requireAuth: false,
    requireOrgScope: false,
    writeAuditEvent: false,
    rateLimit: false,
  },
  handler: async (_ctx, _req, reply) => reply.send({ status: 'ok' }),
})
```

**And** every opt-out must be named. There must be no shorthand like `public: true` that silently disables multiple concerns without making each disabled concern visible.

**Negative example that must fail review:**

```typescript
// Wrong: this route looks protected but bypasses the framework entirely.
fastify.route({
  method: 'GET',
  url: '/api/v1/org/security-alerts',
  handler: async (req, reply) => reply.send({ data: [] }),
})
```

### AC-3: SecureRoute API Shape and Handler Context

**Given** route handlers need typed access to auth context, org role, request-scoped transaction, and audit metadata,
**when** a route is registered,
**then** the handler receives a `SecureRouteContext` object rather than re-reading globals from `request`.

Recommended shape:

```typescript
export type SecureRouteContext = {
  auth: {
    userId: string
    orgId: string
    sessionId: string
    jti: string
    sessionVersion: number
    orgRole: OrgRole
  }
  tx: Tx
  audit: {
    eventType?: AuditEventType
    resourceType?: string
    resourceId?: string
    payload?: Record<string, unknown>
  }
}

export type SecureRouteOptions = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  schema?: FastifySchema
  security?: {
    requireAuth?: boolean
    requireOrgScope?: boolean
    minimumRole?: OrgRole
    allowedRoles?: OrgRole[]
    requireMfa?: boolean
    writeAuditEvent?: boolean | AuditConfig
    rateLimit?: false | { max: number; timeWindowMs?: number; key?: string }
  }
  handler: (
    ctx: SecureRouteContext,
    req: FastifyRequest,
    reply: FastifyReply
  ) => Promise<unknown> | unknown
}
```

**And** `ctx.tx` is the only approved database client for org-scoped queries inside protected route handlers.

**DB escape-hatch guard:** Protected route modules must not import `getDb()` directly. Route handlers that need org-scoped data use `ctx.tx`. If platform-level tables are genuinely needed, the route must declare `security.requireOrgScope: false` or use a named platform-access helper with a code comment explaining why RLS does not apply. Add a static route-audit test that scans protected route modules for direct `getDb` imports.

**And** if `requireAuth: false`, the handler receives a narrowed public context without `auth` or `tx`, unless `requireOrgScope` is separately provided through a trusted system context.

**And** TypeScript tests must prove a protected handler can use `ctx.auth.orgId` and `ctx.tx`, while a public handler cannot accidentally access a fake authenticated context.

**Developer ergonomics requirement:** SecureRoute must include a concise happy-path example for a protected read route and one migration example from the existing `registerProtectedRoute()` helper. If the API requires more than the route method, URL, schema, security overrides, and handler, reconsider the API before implementation.

### AC-4: Drizzle RLS Context Is Transaction-Scoped

**Given** PostgreSQL `SET LOCAL` and `set_config(..., true)` are transaction-scoped,
**when** `SecureRoute` executes an authenticated org-scoped request,
**then** all handler database queries run inside one Drizzle transaction after:

```typescript
await tx.execute(sql`SELECT set_config('app.current_org_id', ${auth.orgId}, true)`)
```

**And** the transaction automatically commits only after the handler and required audit write succeed.

**And** if the handler throws, validation fails after transaction start, or audit writing fails, the transaction rolls back.

**And** `app.current_org_id` must never be set on the global `getDb()` client outside a transaction.

**Example implementation pattern:**

```typescript
return getDb().transaction(async (tx) => {
  await setRlsOrgContext(tx, auth.orgId)

  const result = await options.handler({ auth, tx, audit: {} }, request, reply)

  if (auditConfig) {
    await writeAuditEntry(tx, buildAuditEntry({ auth, request, auditConfig }))
  }

  return result
})
```

**And** the story must preserve `packages/db/src/index.ts` `withOrg()` for tests and lower-level helpers while providing a request-friendly way to reuse the same transaction.

**Transaction duration guard:** SecureRoute transactions must contain only database work and the same-transaction audit write. CPU-heavy work, external HTTP calls, QR generation, email/Slack delivery, and pg-boss scheduling should happen before opening the transaction or after commit unless the scheduled job row is part of the atomic business operation. Add code-review checklist items for transaction boundaries.

**Response-after-commit guard:** Prefer SecureRoute handlers to return a serializable result instead of calling `reply.send()` inside the transaction. SecureRoute should send the response only after handler and audit write complete. If a handler must use `reply` directly (streaming, 204 responses, special headers), it must not perform any DB/audit work after sending. Add a test for audit failure after handler result generation to verify no success response is sent before rollback completes.

### AC-5: Auth Integration Uses Existing JWT and Session Rules

**Given** `plugins/authenticate.ts` already validates JWT, revoked tokens, idle timeout, session version, and org membership,
**when** `SecureRoute` requires auth,
**then** it reuses `fastify.authenticate` or `authenticateRequest()` rather than re-implementing token parsing.

**And** a missing auth plugin produces a startup/test error, not a silently public route:

```text
SecureRoute: requireAuth is true but fastify.authenticate is not registered
```

**And** invalid session cases keep the existing response semantics:

| Case | Expected response |
|---|---|
| Missing access cookie | `401 { code: "access_token_missing", message: "Access token is missing" }` |
| Invalid JWT | `401 { code: "access_token_invalid", message: "Access token is invalid" }` |
| Revoked session | `401 { code: "session_revoked", message: "Session has been revoked" }` |
| Idle timeout expired | `401 { code: "session_expired", message: "Session expired due to inactivity" }` |
| Deactivated org membership | `403 { code: "account_deactivated", message: "Account is deactivated" }` |

**And** `request.authContext` remains available for existing middleware during migration, but new route business logic should use `ctx.auth`.

### AC-6: Role Checks Are Centralized and Predictable

**Given** project/org roles are `owner`, `admin`, `member`, and `viewer`,
**when** a route declares `minimumRole` or `allowedRoles`,
**then** `SecureRoute` enforces it centrally before the handler runs.

Role hierarchy:

```text
owner > admin > member > viewer
```

Examples:

```typescript
secureRoute(fastify, {
  method: 'GET',
  url: '/security-alerts',
  security: { minimumRole: 'admin' },
  handler: async (ctx, _req, reply) => {
    const alerts = await listSecurityAlerts(ctx.tx, ctx.auth.orgId)
    return reply.send({ data: alerts })
  },
})
```

```typescript
secureRoute(fastify, {
  method: 'DELETE',
  url: '/users/:userId/sessions',
  security: {
    allowedRoles: ['owner', 'admin'],
    requireMfa: true,
    writeAuditEvent: {
      eventType: AuditEvent.SESSION_REVOKED,
      resourceType: 'user',
      resourceIdFromParams: 'userId',
    },
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  },
  handler: async (ctx, req, reply) => {
    // Business logic only. Auth, MFA, RLS, role, rate limit, and audit are framework concerns.
  },
})
```

**And** insufficient role returns:

```json
{ "code": "insufficient_role", "message": "Insufficient permissions" }
```

with HTTP status `403`.

**And** route code must not call `requireOrgRole()` directly after migration except inside the SecureRoute implementation or compatibility tests.

### AC-7: MFA Enforcement Is a First-Class SecureRoute Concern

**Given** Story 1.9 requires owner/admin privileged endpoints to enforce MFA after the grace period,
**when** a route uses `security.requireMfa: true`,
**then** `SecureRoute` applies the existing `requireMfaEnrollment()` check after auth and role validation and before the handler.

**And** privileged routes currently covered by `route-audit.test.ts` remain covered:

| Route | Requirement |
|---|---|
| `DELETE /api/v1/org/users/:userId/sessions` | Owner/admin plus MFA required. |
| Future invite/member-management routes | Owner/admin plus MFA required unless shared exemption registry explicitly exempts them. |
| `GET /api/v1/org/security-alerts` | Owner/admin route may remain MFA-exempt only if listed in `MFA_ENROLLMENT_EXEMPT_ROUTES`. |

**And** the shared `MFA_ENROLLMENT_EXEMPT_ROUTES` registry remains the single source for MFA exemptions.

### AC-8: Same-Transaction Security Audit Writes

**Given** the architecture requires audit writes to be in the same transaction as the operation they record,
**when** a SecureRoute route performs an auditable action,
**then** the audit row is inserted into `audit_log_entries` using the same `ctx.tx` transaction before the transaction commits.

**And** if the audit insert fails, the business operation rolls back and the client receives `500` or a controlled `503` depending on the failure classification.

**And** audit rows use the existing schema:

| Column | Source |
|---|---|
| `org_id` | `ctx.auth.orgId` |
| `actor_token_id` | Existing or resolved identity token for the user/machine actor; if unavailable in this story, use the existing audit helper contract and document the TODO explicitly. |
| `actor_type` | `human`, `machine_user`, or `system` |
| `event_type` | `AuditEvent.*` or a documented audit event string, not `OperationalEvent.*` |
| `resource_id` | Route params or handler-provided value |
| `resource_type` | Route config or handler-provided value |
| `ip_address` | `request.ip` |
| `user_agent` | `request.headers['user-agent']` |
| `payload` | Minimal non-secret metadata |
| `key_version` and `hmac` | Existing audit HMAC helper behavior |

**And** audit payloads must never include secret values, passwords, TOTP codes, recovery codes, JWTs, refresh tokens, API keys, or raw request bodies.

**Audit payload allowlist:** Audit payload builders must be allowlist-only for params, query, and body. No generic spreading (`{ ...req.params }`, `{ ...req.query }`, `{ ...req.body }`) is allowed in audit payload code. Add a test or static scan for spread usage in audit payload builders.

**Example audit config:**

```typescript
writeAuditEvent: {
  eventType: AuditEvent.SESSION_REVOKED,
  resourceType: 'session',
  resourceIdFromParams: 'sessionId',
  payload: ({ params }) => ({ scope: 'single', targetSessionId: params.sessionId }),
}
```

**And** an integration test demonstrates rollback:

1. Create a test route that inserts an org-scoped row using `ctx.tx`.
2. Force `writeAuditEvent` to fail.
3. Assert the inserted row is not visible after the request.
4. Assert no partial audit row exists.

**Audit failure coverage:** Tests must cover both classes of audit failure:

- persistence failure: insert into `audit_log_entries` fails
- integrity failure: HMAC/key-version generation fails before insert

Both failures must roll back the business operation and return controlled error semantics.

### AC-9: Audit and Operational Logs Stay Separate

**Given** Story 1.10 introduced structured operational logging,
**when** Story 1.11 records security events,
**then** intentional human/machine actions on protected resources are written to `audit_log_entries`.

**And** automated system process events continue to use operational logs or operational tables, not `audit_log_entries`, unless the system action is explicitly a compliance/security audit event.

Classification examples:

| Event | Destination |
|---|---|
| User revokes a session | `audit_log_entries` |
| User reveals a secret value | `audit_log_entries` |
| User changes another user's role | `audit_log_entries` |
| Background job prunes expired failed-auth rows | Operational log |
| Background job detects failed-auth threshold and creates a security alert | Business table plus operational log; audit only if a human/machine actor intentionally triggered it |
| HTTP request completed | Pino operational log only |

**And** tests should use `AuditEvent` constants for DB audit rows and `OperationalEvent` constants only for stdout logs.

### AC-10: Background Job RLS Context

**Given** architecture requires background jobs to enforce org context through the same PostgreSQL RLS mechanism as HTTP requests,
**when** a pg-boss job handler touches org-scoped tables,
**then** it must run through a shared helper that sets `app.current_org_id` in a transaction before any query.

Required helper behavior:

```typescript
export async function runOrgScopedJob<T>(
  orgId: string,
  jobName: string,
  fn: (ctx: { tx: Tx; orgId: string }) => Promise<T>
): Promise<T> {
  return getDb().transaction(async (tx) => {
    await setRlsOrgContext(tx, orgId)
    return fn({ tx: tx as Tx, orgId })
  })
}
```

**And** any org-scoped job payload schema must require `orgId`.

**And** a job payload without `orgId` must fail before any DB query.

**Background job schema guard:** Any job that touches org-scoped tables must validate an `orgId` field in its payload schema before opening a transaction. Missing or invalid `orgId` fails before any DB query. Add a test for invalid UUID and missing org ID.

**And** background jobs must not call `getDb().select()` against org-scoped tables directly.

**Background job DB escape-hatch guard:** Static route/job audit scans must also cover `apps/api/src/workers/**`. Worker modules that touch org-scoped tables must not import `getDb()` directly; they must use `runOrgScopedJob()` or a named platform-access helper with a comment explaining why RLS does not apply.

**And** integration tests cover:

| Test | Expected result |
|---|---|
| Job with Org A context queries a table containing Org A and Org B rows | Only Org A rows are visible. |
| Job with Org B context | Only Org B rows are visible. |
| Job without orgId | Handler rejects before query. |
| Job accidentally uses bare `getDb()` in test harness | Returns zero rows or route-audit/static guard catches it. |

### AC-11: Rate Limiting Is Applied by SecureRoute

**Given** authenticated endpoints need per-account rate limiting,
**when** a SecureRoute route uses default security,
**then** an authenticated user receives a per-account rate limit keyed by user ID plus route key.

**And** routes can override limits:

```typescript
security: {
  rateLimit: { max: 10, timeWindowMs: 60 * 60 * 1000, key: 'POST /auth/mfa/enroll' },
}
```

**And** explicit opt-out is allowed only for routes that document why rate limiting does not apply:

```typescript
security: {
  rateLimit: false, // allowed only for health/ready/metrics or internal test-only routes
}
```

**And** rate-limit failures return:

```json
{
  "code": "rate_limit_exceeded",
  "message": "Too many authenticated requests",
  "retryAfter": 60
}
```

**And** this story may keep the current in-memory `enforceUserRateLimit()` implementation for v1, but the call site must live inside SecureRoute so future durable/distributed rate limiting is centralized.

### AC-12: Route Registration Audit Replaces the TODO

**Given** `apps/api/src/__tests__/route-audit.test.ts` currently contains `it.todo('every /api/v1/ route must be registered via SecureRoute')`,
**when** Story 1.11 is complete,
**then** that TODO is replaced with a real failing test or ESLint rule.

Minimum acceptable implementation:

```typescript
it('every non-public /api/v1 route is registered via SecureRoute', () => {
  // Scans route modules and fails on raw fastify.route/get/post/put/patch/delete
  // unless the route is in the explicit public exemption registry.
})
```

**And** create a shared registry for public or intentionally raw routes:

```typescript
export const PUBLIC_ROUTE_EXEMPTIONS = [
  'GET /health',
  'GET /ready',
  'GET /metrics',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/mfa/recover',
  'POST /api/v1/vault/init',
  'POST /api/v1/vault/unseal',
] as const
```

**And** exemptions must include a reason in comments or metadata:

```typescript
{
  route: 'POST /api/v1/auth/login',
  reason: 'Public credential exchange endpoint; protected by IP/email rate limits and failed-auth recording.',
  securityOwner: 'api-security-reviewer',
  compensatingControls: ['ip-rate-limit', 'failed-auth-recording'],
  expiresAfterStory: null,
}
```

**Public exemption metadata:** Every public/raw route exemption must include:

- route
- reason
- security owner or reviewer
- compensating controls, such as IP rate limit, failed-auth recording, or no data access
- expiration or revisit story if the exemption is temporary

The route-audit test fails exemptions missing required metadata.

**Exemption lifecycle guard:** Public/raw route exemptions marked temporary must include `expiresAfterStory` or `revisitBy`. The route-audit test fails if a temporary exemption has expired or references a completed story without being removed or renewed.

**And** method-not-allowed helper routes may be exempt from SecureRoute only if their source module comments explain they do not touch data and exist only to preserve API behavior.

**And** the test fails if a new protected route uses raw `fastify.route()` or Fastify shorthand methods outside `SecureRoute`.

**Helper registration guard:** Any helper that registers Fastify routes (`registerMethodNotAllowed`, `publicRoute`, `secureRoute`, or future route wrappers) must be included in the route-audit test's allowlist with an explicit classification:

- `secure`: applies SecureRoute defaults
- `public-exempt`: requires public exemption registry entry with reason
- `shell-only`: method-not-allowed or static response only; must not read request body, auth context, or database

The audit test fails for any unclassified helper that calls `fastify.route()` or Fastify shorthand methods.

### AC-13: Existing Route Migration

**Given** `authRoutes` and `orgRoutes` currently use raw route registration and custom wrappers,
**when** Story 1.11 is complete,
**then** migrate at least all protected `/api/v1/auth/*` and `/api/v1/org/*` routes to SecureRoute.

Required migrations:

| Current route | SecureRoute requirement |
|---|---|
| `GET /api/v1/auth/me` | Auth required, viewer role minimum, no audit write, rate limited. |
| `POST /api/v1/auth/mfa/enroll` | Auth required, viewer role minimum, audit event for MFA enrollment start/complete remains in service layer or route transaction, rate limited. |
| `POST /api/v1/auth/mfa/verify-enrollment` | Auth required, viewer role minimum, audit event remains in service layer or route transaction, rate limited. |
| `POST /api/v1/auth/mfa/regenerate-recovery-codes` | Auth required, viewer role minimum, sensitive audit event, rate limited. |
| `GET /api/v1/auth/sessions` | Auth required, viewer role minimum, no audit write, rate limited. |
| `DELETE /api/v1/auth/sessions` | Auth required, viewer role minimum, audit event for logout/session revocation, rate limited. |
| `DELETE /api/v1/auth/sessions/:sessionId` | Auth required, viewer role minimum, audit event for session revocation, rate limited. |
| `POST /api/v1/auth/logout` | Auth required, viewer role minimum, audit event for logout, rate limited. |
| `GET /api/v1/org/security-alerts` | Auth required, admin/owner, MFA exemption only if shared registry says so, no audit write for read. |
| `DELETE /api/v1/org/users/:userId/sessions` | Auth required, admin/owner, MFA required, audit event, rate limited. |

**And** public auth exchange endpoints may remain raw or use a `publicRoute()` wrapper:

| Public route | Required protection even though unauthenticated |
|---|---|
| `POST /api/v1/auth/register` | IP rate limit, input validation, failed registration behavior preserved. |
| `POST /api/v1/auth/login` | IP or email rate limit, failed auth recording preserved. |
| `POST /api/v1/auth/refresh` | Refresh token validation, rate limit preserved. |
| `POST /api/v1/auth/mfa/recover` | Existing IP/email rate limits preserved. |

**Audit event coverage matrix:** Migrating existing routes requires a table that records, for each protected route:

- whether it is `read`, `sensitive-read`, `mutation`, or `security-action`
- whether it writes an audit event
- event type, if applicable
- reason if no audit event is written

This matrix lives in the story or route-audit test fixture and becomes the review checklist for future route migrations.

**Route action classification:** The route audit matrix must classify each route as one of:

- `read`: no audit by default
- `sensitive-read`: audit required, e.g. future secret reveal
- `mutation`: audit required unless explicitly justified
- `security-action`: audit required, e.g. session revocation, MFA recovery, role changes

A route marked `mutation` or `security-action` without an audit event must include a reason and reviewer approval.

### AC-14: RLS Correctness Tests Cover HTTP and Job Paths

**Given** `packages/db/src/__tests__/rls-isolation.test.ts` already verifies table-level isolation for direct helpers,
**when** SecureRoute is implemented,
**then** add API integration tests proving RLS applies through request handlers.

Required integration tests:

1. `GET /api/v1/test/rls-current-org` test-only route registered via SecureRoute returns the current DB setting:

```sql
SELECT current_setting('app.current_org_id', true) AS current_org_id
```

Expected: value equals authenticated user's `orgId`.

2. Authenticated Org A request to a test route querying an org-scoped table sees only Org A rows.

3. Authenticated Org B request to the same route sees only Org B rows.

4. Bare query without SecureRoute context returns zero rows for an org-scoped table, preserving Story 1.4 behavior.

5. Background job helper with Org A context sees only Org A rows.

**And** test-only routes must live under `apps/api/src/__tests__/helpers/` or be registered only inside test files. They must not be imported by `app.ts` or `main.ts`; preserve the existing production-entrypoint guard.

**Test-only route production guard:** Any test-only route helper used for SecureRoute/RLS integration tests must live under `apps/api/src/__tests__/helpers/` or be registered inline in the test. `app.ts` and `main.ts` must not import it. Preserve the production-entrypoint guard from Story 1.9 and extend it to SecureRoute test helpers.

### AC-15: Same-Transaction Audit Test

**Given** audit completeness is an architectural invariant,
**when** a route mutates data and writes an audit event,
**then** tests prove the operation and audit row commit or roll back together.

Required test cases:

| Scenario | Expected result |
|---|---|
| Handler succeeds and audit write succeeds | Business row exists; audit row exists with matching `org_id`, `event_type`, `resource_id`. |
| Handler succeeds but audit write is forced to fail | Business row does not exist; audit row does not exist; response indicates failure. |
| Handler throws before audit write | Business row does not exist; audit row does not exist. |
| Audit payload contains forbidden fields | Route rejects or strips them before writing. |

**Example forced failure approach:**

```typescript
secureRoute(fastify, {
  method: 'POST',
  url: '/test/audit-fail',
  security: {
    writeAuditEvent: {
      eventType: 'test.audit_failure',
      resourceType: 'test',
      forceFailureForTest: true,
    },
  },
  handler: async (ctx) => {
    await ctx.tx.insert(securityAlerts).values({
      orgId: ctx.auth.orgId,
      alertType: 'test',
      severity: 'info',
    })
  },
})
```

Use dependency injection or a test-only audit writer override rather than adding production-only failure flags.

### AC-16: Secret and PII Safety

**Given** SecureRoute will sit on the critical path for protected endpoints,
**when** it builds audit payloads, error responses, and logs,
**then** it must not capture raw request bodies by default.

Forbidden in audit payloads:

```text
password
passphrase
masterKeyPath
envelopeKeyPath
secret
value
authorization
cookie
accessToken
refreshToken
totp
recoveryCode
apiKey
```

**And** any payload builder receives a sanitized view or must explicitly pick allowed fields:

```typescript
payload: ({ params }) => ({
  targetUserId: params.userId,
  scope: 'all_sessions',
})
```

**And** no `err.message` from database/auth failures is used as an audit payload value or client-facing message if it may include SQL fragments or sensitive data.

**Params/query sensitivity:** Sensitive values are forbidden in params and query strings as well as bodies. Audit payload builders must treat params/query as untrusted and allowlist exact non-sensitive fields only. Add negative tests with sensitive sentinels in params and query.

**And** a test injects forbidden fields into a request body and asserts:

1. No audit row payload contains those values.
2. No operational log line contains those values.
3. The route response does not echo those values.

### AC-17: Error Semantics

**Given** SecureRoute centralizes pre-handler failures,
**when** a concern rejects a request,
**then** errors are consistent with existing API contracts.

| Failure | Status | Body |
|---|---:|---|
| Missing/invalid auth | 401 | Existing auth plugin body |
| Missing org auth context after auth | 401 | `{ code: "access_token_missing", message: "Access token is missing" }` |
| Insufficient role | 403 | `{ code: "insufficient_role", message: "Insufficient permissions" }` |
| MFA required | 403 | Existing Story 1.9 `mfa_required` body |
| Rate limited | 429 | Existing authenticated rate-limit body |
| RLS setup failure | 503 | `{ code: "service_unavailable", message: "Database security context unavailable" }` |
| Audit write failure | 503 | `{ code: "audit_write_failed", message: "Audit logging is unavailable" }` |
| Handler throws unexpected error | 500 | Existing app error handler shape |

**And** errors raised inside a transaction must roll back the transaction.

### AC-18: OpenAPI and Type Provider Compatibility

**Given** `apps/api/src/app.ts` uses `@fastify/type-provider-zod` and OpenAPI auto-generation,
**when** routes migrate to SecureRoute,
**then** schemas remain attached to Fastify route options so generated OpenAPI output does not regress.

**And** `withRouteTypeProvider(fastify)` remains compatible with SecureRoute.

**And** response schemas for migrated routes continue to include `ApiErrorSchema` where they did before.

**And** `pnpm --filter @project-vault/api generate-spec` succeeds after migration.

### AC-19: Tests and Verification Commands

**Given** this story changes shared request infrastructure,
**when** implementation is complete,
**then** run and pass at minimum:

```bash
pnpm --filter @project-vault/api test -- secure-route
pnpm --filter @project-vault/api test -- secure-route.integration
pnpm --filter @project-vault/api test -- route-audit
pnpm --filter @project-vault/db test -- rls-isolation
pnpm --filter @project-vault/api typecheck
pnpm --filter @project-vault/db typecheck
pnpm --filter @project-vault/api generate-spec
pnpm check-rls
```

**And** because this is a security framework story, also run the focused existing regression tests:

```bash
pnpm --filter @project-vault/api test -- sessions.integration
pnpm --filter @project-vault/api test -- mfa-enforcement-failed-auth.integration
pnpm --filter @project-vault/api test -- route-audit
```

**And** if test database availability prevents running DB integration tests, the developer must document the exact command attempted and the blocking error in the Dev Agent Record.

**And** run the static guardrail scans introduced in AC-3, AC-10, AC-12, and AC-16 (raw `fastify.route` usage, direct `getDb` imports in route/worker modules, audit payload spreads, and exemption metadata completeness) as part of the route-audit test suite.

## Tasks / Subtasks

- [ ] **Task 1: Write failing tests first** (AC: 2, 4, 8, 10, 12, 14, 15)
  - [ ] Replace `route-audit.test.ts` TODO with a failing raw-route detection test.
  - [ ] Add SecureRoute unit tests for default auth, explicit opt-outs, role ordering, MFA option, and missing auth plugin error.
  - [ ] Add API integration tests for current org setting, cross-org isolation through a route, unauthenticated rejection, insufficient role rejection, and rate limiting.
  - [ ] Add same-transaction audit rollback test.
  - [ ] Add background job RLS helper tests.

- [ ] **Task 2: Expand SecureRoute framework** (AC: 1, 2, 3, 5, 6, 7, 11, 18)
  - [ ] Expand `apps/api/src/lib/secure-route.ts` instead of creating a duplicate framework.
  - [ ] Implement secure defaults with explicit named opt-outs.
  - [ ] Define `SecureRouteContext`, protected/public context typing, and `SecureRouteOptions`.
  - [ ] Reuse `fastify.authenticate` and existing auth error semantics.
  - [ ] Centralize role checks, MFA enforcement, and authenticated rate limiting.
  - [ ] Preserve schema/OpenAPI registration compatibility.

- [ ] **Task 3: Implement RLS transaction helper** (AC: 4, 10, 14)
  - [ ] Add `setRlsOrgContext(tx, orgId)` using `SELECT set_config('app.current_org_id', orgId, true)`.
  - [ ] Ensure all SecureRoute handler DB work uses the same transaction.
  - [ ] Add `runOrgScopedJob()` or equivalent for pg-boss jobs with org-scoped data.
  - [ ] Reject invalid/missing org IDs before queries.

- [ ] **Task 4: Implement same-transaction audit writer integration** (AC: 8, 9, 15, 16, 17)
  - [ ] Adapt existing `modules/audit/write-entry.ts` HMAC helper to support inserting via `ctx.tx`.
  - [ ] Add audit config support to SecureRoute.
  - [ ] Ensure audit payload builders are allowlist-based and never capture raw request bodies.
  - [ ] Ensure audit write failure rolls back business writes.
  - [ ] Keep security audit DB rows separate from Pino operational logs.

- [ ] **Task 5: Migrate existing protected routes** (AC: 7, 12, 13, 18)
  - [ ] Migrate protected `/api/v1/auth/*` routes currently registered through `registerProtectedRoute()`.
  - [ ] Migrate `/api/v1/org/security-alerts`.
  - [ ] Migrate `/api/v1/org/users/:userId/sessions` with admin/owner plus MFA.
  - [ ] Preserve public auth exchange routes with explicit exemptions or `publicRoute()`.
  - [ ] Remove or simplify legacy helpers once no longer needed.

- [ ] **Task 6: CI/static guardrails** (AC: 3, 10, 12)
  - [ ] Add public route exemption registry with reasons.
  - [ ] Fail tests on raw protected `fastify.route()` or shorthand calls.
  - [ ] Preserve production-entrypoint guard against test-only routes.
  - [ ] If implementing ESLint rule, name it `no-raw-fastify-route`; otherwise make the route-audit test mandatory and reliable.

- [ ] **Task 7: Regression and docs** (AC: 19)
  - [ ] Run focused API and DB tests listed in AC-19.
  - [ ] Run typecheck for API and DB packages.
  - [ ] Run OpenAPI spec generation.
  - [ ] Document any test database blockers in Dev Agent Record.

- [ ] **Task 8: Elicitation hardening guardrails** (AC: 3, 4, 8, 10, 12, 13, 16)
  - [ ] Static scan: protected route modules and `apps/api/src/workers/**` must not import `getDb()` for org-scoped tables
  - [ ] Route-audit helper classification (`secure` / `public-exempt` / `shell-only`) with failure on unclassified route-registering helpers
  - [ ] Public exemption registry metadata (reason, security owner, compensating controls) + temporary-exemption lifecycle (`expiresAfterStory` / `revisitBy`)
  - [ ] Route action classification matrix (`read` / `sensitive-read` / `mutation` / `security-action`) enforced in route-audit fixture
  - [ ] Audit payload allowlist scan: no `{ ...req.params }`, `{ ...req.query }`, `{ ...req.body }` spreads; params/query sensitivity negative tests
  - [ ] Audit failure coverage: both persistence failure and HMAC/key integrity failure roll back
  - [ ] Response-after-commit guard test
  - [ ] Background job schema guard: org-scoped job payloads validate `orgId` before any query

## Dev Notes

### Current Codebase State

The repo already contains partial work that must be reused:

| Existing file | What to do |
|---|---|
| `apps/api/src/lib/secure-route.ts` | Placeholder with `secureRoutes` and `buildSecurePreHandlers()`. Expand or replace in place. |
| `apps/api/src/lib/secure-route.test.ts` | Expand beyond pre-handler ordering into full SecureRoute behavior. |
| `apps/api/src/__tests__/route-audit.test.ts` | Contains the exact TODO this story must close. |
| `packages/db/src/index.ts` | `withOrg()` already sets `app.current_org_id` inside a transaction. Reuse concept; add request-scoped transaction helper. |
| `packages/db/src/__tests__/rls-isolation.test.ts` | Existing direct RLS tests; extend with route/job path coverage. |
| `packages/db/src/schema/audit-log-entries.ts` | Canonical security audit table. |
| `apps/api/src/plugins/authenticate.ts` | Canonical JWT/session/auth-context implementation. Do not duplicate. |
| `apps/api/src/plugins/require-org-role.ts` | Role check behavior to centralize inside SecureRoute. |
| `apps/api/src/modules/auth/mfa-enforcement.ts` | MFA enforcement behavior to call from SecureRoute. |
| `apps/api/src/lib/route-helpers.ts` | Legacy protected-route and in-memory rate-limit helpers. Move concern ownership into SecureRoute. |

### Existing RLS Pattern

`packages/db/src/index.ts` already has:

```typescript
export async function withOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_REGEX.test(orgId)) {
    throw new Error(`withOrg: invalid orgId - expected UUID, received: "${orgId}"`)
  }
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`)
    return fn(tx as unknown as Tx)
  })
}
```

SecureRoute should apply the same transaction-scoped setting, but it must keep the transaction open for the full handler and the audit write. Avoid this anti-pattern:

```typescript
// Wrong: the RLS context is set only inside withOrg(), then the handler uses bare getDb().
await withOrg(auth.orgId, async (tx) => tx.execute(sql`SELECT 1`))
return handlerUsingGetDb()
```

Correct pattern:

```typescript
// Correct: handler receives the same tx after RLS context is set.
await getDb().transaction(async (tx) => {
  await setRlsOrgContext(tx, auth.orgId)
  return handler({ auth, tx: tx as Tx }, request, reply)
})
```

### Audit HMAC and Immutability

`apps/api/src/modules/audit/write-entry.ts` currently exports `computeAuditHmac()`. Story 1.11 should not invent a second checksum format. If the current helper only computes HMAC and does not insert rows, add a small insert helper that accepts `tx`.

Audit table invariants from `packages/db/src/schema/audit-log-entries.ts`:

- `audit_log_entries` is append-only.
- It has no `updated_at`.
- It has composite indexes for org, project, event type, and resource filters.
- `actor_type` is constrained to `human`, `machine_user`, or `system`.
- `project_id` has no FK until Story 2.1; do not add that FK in this story.

### API Contract Notes

The current API has a mixed response shape:

- Some routes use `{ code, message }`.
- App-level `AppError` mapping currently lowercases into `{ error, message }`.
- Story 1.2 established `ApiError` as `{ code, message, details? }`.

For SecureRoute pre-handler failures, preserve the existing route-level auth/role/MFA response bodies so tests do not regress. Do not perform a broad API error-shape refactor in this story.

### Fastify 5 Notes

Fastify supports both full route declaration and shorthand route methods with `preHandler` as a function or array. SecureRoute may call `fastify.route()` internally; the rule is that product route modules must not call raw Fastify route registration directly for protected routes.

Use route options with handler attached once. Fastify throws if a handler is supplied both inside options and as a separate shorthand argument.

### Drizzle RLS Notes

Drizzle does not provide a magic per-request RLS context. PostgreSQL RLS sees session settings on the transaction connection. `set_config(..., true)` is equivalent to `SET LOCAL`; it is cleared on transaction end. Therefore:

- Every RLS-dependent handler must run in the transaction where the setting was applied.
- Do not hold transactions open across external HTTP calls or long-running work.
- Keep route transactions short.
- For background jobs, set org context inside the job transaction before any org-scoped query.

### Security Anti-Patterns

Do not:

- Register protected routes with raw `fastify.route()`, `fastify.get()`, `fastify.post()`, etc.
- Use `getDb()` directly inside SecureRoute protected handlers for org-scoped tables.
- Set `app.current_org_id` outside a transaction.
- Filter by `orgId` only in application code and call that RLS.
- Write audit rows after the transaction commits.
- Continue the business operation if audit writing fails.
- Put request bodies, secret values, passwords, JWTs, recovery codes, TOTP codes, or API keys into audit payloads.
- Reuse `OperationalEvent` constants for security audit DB rows.
- Add a second route security abstraction with a different API.
- Remove existing auth/session revocation behavior while centralizing it.
- Add project-table foreign keys to `audit_log_entries`; Story 2.1 owns that.

## Previous Story Intelligence

### Story 1.4 - Database Foundation

- `withOrg()` and `withOrgReadScope()` already set `app.current_org_id` with `set_config(..., true)`.
- RLS isolation tests already prove direct helper behavior for `sessions`, `org_memberships`, `security_alerts`, and `audit_log_entries`.
- `check-rls-coverage.ts` verifies RLS policy presence for org-scoped tables; it does not prove every API query path uses the right org context.
- 1.11 must add request/job correctness, not replace the coverage guard.

### Story 1.6 - Registration, Login, Sessions

- `plugins/authenticate.ts` is the canonical source for access-token parsing, revocation checks, idle timeout, session version validation, org membership loading, and `request.authContext`.
- Auth services already write security-relevant events in places. Preserve existing service-level audit behavior while moving route cross-cutting concerns into SecureRoute.
- Be careful around refresh/login/register public routes. They are unauthenticated but still security-sensitive and rate-limited.

### Story 1.8 - MFA Enrollment and Recovery Codes

- TOTP secrets and recovery codes are sensitive. SecureRoute audit payload builders must never capture raw body values from MFA endpoints.
- MFA recovery remains public by design but protected by rate limits and failed-auth recording.

### Story 1.9 - MFA Role Enforcement and Failed Auth Detection

- Owner/admin privileged routes currently require MFA through `requireMfaEnrollment()`.
- `route-audit.test.ts` already audits owner/admin route MFA coverage. 1.11 should preserve this and add raw-route coverage.
- The latest commits fixed review issues for Story 1.9, so do not undo its route exemptions, shared MFA registry, or production-entrypoint guard.

### Story 1.10 - Structured Operational Logging and Metrics

- 1.10 explicitly distinguishes SecureRoute audit writes from operational Pino logs.
- Operational logs use `OperationalEvent`; security audit rows use `AuditEvent` or explicit audit event strings.
- Redaction requirements from 1.10 apply to logs; 1.11 must add equivalent allowlist discipline for audit payloads.

## Git Intelligence Summary

Recent commits:

```text
28c3a88 fix(core): code review fixes for story 1.9 mfa enforcement and failed auth detection
883d8db feat(core): mfa role enforcement and failed authentication detection
4a0a55b fix(core): complete mfa enrollment ci cleanup
befebc6 feat(core): totp mfa enrollment and recovery codes
5f6cc3f feat(docs): add additional story
```

Actionable implications:

- Current branch is security/auth heavy; expect adjacent uncommitted changes around MFA, logging, and route enforcement.
- Preserve Story 1.9 behavior and tests.
- Avoid broad route rewrites that change public auth endpoint semantics.
- Keep implementation focused on centralizing existing patterns and adding RLS/audit guarantees.

## Latest Tech Information

| Technology | Current repo version | Story impact |
|---|---:|---|
| Fastify | `^5.8.5` | Route options support `preHandler` arrays; SecureRoute can call `fastify.route()` internally. |
| `@fastify/rate-limit` | `^10.3.0` | Public auth endpoints already use plugin rate limiting; authenticated SecureRoute can keep existing per-user helper for now. |
| Drizzle ORM | `^0.45.0` | Use transaction callback and `tx.execute(sql\`SELECT set_config(...)\`)`; no automatic request RLS context. |
| postgres.js | `^3.4.x` | Transaction callback holds a dedicated connection; keep transactions short. |
| Vitest | `^3.2.6` | Add focused unit/integration tests; use existing test helper patterns. |
| TypeScript | `^5.7.3` | Model public vs protected route contexts with types where practical. |

## References

- Story 1.11 source: [_bmad-output/planning-artifacts/epics.md#Story-1.11-SecureRoute-Framework--Drizzle-RLS-Middleware]
- RLS architecture: [_bmad-output/planning-artifacts/architecture.md#Technical-Constraints--Dependencies]
- Cross-cutting concerns: [_bmad-output/planning-artifacts/architecture.md#Cross-Cutting-Concerns-Identified]
- Security architecture: [_bmad-output/planning-artifacts/architecture.md#Security-Architecture]
- PRD tenant isolation: [_bmad-output/planning-artifacts/prd.md#Tenant-Model]
- PRD audit requirements: [_bmad-output/planning-artifacts/prd.md#Audit--Compliance]
- UX security principle: [_bmad-output/planning-artifacts/ux-design-specification.md#Key-Design-Challenges]
- Current SecureRoute placeholder: [apps/api/src/lib/secure-route.ts]
- Current route audit: [apps/api/src/__tests__/route-audit.test.ts]
- Current DB RLS helper: [packages/db/src/index.ts]
- Current RLS isolation tests: [packages/db/src/__tests__/rls-isolation.test.ts]
- Current audit schema: [packages/db/src/schema/audit-log-entries.ts]
- Fastify route docs: [https://fastify.io/docs/latest/Reference/Routes/](https://fastify.io/docs/latest/Reference/Routes/)
- Drizzle transactions docs: [https://orm.drizzle.team/docs/transactions](https://orm.drizzle.team/docs/transactions)
- Drizzle RLS docs: [https://orm.drizzle.team/docs/rls](https://orm.drizzle.team/docs/rls)

## Checklist Validation Notes

- Reinvention prevention: story directs dev agent to expand existing `apps/api/src/lib/secure-route.ts`, reuse `withOrg()` pattern, reuse auth plugin, reuse MFA helper, and reuse audit HMAC helper.
- Wrong-location prevention: resolves `packages/api` vs `apps/api` and `framework` vs existing `lib` path.
- Regression prevention: requires migration tests for auth/session/MFA routes and route-audit TODO closure.
- Security prevention: requires same-transaction audit writes, RLS transaction scoping, public route exemption registry, forbidden audit payload fields, and background job RLS.
- LLM clarity: acceptance criteria include examples, negative examples, exact paths, commands, and explicit out-of-scope boundaries.

## ADRs

### ADR-1.11-01: SecureRoute Lives in `apps/api/src/lib/secure-route.ts`

| | |
|---|---|
| **Context** | The epic references `apps/api/src/framework/secure-route.ts`, but the repo already has `apps/api/src/lib/secure-route.ts` and tests import it. |
| **Decision** | Expand the existing `apps/api/src/lib/secure-route.ts` module in place. Do not create a second route-security abstraction unless all imports/tests are migrated in the same change. |
| **Consequences** | Prevents duplicate frameworks and preserves current test paths. Future refactors may move it to `framework/`, but only as a deliberate rename, not during behavioral implementation. |

### ADR-1.11-02: RLS Context Is Bound to the Handler Transaction

| | |
|---|---|
| **Context** | `set_config(..., true)` behaves like `SET LOCAL`; it is scoped to the current PostgreSQL transaction. Calling `withOrg()` before a handler and then using `getDb()` inside the handler loses the RLS context. |
| **Decision** | `SecureRoute` opens the transaction, sets `app.current_org_id`, passes `ctx.tx` to the handler, and writes audit rows before the same transaction commits. |
| **Consequences** | Route handlers must use `ctx.tx` for org-scoped tables. Long-running external calls must not happen inside SecureRoute transactions. If a route needs external I/O, split it into pre-transaction validation, short DB transaction, and post-commit side effect. |

### ADR-1.11-03: Audit Writes Are Mandatory for Auditable Mutations

| | |
|---|---|
| **Context** | Architecture requires same-transaction audit writes; operation success without audit capture violates FR40 and audit completeness. |
| **Decision** | For routes with `writeAuditEvent`, audit insert failure rolls back the business operation. |
| **Consequences** | Some user-facing operations may fail when audit storage is unhealthy. This is intentional. Story 1.11 must expose controlled error semantics and tests for audit-write failure rollback. |

### ADR-1.11-04: Raw Fastify Routes Are Allowed Only Through Explicit Public Exemptions

| | |
|---|---|
| **Context** | Existing route modules use raw `fastify.route()`, and some public endpoints must remain unauthenticated. |
| **Decision** | Protected routes must use `SecureRoute`. Public/raw routes require an explicit exemption registry entry with a reason. |
| **Consequences** | The route audit test becomes the enforcement mechanism until a custom ESLint rule exists. Method-not-allowed helper routes may be exempt only if they do not touch data and are documented as behavior-preserving API shell routes. |

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List

