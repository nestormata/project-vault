# Story 5.4: Rotation Workflow Web UI

Status: done

<!-- Ultimate context engine analysis completed 2026-07-05 — comprehensive developer guide for the web-UI companion to Stories 5.1/5.2/5.3 (all `done`, all API-only). This story adds ZERO new backend routes, ZERO new DB migrations, ZERO new audit events — every mutation this story's UI performs calls an already-shipped, already-tested Epic 5 endpoint verbatim. Confirmed via direct inspection of `apps/api/src/modules/rotation/routes.ts` (migration `0033_break_glass_and_stale_recovery` is the latest in `packages/db/src/migrations/meta/_journal.json` — 5.1/5.2/5.3's full schema is live) that every endpoint referenced below exists today with the exact path, role gate, and error-code shape documented here. This story is scheduled per the 2026-07-05 Epic 5 retrospective specifically to close the Product-Surface-Contract gap all three prior stories flagged as `TBD` — see `_bmad-output/implementation-artifacts/deferred-work.md` line 68. -->

## Story

As a developer or organization admin managing credential rotations,
I want a web UI to initiate rotations, work through the confirmation checklist, complete or abandon rotations, and trigger break-glass emergency rotation during an incident,
so that I don't have to use `curl`/Postman against the API to do the one thing Epic 5 exists for.

*Covers: the web-UI surface for FR18, FR19, FR20, FR21, FR22, FR23, FR65, FR66, FR75, FR104, FR108 — all already implemented API-side by Stories 5.1, 5.2, 5.3.* [Source: `_bmad-output/planning-artifacts/epics.md#Epic-5-Credential-Rotation--Safe-Trackable-Rotation-Workflows`]

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 5.1 (`rotations`, `rotation_checklist_items`, initiate + read endpoints) — `done` | This story's "Start rotation" and "Rotation history" UI call these endpoints exactly as shipped. |
| Story 5.2 (confirm/fail/retry/complete, `GET .../rotations/upcoming`) — `done` | This story's checklist UI and dashboard widget call these endpoints exactly as shipped. |
| Story 5.3 (break-glass, resume/abandon, stale-recovery) — `done` | This story's break-glass and stale-recovery UI call these endpoints exactly as shipped. |
| Story 2.2 (credential detail page, `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte`) — `done` | This story adds a "Start rotation" entry point and a "Rotations" history section to this **existing** page — it does not replace it. |
| Story 2.4 (`credential_dependencies` list/add/archive endpoints) — `done` | This story's "Start rotation" preview screen and post-break-glass sweep reminder both call the **existing** `GET .../credentials/:credentialId/dependencies` endpoint — no dependency-CRUD UI is built here (see "Explicit Out of Scope"). |
| Epic 2's web pairing precedent (Stories 2.0/2.1/2.2/2.3) | Established the SvelteKit conventions (`$lib/api/*.ts` client modules wrapping `apiFetch`/`parseApiEnvelope`, `PageServerLoad` + client-side `$state` forms, `AccessNotice.svelte` for role-gated denial, Tailwind v4 utility classes) this story follows verbatim — see "Key Code Patterns to Follow". |

---

## Why this story exists (read before coding)

Stories 5.1, 5.2, and 5.3 were each explicitly scoped `api`-only in their own Product Surface Contract sections, and each one's "Linked UI story" field said `TBD` with an identical blocking note: *"Epic 5 has no dedicated frontend/web story, unlike Epic 2's API+web pairing."* The 2026-07-05 Epic 5 retrospective resolved that gap by scheduling this story rather than deferring it indefinitely (`sprint-status.yaml`: `epic-5: in-progress # held open pending 5-4`; `deferred-work.md` line 68: *"Resolved 2026-07-05 (Epic 5 retro): scheduled as `5-4-rotation-workflow-web-ui`"*). **This story is the payoff of that decision.** When this story reaches `done`, `epic-5` can finally move to `done` in `sprint-status.yaml` (subject to Story 5.5's separate hardening work also completing — see "Epic Cross-Story Context").

Every acceptance criterion below was written after directly reading `apps/api/src/modules/rotation/routes.ts`, `apps/api/src/modules/rotation/schema.ts`, and `packages/shared/src/schemas/rotations.ts` in this branch — not from the epic prose alone. Where epic/PRD language and actual shipped code differ (there are no such conflicts found for this story — 5.1/5.2/5.3 already resolved all of them), the shipped code in those three files is authoritative.

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — this story *is* the linked UI story for 5.1/5.2/5.3. |
| **Honest placeholder AC** (if UI deferred) | N/A — no UI is deferred by this story. Dependent-system **management** (add/edit/archive UI, as opposed to the read-only preview this story ships) remains explicitly out of scope — see "Explicit Out of Scope" — and is tracked as its own pre-existing `deferred-work.md` line 64 entry (`Dependent systems (list/create/archive) | 2.4 | Not on credential detail page | Epic 5 prep UI or 2.x follow-up`), which this story does not fully resolve, only partially (read-only preview only). |
| **Persona journey** | See below. |

### Persona journey stub

**Morgan (member role, mid-size team persona from `ux-design-specification.md`)** rotates a leaked API key end-to-end:
1. Opens the credential's detail page (`/projects/:id/credentials/:id`), sees a **Start rotation** button (previously nothing — this story's own new CTA).
2. Clicks it, lands on `/projects/:id/credentials/:id/rotate`, sees a live preview of the dependent systems that will become checklist items, pastes the new value, submits.
3. Redirected to the new rotation's detail page (`/projects/:id/credentials/:id/rotations/:rotationId`), sees each dependent system as a checklist row with **Confirm** / **Report a problem** buttons.
4. Confirms each system as it's verified updated; if one fails, uses **Report a problem** (records a reason, keeps the rotation open per FR75) then **Retry** once fixed.
5. Once every item is confirmed, an **admin/owner** teammate (Morgan is `member` and cannot complete — role-gated, AC-16/AC-19) clicks **Complete rotation**; the page shows the rotation as `completed`.

**Alex (org admin) during an incident** uses break-glass: from the same `/rotate` page, opens the **Emergency: break-glass rotation** panel (admin/owner only — hidden entirely for Morgan), types a reason, confirms, and immediately sees the new value is live plus a "systems that still need the new value" sweep reminder pulled from the credential's existing dependency list.

**Riley (viewer role)** opens any rotation detail page and sees the full checklist read-only — no action buttons render, matching the existing `AccessNotice`/`canReveal`-style gating precedent from Story 2.2's page.

---

## Epic Cross-Story Context

| Story | Relationship to 5.4 |
|---|---|
| 5.1 | Source of `POST .../rotations` (initiate), `GET .../rotations/:rotationId` (detail), `GET .../rotations` (history). This story's initiate page and history section call these three verbatim. |
| 5.2 | Source of `POST .../checklist/:itemId/{confirm,fail,retry}`, `POST .../rotations/:rotationId/complete`, `GET .../rotations/upcoming`. This story's checklist UI, complete button, and dashboard widget call these four verbatim. |
| 5.3 | Source of `POST .../rotations/break-glass`, `POST .../rotations/:rotationId/{resume,abandon}`. This story's break-glass panel and stale-recovery banner call these three verbatim. |
| 5.5 (`5-5-epic-5-completion-rotation-hardening-and-technical-debt.md`, `ready-for-dev`) | A **separate, parallel** closure story bundling 13 backend hardening findings from the 2026-07-05 retro (self-attestation gaps, reveal-regression safety net, TOCTOU race, etc.). **Zero overlap** with this story — 5.5 touches `apps/api/**`/`packages/db/**` only; this story touches `apps/web/**` only. Both must reach `done` before `epic-5: done` (Product Surface Contract G2). Do not duplicate 5.5's backend work here, and do not expect 5.5 to touch any web file. |
| 2.0/2.1/2.2 | Established every SvelteKit convention this story reuses: `PageServerLoad` + `requireUser(locals)`, `$lib/api/*.ts` client wrappers, `AccessNotice.svelte`, Tailwind v4 card/section classes, `resolve()` for typed route hrefs. |
| 2.4 | `GET /api/v1/projects/:projectId/credentials/:credentialId/dependencies` (already shipped, `viewer`+) is this story's **read-only** data source for the "systems that will be included" preview on the initiate page and the post-break-glass sweep reminder. This story adds no dependency mutation UI. |

---

## Ground-Truth API Surface This Story Consumes

*(Verified directly against `apps/api/src/modules/rotation/routes.ts` and `apps/api/src/modules/credentials/routes.ts` in this branch — every path, role, and error code below is live and tested today, not aspirational.)*

