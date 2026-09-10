# Project Vault Action

Retrieve secrets from [Project Vault](https://github.com/nestormata/project-vault) and export them
as masked environment variables in a GitHub Actions workflow.

This action is a thin wrapper around
[`@project-vault/agent`](https://github.com/nestormata/project-vault/tree/main/packages/agent), the
machine-user authentication and secret-retrieval library bundled into this action's `dist/` — it
does not implement its own HTTP client, token exchange, or retry logic. That package is **bundled,
not published**: it is not on npm, and the only supported way to consume it is through this action.

> **Consuming this action?** Use `nestormata/vault-action`, not this monorepo path. GitHub
> Marketplace requires `action.yml` at a repository root, which this monorepo subdirectory can't
> satisfy, so [`nestormata/vault-action`](https://github.com/nestormata/vault-action) is a
> release-only mirror that the release workflow publishes to on every tag. This
> directory remains the actual source of truth for development.

### Tag mapping between this repo and the mirror

The two repositories use different tag names for the same release. Releases are cut here, and the
release workflow rewrites the tag when it mirrors:

| This monorepo | `nestormata/vault-action` (what you reference) |
|---|---|
| `vault-action-v1.2.3` | `v1.2.3` |
| `vault-action-v1` (moving major tag) | `v1` (moving major tag) |

So `nestormata/vault-action@v1` and `@v1.2.3` are the names to use in a workflow;
`vault-action-v1.2.3` is only ever a tag inside this monorepo and will not resolve as an action
reference.

## 1. Setup — create a machine user and API key

Before using this action, create a **machine user** scoped to a single project and issue it an
API key. The web UI has an equivalent for each step; the full HTTP API — request/response shapes,
required roles, expiry and rotation — is documented in
[`docs/machine-users.md`](https://github.com/nestormata/project-vault/blob/main/docs/machine-users.md#part-2--managing-machine-users-and-keys-admin-session).

1. In Project Vault, open the target project and create a machine user.
2. Issue an API key for that machine user. The response's `key` field (format `pk_...`) is shown
   **once** — copy it immediately.
3. Store the key as an encrypted secret in your GitHub repository or organization
   (**Settings → Secrets and variables → Actions → New repository secret**), e.g. named
   `VAULT_API_KEY`. Never commit the raw key to your repository.

A machine user's API key is scoped to **exactly one project** — see the "one project per step"
constraint below.

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

### Multi-field credentials are not supported

Project Vault credentials can hold multiple named fields. This action cannot retrieve them: the
underlying agent's `getSecret()` returns a single string and has no field selector, so a mapping
pointing at a multi-field credential fails the entry with
`VaultMultiFieldSecretUnsupportedError`. Either split the credential into single-value
credentials, or fetch it with `curl` and the `?field=` query parameter as shown in
[`docs/machine-users.md`](https://github.com/nestormata/project-vault/blob/main/docs/machine-users.md).

### One project per step

**Every line in one `secrets` input must reference the same `PROJECT_ID`.** This is a real
constraint inherited from the machine-user model: one API key is always scoped to exactly one
project, so one `vault-action` step can only ever retrieve secrets from one project. If you need
secrets from two projects, use two steps, each with that project's own `api-key`:

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

## 6. Cache on the runner

This action writes an **offline cache to the runner's filesystem**. Know where it lands before you
add persistent or self-hosted runners:

- **Location:** `~/.project-vault/cache.json` by default, created with mode `0600`. Override the
  path by setting `VAULT_CACHE_PATH` in the step's environment.
- **Encrypted at rest:** each value is sealed with AES-256-GCM under a key derived (HKDF) from the
  API key itself. The file is useless without that key, and a cache written under an old key
  cannot be read after a key rotation — clear the file when you rotate, or every read fails with
  `cache_decryption_failed`.
- **Entries expire after 24 hours**, tracked per entry inside the file. An entry past its TTL is
  refused rather than served stale.
- **Credentials the server marks `cacheable: false` are never written**, and an existing cached
  copy of a credential that later becomes non-cacheable is actively deleted.
- **`fallbackThreshold` is `1` for this action.** That means the *first* network-level failure
  flips the run into cache-fallback mode — there is no retry budget before the cache is consulted.
  Once in fallback, a missing or expired entry fails the step (or warns, under
  `continue-on-error: 'true'`).

On GitHub-hosted runners the cache is discarded with the ephemeral VM, so it only helps within a
single job. On a **self-hosted or persistent runner it survives between jobs**: an encrypted file
containing your project's secrets stays on that machine until the TTL lapses or you delete it.
Treat the runner accordingly, or point `VAULT_CACHE_PATH` at a path you clean up yourself.

## 7. Matrix / parallel-job builds

If you use a GitHub Actions matrix with many parallel jobs, each invoking `vault-action` with the
**same** shared machine-user API key, you will produce a burst of concurrent token-exchange calls
against that one key. Project Vault enforces a per-key rate limit on failed authentication
attempts (10 failed attempts per 60-second window, keyed by the API key's hash) as well as an
IP-based limit — legitimate concurrent successes are not throttled, but a wide matrix combined
with any transient failures could approach these limits. Consider keeping matrix fan-out modest,
or staggering job starts, if you use a very large matrix against a single `api-key`.

## 8. Security — SHA-pinning vs. `@v1`

This action publishes a mutable `v1` tag that automatically receives non-breaking patch/minor
updates (the same convention `actions/checkout@v4` uses). For security-conscious consumers who
want to avoid trusting a mutable tag, pin to a full commit SHA instead:

```yaml
- uses: nestormata/vault-action@<full-commit-sha>
```

**The SHA must be a commit in the mirror repository `nestormata/vault-action`, not in this
monorepo.** GitHub resolves `owner/repo@ref` against `owner/repo` only, so a
`nestormata/project-vault` SHA will not resolve here — take the SHA from the mirror's commit
history or from the mirror release that the tag points at.

This trades convenience (no automatic patch/minor updates) for supply-chain integrity — the exact
code that ran is the exact code you reviewed.

## 9. GitLab CI (v1 workaround — native integration is v2)

A native GitLab CI component is **not yet available** (tracked as a v2 enhancement). Until then,
call the machine-token endpoints directly with `curl`.

Define `VAULT_URL`, `PROJECT_ID`, and `VAULT_API_KEY` as CI/CD variables under
**Settings → CI/CD → Variables**, and mark `VAULT_API_KEY` as both **Masked** and **Protected** so
it is redacted from job logs and only exposed to protected branches and tags.

GitLab has no `$GITHUB_ENV` equivalent. To hand a value to *later jobs*, write a dotenv file and
publish it with `artifacts: reports: dotenv`; within a single job an ordinary `export` is enough.

```yaml
retrieve-secret:
  stage: build
  image: alpine:3.20
  before_script:
    - apk add --no-cache curl jq
  script:
    - |
      set -euo pipefail
      TOKEN=$(curl -sf -X POST "$VAULT_URL/api/v1/auth/machine-token" \
        -H "Authorization: Bearer $VAULT_API_KEY" | jq -r '.data.accessToken')
      DATABASE_URL=$(curl -sf "$VAULT_URL/api/v1/machine/projects/$PROJECT_ID/credentials/DATABASE_URL/value" \
        -H "Authorization: Bearer $TOKEN" | jq -r '.data.value')
      printf 'DATABASE_URL=%s\n' "$DATABASE_URL" > build.env
  artifacts:
    reports:
      dotenv: build.env
```

`set -euo pipefail` is load-bearing: without it a failed `curl -f` inside `$(...)` does not stop
the script, and `TOKEN` silently ends up empty instead of the job failing loudly.

A value passed through `artifacts: reports: dotenv` becomes an ordinary environment variable in
downstream jobs and is **not** automatically masked in their logs — GitLab only masks values it
knows about from the Variables settings. Do not echo it, and prefer consuming the secret inside
this same job where possible.

## 10. Complete example workflow

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
| Multi-field credential | Always fails that entry — see "Multi-field credentials are not supported". |
| Cached value cannot be decrypted (key rotated) | Always fails the step — clear the cache file. |

## Runtime

This action runs on `node24` (GitHub's currently-supported JavaScript Actions runtime as of this
action's release — GitHub is migrating all Actions to Node 24 by default; see
[the GitHub changelog](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)).

## Roadmap

- **OIDC/keyless authentication (v2 candidate):** exchanging a workflow's native GitHub OIDC
  identity token directly for a vault machine token, with no static API key stored in the workflow
  at all. Not implemented in v1.
- **Native GitLab CI component (v2):** see the GitLab CI section above for the v1 workaround.

## License

This package is distributed as part of the
[Project Vault](https://github.com/nestormata/project-vault) monorepo and is covered by the
repository's root
[`LICENSE`](https://github.com/nestormata/project-vault/blob/main/LICENSE) (GNU AGPLv3).
