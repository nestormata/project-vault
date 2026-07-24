# Story 13.1: Backfill `current_version_id` for Existing Credentials

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a platform operator upgrading to a version of Project Vault that ships multi-field secrets,
I want every existing credential's `current_version_id` backfilled automatically during the upgrade,
so that no credential is left with an undefined "current version" after the upgrade completes.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `none` |
| **Evaluator-visible** | no |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | N/A — see rationale below |

### Persona journey stub

N/A. This is a pure internal data migration: it adds a nullable FK column, backfills it for pre-existing
rows, and produces no new UI, no new API route, and no observable change to any existing endpoint's
response shape. Rationale for `none` (not `api`): the column added here (`credentials.current_version_id`)
is inert in this story — nothing reads or writes it yet. It becomes load-bearing (and thus
evaluator/UI-relevant) starting in Story 13.2, which is the story responsible for a persona journey and
any UI surface. No credential list/detail response, reveal endpoint, or rotation flow changes behavior
as a result of this story. There is no user-facing capability to build a placeholder AC for.

## Acceptance Criteria

1. **Given** a Postgres database with existing `credentials` rows created before this migration,
   **when** the Phase 2 migration runs,
   **then** `credentials.current_version_id` is set for every row to the `id` of its latest
   `credential_versions` row by `created_at`.

   - *Positive example:* Credential `C1` has one `credential_versions` row `V1` created `2026-01-01`.
     After migration, `C1.current_version_id = V1.id`.
   - *Positive example:* A credential belonging to org `org-b` and a credential belonging to org `org-a`
     both get backfilled correctly in the same migration run — the backfill is not scoped by RLS session
     context (none is available inside a migration; see Dev Notes) but by explicit join on
     `credential_versions.credential_id`, so cross-org correctness must be verified with fixtures from
     at least two distinct orgs.
   - *Negative/edge example:* A credential with `credential_versions` rows that were soft-marked
     `purged_at IS NOT NULL` (retention-purged) or `abandoned_at IS NOT NULL` (abandoned rotation
     candidate) still counts as a real version for "latest by `created_at`" purposes — this backfill is
     about *pointer* correctness, not filtering out lifecycle states. Do not exclude purged/abandoned
     rows from the `MAX(created_at)` computation; only a genuinely absent row (AC-4/AC-5) is skipped.

2. **Given** a credential with multiple existing versions,
   **when** the backfill runs,
   **then** `current_version_id` points to the most recently created version, not the first.

   - *Positive example:* Credential `C2` has versions `V1` (`created_at = 2026-01-01`), `V2`
     (`2026-02-15`), `V3` (`2026-03-01`). After backfill, `C2.current_version_id = V3.id`.
   - *Negative/edge example (tie-break):* Two versions of the same credential share the exact same
     `created_at` timestamp (possible if a test/seed script or a fast automated import created both in
     the same transaction/clock tick). The backfill must be deterministic on ties — order the tiebreak by
     `id` (e.g. `ORDER BY created_at DESC, id DESC LIMIT 1`) so the same row is chosen on every run,
     including on re-runs (idempotency, AC-6). Document the tiebreak rule in the migration's header
     comment so it isn't accidentally reversed by a future edit.
   - *Negative/edge example:* Do not use `version_number` as the ordering key even though it usually
     correlates with recency — `created_at` is the AC's explicit source of truth, and `version_number`
     is not guaranteed monotonic with `created_at` under clock skew or manual data repair scenarios.

