# Story 6.3: Cross-Project Health Dashboard & Public Status Page

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-07-04 — comprehensive developer guide for the
THIRD story in Epic 6. This story creates the org-wide `GET /api/v1/health-dashboard` endpoint, a
public shareable status page (`status_pages` + `status_page_services` tables, opaque-token
auth-free access), and the SvelteKit UI for both. Read "Architecture, Sequencing & Scope
Resolution" below before touching anything — this story has a HARD PREREQUISITE on Story 6.2
(HTTP Endpoint Monitoring & Availability Alerts), which was still `backlog` at the time this story
was written. Do not skip that section. -->

## Story

As a developer or external stakeholder,
I want a cross-project health overview and a shareable public status page for selected services,
so that I can monitor all my services in one view and share status with stakeholders who don't have vault accounts.

*Covers: FR76, FR77, FR72.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-6.3-Cross-Project-Health-Dashboard--Public-Status-Page` (lines 1724-1748)]

---

## Architecture, Sequencing & Scope Resolution (Read Before Coding)

This story sits downstream of two prior decisions — Story 6.1's already-shipped schema (`payment_records`/`cert_records`/`domain_records`, no unified `monitored_assets` table — see ADR-6.1-01/02/03 in `6-1-service-certificate-and-domain-record-management.md`) and Story 6.2's HTTP health-check data model, which **does not exist in the codebase yet** (confirmed: `sprint-status.yaml` shows `6-2-http-endpoint-monitoring-and-availability-alerts: backlog` as of this story's writing; no `service_endpoints`/`endpoint_health_checks` table or `workers/health-check.ts` exists in `packages/db/src/schema/` or `apps/api/src/workers/`). Resolve exactly as follows:

**ADR-6.3-01: Hard prerequisite on Story 6.2 — do not start 6.3 implementation until 6.2 is merged.** FR76's `GET /api/v1/health-dashboard` AC literally requires per-service `status: "healthy"|"degraded"|"down"` and `lastCheckedAt` — this is HTTP-check data, not expiry data. Story 6.1's `payment_records` table (the "services" resource, `url` nullable) has no health-check columns; that data is Story 6.2's entire scope. **If you have picked up this story and Story 6.2 is not `done`, stop and implement/merge Story 6.2 first** — do not invent a parallel health-check mechanism inside 6.3, and do not silently return `healthy` for everything. This mirrors the discipline of `6-1`'s "do not create `service_endpoints`, Story 6.2 owns it" boundary, applied in the other direction.

**ADR-6.3-02: Contract boundary with Story 6.2 (interface, not a table-name guess).** Rather than guessing Story 6.2's physical table name (epics.md's Story 6.2 draft AC says checks are recorded "in `endpoint_health_checks`"; architecture.md's canonical schema instead names a `service_endpoints` table — the same kind of epics.md-vs-architecture.md disagreement ADR-6.1-01 resolved for 6.1, left unresolved for 6.2 as of this writing), this story depends on a **repository function contract**, not a table:
```ts
// Expected shape — Story 6.2 must provide this (exact file path is 6.2's decision;
// suggested: apps/api/src/modules/monitoring/health-check-status.ts)
export type ServiceHealthStatus = {
  serviceId: string          // payment_records.id
  isDown: boolean            // true once 2 consecutive failed checks (AC-E6a) have occurred
  lastCheckStatus: 'healthy' | 'unhealthy' | null  // null = no check has ever run
  lastCheckedAt: string | null  // ISO 8601, null = no check has ever run
  checkIntervalMinutes: number  // per-service configured interval (AC-E6a: 1/5/15/30, default 5)
}
export async function getServiceHealthStatuses(
  tx: Tx,
  serviceIds: string[]
): Promise<Map<string, ServiceHealthStatus>>
```
If Story 6.2 lands this function under a different name/location, update the single call site in this story's `health-dashboard-service.ts` — the rest of 6.3 is insulated from 6.2's internal table shape by this one function boundary. **Before starting Task 2 below, locate Story 6.2's actual implementation and confirm/adjust this contract — do not guess column names from epics.md prose.**

**ADR-6.3-03: "degraded" status definition (resolves an unspecified 3rd state).** Story 6.2's epics.md AC only defines two check outcomes (`healthy`/`unhealthy` per check) and one derived state (`down` after 2 consecutive `unhealthy`) — it never defines "degraded". FR76/Story 6.3's AC requires a 3-way enum (`"healthy"|"degraded"|"down"`). Resolution — compute per service from the `ServiceHealthStatus` contract above:
- **`down`**: `isDown === true`.
- **`degraded`**: `isDown === false` AND (`lastCheckStatus === null` [no check has run yet — e.g. service just registered] OR `lastCheckStatus === 'unhealthy'` [one failed check, not yet at the 2-consecutive threshold] OR the check is **stale**: `lastCheckedAt` is older than `2 × checkIntervalMinutes` minutes ago, meaning the health-check worker itself may be behind or down — a stale "last known healthy" must not be reported as a confident `healthy`).
- **`healthy`**: `isDown === false` AND `lastCheckStatus === 'healthy'` AND the check is **not** stale (within `2 × checkIntervalMinutes`).
- This logic lives in a pure, DB-free function `computeServiceHealthState(status: ServiceHealthStatus, now: Date): 'healthy' | 'degraded' | 'down'` (mirrors 6.1's `expiry-alert-shared.ts` pattern of extracting pure decision logic for direct unit testing) so it is unit-testable without a DB fixture per case.

**ADR-6.3-04: Scope of "services" in the health dashboard — `payment_records` only, not certs/domains.** FR76 says "live availability status of all monitored services **and endpoints**" — this is HTTP-check availability, which only applies to `payment_records` rows with a non-null `url` (the only asset type with a URL to check, per 6.1's schema). `cert_records`/`domain_records` are expiry-tracked, not availability-tracked, and are explicitly out of this endpoint's scope (they already have their own alerting via 6.1's daily jobs). A `payment_records` row with `url IS NULL` has nothing to check and is **excluded** from the health dashboard's `services` array entirely (it is not "monitored" for availability — it still shows up wherever 6.1's plain CRUD list endpoints are used, unaffected by this story).

**ADR-6.3-05: Public status page URL shape — frontend `/status/:token`, backend `/api/v1/status-pages/:token`.** epics.md's literal AC path `GET /status/:token` is the **user-facing, shareable SvelteKit page URL** (short, no `/api/v1/` prefix, meant to be memorable/shareable — e.g. `https://vault.example.com/status/<token>`). It is **not** a literal backend route: every backend route in this codebase lives under `/api/v1/` (`route-audit.test.ts` asserts every OpenAPI path except `/health`, `/metrics`, `/api/v1/auth/*` is in `secureRoutes`; a bare `/status/:token` backend route would be invisible to that audit and would break the established namespacing). Resolution: the backend endpoint is `GET /api/v1/status-pages/:token` (new standalone route prefix, mirroring how `/api/v1/invitations/:token` is a standalone prefix rather than nested under `/projects/`, see `apps/api/src/modules/invitations/token-routes.ts`); the SvelteKit route `apps/web/src/routes/status/[token]/+page.server.ts` calls it server-side through the existing generic `apps/web/src/routes/api/v1/[...path]/+server.ts` proxy (already unauthenticated-safe — the proxy forwards to the backend, which enforces its own `requireAuth: false` + rate limit on this specific route; the proxy itself does not gate auth on any path).

