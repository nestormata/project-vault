# Story 14.9: Extension API Publish-Readiness Decision

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a maintainer of `packages/extension-api` who will eventually support extension authors outside this monorepo (starting with the founder's own private SaaS extension),
I want the package's `private`/license/external-distribution posture explicitly decided and documented instead of left as open prose in Story 14.1's Dev Notes,
so that whoever builds the first external-consuming extension package doesn't have to re-derive licensing and distribution semantics from scratch, and so this open question stops resurfacing at every subsequent epic-14 retro.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `none` |
| **Evaluator-visible** | no |
| **Linked UI story** (if API-only) | N/A — no UI surface exists or is implied by this story |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | N/A — this is an internal packaging/documentation decision inside `packages/extension-api`. It changes zero runtime behavior: no route, no page, no API response, no `GET /health` field is added or altered. Nothing in `apps/api` or `apps/web` is touched. No self-hosted operator, org user, or evaluator can observe any difference before or after this story ships. |

## Acceptance Criteria

### AC-1: `package.json`'s `private` field decision is made explicit and justified in-repo (not left as prose in a different story's Dev Notes)

**Given** `packages/extension-api/package.json` currently has `"private": true` (matching every other internal-only workspace package: `packages/shared`, `packages/crypto`, `packages/db`) with no comment or doc explaining why, while Story 14.1's own Dev Notes (`14-1-define-and-publish-the-extension-api-package.md:90`) call this "an open decision, not yet resolved by any source doc,"

**When** this story is implemented,

**Then** `packages/extension-api/package.json` keeps `"private": true` (confirmed decision, not changed — no npm publish pipeline exists per Story 14.1's own scope boundary and none is being built here) **and** a new `## Publish Readiness` section is added to `architecture.md`'s Extension / Hook Architecture area (see Dev Notes for exact anchor) stating: (a) the package stays `private: true` and workspace-internal for now, (b) the founder's private SaaS extension consumes it via an in-monorepo `workspace:*` dependency reference (not an npm/registry install) until a decision is made to publish externally, and (c) what specifically would need to change to make it publish-ready later (drop `private`, add a real `exports` map matching `packages/agent`'s pattern per Story 14.1's Dev Notes precedent, wire an npm/GitHub Packages publish step in CI) — so a future story has a concrete checklist instead of re-deriving this from zero.

**Example (happy path):** A future engineer opens `architecture.md`, searches "Publish Readiness," and finds the three points above without needing to read `14-1`'s Dev Notes or this story's file at all.

**Edge case:** If `architecture.md`'s Extension / Hook Architecture section has been restructured since this story was written (verify with `grep -n "Extension / Hook Architecture" architecture.md` before editing), add the new subsection at the equivalent location in whatever structure exists then — the requirement is discoverability under a `packages/extension-api` licensing/publishing context, not a specific line number.

### AC-2: `packages/extension-api/package.json` gets its own explicit `license` field, resolving Story 14.1 Dev Notes' second open question

**Given** the repository root `package.json`'s `license` field was set to `"AGPL-3.0-or-later"` by Story 14.0, and Story 14.1's Dev Notes (`14-1-...md:94`) flag as unresolved whether `packages/extension-api/package.json` needs its own explicit `license` field given it will be depended on by a closed-source, non-AGPLv3 private extension package,

**When** this story is implemented,

**Then** `packages/extension-api/package.json` gets an explicit `"license": "AGPL-3.0-or-later"` field (matching the root — this package stays in-repo, `private: true`, and is not itself being redistributed; AGPLv3's network-copyleft boundary is about the running service, not about a workspace-internal types/contracts package a private consumer imports without redistributing it) **and** a one-line comment is added to the new `architecture.md` Publish Readiness section (AC-1) explicitly stating this rationale so it isn't silently assumed by the next reader: *"`packages/extension-api` inherits the repo's AGPLv3 license; a private extension package importing it as a workspace dependency does not trigger AGPLv3's network-copyleft obligations because it isn't redistributing this package, only consuming its types/contracts in-process."*

**Example (happy path):** `cat packages/extension-api/package.json | grep license` returns `"license": "AGPL-3.0-or-later"`.

**Edge case — verify no other workspace package sets an explicit `license` field that would make this an inconsistent one-off:** run `grep -L '"license"' packages/*/package.json` and `grep -rn '"license"' packages/*/package.json` before implementing. If every sibling package already omits `license` (inheriting silently from the root, per standard npm/pnpm semantics), still add it explicitly here per this story's own AC-2 rationale (this package's cross-license-boundary consumption story is different from every sibling's, per Story 14.1 Dev Notes) — but flag in the PR description that this makes `packages/extension-api` the only workspace package with an explicit `license` field, so a reviewer doesn't mistake it for an accidental inconsistency.

### AC-3: External-registry scope question is answered with a concrete "not now, here's the trigger" statement — not left open-ended

**Given** Story 14.1's Dev Notes leave "how does an external private extension actually consume this" as an open item for "whoever builds the founder's private SaaS extension package," with no stated trigger for when that becomes necessary,

**When** this story is implemented,

**Then** the `architecture.md` Publish Readiness section (AC-1) states explicitly: no npm/GitHub Packages registry publish is being built now; the founder's own private SaaS extension package, when it is built, will consume `@project-vault/extension-api` via a `workspace:*` reference if it lives in this same monorepo, or via a private Git-dependency/tarball reference if it lives in a separate repository — and registry publishing (npm private registry or GitHub Packages) is the trigger to revisit only if/when a *third-party* extension author (not the founder's own SaaS package) needs to install this package from outside the monorepo entirely, which epics.md explicitly scopes out of Epic 14 (FR116, "Community extensions — out of Epic 14 scope").

**Example (happy path):** The next time someone reads this trigger condition and realizes a third-party extension author is now in scope (a future epic), they know exactly what decision needs to be revisited and why it wasn't made now.

**Edge case:** Do not build any actual publish tooling, CI job, or registry configuration as part of this story — Story 14.1's Dev Notes are explicit that "this story does not stand up an npm publish pipeline" and building one now (even a stub) would be scope creep this story exists specifically to avoid, not introduce.

### AC-4: A discoverable breadcrumb exists at the package itself, not only buried in `architecture.md`

**Given** `packages/extension-api` currently has no `README.md` at all, and `architecture.md` is a large, multi-epic planning document that a future engineer building the actual external-consuming extension package is unlikely to open before checking the package's own directory first,

**When** this story is implemented,

**Then** create `packages/extension-api/README.md` with a short "License & Publishing" section (3-5 lines) stating the package is `private: true`/AGPLv3-inherited today, linking to `architecture.md`'s new Publish Readiness subsection (AC-1) for the full rationale and trigger condition — so the decision is discoverable from the package itself, not only from a doc a reader has to know exists.

**Example (happy path):** `cat packages/extension-api/README.md` shows the license/publishing note without needing any other file open.

**Edge case:** Keep this file to the license/publishing note only — do not use it as a general package README covering usage/API docs; that's a separate, unscoped concern this story should not expand into.

### AC-5: `deferred-work.md` is reconciled — no stale "open" row is left for a question this story just resolved

**Given** `epic-14-retro-2026-07-28.md` Finding 4 recommended adding a `deferred-work.md` row for this open question (Resolution: "Add a one-line `deferred-work.md` row so it isn't lost"), but this story resolves the question directly rather than merely tracking it,

**When** this story is implemented,

**Then** confirm via `grep -rn "extension-api" _bmad-output/implementation-artifacts/deferred-work.md` that no row was added for this item in the interim (none existed as of this story's creation) — if a row was added by a concurrent session before this story completes, update it to `✅ Resolved` with a one-line pointer to this story and the new `architecture.md` Publish Readiness section, rather than leaving it as an open item alongside a story that already closed it.

## Tasks / Subtasks

- [x] Task 1: Confirm current state (AC: #1, #2, #5)
  - [x] Read `packages/extension-api/package.json` in full; confirm `private: true`, no `license` field, matches expectations in AC-1/AC-2's "Given" clauses
  - [x] `grep -n "Extension / Hook Architecture" _bmad-output/planning-artifacts/architecture.md` to locate the correct insertion point (no exact-title heading exists; used the closest structural equivalent — the "Extension API package (Phase 2 — FR113/FR114)" bullet block under `### API & Communication Patterns`, per AC-1's edge case)
  - [x] `grep -rn "extension-api" _bmad-output/implementation-artifacts/deferred-work.md` to confirm no stale row exists (per AC-5) — confirmed empty match, no row exists
  - [x] Confirm `packages/extension-api/README.md` does not already exist (per AC-4) — confirmed absent
- [x] Task 2: Add the explicit `license` field (AC: #2)
  - [x] Add `"license": "AGPL-3.0-or-later"` to `packages/extension-api/package.json`, placed immediately after `"private": true`
  - [x] Run `grep -L '"license"' packages/*/package.json` to confirm this makes `packages/extension-api` the sole workspace package with an explicit field — confirmed: every other workspace package (`crypto`, `db`, `agent`, `shared`, `vault-action`, `api-contract-tests`, `tsconfig`, `eslint-config`) omits it; `packages/extension-api` is the only one with an explicit `license` field (note for PR description)
- [x] Task 3: Write the `architecture.md` Publish Readiness section (AC: #1, #2, #3)
  - [x] Added a new `#### Publish Readiness` subsection immediately after the "Extension API package (Phase 2 — FR113/FR114)" bullets, before `### Frontend Architecture` (closest structural equivalent per AC-1 edge case)
  - [x] Covers, in order: (a) current `private: true` decision and rationale, (b) the AGPLv3 license-field rationale for a package consumed by a closed-source private extension, (c) the workspace-vs-external-repo consumption path for the founder's own SaaS extension, (d) the concrete trigger condition for revisiting external/registry publishing (third-party extension authors, explicitly out of Epic 14 scope per FR116)
  - [x] Includes the three-option decision record from Dev Notes (stay private / go publish-ready now / dual-license split) verbatim
  - [x] Added the legal-caveat note from Dev Notes verbatim
  - [x] Cross-references `packages/agent`'s non-private `exports` map as the structural pattern to follow if publish-readiness is revisited — documentation only, no `exports` map changes made
- [x] Task 4: Create the package-level breadcrumb (AC: #4)
  - [x] Added `packages/extension-api/README.md` — license/publishing note only (5 lines), linking to the `architecture.md` Publish Readiness subsection from Task 3
- [x] Task 5: Reconcile `deferred-work.md` (AC: #5)
  - [x] Re-confirmed via `grep -rn "extension-api" _bmad-output/implementation-artifacts/deferred-work.md` immediately before completing this story: still no row exists — no action needed, no new "open" row added for a question this story resolves in the same commit
- [x] Task 6: Verify no runtime/behavioral surface was touched (AC: all)
  - [x] `git diff --stat` / `git status --porcelain` shows only `packages/extension-api/package.json` (modified), `packages/extension-api/README.md` (new), `_bmad-output/planning-artifacts/architecture.md` (modified) — no `apps/api`, `apps/web`, or `packages/extension-api/src/**` changes; `deferred-work.md` untouched (no row to reconcile)
  - [x] `pnpm --filter @project-vault/extension-api typecheck` — passes clean
  - [x] `pnpm --filter @project-vault/extension-api test` — 7 test files, 24 tests passed, coverage unchanged

### Review Findings

Reviewed via `bmad-code-review` (Blind Hunter, Edge Case Hunter, Acceptance Auditor) against `git diff daf2b27..HEAD`. Acceptance Auditor found zero AC violations — all 5 ACs (AC-1 through AC-5) fully satisfied, Product Surface Contract compliant (`Surface scope: none` confirmed, zero `apps/api`/`apps/web` touches). Findings below are documentation-accuracy/legal-reasoning issues in the new `architecture.md` Publish Readiness subsection and `README.md`, not AC violations.

- [x] [Review][Patch] Legal rationale over-generalized beyond the workspace:* case; AGPLv3 §13 (network-use clause) and non-types-only runtime code (`register-extension.ts`, `semver`-based negotiation) never addressed — fixed by broadening the "Legal caveat" paragraph in `architecture.md` to explicitly scope the "no redistribution" argument to in-monorepo `workspace:*` consumption only, and flag the separate-repo/tarball path, AGPLv3 §13, and the package's real runtime code as open questions for the already-called-for legal review. [`_bmad-output/planning-artifacts/architecture.md:499-501`]
- [x] [Review][Patch] "inherits silently from the root" overstated real npm/pnpm license-inheritance semantics (no such propagation exists, no per-package `LICENSE` files) — fixed by rewording to state sibling packages are covered by the root `LICENSE`/AGPLv3 posture by convention only, not by any tooling-level inheritance. [`_bmad-output/planning-artifacts/architecture.md:483`]
- [x] [Review][Patch] Decision table's Option A "Zero risk" label read as inconsistent with the Legal caveat two paragraphs later — fixed by qualifying it as "zero *new build/distribution* risk" and cross-referencing the caveat. [`_bmad-output/planning-artifacts/architecture.md:495`]
- [x] [Review][Patch] `README.md`'s cross-reference ("under API & Communication Patterns → Extension API package") implied a heading hierarchy that doesn't exist (`Extension API package` is a bold bullet, not a heading; `Publish Readiness` is its sibling, not its child) — fixed by rewording to reference the actual `#### Publish Readiness` heading and its real position. [`packages/extension-api/README.md:7-9`]
- [x] [Review][Defer] `sprint-status.yaml`'s `epic-14: done` rollup is stale relative to its own newly-added child stories (14-7/14-8 `backlog`, 14-9 `review`) — deferred, pre-existing rollup-tracking gap not introduced by this diff (predates this story; `check-story-status-sync.ts` only checks a story's own file vs. its own sprint-status entry, not epic-vs-children rollup consistency). [`_bmad-output/implementation-artifacts/sprint-status.yaml:236`]
- [x] [Review][Defer] No CI/lint guard prevents a future contributor from "fixing" the perceived license-field inconsistency (removing it from `extension-api`, or adding it everywhere else) contrary to this story's stated intent — deferred as a speculative enforcement mechanism out of scope for this documentation-only story; candidate for a future story alongside 14-8's RBAC-convention documentation effort if this drifts in practice.

## Dev Notes

- **This is a documentation/manifest-only story with zero application code changes.** There is no route, handler, migration, hook, or UI to implement. The "why" for every AC traces back to `14-1-define-and-publish-the-extension-api-package.md` Dev Notes (lines 89-94) and `epic-14-retro-2026-07-28.md` Finding 4 — both already fully quoted in this story's ACs above, so a developer does not need to open either file to implement this correctly. They remain useful only for extra background if something here seems ambiguous.
- **Do not build an npm publish pipeline, CI publish job, or registry configuration.** Story 14.1 was explicit that doing so would be scope creep; this story inherits that same boundary. If you find yourself writing a GitHub Actions workflow file, stop — that is out of scope.
- **Do not change `private: true` to `false`.** No source doc has resolved that the package should become non-private yet — this story documents the *current* decision and the *trigger* for revisiting it, it does not itself flip the switch.
- **RLS/tenant isolation, audit behaviour, auth/session lifecycle, concurrent access, rate limits, migration compatibility, operational logging:** none apply to this story. There is no database table, no API route, no session, no audit event, and no running-process behavior anywhere in this story's scope — it edits two static files (`package.json`, `architecture.md`) and possibly a third (`deferred-work.md`). This is a deliberate scoping note, not an oversight: forcing any of these test categories onto a pure-documentation story would itself be the kind of scope creep this story's own ACs warn against introducing.
- **Testing standard for this story:** no new automated tests are required or meaningful (nothing executable changed). Task 6's verification step (`typecheck`/`test` re-run on the existing `packages/extension-api` suite) exists solely to confirm the manifest edit didn't break anything already passing — it is a regression check, not new test coverage.

### Decision Record: `private`/license/publish posture

| Option | Description | Trade-off | Chosen? |
|---|---|---|---|
| A. Stay private, in-repo only (this story) | Keep `private: true`, add explicit `license` field, document consumption path and future trigger | Zero risk, zero new surface, matches Story 14.1's "no publish pipeline" scope boundary; defers real publish-readiness work to whenever it's actually needed | ✅ Yes |
| B. Make publish-ready now (drop `private`, add `exports` map, wire CI publish job) | Would fully resolve the question in one story | Pure speculative work today — no consumer needs external distribution yet (the founder's SaaS extension can consume via `workspace:*` or a private Git/tarball reference); directly contradicts Story 14.1's explicit scope boundary against standing up a publish pipeline | ❌ No — scope creep |
| C. Dual-license (e.g. AGPLv3 + a separate permissive grant for the types-only surface) | Would preempt any future FUD about AGPLv3 applying to closed-source consumers | Real legal complexity (a second license grant needs actual legal review, not an engineering judgment call) for a problem that doesn't exist yet — no external consumer today | ❌ No — premature, revisit only if/when Option B's trigger fires |

**Legal-caveat note (carry into the `architecture.md` Publish Readiness section verbatim):** Setting an explicit AGPLv3 license field on a package that a closed-source SaaS extension imports can read as alarming out of context, even though in-repo `workspace:*` consumption without redistribution does not itself trigger AGPLv3's network-copyleft obligations. This story documents the current engineering rationale, not a legal opinion — flag Option C (or a scoped exception grant) for actual legal review at the same time registry-publish (Option B's trigger, AC-3) is revisited, rather than assuming the current rationale still holds once the package has real external consumers.

### Project Structure Notes

- Files touched: `packages/extension-api/package.json` (add one field), `packages/extension-api/README.md` (new, license/publishing note only — see AC-4/Task 4), `_bmad-output/planning-artifacts/architecture.md` (add one subsection), optionally `_bmad-output/implementation-artifacts/deferred-work.md` (reconciliation only, see AC-5/Task 5).
- One new file is created (`packages/extension-api/README.md`); no new directories or workspace packages.
- No conflict with unified project structure — this story appends to existing documents, adds one manifest field, and adds one small package-level README, all following existing conventions (root `license` field precedent from Story 14.0; `architecture.md`'s existing Extension / Hook Architecture section as the natural home for the fuller rationale; `packages/agent`'s non-private status as the structural reference if the decision is revisited later).

### References

- [Source: _bmad-output/implementation-artifacts/14-1-define-and-publish-the-extension-api-package.md#Dev Notes (lines 89-94)] — the original open questions this story resolves, quoted in full in the ACs above
- [Source: _bmad-output/implementation-artifacts/epic-14-retro-2026-07-28.md#4. [Medium] `packages/extension-api` external-publish-readiness decision left untracked] — the retro finding that scheduled this story
- [Source: _bmad-output/planning-artifacts/epics.md#FR116 (deferred) — Community extensions — out of Epic 14 scope] — the scope boundary underpinning AC-3's trigger condition
- [Source: packages/extension-api/package.json] — current state: `private: true`, no `license` field
- [Source: packages/agent/package.json] — the one existing non-private workspace package, cited by Story 14.1 Dev Notes as the structural reference *if* publish-readiness is revisited later
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5

### Debug Log References

- `grep -n "Extension / Hook Architecture" _bmad-output/planning-artifacts/architecture.md` → no match; used the "Extension API package (Phase 2 — FR113/FR114)" bullet block (line 473, under `### API & Communication Patterns`) as the closest structural equivalent, per AC-1's edge case.
- `grep -rn "extension-api" _bmad-output/implementation-artifacts/deferred-work.md` → no match, both at story start and re-confirmed before completion; no reconciliation needed for AC-5.
- `grep -L '"license"' packages/*/package.json` (before edit) → all 9 workspace packages including `extension-api`; after edit, `extension-api` is the sole package with an explicit `license` field.
- `pnpm --filter @project-vault/extension-api typecheck` → clean (exit 0).
- `pnpm --filter @project-vault/extension-api test` → 7 files / 24 tests passed, coverage 93.75% stmts (unchanged from baseline — no source files touched).

### Completion Notes List

- Documentation/manifest-only story, exactly as scoped: no application code, route, migration, or UI touched. `git diff --stat` confirms only `packages/extension-api/package.json` and `_bmad-output/planning-artifacts/architecture.md` modified, plus one new file `packages/extension-api/README.md`.
- AC-1: `package.json`'s `private: true` confirmed unchanged (not flipped); new `#### Publish Readiness` subsection added to `architecture.md` stating the package stays private/workspace-internal, the founder's SaaS extension consumes it via `workspace:*`, and the concrete checklist for future publish-readiness (drop `private`, add real `exports` map matching `packages/agent`, wire CI publish step).
- AC-2: Added `"license": "AGPL-3.0-or-later"` to `packages/extension-api/package.json` immediately after `"private": true`. Confirmed via `grep -L`/`grep -rn` across `packages/*/package.json` that this makes `packages/extension-api` the only workspace package with an explicit `license` field (flagging for PR description per AC-2's edge case) — AGPLv3-inheritance/no-copyleft-trigger rationale documented in the new `architecture.md` subsection.
- AC-3: `architecture.md` Publish Readiness subsection states explicitly: no npm/GitHub Packages registry publish is being built now; consumption is via `workspace:*` (same monorepo) or private Git/tarball reference (separate repo); registry publishing is the trigger to revisit only if/when a third-party extension author needs external install, per FR116 (out of Epic 14 scope). No publish tooling/CI job/registry config was built.
- AC-4: Created `packages/extension-api/README.md` with a 5-line "License & Publishing" section only, linking to the `architecture.md` Publish Readiness subsection — no general usage/API docs added, per AC-4's edge case.
- AC-5: Confirmed both at story start and again before completion that no `deferred-work.md` row exists for `extension-api` — no reconciliation action needed; no row was added by a concurrent session.
- Regression check (Task 6): `pnpm --filter @project-vault/extension-api typecheck` and `pnpm --filter @project-vault/extension-api test` both pass clean after the `package.json` edit — no existing behavior broken.
- No new automated tests were written, per this story's own Dev Notes ("Testing standard for this story: no new automated tests are required or meaningful") — Task 6's typecheck/test re-run is a regression check on the existing suite, not new coverage.

### File List

- `packages/extension-api/package.json` (modified — added `"license": "AGPL-3.0-or-later"`)
- `packages/extension-api/README.md` (new — License & Publishing breadcrumb)
- `_bmad-output/planning-artifacts/architecture.md` (modified — added `#### Publish Readiness` subsection under API & Communication Patterns)

## Change Log

- 2026-07-28: Story implemented end-to-end (Tasks 1-6, AC-1 through AC-5) via `bmad-dev-story`. `packages/extension-api/package.json` gets explicit `license` field; `architecture.md` gets new Publish Readiness subsection; `packages/extension-api/README.md` created; `deferred-work.md` confirmed to need no reconciliation. Status: ready-for-dev → review.