3. **And** the migration must complete before the application version that assumes non-null
   `current_version_id` deploys — documented as an explicit deployment-ordering requirement in the
   migration's own header comment and the upgrade runbook.

   - *Positive example:* Migration header comment states plainly: "This migration must be applied and
     completed before deploying any application version whose code assumes
     `credentials.current_version_id` is non-null. Deploying app code that reads
     `current_version_id` as guaranteed-non-null before this migration completes will crash on any
     row this backfill has not yet reached, or (if `current_version_id` is added as nullable in this
     same migration and NOT-NULL enforcement is deferred) read `NULL` and mis-render."
   - *Positive example:* `docs/operational-runbook.md` (or wherever the existing upgrade runbook lives —
     see Dev Notes for the confirmed path) gains a new "Phase 2 upgrade — multi-field secrets" section
     naming this migration by number and stating the same ordering constraint in operator-facing language
     (i.e., "run `make db-migrate` and confirm it completes with zero skipped/orphaned rows in the
     summary output before deploying the new application image").
   - *Negative/edge example:* The migration must **not** add `current_version_id` as `NOT NULL` in the
     same statement/migration that adds the column — `packages/db/src/lib/migration-safety.ts`'s guarded
     migration runner (`guarded-migrate.ts`) rejects `ADD COLUMN ... NOT NULL` without a `DEFAULT` as a
     destructive-pattern violation, and even with a default, adding `NOT NULL` before every row is
     backfilled would break the "skip and log orphaned rows" requirement (AC-4) since a zero-version
     credential has no valid default. Sequence: add column nullable → backfill via UPDATE → (a **later**,
     separate migration, out of this story's scope, adds `NOT NULL` once app code no longer needs to
     tolerate legacy zero-version credentials, or documents that constraint is deliberately deferred).

4. **Given** existing `credential_versions` rows,
   **when** the migration runs,
   **then** their `schema_version` column defaults to `1` (legacy bare-string format) and `field_meta`
   remains `NULL` — no re-encryption, no ciphertext touched.

   - *Positive example:* `credential_versions.schema_version SMALLINT NOT NULL DEFAULT 1` is added as a
     column-level default — this is a safe `ADD COLUMN ... NOT NULL DEFAULT 1` (has a default, passes the
     guarded-migration destructive check) and requires **no backfill UPDATE at all**; Postgres applies the
     default to every existing row as part of the `ALTER TABLE`. After migration, `SELECT schema_version
     FROM credential_versions` returns `1` for every pre-existing row without a separate UPDATE
     statement.
   - *Positive example:* `credential_versions.field_meta JSONB` is added nullable, no default — existing
     rows get `NULL`, matching the AC exactly.
   - *Negative/edge example:* `encrypted_value` (the existing encrypted-envelope column) must be byte-for-
     byte unchanged after migration for every pre-existing row — assert this explicitly in the migration
     test (compare `encrypted_value` before/after) since this AC's entire point is "no re-encryption, no
     ciphertext touched." A regression here would corrupt every existing secret in the fleet.

5. **Given** a `credentials` row with zero `credential_versions` rows (orphaned/corrupted state),
   **when** the backfill runs,
   **then** it skips that row, logs it explicitly, and surfaces it in the migration's summary output
   rather than crashing the migration or silently leaving `current_version_id` in an undefined state.

   - *Positive example:* Credential `C3` has zero rows in `credential_versions` (e.g. due to a historical
     data-integrity issue, a partially-failed import, or manual test-data cleanup that left it orphaned).
     After the backfill runs, `C3.current_version_id` remains `NULL` (not an error, not a fabricated
     placeholder version), and the migration's output includes a `RAISE NOTICE` (or equivalent, see Dev
     Notes) explicitly naming `C3`'s id so an operator scanning migration output sees it called out, not
     buried.
   - *Positive example:* If 3 out of 10,000 credentials are orphaned, the migration still completes
     successfully (exit code 0) — "skips and logs" means the migration continues past that row, not that
     it aborts. A summary count (e.g. "9997 credentials backfilled, 3 skipped (zero versions) — see
     notices above for ids") appears at the end of the migration run.
   - *Negative/edge example:* This is explicitly **not** the same failure mode as a crash — verify (in
     the migration test) that the migration's exit code is 0 / it does not throw when it encounters a
     zero-version credential, distinguishing this from a genuine SQL error.
   - *Negative/edge example:* A follow-up operational question this story surfaces but does not resolve:
     should `current_version_id IS NULL` post-migration (for a credential with real, non-zero
     `credential_versions` history) be treated differently from "brand-new credential mid-creation
     transaction, not yet committed a version"? This story's backfill only ever runs once, at migration
     time, against already-committed data, so it cannot observe an in-flight creation transaction — this
     is a note for Story 13.2, not an AC for this story to satisfy.

6. **And** this story requires an integration test verifying:
   (a) a credential with 5 versions backfills to the version with the max `created_at`,
   (b) a credential with exactly 1 version backfills correctly,
   (c) the migration is idempotent — running it twice produces the same result,
   (d) a credential with zero versions is skipped and logged, not crashed on.

   - *Positive example (a):* Seed 5 `credential_versions` rows with distinct `created_at` values in
     non-insertion order (e.g. insert the 3rd-oldest first) to guard against an implementation that
     accidentally relies on insertion/id order instead of `created_at`. Assert `current_version_id`
     equals the row with the actual max `created_at`.
   - *Positive example (b):* Single-version credential — assert `current_version_id` equals that one
     version's id. This is the common case (every credential created before Epic 13 shipped its first
     multi-version feature had exactly 1 version at minimum, absent rotation).
   - *Positive example (c) — idempotency:* Run the backfill UPDATE, capture `current_version_id` for all
     test credentials, run it again, assert values are byte-identical. Additionally assert `updated_at`
     on `credentials` is **not** bumped a second time by the second run if the UPDATE is written with a
     `WHERE current_version_id IS DISTINCT FROM <computed value>` guard (recommended — see Dev Notes on
     the `set_updated_at` trigger side effect); if the story's chosen implementation instead does an
     unconditional `WHERE current_version_id IS NULL` (also idempotent, since already-backfilled rows no
     longer match), assert that a second run is a no-op with zero rows affected instead.
   - *Positive example (d):* Covered by AC-5's test above — zero-version credential remains `NULL`,
     migration does not throw, and (if a companion summary/notice mechanism is implemented) it appears in
     that output.
   - *Negative/edge example:* Add a 6th case beyond the AC's literal (a)-(d): a credential with versions
     that include `purged_at`/`abandoned_at` set (lifecycle-marked, per AC-1's edge example) still
     backfills correctly to the true latest by `created_at`, proving the query doesn't accidentally
     filter these out.
   - *Test-isolation note:* Per this repo's established convention (see migration 0043/0044 tests), do
     **not** invoke the actual `.sql` migration file against the shared dev database. Reproduce the exact
     backfill `UPDATE` statement inline in the test, scoped to a fresh test org created via
     `withTestOrg`/`createTestUser` from `packages/db/src/test-helpers.ts`, so this test never touches
     unrelated data from other tests running concurrently against the same database.

7. **Given** the backfill `UPDATE` runs against a `credentials` table at production scale,
   **when** the migration executes,
   **then** the lock duration and re-run safety of the operation are explicit, documented properties —
   not implicit assumptions discovered at deploy time.

   - *Positive example:* The migration header comment states the expected row-count scale this
     single-statement UPDATE was validated against (see Dev Notes — "Operational impact" for the
     decision and threshold), and confirms via the idempotency guard (`WHERE current_version_id IS
     NULL`) that a killed/interrupted migration run is always safe to simply re-run — no manual cleanup
     required.
   - *Negative/edge example:* If the operator's fleet has an unusually large `credentials` table (see
     Dev Notes threshold), running this migration during peak traffic could hold a table-level lock long
     enough to cause visible latency/timeouts on concurrent credential reads/writes — this is an
     **operational impact**, not covered by "Surface scope: none" (which only speaks to application-code
     and API-response changes, not migration-time lock behavior). The runbook update (AC-3) must mention
     running this migration during a low-traffic maintenance window as a precaution, even though no
     batching is implemented in this story.
   - *Negative/edge example:* Add a regression test asserting the migration's `RAISE NOTICE` output for
     a skipped/orphaned credential (AC-5) contains only the credential's `id` — never `encrypted_value`
     or any decrypted/plaintext field — so a future edit to the NOTICE message can't accidentally leak
     sensitive data into migration logs, which are often retained/shipped to less-restricted log
     aggregation than application logs.

