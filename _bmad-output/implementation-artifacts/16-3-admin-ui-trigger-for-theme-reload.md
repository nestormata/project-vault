# Story 16.3: Admin UI Trigger for Theme Reload

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an org admin,
I want a button in the web UI to trigger a theme reload,
so that I don't have to know about or manually curl `POST /api/v1/admin/themes/reload` just to pick up a newly installed custom theme file.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — this story ships the UI directly |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

Riley-admin (org role `admin` or `owner`) drops a new `.css` theme file into `VAULT_THEMES_DIR` on the
host, then opens **Settings → Themes**. Below the existing theme-selection list, Riley sees a
"Reload themes" section (visible only to admin/owner — a viewer or member sees the selection list
with no reload section at all). Riley clicks **Reload themes**; the button disables and shows a
pending state for the duration of the request (preventing a double-click from burning into the
10-req/min rate limit), then a success banner appears: "Reloaded N theme(s)." If any failed to
compile, the banner lists which files failed and why. The new theme immediately appears in the
selection list below (SvelteKit `invalidateAll` / re-run of the page's load function), with no full
page refresh required. If Riley is admin/owner but not MFA-enrolled, clicking reload returns
`403 mfa_required`, and the UI replaces the button with an inline "MFA required to reload themes"
notice reactively (there is no side-effect-free way to know this ahead of time — unlike
`sso-domains`, which naturally learns MFA state from a GET it already needs, the reload endpoint's
only `requireMfa` check is the POST itself).

## Acceptance Criteria

> No epics.md entry exists for this story — it was created directly from
> `epic-16-retro-2026-07-28.md` Finding 3 (High) and the `sprint-status.yaml` scope note. The backend
> endpoint (`POST /api/v1/admin/themes/reload`) already exists, fully implemented and tested from
> Story 16.1; these ACs describe the new frontend surface only.

1. **AC-1 (role-gated visibility):** On `(app)/settings/themes/`, a "Reload themes" section is
   rendered only when the authenticated user's org role is `admin` or `owner`. A `member` or
   `viewer` sees the existing theme-selection list with no reload section, no reload button, and no
   client-side code path that could call the reload endpoint.
2. **AC-2 (happy path):** An admin/owner clicks the reload button → the client calls
   `POST /api/v1/admin/themes/reload` → on a `200` response with `failed: []`, a success status
   banner reads "Reloaded N theme(s)." (N = `loaded.length`, "Reloaded 0 themes." is valid and not
   an error) → the page's theme list re-fetches (via `invalidateAll()` or equivalent) so any newly
   loaded theme appears in the selection list without a manual page refresh.
3. **AC-3 (partial failure):** On a `200` response where `failed` is non-empty (mix of loaded and
   failed, or all failed), the banner reports both counts and lists each failed file with its
   `reason` (e.g. "Reloaded 2 theme(s). 1 failed: broken.css — invalid CSS syntax."). This is not an
   error state (still a `200`) — render it as an informational/warning banner, not the same styling
   as a hard failure.
4. **AC-4 (MFA-required state, detected reactively):** The reload button is shown to every
   admin/owner (there is no side-effect-free way to know MFA-enrollment status ahead of time for
   this endpoint). If the reload call returns `403 mfa_required`, replace the button with an inline
   "MFA required to reload themes" notice (or equivalent) instead of a generic error banner — reuse
   `isMfaRequiredError()` from `apps/web/src/lib/api/client.ts` to distinguish this from other 403s.
5. **AC-5 (rate limit / 429):** If the reload call returns `429`, show an error banner indicating the
   admin should wait before retrying (do not silently swallow it, do not retry automatically).
6. **AC-6 (pending/disabled state):** While a reload request is in flight, the button is disabled and
   shows a pending label (e.g. "Reloading…") — prevents a double-click from issuing two concurrent
   reloads and needlessly consuming the 10-req/min rate-limit budget.
7. **AC-7 (audit-write failure / 503):** If the reload call returns `503 audit_write_failed`, show a
   generic error banner ("Reload failed — please try again.") — the fail-closed 503 means the
   reload's audit trail didn't persist, so the UI must not claim success.
8. **AC-8 (insufficient role / 403 defense-in-depth):** Even though AC-1 hides the button from
   non-admins client-side, if a `403 insufficient_role` somehow reaches the client (e.g. a stale
   session whose role was downgraded after page load), show a generic error banner rather than a
   raw/unhandled exception.
9. **AC-9 (no new backend surface):** This story adds no new API routes, no new Fastify handlers, and
   no changes to `apps/api/src/modules/theming/routes.ts` — it exclusively consumes the existing,
   already-tested `POST /api/v1/admin/themes/reload` endpoint from the frontend.
10. **AC-10 (docs consistency):** `architecture.md`'s Requirements-to-Structure table row for Theming
    (currently citing a stale, unconfirmed `(app)/admin/themes/` path — see Dev Notes) is corrected to
    point at `(app)/settings/themes/`, matching where the reload UI actually lands and following
    16.2's own precedent of fixing this same table row for the selection UI.

## Tasks / Subtasks

- [x] Task 1: Add a `triggerThemeReload` API client wrapper (AC: #2, #3, #5, #7, #8)
  - [x] Subtask 1.1: In `apps/web/src/lib/api/themes.ts`, add `ThemeReloadResponse` type
    (`{ loaded: string[]; failed: { file: string; reason: string }[] }`) and
    `triggerThemeReload(fetchFn: typeof fetch)` calling
    `apiFetch<ThemeReloadResponse>(fetchFn, '/api/v1/admin/themes/reload', { method: 'POST' })`,
    mirroring `apps/web/src/lib/api/platform.ts`'s `triggerBackup(fetchFn)` exactly.
  - [x] Subtask 1.2: Unit test the wrapper's request shape (method, path, no body) alongside the
    existing `getThemes`/`patchThemeSelection` tests.
- [x] Task 2: Extend `(app)/settings/themes/+page.server.ts` with the role gate (AC: #1)
  - [x] Subtask 2.1: Extend `ThemesPageData` (or introduce a sibling type) to also carry `orgRole:
    string` and `canReload: boolean` (`orgRole === 'admin' || orgRole === 'owner'`, following
    `sso-domains`'s `canManageSsoDomains(orgRole)` naming/shape convention). Do **not** add an
    `mfaRequired` field here — unlike `sso-domains`, there is no side-effect-free request this load
    function can make to learn MFA-enrollment status ahead of time for this endpoint (its only
    `requireMfa` check is the reload POST itself), so that detection happens reactively in the
    client on click (Task 3), not at load time.
  - [x] Subtask 2.2: Server-side test coverage for `canReload` true/false by role, mirroring
    `sso-domains`'s `+page.server.test.ts` patterns.
- [x] Task 3: Add the "Reload themes" section to `(app)/settings/themes/+page.svelte` (AC: #1-#8)
  - [x] Subtask 3.1: Render the section only when `data.canReload` is true.
  - [x] Subtask 3.2: Wire a button (plain button or a confirm-step component like
    `ConfirmDeleteButton` used on `(app)/platform/backups` — non-destructive action, so a plain
    button is defensible; use judgment and note the choice in Dev Notes) to call
    `triggerThemeReload`, using `triggerMessage`/`triggerError` `$state` banners styled after the
    `(app)/platform/backups` page's pattern. Track a `reloading` `$state` boolean: disable the
    button and show a pending label while the request is in flight (AC-6).
  - [x] Subtask 3.3: On success, call `invalidateAll()` (or the page's existing re-fetch mechanism)
    so the theme-selection list reflects newly loaded themes without a manual refresh.
  - [x] Subtask 3.4: Handle `ApiClientError` branches: `403` where `isMfaRequiredError(err.code)` is
    true → replace the button with the MFA-required notice (AC-4); `403 insufficient_role` (AC-8),
    `429` (AC-5), and `503 audit_write_failed` (AC-7) → generic/specific error banners per their ACs,
    following the `(app)/platform/backups` page's `err.status`/`err.code` branching pattern.
- [x] Task 4: Component/integration tests for the new UI (AC: #1-#8)
  - [x] Subtask 4.1: Extend `themes-page.test.ts` / `themes-page.server.test.ts` (or add new sibling
    test files) covering: section hidden for member/viewer; button visible for admin/owner; pending
    state during an in-flight request; MFA-required notice rendering after a `403 mfa_required`
    response; success banner with `N=0` and `N>0`; partial-failure banner listing failed
    files/reasons; `429` and `503` error banners; list refresh after success.
- [x] Task 5: Fix stale architecture.md docs row (AC: #10)
  - [x] Subtask 5.1: Update the Theming row in architecture.md's Requirements-to-Structure table
    (currently `(app)/admin/themes/ (unconfirmed — see 16-1/16-2...)`) to read
    `(app)/settings/themes/`, removing the "unconfirmed" qualifier now that both the selection UI
    (16.2) and the reload UI (this story) are shipped there.

## Dev Notes

- **No new backend work.** `POST /api/v1/admin/themes/reload` (`apps/api/src/modules/theming/routes.ts`)
  is fully implemented, RBAC-gated (`minimumRole: 'admin'`, `requireMfa: true`,
  `rateLimit: { max: 10, key: 'POST /admin/themes/reload' }`), audited (`AuditEvent.THEME_RELOADED`),
  and tested (`routes.test.ts`) since Story 16.1. This story is purely a frontend consumer of it.
  Story 16.1's originally-shipped `allowedRoles: ['owner', 'admin']` was already corrected to
  `minimumRole: 'admin'` during the epic-16 retro (Finding 5) — nothing to do here.
- **Do not create `(app)/admin/themes/`.** No `(app)/admin/` directory exists anywhere in this repo.
  Story 16.2 already corrected this same misconception for the selection UI: org-facing settings
  pages live under `(app)/settings/*`, instance-operator pages under `(app)/platform/*`. Since the
  reload endpoint is org-scoped (`minimumRole: 'admin'`, not a platform-operator concern), this
  story extends the existing `(app)/settings/themes/+page.svelte` (16.2's page) rather than creating
  a new route.
- **Why the reload section needs its own role gate.** `(app)/settings/themes/+page.server.ts`
  currently has no role gate at all — every authenticated org member (down to `viewer`) can view and
  change their own theme selection. The reload endpoint is `minimumRole: 'admin'`, so the new reload
  section must be independently gated; it is not safe to assume "can see this page" implies "can
  reload themes."
- **RBAC gate pattern to follow:** mirror `(app)/settings/sso-domains/+page.server.ts`'s
  `canManageSsoDomains(orgRole)` helper shape (`orgRole === 'admin' || orgRole === 'owner'`) rather
  than an `allowedRoles`-style exclusion list, per architecture.md's documented convention (default
  to `minimumRole`/contiguous-role checks; `packages/eslint-config/rules/no-contiguous-allowed-roles.js`
  enforces this repo-wide for backend routes, and the same judgment applies to any new frontend gate
  helper for consistency even though the lint rule itself only covers backend route definitions).
- **MFA-required state is detected reactively, not at load time.** The reload endpoint has
  `requireMfa: true`, but unlike `sso-domains` (whose load function naturally learns MFA-enrollment
  status from a GET it already needs for its own listing), there is no side-effect-free request this
  page's load function can make to know MFA status ahead of time — the only `requireMfa`-gated call
  *is* the reload POST itself. So: show the button to every admin/owner, and reuse
  `isMfaRequiredError()` (`apps/web/src/lib/api/client.ts`) to detect the `403 mfa_required` response
  from the click itself, then swap the button for the explanatory notice at that point. This was
  flagged as an open judgment call during story creation and resolved during elicitation — do not
  reintroduce a load-time MFA precheck.
- **UI pattern precedent:** `(app)/platform/backups/+page.svelte` is the closest existing analog for
  a "trigger an action via button, show a result banner" flow — its `triggerMessage`/`triggerError`
  `$state` banners and `err.status`/`err.code` branching (`409`, `429`, `503`) map closely onto this
  endpoint's own `403`/`429`/`503` shape. It uses `ConfirmDeleteButton` (a two-step confirm
  component, despite its destructive-sounding name) for its trigger button; since a theme reload is
  non-destructive (re-reads files from disk, doesn't delete data), a plain button without a confirm
  step is also defensible — pick one and note the choice in the Dev Agent Record.
- **API client convention:** add `triggerThemeReload(fetchFn)` to the existing
  `apps/web/src/lib/api/themes.ts` (sibling of `getThemes`/`patchThemeSelection`), following
  `apps/web/src/lib/api/platform.ts`'s `triggerBackup(fetchFn)` shape exactly — a bare
  `apiFetch<T>(fetchFn, path, { method: 'POST' })` call with no body.
- **Response shape reminder:** `{ loaded: string[], failed: { file: string, reason: string }[] }`,
  always `200` even at 100% failure — "failure" here means individual theme files that didn't
  compile, not an HTTP-level error. Treat `failed.length > 0` as a warning/info state, not the same
  styling as `429`/`503`/`403` error banners.
- **Testing standards:** this project's convention is TDD red-green per AGENTS.md — write/extend the
  failing tests for each AC first (Task 4), confirm they fail for the expected reason, then implement
  Tasks 1-3 to make them pass. Follow existing `themes-page.test.ts` / `themes-page.server.test.ts` /
  `sso-domains`'s equivalent test files for structure and mocking conventions (mock `apiFetch`/fetch,
  not the whole module).

### Project Structure Notes

- Extends existing files only — no new route directories:
  - `apps/web/src/lib/api/themes.ts` (add `triggerThemeReload` + `ThemeReloadResponse` type)
  - `apps/web/src/routes/(app)/settings/themes/+page.server.ts` (add `orgRole`/`canReload`/`mfaRequired`)
  - `apps/web/src/routes/(app)/settings/themes/+page.svelte` (add reload section/button/banners)
  - `apps/web/src/routes/(app)/settings/themes/themes-page.server.test.ts` (extend)
  - `apps/web/src/routes/(app)/settings/themes/themes-page.test.ts` (extend)
  - `_bmad-output/planning-artifacts/architecture.md` (fix stale Theming row, per AC-10)
- No changes expected to `apps/api/src/modules/theming/*` — confirmed already correct and tested.
- Settings index page (`(app)/settings/+page.svelte`) already links to `/settings/themes` — no new
  nav entry needed since this story extends that existing page rather than adding a route.

### References

- [Source: _bmad-output/implementation-artifacts/epic-16-retro-2026-07-28.md#Gap & Risk Audit, Finding 3]
- [Source: _bmad-output/implementation-artifacts/sprint-status.yaml — 16-3 entry]
- [Source: _bmad-output/implementation-artifacts/16-1-install-and-compile-a-custom-theme.md — reload endpoint AC-3, Out of Scope]
- [Source: _bmad-output/implementation-artifacts/16-2-select-an-active-theme.md — routing-convention correction, File List]
- [Source: apps/api/src/modules/theming/routes.ts]
- [Source: apps/api/src/modules/theming/schema.ts]
- [Source: apps/web/src/lib/api/themes.ts]
- [Source: apps/web/src/lib/api/platform.ts — triggerBackup precedent]
- [Source: apps/web/src/routes/(app)/settings/sso-domains/+page.server.ts — canManageSsoDomains/isMfaRequiredError precedent]
- [Source: apps/web/src/routes/(app)/platform/backups/+page.svelte — trigger-button/banner UI precedent]
- [Source: _bmad-output/planning-artifacts/architecture.md#Theme Reload Trigger, #Requirements-to-Structure Table]
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

- TDD red-green followed per task: added failing tests for `triggerThemeReload` (2 failed as
  `TypeError: triggerThemeReload is not a function`), the `+page.server.ts` `canReload` gate (4
  failed on `undefined` vs expected role/boolean), and the `+page.svelte` reload section (9 failed
  on missing "Reload themes" button/text) — each confirmed failing for the expected reason before
  implementation, then went green after the corresponding Task 1-3 code was added.
- Full suite: `pnpm install` was required first (worktree had no `node_modules`); after that,
  `apps/web` vitest run: 216 test files / 1771 tests passed. `tsc --noEmit` clean. `eslint` on all
  changed files: no errors. `prettier --check` flagged 2 files, fixed with `--write`, re-verified
  green.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- Task 1: Added `ThemeReloadResponse` type and `triggerThemeReload(fetchFn)` to
  `apps/web/src/lib/api/themes.ts`, mirroring `platform.ts`'s `triggerBackup(fetchFn)` exactly (bare
  POST, no body). Unit tests in new `apps/web/src/lib/api/themes.test.ts` cover request shape (path,
  method, no body) plus the happy-path and partial-failure response shapes; also backfilled missing
  coverage for the pre-existing `getThemes`/`patchThemeSelection` wrappers in the same file since no
  `themes.test.ts` previously existed.
- Task 2: Extended `ThemesPageData` with `orgRole: string` and `canReload: boolean`
  (`canReloadThemes(orgRole)` helper: `orgRole === 'admin' || orgRole === 'owner'`, mirroring
  `sso-domains`'s `canManageSsoDomains` naming/shape). Deliberately did not add an `mfaRequired`
  field per Dev Notes — this page's load function has no side-effect-free request to learn
  MFA-enrollment status ahead of time for this endpoint. `requireUser(locals)` now captures its
  return value to read `orgRole`. Server test coverage added for all four org roles.
- Task 3: Added a "Reload themes" section to `+page.svelte`, rendered only when `data.canReload` is
  true. **Judgment call (per Dev Notes):** used a plain `<button>` rather than
  `ConfirmDeleteButton` — a theme reload is non-destructive (re-reads files from disk, doesn't
  delete or mutate stored data), so a two-step confirm adds friction without a corresponding safety
  need, unlike the backups page's actually-destructive actions. `reloading`/`reloadMessage`/
  `reloadError`/`reloadMfaRequired` are local `$state`, following the `(app)/platform/backups`
  page's `triggerMessage`/`triggerError` banner pattern. `isMfaRequiredError()` (imported from
  `$lib/api/client.js`) detects the 403 `mfa_required` response reactively from the click itself and
  swaps the button for an inline notice (AC-4) — no load-time MFA precheck was added, per the Dev
  Notes' explicit instruction not to reintroduce one. `429` (AC-5), `503 audit_write_failed` (AC-7),
  and `403` (AC-8 defense-in-depth, in case a stale/downgraded session's role slips past the
  client-side AC-1 gate) each get their own error-banner branch. On success, `invalidateAll()` is
  called so the theme-selection list re-fetches without a manual page refresh (AC-2/AC-3).
- Task 4: Extended `themes-page.test.ts` with 9 new tests covering AC-1 through AC-8 (visibility,
  happy path incl. N=0, partial-failure banner listing failed files/reasons, MFA-required notice,
  429/503/403 error banners, pending/disabled state during an in-flight request). Extended
  `themes-page.server.test.ts` with 4 new tests covering `canReload` true/false across all four org
  roles.
- Task 5: Fixed the stale Theming row in `_bmad-output/planning-artifacts/architecture.md`'s
  Requirements-to-Structure table — was `(app)/admin/themes/ (unconfirmed...)`, now
  `(app)/settings/themes/` with the "unconfirmed" qualifier removed, per AC-10 and 16.2's own
  precedent of fixing this same row.
- No changes made to `apps/api/src/modules/theming/routes.ts` or any other backend file (AC-9).

### File List

- `apps/web/src/lib/api/themes.ts` (modified — added `ThemeReloadResponse` type,
  `triggerThemeReload`)
- `apps/web/src/lib/api/themes.test.ts` (new — unit tests for `getThemes`, `patchThemeSelection`,
  `triggerThemeReload`)
- `apps/web/src/routes/(app)/settings/themes/+page.server.ts` (modified — `orgRole`, `canReload`,
  `canReloadThemes` helper)
- `apps/web/src/routes/(app)/settings/themes/+page.svelte` (modified — "Reload themes" section,
  button, banners)
- `apps/web/src/routes/(app)/settings/themes/themes-page.server.test.ts` (modified — `canReload`
  gate tests)
- `apps/web/src/routes/(app)/settings/themes/themes-page.test.ts` (modified — reload section tests,
  AC-1 through AC-8)
- `_bmad-output/planning-artifacts/architecture.md` (modified — fixed stale Theming
  Requirements-to-Structure row per AC-10)

## Change Log

- 2026-07-28: Story implemented — frontend-only "Reload themes" admin UI section added to
  `(app)/settings/themes/`, consuming the existing `POST /api/v1/admin/themes/reload` endpoint from
  Story 16.1. All 10 ACs satisfied via TDD red-green. Status set to `review`.