| Method & path | Min role | Success | Key error codes |
|---|---|---|---|
| `POST /api/v1/projects/:projectId/credentials/:credentialId/rotations` | `admin` | `201 { data: RotationDetail }` | `409 rotation_in_progress`, `422 validation_error`, `503` (sealed) |
| `GET /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId` | `viewer` | `200 { data: RotationDetail }` | `404 rotation_not_found` |
| `GET /api/v1/projects/:projectId/credentials/:credentialId/rotations` | `viewer` | `200 { data: { items: RotationSummary[], page, limit, total, hasMore } }` | — |
| `POST .../rotations/:rotationId/checklist/:itemId/confirm` | `member` | `200 { data: { item, rotationVersion } }` | `409 already_confirmed`, `422 rotation_not_active` |
| `POST .../rotations/:rotationId/checklist/:itemId/fail` | `member` | `200 { data: { item, rotationVersion } }` | `422 invalid_item_status`, `422 rotation_not_active` |
| `POST .../rotations/:rotationId/checklist/:itemId/retry` | `member` | `200 { data: { item, rotationVersion } }` | `422 max_retries_exceeded`, `422 invalid_item_status` |
| `POST .../rotations/:rotationId/complete` | `admin` | `200 { data: RotationDetail }` | `422 checklist_incomplete`, `422 acknowledgement_required` |
| `POST .../rotations/break-glass` | `admin` (org_admin tier = admin+owner) | `201 { data: RotationDetail }` (`checklistItems: []`, `previousVersionOverlap` present) | `403 insufficient_role`, `422 validation_error`, `409 rotation_lock_contention` |
| `POST .../rotations/:rotationId/resume` | `admin` | `200 { data: RotationDetail }` | `422 rotation_not_stale`, `409 concurrent_modification` |
| `POST .../rotations/:rotationId/abandon` | `admin` | `200 { data: RotationDetail }` | `422 rotation_not_stale`, `409 concurrent_modification` |
| `GET /api/v1/projects/:projectId/rotations/upcoming?horizon=7d\|30d\|90d` | `viewer` | `200 { data: { items: UpcomingRotation[] } }` | — |
| `GET /api/v1/projects/:projectId/credentials/:credentialId/dependencies` | `viewer` | `200 { data: { items: CredentialDependency[], hasDependencies } }` | — |
| Any of the above | any | — | `404` (cross-tenant/nonexistent, no enumeration), `503 { status: "sealed" }` while vault sealed |

**Shared types already exported from `@project-vault/shared`** (no new shared-schema work needed): `RotationDetail`, `RotationSummary`, `RotationChecklistItem`, `RotationStatus` (`'in_progress' | 'completed' | 'abandoned' | 'stale_recovery' | 'break_glass_complete'`), `RotationChecklistItemStatus` (`'unconfirmed' | 'confirmed' | 'failed' | 'max_retries_exceeded'`), `UpcomingRotation` (`{ credentialId, credentialName, scheduledAt, status: 'pending'|'overdue' }`), `CredentialDependency`.

**Important, verified-not-assumed nuance (read before AC-11):** the break-glass response's `checklistItems` is always `[]` — break-glass never creates checklist items (5.3 AC-2, by design). The "sweep checklist" of dependent systems PJ8 requires is delivered server-side only via the **notification payload** (email/Slack), never in the HTTP response body (5.3 AC-7: *"the sweep checklist is delivered via the notification payload, not the HTTP response body ... this story's API-side deliverable is the notification payload carrying the data"*). **This story's UI must independently call `GET .../dependencies` after a successful break-glass response to render its own on-screen sweep reminder** — it cannot read this list off the break-glass response itself. This is a UI-side data-fetch decision, not a backend change.

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| Entry point | Credential detail page gains a "Start rotation" CTA (or "View active rotation" if one exists) — no dead links (G3). |
| Initiate page | `/projects/:projectId/credentials/:credentialId/rotate` — dependency preview (read-only), new-value form, submit → redirect to rotation detail. `admin`/`owner` only; `AccessNotice` for others. |
| Checklist page | `/projects/:projectId/credentials/:credentialId/rotations/:rotationId` — renders full checklist, confirm/fail/retry buttons (`member`+), complete button (`admin`+), resume/abandon banner when `stale_recovery` (`admin`+), all read-only for `viewer`. |
| Break-glass | Panel on the initiate page, `admin`/`owner` only, required reason field, confirmation step, post-success sweep reminder (fetched separately — see nuance above). |
| History | Rotation history list on credential detail page, paginated, links to each rotation's detail page. |
| Dashboard | Project dashboard's already-fetched-but-unrendered `data.dashboard.upcomingRotations` is rendered for the first time (G3 dashboard truth) with an "Overdue" badge and link into the credential. |
| Live status | Manual refresh + auto-poll every 15s while a rotation is `in_progress`/`stale_recovery`; no new SSE wiring (explicit scope decision — see "Design Decisions"). |
| Errors | Every documented error code above is mapped to a specific, non-generic on-screen message; 404/503 share the existing credential-detail-page pattern. |
| Security | No new backend authorization — this story is presentation-only over already-role-gated endpoints. Client-side role checks are UX-only (hide buttons); the server remains the sole enforcement point, and every AC below double-checks the server-rejection path renders correctly, since a hidden button is not a security boundary. |
| Tests | Vitest + `@testing-library/svelte` component tests, `PageServerLoad` unit tests, `$lib/api/rotations.ts` client tests (mocked `fetch`). No Playwright (matches current repo state — `deferred-work.md` line 67, unchanged by this story). |

---

### Design Decisions (Read First)

| # | Decision | Rationale |
|---|---|---|
| D1 | **No new SSE wiring.** `packages/shared/src/schemas/sse-payloads.ts` already reserves a `'rotation.completed': { rotationId, orgId }` SSE payload type, but grep-confirmed **nothing in `apps/api/src` ever calls `emitSseEvent(..., 'rotation.completed', ...)`** — only `notification-inbox.ts` calls `emitSseEvent` today (for `'notification.inbox'`). Wiring that emit call is a backend change and therefore out of scope for a `web`-surface story (it would also require its own test coverage in `apps/api`). This story instead polls: the rotation detail page re-fetches every 15s while `status` is `in_progress` or `stale_recovery`, and stops polling once the status is terminal (`completed`/`abandoned`/`break_glass_complete`) or the tab is hidden (`document.visibilityState`). A manual "Refresh" button is always available. **Flag, do not fix**: wiring the reserved `rotation.completed` SSE emit is a clean, small follow-up for a future backend story once a real-time consumer (this one) exists to justify it — note this in the PR description. |
| D2 | **No dependency-management UI.** The initiate-page preview and the break-glass sweep reminder are **read-only** renders of `GET .../dependencies`. Add/edit/archive dependency UI remains the pre-existing `deferred-work.md` line 64 gap and is not resolved by this story (only the read path is now exposed in two new places). Building CRUD here would be undirected scope creep beyond "the rotation workflow web UI." |
| D3 | **Break-glass and normal initiation share one route** (`/rotate`), not two. Both are "ways to start a rotation" for the same credential; splitting them into separate URLs would let a `member` accidentally land on a page whose primary content (break-glass) they can't use, and would double the "is there already an active rotation" guard logic. The break-glass panel renders conditionally by role within the same page. |
| D4 | **Resume/abandon live on the rotation detail page, not a separate route.** `stale_recovery` is a *status* a rotation can be in, not a distinct workflow — showing the decision banner in-context on the same checklist page an admin was already looking at avoids a navigation dead-end when a rotation goes stale mid-session (the poll from D1 will flip the page into showing the banner without a reload). |
| D5 | **Confirm/fail/retry/complete never lock the page during in-flight requests beyond disabling the clicked button.** Reusing Story 2.2's `revealing`/`submitting` `$state` boolean-per-action pattern (not a single page-wide spinner) so a `member` confirming item 3 doesn't block item 1's button from being clickable while the request is in flight — matches the granularity of the existing credential-detail page's `revealing` state. |
| D6 | **`hasDependencies: false` on the initiate page is not an error.** A credential can rotate with zero dependencies (5.1 AC allows an empty checklist); the preview simply says so, and the completion flow's `acknowledgedNoDependencies` requirement (AC-18) is surfaced only when it becomes relevant (at complete-time, not at initiate-time — that gate belongs to 5.2, not 5.1, and this UI respects that boundary exactly as the API does). |

---

### AC-1: Credential Detail Page — "Start Rotation" Entry Point (No Active Rotation)

**Given** a credential has no rotation currently `in_progress`, `stale_recovery`, or `break_glass_complete`-with-unexpired-overlap (i.e., the most recent rotation, if any, is `completed`/`abandoned`, or none exists),
**When** a user with `admin`/`owner` role views `/projects/:projectId/credentials/:credentialId`,
**Then** a **"Start rotation"** button renders in a new "Rotation" section on the page (below "Version history", following the existing section pattern: `rounded-2xl border border-slate-200 bg-white p-6 shadow-sm`), linking to `/projects/:projectId/credentials/:credentialId/rotate` via `resolve()`.

