-- Story 13.1 AC-1..AC-7: Phase 2 (Structured Multi-Field Secrets) data-model prerequisite.
-- Adds "credentials"."current_version_id" (nullable UUID FK to credential_versions.id, NO
-- DEFAULT) and backfills it for every pre-existing credential to point at its latest
-- credential_versions row by created_at. Also adds credential_versions.schema_version (defaults
-- every existing row to 1, the legacy bare-string format) and credential_versions.field_meta
-- (nullable, no backfill needed — column default/nullability alone satisfies AC-4).
--
-- DEPLOYMENT ORDERING (AC-3): this migration must be applied and completed before deploying any
-- application version whose code assumes credentials.current_version_id is non-null. Deploying
-- app code that reads current_version_id as guaranteed-non-null before this migration completes
-- will crash on any row this backfill has not yet reached, or (since current_version_id is added
-- nullable here and NOT NULL enforcement is deliberately deferred to a later, out-of-scope
-- migration, once app code no longer needs to tolerate legacy zero-version credentials) read NULL
-- and mis-render. See docs/runbook.md § Upgrades for the operator-facing statement of this same
-- constraint.
--
-- current_version_id is added NULLABLE, NO DEFAULT (never NOT NULL in this migration) —
-- guarded-migrate.ts (packages/db/src/lib/migration-safety.ts) rejects ADD COLUMN ... NOT NULL
-- without a DEFAULT as destructive, and even with a default, a zero-version credential (AC-5) has
-- no valid non-null value to assign. A later, separate migration (out of this story's scope) adds
-- NOT NULL once app code no longer needs to tolerate zero-version credentials.
--
-- TIEBREAK RULE (AC-2): when two credential_versions rows for the same credential share the exact
-- same created_at (e.g. a fast automated import in the same transaction/clock tick), the backfill
-- orders by created_at DESC, id DESC — NOT by version_number, which is not guaranteed monotonic
-- with created_at under clock skew or manual data repair. Do not reverse this order in a future
-- edit: doing so changes which version an already-backfilled tie resolves to on re-run and
-- silently breaks idempotency for those specific rows.
--
-- LIFECYCLE STATE IS IRRELEVANT TO "LATEST" (AC-1): a credential_versions row with
-- purged_at IS NOT NULL (retention-purged) or abandoned_at IS NOT NULL (abandoned rotation
-- candidate) still counts as a real version for this "latest by created_at" computation — this
-- backfill is about pointer correctness, not filtering lifecycle states. Only a genuinely absent
-- row (AC-5) is skipped.
--
-- NO RLS SESSION CONTEXT INSIDE A MIGRATION (same note as migration 0044): this migration runs
-- via db-migrate as the Postgres superuser, not through the app's app.current_org_id RLS
-- mechanism. Cross-org correctness is guaranteed by the explicit credential_id join below, never
-- by RLS — there is no cross-org leakage risk regardless, since the join only ever matches a
-- credential to its own versions by FK, but this is worth stating explicitly for the reviewer.
--
-- RE-RUN SAFETY (AC-7): the backfill UPDATE below is guarded by
-- WHERE c.current_version_id IS NULL, so an interrupted/killed migration run (connection drop,
-- deploy timeout) is always safe to simply re-run to completion — already-backfilled rows are
-- skipped, not reprocessed. The credentials.set_updated_at BEFORE UPDATE trigger (0014) bumps
-- updated_at once, for this one-time operational event, on every row this backfill touches on its
-- first (successful) pass; a re-run touches zero additional rows since the guard already excludes
-- them.
--
-- OPERATIONAL IMPACT / SCALE (AC-7): this is a deliberately single, unbatched, set-based UPDATE —
-- matching the same unbatched precedent as migrations 0043/0044 — validated for fleets up to low
-- tens of thousands of credentials. If a specific deployment's credentials table is significantly
-- larger, running this migration during a low-traffic maintenance window is recommended (see
-- docs/runbook.md § Upgrades) to avoid holding a table-level lock long enough to cause visible
-- latency on concurrent credential reads/writes; no batching is implemented in this story — a
-- future story can add chunking if a deployment's scale invalidates this assumption.
ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "current_version_id" uuid REFERENCES "credential_versions"("id");--> statement-breakpoint
ALTER TABLE "credential_versions" ADD COLUMN IF NOT EXISTS "schema_version" smallint NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "credential_versions" ADD COLUMN IF NOT EXISTS "field_meta" jsonb;--> statement-breakpoint
-- Single-statement, set-based backfill (AC-7's "single-statement UPDATE" scale decision) — not a
-- row-by-row loop. DISTINCT ON picks exactly one credential_versions row per credential_id, using
-- the tiebreak rule above.
UPDATE "credentials" AS c
SET "current_version_id" = latest.id
FROM (
  SELECT DISTINCT ON (credential_id) credential_id, id
  FROM credential_versions
  ORDER BY credential_id, created_at DESC, id DESC
) AS latest
WHERE latest.credential_id = c.id
  AND c.current_version_id IS NULL;--> statement-breakpoint
-- Skip/log pass (AC-5): the bulk backfill already happened in the single UPDATE above; this block
-- only enumerates zero-version ("orphaned") credentials — expected to be a small set, if any — for
-- an explicit RAISE NOTICE per row (id only, never encrypted_value or any decrypted/plaintext
-- field — AC-7's content-safety requirement) plus a final summary count.
DO $$
DECLARE
  orphan RECORD;
  skipped_count integer := 0;
  backfilled_count integer;
BEGIN
  SELECT count(*) INTO backfilled_count FROM credentials WHERE current_version_id IS NOT NULL;

  FOR orphan IN
    SELECT c.id
    FROM credentials c
    WHERE c.current_version_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM credential_versions cv WHERE cv.credential_id = c.id)
  LOOP
    RAISE NOTICE 'credential % skipped: zero credential_versions rows found', orphan.id;
    skipped_count := skipped_count + 1;
  END LOOP;

  RAISE NOTICE '% credentials backfilled, % skipped (zero versions) - see notices above for ids', backfilled_count, skipped_count;
END $$;
