CREATE TABLE "machine_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"role" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "machine_users_role_check" CHECK ("machine_users"."role" IN ('member','viewer')),
	CONSTRAINT "machine_users_name_len_check" CHECK (char_length("machine_users"."name") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"machine_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"hmac_key_version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"alert_lead_days" jsonb DEFAULT '[14, 3]'::jsonb NOT NULL,
	"notified_lead_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_name_len_check" CHECK (char_length("api_keys"."name") BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "machine_users" ADD CONSTRAINT "machine_users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "machine_users" ADD CONSTRAINT "machine_users_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "machine_users" ADD CONSTRAINT "machine_users_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_machine_user_id_machine_users_id_fk" FOREIGN KEY ("machine_user_id") REFERENCES "public"."machine_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_machine_users_project" ON "machine_users" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "idx_machine_users_org" ON "machine_users" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_api_keys_machine_user" ON "api_keys" USING btree ("machine_user_id");
--> statement-breakpoint
CREATE INDEX "idx_api_keys_org" ON "api_keys" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_api_keys_key_hash" ON "api_keys" USING btree ("key_hash");
--> statement-breakpoint

ALTER TABLE machine_users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE api_keys       ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- WITH CHECK defaults to USING for command-less ALL policies (see 0013_projects.sql /
-- 0014_credentials.sql precedent) — omission here is intentional, not a gap.
CREATE POLICY machine_users_isolation
  ON machine_users
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY api_keys_isolation
  ON api_keys
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
