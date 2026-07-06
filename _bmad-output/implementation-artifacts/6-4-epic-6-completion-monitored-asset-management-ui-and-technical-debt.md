# Story 6.4: Epic 6 Completion — Monitored Asset Management UI & Technical Debt

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-07-06 — Epic 6 closure story derived from
epic-6-retro-2026-07-06.md's action items (A6-1, A6-2, P6-3), mirroring the closure-story pattern
already used for Epics 2 (2-8), 3 (3-4), and 5 (5-5). Story 6.1 shipped `payment_records`/
`cert_records`/`domain_records` (services/certificates/domains) as API-only, explicitly flagging in
its own Product Surface Contract that no UI story existed yet ("flag it at Epic 6 sprint-planning/
retrospective time so a UI story gets added before epic-6: done"). That flag sat unconverted for
3 days while Epic 7 shipped entirely and Epics 8/9 advanced. This story closes it, plus two smaller,
explicitly-scoped items: the now-stale `dashboard-copy.ts` "available in Epic 6" claim, and the
`AuditEvent` object/type-union dual-listing consolidation (flagged as debt in 6.1/6.2/6.3, reproduced
3 times, never fixed). A fourth item — not named by the retro's literal text but discovered during
this story's own research and just as real — is also folded in: Story 6.2's Product Surface Contract
named Story 6.3 as its "linked UI story," but 6.3 only ever *consumed* `service_endpoints` data
(health dashboard, status-page picker); it never shipped a way to *create* a `service_endpoints` row.
As of this story's creation, the web app has zero route capable of registering an HTTP endpoint to
monitor — meaning 6.2's and 6.3's fully-built health-check/status-page machinery has no way to ever
become populated by a real (non-API) user. Left unaddressed, this would be Epic 6's second open PSC
gap sitting for a future retro to re-discover. This story closes it in the same pass as
services/certificates/domains, since it is the identical gap shape against a sibling table in the
same module. -->

## Story

As a developer or org admin using Project Vault's operational-monitoring features,
I want a web UI to register, view, edit, and remove monitored services, SSL/TLS certificates, domains, and HTTP endpoint monitors — and to see, snooze, and dismiss the alerts those endpoints raise — so that the monitoring capability Epic 6 already built on the backend is actually usable by someone without direct API access, and the product's own UI copy stops promising a feature it doesn't yet deliver.

*Closes: Epic 6 retrospective action items A6-1, A6-2, and P6-3 (audit-registry consolidation).* [Source: `_bmad-output/implementation-artifacts/epic-6-retro-2026-07-06.md`]

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — this story ships the UI itself; it is the linked follow-up 6.1 and 6.2 both pointed to. |
| **Honest placeholder AC** (if UI deferred) | N/A — nothing is deferred further. If any part of scope genuinely cannot land (see Known Scope Boundaries), the corresponding placeholder copy must stay honest, not be silently upgraded to imply a working feature that doesn't exist yet. |
| **Persona journey** | See below |

### Persona journey stub

**Sam-member (developer, registers operational assets):** Sam opens a project's credentials page, clicks the new "Services" link in the project sub-nav (alongside new "Certificates," "Domains," and "Endpoints" links — see AC-A1), and lands on a "Services" list (initially empty: *"No services registered yet."*). Sam clicks "Add service," fills in a name, optional URL, and optional renewal date, and saves — the new service appears in the list immediately with its configured alert lead days. Sam repeats the flow for a certificate (`api.example.com`, expiring in 45 days) and a domain (`example.com`, renewing in 200 days), then registers an HTTP endpoint monitor for `https://api.example.com/health` via the fourth new "Endpoints" link/page. Within the next scheduled health-check tick (Story 6.2, already running), the endpoint's status begins updating live on both this page and the org-wide `/health` dashboard (Story 6.3, already built) — Sam did not have to configure anything beyond the URL, matching UX-DR9/the UX spec's "monitoring configures itself" principle.

**Riley-admin (responds to a live incident):** Riley gets a `service.down` email (Story 6.2, already wired) linking to `/projects/:projectId/service-endpoints`. Riley opens the page, sees the endpoint's status badge (red, "down"), an inline active-alert banner with "Snooze 1 hour" and "Dismiss" buttons, and recent health-check history. Riley snoozes the alert while a known third-party outage is in progress, and dismisses it once resolved — all without needing `curl` or Swagger.

**Alex-viewer (read-only, browses coverage):** Alex, an org `viewer`, opens the same pages and sees every list and detail view, but never sees a create/edit/delete control anywhere (server already enforces `member`+ for mutations; the UI must not render disabled-but-visible mutation controls that invite a 403, per this codebase's existing `canCreateCredential`-style gating convention).

---

## Background: What Already Exists (Read Before Coding)

This story adds **zero new backend routes, zero new database tables, and zero new migrations.** Every API endpoint this story's UI calls already exists, is `done`, and is covered by its own story's integration tests. Do not re-implement, re-validate, or "helpfully" extend any backend behavior described below — treat `apps/api/src/modules/monitoring/` as a stable, already-reviewed dependency. This section exists so the dev agent does not have to re-read all of 6.1/6.2/6.3 to find these facts.

### The four already-shipped, UI-less resource types

| Resource | Table | Routes (all under `/api/v1/projects/:projectId/...`, all `apps/api/src/modules/monitoring/routes.ts`) | Story |
|---|---|---|---|
| Services | `payment_records` | `GET/POST /services`, `PATCH/DELETE /services/:serviceId` | 6.1 |
| Certificates | `cert_records` | `GET/POST /certificates`, `PATCH/DELETE /certificates/:certificateId` | 6.1 |
| Domains | `domain_records` | `GET/POST /domains`, `PATCH/DELETE /domains/:domainId` | 6.1 |
| Service endpoints (HTTP monitors) | `service_endpoints` | `GET/POST /service-endpoints`, `PATCH/DELETE /service-endpoints/:serviceEndpointId`, `GET /service-endpoints/:serviceEndpointId/health-history` | 6.2 |
| Monitoring alerts | `monitoring_alerts` | `GET /alerts`, `POST /alerts/:alertId/snooze`, `POST /alerts/:alertId/dismiss` | 6.2 |

All Zod request/response schemas for these already exist in `apps/api/src/modules/monitoring/schema.ts` (read this file directly before writing any API wrapper — it is the single source of truth for field names, types, and validation bounds). Key facts a naive re-derivation would get wrong:

- **Services' update body has no `name` field.** `UpdatePaymentRecordBodySchema` (schema.ts:57-60) only accepts `url`, `renewalDate`, `alertLeadDays` — and the schema is `.strict()`, so submitting `{ name: "..." }` in a `PATCH .../services/:serviceId` body returns `422` (unrecognized key), not a silent no-op. **The service edit form must not include a name field at all** — a service's name is immutable after creation via this API. Certificates and domains do **not** have this restriction: `UpdateCertificateBodySchema` accepts `domain` and `UpdateDomainRecordBodySchema` accepts `domainName` (both renamable).
- **Create-body required-vs-optional fields differ per resource** (verify directly in `schema.ts` before building forms, do not assume symmetry): services' `url`/`renewalDate` are both nullable+optional (a service can be registered with no URL and no renewal date at all — it just won't be enrolled in expiry alerting until a `renewalDate` is added later via `PATCH`); certificates' `expiresAt` is **required** (no nullable/optional); domains' `renewalDate` is **required** (no nullable/optional). `alertLeadDays` is optional on every create body (server fills in the per-resource default: `[14,3]`/`[30,7]`/`[30]`) and is capped at `MAX_ALERT_LEAD_DAYS = 10` entries, each a positive integer.
- **List endpoints for services/certificates/domains/service-endpoints are unbounded — no pagination.** `PaymentRecordListResponseSchema`/`CertificateRecordListResponseSchema`/`DomainRecordListResponseSchema`/`ServiceEndpointListResponseSchema` all return `{ data: { items: [...] } }` with no `page`/`limit`/`hasNext`. Do not build pagination controls for these lists — there are none server-side (bounded in practice by the per-project `MAX_SERVICE_ENDPOINTS_PER_PROJECT = 25` cap on endpoints, and no equivalent cap exists or is needed for services/certs/domains at this story's scope). `GET .../alerts` and `GET .../health-history` **do** paginate (`page`-based, see `pageBasedPaginationQueryFields` in `schema.ts`) — these two need real pagination controls.
- **`service_endpoints.url` responses are always redacted** (`redactUrlForDisplay`, ADR-6.2-11) — userinfo stripped, secret-shaped query params masked as `***REDACTED***`. The UI must never attempt to "restore" or edit around this redaction; an edit form for a service-endpoint's `url` is a fresh text input the user retypes, not a pre-filled-then-partially-masked field (the raw value is never returned by any endpoint after creation).
- **`monitoring_alerts.serviceEndpointId` can be `null`** (`MonitoringAlertSchema`, schema.ts:281) — a historical alert whose originating endpoint was later deleted. The alerts UI must render such alerts (e.g. "endpoint deleted") rather than crashing on a missing `serviceEndpointId`, and must not attempt to link to a now-nonexistent endpoint detail page.
- **Dismissing a monitoring alert requires `admin`+ role** (`POST .../alerts/:alertId/dismiss`, ADR-6.2-04's correction) — **not** `member`+ like every other mutation in this module. Snoozing remains `member`+. The UI's role gate for the dismiss button must check `admin`+ specifically, not reuse the same `member`+ gate as the rest of the page, or a `member`/`viewer` will see a dismiss button that 403s on click.
- **`GET .../services|certificates|domains|service-endpoints` (list, detail) require only `viewer`+**; create/update/delete require `member`+ (except alert-dismiss, `admin`+ above). Mirror `apps/web/src/lib/credentials/permissions.ts`'s `canImportCredentials`-style boolean-helper convention for gating each mutation control — do not hardcode role-string comparisons inline in `.svelte` files.

### The gap this story closes is UI-only, not backend

No AC in `_bmad-output/planning-artifacts/epics.md`'s Epic 6 section (lines 1653-1749) ever describes a services/certificates/domains/service-endpoints management UI — verified by direct re-read during this story's creation. Story 6.3's AC only covers the cross-project health dashboard (`/health`, read-only) and the public status page (read-only for external viewers; the status-page *admin* UI only lets an owner pick from **already-existing** `service_endpoints` rows via `listServiceEndpoints` — it has no create/edit/delete control for them). This confirms 6.1's own flagged gap and extends it: the picker at `/projects/:projectId/status-page` (`apps/web/src/routes/(app)/projects/[projectId]/status-page/+page.svelte`) is presently **unpopulatable** by any UI-only user, since nothing creates a `service_endpoints` row without direct API access.

### Existing conventions this story must reuse, not reinvent

| Concern | Reuse this exact precedent |
|---|---|
| API wrapper shape | `apps/web/src/lib/api/status-page.ts` (thin `apiFetch` wrappers, local request types, shared-package response types) and `apps/web/src/lib/api/credentials.ts` |
| Existing partial wrapper | `apps/web/src/lib/api/service-endpoints.ts` already exists (`listServiceEndpoints`, `ServiceEndpoint` type) — **extend this file** with create/update/delete/get functions; do not create a second, competing wrapper file for the same resource. |
| Create-form pattern | `apps/web/src/routes/(app)/projects/[projectId]/credentials/new/+page.svelte` — `$state` fields, client-side `submitForm()`, `FormSubmitRow` (`$lib/components/forms/FormSubmitRow.svelte`), inline `fieldErrors` |
| Access-denied pattern | `$lib/components/credentials/AccessNotice.svelte` (title/message/backHref/backLabel props) |
| Project sub-nav pattern | The `<nav class="mt-3 flex gap-4 text-sm">` block in `apps/web/src/routes/(app)/projects/[projectId]/credentials/+page.svelte` (lines 57-70) — currently links to "Members" and "Public status page"; add this story's new links here. |
| Project-scoped load-function pattern | `apps/web/src/routes/(app)/projects/[projectId]/status-page/+page.server.ts` — `requireUser(locals)`, conditional data loading, `ApiClientError` catch-and-degrade (mirrors `credentials/+page.server.ts`'s 404 handling) |
| API error shape | `apps/web/src/lib/api/client.ts`'s `ApiClientError` (`.status`, `.code`, `.details`, `.message`) — every wrapper function throws this on non-2xx; catch and map to field errors / banners exactly as `credentials/new/+page.svelte` does via `mapCredentialSubmitError`-style logic (write an equivalent local mapper per resource, or a small shared one — developer's call, but do not let a raw `ApiClientError.message` reach the DOM unformatted since it may include a Zod field-path string not meant for end users). |
| Component test pattern | `apps/web/src/routes/status/[token]/page.test.ts` — `@testing-library/svelte`'s `render`/`cleanup`, asserting rendered text/DOM shape, not full Playwright E2E. This is the established testing tier for these UI stories; use it, do not introduce a new Playwright harness for this story. |
| Top-level primary nav | `apps/web/src/lib/components/shell/nav-model.ts` — fixed 6-item list (Dashboard/Projects/Credentials/Alerts/Health/Settings). **Do not add a 7th top-level nav item** — this story's new pages are project-scoped sub-pages, reached via the project sub-nav (same tier as Members/Public status page), not the primary nav. |

---

## Known Scope Boundaries

- **No new backend routes, schema, or migrations.** Every mutation this story's UI performs goes through an existing, `done`, already-tested endpoint. If implementation reveals a genuine backend gap not listed above, stop and flag it rather than silently adding a route — that would be new, unreviewed backend scope smuggled into a UI-only closure story.
- **No bulk import for services/certificates/domains/endpoints** (unlike credentials' `.env`/JSON import, Story 2.5). Epics.md's Epic 6 section has no bulk-registration AC for these resources; adding one would be unscoped feature work, not a gap closure.
- **No new alert type or notification channel.** This story surfaces existing `monitoring_alerts`/`security_alerts` data; it does not add a new `AuditEvent`/`NOTIFICATION_ALERT_TYPES` entry (the `AuditEvent`/`AuditEventType` **consolidation** in this story is a mechanical refactor of how the existing entries are declared, not an addition of new ones — see AC-J).
- **The `security_alerts` (org-wide, Story 3.4/6.2 anomalous-access) surface is out of scope for this story's UI.** `GET /organizations/:orgId/security-alerts` and its `dismiss` route already exist (6.2 AC 18) but have no web UI either — this is a real, separate gap, but it is an **org-level** security surface (not a "monitored asset"), was not named by the epic-6 retro's action items, and folding it in here would widen this closure story beyond its traceable scope. Flag it, do not build it (see Dev Notes' forward-looking note).
- **No drag-and-drop reordering, saved filters, or search for these lists.** Given lists are unbounded-but-small (no pagination server-side, see Background), a plain unfiltered list is sufficient; do not add client-side pagination/search machinery the data doesn't need yet.
- **AuditEvent consolidation (AC-J) does not change any emitted event's runtime string value.** Every `eventType: 'payment_record.created'`-style string literal at every existing call site (`apps/api/src/modules/monitoring/routes.ts` and others) must resolve to the exact same string after the refactor — this is a type-level/declaration-level consolidation only, verified by the existing `audit-events.test.ts` assertions continuing to pass unchanged.
- **No fix for the `payment_records` physical-table-name vs. "services" domain-language mismatch** (TD6-1 in the retro, explicitly "not scheduled" — a rename, not a UI gap). This story's UI code and copy use "Services"/"service" consistently in all user-facing text and variable/component names, regardless of the underlying table name — do not leak `paymentRecord`/`payment_record` into any UI-facing label, route segment, or component name (the API wrapper file may reasonably be named `services.ts` even though it calls `/services` which maps to `payment_records` server-side — this mirrors how `service-endpoints.ts` already names itself after the route, not the table).

---

## Acceptance Criteria

### A. Navigation — a real path exists to every new page (G3 compliance)

**AC-A1.** **Given** a project's credentials page (`/projects/:projectId/credentials`), **when** a user with any org role views it, **then** the existing sub-nav block (currently "Members" / "Public status page") gains four additional links: "Services", "Certificates", "Domains", "Endpoints" — each resolving to a real SvelteKit route (`/projects/:projectId/services`, `.../certificates`, `.../domains`, `.../service-endpoints`) that renders successfully for a `viewer`+ role, closing the exact "navigation to nowhere" pattern the Product Surface Contract's G3 rule exists to prevent.
   - *Example (happy path):* a `viewer` clicks "Services" → lands on `/projects/proj-1/services`, sees the list (possibly empty), no error.
   - *Example (edge — project not found/cross-org):* same 404 handling as the existing credentials page's `notFound` pattern — the sub-nav itself still renders (it's static), but the target page shows the existing "project not found" notice rather than throwing an unhandled error.

**AC-A2.** **Given** the `/health` cross-project dashboard (Story 6.3, already shipped), **when** it renders in its empty state (`hasAnyServices` false), **then** the existing copy *"Register a service endpoint on a project to see its live status here."* is no longer a dead-end sentence — it becomes a link to `/projects` (or, if exactly one project exists in the org, directly to that project's `/service-endpoints` page) so a first-time user has an actual next step, not just a description of one. When `hasAnyServices` is true, each existing per-project card (which already links its project name to `.../credentials`) gains a second, smaller "Manage endpoints" link to `.../service-endpoints`.
   - *Example (happy path, multiple projects):* empty state → "Browse your projects" link → `/projects`.
   - *Example (edge — exactly one project in the org):* empty state → link goes directly to `/projects/<that-project-id>/service-endpoints`, skipping an unnecessary intermediate list-of-one.
   - *Example (non-empty state):* a project card showing 2 healthy services now also shows a "Manage endpoints" link alongside the existing project-name link.

**AC-A3.** **Given** the status-page admin picker (`/projects/:projectId/status-page`, Story 6.3), **when** it renders and the project has zero `service_endpoints` rows yet, **then** the service picker's empty state gains a link to `/projects/:projectId/service-endpoints` (this story's new registration page) — closing the exact "unpopulatable picker" gap described in Background above. This is a small, additive change to an existing `.svelte` file, not a new page.
   - *Example:* Riley opens the status-page admin page on a brand-new project → sees "No service endpoints registered yet. Register one to add it to your public status page." with a link → clicks through, registers one, returns, and now sees it in the picker.

---

### B. Services (`payment_records`) — list, create, edit, delete

**AC-B1.** **Given** a project with zero registered services, **when** a `viewer`+ user visits `/projects/:projectId/services`, **then** the page shows an honest empty state ("No services registered yet.") and, if the caller is `member`+, an "Add service" call-to-action; a `viewer` sees no create control at all (not a disabled one).
   - *Example (happy path, viewer):* page renders with the empty-state message only, no button.
   - *Example (happy path, member):* page renders the empty-state message plus a visible, enabled "Add service" link to `/projects/:projectId/services/new`.

**AC-B2.** **Given** a project with 3 registered services, **when** a `viewer`+ user visits the list, **then** each row shows `name`, `url` (or "—" if null), `renewalDate` (formatted, or "—" if null), and `alertLeadDays` (e.g. "Alerts at 14, 3 days before"); a `member`+ additionally sees "Edit" and "Delete" controls per row.
   - *Example:* a service with `renewalDate: null` (per AC-B4's create-with-omitted-fields case) shows "—" in the renewal-date column, never a fabricated date or a blank cell that could be mistaken for a loading state.

**AC-B3.** **Given** the "Add service" form (`/projects/:projectId/services/new`), **when** a `member`+ submits `{ name: "AWS Hosting", url: "https://console.aws.amazon.com/billing", renewalDate: "2026-09-01" }`, **then** `createPaymentRecord` is called via `POST /api/v1/projects/:projectId/services`, and on success the user is navigated to the services list (or the new service's detail page — developer's choice, mirror whichever pattern `credentials/new` uses, i.e. navigate to the created resource) with the new row visible.
   - *Example (happy path):* form submit → `201` → redirect → new row appears with the exact submitted values plus server-assigned `alertLeadDays: [14, 3]` (default, since the form's alert-lead-days field, if present, was left at its default — see AC-B3's edge case below for a non-default submission).
   - *Example (edge — all optional fields left blank):* `{ name: "GitHub SaaS seat" }` only → `201`, `url`/`renewalDate` both render as "—" in the resulting list row, matching AC-B2.
   - *Example (edge — custom alert lead days):* form includes an "Alert me before renewal (days)" input accepting a comma-separated list (e.g. `"30, 14, 3"`) → parsed client-side into `[30, 14, 3]` → submitted as `alertLeadDays` → `201` with that exact array persisted.
   - *Example (failure — validation, empty name):* submitting with `name` blank shows an inline field error ("Name is required") **before** any network call — mirror `credentials/new`'s `validateCredentialForm`-style client-side pre-check pattern, do not rely solely on the server's `422`.
   - *Example (failure — server-side validation, e.g. `alertLeadDays` with 11 entries):* the client-side check doesn't catch every server rule (e.g. the `MAX_ALERT_LEAD_DAYS = 10` cap isn't necessarily mirrored client-side) — a `422` response is caught, and the response's Zod field-path error is mapped to a user-readable banner (not the raw Zod error object dumped to the page).
   - *Example (failure — archived project, `410`):* the create form still renders (the project exists, just archived), but submission fails with a clear message ("This project is archived and cannot be modified.") rather than a generic error.
   - *Example (failure — cross-org/nonexistent project, `404`):* navigating directly to `/projects/<other-org-project-id>/services/new` (e.g. a stale bookmark) shows the same "project not found" notice the credentials page already uses for this case, not a broken form.

**AC-B4.** **Given** an existing service's detail/edit page (`/projects/:projectId/services/:serviceId`), **when** a `member`+ user changes `url`, `renewalDate`, or `alertLeadDays` and saves, **then** `PATCH /api/v1/projects/:projectId/services/:serviceId` is called with **only** those three fields (never `name` — see Background's "no `name` field in update" note) and the page reflects the saved values, including the server-side `notifiedLeadDays` reset (AC 6, Story 6.1) that occurs whenever `renewalDate` changes — the edit page does not need to display `notifiedLeadDays` itself, but must not display stale cached alert-lead-day state after a `renewalDate` edit.
   - *Example (happy path):* change `renewalDate` from `2026-09-01` to `2027-01-01`, save → `200`, detail page shows the new date.
   - *Example (edge — the name field, confirming AC scope):* the edit form has no editable "Name" input at all (read-only label showing the current name is acceptable; an editable-but-non-submitted input is not, since it would silently misrepresent to the user that renaming is possible).
   - *Example (failure — cross-org/nonexistent serviceId):* navigating to a stale/foreign `serviceId` → `404`, page shows a "not found" notice, not a broken form pre-filled with `undefined`.

**AC-B5.** **Given** an existing service, **when** a `member`+ user clicks "Delete," **then** the control requires a second, explicit confirmation step within the same interaction (e.g. the button relabels to "Confirm delete?" on first click, and only the second click within the same render calls the API) — mirroring this codebase's avoidance of native `window.confirm()` dialogs elsewhere, while still protecting against a single accidental click on a hard-delete with no undo (Story 6.1 AC 7: physically deleted, no soft-delete/tombstone). On confirmed delete, `DELETE /api/v1/projects/:projectId/services/:serviceId` is called and the row is removed from the list without a full page reload (or the user is redirected to the list with the row absent — either is acceptable).
   - *Example (happy path):* click "Delete" → button becomes "Confirm delete?" → click again → `204` → row disappears.
   - *Example (edge — user clicks away instead of confirming):* clicking "Delete" once, then navigating away or clicking a different row's action, does **not** delete anything — the confirmation state must not persist/leak across rows or trigger on an unrelated click.
   - *Example (failure — already deleted, e.g. deleted in another tab):* confirming delete on a row that another session already removed → `404` from the API → the UI shows a brief error and refreshes the list rather than silently pretending success.

---

### C. Certificates (`cert_records`) — list, create, edit, delete

**AC-C1.** **Given** the same list/create/edit/delete shape as Services (AC-B1–B5), **when** applied to `/projects/:projectId/certificates`, **then** the create form's required fields are `domain` and `expiresAt` (both **required**, unlike services — see Background) and `alertLeadDays` optional (server default `[30, 7]`); the edit form allows changing `domain`, `expiresAt`, and `alertLeadDays` (certificates' update schema **does** allow renaming `domain`, unlike services' name — confirm this against `UpdateCertificateBodySchema` in `schema.ts` before assuming the services restriction applies here too).
   - *Example (happy path, create):* `{ domain: "api.example.com", expiresAt: "2026-08-15" }` → `201`, `alertLeadDays: [30, 7]` (default) shown in the resulting row.
   - *Example (failure — missing required `expiresAt`):* client-side validation blocks submission with "Expiry date is required" before any network call (since the server field is non-optional, unlike services' `renewalDate`).
   - *Example (edge — renaming a certificate's `domain` via edit):* `PATCH .../certificates/:certificateId { "domain": "api-v2.example.com" }` → `200`, list/detail reflect the new domain — this is a real, allowed operation for certificates (contrast with AC-B4's services restriction).
   - *Example (failure — `domain` exceeding 253 chars, RFC 1035 max):* client-side length check mirrors the server's bound; a value that somehow bypasses it (e.g. pasted) still gets a clean `422`-mapped error, not a raw stack trace.

**AC-C2.** **And** the certificate list/detail views clearly distinguish `expiresAt` from a renewal date semantically in their labels (e.g. "Expires on," not "Renews on" — certificates use `expiresAt`, not `renewalDate`, per the schema) to avoid the exact kind of domain-language confusion the retro's TD6-1 finding calls out for a different reason (naming precision matters here even though this AC is about display copy, not the underlying table name).

---

### D. Domains (`domain_records`) — list, create, edit, delete

**AC-D1.** **Given** the same list/create/edit/delete shape, **when** applied to `/projects/:projectId/domains`, **then** the create form's required fields are `domainName` and `renewalDate` (both **required** — see Background) and `alertLeadDays` optional (server default `[30]`); the edit form allows changing `domainName`, `renewalDate`, and `alertLeadDays` (domains, like certificates, permit renaming via `UpdateDomainRecordBodySchema`).
   - *Example (happy path, create):* `{ domainName: "example.com", renewalDate: "2027-01-01" }` → `201`, `alertLeadDays: [30]` default shown.
   - *Example (edge — duplicate domain name in the same project):* Story 6.1 AC 3 explicitly **permits** duplicate `domainName` values within a project (e.g. registrar renewal vs. DNS provider renewal tracked separately) — the UI must not add a client-side "this domain already exists" rejection that the API itself doesn't enforce; two rows with the same `domainName` and different `renewalDate`s is valid and must display correctly (e.g. both appear in the list, distinguishable by their different renewal dates, not merged or deduplicated client-side).
   - *Example (failure — missing required `renewalDate`):* client-side validation blocks submission, mirroring AC-C1's certificate case.

---

### E. Service endpoints (`service_endpoints`, HTTP monitors) — list, create, edit, delete

**AC-E1.** **Given** a project with zero registered service endpoints, **when** a `viewer`+ user visits `/projects/:projectId/service-endpoints`, **then** the page shows an honest empty state and, for `member`+, an "Add endpoint" link to `/projects/:projectId/service-endpoints/new`. This is the page that closes AC-A3's "unpopulatable picker" gap and AC-A2's `/health` dead-end.
   - *Example:* identical shape to AC-B1, applied to this resource.

**AC-E2.** **Given** a project with registered endpoints, **when** a `viewer`+ views the list, **then** each row shows `name`, `url` (as returned by the API — already redacted server-side per `redactUrlForDisplay`, the UI does no additional masking or un-masking), a color-coded status badge (`healthy` = green, `degraded` = amber, `down` = red — reuse the existing `ServiceStatusItem.svelte` component from `$lib/components/dashboard/`, already built for Story 6.3's `/health` page, rather than building a second status-badge component), `lastCheckedAt` (or "Not yet checked" if `null`), `checkFrequencyMinutes`, and `downThresholdFailures`.
   - *Example (happy path):* a healthy endpoint shows a green badge and a real `lastCheckedAt` timestamp.
   - *Example (edge — brand-new, never-checked endpoint):* status shows "healthy" (matching the server's initial-state convention, Story 6.2 AC 1 — the UI does not invent a fourth "unknown"/"pending" visual state not present in the API's `'healthy'|'degraded'|'down'` enum) with `lastCheckedAt` rendered as "Not yet checked" rather than a blank cell or `"null"` string.

**AC-E3.** **Given** the "Add endpoint" form, **when** a `member`+ submits `{ name, url, checkFrequencyMinutes?, downThresholdFailures? }`, **then** `POST /api/v1/projects/:projectId/service-endpoints` is called; `checkFrequencyMinutes` is presented as a `<select>` constrained to exactly `[1, 5, 15, 30]` (matching `CHECK_FREQUENCY_MINUTES`, exported from `schema.ts` — import and reuse this exact constant rather than hardcoding the list a second time in the web app), defaulting to `5`; `downThresholdFailures` is a number input `1-10`, defaulting to `2`.
   - *Example (happy path):* `{ name: "API health", url: "https://api.example.com/health" }` (frequency/threshold left at their form defaults, `5`/`2`) → `201`.
   - *Example (failure — endpoint cap reached, `422 service_endpoint_limit_reached`):* the project already has 25 registered endpoints → submission fails with the server's exact message surfaced to the user ("This project has reached its maximum of 25 monitored endpoints"), not a generic error — this is a real, user-actionable limit the UI must not obscure.
   - *Example (failure — SSRF rejection, `422 url_not_allowed`):* a user enters `http://169.254.169.254/` (or any private/loopback/metadata address) → the server's exact rejection message is surfaced ("URL resolves to a private, loopback, or reserved address and cannot be monitored") — the UI does not attempt any client-side SSRF pre-validation of its own (that would require DNS resolution in the browser, which is not possible; this is correctly a server-only check, per ADR-6.2-08).
   - *Example (edge — non-default frequency/threshold):* `checkFrequencyMinutes: 1, downThresholdFailures: 1` → `201`, the health-check scheduler (already running, Story 6.2) picks up the new cadence within its next tick — no UI-side polling/refresh logic is required beyond a normal page reload/revisit to see updated status.

**AC-E4.** **Given** an existing endpoint's edit page, **when** a `member`+ changes `name`, `url`, `checkFrequencyMinutes`, or `downThresholdFailures`, **then** `PATCH .../service-endpoints/:serviceEndpointId` is called with only the changed fields (unlike services, endpoints' update schema **does** allow renaming and re-URLing — confirm against `UpdateServiceEndpointBodySchema`, which mirrors the create body's full field set as all-optional).
   - *Example (happy path — re-URL):* change `url` to a new, valid public URL → `200`, next check uses the new URL; the previously-displayed (already-redacted) `url` value is simply replaced by the new one on the next page load, no stale-redaction handling needed since the raw value is never round-tripped through the UI at all.
   - *Example (failure — new URL also fails SSRF check):* same `422 url_not_allowed` handling as AC-E3.

**AC-E5.** **Given** an existing endpoint, **when** a `member`+ deletes it, **then** the same two-step confirm pattern as AC-B5 applies, and the user is informed (in the confirmation copy) that deleting also cancels pending notifications and marks related alerts as resolved (Story 6.2 AC 3) — e.g. "Deleting this endpoint will also resolve any active alerts for it." — so the action's full effect is not a surprise.
   - *Example (happy path):* delete an endpoint with an active `down` alert → `204`, endpoint disappears from the list; if the alerts panel (AC-F) is open, the now-`resolved_by_deletion` alert either disappears from the "active" view or is shown with a clear "endpoint deleted" annotation (per Background's note that `monitoring_alerts.serviceEndpointId` can be `null` post-deletion).

**AC-E6.** **Given** an endpoint's detail page, **when** a `viewer`+ views it, **then** recent health-check history (`GET .../service-endpoints/:serviceEndpointId/health-history`, paginated, `limit` default `50`) is shown as a simple reverse-chronological list: `checkedAt`, `isHealthy` (as a small icon/label), `statusCode` (or "—"), `latencyMs`, `failureReason` (or "—", only ever non-null when `isHealthy` is false). A "Load more" control (or simple `page` increment) is present since this endpoint **does** paginate (unlike the four list endpoints above).
   - *Example (happy path):* the 50 most recent checks render newest-first.
   - *Example (edge — a check with `failureReason: 'ssrf_blocked'`):* rendered distinctly from `'timeout'`/`'http_error'`/`'network_error'` (e.g. "Blocked (unsafe address)" vs. "Timed out" / "HTTP error" / "Network error") — this is real diagnostic information (ADR-6.2-12) the UI must not collapse into one generic "failed" label.

---

### F. Monitoring alerts — view, snooze, dismiss

**AC-F1.** **Given** the `/projects/:projectId/service-endpoints` list page, **when** the project has ≥1 alert with `status` in `('active', 'snoozed')` (`GET .../alerts?status=active` — note: the API's `status` filter accepts a single value, so an "active or snoozed" view requires either two calls or fetching unfiltered and filtering client-side against the small resulting set; either is acceptable given these lists are unbounded-but-small), **then** an "Active alerts" panel renders above the endpoint list showing each alert's `alertType` (`service.down`/`service.recovery`), `severity`, the originating endpoint's `name` (looked up from the already-fetched endpoint list by `serviceEndpointId`; if `serviceEndpointId` is `null`, per Background, show "Endpoint deleted" instead of crashing on the lookup), and `createdAt`.
   - *Example (happy path):* one `service.down`/`critical` alert for "API health" → panel shows it with a red accent.
   - *Example (edge — zero active alerts):* the panel either doesn't render at all, or renders a small "No active alerts" note — developer's choice, but it must not silently disappear in a way indistinguishable from a loading/error state; be explicit.

**AC-F2.** **Given** an active (non-snoozed, non-dismissed) alert in the panel, **when** a `member`+ clicks "Snooze," **then** a small duration picker (e.g. presets: 30 min / 1 hour / 4 hours / 24 hours, each mapped to `durationMinutes`, capped by the server at `10080` = 7 days) calls `POST .../alerts/:alertId/snooze { durationMinutes }`; on success, the alert's row updates to show "Snoozed until <time>."
   - *Example (happy path):* snooze for 1 hour → `200`, row shows "Snoozed until 3:45 PM."
   - *Example (edge — re-snoozing an already-snoozed alert):* per Story 6.2 AC 9, this extends/replaces `snoozedUntil` rather than erroring — the UI's snooze control remains available (not disabled) on an already-snoozed alert, and a repeat click updates the displayed time.
   - *Example (failure — snoozing a dismissed alert):* the snooze control is not shown at all for a `dismissed` alert (dismissed is terminal, per Story 6.2 AC 10) — this is a UI-side state check, not something that should ever reach the server as a `409` in normal use (though the wrapper must still handle a `409` gracefully if it somehow does, e.g. a stale client state after another session dismissed it — refresh and show the current state rather than a raw error).

**AC-F3.** **Given** an active or snoozed alert, **when** an `admin`+ user (role-gated per Background's note — `member`s and below never see this control) clicks "Dismiss," **then** the same two-step confirm pattern as AC-B5 applies (dismiss is permanent, per Story 6.2 AC 10) and `POST .../alerts/:alertId/dismiss` is called; on success the alert is removed from the "active" panel.
   - *Example (happy path, admin):* dismiss → `200` → alert disappears from the active panel.
   - *Example (failure — a `member` attempting this, defense in depth):* the control is not rendered for a `member`, so this case should not arise from the UI itself; if reached anyway (e.g. a role downgrade mid-session), the resulting `403` is caught and shown as a plain error banner, not an unhandled exception.
   - *Example (edge — dismissing an already-snoozed alert):* per Story 6.2 AC 10, this transitions `snoozed → dismissed` cleanly (not an error) — the UI's dismiss control remains available on a snoozed alert, same as AC-F2's snooze-on-already-snoozed case.

---

### G. Project dashboard — surface real monitored-service health (G3 dashboard truth)

**AC-G1.** **Given** `packages/shared/src/schemas/dashboard.ts`'s `ProjectDashboard.monitoredServiceHealth` (`{ healthy, degraded, down }`) is already computed from real `service_endpoints` data by the backend (Story 6.2 AC 15, `dashboard-stats.ts`) but is **not currently rendered anywhere in the web app** (verified: no `.svelte`/`.ts` file under `apps/web/src` references `monitoredServiceHealth` as of this story's creation), **when** a user views a saved project's dashboard (`/dashboard?project=:projectId` or equivalent — the existing per-project section of `apps/web/src/routes/(app)/dashboard/+page.svelte`), **then** a new stat tile is added alongside the existing "Credentials" / "Expiring soon" / "Alerts" tiles, showing e.g. "3 healthy · 1 degraded · 0 down" (or a per-status mini-breakdown), sourced directly from `data.dashboard.monitoredServiceHealth` — no new API call is needed, this data already flows to the page via the existing dashboard load function.
   - *Example (happy path):* a project with 3 healthy, 1 degraded, 0 down endpoints shows the real breakdown.
   - *Example (edge — zero endpoints registered):* shows "0 healthy · 0 degraded · 0 down" — a real, honest zero (the data pipeline already distinguishes this from a hardcoded placeholder per Story 6.2's own test coverage), not omitted or hidden.
   - *Example (failure mode to avoid):* do **not** hide the tile entirely when all values are zero — that would make "no endpoints registered yet" indistinguishable from "the tile failed to load," which is itself a truth-in-dashboards violation in the other direction (an empty state must say so, not disappear).

---

### H. Stale placeholder-copy correction

**AC-H1.** **Given** `apps/web/src/lib/components/dashboard/dashboard-copy.ts`'s `suggestedActionLabels.add_service` currently reads `'Add first service - available in Epic 6'` (a claim that stopped being true the moment 6.1 shipped its API, and is fully false now that this story ships the UI), **when** this story lands, **then** the copy is corrected to reflect a working feature, e.g. `'Add first service'` (matching the sibling label `add_credential: 'Add first credential'`'s plain, no-caveat phrasing) — with no residual "Epic 6" or "coming soon" language anywhere in this file after the change.
   - *Example (before → after):* `'Add first service - available in Epic 6'` → `'Add first service'`.
   - *Example (regression check):* `forbiddenDashboardClaims` (same file) already asserts against fabricated success language elsewhere — this AC's change must not introduce a new violation of that list (e.g. do not overcorrect into "All services healthy" or similar).

**AC-H2.** **And** `dashboardEmptyStateCopy.noCertificates` (*"No certificate or domain records added yet."*) and `.noServices` (*"No monitored services configured yet."*) — both still accurate as plain empty-state descriptions, not "coming soon" claims — are **left unchanged**; do not over-edit copy that was already honest. This AC exists to make the boundary explicit: AC-H1 fixes a false claim, it does not license a rewrite of every string in the file.

**AC-H3.** **And** `DashboardPlaceholderGrid.svelte`'s two "when X arrives" sentences (*"When service monitoring arrives, this area will show..."*, and the Story-2.1-referencing coverage-gap copy) are scoped to the **preview-only unsaved-project** empty state (`ProjectDashboardEmptyState.svelte`, confirmed by reading the component tree) — this is a legitimately different, still-accurate context (a project that has never been saved literally has no services, by construction) and is explicitly **out of scope** for this AC. Do not touch `DashboardPlaceholderGrid.svelte` or its copy in this story; only `dashboard-copy.ts`'s `suggestedActionLabels.add_service` (AC-H1) is in scope.

---

### I. Role-based UI gating (mirrors backend authorization exactly)

**AC-I1.** **Given** every mutation this story adds (create/edit/delete for services/certificates/domains/service-endpoints, snooze) requires `member`+ org role, and alert-dismiss requires `admin`+, **when** a `viewer` or `member` (for dismiss) visits any of these pages, **then** the corresponding control is not rendered at all (not merely `disabled`) — mirroring `canCreateCredential(data.orgRole)`'s existing pattern of conditionally rendering, not disabling, restricted controls.
   - *Example (viewer, services page):* no "Add service" link, no "Edit"/"Delete" buttons per row — only the read-only list.
   - *Example (member, alerts panel):* "Snooze" visible and enabled; "Dismiss" not rendered at all.
   - *Example (admin, alerts panel):* both "Snooze" and "Dismiss" visible and enabled.

**AC-I2.** **And** every new `+page.server.ts` load function calls `requireUser(locals)` (redirects unauthenticated visitors to `/login`, mirroring every other project sub-page) before making any API call — an unauthenticated direct-URL visit to any new route never reaches a partially-rendered authenticated view.
   - *Example:* an unauthenticated request to `/projects/proj-1/services` → `303` redirect to `/login`, matching `credentials/+page.server.ts`'s existing behavior exactly.

---

### J. `AuditEvent` dual-listing consolidation (P6-3)

**AC-J1.** **Given** `packages/shared/src/constants/audit-events.ts` currently declares the `AuditEvent` const object (the actual runtime values used at every call site) and then separately re-declares **every one of those same string values again**, by hand, as literal members of the `AuditEventType` union (lines 84-142 as of this story's creation) — a genuinely fragile pattern already flagged as debt in 6.1/6.2/6.3's own Dev Notes and reproduced three times — **when** this story consolidates it, **then** `AuditEventType` is derived from the `AuditEvent` object itself (the file already has the machinery to do this: `AuthAuditEventType = (typeof AuditEvent)[keyof typeof AuditEvent]`, which is **already** a complete, always-in-sync derivation of every value in the object) rather than hand-restating every string a second time.
   - **Concrete refactor:** `AuditEventType` should become `AuthAuditEventType` directly (or `AuthAuditEventType` should be renamed to `AuditEventType` and the redundant declaration removed — developer's choice on naming, but the end state must have exactly one place where the set of valid audit-event strings is enumerated: the `AuditEvent` const object itself).
   - *Example (before):* adding a new audit event required editing two places (the object **and** the union) — miss the second and you get a type-checking gap with no runtime symptom (exactly the "easy to silently under-cover" fragility the retro named).
   - *Example (after):* adding a new audit event requires editing **one** place (the `AuditEvent` object); the type derives automatically.
   - *Example (regression check, must still pass unchanged):* every existing assertion in `packages/shared/src/constants/audit-events.test.ts` (e.g. `expect(AuditEvent.PAYMENT_RECORD_CREATED).toBe('payment_record.created')`) continues to pass — this is a type-declaration change, not a value change.

**AC-J2.** **And** the two dead literal members present in the current `AuditEventType` union but **absent from the `AuditEvent` object entirely** — `'user.login'` and `'user.logout'` (verified: `grep -rn "'user\.login'\|'user\.logout'"` across `apps/`/`packages/` shows these two strings used only as arbitrary test-fixture literals in `packages/db/src/__tests__/*.test.ts` and `packages/db/src/test-helpers.test.ts`, against the plain-`text` `event_type` column — never against the `AuditEvent` registry) are **not** silently carried forward into the consolidated type. Since the `event_type` column is plain `text` (not a DB-level enum) and those tests pass an arbitrary string deliberately (to test generic audit-log mechanics, not a real registered event type), removing these two from the type has **zero effect on any passing test** — confirm this by running the full `packages/db` test suite after the change and observing no new failures, rather than assuming it's safe.
   - *Example (before):* `AuditEventType` included `'user.login'`/`'user.logout'` even though nothing in `AuditEvent` produces them and nothing imports `AuditEventType` to type-check against them (verified: no `import.*AuditEventType` exists anywhere outside `audit-events.ts` itself, and every real call site's `eventType` parameter is typed as plain `string`, e.g. `apps/api/src/lib/audit-or-fail-closed.ts:26`).
   - *Example (after):* these two strings are simply gone from the type (they were never real registered events); the type now exactly mirrors the object's actual values, with nothing extra and nothing missing.
   - *Example (safety net):* run `pnpm --filter @project-vault/db test` and `pnpm --filter @project-vault/shared test` after the change — both must pass unchanged, since the `text`-typed `event_type` column never enforced this union at runtime in the first place.

**AC-J3.** **And** the internal `AuditEvent` **type** (a second, differently-shaped thing in the same file — the shape of one audit-log entry: `{ type, actorId, orgId, resourceId?, metadata?, timestamp }`, name-colliding with but distinct from the `AuditEvent` const object) is left structurally unchanged by this consolidation except that its `type` field's type reference now points at the consolidated union — verify via `pnpm typecheck` (root) that nothing consuming this type breaks.
   - *Example:* `pnpm typecheck` passes across all packages (`apps/api`, `apps/web`, `packages/shared`, `packages/db`) after the consolidation — this is the same wiring-verification step every prior Epic 6 story ran, applied here to a `packages/shared`-only change instead of a new backend route.

---

## Tasks / Subtasks

- [ ] Task 1 — Project sub-nav wiring (AC: A1, A2, A3)
  - [ ] Add "Services" / "Certificates" / "Domains" / "Endpoints" links to the `<nav>` block in `apps/web/src/routes/(app)/projects/[projectId]/credentials/+page.svelte` (mirror the existing "Members"/"Public status page" links exactly).
  - [ ] Update `apps/web/src/routes/(app)/health/+page.svelte`'s empty-state copy and per-project cards per AC-A2.
  - [ ] Update `apps/web/src/routes/(app)/projects/[projectId]/status-page/+page.svelte`'s service-picker empty state per AC-A3.

- [ ] Task 2 — API wrappers [Source: `apps/api/src/modules/monitoring/schema.ts` — read directly for exact field names/types before writing any wrapper]
  - [ ] Create `apps/web/src/lib/api/services.ts` (list/get/create/update/delete against `/api/v1/projects/:projectId/services`, mirroring `credentials.ts`'s wrapper shape).
  - [ ] Create `apps/web/src/lib/api/certificates.ts` (same shape, `/certificates`).
  - [ ] Create `apps/web/src/lib/api/domains.ts` (same shape, `/domains`).
  - [ ] Extend (do not replace) `apps/web/src/lib/api/service-endpoints.ts` with `createServiceEndpoint`/`updateServiceEndpoint`/`deleteServiceEndpoint`/`getServiceEndpoint`/`getHealthHistory`.
  - [ ] Create `apps/web/src/lib/api/monitoring-alerts.ts` (`listAlerts`/`snoozeAlert`/`dismissAlert` against `/api/v1/projects/:projectId/alerts`).
  - [ ] Add a small role-gating helper alongside `apps/web/src/lib/credentials/permissions.ts` (or a new sibling file, e.g. `apps/web/src/lib/monitoring/permissions.ts`) exposing `canManageMonitoredAssets(orgRole)` (`member`+) and `canDismissAlert(orgRole)` (`admin`+) — reuse across all new pages rather than inlining role checks per-component.

- [ ] Task 3 — Services pages (AC: B1-B5)
  - [ ] `apps/web/src/routes/(app)/projects/[projectId]/services/+page.server.ts` + `+page.svelte` (list).
  - [ ] `.../services/new/+page.svelte` (create form, no `+page.server.ts` needed if it mirrors `credentials/new`'s client-only-submit pattern).
  - [ ] `.../services/[serviceId]/+page.server.ts` + `+page.svelte` (detail/edit/delete).

- [ ] Task 4 — Certificates pages (AC: C1-C2) — same structure as Task 3, under `certificates/`.

- [ ] Task 5 — Domains pages (AC: D1) — same structure as Task 3, under `domains/`.

- [ ] Task 6 — Service endpoints pages (AC: E1-E6) — same structure as Task 3, under `service-endpoints/`, plus:
  - [ ] Reuse `$lib/components/dashboard/ServiceStatusItem.svelte` for status badges (do not build a second status-badge component).
  - [ ] `.../service-endpoints/[serviceEndpointId]/+page.svelte` includes the health-history list (AC-E6) with pagination.

- [ ] Task 7 — Monitoring alerts panel (AC: F1-F3)
  - [ ] Build the "Active alerts" panel as a component embedded in the service-endpoints list page (not a separate route) — e.g. `apps/web/src/lib/components/monitoring/ActiveAlertsPanel.svelte`.
  - [ ] Wire snooze (duration presets) and dismiss (role-gated, two-step confirm) actions.

- [ ] Task 8 — Dashboard `monitoredServiceHealth` tile (AC: G1) [Source: `apps/web/src/routes/(app)/dashboard/+page.svelte`]
  - [ ] Add the new stat tile to the existing per-project dashboard `<dl>` grid, sourced from `data.dashboard.monitoredServiceHealth` (already present in the load data, no new fetch).

- [ ] Task 9 — Stale copy correction (AC: H1-H3) [Source: `apps/web/src/lib/components/dashboard/dashboard-copy.ts`]
  - [ ] Change `suggestedActionLabels.add_service` only; verify no other string in the file needs touching per AC-H2/H3's explicit boundary.

- [ ] Task 10 — Role gating verification (AC: I1-I2)
  - [ ] Every new `+page.server.ts` calls `requireUser(locals)`.
  - [ ] Every mutation control conditionally rendered via the Task 2 permissions helper, not `disabled`.

- [ ] Task 11 — `AuditEvent` consolidation (AC: J1-J3) [Source: `packages/shared/src/constants/audit-events.ts`, `audit-events.test.ts`]
  - [ ] Derive `AuditEventType` from the `AuditEvent` object; remove the hand-duplicated union members.
  - [ ] Confirm `'user.login'`/`'user.logout'` removal has zero effect on `packages/db`'s test suite (these appear only as arbitrary text-fixture literals, not against the registry — re-verify via grep before assuming, per AC-J2).
  - [ ] Run `pnpm typecheck` (root, all packages) and the full `packages/shared`/`packages/db` test suites.

- [ ] Task 12 — Tests (AC: all)
  - [ ] Component tests (`@testing-library/svelte`, mirror `apps/web/src/routes/status/[token]/page.test.ts`'s pattern) for: services/certificates/domains/service-endpoints list+create+edit+delete happy/edge/failure paths; role-gated control visibility (viewer/member/admin); alerts panel snooze/dismiss; dashboard tile rendering (zero and non-zero cases); dashboard-copy regression test asserting `suggestedActionLabels.add_service` no longer contains "Epic 6".
  - [ ] `packages/shared/src/constants/audit-events.test.ts` — all existing assertions still pass; add a test asserting `AuditEventType`/`AuthAuditEventType` are structurally the same type going forward (e.g. a compile-time check or a runtime assertion that every `AuditEvent` value is assignable to the union) so a future entry added to the object can't silently diverge from the type again.
  - [ ] Manual mobile-viewport check (375×812) of the new pages — reuse the existing `sm:`-breakpoint Tailwind conventions already used throughout the app (per 6.3's own precedent, code-review-verified rather than a captured screenshot, given the noted browser-tooling viewport limitation).

- [ ] Task 13 — Wiring verification (AC: all)
  - [ ] `pnpm typecheck` (root, all packages).
  - [ ] `pnpm --filter @project-vault/web test`, `pnpm --filter @project-vault/shared test`, `pnpm --filter @project-vault/db test` all green.
  - [ ] No `route-audit.test.ts` impact expected (no new backend routes) — run it anyway as a cheap regression check.

---

## Dev Notes

- **This is a UI-only closure story — resist the urge to "fix" anything backend.** Every backend behavior referenced above (validation bounds, role requirements, redaction, pagination-or-not) is already shipped, reviewed, and tested by Stories 6.1/6.2. If a UI requirement in this story seems to need a backend change to implement cleanly, stop and re-read `schema.ts`/the relevant story file — the answer is very likely "the UI must adapt to the existing contract," not "the backend needs a new field."
- **Reuse over new components:** `ServiceStatusItem.svelte`, `FormSubmitRow.svelte`, `AccessNotice.svelte`, `apiFetch`/`ApiClientError`, and `requireUser` all already exist and are directly reusable across every new page this story adds. A dev agent that builds five near-identical bespoke form components instead of one shared pattern (mirroring `credentials/new`'s exact shape four times, once per resource) has misread this story's intent.
- **Forward-looking, explicitly not this story's scope:** the org-wide `security_alerts` surface (Story 3.4/6.2's `security.failed_auth_threshold`/`security.anomalous_access`, `GET/POST .../organizations/:orgId/security-alerts`) has no web UI either, and is a real, separate gap — but it is an org-level security concern, not a "monitored asset," and the epic-6 retro's action items don't name it. Do not fold it into this story's scope; if it needs closing, that's a future story (likely against Epic 8's audit/compliance surface, given its adjacency to `audit_log_entries`).
- **`payment_records`/"Services" naming (TD6-1):** keep every UI-facing string, component name, and route segment using "Services"/"service" — never leak the physical table name `payment_records` into anything user-visible or into new component/file names. The API wrapper file is named `services.ts` (not `payment-records.ts`) for exactly this reason, mirroring how `service-endpoints.ts` already names itself after its route.
- **Two-step delete/dismiss confirmation is a new, small UI pattern this story introduces** (this codebase currently has no destructive-action confirmation control anywhere — `status-page`'s "Disable" button calls the API directly with no confirmation step at all). Since services/certificates/domains/service-endpoints are all hard-deleted with no tombstone (Story 6.1 AC 7, Story 6.2 AC 3), and alert-dismiss is permanent (Story 6.2 AC 10), this story is a reasonable place to introduce the pattern — keep it simple (a same-button relabel-and-reclick, not a modal dialog) so it doesn't become its own mini design system. If a shared `ConfirmButton`-style component would reduce duplication across the ~5 places this pattern is needed (services/certificates/domains/service-endpoints delete, alert dismiss), building one small shared component is encouraged over copy-pasting the state logic five times.
- **`AuditEventType` consolidation (AC-J) is a `packages/shared`-only change** — it has no interaction with the UI work in this story beyond both living in the same closure story. It can be implemented and tested independently of Tasks 1-10; consider doing it first or last, whichever the dev agent finds convenient, since neither ordering creates a dependency on the other.

### Project Structure Notes

- New web routes: `apps/web/src/routes/(app)/projects/[projectId]/services/` (+ `new/`, `[serviceId]/`), `.../certificates/` (+ `new/`, `[certificateId]/`), `.../domains/` (+ `new/`, `[domainId]/`), `.../service-endpoints/` (+ `new/`, `[serviceEndpointId]/`).
- New web API wrappers: `apps/web/src/lib/api/services.ts`, `certificates.ts`, `domains.ts`, `monitoring-alerts.ts`; extends existing `service-endpoints.ts`.
- New shared component (optional but recommended, see Dev Notes): a two-step confirm control, e.g. `apps/web/src/lib/components/forms/ConfirmDeleteButton.svelte`.
- New component: `apps/web/src/lib/components/monitoring/ActiveAlertsPanel.svelte`.
- New permissions helper: `apps/web/src/lib/monitoring/permissions.ts` (or equivalent).
- Modified: `apps/web/src/routes/(app)/projects/[projectId]/credentials/+page.svelte` (nav links), `apps/web/src/routes/(app)/health/+page.svelte` (empty-state link, per-project "Manage endpoints" link), `apps/web/src/routes/(app)/projects/[projectId]/status-page/+page.svelte` (picker empty-state link), `apps/web/src/routes/(app)/dashboard/+page.svelte` (new stat tile), `apps/web/src/lib/components/dashboard/dashboard-copy.ts` (one string), `packages/shared/src/constants/audit-events.ts` (type consolidation).
- No changes to `apps/api/`, `packages/db/` (schema/migrations), or any route registration file — this story touches zero backend route surface.

### References

- [Source: `_bmad-output/implementation-artifacts/epic-6-retro-2026-07-06.md`] — action items A6-1, A6-2, P6-3; finding #1 (PSC gap, critical), finding #4 (AuditEvent dual-listing, medium).
- [Source: `_bmad-output/implementation-artifacts/6-1-service-certificate-and-domain-record-management.md`] — services/certificates/domains schema, routes, and the original PSC flag this story closes; ADR-6.1-01/02/03.
- [Source: `_bmad-output/implementation-artifacts/6-2-http-endpoint-monitoring-and-availability-alerts.md`] — service-endpoints/monitoring-alerts schema, routes, role requirements (ADR-6.2-04's admin-only dismiss), redaction (ADR-6.2-11), status enum definition (ADR-6.2-03).
- [Source: `_bmad-output/implementation-artifacts/6-3-cross-project-health-dashboard-and-public-status-page.md`] — `/health` dashboard, status-page admin picker, `ServiceStatusItem.svelte`, `monitoredServiceHealth` already-wired-by-6.2 note (ADR-6.3-08).
- [Source: `apps/api/src/modules/monitoring/schema.ts`] — canonical field names/types/bounds for every resource this story's UI consumes; read directly, do not rely solely on the story-file summaries above.
- [Source: `apps/api/src/modules/monitoring/routes.ts`] — canonical route list, role requirements (`minimumRole`), rate limits.
- [Source: `packages/shared/src/constants/audit-events.ts`, `audit-events.test.ts`] — AC-J's consolidation target and regression baseline.
- [Source: `apps/web/src/lib/api/credentials.ts`, `status-page.ts`, `service-endpoints.ts`] — API wrapper conventions to mirror/extend.
- [Source: `apps/web/src/routes/(app)/projects/[projectId]/credentials/new/+page.svelte`] — create-form pattern to mirror for every new resource.
- [Source: `apps/web/src/routes/(app)/projects/[projectId]/status-page/+page.server.ts`, `+page.svelte`] — project-scoped load-function and role-gating pattern to mirror.
- [Source: `apps/web/src/routes/(app)/health/+page.svelte`, `+page.server.ts`] — existing cross-project dashboard this story adds navigation into.
- [Source: `apps/web/src/lib/components/dashboard/dashboard-copy.ts`, `ProjectDashboardEmptyState.svelte`, `DashboardPlaceholderGrid.svelte`] — AC-H's exact scope boundary between the one string that changes and the strings that don't.
- [Source: `apps/web/src/lib/components/shell/nav-model.ts`] — confirms the fixed top-level nav this story must not add an entry to.
- [Source: `apps/web/src/routes/status/[token]/page.test.ts`] — component-test pattern to mirror for this story's new pages.
- [Source: `packages/shared/src/schemas/dashboard.ts`] — `ProjectDashboard.monitoredServiceHealth` shape (AC-G1).
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

## Dev Agent Record

### Agent Model Used

_To be filled in by the dev agent during implementation._

### Debug Log References

### Completion Notes List

### File List
