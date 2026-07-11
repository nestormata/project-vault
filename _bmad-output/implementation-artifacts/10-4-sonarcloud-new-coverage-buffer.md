# Story 10.4: SonarCloud New-Coverage Buffer

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->
<!-- Ultimate context engine analysis completed - comprehensive developer guide created. -->

## Story

As a **maintainer relying on the required SonarCloud Quality Gate**,
I want **Sonar's coverage denominator and imported LCOV to truthfully represent product code, with
new-code coverage measured at 85% or higher**,
so that **the fix lands on `main` with a passing gate and at least five percentage points of
headroom above the project's unchanged 80% gate**.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `none` — internal coverage classification, test instrumentation, tests, CI verification, and operator documentation |
| **Evaluator-visible** | No; product behavior, API contracts, routes, navigation, and UI remain unchanged |
| **Linked UI story** | N/A |
| **Honest placeholder AC** | N/A |
| **Persona journey** | N/A — no user-facing capability is added or changed |

### Persona journey stub

N/A. This story repairs engineering evidence and CI enforcement. Existing personas, role gates,
tenant behavior, UI journeys, and API responses must remain unchanged.

### G2/G3/G4 note

Epic 10 remains `in-progress`; this story does not close it. No navigation, dashboard value, or
placeholder is introduced. A runtime defect discovered while adding coverage is not silently fixed:
stop and reconcile it as separately authorized scope or track it as a follow-up.

---

## Planning Reconciliation and Authoritative Baseline

### Why this story is not sourced from an Epic 10 section in `epics.md`

`epics.md` is the historical plan for Epics 1–9. Epic 10 exists in `sprint-status.yaml` as
cross-cutting Quality & Test Automation work. Story 10.4 is therefore derived from:

- Story 1.1's binding per-package Vitest/V8 thresholds of 80% for lines, branches, functions, and
  statements;
- the current implementation and CI workflow on `origin/main`;
- Story 10.3's completed web-only complete-source work;
- the live SonarCloud main analysis and GitHub CI evidence below;
- the human draft `spec-wip.md`, reconciled to the newer live baseline and the user's explicit 85%
  completion target.

The SonarCloud project gate remains `new_coverage >=80%`. This story's primary completion metric is
the stricter measured `new_coverage >=85%`; it is a delivery buffer, not a request to change the
Sonar gate or the shared Vitest thresholds.

### Live main evidence captured during planning

Planning inspected `origin/main` revision `814d0444f937e618361061924bb3e6efb66e285a`
after `git fetch origin`. Sonar's latest main analysis was
`3abdeded-d2c4-491b-97de-b58a6d17bf4e` at `2026-07-10T23:07:03Z`, for that exact revision.
The latest main CI run was GitHub Actions run `29128252327`; every Quality Gates step through
`SonarCloud Scan` passed, and only `SonarCloud Quality Gate` failed.

Reproducible read-only queries (public at planning time; authenticate with `SONAR_TOKEN` if the
project/API later requires it):

```bash
curl -fsS 'https://sonarcloud.io/api/qualitygates/project_status?projectKey=nestormata_project-vault'
curl -fsS 'https://sonarcloud.io/api/measures/component?component=nestormata_project-vault&metricKeys=coverage,new_coverage,lines_to_cover,uncovered_lines,new_lines_to_cover,new_uncovered_lines'
curl -fsS 'https://sonarcloud.io/api/measures/component_tree?component=nestormata_project-vault&metricKeys=coverage,lines_to_cover,uncovered_lines,new_coverage,new_lines_to_cover,new_uncovered_lines&qualifiers=DIR&ps=500'
curl -fsS 'https://sonarcloud.io/api/project_analyses/search?project=nestormata_project-vault&ps=5'
gh run view 29128252327 --json jobs,conclusion,url,headSha
```

| Scope | Overall coverage | Overall lines / uncovered | New coverage | New lines / uncovered |
|---|---:|---:|---:|---:|
| Project | **28.8%** | 11,070 / 8,719 | **41.3445%** (gate display 41.3%) | 483 / 334 |
| `apps/api` | **9.6%** | 8,182 / 7,623 | **20.8459%** | 286 / 254 |
| `apps/web` | **91.6%** | 1,401 / 105 | 74.7525% | 141 / 45 |
| `apps/web/src` | 93.2% | 1,363 / 67 | **91.5152%** | 104 / 8 |
| `packages` | 52.6% | 1,110 / 614 | 56.5217% | 40 / 19 |
| `packages/db` | 29.9% | 342 / 261 | 70.0% | 18 / 6 |
| `packages/shared` | 9.6% | 170 / 160 | 0.0% | 8 / 8 |
| `packages/crypto` | 86.0% | 112 / 16 | 50.0% | 2 / 1 |
| `packages/vault-action` | 92.0% | 164 / 6 | 91.6667% | 8 / 0 |
| `packages/api-contract-tests` | 0.0% | 137 / 137 | 0.0% | 4 / 4 |
| root `scripts` | 0.0% | 377 / 377 | 0.0% | 16 / 16 |