**ADR-6.3-06: Token generation reuses `opaque-token.ts`, not a new base62 encoder.** epics.md's AC literally says "22+ base62 chars". This codebase already has one reviewed, reused opaque-token abstraction (`apps/api/src/lib/opaque-token.ts`: `generateOpaqueToken()`/`hashOpaqueToken()`/`opaqueTokenMatches()`, HMAC-SHA256 storage, constant-time compare) used identically by `recovery-tokens.ts` (`apps/api/src/modules/auth/recovery-tokens.ts` — the newest, cleanest precedent: thin wrapper + a dedicated env secret). `generateOpaqueToken(32)` produces 256 bits of entropy encoded as 43 `base64url` characters — this **exceeds** the literal requirement (128-bit minimum, 22+ chars) in both entropy and length; `base64url` is URL-safe by construction (that is the entire point of the "url" variant), so it satisfies the "shareable URL" intent just as well as base62 would. **Reuse `opaque-token.ts` verbatim via a new thin wrapper `apps/api/src/modules/monitoring/status-page-tokens.ts`** (mirror `recovery-tokens.ts`'s exact shape: `generateStatusPageToken()`, `hashStatusPageToken()`, `statusPageTokenMatches()`, each delegating to the shared primitives with a new `env.STATUS_PAGE_TOKEN_HMAC_SECRET`). Inventing a parallel base62 encoder here would be the exact "reinventing wheels" anti-pattern this workflow exists to prevent.

**ADR-6.3-07: "Owner only" (FR77) means project-owner-or-org-owner, not `secureRoute`'s `minimumRole: 'owner'`.** `secureRoute`'s built-in `minimumRole` check (`apps/api/src/lib/secure-route.ts:193-194`, `hasSufficientRole`) compares against `auth.orgRole` only — it has no concept of a per-project role. Using `minimumRole: 'owner'` on the status-page routes would silently require the caller to be an **org** owner, incorrectly locking out a legitimate **project** owner who isn't an org owner. This is the exact shape of bug ADR-4.4-05 already had to resolve for project archival. Resolution — mirror `apps/api/src/modules/projects/routes.ts`'s `callerArchiveAuthorization()` pattern exactly: register the status-page mutation routes with `minimumRole: 'member'` (an org-level floor, matching the `// org-level floor; in-handler project-owner check is stricter` comment at `routes.ts:831`), then perform an explicit in-handler check: `const callerRole = await callerProjectRole(secureCtx, projectId); const authorized = callerRole === 'owner' || secureCtx.auth.orgRole === 'owner'`. Reuse `getProjectMembershipRole`/the equivalent of `callerProjectRole` — do not duplicate the query; extract/export it from `projects/routes.ts` if it is not already exported, or replicate the identical one-line query shape if extraction is impractical (check first).

**ADR-6.3-08: `dashboard-stats.ts`'s `monitoredServiceHealth` stub must be wired by this story (Product Surface Contract G3 — Dashboard Truth).** `apps/api/src/modules/projects/dashboard-stats.ts:87` hardcodes `monitoredServiceHealth = { healthy: 0, degraded: 0, down: 0 }` with a comment explicitly pointing at Epic 6 (`6-1`'s Dev Notes: "leave that stub alone for 6.2/6.3 to resolve"). This story introduces the exact `computeServiceHealthState()` logic (ADR-6.3-03) needed to compute real values. Per `product-surface-contract.md` G3 ("Aggregate counts ... must query real data when tables are populated"), **this story must replace the hardcoded zero object** in `buildProjectDashboard()` with a real per-project count derived from the same `computeServiceHealthState()` function used by the cross-project endpoint — otherwise this becomes a second, avoidable G1-style retro finding. See AC 10.

---

## Known Scope Boundaries

- **No pagination on `GET /api/v1/health-dashboard`.** epics.md's literal endpoint shape has no `page`/`limit` params, and NFR-perf targets nothing about org-wide monitored-service counts. This endpoint returns every accessible project with ≥1 eligible service, unpaginated — acceptable at expected scale (a single org's total registered services), matching 6.1's precedent of documenting an unsourced-but-reasonable bound rather than silently adding one. If org sizes grow enough to make this a real concern, that is future-story scope, not 6.3's.
- **Certs and domains are not part of the health dashboard or public status page.** Only `payment_records` (services) with a non-null `url` are eligible (ADR-6.3-04). Do not extend `status_page_services` or the health-dashboard query to `cert_records`/`domain_records`.
- **No new notification/alert type.** Unlike 6.1, this story does not add anything to `NOTIFICATION_ALERT_TYPES` — enabling/disabling a public status page is an audited admin action, not a proactive alert to org admins.
- **Public status page views (`GET /api/v1/status-pages/:token`) are never audit-logged.** High-frequency, unauthenticated, potentially-scraped traffic writing to the audit log would be a storage/DoS-adjacent concern the architecture doc already flags generically ("Rate Limiting × Audit Volume" risk, architecture.md line 137). Only the four admin mutations (enable, regenerate, update, disable) are audited. See AC 29.

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` (API + web in the same story) |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — this story ships its own UI |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

**Alex-viewer / Sam-member (internal, cross-project health dashboard):** Alex logs in, clicks "Health" in the primary nav (the existing `(app)/health` placeholder route — currently rendering `PlaceholderSection section="health"`, copy: *"No monitored services configured yet. Service and endpoint monitoring arrives in Epic 6."* per `apps/web/src/lib/components/shell/placeholder-copy.ts:15-18*). After this story, `/health` renders the real cross-project dashboard: every project with at least one monitored service, each service's live status (green/amber/red), and an org-wide summary strip. Empty-state (no services registered anywhere in the org yet) shows a truthful "no services monitored yet" message — not the old Epic-6-placeholder copy (see AC 8) and not a fabricated all-healthy summary (AC-E2f style honesty).

**Riley-admin (project owner, public status page):** Riley opens a project's settings, finds a new "Public status page" section, enables it, sees the shareable URL and the plaintext token exactly once with a copy button and an explicit "this cannot be shown again — regenerate to get a new link" warning, then picks which services appear and what public-facing display names to use (e.g. "Payments API" instead of the internal record name "aws-payments-prod-lambda"). Riley shares the URL with an external stakeholder (no vault account).

**External stakeholder (public, unauthenticated):** opens `https://vault.example.com/status/<token>` on a phone, sees a clean, read-only page listing each configured service's display name and status — no internal identifiers, no login prompt, works without horizontal scrolling on a 375px viewport (FR72/AC-E6d mobile matrix: Chrome/Safari, iOS 16+/Android 13+).

## Acceptance Criteria

### A. Cross-project health dashboard — `GET /api/v1/health-dashboard`

