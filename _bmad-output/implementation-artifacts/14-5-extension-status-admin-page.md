# Story 14.5: Extension Status Admin Page

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an OrgAdmin (self-hosted or hosted-SaaS deployment),
I want a real admin page in the web app that shows whether a configured extension is loaded, not configured, or failed to load,
so that I don't have to `curl`/`httpie` the API directly or read raw server logs just to answer "is my extension working."

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes — a real, reachable page at `(app)/settings/extensions`, linked from the Settings index, gated to org role `admin` |
| **Linked UI story** (if API-only) | N/A — this story *is* the UI story that closes the gap 14-2 flagged |
| **Honest placeholder AC** (if UI deferred) | N/A — see AC-3/AC-4 below for the two honest empty states this page renders (not-configured, load-failed) |
| **Persona journey** | See below |

### Persona journey stub

**Riley-admin (OrgAdmin, self-hosted deployment):**
1. Riley sets `VAULT_EXTENSIONS_PACKAGE` and restarts the API (per Story 14.2 — out of scope here, already shipped).
2. Riley logs in, opens **Settings**, and sees a new **Extensions** row alongside Users/Security/Audit/Language.
3. Riley clicks through to `/settings/extensions` and sees one of three honest states, no `curl` required:
   - **Loaded:** extension name, semver `apiVersion`, capability badges (`auth-provider` / `notification-channel` / `ui-panel`), and a human-readable "Loaded at" timestamp.
   - **Not configured:** "No extension configured for this vault" — the expected default for the vast majority of self-hosted installs.
   - **Load failed:** "The configured extension failed to load — core vault functionality is unaffected. Check the server's structured logs and this org's audit log for details," with a link to `/settings/audit` shown **only if Riley's own org role is `owner`** (that page's own `AUDIT_LOG_ROLE` gate — see `apps/web/src/routes/(app)/settings/audit/+page.server.ts` — is owner-only, a *stricter* role than this page's `admin` gate; an `admin`-but-not-`owner` Riley would otherwise click through to a permission wall). When Riley is `admin`-not-`owner`, the sentence stands without the link.
4. If Riley is `owner`, `member`, or `viewer` (not `admin`), the page still loads (no crash, no raw 403 page) but shows "You need the Admin role to view extension status" instead of any data — mirroring how `/settings/audit` already handles its own owner-only gate.
5. If Riley is not logged in at all, the normal `requireUser` redirect to `/login` applies, same as every other `(app)/settings/*` page.
6. If Riley *is* `admin`-role but hasn't enrolled in MFA yet, the underlying API call (`requireMfa: true` on the route, per Story 14.2) returns `403 MFA_ENROLLMENT_REQUIRED` — Riley sees a distinct "Enable multi-factor authentication to view extension status" message linking to `/settings/security`, not the generic role-permission message from step 4 and not the generic fetch-failure message from AC-7 (those three messages must be visually/textually distinguishable, since they call for three different user actions: switch account, enroll MFA, retry).

## Acceptance Criteria

1. **Route exists and is reachable — closes the G2 gap.**
   **Given** an authenticated user with org role `admin`,
   **when** they navigate to `/settings/extensions`,
   **then** the page renders (no 404, no build-time route error) and calls both `GET /api/v1/admin/extensions/status` (org-admin-only manifest endpoint, shipped in Story 14.2) and `GET /health` (public, unauthenticated liveness endpoint, also carries `extensions_status` since Story 14.2) via `+page.server.ts`, combining the two responses into one of the three rendered states below.

   **And** the Settings index page (`(app)/settings/+page.svelte`) gains a new **Extensions** row in its nav list (same `<li><a>` pattern as the existing Notifications/Users/Security/Language/Audit rows), visible to every authenticated user regardless of role — the row itself is not hidden by role, exactly like the existing rows; the target page below is what gates by role.