The gate period is `previous_version`, starting `2026-07-09T12:20:06Z`. Reliability, security,
maintainability, duplication, and hotspot-review conditions are all green; only `new_coverage`
is red (`41.3 < 80`).

Additional denominator evidence:

- `apps/api/src/modules` is 7.1% overall and 5.8252% on 195 new lines;
- `apps/api/src/workers` is 0% despite 35 colocated worker test files;
- `apps/api/src/__tests__/helpers` contributes 14 new uncovered lines;
- `apps/web/scripts` contributes 35 new uncovered lines even though it is test tooling;
- `apps/web/src/lib/test` contributes 3 new uncovered lines;
- root `scripts` contributes 16 new uncovered lines;
- `apps/api/vitest.config.ts` lists only 21 production files while the tree contains roughly 244
  production TypeScript files and 203 test files. Sonar treats production sources omitted from LCOV
  as uncovered.

### Contradictions and stale assumptions resolved

1. The human draft's 32% / 80% language is superseded by the live 41.3% main result and this
   story's required `>=85%` target.
2. Story 10.3 is independent and complete for its metric: web Vitest/V8 complete-source branch
   coverage reached 85.03% (`3057/3595`), while Sonar reports `apps/web` about 91.6% overall line
   coverage and `apps/web/src` 91.5% on new code. This story must not re-instrument web or redo
   Story 10.3.
3. PR #169 is no longer open: live GitHub evidence shows it **merged** on 2026-07-10. Its PR
   Quality Gate was green, but the later main analysis still failed at 41.3%. The implementation
   therefore starts from current `main`, preserves #169's precise `apps/web/e2e/**` coverage
   exclusion, and opens one superseding fix PR containing the remaining classification, LCOV,
   test, and documentation work. A conflicting sonar-properties-only branch is forbidden.
4. A green PR gate is not proof when its PR new-code denominator differs from main's
   `previous_version` leak period. Completion requires an actual fix branch/PR analysis whose
   `new_coverage` measure is shown to be equivalent to the code and leak-period denominator that
   will land on main.
5. Overall project coverage may remain far below 85% even when `new_coverage >=85%`. Record it
   before and after, but do not invent an overall-coverage pass threshold.

---

## Acceptance Criteria

### Group A — Reproducible Baseline and Metric Semantics

**AC-A1 — The pre-change Sonar baseline is recorded from APIs, not screenshots.**

**Given** main's latest completed Sonar analysis,
**when** implementation begins before any coverage/configuration change,
**then** the Dev Agent Record captures timestamp, revision, analysis key, Quality Gate payload,
leak-period mode/date, project overall/new measures, and per-component measures using reproducible
API queries.

**Positive example:** the record reproduces revision `814d044...`, overall 28.8%, new coverage
41.3445% (41.3 display), 483 new lines/334 uncovered, and the component table above.

**Edge/failure example:** a dashboard screenshot, rounded percentage without numerator/denominator,
or a later analysis silently substituted for the planning baseline fails this AC; if the API value
has moved, preserve both the planning snapshot and the new implementation-start snapshot.

**AC-A2 — Baseline provenance and freshness are proven.**

**Given** branch analyses and cached dashboards can point at different revisions,
**when** baseline evidence is accepted,
**then** Sonar analysis revision, `origin/main`, and the GitHub run head SHA match, and the record
identifies whether each payload is main, branch, or PR analysis.

**Positive example:** `project_analyses/search` and `git rev-parse origin/main` identify the same
SHA, with the corresponding main CI run URL.

**Edge/failure example:** measurements from a PR parameter, stale local branch, prior version, or
sibling worktree artifact are not labeled as main and therefore cannot serve as the baseline.

**AC-A3 — `new_coverage` is the primary completion metric and retains headroom.**

**Given** the Sonar project gate rejects values below 80%,
**when** the fix is complete,
**then** the actual landing branch/PR analysis reports `new_coverage >=85.0%` and the unchanged
Quality Gate passes.

**Positive example:** Sonar API reports 87.2% and Quality Gate `OK`.

**Edge/failure example:** 84.99%, a rounded UI value that cannot be reproduced, or a green gate at
80–84.99% fails the story even though the configured project gate itself passes.

**AC-A4 — Overall coverage is recorded without becoming a fabricated gate.**

**Given** denominator correction can change both overall and new-code measures,
**when** before/after evidence is finalized,
**then** project overall coverage and lines-to-cover/uncovered-lines, plus the same per-component
breakdown used at baseline, are recorded before and after with deltas; no overall pass percentage
is invented.

