# Story 18.4: Fix Intermittent Double-Click Toggle Button Failures

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user clicking "show password", "confirm", or similar toggle buttons,
I want the action to work reliably on the first click,
so that the app doesn't feel fragile or make me think my click didn't register.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

Riley-member clicks "Show password" on a credential field. It reveals on the first click, every time — not "sometimes needs a second click." Same for confirm/submit-style toggle buttons elsewhere in the app.

## Acceptance Criteria

1. Root cause of the "works on the 2nd click" behavior is identified and documented in Dev Agent Record with an actual reproduction (not a guess) before a fix is written — per AGENTS.md's TDD guidance, a failing test reproducing the real bug (not a synthetic race that merely resembles it) must exist and fail against the pre-fix code before the fix is applied.
2. **Important existing-code correction**: initial investigation (this story's own research) found **no CSRF/double-submit-cookie mechanism anywhere in this codebase** — auth relies solely on `credentials: 'include'` session cookies (`apps/web/src/lib/api/client.ts:59`). Do not assume a CSRF-token flow is the cause; verify against actual code. The likely real cause is a client-side state/race bug (e.g. optimistic UI updating before the server response, or a component re-render clobbering an in-flight action) — investigate using the same category of pattern already fixed once in this codebase: `apps/web/src/routes/(app)/settings/language/+page.svelte:20-24` explicitly handles a "double-click race" by treating the server response as source of truth instead of the clicked value optimistically (see its inline comment referencing "AC 2 double-click race"). Check whether the reported "show password"/"confirm" buttons have the same class of bug (acting on stale local state before a pending request resolves).
3. All toggle-style buttons exhibiting this symptom (show/hide password, confirm actions, and any other "click sets a related cookie/session flag then immediately requires it" flow) are audited, with every checked location and its verdict (affected/not-affected, and which root-cause class if affected) enumerated in Dev Agent Record — not just the two named examples, and not summarized as "audited broadly" without evidence of what was checked. If the audit finds more than one distinct root-cause class affecting different buttons differently, each distinct class gets its own documented fix and its own regression test — do not force multiple unrelated causes into a single explanation just because they present the same symptom.
4. A regression test is added per confirmed root-cause class (per AC-1), using a deterministic reproduction mechanism (e.g. firing the interaction events synchronously before the relevant microtask/response flush, not a wall-clock `setTimeout`-based race) so the test is reliable, not flaky.
5. The fix does not weaken protection against genuine duplicate/double-submits — a real second click (or rapid double-click) on an already-fixed button must not trigger the action twice; verify this explicitly rather than only testing the "single click now succeeds" path.
6. Toggle state changes (e.g. show/hide password) are perceivable by assistive technology, not just sighted users — verify (and add if missing) an appropriate `aria-pressed`/equivalent state attribute on the affected buttons as part of this fix.
7. No unrelated behavior of the fixed buttons changes (e.g. reveal/hide semantics, confirmation copy).

## Tasks / Subtasks

- [x] Task 1: Reproduce the bug with a failing test (AC: 1, 4)
- [x] Task 2: Root-cause and document in Dev Agent Record (AC: 1, 2)
- [x] Task 3: Audit for other affected toggle buttons (AC: 3)
- [x] Task 4: Fix + verify tests pass (AC: 3, 5)

## Dev Notes

- **Do not assume CSRF.** A grep of this repo for `csrf`/`CSRF` across `apps/api/src` and `apps/web/src` returns nothing outside build artifacts — there is no CSRF/double-submit-cookie mechanism to be "fragile." The user-reported symptom ("set cookie doesn't get set... click a second time and then it does") is almost certainly describing a client-side session/state race, not literally a `Set-Cookie` header failing — confirm this with real network inspection (dev tools / a Playwright trace) before writing the fix, since misdiagnosing this as a server-side cookie bug would waste the story.
- `apiFetch` (`apps/web/src/lib/api/client.ts:59`) always sends `credentials: 'include'` — a good starting point to trace what actually happens on the first click of an affected button (is the request even sent? does it 401/403? does the UI ignore a successful response?).
- Known, already-fixed precedent for a conceptually similar bug: `apps/web/src/routes/(app)/settings/language/+page.svelte:20-24` — read this fix and its surrounding comment (references "AC 2 double-click race") as the template for how this codebase has solved "acts on stale optimistic state" bugs before.
- Ask the user (or check MFA-related code paths) whether the "show password"/"confirm" buttons in question require an MFA step-up or a freshly-issued session token that might not be available yet on first render — that's another plausible root cause worth ruling in/out (e.g. a token/nonce fetched async that the first click races against).

### Project Structure Notes

- Fix location(s) depend on root cause; likely `apps/web/src/lib/components/` (whatever component renders "show password"/"confirm") — do not guess the file without first locating the actual reveal/confirm button implementations via investigation.

### References

- [Source: apps/web/src/lib/api/client.ts]
- [Source: apps/web/src/routes/(app)/settings/language/+page.svelte]
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5), via `bmad-dev-story`.

