# `@project-vault/cli`

Terminal CLI for fetching and injecting [Project Vault](https://github.com/nestormata/project-vault)
secrets, for a developer or CI engineer using a machine-user API key. Story 43.1 implemented the
first command, `get`; Story 43.2 added `login`/`logout`; Story 43.3 added `run -- <cmd>` (per
UX-DR16, the documented default injection path). `.env` materialization and later Epic 43 stories
build on the foundation these establish.

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

## `pvault login` / `pvault logout` (Story 43.2)

Authenticate to the vault as yourself (a human user), instead of provisioning a machine user for
personal work:

```bash
VAULT_URL=https://vault.example.com pvault login
# Email: dev@example.com
# Password: (not echoed)
# Enter your 6-digit authenticator code: (only if TOTP MFA is enrolled)
# Logged in.

pvault logout
# Logged out.
```

`login`/`logout` take no `--api-key`/`--project-id` (that's the machine-user path) — only
`VAULT_URL` (or `--url`). Email and password are always prompted interactively, never accepted as
flags or argv (the same shell-history/`ps`-visibility reasoning Story 43.3's injected-secret ACs
document). A WebAuthn-only account fails closed with a clear message rather than silently
attempting a weaker factor — CLI WebAuthn support is Epic 46's Story 46.5, not this one.

## Design decisions (Dev Notes, Story 43.2)

Story 43.2 adds three more decisions, appended to Story 43.1's six above. **Decision #2 below is
binding on Story 51.2** (the browser extension's own login) — see its own note on exactly what
that story inherits versus what it must decide for itself.

### 1. Session storage: a `0600` file, not a platform keychain

`${XDG_CONFIG_HOME:-~/.config}/pvault/session.json`, written atomically (temp file + `fsync` +
`rename`) with the parent directory at `0700` and the file itself at `0600`, both enforced via an
explicit post-write `chmodSync` (never relied on implicitly, since `umask` can widen
`writeFileSync`'s `mode` option). A `keytar`-style OS-credential-store dependency was considered
and explicitly **not** adopted — this monorepo has no existing native-module dependency of that
class, and the AC itself accepts file-based storage as compliant ("mode `0600` **or** a platform
keychain"). See `src/session-store.ts`.

**Windows note:** Node's `mode` option on `fs.writeFileSync`/`chmodSync` is a no-op on Windows —
POSIX mode bits don't exist there. The session file's confidentiality on Windows relies entirely
on the OS default of NTFS ACLs scoping the file to the owning user account; this is **not** the
same `0600` guarantee POSIX platforms get, and the permission-check in AC-5 (`src/session-store.ts`
`readSession()`) is correspondingly skipped on `process.platform === 'win32'` rather than silently
no-op'ing with no explanation.

### 2. Token type, issuance endpoints, and lifetime — **binding on Story 51.2**

New, dedicated JSON-bearer-token routes (`apps/api/src/modules/auth/cli-login-routes.ts`), rather
than a header-gated dual-mode `/login` — a missing header silently falling back to cookie mode is
a subtler, easier-to-regress surface than two explicit, independently-testable routes:

- `POST /api/v1/auth/cli-login` — mirrors `/login`'s body (`email`, `password`); returns either
  `{ data: { mfaRequired: true, mfaToken } }` (identical shape to the cookie route's MFA
  challenge) or `{ data: { accessToken, refreshToken, tokenType: 'Bearer', expiresIn, userId,
orgId } }`.
- `POST /api/v1/auth/cli/mfa/verify-login` — mirrors `/mfa/verify-login`'s body (`mfaToken`,
  `totp`); returns the same bearer-token shape as above on success.
- `POST /api/v1/auth/cli/refresh` — body `{ refreshToken }`; returns a fresh
  `{ accessToken, refreshToken, tokenType, expiresIn }`. The refresh token **rotates** on every
  successful refresh (confirmed directly against `service.ts`'s `refreshSession()`/
  `rotateRefreshToken()` — the same rotation the cookie-based `/refresh` route already relies on,
  with a grace-period allowance for a reused, very-recently-rotated token, which is what makes the
  concurrent-refresh race below safe rather than merely likely-safe).
- `POST /api/v1/auth/cli/logout` — body `{ refreshToken? }`; best-effort server-side revocation
  (always returns `200 { data: { revoked } }`, never an error, even for an unknown/already-invalid
  token — the CLI's local file deletion is the command's real primary job).

All four call the **exact same** `loginUser()`/`verifyLogin()`/`refreshSession()` functions the
cookie-based routes in `routes.ts` use (`routes.ts` exports a shared `handleGatedLogin()` helper
both `/login` and `/cli-login` call, so the gate/normalize/parse/authenticate sequence is written
once) — no auth logic is duplicated, only the reply shape differs (JSON body vs. `Set-Cookie`).

**Both the access JWT and the refresh opaque token are returned in the JSON body** — a deliberate
divergence from the browser, which never sees its refresh token directly (httpOnly-cookie-only).
The CLI has no cookie jar; the refresh token has to live somewhere the CLI can present it later,
and the `0600` session file (decision #1) is that somewhere.

**Lifetime:** reuses `JWT_ACCESS_TTL_SECONDS`/`REFRESH_TOKEN_TTL_DAYS` as-is (no new env vars) —
but the CLI implements its own client-side **silent refresh** (`src/session-refresh.ts`'s
`ensureFreshSession()`): when the stored access token is expired or within 30s of expiring, it
refreshes automatically and rewrites the session file, with no user-visible re-prompt. A
still-expired-after-refresh (or refresh-call-failed) session produces the plain re-prompt message
this story's AC-4 requires — "Your session has expired. Run `pvault login` to sign in again." —
never a bare 401.

**Concurrent-refresh race:** since the refresh token rotates, two processes racing to
silently-refresh the same session file could otherwise produce a spurious failure for the loser.
`ensureFreshSession()` re-reads the session file once before concluding a session is dead — a
losing process picks up the winning process's freshly-written tokens instead of wrongly
re-prompting for a session that's actually still healthy. The session file write itself is atomic
(temp-file + `rename`), so a reader racing a writer never observes a torn/partial file.

**Scope boundary — not inherited from `packages/agent`, and `pvault get` is unchanged:** a human
session's access JWT is a first-party user JWT, a different token type from the machine-user
`pk_`-key-derived scoped JWT `@project-vault/agent`'s `createVaultAgent()` accepts. `login`/
`logout` talk to the new endpoints directly via `fetch`, entirely independent of
`packages/agent`. **This story does not make `pvault get` consume a human session** — that wiring,
if ever wanted, is a separate, unrequested piece of scope.

**What Story 51.2 inherits, and what it must decide for itself:** the browser extension inherits
this decision's **token type, issuance endpoint(s), and lifetime** (the JSON-bearer-token
login/refresh routes above and their TTLs) — it should call the same `/cli-login`,
`/cli/mfa/verify-login`, `/cli/refresh` routes rather than inventing a second session design. It
must **not** inherit decision #1's file-based _storage_ mechanism (a browser extension has no
filesystem to write a `0600` file to) — its own storage decision belongs in `chrome.storage.local`
(never `chrome.storage.sync`, which would replicate a human session's refresh token across every
browser instance signed into the same account — a materially broader exposure than one machine's
`0600` file).

### 3. Interactive prompting: `node:readline/promises`, no new dependency

Email/TOTP prompts use `readline/promises`'s `rl.question()` directly (normal line editing/echo).
The password prompt reads raw keystrokes without echoing them (`src/prompt.ts`'s `promptMasked()`)
rather than pulling in an `inquirer`-class dependency for one masked-input use case — same
minimal-footprint reasoning as Story 43.1 choosing `commander` deliberately. `packages/cli/src/
cli.ts`'s `CliRuntime` type gained a `prompt: PromptFn` field (and a `fetchFn: typeof fetch` field
for decision #2's direct HTTP calls) so `login`'s tests inject a fake prompt/fetch exactly the way
`get`'s tests inject fake streams — `bin.ts`'s real entry point wires `createRealPrompt()`/the
real global `fetch`.

### Exit-code additions (append-only, extends Story 43.1's table)

| Exit code | Meaning                                                                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `14`      | `notLoggedIn` — a session-consuming command found no session file where one was expected                                                                                                            |
| `15`      | `sessionExpired` — the stored session is expired and the silent refresh also failed/expired (AC-4)                                                                                                  |
| `16`      | `invalidTotp` — surfaced during the login MFA round trip, not a stored-session failure                                                                                                              |
| `17`      | `mfaTokenExpired` — the pending-MFA token itself died mid-login; the whole login flow restarts                                                                                                      |
| `18`      | `webauthnOnlyUnsupported` — AC-3's fail-closed case for a non-TOTP MFA challenge                                                                                                                    |
| `19`      | `insecureSessionFilePermissions` — AC-5's hard refusal to use a group/world-readable session file                                                                                                   |
| `20`      | `nativeLoginDisabled` — this vault instance has native (password) login disabled (SSO-only)                                                                                                         |
| `21`      | `invalidCredentials` — plain wrong email/password (not one of Dev Notes decision #4's originally-named codes, added because this needed its own distinguishable code too — see `src/exit-codes.ts`) |

## `pvault run --` (Story 43.3)

Fetch one or more secrets and spawn a command with them injected into its environment — per
UX-DR16, this is Epic 43's **documented default path** (`pvault get`'s TTY refusal already names it
as the intended way to consume a secret in a real process):

```bash
VAULT_API_KEY=pk_abc123 \
VAULT_URL=https://vault.example.com \
VAULT_PROJECT_ID=a1c2d3e4-0000-0000-0000-000000000000 \
  pvault run --secret DATABASE_URL --allow-unhardened-injection -- psql "$DATABASE_URL"

# Multiple secrets, and renaming a credential to a different env var name:
pvault run --secret DATABASE_URL --secret "my-db-password=MY_DB_PASSWORD" \
  --allow-unhardened-injection -- ./deploy.sh
```

`--allow-unhardened-injection` is required until Story 43.4 ships (see decision #6 below) — every
invocation without it refuses to run at all. The command's own stdout/stderr never echo a fetched
value (AC-1); the child's stdin/stdout/stderr connect directly to the terminal (`stdio: 'inherit'`),
so interactive commands (`psql`, `python -i`, a dev server) behave exactly as if launched directly.

## Design decisions (Dev Notes, Story 43.3)

Seven more decisions, appended to Stories 43.1/43.2's above.

### 1. Reserved/dangerous env var protection — CLI-local port (`src/reserved-env-vars.ts`)

Ports `packages/vault-action/src/parse-secrets.ts`'s exact `RESERVED_ENV_VAR_NAMES` set (`PATH`,
`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `NODE_OPTIONS`,
`HOME`, `SHELL`), minus the two GitHub-Actions-specific entries (`GITHUB_TOKEN`, the
`GITHUB_`/`ACTIONS_` prefix rules) that don't apply outside a GitHub Actions runner. `--secret
DB_PASSWORD=LD_PRELOAD` is refused before any network call. The file is not vendored/imported
directly from `packages/vault-action` (different shape, different conventions) — only the set and
the identifier-validity regex are ported.

### 2. The AC-6 seam: `src/inject-and-run.ts`'s `injectAndRun()`

The core "resolve credential names to fetched values (fail-closed), then spawn a command with them
injected" logic is an exported, framework-agnostic function — **zero** imports of `commander`,
`Command`, `CliRuntime`, or `process.argv` parsing anywhere in the module. `src/run-command.ts` is
the thin CLI adapter: it parses `pvault run`'s flags into `InjectEntry[]`, calls `injectAndRun()`,
and maps the result to `setExitCode()`.
`src/inject-and-run.non-cli-caller.test.ts` is the AC-6 proof: it imports only `injectAndRun` (never
`cli.ts` or anything commander-related) and drives it directly, exactly as a future Epic 50 broker
(FR177's `inject_env`) could. Epic 50 is currently gated with zero implementation stories, so this
AC is satisfied **structurally** — by the seam and its proving test — not by a real cross-package
integration that doesn't exist yet. The seam stays inside `packages/cli` (not a new top-level
package), matching how `packages/cli` itself consumes `packages/agent` as a plain `workspace:*`
dependency.

### 3. Fail-closed, all-or-nothing multi-secret fetch

Every requested secret is fetched sequentially, before `spawn()` is ever called. Any single failure
aborts the whole command — **the child process is never spawned** — with an error built only from
the failing entry's own message, never from a partially-built map of already-fetched values (a
value fetched before a later failure must never leak into the abort-path error output). This is a
deliberate divergence from `packages/vault-action`'s `run.ts`, which attempts every entry
independently: a spawned arbitrary command with partially-missing secrets is a materially different
risk than a CI step reporting a failed output. `src/agent-error-messages.ts` (extracted from
`get-command.ts`) is shared between `get` and `run` so the two never diverge in wording for the same
underlying `VaultAgentError` code.

### 4. Commander's `--` passthrough: verified working, no manual fallback needed

Verified directly against the installed `commander@^14`: `.argument('<command...>')` correctly
captures everything after a literal `--` token verbatim (including flags that look like `pvault`'s
own options, e.g. `ls --help` after `--`), with no manual `process.argv`-split fallback required.
What commander's default parsing does **not** give a clean error for are two edge cases — a missing
`--` entirely, and an empty command after it — both produce a confusing default (e.g. "unknown
option '-la'"). A `program.hook('preSubcommand', ...)` inspects the subcommand's raw args _before_
its own option/argument parsing runs, and calls `thisCommand.error(...)` with `pvault run`'s own
clear usage message for both cases.

### 5. New exit codes (append-only, extends Stories 43.1/43.2's 1-21 table)

| Exit code | Meaning                                                                                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `22`      | `secretsRequired` — zero `--secret` flags passed                                                                                                                                                                       |
| `23`      | `unhardenedInjectionNotAcknowledged` — the `--allow-unhardened-injection` opt-in flag was omitted (AC-5)                                                                                                               |
| `24`      | `childSignalTerminated` — Windows-only fallback for a signal-terminated child (AC-4); never actually observed on POSIX, where the parent dies via the re-raised signal itself instead of returning via `setExitCode()` |

### 6. `--allow-unhardened-injection` (AC-5) — CLI-argument-only, no env var fallback

A long, deliberately hard-to-type-by-accident flag name (rejecting a short `-f`/`--force` form),
naming exactly what risk is being accepted: secrets injected into a process whose own crash dumps,
stack traces, or `/proc/<pid>/environ` could leak them (FR158a — Story 43.4's scope, not this
one's). The warning prints to stderr on **every** invocation with the flag present, not just once —
a developer scripting this into a Makefile target should see it every run until Story 43.4 ships.
Deliberately **not** also readable from an env var (every other flag in this CLI does have one) —
this keeps the opt-in a conscious, per-invocation act during the gated interval. The check is
isolated in its own function, `src/run-command.ts`'s `requireUnhardenedInjectionOptIn()`, so Story
43.4 can delete one function call and its supporting flag/message cleanly when it removes this AC.

**Known, accepted limitation:** the warning can be silently swallowed by a shell redirect that
discards stderr (`... 2>/dev/null`) — a common, legitimate cron/CI pattern. There is no reliable way
to force visibility into a process whose own invoker chose to discard stderr, short of refusing to
run at all when stderr isn't a TTY, which would break that same legitimate use case. Story 43.4's
audit-log requirement (FR158a) is the actual mitigation — an audit trail that doesn't depend on the
invoker having read their own terminal output.

### 7. Offline-cache/provenance participation: reuses `get`'s exact policy, not a special case

`pvault run` participates in `packages/agent`'s offline-cache fallback exactly as `pvault get` does
(decision #5 above) — each `--secret` fetch individually goes through
`withFetchProvenanceTracking()`, and each secret served from a stale cache gets its own per-name
warning on stderr (`warning: 'X' served from offline cache (vault unreachable), value may be
stale`) before the child is ever spawned. This is a considered trade-off, not an oversight —
injecting a stale credential into a running, possibly long-lived process is arguably riskier than
`get` printing a stale value once for a human to judge — but disabling cache participation for `run`
would make it less resilient to a genuinely offline vault than `get`, contradicting Epic 43's
framing of the offline cache as a documented, accepted feature. The mandatory per-secret warning is
the mitigation; a stronger one (refusing to inject a stale value without further opt-in) is out of
this story's scope.

### AC-4 — exact exit code / signal propagation, by design

"Propagates the child's exit code exactly, including signal-terminated cases" is read as **the
parent's own termination is the same signal event** — `process.kill(process.pid, signal)` — not a
synthetic `128 + N` code, matching how `npm`/`cross-env`-class tools behave. A parent-received
`SIGINT` while the child is running is forwarded to the child (`child.kill('SIGINT')`) rather than
orphaning it, with the listener removed once the child's own `exit` event fires.

## Running the e2e tests

`src/get-command.e2e.test.ts` boots a real, listening `@project-vault/api` server and round-trips
a real secret through it — it needs a real, migrated Postgres:

```bash
make db-up
DATABASE_URL=postgresql://postgres:password@localhost:$DB_HOST_PORT/project_vault pnpm --filter @project-vault/db db:migrate
DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:$DB_HOST_PORT/project_vault \
ADMIN_DATABASE_URL=postgresql://vault_admin:password@localhost:$DB_HOST_PORT/project_vault \
  pnpm --filter @project-vault/cli test
```

`src/inject-and-run.e2e.test.ts` (Story 43.3, AC-4) needs **no** Postgres/API server — it spawns a
real `node:child_process` child (via the real, non-mocked `spawn`) and asserts real exit-code/signal
propagation, with `getSecret` stubbed in-memory (the fetch side is already covered by
`get-command.e2e.test.ts`'s real round trip). It runs as part of the normal `pnpm test` command with
no extra setup.
