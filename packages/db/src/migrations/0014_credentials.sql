CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"rotation_schedule" text,
	"retention_count" integer DEFAULT 3 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credentials_retention_count_check" CHECK ("credentials"."retention_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "credential_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"encrypted_value" jsonb,
	"key_version" integer,
	"version_number" integer NOT NULL,
	"rotation_locked_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_versions" ADD CONSTRAINT "credential_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_versions" ADD CONSTRAINT "credential_versions_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_versions" ADD CONSTRAINT "credential_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_credentials_project_created" ON "credentials" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_credentials_org" ON "credentials" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_credential_versions_unique" ON "credential_versions" USING btree ("credential_id","version_number");--> statement-breakpoint
CREATE INDEX "idx_credential_versions_cred" ON "credential_versions" USING btree ("credential_id","version_number" DESC NULLS LAST);

-- Enable RLS on new org-scoped tables.
ALTER TABLE credentials         ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE credential_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- WITH CHECK defaults to USING for command-less ALL policies.
CREATE POLICY credentials_isolation
  ON credentials
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY credential_versions_isolation
  ON credential_versions
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

-- updated_at trigger for credentials (function defined in 0001). credential_versions
-- intentionally has NO updated_at and NO trigger -- it is insert-only plus the purge UPDATE.
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON credentials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
