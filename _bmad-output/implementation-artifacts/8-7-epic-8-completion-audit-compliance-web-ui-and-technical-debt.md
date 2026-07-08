# Story 8.7: Epic 8 Completion — Audit & Compliance Web UI and Technical Debt

Status: ready-for-dev

<!-- Story derived from epic-8-retro-2026-07-07.md's Finding 2 + Action Item A8-1. Closes the
     audit/compliance web UI gap flagged identically, in near-verbatim language, by Stories 8.1,
     8.2, 8.3, and 8.4's own Product Surface Contract sections — none of the four Epic 8 stories
     ships a web screen; all four are "api"-only with a "TBD" linked-UI-story field, each pointing
     at "Epic 8 sprint planning/retrospective" as the place this would get resolved. It sat
     unresolved through all four stories until this retro. This is the exact "flag it in prose,
     catch it at the next retro" pattern the project's own retros have now diagnosed four times
     (Epic 6's P6-1, Epic 7's P7-1, and twice more inside Epic 8 itself) — this story is the fix
     for THIS occurrence, following the closure-story precedent already used for Epic 2 (2-8),
     Epic 3 (3-4), Epic 5 (5-4/5-5), Epic 6 (6-4), and Epic 7 (8-6). `epic-8` stays `in-progress`
     until this story lands (Product Surface Contract G2 gate). Deferred-work.md's "Web UI gaps"
     table already records this exact scope as "Resolved 2026-07-07 (Epic 8 retro): scheduled as
     8-7-epic-8-completion-audit-compliance-web-ui-and-technical-debt." -->

<!-- Adversarial review (2026-07-07, see sibling file
     8-7-epic-8-completion-audit-compliance-web-ui-and-technical-debt-adversarial-review.md)
     surfaced 16 findings (1 critical, 2 high, 8 medium/medium-low, 5 low) against this story
     before any implementation began. All 16 were resolved directly in this story file pre-dev
     (not deferred to a follow-up story) — see the adversarial-review file for the original finding
     text and inline "(adversarial review, <severity>)" annotations throughout this file for where
     each fix landed. Notable corrections: AC-M1's piiRetained shape now matches
     ErasureReportResponseSchema exactly (was a critical fabrication risk); the endpoint inventory
     table now lists real per-row full paths instead of a single incorrect blanket prefix claim;
     AC-G3/D3 gained a third, real download mechanism (triggerTextDownload) instead of punting to
     "confirm at implementation time." -->

## Story

As Dana, Project Vault's Security & Compliance Lead (and any org owner/admin standing in for that
role on a smaller team),
I want a web UI for searching/exporting/forwarding the audit log, configuring retention, running
point-in-time access reports, managing dormant-user alerts, and running the erasure-request
review→confirm→execute workflow with a downloadable compliance report,
so that Project Vault's compliance and governance capabilities — already fully built and tested on
the backend by Stories 8.1 through 8.4 — are actually usable by someone without `curl` or the
Swagger UI, and Epic 8 can close without leaving its own governance-facing UI gap untracked for a
fifth story running.

*Closes: Epic 8 retrospective Finding 2 / Action Item A8-1.* [Source: `_bmad-output/implementation-artifacts/epic-8-retro-2026-07-07.md`]

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `web` — this story adds **zero new backend routes, zero new database tables, zero new migrations**. Every API endpoint this story's UI calls already exists, shipped `done` by Stories 8.1–8.4, each covered by its own story's integration tests. |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — this story **is** the linked follow-up all four of 8.1/8.2/8.3/8.4 pointed to via their `TBD` field. |
| **Honest placeholder AC** (if UI deferred) | N/A — nothing is deferred further. Two narrow, explicitly-scoped limitations are carried forward from this codebase's own existing precedent (no `GET` readback for forwarding/retention/dormancy-threshold config — see Key Design Decision D2) and documented as accepted UI copy, not silently hidden gaps. |
| **Persona journey** | See below |

### Persona journey stub

**Dana (Security & Compliance Lead, org owner role):** Ahead of a SOC 2 audit, Dana opens Settings → **Audit & Compliance** → **Access Report**, picks `asOf = 2026-03-01`, and gets a paginated table of every user, their org role, and their per-project roles as they stood on that date — including a user who has since left the org entirely, reconstructed from the audit log's own history (Story 8.3's replay engine). She downloads it as CSV for the audit binder. Separately, she opens **Audit & Compliance** → **Search & Export**, filters by `eventType = credential.access` and a date range, sees the matching rows in a table, and triggers a CSV export — the export panel shows the mandatory integrity check running first ("1,247 records verified — no tampering detected") before the download link appears. She configures a 400-day retention policy and a webhook forwarder pointing at the org's SIEM ingest endpoint.

**Riley (org owner, responds to a dormant-account finding):** Riley opens **Alerts** (the existing Notifications inbox) and sees a new "Dormant user alerts" section alongside the existing machine-key dormancy section: `jsmith@example.com` hasn't been active in 94 days. Riley clicks **Deactivate account** (reusing Story 4.3's existing action) — or, for a departed employee, follows the "Pseudonymize identity" link into Settings → Users, types the user's email to confirm, and their audit-trail identity is permanently replaced with an alias, closing the compliance loop on this account without touching a single historical audit row's integrity.

**Alex (org admin, handles a GDPR erasure request):** A former contractor formally requests erasure. Alex opens Settings → Users, finds the user's row, clicks **Request erasure**, types a reason, and reviews the generated PII inventory (7 tables, 23 rows, listed fields) before anything is touched. Alex hands the review off to Casey (org owner), who opens the same request page, types the user's exact email to confirm, and clicks **Execute erasure** — an irreversible action clearly labeled as such. Once complete, Alex downloads the compliance report (JSON) as the auditable artifact proving what was removed, what was retained, and why.

---

## Background: What Already Exists (Read Before Coding)

This story adds a web UI on top of an already-shipped, already-tested backend. Do not
re-implement, re-validate, or "helpfully" extend any backend behavior described below — treat
`apps/api/src/modules/audit/`, `apps/api/src/modules/compliance/`, and the relevant handlers in
`apps/api/src/modules/org/` as stable, already-reviewed dependencies. This section exists so the
dev agent does not have to re-read all of 8.1–8.4 to find these facts.

### Full endpoint inventory this story's UI consumes

**Correction (adversarial review, high):** these endpoints are registered across **three
different route-prefix families**, not uniformly under `/api/v1/org` — do not assume a single
prefix and string-concatenate paths. The `Full path` column below is the literal path to call;
verify against `apps/api/src/app.ts` (prefix registrations) if anything here ever looks stale.

| Endpoint (relative) | Full path | Registered by (`app.ts` prefix) | Role gate | MFA | Source story | Consumed by AC group |
|---|---|---|---|---|---|---|
| `GET /audit/verify?from=&to=` | `/api/v1/org/audit/verify` | `auditRoutes`, prefix `/api/v1/org` (`app.ts:244`) | `owner` only | no (security-visibility GET, `mfa-policy-matrix.md:62`) | 8.1 | D |
| `GET /audit/events?actorId=&eventType=&resourceId=&projectId=&from=&to=&page=&limit=` | `/api/v1/org/audit/events` | `auditRoutes`, `/api/v1/org` (`app.ts:244`) | `owner` only | no | 8.2 | B |
| `POST /audit/export { from, to, format: "csv", includeIntegrityReport }` | `/api/v1/org/audit/export` | `auditRoutes`, `/api/v1/org` (`app.ts:244`) | `owner` only | requireMfa: true | 8.2 | C |
| `GET /audit/exports/:jobId` | `/api/v1/org/audit/exports/:jobId` | `auditRoutes`, `/api/v1/org` (`app.ts:244`) | `owner` only | no | 8.2 | C |
| `GET /audit/exports/:jobId/download` | `/api/v1/org/audit/exports/:jobId/download` | `auditRoutes`, `/api/v1/org` (`app.ts:244`) | `owner` only | no | 8.2 | C |
| `PUT /audit/forwarding { type, config }` | `/api/v1/org/audit/forwarding` | `auditRoutes`, `/api/v1/org` (`app.ts:244`) | `admin`+ (`minimumRole: 'admin'`) | requireMfa: true | 8.2 | E |
| `PUT /audit/retention { retentionDays }` | `/api/v1/org/audit/retention` | `auditRoutes`, `/api/v1/org` (`app.ts:244`) | `admin`+ | requireMfa: true | 8.2 | F |
| `POST /audit/access-report { asOf?, page, limit, format }` | `/api/v1/org/audit/access-report` | `auditRoutes`, `/api/v1/org` (`app.ts:244`) | `owner` only | no | 8.3 | G |
| `GET /security-alerts?status=` (existing, Epic 1, extended by 7.2/8.3) | `/api/v1/org/security-alerts` | `orgRoutes`, `/api/v1/org` (`app.ts:243`) | `owner`+`admin` | no | 1 / 8.3 | H |
| `POST /security-alerts/:alertId/dismiss { reason }` (existing, generic) | `/api/v1/security-alerts/:alertId/dismiss` — **not** under `/api/v1/org`, despite the similar-looking GET above living there | `securityAlertActionsRoutes`, prefix `/api/v1/security-alerts` (`app.ts:281`) | `owner`+`admin` | requireMfa: true | Epic 1 | H |
| `POST /users/:userId/deactivate` (existing, unchanged) | `/api/v1/org/users/:userId/deactivate` | `orgRoutes`, `/api/v1/org` (`app.ts:243`) | `admin`+ | requireMfa: true | 4.3 | H |
| `PATCH /organizations/:orgId/user-dormancy-settings { userDormancyThresholdDays }` | `/api/v1/organizations/:orgId/user-dormancy-settings` — **note the plural `organizations`, a distinct prefix from every other row's `org`** | `organizationSettingsRoutes`, prefix `/api/v1/organizations` (`app.ts:282`) | `admin`+ | requireMfa: true | 8.3 | I |
| `POST /users/:userId/pseudonymize { confirmUserId }` | `/api/v1/org/users/:userId/pseudonymize` | `orgRoutes`, `/api/v1/org` (`app.ts:243`) | `owner` only | requireMfa: true | 8.3 | J |
| `POST /users/:userId/erasure-request { reason, requestedBy }` | `/api/v1/org/users/:userId/erasure-request` | `erasureRoutes`, `/api/v1/org` (`app.ts:245`) | `admin`+ | requireMfa: true | 8.4 | K |
| `POST /users/:userId/erasure-request/:requestId/execute { confirm: true }` | `/api/v1/org/users/:userId/erasure-request/:requestId/execute` | `erasureRoutes`, `/api/v1/org` (`app.ts:245`) | `owner` only | requireMfa: true | 8.4 | L |
| `GET /users/:userId/erasure-request/:requestId/report` | `/api/v1/org/users/:userId/erasure-request/:requestId/report` | `erasureRoutes`, `/api/v1/org` (`app.ts:245`) | `admin`+ | requireMfa: true | 8.4 | M |

