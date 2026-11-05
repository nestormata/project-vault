-- Story 73-9 (D1) — host-managed machine users for extension credential-sharing writes.
-- Additive and idempotent; no table, no RLS change (the rows inherit machine_users' FORCE RLS
-- policy), no backfill (every existing row is admin-provisioned: host_managed = false and a
-- project_id, which the CHECK below requires).
--   * host_managed: true for the keyless, org-scoped principal the host creates for an extension.
--   * project_id becomes nullable, but only a host-managed row may leave it NULL, and a
--     host-managed row must have no project and no human creator (the CHECK).
--   * the partial unique index makes concurrent provisioning race-safe: at most one host-managed
--     row per (org, extension name). Admin-provisioned rows keep their non-unique names.
-- ROLLING DEPLOY: the previous app version never reads host_managed and always inserts a
-- project_id, so its rows default to host_managed = false and satisfy the CHECK.
ALTER TABLE "machine_users" ADD COLUMN IF NOT EXISTS "host_managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_users" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'machine_users_host_managed_shape_check'
  ) THEN
    ALTER TABLE "machine_users" ADD CONSTRAINT "machine_users_host_managed_shape_check" CHECK (("machine_users"."host_managed" AND "machine_users"."project_id" IS NULL AND "machine_users"."created_by" IS NULL) OR (NOT "machine_users"."host_managed" AND "machine_users"."project_id" IS NOT NULL));
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_machine_users_host_managed_org_name" ON "machine_users" USING btree ("org_id","name") WHERE "machine_users"."host_managed";
