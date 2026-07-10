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