## Tasks / Subtasks

- [x] Task 1: Add `current_version_id` and `credential_versions.schema_version`/`field_meta` columns (AC: 1, 3, 4)
  - [x] Subtask 1.1: Determine the next migration number by checking `packages/db/src/migrations/meta/_journal.json` / the highest-numbered `.sql` file at implementation time — do not hardcode a number now (this repo has had a real migration-number collision on a parallel branch before; see Dev Notes).
  - [x] Subtask 1.2: Author `NNNN_credentials_current_version_id.sql` (or a combined single migration if preferred — see Dev Notes on sequencing options) adding `credentials.current_version_id UUID NULL REFERENCES credential_versions(id)` (nullable, no default — deliberately not NOT NULL yet, per AC-3).
  - [x] Subtask 1.3: In the same or a co-located migration, add `credential_versions.schema_version SMALLINT NOT NULL DEFAULT 1` and `credential_versions.field_meta JSONB NULL` (AC-4) — no backfill UPDATE needed for these two, the column default/nullability handles existing rows automatically.
  - [x] Subtask 1.4: Write the migration's header comment per house style (see `0043`/`0044` precedent in Dev Notes) documenting: purpose, AC references, the tiebreak rule (AC-2), the deployment-ordering requirement (AC-3), and the "no RLS session context inside a migration" note.
