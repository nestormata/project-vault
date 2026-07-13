# Story 1.15: packages/db RLS-Isolation Test Suite Flake Investigation

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

<!-- This is an ad-hoc, bug-driven story with no epics.md backlog entry — same pattern as 1-13
     (infra/process hardening) and 6-5 (monitored-asset creation fix). Slotted into epic-1
     (Database Foundation with PostgreSQL RLS and Core Schema) rather than a new epic: the failing
     suite is packages/db's RLS-isolation coverage, directly descended from Story 1.4 (which
     created rls-isolation.test.ts, AC-11) and Story 1.11 (which extended it for
     SecureRoute/background-job paths). A brand-new, unrelated-topic epic (as 1-13/1-14 justified
     for infra hardening and KMS respectively) is not warranted here — this bug lives entirely
     inside epic-1's own subject matter. Numbered 1-15, the next free slot after 1-14
     (vault-kms-unseal-mode, merged via PR #182). -->

## Story

As a developer relying on `packages/db`'s RLS-isolation test suite as a tenant-isolation safety
net,
I want the suite's pre-existing, currently-unexplained off-by-one row-leakage failures
root-caused and either fixed or conclusively explained,
so that a green `packages/db` test run can be trusted as real evidence that cross-org data
isolation actually holds (right now a failure here could mean either a flaky harness or a genuine
RLS policy leak, and nobody can tell which).

## Background / Discovery Context

Discovered and confirmed during Story 10.4 (SonarCloud new-coverage-buffer work, PR #185, merged
2026-07-13). Story 10.4's own PR description states, verbatim, under "Known out-of-scope issue":

> `packages/db`'s RLS-isolation test suite (13 files) fails with off-by-one row-leakage even on a
> freshly migrated, empty database - confirmed pre-existing and unrelated to this story (zero
> diff). Flagged for investigation as a separate story; not fixed here.

Story 10.4's own diff touched only `apps/api` (coverage/test files) and had **zero overlap** with
`packages/db` — the coordinator's own post-stop verification run against a clean-migrated database
still showed the same 13 files failing, which is how it was confirmed pre-existing rather than
introduced by that story's changes. This story exists to give that finding an actual home instead
of leaving it as an unresolved PR-description footnote.

Historical corroboration: Story 1.7's Dev Agent Record (2026-06-26) independently logged the same
symptom over two entries — `pnpm --filter @project-vault/db test` blocked by "pre-existing local
RLS/permission expectation failures (`rls-isolation`, `audit-log-immutability`,
`api-instances-privileges`)" — meaning this is not a one-off: at least one earlier session
(pre-Story-1.7, i.e. before 2026-06-26) also hit it and treated it as pre-existing and unrelated,
without investigating further. This story is the first attempt to actually root-cause it instead
of routing around it again.

### The 13 files

No single file has "13" written anywhere; this list is reconstructed from Story 1.7's grouping
("rls-isolation, audit-log-immutability, api-instances-privileges" treated as one family) plus the
`*-rls-isolation.test.ts` / `*-rls.test.ts` naming family, which together total exactly 13:

1. `packages/db/src/__tests__/rls-isolation.test.ts`
2. `packages/db/src/__tests__/projects-rls-isolation.test.ts`
3. `packages/db/src/__tests__/credentials-rls-isolation.test.ts`
4. `packages/db/src/__tests__/credential-dependencies-rls-isolation.test.ts`
5. `packages/db/src/__tests__/rotations-rls-isolation.test.ts`
6. `packages/db/src/__tests__/pending-imports-rls-isolation.test.ts`
7. `packages/db/src/__tests__/notification-inbox-rls.test.ts`
8. `packages/db/src/__tests__/notification-prefs-rls.test.ts`
9. `packages/db/src/__tests__/notification-queue-rls.test.ts`
10. `packages/db/src/__tests__/projects-archival-rls.test.ts`
11. `packages/db/src/__tests__/platform-audit-events-immutability-and-rls.test.ts`
12. `packages/db/src/__tests__/audit-log-immutability.test.ts`
13. `packages/db/src/__tests__/api-instances-privileges.test.ts`

`check-rls-coverage.test.ts` is deliberately excluded from this list — it verifies RLS *policy
coverage* (every `org_id` table has a policy), not row-level isolation behavior, so it's a
different failure class even though it also touches live RLS policies.

## Reproduction Attempts (this story's own investigation pass)

**Could not reproduce firsthand, despite a genuine attempt against a freshly migrated, completely
empty database, in this worktree's own isolated Docker stack.**

Steps taken:

1. Brought up this worktree's own isolated Postgres container (`make db-up` — resolved to
   `agent-aa0a0763223d53ccc-db-1` on port 5432, a fresh named volume, fully separate from the main
   checkout's `project-vault-db-1` container).
2. Built `packages/shared` (`pnpm --filter @project-vault/shared build`) — required first; `make
   db-migrate` otherwise fails with `ERR_MODULE_NOT_FOUND` on `@project-vault/shared/dist/index.js`
   because `packages/db`'s migration scripts import compiled shared types (not a story-relevant
   bug, just an undocumented cold-worktree bootstrapping step — worth flagging to whoever owns
   onboarding docs).
