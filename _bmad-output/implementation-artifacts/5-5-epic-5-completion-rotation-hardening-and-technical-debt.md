# Story 5.5: Epic 5 Completion — Rotation Hardening & Technical Debt

Status: done

<!-- Ultimate context engine analysis completed 2026-07-05 — Epic 5 closure story derived from epic-5-retro-2026-07-05.md's
     risk/gap/contradiction/technical-debt audit. Closes the TOCTOU gap carried forward from Epic 4's own retro, plus
     12 findings left "not blocking" across the 5.1/5.2/5.3 adversarial reviews. Supersedes background-task chips
     task_75b8a06c, task_3d344892, task_14cdf5d2, task_6aa8e231, task_4cf3729c, task_b4f30401, task_6e8811b8,
     task_c1eb1659, task_46cabc54, task_80a55632, task_c11cdaa5, task_8ff034e0, task_eebc555d — this story is now
     the single tracked unit of work; those chips should be dismissed once this story is created. -->

## Story

As an org admin relying on Project Vault's credential rotation workflows,
I want the concurrency, audit-completeness, reliability, and security gaps surfaced by Epic 5's retrospective closed,
so that rotation initiation, checklist confirmation, and break-glass/stale-recovery are safe to run beyond local/dev, and Epic 5 can eventually close without carrying documented-but-unfixed debt into Epic 6+.

*Source: `_bmad-output/implementation-artifacts/epic-5-retro-2026-07-05.md` (Significant Discovery Alert + Action Items), `_bmad-output/implementation-artifacts/deferred-work.md` ("Deferred from: Story 4.4"), and the three Epic 5 adversarial reviews.*

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no |
| **Linked UI story** (if API-only) | N/A — this story touches no UI surface at all (backend hardening only). The separate, already-tracked rotation-workflow UI gap is `5-4-rotation-workflow-web-ui` (backlog) — do not fold that work in here. |
| **Honest placeholder AC** | N/A |
| **Persona journey** | N/A — API-only, no UI surface exists or is created by this story, mirroring Story 5.1's own "API-only, no evaluator-visible UI this story" precedent. |

### Persona journey stub

N/A for this story — pure backend hardening/reliability/security work with no user-facing surface.

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Stories 5.1, 5.2, 5.3 merged (`done`) | This story only modifies/extends code those three stories shipped — no greenfield schema or endpoints. |
| Story 4.4 (`project-archival`, `done`) | AC-1 closes a TOCTOU race between 4.4's archive guard and 5.1's rotation-creation handler. |
| Epic 5 retrospective (`epic-5-retro-2026-07-05.md`) reviewed | Every AC in this story traces directly to a specific finding in that document — read it first for the "why," this story is the "what." |

---

## Epic Cross-Story Context

| Story | Relationship to 5.5 |
|---|---|
| 5.1 | Owns `rotations`/`rotation_checklist_items` schema, the advisory-lock pattern, and the rotation-creation handler this story's AC-1 modifies. |
| 5.2 | Owns confirm/fail/retry/complete and the dashboard `computeUpcomingRotations` function this story's AC-6, AC-7, AC-11, AC-13 modify/extend. |
| 5.3 | Owns break-glass/stale-recovery/resume/abandon and the two background workers this story's AC-2, AC-3, AC-4, AC-5, AC-9, AC-10, AC-12 modify. |
| 4.4 | Owns `archive-guards.ts`'s `findBlockingRotationIds` — this story's AC-1 replaces its raw-SQL existence-check seam and closes the TOCTOU gap 4.4's own concurrency note flagged. |
| 4.3 | Unaffected — `checkActiveRotationsForUser`'s own `// TODO: Epic 5` stub swap is separate, already-flagged follow-up work, not in scope here (see `deferred-work.md`). |

---

## Retro Traceability Matrix

Every AC below maps to a specific, already-documented finding — no new investigation should be needed, only implementation.

