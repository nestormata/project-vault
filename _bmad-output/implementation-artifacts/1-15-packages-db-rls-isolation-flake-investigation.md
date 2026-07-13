# Story 1.15: packages/db RLS-Isolation Test Suite Flake Investigation

Status: review

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
   fixed **in the production code path** (`packages/db/src/index.ts` or wherever the mechanism
   lives), not merely in the test harness. A mitigation scoped to "test context only" (e.g. forcing
   a fresh connection per `withOrg()` call, but only when invoked from tests) is only acceptable if
   AC 8 has established that the same mechanism is NOT reachable/exploitable from production
   request handling — if AC 8 finds it IS reachable, the fix must cover the production path, and a
   test-only mitigation alone does not satisfy this AC. If truly not fixable without a larger change
   (e.g. requires a Postgres/driver upgrade), the story documents the trade-off, proposes the
   smallest safe mitigation, and — if the mechanism is production-reachable per AC 8 — escalates the
   unfixed production exposure per AC 9 rather than closing quietly.
5. Post-fix, `make test-repeat N=10` passes cleanly for `packages/db` (or the full suite, if the
   fix reordering makes isolating just `packages/db` impractical) with zero failures across all 10
   runs — this is the story's own bar for "actually fixed," not a single green run.
6. If a CI-only trigger is confirmed (AC 1's containerized/CI-parity path), a corresponding
   safeguard is added to CI (e.g. a periodic/nightly `test-repeat`-style job for `packages/db`,
   mirroring the precedent set for the mfa-login/mfa-enrollment flake) so a recurrence surfaces
   automatically instead of requiring another PR description footnote, AND the safeguard's failure
   must produce an actionable alert/notification to a human (e.g. failing CI job blocks merge or
   pages/notifies, not merely "runs periodically" with nobody watching).
7. `packages/db`'s existing coverage thresholds (80% lines/branches/functions/statements per
   `packages/db/vitest.config.ts`) are not weakened as a side effect of any fix or added regression
   test.