2. **Loaded state — shows the real manifest.**
   **Given** `GET /api/v1/admin/extensions/status` returns `{ name, apiVersion, capabilities, loadedAt }` (a non-null manifest),
   **when** the admin visits `/settings/extensions`,
   **then** the page renders: the extension's `name` (e.g. `com.acme.sso-extension`), its `apiVersion` (e.g. `1.2.0`), one badge per entry in `capabilities` (`'auth-provider' | 'notification-channel' | 'ui-panel'` — see `apps/api/src/extensions/status-routes.ts`'s `ExtensionStatusResponseSchema` for the exact enum), and `loadedAt` formatted as a locale-aware human-readable timestamp (not the raw ISO string) — follow the existing timestamp-formatting helper already used elsewhere in `apps/web` (grep for `toLocaleString` / `Intl.DateTimeFormat` usage in `apps/web/src/lib/` before writing a new one).

   **Edge case:** `capabilities` is an empty array (a manifest that declares zero capabilities is valid per Story 14.1's schema — capability negotiation only checks `apiVersion`, not that the array is non-empty). The page must render the name/version/loadedAt normally and show "No capabilities declared" instead of an empty badge row or a blank gap.

3. **Not-configured state — honest placeholder, not a fabricated success.**
   **Given** `GET /api/v1/admin/extensions/status` returns `null` **and** `GET /health`'s `extensions_status` is `"not_configured"`,
   **when** the admin visits the page,
   **then** it renders an explicit "No extension configured for this vault" empty state — this is the expected, common, non-error case (most self-hosted installs run with zero extensions) and must not be styled or worded as if something is wrong. This is the AC-4/G3 "honest placeholder" the story's Product Surface Contract commits to, not a fake zero or a spinner that never resolves.

4. **Load-failed state — honest placeholder, distinct from not-configured.**
   **Given** `GET /api/v1/admin/extensions/status` returns `null` **and** `GET /health`'s `extensions_status` is `"load_failed"`,
   **when** the admin visits the page,
   **then** it renders a *visually and textually distinct* state from AC-3 — e.g. "The configured extension failed to load. Core vault functionality is unaffected. Check the server's structured logs and this org's audit log (`extension.load_failed`) for details." — **and this page never fetches or displays the raw failure reason, exception message, or stack trace.** The backend's fixed enum (`import_error` / `manifest_invalid` / `capability_mismatch`, per Story 14.2 AC-3) is intentionally not exposed by `GET /api/v1/admin/extensions/status` at all (it returns bare `null` for every non-loaded case) — this page must not attempt to reconstruct or guess the reason from any other source (e.g. scraping `/settings/audit`'s events client-side); pointing the admin at the existing audit log / server logs is the correct level of detail, matching Story 14.2's own "never leak raw exception content" security rule.

   **And** the "audit log for details" sentence includes a clickable link to `/settings/audit` **only when the viewing user's own org role is `owner`** — `/settings/audit`'s own page gate (`AUDIT_LOG_ROLE = 'owner'` in that page's `+page.server.ts`) is stricter than this page's `admin` gate, so an `admin`-but-not-`owner` viewer would otherwise be linked straight into a permission wall on the very page this message points them to. Cover both cases (`owner` → link present; `admin`-not-`owner` → same sentence, no link) with dedicated tests.

5. **RBAC — only org role `admin` sees data; `owner`/`member`/`viewer` see a permission message, not a crash.**
   **Given** an authenticated user whose org role is `owner`, `member`, or `viewer`,
   **when** they navigate to `/settings/extensions`,
   **then** `+page.server.ts` does **not** call `GET /api/v1/admin/extensions/status` at all for that role (avoids a guaranteed, wasted 403 round-trip — mirror `/settings/audit`'s `AUDIT_LOG_ROLE` early-return pattern) and the page renders "You need the Admin role to view extension status" instead of any manifest/placeholder content. **`owner` is explicitly included in the blocked set** — this mirrors the API's own `allowedRoles: ['admin']` (not `['owner', 'admin']`, per Story 14.2's Dev Notes RBAC judgment call) and must have its own dedicated test; do not assume `owner` is treated as admin-equivalent anywhere in this story either.

   **And** `GET /health` (used for AC-3/AC-4's not-configured/load-failed distinction) is still fetched and safe to call for every role, since it requires no auth — but its result is only *rendered* when the role check in this AC has already gated out the non-admin case, so a non-admin never sees even the coarse `not_configured`/`load_failed` signal, only the permission message. This is a deliberate least-privilege choice: `GET /health` being public doesn't obligate this org-admin-scoped page to surface it to non-admins.

6. **Unauthenticated — standard redirect, no special-casing.**
   **Given** an unauthenticated visitor,
   **when** they request `/settings/extensions`,
   **then** `requireUser(locals)` throws the standard `redirect(303, '/login')`, identical to every other `(app)/settings/*` page (see `apps/web/src/lib/server/require-user.ts`) — no new auth mechanism, no bespoke redirect target.

7. **Transient fetch failure — honest error state, page stays usable.**
   **Given** `GET /api/v1/admin/extensions/status` or `GET /health` throws or returns a non-2xx/network error for an `admin`-role user (e.g. a transient 5xx or timeout),
   **when** the page loads,
   **then** it does not crash to a raw SvelteKit error page — it renders an honest "Failed to load extension status, try again" message (mirroring `/settings/audit`'s `Promise`/`ApiClientError` catch-and-degrade pattern in its own `+page.server.ts`) and the rest of the page (nav, heading) remains intact. Cover both fetch calls failing independently (status fails but health succeeds, and vice versa) as distinct test cases, since they are two independent network calls with no shared failure mode.

   **Edge case — MFA-not-enrolled `admin` is a distinct case, not a generic failure.** `GET /api/v1/admin/extensions/status` has `requireMfa: true` (Story 14.2) — an `admin`-role user who hasn't enrolled in MFA gets a `403` response with `{ code: 'mfa_required', ... }` (see `apps/api/src/modules/auth/mfa-enforcement.ts`) surfaced as `ApiClientError`, which is technically a "fetch failure" but must **not** render this AC's generic "failed to load, try again" message (retrying won't help). Detect `ApiClientError` with `status === 403 && code === 'mfa_required'` specifically and render a distinct "Enable multi-factor authentication to view extension status" message linking to `/settings/security`, matching the persona journey's step 6. `GET /health` needs no equivalent case since it never requires MFA (it requires no auth at all).

8. **Defensive handling of a logically inconsistent combination.** In production this cannot happen (both endpoints read the same in-memory, set-once-at-boot loader state, per Story 14.2 — there is no reload/hot-swap in this epic's scope), but the two fetches are still two independent HTTP calls with no atomicity guarantee across them (e.g. a deploy/restart landing between the two requests in a rolling-update environment).
   **Given** `GET /api/v1/admin/extensions/status` returns a non-null manifest **but** `GET /health`'s `extensions_status` is `not_configured` or `load_failed` (or the reverse: `status` is `null` but `health` says `loaded`),
   **when** the page renders,
   **then** it must not throw or render a blank/broken state — treat the manifest endpoint as authoritative (a non-null manifest always renders the AC-2 loaded state regardless of what `health` says) and log this mismatch client-side only via `console.warn` (no new backend audit event, no user-facing error) since it signals a boot-timing race worth a developer noticing, not an admin-facing problem.

9. **No backend changes — this story is a pure `apps/web` consumer.**
   **Given** this story's entire scope,
   **when** implementation is reviewed,
   **then** `apps/api/**`, `packages/extension-api/**`, `packages/shared/**`, and any DB migration are **untouched** — this story only adds/modifies files under `apps/web/**`, consuming the two GET endpoints Story 14.2 already shipped and tested. If implementation reveals a genuine gap in either endpoint's response shape (e.g. a field this page needs that the API doesn't return), stop and flag it rather than silently patching `apps/api` inside this story (same scope-discipline precedent as Story 14.2's own boundary note about `packages/extension-api`).

## Tasks / Subtasks

- [ ] Task 1: Add `extensions_status` to the web app's `HealthResponse` type (AC: 3, 4)
  - [ ] **Gap found during story creation:** `apps/web/src/lib/api/platform.ts`'s `HealthResponse` type (`{ status: 'ok' | 'error'; version: string }`) does **not** currently include `extensions_status`, even though the actual `/health` route (`apps/api/src/routes/health.ts`) has returned it since Story 14.2. Write a failing test in `apps/web/src/lib/api/platform.test.ts` asserting `fetchHealth()`'s return type/parsed value includes `extensions_status: 'not_configured' | 'loaded' | 'load_failed'`, then extend the `HealthResponse` type and (if needed) `fetchHealth()`'s parsing to pass it through untouched (it's a passthrough field, no new API call shape).
- [ ] Task 2: Add an `apps/web/src/lib/api/extensions.ts` client module (AC: 1, 2, 3, 4, 7)
  - [ ] Write failing tests in a co-located `extensions.test.ts` for a new `getExtensionStatus(fetchFn)` function that calls `GET /api/v1/admin/extensions/status` via the existing `apiFetch<T>()` helper (`apps/web/src/lib/api/client.ts`) and returns `{ name, apiVersion, capabilities, loadedAt } | null`, matching `ExtensionStatusResponseSchema` in `apps/api/src/extensions/status-routes.ts`.
  - [ ] Implement `getExtensionStatus()`; export the response type (`ExtensionStatus | null`) for reuse in `+page.server.ts` and the Svelte component.
- [ ] Task 3: Build `+page.server.ts` for `/settings/extensions` (AC: 1, 5, 6, 7)
  - [ ] Write failing tests in `extensions-page.server.test.ts` (co-located, following `audit-page.server.test.ts`'s naming convention) covering: `admin` role + loaded manifest → `{ allowed: true, ...loaded state }`; `admin` + not-configured → `{ allowed: true, ...not-configured state }`; `admin` + load-failed → `{ allowed: true, ...load-failed state }`; `owner`/`member`/`viewer` → `{ allowed: false, orgRole }` with **no** `getExtensionStatus()` call made (assert the mock was never invoked, per AC-5's least-privilege note); `getExtensionStatus()` throwing → honest `errorMessage`, `fetchHealth()` throwing → honest `errorMessage`, both independently.
  - [ ] Implement `+page.server.ts`: `requireUser(locals)` first (AC-6), then branch on `orgRole === 'admin'` (AC-5) before calling either fetch function, using `Promise.allSettled` for the two independent calls when the role check passes (per AC-7's "each fails independently" requirement — do not let one `await` short-circuit the other).
- [ ] Task 4: Build `+page.svelte` for `/settings/extensions` (AC: 1, 2, 3, 4, 5, 7)
  - [ ] Render three distinct data states (loaded / not-configured / load-failed) plus the two gate states (`allowed: false` permission message, `errorMessage` fetch-failure message), following the existing conditional-rendering pattern in `apps/web/src/routes/(app)/settings/audit/+page.svelte` (role-gated `{#if data.allowed}` wrapper) and `apps/web/src/routes/(app)/settings/users/+page.svelte` (`canManage` pattern) for structure/styling consistency (Tailwind classes matching the existing settings pages — reuse `rounded-2xl`/`border-gray-200` etc. conventions already in this directory, not new ad hoc styles).
  - [ ] Capability badges: small pill/badge per `capabilities[]` entry; "No capabilities declared" text when the array is empty (AC-2 edge case).
  - [ ] Write a component-level test (`extensions-page.test.ts`, following `audit-page.test.ts`'s pattern) asserting each of the five render states shows its expected distinguishing text.
- [ ] Task 5: Add the Settings index nav entry (AC: 1)
  - [ ] Extend `apps/web/src/routes/(app)/settings/+page.svelte` with a new `<li>` row for **Extensions** → `/settings/extensions`, placed after Audit & Compliance (matching this epic's numbering being the newest addition) — same markup shape as the existing rows (title + one-line description + `→` chevron).
  - [ ] Extend `settings-index-page.test.ts` with an assertion that the new link/row renders and resolves to the correct href.
- [ ] Task 6: Route resolution and no-404 verification (AC: 1)
  - [ ] Confirm `resolve('/settings/extensions')` (SvelteKit's typed route helper, per this codebase's `$app/paths` convention already used throughout `settings/+page.svelte`) compiles — this is what actually proves G3's "no 404" rule at build time, not just a manual click-through.
- [ ] Task 7: Full regression pass
  - [ ] `pnpm turbo typecheck lint test --filter=@project-vault/web`
  - [ ] Confirm this repo's 80/80/80/80 coverage bar is met for all new files (`extensions.ts`, `+page.server.ts`, `+page.svelte`).
  - [ ] `npx jscpd apps/web/src/routes/\(app\)/settings/extensions apps/web/src/lib/api/extensions.ts` — confirm no clone flags against the sibling `audit`/`users` pages this story deliberately mirrors the structure of.
  - [ ] Live-browser verification (per this project's UI-story convention): with a running docker stack, log in as an `admin`-role user, confirm all three data states render correctly (use `VAULT_EXTENSIONS_PACKAGE` unset for not-configured; a deliberately-broken package name for load-failed; a valid stub extension package if one exists in the test fixtures for loaded — otherwise document why the loaded state was only verified via component test, not live browser).

## Dev Notes

### Scope boundaries — what this story is NOT

- **No new backend routes, no schema changes, no new audit events.** This story consumes `GET /api/v1/admin/extensions/status` and `GET /health` exactly as Story 14.2 shipped them. See AC-9.
- **No reconstruction of the failure reason.** The backend deliberately never exposes `import_error`/`manifest_invalid`/`capability_mismatch` via either endpoint this page calls (`GET /api/v1/admin/extensions/status` returns bare `null`, `GET /health` only returns the 3-value `extensions_status` enum with no sub-reason) — this page must not attempt to infer or guess the specific reason from any other signal. Pointing the admin at server logs / the audit log is the correct, final level of detail for this story. See AC-4.
- **No install/reload/restart action on this page.** The loader (`apps/api/src/extensions/loader.ts`) only loads once at boot; there is no "reload extension" or "install extension" button in this epic's scope (community extensions / a general install pathway are explicitly out of scope for Epic 14 per epics.md's FR116 deferral note). This page is read-only.
- **No changes to `(app)/platform/*`.** That route group is gated by `platformOperatorGate` (`apps/web/src/lib/server/require-platform-operator.ts`), a wholly separate concept ("platform operator," used for cross-org backup/settings/upgrade pages) from the org-scoped `admin` role this story gates on. Extension status is an org-admin-facing feature (the API route itself is `allowedRoles: ['admin']`, an org role, not a platform-operator check) — it belongs under `(app)/settings/*`, not `(app)/platform/*`. Do not conflate the two.

### Judgment call: route placement diverges from architecture.md's literal path

architecture.md (L550, L1044, L1303) describes this page as living at `(app)/admin/extensions/`. **This does not match the actual current codebase**: `apps/web/src/routes/(app)/` has no `admin/` directory at all — org-admin-gated features (Users, Security, Audit) all live under `(app)/settings/*` today (shipped across Epics 2/5/8), and platform-operator-gated features live under `(app)/platform/*` (shipped in Epic 9's `9-7-epic-9-completion-platform-operations-web-ui`). Neither of the two route groups architecture.md's stale text implies (`admin/`) exists. **Resolution:** place this page at `(app)/settings/extensions`, matching the actual, established convention for an org-admin-role-gated (not platform-operator-gated) feature — consistent with `(app)/settings/audit`, `(app)/settings/users`, `(app)/settings/security`. This is a judgment call, flagged here for maintainer confirmation, following the same "resolve now, flag for review" pattern Story 14.2 used for its own architecture-vs-reality gaps (see that story's Dev Notes §1-5). If this is rejected in review, moving the three new files under a new `(app)/admin/` route group is a small, isolated change.

### Architecture compliance (must follow exactly)

- **API contract source of truth:** `apps/api/src/extensions/status-routes.ts`'s `ExtensionStatusResponseSchema` (union of the manifest object or `z.null()`) and `apps/api/src/routes/health.ts`'s `extensions_status` enum are the two response shapes this page must handle — read both files directly during implementation, do not assume the shape from this story's prose alone.
- **RBAC role mapping:** `admin` org role exactly, not `['owner', 'admin']` — see Story 14.2 Dev Notes' own resolution of this exact question for the API route; this page's client-side gate must match the API's gate 1:1 or a non-admin will see a broken fetch instead of the intended permission message.
- **`GET /health` is unauthenticated by design** — do not add a credentials/auth check around the `fetchHealth()` call; it already omits auth (see `apps/web/src/lib/api/platform.ts`'s existing `fetchHealth()`, which this story reuses rather than duplicating).
- **No bare `fetch()` calls** — use the existing `apiFetch<T>()` (`apps/web/src/lib/api/client.ts`) for the authenticated manifest endpoint (consistent with every other `apps/web/src/lib/api/*.ts` module) and the existing `fetchHealth()` (`apps/web/src/lib/api/platform.ts`) for the public health check, rather than introducing a third fetch pattern.
- **Distinguish the three non-loaded states without relying on color alone** (accessibility): the "not configured," "load failed," and "permission denied" states must each carry distinct icon/text, not just a color swap (e.g. all three rendered as a gray/amber/red box with identical wording) — a color-only distinction fails for colorblind users and doesn't survive a screenshot shared in a support ticket. Reuse whatever icon/badge convention `/settings/audit`'s own empty/error states already use, if any, rather than inventing a new one.
- **i18n scope:** this codebase's Paraglide message system (`m.*()`, `apps/web/src/lib/paraglide/`) was introduced in Epic 15 but has only been applied to the Settings → Language feature itself — sibling pages this story mirrors (`/settings/audit`, `/settings/users`) still use raw English strings today. Follow that same current convention (raw strings) for this story's new copy rather than partially adopting `m.*()` for one page while every neighboring settings page remains untranslated; a repo-wide i18n sweep is out of scope here and untracked by this story.

### Project Structure Notes

New files:
- `apps/web/src/lib/api/extensions.ts` + `extensions.test.ts`
- `apps/web/src/routes/(app)/settings/extensions/+page.server.ts`
- `apps/web/src/routes/(app)/settings/extensions/+page.svelte`
- `apps/web/src/routes/(app)/settings/extensions/extensions-page.server.test.ts`
- `apps/web/src/routes/(app)/settings/extensions/extensions-page.test.ts`

Modified files:
- `apps/web/src/lib/api/platform.ts` (+ `platform.test.ts`) — `HealthResponse` type gains `extensions_status`
- `apps/web/src/routes/(app)/settings/+page.svelte` (+ `settings-index-page.test.ts`) — new Extensions nav row

No `apps/api`, `packages/extension-api`, `packages/shared`, or migration changes — see AC-9.

### Testing standards summary

- **TDD red-green mandatory** (AGENTS.md): write/extend the failing test first for every task above, confirm it fails for the expected reason, then implement.
- Follow this directory's existing test-naming convention exactly: `<feature>-page.server.test.ts` for server load-function tests, `<feature>-page.test.ts` for component/render tests (see `audit-page.server.test.ts`/`audit-page.test.ts`, `users-page.test.ts`/`users-settings-page.server.test.ts` for the two slightly-varying but established naming patterns in this directory — either is acceptable, pick one and be consistent within this story's new files).
- Repo coverage bar: 80/80/80/80 (statements/branches/functions/lines), same bar Story 14.2 met on the backend side.
- RBAC negative-path coverage is not optional: `owner`, `member`, and `viewer` must each have their own dedicated test proving the permission-denied render, not a single generic "non-admin" test — mirrors Story 14.2's own insistence on per-role test coverage for its API route (AC-5).
- Live-browser verification required per this project's UI-story convention (see memory: UI-relevant stories should be driven in a running app, not verified by test suite alone) — Task 7's last subtask.

### References

- [Source: _bmad-output/implementation-artifacts/14-2-load-a-configured-extension-at-startup-fail-safe.md] — prior story in this epic; defines `GET /api/v1/admin/extensions/status` and `GET /health`'s `extensions_status` field this story consumes; its own Product Surface Contract section is the literal origin of this story ("blocking note... before Epic 14 is allowed to move to done per G2")
- [Source: _bmad-output/implementation-artifacts/epic-14-retro-2026-07-26.md] — first Epic 14 retrospective; found the G2 gap unresolved and scheduled this story as `14-5-extension-status-admin-page`, keeping `epic-14` at `in-progress` rather than `done`
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] — row 98, "Extension status admin page" — tracks this exact gap from creation to (pending) resolution
- [Source: _bmad-output/planning-artifacts/epics.md#Epic 14: Extension Architecture & Pluggable Authentication] — epic framing; FR113/FR114 mapping; "core never special-cases the extension" invariant (no epics.md story text exists for 14.5 itself — it was added post-hoc via retro, not epics.md, per `my-epic-retro`'s own convention of scheduling backlog entries without duplicating `bmad-create-epics-and-stories`)
- [Source: _bmad-output/planning-artifacts/architecture.md] (~L550, L1044, L1303) — describes the page at `(app)/admin/extensions/`; **superseded by this story's judgment call above** placing it at `(app)/settings/extensions` to match the actual, current routing convention
- [Source: _bmad-output/implementation-artifacts/product-surface-contract.md] — G1-G4 rules this story exists to satisfy for Epic 14
- Codebase (read directly during story creation): `apps/api/src/extensions/status-routes.ts`, `apps/api/src/routes/health.ts`, `apps/web/src/lib/api/platform.ts`, `apps/web/src/lib/api/client.ts`, `apps/web/src/lib/server/require-user.ts`, `apps/web/src/lib/server/require-platform-operator.ts`, `apps/web/src/routes/(app)/settings/+page.svelte`, `apps/web/src/routes/(app)/settings/audit/+page.server.ts`, `apps/web/src/routes/(app)/settings/audit/+page.svelte`, `apps/web/src/routes/(app)/settings/users/+page.server.ts`
- TDD process: [Source: AGENTS.md#Development Story Implementation]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5), via bmad-create-story

### Debug Log References

### Completion Notes List

- Story created via `pick-story` → `bmad-create-story` for backlog entry `14-5-extension-status-admin-page`, added to `sprint-status.yaml` by `my-epic-retro`'s first Epic 14 retrospective (2026-07-26) to close the G2 product-surface gate flagged by Story 14.2's own Product Surface Contract.
- **Gap found during story creation:** `apps/web/src/lib/api/platform.ts`'s `HealthResponse` type does not currently include `extensions_status`, despite the backend having returned it since Story 14.2 — added as Task 1, ahead of the new page's own code.
- **Judgment call:** route placed at `(app)/settings/extensions` rather than architecture.md's literal `(app)/admin/extensions/`, since no `(app)/admin/` route group exists in the current codebase — org-admin features live under `(app)/settings/*`, platform-operator features under `(app)/platform/*`. Flagged in Dev Notes for maintainer confirmation, consistent with Story 14.2's own precedent for resolving architecture-vs-reality gaps during story creation rather than leaving them ambiguous.

### File List
