# `@project-vault/cli`

Terminal CLI for fetching and injecting [Project Vault](https://github.com/nestormata/project-vault)
secrets, for a developer or CI engineer using a machine-user API key. Story 43.1 implements the
first command, `get`; later stories in Epic 43 (`login`, `run -- <cmd>`, `.env` materialization)
build on the foundation this story establishes.

This package is a thin wrapper around
[`@project-vault/agent`](../agent/README.md) — it consumes that package as a plain pnpm workspace
dependency (`workspace:*`) and never re-implements or vendors its token-exchange/credential-fetch
logic (Story 43.1 AC-1).

## Installation / running locally

Not published to any registry (matching `@project-vault/agent` and `@project-vault/vault-action`).
Run it from this monorepo checkout:

```bash
pnpm --filter @project-vault/cli build
node packages/cli/dist/bin.js get DATABASE_URL
```

## Usage

```bash
VAULT_API_KEY=pk_abc123 \
VAULT_URL=https://vault.example.com \
VAULT_PROJECT_ID=a1c2d3e4-0000-0000-0000-000000000000 \
  pvault get DATABASE_URL > out.txt
```

Piped/redirected output carries only the resolved value, with no banner, decoration, or log line
(AC-4). Running `pvault get` directly in an interactive terminal refuses to print unless you pass
`--stdout` (AC-3 / UX-DR16 — `pv run --`, this epic's default injection path, ships in Story 43.3).

## Design decisions (Dev Notes, Story 43.1)

This story made six decisions epics.md deliberately left open. They're recorded here so Stories
43.2–43.6 build on a settled foundation instead of each guessing independently.

### 1. Package/binary name: `@project-vault/cli` / `pvault` (not `pv`)

`pv` ("Pipe Viewer") is a widely pre-installed/packaged Unix utility, and also collides with
LVM2's `pv*` command family. Every epics.md example command uses `pv` (`pv get`, `pv run --`,
`pv login`) — this is a deliberate, documented divergence from those illustrative examples, not an
oversight. The binary is `pvault`; later stories' example commands should say `pvault`, not `pv`.

### 2. Config resolution: `VAULT_*` env vars, CLI flags override

`VAULT_API_KEY`, `VAULT_URL`, `VAULT_PROJECT_ID` — kept under the same prefix
`@project-vault/agent` itself already uses (`VAULT_CACHE_PATH`, `VAULT_FALLBACK_THRESHOLD`) rather
than inventing a second `PV_*` prefix (epics.md's own illustrative examples use `PV_*`; this is
the same deliberate divergence as decision #1, for the same reason). `--api-key`/`--url`/
`--project-id` flags override the corresponding env var. A missing required value fails
synchronously, before any network call, naming exactly which value(s) are missing.

### 3. Interactive-print override flag: `--stdout`

`pvault get NAME --stdout` prints even on an interactive TTY. The refusal message names both
`--stdout` and `pvault run -- <command>` (Story 43.3) as the two ways to get the value out.

### 4. Exit-code scheme (AC-5)

Every `.code` value `@project-vault/agent`'s `VaultAgentError` can throw maps to its own exit
code, so a CI pipeline can branch on `$?` reliably. See `src/exit-codes.ts` for the authoritative
mapping (this table must stay in sync with it):

| Exit code | Meaning                                                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | Success                                                                                                                                                                                           |
| `1`       | Usage error — bad args, missing config, blank credential name, non-UUID `VAULT_PROJECT_ID`, or an interactive-TTY refusal without `--stdout`. Nothing ever reached `packages/agent` on this path. |
| `2`       | `token_exchange_failed` — invalid or revoked API key                                                                                                                                              |
| `3`       | `credential_not_found`                                                                                                                                                                            |
| `4`       | `insufficient_role`                                                                                                                                                                               |
| `5`       | `ambiguous_credential_name`                                                                                                                                                                       |
| `6`       | `vault_request_failed` — generic non-2xx from the credential-value route                                                                                                                          |
| `7`       | `multi_field_secret_unsupported`                                                                                                                                                                  |
| `8`       | `vault_unreachable` — no cached value exists                                                                                                                                                      |
| `9`       | `vault_unreachable_non_cacheable`                                                                                                                                                                 |
| `10`      | `cache_expired`                                                                                                                                                                                   |
| `11`      | `cache_decryption_failed`                                                                                                                                                                         |
| `12`      | `cache_corrupted`                                                                                                                                                                                 |
| `13`      | Unexpected/unclassified error (a bug, or a future `packages/agent` error code this CLI doesn't know about yet)                                                                                    |

### 5. Offline-cache participation: enabled, with mandatory provenance signaling (AC-4a)

`pvault get` uses `packages/agent`'s own default `cachePath`/`fallbackThreshold` — it does not
override either. `packages/agent`'s public `getSecret()` has no provenance field, so this package
does not modify `packages/agent` to add one (out of this story's scope); instead
`src/cache-provenance.ts` observes the one already-documented signal `packages/agent` itself
relies on internally — a network-level `fetch()` `TypeError` — for the duration of a single
`getSecret()` call, and prints `warning: served from offline cache (vault unreachable), value may
be stale` to stderr (never stdout) whenever that happened. Exit code stays `0`: a successfully
served, if stale, value is not itself a failure this CLI hard-fails on.

### 6. Argument-parsing framework: [`commander`](https://www.npmjs.com/package/commander) `^14`

Chosen over hand-rolled `process.argv` parsing because this is the first story of a six-story epic
whose later stories add `login`, `run -- <cmd>`, `.env` materialization, and a startup version
check — all multi-command, multi-flag surfaces. `commander` was already resolved elsewhere in this
monorepo's lockfile.

## Accepted residual risk

`VAULT_API_KEY` (like any credential passed via environment variable to a CLI) is readable by any
other process of the same OS user via `/proc/<pid>/environ` on Linux for as long as the process is
running. This is the same class of exposure every AWS CLI/`gcloud`/similar tool accepts, and is
**not** something this story engineers around — see Story 43.1's Dev Notes "Accepted residual
risk" and Story 43.4's hardening scope for the analogous, explicitly-accepted limitation on
_injected_ secrets.

## Running the e2e test

`src/get-command.e2e.test.ts` boots a real, listening `@project-vault/api` server and round-trips
a real secret through it — it needs a real, migrated Postgres:

```bash
make db-up
DATABASE_URL=postgresql://postgres:password@localhost:$DB_HOST_PORT/project_vault pnpm --filter @project-vault/db db:migrate
DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:$DB_HOST_PORT/project_vault \
ADMIN_DATABASE_URL=postgresql://vault_admin:password@localhost:$DB_HOST_PORT/project_vault \
  pnpm --filter @project-vault/cli test
```
