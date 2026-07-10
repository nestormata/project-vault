# Story 10.2: apps/web Branch Coverage Hardening

Status: backlog

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->
<!-- Created 2026-07-10 after discovering that apps/web/vitest.config.ts still carried its Story 1.1 scaffold override (coverage.exclude: ['**/*'], all thresholds 0), which silently zeroed out coverage reporting for the entire package even though it now has 106 test files / 764 passing tests. The override was removed (commit on branch worktree-readme-badges) so apps/web now inherits the same v8 coverage defaults every other clean package (agent/crypto/vault-action) already uses, and SonarCloud/CI now measure real numbers instead of a stale 0%. That fix immediately surfaced the actual gap this story exists to close: with real measurement on, apps/web sits at 81.81% statements / 85.66% functions / 83.79% lines but only 67.41% branches — below the shared 80% threshold from packages/tsconfig/vitest.base.ts — so `pnpm vitest run --coverage` now fails its own gate for this package. -->

## Story

As a **developer relying on CI's coverage gate to catch untested logic before it ships**,
I want **apps/web's branch coverage raised to the shared 80% threshold** (statements/functions/lines already clear it),
so that **the coverage gate for apps/web is actually enforced instead of either disabled (the prior state) or silently red (the state immediately after re-enabling it)**.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `none` — test-only change. No new routes, schema, or user-visible behavior; this story only adds test cases exercising existing conditional branches. |
| **Evaluator-visible** | no |
| **Linked UI story** | N/A — not a UI-scoping story |
| **Honest placeholder AC** | N/A |
| **Persona journey** | N/A — pure test-coverage hardening, no new persona-facing surface |

### Persona journey stub

N/A — internal quality-gate hardening story, no new user-facing surface.

---

## Background

`apps/web/vitest.config.ts` previously set `coverage.exclude: ['**/*']` with all thresholds at `0`, a leftover from Story 1.1's scaffold days when the app had no testable source. That override was removed as part of this same worktree's investigation into a suspiciously-low 12.3% overall SonarCloud project coverage figure — apps/web's `coverage/lcov.info` was coming back completely empty (`All files | 0 | 0 | 0 | 0` in CI), and since apps/web is the largest package by line count, its 0% was dragging the whole project's aggregate coverage down despite every other package (`agent` 88.88%, `crypto` 94.3%, `shared` 90.9%, `vault-action` 94.08%, `db` 95.4%, `api` 93.73%) sitting well above 80%.

With the override removed, `pnpm --filter web vitest run --coverage` (from `apps/web/`) now reports real numbers:

```
Statements   : 81.81% ( 4889/5976 )
Branches     : 67.41% ( 1583/2348 )
Functions    : 85.66% ( 1309/1528 )
Lines        : 83.79% ( 3439/4104 )
ERROR: Coverage for branches (67.41%) does not meet global threshold (80%)
```

Only branch coverage is below the shared 80% floor (`packages/tsconfig/vitest.base.ts`). This story's job is to close that gap with real test cases (not by lowering the threshold or re-excluding files) unless a specific file is judged genuinely low-value to branch-test (documented per-file, not blanket).

## Acceptance Criteria

### AC-1 — Identify the lowest-branch-coverage files and their untested branches

**Given** the current coverage run's per-file breakdown (captured in this story's background section and reproducible via `pnpm --filter web vitest run --coverage`),
**When** the dev agent picking up this story reproduces the run,
**Then** it produces an explicit ranked list of files below 80% branch coverage (worst first) with the specific uncovered line ranges, to scope the work before writing tests. Notably low performers observed at story-creation time (subject to re-verification, this codebase changes daily): `.../settings/users/+page.svelte` (39.61%), `.../[projectId]/status-page/+page.svelte` (17.3%), `.../notifications/+page.svelte` (33.33%), `.../[projectId]/members/+page.svelte` (23.52%).

### AC-2 — Raise branch coverage to ≥80% without disabling or excluding files

**Given** the ranked list from AC-1,
**When** new test cases are added targeting the identified untested branches (conditional rendering paths, error/empty-state branches, form-validation branches, etc. — whichever a given file's uncovered ranges turn out to be),
**Then** a re-run of `pnpm --filter web vitest run --coverage` reports branch coverage ≥80%, with statements/functions/lines remaining ≥80% (already true today — must not regress).

### AC-3 — No coverage config regressions

**Given** `apps/web/vitest.config.ts` no longer carries the Story 1.1 scaffold override (already fixed on this branch),
**When** this story's changes are reviewed,
**Then** no new `coverage.exclude`/threshold-lowering override is introduced for apps/web as a shortcut to pass the gate — any file judged genuinely not worth branch-testing (e.g., a trivial re-export, generated code) must be excluded individually with an inline comment explaining why, not via a blanket `exclude: ['**/*']`-style pattern.

### AC-4 — CI coverage gate passes end-to-end

**Given** AC-1–AC-3 are complete,
**When** `pnpm turbo test` runs in CI (the "Test (with coverage)" step of `.github/workflows/ci.yml`),
**Then** the apps/web coverage step exits successfully (no threshold failure), and the next SonarCloud scan reports a realistic overall project coverage figure (expected to jump well above the current artificially-low 12.3%, since apps/web is the largest contributor to `lines_to_cover`).

---

## Testing Standards Summary

- Coverage tool: `v8` provider via Vitest (`packages/tsconfig/vitest.base.ts`), already configured — no new tooling needed.
- Run coverage locally with `pnpm --filter web vitest run --coverage` from repo root, or `pnpm vitest run --coverage` from `apps/web/`.
- Follow this repo's existing Svelte component test conventions (see any of the 106 existing `*.test.ts` files under `apps/web/src/`) — no new test framework or pattern is introduced by this story.
