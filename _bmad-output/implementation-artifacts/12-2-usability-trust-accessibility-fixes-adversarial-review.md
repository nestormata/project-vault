# Adversarial Review: Story 12.2 — Usability Trust and Accessibility Fixes

**Date:** 2026-07-13
**Reviewed file:** `_bmad-output/implementation-artifacts/12-2-usability-trust-accessibility-fixes.md`
**Reviewer:** bmad-review-adversarial-general

This review also covers the sibling story `12-1-project-information-architecture.md` for
cross-story consistency. Findings below are limited to Story 2 issues and cross-story issues
relevant to Story 2. See the sibling review file for Story 1-specific findings (the cross-story
findings are duplicated here for completeness).

## Findings

- **[HIGH] No AC requires audit-log entries for destructive user-management actions.**
  AC-15 adds a client-side `confirm()` dialog with a named user/action for "Deactivate account,"
  "Remove from organization," and "Request erasure" — but nothing in AC-15 or elsewhere in the story
  requires (or even checks for) a server-side audit-trail entry for these actions. For a product the
  story itself frames as "a security/operations product I depend on," and given the also_consider
  explicitly calls out audit/logging gaps, the absence of any audit-logging AC for destructive
  identity actions (deactivate, remove, erasure) is a notable gap — confirmation-dialog UX and
  audit trail are separate concerns, and only the former is covered.

- **[MEDIUM] AC-8's org-state gate has an unaddressed race condition.**
  The wizard auto-launch gate is "does this org have any projects" (project count > 0). Two
  admins/owners accepting invitations into the same freshly-created zero-project org at roughly the
  same time could both observe project count 0, both have the wizard auto-launch, and both attempt
  to create a "first project" concurrently. The story is otherwise careful about edge cases (AC-3
  slow-backend, AC-7 partial-completion rollback) but doesn't mention this concurrency scenario.

- **[MEDIUM] AC-2 treats "hard navigation" as an equally acceptable fix alongside `invalidateAll`, without acknowledging the UX regression.**
  A full-page hard navigation after onboarding completion is a materially worse first impression
  than a soft `goto(url, { invalidateAll: true })` — it introduces a visible reload/flash right at
  the moment the story's own framing says trust matters most ("a security/operations product...
  doesn't itself create confusion"). Listing it as an unranked, equally valid option is a design
  gap, not just an implementation detail left open.

- **[LOW] AC-18's unauthenticated-vs-authenticated 404 fallback defers a real design decision to dev-story time.**
  If distinguishing auth state in `+error.svelte` proves impractical, the AC allows falling back to
  linking `/` and says only "document whichever approach is taken" — leaving an open design
  question (does `/` reliably redirect correctly today?) unresolved at story-writing time rather
  than settled by the story author, who had the chance to confirm `root-page.server.test.ts`'s
  actual behavior before writing the AC.

- **[LOW] AC-22/23's event-type label mapping has no completeness-verification requirement.**
  The story requires a shared mapping module and a graceful humanized fallback for unmapped codes
  (AC-23), but no AC requires a test that enumerates every event-type code actually emitted
  elsewhere in the codebase (audit log, notifications) and asserts each has a real mapping entry.
  Without that, the mapping table could ship with real day-one gaps that are silently papered over
  by the fallback rather than caught by CI.

## Cross-story findings

- **[MEDIUM] Both stories independently touch dashboard-adjacent behavior with no coordination note.**
  Story 2 Task 1 fixes a staleness bug in `apps/web/src/routes/(app)/dashboard/+page.server.ts` and
  the onboarding wizard's transition into `/dashboard`. Story 1 Task 3 re-points
  `apps/web/src/routes/(app)/dashboard/+page.svelte`'s project-level links. Different files, but
  both stories' regression-test notes point at the same `dashboard.test.ts` as their verification
  surface, and neither story's Dev Notes acknowledges that the sibling is concurrently changing
  dashboard-adjacent behavior. Not a hard ordering dependency, but a real merge/test-conflict risk
  if implemented as parallel PRs.

- **[LOW] Story 1's Background contains a one-directional dangling cross-reference into this story.**
  Story 1 cites "see `12-2-usability-trust-accessibility-fixes` AC-D4 for the bare-404-page fix,"
  despite both stories' headers asserting a reader "does not need... the sibling story to be
  understood or implemented." This isn't load-bearing for Story 1 (its AC-3/AC-4 reuse the existing
  credentials-route error pattern, not this story's new `+error.svelte`), but it means the
  independence claim is slightly oversold, and note that this story's actual AC numbering is a flat
  1-26 list, not "AC-D4" — Story 1's cross-reference uses a group-letter naming convention (D4) that
  doesn't match how this story's ACs are actually numbered, which would confuse a reader trying to
  resolve the pointer.

- **[LOW] Neither story explicitly states which one owns "everything else" from the accessibility audit.**
  This story carries a full accessibility AC group (D, ACs 12-21) for pre-existing issues; Story 1
  carries its own accessibility ACs (15, 16) scoped to its new sub-nav. No AC or scope note in
  either file states that this story is responsible for *all* other pre-existing accessibility
  findings not touched by Story 1's new surface — implied but never stated, a minor traceability
  gap rather than a functional one.
