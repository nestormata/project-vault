# Story 6.3: Cross-Project Health Dashboard & Public Status Page

Status: done

<!-- Ultimate context engine analysis completed 2026-07-04 — comprehensive developer guide for the
THIRD story in Epic 6. This story creates the org-wide `GET /api/v1/health-dashboard` endpoint, a
public shareable status page (`status_pages` + `status_page_services` tables, opaque-token
auth-free access), and the SvelteKit UI for both. Read "Architecture, Sequencing & Scope
Resolution" below before touching anything — this story has a HARD PREREQUISITE on Story 6.2
(HTTP Endpoint Monitoring & Availability Alerts), which was still `backlog` at the time this story
was written. Do not skip that section. -->

<!-- REALIGNMENT PASS (2026-07-04, same day, after Story 6.2's own adversarial-review hardening
landed on `main`): this story was originally drafted speculatively, before Story 6.2's actual data
model existed. Story 6.2 has since been planned, hardened, and merged as `ready-for-dev` (not yet
`done` — the ADR-6.3-01 implementation gate below still applies), and it shipped a **materially
different** data model than this story guessed: `service_endpoints` is a fully independent table
with **no FK relationship to `payment_records`** (6.2's ADR-6.2-01), not a `payment_records`-with-a-
`url` row as ADR-6.3-02/04 originally assumed. That is exactly the "reconciliation reveals a shape
mismatch beyond renaming" scenario ADR-6.3-02's own disclaimer told the eventual implementer to stop
and re-plan for — this pass does that re-planning now, while the details are fresh, rather than
leaving it for whoever picks up Task 0 later. ADR-6.3-02/03/04/08 below are rewritten (not merely
amended) to source "services" from `service_endpoints` directly; Section B (the old AC 7 / Task 4
dashboard-truth work) is removed outright because Story 6.2's own AC 15/Task 8 already wired that
exact stub to real `service_endpoints` data — building it again here would be duplicate,
conflicting work against the same file. Every other AC/Task affected by the `payment_records` →
`service_endpoints` swap is updated in place; unaffected sections (token generation, ownership
authorization, public-page privacy/rate-limiting, audit logging, migration mechanics) are
untouched. -->

## Story

As a developer or external stakeholder,
I want a cross-project health overview and a shareable public status page for selected services,
so that I can monitor all my services in one view and share status with stakeholders who don't have vault accounts.

*Covers: FR76, FR77, FR72.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-6.3-Cross-Project-Health-Dashboard--Public-Status-Page` (lines 1724-1748)]

---

## Architecture, Sequencing & Scope Resolution (Read Before Coding)

This story sits downstream of two prior decisions — Story 6.1's already-shipped schema (`payment_records`/`cert_records`/`domain_records`, no unified `monitored_assets` table — see ADR-6.1-01/02/03 in `6-1-service-certificate-and-domain-record-management.md`) and Story 6.2's HTTP health-check data model, which is now **planned and hardened** (`ready-for-dev` on `main`, see `6-2-http-endpoint-monitoring-and-availability-alerts.md`) but **not yet implemented in code** — no `service_endpoints`/`endpoint_health_checks` table or `workers/monitoring-health-check.ts` exists yet in `packages/db/src/schema/` or `apps/api/src/workers/`. Resolve exactly as follows:

**ADR-6.3-01: Hard prerequisite on Story 6.2 — do not start 6.3 implementation until 6.2 is `done` (merged, working code — not just `ready-for-dev`).** FR76's `GET /api/v1/health-dashboard` AC literally requires per-service `status: "healthy"|"degraded"|"down"` and `lastCheckedAt` — this is HTTP-check data, not expiry data. Story 6.1's `payment_records` table (the "services" resource, `url` nullable) has no health-check columns; that data is Story 6.2's entire scope, sourced from Story 6.2's own `service_endpoints` table. **If you have picked up this story and Story 6.2 is not `done`, stop and implement/merge Story 6.2 first** — do not invent a parallel health-check mechanism inside 6.3, and do not silently return `healthy` for everything. This mirrors the discipline of `6-1`'s "do not create `service_endpoints`, Story 6.2 owns it" boundary, applied in the other direction. **The contract question ADR-6.3-02 originally left open is now resolved (see below, realignment pass)** — the remaining gate is purely "does the `service_endpoints` table/worker actually exist in the running codebase yet," not "what shape does it have."

**ADR-6.3-02 (rewritten, realignment pass): "services" in the health dashboard are `service_endpoints` rows, not `payment_records` rows.** The original version of this ADR guessed a speculative `getServiceHealthStatuses(tx, serviceIds: payment_records.id[])` repository-function contract, written before Story 6.2 existed, keyed by `payment_records.id`. Story 6.2 has since shipped (planned/hardened, `ready-for-dev`) with `service_endpoints` as a **fully independent table with no FK to `payment_records`** (6.2's ADR-6.2-01: "there is no FK between them in v1... four independent resources, not a hierarchy"). This is not a naming difference the old contract's "update the call site" escape hatch can absorb — there is no `payment_records.id` to look up a health status *for*, because a `service_endpoints` row is a wholly separate resource a user registers independently (its own `id`, `name`, `url`, unrelated to any `payment_records` row that happens to describe the same real-world service).
  - **Resolution:** drop the speculative `getServiceHealthStatuses`/`ServiceHealthStatus` contract entirely. This story queries `service_endpoints` directly — it is already project+org scoped, RLS-protected, and (per 6.2's ADR-6.2-03) already carries a computed, stored `status: 'healthy'|'degraded'|'down'` column plus `consecutiveFailures`, `lastCheckedAt`, `checkFrequencyMinutes`, `downThresholdFailures`. No separate health-state-derivation function is needed on this story's side — 6.2's worker has already done that computation and persisted the result on the row.
  - **On reusing 6.2's helper (realignment-review correction):** 6.2's own `getBatchedProjectServiceHealthStats(tx, projectIds)` (its Task 8 helper) is **not** directly reusable here despite the superficial similarity — it returns *aggregated counts* per project (`Map<projectId, {healthy, degraded, down}>`), while this story's AC 1 needs a *flat list of individual services* (`id`, `name`, `status`, `lastCheckedAt`) grouped by project. Treat 6.2's helper only as evidence that a batched-by-project query technique already exists in this module (i.e. don't reinvent the batching pattern from scratch), not as a function to call or a shape to copy verbatim — this story's Task 3 needs its own, differently-shaped query.
  - **On the `status` type (realignment-review correction):** the instruction to "import the enum/type from 6.2's schema if exported" assumes 6.2 exports a reusable TS union for `status` — but 6.2's own schema task defines `status` as a plain `text NOT NULL DEFAULT 'healthy'` column with a `CHECK IN (...)` constraint, not a Drizzle `pgEnum`, and 6.2 does not commit to exporting a status union type. **Before assuming one exists, check `packages/db/src/schema/service-endpoints.ts` once 6.2 is implemented.** If no exported type exists, declare `type ServiceHealthStatusValue = 'healthy' | 'degraded' | 'down'` locally in this story's `health-dashboard.ts` schema file with a comment pointing at 6.2's CHECK constraint as the source of truth — this is an acceptable, documented duplication of a 3-value literal union (not the "diverging union" problem the original guidance was trying to avoid, which refers to inventing *different values*, not restating the same three strings in two files).
  - **What to actually query:** `SELECT id, projectId, name, status, lastCheckedAt FROM service_endpoints WHERE projectId IN (<non-archived project ids for this org>)`, one query, then group results by `projectId` in memory (mirrors the N+1-avoidance discipline the original ADR-6.3-02 already called for, now applied to the real table).
  - **Before starting Task 3 below** (Task 2 is removed by this realignment pass — see below; there is no Task 2 to gate on), confirm `service_endpoints`'s actual shipped columns match this description by reading `6-2-http-endpoint-monitoring-and-availability-alerts.md` and, once 6.2 is implemented, `packages/db/src/schema/service-endpoints.ts` directly. A rename during 6.2's actual implementation would ripple into: this story's Task 3 query, the AC 19 migration's `service_id` FK target column, Task 5's schema file column mapping, and any shared Zod type imported per the guidance above — check all four, not just the query.

**ADR-6.3-03 (rewritten, realignment pass): no separate "degraded" derivation — consume `service_endpoints.status` verbatim.** The original version of this ADR invented a staleness-based three-way derivation (`lastCheckedAt` older than `2 × checkIntervalMinutes` ⇒ `degraded`) layered on top of the old speculative contract's binary `isDown`/`lastCheckStatus` fields. That entire derivation is now unnecessary: Story 6.2's `service_endpoints.status` column **is already** the three-value `'healthy'|'degraded'|'down'` enum FR76 needs (6.2's ADR-6.2-03: `healthy` = 0 consecutive failures, `degraded` = between 1 and `downThresholdFailures - 1`, `down` = at or above threshold), computed and persisted by 6.2's own worker on every check. This story has zero opinion on how that status is derived — it just reads the column.
  - **Accepted behavioral inheritance (documented, not a defect):** Story 6.2's AC 1 sets a brand-new `service_endpoints` row's initial `status` to `"healthy"` before any check has ever run (`consecutiveFailures: 0`, `lastCheckedAt: null`) — not `"degraded"` as this story's original draft assumed a never-checked service should read. This story does **not** override that value at the display layer (e.g. showing `degraded` on the dashboard while the same row's own `GET /service-endpoints` call would show `healthy`) — displaying anything other than the stored value would itself be a truth-in-dashboards violation, and 6.2's initial-state choice is out of scope to relitigate here since it already shipped. A newly-registered, never-checked service therefore shows as `healthy` on both the direct endpoint-management view and this story's dashboard, consistently.
  - **No staleness/worker-heartbeat detection in this story.** Whether the health-check scheduler itself is behind is Story 6.2's own concern (its ADR-6.2-09 overlap guard), not something this story re-derives from timestamps. Removing this eliminates AC 3 and its dedicated pure-function/unit-test task entirely (see Task 2 below).

**ADR-6.3-04 (rewritten, realignment pass): scope of "services" — every `service_endpoints` row, no url-null filter needed.** The original version excluded `payment_records` rows with `url IS NULL` (the only asset type with a URL to check). That filter is now moot: `service_endpoints.url` is `NOT NULL` by construction (6.2's schema) — a `service_endpoints` row only ever exists because someone registered it specifically to be HTTP-monitored, so **every** `service_endpoints` row for a non-archived project is eligible, with no additional filtering condition. `cert_records`/`domain_records` remain explicitly out of scope (expiry-tracked, not availability-tracked, already alerted via 6.1's daily jobs) — that part of the original resolution is unchanged.

**ADR-6.3-05: Public status page URL shape — frontend `/status/:token`, backend `/api/v1/status-pages/:token`.** epics.md's literal AC path `GET /status/:token` is the **user-facing, shareable SvelteKit page URL** (short, no `/api/v1/` prefix, meant to be memorable/shareable — e.g. `https://vault.example.com/status/<token>`). It is **not** a literal backend route: every backend route in this codebase lives under `/api/v1/` (`route-audit.test.ts` asserts every OpenAPI path except `/health`, `/metrics`, `/api/v1/auth/*` is in `secureRoutes`; a bare `/status/:token` backend route would be invisible to that audit and would break the established namespacing). Resolution: the backend endpoint is `GET /api/v1/status-pages/:token` (new standalone route prefix, mirroring how `/api/v1/invitations/:token` is a standalone prefix rather than nested under `/projects/`, see `apps/api/src/modules/invitations/token-routes.ts`); the SvelteKit route `apps/web/src/routes/status/[token]/+page.server.ts` calls it server-side through the existing generic `apps/web/src/routes/api/v1/[...path]/+server.ts` proxy (already unauthenticated-safe — the proxy forwards to the backend, which enforces its own `requireAuth: false` + rate limit on this specific route; the proxy itself does not gate auth on any path).

**ADR-6.3-06: Token generation reuses `opaque-token.ts`, not a new base62 encoder.** epics.md's AC literally says "22+ base62 chars". This codebase already has one reviewed, reused opaque-token abstraction (`apps/api/src/lib/opaque-token.ts`: `generateOpaqueToken()`/`hashOpaqueToken()`/`opaqueTokenMatches()`, HMAC-SHA256 storage, constant-time compare) used identically by `recovery-tokens.ts` (`apps/api/src/modules/auth/recovery-tokens.ts` — the newest, cleanest precedent: thin wrapper + a dedicated env secret). `generateOpaqueToken(32)` produces 256 bits of entropy encoded as 43 `base64url` characters — this **exceeds** the literal requirement (128-bit minimum, 22+ chars) in both entropy and length; `base64url` is URL-safe by construction (that is the entire point of the "url" variant), so it satisfies the "shareable URL" intent just as well as base62 would. **Reuse `opaque-token.ts` verbatim via a new thin wrapper `apps/api/src/modules/monitoring/status-page-tokens.ts`** (mirror `recovery-tokens.ts`'s exact shape: `generateStatusPageToken()`, `hashStatusPageToken()`, `statusPageTokenMatches()`, each delegating to the shared primitives with a new `env.STATUS_PAGE_TOKEN_HMAC_SECRET`). Inventing a parallel base62 encoder here would be the exact "reinventing wheels" anti-pattern this workflow exists to prevent.

