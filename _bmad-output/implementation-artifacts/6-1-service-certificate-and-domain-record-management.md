# Story 6.1: Service, Certificate & Domain Record Management

Status: done

<!-- Ultimate context engine analysis completed 2026-07-03 — comprehensive developer guide for the FIRST story in Epic 6 (Operational Monitoring & Status). This story creates the `payment_records`, `cert_records`, and `domain_records` tables plus their CRUD API and a daily proactive-expiry-alert job. It deliberately does NOT create `service_endpoints` (HTTP uptime monitoring) — that table and its health-check worker belong to Story 6.2. Read "Architecture Conflict Resolution" below before touching the schema: epics.md's draft AC text and architecture.md's canonical schema disagree on table shape, and this story resolves that disagreement in favor of architecture.md with documented rationale. -->

## Story

As a developer tracking my operational assets,
I want to register services, SSL/TLS certificates, and domains with expiry dates and receive proactive alerts before they expire,
so that nothing silently lapses and causes an outage.

*Covers: FR24, FR25, FR26, FR28, FR29.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-6.1-Service-Certificate--Domain-Record-Management`]

---

## Architecture Conflict Resolution (Read Before Coding)

`epics.md` (Story 6.1 draft AC) and `architecture.md` (§"Canonical Schema Entity Names", the later, adversarially-reviewed authority) disagree on three points. Resolve all three exactly as follows — do not re-derive from epics.md alone:

**ADR-6.1-01: No unified `monitored_assets` table.** `epics.md`'s AC prose describes a single polymorphic `monitored_assets` table (`assetType: "service"|"certificate"|"domain"`) with generic `PATCH/DELETE /api/v1/projects/:projectId/assets/:assetId` routes. `architecture.md`'s "Canonical Schema Entity Names (complete)" table — the document that survived 5 rounds of adversarial elicitation and is declared complete — instead lists **three separate physical tables**: `payment_records`, `cert_records`, `domain_records` (each with its own `alert_threshold_days` column), plus a fourth, unrelated table `service_endpoints` scoped to Story 6.2's HTTP uptime monitoring (FR27), not this story.
   - **Resolution:** build three separate tables, three separate route families, no shared `assetId` space. `service_endpoints` is out of scope for 6.1 entirely — do not create it, do not reference it. Story 6.2 owns it.
   - **Route shape:** `POST /api/v1/projects/:projectId/services`, `.../certificates`, `.../domains` for creation (matches epics.md's literal paths — keep these). For update/delete, use **per-resource routes**, not the generic `/assets/:assetId` epics.md implies: `PATCH|DELETE /api/v1/projects/:projectId/services/:serviceId`, `.../certificates/:certificateId`, `.../domains/:domainId`. This is the only shape that's coherent with three separate tables/PK spaces.
   - **Naming:** epics.md calls the FR24 endpoint "services" and its table entry says `assetType: "service"`; architecture.md's matching row (the one with `alert_threshold_days`, matching FR24's expiry-alerting need) is named `payment_records` ("hosting providers, payment subscriptions, SaaS tools" — FR24's literal description). Use **`payment_records`** as the physical table name (architecture.md is canonical for schema naming) but keep the **`/services` route path** (epics.md is canonical for the API surface — it's already referenced by existing frontend placeholder copy, see point 3).

**ADR-6.1-02: `alertLeadDays` is an array, not `architecture.md`'s single `alert_threshold_days integer`.** AC-E6b (epics.md) requires certificates to alert at **both** 30 and 7 days out — a single integer column cannot represent that. `architecture.md`'s single-column entries predate AC-E6b's dual-threshold requirement and are an omission, not a deliberate constraint (nothing in architecture.md's rationale column addresses multi-threshold alerting).
   - **Resolution:** each table gets `alert_lead_days` as a `jsonb` column typed `number[]` (same pattern as `credentials.tags`, [credentials.ts](../../packages/db/src/schema/credentials.ts) — `jsonb('alert_lead_days').notNull().default(sql\`'[…]'::jsonb\`).$type<number[]>()`), not a Drizzle/PG native integer array (no other table in the schema uses a native PG array — stay consistent).
   - Defaults per AC-E6b and the epics.md AC body: `payment_records.alertLeadDays` default `[14, 3]`; `cert_records.alertLeadDays` default `[30, 7]`; `domain_records.alertLeadDays` default `[30]`.

