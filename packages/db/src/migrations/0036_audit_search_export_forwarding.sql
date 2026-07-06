-- Story 8.2: Audit Log Search, Export & External Forwarding
-- D5: new index on the previously-unindexed actor_token_id column.
CREATE INDEX "idx_audit_log_entries_actor_token" ON "audit_log_entries" USING btree ("actor_token_id","created_at" DESC);
--> statement-breakpoint

-- D8: generated CSV exports are stored directly in Postgres (bytea), not an external object
-- store — this codebase provisions no internal object storage.
CREATE TABLE "audit_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"requested_by" uuid,
	"from_date" timestamp with time zone NOT NULL,
	"to_date" timestamp with time zone NOT NULL,
	"format" text NOT NULL,
	"include_integrity_report" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_reason" text,
	"rows_checked" integer,
	"integrity_summary" jsonb,
	"file_content" bytea,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "audit_exports_status_check" CHECK ("audit_exports"."status" IN ('pending','processing','completed','failed')),
	CONSTRAINT "audit_exports_format_check" CHECK ("audit_exports"."format" IN ('csv'))
);
--> statement-breakpoint

-- D3/D9: one row per org; PUT /audit/forwarding upserts wholesale (switching type clears the
-- other type's fields, AC-17).
CREATE TABLE "audit_forwarding_config" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"webhook_url" text,
	"webhook_secret_encrypted" jsonb,
	"last_forwarded_created_at" timestamp with time zone,
	"last_forwarded_id" uuid,
	"consecutive_failure_count" integer DEFAULT 0 NOT NULL,
	"s3_bucket" text,
	"s3_prefix" text,
	"s3_region" text,
	"s3_access_key_id" text,
	"s3_secret_access_key_encrypted" jsonb,
	"s3_endpoint" text,
	"s3_last_forwarded_date" date,
	"s3_consecutive_failure_count" integer DEFAULT 0 NOT NULL,
	"configured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_forwarding_config_type_check" CHECK ("audit_forwarding_config"."type" IN ('webhook','s3'))
);
--> statement-breakpoint

-- D7: one row per org; retentionDays: null (no row) means "retain forever."
CREATE TABLE "audit_retention_config" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"retention_days" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "audit_exports" ADD CONSTRAINT "audit_exports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_exports" ADD CONSTRAINT "audit_exports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_forwarding_config" ADD CONSTRAINT "audit_forwarding_config_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_retention_config" ADD CONSTRAINT "audit_retention_config_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "idx_audit_exports_org_created" ON "audit_exports" USING btree ("org_id","created_at" DESC);
--> statement-breakpoint

ALTER TABLE audit_exports             ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_forwarding_config   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_retention_config    ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- WITH CHECK defaults to USING for command-less ALL policies (see 0013_projects.sql /
-- 0029_machine_users_and_api_keys.sql precedent) — omission here is intentional, not a gap.
CREATE POLICY audit_exports_isolation
  ON audit_exports
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY audit_forwarding_config_isolation
  ON audit_forwarding_config
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY audit_retention_config_isolation
  ON audit_retention_config
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

-- D2: retention pruning cannot use a plain DELETE — Story 8.1's append-only trigger (0001) and
-- grant REVOKE (0002) both block vault_app from deleting audit_log_entries rows. This function,
-- owned by the migration-runner role (NOT vault_app — SECURITY DEFINER functions execute with
-- the *owner's* privileges), is the one sanctioned, narrowly-scoped exception.
--
-- Critical fix (adversarial-review): SECURITY DEFINER bypasses RLS entirely, so "the caller
-- passed the right p_org_id" cannot be the only tenant-isolation guard here — that would make a
-- SQL-injection or logic bug anywhere else in the app able to delete another org's audit rows
-- via this function. The check below requires the caller's own transaction-scoped RLS org
-- context (app.current_org_id, the same setting every other org-scoped policy already relies
-- on) to match p_org_id exactly before deleting anything.
CREATE OR REPLACE FUNCTION purge_expired_audit_log_entries(p_org_id uuid, p_cutoff timestamptz)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted bigint;
  v_session_org uuid;
BEGIN
  v_session_org := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  IF v_session_org IS NULL OR v_session_org <> p_org_id THEN
    RAISE EXCEPTION 'purge_expired_audit_log_entries: p_org_id (%) does not match the session''s RLS org context (%)', p_org_id, v_session_org;
  END IF;

  PERFORM set_config('app.audit_retention_purge', 'true', true);
  DELETE FROM audit_log_entries WHERE org_id = p_org_id AND created_at < p_cutoff;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  PERFORM set_config('app.audit_retention_purge', 'false', true);
  RETURN v_deleted;
END;
$$;
--> statement-breakpoint

-- The trigger gains exactly one new escape hatch: DELETE is allowed only while the above
-- function's session-local flag is set. UPDATE is never allowed, under any flag — retention
-- only ever deletes whole rows, never mutates them.
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.audit_retention_purge', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log_entries is append-only: UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- vault_app is granted EXECUTE on the function ONLY — never a raw DELETE grant. The function's
-- own internal p_org_id/session-context check (above) is what keeps this broad EXECUTE grant
-- safe despite SECURITY DEFINER's RLS bypass.
GRANT EXECUTE ON FUNCTION purge_expired_audit_log_entries(uuid, timestamptz) TO vault_app;
