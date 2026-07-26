-- Story 5.6 AC-1/AC-2/AC-3/AC-7: staged -> promoted -> retired rotation state machine.
--
-- Schema additions (all nullable, purely additive):
--   credential_versions.promoted_at  (AC-1) — non-null = eligible to be "current"
--   rotations.promoted_at            (AC-2.3) — distinct column, distinct table, same name
--   rotations.retired_at             (AC-2.4)
--   rotations.stale_staged_alerted_at (AC-4.3)
--
-- rotations_status_check is widened (AC-2.1) — Postgres cannot widen a CHECK constraint in
-- place, so it is dropped and re-added with the exact same name and every existing value
-- retained, plus 'staged'/'promoted'/'retired' added. Same reviewed pattern as migration 0047
-- (notification_preferences_channel_check) — see KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS.
--
-- idx_rotations_one_active_per_credential is widened (AC-2.6) to also cover 'staged'/'promoted'
-- as "active" statuses blocking a second concurrent rotation on the same credential.
--
-- AC-7 in-flight-rotation migration path — the highest-risk part of this migration. Every
-- `rotations` row with status = 'in_progress' at migration time already has its NEW version
-- live/servable under the pre-5.6 selection logic (ORDER BY version_number DESC, per
-- ADR-5.1-04) — moving it to 'staged' would silently un-serve that already-live value the
-- instant this migration runs (see the story file's Example 7a). Instead:
--   1. (row-specific, BEFORE the blanket backfill, while status = 'in_progress' can still be
--      joined against) the in-flight rotation's NEW version gets promoted_at = its own
--      created_at, and the rotations row itself gets promoted_at = initiated_at.
--   2. (blanket) every other still-promoted_at-IS-NULL credential_versions row gets
--      promoted_at = created_at (AC-1.3) — this is a superset that intentionally does NOT
--      double-process the rows step 1 already touched (guarded by promoted_at IS NULL).
--   3. (status flip, LAST) in_progress rotations become 'promoted'.
-- Ordering matters: steps 1 and 3 must both be able to filter on status = 'in_progress', so the
-- status UPDATE runs last, after both version-level backfills have already used that predicate.
ALTER TABLE "credential_versions" ADD COLUMN IF NOT EXISTS "promoted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rotations" ADD COLUMN IF NOT EXISTS "promoted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rotations" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rotations" ADD COLUMN IF NOT EXISTS "stale_staged_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rotations" ALTER COLUMN "status" SET DEFAULT 'staged';--> statement-breakpoint
ALTER TABLE "rotations" DROP CONSTRAINT "rotations_status_check";--> statement-breakpoint
ALTER TABLE "rotations" ADD CONSTRAINT "rotations_status_check" CHECK ("rotations"."status" IN ('in_progress','staged','promoted','retired','completed','abandoned','stale_recovery','break_glass_complete'));--> statement-breakpoint
DROP INDEX IF EXISTS "idx_rotations_one_active_per_credential";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rotations_one_active_per_credential" ON "rotations" USING btree ("credential_id") WHERE "rotations"."status" IN ('in_progress', 'staged', 'promoted', 'stale_recovery');--> statement-breakpoint
-- AC-7 step 1: row-specific new-version promoted_at, for in-flight in_progress rotations only.
UPDATE "credential_versions" AS cv
SET "promoted_at" = cv."created_at"
FROM "rotations" AS r
WHERE r."new_version_id" = cv."id"
  AND r."status" = 'in_progress'
  AND cv."promoted_at" IS NULL;--> statement-breakpoint
-- AC-1.3: blanket backfill for every remaining (non-in-flight) credential_versions row.
UPDATE "credential_versions"
SET "promoted_at" = "created_at"
WHERE "promoted_at" IS NULL;--> statement-breakpoint
-- AC-7 step 3: status flip + rotations.promoted_at = initiated_at, LAST (after both version
-- backfills above have already used the status = 'in_progress' predicate).
UPDATE "rotations"
SET "status" = 'promoted', "promoted_at" = "initiated_at"
WHERE "status" = 'in_progress';--> statement-breakpoint
-- AC-7.8 migration self-verification: for every credential with at least one promoted, non-
-- purged, non-abandoned version, assert exactly one version holds the max (promoted_at,
-- version_number) tuple among its promoted versions. Expected: zero failing credentials. This
-- turns a silent selection-inversion bug into a loud, greppable deploy-time log line.
DO $$
DECLARE
  invariant_failures integer;
BEGIN
  -- Review fix (5-6 code review, Edge Case Hunter finding): the original version of this check
  -- used row_number() to rank each credential's promoted versions, then flagged any credential
  -- with count(rn = 1) <> 1. row_number() is guaranteed by definition to assign exactly one
  -- rank-1 row per PARTITION BY group, even when multiple rows tie on the ORDER BY columns — so
  -- that HAVING clause could never match anything, meaning the check always reported zero
  -- failures regardless of whether the backfill was actually correct. rank() (not MAX on a
  -- record — Postgres has no MAX aggregate for anonymous record types) instead assigns the SAME
  -- rank to genuine (promoted_at, version_number) ties, so count(*) FILTER (WHERE rnk = 1) > 1
  -- can now actually trigger and catch a real duplicate-"current"-version anomaly for a
  -- credential, turning this from a check that could never fail into one that can.
  SELECT count(*) INTO invariant_failures
  FROM (
    SELECT credential_id
    FROM (
      SELECT
        credential_id,
        rank() OVER (
          PARTITION BY credential_id ORDER BY promoted_at DESC, version_number DESC
        ) AS rnk
      FROM credential_versions
      WHERE promoted_at IS NOT NULL
        AND purged_at IS NULL
        AND abandoned_at IS NULL
    ) AS ranked
    GROUP BY credential_id
    HAVING count(*) FILTER (WHERE rnk = 1) <> 1
  ) AS failing;

  RAISE NOTICE 'migration 0050: % credential(s) failed the exactly-one-current-version invariant check (expected 0)', invariant_failures;
END $$;