1. **Given** an authenticated user with any org role (`viewer`+) and at least one project in their org has a `payment_records` row with a non-null `url`, **when** they call `GET /api/v1/health-dashboard`, **then** the response is `200` with `{ data: { projects: [{ projectId, projectName, services: [{ id, name, status, lastCheckedAt }] }], summary: { healthy, degraded, down } } }`, where `projects` includes only non-archived projects that have ≥1 eligible service (ADR-6.3-04), each `services[]` entry uses `computeServiceHealthState()` (ADR-6.3-03) for `status`, and `summary` is the sum of all `status` values across all listed services.
   - *Example (happy path):* org has 2 projects; project A has one service currently healthy, one currently down; project B has one degraded service (no check yet). Response: `projects: [{ projectId: 'A', services: [{status:'healthy'},{status:'down'}] }, { projectId: 'B', services: [{status:'degraded'}] }], summary: { healthy: 1, degraded: 1, down: 1 }`.
   - *Example (edge — no services anywhere in org):* `projects: []`, `summary: { healthy: 0, degraded: 0, down: 0 }`, HTTP `200` (not `404` — an empty dashboard is a valid state, not an error).
   - *Example (edge — service exists but has no `url`):* a `payment_records` row with `url: null` never appears in any project's `services[]` (ADR-6.3-04) and does not affect `summary`.
   - *Example (edge — archived project):* a project with `archivedAt IS NOT NULL` that has monitored services is excluded from `projects[]` entirely, even though its `payment_records` rows still physically exist.

