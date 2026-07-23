# Project Vault Action

Retrieve secrets from [Project Vault](https://github.com/project-vault) and export them as
masked environment variables in a GitHub Actions workflow.

This action is a thin wrapper around [`@project-vault/agent`](../agent) (Story 7.2's
machine-user authentication and programmatic secret-retrieval package) — it does not implement
its own HTTP client, token exchange, or retry logic.

> **Consuming this action?** Use `nestormata/vault-action`, not this monorepo path. GitHub
> Marketplace requires `action.yml` at a repository root, which this monorepo subdirectory can't
> satisfy, so [`nestormata/vault-action`](https://github.com/nestormata/vault-action) is a
> release-only mirror that `vault-action-release.yml` publishes to on every tag (issue #112). This
> directory remains the actual source of truth for development.

## 1. Setup — create a machine user and API key

Before using this action, create a **machine user** scoped to a single project and issue it an
API key (Story 7.1):

1. In Project Vault, open the target project and create a machine user
   (`POST /api/v1/projects/:projectId/machine-users`), or use the web UI equivalent.
2. Issue an API key for that machine user (`POST /api/v1/machine-users/:machineUserId/api-keys`).
   The response's `key` field (format `pk_...`) is shown **once** — copy it immediately.
3. Store the key as an encrypted secret in your GitHub repository or organization
   (**Settings → Secrets and variables → Actions → New repository secret**), e.g. named
   `VAULT_API_KEY`. Never commit the raw key to your repository.

A machine user's API key is scoped to **exactly one project** — see the "one project per step"
constraint below (D2).

## 2. Usage

```yaml
- uses: nestormata/vault-action@v1
  with:
    vault-url: <your Project Vault base URL>
    api-key: ${{ secrets.VAULT_API_KEY }}
    secrets: <PROJECT_ID>/<CREDENTIAL_NAME> as <ENV_VAR_NAME>
```

See section 9 below for a complete, runnable example with real values filled in.

| Input | Required | Default | Description |
|---|---|---|---|
| `vault-url` | yes | — | Base URL of your Project Vault instance. |
| `api-key` | yes | — | Machine user API key (`pk_...`) issued via Project Vault. |
| `secrets` | yes | — | One mapping per line: `PROJECT_ID/CREDENTIAL_NAME as ENV_VAR_NAME`. |
| `continue-on-error` | no | `'false'` | If `'true'`, warn (not fail) when the vault is unreachable. See the naming-collision note below — this is **not** the same thing as GitHub's own step-level `continue-on-error:` key. |

## 3. Secret-mapping syntax

Each line of the `secrets` input has the shape:

```
PROJECT_ID/CREDENTIAL_NAME as ENV_VAR_NAME
```

- `PROJECT_ID` is the target project's UUID (not its display name).
- `CREDENTIAL_NAME` is the credential's name in that project (may itself contain `/`).
- `ENV_VAR_NAME` is the environment variable this step exports the value as. It must be a safe
  identifier (`^[A-Za-z_][A-Za-z0-9_]*$`) and must not be a reserved/dangerous name such as
  `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_OPTIONS`, `HOME`, `SHELL`, `GITHUB_TOKEN`, or any
  name starting with `GITHUB_`/`ACTIONS_` — these are rejected before any network call, to prevent
  a careless or compromised mapping from hijacking a later step's execution environment.
- `ENV_VAR_NAME` targets must be unique within one `secrets` input (case-insensitively — `DB_URL`
  and `db_url` are treated as the same target, since environment variable names are
  case-insensitive on Windows runners even though this action itself runs on Linux/macOS runners
  too).

### One project per step (D2)

**Every line in one `secrets` input must reference the same `PROJECT_ID`.** This is a real
constraint inherited from Story 7.1's machine-user model: one API key is always scoped to exactly
one project, so one `vault-action` step can only ever retrieve secrets from one project. If you
need secrets from two projects, use two steps, each with that project's own `api-key`:

```yaml
- uses: nestormata/vault-action@v1
  with:
    vault-url: https://vault.example.com
    api-key: ${{ secrets.PROJECT_A_VAULT_API_KEY }}
    secrets: a1c2d3e4-0000-0000-0000-000000000000/DATABASE_URL as DB_URL

- uses: nestormata/vault-action@v1
  with:
    vault-url: https://vault.example.com
    api-key: ${{ secrets.PROJECT_B_VAULT_API_KEY }}
    secrets: b5f6a7c8-0000-0000-0000-000000000000/API_TOKEN as API_TOKEN
```

### Multiple secrets from one project

Use a YAML block scalar (`|`) to list multiple mappings, one per line:

```yaml
- uses: nestormata/vault-action@v1
  with:
    vault-url: https://vault.example.com
    api-key: ${{ secrets.VAULT_API_KEY }}
    secrets: |
      a1c2d3e4-0000-0000-0000-000000000000/DATABASE_URL as DB_URL
      a1c2d3e4-0000-0000-0000-000000000000/STRIPE_SECRET_KEY as STRIPE_KEY
      a1c2d3e4-0000-0000-0000-000000000000/REDIS_URL as REDIS_URL
```

Every entry is attempted independently, in input order, regardless of whether an earlier entry
failed — a single run's log shows every problem in one pass, instead of one-error-per-run
whack-a-mole.

## 4. `continue-on-error`

`continue-on-error` (default `'false'`) governs exactly one failure class: the vault being
completely unreachable (connection refused, timeout, or DNS failure) with no usable offline-cache
entry for that credential. It does **not** soften an application-level error the vault
successfully responded with — an invalid/revoked API key, a not-found credential, an ambiguous
name, or an insufficient-scope error always fails the step regardless of this input. These are
workflow-configuration mistakes, not transient vault unavailability, and silently warning past
them could mask a broken pipeline (e.g., a typo'd credential name producing an empty, unmasked
environment variable).

**Naming-collision warning:** GitHub Actions workflows have their **own**, unrelated,
step-level `continue-on-error:` YAML key. Setting the workflow-native key to `true` makes GitHub
skip marking the *job* as failed even if this action's step fails — regardless of what this
action's own `continue-on-error` **input** says. The two mechanisms are independent:

```yaml
# This action's own input — softens only "vault unreachable" failures.
- uses: nestormata/vault-action@v1
  with:
    vault-url: ${{ vars.VAULT_URL }}
    api-key: ${{ secrets.VAULT_API_KEY }}
    secrets: f00dcafe-2222-2222-2222-222222222222/CACHE_URL as CACHE_URL
    continue-on-error: 'true'

# GitHub's own, unrelated step-level key — lets the JOB continue even if this step hard-fails.
- uses: nestormata/vault-action@v1
  continue-on-error: true
  with:
    vault-url: ${{ vars.VAULT_URL }}
    api-key: ${{ secrets.VAULT_API_KEY }}
    secrets: f00dcafe-2222-2222-2222-222222222222/CACHE_URL as CACHE_URL
```

When a vault-unreachable failure is warned rather than failed, the corresponding environment
variable is simply **not set** for that entry — a later step referencing it sees an unset/empty
value, so provide your own fallback if your script needs one.

## 5. Network timeout

Each credential retrieval (including the underlying token exchange) is bounded by a fixed,
non-configurable **10-second** timeout. If the vault does not respond within 10 seconds (e.g. a
hung DNS resolution or TCP handshake, as opposed to an immediate connection refusal), the attempt
is treated exactly like a connection refusal — this bounds how long a single unreachable vault can
stall your job, instead of waiting for your workflow's full `timeout-minutes`.

## 6. Matrix / parallel-job builds

If you use a GitHub Actions matrix with many parallel jobs, each invoking `vault-action` with the
**same** shared machine-user API key, you will produce a burst of concurrent token-exchange calls
against that one key. Project Vault enforces a per-key rate limit on failed authentication
attempts (10 failed attempts per 60-second window, keyed by the API key's hash) as well as an
IP-based limit — legitimate concurrent successes are not throttled, but a wide matrix combined
with any transient failures could approach these limits. Consider keeping matrix fan-out modest,
or staggering job starts, if you use a very large matrix against a single `api-key`.

## 7. Security — SHA-pinning vs. `@v1`

This action publishes a mutable `v1` tag that automatically receives non-breaking patch/minor
updates (the same convention `actions/checkout@v4` uses). For security-conscious consumers who
want to avoid trusting a mutable tag, pin to a full commit SHA instead:

```yaml
- uses: nestormata/vault-action@<full-commit-sha>
```

This trades convenience (no automatic patch/minor updates) for supply-chain integrity — the exact
code that ran is the exact code you reviewed.

## 8. GitLab CI (v1 workaround — native integration is v2)

A native GitLab CI component is **not yet available** (tracked as a v2 enhancement). Until then,
call Story 7.2's machine-token endpoints directly with `curl`:

```yaml
retrieve-secret:
  stage: build
  before_script:
    - |
      TOKEN=$(curl -sf -X POST "$VAULT_URL/api/v1/auth/machine-token" \
        -H "Authorization: Bearer $VAULT_API_KEY" | jq -r '.data.accessToken')
      DATABASE_URL=$(curl -sf "$VAULT_URL/api/v1/machine/projects/$PROJECT_ID/credentials/DATABASE_URL/value" \
        -H "Authorization: Bearer $TOKEN" | jq -r '.data.value')
      echo "DATABASE_URL=$DATABASE_URL" >> "$GITLAB_ENV"
      # IMPORTANT: mark VAR as masked in GitLab CI/CD variable settings, or configure this job's
      # output masking — this snippet does not mask the value for you.
```

## 9. Complete example workflow

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Retrieve deploy secrets from Project Vault
        uses: nestormata/vault-action@v1
        with:
          vault-url: ${{ vars.VAULT_URL }}
          api-key: ${{ secrets.VAULT_API_KEY }}
          secrets: |
            9f8e7d6c-3333-3333-3333-333333333333/PROD_DB_CONNECTION as DB_URL
            9f8e7d6c-3333-3333-3333-333333333333/DEPLOY_TOKEN as DEPLOY_TOKEN
      - run: ./scripts/deploy.sh
```

## Errors

| Condition | Behavior |
|---|---|
| Vault unreachable | Fails the step (`continue-on-error: 'false'`, default) or warns (`'true'`). |
| Invalid/revoked/expired `api-key` | Always fails the step. |
| Credential not found | Always fails the step. |
| Ambiguous credential name (duplicate name in project) | Always fails the step — rename one of the duplicates in Project Vault. |
| Insufficient role / wrong project | Always fails the step. |
| `PROJECT_ID` is not a UUID (e.g. a display name) | Always fails the step — use the project's UUID. |

## Runtime

This action runs on `node24` (GitHub's currently-supported JavaScript Actions runtime as of this
action's release — GitHub is migrating all Actions to Node 24 by default; see
[the GitHub changelog](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)).

## Roadmap

- **OIDC/keyless authentication (v2 candidate):** `architecture.md`'s aspirational
  `modules/integrations/github-actions/` design describes exchanging a workflow's native GitHub
  OIDC identity token directly for a vault machine token, with no static API key stored in the
  workflow at all. This is not implemented in v1 — see this story's Dev Notes (D5) for the full
  rationale.
- **Native GitLab CI component (v2):** see the GitLab CI section above for the v1 workaround.

## License

This package is distributed as part of the [Project Vault](../../) monorepo and is covered by the
repository's root [`LICENSE`](../../LICENSE) (GNU AGPLv3).
