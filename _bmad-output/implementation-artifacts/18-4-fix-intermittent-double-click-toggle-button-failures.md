# Story 18.4: Fix Intermittent Double-Click Toggle Button Failures

Status: ready-for-dev

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

- [ ] Task 1: Reproduce the bug with a failing test (AC: 1, 4)
- [ ] Task 2: Root-cause and document in Dev Agent Record (AC: 1, 2)
- [ ] Task 3: Audit for other affected toggle buttons (AC: 3)
- [ ] Task 4: Fix + verify tests pass (AC: 3, 5)

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

### Debug Log References

### Completion Notes List

### File List