2. **Given** the same endpoint, **when** a service has never had a health check recorded (`lastCheckStatus: null` from the ADR-6.3-02 contract, e.g. registered seconds ago, before the health-check worker's first run), **then** it is reported as `status: 'degraded'`, `lastCheckedAt: null` — never `'healthy'` (a service must never default to a confident-healthy claim it hasn't earned) and never `'down'` (it hasn't failed anything yet either).
   - *Example:* `POST .../services` creates a service at `T`; `GET /api/v1/health-dashboard` called at `T+1s` (before Story 6.2's worker's first scheduled run) shows that service as `degraded`, `lastCheckedAt: null`.

3. **Given** a service whose last successful check is older than `2 × checkIntervalMinutes` (staleness — ADR-6.3-03), **then** its status is `'degraded'` even if the last recorded check was `'healthy'` and it was never marked down.
   - *Example:* `checkIntervalMinutes: 5`, `lastCheckStatus: 'healthy'`, `lastCheckedAt` is 25 minutes old (health-check worker itself appears to be behind/down) → reported `degraded`, not `healthy`.
   - *Example (boundary):* `lastCheckedAt` exactly `10.0` minutes old with `checkIntervalMinutes: 5` → still within the `2×` window (`≤`, inclusive) → `healthy` if `lastCheckStatus` was `'healthy'` and not down. `10.0001` minutes → `degraded`. Unit-test this boundary explicitly in `computeServiceHealthState()`'s test file.

4. **Given** an unauthenticated request, **when** `GET /api/v1/health-dashboard` is called with no session cookie, **then** the response is `401` (standard `SecureRoute` `requireAuth` behavior — no special-casing needed, this route is fully authenticated, unlike the public status page).

5. **Given** two organizations A and B each with monitored services, **when** a user authenticated in org A calls `GET /api/v1/health-dashboard`, **then** the response contains only org A's projects/services — org B's data is invisible (RLS `org_id` scoping via `withOrg`/`withOrgReadScope`, same mechanism as every other cross-project query in this codebase, e.g. `getOrgDashboardData`). Verified by an integration test using `withTestOrg()` twice and asserting cross-org absence, not merely correct counts for one org.

6. **And** the route is registered with `minimumRole: 'viewer'`, `writeAuditEvent: false` (a health-status read is not a sensitive action — mirrors `dashboardRoutes`' existing `GET /api/v1/dashboard` exactly, see `apps/api/src/modules/dashboard/routes.ts`), and an explicit rate limit `{ max: 120, timeWindowMs: 60_000 }` (mirrors `LIST_RATE_LIMIT` already defined in `apps/api/src/modules/monitoring/routes.ts:94` — reuse that constant, do not redefine a diverging value).
   - *Example (failure — rate limit):* a caller exceeding 120 requests/minute to this endpoint receives `429` with the standard rate-limit error shape used elsewhere in the codebase.

### B. Per-project dashboard truth (ADR-6.3-08)

7. **Given** `apps/api/src/modules/projects/dashboard-stats.ts`'s `buildProjectDashboard()`, **when** a project has monitored services with real health data, **then** `monitoredServiceHealth` reflects real counts (`{ healthy, degraded, down }` computed the same way as AC 1-3, scoped to that single project) instead of the hardcoded `{ healthy: 0, degraded: 0, down: 0 }`.
   - *Example (happy path):* project has 2 healthy services, 1 down → `GET /api/v1/projects/:projectId/dashboard` returns `monitoredServiceHealth: { healthy: 2, degraded: 0, down: 1 }`.
   - *Example (edge — project truly has no services, matches pre-existing behavior):* `monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 }` remains correct and is now a **true** zero (verified against the DB), not a hardcoded placeholder — the distinction matters for the `isEmpty`/`suggestedActions` computation immediately below it in the same function, which must keep working unchanged.
   - **Non-regression note:** `getProjectDashboardData()` is called both from `GET /:projectId/dashboard` (`modules/projects/routes.ts`) and used by the SvelteKit `(app)/dashboard` page's server load — do not change the function's exported shape (`ProjectDashboard` type in `packages/shared/src/schemas/dashboard.ts`), only the internal computation feeding `monitoredServiceHealth`. Run `apps/api/src/modules/projects/dashboard-stats.test.ts` and fix any now-outdated hardcoded-zero assertions rather than deleting them — they need to become real-data assertions.

### C. Enable a public status page — `POST /api/v1/projects/:projectId/status-page`

8. **Given** a project exists, has no existing enabled status page, and the caller is the project owner or an org owner (ADR-6.3-07), **when** they call `POST /api/v1/projects/:projectId/status-page` with `{}` (no body required — services are configured separately via PUT, see AC 20), **then** a `status_pages` row is created (`orgId`, `projectId` unique, `tokenHash`, `createdBy`, `createdAt`, `updatedAt`) and the response is `201` with `{ data: { token: '<plaintext, shown once>', createdAt } }` — the plaintext token is never persisted and never retrievable again via any other endpoint.
   - *Example (happy path):* `POST /api/v1/projects/proj-1/status-page {}` as project owner → `201 { data: { token: 'kR3f...(43 chars)', createdAt: '2026-07-04T...' } }`.
   - *Example (failure — insufficient role):* caller is a project `member`/`viewer`/`admin` (not project owner, not org owner) → `403 { code: 'insufficient_role' }`.
   - *Example (failure — cross-org/nonexistent project):* `projectId` belongs to another org or doesn't exist → `404 project_not_found` (never `403` — matches the established convention of not leaking cross-org existence).
   - *Example (failure — archived project):* project is archived → `410` via `rejectIfProjectArchived` (same guard as 6.1).
   - *Example (failure — already enabled):* a second `POST` while a `status_pages` row already exists for this project → `409 { code: 'status_page_already_enabled' }` — the caller must use the regenerate endpoint (AC 12) to rotate the token, not re-`POST`. This prevents an accidental silent no-op or an accidental second row that would violate the `projectId` uniqueness constraint anyway (constraint is the backstop; the `409` is the friendly error path checked first).

9. **And** `POST` requires MFA enrollment (`requireMfa: true`) — mirrors the project-archival precedent (`routes.ts:832`) for high-impact actions that create a new externally-shareable secret; a caller without MFA enrolled receives the standard MFA-required error regardless of role.
   - *Example (failure):* project-owner caller without `mfa_enrolled_at` set → `403` (standard MFA-required response shape, same as any other `requireMfa: true` route).

10. **And** RLS isolation: a `status_pages` row created under org A's project is invisible to any request scoped to org B (enforced via `org_id = current_setting('app.current_org_id')`), verified by an integration test and by `check-rls-coverage.ts` passing for the new table.

### D. Regenerate the token — `POST /api/v1/projects/:projectId/status-page/regenerate`

11. **Given** a project with an existing enabled status page and the caller is the project owner or org owner, **when** they call `POST /api/v1/projects/:projectId/status-page/regenerate`, **then** a new opaque token is generated, `tokenHash` is atomically replaced (same `status_pages` row, `updatedAt` bumped), and the response is `200 { data: { token: '<new plaintext, shown once>', updatedAt } }`; the **old** token immediately stops resolving.
    - *Example (happy path):* regenerate → old token `abc...` now `404`s on `GET /api/v1/status-pages/abc...`; new token `xyz...` resolves `200`.
    - *Example (failure — no status page exists yet):* `404 { code: 'status_page_not_found' }` — caller must `POST .../status-page` first.
    - *Example (concurrency — race between two regenerate calls):* two concurrent `POST .../regenerate` requests from the same authorized owner (e.g. two open browser tabs) — the `UPDATE ... WHERE project_id = $1` runs inside a transaction; whichever commits last wins and its plaintext token is the one actually valid going forward. **Both requests receive a `200` with a token in the response body, but only the later-committing one's token remains valid** — this is an inherent property of "the response shows the plaintext once," not a bug to prevent, but it MUST be called out in the endpoint's OpenAPI description (`"if called concurrently, only the last-committed token remains valid — earlier ones in flight will silently stop working"`) so frontend/API consumers are not surprised. Do not attempt row-locking to "fix" this — the plaintext is already unrecoverable by the time a second caller could inspect the first's result, so there's no meaningful race to close beyond documenting it.
    - MFA required, same as AC 9.

### E. Public unauthenticated read — `GET /api/v1/status-pages/:token`

12. **Given** a valid, non-revoked token matching an enabled `status_pages` row, **when** anyone (no `Authorization`/session cookie required) calls `GET /api/v1/status-pages/:token`, **then** the response is `200 { data: { services: [{ displayName, status, lastCheckedAt }] } }` ordered by the `status_page_services.sortOrder` — **never** including `serviceId`, the underlying `payment_records.name`/`url`, `projectId`, `orgId`, or any other internal identifier (FR77's core privacy guarantee).
    - *Example (happy path):* status page configured with 2 services, display names "Payments API" and "Auth Service" → `200 { data: { services: [{ displayName: 'Payments API', status: 'healthy', lastCheckedAt: '...' }, { displayName: 'Auth Service', status: 'down', lastCheckedAt: '...' }] } }`.
    - *Example (edge — status page enabled but zero services configured):* `200 { data: { services: [] } }` — not an error; this is a valid "page exists, nothing shown yet" state (matches Riley's flow of enabling the page before configuring services in AC 20).
    - *Example (failure — unknown token):* any string not matching a stored `tokenHash` (via `statusPageTokenMatches`, constant-time compare) → `404 { code: 'status_page_not_found' }`. **Must not distinguish** "malformed token" vs. "well-formed but wrong" vs. "was valid, now disabled" in either status code or response timing — all three collapse to the same `404`, same latency profile (the constant-time compare already prevents a timing side-channel; do not add an early-return fast-path for "obviously malformed" tokens that would reintroduce one).
    - *Example (failure — status page was disabled via DELETE):* previously-valid token → `404` (same code/shape as "never existed" — see AC 21).

13. **And** the rate limit is `{ max: 60, timeWindowMs: 60_000 }` keyed by IP (`requireAuth: false` routes in this codebase's `SecureRoute` already key rate limits as `ip:${request.ip}` for public routes — `apps/api/src/lib/secure-route.ts:277-297`, `handlePublicRequest`/`enforceUserRateLimit` — this is not new plumbing, just correct config), satisfying FR77's literal "60 requests/minute per IP" requirement exactly.
    - *Example (happy path):* 60 requests from the same IP within 60 seconds all succeed (assuming valid token).
    - *Example (failure):* the 61st request within the same window → `429`, standard rate-limit error shape.
    - *Example (edge — many different tokens, one IP):* the per-IP bucket is shared across all tokens requested by that IP (key is the route pattern `GET /api/v1/status-pages/:token`, not per-token) — a script hitting 3 different status pages 20 times each from one IP hits the same 60-request ceiling. This is intentional (FR77 says "per IP", not "per IP per token") — do not key by `ip+token`.

14. **And** this route is `requireAuth: false`, `writeAuditEvent: false` (no audit row per view — see Known Scope Boundaries), and registered under a new standalone prefix `/api/v1/status-pages` (ADR-6.3-05) — added to `route-exemptions.ts`'s `ROUTE_ACTION_CLASSIFICATIONS` with `action: 'read'` and an `auditOmissionReason` (mirror the existing `MONITORING_LIST_READ_OMISSION_REASON`-style constant, or a new one: `"Public, unauthenticated, high-frequency status page view — auditing every view would create unbounded audit-log growth from external, non-actor traffic; see Known Scope Boundaries in 6-3 story file."`).

### F. Update configured services — `PUT /api/v1/projects/:projectId/status-page`

15. **Given** an enabled status page and the caller is the project owner or org owner, **when** they call `PUT /api/v1/projects/:projectId/status-page` with `{ services: [{ serviceId, displayName }, ...] }`, **then** the full `status_page_services` set for that status page is replaced atomically (delete-all-then-insert-new, in one transaction) with `sortOrder` set to array index, and the response is `200` with the updated public-facing service list.
    - *Example (happy path):* `PUT { services: [{ serviceId: 'svc-1', displayName: 'Payments API' }, { serviceId: 'svc-2', displayName: 'Auth Service' }] }` → `200`, both rows created with `sortOrder: 0, 1`.
    - *Example (edge — empty array):* `PUT { services: [] }` → `200`, all existing `status_page_services` rows for this status page deleted; public page now shows `services: []` (AC 12's empty-state).
    - *Example (failure — validation, empty display name):* `displayName` empty or exceeds 100 chars → `422` with field-level Zod error.
    - *Example (failure — serviceId not in this project or not a service with a `url`):* references a `payment_records.id` from a different project, or a service with `url: null` (not eligible per ADR-6.3-04), or a `cert_records`/`domain_records` id → `422 { code: 'invalid_service_reference' }` (validated in the same transaction, not deferred to a later health-check failure).
    - *Example (failure — duplicate serviceId in one request):* `services: [{serviceId: 'svc-1', ...}, {serviceId: 'svc-1', ...}]` → `422` (the `UNIQUE(statusPageId, serviceId)` constraint is the DB-level backstop, but validate in the Zod schema first for a clean error message rather than a raw constraint-violation 500).
    - *Example (failure — more than 50 services in one request):* `422` — arbitrary reasonable cap (undocumented in epics.md/architecture.md, same style of documented-but-unsourced bound as 6.1's `alertLeadDays` max-10 cap) bounding public-page rendering size; document the choice inline.
    - *Example (failure — no status page exists yet):* `404 { code: 'status_page_not_found' }`.

### G. Disable the public page — `DELETE /api/v1/projects/:projectId/status-page`

16. **Given** an enabled status page and the caller is the project owner or org owner, **when** they call `DELETE /api/v1/projects/:projectId/status-page`, **then** the `status_pages` row (and its `status_page_services` rows, via `ON DELETE CASCADE`) is hard-deleted, and any subsequent `GET /api/v1/status-pages/:token` with the old token returns `404` immediately (no grace period).
    - *Example (happy path):* `DELETE` → `204`; a request to the old public URL 1 second later → `404`.
    - *Example (failure — no status page exists, or already deleted):* `404 { code: 'status_page_not_found' }` — **not** idempotent-success (`204` on a no-op); this matches 6.1's `DELETE .../services/:serviceId` convention (`404` if not found) rather than the sometimes-seen "idempotent DELETE always 204s" pattern, for consistency within this codebase's existing DELETE semantics.
    - No MFA requirement on DELETE — disabling reduces exposure, does not mint a new secret; consistent with not over-gating a risk-reducing action (see ADR discussion above the AC table).

### H. Audit logging

17. **And** every status-page mutation (enable, regenerate, update, disable) writes an audit event in the same transaction as the DB change, fail-closed (reuse `writeMonitoringAuditOrFailClosed` from `apps/api/src/modules/monitoring/routes.ts:70`, extended to accept `resourceType: 'status_page'`): `STATUS_PAGE_ENABLED` (`'status_page.enabled'`), `STATUS_PAGE_TOKEN_REGENERATED` (`'status_page.token_regenerated'`), `STATUS_PAGE_UPDATED` (`'status_page.updated'`), `STATUS_PAGE_DISABLED` (`'status_page.disabled'`) — new entries in **both** the `AuditEvent` object (`packages/shared/src/constants/audit-events.ts:42-50` region) **and** the `AuditEventType` union (lines 89-97 region) — this file double-lists every event, matching 6.1's Task 1 note exactly; missing either half is a type error only, not a runtime failure, so it is easy to silently under-cover — grep both regions before considering this task done.
    - *Example (happy path):* enabling a status page writes one `status_page.enabled` row with `resourceId: status_pages.id`, `payload: { projectId }`.
    - *Example (failure isolation):* if the audit write fails inside the transaction, the whole mutation rolls back (same-transaction invariant, NFR-REL5) — verified by an integration test that forces the audit write to throw and asserts the `status_pages` row was not created/updated.
    - *Example (deleted-row snapshot, mirrors 6.1 AC 9):* the `status_page.disabled` audit payload includes a snapshot of which `status_page_services` display names were configured at time of deletion (`payload: { projectId, configuredServiceCount, displayNames: [...] }`) since the row is hard-deleted with no tombstone — same rationale as 6.1's ADR for hard-deleted `payment_records`/`cert_records`/`domain_records`.

18. **And** `GET /api/v1/status-pages/:token` (public view) is explicitly **not** audited (see AC 14 and Known Scope Boundaries) — a code reviewer should not "helpfully" add an audit call here; this is a deliberate, documented omission, not an oversight.

### I. Migration & schema

19. **And** two new tables are created in one migration (next free number — re-check `packages/db/src/migrations/meta/_journal.json`, `0029` as of this story's writing but verify per 6.1's own caution about stale `drizzle-kit generate` snapshot lineage):
    - `status_pages`: `id uuid PK`, `...orgScoped({onDelete:'cascade'})`, `project_id uuid NOT NULL UNIQUE FK → projects.id ON DELETE CASCADE`, `token_hash text NOT NULL UNIQUE`, `created_by uuid FK → users.id ON DELETE SET NULL`, `created_at`, `updated_at`.
    - `status_page_services`: `id uuid PK`, `...orgScoped({onDelete:'cascade'})`, `status_page_id uuid NOT NULL FK → status_pages.id ON DELETE CASCADE`, `service_id uuid NOT NULL FK → payment_records.id ON DELETE CASCADE`, `display_name text NOT NULL` (`check` length 1-100, mirroring 6.1's `char_length` check pattern), `sort_order integer NOT NULL DEFAULT 0`, `created_at`, `updated_at`, `UNIQUE(status_page_id, service_id)`.
    - Both tables get `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` in the **same migration file** (hand-write following `0025_project_invitations.sql`'s exact shape — `drizzle-kit generate`'s snapshot lineage is stale per 6.1's Debug Log; hand-author and hand-append the `_journal.json` entry the same way the last several stories did).
    - Indexes: `UNIQUE` on `status_pages(project_id)`, `UNIQUE` on `status_pages(token_hash)` (doubles as the public lookup index), `idx_status_pages_org` on `org_id`; `idx_status_page_services_status_page_id` on `status_page_services(status_page_id)` (public-page join), `UNIQUE(status_page_id, service_id)`, `idx_status_page_services_org` on `org_id`.
    - *Example (migration correctness check):* `pnpm db#check-rls` passes for both new tables; `\d status_pages` / `\d status_page_services` manually confirm columns/FKs/checks/policy against a real Postgres instance, mirroring 6.1's Debug Log verification step.

20. **And** exporting both new Drizzle tables from `packages/db/src/schema/index.ts` (append after `domain-records.ts`'s line, alongside the existing `payment-records.ts`/`cert-records.ts`/`domain-records.ts` exports).

## Tasks / Subtasks

- [ ] Task 0 — Prerequisite check (blocking, AC: all)
  - [ ] Confirm Story 6.2 is `done` in `sprint-status.yaml` and locate its actual health-check data model / repository function. If 6.2 is not done, stop and coordinate — do not proceed past this task (ADR-6.3-01).
  - [ ] Reconcile ADR-6.3-02's expected `ServiceHealthStatus`/`getServiceHealthStatuses()` contract against what 6.2 actually shipped; update the contract/call site accordingly before writing any of 6.3's own code.

- [ ] Task 1 — Registries (AC: 17) [Source: `packages/shared/src/constants/audit-events.ts`]
  - [ ] Add `STATUS_PAGE_ENABLED`, `STATUS_PAGE_TOKEN_REGENERATED`, `STATUS_PAGE_UPDATED`, `STATUS_PAGE_DISABLED` to both the `AuditEvent` object and the `AuditEventType` union (both regions — see AC 17 note).
  - [ ] Add `STATUS_PAGE_TOKEN_HMAC_SECRET` to `apps/api/src/config/env.ts`: schema entry (`secretEnvDefault` pattern, `DEV_STATUS_PAGE_TOKEN_HMAC_SECRET = 'g'.repeat(64)`), `ProductionEnv` type entry, a `validateStatusPageTokenProductionSecret()` function mirroring `validateRecoveryTokenProductionSecret()` exactly (required in prod, must differ from every other secret including the newest `RECOVERY_TOKEN_HMAC_SECRET`, must not match `PLACEHOLDER_SECRET_PATTERN`), call it from `validateProductionEnv()`, and add it to the `RawEnv`/`Env` type omission-and-re-add block (`env.ts:401-413` region).

- [ ] Task 2 — Health-status computation (AC: 1-3, 6, 7) [Source: ADR-6.3-02/03, `apps/api/src/workers/expiry-alert-shared.ts` as the "pure decision function" precedent]
  - [ ] Create `apps/api/src/modules/monitoring/health-status.ts`: `computeServiceHealthState(status: ServiceHealthStatus, now: Date): 'healthy'|'degraded'|'down'`, pure and DB-free, plus the `ServiceHealthStatus` type (or import Story 6.2's if it already defines an equivalent — do not duplicate).
  - [ ] Unit test every branch and the `2×checkIntervalMinutes` staleness boundary (AC 3's exact-boundary case).

- [ ] Task 3 — Health dashboard schema + service + route (AC: 1-6) [Source: `apps/api/src/modules/dashboard/routes.ts`, `apps/api/src/modules/projects/dashboard-stats.ts`]
  - [ ] Add `HealthDashboardSchema`/`HealthDashboardServiceSchema` to `packages/shared/src/schemas/health-dashboard.ts` (mirror `org-dashboard.ts`'s shape/`.meta({id:...})` convention exactly); export from `packages/shared/src/index.ts`.
  - [ ] Create `apps/api/src/modules/monitoring/health-dashboard-service.ts`: query all non-archived projects with ≥1 `payment_records` row where `url IS NOT NULL`, batch-call `getServiceHealthStatuses()` (ADR-6.3-02), map through `computeServiceHealthState()`, group by project, compute `summary`.
  - [ ] Create `apps/api/src/modules/monitoring/health-dashboard-routes.ts` exporting `healthDashboardRoutes(fastify)`: single `GET ''` route mirroring `dashboardRoutes` exactly (`minimumRole: 'viewer'`, `writeAuditEvent: false`, `rateLimit: LIST_RATE_LIMIT` imported from `monitoring/routes.ts` — export that constant if not already exported).
  - [ ] Register in `apps/api/src/app.ts`: `await fastify.register(healthDashboardRoutes, { prefix: '/api/v1/health-dashboard' })`.

- [ ] Task 4 — Wire `dashboard-stats.ts` truth (AC: 7) [Source: ADR-6.3-08]
  - [ ] Update `getBatchedProjectCredentialStats`-adjacent code path in `dashboard-stats.ts`: add a batched query for the caller's project's eligible services + `getServiceHealthStatuses()` + `computeServiceHealthState()`, replacing the hardcoded `{healthy:0,degraded:0,down:0}` in `buildProjectDashboard()`.
  - [ ] Update `apps/api/src/modules/projects/dashboard-stats.test.ts`'s now-outdated hardcoded-zero assertions to real-data assertions (do not delete coverage — extend it).

- [ ] Task 5 — Status page tokens + schema + migration (AC: 8, 10, 19, 20) [Source: `apps/api/src/modules/auth/recovery-tokens.ts`, `packages/db/src/schema/payment-records.ts`, `packages/db/src/migrations/0025_project_invitations.sql`]
  - [ ] Create `apps/api/src/modules/monitoring/status-page-tokens.ts` mirroring `recovery-tokens.ts` exactly (ADR-6.3-06).
  - [ ] Create `packages/db/src/schema/status-pages.ts`, `status-page-services.ts` per AC 19's column list.
  - [ ] Re-check `_journal.json` for the actual next-free migration number; hand-write `NNNN_status_pages.sql` following `0025_project_invitations.sql`'s exact shape (tables, FKs, indexes, `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` for both tables in this same file); hand-append the `_journal.json` entry.
  - [ ] Export both tables from `packages/db/src/schema/index.ts`.
  - [ ] Run `db#check-rls` locally.

- [ ] Task 6 — Status page admin routes (AC: 8-9, 11, 15-18) [Source: `apps/api/src/modules/projects/routes.ts` (`callerArchiveAuthorization` pattern), `apps/api/src/modules/monitoring/routes.ts` (`writeMonitoringAuditOrFailClosed`, `WRITE_RATE_LIMIT`)]
  - [ ] Extend `apps/api/src/modules/monitoring/schema.ts` with request/response Zod schemas for enable/regenerate/update (local, request-body-only — mirror 6.1's convention of keeping request schemas module-local while response types needed by the web app live in `packages/shared`, see the codebase-convention note in Dev Notes below).
  - [ ] Add `StatusPageSchema`/`PublicStatusPageServiceSchema` response types to `packages/shared/src/schemas/status-page.ts` (needed by the web app); export from `index.ts`.
  - [ ] Extend `apps/api/src/modules/monitoring/service.ts` (or a new sibling `status-page-service.ts` if it keeps `service.ts` from growing unwieldy — developer's call, consistent with 6.1's own "kept as one file, logic stayed small enough" precedent) with the enable/regenerate/update/disable DB functions, each reusing `findProjectInOrg`/`rejectIfProjectArchived` and the ADR-6.3-07 ownership check.
  - [ ] Create `apps/api/src/modules/monitoring/status-page-routes.ts` exporting `statusPageRoutes(fastify)`: `POST/PATCH.../regenerate/PUT/DELETE /:projectId/status-page[/regenerate]`, each `secureRoute`-registered with `minimumRole: 'member'` + in-handler ownership check, `requireMfa: true` on enable/regenerate only, `rateLimit: WRITE_RATE_LIMIT`.
  - [ ] Register in `app.ts` inside the existing `eslint-disable sonarjs/no-duplicate-string` block (`app.ts:191-197`) alongside `monitoringRoutes`, prefix `/api/v1/projects`.
  - [ ] Add `route-exemptions.ts` entries for all new routes (mirror the `payment_record.*` block exactly for the audited mutations; a distinct `auditOmissionReason` entry for the public GET, see AC 14).

- [ ] Task 7 — Public status page route (AC: 12-14, 18) [Source: `apps/api/src/modules/invitations/token-routes.ts`]
  - [ ] Create `apps/api/src/modules/monitoring/public-status-page-routes.ts` exporting `publicStatusPageRoutes(fastify)`: single `GET /:token` route, `requireAuth: false`, `writeAuditEvent: false`, `rateLimit: { max: 60, timeWindowMs: 60_000, key: 'GET /api/v1/status-pages/:token' }`, looks up by `hashStatusPageToken`/`statusPageTokenMatches` (constant-time), joins `status_page_services` ordered by `sortOrder`, returns only `displayName`/`status`/`lastCheckedAt`.
  - [ ] Register in `app.ts`: `await fastify.register(publicStatusPageRoutes, { prefix: '/api/v1/status-pages' })` (standalone prefix, ADR-6.3-05 — not nested under `/api/v1/projects`).

- [ ] Task 8 — Web: cross-project health dashboard page (AC: persona journey, mobile) [Source: `apps/web/src/routes/(app)/health/+page.svelte`, `apps/web/src/routes/(app)/dashboard/+page.server.ts`]
  - [ ] Replace `apps/web/src/routes/(app)/health/+page.svelte`'s `PlaceholderSection` with the real dashboard: per-project cards, each service's status indicator (simple color-coded badge — no existing badge component to reuse; keep it minimal, consistent with existing Tailwind usage elsewhere in `apps/web/src/lib/components`), org-wide summary strip.
  - [ ] Add `apps/web/src/routes/(app)/health/+page.server.ts` calling the new `getHealthDashboard` API wrapper.
  - [ ] Create `apps/web/src/lib/api/health-dashboard.ts` (thin `apiFetch` wrapper, mirror `apps/web/src/lib/api/dashboard.ts` exactly).
  - [ ] Remove/update the `health` entry in `apps/web/src/lib/components/shell/placeholder-copy.ts` only if it becomes actively misleading post-implementation (it will — the placeholder claims "arrives in Epic 6" while this story ships the real page); update copy or remove the `'health'` key from `PlaceholderSectionKey` if no longer referenced anywhere (grep first).
  - [ ] Verify mobile rendering (375×812 viewport, per AC-E6d matrix) — no horizontal scroll, touch-friendly status indicators.

- [ ] Task 9 — Web: status page admin UI (AC: persona journey) [Source: `apps/web/src/routes/(app)/projects/[projectId]/members` as the nearest "project settings sub-page" structural precedent]
  - [ ] Add a status-page management section under `apps/web/src/routes/(app)/projects/[projectId]/` (new route, e.g. `status-page/+page.svelte` + `+page.server.ts`), gated in the UI to project owners (still enforced server-side regardless of client gating).
  - [ ] Enable/regenerate flow: show plaintext token once with a copy-to-clipboard control and an explicit "cannot be shown again" warning; service picker + display-name inputs calling `PUT`.
  - [ ] Create `apps/web/src/lib/api/status-page.ts` (admin-side wrapper: enable/regenerate/update/disable + local `UpdateStatusPageRequest` TS type, mirroring `apps/web/src/lib/api/projects.ts`'s convention of plain-TS request types + shared-package response types).

- [ ] Task 10 — Web: public status page route (AC: 12, mobile) [Source: `apps/web/src/routes/(auth)/invitations/accept/+page.svelte` as the nearest token-based-public-page precedent; ADR-6.3-05]
  - [ ] Create `apps/web/src/routes/status/[token]/+page.server.ts` (standalone, top-level — sibling to `(app)`/`(auth)`, NOT inside either group, so it is exempt from `isProtectedAppPath`/`isAuthPath` redirects in `hooks.server.ts`) that server-side-fetches `GET /api/v1/status-pages/:token` and renders a 404-equivalent page on failure rather than throwing an unhandled error.
  - [ ] Create `apps/web/src/routes/status/[token]/+page.svelte`: minimal, unauthenticated-safe layout (does not use the authenticated app shell/nav — no session data available or needed), renders `services[]` with status indicators, explicit "not found" state for invalid/disabled tokens.
  - [ ] Verify mobile rendering (375×812), no horizontal scroll.

- [ ] Task 11 — Tests (AC: all)
  - [ ] `health-dashboard-service.test.ts` / `health-dashboard-routes.test.ts`: cross-project aggregation, empty state, archived-project exclusion, url-null exclusion, RLS cross-org isolation, rate limit.
  - [ ] `health-status.test.ts`: all `computeServiceHealthState()` branches + staleness boundary (AC 3).
  - [ ] `dashboard-stats.test.ts`: updated real-data assertions for `monitoredServiceHealth`.
  - [ ] `status-page-routes.test.ts`: enable (happy/403/404/410/409-already-enabled), regenerate (happy/404/concurrency note documented not necessarily test-asserted given its inherent nature — AC 11), update (happy/empty/validation/cross-project-service-reference/duplicate/cap), disable (happy/404-not-idempotent), ownership authorization (project owner passes, org owner passes, project member/viewer/admin-non-owner fails), MFA-required on enable/regenerate, audit event per mutation (fail-closed test per AC 17), RLS cross-org isolation.
  - [ ] `public-status-page-routes.test.ts`: happy path, unknown token 404, disabled-token 404, rate limit 429, no-services-configured empty array, response never contains `serviceId`/internal name/url/projectId/orgId (explicit negative assertion — grep the serialized response for forbidden fields, not just check for presence of allowed ones).
  - [ ] Run `route-audit.test.ts` explicitly (cheap, easy to omit outside full `make ci`, per 6.1's own reminder) — requires the new `route-exemptions.ts` entries from Task 6/7.

- [ ] Task 12 — Wiring verification (AC: all)
  - [ ] `pnpm generate-spec && pnpm typecheck` (root, all packages, per 6.1's precedent that this is a no-op for hand-authored route files but still confirms the web app's generated types compile).
  - [ ] `db#check-rls` passes for `status_pages`/`status_page_services`.
  - [ ] Manual mobile-viewport check (Chrome/Safari emulation, 375×812) of both `/health` and `/status/:token`.

## Dev Notes

- **Sequencing is the single biggest risk in this story** — see ADR-6.3-01/02. Everything else follows once Story 6.2's contract is confirmed.
- **Codebase convention for request vs. response schema location** (clarifies Task 5/6): response types the web app must consume (e.g. `HealthDashboard`, `StatusPage`) live in `packages/shared/src/schemas/*.ts` as Zod schemas + inferred types (mirrors `org-dashboard.ts`/`dashboard.ts`, consumed by both backend response validation and `apps/web/src/lib/api/*.ts` imports). Request-body validation schemas stay module-local in `apps/api/src/modules/monitoring/schema.ts` (mirrors 6.1's `CreatePaymentRecordBodySchema` etc.); the web app defines its own plain TS request types locally in its `lib/api/*.ts` wrappers (mirrors `apps/web/src/lib/api/projects.ts`'s `CreateProjectRequest`) rather than importing a shared request schema. Do not put request schemas in `packages/shared` — that is not this codebase's pattern despite `architecture.md`'s general "import from packages/shared" guidance; 6.1 already established the module-local exception for request bodies.
- **`callerProjectRole`/`callerArchiveAuthorization`-equivalent reuse (ADR-6.3-07):** check whether `apps/api/src/modules/projects/routes.ts`'s `callerProjectRole()` (private helper, ~line 55-66) is already exported; if not, either export it or replicate the identical `getProjectMembershipRole()` call — do not diverge on the query shape, since a subtly different project-role lookup here vs. archival would be a correctness bug (two different "who is this project's owner" answers in the same codebase).
- **Do not build a parallel health-check mechanism.** If Story 6.2 is behind schedule and tempting to route around, do not. The entire value of ADR-6.3-02's interface boundary is that 6.3 has zero opinion on how checks happen — only on how their results are classified for display.
- **Public status page pages must never go through `(app)/+layout.server.ts`'s auth guard** (`throw redirect(303, '/login')` on missing `locals.user`) — this is why the SvelteKit route lives at top-level `apps/web/src/routes/status/[token]/`, not nested under `(app)`. Double-check `apps/web/src/lib/server/auth-guard.ts`'s `isProtectedAppPath()` list does **not** include `/status` — it currently lists `/dashboard`, `/projects`, `/credentials`, `/alerts`, `/health`, `/settings` only, so `/status` is safe by omission, but re-verify this hasn't changed by the time this story is implemented.
- **`hooks.server.ts` still runs for the public status page request** (it's global) — it will still call `/api/v1/auth/me` once per request even though the page needs no auth. This is pre-existing behavior for every unauthenticated route in the app (e.g. `/register`) and is not something this story needs to fix; just be aware it's one extra backend call per page view, separate from the FR77 IP rate limit which applies only to the actual `/api/v1/status-pages/:token` call.
- **Vault-sealed edge case:** `shouldCheckVaultReadiness()` in `hooks.server.ts` does not redirect `/status/:token` to `/vault` when the vault is sealed (it's not in that function's checked-path list). If the vault is sealed, the backend call will simply fail (DB likely inaccessible or returns an error) — the SvelteKit page's `+page.server.ts` must catch this and render the same generic "status temporarily unavailable" state used for a 404/network error, not crash with an unhandled exception. Not a new rate-limit or security concern, just a robustness requirement for Task 10.
- **Concurrency note beyond AC 11:** the `PUT .../status-page` full-replace (delete-all-then-insert) must happen inside one transaction so a concurrent public `GET` never observes a transient "zero services" state mid-update — standard transactional isolation, no special handling needed beyond "do it in one `tx`", but call this out in code review since it's easy to accidentally split into two round trips.

### Project Structure Notes

- Extends existing module `apps/api/src/modules/monitoring/` (no new top-level module — matches architecture.md's mapping row, same module as 6.1/6.2).
- New backend files: `health-status.ts`, `health-dashboard-service.ts`, `health-dashboard-routes.ts`, `status-page-tokens.ts`, `status-page-routes.ts`, `public-status-page-routes.ts`, plus extensions to `schema.ts`/`service.ts`.
- New schema files: `packages/db/src/schema/status-pages.ts`, `status-page-services.ts`.
- New shared schemas: `packages/shared/src/schemas/health-dashboard.ts`, `status-page.ts`.
- New web routes: `apps/web/src/routes/(app)/health/+page.server.ts` (replaces placeholder-only page), `apps/web/src/routes/(app)/projects/[projectId]/status-page/` (new), `apps/web/src/routes/status/[token]/` (new, **top-level**, not under any existing route group — this is the one deliberate exception to the `(app)`/`(auth)` grouping convention, required by the public/unauthenticated nature of the page, ADR-6.3-05).
- New web API wrappers: `apps/web/src/lib/api/health-dashboard.ts`, `status-page.ts`.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` lines 1724-1748] — Story 6.3 draft AC, endpoint shapes, FR76/77/72 mapping, AC-E6d mobile matrix.
- [Source: `_bmad-output/planning-artifacts/epics.md` lines 1694-1720] — Story 6.2 draft AC (health-check semantics this story depends on; unresolved table-naming conflict acknowledged in ADR-6.3-02).
- [Source: `_bmad-output/planning-artifacts/prd.md` lines 902-903, 945] — FR76, FR77, FR72 canonical text.
- [Source: `_bmad-output/planning-artifacts/architecture.md` lines 884-901, 903-930] — Requirements-to-Structure Mapping (`modules/monitoring/`), canonical schema entity names (`service_endpoints` naming tension, ADR-6.3-02).
- [Source: `_bmad-output/implementation-artifacts/6-1-service-certificate-and-domain-record-management.md`] — prior story in this epic; ADR-6.1-01/02/03 precedent this story's own ADRs extend; `payment_records`/`cert_records`/`domain_records` schema this story reads from; `dashboard-stats.ts:87` stub this story resolves (Dev Notes line, quoted in ADR-6.3-08).
- [Source: `apps/api/src/lib/opaque-token.ts`, `apps/api/src/modules/auth/recovery-tokens.ts`] — token generation/hash/compare pattern to reuse verbatim (ADR-6.3-06).
- [Source: `apps/api/src/modules/invitations/token-routes.ts`] — public, token-based, `requireAuth:false` route pattern to mirror for the public status page GET.
- [Source: `apps/api/src/modules/projects/routes.ts` lines 55-95, 819-833] — `callerProjectRole`/`callerArchiveAuthorization` project-owner-or-org-owner pattern (ADR-6.3-07); `minimumRole: 'admin'` org-floor-plus-in-handler-check precedent.
- [Source: `apps/api/src/modules/dashboard/routes.ts`] — minimal `GET` org-wide route pattern mirrored for the health-dashboard route.
- [Source: `apps/api/src/modules/monitoring/routes.ts` lines 66-95] — `writeMonitoringAuditOrFailClosed`, `LIST_RATE_LIMIT`/`WRITE_RATE_LIMIT` constants to reuse.
- [Source: `apps/api/src/lib/secure-route.ts` lines 190-297] — `hasSufficientRole` (org-role-only, ADR-6.3-07), `handlePublicRequest`/IP-keyed rate limiting for `requireAuth:false` routes (AC 13).
- [Source: `apps/api/src/config/env.ts` lines 109-170, 401-434] — production-secret validation pattern for the new `STATUS_PAGE_TOKEN_HMAC_SECRET`.
- [Source: `apps/web/src/lib/server/auth-guard.ts`, `apps/web/src/hooks.server.ts`] — route-group auth-guard behavior the public status page page must fall outside of.
- [Source: `apps/web/src/routes/(auth)/invitations/accept/+page.svelte`] — nearest existing token-based public-page frontend precedent.
- [Source: `apps/web/src/lib/components/shell/placeholder-copy.ts` lines 15-18] — existing `(app)/health` placeholder copy this story replaces with real content.
- [Source: `packages/shared/src/constants/audit-events.ts`] — `AuditEvent` object + `AuditEventType` union double-listing pattern (AC 17).
- [Source: `packages/db/src/migrations/0025_project_invitations.sql`] — RLS-in-migration pattern to copy exactly for the two new tables.
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`] — G3 Dashboard Truth (ADR-6.3-08), G4 persona journey.

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
