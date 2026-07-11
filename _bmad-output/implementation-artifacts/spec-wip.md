---
title: 'Fix SonarCloud Quality Gate new_coverage on main'
type: 'bugfix'
created: '2026-07-10'
status: 'ready-for-dev'
context:
  - 'docs/sonarqube.md'
  - 'sonar-project.properties'
  - 'apps/api/vitest.config.ts'
  - '.github/workflows/ci.yml'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `main` CI fails solely at the SonarCloud Quality Gate. The analysis for
`814d0444` reports `new_coverage=41.3%` against the required `>=80%`; new-code security,
reliability, and maintainability ratings are A, duplication is 0%, and security-hotspot review is
100%. PR #169 has already merged, so `apps/web/e2e/**` is excluded, but that partial fix did not
make the main-branch gate pass.

**Approach:** Make local Vitest measurement and Sonar's imported LCOV agree on a complete,
category-defined API production-source denominator. Exclude only code that is genuinely
non-coverable or test infrastructure, add behavior-focused tests where the truthful baseline is
below 80%, and prove the result on a main-equivalent Sonar analysis. Do not lower the gate or hide
product and operational logic behind exclusions.

## Product Surface Contract

| Field                     | Value                                                                           |
| ------------------------- | ------------------------------------------------------------------------------- |
| **Surface scope**         | `none` — test measurement, tests, scanner configuration, and documentation only |
| **Evaluator-visible**     | CI/Sonar evidence only; no shipped API or web behavior changes                  |
| **Linked UI story**       | N/A                                                                             |
| **Honest placeholder AC** | N/A                                                                             |
| **Persona journey**       | N/A — no user-facing journey changes                                            |

If implementation uncovers a runtime defect, record it and stop that path. Fixing production
behavior requires separately authorized scope.

## Boundaries & Constraints

**Always:**

- Keep Quality Gate enforcement enabled in CI.
- Keep `new_coverage` threshold at `>=80%` (Sonar project gate).
- Preserve the API's four 80% Vitest thresholds and V8/LCOV provider/reporting contract.
- Replace the Story 1.1-era API source allowlist with a complete eligible-source include.
- Define exclusions by auditable category, extending Vitest defaults rather than replacing them.
- Add behavior-focused tests when complete-source instrumentation exposes uncovered product code.
- Keep coverage output fresh and prove JSON/LCOV path membership before using percentages.
- Verify with a branch analysis based on current `main`, then verify the post-merge main analysis.

**Never:**

- Disable or skip `sonarqube-quality-gate-action`.
- Lower Sonar's `new_coverage` threshold to make CI green.
- Blanket-exclude `scripts/**`, `apps/api/src/modules/**`, workers, routes, or other production/
  operational logic merely because it lacks LCOV today.
- Replace the stale API allowlist with another selective list of current Sonar hotspots.
- Reset the Sonar new-code baseline/version to erase the active leak period.
- Add coverage-ignore directives, weaken assertions, or change runtime code to manufacture coverage.
- Treat PR-gate success as proof that the main-branch `new_coverage` condition will pass.

**Stop conditions:**

- A source-map/path mismatch prevents authored API files from reconciling between JSON and LCOV.
- Reaching 80% appears to require excluding product logic or changing the Sonar leak period.
- A test reveals incorrect runtime behavior that cannot be characterized without a production fix.
- Current `main` moves enough to change the new-code denominator materially; rebase and re-baseline.

## I/O & Edge-Case Matrix

| Scenario                    | Input / State                                                      | Expected Output / Behavior                                                                                    | Error Handling                                                                          |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Current main                | Sonar analysis `814d0444`, leak period from `2026-07-09T12:20:06Z` | Baseline is `new_coverage=41.3%`; only this condition fails                                                   | Re-read the API if main receives another analysis                                       |
| Complete API source         | Fresh API V8 run                                                   | Every eligible instrumentable production file appears in coverage JSON and LCOV, including zero-covered files | Reconcile missing, duplicate, absolute, and generated paths before test work            |
| Truthful baseline below 80% | Existing tests pass but coverage thresholds fail                   | Record exact metric counts and ranked uncovered authored ranges; add focused tests                            | Do not narrow `coverage.include` or add product exclusions                              |
| Test/declaration support    | `*.test.ts`, `*.d.ts`, setup files, fixtures, test helpers         | Excluded by explicit category while production siblings remain measured                                       | A new category needs evidence and review                                                |
| Repository scripts          | `scripts/**`                                                       | Remain analyzed and are not blanket coverage-excluded                                                         | Classify a specific entrypoint only with documented non-product/non-coverable rationale |
| PR analysis                 | Fix branch contains coverable new lines or only config changes     | Useful evidence, but not sufficient by itself                                                                 | Require main-equivalent measure math and post-merge main verification                   |
| Stale report/cache          | LCOV predates source/config under test                             | Verification fails closed                                                                                     | Delete coverage output and rerun                                                        |

