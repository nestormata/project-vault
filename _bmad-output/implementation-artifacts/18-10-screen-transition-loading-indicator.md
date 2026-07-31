# Story 18.10: Screen-Transition Loading Indicator

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user navigating between screens,
I want a visible loading indicator during the 1-2 second gap while a new screen loads,
so that I know my click registered and don't re-click or think the app is unresponsive.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

Riley-member clicks a nav link to a page whose data takes a moment to load. A visible, unobtrusive loading indicator (e.g. a top-of-page progress bar) appears immediately and clears when the new page is ready — Riley doesn't wonder whether the click worked.

## Acceptance Criteria

1. A global navigation-loading indicator is added, driven by SvelteKit's `navigating` store (`$app/stores`) — confirmed via investigation that no such indicator or store usage currently exists anywhere in `apps/web`.
2. The indicator appears as soon as a navigation starts (`navigating` becomes non-null) and disappears when it completes — no manual timers or guessed durations.
3. Visual treatment is unobtrusive and consistent with the app's existing design language (e.g. a slim top-of-viewport progress bar is the common pattern for this; a full-page spinner/overlay should be avoided since it would block interaction unnecessarily for fast navigations).
4. The indicator does not flash/flicker for very fast navigations (a short delay before showing, on the order of ~150-200ms, so instantaneous navigations don't show a distracting blip). The delayed-show timer is explicitly cancelled if navigation resolves before the threshold fires, so a fast navigation never shows a late, purposeless flash of the indicator immediately after the page has already rendered.
5. Applies globally (added once in the root layout, e.g. `apps/web/src/routes/+layout.svelte`), not per-page.
6. The indicator is exposed to assistive technology (e.g. `role="status"`/`aria-live="polite"` on the indicator element, or an equivalent visually-hidden live-region announcement) — a purely visual progress bar gives screen-reader users no signal that a navigation is in flight.
7. The indicator's animation respects `prefers-reduced-motion` (no continuous/pulsing animation for users who've requested reduced motion; a simpler static or minimal-motion treatment is used instead).
8. If a navigation is cancelled (e.g. the user clicks another link before the first navigation finishes) or the target route errors/404s, the indicator correctly clears rather than getting stuck visibly "loading" — verify against `navigating` store transitions, not just the single-navigation happy path.
9. New component test(s) cover: indicator shows during a simulated pending navigation and hides once navigation resolves, the ~150-200ms delayed-show behavior specifically (fast navigation → never shows; slow navigation → shows only after the threshold), and the cancelled-navigation clear behavior from AC-8.
10. No existing page-level loading states (e.g. form-submission spinners already present on individual actions) are removed or duplicated by this — this is specifically for cross-page navigation, not in-page async actions.

## Tasks / Subtasks

- [x] Task 1: Build global nav-loading indicator component driven by `navigating` store (AC: 1, 2, 3, 4)
- [x] Task 2: Wire into root layout (AC: 5)
- [x] Task 3: Tests (AC: 6, 7)

## Dev Notes

- Confirmed via investigation: **no existing global loading/nav-progress pattern** exists in this app — no `$app/stores` `navigating` usage, no spinner/progress-bar component, no nprogress-style library in `apps/web/package.json`. This is genuinely new, not a matter of wiring up something already built.
- Keep the implementation dependency-free if reasonably possible (a small custom component reading the `navigating` store is enough for a top-bar progress indicator) rather than adding a new package for this, unless a very lightweight, well-maintained option is clearly justified — flag the tradeoff in Dev Agent Record if a library is chosen.
- Be careful this doesn't interact badly with existing per-action loading states (e.g. a submit button's own spinner) — this indicator is purely for SvelteKit page navigations (`navigating` store), not form actions/fetches within a page.

### Project Structure Notes

- New component likely lands in `apps/web/src/lib/components/` (e.g. `NavigationProgressBar.svelte`), wired into `apps/web/src/routes/+layout.svelte`.

### References

- SvelteKit `navigating` store: `$app/stores`
- [Source: apps/web/src/routes/+layout.svelte]
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

GPT-5 (Codex)

### Debug Log References

- RED phase: focused Vitest run failed because `NavigationProgressBar.svelte` did not yet exist.
- GREEN phase: focused component/root-layout tests pass. Dependency installation was required because
  this isolated worktree had no `node_modules`; Paraglide emitted a pre-existing offline plugin-fetch
  warning during test/typecheck/lint setup, but each requested command completed successfully.

### Completion Notes List

- AC-1/2/4/8: Added a dependency-free root-safe Svelte component subscribed to `$app/stores`'s
  `navigating` store. It reveals after 180ms, cancels the delayed reveal on `null`, and clears the
  visible bar for resolved, cancelled, and errored navigations without guessed load durations.
- AC-3: Uses a fixed 3px top-of-viewport brand-colored bar with `pointer-events: none`; no overlay or
  full-page spinner was introduced.
- AC-5: Mounted exactly once in `apps/web/src/routes/+layout.svelte`, covering authenticated and
  pre-auth routes globally.
- AC-6/7: Exposes `role="status"` with `aria-live="polite"` and a screen-reader label; the CSS media
  query removes continuous animation and uses a static full-width treatment for reduced motion.
- AC-9: Added focused tests for fast/slow delayed-show behavior, delayed-show cancellation, visible
  cancellation/error clearing, accessibility/reduced motion, and root-layout wiring.
- AC-10: Existing page-level loading states were not modified or duplicated; the existing GlobalSearch
  loading tests remain green.

### File List

- `apps/web/src/lib/components/NavigationProgressBar.svelte`
- `apps/web/src/lib/components/NavigationProgressBar.test.ts`
- `apps/web/src/routes/+layout.svelte`
- `apps/web/src/routes/root-layout.test.ts`

### Change Log

- 2026-07-30: Implemented Story 18.10 via TDD red-green; all tasks and acceptance criteria are
  complete and the story is ready for review.
