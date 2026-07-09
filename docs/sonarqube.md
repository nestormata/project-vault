# SonarCloud analysis

This project uses SonarCloud's **Automatic Analysis** (Autoscan) — the GitHub App integration
analyzes every push and pull request on its own; there is no scanner to run in CI or locally.
**Do not** add a `sonarsource/sonarqube-scan-action` (or any `sonar-scanner` CI step): SonarCloud
does not allow Automatic Analysis and CI-based analysis on the same project at once — running a
scanner while Automatic Analysis is enabled fails with `ERROR: You are running CI analysis while
Automatic Analysis is enabled.` If this project ever needs CI-based analysis instead (bigger repo,
slower Autoscan timeouts, need for `sonar.python.version`-style properties that Autoscan doesn't
support — see below), switch it off first: SonarCloud → this project → **Administration → Analysis
Method**, then wire a scan step into `ci.yml` after `pnpm install`.

## Configuring what Autoscan analyzes

Autoscan does **not** read `sonar-project.properties`. It only reads a project-root
`.sonarcloud.properties` file, and only supports a small subset of properties (`sonar.sources`,
`sonar.exclusions`, `sonar.inclusions`, `sonar.tests`, `sonar.test.exclusions`,
`sonar.test.inclusions`, `sonar.sourceEncoding`, `sonar.cpd.exclusions` — no
`sonar.python.version`, no coverage/LCOV wiring, no `sonar.typescript.tsconfigPaths`). Without it,
Autoscan defaults to `sonar.sources=.` — the entire repo, including vendored tooling that was
never meant to be analyzed as this project's own code.

`.sonarcloud.properties` (committed, non-secret) scopes analysis to `apps/`, `packages/`, and
`scripts/` — this project's actual source — and excludes build output (`dist`, `build`,
`.svelte-kit`), `coverage`, `.turbo`, `.stryker-tmp`, `reports`, DB migrations, the generated
`packages/shared/openapi.json`, and `packages/vault-action/dist/`, plus `packages/eslint-config/`
(a shared ESLint config with zero `.ts` source files — see the inline comment in that file for why
it's excluded rather than just ignored).

### Known residual warning: `apps/web/tsconfig.json`

Autoscan clones the repo to a throwaway directory and analyzes it as-is — it never runs
`pnpm install` or `svelte-kit sync`. `apps/web/tsconfig.json` extends `./.svelte-kit/tsconfig.json`,
a file SvelteKit generates at build/dev time and that is (correctly) git-ignored. Because that file
never exists in Autoscan's checkout, SonarCloud's dashboard shows a "Failed to parse TSConfig
file .../apps/web/tsconfig.json" warning on every analysis. There's no `.sonarcloud.properties`
setting that fixes this without excluding `apps/web` from analysis entirely (not worth the loss of
coverage for the primary web app) — this is an accepted, understood trade-off of using Automatic
Analysis with a SvelteKit app in a pnpm workspace. Switching to CI-based analysis (running after
`pnpm turbo typecheck`, which does `svelte-kit sync`) is the only way to eliminate it; revisit if
that becomes worth the CI-integration tradeoffs described above.

## Reading results from SonarCloud

The dashboard is the source of truth: <https://sonarcloud.io/project/issues?id=nestormata_project-vault>.

To read results from the CLI/scripts (e.g. to triage issues without leaving the terminal), use the
[SonarCloud Web API](https://sonarcloud.io/web_api) with a token — no scan involved, purely reads
results Autoscan already computed:

```bash
make sonar-issues                    # OPEN + CONFIRMED issues (default)
./scripts/sonar-issues.sh RESOLVED   # any issueStatuses value the API accepts
```

This reads `SONAR_TOKEN` / `SONAR_PROJECT_KEY` / `SONAR_HOST_URL` from `.env` (git-ignored) — same
one-time setup as before:

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
- `ce/component?component=<key>` then `ce/task?id=<analysisId>&additionalFields=scannerContext,warnings`
  — background analysis task status, scanner context, and any analysis warnings (this is how the
  `apps/web/tsconfig.json` warning above was root-caused: the scanner context showed
  `sonar.autoscan.enabled=true`, `sonar.projectBaseDir=/tmp/clone...`, `sonar.sources=.`, proving
  Autoscan runs from a bare clone with no install step and ignores `sonar-project.properties`).

Full API reference and an interactive explorer: <https://sonarcloud.io/web_api>.
