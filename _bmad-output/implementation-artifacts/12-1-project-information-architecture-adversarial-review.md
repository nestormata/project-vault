# Adversarial Review: Story 12.1 — Project Information Architecture

**Date:** 2026-07-13
**Reviewed file:** `_bmad-output/implementation-artifacts/12-1-project-information-architecture.md`
**Reviewer:** bmad-review-adversarial-general

This review also covers the sibling story `12-2-usability-trust-accessibility-fixes.md` for
cross-story consistency. Findings below are limited to Story 1 issues and cross-story issues
relevant to Story 1. See the sibling review file for Story 2-specific findings (the cross-story
findings are duplicated there for completeness).

## Findings

- **[HIGH] AC-4's "established pattern" for malformed project IDs does not actually exist as described.**
  Direct read of `apps/web/src/routes/(app)/projects/[projectId]/credentials/+page.server.ts`
  confirms the loader only catches `ApiClientError` with `status === 404`; any other error
  (including a likely `400` for a malformed UUID like `not-a-uuid`) is rethrown and falls through
  to SvelteKit's generic/default error boundary — not a graceful 404/400 page. AC-4 instructs the
  dev to "reuse whatever the credentials route currently does for the same malformed input," but
  that behavior is effectively "crash to the default error page," not a deliberate pattern. A dev
  following this AC literally will ship the same unhandled-error behavior for the new overview
  route instead of proper input validation.

- **[HIGH] Cross-story: potential divergent implementations of the same focus-ring fix.**
  Story 2 AC-13 requires fixing the invisible focus-ring on `bg-slate-950` buttons "at the shared
  component/utility level... so every current and future `bg-slate-950` button inherits the fix."
  Story 1 AC-15 separately requires the new `ProjectNav` tabs to meet the same focus-visible bar
  and explicitly calls out the same underlying bug ("do not reuse the invisible-focus-ring pattern
  flagged in the audit"). Neither story states which one owns the shared fix or how the other
  consumes it. Story 1's own Dev Notes suggest the sub-nav can ship early/standalone (before
  Story 2 necessarily lands), which risks the sub-nav tabs getting a bespoke one-off fix that
  duplicates or conflicts with Story 2's later "shared utility" fix — exactly the "patch
  individual buttons one at a time" anti-pattern Story 2 AC-13 says to avoid.

- **[MEDIUM] AC-2 summary tiles: no partial-failure behavior specified.**
  The overview page's three tiles (member count, expiring-soon, endpoint/status-page health) each
  require a separate call to an existing project-scoped API endpoint per the Dev Notes ("no new
  API changes... obtainable from existing project-scoped endpoints"). Nothing in AC-2 or the test
  coverage ACs (17/18) specifies what happens if one of the three calls fails or times out while
  the others succeed — does the whole page fail, or does the failing tile degrade gracefully? This
  is a real gap for a page that fans out to at least 3 backend calls on every load.

- **[MEDIUM] AC-9 only hides/disables the tab; it does not require verifying the underlying route still enforces authorization.**
  AC-9 protects a viewer from being "linked... into a 403 page with no explanation" by hiding or
  disabling the tab, but there is no AC or test requiring confirmation that navigating directly to
  a role-gated sub-route (e.g. typing `/projects/:id/members` in the address bar) still correctly
  403s at the route/API level. The story assumes this authz already exists ("check... before
  assuming") but never turns that assumption into a verified AC — for a credentials-vault product,
  UI-level hiding without a paired enforcement check is a thin guarantee.

- **[MEDIUM] No tenant-isolation AC for the summary-tile queries themselves.**
  AC-3 covers the org-ownership check for the project itself, but none of AC-1/AC-2/AC-17 requires
  that the member-count, expiring-soon, and endpoint-health queries backing the summary tiles are
  independently scoped by both `project_id` and the caller's `org_id` (not project_id alone). Given
  the also_consider explicitly flags RLS/tenant isolation, this is a gap worth closing with an
  explicit AC or test, even if the underlying endpoints already do this correctly today.

- **[LOW] AC-5 doesn't address interaction restrictions for archived projects, only a visual badge.**
  It's unclear whether tabs like "Add credential" quick actions inherited from sub-pages should be
  disabled for an archived project, or whether the badge is purely cosmetic. Left to implementer
  judgment with no test to pin the decision down.

- **[LOW] Task 2's Dev Notes understate the risk of introducing `+layout.svelte`.**
  The notes claim "regression risk is primarily visual/layout... not functional," but a new
  `[projectId]/+layout.svelte` changes the SvelteKit parent/child `load` data-merging chain for all
  8 existing sub-routes — a functional change to data flow, not purely cosmetic. Worth flagging
  explicitly as a risk rather than downplaying it.

- **[LOW] The persona journey's "breadcrumb/header, if present" affordance is never formalized as an AC.**
  The story's narrative mentions an optional way back to Overview via "the project name in a
  breadcrumb/header, if present," but no AC requires this element to exist, and no test covers it —
  it's an ambiguous, unverified detail left dangling in prose.

## Cross-story findings

- **[MEDIUM] Both stories independently touch dashboard-adjacent behavior with no coordination note.**
  Story 1 Task 3 re-points `apps/web/src/routes/(app)/dashboard/+page.svelte`'s project-level links.
  Story 2 Task 1 fixes a staleness bug in `apps/web/src/routes/(app)/dashboard/+page.server.ts` and
  the onboarding wizard's transition into `/dashboard`. Different files, but both stories'
  regression-test notes point at the same `dashboard.test.ts` as their verification surface, and
  neither story's Dev Notes acknowledges that the sibling is concurrently changing
  dashboard-adjacent behavior. Not a hard ordering dependency, but a real merge/test-conflict risk
  if implemented as parallel PRs.

- **[LOW] Story 1's Background contains a one-directional dangling cross-reference to Story 2.**
  It cites "see `12-2-usability-trust-accessibility-fixes` AC-D4 for the bare-404-page fix,"
  despite both stories' headers asserting a reader "does not need... the sibling story to be
  understood or implemented." This particular reference isn't load-bearing (Story 1's own AC-3/AC-4
  reuse the existing credentials-route error pattern, not Story 2's new `+error.svelte`), but the
  independence claim is slightly oversold given the reference exists at all — a reviewer reading
  only Story 1 hits an unresolvable pointer.

- **[LOW] Neither story explicitly states which one owns "everything else" from the accessibility audit.**
  Story 1 carries its own accessibility ACs (15, 16) scoped to the new sub-nav; Story 2 carries a
  full accessibility AC group (D) for pre-existing issues. No AC or scope note in either file states
  that Story 2 is responsible for *all* other pre-existing accessibility findings not touched by
  Story 1's new surface — implied but never stated, a minor traceability gap rather than a
  functional one.