**ADR-6.3-07: "Owner only" (FR77) means project-owner-or-org-owner, not `secureRoute`'s `minimumRole: 'owner'`.** `secureRoute`'s built-in `minimumRole` check (`apps/api/src/lib/secure-route.ts:193-194`, `hasSufficientRole`) compares against `auth.orgRole` only — it has no concept of a per-project role. Using `minimumRole: 'owner'` on the status-page routes would silently require the caller to be an **org** owner, incorrectly locking out a legitimate **project** owner who isn't an org owner. This is the exact shape of bug ADR-4.4-05 already had to resolve for project archival. Resolution — mirror `apps/api/src/modules/projects/routes.ts`'s `callerArchiveAuthorization()` pattern exactly: register the status-page mutation routes with `minimumRole: 'member'` (an org-level floor, matching the `// org-level floor; in-handler project-owner check is stricter` comment at `routes.ts:831`), then perform an explicit in-handler check: `const callerRole = await callerProjectRole(secureCtx, projectId); const authorized = callerRole === 'owner' || secureCtx.auth.orgRole === 'owner'`. Reuse `getProjectMembershipRole`/the equivalent of `callerProjectRole` — do not duplicate the query; extract/export it from `projects/routes.ts` if it is not already exported, or replicate the identical one-line query shape if extraction is impractical (check first).

**ADR-6.3-08 (removed, realignment pass): `dashboard-stats.ts`'s `monitoredServiceHealth` stub is already wired — by Story 6.2, not this story.** The original version of this ADR assigned this story the job of replacing `apps/api/src/modules/projects/dashboard-stats.ts:87`'s hardcoded `{ healthy: 0, degraded: 0, down: 0 }` with real data, per `6-1`'s Dev Notes breadcrumb ("leave that stub alone for 6.2/6.3 to resolve"). Story 6.2's own AC 15/Task 8 (`getBatchedProjectServiceHealthStats`) already does exactly this, against real `service_endpoints` data, as part of 6.2's scope. This story building the same wiring again — against a different, incompatible source table (`payment_records`) — would produce two stories independently overwriting the same three lines of `buildProjectDashboard()` with conflicting logic. **This story does not touch `dashboard-stats.ts` at all.** The old AC 7 and Task 4 that depended on this ADR are removed below (see Section B and Task 4).

**ADR-6.3-09: How the public, unauthenticated `GET /api/v1/status-pages/:token` resolves an org-scoped row without an org session (resolves the RLS-bypass question the public GET otherwise leaves open).** The caller has no session and is not scoped to any org, but `status_pages`/`status_page_services` are `orgScoped` tables with `ENABLE ROW LEVEL SECURITY` policies keyed on `current_setting('app.current_org_id')` (AC 10, AC 19) — a query with no org context set cannot see any row under normal RLS-scoped connections (`withOrg`/`getDb()`). This is the **exact same problem** `apps/api/src/modules/invitations/token-routes.ts`'s public `GET /:token` already solves for `project_invitations` (also `orgScoped` + RLS-protected, per `0025_project_invitations.sql`): resolve as follows, mirroring that precedent exactly —
  1. **Point lookup via the admin connection.** `apps/api/src/modules/invitations/lookup.ts`'s `findInvitationByTokenHash()` performs its single point-lookup by the unique hashed-token index via `getAdminDb()` (`apps/api/src/lib/db.ts`), not `withOrg`/`getDb()`, with this exact documented rationale (quoted verbatim from that file, apply the same reasoning here): *"The caller's org is unknown until the [row] is resolved, so a per-org RLS-scoped scan isn't an option here (and would be an unbounded table scan across every org in the vault). This is a single point-lookup by the unique HMAC-hashed token index via the admin connection — the 256-bit token is itself the authorization credential, the same trust model that already excludes `refresh_tokens`/`pending_mfa_sessions` from RLS for identical pre-auth lookups."* Create `findStatusPageByTokenHash()` in `apps/api/src/modules/monitoring/service.ts` (or the sibling status-page service file from Task 6) following this exact shape: `getAdminDb().select().from(statusPages).where(eq(statusPages.tokenHash, tokenHash)).limit(1)`.
  2. **Re-scope with `withOrg` once the org is known.** Once the admin lookup resolves the row's `orgId`, the join to `status_page_services` (and any subsequent read) runs inside `withOrg(statusPage.orgId, tx => ...)` — mirroring `invitationTokenRoutes`'s `GET /:token` handler, which resolves `invitation.orgId` from the admin lookup and then re-scopes the follow-up `projects` query with `withOrg(invitation.orgId, ...)`. Do not perform the `status_page_services` join on the admin connection — only the initial org-unknown point lookup needs the bypass.
  3. **This is not a new RLS exception pattern** — it is the same trust model already applied to `project_invitations`, `refresh_tokens`, and `pending_mfa_sessions`: a sufficiently-high-entropy token *is* the authorization credential for that one specific pre-auth lookup, and RLS resumes normal enforcement immediately afterward. `check-rls-coverage.ts` (AC 19/Task 5) is expected to pass unchanged — this ADR does not disable RLS on `status_pages`/`status_page_services`, it documents one narrow, precedented point-lookup exception to it.
  4. **Test requirement:** `public-status-page-routes.test.ts` (Task 11) must include a test mirroring `packages/db/src/schema/auth-sessions-schema.test.ts`'s "documents `refresh_tokens` as an RLS coverage exception" pattern — assert that the admin-connection point lookup is a deliberate, tested exception (e.g., a cross-org integration test: token created under org A resolves correctly when looked up with no org context set at all, not merely "org B can't see it" which AC 10 already covers for the authenticated admin routes).

---

## Known Scope Boundaries

- **No pagination on `GET /api/v1/health-dashboard`.** epics.md's literal endpoint shape has no `page`/`limit` params, and NFR-perf targets nothing about org-wide monitored-service counts. This endpoint returns every accessible project with ≥1 eligible service, unpaginated — acceptable at expected scale (a single org's total registered services), matching 6.1's precedent of documenting an unsourced-but-reasonable bound rather than silently adding one. If org sizes grow enough to make this a real concern, that is future-story scope, not 6.3's.
- **Certs and domains are not part of the health dashboard or public status page.** Only `service_endpoints` rows are eligible (ADR-6.3-04, realigned). Do not extend `status_page_services` or the health-dashboard query to `cert_records`/`domain_records`/`payment_records`.
- **No new notification/alert type.** Unlike 6.1, this story does not add anything to `NOTIFICATION_ALERT_TYPES` — enabling/disabling a public status page is an audited admin action, not a proactive alert to org admins.
- **Public status page views (`GET /api/v1/status-pages/:token`) are never audit-logged.** High-frequency, unauthenticated, potentially-scraped traffic writing to the audit log would be a storage/DoS-adjacent concern the architecture doc already flags generically ("Rate Limiting × Audit Volume" risk, architecture.md line 137). Only the four admin mutations (enable, regenerate, update, disable) are audited. See AC 18.
- **No dedicated enumeration/abuse-metrics instrumentation for the public GET.** Beyond the IP rate limit (AC 13) and standard per-request Fastify access logs (method/path/status/IP, already emitted for every route in this codebase with no story-specific change needed), this story adds no additional probing/enumeration detection (e.g. alerting on repeated-404 patterns against `/api/v1/status-pages/:token`). Brute-forcing a 256-bit token is impractical regardless; building dedicated abuse-metrics tooling is out of scope for this story and would apply equally to every other public token-based endpoint in the codebase (e.g. invitations), not just this one.
  - **Compounding effect, acknowledged explicitly (realignment-review finding):** this bullet and the one above it (no audit logging for public views) are each individually justified in isolation, but taken together they mean an org admin has **no way at all** to learn how many times, from where, or how aggressively their externally-shared status page link has been accessed or probed — not even a coarse count. This is an accepted trade-off for v1, not an oversight: building either visibility mechanism (audit logging or abuse metrics) for this one route without a broader observability story for all public token-based endpoints would be inconsistent scope creep. A future story adding basic view-count/access telemetry across all public endpoints (invitations included) would be a reasonable place to close this gap, not a fix scoped to this story alone.