**Two rows above are the exceptions to watch for:** the dismiss-alert endpoint (`/api/v1/security-alerts/...`)
and the user-dormancy-settings endpoint (`/api/v1/organizations/...`) — everything else in this
table is under `/api/v1/org` (singular, no trailing segment before the resource). A client wrapper
that blindly prefixes every path in this table with `/api/v1/org` will 404 on exactly those two
calls (AC groups H and I).

**No `GET` endpoints exist for reading back current forwarding config, current retention config, or
the current dormancy threshold.** This mirrors the exact limitation Story 8.6 already accepted for
the machine-key dormancy threshold (`8-6-...md`'s Completion Notes: "the web control is a 'set a new
threshold' selector with no pre-populated current value"). This story's Prerequisites/Dev Notes
explicitly forbid adding new backend endpoints to work around this — see Key Design Decision D2.

### Existing conventions this story must reuse, not reinvent

- **`DataTable.svelte`** (`apps/web/src/lib/components/tables/DataTable.svelte`, built by Story
  8.6 for jscpd de-duplication) — reuse for the audit-events search table and the access-report
  table rather than hand-rolling a third `<table>` markup block.
- **`ConfirmDeleteButton.svelte`** (`apps/web/src/lib/components/forms/ConfirmDeleteButton.svelte`)
  — the two-step "click once to arm, click again to confirm" pattern already used by Stories 6.4
  and 8.6 for every irreversible action in this app. Reuse for: dismiss-with-reason, deactivate,
  pseudonymize, and erasure-execute. Do not invent a fourth confirmation pattern.
- **`toDormancyAlertViews()` / `DormancyAlertView`** shape
  (`apps/web/src/lib/notifications/dormancy-alerts.ts`, Story 8.6) — this story adds a sibling
  `toUserDormancyAlertViews()` function following the exact same filter/map shape, keyed on
  `alertType === 'user.dormant'` instead of `'machine_key.dormant'`, reading
  `userDormantPayloadSchema`'s fields (`userId`, `displayName`, `orgRole`, `lastActiveAt`).
- **`requireUser(locals)`** (`apps/web/src/lib/server/require-user.js`) — every new
  `+page.server.ts` load function calls this before any API call, exactly like every existing
  authenticated page.
- **`ApiClientError`** (`apps/web/src/lib/api/client.js`) — the existing pattern of catching a
  `403`/`404`/`409`/`410`/`422` and mapping it to a friendly page state, not letting it bubble as
  an unhandled 500. Every new API client wrapper in `apps/web/src/lib/api/` follows the same
  `apiFetch<T>(fetchFn, path, init)` shape as every existing file in that directory (e.g.
  `security-alerts.ts`, `organization-settings.ts`).
- **`/settings/+page.svelte`**'s existing tile-list pattern (`<ul class="divide-y ...">` of
  `<a>` rows, each with a title + one-line description + a `→` affordance) — this story adds
  exactly one new tile, "Audit & Compliance," linking to `/settings/audit`.

---

## Retro Traceability Matrix

| Finding | Source | AC group |
|---|---|---|
| No web UI exists anywhere for audit log search/filter/export/forwarding/retention config | 8.1/8.2 Product Surface Contract ("TBD" gap); `epic-8-retro-2026-07-07.md` Finding 2 | B, C, D, E, F |
| No web UI for point-in-time access reports or dormant-user alert admin actions | 8.3 Product Surface Contract; retro Finding 2 | G, H, I, J |
| No web UI for the erasure-request review→confirm→execute flow or compliance-report download | 8.4 Product Surface Contract; retro Finding 2 | K, L, M |
| Deferred-work.md's "Web UI gaps" table row for this scope needed a real story number | `deferred-work.md` §"Audit/compliance management" | Entire story |

*(This story's scope is deliberately narrow to the UI gap Finding 2 identifies. The retro's other
Epic 8 findings — story-status/sprint-status drift (Finding 1, resolved directly during the retro),
Story 8.6's missing adversarial review (Finding 3, owned separately by Dana as A8-2), the
`epic-8:` sprint-status comment (Finding 4/A8-4), and the `epics.md` naming-reconciliation doc line
(Finding 5/A8-5) — are explicitly **not** bundled into this story; they are either already resolved
or tracked as independent, non-story follow-ups. Do not fold them in here.)*

---

## Key Design Decisions

**Read this section before writing any code.**

### D1 — Route structure: three sub-pages under `/settings/audit`, not one page or six

A single page cramming search/export/verify/access-report/forwarding/retention together would be
unreadably dense; six separate top-level settings tiles would clutter `/settings/+page.svelte`
beyond its existing three-tile pattern. **Decision:**

- `/settings/audit` — **Audit Log**: search/filter table (AC group B), integrity-verify panel (AC
  group D), and export trigger/status/download (AC group C). All three concerns share one
  `owner`-only gate and operate on the same underlying data, so they live on one page as distinct
  sections, not three routes.
- `/settings/audit/access-report` — **Access Report** (AC group G). A structurally different
  question ("who had access when," not "what happened") with its own request/response shape;
  deserves its own route.
- `/settings/audit/forwarding` — **Forwarding & Retention** (AC groups E, F). Both are
  `admin`+-gated configuration forms, distinct from the `owner`-only read/search screens above;
  grouped together because both are "how the log behaves going forward" settings.
- `/settings/+page.svelte` gains exactly **one** new tile, "Audit & Compliance," linking to
  `/settings/audit`; that page itself links to its two siblings — matching the pattern
  `/settings/audit` → sub-pages, not three new top-level tiles. **Correction (adversarial review,
  medium):** because `/settings/audit` is `owner`-only while `/settings/audit/forwarding` is
  `admin`+, an `admin` who reaches `/settings/audit` is shown the role-gated notice instead of the
  page body where those sibling links normally live — so `admin`'s only in-app path to a page they
  can actually use would otherwise be missing. AC-B4 adds a forwarding link into that same
  role-gated notice specifically for the `admin` case to close this gap without adding a fourth
  top-level tile.