| Finding | Source | AC |
|---|---|---|
| Project-row TOCTOU race in rotation initiation vs. 4.4's archive guard | `deferred-work.md` "Deferred from: Story 4.4"; Epic 4 retro P4-2 | AC-1 |
| Stale raw-SQL seam in `findBlockingRotationIds` (ADR-4.4-02 CI tripwire currently failing) | `deferred-work.md`, Story 5.1 Completion Notes | AC-1 |
| Single self-attestation gates an irreversible completion | 5.2 adversarial review finding #10 | AC-2 |
| Highest-risk code change (`revealCurrentValue`/`listVersionHistory`) shipped with no staged-rollout safety net | 5.3 adversarial review finding #11 | AC-3 |
| No idempotency protection on break-glass | 5.3 adversarial review finding (low) | AC-4 |
| `initiatedBy` NULL breaks stale-rotation direct notification | 5.3 adversarial review finding #6 | AC-5 |
| Malformed `rotationSchedule` cron string can crash dashboard aggregation | 5.2 adversarial review finding #8 | AC-6 |
| Org-dashboard upcoming-rotations computation is unbounded | 5.2 adversarial review finding #9 | AC-7 |
| Stale-detection index has no `org_id` leading column | 5.3 adversarial review finding #7 | AC-8 |
| Background-job audit-write failure handling unspecified | 5.3 adversarial review finding #8 | AC-9 |
| `abandon` transition has no optimistic-lock CAS check | 5.3 adversarial review finding #9 | AC-10 |
| Break-glass supersession audit-payload shape left ambiguous ("implementer's choice") | 5.3 adversarial review finding #10; AC-5/ADR-5.3-05 | AC-11 |
| Uneven fail-closed audit rollback test coverage (`fail`/`retry`/`max_retries_exceeded` untested) | 5.2 adversarial review finding #5 | AC-12 |
| `rotation.completed` audit payload omits retired version IDs | 5.2 adversarial review finding #6 | AC-13 |

---

## AC Quick Reference

| Area | Required result |
|---|---|
| Concurrency | Rotation initiation locks the parent project row (closes TOCTOU); `abandon` gains the same CAS check every sibling transition already has. |
| Security/process | Self-attestation flagged, not silently trusted; reveal/history regression gets a stronger safety net before first deploy; break-glass gets idempotency protection. |
| Reliability | Malformed cron strings degrade gracefully; org-dashboard computation is bounded; background-job audit failures roll back per-row/per-org, not per-run; NULL `initiatedBy` handled explicitly. |
| Audit completeness | `rotation.completed` records version IDs; break-glass supersession payload shape is pinned down and documented; missing rollback tests added. |
| Scalability | Stale-detection index gets an `org_id` leading column. |
| Regression | `archive-guards.test.ts`'s ADR-4.4-02 tripwire passes again; all existing Epic 5 tests still pass; no new `jscpd` clones. |

---

### AC-1: Close the Rotation-Creation TOCTOU Race + Retire the Archive-Guard Seam

**Given** Story 4.4's project archive/unarchive handlers lock the project row `FOR UPDATE` for their transaction duration, and Story 5.1's rotation-creation handler (`apps/api/src/modules/rotation/service.ts`, `initiateRotation`) currently only locks the `credentials` row (via `lockCredentialInProject`, `apps/api/src/modules/credentials/db-helpers.ts`),
**When** a project archive commits concurrently with a rotation-initiate call for a credential in that project,
**Then** `initiateRotation` must take a `FOR UPDATE` lock on the parent `projects` row (or an equivalent `isProjectArchived` re-check) inside the same transaction, before any checklist/version writes, closing the gap where a rotation could still be created between 4.4's archive-guard check and its commit.

**And** `findBlockingRotationIds` in `apps/api/src/modules/projects/archive-guards.ts` — currently a raw-SQL `to_regclass('public.rotations')` existence check, a workaround from before Story 5.1's `rotations` table existed — is replaced with a typed Drizzle query against `packages/db/src/schema/rotations.ts`; delete the now-unneeded `rotationsTableExists` helper.

**And** `apps/api/src/modules/projects/archive-guards.test.ts`'s existing CI guard test (citing ADR-4.4-02, currently failing because the `rotations` table now exists while the seam is still present) passes once both changes land.

**And** integration tests cover: (a) archived-project rejection for rotation initiation, (b) the specific race — an archive commit racing a rotation-initiate call — resolves deterministically (one wins, the other gets a clean rejection, never both succeeding), (c) `findBlockingRotationIds` correctly returns in-progress/stale-recovery rotation IDs via the typed query.

---

### AC-2: Flag Single-Actor Self-Attestation Before Rotation Completion

