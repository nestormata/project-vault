# Story 18.1: Fix Internal Navigation Links and Hover Affordances

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user,
I want links and controls in the app to behave and read consistently (real navigable links instead of plain text, clear hover feedback on clickable rows, and the correct project name instead of a raw UUID),
so that I don't have to guess where a control leads, hunt for a settings page manually, or decode internal identifiers.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

Riley-member sees an MFA warning banner and clicks straight through to the enrollment page in one click. Riley hovers the "Archive"/"Unarchive" control on the projects list and gets a clear visual cue (cursor + hover state) that it's interactive before clicking. Riley (as an org admin) opens a Machine User's detail page and reads a real project name in "Scope boundary" instead of a UUID.

## Acceptance Criteria

1. Every internal link that hardcodes `/settings/security` as a raw string — confirmed to actually be the `href` **prop passed into `<SettingsGateNotice>`** at `apps/web/src/routes/(app)/settings/external-identities/+page.svelte:106` and `apps/web/src/routes/(app)/settings/sso-domains/+page.svelte:137` (not a literal `<a href="...">` tag) — is rewritten to pass `resolve('/settings/security')` instead, matching the existing literal-anchor convention (e.g. `apps/web/src/routes/(app)/settings/+page.svelte:41`).
2. Any MFA-related warning/error surface that currently renders the enrollment instruction as plain text (not a link) is changed to a real `<a href={resolve('/settings/security')}>` link — reuse `apps/web/src/lib/components/MfaAwareErrorAlert.svelte` where the surface already renders an error message containing "MFA"; where it doesn't (a plain static banner), add an equivalent link using the same `resolve()` pattern. Every MFA-related banner/nudge/toast/inline-error location found by this audit (not just the first one encountered) is enumerated with its disposition in Dev Agent Record, so audit completeness is verifiable by a reviewer rather than asserted.
3. The archive/unarchive controls on `apps/web/src/routes/(app)/projects/+page.svelte` (`onArchive`/`onUnarchive`, ~lines 88-131 and 289-306) get an explicit hover affordance: `cursor-pointer` is present (not relying on default `<button>` styling if a parent element suppresses it) and a visible hover state (e.g. underline/color change already present is confirmed applied on `:hover`, or added if missing) so the control is unambiguously recognizable as clickable on mouseover. The same visual cue is also applied on `:focus-visible` so keyboard users get an equivalent affordance, not just mouse users.
4. `apps/api/src/modules/machine-users/routes.ts`'s `scopeBoundaryFor` (lines ~99-102) no longer interpolates the raw `row.projectId` UUID into the `canAccess` string. It resolves and includes the project's actual `name` (joined from the `projects` table) instead, e.g. `credentials in project "<project name>" (<machine user name>'s assigned project)`. (If `projectId` turns out to be unreachable as an orphan given existing FK constraints, no special-case handling is needed — note this in Dev Notes rather than as a formal AC.)
5. `apps/web/src/routes/(app)/projects/[projectId]/machine-users/[machineUserId]/+page.svelte` (lines ~178-197) renders the corrected string as-is — no client-side truncation/formatting needed since the API now returns a human-readable value.
6. Existing tests covering `scopeBoundaryFor` / the machine-user detail page are updated to assert on the corrected project name string, confirming the UUID no longer appears.
7. The archive/unarchive controls' `title=` attribute (per Dev Notes) is paired with a visible text label or `aria-label` — a `title`-only tooltip is inconsistently exposed to screen readers and invisible on touch devices, so it must not be the sole means of conveying the control's purpose.
8. Test coverage for AC-3's hover/focus affordance asserts the relevant CSS class/computed style is present in a component test (not left to manual eyeballing) — a dedicated visual/Playwright test is not required for this papercut fix.
9. No existing route, redirect, or link target changes — this story only fixes how links are constructed/rendered and how one string is composed, not where anything points.

## Tasks / Subtasks

- [x] Task 1: Fix raw `href="/settings/security"` strings (AC: 1)
  - [x] Update `external-identities/+page.svelte` and `sso-domains/+page.svelte` to use `resolve('/settings/security')`
- [x] Task 2: Ensure MFA enrollment warnings are always links (AC: 2)
  - [x] Audit all MFA-related banners/warnings for plain-text "Enroll at /settings/security" copy; convert to `resolve()`-based links
- [x] Task 3: Archive/unarchive hover affordance (AC: 3, 7, 8)
  - [x] Inspect current button markup/CSS on the projects list; add/confirm `cursor-pointer` and hover style