**Example (happy path):** Credential `sk_stripe` has one prior rotation, `completed` on 2026-06-01. Morgan (admin) opens the credential page; sees "Start rotation" enabled, clicks it, lands on the initiate page.

**Edge case — `member`/`viewer` role:** the section still renders (so a member can see rotation *history*, AC-6) but shows explanatory text instead of the button: *"Starting a rotation requires Admin access or higher."* — no link to `/rotate` is rendered at all for these roles (not just disabled — omitted, so there's no dead click target, matching `AccessNotice`'s "don't render what you can't do" convention already used for `canCreateCredential`).

**Edge case — brand-new credential, zero rotations ever:** section still renders with the "Start rotation" button (for admin/owner) and an empty-state message for history: *"No rotations yet."*

---

### AC-2: Credential Detail Page — Active Rotation Redirect (No Dead Ends)

**Given** a credential already has a rotation whose `status` is `in_progress`, `stale_recovery`, or `break_glass_complete` with a non-expired `previousVersionOverlap`,
**When** any user loads `/projects/:projectId/credentials/:credentialId`,
**Then** the "Rotation" section shows **"View active rotation"** (not "Start rotation") linking directly to `/projects/:projectId/credentials/:credentialId/rotations/:activeRotationId` — determined server-side in `+page.server.ts` by inspecting the first item of `GET .../rotations?limit=1` (history is already ordered most-recent-first per 5.1) and checking its `status`.

**Example:** Credential has a rotation `in_progress` from an hour ago with 2/3 items confirmed. Any role (viewer included) sees "View active rotation (2/3 confirmed)" instead of a "Start rotation" button — **never** a link to `/rotate` while active (G3: no navigation to a page that would just 409).

**Edge case — race condition:** a second admin already completed the rotation in another tab 5 seconds ago; this admin's stale page still shows "View active rotation" — clicking it lands on the now-`completed` rotation detail page, which correctly shows a completed state (AC-9) rather than erroring; no special handling needed because the rotation detail page always reflects live server state on load.

---

### AC-3: Initiate Rotation Page — Dependency Preview (Happy Path)