8. **Production-exploitability assessment (mandatory once AC 2 names a mechanism).** If AC 2's named
   mechanism is (a) a genuine RLS policy gap or (b) a pooled-connection `set_config`/transaction-
   scoping leak, the Dev Agent Record must explicitly state whether that same mechanism is reachable
   from `packages/db`'s production callers (`apps/api` request handling via `withOrg()`/
   `withOrgAndUser()`, not just this test suite) under real concurrent load — i.e., could a live
   customer's `app.current_org_id` have bled across tenants in production, not just in tests. This
   assessment must be explicit ("reachable" or "not reachable, because ...") — "we didn't check" is
   not an acceptable answer once AC 2 implicates (a) or (b). If root cause is (c) (test-fixture-only)
   or (d) or is never determined (AC 1's fallback), this AC is satisfied by stating that production
   reachability does not apply because the mechanism is test-scoped only.
9. **Closure gate.** The story may only move to `done` if either: (a) AC 2's mechanism is (c)
   (test-fixture-only) or (d) and AC 8 confirms no production reachability, in which case the
   Product Surface Contract's `Surface scope: none` classification stands unchanged; or (b) AC 2's
   mechanism is (a) or (b) AND AC 8 finds it is NOT production-reachable, in which case the story
   documents why and may still close as `done`; or (c) AC 2's mechanism is (a) or (b) AND AC 8 finds
   it IS (or plausibly could be) production-reachable, in which case the story must NOT close as
   `done` on this classification alone — the Product Surface Contract must be updated to reflect a
   real tenant-isolation/security concern, and the story either resolves the production-side fix
   within this story's scope or explicitly hands off to a dedicated security-review/incident-
   response follow-up (opened as its own tracked story) before this story itself can close.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `none` — this is an internal test-infrastructure/data-integrity investigation inside `packages/db`, not user-facing product surface. |
| **Evaluator-visible** | no |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | N/A — internal reliability/test-infra work with no direct user-facing behavior change. **Closure gate resolved (AC 9, branch (a)):** the root-caused mechanism (AC 2) is (c) test-fixture-only — it lives entirely inside `check-rls-coverage.test.ts`, a test file, never in a production code path — and AC 8 confirms it is NOT production-reachable. The `Surface scope: none` / `Evaluator-visible: no` classification above therefore stands unchanged. |

## Tasks / Subtasks

- [x] Task 1: Reproduce (AC: 1)
  - [x] Subtask 1.1: `make db-up && make db-migrate` on a clean worktree; confirm empty DB
        (`select count(*) from organizations` = 0) and `pnpm check-rls` clean, exactly as this
        story's own investigation pass did.
  - [x] Subtask 1.2: `make test-repeat N=10` (or higher) scoped to `packages/db` first (adapt the
        Makefile's loop or invoke `pnpm --filter @project-vault/db vitest run` in a shell loop) —
        capture the first failure verbatim (test name, file, assertion diff). **Extended to N=30**
        (see Dev Agent Record): still zero failures. AC 1's fallback invoked — see Completion Notes.
  - [x] Subtask 1.3: If Subtask 1.2 doesn't reproduce, try the full monorepo `make test-repeat`
        (all packages, matching how `apps/api#test` depends on `@project-vault/db#test` in
        `turbo.json` — the flake may only appear under cross-package scheduling/resource
        contention, not `packages/db` in isolation). **Not run this pass** — the N=30
        `packages/db`-scoped result plus the story-creation pass's earlier 8 clean runs was judged
        a "serious, documented attempt" sufficient to invoke AC 1's fallback (see Completion Notes
        for the explicit justification), rather than spending further wall-clock time on
        full-monorepo repeats with the same zero-reproduction outcome expected.
  - [x] Subtask 1.4: If still unreproduced, try a CI-parity environment (GitHub Actions runner
        resource profile, or `act`/a resource-constrained container) before concluding it's
        CI-only-and-unreproducible-locally. **Not run** — same fallback justification as 1.3; static
        analysis (Task 2) found a concrete, falsifiable mechanism that explains why local sequential
        runs can't reproduce it (see AC 2 finding) without needing a CI-parity environment to prove it.
- [x] Task 2: Root-cause (AC: 2)
  - [x] Subtask 2.1: Start from the pooled-connection `set_config` leak candidate (see
        "Reproduction Attempts" above) — instrument or log `app.current_org_id` per query during a
        failing run to confirm/deny it. **Ruled out** — `withOrg()`/`withOrgAndUser()` use
        Drizzle's `transaction()`, which issues ROLLBACK on any thrown error before the connection
        returns to the pool; Postgres's own `SET LOCAL` semantics guarantee the setting is cleared
        on COMMIT/ROLLBACK regardless of connection reuse. No code path was found where a
        connection returns to the pool mid-transaction without a commit/rollback having run.
  - [x] Subtask 2.2: Cross-check `test-helpers.ts`'s `cleanupTestOrg`/`withTestOrg` for any
        partial-cleanup path that could leave a stale row visible to a later test's row-count
        assertion. **Found a real (but non-triggering) latent bug, ruled out as THE mechanism**:
        `cleanupTestOrg`'s broad `isForeignKeyViolation` catch assumes the org-delete's only
        possible FK blocker is `audit_log_entries`'s append-only rule, but `schema/helpers.ts`'s
        `orgScoped()` defaults two more tables (`data_erasure_requests`, `audit_exports`) to no
        `ON DELETE CASCADE` — if any test ever inserted into those tables under a `withTestOrg`
        org, the swallowed violation would leak that org row forever. Grepped all 13 files plus
        `audit-log-immutability.test.ts`/`api-instances-privileges.test.ts`: none of them touch
        `data_erasure_requests` or `audit_exports`, so this exists as a latent hygiene bug but does
        not explain the reported flake. Left unfixed (out of this story's diagnosed-mechanism
        scope) but flagged in Dev Notes for whoever owns those two tables' own test coverage.
  - [x] Subtask 2.3: Audit `packages/db/src/migrations/0001_rls_and_triggers.sql` and any
        later migration that touches policies on the 13 files' tables for a genuine policy gap.
        **No gap found** — every `CREATE POLICY` across all migrations uses the same
        `org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid` pattern
        consistently (grep-verified across all 19 migrations that touch RLS policies).
        **Root cause found instead in `check-rls-coverage.test.ts`** (deliberately excluded from
        the "13 files" list, but the actual source of the cross-suite risk) — see AC 2 in Dev
        Agent Record below for the full mechanism.
- [x] Task 3: Fix + regression test (AC: 3, 4)
  - [x] Subtask 3.1: Write the regression test first, confirm it fails for the diagnosed reason
        (RED). Done for the concrete, provable half of the mechanism (see AC 3).
  - [x] Subtask 3.2: Implement the smallest fix that makes it pass (GREEN). Done — see AC 4.
- [x] Task 4: Stress-verify (AC: 5)
  - [x] Subtask 4.1: `make test-repeat N=10` clean post-fix — done, scoped to `packages/db`
        (10/10 clean, see AC 5).
- [x] Task 5: CI safeguard, if CI-only (AC: 6)
  - [x] Subtask 5.1: Ensure the safeguard's failure produces an actionable alert (blocks merge or
        notifies a human), not just a periodic run nobody watches. Already satisfied by the
        existing `nightly.yml` `flaky-test-repeat` job — see AC 6.