**Positive example:** the final record says overall coverage moved from 28.8% to the measured final
value while separately proving new coverage >=85%.

**Edge/failure example:** claiming overall coverage must reach 85%, or omitting an overall decrease
caused by a newly truthful denominator, fails this AC.

**AC-A5 — Leak-period movement and rebases are explicitly reconciled.**

**Given** `previous_version` started on 2026-07-09 and can move after version/baseline changes or a
rebase,
**when** final analysis runs,
**then** its period mode/date and new-lines denominator are compared with baseline and all changes
are explained before accepting the percentage.

**Positive example:** a rebase adds new coverable lines; the developer reruns analysis and proves
the enlarged final denominator still reaches 85%.

**Edge/failure example:** retaining an older green result after main moves, or treating fewer
new-lines-to-cover as automatically equivalent, fails this AC.

### Group B — Truthful Coverage Scope and LCOV Membership

**AC-B1 — Coverage exclusions classify only non-product/test infrastructure.**

**Given** Sonar should analyze broad source scope but only require coverage for product runtime
code,
**when** `sonar.coverage.exclusions` is updated,
**then** it precisely coverage-excludes `apps/web/e2e/**`, root `scripts/**`, and proven test
helper/bootstrap paths such as `apps/api/src/__tests__/**`, `apps/api/src/**/*-test-helpers.ts`, and
`apps/web/src/lib/test/**` without excluding product modules.

**Positive example:** helper/bootstrap files stop contributing uncovered lines while remaining
available for issue analysis where `sonar.sources`/test classification allows it.

**Edge/failure example:** `apps/api/src/modules/**`, `apps/api/src/workers/**`, a named
low-coverage business file, or an imprecise `**/scripts/**` rule that catches runtime package
scripts is excluded merely to raise the metric.

**AC-B2 — Coverage exclusion is not source exclusion.**

**Given** `sonar.coverage.exclusions` and `sonar.exclusions` have different effects,
**when** configuration is reviewed,
**then** newly classified non-product paths are added only to coverage exclusions unless a
separate, documented reason proves they should not be analyzed for issues at all.

**Positive example:** root operator scripts remain analyzable for bugs/security issues but do not
inflate unit-coverage denominator.

**Edge/failure example:** moving test infrastructure into `sonar.exclusions` solely to hide issues
or confusing `sonar.test.inclusions` with coverage import fails this AC.

**AC-B3 — Product code has a hard must-not-exclude rule.**

**Given** metric pressure can encourage denominator gaming,
**when** the final Sonar configuration and diff are inspected,
**then** no product business logic, routes, workers, auth/session code, audit code, RLS/tenant code,
or runtime package source is newly coverage-excluded to obtain the target.

**Positive example:** `dashboard-stats.ts`, `mfa.ts`, `mfa-enforcement.ts`, and tested workers enter
LCOV or receive behavior tests.

**Edge/failure example:** excluding a product path because expanded LCOV reveals less than 80%
coverage invokes Ask First; it is not an authorized workaround.

**AC-B4 — API LCOV inclusion is expanded to truthful product membership.**

**Given** `apps/api/vitest.config.ts` currently allowlists only 21 early files,
**when** API coverage configuration is changed,
**then** every in-scope API production module already exercised by the API test graph is eligible
for `apps/api/coverage/lcov.info`, including projects dashboard stats, MFA enforcement, and tested
workers; no allowlist is narrowed to only high-coverage hotspots.

**Positive example:** a tested worker and `src/modules/projects/dashboard-stats.ts` both have `SF:`
records in fresh LCOV with real counters.

**Edge/failure example:** selecting only files known to exceed 80%, importing modules without
behavior assertions, or blanket-including helper/test files as product fails this AC.

**AC-B5 — LCOV membership is mechanically reconciled with Sonar paths.**

**Given** LCOV path format or monorepo working directories can prevent coverage attachment,
**when** fresh API coverage is generated,
**then** normalized repository-relative API production paths are reconciled against LCOV `SF:`
records and Sonar component/file keys, with expected tested files explicitly evidenced as present.

**Positive example:** absolute and package-relative `SF:` paths normalize to one
`apps/api/src/...` path that matches Sonar's source component exactly.

**Edge/failure example:** duplicate paths, `src/...` records resolving to the repository root,
backslash/slash drift, source-map aliases, or an expected tested file absent from LCOV must be
investigated; a passing Vitest console summary does not waive this check.

**AC-B6 — Monorepo report ordering and freshness cannot mask omissions.**

