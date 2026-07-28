# Story 14.9: Extension API Publish-Readiness Decision

Status: ready-for-dev

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

- [ ] Task 1: Confirm current state (AC: #1, #2, #5)
  - [ ] Read `packages/extension-api/package.json` in full; confirm `private: true`, no `license` field, matches expectations in AC-1/AC-2's "Given" clauses
  - [ ] `grep -n "Extension / Hook Architecture" _bmad-output/planning-artifacts/architecture.md` to locate the correct insertion point
  - [ ] `grep -rn "extension-api" _bmad-output/implementation-artifacts/deferred-work.md` to confirm no stale row exists (per AC-5)
  - [ ] Confirm `packages/extension-api/README.md` does not already exist (per AC-4)
- [ ] Task 2: Add the explicit `license` field (AC: #2)
  - [ ] Add `"license": "AGPL-3.0-or-later"` to `packages/extension-api/package.json`, placed immediately after `"private": true` (groups the two visibility/licensing metadata fields together, rather than after `"version"` — the current key order is `name, version, private, type, main, ...`, so licensing metadata reads more coherently next to the `private` flag it's directly explained by)
  - [ ] Run `grep -L '"license"' packages/*/package.json` to confirm this makes `packages/extension-api` the sole workspace package with an explicit field, and note this in the PR description
- [ ] Task 3: Write the `architecture.md` Publish Readiness section (AC: #1, #2, #3)
  - [ ] Add a new `#### Publish Readiness` subsection immediately under the Extension / Hook Architecture section (or the closest structural equivalent if the doc has been reorganized since — see AC-1 edge case)
  - [ ] Cover, in this order: (a) current `private: true` decision and rationale, (b) the AGPLv3 license-field rationale for a package consumed by a closed-source private extension, (c) the workspace-vs-external-repo consumption path for the founder's own SaaS extension, (d) the concrete trigger condition for revisiting external/registry publishing (third-party extension authors, explicitly out of Epic 14 scope per FR116)
  - [ ] Include the three-option decision record from Dev Notes (stay private / go publish-ready now / dual-license split) so the rejected alternatives and their trade-offs are preserved, not just the chosen option
  - [ ] Add the legal-caveat note from Dev Notes verbatim (AGPLv3-on-a-closed-source-consumed-package can read as alarming out of context even though the in-repo consumption is not itself a copyleft trigger) so a future publish-readiness pass doesn't skip a real license review
  - [ ] Cross-reference `packages/agent`'s non-private, multi-entry `exports` map as the structural pattern to follow *if and when* publish-readiness is revisited (per Story 14.1 Dev Notes precedent) — do not implement any `exports` map changes now, this is documentation only
- [ ] Task 4: Create the package-level breadcrumb (AC: #4)
  - [ ] Add `packages/extension-api/README.md` per AC-4 — license/publishing note only, linking to the `architecture.md` section from Task 3
- [ ] Task 5: Reconcile `deferred-work.md` (AC: #5)
  - [ ] If no row exists yet (expected, per this story's research), no action needed — do not add a new "open" row for a question this story is actively resolving in the same commit
  - [ ] If a row was added by a concurrent session (race condition — see `feedback-nested-background-agents.md`-style concurrent-session precedent from other stories in this project), update it to `✅ Resolved` pointing at this story and the new `architecture.md` section, per AC-5
- [ ] Task 6: Verify no runtime/behavioral surface was touched (AC: all)
  - [ ] `git diff --stat` should show only `packages/extension-api/package.json`, `packages/extension-api/README.md`, `_bmad-output/planning-artifacts/architecture.md`, and optionally `_bmad-output/implementation-artifacts/deferred-work.md` — no `apps/api`, `apps/web`, or `packages/extension-api/src/**` changes
  - [ ] Run `pnpm --filter @project-vault/extension-api typecheck` and `pnpm --filter @project-vault/extension-api test` to confirm the `package.json` edit didn't break the existing package (a `license` field addition is inert but verify the build/test pipeline still resolves the manifest correctly)

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

### Debug Log References

### Completion Notes List

### File List
