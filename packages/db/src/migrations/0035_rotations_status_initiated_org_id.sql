-- Story 5.5 AC-8: widens Story 5.3's idx_rotations_status_initiated (status, initiated_at) to
-- lead with org_id — the stale-detection job (apps/api/src/workers/rotation-recover.ts) scans
-- per-org via fetchAllOrgIds()/runOrgScopedJob(), so each org's scoped scan should hit an
-- efficient index range instead of a full-index scan filtered by the org_id predicate after
-- the fact.
DROP INDEX "idx_rotations_status_initiated";--> statement-breakpoint
CREATE INDEX "idx_rotations_status_initiated" ON "rotations" USING btree ("org_id","status","initiated_at");