**Given** CI imports seven LCOV paths after `pnpm turbo test`,
**when** authoritative local and CI scans run,
**then** old coverage directories are removed first, every configured report exists from that
exact run, report-path order does not cause one package to shadow another, and scanner warnings
about missing/unresolved files are recorded and resolved.

**Positive example:** the CI run generates all configured LCOV files before scan and the scanner
context shows each imported report with no unresolved API source paths.

**Edge/failure example:** stale ignored LCOV, Turbo cache from another revision, a missing report
silently accepted, or overlapping `SF:` entries attached to the wrong package fails this AC.

**AC-B7 — `api-contract-tests` receives an evidence-based classification.**

**Given** `packages/api-contract-tests` is a private black-box conformance suite whose Vitest config
sets statement/branch/function/line thresholds to zero and whose package exposes no runtime export,
**when** its Sonar coverage treatment is decided,
**then** the decision is documented from package manifest, Vitest config, CI invocation, and source
purpose. If it remains wholly test-only, precisely coverage-exclude
`packages/api-contract-tests/**` while retaining issue analysis; if any reusable product/runtime
code is found, exclude only proven fixtures/harness code and keep product code covered.

**Positive example:** its OpenAPI fixtures and harness stop counting as uncovered product lines,
with the rationale recorded in `docs/sonarqube.md`.

**Edge/failure example:** blanket exclusion based only on its name, or retaining a product client
inside the excluded package without separate coverage, fails this AC.

### Group C — Threshold Integrity, TDD, and Behavior-Focused Tests

**AC-C1 — API Vitest keeps all four metrics at or above 80%.**

**Given** the shared base and API override both require 80% lines, branches, functions, and
statements,
**when** truthful API inclusion is enabled and the full API suite runs,
**then** all four metrics remain `>=80%` and neither shared nor API thresholds are lowered.

**Positive example:** fresh API coverage reports each exact numerator/denominator above 80 and the
command exits zero.

**Edge/failure example:** one metric reaches 79.99%, a threshold is removed, or a provider/reporter
change makes the gate inapplicable invokes Ask First and cannot be called complete.

**AC-C2 — Shared coverage defaults remain authoritative.**

**Given** `packages/tsconfig/vitest.base.ts` supplies V8 plus LCOV and four 80% thresholds,
**when** configuration changes are reviewed,
**then** that shared base remains unchanged unless the user explicitly approves otherwise; API
configuration may only specialize truthful source membership.

**Positive example:** `apps/api/vitest.config.ts` expands include/exclude semantics while inheriting
provider/reporters and preserving its explicit 80% floor.

**Edge/failure example:** lowering shared thresholds, removing LCOV reporter, switching provider, or
changing unrelated packages to make API pass fails this AC.

**AC-C3 — Configuration guards follow literal TDD RED→GREEN.**

**Given** `AGENTS.md` requires tests first,
**when** implementation begins,
**then** focused executable guards for Sonar classification/must-not-exclude rules and evaluated API
Vitest coverage membership are written first, fail for the expected current-state reason, and pass
after the smallest configuration change.

**Positive example:** a guard initially fails because `dashboard-stats.ts` is outside evaluated
coverage include, then passes after truthful expansion.

**Edge/failure example:** testing only raw configuration text when merged config semantics can
override it, writing guards after configuration, or manufacturing RED with a broken fixture fails
this AC.

**AC-C4 — Remaining gaps are closed with behavior-focused tests only after classification and LCOV.**

**Given** non-product exclusions and truthful API LCOV have been measured,
**when** equivalent Sonar new coverage is still below 85% and the user authorizes continued work,
**then** tests target observable product behavior on the remaining new-code gaps: success,
validation/boundary, authorization/tenant, typed/unknown failure, audit-failure, and
concurrency/replay branches where those behaviors exist.

**Positive example:** a worker test asserts emitted job/audit outcome and retry behavior rather than
merely importing the worker for execution credit.

**Edge/failure example:** assertion-free imports, full-module mocks that remove real code, skipped
tests, coverage-ignore directives, or deleting/weaking regressions to raise coverage fails this AC.

**AC-C5 — Ask First is mandatory at both decision boundaries.**

**Given** truthful expansion may expose real debt,
**when** (a) any API Vitest metric falls below 80%, or (b) precise exclusions plus truthful LCOV
still leave equivalent Sonar `new_coverage <85%`,
**then** implementation pauses and presents measured numerators/denominators, uncovered files/lines,
and choices to the user before proceeding.

**Positive example:** choices prioritize behavior-focused tests, then a narrowly justified scope
decision; a Sonar baseline/version reset is presented only as an explicit operator/product decision
and cannot substitute for coverage proof without approval.

**Edge/failure example:** narrowing include to already-high hotspots, excluding product paths,
lowering thresholds, moving the leak baseline, or claiming an approved reset proves coverage without
re-analysis fails this AC.