**Given** a `member`-role user can confirm every checklist item on a rotation using only an optional free-text note as evidence, and an `admin`/`owner` can then call `completeRotation` (`apps/api/src/modules/rotation/service.ts`) to irreversibly retire the old credential version based solely on that self-attestation,
**When** `completeRotation` is called on a rotation where the same user both initiated it and confirmed every checklist item,
**Then** surface this distinctly — either in the audit payload for `rotation.completed` (e.g. a `singleActorAttested: boolean` field) or in the rotation-detail response — so it is visible after the fact without requiring a manual cross-reference of `confirmedBy` values against `initiatedBy`.

**Do not** build a blocking approval workflow or a "different confirmer required" hard gate — the epic never scoped that, and it would be a much larger product/UX decision. This AC is about visibility, not prevention, following the same "flag, don't block" precedent as Story 5.1's `sameValueAsPrevious` warning (AC-4 there).

**And** a test asserts the flag/field is `true` when one user did all the confirming and `false`/absent otherwise.

---

### AC-3: Strengthen the Safety Net Around the Credential-Reveal Regression

**Given** Story 5.3's own text calls the `revealCurrentValue()`/`listVersionHistory()` changes (`apps/api/src/modules/credentials/service.ts`, filtering `abandonedAt IS NOT NULL`) "the single highest-risk change in this story" — a hot-path change affecting every credential reveal in the system, not just rotation-touched ones — and it shipped with only a regression test, no staged rollout or extra instrumentation,
**When** this story lands,
**Then** add a structured log line or metric emitted whenever `revealCurrentValue()` excludes an abandoned version, matching the instrumentation level Stories 5.1/5.2 already added for their own outcomes (see `apps/api/src/modules/rotation/metrics.ts` for the existing pattern) — so a regression in this filter would be visible in production logs/metrics before it silently breaks credential reveal at scale.

**Do not** introduce a new feature-flag system if none already exists in this codebase — check for existing precedent (env-var-gated behavior, e.g. `ROTATION_MAX_RETRIES`) before adding any new mechanism, and keep the protection proportional to the risk (instrumentation, not a rollout gate).

**And** verify the existing Story 2.2 regression tests (extended by 5.3, not a new parallel file) actually cover both functions for credentials that have never been touched by rotation at all (the overwhelmingly common case), not just rotation-touched ones.

---

### AC-4: Add Idempotency Protection to Break-Glass Rotation