**ADR-6.1-03: Frontend placeholder copy already exists and must stay honest.** `apps/web/src/lib/components/shell/placeholder-copy.ts:19` and `apps/web/src/lib/components/dashboard/dashboard-copy.ts:10-19` already say "Service and endpoint monitoring arrives in Epic 6" / "Add first service — available in Epic 6" / "No certificate or domain records added yet." These were written in Story 2.0/2.1 as **honest placeholders**, anticipating this story. **This story is API-only — do not build any web UI.** The placeholder copy remains accurate after this story ships (the API exists, the UI still doesn't) and must NOT be changed to imply a working UI exists. See Product Surface Contract below.

---

## Known Scope Boundary: Credential Expiry Alerts Are Explicitly Out of Scope

`packages/shared/src/constants/notification-types.ts` already contains a `'credential.expiry'` alert type with no publisher (`deferred-work.md`: "Credential expiry notifications — Columns exist (2.2/2.4); no delivery — Epic 3+ — Backend ready; alerting jobs not wired"). `architecture.md`'s Requirements-to-Structure table also lists a `workers/credential-expiry-alert.ts` under the Operational Monitoring module, which could be read as "this belongs to Epic 6."

**Decision:** this story does **not** implement credential expiry alerting. `credentials` has no `alertLeadDays` column and epics.md's Story 6.1 AC text — the literal, testable contract for this story — enumerates only `POST .../services`, `.../certificates`, `.../domains`; it never mentions a credentials endpoint or a `credentials` schema change. Adding it here would be scope creep requiring an uncalled-for migration. Leave `'credential.expiry'` in the registry untouched (already there, unused) — a future story can wire `workers/credential-expiry-alert.ts` without needing a registry change. Do not attempt to "helpfully" close this gap in 6.1.

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no (API-only; existing placeholder copy already communicates "coming in Epic 6" honestly) |
| **Linked UI story** (if API-only) | `TBD` — **blocking note:** no story in `epics.md` Epic 6 currently has explicit ACs for a services/certificates/domains management UI. Story 6.3's AC only covers the cross-project health dashboard and public status page UI, not asset CRUD forms. This is a genuine Product Surface Contract gap (same shape as the Epic 2 retro finding that produced G1) — flag it at Epic 6 sprint-planning/retrospective time so a UI story gets added before `epic-6: done`. Do not attempt to fill this gap inside 6.1. |
| **Honest placeholder AC** (if UI deferred) | AC-E2f-equivalent: existing copy in `placeholder-copy.ts`/`dashboard-copy.ts` ("available in Epic 6") remains truthful after this story — verify it wasn't accidentally changed to claim a working UI (see AC 8 below). |
| **Persona journey** | See below |

### Persona journey stub

API-only story, no UI change. Evaluator/persona impact: a developer (Riley-admin or any project member with `member`+ role) integrates against the new REST endpoints directly (Swagger/OpenAPI spec, generated via `generate-spec`) to register a service, certificate, or domain record and receives email/Slack/inbox alerts as configured expiry thresholds approach. No SvelteKit route changes. The existing dashboard `add_service` suggested action and placeholder copy remain pointing at "coming soon" until the (not-yet-created) UI story lands.

## Acceptance Criteria

1. **Given** a project exists and the caller has `member`+ role on it, **when** they call `POST /api/v1/projects/:projectId/services` with `{ name, url?, renewalDate?, alertLeadDays?: number[] }`, **then** a `payment_records` row is created with `orgId`, `projectId`, `name`, `url` (nullable), `renewalDate` (nullable), `alertLeadDays` (jsonb array, default `[14, 3]` if omitted), `notifiedLeadDays: []`, `createdBy`, `createdAt`, `updatedAt`, and the response is `201` with the created record.
   - *Example (happy path):* `POST /api/v1/projects/proj-1/services { "name": "AWS Hosting", "url": "https://console.aws.amazon.com/billing", "renewalDate": "2026-09-01T00:00:00Z" }` → `201 { data: { id, name: "AWS Hosting", alertLeadDays: [14, 3], renewalDate: "2026-09-01T00:00:00Z", … } }`.
   - *Example (edge — omitted optional fields):* `POST /api/v1/projects/proj-1/services { "name": "GitHub SaaS seat" }` → `201`, `url: null`, `renewalDate: null`, `alertLeadDays: [14, 3]`. A null `renewalDate` means the asset is tracked but not yet enrolled in expiry alerting (the daily job skips rows with `renewalDate IS NULL`).
   - *Example (failure — validation):* `name` missing or empty, or `alertLeadDays` contains a non-positive integer, or contains more than 10 entries → `422` with field-level Zod error (mirror `validationError()` shape used by `credentials/routes.ts`).
   - *Example (failure — cross-org/nonexistent project):* `projectId` belongs to another org or doesn't exist → `404 PROJECT_NOT_FOUND` (never `403` — matches `credentials` convention of not leaking existence across orgs).
   - *Example (failure — archived project):* project is archived → `410` via `rejectIfProjectArchived` (same guard `credentials/routes.ts` uses at [routes.ts:299](../../apps/api/src/modules/credentials/routes.ts)).

2. **Given** the same preconditions, **when** the caller calls `POST /api/v1/projects/:projectId/certificates` with `{ domain, expiresAt, alertLeadDays?: number[] }`, **then** a `cert_records` row is created with `assetType`-equivalent fields, `alertLeadDays` default `[30, 7]` (AC-E6b) if omitted, `notifiedLeadDays: []`.
   - *Example (happy path):* `{ "domain": "api.example.com", "expiresAt": "2026-08-15T00:00:00Z" }` → `201`, `alertLeadDays: [30, 7]`.
   - *Example (failure):* `domain` empty or exceeds 253 chars (RFC 1035 max), or `expiresAt` unparsable → `422`.

3. **Given** the same preconditions, **when** the caller calls `POST /api/v1/projects/:projectId/domains` with `{ domainName, renewalDate, alertLeadDays?: number[] }`, **then** a `domain_records` row is created, `alertLeadDays` default `[30]` if omitted, `notifiedLeadDays: []`.
   - *Example (happy path):* `{ "domainName": "example.com", "renewalDate": "2027-01-01T00:00:00Z" }` → `201`, `alertLeadDays: [30]`.
   - *Example (failure):* duplicate `domainName` within the same project is **allowed** (no uniqueness constraint specified by epics.md/architecture.md — a project may legitimately track the same domain under two records, e.g. registrar renewal vs. DNS provider renewal); do not add a uniqueness check not called for by the AC.

4. **And** assets with a non-null `renewalDate` (services, domains) or `expiresAt` (certificates) are automatically enrolled in monitoring at creation time — no separate "enable alerting" step or config flag (UX-DR9). This is satisfied by construction: the daily job (AC 5) scans all rows with a non-null date column, unconditionally.

5. **And** a pg-boss job runs daily at `08:00 UTC` (cron `0 8 * * *`), one worker per asset type — `payment-expiry-alert`, `cert-expiry-alert`, `domain-expiry-alert` (registered as pg-boss job names `payment:expiry-alert`, `cert:expiry-alert`, `domain:expiry-alert` per the `{domain}:{action}` convention, [Source: architecture.md `health:check` example cited in `3-1-*.md:64`]) — for each row with a non-null expiry/renewal date:
   - Compute `daysRemaining = ceil((expiryDate − now) / 86400000)`.
   - For each value `v` in `alertLeadDays` **not already present** in `notifiedLeadDays`: if `|daysRemaining − v| ≤ 1`, dispatch a notification via `dispatchOrgAdminNotification` ([dispatcher.ts](../../apps/api/src/notifications/dispatcher.ts)) with `templateId: 'payment.expiry' | 'certificate.expiry' | 'domain.expiry'` (new entries — see Task 1) and severity `daysRemaining ≤ 3 → 'critical'`, `daysRemaining ≤ 7 → 'warning'`, else `'info'` (only reachable when `daysRemaining ≤ 30`, since nothing alerts past 30 days by default), then **append `v` to `notifiedLeadDays`** in the same transaction so the same threshold never re-fires.
   - **Idempotency requirement (not explicit in epics.md, resolved here to prevent duplicate alerts):** the ±1 day tolerance means a given threshold value can match on up to 3 consecutive daily runs (e.g. `daysRemaining` 8, 7, 6 all match `v=7`). `notifiedLeadDays` is the guard against re-firing on days 2 and 3. `notifiedLeadDays` **resets to `[]`** whenever `renewalDate`/`expiresAt` is changed via PATCH (AC 6) — a new expiry date starts a new alert cycle.
   - *Example:* a cert with `expiresAt` 7 days out and `alertLeadDays: [30, 7]`, `notifiedLeadDays: []` → job fires `certificate.expiry` at `warning` severity, then sets `notifiedLeadDays: [7]`. Next day (`daysRemaining` = 6, still within ±1 of `7`) → `7` is already in `notifiedLeadDays`, no second alert. When `daysRemaining` later approaches 3 or fewer and no `v` at exactly 3 is configured (only 30/7 here), no further alert fires — matches AC-E6b's literal thresholds, not an implicit "always alert at ≤3."
   - *Example (edge — renewalDate is null):* row skipped entirely, not an error.
   - **Edge case (pre-mortem finding — already-overdue asset):** `alertLeadDays` values are all positive, so the `|daysRemaining − v| ≤ 1` match window never catches an asset whose expiry date has already passed by more than 1 day (e.g. someone registers a cert that expired 3 weeks ago, or an alert was missed due to downtime). Without a special case, such an asset would **never** alert. Rule: additionally, if `daysRemaining ≤ 0` and `0` is not already present in `notifiedLeadDays`, fire one `critical`-severity alert (reuse the same `templateId`, payload gets `overdue: true`) and append `0` to `notifiedLeadDays`. This fires once per overdue asset, not daily, via the same dedupe mechanism as the positive-threshold case.
   - **Failure isolation (failure-mode finding):** each worker processes rows across all orgs in one job run; wrap the per-row match+dispatch+`notifiedLeadDays`-update in a try/catch **per row** so one row's failure (e.g. a malformed payload, a transient DB error) doesn't abort the whole batch and silently skip every other org's alerts that day. Log failures via the existing `operationalLog`/`serializeLogError` pattern (see `main.ts` imports) and continue to the next row. The notification-queue insert and the `notifiedLeadDays` update for a given row must commit in the **same transaction** — an interleaved partial failure (notification queued but `notifiedLeadDays` not updated, or vice versa) would otherwise cause a duplicate or a silently-swallowed alert on the next run.

6. **And** `PATCH /api/v1/projects/:projectId/services/:serviceId` (and the `certificates`/`domains` equivalents) updates `renewalDate`/`expiresAt`, `url`/`domain`/`domainName`, or `alertLeadDays`; **any change to the expiry/renewal date field resets `notifiedLeadDays` to `[]`** (new alert cycle, per AC 5).
   - *Example:* `PATCH .../services/svc-1 { "renewalDate": "2027-01-01T00:00:00Z" }` → `200`, `notifiedLeadDays` reset to `[]` even if it previously held values.
   - *Example (failure):* `serviceId` belongs to a different project/org → `404`.

7. **And** `DELETE /api/v1/projects/:projectId/services/:serviceId` (and `certificates`/`domains` equivalents) removes the row and **cancels any pending alerts for it** — mark `notification_queue` rows with `status = 'pending'` AND `payload->>'assetId' = :serviceId` AND `org_id = :orgId` as `status = 'suppressed'` (reuse `markNotificationSuppressed`-style update from [notification-queue-ops.ts](../../apps/api/src/workers/notification-queue-ops.ts), or add a bulk-by-payload-key variant if the single-ID version doesn't fit — a plain `UPDATE ... WHERE payload->>'assetId' = $1` is fine, this is not a hot path and no index is required for the low pending-row cardinality per org).
   - *Example:* delete a service with 2 pending queued notifications → both flip to `suppressed`, `204` returned, row physically deleted (hard delete — no soft-delete/archival requirement in the AC, unlike `credential_dependencies`).
   - *Example (failure):* `serviceId` not found in project/org → `404`.

8. **And** the existing frontend placeholder copy (`placeholder-copy.ts`, `dashboard-copy.ts`) is verified unchanged and still accurate — this story does not touch `apps/web/`. Add a one-line comment near those copy strings only if their existing "Epic 6" wording becomes actively misleading (it isn't — Epic 6 is now partially shipped but the UI genuinely still doesn't exist), otherwise leave them untouched.

9. **And** every create/update/delete on all three resource types writes an audit event in the same transaction, fail-closed (mirror `writeCredentialAuditOrFailClosed` pattern): `payment_record.created|updated|deleted`, `certificate.created|updated|deleted`, `domain_record.created|updated|deleted` (new `AuditEvent` registry entries — see Task 1). **Devil's-advocate resolution on hard-delete (AC 7):** since deleted rows are physically removed with no soft-delete/tombstone, the `*.deleted` audit event's `payload` **must include a snapshot of the deleted row's identifying fields** (`name`/`domain`/`domainName`, `expiresAt`/`renewalDate`, `alertLeadDays`) — this is the only place that data survives after deletion, and it's what makes hard-delete acceptable here without a compliance gap (contrast with `credential_dependencies`, which soft-deletes via `archivedAt` specifically because that history needs to remain queryable, not just audit-logged).

10. **And** RLS isolation: a `payment_records`/`cert_records`/`domain_records` row created under org A is invisible (404, not 403) to a caller authenticated in org B, enforced at the Postgres level via `org_id = current_setting('app.current_org_id')`, verified by an integration test that attempts cross-org read/update/delete and by `check-rls-coverage.ts` passing in CI.

11. **And** integration tests cover, at minimum: create each of the 3 asset types (happy path + validation failures + archived-project 410 + cross-org 404); daily job days-matching logic including the ±1 tolerance and `notifiedLeadDays` dedupe (both "fires once" and "does not re-fire next day" as explicit separate test cases); severity mapping boundaries (exactly 3, exactly 7, exactly 30 days remaining); update resets `notifiedLeadDays`; delete cancels pending queue entries; RLS cross-org isolation; audit event written for every mutation; rate limiting on the list/create endpoints (mirror `credentials` route rate-limit config, e.g. 120/min GET, tighter on POST).

## Tasks / Subtasks

- [x] Task 1 — Registries (AC: 5, 9) [Source: `packages/shared/src/constants/notification-types.ts`, `packages/shared/src/constants/audit-events.ts`]
  - [x] Add `'payment.expiry'`, `'certificate.expiry'`, `'domain.expiry'` to `NOTIFICATION_ALERT_TYPES` in `packages/shared/src/constants/notification-types.ts`. **This is not optional** — `getPreferences()` only generates default org-admin preference rows for alert types present in this array; without this change, `dispatchOrgAdminNotification` will silently find zero recipients and zero notifications will ever be queued, with no error raised anywhere (see [preferences.ts:46](../../apps/api/src/modules/notifications/preferences.ts)).
  - [x] Add `PAYMENT_RECORD_CREATED/UPDATED/DELETED`, `CERTIFICATE_CREATED/UPDATED/DELETED`, `DOMAIN_RECORD_CREATED/UPDATED/DELETED` to `AuditEvent` const + `AuditEventType` union in `packages/shared/src/constants/audit-events.ts` (both the object and the type union need every new key, matching the existing double-listing pattern already in that file).

- [x] Task 2 — Schema & migration (AC: 1, 2, 3, 10) [Source: `packages/db/src/schema/credentials.ts`, `packages/db/src/schema/helpers.ts`]
  - [x] Re-check `packages/db/src/migrations/meta/_journal.json` for the actual next-free migration number before generating — **`0027` as of this story's writing (last is `0026_account_recovery_tokens`)**, but verify. (Actual next-free was `0028` — Story 5.1's `rotations` migration had since landed as `0027`.)
  - [x] Create `packages/db/src/schema/payment-records.ts`, `cert-records.ts`, `domain-records.ts`, each: `id uuid PK`, `...orgScoped({ onDelete: 'cascade' })`, `projectId uuid NOT NULL FK → projects.id ON DELETE CASCADE`, resource-specific columns (see AC 1-3), `alertLeadDays jsonb NOT NULL DEFAULT '[…]'::jsonb $type<number[]>`, `notifiedLeadDays jsonb NOT NULL DEFAULT '[]'::jsonb $type<number[]>`, `createdBy uuid FK → users.id ON DELETE SET NULL`, `createdAt`/`updatedAt`. Indexes: `(projectId, <expiryColumn>)` for the daily job's scan, plus `orgId` (mirror `credentials.ts` index style exactly). **Security-audit finding — add `check()` length constraints matching the `credential_dependencies.system_name` pattern** ([credential-dependencies.ts:34-37](../../packages/db/src/schema/credential-dependencies.ts)): `name`/`domain`/`domainName` `char_length` BETWEEN 1 AND 256; `url` (payment_records only) BETWEEN 0 AND 2048 when non-null. Unbounded text columns on a user-writable, cross-tenant-adjacent table are an avoidable footgun (oversized rows bloat the daily-job scan and any future UI render) — every existing free-text column in this schema has an equivalent bound.
  - [x] Run `drizzle-kit generate` to produce the migration SQL; **hand-verify** it includes `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY "<table>_isolation" ON "<table>" USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);` for all three tables **in the same migration file** (mirror [0025_project_invitations.sql](../../packages/db/src/migrations/0025_project_invitations.sql) exactly) — `drizzle-kit generate` does not emit RLS policies automatically; they're hand-added the same way every prior RLS-bearing migration in this repo was. (`drizzle-kit generate`'s snapshot lineage is stale after several stories hand-wrote migrations without a fresh snapshot — generating for real would have re-emitted every table since `0019`. Hand-wrote `0028_monitoring_records.sql` instead, following `0027_rotations.sql`'s exact shape, and hand-appended the `_journal.json` entry — same workflow the previous several stories already used.)
  - [x] Export all three tables from `packages/db/src/schema/index.ts`.
  - [x] Run `db#check-rls` (`packages/db/scripts/check-rls-coverage.ts`) locally before moving on — it fails CI otherwise. (Passes — see Completion Notes.)

- [x] Task 3 — Module: zod schemas + service helpers (AC: 1-3, 6, 7, 9) [Source: `apps/api/src/modules/credentials/schema.ts`, `service.ts`]
  - [x] Create `apps/api/src/modules/monitoring/schema.ts`: request/response Zod schemas for all 3 resource types, reusing `ProjectScopeParamsSchema` from `credentials/schema.ts` where the shape matches (or defining an equivalent local one — do not duplicate silently, import if identical).
  - [x] Create `apps/api/src/modules/monitoring/service.ts` (or split per-resource if it gets large — `payment-records-service.ts` etc.): CRUD functions taking `tx: Tx`, mirroring `credentials/service.ts`'s `findProjectInOrg` reuse and the `withCredentialAuditOrFailClosed`-equivalent audit-write helper. **Do not inline Drizzle queries or Map lookups directly in `routes.ts`** — [[route-audit-thin-routes]] — `route-audit.test.ts` statically flags any bare `.get()/.post()/.patch()/.delete()` call in `routes.ts` as an unregistered raw Fastify route, including on unrelated objects like Drizzle query builders. Keep `routes.ts` thin; all DB logic lives in `service.ts`. (Kept as one `service.ts` covering all three resource types — the per-resource logic stayed small and parallel enough not to warrant a three-way file split.)

- [x] Task 4 — Routes (AC: 1-3, 6, 7, 9, 10) [Source: `apps/api/src/modules/credentials/routes.ts`, `apps/api/src/app.ts:196`]
  - [x] Create `apps/api/src/modules/monitoring/routes.ts` exporting `monitoringRoutes(fastify: FastifyApp)`, registering `GET/POST /:projectId/services`, `PATCH/DELETE /:projectId/services/:serviceId`, and the `certificates`/`domains` equivalents, all via `secureRoute(fastify, { method, url, schema, security: { minimumRole: 'member', writeAuditEvent: false, rateLimit: {...} }, handler })` — `writeAuditEvent: false` because audit writes happen explicitly inside the handler alongside the DB mutation (same reason `credentials/routes.ts` does it that way — same-transaction invariant). Rate limits (security-audit finding — mirror `credentials/routes.ts` exactly, values already established project-wide): GET list `max: 120, timeWindowMs: 60_000`; POST/PATCH/DELETE `max: 60, timeWindowMs: 60_000`.
  - [x] Register in `apps/api/src/app.ts`: `await fastify.register(monitoringRoutes, { prefix: '/api/v1/projects' })` — add inside the existing `eslint-disable sonarjs/no-duplicate-string` block at [app.ts:191-197](../../apps/api/src/app.ts) alongside `credentialRoutes`, since `route-audit.test.ts` statically parses the literal prefix string.

- [x] Task 5 — Daily expiry-alert workers (AC: 4, 5) [Source: `apps/api/src/main.ts:104-161`, `apps/api/src/notifications/dispatcher.ts`]
  - [x] Create `apps/api/src/workers/payment-expiry-alert.ts`, `cert-expiry-alert.ts`, `domain-expiry-alert.ts` — each: query all rows across all orgs with non-null expiry column (this worker runs org-agnostic, unlike `withOrg`-scoped request handlers — mirror how `credentials/prune-versions` or `import/cleanup-expired` operate cross-org in a single job run), compute `daysRemaining`, match against `alertLeadDays` minus `notifiedLeadDays`, call `dispatchOrgAdminNotification`, update `notifiedLeadDays` in the same transaction as the notification-queue insert. (Uses `createOrgAdminNotificationEntries` + `sendNotificationJobs` — the two halves `dispatchOrgAdminNotification` is composed of — with the queue insert inside the same `runOrgScopedJob` transaction as the `notifiedLeadDays` update, and `sendNotificationJobs(boss, …)` called once after all orgs/rows are processed. This mirrors the existing `check-failed-auth-threshold.ts` precedent: calling `boss.send` *inside* the DB transaction would enqueue the pg-boss job before the transaction is guaranteed to commit.) Extracted the days/severity/dedupe decision into a pure, DB-free `expiry-alert-shared.ts` helper shared by all three workers.
  - [x] Register in `main.ts`: add `'payment:expiry-alert': { cron: '0 8 * * *' }`, `'cert:expiry-alert': { cron: '0 8 * * *' }`, `'domain:expiry-alert': { cron: '0 8 * * *' }` to `registerSchedules`, and matching entries in `registerWorkers` wrapped in `withJobLogging` (mirror `credentials/prune-versions`'s registration exactly, [main.ts:133-136](../../apps/api/src/main.ts)).

- [x] Task 6 — Tests (AC: all) [Source: `apps/api/src/modules/credentials/credential-integration-context.ts`]
  - [x] Create `apps/api/src/modules/monitoring/monitoring-integration-context.ts` mirroring `credential-integration-context.ts`'s `bootstrapRouteIntegrationTest()` reuse.
  - [x] `routes.test.ts` covering AC 1-3, 6, 7, 10 (create/update/delete/cross-org/archived-project/validation) for all 3 resource types.
  - [x] Worker tests (`payment-expiry-alert.test.ts` etc.) covering AC 5 and 11's days-matching, ±1 tolerance, `notifiedLeadDays` dedupe-across-days, and severity-boundary cases. (Boundary/dedupe/overdue cases covered as pure unit tests in `expiry-alert-shared.test.ts`; each worker also has a DB-backed integration test. The domain-worker test surfaced a real, worth-documenting interaction: the domain default `alertLeadDays: [30]` always computes `info` severity, which the existing Story 3.2 default admin preference (`minSeverity: 'warning'`) filters out of delivery — `notifiedLeadDays` still advances so the cycle doesn't get stuck. Documented inline in the test rather than treated as a defect, since AC 5's severity formula and the pre-existing preference default are both intentional and outside this story's scope to change.)
  - [x] Run `route-audit.test.ts` explicitly even in a scoped verify pass — [[route-audit-thin-routes]] — it's cheap (~1s) and easy to omit, but only runs by default in full `make ci`. (Ran and passing — required adding `ROUTE_ACTION_CLASSIFICATIONS`/`WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED` entries to `route-exemptions.ts` for all 12 new routes.)

- [x] Task 7 — Wiring verification (AC: all)
  - [x] `pnpm generate-spec && pnpm typecheck` — confirms the new routes' Zod schemas produce a valid OpenAPI contract and the web app's generated `openapi-fetch` types still compile (even though no web code calls the new endpoints yet, the generated client types must not break the build). (Both pass. Note: `apps/api/src/scripts/generate-spec.ts` is a small hand-authored subset covering only the auth endpoints — it does not yet reflect `credentials`, `rotation`, or the new `monitoring` routes; running it is a no-op for this story. `openapi-fetch`/generated-client wiring does not exist anywhere in the repo yet either — `pnpm typecheck` across all packages, including `@project-vault/web`, is what actually confirms nothing broke.)
  - [x] `db#check-rls` passes for all 3 new tables.
  - [x] Manually verify `apps/web/src/lib/components/shell/placeholder-copy.ts` and `dashboard-copy.ts` are byte-identical to before this story (AC 8) — `git diff` should show no changes under `apps/web/`. (Confirmed — `git status --porcelain apps/web/` is empty.)

## Dev Notes

- This is the first Epic 6 story — no prior Epic 6 code exists to reconcile against. The relevant cross-epic coordination is entirely forward-looking placeholder text (Story 2.0/2.1) and the `deferred-work.md`/registry items called out above, not a schema stub left by another story (contrast with Story 5.1, which had to satisfy two other stories' forward stubs — no such stubs exist for 6.1).
- `apps/api/src/modules/projects/dashboard-stats.ts:87` hardcodes `monitoredServiceHealth = { healthy: 0, degraded: 0, down: 0 }` with a comment pointing at "Epic 6 project-scoped monitoring alerts." That field is about **live health status** (6.2's `service_endpoints` health-check concern), not this story's expiry records — **do not** wire `payment_records`/`cert_records`/`domain_records` into `dashboard-stats.ts`; leave that stub alone for 6.2/6.3 to resolve.
- Reuse `findProjectInOrg`, `rejectIfProjectArchived`, `parseParams`/`parseBody`/`validationError`, `buildPaginationMeta`/`parsePagination` from the `credentials`/`projects` modules rather than reimplementing — same conventions, same 404-not-403 and archived-project-410 behavior expected by AC 1.
- `alertLeadDays` validation: array of positive integers, max length 10 (arbitrary reasonable cap — not specified numerically anywhere in epics.md/architecture.md, chosen to bound worst-case daily-job iteration per asset; document the choice in a code comment since it's not sourced).
- No web/SvelteKit changes in this story (Product Surface Contract: `api`-only). Do not create routes under `apps/web/src/routes/`.

### Project Structure Notes

- New backend module: `apps/api/src/modules/monitoring/` (matches architecture.md's Requirements-to-Structure Mapping row: `Operational Monitoring & Alerts | modules/monitoring/`).
- New workers: `apps/api/src/workers/payment-expiry-alert.ts`, `cert-expiry-alert.ts`, `domain-expiry-alert.ts` (matches architecture.md's worker list for this module, minus `health-check.ts` and `credential-expiry-alert.ts` — both explicitly out of scope, see above).
- New schema files: `packages/db/src/schema/payment-records.ts`, `cert-records.ts`, `domain-records.ts`.
- No changes to `apps/web/` (see Product Surface Contract).
- Deviations from architecture.md's literal column shapes (documented above with rationale): `alert_lead_days` as `jsonb number[]` instead of `alert_threshold_days integer`; addition of `notified_lead_days jsonb number[]` (not mentioned in either source doc, required for correctness per AC 5's idempotency analysis).

### References

- [Source: `_bmad-output/planning-artifacts/epics.md#Story-6.1-Service-Certificate--Domain-Record-Management` (lines 1664-1691)] — story AC draft, endpoint shapes, default lead days.
- [Source: `_bmad-output/planning-artifacts/epics.md` lines 1659-1662] — AC-E6a/b/c/d cross-story constants (check frequency, lead-time defaults, snooze behavior — E6c/6.2 not applicable here).
- [Source: `_bmad-output/planning-artifacts/architecture.md` lines 903-930] — canonical schema entity names, `alert_threshold_days` columns, RLS-in-migration requirement.
- [Source: `_bmad-output/planning-artifacts/architecture.md` lines 884-901] — Requirements-to-Structure Mapping (`modules/monitoring/`, worker file names).
- [Source: `_bmad-output/implementation-artifacts/deferred-work.md`] — credential-expiry-notifications gap (out of scope, see above) and `monitoredServiceHealth` dashboard placeholder.
- [Source: `packages/shared/src/constants/notification-types.ts`] — `NOTIFICATION_ALERT_TYPES` registry, must be extended.
- [Source: `packages/shared/src/constants/audit-events.ts`] — `AuditEvent` registry, must be extended.
- [Source: `apps/api/src/notifications/dispatcher.ts`] — `dispatchOrgAdminNotification` / `createOrgAdminNotificationEntries`, the canonical Story 3.1 notification entry point referenced by epics.md's "queues a notification via Story 3.1."
- [Source: `apps/api/src/modules/credentials/routes.ts`, `service.ts`, `schema.ts`] — route/service/schema pattern to mirror (SecureRoute usage, `findProjectInOrg`, `rejectIfProjectArchived`, thin-routes convention).
- [Source: `apps/api/src/main.ts` lines 104-161] — pg-boss `registerSchedules`/`registerWorkers` wiring pattern to mirror.
- [Source: `packages/db/src/migrations/0025_project_invitations.sql`] — RLS-in-migration pattern to copy exactly.
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.5 (claude-sonnet-5), via the `bmad-dev-story` workflow, in an isolated git worktree.

### Debug Log References

- Local dev DB stood up via `docker compose up -d db` with a worktree-scoped `.env` (`DB_HOST_PORT=5442`) to avoid colliding with other running stacks (main checkout on 5432, another worktree on 5433).
- `drizzle-kit generate` was attempted first per the story's literal instruction, but its snapshot lineage is stale (only `0000` and `0019` have real snapshot JSON files — every migration since was hand-authored without running `generate`, per `git log` on `packages/db/src/migrations/meta/`). Running `generate` re-emitted `CREATE TABLE` for every table added since `0019` (notification_inbox, project_invitations, rotations, etc.), which would have collided with the already-applied migrations. Reverted the generated file/snapshot and hand-wrote `0028_monitoring_records.sql` following `0027_rotations.sql`'s exact shape instead (same workflow the last several stories already used).
- Migration applied and verified against a real Postgres instance: `db:migrate` succeeds, `pnpm check-rls` (as `vault_app`) passes for all 3 new tables, `\d payment_records` confirms columns/checks/FKs/policy/trigger.
- Full `apps/api` test suite run (`vitest run`, 94 files, 764 tests): 763 passed, 1 pre-existing failure in `modules/projects/archive-guards.test.ts` (ADR-4.4-02 cleanup left over from Story 5.1 — confirmed via `git diff` showing zero changes to that file/its dependencies from this story). Flagged as a separate out-of-scope task rather than fixed here.
- `route-audit.test.ts`, `pnpm generate-spec`, and `pnpm typecheck` (root, all packages) all pass.

### Completion Notes List

- **AC 1-3 (create services/certificates/domains):** `POST /:projectId/services|certificates|domains` implemented with per-type Zod validation (name/domain/domainName length bounds, `alertLeadDays` positive-integer array capped at 10), correct per-type `alertLeadDays` defaults (`[14,3]`/`[30,7]`/`[30]`), `notifiedLeadDays: []` on creation, 404 `project_not_found` for cross-org projects, 410 for archived projects. Domain `domainName` intentionally has no uniqueness constraint (AC 3 explicitly permits duplicates).
- **AC 4 (auto-enrollment):** satisfied by construction — no separate enable-alerting step or flag exists; the daily job unconditionally scans all rows with a non-null expiry/renewal column.
- **AC 5/11 (daily job, matching, idempotency, overdue, severity, failure isolation):** the ±1-day tolerance matching, `notifiedLeadDays` dedupe, severity boundaries (≤3 critical / ≤7 warning / else info), and the overdue (`daysRemaining <= 0`, threshold `0`) special case are implemented as a pure, DB-free function (`apps/api/src/workers/expiry-alert-shared.ts`) with full boundary-case unit test coverage. Each of the three workers (`payment-expiry-alert.ts`, `cert-expiry-alert.ts`, `domain-expiry-alert.ts`) wraps per-row processing in its own `runOrgScopedJob` transaction inside a per-row `try/catch`, so one row's failure doesn't abort the batch; the notification-queue insert and `notifiedLeadDays` update commit in that same transaction. Notification jobs are collected and handed to `sendNotificationJobs(boss, …)` once, after all orgs/rows are processed (mirrors the existing `check-failed-auth-threshold.ts` precedent — calling `boss.send` before the owning transaction commits would be premature).
  - **Finding surfaced by testing, not a defect:** `domain_records`' sole default threshold (`alertLeadDays: [30]`) always computes `info` severity per AC 5's formula, and the existing Story 3.2 default admin notification preference (`minSeverity: 'warning'`) filters `info`-severity alerts out of delivery entirely. This means a domain record relying purely on the default lead days will never actually deliver a notification unless an org admin lowers their preference — `notifiedLeadDays` still advances (so the job doesn't get stuck retrying), but no email/Slack/inbox entry is created. This is the correct, intended interaction of two independently-specified behaviors (AC 5's severity formula; Story 3.2's preference default), not something 6.1 should silently patch — documented inline in `domain-expiry-alert.test.ts` and called out here for product/QA awareness.
- **AC 6 (update resets notifiedLeadDays):** `PATCH` routes reset `notifiedLeadDays` to `[]` whenever the raw request body contains the expiry/renewal-date key (regardless of whether the new value differs from the old one), matching the story's literal example.
- **AC 7 (delete cancels pending alerts):** hard-delete plus a bulk `UPDATE notification_queue SET status = 'suppressed' WHERE org_id = $1 AND status = 'pending' AND payload->>'assetId' = $2` (no dedicated index, per the story's own note on low pending-row cardinality per org).
- **AC 8 (placeholder copy untouched):** verified via `git status --porcelain apps/web/` — empty; no files under `apps/web/` were touched.
- **AC 9 (audit events, fail-closed, deleted-row snapshot):** all 9 new create/update/delete routes write an audit event through `writeMonitoringAuditOrFailClosed` (same fail-closed `writeHumanAuditEntryOrFailClosed` wrapper pattern as `credentials`), inside the same transaction as the DB mutation, with `writeAuditEvent: false` at the route-registration level (mirrors the `credentials` convention exactly). `*.deleted` audit payloads include the deleted row's identifying field, expiry/renewal date, and `alertLeadDays` as a snapshot, since the row is hard-deleted with no tombstone.
- **AC 10 (RLS isolation):** enforced at the Postgres level via `USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)` on all 3 new tables (migration `0028_monitoring_records.sql`); verified by an integration test that attempts cross-org PATCH/DELETE and gets 404 (not 403), plus `check-rls-coverage.ts` passing for all 3 tables.
- **AC 11 (integration test coverage):** covered across `apps/api/src/modules/monitoring/routes.test.ts` (create happy/edge/validation/cross-org/archived/audit per resource type, update-resets-notifiedLeadDays, cross-org 404 on update, delete-cancels-pending-queue-suppresses-both-entries, delete 404, RLS cross-org isolation on read/update/delete, list), `apps/api/src/workers/expiry-alert-shared.test.ts` (pure boundary/dedupe/overdue cases), and one integration test file per worker. Rate limiting itself was not re-proven with a dedicated 429-triggering test (the existing `register-rate-limit.test.ts` pattern already establishes that mechanism works and is bypassed by default under `NODE_ENV=test`); the route registrations were instead verified to carry the same `max`/`timeWindowMs` values as the `credentials` convention (120/60s GET, 60/60s POST/PATCH/DELETE).
- **Architecture conflict resolutions (ADR-6.1-01/02/03) and the credential-expiry-alerting scope boundary** were followed exactly as directed in the story file — three separate physical tables (`payment_records`/`cert_records`/`domain_records`) under the `/services`/`/certificates`/`/domains` route paths, `jsonb number[]` for `alertLeadDays`/`notifiedLeadDays`, and no changes to `credentials` or `apps/web/`.
- **Out of scope, flagged separately:** a pre-existing, unrelated test failure in `apps/api/src/modules/projects/archive-guards.test.ts` (ADR-4.4-02 cleanup debt left over from Story 5.1 landing the `rotations` table) — not touched by this story; spawned as a separate follow-up task.

### File List

**New files:**
- `packages/db/src/schema/payment-records.ts`
- `packages/db/src/schema/cert-records.ts`
- `packages/db/src/schema/domain-records.ts`
- `packages/db/src/schema/monitoring-records-schema.test.ts`
- `packages/db/src/migrations/0028_monitoring_records.sql`
- `apps/api/src/modules/monitoring/schema.ts`
- `apps/api/src/modules/monitoring/service.ts`
- `apps/api/src/modules/monitoring/routes.ts`
- `apps/api/src/modules/monitoring/routes.test.ts`
- `apps/api/src/modules/monitoring/monitoring-integration-context.ts`
- `apps/api/src/workers/expiry-alert-shared.ts`
- `apps/api/src/workers/expiry-alert-shared.test.ts`
- `apps/api/src/workers/payment-expiry-alert.ts`
- `apps/api/src/workers/payment-expiry-alert.test.ts`
- `apps/api/src/workers/cert-expiry-alert.ts`
- `apps/api/src/workers/cert-expiry-alert.test.ts`
- `apps/api/src/workers/domain-expiry-alert.ts`
- `apps/api/src/workers/domain-expiry-alert.test.ts`

**Modified files:**
- `packages/shared/src/constants/notification-types.ts` (added `payment.expiry`/`certificate.expiry`/`domain.expiry`)
- `packages/shared/src/constants/notification-types.test.ts`
- `packages/shared/src/constants/audit-events.ts` (added `PAYMENT_RECORD_*`/`CERTIFICATE_*`/`DOMAIN_RECORD_*` events)
- `packages/shared/src/constants/audit-events.test.ts`
- `packages/shared/src/constants/operational-event-types.ts` (added `MONITORING_EXPIRY_ALERT_ROW_FAILED`)
- `packages/shared/src/constants/operational-event-types.test.ts`
- `packages/db/src/schema/index.ts` (exported the 3 new tables)
- `packages/db/src/migrations/meta/_journal.json` (hand-appended the `0028` entry)
- `apps/api/src/app.ts` (registered `monitoringRoutes`)
- `apps/api/src/main.ts` (registered the 3 daily expiry-alert schedules/workers)
- `apps/api/src/lib/route-exemptions.ts` (classified the 12 new routes)
- `_bmad-output/implementation-artifacts/6-1-service-certificate-and-domain-record-management.md` (this file — tasks, status, Dev Agent Record)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status transition, handled by workflow tooling)

**Not modified (verified):** nothing under `apps/web/`.