**AC-C6 — Sensitive-path tests preserve existing security contracts.**

**Given** uncovered API sources include auth, credentials, audit, and tenant-aware modules,
**when** tests are added,
**then** they preserve current auth/session lifecycle, org context and RLS assumptions,
fail-closed audit behavior, rate limits, and replay/concurrency semantics; test doubles do not
weaken those contracts.

**Positive example:** a tenant-sensitive service test uses the existing real-DB/`withOrg` harness
and proves denial/isolation without changing production authorization.

**Edge/failure example:** a unit mock is described as RLS proof, audit failure is mocked away, rate
limits are disabled outside existing env-gated test conventions, or a race is tested sequentially
while claimed as concurrency coverage.

### Group D — Sonar Proof, CI Delivery, Documentation, and Scope

**AC-D1 — The fix is proven on the actual landing branch/PR analysis.**

**Given** PR #169's green PR gate did not predict main's red leak-period gate,
**when** the Story 10.4 fix PR runs Sonar,
**then** API queries for that exact PR/branch and commit SHA show `new_coverage >=85%`, and the
analysis is demonstrated to evaluate an equivalent landing denominator rather than merely a tiny
PR diff.

**Positive example:** branch analysis on the fix SHA uses the relevant `previous_version` period,
or a PR analysis plus reproducible line-level reconciliation proves all main leak-period new lines
and the fix delta are represented.

**Edge/failure example:** accepting `project_status?pullRequest=N` as green when
`new_lines_to_cover` omits the existing 483-line leak set, or when `new_coverage` is absent/ignored,
fails this AC.

**AC-D2 — Branch-analysis availability and permissions fail closed.**

**Given** SonarCloud plan/permissions may not expose custom branch analysis or all API payloads,
**when** equivalent branch/PR proof cannot be obtained,
**then** implementation stops and asks for operator action/approval; it does not merge based on
local Vitest math or a non-equivalent green PR gate.

**Positive example:** the user enables/authorizes a suitable analysis and the developer reruns it.

**Edge/failure example:** a 403, missing branch measure, or unsupported analysis type is treated as
“probably green” and bypassed.

**AC-D3 — Required Quality Gate enforcement remains intact.**

**Given** `.github/workflows/ci.yml` runs scan followed by
`SonarCloud Quality Gate`,
**when** the final diff and CI run are reviewed,
**then** both steps remain enabled, ordered after fresh coverage generation, and blocking; the
project's 80% gate is not lowered.

**Positive example:** scan succeeds, Quality Gate action reports `OK`, and the job passes.

**Edge/failure example:** `continue-on-error`, an `if` that skips Sonar, deleted polling action,
lowered gate threshold, or an alternate workflow that does not protect main fails this AC.

**AC-D4 — PR #169's merged delta is preserved and superseded coherently.**

**Given** #169 is merged into current main and already coverage-excludes `apps/web/e2e/**`,
**when** the fix is prepared,
**then** one new PR based on current main keeps that delta and adds all remaining Story 10.4 work;
no isolated or conflicting sonar-properties-only PR is opened.

**Positive example:** the new PR description explains that #169 was necessary but insufficient and
links its merged evidence.

**Edge/failure example:** reverting #169, attempting to push to its merged branch, or landing
coverage configuration separately before truthful API LCOV/tests fails this AC.

**AC-D5 — `docs/sonarqube.md` becomes an operationally complete source of truth.**

**Given** operators need to reproduce the metric and understand exclusions,
**when** documentation is updated,
**then** it explains coverage exclusion versus source exclusion, precise non-product classifications,
LCOV report generation/import, path normalization checks, baseline/final API queries, PR-vs-main
semantics, 80% gate versus 85% story target, and stale-artifact cleanup.

**Positive example:** a cold operator can reproduce project/component before/after measures and
identify why product modules remain covered.

**Edge/failure example:** documentation says “PR gate green means main green,” repeats the stale
32% baseline as current, or omits the must-not-exclude-product rule.

**AC-D6 — Final evidence is complete and auditable.**

**Given** implementation and CI are complete,
**when** the Dev Agent Record is reviewed,
**then** one evidence table records exact before/after project and component metrics, leak period,
analysis IDs/revisions, API Vitest four-metric counts, LCOV membership reconciliation, exclusions
and rationale, test counts, CI/Quality Gate URLs, and unresolved scanner warnings (expected none).

**Positive example:** every percentage is tied to its source payload and exact commit.

**Edge/failure example:** scattered rounded prose, local-only coverage, or missing component deltas
fails this AC.

**AC-D7 — Package broadening is evidence-driven and deferred honestly.**