- Dormant-user alerts (AC group H) extend the **existing** `/notifications` page (Story 8.6's
  precedent: "do NOT build a new dormancy-specific inbox page — extend the existing Security
  Alerts surface"). Do not build a fourth new top-level page for this.
- The dormancy threshold (AC group I) and pseudonymize action (AC group J) extend the **existing**
  `/settings/users` page, mirroring Story 8.6's machine-key-threshold placement exactly.
- Erasure request/review/execute/report (AC groups K, L, M) live at
  `/settings/users/[userId]/erasure/[requestId]`, reached via a new "Request erasure" row action on
  the existing `/settings/users` table.

### D2 — No `GET` readback for forwarding/retention/dormancy-threshold config: an accepted, documented UI limitation, not a new backend endpoint

Per the endpoint inventory above, `PUT /audit/forwarding`, `PUT /audit/retention`, and
`PATCH .../user-dormancy-settings` have no corresponding `GET`. Adding one would be new backend
scope, which this story's Product Surface Contract (`web`-only, zero new endpoints) explicitly
rules out. **Decision, following Story 8.6's own precedent for the identical machine-key-threshold
limitation:** every form on these three surfaces is a **"set a new value"** form with no
pre-populated current value — the select/input starts empty/unselected, and a visible help note
states plainly that the current configuration is not displayed ("Project Vault does not currently
display your saved forwarding/retention/threshold configuration — this form always sets a new
value."). This is an intentional, documented scope boundary, not an oversight; if a future story
adds the missing `GET` endpoints, this UI limitation is trivially removed then.

### D3 — File downloads: three different mechanisms for three different response shapes

- **Audit CSV export** (`GET /audit/exports/:jobId/download`) already returns a file with
  `Content-Disposition: attachment; filename="audit-export-<jobId>.csv"` (Story 8.2 D8, confirmed:
  `apps/api/src/modules/audit/routes.ts:398`). **This is the first file-download flow in this web
  app** (confirmed: zero references to `download` or `Content-Disposition` anywhere in
  `apps/web/src` today). Use a plain `<a href="/api/v1/org/audit/exports/{jobId}/download">Download CSV</a>` — the existing
  `apps/web/src/routes/api/v1/[...path]/+server.ts` proxy (`proxyApiRequest`) already forwards the
  authenticated session cookie and streams the response through, so the browser's native
  download handling works with zero new JavaScript. Do not fetch this via `apiFetch`/JS and
  construct a blob — that is unnecessary complexity for a route that already sets the right
  headers server-side.
- **Erasure compliance report** (`GET .../erasure-request/:requestId/report`) returns **JSON**,
  with no `Content-Disposition` header — it is a normal API response, not a file stream. **New,
  small client-side utility**: `apps/web/src/lib/download.ts` exporting
  `triggerJsonDownload(filename: string, data: unknown): void`, which builds a `Blob` from
  `JSON.stringify(data, null, 2)`, creates an object URL, and clicks a temporary anchor — standard
  browser-download-from-JS pattern, unit-testable by asserting the blob content and filename
  without needing a real browser download to occur in the test environment (mock
  `URL.createObjectURL`/anchor `.click()`).
- **Access-report CSV** (`POST /audit/access-report { format: "csv" }`) fits **neither** of the two
  mechanisms above (adversarial review, high — confirmed against
  `apps/api/src/modules/audit/routes.ts:460-464`): it is a `POST`, not a `GET`, so a plain `<a
  href>` cannot carry the filter body needed to reproduce the on-screen `asOf`/pagination state;
  and its handler sets only `Content-Type: text/csv`, never `Content-Disposition` — there is no
  server-provided filename to rely on. **Decision: a third utility**,
  `apps/web/src/lib/download.ts` also exporting `triggerTextDownload(filename: string, mimeType:
  string, text: string): void` — same Blob/object-URL/temporary-anchor mechanism as
  `triggerJsonDownload`, but takes a pre-formatted string body and an explicit `mimeType` instead
  of JSON-serializing an object. The access-report page calls `apiFetch` (or the raw `fetch`
  wrapper, matching however this app's client reads a non-JSON response body) against `POST
  /audit/access-report` with `format: "csv"`, reads the response body as text, and calls
  `triggerTextDownload('access-report-<asOf-or-"current">.csv', 'text/csv', csvText)` — the
  filename is constructed client-side (from the `asOf` value already in page state, or the literal
  string `"current"` when no `asOf` was set) since the server supplies none.

### D4 — Pseudonymize confirmation: typed email, not a typed UUID

`POST /users/:userId/pseudonymize`'s body requires `confirmUserId` to exactly equal the target
`userId` (a UUID) — the server has no concept of "type the display name to confirm." Asking a human
to hand-type a raw UUID is bad UX and adds no real security (a copy-paste UUID confirms nothing
about intent). **Decision:** the confirm dialog requires the caller to type the target user's exact
**email** (client-side string comparison against the already-known row's email, matching the
Riley/Dana persona journey's "types the user's email to confirm" language above) before the submit
control enables; the `confirmUserId` value sent to the server is populated automatically from the
already-known `userId` of the row being acted on, not manually typed. Document this reasoning
inline as a comment — it is a deliberate UX decision, not an incomplete implementation of the
server's literal field name. **Match is case-insensitive and trimmed** (adversarial review, low:
a naive exact-string match would permanently stick a legitimate operator with a disabled submit
button if they type the email in different letter case than what's stored, with no specified
fallback) — see `TypedConfirmInput.svelte`'s contract above for the exact comparison logic.

### D5 — Erasure execute: an additional, UI-only typed-confirmation step beyond the server's bare `{ confirm: true }`

`POST .../erasure-request/:requestId/execute`'s body is just `{ confirm: boolean }` — the server
does not require re-typing an identifier. Given this action is irreversible and touches a user's
global identity (D2 of Story 8.4: cross-org-guarded, but still permanent for the requesting org),
this story adds the same typed-email confirmation pattern as D4 (`TypedConfirmInput.svelte`, same
case-insensitive/trimmed match — type the target user's exact email before the "Execute erasure"
control — itself a `ConfirmDeleteButton`-style two-step control — becomes enabled), matching the
level of care this codebase already applies to its other highest-stakes actions (D4's pseudonymize,
Story 8.1's owner-only verify endpoint). This typed-email check happens entirely client-side; the
actual submitted body remains exactly `{ confirm: true }` per the server's real contract.
**Framing correction (adversarial review, low):** this is **misclick/intent-confirmation
protection, not a security control** — calling it "defense-in-depth" overstates its value, since by
construction it is a pure client-side string comparison gating a submit button: any direct API
caller (or a user with browser dev tools open) bypasses it trivially, and the request body it
produces is unchanged from what an unconfirmed call would send. Document it in code/UI copy as what
it actually is — a safeguard against a human clicking the wrong row or moving too fast on an
irreversible action — not as a claim of additional server-enforced security.

### D6 — Reading current erasure-request state without a dedicated `GET`-by-userId endpoint

There is no endpoint to fetch "the current erasure request for user X" independent of creating one
or fetching its completed report. `GET .../report` on a not-yet-completed request returns
`409 { code: "erasure_not_yet_completed", status: "pending" | "in_progress" }` (confirmed:
`ErasureNotYetCompletedErrorSchema`, `apps/api/src/modules/compliance/schema.ts`) — this is usable
as a genuine status probe. **Decision:** the
`/settings/users/[userId]/erasure/[requestId]` page's load function calls `GET .../report` first:
- `200` → completed; render the compliance report + download control (AC group M).
- `409 erasure_not_yet_completed { status: "pending" }` → render the pending review screen. To
  redisplay the PII inventory (not returned by the report-status probe), the load function then
  calls `POST .../erasure-request` again with the same target `userId` — this is safe and **not**
  a duplicate-creating call: `createErasureRequest`'s `already_pending` branch (Story 8.4's partial
  unique index, D9) returns the **existing** request's `requestId`+`piiInventory` in its `409`
  body without creating a second row. This "safe re-POST as a read path" is a genuine, intentional
  reuse of an idempotent-by-construction endpoint, not a workaround — document it plainly in code
  comments so a future reader doesn't "fix" it into a real duplicate-request bug.
- `409 erasure_not_yet_completed { status: "in_progress" }` → **do not** re-POST for this branch
  (adversarial review, medium — corrects an earlier draft of this decision that treated `pending`
  and `in_progress` identically). A re-POST while a request is `in_progress` hits
  `createErasureRequest`'s `execution_in_progress` outcome, which returns `409 {
  code: 'erasure_execution_in_progress', requestId }` — confirmed via
  `ErasureExecutionInProgressErrorSchema` (`apps/api/src/modules/compliance/schema.ts`) — with
  **no** `piiInventory` field, unlike the `already_pending` branch above. Instead, render a
  narrower "This erasure is currently being processed" screen (same copy/pattern as AC-L4's
  concurrent-execute race) with no inventory table and a refresh/reload control — do not attempt to
  render an inventory table with missing data, and do not call `POST .../erasure-request` a second
  time for this status.
- `404` → no request exists yet for this `requestId` (e.g., a stale/tampered URL); render a
  "request not found" notice with a link back to `/settings/users`.

**Known Scope Boundary — `userId`/`requestId` URL pair is unvalidated (documented, not silently
fixable — adversarial review, low/medium):** `GET .../report`'s handler looks up the request purely
by `requestId` (scoped to the caller's `orgId`) — confirmed against
`apps/api/src/modules/compliance/erasure-routes.ts`, the `userId` route segment is parsed but never
used in the lookup. None of this story's consumed responses (`ErasureReportResponseSchema`,
`CreateErasureRequestResponseSchema`, `ErasureAlreadyPendingErrorSchema`) include a target-user
identifier field the UI could cross-check the route's `userId` against — so there is no
backend-provided signal available to detect a stale/hand-edited URL whose `userId` doesn't actually
match the `requestId`'s real target user. Closing this properly would require a new response field
or endpoint, which is out of scope for this `web`-only story (Product Surface Contract). Accept this
as a known limitation: the page trusts `requestId` as authoritative and does not attempt to validate
`userId` against it. If this becomes a real-world problem (e.g. a support workflow that hands out
raw URLs), a future story should add the missing field rather than have this story's UI guess.

---

## Prerequisites

| Prerequisite | Why | Status |
|---|---|---|
| Story 8.1 (Tamper-Evident Audit Log) | Source of `GET /audit/verify`, AC group D | `done` |
| Story 8.2 (Audit Log Search, Export & Forwarding) | Source of `GET /audit/events`, export/forwarding/retention endpoints, AC groups B/C/E/F | `done` |
| Story 8.3 (Access Reports, Dormant Users & Audit PII Management) | Source of `POST /audit/access-report`, `user.dormant` alerts, dormancy-settings route, `POST /pseudonymize`, AC groups G/H/I/J | `done` |
| Story 8.4 (Data Subject Erasure Request Handling) | Source of the three erasure endpoints, AC groups K/L/M | `done` |
| Story 4.3 (Account Deactivation & Recovery) | Source of the existing `POST /users/:userId/deactivate` this story's dormant-alert UI action reuses unchanged | `done` |
| Story 8.6 (Epic 7 Completion — Machine User Web UI) | Source of `DataTable.svelte`, `ConfirmDeleteButton.svelte`, `toDormancyAlertViews()`'s shape, and the "no-GET-readback, set-new-value-only" UI precedent (D2) this story mirrors for three more settings | `done` |
| Story 6.4 (Epic 6 Completion — Monitored Asset Management UI) | Source of `ConfirmDeleteButton.svelte`'s original introduction and the lettered-AC-group story format this story follows | `done` |

All four hard backend prerequisites (8.1–8.4) are confirmed `done` in `sprint-status.yaml` as of
this story's creation — **unlike** 8.2/8.3/8.4's own creation-time state (which had to plan around
8.1 still being `ready-for-dev`), this story can and should call every listed endpoint directly
with no "must be done, not just ready-for-dev" caveat.

---

## Epic Cross-Story Context

| Story | Relationship to 8.7 |
|---|---|
| 8.1–8.4 (`done`) | Source of every endpoint this story's UI consumes; zero backend changes needed. |
| 8.6 (`done`) | Structural and component-reuse template: `DataTable.svelte`, `ConfirmDeleteButton.svelte`, the dormancy-alert-view shape, and the "no-GET-readback" accepted-limitation precedent this story extends to three more settings. |
| 6.4 (`done`) | Origin of `ConfirmDeleteButton.svelte` and the lettered-AC-group (`### A.`, `### B.`, ...) story-writing convention this story follows. |
| Epic 9 (in progress, 9.1–9.3 `done`) | No dependency either direction — per `epic-8-retro-2026-07-07.md`'s "Next Epic Preview": "Story 8-7 ... does not need to block Epic 9's remaining stories," matching how 6-4/8-6 didn't block their downstream epics either. |
| `epic-8` (`sprint-status.yaml`, `in-progress`) | This story is the sole remaining condition for `epic-8` to move to `done` (Product Surface Contract G2 gate) — confirm no other open Critical product-surface gap exists for Epic 8 before marking this story `done`. |

---

## Acceptance Criteria

### A. Navigation — a real path exists to every new page (G3 compliance)

**AC-A1.** **Given** the `/settings` page's existing three-tile list (Notifications, Users,
Security), **when** this story lands, **then** a fourth tile, "Audit & Compliance" (description:
"Audit log search, export, access reports, and erasure requests"), links to `/settings/audit`,
visible to every authenticated role — the tile itself is always visible; role-gating happens
*within* the target page (AC group N), not by hiding the tile.
- *Example (happy path, owner):* clicks the tile → lands on `/settings/audit`, sees the full
  search/export/verify page.
- *Example (edge, viewer role):* clicks the same tile → lands on `/settings/audit`, sees an honest
  "This page requires the owner role" notice instead of the search table (AC-N1) — not a 404, not
  a silently-hidden tile that would make the feature undiscoverable.

**AC-A2.** **Given** `/settings/audit`, **when** it renders, **then** it includes two real links —
"Access Report" → `/settings/audit/access-report` and "Forwarding & Retention" →
`/settings/audit/forwarding` — both resolving to real SvelteKit routes with no 404, closing the
D1 route-structure decision into actual navigable UI.
- *Example:* an owner on `/settings/audit` clicks "Access Report" → lands on
  `/settings/audit/access-report`, sees the `asOf` picker (AC group G).

**AC-A3.** **Given** `/notifications`, **when** this story lands, **then** it gains a "Dormant user
alerts" section (alongside the existing "Machine key dormancy alerts" section from Story 8.6),
visible only to `owner`/`admin` roles — a `member`/`viewer` sees neither section, matching the
existing `DORMANCY_MANAGE_ROLES` gate already applied to the machine-key section.
- *Example (happy path, admin):* one dormant-user alert (`jsmith@example.com`, 94 days inactive) →
  section renders with dismiss/deactivate/pseudonymize-link controls.
- *Example (edge, viewer):* neither dormancy section renders at all — the page shows only the
  viewer's own personal notification inbox.

**AC-A4.** **Given** `/settings/users`, **when** this story lands, **then** each user row gains a
"Request erasure" action (visible to `admin`+, matching the existing "Deactivate account" action's
role gate) linking into the new `/settings/users/[userId]/erasure/[requestId]` flow (AC group K),
and a "Pseudonymize identity" action (visible to `owner` only, per AC group J's stricter gate) —
both real, resolving controls, not placeholders.
- *Example (happy path, admin):* sees "Request erasure" next to "Deactivate account"; does **not**
  see "Pseudonymize identity" (owner-only).
- *Example (happy path, owner):* sees both actions.

---

### B. Audit Log Search & Filter (`owner`-only)

**AC-B1.** **Given** `/settings/audit`, **when** an `owner` visits it with zero prior filters
applied, **then** the page issues `GET /audit/events?page=1&limit=20` (no other filters) and
renders the results in a `DataTable.svelte` instance with columns `eventType`, `actorDisplayName`,
`resourceType`/`resourceId`, `projectId`, `ipAddress`, `createdAt` — a real, unfiltered first page
of the org's actual audit history, never a hardcoded example row.
- *Example (happy path):* an org with 340 audit rows shows the 20 most recent, with pagination
  controls reflecting `total: 340, page: 1, hasNext: true`.
- *Example (edge, brand-new org with zero audit rows so far):* an honest empty state — "No audit
  events yet." — never a fabricated example row (G3 dashboard-truth rule, applied here to a table
  rather than a stat tile).

**AC-B2.** **Given** the search form (actor, event type, resource ID, project, date range), **when**
an `owner` fills in `eventType: "credential.access"` and a `from`/`to` range and submits, **then**
`GET /audit/events?eventType=credential.access&from=...&to=...&page=1&limit=20` is called and the
table updates to the filtered result set, with the active filters visibly summarized above the
table (e.g. "Filtered by: event type = credential.access, 2026-06-01 → 2026-06-30").
- *Example (happy path):* 12 matching rows out of 340 total → table shows 12, pagination reflects
  `total: 12`.
- *Example (edge, actorId filter with a typo'd/nonexistent user UUID):* per Story 8.2 D6, the API
  resolves this to zero matching token IDs and returns `200` with an empty result set, **not**
  `404` — the UI renders the same honest "No audit events match these filters." empty state as
  AC-B1's zero-rows case, with a visible "Clear filters" control, not an error banner.
- *Example (failure, `to` before `from`):* client-side validation blocks submission ("End date must
  be after start date") before any network call — mirror the existing `credentials/new`-style
  pre-check pattern already used elsewhere in this app (per Story 6.4's convention).

**AC-B3.** **Given** a page of results, **when** an `owner` clicks a specific event row,
**then** the row expands (or opens a detail panel) showing the event's full detail already present
in the response (`resourceId`, `resourceType`, `projectId`, `ipAddress`, `createdAt`,
`actorDisplayName`) — no second API call is made, since `GET /audit/events` already returns every
field needed; this is a pure client-side reveal.
- *Example:* click a `credential.access` row → panel shows `resourceId: <credentialId>,
  actorDisplayName: "Dana Smith", ipAddress: "203.0.113.4"`.
- *Accepted tradeoff (documented, not a gap to silently fix — adversarial review, medium):* because
  this reveal is purely client-side, there is no audit-log entry distinguishing "owner scanned a
  table of summary rows" from "owner inspected this specific person's IP address in detail" — only
  the single `audit.search_run` event for the original list query exists. Adding a second
  server-side audit write per detail-panel expand would require a new backend endpoint, which is
  out of scope for this `web`-only story (Product Surface Contract). This is an accepted,
  documented limitation, not an oversight; a future story could add a lightweight "detail viewed"
  audit event if this granularity becomes a real compliance requirement.

**AC-B4.** **Given** a non-`owner` role (`admin`, `member`, `viewer`) visits `/settings/audit`
directly (e.g. a bookmarked or shared URL), **when** the page loads, **then** it shows an honest
"This page requires the owner role" notice with a link back to `/settings` — never a raw `403`
error dump, and never a silent redirect that hides *why* the page didn't load (matching AC-A1's
edge case and this codebase's general non-owner-role-gated-page convention). **For the `admin` role
specifically**, the notice additionally includes a link to "Forwarding & Retention"
(`/settings/audit/forwarding`) — a page `admin`+ *can* use (AC-N1) — since D1 places that page's
only in-app discovery link inside `/settings/audit`'s own body, which this same role-gated notice
is otherwise hiding from them (adversarial review, medium: without this, an `admin` has no
in-app path to a page they're the intended audience for, short of guessing the URL).
- *Example (admin):* an `admin` navigates to `/settings/audit` directly → sees the role notice
  *plus* a "You can still access Forwarding & Retention →" link to `/settings/audit/forwarding`.
- *Example (member/viewer):* sees the plain role notice with no forwarding link, since neither role
  can use that page either (AC-N1's gate is `admin`+, not open to `member`/`viewer`).

---

### C. Audit Export — Trigger, Status, Download (`owner`-only, mandatory integrity precondition)

**AC-C1.** **Given** `/settings/audit`'s Export panel, **when** an `owner` picks a `from`/`to`
range and clicks "Export CSV," **then** `POST /audit/export { from, to, format: "csv",
includeIntegrityReport: true }` is called; the response's `{ jobId }` is stored in page state and
the panel immediately begins polling `GET /audit/exports/:jobId` every 2 seconds showing a
"Verifying integrity, then generating export…" status message, **capped at 60 poll attempts (2
minutes)** (adversarial review, medium: an unbounded poll has no stated failure mode for a job
stuck in `pending`/`processing`, and this cap also keeps polling within `GET
/audit/exports/:jobId`'s 60/min rate limit for a single panel). If the cap is reached without
`completed`/`failed`, the panel stops polling and shows "This export is taking longer than
expected" with a manual "Check again" control (a single on-demand poll, not an automatic restart of
the 60-attempt loop) rather than polling forever.
- *Example (happy path):* trigger export → `jobId` returned → panel polls → after a few seconds,
  status transitions `pending → processing → completed` → a "Download CSV" link
  (`/api/v1/org/audit/exports/{jobId}/download`, per D3) appears.
- *Example (edge, stuck job):* 60 polls pass with the job still `processing` → polling stops → "This
  export is taking longer than expected — check again" shown with a manual retry control.
- *Example (failure, rate limit hit mid-poll):* a `429` from `GET /audit/exports/:jobId` (e.g. a
  second browser tab polling the same job) is caught and shown as "Checking export status is
  temporarily rate-limited — retrying shortly," and polling backs off (e.g. skips the next
  scheduled attempt) rather than treating the `429` as a terminal failure or continuing to hammer
  the endpoint at the same 2-second cadence (adversarial review, low).

**AC-C2.** **Given** an export whose integrity verification **failed** (Story 8.1's tamper
detection), **when** the poll reaches `status: "failed"`, **then** the panel shows the failure
plainly — e.g. "Export failed: integrity verification detected N tampered record(s). See the
Integrity Verification panel below for details." — and does **not** render a download link (a
failed-verification export never produces a downloadable file, per Story 8.2's own mandatory
precondition).
- *Example (failure path):* `integritySummary: { passed: 1200, failedCount: 3 }` → panel shows "3
  of 1,203 records failed integrity verification" with no download link, and a direct link to the
  Verify panel (AC group D) to investigate further.

**AC-C3.** **Given** the export panel, **when** a range wider than the export's own bound is
selected (mirrors Story 8.1's `422 range_too_large` precedent, applied here to whatever bound
Story 8.2's export flow enforces), **then** the resulting `422` is caught and its exact server
message is surfaced (e.g. "Export range too large — please export in smaller date windows"), not a
generic error.
- *Example (failure):* a 3-year range on an org with a bounded export window → `422` → friendly
  message shown, form remains editable for the user to narrow the range and retry.

**AC-C4.** **Given** a completed export, **when** the "Download CSV" link is clicked, **then** the
browser downloads `audit-export-<jobId>.csv` via the plain `<a href>` mechanism (D3) — no
JavaScript-driven fetch, no in-page CSV preview is required by this AC (the file itself is the
deliverable).
- *Example:* click "Download CSV" → browser's native download starts, filename matches the
  server's `Content-Disposition` header exactly.

---

### D. Audit Integrity Verification (`owner`-only, non-cryptographer-friendly)

**AC-D1.** **Given** `/settings/audit`'s Verify panel, **when** an `owner` picks a `from`/`to`
range (≤ 90 days, per Story 8.1's `AUDIT_VERIFY_MAX_RANGE_DAYS` bound) and clicks "Run integrity
check," **then** `GET /audit/verify?from=&to=` is called and the response's `summary` string is
rendered as the headline result — e.g. **"All 1,247 records verified — no tampering detected"** —
exactly as Story 8.1's own AC-15/UX-DR13 requires ("designed to be comprehensible to a
non-cryptographer"), not a raw JSON dump.
- *Example (happy path):* clean range → green success banner with the exact `summary` text.
- *Example (edge, empty range):* zero rows in the selected window → `rowsChecked: 0` → a plain "No
  audit events in this range to verify." message, not an error.

**AC-D2.** **Given** a range containing tampered rows, **when** the check completes, **then** the
`failed` array (each `{ id, eventType, timestamp }`) is rendered as a distinct, visually
alarming (e.g. red-bordered) list beneath the summary — "3 records failed verification:" followed
by each failed row's `eventType` and `timestamp` (never the full row content, which this endpoint
doesn't return anyway).
- *Example (failure/edge):* `failed: [{ id: "...", eventType: "credential.access", timestamp:
  "2026-06-14T10:03:00Z" }]` → one list item rendered with that event type and timestamp.

**AC-D3.** **Given** a range exceeding either the day-count or row-count bound, **when** submitted,
**then** the resulting `422 { code: "range_too_large" }` (Story 8.1 D4) is caught and its exact
message surfaced, with the form's date inputs remaining populated (not cleared) so the user can
narrow the range without re-entering both dates from scratch.
- *Example (failure):* a 120-day range → `422` → "Please select a range of 90 days or fewer" shown
  inline under the date inputs.

---

### E. Forwarding Configuration — Webhook & S3 (`admin`+, write-only per D2)

**AC-E1.** **Given** `/settings/audit/forwarding`'s Forwarding section, **when** an `admin`+ user
selects "Webhook" and fills in `url` (must start with `https://`) and `secretHeader`, then submits,
**then** `PUT /audit/forwarding { type: "webhook", config: { url, secretHeader } }` is called; on
success, a confirmation banner shows "Webhook forwarding configured" with the response's
`configuredAt` timestamp — **not** the `secretHeader` value, which the response schema never
returns and the form must not attempt to redisplay. The `secretHeader` input uses `type="password"`
with `autocomplete="off"` (adversarial review, medium: this form introduces live webhook secrets
and AWS credentials with no redisplay-prevention spec for the *input* side — masking prevents
shoulder-surfing/screen-recording exposure and blocks browser password-manager autofill/capture of
a value that isn't actually a login credential).
- *Example (happy path):* `url: "https://siem.example.com/ingest", secretHeader: "wh_secret_..."` →
  `200` → "Webhook forwarding configured at 2026-07-07 14:02 UTC."
- *Example (masking):* the `secretHeader` field renders as a masked (dot/asterisk) input, matching
  standard password-field behavior, not plain text.

**AC-E2.** **Given** the same form, **when** a non-`https://` URL is entered (e.g.
`http://siem.example.com/ingest`), **then** client-side validation blocks submission with "URL
must use https://" before any network call, mirroring the server's own Zod constraint
(`url.startsWith('https://')`).
- *Example (failure, client-caught):* `http://...` → inline error, no request sent.
- *Example (failure, server-caught SSRF rejection — D4 of Story 8.2):* an `https://` URL that
  resolves to a private/loopback/metadata address (e.g. `https://169.254.169.254/`) passes
  client-side validation (which cannot perform DNS resolution in the browser) but is rejected
  server-side with `422 { code: "unsafe_forwarding_url" }` — the UI catches this and surfaces the
  exact message ("URL resolves to a private, loopback, or reserved address and cannot be used for
  forwarding"), it does **not** attempt any client-side SSRF pre-check of its own (that would
  require DNS resolution unavailable in a browser context, per Story 8.2 D4's own note that this
  is correctly a server-only check).

**AC-E3.** **Given** the same panel, **when** an `admin`+ selects "S3-compatible" and fills in
`bucket`, `region`, `accessKeyId`, `secretAccessKey`, and optionally `prefix`/`endpoint` (for
Minio), **then** `PUT /audit/forwarding { type: "s3", config: {...} }` is called; the confirmation
banner shows the same success pattern as AC-E1, and **neither `accessKeyId` nor
`secretAccessKey` is ever redisplayed anywhere in the UI after submission** (the response schema
returns only `type`, `enabled`, `configuredAt` — the form fields for these two are cleared, not
retained in page state, after a successful submit). Both `accessKeyId` and `secretAccessKey` use
`type="password"` with `autocomplete="off"` for the same reason as AC-E1's `secretHeader`.
- *Example (happy path, AWS S3):* `bucket: "org-audit-logs", region: "us-east-1"` (no `endpoint`) →
  `200`.
- *Example (happy path, Minio via `endpoint`):* same fields plus `endpoint:
  "https://minio.internal.example.com"` → `200`.
- *Example (failure, malicious `endpoint`):* an `endpoint` resolving to a private address is
  rejected server-side the same way as AC-E2's webhook case (Story 8.2 D4's `assertPublicHostname`
  applies to S3 `endpoint` too) — same UI handling, no client-side DNS check attempted.

**AC-E4.** **Given** D2's accepted no-GET-readback limitation, **when** an `admin`+ visits
`/settings/audit/forwarding`, **then** a visible help note states plainly: "Project Vault does not
currently display your saved forwarding configuration — this form always sets a new value," and
**both** the webhook and S3 forms start with every field empty/unselected (never pre-filled with a
stale or fabricated placeholder value).
- *Example:* re-visiting the page after a successful save shows the same empty form, not the
  values just submitted — this is the intentional, documented behavior, not a bug to "fix" by
  caching the last-submitted values client-side (which would misleadingly imply the server also
  remembers them across page loads/devices, when only the server's actual saved config — invisible
  to this UI — is authoritative).

**Known Scope Boundary (documented, not a gap to silently fix — adversarial review, medium):**
there is no way, in this UI or the underlying API, to turn forwarding *off* once configured.
`AuditForwardingConfigRequestSchema`'s `type` field only accepts `'webhook' | 's3'` — there is no
`'none'`/`'disabled'` type and no endpoint to unset forwarding. The Forwarding form in this story
only supports configuring or reconfiguring a forwarder, never disabling one; the help copy from
AC-E4 must not imply a disable capability exists. This is distinct from D2's read-back limitation
(which is about *seeing* the current config, not *changing* it) and is a real capability gap in the
underlying API, not something this `web`-only story can add a workaround for. A future story would
need a new backend endpoint (or a `type: 'none'` schema addition) to close this.

---

### F. Retention Configuration (`admin`+, write-only per D2)

**AC-F1.** **Given** `/settings/audit/forwarding`'s Retention section, **when** an `admin`+ enters
`retentionDays: 400` and submits, **then** `PUT /audit/retention { retentionDays: 400 }` is called;
on success, a confirmation banner shows "Retention set to 400 days" with the response's
`updatedAt`.
- *Example (happy path):* `400` → `200` → confirmation shown.

**AC-F2.** **Given** the same form, **when** a value outside `[AUDIT_RETENTION_MIN_DAYS = 30,
AUDIT_RETENTION_MAX_DAYS = 3650]` is entered, **then** client-side validation blocks submission
("Retention must be between 30 and 3,650 days") — the two named constants are imported from the
shared package if exported there, or otherwise mirrored as literal bounds with a comment citing
Story 8.2 D7 as the source of truth, not invented independently.
- *Example (failure, client-caught):* `10` → inline error, no request sent.
- *Example (failure, server-caught, e.g. a stale client-side bound):* a value technically within a
  UI-side bound that has drifted from the server's actual constants still gets a clean
  `422`-mapped error surfaced, not a raw Zod error object.

**AC-F3.** **Given** the "retain forever" option, **when** an `admin`+ explicitly selects it (e.g.
a checkbox "Never automatically delete audit events" that clears/disables the numeric input),
**then** `PUT /audit/retention { retentionDays: null }` is sent — a real, valid, explicit request
per Story 8.2 D7's "retentionDays: null is a valid, explicit 'retain forever' state," not an
omitted field.
- *Example (happy path):* checkbox checked → numeric input disabled/cleared → submit → `{
  retentionDays: null }` sent → confirmation: "Audit events will be retained indefinitely."

---

### G. Point-in-Time Access Report (`owner`-only)

**AC-G1.** **Given** `/settings/audit/access-report`, **when** an `owner` leaves the `asOf` field
empty and submits (the "current state" case, per Story 8.3 D2's fast path), **then** `POST
/audit/access-report { page: 1, limit: 20, format: "json" }` is called (no `asOf` key at all in the
body — matching D2's "presence-or-absence of the field is the only branch condition") and the
result renders as a paginated table: `displayName`, `orgRole`, `status` (active/deactivated), and a
nested list of `projects: [{ projectName, role, grantedAt }]` per user.
- *Example (happy path):* an org with 12 active users and 1 deactivated user → 13 rows, the
  deactivated user's row shows a "Deactivated" badge (matching `/settings/users`' existing badge
  convention) but is still listed, per Story 8.3 AC design (deactivated ≠ removed).

**AC-G2.** **Given** the same page, **when** an `owner` picks a historical `asOf` date (e.g.
`2026-03-01`) and submits, **then** `POST /audit/access-report { asOf: "2026-03-01T00:00:00Z",
page: 1, limit: 20, format: "json" }` is called (the historical/replay path) and the result
correctly includes a user who has since been fully removed from the org — reconstructed entirely
from audit-event replay, per Story 8.3 D2 — with the report's `asOf`/`generatedAt` fields both
shown above the table so the user knows exactly what point in time (and when the report was run)
they're looking at.
- *Example (happy path, historical, removed user included):* a user removed from the org on
  2026-05-01 still appears in a report for `asOf: 2026-03-01` — the UI must not filter this row
  out based on the user's *current* org membership (there is none) — it must trust the API's
  response as authoritative.
- *Example (failure, `asOf` before org creation):* the API rejects with `422` (per Story 8.3's
  validation boundary — "nothing to report") — the UI surfaces "This date is before your
  organization was created" rather than silently showing an empty table.
- *Example (failure, `asOf` in the future):* rejected `422` — "Access reports cannot be generated
  for a future date" — same handling pattern.

**AC-G3.** **Given** a generated report (either path), **when** the `owner` clicks "Download CSV,"
**then** `POST /audit/access-report { ..., format: "csv" }` is called with the **same** filters
already applied on screen (same `asOf`/pagination state, re-requested with `format: "csv"` since
the JSON and CSV variants are two separate calls per the API's own `format` discriminator, not a
client-side re-serialization of the already-fetched JSON — this matters because the CSV response
uses a different column set per Story 8.3's Architecture Conflict Resolution table, not the JSON
shape's nested `projects` array); the response body (plain CSV text, `Content-Type: text/csv`, no
`Content-Disposition` header — confirmed via source, see D3) is downloaded using D3's third
mechanism, `triggerTextDownload()`, with a client-constructed filename
(`access-report-<asOf-date-or-"current">.csv`) — **do not** use a plain `<a href>` for this
endpoint (it's a `POST`, so an anchor tag cannot carry the request body) and do not assume a
`Content-Disposition` header will appear.
- *Example (happy path):* click "Download CSV" while viewing the historical `asOf: 2026-03-01`
  report → the downloaded file `access-report-2026-03-01.csv` reflects that same historical point
  in time, not "now."
- *Example (accepted tradeoff, documented — adversarial review, low/medium):* on the historical
  `asOf` path, this AC's CSV request re-runs Story 8.3's full audit-log replay computation from
  scratch (the same one already run once for the on-screen JSON view) rather than reusing a cached
  result — every CSV download is a second, full replay, not a lightweight re-format of
  already-fetched data. This is an accepted performance tradeoff for this story (no caching layer
  is in scope for a `web`-only story with zero new backend endpoints); if replay cost becomes a
  real problem in practice, a future story should add either a server-side cache or a combined
  `format: "both"` response, not something this story's UI can work around client-side.

**AC-G4.** **Given** a report with more users than fit on one page, **when** the `owner` navigates
to page 2, **then** pagination is stable and non-overlapping across pages — per Story 8.3 D2's
"deterministic ordering (sorted by `userId ASC`)" guarantee — the UI simply passes `page`/`limit`
through to the same `asOf`-scoped request; it performs no client-side re-sorting or deduplication
of its own.
- *Example:* 45 users, `limit: 20` → page 1 shows users 1–20, page 2 shows 21–40, page 3 shows
  41–45, with zero overlap or repeats between pages.

---

### H. Dormant User Alerts in the Notifications Inbox (`owner`/`admin`)

**AC-H1.** **Given** the `/notifications` page's new "Dormant user alerts" section (AC-A3),
**when** it renders for an `owner`/`admin` with ≥ 1 open `user.dormant` alert, **then** each alert
shows the payload's `displayName`, `orgRole`, and `lastActiveAt` (formatted, or "Never active" if
`null`), plus three actions: **Dismiss** (requires typing a reason, reusing the existing
`dismissDormancyAlert`-style form action shape from `/notifications/+page.server.ts`), **Deactivate
account** (calls the existing, unchanged `POST /users/:userId/deactivate`), and **Pseudonymize
identity** (a link into `/settings/users`, not an inline action here — per D1, the typed-email
confirmation flow (D4) belongs on the Users settings page where the user's email is already
visible in the row, not duplicated into the notifications page).
- *Example (happy path, dismiss):* type a reason ("Confirmed active via out-of-band contact,
  keeping account") → dismiss → alert disappears from the open-alerts list.
- *Example (edge, dismiss without a reason):* submit blocked client-side ("A reason is required to
  dismiss this alert"), mirroring the existing machine-key dormancy dismiss action's identical
  validation.
- *Example (happy path, deactivate):* click "Deactivate account" → `ConfirmDeleteButton`-style
  two-step confirm → `POST /users/:userId/deactivate` → account shows "Deactivated" badge
  everywhere else in the app (e.g. `/settings/users`) on next load.
- *Example (edge, already deactivated by another admin in the meantime):* the deactivate call
  returns the API's existing `already_deactivated`-style response (Story 4.3's idempotent
  behavior) — the UI shows "This account was already deactivated" rather than a raw error, per
  the existing `/settings/users` page's own handling of this exact case (reuse it).

**AC-H2.** **Given** zero open `user.dormant` alerts, **when** the section renders, **then** it
shows either nothing at all or an explicit "No dormant user alerts" note (developer's choice,
matching the existing machine-key section's own precedent for this state) — it must not be
indistinguishable from a loading or error state.
- *Example:* a healthy org with no dormant users → section either omitted entirely or shows the
  explicit empty note; either is acceptable per this AC, but silence-that-looks-like-a-bug is not.

**AC-H3.** **Given** a `member`/`viewer` role, **when** they visit `/notifications`, **then**
neither dormancy section (machine-key or user) renders, matching `DORMANCY_MANAGE_ROLES`'s
existing gate — reuse that constant, do not introduce a second, possibly-drifting role-check.

---

### I. User Dormancy Threshold Setting (`admin`+, write-only per D2)

**AC-I1.** **Given** `/settings/users`, **when** this story lands, **then** the page gains a
"User dormancy alerts" control (mirroring the existing "Machine key dormancy alerts" selector
already on this page from Story 8.6) — a `<select>` with the same allowed values (`30, 60, 90,
180` days) — visible to `admin`+ only.
- *Example (happy path):* select `60` → submit → `PATCH
  /organizations/:orgId/user-dormancy-settings { userDormancyThresholdDays: 60 }` → `200` →
  confirmation "Threshold updated to 60 days."

**AC-I2.** **Given** D2's no-readback limitation, **when** the selector renders, **then** it starts
unselected (no default-selected option implying a known current value) — same "Choose a new
threshold…" placeholder-copy pattern Story 8.6 already established for the machine-key control,
reused verbatim for consistency between the two now-sibling settings.
- *Example:* the page never claims "Current threshold: 90 days" anywhere, since that value is not
  fetchable.

**AC-I3.** **Given** the selector's help text, **when** it renders, **then** it explicitly states
the change is **not retroactive** — already-fired `user.dormant` alerts are not reconciled or
auto-dismissed when the threshold changes — mirroring Story 8.3 D12's documented, deliberate scope
boundary and Story 8.6's identical UI-copy-only fix for the machine-key equivalent (AC-11 there).
- *Example:* help text reads "Changing this threshold does not affect alerts already in your
  Dormant user alerts inbox."

---

### J. Pseudonymize User Identity (`owner`-only, MFA, blast-radius confirmation)

**AC-J1.** **Given** `/settings/users`' "Pseudonymize identity" row action (`owner`-only, AC-A4),
**when** an `owner` clicks it, **then** a confirmation dialog opens showing: a plain warning that
this action is **permanent and irreversible** (Story 8.3 D8: the DB trigger makes a second, real
alias change impossible — re-running is a no-op, not a "change again" operation), a field
requiring the caller to type the target user's exact email (D4) before the submit control enables,
and — if the target user belongs to other orgs — the pre-submission blast-radius warning is **not**
knowable client-side before the call (the API computes it server-side and returns it in the
response), so the dialog's copy states this plainly: "This may also affect how this user's audit
history displays in other organizations they belong to — you'll see the exact count after
confirming."
- *Example (happy path, single-org user):* type the exact email → submit → `POST
  /users/:userId/pseudonymize { confirmUserId: "<uuid>" }` → `200 { alias: "user_a1b2c3d4",
  otherAffectedOrgCount: 0 }` → success banner: "Identity pseudonymized as user_a1b2c3d4. No other
  organizations affected."

**AC-J2.** **Given** the same flow, **when** the target user belongs to 2 other orgs,
**then** the success response's `otherAffectedOrgCount: 2` is surfaced plainly in the confirmation
banner: "Identity pseudonymized as user_e5f6g7h8. This also affects how this user's audit history
displays in 2 other organization(s) they belong to." — this is Story 8.3 D9's documented, accepted
cross-org bleed; the UI's job is to make it visible at the moment of action, not to prevent it.
- *Example (edge, cross-org bleed):* `otherAffectedOrgCount: 2` → banner shown exactly as above.

**AC-J3.** **Given** the typed-email field, **when** the caller types anything other than the
target's exact email, **then** the submit control remains disabled — this is purely a UI-layer
gate (D4); it is never sent to the server as the (structurally different) `confirmUserId` field,
so there is no server-side "email mismatch" error case to handle — only a disabled button.
- *Example (failure, client-caught only):* typing `jsmit@example.com` (typo) instead of
  `jsmith@example.com` → button stays disabled, no request is ever sent.
- *Example (edge, re-pseudonymizing an already-pseudonymized user):* per Story 8.3 D8, this is a
  **no-op** returning `200` with the *existing* alias unchanged (not a new one) — the UI's success
  banner must reflect this honestly, e.g. "This identity was already pseudonymized as
  user_a1b2c3d4 — no change made," not implying a fresh alias was just generated.

---

### K. Erasure Request Creation & PII Inventory Review (`admin`+)

**AC-K1.** **Given** `/settings/users`' "Request erasure" row action (`admin`+, AC-A4), **when** an
`admin`+ clicks it, fills in a `reason` (required, ≤ 2000 chars) and `requestedBy` (required, ≤ 500
chars — e.g. "Data Subject via support ticket #4021"), and submits, **then** `POST
/users/:userId/erasure-request { reason, requestedBy }` is called; on `201`, the caller is
navigated to `/settings/users/[userId]/erasure/[requestId]` (using the response's `requestId`),
which immediately renders the returned `piiInventory` — a table of `{ table, rowCount, piiFields }`
rows (e.g. "users — 1 row — email, passwordHash," "sessions — 3 rows — ipAddress, userAgent") —
**before** any erasure has actually happened, giving the reviewer a chance to see full scope first.
- *Example (happy path):* submit → `201` → redirected to the erasure-request page → inventory table
  shows 7 rows across `users`, `user_identity_tokens`, `sessions`, `mfa_enrollments`,
  `mfa_recovery_codes`, `account_recovery_tokens`, `org_memberships`.

**AC-K2.** **Given** the same form, **when** the target user does not exist in this org, **then**
the resulting `404` is caught and surfaced ("User not found") — this should not normally be
reachable via the UI (the action originates from an already-rendered row for a real user), but the
handler must not crash on a stale/tampered request.
- *Example (edge, race — user removed from org in another tab between page load and submit):*
  `404` → friendly message, no unhandled exception.

**AC-K3.** **Given** a user with an **already-pending** erasure request, **when** an `admin`+
clicks "Request erasure" on that same row and submits (e.g. after a page refresh where the row
still shows the plain action, since there's no dedicated "pending erasure" badge feeding row
rendering — see Known Scope Boundary below), **then** the `409 { code:
"erasure_request_already_pending", requestId, piiInventory }` response is caught and the UI
navigates to the **existing** request's page (`/settings/users/[userId]/erasure/[requestId]`)
using the `requestId` from the error body — the reviewer lands on the same review screen either
way, never a raw error for what is, from their perspective, a legitimate "resume review" action.
- *Example (happy path, resumed review):* click "Request erasure" again on a user with a pending
  request → `409` caught silently → same review page as if `201` had been returned.

**AC-K4.** **Given** a user whose erasure has **already completed**, **when** an `admin`+
clicks "Request erasure," **then** the `410 { code: "user_already_erased", requestId,
completedAt }` response is caught and the UI navigates to the completed request's report page
(AC group M) instead — showing the historical compliance record rather than implying a fresh
request is starting.
- *Example (edge, already erased):* `410` → redirected straight to the compliance report view
  (`M` group), skipping the pending-review screen entirely since there is nothing left to review.

**Known Scope Boundary (documented, not a gap to silently fix):** the `/settings/users` list does
not display a "pending erasure" or "erased" badge per row (no endpoint exists to list erasure
request status in bulk for all org users — only per-user, on-demand, via the flows in AC-K3/K4
above). An admin who wants to know a specific user's erasure status must click "Request erasure"
and let the 409/410 short-circuit resolve it, per AC-K3/K4. This is acceptable for this story's
scope (zero new backend); a future story could add a bulk-status endpoint if this becomes a
frequent workflow friction point.

---

### L. Erasure Execution — Confirm & Execute (`owner`-only, MFA, concurrency-safe)

**AC-L1.** **Given** the pending-review screen (`/settings/users/[userId]/erasure/[requestId]`,
status `pending`), **when** an `owner` reviews the PII inventory and clicks "Execute erasure,"
**then** the typed-email confirmation flow (D5) gates the control exactly like AC-J1's pattern, and
on confirmation, `POST .../execute { confirm: true }` is called.
- *Example (happy path):* type the exact target email → "Execute erasure" enables → click → `200 {
  status: "completed", completedAt, revokedSessionCount: 2, auditEventId }` → page transitions
  directly to the compliance-report view (AC group M) showing the just-completed report.

**AC-L2.** **Given** an `admin`-but-not-`owner` viewing the same pending-review page, **when** the
page renders, **then** the PII inventory is fully visible (read-only review is `admin`+, per D7 of
Story 8.4) but the "Execute erasure" control is **not rendered at all** — matching the strict
owner-only execution gate — an `admin` can review and hand off, but cannot pull the trigger.
- *Example (happy path, admin reviewing):* full inventory table visible; where "Execute erasure"
  would be, a plain note: "Only an organization owner can execute this erasure request."

**AC-L3.** **Given** a user who belongs to other organizations (Story 8.4 D2's cross-org guard),
**when** the `owner` attempts to execute, **then** the resulting `409 {
code: "user_has_other_org_memberships", otherOrgCount, remediation }` is caught and its exact
`remediation` string is displayed verbatim ("Contact support to coordinate removal of this user's
membership in the other org(s) before erasure can proceed.") alongside the `otherOrgCount` — the
page remains on the pending-review screen (execution did not proceed, no mutation occurred), so a
retry after the blocking membership is resolved out-of-band works without re-creating the request.
- *Example (failure, cross-org block):* `otherOrgCount: 1` → banner: "This user belongs to 1 other
  organization. Contact support to coordinate removal of this user's membership in the other
  org(s) before erasure can proceed."

**AC-L4.** **Given** two owners racing to execute the same request (Story 8.4 D9's concurrency
guard), **when** the second `execute` call arrives after the first has already claimed the
`in_progress` state, **then** the resulting `409 { code: "erasure_already_in_progress" }` (or
`already_completed`, distinguished per the outcome) is caught and shown as "This erasure is already
being processed" (or "already completed") — the UI does **not** show a generic error or allow a
retry button that would resubmit into the same race; instead it offers a page-refresh/reload
control to pick up the (soon-to-be) completed state.
- *Example (edge, concurrent execute):* Owner A and Owner B both click "Execute erasure" within
  moments of each other on two different tabs/sessions — one succeeds (`200`), the other receives
  `409 erasure_already_in_progress` and is guided to refresh rather than being told to "try again"
  (which would just race again).

**AC-L5.** **Given** the `confirm: false` schema-valid-but-business-rejected case (D6 of Story 8.4
— schema allows `confirm` to be omitted/false, but the handler rejects it), **when** reached (this
should not be reachable through the UI's own flow, since the client only ever submits `confirm:
true` after the typed-email gate passes), **then** the resulting `400 {
code: "confirmation_required" }` is still handled gracefully rather than crashing, as a defensive
boundary in case of a client-state bug.
- *Example (defensive, should-not-happen):* a hypothetical stale client submits `confirm: false` →
  `400` caught → generic "Confirmation is required to execute this erasure" shown, not an
  unhandled exception.

---

### M. Erasure Compliance Report & Download (`admin`+)

**AC-M1.** **Given** a completed erasure request, **when** an `admin`+ views
`/settings/users/[userId]/erasure/[requestId]` (via D6's `GET .../report` returning `200`),
**then** the page renders the full compliance artifact using the **exact** shape
`ErasureReportResponseSchema` returns (`apps/api/src/modules/compliance/schema.ts:62-84` — confirm
against source, not this description, if the two ever appear to disagree): `executedAt`, a **"What
was removed"** list (`piiRemoved`: each entry is `{ table, fields: string[], method }` — e.g.
"sessions — ipAddress, userAgent — nulled"), a **"What was retained"** list (`piiRetained`: each
entry is `{ table, reason }` — **note:** unlike `piiRemoved`, each `piiRetained` entry has no
`fields` array of its own and its per-row justification field is named `reason`, not
`retentionJustification` — e.g. "audit_log_entries — audit log integrity (HMAC-protected,
append-only)"), a separate **top-level `retentionJustification` string** (one value for the whole
report, not per-table — render this once, above or below the `piiRetained` list, clearly
distinguished from each entry's own `reason`), and the `auditEventId` linking to the underlying
`user.erasure_executed` audit row (a plain text value or, if feasible without new backend work, a
link into the Audit Log search page (AC group B) pre-filtered by `resourceId`).
- *Example (happy path):* full report renders with `piiRemoved` rows showing `table`/`fields`/
  `method`, `piiRetained` rows showing `table`/`reason` (no `fields` column for these rows), and
  the single top-level `retentionJustification` string rendered separately — never summarized,
  truncated, or reworded; this is a compliance artifact, and its exact wording from the API is the
  source of truth.
- *Example (failure mode to avoid — flagged by adversarial review, critical):* do **not** implement
  `piiRetained` rows as `{ table, fields, retentionJustification }` — that shape does not exist in
  the API response and will either throw on render or silently drop the real `reason` field.

**AC-M2.** **Given** the rendered report, **when** the `admin`+ clicks "Download compliance
report," **then** `triggerJsonDownload('erasure-report-<requestId>.json', reportData)` (D3) fires,
producing a browser download of the exact JSON payload already on screen — no reformatting,
re-summarizing, or lossy transformation between what's displayed and what's downloaded.
- *Example (happy path):* click download → file `erasure-report-<requestId>.json` downloads,
  content matches the `GET .../report` response's `data` object exactly (pretty-printed for
  readability, per D3's `JSON.stringify(data, null, 2)`).

**AC-M3.** **Given** a request that is still `pending`/`in_progress` (not yet executed), **when**
an `admin`+ navigates directly to its URL, **then** per D6 the `409 erasure_not_yet_completed`
response routes them to the review screen (AC group K/L) instead of a broken report view — there
is no separate "report not ready" dead-end page; the same URL serves both states depending on
server-reported status.
- *Example (edge, not-yet-executed):* an `admin`+ (who cannot execute, only review) visits the URL
  for a still-pending request → sees the K-group review screen, not an error about a missing
  report.

---

### N. Role-Based UI Gating (mirrors backend authorization exactly)

**AC-N1.** **Given** every route this story adds, **when** a role below the endpoint's own
`allowedRoles`/`minimumRole` gate views it, **then** the corresponding restricted control is
**never rendered** (not merely disabled) — matching Story 6.4 AC-I1's existing convention — with
one narrow exception already specified: `/settings/audit`, `/settings/audit/access-report`, and
`/settings/audit/forwarding` render an honest **page-level** "requires owner/admin role" notice
(AC-B4) rather than omitting entire pages from navigation, since these pages have no
role-conditional sub-content to selectively hide — the whole page's premise is `owner`/`admin`+
scoped.
- *Example (viewer, `/settings/users`):* sees the users list; sees neither "Request erasure" nor
  "Pseudonymize identity" nor "Deactivate account" (all `admin`+/`owner`-only) — read-only view
  only, matching the page's pre-existing convention for these controls.
- *Example (admin, `/settings/audit/forwarding`):* full read/write access (this page's gate is
  `admin`+, not `owner`-only) — both forwarding and retention forms fully usable.
- *Example (admin, `/settings/audit`):* page-level notice — this page is `owner`-only, stricter
  than the forwarding/retention page.

**AC-N2.** **And** every new `+page.server.ts` load function calls `requireUser(locals)` before
any API call, exactly like every existing authenticated page in this app — an unauthenticated
direct-URL visit to any new route redirects to `/login`, never reaching a partially-rendered
authenticated view.
- *Example:* an unauthenticated request to `/settings/audit` → `303` redirect to `/login`, matching
  `settings/users/+page.server.ts`'s existing behavior.

---

### O. Audit & Dashboard Truth — No Fabricated Data, Honest Empty States (G3)

**AC-O1.** **Given** any table or count this story renders (audit-events total, access-report user
count, PII-inventory row counts, dormant-alert counts), **when** the underlying data is genuinely
zero, **then** the UI shows a real, honest zero or an explicit empty-state sentence — never a
hidden section (which would be indistinguishable from a loading/error state) and never a fabricated
non-zero placeholder.
- *Example (happy path, real zero):* an org with zero audit events shows "No audit events yet." —
  a real, distinguishable-from-loading empty state.
- *Example (failure mode to avoid):* do **not** hide the entire Export/Verify panels when the
  search table is empty — a compliance officer must still be able to attempt an export or a
  verification check against an empty range (which itself is a valid, testable outcome per AC-C1's
  "no rows" edge case), not have the controls disappear because the table above happened to be
  empty.

**AC-O2.** **And** no page introduced by this story claims a capability that isn't real — e.g. the
Forwarding page's help copy (AC-E4) must not imply the current config is viewable when it isn't;
the dormancy-threshold help copy (AC-I3) must not imply retroactive reconciliation happens when it
doesn't. Every documented scope boundary in this story (D2, D5's UI-only nature, the K-group
"Known Scope Boundary") must be reflected honestly in the shipped UI copy, not just in this story
file.
- *Example (regression check):* grep the new `.svelte` files for language like "current
  configuration" or "your saved settings" anywhere near the forwarding/retention/dormancy forms —
  none should appear, since none of the three has a readback path (D2).

---

## Tasks / Subtasks

- [ ] **Task 1: Route scaffolding + navigation** (AC-A1–A4, N2)
  - [ ] `/settings/audit/+page.svelte` + `+page.server.ts` (search/export/verify sections)
  - [ ] `/settings/audit/access-report/+page.svelte` + `+page.server.ts`
  - [ ] `/settings/audit/forwarding/+page.svelte` + `+page.server.ts`
  - [ ] `/settings/users/[userId]/erasure/[requestId]/+page.svelte` + `+page.server.ts`
  - [ ] New tile on `/settings/+page.svelte`; new row actions on `/settings/users/+page.svelte`
- [ ] **Task 2: API client wrappers** (all AC groups)
  - [ ] `apps/web/src/lib/api/audit.ts` (search, export trigger/status, verify, access-report)
  - [ ] `apps/web/src/lib/api/compliance.ts` (erasure create/execute/report, pseudonymize)
  - [ ] `apps/web/src/lib/download.ts` (`triggerJsonDownload`, `triggerTextDownload`, D3)
- [ ] **Task 3: Audit Log page — search, export, verify** (AC groups B, C, D)
- [ ] **Task 4: Forwarding & Retention page** (AC groups E, F)
- [ ] **Task 5: Access Report page** (AC group G)
- [ ] **Task 6: Dormant user alerts in Notifications inbox** (AC group H)
  - [ ] `toUserDormancyAlertViews()` sibling to Story 8.6's `toDormancyAlertViews()`
- [ ] **Task 7: User dormancy threshold on Users settings** (AC group I)
- [ ] **Task 8: Pseudonymize action on Users settings** (AC group J)
- [ ] **Task 9: Erasure request creation + PII inventory review** (AC group K)
- [ ] **Task 10: Erasure execution flow** (AC group L)
- [ ] **Task 11: Erasure compliance report + download** (AC group M)
- [ ] **Task 12: Role-gating pass + dashboard/audit-truth pass** (AC groups N, O)
- [ ] **Task 13: Full regression** — `pnpm turbo typecheck`, `pnpm turbo lint`, `pnpm jscpd` (0
      clones — reuse `DataTable.svelte`/`ConfirmDeleteButton.svelte` deliberately to avoid new
      clones), full `apps/web` test suite, `make ci` (zero `apps/api`/`packages/db` diff expected —
      confirm no accidental backend changes crept in per this story's `web`-only Product Surface
      Contract scope), **and AC-O2's regression grep**: `grep -rniE "current configuration|your
      saved (config|settings)" apps/web/src/routes/**/audit*/**/*.svelte
      apps/web/src/routes/**/settings/users/**/*.svelte` must return zero matches near the
      forwarding/retention/dormancy-threshold form copy (adversarial review, low: this was
      previously a manual-only check with no automated enforcement, making it the easiest AC in
      the story to silently skip — run it as an explicit step of this task, not just informally)

---

## Dev Notes

### Project Structure Notes

- **Web only.** No changes anywhere under `apps/api/`, `packages/db/`, or `packages/shared/` are
  expected. If implementation reveals a genuine need for backend change (e.g. a missing field the
  UI cannot function without), stop and re-read this story's Product Surface Contract and D1/D2 —
  the intended design already routes around every known gap without backend changes; a perceived
  need for one likely means a design decision above was missed, not that a new one is required.
- New routes live under `apps/web/src/routes/(app)/settings/audit/` and
  `apps/web/src/routes/(app)/settings/users/[userId]/erasure/[requestId]/` — following this app's
  existing `(app)` route-group and nested-dynamic-segment conventions exactly (compare
  `apps/web/src/routes/(app)/projects/[projectId]/machine-users/[machineUserId]/`, Story 8.6).
- No other Epic 8/9 story's scope is touched. Do not fold any Epic 9 concerns (platform operator
  audit log, Story 9.4 — a structurally separate table/UI) into this story.

### Key Code Patterns to Follow

- **Tables:** `DataTable.svelte` (Story 8.6) for the audit-events search table and the
  access-report table.
- **Confirmation-before-destructive-action:** `ConfirmDeleteButton.svelte` for dismiss, deactivate,
  pseudonymize, and erasure-execute — do not invent a second confirmation pattern.
- **Typed-identifier confirmation (D4/D5):** a small, reusable component, `TypedConfirmInput.svelte`,
  used identically for pseudonymize (AC-J) and erasure-execute (AC-L) — do not duplicate this logic
  twice by hand. Minimum contract (adversarial review, medium: this component gates the story's two
  highest-stakes irreversible actions and had no acceptance-level spec of its own):
  - **Props:** `expectedValue: string` (the target email to match against).
  - **Behavior:** binds an internal text input; on every keystroke, compares the current input
    value against `expectedValue` using a **case-insensitive, trimmed** match (`input.trim().toLowerCase()
    === expectedValue.trim().toLowerCase()`) — see D4/D5's case-sensitivity note below for why.
  - **Exposes:** a boolean (prop binding, event, or exported function — implementer's choice of
    Svelte idiom) indicating whether the current input matches, which the parent (`AC-J1`'s
    pseudonymize dialog, `AC-L1`'s execute dialog) uses to enable/disable its submit control. The
    component itself renders no submit button — it only gates one.
  - **No other state:** it does not call any API, does not know about `confirmUserId` or
    `{ confirm: true }` — those request-shape decisions stay in the parent component per D4/D5.
- **File download (D3):** plain `<a href>` for the audit CSV export (server sets
  `Content-Disposition`); `triggerJsonDownload()` for the JSON compliance report;
  `triggerTextDownload()` for the access-report CSV (`POST`-only endpoint, no
  `Content-Disposition` — client-constructed filename).
- **No-readback forms (D2):** always-empty initial state + explicit "we don't display your current
  setting" help copy — apply identically to forwarding, retention, and the user-dormancy threshold.
- **429 (rate-limit) handling (adversarial review, low):** this story's UI calls several endpoints
  with meaningful per-minute caps — `GET /audit/verify` (20/min, AC group D), `GET
  /audit/exports/:jobId` (60/min, AC-C1's poller — handled explicitly there), and `POST
  /audit/access-report` (30/min, AC group G, double-counted for CSV downloads per AC-G3's
  duplicate-request note). Every one of these must catch a `429` the same way every other
  `ApiClientError` status is already handled elsewhere in this story (D-group's error-mapping
  convention) — a friendly "You're doing that too quickly — please wait a moment and try again"
  message, never an unhandled exception or a silent retry loop. AC-C1 specifies the exact bounded
  behavior for the export poller; the verify (D) and access-report (G) forms are simpler
  one-shot submissions and just need the same catch-and-friendly-message treatment as their other
  documented error cases (AC-D3, AC-G2's `422` handling), not a bespoke retry mechanism of their
  own.

### Anti-Patterns (Do Not)

- Do NOT add any new backend `GET` endpoints to work around D2's no-readback limitation — this is
  an explicit, accepted scope boundary for this story, not an oversight.
- Do NOT build a fourth confirmation-dialog pattern — reuse `ConfirmDeleteButton.svelte`.
- Do NOT build a separate dormancy-specific inbox page for AC group H — extend the existing
  `/notifications` Security Alerts surface, per Story 8.6's own precedent for the identical
  decision.
- Do NOT attempt a client-side SSRF pre-check for forwarding URLs/S3 endpoints (AC-E2/E3) — DNS
  resolution is not available in a browser context; this is correctly a server-only check.
- Do NOT let the erasure-execute or pseudonymize typed-confirmation UI imply it changes the actual
  request body beyond what the server's schema defines (D4/D5) — these are UI-only friction
  layers, not new request fields.
- Do NOT mark any AC "done" without exercising its failure/edge cases, not just its happy path —
  per this story's own instruction to provide concrete positive *and* negative examples for every
  AC, the same discipline applies to actually testing them.

### References

- `_bmad-output/implementation-artifacts/epic-8-retro-2026-07-07.md` — source retro for this
  story's Finding 2 / Action Item A8-1.
- `_bmad-output/implementation-artifacts/8-1-tamper-evident-audit-log-with-hmac-integrity.md` —
  `GET /audit/verify` semantics, non-cryptographer-friendly summary requirement (UX-DR13).
- `_bmad-output/implementation-artifacts/8-2-audit-log-search-export-and-external-forwarding.md` —
  search/export/forwarding/retention endpoint contracts, SSRF protections (D4), retention bounds
  (D7), export storage mechanism (D8).
- `_bmad-output/implementation-artifacts/8-3-access-reports-dormant-users-and-audit-pii-management.md`
  — access-report two-path design (D2), pseudonymization idempotency (D8), cross-org bleed (D9),
  dormancy-threshold non-retroactivity (D12).
- `_bmad-output/implementation-artifacts/8-4-data-subject-erasure-request-handling.md` — erasure
  request/execute/report contracts, cross-org guard (D2), concurrency guard (D9), PII inventory
  shape.
- `_bmad-output/implementation-artifacts/8-6-epic-7-completion-machine-user-web-ui-and-hardening.md`
  — sibling closure-story precedent; source of `DataTable.svelte`, dormancy-alert-view shape, and
  the no-GET-readback UI precedent this story extends.
- `_bmad-output/implementation-artifacts/6-4-epic-6-completion-monitored-asset-management-ui-and-technical-debt.md`
  — source of `ConfirmDeleteButton.svelte` and this story's lettered-AC-group format.
- `_bmad-output/implementation-artifacts/product-surface-contract.md` — G1–G4 rules this story's
  Product Surface Contract section and navigation/dashboard-truth ACs (group O) satisfy.
- `_bmad-output/planning-artifacts/prd.md` — Dana persona (`prd.md:241`, "she opens Project Vault's
  audit log interface"), FR40–FR44/FR69–FR71/FR102 narrative context.
- `_bmad-output/planning-artifacts/ux-design-specification.md:82-87` — "terminated-employee access
  is a frequent auditor question" (access-report persona rationale), `:83` "filterable, exportable
  audit logs" (Dana's stated need).

---

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