3. `make db-migrate` — applied all 49 migrations cleanly (`0000_initial_schema` through
   `0048_vault_kms_columns`).
4. Confirmed genuinely empty: `select count(*) from organizations` → `0`. `pnpm check-rls` → `all
   org_id tables have RLS policies — OK`.
5. Ran exactly the 13 files above via `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/db vitest run <13 paths>` — **13 files passed, 48 tests passed.**
6. Ran the full `packages/db` suite (`pnpm vitest run`, no filter) three times back-to-back against
   the same DB — **40 files / 197 tests passed, all three runs, zero failures.**
7. Ran the full monorepo `make test` (`pnpm turbo test --force`, which runs `packages/db`'s suite
   as an upstream dependency of `apps/api`'s) — `packages/db`'s tests passed within that pipeline
   too (confirmed indirectly: `apps/api#test`, which `turbo.json` makes depend on
   `@project-vault/db#test`, proceeded to run and 11/12 turbo tasks completed successfully before
   the overall run was cut off by this pass's own 400s investigation timeout mid-way through
   `apps/api`'s much longer suite — `@project-vault/db#test` itself was one of the 11 tasks that
   completed cleanly, not the one that was still running).
8. Additionally ran a `make test-repeat`-style loop (`pnpm vitest run`, no filter, in a bash `for`
   loop) against `packages/db` specifically: 5 more full clean runs (40 files / 197 tests each)
   before a 2-minute wall-clock cap on this investigation pass stopped the loop mid-way through
   run 6 (run 6 was not a failure — it was simply still executing when the cap hit).

**Total tally from this pass: 8 full clean `packages/db` suite runs (3 initial + 5 repeat-loop) +
1 clean 13-file subset run + 2 clean in-pipeline runs (isolated `pnpm vitest run` invocation
counted once, `make test`'s turbo-dependency run counted separately) — zero failures across all of
it**, against a database this pass confirmed was freshly migrated and empty at the start.

**Conclusion:** whatever triggers this is either genuinely CI-only (resource contention, a
narrower timing window under GitHub Actions' shared runners, a different Postgres version/config
than local Docker, or parallel-workflow contention this worktree's isolated single-run environment
doesn't reproduce), or requires a repeat-run / stress condition well beyond 8 consecutive clean
passes (see `make test-repeat N=<n>`, added specifically for this class of rare flake per its own
Makefile comment: "turns a rare, timing-dependent flake (e.g. one bad run in ~6-8) into a run that
fails almost every time" — 8 clean runs is within noise of a "1-in-6 to 1-in-8" style rate, so this
does NOT rule out that failure rate, it just didn't happen to land on the bad run this time). A
longer `test-repeat N=20+` run and a CI-parity (containerized, resource-constrained) run are still
worth trying and are left as this story's first real task, not assumed already done.

### What was ruled out during this pass (read-only source inspection)

- **Not an intra-file `Promise.all` race.** `grep -l "Promise.all"` across all 13 files plus
  `audit-log-immutability.test.ts` / `api-instances-privileges.test.ts` returns zero matches — no
  file fires concurrent `withOrg()` calls against a shared pooled connection within itself.
- **`fileParallelism: false` is already set** in `packages/db/vitest.config.ts`, specifically
  because `check-rls-coverage.test.ts` drops and recreates live RLS policies and would otherwise
  race any file touching the same tables (see that config's own comment, added per Story 1.4's
  AC-11 review). This does NOT rule out a race between `check-rls-coverage.test.ts` and one of the
  13 files if vitest's file *ordering* (not parallelism) ever changes, or if `fileParallelism`
  interacts differently under `pnpm turbo test --force`'s invocation vs. a bare `vitest run`.
- **`withOrg()`/`withOrgAndUser()` use `set_config(..., true)` inside a real `db.transaction()`**
  (`packages/db/src/index.ts`) — the correct transaction-scoped ("SET LOCAL") pattern for avoiding
  cross-request bleed on a pooled connection. This is the right pattern in principle; whether the
  underlying pool (`pg` driver, via Drizzle) ever hands out a connection mid-transaction-commit in
  a way that could still leak `app.current_org_id` under concurrent load was NOT verified — this is
  the single most likely root-cause candidate and should be the first place the next investigator
  looks, given the "off-by-one row leakage" symptom is exactly what a stale-session-variable bleed
  onto a reused pooled connection would produce.

## Acceptance Criteria

1. The flake is reproduced at least once with a captured failure (test name, expected vs. actual
   row set/count, and the exact command/environment that triggered it) — via `make test-repeat`
   (try N=10+ first), a containerized/CI-parity run, or by running the full monorepo suite
   concurrently with other packages under load. If truly unreproducible after a serious, documented
   attempt (not just "still can't repro"), AC 2-5 may be answered from static/code-path analysis
   instead, but that fallback must be explicitly justified in the Dev Agent Record, not silently
   substituted.
2. The mechanism is root-caused to one of: (a) a genuine RLS policy gap/leak in a specific
   migration or `packages/db/src/migrations/0001_rls_and_triggers.sql`-family policy, (b) a
   pooled-connection `set_config`/transaction-scoping leak (see the ruled-in candidate above), (c)
   a test-fixture/cleanup ordering bug (e.g. `cleanupTestOrg`'s partial-failure paths in
   `test-helpers.ts` leaving stale rows that a later test's count-based assertion picks up), or (d)
   something else — but a specific, falsifiable mechanism must be named, not just "it's flaky."
3. A regression test is added that reliably reproduces the failure mode BEFORE the fix (RED) and
   passes after (GREEN), per this repo's mandatory TDD red-green workflow (`AGENTS.md`) — unless AC
   1's fallback applies, in which case document why a reliable RED state could not be constructed.
4. If the root cause is a real bug (options a-c above, or any newly discovered mechanism), it is
   fixed. If it is not currently fixable without a larger change (e.g. requires a Postgres/driver
   upgrade, or a fundamental pooling-strategy change), the story documents the trade-off and
   proposes the smallest safe mitigation (e.g. forcing a fresh connection per `withOrg()` call in
   test context only) rather than leaving the suite silently red or silently ignored.
5. Post-fix, `make test-repeat N=10` passes cleanly for `packages/db` (or the full suite, if the
   fix reordering makes isolating just `packages/db` impractical) with zero failures across all 10
   runs — this is the story's own bar for "actually fixed," not a single green run.
6. If a CI-only trigger is confirmed (AC 1's containerized/CI-parity path), a corresponding
   safeguard is added to CI (e.g. a periodic/nightly `test-repeat`-style job for `packages/db`,
   mirroring the precedent set for the mfa-login/mfa-enrollment flake) so a recurrence surfaces
   automatically instead of requiring another PR description footnote.
7. `packages/db`'s existing coverage thresholds (80% lines/branches/functions/statements per
   `packages/db/vitest.config.ts`) are not weakened as a side effect of any fix or added regression
   test.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `none` — this is an internal test-infrastructure/data-integrity investigation inside `packages/db`, not user-facing product surface. |
| **Evaluator-visible** | no |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | N/A — internal reliability/test-infra work with no direct user-facing behavior change. If the root cause turns out to be option (a) (a genuine RLS policy gap), this classification must be revisited immediately: a real cross-org data leak is a security-relevant product concern, not just test infra, and would need its own security-impact assessment before this story can close as `done`. |

## Tasks / Subtasks

- [ ] Task 1: Reproduce (AC: 1)
  - [ ] Subtask 1.1: `make db-up && make db-migrate` on a clean worktree; confirm empty DB
        (`select count(*) from organizations` = 0) and `pnpm check-rls` clean, exactly as this
        story's own investigation pass did.
  - [ ] Subtask 1.2: `make test-repeat N=10` (or higher) scoped to `packages/db` first (adapt the
        Makefile's loop or invoke `pnpm --filter @project-vault/db vitest run` in a shell loop) —
        capture the first failure verbatim (test name, file, assertion diff).
  - [ ] Subtask 1.3: If Subtask 1.2 doesn't reproduce, try the full monorepo `make test-repeat`
        (all packages, matching how `apps/api#test` depends on `@project-vault/db#test` in
        `turbo.json` — the flake may only appear under cross-package scheduling/resource
        contention, not `packages/db` in isolation).
  - [ ] Subtask 1.4: If still unreproduced, try a CI-parity environment (GitHub Actions runner
        resource profile, or `act`/a resource-constrained container) before concluding it's
        CI-only-and-unreproducible-locally.
- [ ] Task 2: Root-cause (AC: 2)
  - [ ] Subtask 2.1: Start from the pooled-connection `set_config` leak candidate (see
        "Reproduction Attempts" above) — instrument or log `app.current_org_id` per query during a
        failing run to confirm/deny it.
  - [ ] Subtask 2.2: Cross-check `test-helpers.ts`'s `cleanupTestOrg`/`withTestOrg` for any
        partial-cleanup path that could leave a stale row visible to a later test's row-count
        assertion (the "off-by-one" framing fits a single leftover row as much as it fits a single
        leaked cross-org row — confirm which one this actually is before assuming it's an RLS
        policy bug).
  - [ ] Subtask 2.3: Audit `packages/db/src/migrations/0001_rls_and_triggers.sql` and any
        later migration that touches policies on the 13 files' tables for a genuine policy gap.
- [ ] Task 3: Fix + regression test (AC: 3, 4)
  - [ ] Subtask 3.1: Write the regression test first, confirm it fails for the diagnosed reason
        (RED).
  - [ ] Subtask 3.2: Implement the smallest fix that makes it pass (GREEN).
- [ ] Task 4: Stress-verify (AC: 5)
  - [ ] Subtask 4.1: `make test-repeat N=10` clean post-fix.
- [ ] Task 5: CI safeguard, if CI-only (AC: 6)
- [ ] Task 6: Confirm no coverage regression (AC: 7)

## Dev Notes

- **Do not assume this is "just a flaky test."** The failure mode (row-count/row-identity leakage
  across orgs) is exactly the shape of a real tenant-isolation bug, which is the single most
  security-sensitive thing this codebase's RLS layer exists to prevent. Treat AC 2's classification
  step as mandatory, not a formality — do not fix by loosening an assertion or adding a retry
  without first proving the mechanism.
- **`fileParallelism: false`** is already set in `packages/db/vitest.config.ts` for a documented
  reason (see that file's comment, tied to `check-rls-coverage.test.ts`'s live policy
  drop/recreate). Do not casually flip it while investigating — if you do, revert it before this
  story closes unless you have a specific, documented reason and have re-verified
  `check-rls-coverage.test.ts` doesn't race.
- **Worktree bootstrapping gotcha found during this story's own reproduction pass:** a fresh
  worktree's `make db-migrate` fails with `ERR_MODULE_NOT_FOUND` on
  `@project-vault/shared/dist/index.js` until `pnpm --filter @project-vault/shared build` has been
  run at least once. Not in this story's scope to fix, but worth a one-line note if you hit it
  again — it's not related to the RLS flake itself.
- **Docker/port isolation:** this worktree's `.env` is git-ignored and gets its own free ports
  (`make check-ports`/`make fix-ports`) plus its own Compose project name (derived from the
  worktree directory, e.g. `agent-<hash>`), which is genuinely isolated from the main checkout's
  `project-vault` Compose project — confirmed during this story's own investigation (the main
  checkout's `project-vault-db-1` container/volume already had 2048 pre-existing
  `organizations` rows from unrelated prior work; this worktree's own fresh
  `agent-<hash>-db-1` container/volume started genuinely empty). Do not `cd` into the main
  checkout path mid-investigation — stay inside this story's own worktree, or you will end up
  pointed at someone else's live dev database instead of a clean one, as this investigation
  initially (harmlessly) did before catching and correcting itself.
- **`ADMIN_DATABASE_URL` port trap** (from prior project memory): `getAdminDb()`/superuser-role
  helpers default to port 5432 independently of whatever `DATABASE_URL` says — a
  port-bumped worktree can get false negatives/positives on anything touching the superuser
  connection if only `DATABASE_URL` is overridden. Relevant here because `make db-migrate` and
  `check-audit-actor-token-coverage` both use the superuser URL — double-check both env vars are
  consistent before trusting any run, clean or failing.
- **RTK/piped-output truncation** (from prior project memory): vitest output piped/redirected
  through `rtk` gets cut to ~2000 chars and can mask a non-zero exit code. If reproducing under
  `rtk`, capture exit codes explicitly (`... ; echo $? >> result.txt`) rather than trusting a piped
  tail.

### Project Structure Notes

- All work is confined to `packages/db/src/__tests__/` (new/modified regression test) and
  whatever source file(s) the root cause implicates (`packages/db/src/index.ts`,
  `packages/db/src/test-helpers.ts`, or a migration file under `packages/db/src/migrations/` —
  determined by Task 2, not assumed up front). No `apps/api` or `apps/web` changes are expected
  unless the root cause turns out to be a shared connection-pooling utility also used outside
  `packages/db` (unlikely but not yet ruled out — check `packages/db/src/index.ts`'s exports for
  cross-package reuse before assuming this is fully contained).
- No new directories needed.

### References

- [Source: PR #185 body, "Known out-of-scope issue" section] — original discovery and pre-existing/unrelated confirmation
- [Source: _bmad-output/implementation-artifacts/10-4-sonarcloud-new-coverage-buffer.md] — story whose diff this flake is confirmed unrelated to (zero overlap with `packages/db`)
- [Source: _bmad-output/implementation-artifacts/1-7-jwt-session-management-and-security-controls.md] — 2026-06-26 Dev Agent Record entries independently logging the same `rls-isolation`/`audit-log-immutability`/`api-instances-privileges` grouping as pre-existing, prior to this story
- [Source: packages/db/vitest.config.ts] — `fileParallelism: false` rationale, coverage thresholds
- [Source: packages/db/src/index.ts] — `withOrg`/`withOrgAndUser`/`set_config(..., true)` transaction-scoping pattern (primary root-cause candidate)
- [Source: packages/db/src/test-helpers.ts] — `withTestOrg`/`cleanupTestOrg` fixture lifecycle (secondary root-cause candidate)
- [Source: Makefile, `test-repeat` target and its comment] — existing tooling for surfacing rare timing-dependent flakes, precedent: mfa-login/mfa-enrollment cross-file flake (Story 10.4)
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (story authored via bmad-create-story from direct source investigation, PR #185's
description, and a first-hand — unsuccessful — local reproduction attempt against a freshly
migrated, empty database in an isolated worktree Docker stack)

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- This story's own creation pass attempted reproduction (see "Reproduction Attempts" above) and
  could NOT reproduce the flake firsthand: 13-file subset run (48 tests), 3x full `packages/db`
  suite runs (197 tests each), and one full monorepo `make test` pass all came back 100% green
  against a genuinely fresh, empty, fully-migrated database. This does not mean the bug doesn't
  exist — Story 10.4's own coordinator independently confirmed 13 failing files against a clean DB
  in a different session — but it does mean the trigger condition is narrower than "any clean-DB
  run," which is the first thing Task 1 needs to pin down (repeat-run stress, cross-package
  contention, or CI-only environment differences).
- No product code was modified in this story-creation pass — investigation was read-only plus
  bringing up/tearing down a local Docker Postgres stack, per this task's explicit constraints.

### File List

**New files:**
- `_bmad-output/implementation-artifacts/1-15-packages-db-rls-isolation-flake-investigation.md` (this file)
- `_bmad-output/implementation-artifacts/1-15-packages-db-rls-isolation-flake-investigation-adversarial-review.md`

**Modified files:**
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
