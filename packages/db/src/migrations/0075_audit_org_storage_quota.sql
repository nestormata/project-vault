CREATE TABLE "audit_storage_quota_config" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"quota_bytes" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_storage_quota_config_quota_bytes_positive" CHECK ("audit_storage_quota_config"."quota_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_org_storage_usage" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"bytes_used" bigint DEFAULT 0 NOT NULL,
	"preauth_bytes_used" bigint DEFAULT 0 NOT NULL,
	"entry_count" bigint DEFAULT 0 NOT NULL,
	"refused_write_count" bigint DEFAULT 0 NOT NULL,
	"last_refusal_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_org_storage_usage_bytes_used_non_negative" CHECK ("audit_org_storage_usage"."bytes_used" >= 0),
	CONSTRAINT "audit_org_storage_usage_preauth_bytes_used_non_negative" CHECK ("audit_org_storage_usage"."preauth_bytes_used" >= 0),
	CONSTRAINT "audit_org_storage_usage_entry_count_non_negative" CHECK ("audit_org_storage_usage"."entry_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "audit_storage_quota_config" ADD CONSTRAINT "audit_storage_quota_config_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_org_storage_usage" ADD CONSTRAINT "audit_org_storage_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Story 22.1 AC-15/D1 trade-offs: fillfactor = 70 leaves headroom for HOT (heap-only tuple)
-- updates on this hot, frequently-rewritten counter row, reducing index churn from the gate
-- statement's per-write UPDATE. The measurement of whether this is sufficient to bound
-- cross-tenant coupling through the shared cluster is Story 22.4's; this is the schema decision
-- that measurement will evaluate.
ALTER TABLE "audit_org_storage_usage" SET (fillfactor = 70);
--> statement-breakpoint

-- Story 22.1 AC-3: RLS on both new tables, with a real write-side boundary (FOR ALL ... USING
-- ... WITH CHECK, both clauses spelled out — review finding M3). Story 24.1 has already landed in
-- this codebase (migration 0070): RLS-enabled tables must be owned by the non-superuser,
-- NOBYPASSRLS `vault_owner` role and have FORCE ROW LEVEL SECURITY set, or `make check-rls`
-- rejects them outright. (Documentation drift vs. this story's Dev Notes, which assumed 24.1/24.2
-- had not yet shipped — see the design note's Documentation Drift section, D-6.)
ALTER TABLE "audit_storage_quota_config" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_org_storage_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY audit_storage_quota_config_isolation
  ON audit_storage_quota_config
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY audit_org_storage_usage_isolation
  ON audit_org_storage_usage
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "audit_storage_quota_config" OWNER TO vault_owner;
--> statement-breakpoint
ALTER TABLE "audit_org_storage_usage" OWNER TO vault_owner;
--> statement-breakpoint
ALTER TABLE "audit_storage_quota_config" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_org_storage_usage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "audit_storage_quota_config" TO vault_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "audit_org_storage_usage" TO vault_app;