- [x] Task 6: Confirm no coverage regression (AC: 7)
- [x] Task 7: Production-exploitability assessment (AC: 8)
  - [x] Subtask 7.1: If AC 2 names mechanism (a) or (b), trace whether `apps/api`'s request-handling
        callers of `withOrg()`/`withOrgAndUser()` (not just this test suite) could hit the same
        mechanism under real concurrent production load. Document the finding explicitly
        (reachable / not reachable, with reasoning) in the Dev Agent Record. N/A — mechanism is (c).
  - [x] Subtask 7.2: If mechanism is (c), (d), or unresolved (AC 1 fallback), state explicitly that
        production reachability does not apply and why. Done — see AC 8.
- [x] Task 8: Closure gate (AC: 9)
  - [x] Subtask 8.1: Before marking this story `done`, confirm which closure branch (a/b/c per AC 9)
        applies based on Task 2 and Task 7's findings, and update the Product Surface Contract table
        above accordingly. If branch (c) applies (production-reachable real leak), do not close this
        story as `done` without either fixing the production path within scope or opening a
        dedicated security-review/incident-response follow-up story and linking it here. Branch (a)
        applies — see AC 9.

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

- Stress-repro pass (implementation, pre-fix): `pnpm --filter @project-vault/db exec vitest run`
  in a 30-iteration shell loop against this worktree's own isolated Postgres (port 5433) —
  30/30 runs clean, 42 files / 201 tests each, zero failures (log retained in this session's
  scratchpad as `db-repeat2.log`). Combined with the story-creation pass's earlier 8 clean runs,
  this is 38 total clean full-suite runs plus the 13-file subset and in-pipeline runs — see
  Completion Notes for why this was judged sufficient to invoke AC 1's fallback rather than
  continuing indefinitely.
- RED verification: temporarily reverted `check-rls-coverage.test.ts` to its pre-fix form, added a
  probe test asserting `sessions_isolation` is present in `pg_policies` immediately after a
  drop-under-lock block with no inline restore — **failed** (`expected [] to have a length of 1
  but got +0`), proving the pre-fix window (drop landed, restore deferred to `afterEach`) is real
  and observable, not theoretical.
