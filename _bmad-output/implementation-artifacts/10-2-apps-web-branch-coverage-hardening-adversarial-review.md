# Adversarial Review: Story 10.2 (apps/web Branch Coverage Hardening)

**Date:** 2026-07-10
**Reviewed file:** `/home/nestor/Proyects/project-vault/.claude/worktrees/plan/10-2-apps-web-branch-coverage-hardening/_bmad-output/implementation-artifacts/10-2-apps-web-branch-coverage-hardening.md`
**Reviewer:** bmad-review-adversarial-general

---

## Findings

1. **[high]** AC-A2 does not make the denominator complete. The shared config has thresholds and reporters but no `coverage.include` for `apps/web/src`; Vitest therefore measures loaded modules, while AC-A2 explicitly limits itself to files “reached by the current ... model.” Unimported production files can remain absent, so the story can pass 80% without repository-wide truthful coverage.

2. **[high]** The story knowingly converts a pagination defect into required regression behavior. `+page.svelte` receives `data.hasNext` but renders **Next** from `notifications.length === 20`; Dev Notes instruct tests to preserve that behavior. This can show Next on a full final page and contradicts FR97’s truthful pagination contract rather than merely deferring an unrelated defect.

3. **[high]** AC-D1’s RED requirement is unsound for test-only work against already-shipped behavior. It accepts a failure caused by an absent mock/fixture, then calls correcting the test harness “GREEN.” That proves only that an intentionally incomplete test was repaired—not that production behavior changed or that the new assertion can detect a regression—and conflicts with the repository’s behavior-first TDD intent.

4. **[medium]** Groups C1–C4 mandate “full” or “complete” path coverage for four large pages, while Task 6 says to add the smallest tests selected from a fresh ranking and the planning table says it is not frozen. These are incompatible completion strategies: all four exhaustive lists are mandatory ACs even if different files close the measured deficit more efficiently.

5. **[medium]** AC-A1 requires the pre-change command to fail specifically below 80%, but the reconciliation section says normal code movement may change the baseline. If upstream movement raises branches to 80%, an already-satisfied gate makes the story formally impossible because no valid RED can be recorded.

6. **[medium]** AC-A3 treats 80.04% as an acceptable endpoint and requires no safety margin. One small conditional added by another ready/in-progress web story can immediately return the package to red, making this a point-in-time threshold crossing rather than durable hardening.

7. **[medium]** “Non-bypassable” is not automated. AC-A4 relies on final-diff review but adds no invariant test or CI guard pinning the shared 80% thresholds, V8 provider, test include, or coverage denominator. The configuration remains mechanically relaxable while the test suite still passes.

8. **[medium]** Authorization evidence is limited to component props and mocked 401/403 responses. The tasks do not require loader/server tests proving that authenticated session and role data produce the correct `canManage`/role props. A mistaken server-side role mapping could therefore expose controls while every required component test passes; the story correctly disclaims RLS proof but leaves the web auth/session boundary under-specified.

9. **[medium]** AC-D2 requires identical test counts across two runs, not identical coverage numerators, denominators, or uncovered ranges. Time-, locale-, or environment-dependent branches can vary while test counts remain identical, undermining the determinism claim that matters to this story.

10. **[medium]** AC-D4 cannot establish that LCOV came from the same passing run merely by inspecting a non-empty file. The story requires neither deleting prior coverage before execution nor checking timestamps/run provenance, so stale-but-plausible LCOV can satisfy the stated inspection.

11. **[medium]** AC-D3 omits the prerequisites for local `pnpm turbo test`. The repository’s CI provisions PostgreSQL, migrates it, and supplies application/admin database URLs; the story asks developers to run the same graph without specifying equivalent setup, so unrelated DB failures can block or muddy verification.

12. **[medium]** The test-only scope conflicts with mandatory C-group behavior if a targeted shipped branch is defective or not testable through the existing seam. D5 forbids runtime corrections and says to pause, but C1–C4 still require those paths before completion; no acceptance rule defines whether to defer, replace the target, or block the story.

13. **[low]** The baseline and ranked uncovered ranges are recorded only in free-form Dev Agent notes. No machine-readable coverage summary or retained artifact is required, making later review of denominator drift and claimed branch closure unnecessarily difficult.

14. **[low]** The story encourages substantial additions to already broad page-level test files while explicitly deferring refactoring the large Svelte pages. This may reach the percentage quickly but compounds fixture/mock complexity and makes future branch intent harder to isolate.

---

## Summary

- **Total findings: 14**
- Critical: 0
- High: 3
- Medium: 9
- Low: 2