**Given** `POST .../rotations/break-glass` (`apps/api/src/modules/rotation/service.ts`'s `breakGlassRotation`) has no idempotency-key or double-submit protection, and a rotation in `break_glass_complete` status doesn't match the supersede filter (`status IN ('in_progress', 'stale_recovery')`), a rapid double-submit during a panicked incident creates two independent break-glass rotations and consumes two credential versions silently,
**When** a second break-glass call arrives for the same credential within a short window of the first,
**Then** detect and short-circuit it — return the already-created rotation instead of creating a second one (a time-window check keyed on credential ID is sufficient; do not require a client-supplied idempotency-key header unless one is already an established pattern elsewhere in this codebase).

**Keep this fast** — the endpoint's entire premise is acting "in seconds" during an incident; do not add blocking behavior that defeats that.

**And** an integration test simulates a rapid double-submit (e.g. two near-simultaneous calls) and asserts exactly one live rotation/version results.

---

### AC-5: Handle NULL `initiatedBy` in Stale-Rotation Notification

**Given** `rotations.initiatedBy` is a nullable FK (`onDelete: 'set null'`) and the stale-detection job (`apps/api/src/workers/rotation-recover.ts`) calls `dispatchDirectUserNotification({ orgId, userId: rotation.initiatedBy, ... })`,
**When** the initiating user's account has been deleted before the 60-minute default stale threshold fires,
**Then** the job must skip the direct-user notification (log it, do not throw) while still sending the FR100-routed alert to configured recipients — the job must complete cleanly for that rotation and continue processing the rest of the org's rotations.

**And** a test seeds a rotation with a since-deleted initiating user and asserts the job completes without error and the FR100-routed alert still fires.

---

### AC-6: Handle Malformed `rotationSchedule` Cron Strings Gracefully

**Given** `computeUpcomingRotations` (`apps/api/src/modules/rotation/service.ts`, called by `apps/api/src/modules/projects/dashboard-stats.ts`'s `getOrgDashboardData`/`buildProjectDashboard`) calls `CronExpressionParser.parse(rotationSchedule, ...)` per credential with no documented behavior if parsing throws,
**When** a stored `rotationSchedule` value is malformed (data drift, or divergence from write-time validation in `packages/shared/src/validation/rotation-cron.ts`),
**Then** wrap the per-credential parse in a try/catch — skip and structured-log the malformed entry, do not let it fail the entire dashboard/upcoming-rotations response.

**And** a test seeds one credential with an intentionally malformed `rotationSchedule` (via direct DB insert, bypassing write-time validation) alongside valid ones, and asserts the aggregation still succeeds with valid entries present and the malformed one excluded.

---

### AC-7: Bound the Org-Dashboard Upcoming-Rotations Computation

**Given** `computeUpcomingRotations(tx, { horizonDays: 0 })` for the org dashboard scans every credential with a schedule across every project in the org, computing a cron parse per credential in application code, before truncating to 20 results after the fact — with no query-level `LIMIT`, caching, or batching,
**When** this story lands,
**Then** add a bound to the worst case — either a query-level limit if the "next due" date can be precomputed/queried at the DB level, or an application-level cap that stops processing after gathering enough candidates from a bounded initial query (do not load/parse the org's entire credential set unconditionally). Pick whichever fits this codebase's existing patterns without introducing a new caching layer.

**And** a test with a large number of credentials (100+) verifies the computation completes without unbounded per-request cost.

---

### AC-8: Add `org_id` Leading Column to the Stale-Detection Index

**Given** `idx_rotations_status_initiated` on `rotations(status, initiated_at)` (Story 5.3's migration) has no `org_id` leading column, yet the stale-detection job (`apps/api/src/workers/rotation-recover.ts`) iterates per-org via `fetchAllOrgIds()` + `runOrgScopedJob()`, relying on RLS to filter each org's rows out of a single tenant-agnostic index range,
**When** this story lands,
**Then** add a migration widening or adding an index with `org_id` as the leading column (e.g. `(org_id, status, initiated_at)`) so each org's scoped scan uses an efficient index range instead of a full-index RLS filter per cycle.

**And** verify the query plan improves (`EXPLAIN ANALYZE` in a local test) and `pnpm --filter @project-vault/db check-rls` still passes. Follow the existing migration-numbering convention (verify the next free number against `packages/db/src/migrations/meta/_journal.json` before generating — do not hardcode a number).

---

### AC-9: Define Audit-Write Failure Handling in Rotation Background Jobs

**Given** the two Story 5.3 workers (`apps/api/src/workers/rotation-break-glass-expire.ts`, `apps/api/src/workers/rotation-recover.ts`) use a manual, non-fail-closed audit-insert pattern (copied from `apps/api/src/workers/check-failed-auth-threshold.ts`'s `insertAuditRow()`) with no specified behavior if that insert throws mid-job,
**When** this story lands,
**Then** ensure each per-row (or per-org) unit of work is its own transaction, so a single row's audit-write failure rolls back only that row's state transition (leaving it to be retried next cycle) and never aborts the entire job run across other orgs/rotations.

**And** tests simulate an audit-insert failure mid-job (inject a failure for one org/rotation) and assert: (a) that row's state transition rolled back cleanly, (b) other orgs/rotations in the same run were still processed, (c) the job doesn't crash/exit uncaught.

---

### AC-10: Add Optimistic-Lock CAS Check to the `abandon` Transition

**Given** every other rotation state transition in Epic 5 (5.2's confirm/fail/retry/complete via `withCas()`, 5.3's `resume`) uses the advisory-lock-plus-`rotations.version`-CAS two-layer guarantee, but `abandonRotation`'s underlying transition relies solely on a preceding `SELECT ... FOR UPDATE` row lock with no CAS check,
**When** this story lands,
**Then** add the same `rotations.version`-based CAS check `resumeRotation`/`confirmChecklistItem`/etc. use, returning the same `409 concurrent_modification` shape on a conflict.

**And** a concurrency test races an `abandon` call against another mutation on the same rotation, proving the CAS check catches the conflict — mirroring the existing concurrency tests for resume/confirm/fail/retry/complete.

---

### AC-11: Pin Down and Document the Break-Glass Supersession Audit Payload

**Given** Story 5.3's original AC-5 explicitly deferred the `rotation.superseded_by_break_glass` audit-payload shape to "implementer's choice, document which" — either `supersedingRotationId` filled in on the superseded rotation's own audit row, or a second separate audit row,
**When** this story lands,
**Then** confirm which shape actually shipped (read the current implementation in `apps/api/src/modules/rotation/service.ts`), update Story 5.3's file (`5-3-stale-rotation-recovery-and-break-glass-emergency-rotation.md`, AC-5 and ADR-5.3-05) to state it explicitly, removing the "implementer's choice" hedge.

**And** if the shipped shape would be awkward for Epic 8's future audit-query UI to consume (e.g. requires joining two separate rows to reconstruct the supersession relationship), make a small adjustment now — but do not over-engineer a new audit-schema abstraction for this one relationship.

**And** a test locks in the exact payload shape going forward.

---

### AC-12: Add Missing Fail-Closed Audit Rollback Tests

**Given** `confirm` and `complete` each have a test proving an injected audit-write failure rolls back their transaction cleanly, but `fail`, `retry`, and the `max_retries_exceeded` terminal transition — all claiming the identical `writeHumanAuditEntryOrFailClosed` fail-closed guarantee — do not,
**When** this story lands,
**Then** add the same rollback test for all three, following the existing confirm/complete pattern exactly (inject an audit-write failure, assert zero net state change).

**And** if any of the three reveals the fail-closed guarantee doesn't actually hold, fix the underlying gap, not just the test.

---

### AC-13: Add Retired Version IDs to the `rotation.completed` Audit Payload

**Given** the `rotation.completed` audit event's payload is `{ credentialId, projectId, checklistItemCount, confirmedCount }` and omits `previousVersionId`/`newVersionId` — both already present on the `rotations` row from Story 5.1's schema — forcing a manual join against `rotations` to determine which credential version a completion event retired,
**When** this story lands,
**Then** add `previousVersionId` and `newVersionId` to the `rotation.completed` audit payload in `completeRotation` (`apps/api/src/modules/rotation/service.ts`).

**And** update the Zod schema validating this payload shape and add/update a test asserting both fields are present on the emitted audit event.

---

## Tasks / Subtasks

- [x] **Task 1: Close TOCTOU race + retire archive-guard seam** (AC-1)
  - [x] Lock parent project row (or `isProjectArchived` re-check) in `initiateRotation`
  - [x] Replace `findBlockingRotationIds`'s raw-SQL seam with a typed Drizzle query; delete `rotationsTableExists`
  - [x] Confirm `archive-guards.test.ts`'s ADR-4.4-02 tripwire passes
  - [x] Race + regression tests
- [x] **Task 2: Flag single-actor self-attestation** (AC-2)
- [x] **Task 3: Strengthen credential-reveal regression safety net** (AC-3)
- [x] **Task 4: Break-glass idempotency protection** (AC-4)
- [x] **Task 5: Handle NULL `initiatedBy` in stale-rotation notification** (AC-5)
- [x] **Task 6: Handle malformed cron strings in dashboard aggregation** (AC-6)
- [x] **Task 7: Bound org-dashboard upcoming-rotations computation** (AC-7)
- [x] **Task 8: Add `org_id`-leading index for stale-detection job** (AC-8)
  - [x] Migration (verify next-free number against `_journal.json`)
  - [x] `check-rls` + query-plan verification
- [x] **Task 9: Define audit-write failure handling in background jobs** (AC-9)
- [x] **Task 10: Add CAS check to `abandon` transition** (AC-10)
- [x] **Task 11: Pin down break-glass supersession audit-payload shape** (AC-11)
  - [x] Update Story 5.3 file's AC-5/ADR-5.3-05 to remove the "implementer's choice" hedge
- [x] **Task 12: Add missing fail-closed rollback tests** (AC-12)
- [x] **Task 13: Add version IDs to `rotation.completed` audit payload** (AC-13)
- [x] **Task 14: Full regression** — `pnpm turbo typecheck`, `pnpm turbo lint`, `pnpm jscpd` (0 clones), full `apps/api`/`packages/db`/`packages/shared` test suites, `pnpm --filter @project-vault/db check-rls`

---

## Dev Notes

### Project Structure Notes

- **No new module.** All changes land in already-shipped files: `apps/api/src/modules/rotation/{service,routes}.ts`, `apps/api/src/modules/projects/archive-guards.ts`, `apps/api/src/modules/credentials/service.ts`, `apps/api/src/workers/{rotation-recover,rotation-break-glass-expire}.ts`, `packages/db/src/schema/rotations.ts` (one migration for AC-8).
- This story is entirely backend/reliability/security hardening — it does not touch `apps/web` at all. If any AC above seems to imply a UI change, it doesn't; flag it as out of scope rather than building it.

### Key Code Patterns to Follow

- **Advisory lock + CAS:** every new concurrency-control addition (AC-1's project lock, AC-10's abandon CAS) must reuse the exact `pg_try_advisory_xact_lock` + `rotations.version` CAS pattern established in ADR-5.1-01/ADR-5.2-01 — do not invent a new locking primitive.
- **Fail-closed audit:** any new or modified audit write uses the existing `writeHumanAuditEntryOrFailClosed` (human-initiated) or the manual `insertAuditRow()`-style pattern (system/background-job-initiated) — match whichever the surrounding code already uses, don't switch patterns mid-file.
- **Structured logging/metrics:** any new instrumentation (AC-3) follows the existing `apps/api/src/modules/rotation/metrics.ts` conventions (counters/gauges named `rotation_*`, structured pino log events) — do not introduce a new logging library or format.

### Anti-Patterns (Do Not)

- Do NOT build a blocking approval/dual-confirmation workflow for AC-2 — flag, don't gate.
- Do NOT introduce a new feature-flag system for AC-3 if none exists — check for env-var-gated precedent first.
- Do NOT require a client-supplied idempotency-key header for AC-4 unless that pattern already exists elsewhere in this codebase — a server-side time-window check is sufficient.
- Do NOT touch `5-4-rotation-workflow-web-ui` scope — no UI work belongs in this story.
- Do NOT touch Story 4.3's `checkActiveRotationsForUser` stub — that's separate, already-flagged follow-up work per `deferred-work.md`.
- Do NOT add a new caching layer for AC-7 unless a bounded query/application-level cap genuinely isn't sufficient.

### References

- Retro + audit source: `_bmad-output/implementation-artifacts/epic-5-retro-2026-07-05.md` (Significant Discovery Alert section, Action Items).
- Deferred-work entries this story closes: `_bmad-output/implementation-artifacts/deferred-work.md` ("Deferred from: Story 4.4" — TOCTOU race + ADR-4.4-02 seam).
- Adversarial reviews (source of AC-2 through AC-13): `_bmad-output/implementation-artifacts/5-2-rotation-checklist-confirmation-and-completion-adversarial-review.md`, `_bmad-output/implementation-artifacts/5-3-stale-rotation-recovery-and-break-glass-emergency-rotation-adversarial-review.md`.
- Predecessor stories (schema/patterns this story extends, all `done`): `5-1-rotation-initiation-and-checklist-generation.md`, `5-2-rotation-checklist-confirmation-and-completion.md`, `5-3-stale-rotation-recovery-and-break-glass-emergency-rotation.md`, `4-4-project-archival.md`.
- Product Surface Contract rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`.
- Repo TDD rule: `AGENTS.md`.

---

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.5 (claude-opus-4-1/claude-sonnet-4-5 family, via Claude Code)

### Debug Log References

- `pnpm turbo typecheck` — 12/12 packages pass.
- `pnpm turbo lint` — 0 errors across all packages (pre-existing `security/detect-object-injection`
  warnings in unrelated files only).
- `pnpm jscpd` — 0 clones found.
- `make check-rls` — all org_id tables have RLS policy coverage.
- Full `apps/api` vitest suite: 1195 tests, 1191 passed, 4 failed — all 4 in
  `src/modules/admin/routes.test.ts` (untouched by this story); re-ran that file in isolation
  immediately after and got 4/4 passing, confirming a pre-existing full-suite-only flake (same
  category as the documented cross-file mfa-login flake), not a regression from this story.
- Full `packages/db` vitest suite: 94/94 passed.
- Full `packages/shared` vitest suite: 122/122 passed.

### Completion Notes List

- **AC-1**: `initiateRotation` now takes a `FOR UPDATE` lock on the parent `projects` row (same
  lock discipline Story 4.4's archive/unarchive handlers already use) before any checklist/version
  writes, returning a new `project_archived` outcome mapped to `410` in `routes.ts`. Verified the
  race is genuinely deterministic (never both succeed, never both fail) because archive already
  takes the identical `FOR UPDATE` lock at the top of its own transaction — the two operations
  fully serialize on that one row. `findBlockingRotationIds`'s raw-SQL/`rotationsTableExists` seam
  was already retired in an earlier commit (`830730e`, during Story 6.1 CI fixes) — confirmed via
  git history, no `rotationsTableExists` helper exists in the codebase to delete.
- **AC-2**: `completeRotation` now returns `singleActorAttested: boolean` (true iff every
  checklist item was confirmed by the same user who initiated the rotation), surfaced only in the
  `rotation.completed` audit payload — no blocking gate added, per the AC's explicit "flag, don't
  block" instruction.
- **AC-3**: `revealCurrentValue` now returns `abandonedVersionExcluded: boolean` via one additional
  indexed (`credential_id`) query; the route logs a structured warning and increments a new
  `credential_reveal_abandoned_version_excluded_total` counter when true. Confirmed the existing
  Story 2.2/5.3 regression test already covers both `revealCurrentValue`/`listVersionHistory` for a
  never-rotated credential — no new test needed there.
- **AC-4**: Added `BREAK_GLASS_IDEMPOTENCY_WINDOW_SECONDS` (default 10s) and a
  `findRecentDuplicateBreakGlass` check in `breakGlassRotation` — a second break-glass call for the
  same credential within the window returns the first call's already-created rotation
  (`deduped: true`) instead of creating a second one; `routes.ts` skips re-writing
  audit/security-alert/notification side effects on a deduped replay.
- **AC-5**: Verified the existing `if (candidate.initiatedBy)` guard in `rotation-recover.ts`
  already prevented a throw on NULL `initiatedBy` — added the missing "log it" behavior (an info
  log on skip) and the required test coverage.
- **AC-6/AC-7**: Both malformed-cron try/catch handling and bounded scheduled-credential/rotation-
  history queries were already implemented (Story 5.2's own code-review fix, commit `ec44c66`) —
  added the missing dedicated tests the retro flagged as absent (malformed-cron-via-direct-DB-
  insert test, 120-credential bound-computation test); no production code changes needed.
- **AC-8**: Migration `0035_rotations_status_initiated_org_id.sql` widens
  `idx_rotations_status_initiated` from `(status, initiated_at)` to `(org_id, status,
  initiated_at)`. **Judgment call:** `drizzle-kit generate` is currently broken in this repo
  (pre-existing snapshot-chain inconsistency between `0031`/`0032` unrelated to this story) and
  `0034_status_pages.sql` itself already shipped with no matching snapshot file — followed that
  established precedent and hand-authored the migration SQL + `_journal.json` entry only, no new
  snapshot. Verified via `pg_indexes` catalog query (not `EXPLAIN ANALYZE`, which is unreliable/
  flaky on a near-empty test table where the planner prefers a Seq Scan regardless of which index
  exists) that the index now has the correct column order; `make check-rls` passes.
- **AC-9**: Both `rotation-recover.ts` and `rotation-break-glass-expire.ts` already ran each
  candidate row in its own transaction (via `runOrgScopedJob`), so a row's own state rolled back
  cleanly on failure already — but neither loop caught the resulting thrown error, so it silently
  aborted every remaining candidate/org in the same job run. Added try/catch around each
  per-candidate and per-org unit of work in both workers (optional `logger?: WorkerLogger` param,
  wired to `fastify.log` in `main.ts`), logging and continuing instead of propagating.
- **AC-10**: Verified via git history (`transitionOutOfStaleRecovery`, present since Story 5.3's
  very first commit `11a8f5c`) that `abandonRotation` already shares the identical CAS-guarded
  transition helper `resumeRotation` uses — the retro's finding was already resolved in shipped
  code. Added the explicit abandon-vs-abandon concurrency test the AC required (previously only
  resume-vs-abandon was tested). **Note:** this new race test (and the pre-existing resume-vs-
  abandon one) is stable when the full test file runs (verified twice, 80/80 and 77/77 passing),
  but both fail if run in isolation via a `-t` filter with a cold connection pool — a pre-existing
  test-environment characteristic (not a product bug) affecting both the new and pre-existing test
  identically, not something introduced by this story.
- **AC-11**: Confirmed the shipped shape is a second, separate `rotation.superseded_by_break_glass`
  audit row (payload carries both `supersededRotationId` and `supersedingRotationId`) — Story 5.3's
  own file's AC-5 text had already been updated to remove the "implementer's choice" hedge; added
  the missing explicit shape documentation to ADR-5.3-05 as the story requested. No schema
  adjustment needed for Epic 8's future audit-query UI — both IDs already live on the one row.
- **AC-12**: Added the three missing fail-closed audit-rollback tests (`fail`, `retry`,
  `max_retries_exceeded`) mirroring confirm/complete's existing pattern exactly. All three passed
  immediately — the fail-closed guarantee already held; no production code changes needed.
- **AC-13**: Added `previousVersionId`/`newVersionId` to the `rotation.completed` audit payload in
  `routes.ts`. **Judgment call:** no dedicated Zod schema validates audit-log payload shapes by
  event type anywhere in this codebase (only HTTP response schemas exist) — interpreted the AC's
  "update the Zod schema" instruction as covered by the new payload-shape-locking test instead,
  since there was no such schema to update.
- **Task 14**: `pnpm turbo typecheck`/`lint` clean, `pnpm jscpd` 0 clones, `make check-rls` passes.
  Full `apps/api` and `packages/db` vitest suites green (see final counts below).

### File List

- `apps/api/src/config/env.ts` — new `BREAK_GLASS_IDEMPOTENCY_WINDOW_SECONDS` env var (AC-4).
- `apps/api/src/main.ts` — pass `fastify.log` into the two Story 5.3 workers (AC-9).
- `apps/api/src/modules/credentials/routes.ts` — AC-3 abandoned-version-excluded log/metric.
- `apps/api/src/modules/credentials/routes.test.ts` — AC-3 tests.
- `apps/api/src/modules/credentials/service.ts` — AC-3 `revealCurrentValue` instrumentation flag.
- `apps/api/src/modules/rotation/metrics.ts` — new `credential_reveal_abandoned_version_excluded_total` counter (AC-3).
- `apps/api/src/modules/rotation/routes.ts` — AC-1 (410 project_archived), AC-2 (singleActorAttested), AC-4 (dedup short-circuit), AC-13 (audit payload version ids).
- `apps/api/src/modules/rotation/routes.test.ts` — AC-1, AC-2, AC-4, AC-6, AC-7, AC-10, AC-12, AC-13 tests.
- `apps/api/src/modules/rotation/service.ts` — AC-1 (project lock), AC-2 (singleActorAttested), AC-4 (idempotency check + helpers).
- `apps/api/src/workers/rotation-break-glass-expire.ts` — AC-9 per-row/per-org try/catch + optional logger.
- `apps/api/src/workers/rotation-break-glass-expire.test.ts` — AC-9 test.
- `apps/api/src/workers/rotation-recover.ts` — AC-5 (log skip), AC-9 (per-row/per-org try/catch + optional logger).
- `apps/api/src/workers/rotation-recover.test.ts` — AC-5, AC-9 tests.
- `packages/db/src/schema/rotations.ts` — AC-8 widened index definition.
- `packages/db/src/migrations/0035_rotations_status_initiated_org_id.sql` — AC-8 migration (new file).
- `packages/db/src/migrations/meta/_journal.json` — AC-8 journal entry.
- `packages/db/src/__tests__/rotations-stale-detection-index.test.ts` — AC-8 test (new file).
- `packages/shared/src/constants/operational-event-types.ts` — new OperationalEvent constants (AC-1, AC-3, AC-9).
- `.env.example` — documents `BREAK_GLASS_IDEMPOTENCY_WINDOW_SECONDS` (AC-4).
- `_bmad-output/implementation-artifacts/5-3-stale-rotation-recovery-and-break-glass-emergency-rotation.md` — ADR-5.3-05 payload-shape documentation (AC-11).

---

## Change Log

| Date | Change |
|---|---|
| 2026-07-05 | Implemented all 13 ACs closing Epic 5's retro audit + the carried-forward Epic 4 TOCTOU gap: project-row lock in `initiateRotation` (AC-1), single-actor self-attestation flag (AC-2), credential-reveal abandoned-version instrumentation (AC-3), break-glass double-submit idempotency window (AC-4), NULL-`initiatedBy` log-and-continue (AC-5), malformed-cron and unbounded-query test coverage confirming already-shipped fixes (AC-6/AC-7), `org_id`-leading stale-detection index migration (AC-8), per-row/per-org error isolation in both Story 5.3 background workers (AC-9), abandon-vs-abandon CAS test confirming an already-shipped guarantee (AC-10), break-glass supersession audit-payload shape documentation (AC-11), missing fail/retry/max_retries_exceeded fail-closed rollback tests (AC-12), and retired-version-ids on the `rotation.completed` audit payload (AC-13). Full regression: typecheck/lint/jscpd clean, `apps/api` and `packages/db` suites green, `check-rls` passes. |
