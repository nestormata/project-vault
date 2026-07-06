# Story 7.3: GitHub Actions CI/CD Integration

Status: done

<!-- Ultimate context engine analysis completed 2026-07-04 — comprehensive developer guide for the official `project-vault/vault-action` GitHub Action: a thin, bundled TypeScript wrapper around Story 7.2's `@project-vault/agent` package and machine-token auth flow. This is the THIRD and FINAL story in Epic 7. It ships almost no new backend code — no new DB migration, no new API routes — its entire surface is a new workspace package (`packages/vault-action/`) plus documentation. Read "Key Design Decisions & Open Questions" before coding: several concrete conflicts between epics.md's literal Story 7.3 wording, architecture.md's aspirational OIDC-integration design, and Stories 7.1/7.2's already-committed `@project-vault/agent`-based design are resolved here, following the exact resolution discipline Stories 4.1, 7.1, and 7.2 established. -->

## Story

As a developer using GitHub Actions,
I want an official `project-vault/vault-action` GitHub Action that retrieves secrets from the vault and exports them as masked environment variables,
so that my CI/CD pipelines can use vault secrets without manual API calls or custom scripts.

*Covers: FR39.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-7.3` (lines 1830-1855)]

**Out of scope for this story (belongs elsewhere — do not implement here):**

- Machine user identity/API-key CRUD, the machine-token exchange endpoint, the credential-by-name retrieval endpoint, and the `@project-vault/agent` npm package itself — all **Stories 7.1/7.2**, both already `ready-for-dev`. This story is a **pure consumer** of `@project-vault/agent`; it adds zero new backend routes, zero new database migrations, and zero new schema.
- Any GitHub Actions OIDC / JWKS-based federation flow (no static API key stored in the workflow) — this is `architecture.md`'s aspirational `modules/integrations/github-actions/` design (see D5 below); it is explicitly **not** implemented in this story and is flagged as a candidate v2 enhancement.
- A native GitLab CI component/integration — explicitly descoped to v2 per epics.md `AC-E7a`; this story documents the v1 GitLab path (raw REST calls with `curl` against 7.2's machine-token endpoint) but ships no GitLab-specific code.
- Actually clicking "Publish to GitHub Marketplace" on github.com — a one-time, human, out-of-band action performed by whoever owns the `project-vault` GitHub organization once this story's code is merged and tagged; this story delivers everything required to make that click possible (complete `action.yml`, README, branding, a tagged release) but cannot itself perform it (see D7).

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `none` — internal/tooling. This story ships a standalone CI/CD integration artifact (a GitHub Action) consumed by external GitHub workflows, not a route or page inside Project Vault's own web app or REST API surface. |
| **Evaluator-visible** | no — nothing in this story is reachable from Project Vault's own web UI or API; it is exercised entirely from a *consumer's* GitHub Actions workflow, outside the vault application itself. |
| **Linked UI story** (if API-only) | N/A — this is not an API-only backend story; see rationale below. |
| **Honest placeholder AC** (if UI deferred) | N/A — no UI is being deferred; none is in scope for this surface, ever, by design (a GitHub Action has no UI of its own beyond its workflow log output). |
| **Persona journey** | N/A — the "user" of this story is a developer's GitHub Actions workflow YAML, not a human clicking through Project Vault's product UI. The closest thing to a persona journey is the **README's example workflow** (AC-14), which is the actual "UI" a developer interacts with — see AC-14 for its required content. |

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| **Story 7.2 implemented** (`@project-vault/agent` package: `createVaultAgent({ apiKey, baseUrl, projectId })`, `.getSecret(name)`, `VaultAgentError`/`VaultCacheDecryptionError`/`VaultCacheCorruptedError`/`VaultUnreachableNonCacheableError`; `POST /api/v1/auth/machine-token`; `GET /api/v1/machine/projects/:projectId/credentials/:name/value`) | This story's entire runtime behavior is a thin wrapper over 7.2's package — **do not** re-implement token exchange, credential retrieval, or HTTP retry logic. **At story-creation time, 7.2 is `ready-for-dev`, not yet `done`** — if 7.2's `@project-vault/agent` public API (constructor shape, method names, error class names/fields) diverges from its own spec during development, this story's implementation must be updated to match the actually-shipped API, not the spec in `7-2-machine-user-authentication-and-programmatic-secret-retrieval.md`. |
| **Story 7.1 implemented** (`machine_users`/`api_keys` schema, one machine user = one project scope) | This story's cross-project validation (AC-4) is a direct consequence of 7.1's design: a `pk_...` API key is always scoped to exactly one project. Confirm this constraint has not changed before implementing AC-4. |
| **No CI release pipeline exists today** (confirmed: `.github/workflows/` contains only `ci.yml` and `nightly.yml`; `architecture.md`'s mention of a `release.yml` "on merge to main" for GHCR publishing does not exist in the repo at story-creation time) | This story must add its own minimal release workflow for **tagging** the action (D7/AC-15) — it is not reusing an existing release pipeline, because none exists yet for any purpose in this repo. |
| Turborepo auto-discovers new `packages/*` workspaces | `packages/vault-action` needs no `turbo.json`/`pnpm-workspace.yaml` changes — confirmed via `pnpm-workspace.yaml`'s `packages: ["apps/*", "packages/*"]` glob. |

---

## Key Design Decisions & Open Questions

**Read this section before writing any code.** These resolve concrete conflicts between epics.md's literal Story 7.3 wording, `architecture.md`'s aspirational design, and Stories 7.1/7.2's own explicit handoffs — the same resolution discipline Stories 4.1, 7.1, and 7.2 established: actually-committed prerequisite-story contracts win over an epics.md AC's literal-but-unshipped spec, and an aspirational architecture-doc design with zero shipped code loses to the design the prerequisite stories already committed to.

### D1 — Runtime HTTP dependency: `@project-vault/agent` only, **not** `@actions/http-client`

- epics.md (`epics.md:1844`) says the action "uses `@actions/core` and `@actions/http-client`."
- **Prerequisite reality:** 7.2's `@project-vault/agent` (D11 of that story) already implements the entire HTTP surface this action needs — token exchange, credential-by-name retrieval, typed errors, and (optionally) the offline cache — using Node's built-in global `fetch` internally, not `@actions/http-client`. 7.1's own cross-story-context row for this story states plainly: *"The published action authenticates using a `pk_...` key issued by this story's `POST .../api-keys` endpoint, via 7.2's token exchange"* — i.e., through the package, not a hand-rolled HTTP call.
- **Decision implemented in this story:** `packages/vault-action` depends on `@actions/core` (input parsing, masking, logging, `setFailed`) and `@project-vault/agent` (`workspace:*`, all vault I/O) — it does **not** add `@actions/http-client` as a dependency. Re-implementing HTTP calls against 7.2's endpoints directly, in parallel with the already-built agent package, would be exactly the "reinventing the wheel" anti-pattern this workflow's guardrails exist to prevent. `@project-vault/agent`'s workspace dependency is resolved and bundled at build time (D6) — it does not need to be published to npm for this story to consume it, even though 7.2 separately made it externally publishable for its own reasons.
- **Bounded network timeout (neither 7.1 nor 7.2 specifies one — this story adds the first explicit bound):** neither prerequisite story's spec states a fixed timeout for the agent's underlying `fetch()` calls, which means a hung DNS resolution or TCP handshake (as opposed to an immediate connection refusal) could otherwise stall a `getSecret()` call for the workflow's full `timeout-minutes` — potentially far longer than a CI job should ever wait on a single credential lookup, with no informative log output in the interim. Since this story cannot retroactively add a timeout inside 7.2's already-committed `@project-vault/agent` implementation, this action wraps each `getSecret()`/token-exchange call with its own explicit deadline: an `AbortController` timeout of **10 seconds** per underlying network attempt (a fixed, hardcoded constant — not a new user-facing input, to keep the action's input surface minimal), after which the call is treated as vault-unreachable (D4) exactly like a connection refusal. Document this fixed timeout in the README so a workflow author debugging an unexpectedly-fast failure understands why.

### D2 — Secrets-mapping syntax: `PROJECT` segment is the target `projectId`, and all lines in one invocation must resolve to the **same** project

- epics.md's literal input shape is `secrets: "PROJECT/CREDENTIAL_NAME as ENV_VAR_NAME"` with no separate `projectId` input.
- **The conflict:** 7.1's machine-user model scopes exactly **one** project per API key/machine user (`POST /api/v1/projects/:projectId/machine-users`); 7.2's machine JWT carries a single `scope: projectId` claim fixed at machine-user-creation time, not something a caller can vary per request (7.2 AC-7: a JWT's `scope` not matching the URL's `:projectId` returns `403`). This means a single `api-key` input to this action can only ever retrieve secrets from **one** project, no matter how the `secrets` mapping string is structured.
- **Decision implemented in this story:** the `PROJECT` segment of each `secrets` line is parsed as the `projectId` (UUID) that line targets. Before making **any** network call, the action validates that every parsed line's `PROJECT` segment is identical across the whole `secrets` input, comparing **lowercase-normalized** UUID strings (case-insensitive — matching Postgres's own `uuid` comparison semantics, AC-4) so two lines referencing the identical UUID in different hex-digit casing are not flagged as a false-positive mismatch. If two or more distinct `PROJECT` values are found, the action fails immediately (`core.setFailed`, no partial retrieval attempted) with a message instructing the caller to split the request into multiple `vault-action` steps, one per project, each with that project's own `api-key`. This is a genuine, surfaced scope boundary — not a bug — and is documented in the README (AC-14).
- The single validated `projectId` (from the first parsed line) is passed to `createVaultAgent({ apiKey, baseUrl, projectId })` once per action invocation; all `getSecret()` calls in that invocation reuse the same agent instance (one token exchange, not one per secret).

### D3 — Action inputs use idiomatic kebab-case ids, not epics.md's literal camelCase

- epics.md writes the inputs as `vaultUrl`, `apiKey`, `secrets`. GitHub Actions' own convention (and the vast majority of Marketplace actions, e.g. `actions/checkout`, `actions/setup-node`) uses lowercase-hyphenated `with:` keys.
- **Decision implemented in this story:** `action.yml` declares inputs `vault-url`, `api-key`, `secrets`, `continue-on-error` (see D4) — read via `core.getInput('vault-url')` etc. This is purely a naming-convention alignment with the ecosystem this action is published into; it changes no behavior epics.md's AC describes. Cross-referenced in the README and in this story's ACs using the kebab-case names throughout.

### D4 — `continueOnError` scope: only vault-unreachable (network-level) failures are soft; application-level errors (404/409/403/401) always fail the step

- epics.md (`epics.md:1846`): *"if the vault is unreachable and `continueOnError: true` is set, the action warns but does not fail the workflow; if `continueOnError: false` (default), it fails the step."*
- **Decision implemented in this story:** `continue-on-error` (input, default `"false"`) governs exactly one failure class: `@project-vault/agent` throwing because the vault could not be reached at all (connection refused/timeout/DNS failure — the same network-level condition 7.2's agent already distinguishes from an HTTP error response, see 7.2 AC-11) **and** no usable offline cache entry exists for that name either. It does **not** soften any application-level error the vault *did* successfully respond with: an invalid/expired/revoked API key (`401`), a not-found credential (`404`), an ambiguous name (`409`), or a cross-project/role failure (`403`) always calls `core.setFailed()` regardless of `continue-on-error` — these are configuration mistakes in the workflow itself, not transient vault unavailability, and silently warning past them would mask a broken pipeline (e.g., a typo'd credential name silently producing an empty, unmasked env var).
- **How this composes with AC-9's "attempt every entry" behavior (must not be read as contradictory):** regardless of `continue-on-error`'s value, and regardless of any single entry's outcome, the action **always attempts every parsed entry** — no entry is ever skipped because an earlier entry failed, whether that earlier failure was vault-unreachable or application-level. `continue-on-error` does **not** control *whether processing continues to the next entry* (that always happens); it controls only *what the action does at the very end*, once every entry has been attempted, when one or more vault-unreachable failures occurred: with `continue-on-error: false` (default), any accumulated vault-unreachable failure(s) cause a final `core.setFailed()` summarizing them (mirroring AC-9's summary format); with `continue-on-error: true`, accumulated vault-unreachable failures instead produce a final `core.warning()` and the action does **not** fail. Any application-level failure (401/403/404/409) accumulated along the way always contributes to a hard `core.setFailed()` at the end (D4, unconditionally), even if every vault-unreachable failure in the same run was soft-warned under `continue-on-error: true` — the two failure classes are tracked independently and only application-level failures are guaranteed to hard-fail the run.

### D5 — `architecture.md`'s GitHub Actions OIDC/JWKS design is **not** implemented; flagged as a v2 candidate

- `architecture.md` (source-tree section, lines 1044-1048) describes an aspirational `modules/integrations/github-actions/` backend module: *"verifies GitHub JWKS, issues machine user token"* — i.e., a workflow's native GitHub OIDC identity token is exchanged directly for a vault machine token, with **no static API key stored in the workflow's secrets at all**.
- **Why this story does not build it:** (1) no code for this module exists anywhere in the repo (confirmed: `apps/api/src/modules/` has no `integrations/` directory today); (2) Stories 7.1 and 7.2 — both already `ready-for-dev`, i.e., already committed designs — build exclusively on the static-API-key + machine-token-exchange model, with no OIDC verification, JWKS caching, or federated-identity machine-user-provisioning flow anywhere in their scope; (3) epics.md's own Story 7.3 AC text (the actual source-of-truth for this story, `epics.md:1838-1854`) describes only the static-API-key flow (`apiKey` as a workflow input) with no mention of OIDC; (4) building OIDC federation from scratch here would require an entirely new backend module, a new machine-user provisioning-by-workload-identity flow, and JWKS-fetching/caching infrastructure — a scope increase far beyond "wrap the already-built 7.2 flow in a GitHub Action," and not covered by FR39's PRD wording ("native integrations that allow CI/CD pipelines to retrieve secrets," which the static-key flow already satisfies).
- **Decision implemented in this story:** ship the static-API-key flow only, matching 7.1/7.2/epics.md. Add a one-line note to the README's "Roadmap" section flagging OIDC-based keyless authentication as a possible v2 direction, with a cross-reference to `architecture.md`'s aspirational module — so the idea is not lost, but is explicitly not promised or half-built here.

### D6 — Bundling: `@vercel/ncc`, committed `dist/index.js`, CI freshness check mirroring the existing `openapi.json` pattern

- GitHub Actions' `runs: using: 'node24'` execution model does **not** run `npm install`/`pnpm install` before executing a JavaScript action — it runs the committed entry file directly via `node <entry>`. A workspace package with a `workspace:*` dependency (`@project-vault/agent`) and any transitive `node_modules` will not resolve at all for an external consumer who only does `uses: project-vault/vault-action@v1` (which checks out the git repository, not `node_modules`).
- **Decision implemented in this story:** `packages/vault-action` is built with `@vercel/ncc` (`ncc build src/index.ts -o dist`), producing a single self-contained `dist/index.js` (all dependencies, including the bundled `@project-vault/agent` and its own dependencies, inlined) that **is committed to the repository** (not `.gitignore`d, unlike every other package's `dist/`) — this is the one package in the monorepo where `dist/` must be tracked in git, because it is the actual artifact GitHub checks out and runs.
- A new CI script, `scripts/check-vault-action-dist-fresh.ts`, rebuilds `packages/vault-action` into a temp directory and diffs it against the committed `dist/index.js`; a mismatch fails CI with a message to run `pnpm --filter vault-action build` and commit the result — the exact same "generated artifact must match committed output" discipline `generate-spec`/`openapi.json` freshness already enforces elsewhere in this repo's `turbo.json` pipeline (`typecheck` depends on `generate-spec`). Wire this script into `.github/workflows/ci.yml`'s `quality-gates` job as a new step.

### D7 — Marketplace publishing and versioning: this story ships the mechanics; the actual publish click is a manual, one-time, out-of-band action

- Publishing an action to the GitHub Marketplace requires: a public GitHub repository (or the `project-vault/vault-action` path within one), a complete `action.yml` (name, description, inputs, outputs, `branding.icon`/`branding.color`), a `LICENSE` file, and at least one semver git tag — plus a human clicking "Draft a release" → "Publish this Action to the Marketplace" in the GitHub UI, which requires org-owner-level GitHub permissions this story's automated pipeline does not have and cannot simulate.
- **Decision implemented in this story:** deliver everything mechanically required (complete `action.yml`, README, `LICENSE` reference, branding fields) and add a minimal `.github/workflows/vault-action-release.yml` that, on a `vault-action-v*` tag push, builds/tests `packages/vault-action`, re-verifies dist freshness at the tagged ref (see the new requirement below), then creates/moves the major-version convenience tag (`v1` → the new patch tag, matching `actions/checkout`'s own well-known "mutable major tag" convention via `actions/publish-action` or an equivalent `git tag -f v1 && git push -f origin v1` step). The actual Marketplace-listing button click is called out explicitly as a manual follow-up in this story's Dev Notes and Completion Notes — do not attempt to script it away as if it were CI-automatable; it is not.
- **Mutable `v1` tag is a known supply-chain risk — mitigations required, not optional hardening:** force-moving `v1` (`git tag -f`/`push -f`) is the exact mechanism behind real-world GitHub Actions supply-chain compromises — anyone able to push to the release pipeline (or who compromises it) can silently redirect every consumer pinned to `uses: project-vault/vault-action@v1` to different code with no visible version bump. Two mitigations are required parts of this story's deliverable, not follow-up hardening: (1) the README (AC-14) documents SHA-pinning as the hardened alternative for security-conscious consumers — `uses: project-vault/vault-action@<full-commit-sha>` instead of `@v1` — with a short explanation that this trades convenience (no automatic patch/minor updates) for supply-chain integrity (the exact code that ran is the exact code reviewed); (2) `vault-action-release.yml` and the branch it releases from **require branch protection with required review** on any change that can move the `v1` tag — i.e., the workflow file itself and the release process must live behind the same required-PR-review gate as any other protected branch in this repo, so a single compromised or careless push cannot unilaterally redirect `v1`. This is documented here as an **operational requirement** on the `vault-action-v1` release process (repo/branch settings), since it cannot be enforced by the workflow YAML alone — flag it explicitly in Dev Notes/Completion Notes as a repo-configuration step to verify, not something the workflow file's contents alone can guarantee.

---

## Epic Cross-Story Context

| Story | Relationship to 7.3 |
|---|---|
| 7.1 (Machine User Identity & API Key Management, `ready-for-dev`) | Provides the `pk_...` API key format this action's `api-key` input accepts, issued via 7.1's `POST .../api-keys`. No direct code dependency — 7.3 never touches 7.1's routes or schema directly, only via 7.2's package. |
| 7.2 (Machine User Authentication & Programmatic Secret Retrieval, `ready-for-dev`) | **Hard dependency.** This story's entire runtime is `@project-vault/agent` (7.2's package) plus a thin CLI/Actions-runner wrapper. Do not duplicate token-exchange, retry, or offline-cache logic here — call the package's exported functions/methods exactly as 7.2 ships them. |
| Epic 8 (Compliance/Audit, `backlog`) | No new audit code in this story — every credential access this action performs that actually reaches the server flows through 7.2's existing `credential.value_revealed` audit write (`actorType: 'machine_user'`). **Accepted gap, not a defect:** per 7.2 AC-9, a `getSecret()` call served from `@project-vault/agent`'s offline cache (vault unreachable) writes **no** audit row server-side, since the server was never contacted — this story's Dev Notes already note the offline cache remains active unmodified inside a single action invocation, so some fraction of this action's reads during a vault outage inherit that same unaudited characteristic. Fixing this would require changing 7.2's agent (e.g., a client-side catch-up log), which is out of scope here; nothing for Epic 8 to change because of this story beyond being aware the gap exists. |
| Epic 9 (Platform Operations, `backlog`) | This story is the **first** in the repo to introduce a committed-`dist/` package and its own dedicated release workflow (D6/D7) — flagged so Epic 9's eventual general release/versioning story (if one is ever added) is aware a precedent already exists and doesn't duplicate/conflict with it. |

---

## Architecture Conflict Resolution (Read Before Coding)

| Epic/Architecture wording | Canonical implementation for 7.3 | Rationale |
|---|---|---|
| epics.md: action "uses `@actions/core` and `@actions/http-client`" | `@actions/core` + `@project-vault/agent` (no `@actions/http-client`) — D1 | 7.2's agent package already owns all HTTP/auth logic; adding a second, unused HTTP client duplicates functionality that already exists |
| epics.md: `secrets: "PROJECT/CREDENTIAL_NAME as ENV_VAR_NAME"` (multi-project implied) | `PROJECT` segment must be identical across all lines in one invocation (one project per API key) — D2 | 7.1/7.2's machine-user model scopes one API key to exactly one project; this is a real, load-bearing constraint from already-committed prerequisite stories, not an oversight |
| epics.md camelCase inputs (`vaultUrl`, `apiKey`) | kebab-case (`vault-url`, `api-key`) — D3 | Matches GitHub Actions Marketplace ecosystem convention; a cosmetic alignment, not a behavior change |
| `architecture.md`: GitHub Actions OIDC/JWKS federation (`modules/integrations/github-actions/`) | Not implemented; static API-key flow only — D5 | No code exists for the OIDC design anywhere; both prerequisite stories (7.1/7.2) and epics.md's own Story 7.3 AC commit to the static-key model; OIDC is a materially larger, unscoped feature |
| architecture.md generic error envelope `{ error, message, statusCode, requestId }` | N/A for this story — this package makes no direct HTTP calls of its own; all error handling is against 7.2's already-resolved `{ code, message, details? }` envelope, surfaced via `@project-vault/agent`'s typed error classes | Consistency with 7.1/7.2's identical resolution |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| Package scaffold | New workspace package `packages/vault-action/`; `action.yml` with kebab-case inputs (D3); depends on `@actions/core` + `@project-vault/agent` only (D1). |
| Secrets-mapping parsing | Parses `PROJECT/NAME as ENV_VAR` lines, one per line; rejects malformed lines, duplicate `ENV_VAR` targets (case-insensitive, AC-3), dangerous/reserved `ENV_VAR` targets (safe-identifier regex + denylist, AC-3), and cross-project mixes (case-insensitive UUID comparison, D2/AC-4) before any network call. |
| Retrieval + masking | Calls `@project-vault/agent`'s `getSecret()` once per line (one shared agent/token per invocation); masks every value via `core.setSecret()` on the full value **and** on each non-empty line split by `\n` (AC-6 — required for multi-line secrets like PEM keys, not just a single whole-value call) **before** exporting; exports via `core.exportVariable()`. |
| `continue-on-error` | Default `"false"`: vault-unreachable fails the step. `"true"`: vault-unreachable warns, does not fail. Application-level errors (401/403/404/409) **always** fail regardless (D4). |
| Bundling | `@vercel/ncc`-built, committed `dist/index.js`; CI freshness check (D6) fails the build if `dist/` is stale. |
| Documentation | README covers setup, mapping syntax, multiple secrets, `continue-on-error`, matrix/parallel-job rate-limit considerations, SHA-pinning as a hardened alternative to `@v1`, a complete (automatically YAML-validated) example workflow, and the v1 GitLab CI documented workaround (`curl` + machine-token). |
| Marketplace readiness | Complete `action.yml` (name/description/inputs/outputs/branding); `LICENSE`; a git-tag-based release workflow that re-verifies dist freshness and then moves a mutable `v1` tag, behind required branch-protection review (D7). Actual Marketplace-listing publish is a manual follow-up with a named owner and tracked issue, not an automated AC. |
| Integration tests | GitHub Actions Toolkit test utilities (`@actions/core`'s test helpers / mocked `process.env`/`process.stdout`) cover: successful retrieval + masking (including multi-line values), vault-unreachable + `continue-on-error: true` (warns, does not fail), vault-unreachable + `continue-on-error: false` (fails), reserved-name/case-insensitive validation, and each D2/D4 edge case below. |

---

### AC-1: Package Scaffold and `action.yml` Metadata — Happy Path

**Given** no `packages/vault-action` exists today,
**When** this story is implemented,
**Then** a new workspace package `packages/vault-action/` is created with `package.json` (`"name": "@project-vault/vault-action"`, `"private": true` — it is distributed via `uses: project-vault/vault-action@v1` git-checkout, not npm, so it is never published to the npm registry), depending on `@actions/core` (runtime, pinned `^1.10.0` or later — see minimum-version note below) and `@project-vault/agent` (`workspace:*`, runtime, D1), and `@vercel/ncc`/`typescript`/`vitest` (dev).

**Minimum `@actions/core` version (security requirement, not a style preference):** `@actions/core` **must** be pinned to `^1.10.0` or later. Versions of the toolkit prior to this used a fixed, predictable delimiter when writing multi-line values to the `GITHUB_ENV` environment file (`exportVariable()`'s underlying implementation), which was vulnerable to environment-file-injection if an exported value's content happened to contain that delimiter format — a known GitHub Actions "workflow command injection" vulnerability class. `@actions/core@1.10+` writes each `GITHUB_ENV` entry with a randomized UUID delimiter per call, closing that injection vector. Since this action's entire purpose is exporting arbitrary secret values (attacker-influenceable in content, if not in name) via `core.exportVariable()`, running on a pre-1.10 toolkit would reopen exactly the injection risk this action exists to avoid. Verify the installed version at implementation time and bump the `package.json` dependency range if the current pinned version predates this fix.

**And** `packages/vault-action/action.yml` is a complete GitHub Action metadata file:

```yaml
name: 'Project Vault Action'
description: 'Retrieve secrets from Project Vault and export them as masked environment variables'
author: 'Project Vault'
branding:
  icon: 'lock'
  color: 'blue'
inputs:
  vault-url:
    description: 'Base URL of your Project Vault instance'
    required: true
  api-key:
    description: 'Machine user API key (pk_...) issued via Project Vault'
    required: true
  secrets:
    description: 'One mapping per line: PROJECT_ID/CREDENTIAL_NAME as ENV_VAR_NAME'
    required: true
  continue-on-error:
    description: 'If true, warn (not fail) when the vault is unreachable'
    required: false
    default: 'false'
runs:
  using: 'node24'
  main: 'dist/index.js'
```

**And** every input declared in `action.yml` is read in `src/index.ts` via `core.getInput('vault-url', { required: true })` / etc. — no input is read via raw `process.env.INPUT_*` string-building.

**Edge case — `runs.using` runtime availability:** if the GitHub Actions runner fleet does not yet support `using: 'node24'` at the time this story is implemented (verify against GitHub's current supported runtime list — this could not be confirmed at story-creation time), fall back to `using: 'node20'`; `@project-vault/agent`'s own runtime requirement (Node ≥24 per this repo's root `package.json` `engines`) is a **build-time** constraint for the monorepo, not a hard requirement for the *bundled, ncc-compiled* `dist/index.js` artifact GitHub actually executes — confirm the bundled output runs correctly under whichever `using:` value is chosen, and document the chosen runtime version's rationale in the README. Do not guess silently; flag the final choice in Dev Notes/Completion Notes.

---

### AC-2: Secrets-Mapping Parsing — Single Secret, Happy Path

**Given** the `secrets` input contains exactly one line: `"a1c2d3e4-.../DATABASE_URL as DB_URL"`,
**When** the action parses it,
**Then** it produces one parsed entry: `{ projectId: "a1c2d3e4-...", credentialName: "DATABASE_URL", envVarName: "DB_URL" }`, using a strict regex/split on ` as ` (single space-`as`-single-space, case-sensitive) after first splitting the `PROJECT/NAME` segment on the **first** `/` only (credential names may themselves legitimately contain `/`, matching 7.2 AC-6's slash-containing-name edge case — do not `split('/')` naively and discard extra segments).

**Edge case — trailing/leading whitespace:** given a line with extra spaces (`"  a1c2.../DATABASE_URL   as   DB_URL  "`), the parser trims each line before parsing and normalizes internal whitespace around `as` to exactly one space so the mapping still parses correctly — do not fail on incidental whitespace a human editing YAML is likely to introduce.

**Edge case — blank lines between entries:** given the multiline `secrets` input has blank lines separating mapping lines (a common YAML block-scalar formatting habit), blank lines are silently skipped, not treated as malformed entries.

---

### AC-3: Secrets-Mapping Parsing — Multiple Secrets, One Per Line

**Given** the `secrets` input contains three lines, all sharing the same `PROJECT` segment:

```
a1c2d3e4-.../DATABASE_URL as DB_URL
a1c2d3e4-.../STRIPE_SECRET_KEY as STRIPE_KEY
a1c2d3e4-.../REDIS_URL as REDIS_URL
```

**When** the action parses this input,
**Then** it produces three parsed entries in the same order they appear in the input, and each is retrieved and exported independently (AC-6), in input order — output ordering in workflow logs is deterministic and matches the input's line order, which matters for a human debugging a failed run.

**Edge case — duplicate `ENV_VAR_NAME` targets:** given two lines both map to `... as DB_URL` (even if they reference different credential names), the action fails fast, **before any network call**, with `core.setFailed("Duplicate environment variable target: DB_URL")` — silently letting the second overwrite the first would non-obviously discard one secret's export with no indication in the log of which one "won." **This comparison is case-insensitive** (e.g. `DB_URL` and `db_url` are treated as duplicates and both rejected) regardless of which OS the runner is on — environment variable names are case-insensitive on Windows runners but case-sensitive on Linux/macOS, and a case-sensitive-only duplicate check would let two entries that collide at the OS level on Windows silently pass this action's own validation. Making the check case-insensitive everywhere is simpler than scoping this action's documented support to non-Windows runners, and it never rejects a mapping that would have worked safely, since a genuine cross-case pair is never safe on any runner this action might be used on.

**Edge case — empty `secrets` input:** given `secrets` is an empty string or contains only blank lines, the action fails with `core.setFailed("The 'secrets' input must contain at least one PROJECT/NAME as ENV_VAR mapping")` — an accidentally-empty mapping is a workflow-authoring mistake, not a valid "retrieve nothing" no-op.

**Edge case — dangerous or reserved `ENV_VAR_NAME` target:** given a parsed entry's `envVarName` is not a safe, ordinary environment-variable identifier, the action fails fast, **before any network call**, at the same validation stage and rigor level as the duplicate-target check above. Two checks are applied, in order, to every parsed entry: (1) `envVarName` must match the safe-identifier regex `^[A-Za-z_][A-Za-z0-9_]*$` — anything else (e.g. containing `=`, whitespace, or shell-metacharacters) fails with `core.setFailed("Invalid environment variable target 'NAME': must match ^[A-Za-z_][A-Za-z0-9_]*$")`; (2) `envVarName` (case-insensitively) is checked against a denylist of dangerous/reserved names — `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_OPTIONS`, `HOME`, `SHELL`, `GITHUB_TOKEN`, and any name starting with `GITHUB_` or `ACTIONS_` (GitHub Actions' own reserved namespaces) — a match fails with `core.setFailed("Refusing to export to reserved/dangerous environment variable 'NAME' — this could hijack a later step's execution environment")`. Without this check, a compromised or careless `secrets` mapping could silently overwrite `PATH`/`LD_PRELOAD` for every subsequent step in the job — a real privilege-escalation surface for an action whose entire purpose is exporting values other steps trust.

---

### AC-4: Cross-Project Validation (D2) — Rejects Mixed-Project Mappings Before Any Network Call

**Given** the `secrets` input contains two lines with **different** `PROJECT` segments:

```
a1c2d3e4-.../DATABASE_URL as DB_URL
b5f6a7c8-.../API_TOKEN as API_TOKEN
```

**When** the action parses and validates this input,
**Then** it fails immediately with `core.setFailed("All 'secrets' entries must reference the same project (found: a1c2d3e4-..., b5f6a7c8-...). One vault-action step retrieves secrets from exactly one project — split into multiple steps, each with that project's own api-key, to pull from multiple projects.")` — **zero** `getSecret()` calls are made, even for the entries that would have succeeded; a partial-success-then-fail-on-project-2 outcome would non-obviously export only some of the intended secrets before failing. **This comparison is case-insensitive**: `PROJECT` segments are lowercase-normalized before comparison, so two lines referencing the same UUID that differ only in hex-digit casing (e.g. `A1C2D3E4-...` vs. `a1c2d3e4-...`) are correctly treated as the **same** project, matching Postgres's own case-insensitive `uuid` comparison semantics — a naive case-sensitive string-equality check would produce a false-positive mismatch on a harmless formatting difference a human copy-pasting UUIDs from different sources could easily introduce. The single validated `projectId` passed to `createVaultAgent()` uses the lowercase-normalized form.

**Edge case — malformed `PROJECT` segment (not a UUID-shaped string):** given a line's `PROJECT` segment is `"my-project"` (a human-readable slug, not a UUID) rather than an actual `projectId`, the action does **not** attempt a lenient slug-to-id resolution (no such lookup endpoint exists) — it passes the string through as-is to `createVaultAgent({ projectId })`. This codebase's route-param convention (per 7.1/7.2) validates `:projectId` with a Zod UUID schema, so the expected failure mode is a `422`/`400` validation error from the vault's route-parameter check, **not** a `404` — a malformed, non-UUID string never reaches the "does this project exist" lookup at all; it is rejected at the schema layer first. The action's error handler surfaces this as `core.setFailed("Failed to retrieve secret 'NAME': invalid project identifier — 'PROJECT' must be the project's UUID, not its display name")`, cross-referenced in the README.

**Edge case — single-line input:** given only one `secrets` line exists, the cross-project check trivially passes (a single project value has nothing to conflict with) — do not special-case "only one line" separately from the general N-line comparison; the same "all values equal" check handles both.

---

### AC-5: Authentication — Happy Path via `@project-vault/agent`

**Given** a valid, non-revoked, non-expired `pk_...` API key provided via the `api-key` input, and a reachable `vault-url`,
**When** the action runs,
**Then** it calls `core.setSecret(apiKey)` **immediately** upon reading the input (before any logging, before any other action code runs) so the key is masked in logs from the earliest possible point, then constructs exactly one `createVaultAgent({ apiKey, baseUrl: vaultUrl, projectId })` instance (D2 — one agent per invocation, reused across all parsed entries) — 7.2's package internally performs the token exchange (`POST /api/v1/auth/machine-token`) on first `getSecret()` call.

**Edge case — invalid/revoked/expired key:** given the API key is invalid, revoked, or expired (7.2's `401 invalid_api_key`, indistinguishable by design per 7.2 AC-3), `@project-vault/agent`'s first `getSecret()` call throws a `VaultAgentError`; this action's error handler catches it and calls `core.setFailed("Failed to retrieve secret 'DATABASE_URL': invalid or revoked API key. Check that the api-key input is current and has not been revoked.")` — the underlying 7.2 error code (`invalid_api_key`) is surfaced in the message for debuggability, but the action never attempts to distinguish "invalid" from "revoked" from "expired" itself (7.2's server deliberately does not distinguish these either, to avoid leaking key-lifecycle information).

**Edge case — malformed `api-key` (does not start with `pk_`):** the action does not pre-validate the `pk_` prefix client-side before calling the agent — it lets `@project-vault/agent`/7.2's server-side check reject it (cheap, pre-DB rejection per 7.2 AC-3), avoiding a second, potentially-drifting validation rule living in two places.

---

### AC-6: Secret Retrieval and Masking — Happy Path

**Given** the cross-project validation (AC-4) has passed and a valid agent is constructed (AC-5),
**When** the action processes the parsed entry `{ projectId, credentialName: "DATABASE_URL", envVarName: "DB_URL" }`,
**Then** it calls `agent.getSecret("DATABASE_URL")`, and on success: (1) calls `core.setSecret(value)` **first**, then splits `value` on `\n` and calls `core.setSecret(line)` for each non-empty line (see the multi-line edge case below — a single whole-value call alone does not reliably mask every line of a multi-line secret in subsequent log output) — registering the value for masking in **all** subsequent log output for the remainder of the job, including output from steps that run *after* this one; (2) only then calls `core.exportVariable("DB_URL", value)`, making it available as `$DB_URL`/`${{ env.DB_URL }}` to every subsequent step in the job.

**And** if the action itself ever logs the parsed mapping for debugging (`core.debug()`/`core.info()`), it logs `credentialName`/`envVarName`/`projectId` only — **never** the retrieved value, at any log level, even `core.debug()` (debug logs are visible to anyone with `ACTIONS_STEP_DEBUG` enabled on the repo and must not become a value-leak side channel).

**Edge case — value containing a literal newline (e.g. a PEM private key or multi-line JSON secret):** GitHub Actions' masking engine matches on a per-log-line basis — a single `core.setSecret()` call over the whole multi-line string reliably masks the **entire** string as one contiguous match, but does **not** reliably mask each individual line of that value if a later log line happens to emit only a fragment (e.g. a tool that echoes the value one line at a time). Therefore, for **every** retrieved value, before it is ever exported or could be logged: (1) call `core.setSecret(value)` once on the full value (covers the common case and any log line that reproduces the value verbatim), **and** (2) split the value on `\n` and call `core.setSecret(line)` once per non-empty line (covers the multi-line-value-emitted-piecemeal case) — do this for every entry regardless of whether the value visibly contains a newline, since the check is cheap and uniform. A value containing a substring identical to another already-masked secret's value is masked automatically as a side effect once both values (and their lines) have been registered — no extra handling needed for that sub-case. Add a test asserting `core.setSecret` is invoked (once for the full value, once per non-empty line) before `core.exportVariable`, for every entry, not just the first.

**Edge case — empty-string secret value:** given a credential's current value is legitimately an empty string, the action still exports it (`core.exportVariable("DB_URL", "")`) rather than treating an empty value as an error — an empty secret is a valid (if unusual) stored value, not a retrieval failure; do not skip masking for it either (`core.setSecret("")` is a harmless no-op per the Actions toolkit's own behavior).

---

### AC-7: Vault Unreachable — `continue-on-error: false` (Default) — Fails the Step

**Given** `continue-on-error` is omitted (defaults to `"false"` per `action.yml`, D4),
**When** `agent.getSecret()` throws because the vault could not be reached at all (connection refused/timeout/DNS failure) **and** no usable offline-cache entry exists for that credential name,
**Then** the action still attempts every remaining parsed entry (per D4's clarifying note — a vault-unreachable failure never short-circuits the run) and, once all entries have been attempted, calls `core.setFailed("Failed to retrieve secret 'DATABASE_URL': vault at https://vault.example.com is unreachable")` (or the AC-9-style multi-failure summary if more than one entry failed), the step is marked `failure`, and the workflow's default `continue-on-error` behavior (a GitHub-native job-level setting, distinct from this action's own input of the same name — see the naming-collision note below) determines whether subsequent steps run.

**Naming-collision note (must be documented in the README, AC-14):** GitHub Actions workflows have their **own** native `continue-on-error:` step-level YAML key, unrelated to this action's `continue-on-error` **input**. A user who sets the workflow-native `continue-on-error: true` on the step invoking this action gets GitHub's own "don't fail the job even if this step fails" behavior regardless of what this action's `continue-on-error` input says — the two are independent, easily-confused mechanisms with the same name. The README must explicitly disambiguate them with a worked example of each.

**Edge case — explicit `continue-on-error: "false"` (not just omitted):** identical behavior to the default — the input is parsed via `core.getBooleanInput('continue-on-error')` (Actions Toolkit's strict boolean parser, which accepts only `'true'`/`'false'`/`'True'`/`'False'`/`'TRUE'`/`'FALSE'` and throws on anything else, e.g. `'yes'`) so a typo'd value fails loudly at input-parsing time rather than being silently coerced to a default.

**Edge case — a typo'd `continue-on-error` value (e.g. `"yes"`):** `core.getBooleanInput()`'s throw on an unrecognized string is **caught** by this action's own top-level error handling and converted into a clean `core.setFailed("Invalid 'continue-on-error' value 'yes' — must be 'true' or 'false'")`, consistent with every other carefully-scripted error message in this action — it is never allowed to propagate as an unhandled exception with a raw Node stack trace in the workflow log, which would be a jarring, unhelpful failure mode for what is just a workflow-authoring typo.

---

### AC-8: Vault Unreachable — `continue-on-error: true` — Warns, Does Not Fail

**Given** `continue-on-error: true` is set on this action's input,
**When** `agent.getSecret()` throws the same vault-unreachable condition as AC-7,
**Then** the action calls `core.warning("Failed to retrieve secret 'DATABASE_URL': vault at https://vault.example.com is unreachable — continuing because continue-on-error is true")` and proceeds to the **next** parsed entry (it does not abort the whole run on the first unreachable failure) — the action's own exit is still a success (`process.exitCode` not set to failure), so the step and job continue exactly as if nothing had failed, and `$DB_URL` is simply **not set** for that one entry (subsequent steps referencing `$DB_URL` see an unset/empty variable, which the README must call out as an expected side effect the workflow author is responsible for handling, e.g. via a fallback default in their own script).

**Edge case — mixed outcomes within one invocation:** given the `secrets` input has three entries and the vault becomes unreachable partway through (e.g., transient network blip during the second `getSecret()` call), with `continue-on-error: true`, the first entry (already succeeded) is exported and masked, the second is warned-and-skipped, and the action still attempts the third — each entry's outcome is independent; one entry's transient failure does not abort processing of the remaining entries when `continue-on-error: true`.

**Edge case — sustained (non-transient) vault outage across many entries:** given the `secrets` input has many entries (e.g. ten) and the vault is genuinely down for the whole invocation (not a one-off transient blip), the action does **not** independently retry a live network call for every remaining entry once vault-unreachable has already been established — after the **first** entry's `getSecret()` call is classified as vault-unreachable (and no offline-cache entry served it), the action short-circuits: every subsequent entry is recorded with the same vault-unreachable failure reason without attempting its own network round-trip (unless that entry has its own usable offline-cache hit, which is still checked per-entry since cache freshness can differ by credential). This bounds the outage's total time cost to roughly one connection attempt's worth of latency regardless of how many lines are in `secrets`, instead of multiplying it by entry count — a real CI-cost concern this action's own design (fail fast or warn fast) is supposed to avoid.

**Edge case — application-level error under `continue-on-error: true`:** given the vault **is** reachable but returns `404 credential_not_found` for one entry, the action still calls `core.setFailed()` for that condition regardless of `continue-on-error` (D4) — `continue-on-error` only softens *vault-unreachable* failures, never application-level ones; add a test asserting this distinction explicitly (a `continue-on-error: true` run with a typo'd credential name must still fail the step).

---

### AC-9: Application-Level Errors — Not Found, Ambiguous Name, Insufficient Scope

**Given** the vault is reachable and returns 7.2's `404 credential_not_found` for one parsed entry,
**When** this happens,
**Then** the action calls `core.setFailed("Failed to retrieve secret 'DATABASE_URL': credential not found in project a1c2d3e4-...")` — this failure is **not** subject to `continue-on-error` (D4; see AC-8's edge case) regardless of the input's value.

**And**, given the vault returns 7.2's `409 ambiguous_credential_name` (two credentials share the requested name in the target project — 7.2 D6),
**when** this happens,
**then** the action calls `core.setFailed("Failed to retrieve secret 'API_KEY': multiple credentials share this name in the project — machine-user retrieval requires unique names. Rename one of the duplicates in Project Vault before using it with vault-action.")` — surfacing 7.2's exact remediation guidance rather than a generic error.

**And**, given the vault returns 7.2's `403 insufficient_role` (the API key's scoped project does not match, or the machine user's role is otherwise insufficient),
**when** this happens,
**then** the action calls `core.setFailed("Failed to retrieve secret 'DATABASE_URL': the provided api-key is not authorized for project a1c2d3e4-...")`.

**Edge case — first entry fails, later entries would have succeeded:** given three entries and the first one 404s, the action still attempts entries 2 and 3 (collecting all failures rather than stopping at the first) so a single run's log shows the **complete** set of problems in one pass, then calls `core.setFailed()` once at the end summarizing all entries that failed (e.g., `"1 of 3 secrets failed to retrieve: DATABASE_URL (not found)"`) — this gives a workflow author fixing multiple typos in one edit-and-rerun cycle instead of one-error-per-run whack-a-mole. Entries that *succeeded* before a later entry's failure are still masked and exported (their env vars remain usable in later steps even though the overall step is marked failed) — a partial success is still useful to a debugging developer, and GitHub Actions itself allows subsequent steps to inspect `${{ steps.<id>.outcome }}` if they need to react to the partial-failure state.

**Reason-vocabulary consistency (applies to every summary above and in AC-7/AC-8):** the terse per-entry reason token used in a summary line (`(not found)`, `(ambiguous name)`, `(insufficient scope)`, `(vault unreachable)`, `(invalid api-key)`) maps 1:1 to the verbose per-entry `core.setFailed()`/`core.warning()` message this same entry would have produced on its own (`"credential not found in project ..."` → `not found`; `"multiple credentials share this name..."` → `ambiguous name`; `"the provided api-key is not authorized for project ..."` → `insufficient scope`; `"vault at ... is unreachable"` → `vault unreachable`; `"invalid or revoked API key..."` → `invalid api-key`) — the summary never invents a separate shorthand vocabulary disconnected from the individual messages, so an implementer and a test-writer reading either the per-entry or summary example independently arrive at the same expected strings.

---

### AC-10: `api-key` Masking Precedes All Other Action Behavior

**Given** the action starts running with a valid `api-key` input,
**When** `main()` begins execution,
**Then** the very first statement of substance in `src/index.ts`'s entry point is `core.setSecret(core.getInput('api-key', { required: true }))` — before parsing `secrets`, before any `core.info()` call, before constructing the agent. This ordering is asserted by a unit test that intercepts `core.info`/`core.debug`/`core.warning` calls made during a simulated run and confirms none of them could have logged the raw key value before masking was registered (a regression here would leak the key into logs on any early-exit error path added by a future edit).

**Edge case — the agent's own internal error messages happen to embed the api key string** (e.g., a hypothetical future version of `@project-vault/agent` includes the key in a thrown error's `.message` for debugging): because `core.setSecret()` was already called before the agent was ever constructed, GitHub's masking engine redacts the key from **any** subsequent log line regardless of which code path produced it — this is exactly why masking-first (not "mask only around the specific retrieval call") is the required ordering.

---

### AC-11: Bundling and `dist/index.js` Freshness (D6)

**Given** `packages/vault-action/src/index.ts` (and any files it imports) have been edited,
**When** `pnpm --filter vault-action build` is run,
**Then** `@vercel/ncc` compiles the package into a single `dist/index.js` (plus `dist/index.js.map` and any licenses file `ncc` emits), and this output **is committed to git** — unlike every other package's `dist/`, which is `.gitignore`d.

**And** a new script `scripts/check-vault-action-dist-fresh.ts` (registered as `pnpm check-vault-action-dist` at the repo root, and as a new step in `.github/workflows/ci.yml`'s `quality-gates` job) rebuilds `packages/vault-action` into a temporary directory and byte-compares the result against the committed `packages/vault-action/dist/index.js`; on any diff, it exits non-zero with `"packages/vault-action/dist/index.js is stale — run 'pnpm --filter vault-action build' and commit the result"`.

**Edge case — a contributor edits `src/` but forgets to rebuild before committing:** the freshness check (above) fails CI on that PR — this is the intended catch, mirroring the existing `generate-spec`/`openapi.json` freshness discipline (`turbo.json`'s `typecheck` task already `dependsOn: ["generate-spec"]`) applied to a second, structurally-similar "committed generated artifact" case in this repo.

**Edge case — non-deterministic build output (e.g., embedded timestamps or absolute paths from `ncc`):** if `ncc`'s default output embeds anything non-reproducible (verify this against the installed `@vercel/ncc` version before relying on a byte-for-byte diff), the freshness check instead compares a normalized form (e.g., strip source-map comments, or compare `dist/index.js`'s executable content while ignoring `dist/index.js.map`) — do not ship a flaky CI check that fails on a clean rebuild with no source changes; verify this empirically during implementation and document whichever comparison strategy is actually reliable.

**Review ergonomics — the committed `dist/index.js` diff:** since this is the only package in the monorepo with a large generated file tracked in git and reviewed on every PR touching `packages/vault-action/src`, add a `.gitattributes` entry marking `packages/vault-action/dist/index.js` (and its `.map` file) `linguist-generated=true` — this collapses the diff by default in GitHub's PR review UI (and equivalent tooling that respects the `linguist-generated` convention), so reviewers aren't asked to eyeball a multi-thousand-line bundled diff on every source change; the freshness check (above) remains the actual correctness gate, this is purely a review-ergonomics improvement for a pattern that's novel in this repo.

---

### AC-12: Integration Tests — GitHub Actions Toolkit Test Utilities

**Given** `packages/vault-action`'s test suite,
**When** tests run (`pnpm --filter vault-action test`, via `vitest`),
**Then** the following scenarios are covered using mocked `@actions/core` (via `vi.mock('@actions/core')` or the equivalent, intercepting `getInput`/`getBooleanInput`/`setSecret`/`exportVariable`/`setFailed`/`warning`/`info`/`debug`) and a mocked `@project-vault/agent` (`vi.mock('@project-vault/agent')`, since this package's own tests must not make real HTTP calls against a live vault):

1. Successful single-secret retrieval: `setSecret` called with the value before `exportVariable`; `setFailed`/`warning` never called.
2. Successful multi-secret retrieval (AC-3): all three entries exported in input order.
3. Vault unreachable, `continue-on-error: false` (default, AC-7): `setFailed` called, `warning` never called.
4. Vault unreachable, `continue-on-error: true` (AC-8): `warning` called, `setFailed` never called, remaining entries still attempted.
5. Mixed vault-unreachable-then-application-error under `continue-on-error: true` (AC-8's edge case): the application-level error still calls `setFailed` even though the vault-unreachable one only warned.
6. Cross-project mismatch (AC-4): `setFailed` called with the project-mismatch message; the mocked agent constructor/`getSecret` is asserted **never called** (zero network attempts).
7. Duplicate `ENV_VAR_NAME` targets (AC-3's edge case): `setFailed` called before any retrieval attempt.
8. `api-key` masked before any other `core.*` call (AC-10): assert call-order via mock call sequence inspection.
9. Malformed `secrets` line (missing ` as `, empty input): `setFailed` called with a parsing-specific message, distinct from a retrieval-failure message.
10. Partial-failure summary (AC-9's edge case): given entry 1 fails (404) and entries 2-3 succeed, all three are attempted, entries 2-3 are exported/masked, and the final `setFailed` call's message names entry 1 specifically.
11. Dangerous/reserved `ENV_VAR_NAME` target (AC-3's edge case): a mapping targeting `PATH`, `LD_PRELOAD`, or a `GITHUB_`-prefixed name is rejected by `setFailed` before any network call; a valid ordinary identifier is not rejected.
12. Case-insensitive duplicate/cross-project detection: `DB_URL` and `db_url` targets are treated as a duplicate (AC-3); `PROJECT` segments differing only in hex-digit casing are treated as the same project, not a mismatch (AC-4).
13. Multi-line secret masking (AC-6's edge case): given a mocked `getSecret()` value containing embedded `\n` characters, assert `core.setSecret` is called once with the full value **and** once per non-empty line, all before `core.exportVariable`.
14. Typo'd `continue-on-error` value (AC-7's edge case): `core.getBooleanInput`'s throw for an unrecognized string is caught and converted into a single clean `core.setFailed()` call, not an unhandled exception.

**Edge case — real end-to-end smoke test:** in addition to the mocked-unit-test suite above, add **one** `apps/api` integration test (in the existing `withTestOrg` integration-test harness, since it can spin up a real API server + database) that: creates a machine user + API key (7.1), imports `@project-vault/agent` directly (not through `packages/vault-action`, since the Action's own entry point is designed to run inside the GitHub Actions runtime, not a generic test harness) and calls `getSecret()` against the real running test API — this proves the underlying flow this action wraps actually works end-to-end, complementing (not replacing) `packages/vault-action`'s own mocked unit tests, which verify the Action-specific wiring (masking order, `continue-on-error` semantics, cross-project validation) in isolation.

---

### AC-13: README — Required Content

**Given** `packages/vault-action/README.md`,
**When** it is written,
**Then** it documents, at minimum: (1) setup — how to create a machine user + API key (cross-referencing Story 7.1's endpoints) and store it as a GitHub encrypted secret; (2) the exact `uses: project-vault/vault-action@v1` workflow step syntax with all four inputs (`vault-url`, `api-key`, `secrets`, `continue-on-error`); (3) the secret-mapping syntax `PROJECT_ID/CREDENTIAL_NAME as ENV_VAR_NAME`, including the one-project-per-step constraint (D2) and a worked example of splitting a two-project need into two steps; (4) multiple secrets, one per line, using a YAML block scalar (`|`); (5) the `continue-on-error` input **and** the naming-collision disambiguation from GitHub's own native step-level `continue-on-error:` key (AC-7); (6) a complete, copy-pasteable example workflow file; (7) a callout for **matrix/parallel-job builds**: a GitHub Actions matrix build with many parallel jobs, each invoking `vault-action` with the same shared machine-user API key, causes a burst of concurrent token-exchange calls against that one key — note 7.2's per-`keyHash` and IP-based rate limits as a consideration for wide matrices, and recommend keeping matrix fan-out modest or staggering job starts if a very large matrix is used against a single api-key.

**And** the example workflow is syntactically valid GitHub Actions YAML — this is **required**, not optional: add an automated test that extracts the README's embedded example-workflow code block and asserts it parses as valid YAML (e.g. via a plain YAML parser in the package's own test suite). A manual-verification substitute is not acceptable here — per the Product Surface Contract, this README example is explicitly called out as the actual "UI" a developer interacts with for this story, and leaving its correctness to an undocumented-cadence manual check is too weak a guarantee for the single most user-facing artifact this story produces.

**Edge case — README drift from `action.yml`:** if a future edit adds/removes/renames an `action.yml` input without updating the README, there is no automated catch for this in-scope for this story (documented as a known gap, not fixed here) — flag in Dev Notes as a good candidate for a future lightweight doc-sync check, matching the spirit of D6's freshness-check pattern, but out of scope to build now.

---

### AC-14: README — GitLab CI v1 Documentation (v2 Scope Boundary)

**Given** epics.md `AC-E7a` scopes native GitLab CI integration to v2,
**When** the README is written,
**Then** it includes a "GitLab CI" section stating plainly that a native GitLab CI component is not yet available (v2), and documents the v1 workaround: a `curl`-based `before_script` snippet that (1) `POST`s to `$VAULT_URL/api/v1/auth/machine-token` with `Authorization: Bearer $VAULT_API_KEY` to obtain a machine JWT, (2) `GET`s `$VAULT_URL/api/v1/machine/projects/$PROJECT_ID/credentials/$NAME/value` with the JWT, (3) extracts `.data.value` via `jq`, and (4) exports it via GitLab CI's own `export VAR=value >> "$GITLAB_ENV"` masking-aware mechanism — cross-referencing GitLab's own masked-variable documentation for the caller to configure masking on their end (this action's Node-based masking mechanism, `core.setSecret()`, is GitHub-Actions-specific and has no GitLab equivalent this story can ship).

**Edge case — someone copies the GitLab snippet verbatim without configuring GitLab's own masking:** the README's snippet includes an explicit warning comment (`# IMPORTANT: mark VAR as masked in GitLab CI/CD variable settings, or configure this job's output masking — this snippet does not mask the value for you`) — do not let a copy-pasted example silently produce unmasked secrets in GitLab job logs.

---

### AC-15: `action.yml` and Package Marketplace-Readiness (D7)

**Given** `packages/vault-action/action.yml` and its supporting files,
**When** reviewed for Marketplace-publish readiness,
**Then** all of the following are present and complete: `name`, `description`, `author`, `branding.icon`/`branding.color` (both required by GitHub for Marketplace listing), every `inputs.*.description`, and a repository-root (or package-level, per GitHub's actual requirement — confirm at implementation time) `LICENSE` file consistent with the rest of this monorepo's licensing.

**And** `.github/workflows/vault-action-release.yml` (new file, D7) triggers on tag push matching `vault-action-v*`, runs `pnpm --filter vault-action build && pnpm --filter vault-action test` as a gate, **re-runs `scripts/check-vault-action-dist-fresh.ts` (the same dist-freshness check `ci.yml` already enforces, AC-11) against the tagged ref before moving any tag**, and only on success force-moves the mutable major-version tag (e.g., pushing `vault-action-v1.2.0` moves `vault-action-v1` to point at the same commit) — mirroring the well-known Marketplace-actions convention (`actions/checkout@v4` resolving a mutable `v4` tag) so consumers can pin `uses: project-vault/vault-action@v1` and transparently receive non-breaking patch/minor updates. **Why the freshness re-check is required here too, not just in `ci.yml`:** `ci.yml`'s freshness gate runs at PR time, but nothing stops a tag from later being pushed against a commit where `dist/` had drifted from `src/` (e.g., a manual commit that bypassed PR review, or a rebase that dropped the freshness-passing commit) — without re-running the same check at tag-push time, the release workflow would build and test an *ephemeral* rebuild that is never actually compared against the `dist/index.js` **committed at that tag**, i.e. the exact file GitHub Actions executes for every consumer. Re-running the freshness check here closes that gap: a stale-`dist/` tag fails the release workflow and the mutable tag is never moved.

**Edge case — a `vault-action-v2.0.0` tag (breaking change) is pushed:** the release workflow moves `vault-action-v2`, **not** `vault-action-v1` — a major-version bump must never silently move the tag existing consumers are pinned to; verify the workflow's tag-parsing step correctly extracts the major version from the pushed tag and only force-moves the matching major tag.

**Supply-chain hardening (D7):** the README documents SHA-pinning (`uses: project-vault/vault-action@<full-commit-sha>`) as the recommended alternative to `@v1` for security-conscious consumers who want to avoid trusting a mutable tag; and the `vault-action-release.yml` workflow file plus the branch it releases from are required to sit behind this repo's standard branch-protection/required-review settings, so moving the `v1` tag always traces back to a reviewed change, not a unilateral push — see D7 for the full rationale.

**Manual follow-up (not an automated AC — cannot be tested in CI):** once this story's code is merged and the first `vault-action-v1.0.0` tag is pushed, a human with `project-vault` GitHub-org-owner permissions must manually visit the repository's Releases page and click "Publish this Action to the Marketplace." This is tracked, not just noted in passing: Completion Notes must name an explicit owner (the individual or role responsible for clicking publish) and reference a tracked issue/ticket for the manual publish step, so the follow-up has an accountable owner and a place to be marked done — "recorded in Completion Notes" alone, with no named owner or ticket, is not sufficient tracking for a step that otherwise has no automated enforcement.

---

## Tasks / Subtasks

- [x] **Task 1: Package scaffold** (AC-1) — `packages/vault-action/package.json`, `tsconfig.json`, `action.yml`; confirm `pnpm-workspace.yaml` auto-discovers it with no config changes.
- [x] **Task 2: Secrets-mapping parser** (D2, AC-2 to AC-4) — `src/parse-secrets.ts`: line-splitting, `PROJECT/NAME as ENV_VAR` regex, case-insensitive duplicate-`ENV_VAR` detection, dangerous/reserved `ENV_VAR_NAME` validation (safe-identifier regex + denylist), case-insensitive (lowercase-normalized) cross-project validation, all with zero network calls (pure function, easy to unit test in isolation).
- [x] **Task 3: Agent wiring + masking** (D1, AC-5, AC-6, AC-10) — `src/index.ts` entry point: `core.setSecret(apiKey)` first; construct one `createVaultAgent()`; wrap each network call with a fixed 10s `AbortController` timeout; loop over parsed entries calling `getSecret()`, `setSecret()` (full value + each non-empty line for multi-line secrets), `exportVariable()` in that order.
- [x] **Task 4: Error handling and `continue-on-error`** (D4, AC-7 to AC-9) — distinguish vault-unreachable (soft, if `continue-on-error: true`) from application-level errors (always hard-fail); always attempt every entry regardless of `continue-on-error`; short-circuit remaining network attempts once vault-unreachable is established for the run; catch a typo'd `continue-on-error` boolean-parse throw and convert to `core.setFailed()`; collect all entries' outcomes before a single final `setFailed()`/`warning()` summarizing every failure using reason tokens that map 1:1 to the per-entry messages (AC-9's edge case).
- [x] **Task 5: Bundling + freshness check** (D6, AC-11) — add `@vercel/ncc` build script; commit `dist/`; write `scripts/check-vault-action-dist-fresh.ts`; wire into `.github/workflows/ci.yml`; add a `.gitattributes` `linguist-generated` entry for the committed `dist/`.
- [x] **Task 6: Unit + integration tests** (AC-12) — mocked `@actions/core`/`@project-vault/agent` test suite covering all 14 listed scenarios; one real end-to-end `apps/api` integration test using `@project-vault/agent` directly against a live test server.
- [x] **Task 7: README** (AC-13, AC-14) — setup, syntax, multiple-secrets example, `continue-on-error` disambiguation, matrix/parallel-job rate-limit callout, SHA-pinning guidance, a complete example workflow with an automated YAML-validity test, GitLab CI v1 documented workaround.
- [x] **Task 8: Marketplace readiness + release workflow** (D7, AC-15) — complete `action.yml` branding/licensing fields; `.github/workflows/vault-action-release.yml` (build/test gate + re-run of the dist-freshness check at the tagged ref + mutable major-tag move), gated by required branch-protection review; record the manual Marketplace-publish-click follow-up in Completion Notes with a named owner and a tracked issue/ticket.

---

## Dev Notes

- This story's **highest-risk decision** is D2 (cross-project validation) — it is a real, user-facing scope boundary (one `vault-action` step = one project) that a workflow author unfamiliar with 7.1's machine-user model could easily hit; get the pre-flight validation (AC-4) and its error message right, since it is the primary thing standing between "confusing partial failure" and "clear, actionable guidance" for that user.
- Do **not** add `@actions/http-client` as a dependency (D1) even though epics.md's literal text mentions it — `@project-vault/agent` already owns all HTTP/retry/auth logic; a second HTTP client with no call sites would be dead weight and a maintenance trap.
- Do **not** attempt to build the `architecture.md`-described GitHub OIDC/JWKS federation flow in this story (D5) — no prerequisite code for it exists, and both 7.1/7.2 (already `ready-for-dev`) and epics.md's own Story 7.3 AC commit to the static-API-key model instead. Flag OIDC as a v2 idea in the README's Roadmap section only.
- `packages/vault-action/dist/` is the **only** `dist/` directory in this monorepo that is committed to git (D6) — do not let a future contributor "clean up" and `.gitignore` it; that would silently break every consumer pinned to `uses: project-vault/vault-action@v1`, since GitHub Actions runs the committed file directly with no install step.
- **Open question (escalate, don't silently resolve):** whether GitHub's currently-supported Actions runtime list includes `using: 'node24'` at the time this story is implemented could not be confirmed at story-creation time (AC-1's edge case) — verify against GitHub's current documentation before finalizing `action.yml`, and fall back to `using: 'node20'` if `node24` is unavailable; document the actual choice made in Completion Notes.
- **Open question:** the actual "click publish on the GitHub Marketplace" step (D7/AC-15) requires `project-vault` GitHub-org-owner permissions no automated pipeline in this story has — this is a genuine manual follow-up, not something to be resolved or worked around in code. Per AC-15, this must be recorded in Completion Notes with a **named owner** and a **linked tracked issue/ticket**, not just a bare action-item bullet — "record in Completion Notes" alone has no enforcement mechanism, so the named-owner + ticket requirement is what actually prevents this from silently falling through once the story is marked complete.
- The offline-fallback-cache behavior described in Story 7.2 (activating after repeated connection failures within a rolling 30-second window) is largely orthogonal to this story's needs — a GitHub Actions runner is ephemeral and single-shot, so the cache provides limited benefit across separate workflow runs, but it is not harmful either, and this story does not disable or special-case it; `@project-vault/agent`'s existing fallback behavior (7.2 AC-11) applies unmodified inside a single action invocation's retries.
- **Known technical debt: no cross-release sync process for the bundled cache-crypto code.** 7.2's D11 already documents that `packages/agent/src/cache-crypto.ts` deliberately duplicates (rather than imports) `packages/crypto/src/aes.ts`'s AES-256-GCM algorithm, to keep `@project-vault/agent` independently publishable. This story now bundles that same duplicated crypto code into a **third**, independently-versioned artifact — the committed `packages/vault-action/dist/index.js`. If a future security fix is applied to `packages/agent`'s cache-crypto (e.g., an IV-reuse or auth-tag bug), nothing in this story's tooling ties that upstream patch to a mandatory `vault-action` rebuild + re-tag + release — the dist-freshness check (AC-11/D6) only catches `packages/vault-action/src/` drifting from its own committed `dist/`, it does **not** detect that a transitively-bundled dependency (`@project-vault/agent`) changed upstream and needs a re-bundle. Until a cross-package dependency-change-detection mechanism exists (out of scope here), a security fix to `packages/agent`'s crypto requires a human to remember to manually trigger a `vault-action` rebuild/re-tag/release — flag this explicitly during any future `packages/agent` cache-crypto change.

### Project Structure Notes

- New top-level workspace package: `packages/vault-action/` (`src/index.ts`, `src/parse-secrets.ts`, `action.yml`, committed `dist/index.js` — the only committed `dist/` in the monorepo).
- New root-level script: `scripts/check-vault-action-dist-fresh.ts`, wired into `.github/workflows/ci.yml`'s existing `quality-gates` job as an additional step.
- New workflow file: `.github/workflows/vault-action-release.yml` — the first release/tag-based workflow in this repo (existing workflows are `ci.yml`/`nightly.yml` only, both push/PR/schedule-triggered, not tag-triggered).
- No changes to `apps/api`, `apps/web`, or any existing package's schema, routes, or migrations — this story is additive-only at the monorepo-workspace level.
- No detected conflicts with other `ready-for-dev`/`backlog` stories at the time this story was created — 7.1/7.2 are the direct package/API dependency (see Prerequisites); this story touches no file either of them owns.

### References

- Epics AC: [Source: `_bmad-output/planning-artifacts/epics.md#Story-7.3` (lines 1830-1855)]
- Epic 7 preamble / blockers (AC-E7a integration-depth scope boundary): [Source: `_bmad-output/planning-artifacts/epics.md` lines 1752-1765]
- PRD: [Source: `_bmad-output/planning-artifacts/prd.md` FR39 (line 916)]
- Architecture — aspirational GitHub Actions OIDC module (D5, not implemented): [Source: `_bmad-output/planning-artifacts/architecture.md` lines 1044-1052, 1292-1293]
- Architecture — release/GHCR mention (`release.yml`, does not exist yet, D7): [Source: `_bmad-output/planning-artifacts/architecture.md` line 466]
- Story 7.2 (hard dependency — `@project-vault/agent` public API, D1/D2 inherited): [Source: `_bmad-output/implementation-artifacts/7-2-machine-user-authentication-and-programmatic-secret-retrieval.md`, especially D11, AC-2, AC-3, AC-6, AC-7, AC-10 through AC-15]
- Story 7.1 (machine-user-scoped-to-one-project model, D2's basis): [Source: `_bmad-output/implementation-artifacts/7-1-machine-user-identity-and-api-key-management.md`, especially D1-D4]
- Existing committed-generated-artifact CI freshness precedent (D6): `turbo.json`'s `typecheck` task `dependsOn: ["generate-spec"]`; `packages/shared/openapi.json`
- Existing CI workflow to extend (D6): `.github/workflows/ci.yml` (confirmed: only `ci.yml`/`nightly.yml` exist at story-creation time — no `release.yml`)
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

---

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.6

### Debug Log References

- `pnpm --filter @project-vault/vault-action test` (vitest + v8 coverage) — 77 tests passing across `parse-secrets.test.ts`, `run.test.ts`, `classify.test.ts`, `with-timeout.test.ts`, `index.test.ts`, `readme-example.test.ts`; coverage 94.5%/85.4%/100%/96.2% (stmts/branch/func/line), above the package's 80% gate on all four axes.
- `pnpm --filter @project-vault/vault-action typecheck` / `lint` — clean (lint: 0 errors, 3 pre-existing-style `security/*` heuristic warnings, same tolerance level as the rest of the repo).
- `pnpm tsx scripts/check-vault-action-dist-fresh.ts` — manually verified both the "fresh" (OK) and "stale" (non-zero exit, itemized diff) paths by temporarily appending a stray line to the committed `dist/index.js` and re-running.
- Empirically verified `ncc` build reproducibility: ran `pnpm --filter vault-action build` twice back-to-back and byte-diffed the two `dist/` outputs — zero differences (no embedded timestamps/absolute paths); `dist/index.js`/`dist/index.js.map` both use ncc's relative-path source-map `sources` entries.
- Real end-to-end AC-12 smoke test: `pnpm --filter @project-vault/api exec vitest run src/modules/machine-users/vault-action-agent-e2e.test.ts` against a live `make db-up` + `make db-migrate` Postgres instance — 2/2 passing; full `apps/api/src/modules/machine-users` suite re-run afterward (9 files, 83 tests) to confirm no regressions from the new `app.listen()`-based harness pattern.
- `pnpm turbo typecheck` / `pnpm turbo test` (filtered to `@project-vault/vault-action` and `@project-vault/agent`) — confirmed the new `turbo.json` `"@project-vault/vault-action#typecheck": {"dependsOn": ["^build"]}` override correctly materializes `@project-vault/agent`'s `dist/` before `vault-action` typechecks (this is the first in-monorepo consumer of `@project-vault/agent`'s built output — no prior package exercised this dependency edge).
- YAML-validity of both new/edited GitHub Actions workflow files (`ci.yml`, `vault-action-release.yml`) verified via the `yaml` package's `parse()`.

### Completion Notes List

- **Package scaffold (AC-1):** `packages/vault-action` created with `"private": true`, `@actions/core@^1.11.1` (satisfies the `^1.10.0`+ minimum-version security requirement — the installed npm registry's highest 1.x release), `@project-vault/agent: workspace:*`, dev deps `@vercel/ncc`, `typescript`, `vitest`, `yaml` (for the README YAML-validity test). `action.yml` matches the story's spec verbatim.
- **Runtime choice (AC-1 edge case, escalated per Dev Notes):** verified via web search that GitHub's Actions runner fleet fully supports `using: 'node24'` as of this story's implementation date (2026-07-05) — GitHub's own changelog states runners begin defaulting to Node 24 on 2026-06-16 with full migration in fall 2026, and `node20` is being deprecated. `action.yml` uses `runs.using: 'node24'` (not the `node20` fallback).
- **Secrets-mapping parser (AC-2–AC-4):** `src/parse-secrets.ts` is a pure, zero-network function. Handles first-`/`-only splitting, whitespace normalization around ` as `, blank-line skipping, case-insensitive duplicate-`ENV_VAR` detection, the safe-identifier regex + reserved-name denylist (exact names + `GITHUB_`/`ACTIONS_` prefixes), and case-insensitive (lowercase-normalized) cross-project validation. 25 unit tests.
- **Agent wiring + masking (AC-5, AC-6, AC-10):** `src/run.ts` masks `api-key` as the first statement of substance, constructs exactly one `createVaultAgent({ apiKey, baseUrl, projectId, fallbackThreshold: 1 })` per invocation, and for every entry: `withTimeout()`-wraps `getSecret()` (10s fixed `AbortController` deadline, `src/with-timeout.ts`), masks the full value **and** each non-empty line before `exportVariable()`.
- **`fallbackThreshold: 1` design decision (not explicitly specified by the story, but directly implements AC-8's "sustained outage" edge case):** rather than reimplementing "stop attempting live network calls after the first vault-unreachable classification" inside `vault-action`, the agent is constructed with `fallbackThreshold: 1`, which makes 7.2's own already-shipped fallback-state machine (`packages/agent/src/fallback-state.ts`) trip into cache-only mode after exactly one consecutive network failure — reusing existing, already-tested logic instead of duplicating it, per this story's own Dev Notes guidance ("do not duplicate agent's already-built logic").
- **Error classification (D4, AC-7–AC-9):** `src/classify.ts` classifies `VaultAgentError` codes into "vault unreachable" (`vault_unreachable`, `vault_unreachable_non_cacheable`, `cache_expired`, `cache_decryption_failed`, `cache_corrupted`, plus this package's own `vault_action_timeout`) vs. always-hard-fail application-level codes. **Deviation from the story's literal error-code names, per the story's own "actual shipped API wins" directive:** 7.2's shipped `@project-vault/agent` does not have a distinct `invalid_api_key` code — an invalid/revoked/expired key surfaces as `token_exchange_failed` from `exchangeToken()`'s generic `!res.ok` branch. `classify.ts` maps `token_exchange_failed` to the exact AC-5-specified user message ("invalid or revoked API key..."). Also: `run.ts` collects both failure classes independently across all entries and reports them as two separate final calls (a vault-unreachable summary via `setFailed`/`warning` per `continue-on-error`, and an application-level summary always via `setFailed`) — single-failure classes render the verbose per-entry message directly; 2+ failures in a class render the terse `"N of M secrets failed to retrieve: NAME (reason), ..."` form, per AC-9.
- **AC-4's "non-UUID PROJECT segment" edge case:** since the shipped agent has no dedicated error code for a route-param validation failure, `classify.ts` detects this client-side (the projectId's shape is already known locally) and only applies the "invalid project identifier" message when the generic/unrecognized `VaultAgentError` code coincides with a non-UUID-shaped project id — documented as a pragmatic adaptation, not a literal implementation of an agent-side code that doesn't exist.
- **Bundling + freshness (AC-11):** `pnpm --filter vault-action build` runs `ncc build src/index.ts -o dist --minify=false --source-map --license licenses.txt`. `tsconfig.json` sets `declaration: false` (ncc's TS loader otherwise whole-program-emits stray `.d.ts` for every file in the program, including `*.test.ts`, into `dist/` — not desired for a bundled, non-published action package). `scripts/check-vault-action-dist-fresh.ts` rebuilds into an OS temp dir and does a full recursive byte-for-byte directory comparison (empirically verified reproducible, including `.map` — see Debug Log). Wired into `.github/workflows/ci.yml`'s `quality-gates` job as `pnpm check-vault-action-dist`. `.gitattributes` marks `packages/vault-action/dist/**` `linguist-generated=true`; `.gitignore` gets an explicit negation for `packages/vault-action/dist/` (the one exception to the repo-wide `dist/` ignore rule).
- **First in-monorepo consumer of `@project-vault/agent`'s built output (infra fix, not in the story's literal task list but required for CI to actually work):** added `"@project-vault/vault-action#typecheck": {"dependsOn": ["^build"]}` to `turbo.json` so `pnpm turbo typecheck` builds `@project-vault/agent` before typechecking `vault-action` (the global `"test"` task already had `dependsOn: ["^build"]`, so `pnpm turbo test` needed no change). Flagging this because no other package previously exercised this dependency edge.
- **Tests (AC-12):** 68 mocked unit tests across `packages/vault-action/src/*.test.ts` cover all 14 AC-12 scenarios plus the AC-4/AC-5/AC-6/AC-9 edge cases (empty-value export, multi-line masking order, `fallbackThreshold: 1` wiring, timeout behavior via fake timers). One real end-to-end test file, `apps/api/src/modules/machine-users/vault-action-agent-e2e.test.ts`, boots a real listening Fastify server (`app.listen({ port: 0 })`) and drives `@project-vault/agent` directly (not through `packages/vault-action`) against it — proves the real machine-token-exchange + credential-value HTTP round trip this action wraps. `apps/api`'s narrow `FastifyApp` test-harness type only exposes `listen(): Promise<string>` (no `.server` accessor), so the test uses that returned address string directly rather than introspecting a raw `net.Server`.
- **README (AC-13, AC-14):** covers setup, the four inputs, mapping syntax + the D2 one-project-per-step constraint (with a worked two-step example), multiple secrets via a block scalar, the `continue-on-error` naming-collision disambiguation (both mechanisms shown side-by-side), the fixed 10s timeout, the matrix/parallel-job rate-limit callout (referencing 7.2's 10-attempts/60s per-key-hash limit), SHA-pinning guidance, a complete example workflow, and the GitLab CI v1 `curl` workaround with an explicit masking warning comment. `src/readme-example.test.ts` extracts every fenced ` ```yaml ` block from the README and (a) asserts each parses as valid YAML, (b) asserts the complete example workflow has a valid top-level GitHub Actions shape and a `vault-action` step with all three required inputs, (c) asserts specific required-content strings are present (D2 wording, naming-collision wording, SHA-pinning, matrix/rate-limit, GitLab CI) — this is the **mandatory automated check** AC-13 requires (not the optional "manual verification" fallback the story allows).
- **Marketplace readiness + release workflow (D7, AC-15):** `action.yml` already has `branding`, `author`, per-input `description`. No new `LICENSE` file was added — the existing repository-root `LICENSE` (AGPLv3) already satisfies GitHub's repository-level Marketplace requirement and is explicitly the "consistent with the rest of this monorepo's licensing" choice AC-15 calls for. New `.github/workflows/vault-action-release.yml` triggers on `vault-action-v*` tag pushes, builds+tests `packages/vault-action` (and its `@project-vault/agent` dependency, via `pnpm --filter "@project-vault/vault-action..." build`), **re-runs `pnpm check-vault-action-dist` against the tagged ref** (closing the gap the adversarial review flagged — a fresh, never-compared rebuild would not have caught a stale `dist/` committed at the tag), then force-moves the parsed major-version tag (e.g. `vault-action-v1`) via `git tag -f`/`push --force`, refusing to move the wrong major tag if the pushed tag's major version differs. README documents SHA-pinning as the hardened `@v1`-alternative.
- **Manual follow-up — NOT fully satisfiable from this development session (flagged, not silently resolved):** AC-15 requires the Marketplace-publish-click follow-up to be recorded with a **named owner** and a **linked tracked issue/ticket**. This session has no access to create a real GitHub issue against the `project-vault` org, nor a specific named individual to assign. **Action required before this story can be considered fully done per AC-15's letter:** whoever merges this PR must (1) file a tracked issue titled e.g. "Publish vault-action v1.0.0 to GitHub Marketplace" in the `project-vault` repository, (2) assign it to a named individual holding `project-vault` GitHub-org-owner permissions, and (3) reference that issue number here. This is called out explicitly as an incomplete/deferred sub-item of Task 8, not silently marked done.
- **Operational requirement flagged, not enforced by this code (D7):** `vault-action-release.yml` and the branch it releases from must sit behind this repo's standard branch-protection/required-review settings so the mutable `v1` tag can only move via a reviewed change — this is a repo/GitHub-settings configuration step outside what any workflow YAML can self-enforce. Documented in the workflow file's header comment and in the README; needs manual verification by a repo admin.
- **Deviation — D1's "AbortController timeout ... per underlying network attempt":** `@project-vault/agent`'s `getSecret()` does not accept an external `AbortSignal` (its internal `fetch()` calls are not cancellable from outside), so `withTimeout()` races the *entire* `getSecret()` call (which may itself perform an internal token-exchange fetch plus a credential fetch) against one 10s deadline, rather than bounding each internal `fetch()` independently. A timed-out call cannot cancel the underlying in-flight `fetch()` (it becomes an orphaned promise) — functionally equivalent to a connection-refused classification for the workflow's purposes, but not a true socket-level abort. Documented in code comments in `src/with-timeout.ts`.
- **Known, accepted transitive dependency risk (flagged, not fixed here):** `pnpm audit --audit-level=high` reports several high-severity advisories against `undici@<6.24.0`, pulled in transitively via `@actions/core → @actions/http-client` (used internally by `@actions/core` for its OIDC `getIDToken()` helper, which this action does not call). This is a widely-known, accepted characteristic of the `@actions/toolkit` ecosystem generally, not something introduced by a choice this story made beyond depending on `@actions/core` itself (a hard D1 requirement). `ci.yml`'s `pnpm audit --audit-level=high` step already has `continue-on-error: true` for exactly this class of noisy transitive advisory, so this does not fail CI; flagged here for visibility rather than attempting a risky forced `undici` version override that could destabilize `@actions/core`'s bundled OIDC code path during the `ncc` build.

### File List

**New:**
- `packages/vault-action/package.json`
- `packages/vault-action/tsconfig.json`
- `packages/vault-action/eslint.config.js`
- `packages/vault-action/vitest.config.ts`
- `packages/vault-action/action.yml`
- `packages/vault-action/README.md`
- `packages/vault-action/src/index.ts`
- `packages/vault-action/src/index.test.ts`
- `packages/vault-action/src/run.ts`
- `packages/vault-action/src/run.test.ts`
- `packages/vault-action/src/parse-secrets.ts`
- `packages/vault-action/src/parse-secrets.test.ts`
- `packages/vault-action/src/classify.ts`
- `packages/vault-action/src/classify.test.ts`
- `packages/vault-action/src/with-timeout.ts`
- `packages/vault-action/src/with-timeout.test.ts`
- `packages/vault-action/src/readme-example.test.ts`
- `packages/vault-action/dist/index.js` (committed generated artifact, D6 — the only tracked `dist/` in the monorepo)
- `packages/vault-action/dist/index.js.map`
- `packages/vault-action/dist/licenses.txt`
- `packages/vault-action/dist/package.json`
- `packages/vault-action/dist/sourcemap-register.cjs`
- `scripts/check-vault-action-dist-fresh.ts`
- `scripts/check-vault-action-dist-fresh.test.ts`
- `.github/workflows/vault-action-release.yml`
- `.gitattributes`
- `apps/api/src/modules/machine-users/vault-action-agent-e2e.test.ts`

**Modified:**
- `.github/workflows/ci.yml` (new `pnpm check-vault-action-dist` step in `quality-gates`)
- `.gitignore` (negation for `packages/vault-action/dist/`)
- `package.json` (new `check-vault-action-dist` script)
- `pnpm-lock.yaml` (new dependencies)
- `turbo.json` (new `@project-vault/vault-action#typecheck` task override)