**Given** `packages/db` and `packages/shared` have narrow coverage includes and misleading overall
coverage, but API skew dominates the current new-code failure,
**when** Story 10.4 measures post-API results,
**then** broadening those package includes is deferred unless their measured new-code gaps
materially block `>=85%`. If overall coverage remains misleading, implementation creates or
identifies an explicit tracked follow-up and records its key/URL before this story is done.

**Positive example:** after equivalent Sonar reaches 87%, db/shared broadening remains out of scope
and a backlog issue/story tracks complete-source package coverage.

**Edge/failure example:** silently broadening unrelated packages without need, or leaving known
misleading overall package coverage as untracked prose, fails this AC.

**AC-D8 — Runtime, schema, and product surfaces remain unchanged.**

**Given** this is internal quality work,
**when** the final diff is reviewed,
**then** expected changes are limited to coverage/configuration guards, behavior-focused tests if
authorized, `sonar-project.properties`, `apps/api/vitest.config.ts`, `docs/sonarqube.md`, and
story/status evidence. No migration, runtime schema, API contract, production behavior, navigation,
audit event, operational metric/log, deployment topology, or dependency change is expected.

**Positive example:** production source is untouched while tests/config/docs establish truthful
coverage.

**Edge/failure example:** changing a branch in product code to reduce the denominator, fixing a
discovered runtime bug without scope reconciliation, or adding a migration fails this AC.

---

## Tasks / Subtasks

- [ ] **Task 1 — Freeze reproducible pre-change evidence (AC-A1, AC-A2, AC-A4, AC-A5)**
  - [ ] Fetch current main and capture matching Git SHA, Sonar analysis key/time, CI run, Quality
        Gate conditions, leak period, project measures, and component tree.
  - [ ] Preserve the planning snapshot above and add a second implementation-start snapshot if
        main/Sonar moved.
  - [ ] Save raw query commands and exact numerators/denominators in the Dev Agent Record.

- [ ] **Task 2 — Write configuration guards first and prove RED (AC-B1–B5, AC-C3)**
  - [ ] Add an executable Sonar-properties guard covering precise coverage-only classifications and
        product-code must-not-exclude invariants; run it and confirm expected current RED.
  - [ ] Add an executable evaluated-Vitest-config/membership guard proving truthful API product
        inclusion and helper exclusion; run it and confirm expected current RED.
  - [ ] Ensure the guards run in the existing required test graph, not as an undocumented manual
        script.

- [ ] **Task 3 — Classify non-product coverage scope precisely (AC-B1–B3, AC-B7)**
  - [ ] Inventory each candidate exclusion and prove test/helper/tooling purpose.
  - [ ] Preserve `apps/web/e2e/**`; add precise root-script, API helper/bootstrap, and web test-support
        coverage exclusions without changing issue-analysis scope.
  - [ ] Classify `packages/api-contract-tests` from its package manifest, Vitest config, source role,
        and CI invocation; apply only the evidence-supported coverage exclusion.
  - [ ] Run focused guards GREEN and review the diff for forbidden product exclusions.

- [ ] **Task 4 — Expand API LCOV truthfully (AC-B4–B6, AC-C1, AC-C2)**
  - [ ] Replace/expand the Story-1.1-era API allowlist with a maintainable product-source contract
        that includes already-tested production modules and workers and excludes tests/helpers.
  - [ ] Delete stale API coverage, run the full API suite, and retain all four 80% thresholds plus V8
        LCOV reporting.
  - [ ] Normalize and reconcile API production inventory, expected tested files, LCOV `SF:` records,
        and Sonar paths; investigate all missing/duplicate/mismatched paths.
  - [ ] Confirm dashboard stats, MFA/MFA enforcement, and representative tested workers appear.

- [ ] **Task 5 — Enforce Ask First boundaries (AC-C1, AC-C5)**
  - [ ] If any truthful API Vitest metric is below 80%, stop with exact counts and ranked gaps.
  - [ ] Measure equivalent Sonar new coverage after exclusions + LCOV; if below 85%, stop with exact
        denominator/gaps and behavior-focused-test options.
  - [ ] Do not narrow product include, exclude product code, lower thresholds, or reset a baseline
        without explicit user approval.

- [ ] **Task 6 — Add only approved behavior-focused tests if needed (AC-C4, AC-C6)**
  - [ ] Select remaining new-code gaps from the current Sonar file/line measure, prioritizing
        security-sensitive and high-yield behavior.
  - [ ] Follow TDD RED→GREEN for any defect/change and characterization adequacy for existing behavior;
        assert success, boundary, denied, failure, audit, and concurrency/replay paths where relevant.
  - [ ] Re-run focused, API, and relevant broader suites; retain real DB/RLS conventions where the
        behavior requires them.

