-- Story 72-9 — project URLs and soft delete with a grace period.
-- Purely additive and idempotent, like 0104/0105: four columns on projects plus one partial index.
--   * urls: jsonb array of http/https links, NOT NULL DEFAULT '[]' (the previous app version never
--     writes it and keeps working; every existing row reads as "no URLs", no backfill).
--   * deleted_at / deleted_by / purge_after: NULL = not deleted. A delete sets all three and also
--     sets archived_at (when it was NULL), so the archive-aware readers already hide the project.
--     The purge job hard-deletes rows whose purge_after has passed (children cascade). deleted_by
--     is ON DELETE SET NULL, the same delete rule as created_by.
-- No RLS change: projects keeps its existing org-scoped FORCE RLS policy, and the purge job runs
-- one transaction per organization with app.current_org_id bound.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "urls" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "purge_after" timestamp with time zone;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_deleted_by_users_id_fk'
  ) THEN
    ALTER TABLE "projects" ADD CONSTRAINT "projects_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_purge_due" ON "projects" USING btree ("purge_after") WHERE "projects"."deleted_at" IS NOT NULL;