- [x] Task 2: Write the backfill `UPDATE` statement (AC: 1, 2, 5)
  - [x] Subtask 2.1: `UPDATE credentials SET current_version_id = (SELECT id FROM credential_versions WHERE credential_id = credentials.id ORDER BY created_at DESC, id DESC LIMIT 1) WHERE current_version_id IS NULL` (or equivalent set-based form) — join-scoped, not RLS-scoped.
  - [x] Subtask 2.2: Add a `RAISE NOTICE` (or a `DO $$ ... $$` block producing one) for each credential where the correlated subquery returns no row, naming the credential's id explicitly (AC-5).
  - [x] Subtask 2.3: Add a final summary `RAISE NOTICE` reporting counts backfilled vs. skipped.
- [x] Task 3: Update Drizzle schema source of truth (AC: 1, 4)
  - [x] Subtask 3.1: Add `currentVersionId` to `packages/db/src/schema/credentials.ts` matching the new column (nullable UUID FK).
  - [x] Subtask 3.2: Add `schemaVersion` and `fieldMeta` to `packages/db/src/schema/credential-versions.ts`.
  - [x] Subtask 3.3: Confirm `drizzle-kit generate` (or a manual diff check) does not propose a duplicate/conflicting migration against the hand-authored SQL — hand-authored migrations must stay in sync with the schema file per this repo's established convention.
