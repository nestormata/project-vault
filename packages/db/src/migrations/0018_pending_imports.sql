CREATE TABLE "pending_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by" uuid,
	"file_type" text NOT NULL,
	"item_count" integer NOT NULL,
	"items" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_imports_file_type_check" CHECK ("pending_imports"."file_type" IN ('env', 'json')),
	CONSTRAINT "pending_imports_item_count_check" CHECK ("pending_imports"."item_count" BETWEEN 0 AND 500)
);
--> statement-breakpoint
ALTER TABLE "pending_imports" ADD CONSTRAINT "pending_imports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_imports" ADD CONSTRAINT "pending_imports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_imports" ADD CONSTRAINT "pending_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE pending_imports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY pending_imports_isolation
  ON pending_imports
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
