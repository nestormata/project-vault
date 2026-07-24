# Story 14.1: Define and Publish the Extension API Package

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer building an extension for Project Vault (starting with the founder's own private SaaS package),
I want a versioned, typed Extension API package with capability negotiation,
so that my extension registers hooks against a stable contract and gets a clear failure instead of silent breakage when core's extension surface changes.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `none` |
| **Evaluator-visible** | no |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | N/A — this story ships a standalone, unconsumed workspace package (types + hook contracts + capability-negotiation logic only). Nothing in `apps/api` or `apps/web` imports or wires it up yet — that begins in Story 14.2 (loader) and 14.3 (auth strategy dispatch). No self-hosted operator, org user, or evaluator sees any behavior change from this story alone: `GET /health`, login, and every existing route are byte-for-byte unaffected. Rationale for `none` rather than `api`: this is a library contract for third-party extension *authors* (starting with the founder's own private SaaS package), not a product surface Project Vault's own users interact with directly. |

### Persona journey stub

N/A — see rationale above. There is no in-app or API user journey to exercise; the only "consumer" of this story's deliverable is a future extension package (Story 14.2+) importing `@project-vault/extension-api`.

## Acceptance Criteria

1. **Package scaffold exists with the required exports.**
   Given the monorepo workspace, when `packages/extension-api` is created, then it exports `defineExtension()`, `registerExtension(manifest: ExtensionManifest, hooksFactory: () => ExtensionHooks)`, and an `EXTENSION_API_VERSION` semver constant from the package root (`@project-vault/extension-api`).

2. **Hook interfaces are typed and re-exported from the root only.**
   It exports typed hook interfaces `AuthStrategy`, `NotificationChannel`, `UIPanel` from `src/hooks/`, all re-exported from `src/index.ts` — an extension author's only import path is `@project-vault/extension-api`, never a `hooks/` subpath directly (e.g. never `@project-vault/extension-api/hooks/auth-strategy`).

3. **Hook methods are Promise-typed.**
   Every hook interface method (`onAuthenticate`, `onNotify`, `onRenderPanel`) is typed as returning `Promise<T>`. A hook method typed to return a non-Promise value must fail TypeScript compilation — verify with a `// @ts-expect-error` fixture test (or equivalent negative type test) asserting the non-Promise shape is rejected; a positive-only test suite would not actually prove this AC.

4. **Compatible manifest passes capability negotiation and the hooks are wired.**
   Given an extension manifest declaring `apiVersion: "^1.2.0"` and core's `EXTENSION_API_VERSION` is `"1.3.0"`, when `registerExtension(manifest, hooksFactory)` is called, then `semver.satisfies(EXTENSION_API_VERSION, manifest.apiVersion)` (via the `semver` npm package — not hand-rolled range parsing) passes, `hooksFactory()` is invoked, and its returned hooks are accepted (returned/stored — this story has no `apps/api` wiring to assert against yet, so "accepted" means `registerExtension()` returns successfully and the hooks it received are inspectable by the caller, e.g. via a return value or an in-memory registry this package itself owns).

5. **Incompatible manifest fails the gate before any extension code runs.**
   Given an extension manifest declaring `apiVersion: "^2.0.0"` against the same core version (`"1.3.0"`), when `registerExtension()` is called, then the semver check fails, `registerExtension()` throws synchronously with a typed `ExtensionRegistrationError` whose `reason` field is `"incompatible-version"`, and **`hooksFactory` is never invoked** — assert this directly (e.g. a spy/mock on `hooksFactory` with zero calls), not just that the function throws. Zero extension code executes. Prerelease core versions (e.g. core `EXTENSION_API_VERSION` of `"1.3.0-beta.1"`) must be handled explicitly and deterministically, not left to `semver.satisfies`'s default prerelease-exclusion behavior by accident — cover this with an explicit test (see Task 3/Task 5).

6. **Manifest name is validated as reverse-DNS style.**
   Given a manifest's `name` field, when validated at registration, then it must match `/^[a-z0-9]+(\.[a-z0-9-]+)+$/` (reverse-DNS style, e.g. `com.acme.sso-extension`) or `registerExtension()` rejects it — throws synchronously with a typed `ExtensionRegistrationError` whose `reason` field is `"invalid-name"` (same error class as AC5, discriminated by `reason`, so a caller like the Story 14.2 loader can branch on failure cause without string-matching the message — `hooksFactory` never invoked). Cover both a valid name and at least two invalid shapes (no dot, uppercase character) in tests.

7. **CI enforces version-skew in lockstep with any surface change.**
   Given the CI pipeline, when any file under `packages/extension-api/src/**` changes without a corresponding change to `packages/extension-api/package.json`'s `version` *field value* (not merely the file being touched — a diff that edits `package.json` without changing `version` must still fail) in the same commit/PR diff, then CI fails with an explicit error naming the version-skew guard (new script, e.g. `scripts/check-extension-api-version-skew.ts`, following the same pattern as the existing `check-story-status-sync.ts`/`check-psc-tbd-tracking.ts` guards — compare the diff of `packages/extension-api/src/**` against the actual before/after `version` string in `packages/extension-api/package.json` across the PR's base/head). Wired into `make ci` and the CI workflow in this same story (Product Surface Contract rule G3: "Security CI guards ship in `make ci` the same story" — this guard is a supply-chain/version-integrity guard, same category).

## Tasks / Subtasks

- [x] Task 1: Scaffold `packages/extension-api` workspace package (AC: 1)
  - [x] Add `packages/extension-api/package.json` modeled on `packages/shared/package.json` (name `@project-vault/extension-api`, `type: module`, `main`/`types`/`exports` pointing at `dist/`, `typecheck`/`lint`/`test`/`build` scripts, `@project-vault/eslint-config` + `@project-vault/tsconfig` devDependencies) — see Dev Notes on the `private` field decision
  - [x] Add `packages/extension-api/tsconfig.json` extending `@project-vault/tsconfig` (node variant)
  - [x] Add `semver` as a runtime dependency and `@types/semver` as a devDependency (new to this monorepo — not used elsewhere yet, confirmed via repo-wide grep during story creation)
  - [x] Register the new package so `pnpm install` / turbo picks it up (pnpm workspace glob already covers `packages/*`; verified `pnpm-workspace.yaml` needs no change — `pnpm install` picked up the new package automatically)
- [x] Task 2: Define hook interfaces (AC: 2, 3)
  - [x] `src/hooks/auth-strategy.ts` — `AuthStrategy` interface, `onAuthenticate(...): Promise<AuthResult>` (shape per architecture.md: `{ externalSubject, providerName, email?, displayName? }` — this story only needs the type, not the runtime dispatch which lands in Story 14.3)
  - [x] `src/hooks/notification-channel.ts` — `NotificationChannel` interface, `onNotify(...): Promise<void>`
  - [x] `src/hooks/ui-panel.ts` — `UIPanel` interface, `onRenderPanel(...): Promise<UIPanelResult>` (or equivalent serializable return type)
  - [x] Keep every hook boundary type serializable-data-only per architecture.md's Data Boundaries — no `Tx`, no `SecretValue`, no `AuthContext` exported from this package
  - [x] `src/index.ts` re-exports all three hook types — added `index.test.ts`'s structural assertion (`package.json#exports` keys equal `['.']`) plus a review-checklist comment in `index.ts` itself, preventing a future `hooks/` subpath export from the package root's `exports` map
  - [x] Add a `// @ts-expect-error` negative-type-test fixture proving a non-Promise-returning hook method fails compilation (AC3)
- [x] Task 3: Implement `ExtensionManifest`, `defineExtension()`, `registerExtension()` (AC: 1, 4, 5, 6)
  - [x] `ExtensionManifest` type: `{ name: string, apiVersion: string, capabilities: ('auth-provider' | 'notification-channel' | 'ui-panel')[] }` per architecture.md's Extension Manifest Shape
  - [x] `EXTENSION_API_VERSION` — export as a semver string constant; this story sets it to `"1.0.0"` as the initial package version (bump alongside `package.json`'s own `version` per the version-skew guard)
  - [x] `defineExtension()` — thin manifest-authoring helper (identity-only convenience wrapper: `defineExtension(manifest: ExtensionManifest): ExtensionManifest`, a typed identity function)
  - [x] `registerExtension(manifest, hooksFactory)` — validates `manifest.name` against the reverse-DNS regex (AC6) **before** the semver check; validates `semver.satisfies(EXTENSION_API_VERSION, manifest.apiVersion, { includePrerelease: false })` (AC4/5) **before** ever calling `hooksFactory()` — both validation steps complete with zero calls to `hooksFactory` on any failure (verified via spy assertions)
  - [x] `hooksFactory` is lazy — `registerExtension()` never references it until both gates pass (verified with a side-effecting factory in a dedicated test)
  - [x] Defined `class ExtensionRegistrationError extends Error { reason: 'invalid-name' | 'incompatible-version' }` and throws it (not a bare `Error`) from both the name-validation and version-negotiation failure paths
  - [x] Documented and tested explicit prerelease handling: `isApiVersionCompatible()` calls `semver.satisfies(coreVersion, range, { includePrerelease: false })` explicitly — a stable manifest range does NOT satisfy a prerelease core version unless the manifest's own range opts into that prerelease line; rationale documented in a code comment in `register-extension.ts` and covered by three dedicated tests
- [x] Task 4: Version-skew CI guard (AC: 7)
  - [x] New script `scripts/check-extension-api-version-skew.ts`, following the git-diff-inspection pattern of `scripts/check-story-status-sync.ts` — resolves PR base/head (`GITHUB_BASE_REF`/`GITHUB_SHA` on GitHub Actions, `main`/`HEAD` fallback locally), diffs `packages/extension-api/src/**` against the actual before/after `version` field value read via `git show <ref>:package.json`
  - [x] Added co-located `check-extension-api-version-skew.test.ts` (14 tests, incl. 3 real-temp-git-repo integration tests covering: no `src/**` change → pass, `src/**` change + version bump → pass, `src/**` change without version bump → fail)
  - [x] Added root `package.json` script `check-extension-api-version-skew` (same naming convention as `check-story-status-sync`, `check-psc-tbd-tracking`)
  - [x] Wired into `Makefile`'s `ci:` target (alongside `check-story-status-sync`/`check-psc-tbd-tracking`) and into `.github/workflows/ci.yml`'s CI job (same step group as the other `pnpm check-*` invocations)
- [x] Task 5: Tests
  - [x] Unit tests for `registerExtension()`: compatible manifest accepted (AC4), incompatible `apiVersion` rejected + `hooksFactory` never called (AC5), invalid `name` rejected + `hooksFactory` never called (AC6, 2 invalid shapes + 1 valid), name-vs-semver validation ordering
  - [x] Tests assert rejection errors are instances of `ExtensionRegistrationError` with the correct `reason` (`"invalid-name"` vs `"incompatible-version"`) for each failure path (AC5/AC6), via a shared `expectRejection()` helper that also asserts zero `hooksFactory` calls
  - [x] Tested the chosen prerelease-handling behavior explicitly: a prerelease `EXTENSION_API_VERSION`-shaped core version against stable and prerelease-opted-in manifest ranges (AC5)
  - [x] Type-level test proving Promise-typed hook methods are enforced (AC3) — verified the fixture actually catches a regression by temporarily loosening `AuthStrategy.onAuthenticate`'s return type and confirming `tsc --noEmit` failed with "Unused '@ts-expect-error' directive", then restored it
  - [x] Unit tests for the new version-skew guard script (Task 4) — see above
  - [x] `packages/extension-api` reaches this repo's standard coverage bar: 93.75% statements, 100% branches, 80% functions, 93.75% lines (global thresholds of 80/80/80/80 from `@project-vault/tsconfig/vitest.base`, same as `packages/shared`)

## Dev Notes

- **This story does not stand up an npm publish pipeline.** "Publish" in the story title and in prd.md/architecture.md ("the core publishes a versioned `@project-vault/extension-api` package") refers to the package existing with a stable, versioned, typed contract inside this monorepo — not an external npm registry publish step, a CI publish job, or a public package listing. No AC in epics.md's Story 14.1 requires that, and building one now would be scope creep this workflow explicitly warns against. If external distribution (npm/GitHub Packages) is needed later, that belongs in a dedicated follow-up story — flag it as an open question below rather than inventing it here.
- **`private` field in `package.json` — an open decision, not yet resolved by any source doc.** Every existing internal-only package (`packages/shared`, `packages/crypto`, `packages/db`) sets `"private": true`. `packages/extension-api` is architecturally different — it exists specifically to be depended on by a package *outside* this workspace (the founder's private SaaS extension, per architecture.md's Data Boundaries: "Depended on by `apps/api` (core) and by any extension package... private today, community once sandboxing ships"). Since this story doesn't build an actual publish pipeline (see above), the pragmatic default for this story is to still mark it `"private": true` like every sibling package (it stays a `workspace:*`-only reference within this repo for now) and flag the "how does an external private extension actually consume this" question as an open item for whoever builds the founder's private SaaS extension package — do not silently invent a registry/tarball mechanism here.
- **`packages/agent` is the one existing package in this monorepo that is NOT private** (`@project-vault/agent`, no `"private": true` field, has a real `exports` map with a secondary `./cache-crypto` entry point) — it is the closest structural analog if `packages/extension-api` does need to be publish-ready later (multi-entry `exports`, not marked private). Use it only as a reference for the `exports` map shape if scope expands; do not copy its non-private status without confirming with the user first, per the point above.
- **Ordering discipline is the core correctness property of this story.** AC5 and AC6 both require `hooksFactory` to be verifiably uninvoked on failure — this is the entire point of the "capability negotiation is a hard gate, not aspirational" architecture decision (architecture.md: "An eager `hooks` object... would make 'gate before any hook wires' false"). Every rejection path must be provable with a spy/mock assertion of zero calls, not just an assertion that `registerExtension()` throws.
- **No `apps/api` or `apps/web` changes in this story.** The loader that actually calls `registerExtension()` against a real `VAULT_EXTENSIONS_PACKAGE` is Story 14.2; the auth-strategy dispatch that consumes `AuthStrategy` hooks is Story 14.3. This story is self-contained within `packages/extension-api` plus the new root-level CI guard script and its wiring (`Makefile`, `.github/workflows/ci.yml`, root `package.json`). If implementation drifts into touching `apps/api`/`apps/web`, stop and flag it — that's scope drift into 14.2/14.3.
- **No previous in-epic technical story to mine for code patterns** — Story 14.0 (AGPLv3/CLA) was governance/legal work with `Surface scope: none` and zero application code touched (confirmed: only `LICENSE`, `package.json`'s `license` field, `README.md`, `CONTRIBUTING.md`, `CLA.md`, `.github/pull_request_template.md`, `.github/workflows/cla.yml`). It establishes no code conventions for this story to reuse. It is relevant to this story in exactly one way (cross-story concern, not a blocker): **Story 14.0 set `package.json`'s root `license` to `"AGPL-3.0-or-later"`.** Since `packages/extension-api` will be depended on by a closed-source, non-AGPLv3 private extension package (per its explicit purpose), confirm at implementation time whether `packages/extension-api/package.json` needs its own explicit `"license"` field — likely still `AGPL-3.0-or-later` since it stays `"private": true` and in-repo (see above), matching every other internal package's inherited licensing, not a separate license grant. This is not a blocking legal question (AGPLv3's network-copyleft boundary is about the *running service*, not about whether a private consumer can import a workspace-internal types package they never redistribute) but is worth a one-line confirmation in the PR description if it comes up in review.
- **`semver` is a new dependency to this monorepo** — confirmed via repo-wide grep during story creation (`grep -rn '"semver"' package.json packages/*/package.json apps/*/package.json pnpm-lock.yaml` returned no matches). Use the `semver` npm package's `satisfies()` function directly per architecture.md's explicit instruction ("via `semver.satisfies()`, never hand-rolled range parsing") — do not write custom semver range logic.
- Follow this repo's established `check-*.ts` CI-guard pattern exactly (`scripts/check-story-status-sync.ts`, `scripts/check-psc-tbd-tracking.ts`, `scripts/check-vault-action-dist-fresh.ts` are the closest analogs — each is a standalone `tsx`-run script with a co-located `.test.ts`, wired into both `Makefile`'s `ci:` target and `.github/workflows/ci.yml`). Do not invent a different guard mechanism (e.g. a git pre-commit hook only) — CI enforcement is the explicit AC7 requirement.

### Project Structure Notes

- New package: `packages/extension-api/` — `package.json`, `tsconfig.json`, `src/index.ts`, `src/hooks/auth-strategy.ts`, `src/hooks/notification-channel.ts`, `src/hooks/ui-panel.ts` (exact structure per architecture.md § Extension & Theming Structure — note the architecture doc's Project Structure section places `index.ts`/`hooks/` directly under `packages/extension-api/` without a `src/` layer in one spot (line ~768) but shows `src/` in the Source Tree section (line ~1390); this repo's other packages (`packages/shared`, `packages/crypto`) consistently use a `src/` layer — follow that established convention, treat the no-`src/` mention as the architecture doc's own inconsistency, not a deviation to replicate.
- New root-level script: `scripts/check-extension-api-version-skew.ts` + `scripts/check-extension-api-version-skew.test.ts`
- Modified: root `package.json` (new `check-extension-api-version-skew` script + `pnpm-workspace.yaml` verification), `Makefile` (`ci:` target), `.github/workflows/ci.yml` (new step)
- No `apps/api` or `apps/web` changes expected — see Dev Notes scope-boundary note.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 14.1: Define and Publish the Extension API Package] — full AC source text
- [Source: _bmad-output/planning-artifacts/epics.md#Epic 14: Extension Architecture & Pluggable Authentication] — epic framing, FR113/FR114/FR115/FR116(deferred), Story 0 sequencing rationale
- [Source: _bmad-output/planning-artifacts/architecture.md#Extension / Hook Architecture (Phase 2, from architecture.md — Epic 14)] — package responsibilities, lazy-hooksFactory rationale, identity-binding note (Story 14.3 scope, not this story)
- [Source: _bmad-output/planning-artifacts/architecture.md#Extension Manifest Shape] — `ExtensionManifest` interface, `registerExtension()` signature
- [Source: _bmad-output/planning-artifacts/architecture.md#Data Boundaries] — `packages/extension-api` is types/contracts only, serializable-data-only across hook boundaries, version-skew CI guard requirement
- [Source: _bmad-output/planning-artifacts/architecture.md#Extension & Theming Structure] — file layout under `packages/extension-api/src/`
- [Source: _bmad-output/planning-artifacts/prd.md#FR113, FR114, FR115] — functional requirements this story partially satisfies (FR113 fully; FR114/FR115 depend on Stories 14.2/14.3)
- [Source: _bmad-output/implementation-artifacts/14-0-establish-agplv3-license-and-contributor-agreement.md] — prior story in this epic; governance-only, no code-pattern overlap, but establishes root `package.json`'s `"license": "AGPL-3.0-or-later"` field referenced in this story's Dev Notes
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]
- Sibling-package pattern reference: `packages/shared/package.json` (closest analog: private, types/contracts-heavy, no application logic)

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

- Confirmed RED before implementation: ran `pnpm exec tsc --noEmit` in `packages/extension-api` with only test files present — 14 `TS2307: Cannot find module` errors (one per not-yet-created source module), plus `pnpm exec vitest run scripts/check-extension-api-version-skew.test.ts` failing the same way before `check-extension-api-version-skew.ts` existed.
- Verified the AC3 negative-type-test fixture is load-bearing (not a vacuous pass): temporarily loosened `AuthStrategy.onAuthenticate`'s return type to `AuthResult | Promise<AuthResult>` and re-ran `tsc --noEmit` — it failed with `Unused '@ts-expect-error' directive`, proving the fixture would catch a real regression. Reverted immediately after.
- `pnpm turbo typecheck/lint/test --filter=@project-vault/extension-api` all green; `pnpm exec jscpd apps packages scripts` reports 0 clones after adding this story's files.

### Completion Notes List

- Scaffolded `packages/extension-api` (AC1) modeled on `packages/shared`: `package.json` (`private: true`, `"version": "1.0.0"`, `semver` runtime dep + `@types/semver` dev dep), `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`. No `pnpm-workspace.yaml` change was needed (existing `packages/*` glob already covers it).
- `src/hooks/{auth-strategy,notification-channel,ui-panel}.ts` define `AuthStrategy`/`NotificationChannel`/`UIPanel` with Promise-typed methods only, serializable-data-only payloads (AC2/AC3). `src/hooks/type-fixtures.ts` is a compile-only `@ts-expect-error` fixture proving the Promise constraint is enforced (AC3).
- `src/manifest.ts` defines `ExtensionManifest`, `EXTENSION_API_VERSION = "1.0.0"`, and `defineExtension()` (typed identity function) (AC1).
- `src/errors.ts` defines `ExtensionRegistrationError` discriminated by `reason: 'invalid-name' | 'incompatible-version'` (AC5/AC6).
- `src/register-extension.ts` implements `registerExtension()`: validates the reverse-DNS name regex first, then `isApiVersionCompatible()` (wraps `semver.satisfies(core, range, { includePrerelease: false })`, explicit/deliberate prerelease handling), both **before** ever calling `hooksFactory` — proven via spy/mock zero-call assertions on every rejection path (AC4/AC5/AC6).
- `src/index.ts` re-exports everything from the package root only; `package.json#exports` declares only `"."` (no `hooks/` subpath), asserted structurally by `index.test.ts` (AC2).
- Added `scripts/check-extension-api-version-skew.ts` + co-located `.test.ts` (AC7), following `check-story-status-sync.ts`'s pattern: resolves a base/head diff range (`GITHUB_BASE_REF`/`GITHUB_SHA` on CI, `main`/`HEAD` locally), diffs `packages/extension-api/src/**`, and compares the actual `version` field value (not just file-touched) via `git show <ref>:package.json`. Wired into root `package.json`, `Makefile`'s `ci:` target, and `.github/workflows/ci.yml`.
- Final test run: `packages/extension-api` — 7 test files, 24 tests passed, coverage 93.75% stmts / 100% branch / 80% functions / 93.75% lines (meets the repo's 80/80/80/80 bar). `scripts/check-extension-api-version-skew.test.ts` — 14 tests passed. No regressions in touched config files (`package.json`, `Makefile`, `.github/workflows/ci.yml` are additive-only diffs).
- Scope held to this story's boundary: no `apps/api`/`apps/web` changes made.

### File List

- `packages/extension-api/package.json` (new)
- `packages/extension-api/tsconfig.json` (new)
- `packages/extension-api/eslint.config.js` (new)
- `packages/extension-api/vitest.config.ts` (new)
- `packages/extension-api/src/index.ts` (new)
- `packages/extension-api/src/index.test.ts` (new)
- `packages/extension-api/src/manifest.ts` (new)
- `packages/extension-api/src/manifest.test.ts` (new)
- `packages/extension-api/src/errors.ts` (new)
- `packages/extension-api/src/register-extension.ts` (new)
- `packages/extension-api/src/register-extension.test.ts` (new)
- `packages/extension-api/src/hooks/auth-strategy.ts` (new)
- `packages/extension-api/src/hooks/auth-strategy.test.ts` (new)
- `packages/extension-api/src/hooks/notification-channel.ts` (new)
- `packages/extension-api/src/hooks/notification-channel.test.ts` (new)
- `packages/extension-api/src/hooks/ui-panel.ts` (new)
- `packages/extension-api/src/hooks/ui-panel.test.ts` (new)
- `packages/extension-api/src/hooks/type-fixtures.ts` (new)
- `packages/extension-api/src/hooks/type-fixtures.test.ts` (new)
- `scripts/check-extension-api-version-skew.ts` (new)
- `scripts/check-extension-api-version-skew.test.ts` (new)
- `package.json` (modified — new `check-extension-api-version-skew` script)
- `Makefile` (modified — new `pnpm check-extension-api-version-skew` step in `ci:` target)
- `.github/workflows/ci.yml` (modified — new "Check extension-api version-skew" CI step)
- `pnpm-lock.yaml` (modified — `semver`/`@types/semver` added)

## Change Log

- 2026-07-24: Implemented Story 14.1 end-to-end via TDD (tests written and confirmed failing
  before each source file existed). Scaffolded `packages/extension-api` with
  `defineExtension()`/`registerExtension()`/`EXTENSION_API_VERSION`/typed hook interfaces
  (`AuthStrategy`/`NotificationChannel`/`UIPanel`), all Promise-typed and root-only exported.
  `registerExtension()` validates reverse-DNS manifest names and semver capability compatibility
  (via the `semver` package, explicit `includePrerelease: false`) before ever invoking
  `hooksFactory`, throwing a typed `ExtensionRegistrationError` discriminated by `reason` — every
  rejection path is verified with a zero-call spy assertion on `hooksFactory`, not just that it
  throws. Added `scripts/check-extension-api-version-skew.ts` (+ test) and wired it into
  `Makefile`'s `ci:` target, `.github/workflows/ci.yml`, and root `package.json` (AC7). No
  `apps/api`/`apps/web` changes — this package is unconsumed until Stories 14.2/14.3.