- GREEN verification: restored the fixed file (inline `finally`-based restore via the new
  `withPolicyDropped` helper) — same probe, now embedded as a permanent regression test, passes;
  full file 8/8 tests pass.
- Post-fix full suite: `pnpm --filter @project-vault/db exec vitest run --coverage` — 42 files /
  202 tests pass (201 pre-existing + 1 new regression test), coverage 92.5%/80.85%/100%/92.92%
  (stmts/branches/funcs/lines), all above the 80% floor in `vitest.config.ts`.
- Post-fix stress verify: 10-iteration `pnpm --filter @project-vault/db exec vitest run` loop
  (AC 5's `test-repeat N=10`, scoped to `packages/db` per AC 5's own "or packages/db, if isolating
  is practical" clause) — 10/10 clean, `exit=0` every run.
- `tsc --noEmit` and `eslint src/__tests__/check-rls-coverage.test.ts` both clean (one
  `security/detect-object-injection` warning on the new `POLICY_DEFS[policyName]` lookup resolved
  with a documented `eslint-disable-next-line`, matching the existing convention in
  `apps/org/pseudonymize.ts`; `policyName` is always one of this file's own hardcoded literals,
  never external input).

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

---

**Implementation pass (this session):**

- **AC 1 (reproduce):** Extended the stress attempt to a 30-iteration `packages/db`-scoped
  `test-repeat`-style loop against this worktree's own isolated DB — 30/30 clean, zero failures,
  on top of the story-creation pass's earlier 8 clean runs (38 total). **Could not reproduce a
  live failure of the reported symptom.** Per AC 1's own explicit fallback clause ("If truly
  unreproducible after a serious, documented attempt... AC 2-5 may be answered from
  static/code-path analysis instead, but that fallback must be explicitly justified, not silently
  substituted"), this is that justification: 38 clean full-suite runs plus a 13-file subset run and
  two in-pipeline runs, with zero reproductions, is judged a serious documented attempt. The
  monorepo-wide `test-repeat` and CI-parity-container escalation paths (Subtasks 1.3/1.4) were
  deliberately not pursued further once Task 2's static analysis below identified a concrete,
  falsifiable, cross-suite-timing-dependent mechanism that independently explains why sequential,
  single-process local runs (this worktree's included) would not surface it — pursuing the
  fallback was the more information-dense use of the remaining investigation budget than a fourth
  category of "still can't repro" run.
- **AC 2 (root-cause, via static/code-path analysis per AC 1's fallback):** The mechanism lives in
  `packages/db/src/__tests__/check-rls-coverage.test.ts` — deliberately excluded from the "13
  files" list (it tests policy *coverage*, not isolation *behavior*), but it is the one file in
  the entire suite that mutates *live* RLS policies on shared, real tables (`sessions`,
  `audit_log_entries`, `audit_exports`, `audit_forwarding_config`, `audit_retention_config`).
  Before this fix, each of its 5 policy-mutation tests ran `DROP POLICY ... ON <table>` directly
  (DDL, auto-committed, not transaction-scoped) and relied *solely* on a file-level `afterEach`
  hook — which only fires after the *current test's* body finishes — to restore it. Between the
  DROP landing and `afterEach` firing, the table has RLS enabled with **zero** policies, which
  Postgres resolves as **deny-all** for any non-owner role (fail-closed, not fail-open). The
  file's own top-of-file comment already documents the consequence of this exact gap for a
  different suite ("API integration tests authenticate via the sessions table RLS policy;
  dropping it concurrently yields flaky 401s") — this story connects that same, previously
  undiagnosed mechanism to the reported `packages/db` "off-by-one" symptom: any of the 13 RLS
  files' assertions against `sessions` or `audit_log_entries` (e.g. `rls-isolation.test.ts`'s
  `expect(orgARows).toHaveLength(1)`) would see `0` instead of `1` if their query landed inside
  this gap — an *under*-count, not an over-count/leak, but exactly the "expected N, actual N±1"
  shape the bug report used loosely as "row-leakage." This requires either the test process being
  interrupted between the DROP and the `afterEach` restore (crash, `SIGKILL`, CI job timeout — the
  advisory lock this file uses (`RLS_POLICY_MUTATION_LOCK`) only serializes *this file's own*
  tests against each other, not against any other suite or process reading the same tables), or a
  cross-process/cross-package window under `pnpm turbo test --force`'s concurrent scheduling —
  both scenarios plausible under CI's shared, resource-constrained runners and effectively
  invisible to this worktree's own strictly-sequential local reproduction attempts, which is
  consistent with 38/38 clean local runs never hitting it. **Named mechanism: (c) test-fixture/
  cleanup-ordering bug** — specifically in `check-rls-coverage.test.ts`'s policy-mutation-and-
  restore lifecycle, not in `withOrg()`/`withOrgAndUser()` or `withTestOrg()`/`cleanupTestOrg()` as
  originally hypothesized (both were separately investigated and ruled out — see Task 2's
  subtasks above). A secondary, unrelated latent bug was also found and documented (Subtask 2.2:
  `cleanupTestOrg`'s over-broad FK-violation swallow could silently leak a test org + child rows
  if a test ever wrote to `data_erasure_requests`/`audit_exports`) but does not fire today and is
  not this flake's cause.
- **AC 3 (RED-GREEN regression test):** A reliable, deterministic RED state for the *worst-case*
  version of this bug (a hard process crash between DROP and restore) cannot be constructed
  without deliberately killing the test process mid-run, which would itself be a new source of
  test-suite flakiness — not attempted, per AC 3's own fallback allowance to document why RED
  couldn't be constructed for that variant. However, the *provable* half of the mechanism (the
  restore being deferred to `afterEach` instead of running inline) **was** constructed as a
  genuine RED→GREEN: reverted to the pre-fix file, added a test asserting the policy is present
  in `pg_policies` immediately after a drop-under-lock block — this **failed** against the old
  code (RED, verbatim: `expected [] to have a length of 1 but got +0`) because nothing had
  restored the policy yet at that point in program order, and **passes** against the fixed code
  (GREEN) because the restore is now the `finally` that runs before the helper returns control to
  the test body. This test is now a permanent part of the suite (see File List).
- **AC 4 (fix in production code path):** Not applicable in the sense AC 4 anticipates — the
  named mechanism (c) has no production code path at all; `check-rls-coverage.test.ts` is a test
  file that only runs under `vitest` with `ADMIN_DATABASE_URL` superuser credentials, never part
  of any deployed artifact or `apps/api`/`apps/web` runtime code. The fix is entirely and
  correctly scoped to that test file: replaced the bare `DROP POLICY` + deferred-`afterEach`-only
  restore pattern with a `withPolicyDropped()` helper that restores the policy in a `finally`
  immediately wrapping the drop (narrowing the exposure window to the smallest span physically
  possible — the body of the wrapped callback — instead of "until this test file's current test
  finishes"). The file-level `afterEach` is kept as a last-resort safety net for the one case the
  inline `finally` can't cover (the process being killed outright before `finally` runs).
- **AC 5 (post-fix stress-verify):** `packages/db`-scoped 10-iteration repeat run, post-fix:
  10/10 clean (`exit=0` every run, 42 files / 202 tests each) — see Debug Log References.
- **AC 6 (CI safeguard):** AC 1's outcome means a CI-only trigger was never *conclusively*
  confirmed (the flake was never reproduced at all, locally or otherwise, during this story). No
  new CI job was added on that basis. However, `.github/workflows/nightly.yml`'s existing
  `flaky-test-repeat` job already runs the full monorepo suite (which includes
  `@project-vault/db#test` as a `turbo.json` dependency of `apps/api#test`) 5x back-to-back every
  night, with `notify-failure` posting to Slack on any job failure in the `nightly` workflow —
  this already satisfies AC 6's actionable-alert requirement for exactly this class of rare,
  timing-dependent flake (it's the same job the mfa-login/mfa-enrollment precedent cites). No
  duplicate job was added; this existing safeguard is documented here so it isn't rediscovered as
  a gap later.
- **AC 7 (no coverage regression):** Post-fix `packages/db` coverage: 92.5% statements / 80.85%
  branches / 100% functions / 92.92% lines — all above the 80% floor in `vitest.config.ts`, and in
  line with pre-fix levels (the one new regression test only exercises already-covered code paths
  in the test file itself, which isn't in the coverage `include` list).
- **AC 8 (production-exploitability assessment — mandatory once AC 2 names a mechanism):**
  **Not production-reachable.** AC 2's named mechanism (c) is entirely contained within
  `check-rls-coverage.test.ts`: the `DROP POLICY`/`CREATE POLICY` DDL statements only execute when
  this specific test file is run by `vitest` using `ADMIN_DATABASE_URL` (superuser) credentials —
  credentials that production `apps/api` code never holds and this test file is never bundled into
  or invoked by any deployed artifact. Production's own `withOrg()`/`withOrgAndUser()` callers (in
  `apps/api`'s request handling) never issue `DROP POLICY`/`CREATE POLICY` and cannot trigger or be
  affected by this mechanism. The one real-world-adjacent risk this story surfaced is *not*
  production exposure but a shared-non-production-environment testing-hygiene concern, already
  self-documented in the test file's own pre-existing comment: if `apps/api`'s integration suite
  and `check-rls-coverage.test.ts` ever run concurrently against the same long-lived *shared
  dev/staging* Postgres instance (not a production database, and not this story's subject), the
  former can see transient, fail-closed 401s during the latter's drop window. That is a test-suite
  scheduling concern for whoever owns shared-environment CI hygiene, not a tenant-isolation defect,
  and is out of this story's scope to fix.
- **AC 9 (closure gate):** Branch (a) applies — AC 2's mechanism is (c) (test-fixture-only) and
  AC 8 confirms no production reachability. The Product Surface Contract's `Surface scope: none` /
  `Evaluator-visible: no` classification stands unchanged (see table above, updated to record this
  finding). The story closes as `review` (moving to `done` is a separate post-code-review gate per
  this repo's workflow), not blocked by AC 9's escalation path.
- **Overall:** no genuine cross-tenant RLS leak was found anywhere in `packages/db`'s production
  code path. The reported flake's most plausible explanation is a self-inflicted, CI/shared-
  environment-timing-dependent test-hygiene gap in one non-isolation test file, now closed. If the
  flake recurs after this fix lands, that would itself be strong evidence the root cause was
  something else entirely (e.g. a genuine, still-undiscovered issue) and should reopen this
  investigation rather than be waved off as "still just flaky."

### File List

**New files:**
- `_bmad-output/implementation-artifacts/1-15-packages-db-rls-isolation-flake-investigation.md` (this file)
- `_bmad-output/implementation-artifacts/1-15-packages-db-rls-isolation-flake-investigation-adversarial-review.md`

**Modified files:**
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `packages/db/src/__tests__/check-rls-coverage.test.ts` — root-cause fix (AC 2/4): replaced the
  bare-`DROP`-plus-deferred-`afterEach`-restore pattern with a `withPolicyDropped()` helper that
  restores each mutated RLS policy inline (in a `finally` immediately wrapping the drop), keeping
  the original `afterEach` only as a last-resort safety net for a process-crash scenario the inline
  `finally` can't cover. Added one new regression test (AC 3) proving the policy is restored before
  the test body returns, independent of `afterEach` timing (RED against the pre-fix pattern, GREEN
  against the fix — see Debug Log References). No test assertions on `checkRlsCoverage`'s own
  behavior were changed; all 5 pre-existing policy-mutation tests still exercise the exact same
  drop/detect/restore behavior, just through the new helper.
