-- Story 20.8 AC-5 — dedicated, RLS-isolated, TTL-bounded table backing
-- `HostServices.ephemeralState`. Never reused for any other extension-owned business data
-- (20-7 AC-6). Purely additive: one new table, its FK, its two indexes, its RLS policy, its
-- owner, and its grants — no ALTER on any pre-existing table, no DROP, no backfill.
--
-- Note: `drizzle-kit generate` also proposed re-adding `organizations.service_provisioning_
-- request_id` and `projects.creation_request_id` (plus their partial unique indexes) here — both
-- columns already exist in the real database (migrations 0082/0083), but this repo intentionally
-- prunes most intermediate `meta/*_snapshot.json` files (only a sparse subset is kept — see
-- migration 0064's "snapshot chain repair" precedent), so drizzle-kit's diff against the last
-- retained snapshot (0079) can't see those two already-shipped columns and proposes them again.
-- Those two ALTER TABLE statements and their indexes were deliberately removed from this file —
-- shipping them would violate this migration's own additive-only contract and would fail outright
-- against a real database that already has both columns.
CREATE TABLE "extension_ephemeral_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"extension_namespace" text NOT NULL,
	"key" text NOT NULL,
	"value_ciphertext" "bytea" NOT NULL,
	"encryption_key_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extension_ephemeral_state" ADD CONSTRAINT "extension_ephemeral_state_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_extension_ephemeral_state_unique" ON "extension_ephemeral_state" USING btree ("org_id","extension_namespace","key");
--> statement-breakpoint
CREATE INDEX "idx_extension_ephemeral_state_org_expiry" ON "extension_ephemeral_state" USING btree ("org_id","expires_at");
--> statement-breakpoint

-- AC-5 — RLS enable+force with a FOR ALL ... USING (...) WITH CHECK (...) policy on
-- org_id = current_setting('app.current_org_id', true)::uuid, same shape as
-- audit_storage_quota_config's policy in migration 0075_audit_org_storage_quota.sql. Story 24.1
-- (migration 0070) requires RLS-enabled tables to be owned by the non-superuser, NOBYPASSRLS
-- vault_owner role with FORCE ROW LEVEL SECURITY set, or `make check-rls` rejects them.
ALTER TABLE "extension_ephemeral_state" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY extension_ephemeral_state_isolation
  ON extension_ephemeral_state
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "extension_ephemeral_state" OWNER TO vault_owner;
--> statement-breakpoint
ALTER TABLE "extension_ephemeral_state" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "extension_ephemeral_state" TO vault_app;
