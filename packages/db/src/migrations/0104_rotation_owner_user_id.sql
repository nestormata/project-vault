-- Story 43-17 KD-1/KD-2 — rotation ownership transfer on user deactivation/removal (FR102).
-- Purely additive: one nullable column, its FK and one partial index. `initiated_by` is never
-- rewritten (it is the rotation's provenance and the four-eyes comparison anchor); the effective
-- owner is COALESCE(owner_user_id, initiated_by), so every existing row (NULL here) keeps meaning
-- "the owner is the initiator" with no backfill, and the previous app version, which never selects
-- the column, keeps working. ON DELETE SET NULL: a hard-deleted owner falls back to the initiator.
-- Idempotent (IF NOT EXISTS / guarded constraint) like neighbouring additive migrations.
ALTER TABLE "rotations" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rotations_owner_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "rotations" ADD CONSTRAINT "rotations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_rotations_owner_blocking" ON "rotations" USING btree ("org_id","owner_user_id") WHERE "rotations"."owner_user_id" IS NOT NULL;