- [ ] **Task 7 — Prove the landing analysis, not merely a PR check (AC-A3, AC-D1–D4)**
  - [ ] Open one fix PR from current main that preserves and supersedes #169's merged partial fix.
  - [ ] Query Sonar by exact PR/branch and SHA; compare leak period and new-line denominator with main.
  - [ ] If branch analysis/permissions cannot prove equivalence, stop for operator action.
  - [ ] Require `new_coverage >=85%`, Quality Gate `OK`, and the enabled blocking CI action.

- [ ] **Task 8 — Document and close evidence (AC-A4, AC-D5–D8)**
  - [ ] Update `docs/sonarqube.md` with scope rationale, LCOV/path checks, API queries, metric semantics,
        stale-artifact handling, and PR-vs-main caveat.
  - [ ] Record complete before/after project/component evidence with analysis IDs, revisions, exact
        counts, CI URLs, and scanner warnings.
  - [ ] Decide db/shared scope from measured blocking impact; identify/create a tracked complete-source
        follow-up if their overall coverage remains misleading.
  - [ ] Confirm no runtime/schema/product/dependency changes and synchronize story/sprint status.

---

## Dev Notes

### Binding implementation order

1. Capture fresh baseline.
2. Write failing configuration guards.
3. Coverage-exclude only proven non-product/test infrastructure.
4. Expand API LCOV to truthful product membership.
5. Measure local thresholds and equivalent Sonar new coverage.
6. Ask First at either decision boundary.
7. Only after approval, add behavior-focused tests for remaining product gaps.
8. Prove `new_coverage >=85%` on the actual landing analysis and update docs/evidence.

Do not reorder this into “write tests until local Vitest is green.” Vitest package thresholds and
Sonar `new_coverage` answer different questions.

### Technical guardrails

- **Do not re-instrument web.** Story 10.3 already established complete web V8 membership and 85.03%
  branch coverage. Sonar's web source is not the primary failing component.
- **Do not confuse branch coverage with Sonar line coverage.** Story 10.3's 85.03% is V8 branches;
  this story's 85% target is Sonar `new_coverage`.
- **Do not use broad wildcard convenience.** Candidate exclusions must be enumerated against current
  paths. In particular, distinguish root `scripts/**` from runtime `apps/api/src/scripts/**` and
  `packages/db/src/scripts/**`.
- **Do not hide product workers.** `apps/api/src/workers/**` is production behavior with many tests;
  it belongs in truthful LCOV.
- **Do not assume LCOV omission means zero test coverage.** First reconcile include rules and paths.
- **Do not assume LCOV presence means Sonar imported it.** Verify `SF:` normalization and scanner/API
  component attachment.
- **Do not accept stale reports.** Coverage output is ignored and worktree-local; remove it before
  authoritative runs.
- **Do not alter Quality Gate enforcement.** `.github/workflows/ci.yml` scan and polling action remain
  blocking and after coverage generation.
- **Do not change Sonar's configured 80% threshold to 85%.** The 85% story target is proven by API
  evidence.

### High-risk-path disposition

| Concern | Story 10.4 treatment |
|---|---|
| Tenant/RLS | No production change. Existing real-DB/RLS harness remains authoritative; any added tenant-sensitive test must use it. |
| Audit failure handling | No production/audit-event change. Added tests must preserve fail-closed behavior and existing transaction boundaries. |
| Auth/session lifecycle | No production change. Coverage tests may characterize current behavior but cannot claim to redesign it. |
| Concurrency/replay | No production change. If a remaining gap is targeted, use genuine overlap/deferred-promise or existing DB-lock patterns; sequential calls are not proof. |
| Rate limits | No production change. Existing environment-gated test conventions remain; no blanket disable. |
| Migrations/runtime schema | N/A; no migration or schema change expected. |
| Operational logging/metrics | No new product logging or metrics. Sonar/CI evidence belongs in the story record and docs, not runtime logs. |
| Deployment hardening | No topology/image change. Required CI remains enabled and passing. |

### Package scope decisions and deferrals

- **Story 10.3:** prerequisite context only; independent and not repeated.
- **PR #169:** merged prerequisite, not an open branch to extend. Story 10.4's single new PR
  supersedes its insufficient e2e-only result without reverting it.
- **`apps/api`:** in scope; root cause and dominant new-code gap.
- **`packages/api-contract-tests`:** classification is in scope; precise coverage exclusion is
  allowed only after proving it is wholly test harness/fixtures.
- **`packages/db` and `packages/shared`:** broad complete-source instrumentation is deferred unless
  measured new-code gaps materially prevent 85%. Misleading residual overall coverage requires an
  explicit tracked follow-up before Story 10.4 is done.
- **Other packages:** no configuration changes unless current measured evidence proves a material
  blocker and the user approves scope expansion.

### Expected file map

