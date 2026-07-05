-- Story 5.3 AC-1: credential_versions gains 2 new nullable columns for break-glass overlap
-- tracking (AC-2/AC-8) and abandonment (AC-5/AC-12, CR5). No RLS change (table already has RLS
-- from 2.2's migration); no CHECK-constraint changes.
ALTER TABLE "credential_versions" ADD COLUMN "break_glass_overlap_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credential_versions" ADD COLUMN "abandoned_at" timestamp with time zone;--> statement-breakpoint
-- Story 5.3 CR8/ADR-5.3-08: widen 5.1's "one in_progress rotation per credential" backstop to
-- also cover 'stale_recovery' — both are "active" statuses once this story introduces
-- stale_recovery, and AC-5 (supersede)/AC-11 (resume) both depend on a real, DB-enforced
-- single-active-row-per-credential invariant, not an application-level pre-check.
DROP INDEX "idx_rotations_one_in_progress_per_credential";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rotations_one_active_per_credential" ON "rotations" USING btree ("credential_id") WHERE "rotations"."status" IN ('in_progress', 'stale_recovery');--> statement-breakpoint
-- Story 5.3 AC-1/AC-9: supports the stale-detection job's org-wide, credential-agnostic
-- `WHERE status = 'in_progress' AND initiated_at < $threshold` scan.
CREATE INDEX "idx_rotations_status_initiated" ON "rotations" USING btree ("status","initiated_at");