</frozen-after-approval>

## Code Map

- `apps/api/vitest.config.ts` — replace the stale source allowlist with canonical complete-source
  include/exclude semantics while retaining all four 80% thresholds.
- `apps/api/src/__tests__/setup-env.ts` and test-support paths — classify as test infrastructure,
  never as production coverage targets.
- `sonar-project.properties` — preserve scanner scope and the merged
  `apps/web/e2e/**` coverage exclusion; add only evidence-backed category exclusions.
- `docs/sonarqube.md` — document complete-source coverage ownership, exclusion rationale, and the
  distinction between PR and branch quality-gate evidence.
- `.github/workflows/ci.yml` — enforcement is already correct; no bypass or ordering change expected.
- Sonar hotspots to validate, not hard-code as the denominator:
  `projects/dashboard-stats.ts`, `auth/mfa.ts`, `auth/mfa-enforcement.ts`, and tested workers.

## Tasks & Acceptance

**Execution:**

- [ ] **TDD RED — configuration contract:** first add a focused test that evaluates the merged API
      Vitest config and fails on the current selective allowlist; assert provider, reporters, complete
      source include, category exclusions, and unchanged four-metric 80% thresholds.
- [ ] **GREEN — truthful API denominator:** implement the smallest config change that includes all
      eligible `apps/api/src/**/*.ts` production sources and excludes only tests, declarations, setup,
      fixtures, and proven test helpers.
- [ ] **Fresh baseline:** delete `apps/api/coverage`, run API coverage, and reconcile the normalized
      eligible inventory against `coverage-final.json` and `lcov.info`. Record zero-instrumentable files
      separately; do not silently omit them.
- [ ] **Coverage closure:** rank exact uncovered new-code/auth/security/worker ranges and add focused
      behavior tests until all local API thresholds pass and projected Sonar `new_coverage` is `>=80%`.
- [ ] **Scanner classification:** review each proposed Sonar coverage exclusion individually.
      Preserve `apps/web/e2e/**`; do not blanket-exclude `scripts/**`.
- [ ] **Documentation:** update `docs/sonarqube.md` with denominator ownership, approved exclusion
      categories, fresh-artifact requirements, and PR-versus-main gate semantics.
- [ ] **Determinism:** run the clean API coverage command twice and confirm identical source
      membership and integer metric totals.
- [ ] **Repository verification:** run relevant focused tests, API coverage, typecheck/lint, and
      `make ci`; no gate may be bypassed.
- [ ] **Remote verification:** push a branch based on current `main`, confirm Sonar analysis and
      quality-gate success, then confirm the post-merge main analysis remains `>=80%`.

**Acceptance Criteria:**

- **AC-1 — Current evidence:** the story records the latest main analysis (`41.3%` at `814d0444`)
  and re-baselines if a newer main analysis exists before implementation.
- **AC-2 — Complete denominator:** a test proves the evaluated API Vitest config includes every
  eligible production TypeScript source category and excludes only test/declaration/support
  categories; no named production hotspot allowlist remains.
- **AC-3 — Report reconciliation:** every eligible instrumentable API source appears in fresh
  `coverage-final.json` and LCOV. Any zero-instrumentable source is listed with evidence.
- **AC-4 — Local gate:** all API tests pass and lines, branches, functions, and statements each
  remain `>=80%` against the complete-source denominator.
- **AC-5 — Existing hotspots:** dashboard stats, MFA/MFA enforcement, and each tested worker appear
  in LCOV with their actual coverage rather than implicit zero due to report omission.