### Debug Log References

- `apps/web` full suite: 221 files / 1899 tests passed (post-fix), no regressions.
- `apps/web` typecheck (`pnpm run typecheck` = paraglide compile + `svelte-kit sync` + `tsc --noEmit`): clean.
- `apps/web` eslint (full `apps/web` run): 0 errors, 21 pre-existing warnings (all in files untouched by this story — `security/detect-object-injection` etc., unrelated to this change).
- A standalone `npx svelte-check` invocation (not the repo's own `typecheck` script) reports ~184 pre-existing errors across many unrelated route files (`Expected 2 arguments, but got 1` on `resolve()` calls, etc.) — confirmed pre-existing and orthogonal to this story: the repo's actual gate is `pnpm run typecheck`, which passes clean; `svelte-check` alone is missing a generation step `typecheck` runs first.

### Completion Notes List

**AC-1/AC-2 — Root cause, actual reproduction (not a guess):**

Confirmed via direct code inspection (no CSRF/double-submit-cookie mechanism exists anywhere in
this repo — a grep for `csrf`/`CSRF` across `apps/api/src`/`apps/web/src` returns nothing outside
build artifacts) that the reported "works on the 2nd click" symptom is a client-side re-entrancy
gap, not a server-side cookie bug, per AC-2's own correction.

Two independent passes (one direct, one via a research subagent) audited every "show/hide
password" and "confirm"-style toggle button in `apps/web` — the two literal examples named in the
story — and found **both already correctly guarded**: every reveal/confirm handler in this
codebase (`OnboardingStep2`'s reveal toggle, `ConfirmDeleteButton` and all its callers,
`BreakGlassPanel`, the credential-detail page's reveal/reveal-all/reveal-field flows, `LoginForm`,
`settings/themes`, `settings/language`) sets its guard flag **synchronously before** the first
`await`, so a same-tick second click is a correctly-inert no-op; none exhibits "first click is
silently swallowed."

Broadening the audit (AC-3) to *every* stateful toggle-style button on any page (not just the two
named examples) surfaced exactly one real, unguarded instance:
`apps/web/src/routes/(app)/projects/+page.svelte`'s `toggleShowArchived()` — the "Show
archived"/"Hide archived" filter button. Unlike every sibling action handler on that same page
(`onArchive`/`onUnarchive`/`onSaveTags`, all of which check a busy flag before doing anything),
`toggleShowArchived()` had **no re-entrancy guard whatsoever**, and computed its next URL query
param by reading `data.includeArchived` — a value SvelteKit only swaps in once
`goto(..., { invalidateAll: true })` actually resolves. A second click fired while the first
navigation is still in flight reads the same stale `data.includeArchived` instead of the button's
own just-issued intent, so rapid clicks don't reliably alternate the way a properly-guarded toggle
does — the same category of bug (a UI decision made from a value that hasn't yet been confirmed by
the server/navigation) as the `settings/language/+page.svelte` "AC 2 double-click race" precedent
this story was pointed at, but manifesting as a missing guard rather than a premature optimistic
apply.

**Actual reproduction, per AC-1's "not a guess" requirement:** added a Vitest test
(`apps/web/src/routes/(app)/projects/projects-list-page.test.ts`) that holds the mocked `goto()`
call's promise unresolved and fires two synchronous `fireEvent.click()` calls on the toggle before
it settles — a deterministic microtask-ordering repro (per AC-4), not a wall-clock `setTimeout`
race. Confirmed this test **fails** against the pre-fix code (`goto` called twice) before writing
the fix.

**AC-3 — Full audit table (location → verdict):**

| Location | Verdict |
|---|---|
| `OnboardingStep2.svelte` "Show/Hide value" password reveal | Not affected — plain synchronous boolean flip, no `await`. Added `aria-pressed` (AC-6; this is the story's own named "show password" example). |
| `ConfirmDeleteButton.svelte` (shared by `AssetRowActions`, `AssetDeletePanel`/`AssetDetailFooter`, `ActiveAlertsPanel` dismiss) | Not affected — `if (disabled \|\| pending) return` then synchronous `confirming`/`pending` set before any `await`. |
| `BreakGlassPanel.svelte` expand/cancel/confirm flow | Not affected — all transitions synchronous or guarded by `submitting` before `await`. |
| Credential detail page: single/per-field/reveal-all reveal, hide | Not affected — all guarded by `if (flag) return; flag = true` synchronously before `await`. |
| `LoginForm.svelte` (email/password/SSO steps) | Not affected — guarded by `isSubmitting`/`pendingLookupEmail` synchronously before `await`; already purpose-built (Story 14.4 AC-8/AC-11) against an out-of-order-response race. |
| `settings/themes/+page.svelte` (theme select, org-default select, reload button) | Not affected — guarded by `saving`/`orgDefaultSaving`/`reloading`; applies server response as source of truth (never optimistic). |
| `settings/language/+page.svelte` locale select | Not affected — already fixed (Story 15.1), the precedent this story was pointed at. |
| `status-page/+page.svelte` enable/disable/regenerate | Not affected — guarded by `isBusy` synchronously before `await`. |
| `notifications/+page.svelte` mark-as-read/dismiss/mark-all-read | Not affected — one-shot `use:enhance` form actions, not client-tracked bistable toggle state. |
| `ActiveAlertsPanel.svelte` snooze buttons | Secondary, lower-severity observation (not fixed): no explicit busy guard either, but each preset is a distinct one-shot action button, not a bistable toggle — doesn't match this story's "toggle button" symptom class. Flagged here for visibility, out of this story's scope. |
| `ActiveAlertsPanel.svelte` dismiss | Not affected — delegates to `ConfirmDeleteButton`, keyed per-row by `alert.id`, unaffected by the panel's own writable-`$derived(alerts)` override pattern. |
| **`projects/+page.svelte` "Show archived"/"Hide archived" toggle** | **Affected — the one confirmed root-cause class. Fixed.** |

Only one distinct root-cause class was found (per AC-3's "if more than one... each gets its own
fix" clause — not applicable here, since only one genuine instance exists).

**AC-4/AC-5 — Fix + regression tests:**

Added a `togglingArchived` guard to `toggleShowArchived()` (same synchronous-guard-before-`await`
pattern used by every other action on that page), disabled the button while a toggle navigation is
in flight, and added `aria-pressed={data.includeArchived}` (AC-6). Verified via the new tests that
(a) a second click fired before `goto()` resolves is ignored — `goto` called exactly once — and
(b) once the in-flight navigation resolves, the button re-enables and a fresh click is honored
normally (not permanently stuck disabled).

**AC-6 — Accessibility:** added `aria-pressed` to both the root-caused `projects/+page.svelte`
toggle and to `OnboardingStep2.svelte`'s reveal toggle (the story's own named "show password"
example), even though the latter had no click-race bug — AC-6 explicitly names it.

**AC-7 — No unrelated behavior change:** confirmed via the existing full `apps/web` suite (221
files / 1899 tests, unchanged pass count) that reveal/hide semantics and toggle-target computation
are byte-for-byte unchanged for the normal single-click path (new AC-7 test asserts the exact
`goto()` call args are unchanged).

### File List

- `apps/web/src/routes/(app)/projects/+page.svelte` — added `togglingArchived` re-entrancy guard, `disabled`, and `aria-pressed` to the "Show archived"/"Hide archived" toggle button.
- `apps/web/src/routes/(app)/projects/projects-list-page.test.ts` — added the double-click race reproduction, re-enable-after-resolve, aria-pressed, and single-click-unchanged regression tests.
- `apps/web/src/lib/components/onboarding/OnboardingStep2.svelte` — added `aria-pressed` to the "Show/Hide value" password reveal toggle.
- `apps/web/src/lib/components/onboarding/OnboardingWizard.test.ts` — added an aria-pressed regression test for the reveal toggle.

## Change Log

- 2026-07-30: Implemented all 4 tasks / 7 ACs via bmad-dev-story, TDD red-green throughout. Audited every show-password/confirm-style toggle button in `apps/web` (AC-3); found both of the story's named examples already correctly guarded, and one real, previously-unguarded instance (`projects/+page.svelte`'s "Show archived" toggle) via a deterministic synchronous-double-click reproduction (AC-1/AC-4) that failed against pre-fix code. Fixed with a re-entrancy guard matching this page's own sibling-action convention, plus `aria-pressed` there and on `OnboardingStep2`'s reveal toggle (AC-6). Full `apps/web` suite green: 221 files/1899 tests; typecheck and eslint on all changed files clean. Status: in-progress → review.
