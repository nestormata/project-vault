# Adversarial Review — Story 10.4

- **Date:** 2026-07-10
- **Reviewed file:** `/home/nestor/Proyects/project-vault/.claude/worktrees/plan/10-4-sonarcloud-new-coverage-buffer/_bmad-output/implementation-artifacts/10-4-sonarcloud-new-coverage-buffer.md`
- **Reviewer:** `bmad-review-adversarial-general`

## Findings

- **[critical] Live main’s 41.3445% equals `(149 covered lines + 97 covered conditions) / (483 lines + 112 conditions)`, but the story queries only line counters and calls the metric “line coverage.” Baseline and 85% proof can be wrong. Require new/overall condition counters and exact combined arithmetic at project/component/file levels.**

- **[high] Live PR #170 and main show `apps/web/scripts/**` contributes 35 new lines/35 uncovered, but AC-B1 omits this known Story 10.3 tooling. The target plan is incomplete. Explicitly inventory and coverage-exclude it, or classify it as product and cover it.**

- **[high] AC-B1 pre-authorizes excluding all 377 root-script lines although the directory contains tested migration, RLS, audit, bootstrap, Docker, and Sonar logic. That can hide testable security/operations code. Inventory files, import tested logic coverage, and exclude only proven infrastructure entrypoints.**

- **[high] AC-B4 includes only API modules “already exercised,” so untested product files remain outside Vitest’s 80% denominator despite the truthfulness claim. This preserves selective-allowlist debt. Define complete `apps/api/src` production membership with explicit exclusions, or obtain approval for narrower scope.**

- **[high] Live Sonar exposes only `main` as a long branch; PR #169 has no `new_coverage`, and PR #170 measures only 35 PR lines. AC-D1’s undefined “line-level reconciliation” cannot prove landing equivalence. Specify a condition-aware executable algorithm or authorized post-merge proof/rollback plan.**

- **[high] AC-D7 permits known-misleading `packages/db` and `packages/shared` includes—currently three DB files and one shared schema—whenever they do not block 85%, contradicting project-wide truthfulness. Narrow the claim to API/new code or instrument packages completely; explicitly approve partial truth.**

- **[medium] Baseline API reads are not atomic or analysis-pinned.** `project_status`, `measures/component`, and `component_tree` all read “latest” independently, so a CI analysis completing between calls can combine different revisions despite AC-A2. Capture the latest analysis key/revision first, verify no newer analysis appeared after all reads, and retain timestamped raw payloads; fail/retry on movement.

- **[medium] The promised line-level LCOV/Sonar reconciliation has no file-level Sonar query.** The provided `component_tree` command requests only `qualifiers=DIR`, yet AC-B5/D1 require source-component matching and line-level landing equivalence. Add paginated `FIL`-level measures and line/SCM-new-code retrieval, including condition metrics, plus a deterministic path-normalization comparison.

- **[medium] The 85% target is evidence-only while the enforced gate remains 80%, creating a time-of-check/time-of-merge gap.** Exact-SHA prose does not prevent a later rebase or commit from passing CI at 80–84.99%. Require the final evidence SHA to equal the merge head and invalidate/re-run evidence after every head change, preferably through a required automated verifier/check.

- **[medium] Freshness requirements exceed the delivery changes that are actually specified.** AC-B6 requires every report to come from the exact run and old outputs to be removed, but CI merely runs `pnpm turbo test`; the expected file map excludes workflow or manifest changes. A fresh hosted checkout helps but does not prove local/re-run provenance. Require CI cleanup or a generated SHA/timestamp/hash manifest for all seven LCOV files before scanning.

- **[medium] Story 10.3 is treated as complete even though both its story and sprint status remain `review`.** Its code is merged in PR #170, but its own record discloses unrun DB-dependent `make ci` gates, and its Sonar PR/main effect introduced the 35 uncovered tooling lines this story missed. Make 10.3 acceptance/closure an explicit prerequisite or state that 10.4 owns unresolved review fallout.

- **[medium] `api-contract-tests` classification lacks a decisive rule for mixed test-support code.** The package has no runtime export, but it contains reusable, separately unit-tested algorithms (`request-builder`, pagination checks, spec loading, AJV validation), not only fixtures. “Wholly test-only” is ambiguous and could justify hiding substantial maintainable source. Require a file inventory and explicit ownership/runtime-consumer test; exclude harness/fixtures precisely unless the whole-package decision is approved.

- **[low] Sonar API availability/authentication handling is inconsistent.** The story says planning endpoints were public and suggests optional authentication, while `docs/sonarqube.md` says all reads need `SONAR_TOKEN`; no acceptance path defines redaction, 401/403 handling for baseline reads, or retention of raw evidence. Standardize authenticated/public fallback commands, redact credentials, and fail closed when required payloads are unavailable.
