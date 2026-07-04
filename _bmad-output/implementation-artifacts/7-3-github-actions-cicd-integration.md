# Story 7.3: GitHub Actions CI/CD Integration

Status: ready-for-dev

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
| **No CI release pipeline exists today** (confirmed: `.github/workflows/` contains only `ci.yml` and `nightly.yml`; `architecture.md`'s mention of a `release.yml` "on merge to main" for GHCR publishing does not exist in the repo at story-creation time) | This story must add its own minimal release workflow for **tagging** the action (D7/AC-16) — it is not reusing an existing release pipeline, because none exists yet for any purpose in this repo. |
| Turborepo auto-discovers new `packages/*` workspaces | `packages/vault-action` needs no `turbo.json`/`pnpm-workspace.yaml` changes — confirmed via `pnpm-workspace.yaml`'s `packages: ["apps/*", "packages/*"]` glob. |

---

## Key Design Decisions & Open Questions

**Read this section before writing any code.** These resolve concrete conflicts between epics.md's literal Story 7.3 wording, `architecture.md`'s aspirational design, and Stories 7.1/7.2's own explicit handoffs — the same resolution discipline Stories 4.1, 7.1, and 7.2 established: actually-committed prerequisite-story contracts win over an epics.md AC's literal-but-unshipped spec, and an aspirational architecture-doc design with zero shipped code loses to the design the prerequisite stories already committed to.

### D1 — Runtime HTTP dependency: `@project-vault/agent` only, **not** `@actions/http-client`

- epics.md (`epics.md:1844`) says the action "uses `@actions/core` and `@actions/http-client`."
- **Prerequisite reality:** 7.2's `@project-vault/agent` (D11 of that story) already implements the entire HTTP surface this action needs — token exchange, credential-by-name retrieval, typed errors, and (optionally) the offline cache — using Node's built-in global `fetch` internally, not `@actions/http-client`. 7.1's own cross-story-context row for this story states plainly: *"The published action authenticates using a `pk_...` key issued by this story's `POST .../api-keys` endpoint, via 7.2's token exchange"* — i.e., through the package, not a hand-rolled HTTP call.
- **Decision implemented in this story:** `packages/vault-action` depends on `@actions/core` (input parsing, masking, logging, `setFailed`) and `@project-vault/agent` (`workspace:*`, all vault I/O) — it does **not** add `@actions/http-client` as a dependency. Re-implementing HTTP calls against 7.2's endpoints directly, in parallel with the already-built agent package, would be exactly the "reinventing the wheel" anti-pattern this workflow's guardrails exist to prevent. `@project-vault/agent`'s workspace dependency is resolved and bundled at build time (D6) — it does not need to be published to npm for this story to consume it, even though 7.2 separately made it externally publishable for its own reasons.

### D2 — Secrets-mapping syntax: `PROJECT` segment is the target `projectId`, and all lines in one invocation must resolve to the **same** project

- epics.md's literal input shape is `secrets: "PROJECT/CREDENTIAL_NAME as ENV_VAR_NAME"` with no separate `projectId` input.
- **The conflict:** 7.1's machine-user model scopes exactly **one** project per API key/machine user (`POST /api/v1/projects/:projectId/machine-users`); 7.2's machine JWT carries a single `scope: projectId` claim fixed at machine-user-creation time, not something a caller can vary per request (7.2 AC-7: a JWT's `scope` not matching the URL's `:projectId` returns `403`). This means a single `api-key` input to this action can only ever retrieve secrets from **one** project, no matter how the `secrets` mapping string is structured.
- **Decision implemented in this story:** the `PROJECT` segment of each `secrets` line is parsed as the `projectId` (UUID) that line targets. Before making **any** network call, the action validates that every parsed line's `PROJECT` segment is identical across the whole `secrets` input. If two or more distinct `PROJECT` values are found, the action fails immediately (`core.setFailed`, no partial retrieval attempted) with a message instructing the caller to split the request into multiple `vault-action` steps, one per project, each with that project's own `api-key`. This is a genuine, surfaced scope boundary — not a bug — and is documented in the README (AC-14).
- The single validated `projectId` (from the first parsed line) is passed to `createVaultAgent({ apiKey, baseUrl, projectId })` once per action invocation; all `getSecret()` calls in that invocation reuse the same agent instance (one token exchange, not one per secret).

### D3 — Action inputs use idiomatic kebab-case ids, not epics.md's literal camelCase

- epics.md writes the inputs as `vaultUrl`, `apiKey`, `secrets`. GitHub Actions' own convention (and the vast majority of Marketplace actions, e.g. `actions/checkout`, `actions/setup-node`) uses lowercase-hyphenated `with:` keys.
- **Decision implemented in this story:** `action.yml` declares inputs `vault-url`, `api-key`, `secrets`, `continue-on-error` (see D4) — read via `core.getInput('vault-url')` etc. This is purely a naming-convention alignment with the ecosystem this action is published into; it changes no behavior epics.md's AC describes. Cross-referenced in the README and in this story's ACs using the kebab-case names throughout.

### D4 — `continueOnError` scope: only vault-unreachable (network-level) failures are soft; application-level errors (404/409/403/401) always fail the step

- epics.md (`epics.md:1846`): *"if the vault is unreachable and `continueOnError: true` is set, the action warns but does not fail the workflow; if `continueOnError: false` (default), it fails the step."*
- **Decision implemented in this story:** `continue-on-error` (input, default `"false"`) governs exactly one failure class: `@project-vault/agent` throwing because the vault could not be reached at all (connection refused/timeout/DNS failure — the same network-level condition 7.2's agent already distinguishes from an HTTP error response, see 7.2 AC-11) **and** no usable offline cache entry exists for that name either. It does **not** soften any application-level error the vault *did* successfully respond with: an invalid/expired/revoked API key (`401`), a not-found credential (`404`), an ambiguous name (`409`), or a cross-project/role failure (`403`) always calls `core.setFailed()` regardless of `continue-on-error` — these are configuration mistakes in the workflow itself, not transient vault unavailability, and silently warning past them would mask a broken pipeline (e.g., a typo'd credential name silently producing an empty, unmasked env var).

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
- **Decision implemented in this story:** deliver everything mechanically required (complete `action.yml`, README, `LICENSE` reference, branding fields) and add a minimal `.github/workflows/vault-action-release.yml` that, on a `vault-action-v*` tag push, builds/tests `packages/vault-action`, then creates/moves the major-version convenience tag (`v1` → the new patch tag, matching `actions/checkout`'s own well-known "mutable major tag" convention via `actions/publish-action` or an equivalent `git tag -f v1 && git push -f origin v1` step). The actual Marketplace-listing button click is called out explicitly as a manual follow-up in this story's Dev Notes and Completion Notes — do not attempt to script it away as if it were CI-automatable; it is not.

---

## Epic Cross-Story Context

| Story | Relationship to 7.3 |
|---|---|
| 7.1 (Machine User Identity & API Key Management, `ready-for-dev`) | Provides the `pk_...` API key format this action's `api-key` input accepts, issued via 7.1's `POST .../api-keys`. No direct code dependency — 7.3 never touches 7.1's routes or schema directly, only via 7.2's package. |
| 7.2 (Machine User Authentication & Programmatic Secret Retrieval, `ready-for-dev`) | **Hard dependency.** This story's entire runtime is `@project-vault/agent` (7.2's package) plus a thin CLI/Actions-runner wrapper. Do not duplicate token-exchange, retry, or offline-cache logic here — call the package's exported functions/methods exactly as 7.2 ships them. |
| Epic 8 (Compliance/Audit, `backlog`) | No new audit code in this story — every credential access this action performs already flows through 7.2's existing `credential.value_revealed` audit write (`actorType: 'machine_user'`). Nothing for Epic 8 to change because of this story. |
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
| Secrets-mapping parsing | Parses `PROJECT/NAME as ENV_VAR` lines, one per line; rejects malformed lines, duplicate `ENV_VAR` targets, and cross-project mixes (D2) before any network call. |
| Retrieval + masking | Calls `@project-vault/agent`'s `getSecret()` once per line (one shared agent/token per invocation); masks every value via `core.setSecret()` **before** exporting; exports via `core.exportVariable()`. |
| `continue-on-error` | Default `"false"`: vault-unreachable fails the step. `"true"`: vault-unreachable warns, does not fail. Application-level errors (401/403/404/409) **always** fail regardless (D4). |
| Bundling | `@vercel/ncc`-built, committed `dist/index.js`; CI freshness check (D6) fails the build if `dist/` is stale. |
| Documentation | README covers setup, mapping syntax, multiple secrets, `continue-on-error`, a complete example workflow, and the v1 GitLab CI documented workaround (`curl` + machine-token). |
| Marketplace readiness | Complete `action.yml` (name/description/inputs/outputs/branding); `LICENSE`; a git-tag-based release workflow that moves a mutable `v1` tag (D7). Actual Marketplace-listing publish is a manual follow-up, not an automated AC. |
| Integration tests | GitHub Actions Toolkit test utilities (`@actions/core`'s test helpers / mocked `process.env`/`process.stdout`) cover: successful retrieval + masking, vault-unreachable + `continue-on-error: true` (warns, does not fail), vault-unreachable + `continue-on-error: false` (fails), and each D2/D4 edge case below. |

---

### AC-1: Package Scaffold and `action.yml` Metadata — Happy Path

**Given** no `packages/vault-action` exists today,
**When** this story is implemented,
**Then** a new workspace package `packages/vault-action/` is created with `package.json` (`"name": "@project-vault/vault-action"`, `"private": true` — it is distributed via `uses: project-vault/vault-action@v1` git-checkout, not npm, so it is never published to the npm registry), depending on `@actions/core` (runtime) and `@project-vault/agent` (`workspace:*`, runtime, D1), and `@vercel/ncc`/`typescript`/`vitest` (dev).

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

**Edge case — duplicate `ENV_VAR_NAME` targets:** given two lines both map to `... as DB_URL` (even if they reference different credential names), the action fails fast, **before any network call**, with `core.setFailed("Duplicate environment variable target: DB_URL")` — silently letting the second overwrite the first would non-obviously discard one secret's export with no indication in the log of which one "won."

**Edge case — empty `secrets` input:** given `secrets` is an empty string or contains only blank lines, the action fails with `core.setFailed("The 'secrets' input must contain at least one PROJECT/NAME as ENV_VAR mapping")` — an accidentally-empty mapping is a workflow-authoring mistake, not a valid "retrieve nothing" no-op.

---

### AC-4: Cross-Project Validation (D2) — Rejects Mixed-Project Mappings Before Any Network Call

**Given** the `secrets` input contains two lines with **different** `PROJECT` segments:

```
a1c2d3e4-.../DATABASE_URL as DB_URL
b5f6a7c8-.../API_TOKEN as API_TOKEN
```

**When** the action parses and validates this input,
**Then** it fails immediately with `core.setFailed("All 'secrets' entries must reference the same project (found: a1c2d3e4-..., b5f6a7c8-...). One vault-action step retrieves secrets from exactly one project — split into multiple steps, each with that project's own api-key, to pull from multiple projects.")` — **zero** `getSecret()` calls are made, even for the entries that would have succeeded; a partial-success-then-fail-on-project-2 outcome would non-obviously export only some of the intended secrets before failing.

**Edge case — malformed `PROJECT` segment (not a UUID-shaped string):** given a line's `PROJECT` segment is `"my-project"` (a human-readable slug, not a UUID) rather than an actual `projectId`, the action does **not** attempt a lenient slug-to-id resolution (no such lookup endpoint exists) — it passes the string through as-is to `createVaultAgent({ projectId })`, and the resulting `getSecret()` call fails with whatever 7.2's `@project-vault/agent` throws for an unresolvable/malformed project scope (surfaced via AC-9's not-found handling), with an action-level error message clarifying that `PROJECT` must be the project's UUID, not its display name, cross-referenced in the README.

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
**Then** it calls `agent.getSecret("DATABASE_URL")`, and on success: (1) calls `core.setSecret(value)` **first** — registering the value for masking in **all** subsequent log output for the remainder of the job, including output from steps that run *after* this one; (2) only then calls `core.exportVariable("DB_URL", value)`, making it available as `$DB_URL`/`${{ env.DB_URL }}` to every subsequent step in the job.

**And** if the action itself ever logs the parsed mapping for debugging (`core.debug()`/`core.info()`), it logs `credentialName`/`envVarName`/`projectId` only — **never** the retrieved value, at any log level, even `core.debug()` (debug logs are visible to anyone with `ACTIONS_STEP_DEBUG` enabled on the repo and must not become a value-leak side channel).

**Edge case — value containing characters that could break masking:** given a secret value containing a literal newline or a substring identical to another already-masked secret's value (e.g., two different secrets that happen to share the same value in a test fixture), `core.setSecret()` is called once per distinct value in the order retrieved — GitHub's masking engine is a straightforward substring replacement over subsequent log lines and requires no special handling from this action beyond calling `setSecret()` before any code path that could log the value; add a test asserting `core.setSecret` is invoked before `core.exportVariable` for every entry, not just the first.

**Edge case — empty-string secret value:** given a credential's current value is legitimately an empty string, the action still exports it (`core.exportVariable("DB_URL", "")`) rather than treating an empty value as an error — an empty secret is a valid (if unusual) stored value, not a retrieval failure; do not skip masking for it either (`core.setSecret("")` is a harmless no-op per the Actions toolkit's own behavior).

---

### AC-7: Vault Unreachable — `continue-on-error: false` (Default) — Fails the Step

**Given** `continue-on-error` is omitted (defaults to `"false"` per `action.yml`, D4),
**When** `agent.getSecret()` throws because the vault could not be reached at all (connection refused/timeout/DNS failure) **and** no usable offline-cache entry exists for that credential name,
**Then** the action calls `core.setFailed("Failed to retrieve secret 'DATABASE_URL': vault at https://vault.example.com is unreachable")`, the step is marked `failure`, and the workflow's default `continue-on-error` behavior (a GitHub-native job-level setting, distinct from this action's own input of the same name — see the naming-collision note below) determines whether subsequent steps run.

**Naming-collision note (must be documented in the README, AC-14):** GitHub Actions workflows have their **own** native `continue-on-error:` step-level YAML key, unrelated to this action's `continue-on-error` **input**. A user who sets the workflow-native `continue-on-error: true` on the step invoking this action gets GitHub's own "don't fail the job even if this step fails" behavior regardless of what this action's `continue-on-error` input says — the two are independent, easily-confused mechanisms with the same name. The README must explicitly disambiguate them with a worked example of each.

**Edge case — explicit `continue-on-error: "false"` (not just omitted):** identical behavior to the default — the input is parsed via `core.getBooleanInput('continue-on-error')` (Actions Toolkit's strict boolean parser, which accepts only `'true'`/`'false'`/`'True'`/`'False'`/`'TRUE'`/`'FALSE'` and throws on anything else, e.g. `'yes'`) so a typo'd value fails loudly at input-parsing time rather than being silently coerced to a default.

---

### AC-8: Vault Unreachable — `continue-on-error: true` — Warns, Does Not Fail

**Given** `continue-on-error: true` is set on this action's input,
**When** `agent.getSecret()` throws the same vault-unreachable condition as AC-7,
**Then** the action calls `core.warning("Failed to retrieve secret 'DATABASE_URL': vault at https://vault.example.com is unreachable — continuing because continue-on-error is true")` and proceeds to the **next** parsed entry (it does not abort the whole run on the first unreachable failure) — the action's own exit is still a success (`process.exitCode` not set to failure), so the step and job continue exactly as if nothing had failed, and `$DB_URL` is simply **not set** for that one entry (subsequent steps referencing `$DB_URL` see an unset/empty variable, which the README must call out as an expected side effect the workflow author is responsible for handling, e.g. via a fallback default in their own script).

**Edge case — mixed outcomes within one invocation:** given the `secrets` input has three entries and the vault becomes unreachable partway through (e.g., transient network blip during the second `getSecret()` call), with `continue-on-error: true`, the first entry (already succeeded) is exported and masked, the second is warned-and-skipped, and the action still attempts the third — each entry's outcome is independent; one entry's transient failure does not abort processing of the remaining entries when `continue-on-error: true`.

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

**Edge case — real end-to-end smoke test:** in addition to the mocked-unit-test suite above, add **one** `apps/api` integration test (in the existing `withTestOrg` integration-test harness, since it can spin up a real API server + database) that: creates a machine user + API key (7.1), imports `@project-vault/agent` directly (not through `packages/vault-action`, since the Action's own entry point is designed to run inside the GitHub Actions runtime, not a generic test harness) and calls `getSecret()` against the real running test API — this proves the underlying flow this action wraps actually works end-to-end, complementing (not replacing) `packages/vault-action`'s own mocked unit tests, which verify the Action-specific wiring (masking order, `continue-on-error` semantics, cross-project validation) in isolation.

---

### AC-13: README — Required Content

**Given** `packages/vault-action/README.md`,
**When** it is written,
**Then** it documents, at minimum: (1) setup — how to create a machine user + API key (cross-referencing Story 7.1's endpoints) and store it as a GitHub encrypted secret; (2) the exact `uses: project-vault/vault-action@v1` workflow step syntax with all four inputs (`vault-url`, `api-key`, `secrets`, `continue-on-error`); (3) the secret-mapping syntax `PROJECT_ID/CREDENTIAL_NAME as ENV_VAR_NAME`, including the one-project-per-step constraint (D2) and a worked example of splitting a two-project need into two steps; (4) multiple secrets, one per line, using a YAML block scalar (`|`); (5) the `continue-on-error` input **and** the naming-collision disambiguation from GitHub's own native step-level `continue-on-error:` key (AC-7); (6) a complete, copy-pasteable example workflow file.

**And** the example workflow is syntactically valid GitHub Actions YAML — add a test (or a documented manual verification step, if YAML-linting the README's embedded code block is judged too heavy for this story) confirming it parses as valid workflow YAML, so the README's central example is never silently broken by an unrelated edit.

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

**And** `.github/workflows/vault-action-release.yml` (new file, D7) triggers on tag push matching `vault-action-v*`, runs `pnpm --filter vault-action build && pnpm --filter vault-action test` as a gate, and on success force-moves the mutable major-version tag (e.g., pushing `vault-action-v1.2.0` moves `vault-action-v1` to point at the same commit) — mirroring the well-known Marketplace-actions convention (`actions/checkout@v4` resolving a mutable `v4` tag) so consumers can pin `uses: project-vault/vault-action@v1` and transparently receive non-breaking patch/minor updates.

**Edge case — a `vault-action-v2.0.0` tag (breaking change) is pushed:** the release workflow moves `vault-action-v2`, **not** `vault-action-v1` — a major-version bump must never silently move the tag existing consumers are pinned to; verify the workflow's tag-parsing step correctly extracts the major version from the pushed tag and only force-moves the matching major tag.

**Manual follow-up (not an automated AC — cannot be tested in CI):** once this story's code is merged and the first `vault-action-v1.0.0` tag is pushed, a human with `project-vault` GitHub-org-owner permissions must manually visit the repository's Releases page and click "Publish this Action to the Marketplace" — record this as an explicit Completion Notes action item, not a checked-off AC.

---

## Tasks / Subtasks

- [ ] **Task 1: Package scaffold** (AC-1) — `packages/vault-action/package.json`, `tsconfig.json`, `action.yml`; confirm `pnpm-workspace.yaml` auto-discovers it with no config changes.
- [ ] **Task 2: Secrets-mapping parser** (D2, AC-2 to AC-4) — `src/parse-secrets.ts`: line-splitting, `PROJECT/NAME as ENV_VAR` regex, duplicate-`ENV_VAR` detection, cross-project validation, all with zero network calls (pure function, easy to unit test in isolation).
- [ ] **Task 3: Agent wiring + masking** (D1, AC-5, AC-6, AC-10) — `src/index.ts` entry point: `core.setSecret(apiKey)` first; construct one `createVaultAgent()`; loop over parsed entries calling `getSecret()`, `setSecret()`, `exportVariable()` in that order.
- [ ] **Task 4: Error handling and `continue-on-error`** (D4, AC-7 to AC-9) — distinguish vault-unreachable (soft, if `continue-on-error: true`) from application-level errors (always hard-fail); collect all entries' outcomes before a single final `setFailed()` summarizing every failure (AC-9's edge case).
- [ ] **Task 5: Bundling + freshness check** (D6, AC-11) — add `@vercel/ncc` build script; commit `dist/`; write `scripts/check-vault-action-dist-fresh.ts`; wire into `.github/workflows/ci.yml`.
- [ ] **Task 6: Unit + integration tests** (AC-12) — mocked `@actions/core`/`@project-vault/agent` test suite covering all 10 listed scenarios; one real end-to-end `apps/api` integration test using `@project-vault/agent` directly against a live test server.
- [ ] **Task 7: README** (AC-13, AC-14) — setup, syntax, multiple-secrets example, `continue-on-error` disambiguation, complete example workflow, GitLab CI v1 documented workaround.
- [ ] **Task 8: Marketplace readiness + release workflow** (D7, AC-15) — complete `action.yml` branding/licensing fields; `.github/workflows/vault-action-release.yml` (build/test gate + mutable major-tag move); record the manual Marketplace-publish-click follow-up in Completion Notes.

---

## Dev Notes

- This story's **highest-risk decision** is D2 (cross-project validation) — it is a real, user-facing scope boundary (one `vault-action` step = one project) that a workflow author unfamiliar with 7.1's machine-user model could easily hit; get the pre-flight validation (AC-4) and its error message right, since it is the primary thing standing between "confusing partial failure" and "clear, actionable guidance" for that user.
- Do **not** add `@actions/http-client` as a dependency (D1) even though epics.md's literal text mentions it — `@project-vault/agent` already owns all HTTP/retry/auth logic; a second HTTP client with no call sites would be dead weight and a maintenance trap.
- Do **not** attempt to build the `architecture.md`-described GitHub OIDC/JWKS federation flow in this story (D5) — no prerequisite code for it exists, and both 7.1/7.2 (already `ready-for-dev`) and epics.md's own Story 7.3 AC commit to the static-API-key model instead. Flag OIDC as a v2 idea in the README's Roadmap section only.
- `packages/vault-action/dist/` is the **only** `dist/` directory in this monorepo that is committed to git (D6) — do not let a future contributor "clean up" and `.gitignore` it; that would silently break every consumer pinned to `uses: project-vault/vault-action@v1`, since GitHub Actions runs the committed file directly with no install step.
- **Open question (escalate, don't silently resolve):** whether GitHub's currently-supported Actions runtime list includes `using: 'node24'` at the time this story is implemented could not be confirmed at story-creation time (AC-1's edge case) — verify against GitHub's current documentation before finalizing `action.yml`, and fall back to `using: 'node20'` if `node24` is unavailable; document the actual choice made in Completion Notes.
- **Open question:** the actual "click publish on the GitHub Marketplace" step (D7/AC-15) requires `project-vault` GitHub-org-owner permissions no automated pipeline in this story has — this is a genuine manual follow-up, not something to be resolved or worked around in code; record it explicitly as a Completion Notes action item so it is not silently forgotten.
- The offline-fallback-cache behavior described in Story 7.2 (activating after repeated connection failures within a rolling 30-second window) is largely orthogonal to this story's needs — a GitHub Actions runner is ephemeral and single-shot, so the cache provides limited benefit across separate workflow runs, but it is not harmful either, and this story does not disable or special-case it; `@project-vault/agent`'s existing fallback behavior (7.2 AC-11) applies unmodified inside a single action invocation's retries.

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

### Completion Notes List

### File List