**Given** a user with `admin`/`owner` role navigates to `/projects/:projectId/credentials/:credentialId/rotate` for a credential with 3 non-archived dependencies,
**When** the page's `PageServerLoad` runs,
**Then** it calls `GET /api/v1/projects/:projectId/credentials/:credentialId/dependencies` (new `$lib/api/dependencies.ts` client function, or added to `$lib/api/credentials.ts` — dev's choice, follow existing file-per-resource convention) and renders a read-only list: *"This rotation will create a checklist item for each of these 3 systems:"* followed by each `systemName`.

**Example response consumed:**
```json
{ "data": { "items": [
  { "id": "d1", "systemName": "billing-worker (production)", "systemType": "internal_service", "archivedAt": null, "createdAt": "...", "createdBy": null, "updatedAt": "...", "notes": null, "credentialId": "..." },
  { "id": "d2", "systemName": "GitHub Actions", "systemType": "ci_cd", "archivedAt": null, "createdAt": "...", "createdBy": null, "updatedAt": "...", "notes": null, "credentialId": "..." },
  { "id": "d3", "systemName": "Vercel env vars", "systemType": "hosting", "archivedAt": null, "createdAt": "...", "createdBy": null, "updatedAt": "...", "notes": null, "credentialId": "..." }
], "hasDependencies": true } }
```

**Edge case — zero dependencies:** `hasDependencies: false`, `items: []` — the preview instead reads *"No dependent systems are recorded for this credential. The rotation will still be created, but the checklist will be empty — you'll need to explicitly acknowledge that before completing it."* (foreshadows AC-18, does not block initiation per D6).

---

### AC-4: Initiate Rotation Page — Submit New Value (Happy Path)

**Given** the preview from AC-3 has rendered,
**When** the user types a new value into a `<textarea>` (masked as `type="password"`-equivalent is not applicable to textarea; use a monospace, non-autocomplete field matching the reveal-value styling precedent) and clicks **"Start rotation"**,
**Then** the page calls `POST /api/v1/projects/:projectId/credentials/:credentialId/rotations` with `{ newValue }` (an optional `notes` textarea is also offered, mapped 1:1 to the API's optional `notes` field), and on `201` redirects via `goto(resolve(...))` to `/projects/:projectId/credentials/:credentialId/rotations/:newRotationId` (the `id` from the response's `data`).

**Example request:**
```json
{ "newValue": "sk_live_NEW_VALUE_abc123", "notes": "Rotating after the June security review" }
```

**Edge case — value left empty:** client-side validation (mirroring `validateCredentialForm`'s pattern from onboarding-logic.ts) blocks submission with *"New value cannot be empty"* before any request is sent — matches the existing credential-creation form's client-side-then-server-side double validation.

**Edge case — server-side `422 validation_error`** (e.g., value exceeds 65536 chars — a limit this form does not need to duplicate client-side beyond a soft character counter, since the server is authoritative): the page surfaces the API's `message` field directly under the textarea, form is not cleared, user can edit and resubmit — same non-destructive-on-error UX as the existing credential-creation form (`mapCredentialSubmitError`-style handling).

---

### AC-5: Initiate Rotation Page — Concurrent Rotation Already In Progress (409)

**Given** two admins independently open `/rotate` for the same credential at nearly the same time (neither saw AC-2's redirect because both loaded the credential page before either started rotating),
**When** the second submission's `POST .../rotations` call returns `409 { code: "rotation_in_progress", message: "...", rotationId }`,
**Then** the page does **not** show a generic error — it shows: *"A rotation is already in progress for this credential."* with a link to `/projects/:projectId/credentials/:credentialId/rotations/:rotationId` using the `rotationId` from the error body, so the second admin lands exactly where AC-2 would have sent them, losing zero context.

**Test:** mock `apiFetch` to reject with `ApiClientError(409, { code: 'rotation_in_progress', rotationId: 'r-1', message: '...' }, '...')`; assert the rendered link's `href` resolves to `/projects/p-1/credentials/c-1/rotations/r-1`.

---

### AC-6: Initiate Rotation Page — Role Gating (403 / Hidden)

**Given** a `member` or `viewer` navigates directly to `/projects/:projectId/credentials/:credentialId/rotate` by URL (bypassing AC-1's button, which they'd never see rendered),
**When** the page's `PageServerLoad` runs,
**Then** it renders `AccessNotice` (`title: "Rotation not available"`, `message: "Starting a rotation requires Admin access or higher."`, `backHref: /projects/:projectId/credentials/:credentialId`) instead of the form — the page never issues the `POST` at all in this case (checked via `data.orgRole` server-side in `+page.server.ts`, identical to the existing `new`/credential-creation page's `canCreate` gate), so there is no client-visible 403 flash.

**Edge case — role downgraded mid-session:** an admin has the `/rotate` page open in a stale tab, gets demoted to `member` by another admin, then submits. The server rejects with `403 insufficient_role` (this is the real, load-bearing security boundary — the client-side gate above is UX-only per the AC Quick Reference's Security row); the page shows: *"You do not have permission to start a rotation."* and does not redirect (matches `mapCredentialSubmitError`'s existing 403 handling pattern in onboarding-logic.ts, extended with a rotation-specific message).

---

### AC-7: Rotation Detail Page — Render Checklist (Happy Path)

**Given** a rotation `in_progress` with 3 checklist items (`unconfirmed`, `confirmed`, `failed`),
**When** any user with `viewer`+ role loads `/projects/:projectId/credentials/:credentialId/rotations/:rotationId`,
**Then** the page renders: rotation-level metadata (status badge, initiated-by/at, notes), and one row per checklist item showing `systemName`, a status badge (`unconfirmed` = slate, `confirmed` = emerald matching the existing "Current" version badge styling, `failed` = red, `max_retries_exceeded` = red with a "max retries" label), `retryCount` when > 0, and `lastFailureReason` when present.

**Example rendered state:**
```
Rotation status: in_progress · Initiated 2026-07-01 14:10 by Morgan
┌─────────────────────────────┬─────────────┬────────────┐
│ billing-worker (production)  │ confirmed   │            │
│ GitHub Actions                │ failed      │ retry: 1   │
│ Vercel env vars                │ unconfirmed │            │
└─────────────────────────────┴─────────────┴────────────┘
```

**Edge case — rotation belongs to a different org / doesn't exist (404):** page renders the identical "not found" block already used by the credential detail page for `data.notFound` (`role="alert"`, red border, "Back to credential" link) — reusing, not reinventing, that pattern.

**Edge case — zero checklist items (credential had no dependencies at initiation):** the checklist area shows *"No dependent systems were recorded when this rotation started."* instead of an empty table — never an empty `<table>` with just headers (a stray-content anti-pattern this story avoids by design).

---

### AC-8: Rotation Detail Page — Confirm Checklist Item (Happy Path)

**Given** a checklist item is `unconfirmed`, `failed`, or `max_retries_exceeded`,
**When** a user with `member`+ role clicks that row's **"Confirm"** button (optionally after typing a note in an inline field),
**Then** the page calls `POST .../rotations/:rotationId/checklist/:itemId/confirm` with `{ notes }` (omitted if blank), and on `200` updates just that row in place (using the response's `data.item`) to show `confirmed`, `confirmedBy` (resolved to a display name if available, else the raw id truncated — matches existing `RecentAccessEvent`-style `actorDisplayName` pattern elsewhere, falling back gracefully if no name-resolution endpoint is wired for this id), and `confirmedAt` — **without re-fetching the whole page** (D5: per-row state, not a page reload).

**Test:** render the checklist component with one `unconfirmed` item, click "Confirm", assert the mocked `fetch` was called with the exact URL and body, then assert the row re-renders with a `confirmed` badge using `@testing-library/svelte`'s `findByText`.

**Edge case — item is already `confirmed` when the click lands (409 `already_confirmed`):** a second member clicked "Confirm" on the same item within the same second (double-click, or two tabs). The page catches the `409`, shows a small inline toast/banner: *"Already confirmed by [confirmedBy] at [confirmedAt]"* using the error body's own `confirmedBy`/`confirmedAt` fields (no need to re-fetch — the error body already carries the authoritative values per the API's documented shape), and updates the row to reflect `confirmed` anyway (a 409-here is evidence the desired end state is already true — treat as idempotent success for *display* purposes, never for a second audit-relevant action).

---

### AC-9: Rotation Detail Page — Report a Problem (Fail) and Retry

**Given** a checklist item is `unconfirmed`,
**When** a user with `member`+ role clicks **"Report a problem"**, is prompted for a required reason (client-validated non-empty, mirrors AC-4's empty-value guard) and an optional "retry at" datetime, and submits,
**Then** the page calls `POST .../checklist/:itemId/fail` with `{ reason, retryScheduledAt }`, and on `200` the row updates to `failed` with the reason visible and a **"Retry"** button now shown in place of "Report a problem".

**Example:** reason = `"GitHub Actions deploy pipeline still using the old key"`. Row shows: status `failed`, subtext *"GitHub Actions deploy pipeline still using the old key"*, buttons: **Retry**, **Confirm** (confirming directly from `failed` is always allowed per 5.2 AC-2 — both buttons render simultaneously, since a human might fix-and-verify without going through another explicit retry cycle).

**Happy path — Retry:** clicking **Retry** calls `POST .../checklist/:itemId/retry` with `{}`; on `200` the row returns to `unconfirmed` with `retryCount` incremented (e.g., "unconfirmed · retry 1 of 3" — the "3" is the org-configured `ROTATION_MAX_RETRIES`, but since this story adds no new endpoint to read that config value, the UI shows only the numerator (`retryCount`) and omits the denominator rather than hardcoding or guessing "3" — **do not hardcode the max**; if `422 max_retries_exceeded` is ever returned instead, AC-10 handles the max-reached message, which is where the actual cap value becomes visible to the user, straight from that error body's `maxRetries` field).

**Edge case — retry pushes past the cap (422 `max_retries_exceeded`):** see AC-10.

---

### AC-10: Rotation Detail Page — Max Retries Exceeded (422)

**Given** a checklist item's `retryCount` is already at the org-configured cap,
**When** a user clicks **Retry** one more time,
**Then** the request returns `422 { code: "max_retries_exceeded", message: "...", retryCount, maxRetries }`; the page shows: *"This system has been retried the maximum number of times ([maxRetries]). Ask an admin to confirm it directly once verified, or escalate."* and — critically — still renders the **Confirm** button (a `max_retries_exceeded` item can always be confirmed directly per 5.2's state machine, AC-2's "any of `unconfirmed`/`failed`/`max_retries_exceeded`" — the UI must not dead-end the item).

**Test:** mock the retry call to reject with the `422` shape above with `retryCount: 3, maxRetries: 3`; assert the exact numbers appear in the rendered message and the Confirm button is still present (not just the disabled Retry button).

---

### AC-11: Rotation Detail Page — Complete Rotation (Happy Path, Role-Gated)

**Given** every checklist item is `confirmed` (or the rotation has zero items and the operator has checked an explicit acknowledgement box — AC-18),
**When** a user with `admin`/`owner` role clicks **"Complete rotation"**,
**Then** the page calls `POST .../rotations/:rotationId/complete` with `{}` (or `{ acknowledgedNoDependencies: true }` for the zero-item case), and on `200` re-renders the whole rotation as `completed` (status badge updates, all action buttons disappear, a "Completed at [timestamp]" line appears) — this is the one action in this story that **does** re-fetch/replace the whole rotation view rather than a per-row patch, since completion changes the entire page's affordances (D5 governs per-item confirm/fail/retry, not the terminal complete action).

**Edge case — button is disabled (not hidden) while items remain unconfirmed:** unlike AC-6's role-based hiding, this button *renders* for admin/owner even with pending items, but is `disabled` with a tooltip/subtext: *"[N] system(s) still need confirmation."* — clicking a disabled button is a no-op, so the actual server rejection path (AC-12) is reached only via a stale-page race, not normal use, and must still be handled gracefully when it happens.

---

### AC-12: Rotation Detail Page — Complete Blocked by Pending Items (422)

**Given** the "disabled button" guard in AC-11 is bypassed by a race (page loaded when all items looked confirmed, but a concurrent `fail`/`retry` from another user un-confirmed one right before this click landed),
**When** `POST .../complete` returns `422 { code: "checklist_incomplete", message: "...", pendingItems: [{ id, systemName, status }, ...] }`,
**Then** the page shows: *"Cannot complete — these systems still need confirmation:"* followed by the `pendingItems` list by `systemName`, and **re-fetches the full checklist** (not just re-renders the stale cached list) so the visible state matches the server's authoritative view before the user tries again.

**Test:** seed page state with all 2 items `confirmed`; mock the complete call to reject with `422 checklist_incomplete` and `pendingItems: [{ id: 'i2', systemName: 'GitHub Actions', status: 'unconfirmed' }]`; assert the message lists "GitHub Actions" and assert a follow-up `GET` to the rotation detail endpoint fires (the re-fetch).

---

### AC-13: Rotation Detail Page — Zero-Dependency Completion Acknowledgement (422)

**Given** a rotation has zero checklist items (credential had no recorded dependencies at initiation — AC-3's edge case),
**When** an admin/owner views the rotation detail page,
**Then** instead of a plain "Complete rotation" button, the page shows a required checkbox: *"I confirm this credential is updated in all consuming systems"* (the literal AC-E5a minimum-gate language from `epics.md`) — the **Complete** button is `disabled` until checked, and once checked, submits with `{ acknowledgedNoDependencies: true }`.

**Edge case — unchecked submit somehow reaches the server anyway (e.g. a scripted/automated click bypassing the disabled attribute) → `422 acknowledgement_required`:** the page shows: *"Please confirm the credential is updated everywhere before completing."* and re-shows the (still unchecked) checkbox — never silently retries with the flag auto-set to `true` on the user's behalf.

---

### AC-14: Rotation Detail Page — Confirm/Fail/Retry/Complete Role Gating (Viewer Read-Only)

**Given** a `viewer` loads any rotation detail page,
**When** the page renders,
**Then** every action button (Confirm, Report a problem, Retry, Complete, Resume, Abandon) is **omitted entirely** (not disabled) — the page is a pure read view of status/checklist/history, matching the persona-journey stub's "Riley (viewer)" description. A short banner reads: *"You have read access to this rotation. Confirming, completing, or resolving rotations requires Member access or higher."*

**Test:** render the page component with `data.orgRole = 'viewer'`; assert `screen.queryByRole('button', { name: /confirm/i })` is `null` (not merely `disabled`) for every action.

---

### AC-15: Rotation Detail Page — Concurrent Modification (409) on Any Mutation

**Given** the CAS/advisory-lock backstop documented in 5.2/5.3 (`409 { code: "concurrent_modification", currentVersion }`) can fire on confirm/fail/retry/resume/abandon when two users act on the same rotation within the same instant,
**When** any of this story's mutation calls returns this `409`,
**Then** the page shows a shared, generic-but-informative banner: *"Someone else just updated this rotation. Refreshing…"* and immediately re-fetches the full rotation detail (same re-fetch helper as AC-12), then clears the banner once the refreshed view renders — the user's own in-flight action is **not** silently retried (that could double-submit a `fail` or `confirm`); they re-assess the refreshed state and click again if still needed.

**Test:** mock a `confirm` call to reject with `409 { code: 'concurrent_modification', currentVersion: 5 }`; assert the banner text appears and a subsequent `GET` to the detail endpoint is issued exactly once (not looped).

---

### AC-16: Rotation Detail Page — Stale-Recovery Banner and Resume

**Given** a rotation's `status` is `stale_recovery` (the backend job from 5.3 transitioned it after the configured threshold),
**When** an `admin`/`owner` loads the rotation detail page,
**Then** a prominent amber banner renders above the checklist: *"This rotation has been inactive for too long and needs a decision: resume it, or abandon it and keep the previous credential value."* with two buttons, **Resume** and **Abandon** — the checklist itself still renders below (read-only feel, actions disabled on individual items while `stale_recovery`, matching 5.2's own `422 rotation_not_active` guard: confirm/fail/retry are correctly rejected server-side for a non-`in_progress` rotation, so this story's UI proactively hides those per-item buttons while `stale_recovery` rather than letting the user hit an avoidable 422).

**Happy path — Resume:** clicking **Resume** calls `POST .../rotations/:rotationId/resume` with `{}`; on `200` the banner disappears, status returns to `in_progress`, and per-item confirm/fail/retry buttons reappear (checklist items keep whatever state the stale-detection job reset them to — this story does not alter that server-side behavior, it only reflects it).

**Edge case — a checklist item shows `retryCount: 3` but status `unconfirmed` after resume:** this is the documented, intentional 5.3 AC-10 consequence (retryCount is never reset by the stale-job). The UI renders it exactly as any other `unconfirmed` item with a nonzero `retryCount` — no special-casing needed; AC-9's rendering already handles "unconfirmed with retryCount > 0" correctly.

---

### AC-17: Rotation Detail Page — Abandon (Stale Recovery)

**Given** the same `stale_recovery` banner as AC-16,
**When** an `admin`/`owner` clicks **Abandon**,
**Then** the page first shows a confirmation step (not a native `confirm()` dialog — an inline confirmation panel matching the rest of the app's styling, since this is a data-losing, hard-to-reverse action): *"Abandoning will discard the new value from this rotation. The credential will revert to showing its previous value. This cannot be undone."* with **Abandon anyway** / **Cancel** buttons.

**On confirmation:** calls `POST .../rotations/:rotationId/abandon` with `{}`; on `200` the page re-renders the rotation as `abandoned` (all action buttons gone, banner replaced with a neutral note: *"This rotation was abandoned. The credential's previous value remains current."*) and — because this changes what `GET .../credentials/:credentialId/value` would return — the page suggests, but does not force, navigating back to the credential detail page via a visible link.

**Edge case — `422 rotation_not_stale` (someone else already resumed it first):** the confirmation panel's submit catches this, shows: *"This rotation is no longer awaiting a decision — someone may have already resumed or abandoned it."*, and re-fetches (same pattern as AC-12/AC-15) so the page reflects whichever terminal/active state it's actually in now.

---

### AC-18: Rotation History Section — Credential Detail Page

**Given** a credential has 4 prior rotations across various terminal statuses,
**When** any `viewer`+ role loads the credential detail page,
**Then** a new "Rotations" section (below "Version history", same card styling) lists them most-recent-first via `GET .../rotations?limit=10`, each row showing status badge, `initiatedAt`, `completedAt` (or "—"), and `[confirmedCount]/[itemCount] confirmed`, linking to that rotation's detail page.

**Example row:** `completed · initiated 2026-06-01 09:00 · completed 2026-06-01 09:45 · 3/3 confirmed` → links to `/projects/:id/credentials/:id/rotations/:id`.

**Edge case — more than 10 rotations exist (`hasMore: true`):** a "Show more" link appends `?page=2` (reusing the existing `?page=` URL-param convention already used by the project-scoped credentials list page, `apps/web/src/routes/(app)/projects/[projectId]/credentials/+page.svelte`'s `buildHref`-style helper) rather than introducing a new pagination widget pattern.

**Edge case — zero rotations ever:** *"No rotations yet."* (same string as AC-1's empty-state, single source of truth constant in a shared copy file, not duplicated inline).

---

### AC-19: Break-Glass Panel — Entry Point and Role Gating

**Given** the `/rotate` page from AC-3/AC-4,
**When** a user with `admin`/`owner` role views it,
**Then** below the normal "Start rotation" form, a collapsed section labeled **"Emergency: break-glass rotation"** (visually distinct — red/amber accent, not the default slate card styling used elsewhere, to signal higher risk) is present, expandable on click.

**Edge case — `member`/`viewer` role:** this entire section is **omitted** from the page (not collapsed-and-disabled) — matches AC-6's "don't render what you can't do" convention. A `member` who somehow already knows the form shape and POSTs directly to the break-glass endpoint still gets the server's real `403 insufficient_role` (the actual security boundary); this AC only governs what renders.

---

### AC-20: Break-Glass Panel — Submit (Happy Path)

**Given** the panel from AC-19 is expanded,
**When** the admin/owner types a new value, types a **required** reason (client-validated non-empty — the server requires it unconditionally per `BreakGlassRotationBodySchema`, unlike normal initiation's optional `notes`), and clicks **"Rotate immediately"** (deliberately different label from the normal form's "Start rotation" — reduces the chance of an accidental click doing the higher-blast-radius action),
**Then** the page shows one more confirmation micro-step: a native-feeling but custom (not `window.confirm`) inline prompt — *"This skips the checklist and takes effect immediately. Type CONFIRM to proceed."* requiring the literal text `CONFIRM` in a text input before the actual button becomes clickable (an explicit, deliberate friction device for the single highest-blast-radius action in Epic 5 — mirrors 5.3's own text describing break-glass as needing to "act in seconds" while still not being a misclick).

**On confirmation:** calls `POST .../rotations/break-glass` with `{ newValue, reason }`; on `201`, the page:
1. Shows a success banner: *"Break-glass rotation complete. The new value is live now."*
2. Shows the overlap window from the response's `previousVersionOverlap.breakGlassOverlapExpiresAt` as a countdown/plain timestamp: *"The previous version remains accessible until [timestamp] to let in-flight systems finish using it."*
3. **Independently calls `GET .../dependencies`** (per the "Ground-Truth API Surface" nuance above — this is NOT in the break-glass response) and renders: *"Systems that may still need the new value:"* followed by each non-archived `systemName` — the UI's own best-effort reconstruction of the sweep reminder, since the authoritative sweep payload only reaches admins via the async notification channel (email/Slack), not this page.
4. Provides a link to the new rotation's detail page (`data.id` from the response) — which will render with `checklistItems: []` per AC-7's zero-item edge case, correctly reflecting that break-glass created no checklist.

---

### AC-21: Break-Glass Panel — Validation and Lock Contention

**Given** the `CONFIRM`-gated submit from AC-20,
**When** the reason field is empty or whitespace-only,
**Then** client-side validation blocks submission (*"A reason is required for break-glass rotation"*) before any request — mirrors the server's `reason.trim().min(1)` constraint exactly, so the client never sends a request the server is guaranteed to reject.

**Edge case — `409 rotation_lock_contention`** (a concurrent break-glass or normal-initiate call raced this one for the same credential): the page shows: *"Another rotation action is in progress for this credential right now. Please wait a moment and try again."* — a transient, retry-suggesting message (never phrased as a hard failure, since this is a lock race, not a state conflict) — and does **not** auto-retry (an emergency action auto-retrying without the human re-confirming the `CONFIRM` step would undermine the deliberate-friction design of AC-20).

**Edge case — credential not found / cross-tenant (`404 credential_not_found`):** identical treatment to the existing credential-detail-page 404 pattern (AC-7's edge case) — reused, not reinvented.

---

### AC-22: Break-Glass — Superseded Prior Rotation Is Visible in History (No Special UI)

**Given** break-glass superseded (auto-abandoned) an existing `in_progress` rotation per 5.3 AC-5,
**When** the user later views the credential's Rotation history section (AC-18),
**Then** the superseded rotation shows up exactly like any other `abandoned` rotation — **no new badge or special-cased label is built for "was superseded by break-glass"** in this story; the existing `abandoned` status rendering is sufficient and accurate (this is a deliberate scope boundary: the API's own `rotation.superseded_by_break_glass` audit event is the durable record of *why* it was abandoned, discoverable via a future audit-log UI, not this story's job to surface inline).

---

### AC-23: Project Dashboard — "Upcoming Rotations" Widget (Dashboard Truth, G3)

**Given** `apps/web/src/routes/(app)/dashboard/+page.server.ts` already calls `getProjectDashboard()` and the returned `data.dashboard.upcomingRotations` array has been populated with real data by Story 5.2's `computeUpcomingRotations()` since that story shipped — **confirmed via direct code inspection that `+page.svelte` currently fetches this field but never renders it anywhere in the template** (verified: no occurrence of `upcomingRotations` in `apps/web/src/routes/(app)/dashboard/+page.svelte` today), matching the exact gap `deferred-work.md` line 53 documents,
**When** `data.dashboard.upcomingRotations` is non-empty,
**Then** a new section renders on `/dashboard` (inserted between the project-stats `<dl>` and the existing `<DashboardPlaceholderGrid />`, which stays for the categories it still legitimately covers — Epic 6/8 gaps, untouched by this story): *"Upcoming rotations"* listing each item's `credentialName`, `scheduledAt` (formatted via the page's existing `formatDate` helper), and an **"Overdue"** badge (red) when `status === 'overdue'` vs. a neutral "Scheduled" label when `'pending'` — each row links to `/projects/:selectedProject.id/credentials/:credentialId` via `resolve()`.

**Example:**
```
Upcoming rotations
┌──────────────────────────┬──────────────┬──────────┐
│ sk_stripe_live             │ 2026-06-28    │ Overdue  │
│ db_password_prod            │ 2026-07-20    │ Scheduled│
└──────────────────────────┴──────────────┴──────────┘
```

**Edge case — `upcomingRotations: []` (no rotations scheduled):** the section still renders (not omitted — omitting it would make the dashboard look identical to before this story, defeating G3's intent) with: *"No credentials have an upcoming rotation scheduled."* — an honest empty state, not a fabricated "all good" claim (matches the existing `forbiddenDashboardClaims` test convention in `dashboard-copy.test.ts` that already blocks strings like `"All systems healthy"`).

**Test (regression-critical for G3):** a dedicated test in the existing `dashboard.test.ts`-style file asserts the rendered dashboard, given a mocked `dashboard.upcomingRotations` array with one `overdue` item, contains that credential's name and the literal text "Overdue" — proving this story actually closes the gap rather than merely fetching-and-discarding the field as before.

---

### AC-24: Vault Sealed (503) — Shared Handling Across All New Pages

**Given** any of this story's pages/actions calls an endpoint that returns `503 { status: "sealed" }` while the vault is sealed (initiate, break-glass, confirm/fail/retry/complete, resume/abandon — the read endpoints `GET .../rotations`/`GET .../rotations/:id`/`GET .../dependencies`/`GET .../rotations/upcoming` are **not** vault-guarded per 5.1/5.2/5.3's documented, unchanged `VAULT_GUARD_ALLOWLIST` limitation, so reads still succeed while sealed),
**When** a mutation hits this `503`,
**Then** the page shows the same sealed-vault message pattern already used elsewhere in the app (grep-verify the existing string/component used for this condition on the vault/login flow and reuse it verbatim rather than inventing new copy) — *"The vault is currently sealed. An administrator must unseal it before rotations can be started or updated."*

---

### AC-25: `$lib/api/rotations.ts` Client Module — Error Mapping Contract

**Given** every AC above depends on a typed client module wrapping the 11 endpoints in "Ground-Truth API Surface",
**When** `apps/web/src/lib/api/rotations.ts` is written,
**Then** it exports one function per endpoint (`initiateRotation`, `getRotation`, `listRotations`, `confirmChecklistItem`, `failChecklistItem`, `retryChecklistItem`, `completeRotation`, `breakGlassRotation`, `resumeRotation`, `abandonRotation`, `listUpcomingRotations`) using the **exact** `apiFetch<T>(fetchFn, path, init)` / `ApiClientError` pattern from `$lib/api/credentials.ts` and `$lib/api/client.ts` — no bespoke fetch wrapper, no `axios`, no new HTTP client dependency.

**Test:** a `rotations.test.ts` file (mirroring `credentials.test.ts`'s structure) mocks `fetch` for each function, asserting: (a) correct URL/method/body construction, (b) a non-2xx response with an envelope body throws `ApiClientError` with the right `status`/`code`, (c) a 404 with no parseable JSON body still throws a sane `ApiClientError` rather than crashing on `.json()` (matches `parseApiEnvelope`'s existing `.catch(() => null)` guard).

---

### AC-26: Accessibility and Keyboard Basics

**Given** every action button introduced by this story (Confirm, Report a problem, Retry, Complete, Resume, Abandon, Rotate immediately),
**When** rendered,
**Then** each is a real `<button type="button">` (never a `<div onclick>`), has an accessible name matching its visible label (no icon-only buttons without `aria-label`), and every status badge conveys state via text content (not color alone — e.g. "confirmed"/"failed" as visible text, not just a colored dot), matching the existing credential-detail page's "Current" version badge precedent (text + color, never color-only).

**Test:** `@testing-library/svelte`'s `getByRole('button', { name: ... })` queries are used throughout this story's component tests (not `querySelector` by class) — this is itself the enforcement mechanism; a button without a proper accessible name fails these queries and the test suite catches it structurally, not via a separate a11y-linter dependency this story does not introduce.

---

### AC-27: No Backend Changes — Route-Audit and Test-Suite Non-Regression

**Given** this story adds zero new Fastify routes, zero new DB migrations, and zero new audit events,
**When** `pnpm --filter @project-vault/api test route-audit.test.ts` and the full `apps/api` test suite are run after this story's changes land,
**Then** both are **unaffected** — this story's own test additions are entirely under `apps/web/src/**`, and `apps/api/**`/`packages/db/**` have zero diff. If a code-review or CI run shows any `apps/api` file changed as part of this story's PR, that is a scope violation to flag, not accept.

---

## Explicit Out of Scope

- **Dependent-system management UI** (add/edit/archive forms) — this story only reads the existing list (AC-3, AC-20); `deferred-work.md` line 64's gap remains open for its own follow-up story.
- **Wiring the reserved `rotation.completed` SSE emit** — D1; a clean, small future backend story, not this one.
- **Playwright / E2E browser tests** — unchanged repo-wide gap (`deferred-work.md` line 67); this story's tests are Vitest + `@testing-library/svelte` component/unit tests only, consistent with every other web story to date.
- **Machine-user API key emergency rotation** — PJ7/Epic 7's job, unrelated to this credential-rotation UI.
- **A denominator ("X of Y retries") in the retry UI beyond what error responses already provide** — see AC-9's note; no new endpoint is added to expose `ROTATION_MAX_RETRIES` proactively.
- **Real-time collaborative cursors / "who else is viewing this rotation"** — no such feature exists in the API; not invented here.
- **Story 5.5's backend hardening items** (self-attestation, audit-payload completeness, TOCTOU fixes, etc.) — entirely separate, parallel story; zero file overlap expected.
- **Changing any role/permission threshold** — every role gate in this story (`admin`/`owner` for initiate/complete/break-glass/resume/abandon, `member`+ for confirm/fail/retry, `viewer`+ for reads) is a direct, unmodified mirror of the already-shipped, already-tested backend gates. This story never proposes loosening or tightening them.

---

## Tasks / Subtasks

- [x] **Task 1: API client module** (AC-25)
  - [x] `apps/web/src/lib/api/rotations.ts` — 11 typed functions per "Ground-Truth API Surface"
  - [x] `apps/web/src/lib/api/rotations.test.ts` — mocked-fetch coverage for every function's success + error-mapping path
  - [x] Extend `apps/web/src/lib/api/credentials.ts` (or a new `dependencies.ts`) with a `listCredentialDependencies` client function if one does not already exist under that name — verify current export names before adding a duplicate

- [x] **Task 2: Credential detail page — Rotation section** (AC-1, AC-2, AC-18)
  - [x] Extend `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.server.ts` to also fetch `listRotations(fetch, projectId, credentialId, { limit: 10 })`
  - [x] Extend the corresponding `+page.svelte` with a new "Rotation" section: start/view-active CTA + history list, role-gated per AC-1/AC-6

- [x] **Task 3: Initiate rotation page** (AC-3, AC-4, AC-5, AC-6)
  - [x] `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/+page.server.ts` — `requireUser`, role check, dependency preview fetch, active-rotation redirect guard
  - [x] `.../rotate/+page.svelte` — form, preview list, submit handler, error mapping
  - [x] Component/route tests

- [x] **Task 4: Break-glass panel** (AC-19, AC-20, AC-21, AC-22)
  - [x] `apps/web/src/lib/components/rotations/BreakGlassPanel.svelte` — collapsible, `CONFIRM`-gated, role-hidden for non-admins
  - [x] Wire into the `/rotate` page from Task 3
  - [x] Component tests including the `CONFIRM` friction gate and the independent post-success `dependencies` fetch

- [x] **Task 5: Rotation detail / checklist page** (AC-7 through AC-17)
  - [x] `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]/+page.server.ts`
  - [x] `.../rotations/[rotationId]/+page.svelte` + a `ChecklistItemRow.svelte` component (per-item `$state` for D5's granular in-flight handling)
  - [x] Stale-recovery banner (`StaleRecoveryBanner.svelte`) with resume/abandon
  - [x] 15-second poll while `in_progress`/`stale_recovery`, paused on `document.visibilityState === 'hidden'` (D1)
  - [x] Component/route tests for every AC-7–AC-17 scenario

- [x] **Task 6: Dashboard widget** (AC-23)
  - [x] Extend `apps/web/src/routes/(app)/dashboard/+page.svelte` with the "Upcoming rotations" section
  - [x] Extend the dashboard test file with the G3 regression-critical test from AC-23

- [x] **Task 7: Shared error/empty-state copy and a11y pass** (AC-24, AC-26, AC-27)
  - [x] Sealed-vault message reused verbatim from existing precedent
  - [x] Full `getByRole` audit across new components
  - [x] Confirm zero `apps/api`/`packages/db` diff before opening the PR

---

## Dev Notes

### Project Structure Notes

| Area | Guidance |
|---|---|
| New API client | `apps/web/src/lib/api/rotations.ts` (+ `.test.ts`) — follow `credentials.ts` exactly. |
| New routes | `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/` and `.../rotations/[rotationId]/` — both new directories under the existing credential-detail route tree. |
| New components | `apps/web/src/lib/components/rotations/` — new directory, following the existing per-feature component folder convention (`components/credentials/`, `components/dashboard/`, `components/onboarding/`). Suggested files: `ChecklistItemRow.svelte`, `BreakGlassPanel.svelte`, `StaleRecoveryBanner.svelte`, `UpcomingRotationsWidget.svelte` (or inline in the dashboard page if small enough — dev's call). |
| Modified files | `.../credentials/[credentialId]/+page.server.ts` and `+page.svelte` (Task 2), `.../dashboard/+page.svelte` (Task 6) — both **extended**, not rewritten; preserve every existing section/test. |
| No new DB/API files | Confirmed zero migration, zero new `apps/api/src/modules/rotation/**` files, zero new `packages/shared/src/schemas/**` files (every type this story needs is already exported). |

### Key Code Patterns to Follow

- **API client:** `apiFetch<T>(fetchFn, path, init)` from `$lib/api/client.js`; `ApiClientError` for typed error branching (`error.status`, `error.code`, `error.details`) — see `credentials.ts`/`client.ts` verbatim.
- **Page load + role:** `requireUser(locals).orgRole` in every new `+page.server.ts`, exactly like the existing credential detail page.
- **Role-gated denial:** `AccessNotice.svelte` (`title`, `message`, `backHref`, `backLabel?`) — reuse, do not reinvent, for every "you can't do this" full-page case (AC-6). For inline/partial gating (AC-1, AC-14, AC-19), omit the control entirely rather than rendering a disabled one, per those ACs' own text.
- **Forms:** client-side `$state` + `onsubmit={(e) => { e.preventDefault(); void submitForm() }}` pattern from `credentials/new/+page.svelte` — no SvelteKit form actions (`+page.server.ts` `actions`) are used anywhere in this codebase's existing mutation flows; stay consistent.
- **Navigation:** `resolve()` from `$app/paths` for every `href`/`goto()` target — never a raw template-literal string passed straight to `href` (breaks typed-route checking already enforced elsewhere in this app).
- **Dates:** the existing `formatDate` helper pattern (`toLocaleString`/`toLocaleDateString` with the same options objects already used in `credentials/[credentialId]/+page.svelte` and `dashboard/+page.svelte`) — do not introduce a date library.
- **Testing:** `@testing-library/svelte` (`render`, `screen`, `fireEvent`, `cleanup`) + `vitest` (`describe`/`it`/`expect`/`vi`), `vi.mock('$app/navigation', ...)` and `vi.hoisted(() => vi.fn(...))` for `goto` mocks — copy `GlobalSearch.test.ts`'s structure.

### Tech Stack (Repo Pinned)

| Tech | Version | Notes |
|---|---|---|
| SvelteKit | `^2.68.0` | File-based routing; `PageServerLoad`/`PageServerData` typed via `./$types.js`. |
| Svelte | `^5.56.4` | Runes (`$state`, `$derived`, `$props`) — no legacy `export let`/stores-for-local-state. |
| Tailwind CSS | `^4.3.1` | Utility classes only, matching existing card/section/badge conventions verbatim (`rounded-2xl border border-slate-200 bg-white p-6 shadow-sm` for cards, `rounded-full ... text-xs font-semibold` for badges). |
| zod | `^4.4.3` (`zod/v4`) | Not touched directly by this story (no new schemas needed — all types already exported from `@project-vault/shared`). |
| Vitest | `^4.1.9` | Unified test runner. |
| @testing-library/svelte | `^5.4.2` | Component tests. |

### Architecture Compliance

- No new backend surface of any kind (AC-27) — this is a pure `apps/web/**` story.
- Every mutation call goes through the existing `apiFetch`/credentials-cookie (`credentials: 'include'`) pattern — no new auth mechanism.
- Client-side role checks are UX-only; the server remains the sole authorization boundary (Security row, AC Quick Reference) — every AC that mentions hiding a button also documents what happens if the server call is reached anyway.
- No new environment variables, no new feature flags.

### Anti-Patterns (Do Not)

- Do not build a generic "rotation store" singleton — each page/component fetches and holds its own `$state`, matching this app's existing per-page-load pattern (no global client-side cache layer exists anywhere else in this codebase; do not introduce the first one here).
- Do not silently retry a failed mutation on the user's behalf (AC-15, AC-21) — always surface the conflict and let the human decide.
- Do not render a disabled button where "omit the button" is what the corresponding AC specifies — the two are explicitly different UX decisions in this story (compare AC-1/AC-6/AC-14/AC-19's "omit" language against AC-11's "disabled" language) and are not interchangeable.
- Do not assume the break-glass response contains the sweep checklist — it does not (see "Ground-Truth API Surface" nuance); fetch dependencies separately.
- Do not hardcode `3` (or any number) as the retry cap anywhere in the UI — it is admin-configurable server-side and this story has no endpoint to read the configured value proactively (AC-9).
- Do not add Playwright, a new HTTP client library, a new date library, or a global state-management library — none are needed and none exist elsewhere in this app.

---

## Previous Story Intelligence

### Story 5.3 (`5-3-stale-rotation-recovery-and-break-glass-emergency-rotation.md`, `done`)

Its own Product Surface Contract explicitly named this exact gap and handed off the resolution path this story fulfills: *"When this story reaches review, the reviewer/SM must check whether a web rotation-UI story has since been added... if not, add a single consolidated entry to deferred-work.md."* That consolidated entry (line 68) is what scheduled this story. 5.3 also surfaced the critical nuance this story's "Ground-Truth API Surface" section documents: the sweep checklist is notification-payload-only, never in the break-glass HTTP response — a fact easy to miss without having read 5.3's AC-7 closely, which is why it's called out explicitly here rather than left implicit.

### Story 5.2 (`5-2-rotation-checklist-confirmation-and-completion.md`, `done`)

Wired `upcomingRotations` to real data server-side but — confirmed by this story's own research — the web frontend never rendered it. This is not a regression in 5.2 (dashboard rendering was never 5.2's job — it's an API story); it's exactly the kind of gap this story exists to close (AC-23).

### Story 2.2 (`2-2-credential-storage-and-retrieval-with-version-history.md`, `done`)

Source of the exact page (`credentials/[credentialId]/+page.svelte`) this story extends, and the exact `$state`/`revealing`-flag/`AccessNotice` patterns this story's Dev Notes require reusing verbatim.

---

## Git Intelligence Summary

Confirmed via direct file inspection (not commit-log guessing, since this worktree's git history reflects the underlying epic's development, not this story's): `packages/db/src/migrations/meta/_journal.json`'s latest entry is `0033_break_glass_and_stale_recovery` — 5.1/5.2/5.3's full schema and all endpoints in "Ground-Truth API Surface" are live in this branch today, verified by direct `grep` against `apps/api/src/modules/rotation/routes.ts` and `apps/api/src/modules/rotation/routes.test.ts` for every path/role/error-code cited in this story. No forward-looking assumptions were needed anywhere in this document, unlike 5.1's own creation (which had to assume 2.2/2.4 conventions before they were provably final) — every dependency this story has is already `done` and already shipped.

---

## References

- [Source: `_bmad-output/planning-artifacts/epics.md#Epic-5-Credential-Rotation--Safe-Trackable-Rotation-Workflows`]
- [Source: `_bmad-output/planning-artifacts/prd.md` FR18–FR23, FR65, FR66, FR75, FR104, FR108]
- [Source: `_bmad-output/planning-artifacts/architecture.md` — SvelteKit/Svelte 5/Tailwind v4 frontend stack, real-time transport section]
- [Source: `_bmad-output/planning-artifacts/ux-design-specification.md` — rotation-checklist UX principles, "adaptive rotation" pacing, persona definitions (Morgan, Alex, Riley)]
- [Source: `_bmad-output/implementation-artifacts/5-1-rotation-initiation-and-checklist-generation.md`]
- [Source: `_bmad-output/implementation-artifacts/5-2-rotation-checklist-confirmation-and-completion.md`]
- [Source: `_bmad-output/implementation-artifacts/5-3-stale-rotation-recovery-and-break-glass-emergency-rotation.md`]
- [Source: `_bmad-output/implementation-artifacts/5-5-epic-5-completion-rotation-hardening-and-technical-debt.md` — parallel, non-overlapping closure story]
- [Source: `_bmad-output/implementation-artifacts/2-0-mvp-frontend-shell-and-empty-project-dashboard.md`, `2-1-project-creation-and-cross-project-dashboard.md`, `2-2-credential-storage-and-retrieval-with-version-history.md` — Epic 2's API+web pairing precedent]
- [Source: `_bmad-output/implementation-artifacts/deferred-work.md` §"Web UI gaps" line 68, §"Project dashboard" line 53]
- [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]
- [Source: `apps/api/src/modules/rotation/routes.ts`, `apps/api/src/modules/rotation/schema.ts`, `packages/shared/src/schemas/rotations.ts`, `packages/shared/src/schemas/dashboard.ts`, `packages/shared/src/schemas/sse-payloads.ts` — ground truth for every endpoint/type cited]
- [Source: `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte`, `+page.server.ts`, `apps/web/src/routes/(app)/dashboard/+page.svelte`, `+page.server.ts` — existing pages this story extends]
- [Source: `apps/web/src/lib/api/credentials.ts`, `client.ts`, `apps/web/src/lib/components/onboarding/onboarding-logic.ts`, `apps/web/src/lib/components/credentials/AccessNotice.svelte` — patterns this story reuses verbatim]

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-5 (Claude Code)

### Debug Log References

- TDD red-green followed per task: wrote/updated tests first (confirmed red — missing modules/behavior), then implemented, then reran focused tests to green, then the full `apps/web` suite.
- `svelte-kit sync` initially failed with "Files prefixed with + are reserved" because colocated server-load tests were named `+page.server.test.ts`; renamed to `credential-detail-page.server.test.ts`, `rotate-page.server.test.ts`, and `rotation-page.server.test.ts` (SvelteKit treats any `+`-prefixed file under `routes/` as a route file, matching the existing `alerts-redirect.test.ts` naming precedent rather than `+`-prefixed test files).
- `eslint` flagged `svelte/prefer-writable-derived` on the rotation detail page's `$state` + `$effect` sync-from-props pattern; rewrote to a writable `$derived(data.rotation)` (Svelte 5.25+ overridable-derived pattern), which is both more idiomatic and resolves the lint error.

### Completion Notes List

- Ultimate context engine analysis completed 2026-07-05 — comprehensive developer guide created. This story closes the Product-Surface-Contract gap flagged identically by Stories 5.1, 5.2, and 5.3, all resolved via the 2026-07-05 Epic 5 retrospective's decision to schedule a dedicated web-UI story rather than defer indefinitely.
- Implementation completed 2026-07-05. All 27 ACs implemented against the already-shipped Epic 5 API surface (Stories 5.1/5.2/5.3) with zero new backend routes, migrations, or audit events — confirmed via `git status` showing zero diff under `apps/api/**`/`packages/db/**` (AC-27).
- `$lib/api/rotations.ts` wraps all 11 rotation endpoints with the existing `apiFetch`/`ApiClientError` pattern; `listCredentialDependencies` was added to the existing `$lib/api/credentials.ts` (no separate `dependencies.ts` needed, no duplicate export existed).
- Credential detail page's new "Rotation" section determines the active-rotation CTA via a dedicated `GET .../rotations?limit=1` call (AC-2's literal guidance), decoupled from the paginated (`?page=`) history list fetch (AC-18).
- `/rotate` combines the normal initiate form and the break-glass panel on one route per Design Decision D3; a server-side active-rotation guard redirects straight to the in-progress rotation's detail page rather than rendering a form that would just 409.
- `BreakGlassPanel.svelte` implements the literal `CONFIRM`-text friction gate (AC-20) and independently re-fetches dependencies after a successful break-glass response, since the response body never carries the sweep checklist (5.3 AC-7 nuance, documented in the story's "Ground-Truth API Surface" section).
- Rotation detail page uses a writable `$derived` local working copy of the rotation so per-item confirm/fail/retry (via `ChecklistItemRow.svelte`) can patch a single row (D5) while complete/resume/abandon replace the whole rotation view; a 15s `setInterval` poll runs while `status` is `in_progress`/`stale_recovery`, paused via the `visibilitychange` event when the tab is hidden (D1 — no new SSE wiring).
- Dashboard's previously-fetched-but-unrendered `data.dashboard.upcomingRotations` is now rendered for the first time, closing the G3 gap `deferred-work.md` line 53 documented; includes an explicit non-empty-string empty state and a dedicated regression test asserting the literal text "Overdue" renders.
- All role gates (admin/owner for initiate/complete/break-glass/resume/abandon, member+ for confirm/fail/retry, viewer+ for reads) are UX-only mirrors of the already-shipped server gates (`rotation-permissions.ts`), with every AC's corresponding server-rejection path (403/409/422/503) explicitly handled and tested, not just the happy path.
- Test suite: 33 new/modified test files-worth of coverage across API client, permission/copy helpers, components, and routes — final `apps/web` run: 249 tests passed, 0 failed. `tsc --noEmit` and `eslint .` both clean.

### File List

**New files:**
- `apps/web/src/lib/api/rotations.ts`
- `apps/web/src/lib/api/rotations.test.ts`
- `apps/web/src/lib/components/rotations/rotation-permissions.ts`
- `apps/web/src/lib/components/rotations/rotation-permissions.test.ts`
- `apps/web/src/lib/components/rotations/rotation-copy.ts`
- `apps/web/src/lib/components/rotations/rotation-copy.test.ts`
- `apps/web/src/lib/components/rotations/BreakGlassPanel.svelte`
- `apps/web/src/lib/components/rotations/BreakGlassPanel.test.ts`
- `apps/web/src/lib/components/rotations/ChecklistItemRow.svelte`
- `apps/web/src/lib/components/rotations/ChecklistItemRow.test.ts`
- `apps/web/src/lib/components/rotations/StaleRecoveryBanner.svelte`
- `apps/web/src/lib/components/rotations/StaleRecoveryBanner.test.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/credential-detail-page.server.test.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/+page.server.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/+page.svelte`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/rotate-page.server.test.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]/+page.server.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]/+page.svelte`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]/rotation-page.server.test.ts`
- `apps/web/src/routes/rotate-page.test.ts`
- `apps/web/src/routes/rotation-detail-page.test.ts`

**Modified files:**
- `apps/web/src/lib/api/credentials.ts` (added `listCredentialDependencies`)
- `apps/web/src/lib/api/credentials.test.ts` (added coverage for `listCredentialDependencies`)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.server.ts` (rotation history + active-rotation detection)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte` (new "Rotation" section)
- `apps/web/src/routes/projects-credentials.test.ts` (rotation-section coverage; extended existing detail-page fixture)
- `apps/web/src/routes/(app)/dashboard/+page.svelte` (new "Upcoming rotations" widget)
- `apps/web/src/routes/dashboard.test.ts` (AC-23 regression-critical widget tests)

**Non-code (bookkeeping):**
- `_bmad-output/implementation-artifacts/5-4-rotation-workflow-web-ui.md` (this file — Status, Tasks, Dev Agent Record, Change Log)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (5-4: in-progress → review)

### Change Log

- 2026-07-05: Implemented all 27 acceptance criteria (initiate/checklist/complete/break-glass/history/dashboard-widget web UI over the already-shipped Epic 5 API). Zero `apps/api`/`packages/db` diff. 249/249 `apps/web` tests passing, `tsc --noEmit` and `eslint .` clean. Status: `ready-for-dev` → `review`; `sprint-status.yaml` updated in lockstep (P3).
