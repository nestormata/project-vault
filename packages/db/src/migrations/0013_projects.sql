CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_memberships_project_id_user_id_pk" PRIMARY KEY("project_id","user_id"),
	CONSTRAINT "project_memberships_role_check" CHECK ("project_memberships"."role" IN ('owner','admin','member','viewer'))
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_projects_org_slug" ON "projects" USING btree ("org_id","slug");
--> statement-breakpoint
CREATE INDEX "idx_projects_org_created" ON "projects" USING btree ("org_id","created_at" DESC NULLS LAST);
--> statement-breakpoint

-- Enable RLS on new org-scoped tables.
ALTER TABLE projects            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE project_memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- WITH CHECK defaults to USING for command-less ALL policies.
CREATE POLICY projects_isolation
  ON projects
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY project_memberships_isolation
  ON project_memberships
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

-- Clear pre-Story-2.1 orphan project ids before enforcing referential integrity.
ALTER TABLE audit_log_entries DISABLE TRIGGER audit_log_immutability;
--> statement-breakpoint
UPDATE audit_log_entries SET project_id = NULL WHERE project_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE audit_log_entries ENABLE TRIGGER audit_log_immutability;
--> statement-breakpoint
ALTER TABLE audit_log_entries
  ADD CONSTRAINT fk_audit_project
  FOREIGN KEY (project_id) REFERENCES projects(id)
  ON DELETE SET NULL;
--> statement-breakpoint

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