- [x] Task 4: Fix Machine User scope boundary UUID (AC: 4, 5, 6)
  - [x] Update `scopeBoundaryFor` to join/resolve project name
  - [x] Update/add tests in the machine-users module and the web detail page test

## Dev Notes

- **MFA link component**: `apps/web/src/lib/components/MfaAwareErrorAlert.svelte` already renders `<a href={resolve('/settings/security')}>Enable MFA</a>` whenever an error message contains `'MFA'`; it's reused by `BreakGlassPanel`, rotation pages, and the project members page. Prefer reusing this component over inventing a new one. If the specific banner Nestor saw isn't wired through this component, find it and either route it through `MfaAwareErrorAlert` or apply the same `resolve()` pattern directly.
- `/settings/security` is a real route: `apps/web/src/routes/(app)/settings/security/+page.svelte` + `+page.server.ts`, enrollment UI in `apps/web/src/lib/components/settings/MfaEnrollmentPanel.svelte`.
- **No Tooltip component exists in this repo.** Don't introduce one for this story — a `title=` attribute + `cursor-pointer`/hover CSS is sufficient and matches the existing precedent (`title={disabledReason ?? undefined}` on the dependent-systems checkbox, credential detail page ~line 1103; `title="Coming soon"` in `OnboardingStep3.svelte:50`).
- **Machine User scope boundary bug is concrete and confirmed**: `apps/api/src/modules/machine-users/routes.ts:99-102`, `scopeBoundaryFor`:
  ```
  canAccess: [`credentials in project ${row.projectId} (${row.name}'s assigned project)`]
  ```
  `row.name` is the *machine user's* name, not the project's — `row.projectId` is never resolved to a project name anywhere in this function. Fix by joining to `projects` (the query already has the machine user's `projectId`; check whether the existing query already selects project fields before adding a new join).
- Rendered at `apps/web/src/routes/(app)/projects/[projectId]/machine-users/[machineUserId]/+page.svelte:178-197` — purely a pass-through, no client fix needed once the API string is correct.

### Project Structure Notes

- No new files needed. Changes are confined to existing route/component/module files listed above.
- Follows existing SvelteKit `resolve()` convention for internal links — do not introduce raw string hrefs.

### References

- [Source: apps/web/src/lib/components/MfaAwareErrorAlert.svelte]
- [Source: apps/web/src/routes/(app)/settings/security/+page.svelte]
- [Source: apps/web/src/routes/(app)/projects/+page.svelte]
- [Source: apps/api/src/modules/machine-users/routes.ts#scopeBoundaryFor]
- [Source: apps/web/src/routes/(app)/projects/[projectId]/machine-users/[machineUserId]/+page.svelte]
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5), via the `bmad-dev-story` workflow.

### Debug Log References

- API integration tests for AC-4/AC-6 require a running Postgres: `make db-up`, then
  `pnpm --filter @project-vault/shared build && pnpm --filter @project-vault/db build` (the
  worktree had no prebuilt `dist/` for either package), then `make db-migrate`. The `vault_app`
  role password is `dev-only-change-in-prod` (set by migration `0001_rls_and_triggers.sql`) —
  the `.env.example` placeholder password does not match it locally.
- `apps/api/src/modules/machine-users/routes.test.ts` — 22/22 passed after the fix.
- `apps/web` full suite — 221 files / 1837 tests passed.
- `apps/api` `typecheck` and `apps/web` `lint` both clean (0 errors) after the change; had to add
  two `eslint-disable-next-line svelte/no-navigation-without-resolve` comments in
  `SettingsGateNotice.svelte` since its `<a href>` now receives an already-resolved value from the
  caller instead of calling `resolve()` itself.
- `svelte-check` in this repo has ~180 pre-existing false-positive `resolve()` arity errors across
  unrelated files (confirmed by grepping for `SettingsGateNotice` in its output — zero hits); it is
  not wired into any `make`/`pnpm` script, so it was used only as a manual sanity check, not a gate.

### Completion Notes List

- **AC-1**: `SettingsGateNotice.svelte`'s `href` prop contract changed from "route id, resolved
  internally" to "already-resolved value, passed in by the caller" — this matches the literal-anchor
  convention (`settings/+page.svelte`) and avoids a double-`resolve()` call. Both call sites
  (`external-identities/+page.svelte`, `sso-domains/+page.svelte`) updated for both their `denied`
  (`/settings`) and `mfa` (`/settings/security`) variants, since the component's new type contract
  applies to all callers, not just the `/settings/security` ones named in the AC.
- **AC-2 audit** (every MFA-related banner/nudge/toast/inline-error found, with disposition):
  - `apps/web/src/routes/(app)/projects/[projectId]/status-page/+page.svelte` — plain-text error
    message containing "MFA" → **fixed**: swapped the raw `<p role="alert">` for
    `<MfaAwareErrorAlert>` (reuse, no new component).
  - `apps/web/src/routes/(app)/settings/notifications/+page.svelte` — static "Enroll in MFA to
    unlock…" hint, no error object → **fixed**: reused `<MfaAwareErrorAlert>` with a static message
    string (its `message.includes('MFA')` check still fires).
  - `apps/web/src/routes/(app)/settings/themes/+page.svelte` — `reloadMfaRequired` boolean flag
    (not a message string) → **fixed**: added an inline `<a href={resolve('/settings/security')}>`
    link directly, matching the pattern already used in the rotate/rotations pages, since there's
    no message string here to route through `MfaAwareErrorAlert`.
  - `apps/web/src/routes/(app)/settings/extensions/+page.svelte` — **already compliant**: renders a
    real `<a href={resolve('/settings/security')}>` link.
  - `apps/web/src/routes/(app)/platform/audit/+page.svelte`,
    `platform/settings/+page.svelte`, `platform/settings/orgs/+page.svelte`,
    `projects/[projectId]/credentials/[credentialId]/rotate/+page.svelte`,
    `projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]/+page.svelte`,
    `projects/[projectId]/members/+page.svelte` — **already compliant**: all already render either
    `<MfaAwareErrorAlert>` or an inline `resolve('/settings/security')` link.
  - `apps/(auth)/recovery/[token]/+page.svelte` — mentions "MFA" in error copy, but this is the
    unauthenticated account-recovery flow where MFA re-enrollment happens inline on the same page
    (a checkbox + QR code), not a nudge pointing at `/settings/security` → **N/A**, out of scope.
- **AC-3/AC-7/AC-8**: `projects/+page.svelte`'s archive/unarchive `<button>`s gained explicit
  `cursor-pointer`, a `hover:text-*` color-change affordance, the identical cue mirrored on
  `focus-visible:text-*` for keyboard users, and a `title=` attribute — paired with the
  already-visible "Archive project"/"Unarchive" button text, so `title` is never the sole means of
  conveying purpose. Coverage is a component-test assertion on `button.className` /
  `getAttribute('title')`, not a Playwright visual test (per AC-8's explicit scope).
- **AC-4/AC-5/AC-6**: `scopeBoundaryFor` in `apps/api/src/modules/machine-users/routes.ts` now
  resolves the project's real `name` (new `projectNameById` helper, a `projects` table lookup) into
  the `canAccess` string instead of the raw `projectId` UUID; falls back to the id itself if the
  project row is ever unreachable (no FK path currently allows an orphaned `projectId`, so this is a
  defensive fallback, not a documented state — per the AC's own guidance, not elevated to a formal
  AC). `toMachineUserDetail`/`scopeBoundaryFor` became `async` and both call sites (`POST
  .../machine-users`, `GET /machine-users/:id`) now `await` them. The web detail page
  (`.../machine-users/[machineUserId]/+page.svelte`) needed no change — confirmed pure pass-through.
- **AC-9**: no route, redirect, or link target changed anywhere in this story — only how existing
  links/strings are constructed or rendered.

### File List

- `apps/api/src/modules/machine-users/routes.ts`
- `apps/api/src/modules/machine-users/routes.test.ts`
- `apps/web/src/lib/components/settings/SettingsGateNotice.svelte`
- `apps/web/src/routes/(app)/settings/external-identities/+page.svelte`
- `apps/web/src/routes/(app)/settings/sso-domains/+page.svelte`
- `apps/web/src/routes/(app)/projects/[projectId]/status-page/+page.svelte`
- `apps/web/src/routes/status-page-admin.test.ts`
- `apps/web/src/routes/(app)/settings/notifications/+page.svelte`
- `apps/web/src/routes/(app)/settings/notifications/notifications-settings-page.test.ts`
- `apps/web/src/routes/(app)/settings/themes/+page.svelte`
- `apps/web/src/routes/(app)/settings/themes/themes-page.test.ts`
- `apps/web/src/routes/(app)/projects/+page.svelte`
- `apps/web/src/routes/projects-list.test.ts`

## Change Log

- 2026-07-29: Implemented all 4 tasks / 9 ACs via `bmad-dev-story` (TDD red-green per file). API
  integration suite (`apps/api/src/modules/machine-users`) 22/22 passing; full `apps/web` suite 221
  files / 1837 tests passing; `apps/api` typecheck and `apps/web` lint both clean. Status:
  ready-for-dev → review.