- [x] Task 4: Update the upgrade runbook (AC: 3)
  - [x] Subtask 4.1: Locate the existing operational/upgrade runbook (see Dev Notes — likely `9-5-operational-runbook-and-deployment-guide.md`'s delivered doc) and add the Phase 2 migration-ordering note.
- [x] Task 5: Integration tests (AC: 6, plus edge cases from AC-1/2/5)
  - [x] Subtask 5.1: Create `packages/db/src/__tests__/migration-NNNN-current-version-id-backfill.test.ts` following the `migration-0044-...`/`migration-0043-...` reproduced-statement pattern.
  - [x] Subtask 5.2: Implement the 6 cases enumerated in AC-6 (including the lifecycle-marked-versions edge case) plus the cross-org fixture check from AC-1.
  - [x] Subtask 5.3: Assert `encrypted_value` unchanged (byte-for-byte) for all touched rows (AC-4 regression guard).
  - [x] Subtask 5.4: Assert the `RAISE NOTICE` text for a skipped/orphaned credential contains only the credential id, never `encrypted_value` or plaintext (AC-7).
- [x] Task 7: Operational impact documentation (AC: 7)
  - [x] Subtask 7.1: State the row-count scale this single-statement UPDATE was validated against in the migration header comment.
  - [x] Subtask 7.2: Add a maintenance-window recommendation to the runbook update from Task 4 (low-traffic window precaution, no batching implemented in this story).
- [x] Task 6: Verify guarded-migration safety and CI (AC: 3, all)
  - [x] Subtask 6.1: Run `pnpm db:migrate` (or `make db-migrate`) locally against a fresh/dev DB and confirm `guarded-migrate.ts` does not flag the migration as destructive.
  - [x] Subtask 6.2: Run `make check-rls` to confirm the new columns don't create an RLS coverage gap (new columns on existing RLS-covered tables — should be a no-op, but confirm).
  - [x] Subtask 6.3: Run `pnpm --filter @project-vault/db test` and confirm the new test file and the full package suite pass.

## Dev Notes

- **This is a pure data-model/migration story with zero application-code changes.** No route, service,
  or UI file is touched. `current_version_id` is added but not yet *consumed* by any read/write path —
  that begins in Story 13.2 (which flips it atomically on every version-creating write) and Story 13.3/
  13.4 (which read it). Do not add speculative consumption logic in this story; scope creep here makes
  Story 13.2's own "flips atomically in the same transaction" AC harder to review in isolation.
- **Migration framework:** Drizzle Kit, hand-authored SQL files in `packages/db/src/migrations/`
  (4-digit zero-padded prefix, e.g. `0048_vault_kms_columns.sql` is the current latest as of this story's
  creation — confirm the actual next number at implementation time via `meta/_journal.json`, not this
  note, since parallel epic work may have advanced it). Pure data/DDL-only migrations that don't
  originate from a schema diff are hand-authored, matching the documented precedent in
  `0044_project_membership_visibility_backfill.sql` and `0043_normalize_tag_case.sql`.
- **Follow house migration-comment style**: every existing migration has a substantial header comment
  explaining rationale and citing the story/AC it implements — do the same here, citing "Story 13.1
  AC-1..AC-6".
- **Guarded migration runner:** `packages/db/src/scripts/guarded-migrate.ts` (backed by
  `packages/db/src/lib/migration-safety.ts`) statically scans pending migrations and refuses to apply any
  containing `ADD COLUMN ... NOT NULL` without a `DEFAULT`, plus other destructive patterns (`DROP
  COLUMN`, `TRUNCATE`, `DELETE FROM`, etc.). This is why `current_version_id` must be added nullable with
  no default, and why `schema_version`'s `NOT NULL DEFAULT 1` is fine (has a default) but must not be
  written as `NOT NULL` alone.
- **No RLS session context inside a migration.** Migrations run via `db-migrate` as the Postgres
  superuser (`DB_URL_SUPERUSER`), not through the app's `app.current_org_id` RLS mechanism — explicitly
  called out in migration `0044`'s own comment. The backfill UPDATE must scope correctness via the
  explicit `credential_id` join/correlated subquery, never rely on RLS to prevent cross-org leakage
  (there is no cross-org leakage risk here regardless, since the UPDATE only ever matches a credential to
  its own versions by FK, but this is worth stating explicitly for the reviewer).
- **Known trigger side effect:** `credentials` has a `set_updated_at BEFORE UPDATE` trigger (from
  migration `0014`). The backfill UPDATE will bump `credentials.updated_at` for every row it touches —
  `0043`'s migration documented this exact same concern for its own UPDATE. Decide and document whether
  this is acceptable (likely yes, it's a one-time operational event) or whether the UPDATE should be
  written to avoid touching rows that already have the correct value (recommended anyway for
  idempotency — see AC-6's idempotency test).
- **Migration numbering collision risk is real in this repo:** `0046_project_membership_visibility_
  backfill_bridge.sql` exists specifically because a rebase caused two different stories to claim
  migration number `0044` in parallel; the fix was a follow-up idempotent "bridge" migration at a fresh
  number. Check the actual latest number immediately before authoring this migration, and if a collision
  is discovered post-merge, follow that same bridge-migration pattern rather than renumbering history.
- **`check-rls-coverage.ts` pattern reference** (mentioned in epics.md as "same pattern"): the real
  reusable pattern here is the split between a pure, unit-testable check function
  (`packages/db/src/check-rls-coverage.ts`) and a thin CLI wrapper (`scripts/check-rls-coverage.ts`) using
  the shared `runDbCheck` helper (`scripts/lib/run-db-check.ts`). This repo has **no existing precedent**
  for a migration producing a structured JSON/table summary — logging elsewhere in this codebase is plain
  `stdout`/`stderr` text. Recommended approach for AC-5's "surfaces it in the migration's summary output":
  use SQL-native `RAISE NOTICE` inside the migration itself (visible directly in `db-migrate` output, zero
  new infrastructure) rather than building a new companion script. Only add a companion `scripts/check-*.
  ts` (following the `runDbCheck` pattern) if the team wants a re-runnable, scriptable orphan-detection
  check independent of migration history — treat that as an optional enhancement, not a required AC.
- **Current confirmed schema (zero prior art for these columns):**
  - `credentials` columns today: `id, org_id, project_id, name, description, tags, expires_at,
    alert_lead_days, notified_lead_days, rotation_schedule, retention_count, created_by, created_at,
    updated_at, cacheable`. No `current_version_id` exists yet.
  - `credential_versions` columns today: `id, org_id, credential_id, encrypted_value, key_version,
    version_number, rotation_locked_at, purged_at, break_glass_overlap_expires_at, abandoned_at,
    created_by, created_at`. No `schema_version` or `field_meta` exists yet, and there is **no
    `updated_at`/update trigger** on this table (it's insert-only except the retention-purge UPDATE).
  - Grep of all existing migrations confirms zero prior occurrences of `current_version_id`,
    `schema_version`, or `field_meta` — these are wholly new for Epic 13, not a rename/repurpose of
    anything existing.
- **Test pattern to follow exactly:** `packages/db/src/__tests__/migration-0044-project-membership-
  visibility-backfill.test.ts` and `migration-0043-tag-case-backfill.test.ts` — both reproduce the exact
  migration SQL inline (not by running the `.sql` file), scoped to a fresh test org via `withTestOrg`/
  `createTestUser`/`deleteTestUser` from `packages/db/src/test-helpers.ts`, asserted via direct Drizzle
  queries, cleaned up in `finally` blocks. Follow this pattern for AC-6's required tests, plus a
  `migration-NNNN-safety.test.ts`-style check if the repo convention calls for one (see `migration-0047-
  safety.test.ts`, `migration-0036-safety.test.ts` for that pattern — confirm at implementation time
  whether this migration needs its own).
- **Operational impact (Advanced Elicitation finding — batching decision):** this story deliberately
  ships a single unbatched `UPDATE ... WHERE current_version_id IS NULL` rather than a chunked/looped
  backfill. Rationale: this repo's precedent migrations (`0043`, `0044`) use the same unbatched pattern
  at this fleet's current scale, and premature batching adds real complexity (chunk-size tuning,
  progress tracking, resumability logic beyond the idempotency guard already provided). Decision:
  accept the single-statement UPDATE for now; if a specific deployment's `credentials` row count is
  large enough that a table-level lock for the UPDATE's duration would be operationally risky (no hard
  threshold is defined here — this is a judgment call for the operator, informed by their own table
  size), the runbook note (AC-3/AC-7) instructs running during a low-traffic maintenance window rather
  than the story doing bespoke batching. If a future deployment's scale invalidates this assumption,
  that's a follow-up story, not a retrofit here.
- **Re-run safety is a deliberate, tested property, not an accident:** the `WHERE current_version_id IS
  NULL` guard (Task 2.1) means an interrupted/killed migration run (connection drop, deploy timeout) is
  always safe to simply re-run to completion — already-backfilled rows are skipped, not reprocessed.
  State this explicitly in the migration header comment so an operator who sees a failed `db-migrate`
  run knows re-running is the correct recovery action, not a cause for concern about corrupted state.
- **Runbook location:** the existing operational/upgrade runbook was delivered by Story 9.5 (see
  `_bmad-output/implementation-artifacts/9-5-operational-runbook-and-deployment-guide.md` for its scope
  and the actual doc path it produced) — locate and extend that doc for AC-3's "documented ... in the
  upgrade runbook" requirement rather than creating a new runbook file.
- **Commands:** `pnpm db:migrate` / `make db-migrate` (applies migrations as superuser via
  `guarded-migrate.ts`); `make check-rls` (RLS coverage check, runs as `vault_app` role);
  `pnpm --filter @project-vault/db test` or `cd packages/db && pnpm test` (Vitest v4, `--coverage`);
  `pnpm --filter @project-vault/db generate` only if a schema-diff migration is ever needed (not this
  story's hand-authored backfill).

### Project Structure Notes

- New/changed files, all within `packages/db/`:
  - `packages/db/src/migrations/NNNN_<description>.sql` (new, hand-authored)
  - `packages/db/src/schema/credentials.ts` (edit — add `currentVersionId`)
  - `packages/db/src/schema/credential-versions.ts` (edit — add `schemaVersion`, `fieldMeta`)
  - `packages/db/src/__tests__/migration-NNNN-<description>.test.ts` (new)
  - Runbook doc (edit — path to confirm at implementation time per Dev Notes)
- No changes anywhere under `apps/api/` or `apps/web/` — this story does not touch application code,
  consistent with Surface scope: `none`.
- Alignment with unified project structure: fully consistent with existing conventions (migrations
  package, Drizzle schema package, colocated `__tests__`). No detected conflicts or variances.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 13: Structured Multi-Field Secrets] — epic
  scope, data-model prerequisites callout, backward-compatibility mandate.
- [Source: _bmad-output/planning-artifacts/epics.md#Story 13.1: Backfill `current_version_id` for
  Existing Credentials] — full acceptance criteria (reproduced above).
- [Source: _bmad-output/planning-artifacts/epics.md#Multi-Field Secrets Data Model (Phase 2, from
  architecture.md — Epic 13)] — `current_version_id` explicit-FK design rationale, "same pattern as
  check-rls-coverage.ts" reference, schema_version as authoritative format discriminator.
- [Source: packages/db/src/migrations/0043_normalize_tag_case.sql] — idempotent conditional-UPDATE
  backfill precedent.
- [Source: packages/db/src/migrations/0044_project_membership_visibility_backfill.sql] — hand-authored
  data-only migration precedent; "no RLS session context inside a migration" note.
- [Source: packages/db/src/migrations/0046_project_membership_visibility_backfill_bridge.sql] —
  migration-numbering collision + bridge-migration repair precedent.
- [Source: packages/db/src/lib/migration-safety.ts] — guarded-migration destructive-pattern rules
  (`ADD COLUMN ... NOT NULL` without default is rejected).
- [Source: packages/db/src/check-rls-coverage.ts, scripts/check-rls-coverage.ts, scripts/lib/run-db-
  check.ts] — check-function/CLI-wrapper pattern referenced by epics.md.
- [Source: packages/db/src/__tests__/migration-0044-project-membership-visibility-backfill.test.ts,
  migration-0043-tag-case-backfill.test.ts] — reproduced-statement test pattern to follow.
- [Source: Makefile] — `db-migrate` (superuser) / `check-rls` (vault_app role) target definitions.
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5

### Debug Log References

- `make bootstrap` (fresh worktree DB, port auto-bumped to 5433) → `make db-migrate` applied
  migrations `0000`..`0049` cleanly; `guarded-migrate.ts` did not flag `0049` as destructive.
- `make check-rls` → "check-rls-coverage: all org_id tables have RLS policies — OK" (new columns
  are on already-RLS-covered tables; confirmed no gap).
- `pnpm check-migration-compatibility` → "no destructive statements in any committed migration —
  OK" (full-history static scan, includes `0049`).
- `pnpm --filter @project-vault/db exec vitest run migration-0049` → 2 files, 14/14 tests passed.
- `pnpm --filter @project-vault/db test` (full package suite, coverage) → 44 files, 216/216 tests
  passed; coverage 92.5%/80.85%/100%/92.92% (stmts/branch/funcs/lines), unchanged from baseline.
- `pnpm --filter @project-vault/db typecheck` → clean. `pnpm --filter @project-vault/db lint` → 0
  errors (24 pre-existing warnings elsewhere, unrelated to this story's files).

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Next migration number confirmed via `meta/_journal.json` at implementation time: **0049**
  (`0048_vault_kms_columns` was latest; no collision found). Journal entry added manually (this
  migration is hand-authored/data-DDL-only, matching the `0043`/`0044`/`0048` precedent of no
  companion snapshot file).
- `0049_credentials_current_version_id_backfill.sql`: adds `credentials.current_version_id`
  (nullable UUID FK, no default) and `credential_versions.schema_version`
  (`SMALLINT NOT NULL DEFAULT 1`) / `field_meta` (`JSONB NULL`). The bulk backfill is one
  set-based `UPDATE ... FROM (SELECT DISTINCT ON (credential_id) ...)` statement (AC-7's
  "single-statement UPDATE" scale decision — not a per-row loop), ordered
  `created_at DESC, id DESC` per AC-2's tiebreak rule and guarded by
  `WHERE current_version_id IS NULL` for idempotency/re-run safety (AC-6c, AC-7). A separate
  `DO $$ ... $$` block only enumerates zero-version credentials for a `RAISE NOTICE` per row (id
  only) plus a final summary count (AC-5) — it does not redo the bulk work.
- AC-1 (cross-org correctness): verified via a two-org fixture test; the migration itself has no
  RLS/org scoping (correctness comes from the `credential_id` join alone, per the documented "no
  RLS session context inside a migration" convention from migration `0044`).
- AC-4 (no re-encryption): verified via a byte-for-byte `encrypted_value` equality assertion
  before/after the backfill.
- AC-6's 4 required cases (a-d) plus 3 additional cases were implemented: (AC-1) two-org
  correctness, (AC-2) created_at-tie determinism (stable across re-runs), and the
  purged/abandoned-lifecycle edge case (AC-1's own edge example) — 8 tests total in
  `migration-0049-current-version-id-backfill.test.ts`.
- AC-7's RAISE NOTICE content-safety requirement is covered by a static test
  (`migration-0049-safety.test.ts`, 6 assertions) reading the actual `.sql` file and asserting
  every `RAISE NOTICE` line references only the credential id/aggregate counts, never
  `encrypted_value`/`ciphertext`/`plaintext` — matching this repo's existing
  `migration-0036-safety.test.ts`/`migration-0047-safety.test.ts` static-inspection pattern (no
  live NOTICE-capture wiring needed).
- Drizzle schema: `credentials.ts` now imports `credentialVersions` from `./credential-versions.js`
  for the FK reference (`.references((): AnyPgColumn => credentialVersions.id)`), and
  `credential-versions.ts` already imported `credentials` — this introduces a circular ES module
  import between the two schema files. Verified safe at runtime (lazy `.references()` callback,
  live ESM bindings; full test suite green) — no prior circular-reference precedent existed in
  this schema package before this story, flagged here for reviewer awareness.
- Subtask 3.3 (`drizzle-kit generate` non-conflict check): running `drizzle-kit generate` was not
  meaningful in this repo as a targeted check — the last committed schema snapshot is
  `0033_snapshot.json`; migrations `0034`-`0049` (16 migrations, all hand-authored/data-DDL-only)
  have no snapshot files, an established pre-existing convention, not something this story
  introduced or could resolve in isolation. Verified sync the practical way instead: applied
  `0049` to a fresh DB via `make db-migrate` and confirmed the Drizzle schema's new columns
  (`currentVersionId`, `schemaVersion`, `fieldMeta`) query/insert correctly against the live
  table in the new test file — the schema and the hand-authored SQL agree in practice.
- Runbook: added a new "### Phase 2 upgrade — multi-field secrets" subsection under `docs/
  runbook.md`'s existing `## Upgrades` section (does not add/rename/reorder any `## ` heading, so
  AC-1 from Story 9.5 — `grep -c '^## '` returns 7 — remains satisfied), citing migration `0049`
  by number, the zero-skipped-rows confirmation step, re-run safety, and the maintenance-window
  recommendation (AC-3, AC-7).
- No application code touched (`apps/api/`, `apps/web/` untouched) — consistent with
  `Surface scope: none`. `current_version_id` remains inert; nothing reads/writes it yet (deferred
  to Story 13.2 per this story's own Dev Notes).

### File List

- `packages/db/src/migrations/0049_credentials_current_version_id_backfill.sql` (new)
- `packages/db/src/migrations/meta/_journal.json` (edit — added entry for `0049`)
- `packages/db/src/schema/credentials.ts` (edit — added `currentVersionId`)
- `packages/db/src/schema/credential-versions.ts` (edit — added `schemaVersion`, `fieldMeta`)
- `packages/db/src/__tests__/migration-0049-current-version-id-backfill.test.ts` (new)
- `packages/db/src/__tests__/migration-0049-safety.test.ts` (new)
- `docs/runbook.md` (edit — added "Phase 2 upgrade — multi-field secrets" subsection under
  `## Upgrades`)

## Change Log

- 2026-07-24: Implemented via bmad-dev-story. Added migration `0049_credentials_current_version_id_backfill.sql`
  (nullable `credentials.current_version_id` FK + backfill UPDATE; `credential_versions.schema_version`/
  `field_meta` columns), matching Drizzle schema updates, an 8-case integration test file plus a
  static safety test, and a new runbook subsection. All 7 ACs satisfied; 216/216 `@project-vault/db`
  package tests pass (14 new); `make check-rls`, `pnpm check-migration-compatibility`, typecheck, and
  lint all clean. Status: in-progress -> review.
