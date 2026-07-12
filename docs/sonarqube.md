# SonarCloud analysis

This project uses **CI-based analysis**. The `SonarCloud Scan` step in `.github/workflows/ci.yml`
runs after tests so the scanner can consume generated LCOV reports, and the following quality-gate
step fails CI when the project gate fails. `sonar-project.properties` is the single source of truth
for scanner scope and coverage inputs.

Automatic Analysis must remain disabled in SonarCloud under **Administration → Analysis Method**.
SonarCloud cannot run Automatic and CI-based analysis on the same project. The committed
`sonar-project.properties` also makes this repository ineligible for Automatic Analysis; the
obsolete `.sonarcloud.properties` Autoscan configuration was removed when CI analysis became
authoritative.

## Analysis scope

`sonar-project.properties` analyzes source under `apps/`, `packages/`, and `scripts/`. It excludes
dependencies, generated/build output, coverage, temporary reports, DB migration snapshots, the
generated OpenAPI document, the bundled vault action, and the shared ESLint configuration.
Tests under `apps/` and `packages/` are classified separately, and LCOV reports from all tested
workspaces are imported. CI runs dependency installation and typechecking before the scan, so
SvelteKit's generated TSConfig is available to the analyzer.

## Coverage exclusion vs. source exclusion (Story 10.4)

Sonar has two independent mechanisms and they are not interchangeable:

- **`sonar.exclusions`** removes a path from analysis entirely — no issues, no duplication, no
  coverage. Use it only for generated/vendored artifacts (build output, dependency lockfiles,
  the bundled vault action, applied migration SQL) that should never be linted or scored.
- **`sonar.coverage.exclusions`** keeps a path fully analyzed for bugs, vulnerabilities, code
  smells, and duplication, but removes it from the coverage denominator (`lines_to_cover` /
  `uncovered_lines` and their `new_*` equivalents). Use it for test infrastructure, tooling, and
  black-box harnesses that are not product runtime code — excluding them for issue analysis too
  would just hide real bugs in that code.

`sonar.coverage.exclusions` in this repo, and why each entry qualifies:

