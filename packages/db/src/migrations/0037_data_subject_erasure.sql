-- Story 8.4: Data Subject Erasure Request Handling
-- D1/D9/AC-1/AC-4/AC-19: new org-scoped `data_erasure_requests` table. Normal RLS policy (not
-- added to check-rls-coverage.ts's EXCLUDED_TABLES) — unlike the identity-scoped tables in that
-- set (mfa_recovery_codes, account_recovery_tokens), this table has a real org_id column.
CREATE TABLE "data_erasure_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"requested_by" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"original_email_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "data_erasure_requests_status_check" CHECK ("data_erasure_requests"."status" IN ('pending','in_progress','completed'))
);
--> statement-breakpoint

ALTER TABLE "data_erasure_requests" ADD CONSTRAINT "data_erasure_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- No cascade — a `users` row is never hard-deleted by erasure (Dev Notes), so this FK stays
-- stable for the lifetime of the erasure record.
ALTER TABLE "data_erasure_requests" ADD CONSTRAINT "data_erasure_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "idx_data_erasure_requests_org_user" ON "data_erasure_requests" USING btree ("org_id","user_id");
--> statement-breakpoint
CREATE INDEX "idx_data_erasure_requests_status_created" ON "data_erasure_requests" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX "idx_data_erasure_requests_email_hash" ON "data_erasure_requests" USING btree ("original_email_hash");
--> statement-breakpoint
-- D9: closes the request-*creation* race — only one pending/in_progress request per user at a
-- time. A concurrent second insert raises a unique violation the handler converts into AC-4's
-- existing "return the existing request" 409 response instead of a raw 500 or a second row.
CREATE UNIQUE INDEX "idx_data_erasure_requests_one_pending_per_user" ON "data_erasure_requests" USING btree ("user_id") WHERE "data_erasure_requests"."status" IN ('pending','in_progress');
--> statement-breakpoint

ALTER TABLE data_erasure_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- WITH CHECK defaults to USING for command-less ALL policies (see 0013_projects.sql /
-- 0036_audit_search_export_forwarding.sql precedent) — omission here is intentional, not a gap.
CREATE POLICY data_erasure_requests_isolation
  ON data_erasure_requests
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