Expected implementation changes:

- `sonar-project.properties` — precise coverage-only classification; preserve analysis scope and
  LCOV report paths;
- `apps/api/vitest.config.ts` — truthful, maintainable API product-source membership with all four
  80% thresholds;
- focused configuration guard test(s) in an existing required Vitest test graph;
- existing/new `apps/api/src/**/*.test.ts` only if authorized after measurement;
- `docs/sonarqube.md` — operator procedure and rationale;
- this story and `sprint-status.yaml` — evidence and P3 status.

Not expected: production source, `apps/web/vitest.config.ts`, `packages/tsconfig/vitest.base.ts`,
DB schema/migrations, workflow bypasses, dependency/lockfile, Docker, navigation, or UI files.

### Verification commands

Use the repository's exact versions: Node >=24, pnpm 11.9.0, Vitest 4.1.10, V8 provider. Focused
test paths depend on the guard location selected during implementation.

```bash
# Baseline and final Sonar reads
curl -fsS 'https://sonarcloud.io/api/qualitygates/project_status?projectKey=nestormata_project-vault'
curl -fsS 'https://sonarcloud.io/api/measures/component?component=nestormata_project-vault&metricKeys=coverage,new_coverage,lines_to_cover,uncovered_lines,new_lines_to_cover,new_uncovered_lines'
curl -fsS 'https://sonarcloud.io/api/measures/component_tree?component=nestormata_project-vault&metricKeys=coverage,lines_to_cover,uncovered_lines,new_coverage,new_lines_to_cover,new_uncovered_lines&qualifiers=DIR&ps=500'
curl -fsS 'https://sonarcloud.io/api/project_analyses/search?project=nestormata_project-vault&ps=5'

# Fresh API evidence
rm -rf apps/api/coverage
pnpm --filter @project-vault/api test
rg -n '^SF:.*(dashboard-stats|mfa|mfa-enforcement|workers/)' apps/api/coverage/lcov.info

# Broader verification
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test --force --concurrency=1
make ci

# GitHub/Sonar landing evidence
gh pr checks <fix-pr-number>
gh pr view <fix-pr-number> --json headRefOid,statusCheckRollup,url
```

For PR/branch APIs, add the exact supported `pullRequest=<number>` or `branch=<name>` parameter and
record it. Do not guess endpoint semantics; confirm returned component/revision/period and compare
new-line counts with the landing denominator.

Before Docker or `make ci`, follow `AGENTS.md` port-isolation rules. `make ci` reads this worktree's
`.env`; never reuse another worktree's database or coverage artifacts.

### References

- [Source: `AGENTS.md#Development-Story-Implementation`]
- [Source: `AGENTS.md#Story-Planning-and-Review`]
- [Source: `AGENTS.md#Product-Surface-Contract`]
- [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]
- [Source: `_bmad-output/implementation-artifacts/10-3-apps-web-complete-source-branch-coverage-buffer.md`]
- [Source: `_bmad-output/implementation-artifacts/sprint-status.yaml#Epic-10`]
- [Source: `_bmad-output/planning-artifacts/epics.md#Definition-of-Done`]
- [Source: `_bmad-output/planning-artifacts/epics.md#Story-1.1`]
- [Source: `_bmad-output/planning-artifacts/architecture.md#Testing-Framework`]
- [Source: `_bmad-output/planning-artifacts/architecture.md#CI-CD`]
- [Source: `_bmad-output/planning-artifacts/prd.md#Measurable-Outcomes`]
- [Source: `sonar-project.properties`]
- [Source: `docs/sonarqube.md`]
- [Source: `.github/workflows/ci.yml#Quality-Gates`]
- [Source: `apps/api/vitest.config.ts`]
- [Source: `apps/web/vitest.config.ts`]
- [Source: `packages/tsconfig/vitest.base.ts`]
- [Source: `packages/db/vitest.config.ts`]
- [Source: `packages/shared/vitest.config.ts`]
- [Source: `packages/api-contract-tests/vitest.config.ts`]
- [Source: `turbo.json`]
- [Source: SonarCloud API, project `nestormata_project-vault`, main analysis
  `3abdeded-d2c4-491b-97de-b58a6d17bf4e`, queried 2026-07-10]
- [Source: GitHub PR #169, merged 2026-07-10]
- [Source: GitHub Actions run `29128252327`, main revision `814d0444...`]
- [Planning input: human draft `spec-wip.md`, read-only and intentionally not copied or modified]

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List

## Change Log

- 2026-07-10: Story created from current main, live Sonar/GitHub evidence, Story 10.3, and the
  read-only human draft. Reconciled stale 32%/80% wording to the live 41.3% baseline and required
  85% new-coverage buffer; recorded that PR #169 is already merged but insufficient.