- **AC-6 — No denominator gaming:** the final diff contains no blanket `scripts/**` exclusion,
  production-source exclusion, coverage-ignore directive, threshold reduction, provider switch,
  weakened assertion, skipped test, or runtime behavior change.
- **AC-7 — Sonar gate:** a main-equivalent analysis and the eventual post-merge main analysis report
  `new_coverage>=80%`; security/reliability/maintainability remain A, duplication remains `<=3%`,
  and security-hotspot review remains 100%.
- **AC-8 — Determinism:** two clean API coverage runs produce identical eligible-source membership
  and exact integer totals.
- **AC-9 — Repository gates:** `make ci` passes without `continue-on-error`, skipped Sonar
  enforcement, cache-only evidence, or stale coverage artifacts.
- **AC-10 — Scope:** only test/config/docs files change. Any product defect discovered is recorded
  for separate authorization.

## Spec Change Log

- 2026-07-10: Five-method advanced elicitation review completed and all recommendations accepted:
  First Principles Analysis, Stakeholder Round Table, Red Team vs Blue Team, Pre-mortem Analysis,
  and Critique and Refine. Reconciled the now-merged PR #169, replaced the estimated 41% with the
  observed 41.3% main result, rejected blanket script exclusion and selective API hotspot
  allowlisting, added complete-source/TDD/determinism/anti-gaming contracts, and made the story
  ready for development.

## Design Notes

### Five-method review synthesis

1. **First Principles Analysis:** coverage is trustworthy only when source eligibility is defined
   independently of which files happen to have tests. Therefore another selective include list is
   not an acceptable fix.
2. **Stakeholder Round Table (developer, QA, security, operator):** developers need a stable local
   gate, QA needs reproducible integer evidence, security needs auth/worker code visible even at
   zero, and operators need branch/main proof rather than a green config-only PR.
3. **Red Team vs Blue Team:** likely gaming paths are broad script/product exclusions, hotspot-only
   includes, leak-period resets, stale LCOV, and PR-only evidence. AC-2/3/6/7 block each path.
4. **Pre-mortem Analysis:** the fix would fail if main moved, LCOV paths did not match authored
   sources, complete-source coverage fell below 80%, or config-only PR analysis omitted the branch
   condition. Re-baselining, reconciliation, focused tests, and post-merge verification mitigate
   those failures.
5. **Critique and Refine:** PR #169 is merged, so extending it is impossible; the old spec also
   contradicted itself by forbidding hidden product logic while proposing blanket `scripts/**`
   exclusion and a new selective API allowlist. The refined tasks remove those contradictions.

Sonar `new_coverage` on main uses `previous_version` with a period beginning
`2026-07-09T12:20:06Z`. A PR with only configuration changes can pass without exercising the same
condition that fails branch analysis. Current main run `29128252327` passed all preceding Quality
Gates steps and failed at `SonarCloud Quality Gate`; the public project-status response reports
only `new_coverage` in error.

Preferred order: freeze current-main evidence → define complete API source eligibility → obtain a
fresh truthful baseline → reconcile JSON/LCOV → add behavior tests → classify only proven
non-coverable support → run full CI → verify branch and post-merge main.

## Verification

**Commands:**

- `rm -rf apps/api/coverage && pnpm --filter @project-vault/api test` — expected: tests and all four
  complete-source thresholds pass.
- Repeat the clean API coverage run — expected: identical normalized source membership and integer
  totals.
- `rg -n "dashboard-stats|mfa-enforcement|workers/" apps/api/coverage/lcov.info` — expected: matches
  for included authored product files.
- `pnpm turbo typecheck && pnpm turbo lint` — expected: pass.
- `make ci` — expected: pass including Sonar enforcement.
- `gh run view <run-id>` plus Sonar project-status API — expected: Quality Gate `OK`,
  `new_coverage>=80%`.

**Evidence to record:**

- main SHA and leak-period timestamp used for the baseline;
- eligible/instrumentable/zero-instrumentable API file counts;
- exact covered/total values for all four Vitest metrics;
- JSON/LCOV reconciliation result and two-run equality;
- final Sonar condition values for the fix branch and post-merge main.
