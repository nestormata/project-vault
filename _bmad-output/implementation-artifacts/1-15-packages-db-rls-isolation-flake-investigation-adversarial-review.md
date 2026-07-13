# Adversarial Review: Story 1.15 (packages/db RLS-Isolation Flake Investigation)

**Date:** 2026-07-13
**Reviewed file:** `_bmad-output/implementation-artifacts/1-15-packages-db-rls-isolation-flake-investigation.md`
**Reviewer:** bmad-review-adversarial-general

## Findings

1. **[critical]** No AC or task gates the story from closing under the wrong Product Surface
   classification. The Product Surface Contract table declares `Surface scope: none` /
   `Evaluator-visible: no`, and only a Dev Notes-level sentence says this "must be revisited
   immediately" if option (a) (a genuine RLS policy gap) is confirmed. Nothing enforces that
   revisit — no AC requires updating the Product Surface Contract, escalating, or blocking
   `done` status if a real cross-org leak is found. A story that discovers a live tenant-isolation
   bug could still close as internal test-infra work with no security review triggered.

2. **[critical]** If the root cause turns out to be option (a)/(b) (a genuine RLS policy gap or a
   pooled-connection leak), no AC or task requires assessing whether this has ever been exploitable
   in production — i.e., whether the same `set_config`/pooling pattern used by `withOrg()` in
   production API request handling (not just tests) could leak `app.current_org_id` across tenants
   under real concurrent load. The story frames this entirely as a test-suite trust problem
   ("so that a green packages/db test run can be trusted"), but the underlying code path
   (`packages/db/src/index.ts`) is the same code used in production. A genuine finding here has
   incident-response implications (was any customer's data actually cross-visible?) that the story
   never asks anyone to check.

3. **[critical]** AC 4's suggested "smallest safe mitigation" — "forcing a fresh connection per
   `withOrg()` call in test context only" — is a mitigation that only fixes the test harness, not
   production. If the true root cause is a real connection-pool `set_config` leak, this mitigation
   would make the test suite reliably green while leaving the identical leak live in production
   under the same pooling conditions. This is exactly the kind of "fix the safety net, not the
   bug" outcome the story's own "Story" section says must not happen, yet AC 4 explicitly
   pre-authorizes it as an acceptable resolution without any requirement to also assess/patch the
   production code path.

4. **[high]** AC 5's bar for "actually fixed" — `test-repeat N=10` passing cleanly — is
   statistically too weak given the story's own citation of the Makefile's stated flake rate
   ("one bad run in ~6–8"). If the underlying bug is still present at a ~1-in-7 failure rate, the
   probability all 10 post-fix runs pass by chance alone is roughly (6/7)^10 ≈ 21%. AC 5 can be
   satisfied while the bug is still live roughly 1 time in 5, which undermines the story's entire
   premise of restoring trust in a green run.

5. **[high]** Tasks 2.1–2.3 (root-cause instrumentation) all assume a failing run exists to
   instrument ("instrument or log `app.current_org_id` per query during a failing run"). But this
   story's own Reproduction Attempts section reports 8+ consecutive clean runs with zero
   reproduction. There is no fallback subtask under Task 2 that maps to AC 1's own documented
   fallback path (root-causing from static/code-path analysis when reproduction fails). If Task 1
   doesn't reproduce, Task 2 as written has no valid entry point.

6. **[high]** AC 3 requires a RED-before-GREEN regression test "unless AC 1's fallback applies, in
   which case document why a reliable RED state could not be constructed" — but the story never
   defines what happens next. Is the story allowed to reach `done` with no regression test at all,
   permanently leaving the suite without protection against recurrence? Given the story's stated
   goal is to make a green run trustworthy again, closing without a regression test would leave the
   original problem (an unverifiable safety net) essentially unresolved, and the AC doesn't say
   this is disallowed.

7. **[high]** `audit-log-immutability.test.ts` and `api-instances-privileges.test.ts` are folded
   into the same "13 files" / "off-by-one row-leakage" symptom family as the RLS-isolation tests,
   based solely on Story 1.7's grouping them together in a Dev Agent Record note. But audit-log
   immutability failures and privilege-check failures are a materially different (and arguably more
   severe) security class than row-visibility leakage — a tamper-evidence/audit-integrity gap, not
   a read-isolation gap. AC 2's four named mechanisms (a–d) are all framed around RLS/pooling/fixture
   causes and never separately account for the possibility that these two files are failing for an
   unrelated, audit-trail-specific reason that got lumped in by inference rather than verified
   symptom-matching.

8. **[medium]** The "13 files" list is explicitly reconstructed, not sourced from any actual test
   run or CI log: "No single file has '13' written anywhere; this list is reconstructed from Story
   1.7's grouping ... plus the `*-rls-isolation.test.ts` / `*-rls.test.ts` naming family." No AC or
   task validates that this inferred list matches the actual failing set before Task 1's
   reproduction work begins. If the real failing set differs (more, fewer, or different files),
   Task 1's reproduction attempts are scoped against a guess.

9. **[medium]** AC 1's reproduction bar ("try N=10+ first") has the same statistical weakness as
   finding 4, in reverse: if the true failure rate is rarer than roughly 1-in-10 (plausible — this
   story's own pass got 8 consecutive clean runs), N=10 will very plausibly still fail to reproduce,
   and the story gives no guidance on how many escalating attempts (N=20, N=50, cross-package,
   CI-parity) constitute a "serious, documented attempt" before AC 1's fallback is legitimately
   invocable. This is a scope/effort-budget gap that invites either premature fallback or unbounded
   investigation time.

10. **[medium]** No time-box or effort budget is defined anywhere in the story for the
    reproduction/investigation phase, despite the story itself documenting that its own
    investigation pass already burned significant effort (8 full suite runs, a 400s pipeline
    timeout, a 2-minute repeat-loop cap) without reproducing anything. Task 1.4 (CI-parity /
    resource-constrained container reproduction) in particular could require nontrivial
    infrastructure work with no owner, tooling, or time allowance specified.

11. **[medium]** AC 6's CI safeguard ("a periodic/nightly test-repeat-style job for packages/db")
    has no accompanying requirement for alerting/monitoring when that job fails. A silent nightly
    job that fails and nobody looks at is only marginally better than the current state (a footnote
    in a PR description) — the story doesn't require the safeguard to actually surface a recurrence
    to a human, only that it "surfaces automatically," which is not the same as "someone gets
    notified."

12. **[medium]** No AC or task asks whether the bug (if real) may have already been silently fixed
    or altered by unrelated changes merged since it was last actually observed (before 2026-06-26,
    per Story 1.7's dated entry, versus this story's authoring on 2026-07-13 — roughly three weeks
    and many merged stories later, including migration 0048 and the vault-kms work). This story's
    own reproduction pass came back 100% clean across every attempt. AC 1 does not require checking
    `git log`/dependency changelogs on the implicated files (`packages/db/src/index.ts`,
    `test-helpers.ts`, migrations, or the `pg`/Drizzle dependency versions) for anything that
    changed in that window before assuming the bug is still live and spending further investigation
    effort chasing it.

13. **[medium]** The Dev Agent Record's Completion Notes List contains the line "Ultimate context
    engine analysis completed - comprehensive developer guide created." This does not correspond to
    any deliverable described elsewhere in the story — there is no "developer guide" artifact in the
    File List or anywhere else in the document. This reads as leftover template/boilerplate text
    that was never cleaned up, and its presence undermines confidence in the rest of the Dev Agent
    Record's accuracy.

14. **[low]** AC 2's Dev Notes flag the pooled-connection `set_config` leak as "the single most
    likely root-cause candidate," but this is an inference from the symptom description and a read
    of `withOrg()`'s code, not from any observed failure — the story itself notes the fixture-cleanup
    candidate (option c) is equally consistent with an "off-by-one" symptom (a single leftover row
    vs. a single leaked cross-org row). Presenting one candidate with more confidence than the
    evidence supports risks anchoring/confirmation bias in the next investigator.

15. **[low]** The story never states that it verified `set_config('app.current_org_id', ...)` calls
    are parameterized (they are, per `packages/db/src/index.ts` lines 59–60/79–80, via Drizzle's
    `sql` tagged template) rather than string-concatenated. This is not a live vulnerability — the
    code appears safe — but given the story's own security-adjacent framing (Dev Notes: "this is the
    single most security-sensitive thing this codebase's RLS layer exists to prevent"), it never
    explicitly rules out injection as a contributing factor, leaving a documentation gap for future
    investigators who don't independently check the source.

16. **[low]** The File List section lists this adversarial-review file itself as a "New file"
    produced by the story-creation pass, even though a draft of it already existed prior to this
    pass and is being replaced, not authored fresh — a minor provenance inconsistency in how the
    story accounts for its own artifacts.