- **No retroactive cleanup when a referenced service is deleted after being added to a status page.** If a `service_endpoints` row referenced by `status_page_services` is later deleted via 6.2's `DELETE .../service-endpoints/:serviceEndpointId`, the FK is `ON DELETE CASCADE` (AC 19, realigned) — the `status_page_services` row is removed automatically along with it, so there is no dangling reference to handle at read time (simpler than the original draft's "ineligible but still referenced" concern, which no longer applies now that eligibility is just "the row exists," per ADR-6.3-04's realignment). Removing a service from an *enabled* status page without deleting the underlying endpoint remains a manual admin action (re-`PUT` without that `serviceId`, AC 15).
- **No notification to admins when a shared link stops working.** When a status page is disabled (AC 16) or its token regenerated (AC 11), any external viewer who previously bookmarked/was sent the old link silently receives the same generic `404` used for "never existed" (AC 12) — there is no distinct "revoked" response and no notification mechanism back to the org admin about active external viewers being cut off. This is intentional given the public GET has no viewer identity to notify; a future story could add softer revocation UX if this becomes a real support burden.
- **No CORS/embeddability/caching headers beyond the default.** The public status page endpoint adds no `X-Frame-Options`/CSP `frame-ancestors` changes (iframe-embeddability on a third-party page is not a requirement of FR72/FR77 and is out of scope) and no explicit CORS configuration (the SvelteKit page fetches it server-side through the existing proxy, never cross-origin from a browser). Task 7's route handler must set `Cache-Control: no-store` on the response so an intermediate CDN/proxy cannot serve a stale "enabled" or stale service list after a regenerate or disable.
- **This story's "services" are `service_endpoints` rows, distinct from 6.1's `payment_records`-as-"services" naming.** Both the internal health dashboard and the public status page source their "services" from `service_endpoints` (realigned — see ADR-6.3-02/04), not `payment_records`. This means a project can have `payment_records` rows (billing/hosting references, no health check) that never appear on the health dashboard at all, alongside `service_endpoints` rows (HTTP-monitored, no billing info) that do — the two "services" concepts are visually/conceptually similar to an end user but are backed by unrelated tables with no cross-reference in v1 (6.2's own explicit, deliberate decision). This is worth calling out to whoever builds the UI (Task 8/9) so the copy doesn't imply a single unified "services" list when there are actually two independent ones.
- **`AuditEventType`/`AuditEvent` dual-listing pattern is reused, not fixed.** AC 17 continues the existing pattern (flagged as fragile in 6.1's own Dev Notes: missing either half of the object/union pair is a type error only, not a runtime failure) rather than consolidating it into a single source of truth. Fixing that pattern is a cross-story refactor of `audit-events.ts` affecting every prior story's audit events too, and is out of scope here.

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

**Numbering note (realignment-review finding):** two different conventions were used to evolve this list across revisions, for different reasons. AC 3 and AC 7 are **retired and skipped** — removed entirely by the realignment pass, numbers not reused, so every other AC/Task cross-reference in this file stays valid without a renumbering pass. AC 10a is a **suffix-inserted** addition from an earlier hardening pass, made before the realignment pass touched this file — it was inserted between AC 10 and AC 11 rather than appended, because it logically belongs with AC 10's admin-mutation-routes group. AC 21 (new in this realignment pass) is **appended** at the end in its own subsection, since it doesn't logically belong adjacent to any single existing AC. In short: retire-and-skip for removals, suffix-insertion or append for additions, chosen per case to minimize disruption to existing cross-references — not an oversight.

### A. Cross-project health dashboard — `GET /api/v1/health-dashboard`

1. **Given** an authenticated user with any org role (`viewer`+) and at least one project in their org has a `service_endpoints` row, **when** they call `GET /api/v1/health-dashboard`, **then** the response is `200` with `{ data: { projects: [{ projectId, projectName, services: [{ id, name, status, lastCheckedAt }] }], summary: { healthy, degraded, down } } }`, where `projects` includes only non-archived projects that have ≥1 `service_endpoints` row (ADR-6.3-04, realigned — every `service_endpoints` row is eligible, no filtering needed), each `services[]` entry's `status`/`lastCheckedAt` is read **verbatim** from the `service_endpoints` row (ADR-6.3-02/03, realigned — no client-side derivation), and `summary` is the sum of all `status` values across all listed services.
   - *Example (happy path):* org has 2 projects; project A has one service currently healthy, one currently down; project B has one degraded service. Response: `projects: [{ projectId: 'A', services: [{status:'healthy'},{status:'down'}] }, { projectId: 'B', services: [{status:'degraded'}] }], summary: { healthy: 1, degraded: 1, down: 1 }`.
   - *Example (edge — no services anywhere in org):* `projects: []`, `summary: { healthy: 0, degraded: 0, down: 0 }`, HTTP `200` (not `404` — an empty dashboard is a valid state, not an error).
   - *Example (edge — a project only has `payment_records`, no `service_endpoints`):* that project is excluded from `projects[]` entirely (ADR-6.3-02/04, realigned — `payment_records` rows, even ones with a `url`, are never a source of "services" for this endpoint; that table has no relationship to `service_endpoints`).
   - *Example (edge — archived project):* a project with `archivedAt IS NOT NULL` that has monitored services is excluded from `projects[]` entirely, even though its `service_endpoints` rows still physically exist.

2. **Given** the same endpoint, **when** a service has never had a health check recorded (brand-new `service_endpoints` row, `lastCheckedAt: null`), **then** it is reported exactly as 6.2 stores it: `status: 'healthy'`, `lastCheckedAt: null` (realigned — the original draft of this AC assumed a never-checked service should read `degraded`; that assumption predates Story 6.2's actual initial-state choice of `healthy` for a freshly-registered endpoint, per 6.2's AC 1. This story does not override 6.2's stored value at the display layer — see ADR-6.3-03's "accepted behavioral inheritance" note. A user who wants to distinguish "confirmed healthy" from "not yet checked" must currently do so via `lastCheckedAt: null`, which this AC preserves in the response for exactly that purpose).
   - *Example:* `POST .../service-endpoints` creates a service at `T`; `GET /api/v1/health-dashboard` called at `T+1s` (before the health-check worker's first scheduled run) shows that service as `healthy`, `lastCheckedAt: null` — matching what `GET /api/v1/projects/:projectId/service-endpoints` itself would already show for the same row.

~~3.~~ **Removed (realignment pass, ADR-6.3-03).** The original AC 3 defined a staleness-based `degraded` override (`lastCheckedAt` older than `2 × checkIntervalMinutes`) layered on top of the speculative pre-6.2 contract. There is no such derivation anymore — `service_endpoints.status` is read verbatim (AC 1/2). Whether the health-check worker itself is falling behind schedule is Story 6.2's own concern (its scheduler-overlap guard), not something this story re-derives from timestamps.

4. **Given** an unauthenticated request, **when** `GET /api/v1/health-dashboard` is called with no session cookie, **then** the response is `401` (standard `SecureRoute` `requireAuth` behavior — no special-casing needed, this route is fully authenticated, unlike the public status page).

5. **Given** two organizations A and B each with monitored services, **when** a user authenticated in org A calls `GET /api/v1/health-dashboard`, **then** the response contains only org A's projects/services — org B's data is invisible (RLS `org_id` scoping via `withOrg`/`withOrgReadScope`, same mechanism as every other cross-project query in this codebase, e.g. `getOrgDashboardData`). Verified by an integration test using `withTestOrg()` twice and asserting cross-org absence, not merely correct counts for one org.

6. **And** the route is registered with `minimumRole: 'viewer'`, `writeAuditEvent: false` (a health-status read is not a sensitive action — mirrors `dashboardRoutes`' existing `GET /api/v1/dashboard` exactly, see `apps/api/src/modules/dashboard/routes.ts`), and an explicit rate limit `{ max: 120, timeWindowMs: 60_000 }` (mirrors `LIST_RATE_LIMIT` already defined in `apps/api/src/modules/monitoring/routes.ts:94` — reuse that constant, do not redefine a diverging value).
   - *Example (failure — rate limit):* a caller exceeding 120 requests/minute to this endpoint receives `429` with the standard rate-limit error shape used elsewhere in the codebase.

### B. Per-project dashboard truth — **removed (realignment pass, ADR-6.3-08)**

The original Section B / AC 7 assigned this story the job of wiring `dashboard-stats.ts`'s `monitoredServiceHealth` stub to real data. Story 6.2's own AC 15/Task 8 already does this against real `service_endpoints` data, as part of 6.2's own scope. This story does not touch `dashboard-stats.ts` — see ADR-6.3-08. (There is no AC 7 in this story; the number is retired rather than reused, so downstream AC/Task cross-references elsewhere in this file don't need renumbering.)

### C. Enable a public status page — `POST /api/v1/projects/:projectId/status-page`

8. **Given** a project exists, has no existing enabled status page, and the caller is the project owner or an org owner (ADR-6.3-07), **when** they call `POST /api/v1/projects/:projectId/status-page` with `{}` (no body required — services are configured separately via PUT, see AC 15; pre-existing cross-reference bug fixed during realignment, was "AC 20" which is the schema-export AC), **then** a `status_pages` row is created (`orgId`, `projectId` unique, `tokenHash`, `createdBy`, `createdAt`, `updatedAt`) and the response is `201` with `{ data: { token: '<plaintext, shown once>', createdAt } }` — the plaintext token is never persisted and never retrievable again via any other endpoint.
   - *Example (happy path):* `POST /api/v1/projects/proj-1/status-page {}` as project owner → `201 { data: { token: 'kR3f...(43 chars)', createdAt: '2026-07-04T...' } }`.
   - *Example (failure — insufficient role):* caller is a project `member`/`viewer`/`admin` (not project owner, not org owner) → `403 { code: 'insufficient_role' }`.
   - *Example (failure — cross-org/nonexistent project):* `projectId` belongs to another org or doesn't exist → `404 project_not_found` (never `403` — matches the established convention of not leaking cross-org existence).
   - *Example (failure — archived project):* project is archived → `410` via `rejectIfProjectArchived` (same guard as 6.1).
   - *Example (failure — already enabled):* a second `POST` while a `status_pages` row already exists for this project → `409 { code: 'status_page_already_enabled' }` — the caller must use the regenerate endpoint (AC 11) to rotate the token, not re-`POST`. This prevents an accidental silent no-op or an accidental second row that would violate the `projectId` uniqueness constraint anyway (constraint is the backstop; the `409` is the friendly error path checked first).
   - *Example (concurrency — race between two concurrent first-time `POST` calls, realignment-review finding):* both requests pass the "no existing status page" pre-check before either commits; the second `INSERT` to reach the DB hits the `UNIQUE(project_id)` constraint violation. The handler **must catch this specific constraint-violation error and map it to the same `409 status_page_already_enabled`** used above — not let it surface as an unhandled `500`. Mirrors the same class of race AC 11 already documents for regenerate, just at the insert rather than update step.

9. **And** `POST` requires MFA enrollment (`requireMfa: true`) — mirrors the project-archival precedent (`routes.ts:832`) for high-impact actions that create a new externally-shareable secret; a caller without MFA enrolled receives the standard MFA-required error regardless of role.
   - *Example (failure):* project-owner caller without `mfa_enrolled_at` set → `403` (standard MFA-required response shape, same as any other `requireMfa: true` route).
   - **No new enrollment/remediation flow is introduced by this story.** An authorized-but-unenrolled owner sees the same standard MFA-required error already used by every other `requireMfa: true` route (e.g. project archival) and must complete enrollment via the existing account-settings MFA flow before retrying. This is not a new availability gap introduced by 6.3 — it is identical, pre-existing behavior inherited from the `requireMfa` mechanism itself, and out of scope to change here.

10. **And** RLS isolation: a `status_pages` row created under org A's project is invisible to any request scoped to org B (enforced via `org_id = current_setting('app.current_org_id')`), verified by an integration test and by `check-rls-coverage.ts` passing for the new table.

10a. **And** all four admin mutation routes (`POST`/`PUT`/`DELETE`/regenerate) are registered with `rateLimit: WRITE_RATE_LIMIT`, which is the existing exported constant `{ max: 60, timeWindowMs: 60_000 }` from `apps/api/src/modules/monitoring/routes.ts:95` — the same concrete numbers already used for AC 13's public GET, reused (not redefined) for the mutation routes so this AC is traceable to an exact, testable value rather than a symbolic name.
    - *Example (failure — rate limit):* a caller exceeding 60 mutation requests/minute (across enable/regenerate/update/disable combined, per-route-pattern keying consistent with `WRITE_RATE_LIMIT`'s existing usage elsewhere in this module) receives `429` with the standard rate-limit error shape.

### D. Regenerate the token — `POST /api/v1/projects/:projectId/status-page/regenerate`

11. **Given** a project with an existing enabled status page and the caller is the project owner or org owner, **when** they call `POST /api/v1/projects/:projectId/status-page/regenerate`, **then** a new opaque token is generated, `tokenHash` is atomically replaced (same `status_pages` row, `updatedAt` bumped), and the response is `200 { data: { token: '<new plaintext, shown once>', updatedAt } }`; the **old** token immediately stops resolving.
    - *Example (happy path):* regenerate → old token `abc...` now `404`s on `GET /api/v1/status-pages/abc...`; new token `xyz...` resolves `200`.
    - *Example (failure — no status page exists yet):* `404 { code: 'status_page_not_found' }` — caller must `POST .../status-page` first.
    - *Example (concurrency — race between two regenerate calls):* two concurrent `POST .../regenerate` requests from the same authorized owner (e.g. two open browser tabs) — the `UPDATE ... WHERE project_id = $1` runs inside a transaction; whichever commits last wins and its plaintext token is the one actually valid going forward. **Both requests receive a `200` with a token in the response body, but only the later-committing one's token remains valid** — this is an inherent property of "the response shows the plaintext once," not a bug to prevent, but it MUST be called out in the endpoint's OpenAPI description (`"if called concurrently, only the last-committed token remains valid — earlier ones in flight will silently stop working"`) so frontend/API consumers are not surprised. Do not attempt row-locking to "fix" this — the plaintext is already unrecoverable by the time a second caller could inspect the first's result, so there's no meaningful race to close beyond documenting it.
    - *Example (audit trail under the same race, AC 17 interaction):* both concurrent calls each write their own `STATUS_PAGE_TOKEN_REGENERATED` audit row inside their own successful transaction — this produces **two** audit events for what is effectively one final winning token state. This is accepted and intentional, not a bug: each row accurately records a distinct regenerate call that really happened, at its own timestamp. Do not attempt to suppress, deduplicate, or merge the second audit write — a reviewer inspecting the audit trail after such a race correctly sees two `status_page.token_regenerated` events close together, reflecting that two requests were genuinely made even though only one's resulting token survived.
    - MFA required, same as AC 9.

### E. Public unauthenticated read — `GET /api/v1/status-pages/:token`

12. **Given** a valid, non-revoked token matching an enabled `status_pages` row, **when** anyone (no `Authorization`/session cookie required) calls `GET /api/v1/status-pages/:token`, **then** the response is `200 { data: { services: [{ displayName, status, lastCheckedAt }] } }` ordered by the `status_page_services.sortOrder` — **never** including `serviceId`, the underlying `service_endpoints.name`/`url` (**realigned** — this was a leftover `payment_records` reference from the pre-realignment draft, corrected per the realignment review), `projectId`, `orgId`, or any other internal identifier (FR77's core privacy guarantee).
    - *Example (happy path):* status page configured with 2 services, display names "Payments API" and "Auth Service" → `200 { data: { services: [{ displayName: 'Payments API', status: 'healthy', lastCheckedAt: '...' }, { displayName: 'Auth Service', status: 'down', lastCheckedAt: '...' }] } }`.
    - *Example (edge — status page enabled but zero services configured):* `200 { data: { services: [] } }` — not an error; this is a valid "page exists, nothing shown yet" state (matches Riley's flow of enabling the page before configuring services in AC 15).
    - *Example (failure — unknown token):* any string not matching a stored `tokenHash` (via `statusPageTokenMatches`, constant-time compare) → `404 { code: 'status_page_not_found' }`. **Must not distinguish** "malformed token" vs. "well-formed but wrong" vs. "was valid, now disabled" in either status code or response timing — all three collapse to the same `404`, same latency profile (the constant-time compare already prevents a timing side-channel; do not add an early-return fast-path for "obviously malformed" tokens that would reintroduce one).
    - *Example (failure — status page was disabled via DELETE):* previously-valid token → `404` (same code/shape as "never existed" — see AC 16).

13. **And** the rate limit is `{ max: 60, timeWindowMs: 60_000 }` keyed by IP (`requireAuth: false` routes in this codebase's `SecureRoute` already key rate limits as `ip:${request.ip}` for public routes — `apps/api/src/lib/secure-route.ts:277-297`, `handlePublicRequest`/`enforceUserRateLimit` — this is not new plumbing, just correct config), satisfying FR77's literal "60 requests/minute per IP" requirement exactly.
    - *Example (happy path):* 60 requests from the same IP within 60 seconds all succeed (assuming valid token).
    - *Example (failure):* the 61st request within the same window → `429`, standard rate-limit error shape.
    - *Example (edge — many different tokens, one IP):* the per-IP bucket is shared across all tokens requested by that IP (key is the route pattern `GET /api/v1/status-pages/:token`, not per-token) — a script hitting 3 different status pages 20 times each from one IP hits the same 60-request ceiling. This is intentional (FR77 says "per IP", not "per IP per token") — do not key by `ip+token`.
    - **Accepted availability trade-off:** a shared/NAT'd IP (corporate network, CGNAT mobile carrier) with multiple people or processes simultaneously viewing status pages can collectively exhaust the 60 req/min ceiling and temporarily block unrelated legitimate viewers behind the same IP. This is a deliberate consequence of following FR77's literal "60 requests/minute per IP" wording; no additional keying (e.g., IP+User-Agent heuristics) or per-token sub-bucketing is introduced to mitigate it in this story.

14. **And** this route is `requireAuth: false`, `writeAuditEvent: false` (no audit row per view — see Known Scope Boundaries), and registered under a new standalone prefix `/api/v1/status-pages` (ADR-6.3-05) — added to `route-exemptions.ts`'s `ROUTE_ACTION_CLASSIFICATIONS` with `action: 'read'` and an `auditOmissionReason` (mirror the existing `MONITORING_LIST_READ_OMISSION_REASON`-style constant, or a new one: `"Public, unauthenticated, high-frequency status page view — auditing every view would create unbounded audit-log growth from external, non-actor traffic; see Known Scope Boundaries in 6-3 story file."`).

### F. Update configured services — `PUT /api/v1/projects/:projectId/status-page`

15. **Given** an enabled status page and the caller is the project owner or org owner, **when** they call `PUT /api/v1/projects/:projectId/status-page` with `{ services: [{ serviceId, displayName }, ...] }`, **then** the full `status_page_services` set for that status page is replaced atomically (delete-all-then-insert-new, in one transaction) with `sortOrder` set to array index, and the response is `200` with the updated public-facing service list. **Requires MFA enrollment (`requireMfa: true`, realignment-review finding)** — the original draft only gated enable/regenerate on MFA; this route can materially change what an already-shared public page displays to external viewers without minting a new secret, which is exactly the kind of high-impact action the other two MFA-gated routes exist to protect. A caller without MFA enrolled receives the standard MFA-required error, same shape as AC 9.
    - *Example (happy path):* `PUT { services: [{ serviceId: 'svc-1', displayName: 'Payments API' }, { serviceId: 'svc-2', displayName: 'Auth Service' }] }` → `200`, both rows created with `sortOrder: 0, 1`.
    - *Example (edge — empty array):* `PUT { services: [] }` → `200`, all existing `status_page_services` rows for this status page deleted; public page now shows `services: []` (AC 12's empty-state).
    - *Example (failure — validation, empty or whitespace-only display name):* `displayName` empty, exceeds 100 chars, **or consists entirely of whitespace** (realignment-review finding — trim before length-checking, not just reject empty-string) → `422` with field-level Zod error. A caller cannot submit `"   "` and have it silently render as a blank label on the public page.
    - *Example (failure — serviceId not a `service_endpoints` row in this project, realigned):* references a `service_endpoints.id` from a different project, a `payment_records`/`cert_records`/`domain_records` id (a different table entirely — realigned per ADR-6.3-02/04, no longer "eligible vs. ineligible" filtering within one table, just "is this id a `service_endpoints` row belonging to this project"), or a nonexistent id → `422 { code: 'invalid_service_reference' }` (validated in the same transaction, not deferred to a later health-check failure).
    - *Example (failure — duplicate serviceId in one request):* `services: [{serviceId: 'svc-1', ...}, {serviceId: 'svc-1', ...}]` → `422` (the `UNIQUE(statusPageId, serviceId)` constraint is the DB-level backstop, but validate in the Zod schema first for a clean error message rather than a raw constraint-violation 500).
    - *Example (failure — more than 50 services in one request):* `422` — arbitrary reasonable cap (undocumented in epics.md/architecture.md, same style of documented-but-unsourced bound as 6.1's `alertLeadDays` max-10 cap) bounding public-page rendering size; document the choice inline.
    - *Example (failure — no status page exists yet):* `404 { code: 'status_page_not_found' }`.
    - *Example (injection — HTML/script content in `displayName`):* `displayName: '<script>alert(1)</script>'` is accepted by the length/non-empty Zod validation (no character-class restriction — operators may legitimately want punctuation in a display name) and stored verbatim, but **must render as inert literal text, never as markup**, on both the public status page (Task 10) and the admin management UI (Task 9). This is achieved by relying exclusively on Svelte's default auto-escaping for `{displayName}` interpolation — **never** use `{@html displayName}` anywhere in Task 9/10's templates. `public-status-page-routes.test.ts` (Task 11) must include an explicit assertion that a `displayName` containing `<`, `>`, and `&` round-trips through the API as the literal stored string (the API itself does not escape — HTML-escaping is a rendering-time concern, not a storage concern) and a Playwright/component test for Task 10 must assert the rendered DOM contains the literal text node, not an executed `<script>` element.

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
    - *Example (previous-state snapshot on update, realignment-review finding):* `PUT` performs the same kind of destructive delete-all-then-insert replace on `status_page_services` as `disable` does on the whole `status_pages` row — so `status_page.updated`'s audit payload must include a snapshot of the **previous** service list before the replace (`payload: { projectId, previousServiceCount, previousDisplayNames: [...], newServiceCount, newDisplayNames: [...] }`), not just the new state. Without it, an auditor investigating "what did the public page show before this change" has no record — the same information-loss risk the disable-snapshot rule was designed to prevent, applied inconsistently before this fix.

18. **And** `GET /api/v1/status-pages/:token` (public view) is explicitly **not** audited (see AC 14 and Known Scope Boundaries) — a code reviewer should not "helpfully" add an audit call here; this is a deliberate, documented omission, not an oversight.

### I. Migration & schema

19. **And** two new tables are created in one migration (next free number — re-check `packages/db/src/migrations/meta/_journal.json`, `0029` as of this story's writing but verify per 6.1's own caution about stale `drizzle-kit generate` snapshot lineage). **Near-certain collision, not a generic caveat (realignment-review finding):** Story 6.2's own migration task independently claims the same `0029` for its own three-table migration, and ADR-6.3-01 makes Story 6.2 being `done` a hard prerequisite for starting 6.3 — meaning 6.2's migration will almost certainly already be merged and consuming `0029` (or whatever it lands on) by the time anyone works on this story. Treat "re-check `_journal.json`" as an expected renumbering, not a rare edge case: budget for this story's migration to land at `0030` or later, and re-verify the number a second time immediately before opening the PR (mirrors 6.2's own hardened Task 2 guidance for the identical risk).
    - `status_pages`: `id uuid PK`, `...orgScoped({onDelete:'cascade'})`, `project_id uuid NOT NULL UNIQUE FK → projects.id ON DELETE CASCADE`, `token_hash text NOT NULL UNIQUE`, `created_by uuid FK → users.id ON DELETE SET NULL`, `created_at`, `updated_at`.
    - `status_page_services`: `id uuid PK`, `...orgScoped({onDelete:'cascade'})`, `status_page_id uuid NOT NULL FK → status_pages.id ON DELETE CASCADE`, `service_id uuid NOT NULL FK → service_endpoints.id ON DELETE CASCADE` (**realigned, ADR-6.3-02/04** — was `payment_records.id` in the original draft, written before Story 6.2's actual `service_endpoints` table existed; a `service_endpoints` row deleted via 6.2's own `DELETE .../service-endpoints/:serviceEndpointId` now automatically cascades the `status_page_services` reference, closing the "referenced service becomes ineligible" gap the original draft had to handle at read time — see Known Scope Boundaries), `display_name text NOT NULL` (`check` length 1-100, mirroring 6.1's `char_length` check pattern), `sort_order integer NOT NULL DEFAULT 0`, `created_at`, `updated_at`, `UNIQUE(status_page_id, service_id)`.
    - Both tables get `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` in the **same migration file** (hand-write following `0025_project_invitations.sql`'s exact shape — `drizzle-kit generate`'s snapshot lineage is stale per 6.1's Debug Log; hand-author and hand-append the `_journal.json` entry the same way the last several stories did).
    - Indexes: `UNIQUE` on `status_pages(project_id)`, `UNIQUE` on `status_pages(token_hash)` (doubles as the public lookup index), `idx_status_pages_org` on `org_id`; `idx_status_page_services_status_page_id` on `status_page_services(status_page_id)` (public-page join), `UNIQUE(status_page_id, service_id)`, `idx_status_page_services_org` on `org_id`.
    - *Example (migration correctness check):* `pnpm db#check-rls` passes for both new tables; `\d status_pages` / `\d status_page_services` manually confirm columns/FKs/checks/policy against a real Postgres instance, mirroring 6.1's Debug Log verification step.

20. **And** exporting both new Drizzle tables from `packages/db/src/schema/index.ts` (append after `domain-records.ts`'s line, alongside the existing `payment-records.ts`/`cert-records.ts`/`domain-records.ts` exports).

### J. Read current status page configuration — `GET /api/v1/projects/:projectId/status-page`

21. **And** (realignment-review finding — closes a gap the original draft never covered: no AC anywhere defined how an admin reads back the current configuration) `GET /api/v1/projects/:projectId/status-page`, same ownership authorization as enable/regenerate/update/disable (project owner or org owner, ADR-6.3-07; `minimumRole: 'member'` + in-handler check; **not** `requireMfa` — a read has no MFA requirement, consistent with disable's rationale), returns `{ data: { enabled: boolean, createdAt, updatedAt, services: [{ serviceId, displayName, sortOrder }] } }` if a status page exists for the project, or `{ data: { enabled: false } }` if none exists yet — **never** `404` for "not yet enabled" (that is a common, valid state distinct from AC 8's `404 project_not_found`/`410` archived-project cases). This is the endpoint Task 9's admin UI calls to pre-populate its service picker with already-configured services and display names, and what Riley's persona journey ("opens a project's settings, finds a new 'Public status page' section") implicitly requires to render existing configuration. Never returns the plaintext token (never persisted, AC 8) or `tokenHash`.
    - *Example (happy path — enabled, 2 services configured):* `GET /api/v1/projects/proj-1/status-page` → `200 { data: { enabled: true, createdAt: '2026-07-04T...', updatedAt: '2026-07-04T...', services: [{ serviceId: 'svc-1', displayName: 'Payments API', sortOrder: 0 }, { serviceId: 'svc-2', displayName: 'Auth Service', sortOrder: 1 }] } }`.
    - *Example (edge — not yet enabled):* `200 { data: { enabled: false } }` — not an error, and `services` is omitted/empty rather than throwing.
    - *Example (failure — insufficient role):* caller is a project `member`/`viewer`/`admin` (not owner) → `403`.
    - *Example (failure — cross-org/nonexistent/archived project):* same conventions as AC 8 — `404 project_not_found` / `410` via `rejectIfProjectArchived`.
    - *Example (rate limit):* `LIST_RATE_LIMIT` (`{ max: 120, timeWindowMs: 60_000 }`, mirrors AC 6's cross-project dashboard route) — a read endpoint, not `WRITE_RATE_LIMIT`.

## Tasks / Subtasks

- [x] Task 0 — Prerequisite check (blocking, AC: all)
  - [x] Confirm Story 6.2 is `done` in `sprint-status.yaml` (not just `ready-for-dev`) — i.e. `service_endpoints`/`endpoint_health_checks`/`monitoring_alerts` tables and the health-check worker actually exist and are merged. If 6.2 is not `done`, stop and coordinate — do not proceed past this task (ADR-6.3-01).
  - [x] **The contract reconciliation this task originally asked for is already done** (realignment pass, ADR-6.3-02/03/04): this story now queries `service_endpoints` directly, no speculative repository-function contract remains. The only remaining check here is confirming 6.2's *actual* shipped column names on `service_endpoints` (`status`, `lastCheckedAt`, `name`, `id`) match what this story assumes — read `packages/db/src/schema/service-endpoints.ts` once 6.2 is implemented. **If any column was renamed during 6.2's own implementation (realignment-review finding — full blast radius, not just the query), update all four of:** Task 3's query, the AC 19 migration's `service_id` FK target column, Task 5's schema file column mapping, and any shared Zod type declared per ADR-6.3-02's guidance.

- [x] Task 1 — Registries (AC: 17) [Source: `packages/shared/src/constants/audit-events.ts`]
  - [x] Add `STATUS_PAGE_ENABLED`, `STATUS_PAGE_TOKEN_REGENERATED`, `STATUS_PAGE_UPDATED`, `STATUS_PAGE_DISABLED` to both the `AuditEvent` object and the `AuditEventType` union (both regions — see AC 17 note).
  - [x] Add `STATUS_PAGE_TOKEN_HMAC_SECRET` to `apps/api/src/config/env.ts`: schema entry (`secretEnvDefault` pattern, `DEV_STATUS_PAGE_TOKEN_HMAC_SECRET = 'g'.repeat(64)`), `ProductionEnv` type entry, a `validateStatusPageTokenProductionSecret()` function mirroring `validateRecoveryTokenProductionSecret()` exactly (required in prod, must differ from every other secret including the newest `RECOVERY_TOKEN_HMAC_SECRET`, must not match `PLACEHOLDER_SECRET_PATTERN`), call it from `validateProductionEnv()`, and add it to the `RawEnv`/`Env` type omission-and-re-add block (`env.ts:401-413` region).

- [x] Task 2 — **Removed (realignment pass, ADR-6.3-02/03).** The original Task 2 built a pure `computeServiceHealthState()` derivation function against the speculative pre-6.2 contract, including a staleness boundary test. There is no derivation left to build — `service_endpoints.status` is read verbatim (see Task 3). Nothing to implement here.

- [x] Task 3 — Health dashboard schema + service + route (AC: 1, 2, 4-6) [Source: `apps/api/src/modules/dashboard/routes.ts`, Story 6.2's `apps/api/src/modules/monitoring/service.ts`/`schema.ts` conventions]
  - [x] Add `HealthDashboardSchema`/`HealthDashboardServiceSchema` to `packages/shared/src/schemas/health-dashboard.ts` (mirror `org-dashboard.ts`'s shape/`.meta({id:...})` convention exactly); export from `packages/shared/src/index.ts`. `HealthDashboardServiceSchema` fields: `{ id, name, status, lastCheckedAt }`. **On `status`'s type (realignment-review correction):** check whether `packages/db/src/schema/service-endpoints.ts` (6.2) exports a reusable status union type first — but 6.2's `status` column is a plain `text` + `CHECK` constraint, not a Drizzle `pgEnum`, so it may not export one. If it doesn't, declare `'healthy' | 'degraded' | 'down'` locally here with a comment citing 6.2's CHECK constraint as the source of truth — restating the same three literal values in two files is acceptable; inventing *different* values would not be.
  - [x] Create `apps/api/src/modules/monitoring/health-dashboard-service.ts`: query all non-archived projects in the org, then **exactly one** batched query `SELECT id, projectId, name, status, lastCheckedAt FROM service_endpoints WHERE projectId = ANY(<project ids>)` for the entire org — **not** one call per project (ADR-6.3-02, realigned). Group the single query's results back by project in memory, filter out projects with zero `service_endpoints` rows, and compute `summary` by counting `status` values across all listed services. No separate health-state derivation step — `status` comes straight off the row. A per-project (N+1) query pattern is an incorrect implementation of this task and must be flagged in review; it would compound the unpaginated/unbounded-growth risk already accepted in Known Scope Boundaries.
  - [x] Create `apps/api/src/modules/monitoring/health-dashboard-routes.ts` exporting `healthDashboardRoutes(fastify)`: single `GET ''` route mirroring `dashboardRoutes` exactly (`minimumRole: 'viewer'`, `writeAuditEvent: false`, `rateLimit: LIST_RATE_LIMIT` imported from `monitoring/routes.ts` — export that constant if not already exported).
  - [x] Register in `apps/api/src/app.ts`: `await fastify.register(healthDashboardRoutes, { prefix: '/api/v1/health-dashboard' })`.

- [x] Task 4 — **Removed (realignment pass, ADR-6.3-08).** The original Task 4 wired `dashboard-stats.ts`'s `monitoredServiceHealth` stub to real data. Story 6.2's own Task 8 already does this against `service_endpoints`, as part of 6.2's own scope. This story does not touch `dashboard-stats.ts`.

- [x] Task 5 — Status page tokens + schema + migration (AC: 8, 10, 19, 20) [Source: `apps/api/src/modules/auth/recovery-tokens.ts`, Story 6.2's `packages/db/src/schema/service-endpoints.ts`, `packages/db/src/migrations/0025_project_invitations.sql`]
  - [x] Create `apps/api/src/modules/monitoring/status-page-tokens.ts` mirroring `recovery-tokens.ts` exactly (ADR-6.3-06).
  - [x] Create `packages/db/src/schema/status-pages.ts`, `status-page-services.ts` per AC 19's column list.
  - [x] Re-check `_journal.json` for the actual next-free migration number; hand-write `NNNN_status_pages.sql` following `0025_project_invitations.sql`'s exact shape (tables, FKs, indexes, `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` for both tables in this same file); hand-append the `_journal.json` entry.
  - [x] Export both tables from `packages/db/src/schema/index.ts`.
  - [x] Run `db#check-rls` locally.

- [x] Task 6 — Status page admin routes (AC: 8-9, 11, 15-18, 21) [Source: `apps/api/src/modules/projects/routes.ts` (`callerArchiveAuthorization` pattern), `apps/api/src/modules/monitoring/routes.ts` (`writeMonitoringAuditOrFailClosed`, `WRITE_RATE_LIMIT`/`LIST_RATE_LIMIT`)]
  - [x] Extend `apps/api/src/modules/monitoring/schema.ts` with request/response Zod schemas for enable/regenerate/update/**get-config** (local, request-body-only — mirror 6.1's convention of keeping request schemas module-local while response types needed by the web app live in `packages/shared`, see the codebase-convention note in Dev Notes below).
  - [x] Add `StatusPageSchema`/`PublicStatusPageServiceSchema`/**`StatusPageConfigSchema`** response types to `packages/shared/src/schemas/status-page.ts` (needed by the web app); export from `index.ts`. `StatusPageConfigSchema` backs AC 21 (realignment-review finding — closes the "no way to read current config" gap): `{ enabled, createdAt?, updatedAt?, services?: [{ serviceId, displayName, sortOrder }] }`.
  - [x] Extend `apps/api/src/modules/monitoring/service.ts` (or a new sibling `status-page-service.ts` if it keeps `service.ts` from growing unwieldy — developer's call, consistent with 6.1's own "kept as one file, logic stayed small enough" precedent) with the enable/regenerate/update/disable/**get-config** DB functions, each reusing `findProjectInOrg`/`rejectIfProjectArchived` and the ADR-6.3-07 ownership check. Enable's insert must catch the `status_pages_project_id_unique` constraint-violation error and map it to `409 status_page_already_enabled` (AC 8's concurrency example, realignment-review finding) rather than letting it surface as an unhandled `500`.
  - [x] Create `apps/api/src/modules/monitoring/status-page-routes.ts` exporting `statusPageRoutes(fastify)`: `GET/POST /:projectId/status-page`, `POST /:projectId/status-page/regenerate`, `PUT/DELETE /:projectId/status-page`, each `secureRoute`-registered with `minimumRole: 'member'` + in-handler ownership check. `requireMfa: true` on enable, regenerate, **and update (`PUT`)** — realignment-review finding: the original draft only gated enable/regenerate on MFA ("actions that create a new externally-shareable secret"), but `PUT` can materially change what an already-shared public page displays to external viewers without minting any new secret; gating it on MFA closes that inconsistency. `GET` (AC 21) and `DELETE` remain MFA-free (reads and risk-*reducing* actions don't need step-up). Rate limits: `GET` uses `LIST_RATE_LIMIT`; `POST`/`PUT`/`DELETE`/regenerate use `WRITE_RATE_LIMIT` (AC 10a).
  - [x] Register in `app.ts` inside the existing `eslint-disable sonarjs/no-duplicate-string` block (`app.ts:191-197`) alongside `monitoringRoutes`, prefix `/api/v1/projects`.
  - [x] Add `route-exemptions.ts` entries for all new routes (mirror the `payment_record.*` block exactly for the audited mutations; `GET`/AC 21 is a read, classify alongside the module's other list/detail reads; a distinct `auditOmissionReason` entry for the public GET, see AC 14).

- [x] Task 7 — Public status page route (AC: 12-14, 18) [Source: `apps/api/src/modules/invitations/token-routes.ts`, `apps/api/src/modules/invitations/lookup.ts`, ADR-6.3-09]
  - [x] Create `findStatusPageByTokenHash()` (service/monitoring module) using `getAdminDb()` for the single point-lookup by `tokenHash`, mirroring `findInvitationByTokenHash()`'s exact shape and documented rationale (ADR-6.3-09, step 1) — do not use `withOrg`/`getDb()` for this lookup, the org is not yet known.
  - [x] Create `apps/api/src/modules/monitoring/public-status-page-routes.ts` exporting `publicStatusPageRoutes(fastify)`: single `GET /:token` route, `requireAuth: false`, `writeAuditEvent: false`, `rateLimit: { max: 60, timeWindowMs: 60_000, key: 'GET /api/v1/status-pages/:token' }`. Handler: resolve the row via `findStatusPageByTokenHash`/`statusPageTokenMatches` (constant-time) on the admin connection, then re-scope with `withOrg(statusPage.orgId, tx => ...)` to join `status_page_services` ordered by `sortOrder` (ADR-6.3-09, step 2), returning only `displayName`/`status`/`lastCheckedAt`. Set `Cache-Control: no-store` on the response so an intermediate CDN/proxy never serves a stale enabled/service-list state after a regenerate or disable.
  - [x] Register in `app.ts`: `await fastify.register(publicStatusPageRoutes, { prefix: '/api/v1/status-pages' })` (standalone prefix, ADR-6.3-05 — not nested under `/api/v1/projects`).

- [x] Task 8 — Web: cross-project health dashboard page (AC: persona journey, mobile) [Source: `apps/web/src/routes/(app)/health/+page.svelte`, `apps/web/src/routes/(app)/dashboard/+page.server.ts`]
  - [x] Replace `apps/web/src/routes/(app)/health/+page.svelte`'s `PlaceholderSection` with the real dashboard: per-project cards, each service's status indicator (simple color-coded badge — no existing badge component to reuse; keep it minimal, consistent with existing Tailwind usage elsewhere in `apps/web/src/lib/components`), org-wide summary strip.
  - [x] Add `apps/web/src/routes/(app)/health/+page.server.ts` calling the new `getHealthDashboard` API wrapper.
  - [x] Create `apps/web/src/lib/api/health-dashboard.ts` (thin `apiFetch` wrapper, mirror `apps/web/src/lib/api/dashboard.ts` exactly).
  - [x] Remove/update the `health` entry in `apps/web/src/lib/components/shell/placeholder-copy.ts` only if it becomes actively misleading post-implementation (it will — the placeholder claims "arrives in Epic 6" while this story ships the real page); update copy or remove the `'health'` key from `PlaceholderSectionKey` if no longer referenced anywhere (grep first).
  - [x] Verify mobile rendering (375×812 viewport, per AC-E6d matrix) — no horizontal scroll, touch-friendly status indicators.

- [x] Task 9 — Web: status page admin UI (AC: persona journey, 21) [Source: `apps/web/src/routes/(app)/projects/[projectId]/members` as the nearest "project settings sub-page" structural precedent]
  - [x] Add a status-page management section under `apps/web/src/routes/(app)/projects/[projectId]/` (new route, e.g. `status-page/+page.svelte` + `+page.server.ts`), gated in the UI to the **same project-owner-or-org-owner condition as the backend (ADR-6.3-07)** — do not gate on project-owner alone. An org owner who isn't a project member/owner passes every backend authorization check (ADR-6.3-07) but would be unable to find this section if the UI only checked project role. The `+page.server.ts` load function must fetch the caller's project role (same call as the backend's `callerProjectRole`/equivalent, or a lightweight API that returns it) in addition to the already-available session `orgRole`, and show the section if `projectRole === 'owner' || orgRole === 'owner'`. Server-side enforcement remains authoritative regardless of this UI gate.
  - [x] The `+page.server.ts` load function calls the new `GET /api/v1/projects/:projectId/status-page` (AC 21, realignment-review finding) to pre-populate the section: if `enabled: false`, render the "enable" call-to-action; if `enabled: true`, render the existing service picker pre-filled with the returned `services[]` (by `serviceId`/`displayName`/`sortOrder`) instead of an empty form — the original draft had no way to load this state, which would have made every visit to an already-configured status page look identical to a never-configured one.
  - [x] Enable/regenerate flow: show plaintext token once with a copy-to-clipboard control and an explicit "cannot be shown again" warning; service picker + display-name inputs calling `PUT` (MFA-gated, AC 15, realigned).
  - [x] Create `apps/web/src/lib/api/status-page.ts` (admin-side wrapper: **get-config**/enable/regenerate/update/disable + local `UpdateStatusPageRequest` TS type, mirroring `apps/web/src/lib/api/projects.ts`'s convention of plain-TS request types + shared-package response types).

- [x] Task 10 — Web: public status page route (AC: 12, mobile) [Source: `apps/web/src/routes/(auth)/invitations/accept/+page.svelte` as the nearest token-based-public-page precedent; ADR-6.3-05]
  - [x] Create `apps/web/src/routes/status/[token]/+page.server.ts` (standalone, top-level — sibling to `(app)`/`(auth)`, NOT inside either group, so it is exempt from `isProtectedAppPath`/`isAuthPath` redirects in `hooks.server.ts`) that server-side-fetches `GET /api/v1/status-pages/:token` and renders a 404-equivalent page on failure rather than throwing an unhandled error.
  - [x] Create `apps/web/src/routes/status/[token]/+page.svelte`: minimal, unauthenticated-safe layout (does not use the authenticated app shell/nav — no session data available or needed), renders `services[]` with status indicators, explicit "not found" state for invalid/disabled tokens.
  - [x] Verify mobile rendering (375×812), no horizontal scroll.

- [x] Task 11 — Tests (AC: all)
  - [x] `health-dashboard-service.test.ts` / `health-dashboard-routes.test.ts`: cross-project aggregation over `service_endpoints`, empty state, archived-project exclusion, a project with only `payment_records` (no `service_endpoints`) correctly excluded (realigned — was "url-null exclusion" against `payment_records` in the original draft), never-checked endpoint reads `healthy`/`lastCheckedAt: null` verbatim (AC 2, realigned), RLS cross-org isolation, rate limit.
  - [x] ~~`health-status.test.ts`~~ — removed (realignment pass, Task 2 removed; no derivation function left to unit test).
  - [x] ~~`dashboard-stats.test.ts`~~ — removed from this story's scope (realignment pass, Task 4 removed; 6.2's own test suite covers `monitoredServiceHealth`).
  - [x] `status-page-routes.test.ts`: enable (happy/403/404/410/409-already-enabled, **plus the concurrent-double-`POST` race mapping to `409` not `500`, realignment-review finding**), regenerate (happy/404/concurrency note documented not necessarily test-asserted given its inherent nature — AC 11, but the two-audit-rows-on-race behavior in AC 11's audit-trail example IS asserted), update (happy/empty/validation/**whitespace-only-displayName-rejected**/cross-project-service-reference/duplicate/cap/injection round-trip per AC 15's escaping example — `serviceId` validation now checked against `service_endpoints`, not `payment_records`; **MFA-required, realignment-review finding**; audit payload includes previous-state snapshot, AC 17 realigned), disable (happy/404-not-idempotent), **get-config (AC 21: happy path enabled-with-services, happy path not-yet-enabled returns `{enabled:false}` not `404`, 403 for non-owner, 404/410 cross-org/archived)**, ownership authorization (project owner passes, org owner passes, project member/viewer/admin-non-owner fails), MFA-required on enable/regenerate/**update**, audit event per mutation (fail-closed test per AC 17), RLS cross-org isolation, mutation rate limit at the concrete `WRITE_RATE_LIMIT` value (AC 10a), get-config rate limit at `LIST_RATE_LIMIT`.
  - [x] `public-status-page-routes.test.ts`: happy path, unknown token 404, disabled-token 404, rate limit 429, no-services-configured empty array, response never contains `serviceId`/internal name/url/projectId/orgId (explicit negative assertion — grep the serialized response for forbidden fields, not just check for presence of allowed ones), the RLS-coverage-exception test required by ADR-6.3-09 step 4 (admin-connection lookup resolves correctly with no org context set), `displayName` HTML-injection round-trip (AC 15's injection example). (The original draft's "service missing from the health-status map renders as `down`" test is removed — realigned: `service_id`'s `ON DELETE CASCADE` to `service_endpoints.id` means a deleted service's `status_page_services` row is gone too, so there is no "missing map entry" case to handle — see Known Scope Boundaries.)
  - [x] Component/Playwright test for Task 10: a `displayName` containing `<`, `>`, `&` renders as a literal text node in the DOM, not an executed element (AC 15 injection example).
  - [x] Run `route-audit.test.ts` explicitly (cheap, easy to omit outside full `make ci`, per 6.1's own reminder) — requires the new `route-exemptions.ts` entries from Task 6/7.

- [x] Task 12 — Wiring verification (AC: all)
  - [x] `pnpm generate-spec && pnpm typecheck` (root, all packages, per 6.1's precedent that this is a no-op for hand-authored route files but still confirms the web app's generated types compile).
  - [x] `db#check-rls` passes for `status_pages`/`status_page_services`.
  - [x] Manual mobile-viewport check (Chrome/Safari emulation, 375×812) of both `/health` and `/status/:token`.

## Dev Notes

- **Sequencing is the single biggest risk in this story** — see ADR-6.3-01. The contract question (ADR-6.3-02) is resolved as of the realignment pass; the remaining risk is purely "does 6.2's code actually exist and match this story's assumed `service_endpoints` column names," checked in Task 0.
- **Codebase convention for request vs. response schema location** (clarifies Task 5/6): response types the web app must consume (e.g. `HealthDashboard`, `StatusPage`) live in `packages/shared/src/schemas/*.ts` as Zod schemas + inferred types (mirrors `org-dashboard.ts`/`dashboard.ts`, consumed by both backend response validation and `apps/web/src/lib/api/*.ts` imports). Request-body validation schemas stay module-local in `apps/api/src/modules/monitoring/schema.ts` (mirrors 6.1's `CreatePaymentRecordBodySchema` etc.); the web app defines its own plain TS request types locally in its `lib/api/*.ts` wrappers (mirrors `apps/web/src/lib/api/projects.ts`'s `CreateProjectRequest`) rather than importing a shared request schema. Do not put request schemas in `packages/shared` — that is not this codebase's pattern despite `architecture.md`'s general "import from packages/shared" guidance; 6.1 already established the module-local exception for request bodies.
- **`callerProjectRole`/`callerArchiveAuthorization`-equivalent reuse (ADR-6.3-07):** check whether `apps/api/src/modules/projects/routes.ts`'s `callerProjectRole()` (private helper, ~line 55-66) is already exported; if not, either export it or replicate the identical `getProjectMembershipRole()` call — do not diverge on the query shape, since a subtly different project-role lookup here vs. archival would be a correctness bug (two different "who is this project's owner" answers in the same codebase).
- **Do not build a parallel health-check mechanism.** If Story 6.2 is behind schedule and tempting to route around, do not. This story has zero opinion on how checks happen — it only reads the `status`/`lastCheckedAt` columns Story 6.2's own worker already computes and persists on `service_endpoints`.
- **Public status page pages must never go through `(app)/+layout.server.ts`'s auth guard** (`throw redirect(303, '/login')` on missing `locals.user`) — this is why the SvelteKit route lives at top-level `apps/web/src/routes/status/[token]/`, not nested under `(app)`. Double-check `apps/web/src/lib/server/auth-guard.ts`'s `isProtectedAppPath()` list does **not** include `/status` — it currently lists `/dashboard`, `/projects`, `/credentials`, `/alerts`, `/health`, `/settings` only, so `/status` is safe by omission, but re-verify this hasn't changed by the time this story is implemented.
- **`hooks.server.ts` still runs for the public status page request** (it's global) — it will still call `/api/v1/auth/me` once per request even though the page needs no auth. This is pre-existing behavior for every unauthenticated route in the app (e.g. `/register`) and is not something this story needs to fix; just be aware it's one extra backend call per page view, separate from the FR77 IP rate limit which applies only to the actual `/api/v1/status-pages/:token` call.
- **Vault-sealed edge case:** `shouldCheckVaultReadiness()` in `hooks.server.ts` does not redirect `/status/:token` to `/vault` when the vault is sealed (it's not in that function's checked-path list). If the vault is sealed, the backend call will simply fail (DB likely inaccessible or returns an error) — the SvelteKit page's `+page.server.ts` must catch this and render the same generic "status temporarily unavailable" state used for a 404/network error, not crash with an unhandled exception. Not a new rate-limit or security concern, just a robustness requirement for Task 10.
- **Concurrency note beyond AC 11:** the `PUT .../status-page` full-replace (delete-all-then-insert) must happen inside one transaction so a concurrent public `GET` never observes a transient "zero services" state mid-update — standard transactional isolation, no special handling needed beyond "do it in one `tx`", but call this out in code review since it's easy to accidentally split into two round trips.

### Project Structure Notes

- Extends existing module `apps/api/src/modules/monitoring/` (no new top-level module — matches architecture.md's mapping row, same module as 6.1/6.2).
- New backend files: `health-dashboard-service.ts`, `health-dashboard-routes.ts`, `status-page-tokens.ts`, `status-page-routes.ts`, `public-status-page-routes.ts`, plus extensions to `schema.ts`/`service.ts`. (Realignment pass: `health-status.ts` from the original draft is removed — no separate health-state derivation function is needed; see Task 2.)
- Does **not** modify `apps/api/src/modules/projects/dashboard-stats.ts` (realignment pass — that wiring is Story 6.2's scope, not this story's; see Task 4).
- New schema files: `packages/db/src/schema/status-pages.ts`, `status-page-services.ts`.
- New shared schemas: `packages/shared/src/schemas/health-dashboard.ts`, `status-page.ts`.
- New web routes: `apps/web/src/routes/(app)/health/+page.server.ts` (replaces placeholder-only page), `apps/web/src/routes/(app)/projects/[projectId]/status-page/` (new), `apps/web/src/routes/status/[token]/` (new, **top-level**, not under any existing route group — this is the one deliberate exception to the `(app)`/`(auth)` grouping convention, required by the public/unauthenticated nature of the page, ADR-6.3-05).
- New web API wrappers: `apps/web/src/lib/api/health-dashboard.ts`, `status-page.ts`.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` lines 1724-1748] — Story 6.3 draft AC, endpoint shapes, FR76/77/72 mapping, AC-E6d mobile matrix.
- [Source: `_bmad-output/implementation-artifacts/6-2-http-endpoint-monitoring-and-availability-alerts.md`] — Story 6.2's actual hardened story file (ADR-6.2-01/03/09), the source of truth this story's realignment pass reconciled against, superseding the epics.md draft AC previously cited here for this purpose.
- [Source: `_bmad-output/planning-artifacts/prd.md` lines 902-903, 945] — FR76, FR77, FR72 canonical text.
- [Source: `_bmad-output/planning-artifacts/architecture.md` lines 884-901, 903-930] — Requirements-to-Structure Mapping (`modules/monitoring/`), canonical schema entity names.
- [Source: `_bmad-output/implementation-artifacts/6-1-service-certificate-and-domain-record-management.md`] — prior story in this epic; ADR-6.1-01/02/03 precedent this story's own ADRs extend; `payment_records`/`cert_records`/`domain_records` schema (no longer this story's data source — see ADR-6.3-02/04, realigned); `dashboard-stats.ts:87` stub, now resolved by Story 6.2 rather than this story (ADR-6.3-08).
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
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`] — G3 Dashboard Truth (satisfied by Story 6.2's own AC 15/Task 8, not this story — see ADR-6.3-08, removed), G4 persona journey.

## Dev Agent Record

### Agent Model Used

Claude (claude-sonnet-5), via the `bmad-dev-story` workflow.

### Debug Log References

- Two Postgres-level deadlocks were hit and resolved while writing integration tests, not in
  production code: (1) `health-dashboard-service.test.ts`'s archived-project test originally
  updated `projects.archivedAt` through the same still-open `withTestOrg` transaction used for the
  subsequent `deleteTestUser` call — Postgres's `ON DELETE SET NULL` cascade check on the
  referencing row had to wait on that open transaction, producing a real deadlock (confirmed via
  `pg_blocking_pids`). Fixed by committing the archive-update in its own `withOrg` call before the
  test's `finally` block runs. (2) `status-page-service.test.ts` had the identical pattern via
  `enableStatusPage`'s insert (`createdBy: userId`); fixed by moving `createTestUser`/
  `deleteTestUser` outside the `withTestOrg` transaction entirely.
- `enableStatusPage`'s original implementation caught a Postgres unique-violation error via
  `error.cause.code === '23505'` (mirroring `auth/service.ts`'s `isUniqueViolation` pattern) and
  mapped it to `StatusPageAlreadyEnabledError`. In testing, the raw `PostgresError` was still
  observed propagating out despite the catch block correctly identifying and converting it
  (confirmed via targeted instrumentation) — root cause not fully isolated, but consistent with a
  known class of drizzle-orm/postgres-js double-rejection quirks on constraint-violating
  `INSERT ... RETURNING`. Resolved by switching to `.onConflictDoNothing({ target:
  statusPages.projectId }).returning()` and treating a missing returned row as the conflict signal
  — avoids raising a real Postgres-level error at all, is the same pattern already used elsewhere
  in this codebase (auth/service.ts, mfa-login.ts, invitations/token-routes.ts) for this exact
  race shape, and is a cleaner implementation regardless of the underlying driver quirk.
- Manual end-to-end verification (Task 12) was done against locally-run `api`/`web` dev servers
  (not via the `Claude_Preview` tool, which resolves `.claude/launch.json` against the main repo
  root rather than this worktree's path — a tooling/worktree mismatch, not a project issue).
  Registered a user, enrolled MFA via direct DB update, created a project, registered two
  service-endpoints (`api.github.com`, `httpbin.org` — real resolvable hosts, since the SSRF guard
  performs a live DNS lookup), enabled the status page, and configured both services. Confirmed in
  a real browser: `/health` renders the live summary strip + per-project service list with correct
  status badges; `/projects/:id/status-page` pre-populates the enabled state and configured
  services (AC 21); `/status/:token` renders the public view with no app-shell chrome and correct
  status badges. The browser automation tool's `resize_window` call did not change the actual
  screenshot viewport in this environment (consistently reported 1456×814 regardless of the
  requested 375×812), so a genuine narrow-viewport screenshot could not be captured; mobile-safety
  was instead verified by code review — both new pages reuse the exact same `sm:`-breakpoint
  Tailwind conventions (`grid sm:grid-cols-*`, `flex-wrap`, `min-w-0`/`truncate`) already used
  throughout the rest of this app's pages (dashboard, credentials, members), which are the
  established mobile-safe idiom in this codebase.

### Completion Notes List

- Task 0: confirmed Story 6.2 is `done` in `sprint-status.yaml` and that
  `packages/db/src/schema/service-endpoints.ts` matches ADR-6.3-02's assumed column names exactly
  (`id`, `projectId`, `name`, `status`, `lastCheckedAt`, no exported status union type) before
  writing any dependent code.
- Task 1: added the four `STATUS_PAGE_*` audit events to both `AuditEvent` and `AuditEventType`
  (packages/shared), and `STATUS_PAGE_TOKEN_HMAC_SECRET` to `env.ts` mirroring
  `RECOVERY_TOKEN_HMAC_SECRET`'s validation exactly (required-in-prod, must differ from every
  other secret, must not match the placeholder pattern, dev fallback). The uniqueness check is
  expressed as an array-membership test rather than an OR-chain to stay under the repo's
  cyclomatic-complexity eslint threshold at the 8th dedicated secret.
- Task 3: `getHealthDashboardData` queries non-archived projects, then exactly one batched
  `service_endpoints` query across all their ids (verified via a select-call-counting proxy in the
  service test — 2 selects total, never N+1), groups in memory, and reads `status`/`lastCheckedAt`
  verbatim per ADR-6.3-02/03. `GET /api/v1/health-dashboard` mirrors `dashboardRoutes` exactly
  (`minimumRole: 'viewer'`, `writeAuditEvent: false`, reuses the module's existing
  `LIST_RATE_LIMIT` constant, now exported from `monitoring/routes.ts`).
- Task 5: `status-page-tokens.ts` is a thin wrapper over the shared `opaque-token.ts` primitives,
  identical in shape to `recovery-tokens.ts`. `status_pages`/`status_page_services` hand-authored
  migration (`0034_status_pages.sql`) follows `0031_service_endpoints_monitoring.sql`'s exact
  shape (RLS policy + `set_updated_at` trigger per table); manually verified via `\d` against the
  running Postgres instance and `make check-rls` passes.
- Task 6: `status-page-service.ts` implements enable (via `onConflictDoNothing`, not exception
  catching — see Debug Log), regenerate, get-config, update (delete-all-then-insert-new in the
  caller's transaction, with a previous-state snapshot for the audit payload), and disable (with a
  configured-service snapshot for its own audit payload). `status-page-routes.ts` registers
  GET/POST/PUT/DELETE + POST regenerate, each with the ADR-6.3-07 project-owner-or-org-owner
  in-handler check on top of an org-level `minimumRole: 'member'` floor, `requireMfa: true` on
  enable/regenerate/update (not get-config/disable), and `WRITE_RATE_LIMIT`/`LIST_RATE_LIMIT` as
  specified in AC 10a/21. `callerProjectRole` was exported from `projects/routes.ts` for reuse
  rather than re-implementing the same query.
- Task 7: `findStatusPageByTokenHash` mirrors `findInvitationByTokenHash`'s admin-connection
  point-lookup exactly (ADR-6.3-09); `public-status-page-routes.ts` re-scopes via `withOrg` once
  the org is resolved, sets `Cache-Control: no-store`, and never audits the read.
- Tasks 8-10: `/health` replaces the placeholder with the real cross-project dashboard (summary
  strip + per-project service cards); the `health` key was removed from
  `placeholder-copy.ts`/`PlaceholderSectionKey` since no route references it anymore (test updated
  accordingly). The status-page admin UI at
  `/projects/:projectId/status-page` gates on `projectRole === 'owner' || orgRole === 'owner'`
  (fetched via the existing `listProjectMembers` call, matching the members page's own pattern),
  pre-populates from `GET .../status-page` (AC 21), and shows the plaintext token only
  transiently in local component state right after enable/regenerate (never persisted, never
  re-fetchable). Added small nav links from the credentials page to Members and Public status
  page, since neither was reachable from anywhere in the UI before this story. The public page at
  `/status/:token` is a genuinely top-level route (sibling to `(app)`/`(auth)`), so it only
  inherits the minimal root layout with no auth-shell chrome, confirmed both by the route
  structure and by manual browser verification.
- Task 11: comprehensive test coverage was added across 7 new test files (health-dashboard
  service+routes, status-page tokens+service+routes, public-status-page routes, plus a Svelte
  component test for the injection-safety requirement on Task 10). One test scenario from the
  story's literal list was intentionally narrowed: the true two-concurrent-in-flight-requests race
  for AC 8/AC 11 is proven at the service layer (`onConflictDoNothing` returns no row on conflict,
  asserted directly) rather than via genuinely simultaneous HTTP requests, which vitest/fastify's
  synchronous-per-connection `inject()` cannot easily produce; the route-level test instead does a
  sequential second `POST` and asserts the same `409` mapping, which exercises the identical code
  path the real race would hit.
- Task 12: `pnpm generate-spec && pnpm typecheck` (root) both pass; `make check-rls` passes for
  the two new tables; manual mobile-viewport verification is described above (Debug Log) with the
  browser-tooling limitation noted honestly rather than skipped silently.
- Full regression run: `apps/api` (122 test files / 1173 tests), `packages/db` (23/93),
  `packages/shared` (15/122), `apps/web` (28/155) — all green after this story's changes.

### File List

**Backend (`apps/api`):**
- `apps/api/src/config/env.ts` (modified — `STATUS_PAGE_TOKEN_HMAC_SECRET`)
- `apps/api/src/config/env.test.ts` (modified)
- `apps/api/src/app.ts` (modified — registers health-dashboard/status-page/public-status-page routes)
- `apps/api/src/lib/route-exemptions.ts` (modified — new route classifications)
- `apps/api/src/modules/projects/routes.ts` (modified — exported `callerProjectRole`)
- `apps/api/src/modules/monitoring/routes.ts` (modified — exported `LIST_RATE_LIMIT`/`WRITE_RATE_LIMIT`/`writeMonitoringAuditOrFailClosed`)
- `apps/api/src/modules/monitoring/schema.ts` (modified — status-page request schemas)
- `apps/api/src/modules/monitoring/health-dashboard-service.ts` (new)
- `apps/api/src/modules/monitoring/health-dashboard-routes.ts` (new)
- `apps/api/src/modules/monitoring/status-page-tokens.ts` (new)
- `apps/api/src/modules/monitoring/status-page-service.ts` (new)
- `apps/api/src/modules/monitoring/status-page-routes.ts` (new)
- `apps/api/src/modules/monitoring/public-status-page-routes.ts` (new)

**Schema/migration (`packages/db`):**
- `packages/db/src/schema/status-pages.ts` (new)
- `packages/db/src/schema/status-page-services.ts` (new)
- `packages/db/src/schema/index.ts` (modified — exports)
- `packages/db/src/migrations/0034_status_pages.sql` (new)
- `packages/db/src/migrations/meta/_journal.json` (modified — appended entry)

**Shared (`packages/shared`):**
- `packages/shared/src/constants/audit-events.ts` (modified — 4 new events)
- `packages/shared/src/constants/audit-events.test.ts` (modified)
- `packages/shared/src/schemas/health-dashboard.ts` (new)
- `packages/shared/src/schemas/status-page.ts` (new)
- `packages/shared/src/index.ts` (modified — exports)

**Web (`apps/web`):**
- `apps/web/src/lib/api/health-dashboard.ts` (new)
- `apps/web/src/lib/api/status-page.ts` (new)
- `apps/web/src/lib/api/service-endpoints.ts` (new)
- `apps/web/src/lib/api/public-status-page.ts` (new)
- `apps/web/src/routes/(app)/health/+page.server.ts` (new)
- `apps/web/src/routes/(app)/health/+page.svelte` (modified — replaces placeholder)
- `apps/web/src/lib/components/shell/placeholder-copy.ts` (modified — removed `health` key)
- `apps/web/src/routes/placeholder-sections.test.ts` (modified)
- `apps/web/src/routes/(app)/projects/[projectId]/status-page/+page.server.ts` (new)
- `apps/web/src/routes/(app)/projects/[projectId]/status-page/+page.svelte` (new)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/+page.svelte` (modified — nav links to Members/Public status page)
- `apps/web/src/routes/status/[token]/+page.server.ts` (new)
- `apps/web/src/routes/status/[token]/+page.svelte` (new)

**Tests (new, in addition to the modified test files listed above):**
- `apps/api/src/modules/monitoring/health-dashboard-service.test.ts`
- `apps/api/src/modules/monitoring/health-dashboard-routes.test.ts`
- `apps/api/src/modules/monitoring/status-page-tokens.test.ts`
- `apps/api/src/modules/monitoring/status-page-service.test.ts`
- `apps/api/src/modules/monitoring/status-page-routes.test.ts`
- `apps/api/src/modules/monitoring/public-status-page-routes.test.ts`
- `apps/web/src/routes/status/[token]/page.test.ts`