| Path | Rationale |
|---|---|
| `apps/web/e2e/**` | Playwright E2E specs (PR #169); not unit-covered product code. |
| `scripts/**` (root only) | Root-level operator/CI tooling (`check-*.ts`, `docker-*.sh`, etc.), not shipped product behavior. Precisely root-relative — it does **not** match `apps/api/src/scripts/**` or `packages/db/src/scripts/**`, which are runtime package scripts and remain covered. |
| `apps/api/src/__tests__/**` | API test suite plus its `helpers/` — assertions and fixtures, not product code. |
| `apps/api/src/**/*-test-helpers.ts` | Colocated per-module test fixture files (e.g. `credential-route-test-helpers.ts`). |
| `apps/api/src/**/*-test-bootstrap.ts` | Colocated per-module integration-test bootstrap files (e.g. `machine-user-route-test-bootstrap.ts`, `project-route-test-bootstrap.ts`). |
| `apps/web/src/lib/test/**` | Web test utilities (Story 10.3 precedent). |
| `packages/api-contract-tests/**` | A private black-box OpenAPI conformance suite: its own `vitest.config.ts` sets all four coverage thresholds to `0` with the comment "not designed... its own business logic"; its `package.json` exposes no runtime export and only consumes `@project-vault/api` as a test dependency, never the reverse. Its fixtures/harness (`src/fixtures/**`, `src/openapi/**`) are conformance tooling, not reusable product code. |

**Must-not-exclude rule:** no product runtime path (`apps/api/src/modules/**`,
`apps/api/src/workers/**`, `apps/api/src/routes/**`, `apps/api/src/plugins/**`,
`apps/api/src/lib/**`, `apps/api/src/scripts/**`, or any single named business file) may be added
to `sonar.coverage.exclusions` to raise the metric. `apps/api/src/__tests__/sonar-properties.test.ts`
enforces this both ways — the required inclusions and the forbidden product patterns — against the
live properties file on every test run.

## API LCOV membership (Story 10.4)

`apps/api/vitest.config.ts` previously allowlisted only 21 files from Story 1.1 (`coverage.include`
was a hand-maintained array). That undercounted LCOV membership: Sonar's `apps/api` component
counted ~244 production TypeScript files as coverable but only had `SF:` records for 21 of them, so
~223 genuinely-tested files (routes, `modules/**`, `workers/**`) were reported as 100% uncovered
purely because they were missing from LCOV, not because they lacked tests.

The fix replaces the array with the canonical eligible-source pattern `src/**/*.ts`, mirroring
`apps/web`'s Story 10.3 precedent, with an explicit exclude list for test/helper/bootstrap files:

```ts
coverage: {
  include: ['src/**/*.ts'],
  exclude: [
    ...coverageConfigDefaults.exclude,
    'src/**/*.test.ts',
    'src/**/*.d.ts',
    'src/__tests__/**',
    'src/**/*-test-helpers.ts',
    'src/**/*-test-bootstrap.ts',
  ],
  thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
}
```

`apps/api/src/__tests__/vitest-config.test.ts` evaluates the **merged config module** (not the raw
file text) to guard against a future edit silently narrowing membership back to only high-coverage
hotspots, and to prove specific previously-omitted product files (`dashboard-stats.ts`, `mfa.ts`,
`mfa-enforcement.ts`, tested workers) are eligible.

### Reproducing fresh API LCOV and checking path normalization

```bash
rm -rf apps/api/coverage
pnpm --filter @project-vault/api test
rg -n '^SF:.*(dashboard-stats|mfa|mfa-enforcement|workers/)' apps/api/coverage/lcov.info
```

`SF:` records must normalize to a single `apps/api/src/...` repository-relative path (no absolute
paths, no `src/...`-only paths that would resolve to the repo root, no backslash separators). If an
expected tested file is absent from `SF:` records, check `coverage.include`/`exclude` first before
assuming it lacks tests — Vitest's V8 provider only reports files matched by `include`.

## `new_coverage` vs. the project gate (Story 10.4)

The configured SonarCloud **project Quality Gate threshold stays `new_coverage >= 80%`** — this
story does not change it. Story 10.4's own completion bar is the stricter, self-imposed
**`new_coverage >= 85%`**, tracked as delivery headroom above the gate, not a gate change. A PR
whose own diff is green does **not** prove main will pass: PR analysis and main's
`previous_version` leak-period analysis can evaluate different denominators (see PR #169, which
was PR-green but insufficient once main's post-merge `new_coverage` was measured at 41.3%).
Treat only an equivalent branch/PR analysis — reconciled against the leak-period new-line count
that will land on main — as proof.

## Stale-artifact hygiene

Coverage output directories (`apps/*/coverage/`, `packages/*/coverage/`) are git-ignored and
worktree-local. Always `rm -rf` a package's `coverage/` directory before an authoritative local or
CI run; a stale directory from a prior revision or a different worktree can silently satisfy the
LCOV report-path check without reflecting the current code.

## Reading results from SonarCloud

The dashboard is the source of truth: <https://sonarcloud.io/project/issues?id=nestormata_project-vault>.

To read results from the CLI/scripts (e.g. to triage issues without leaving the terminal), use the
[SonarCloud Web API](https://sonarcloud.io/web_api) with a token — no scan involved, purely reads
results from the most recent CI analysis:

```bash
make sonar-issues                    # OPEN + CONFIRMED issues (default)
./scripts/sonar-issues.sh RESOLVED   # any issueStatuses value the API accepts
```

This reads `SONAR_TOKEN` / `SONAR_PROJECT_KEY` / `SONAR_HOST_URL` from `.env` (git-ignored):

1. `SONAR_TOKEN` — SonarCloud → **My Account → Security → Generate Token**.
2. `SONAR_PROJECT_KEY` — the project key shown on the project's SonarCloud dashboard
   (`nestormata_project-vault`).
3. `SONAR_HOST_URL` already defaults to `https://sonarcloud.io` in `.env.example`.

Useful endpoints beyond `api/issues/search` (all under `https://sonarcloud.io/api/...`, all need
`-u "$SONAR_TOKEN:"`):

- `qualitygates/project_status?projectKey=<key>` — pass/fail quality gate status.
- `hotspots/search?projectKey=<key>&status=TO_REVIEW` — security hotspots awaiting review.
- `measures/component?component=<key>&metricKeys=bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density`
  — headline metrics.
- `ce/component?component=<key>` then
  `ce/task?id=<analysisId>&additionalFields=scannerContext,warnings` — background analysis status,
  scanner context, and warnings.

Full API reference and an interactive explorer: <https://sonarcloud.io/web_api>.
