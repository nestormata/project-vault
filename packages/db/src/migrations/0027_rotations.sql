CREATE TABLE "rotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"new_version_id" uuid NOT NULL,
	"previous_version_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"initiated_by" uuid,
	"initiated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotations_status_check" CHECK ("rotations"."status" IN ('in_progress','completed','abandoned','stale_recovery','break_glass_complete'))
);
--> statement-breakpoint
CREATE TABLE "rotation_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rotation_id" uuid NOT NULL,
	"dependency_id" uuid,
	"system_name" text NOT NULL,
	"status" text DEFAULT 'unconfirmed' NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotation_checklist_items_status_check" CHECK ("rotation_checklist_items"."status" IN ('unconfirmed','confirmed','failed','max_retries_exceeded'))
);
--> statement-breakpoint
ALTER TABLE "rotations" ADD CONSTRAINT "rotations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rotations" ADD CONSTRAINT "rotations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rotations" ADD CONSTRAINT "rotations_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rotations" ADD CONSTRAINT "rotations_new_version_id_credential_versions_id_fk" FOREIGN KEY ("new_version_id") REFERENCES "public"."credential_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rotations" ADD CONSTRAINT "rotations_previous_version_id_credential_versions_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."credential_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rotations" ADD CONSTRAINT "rotations_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rotation_checklist_items" ADD CONSTRAINT "rotation_checklist_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rotation_checklist_items" ADD CONSTRAINT "rotation_checklist_items_rotation_id_rotations_id_fk" FOREIGN KEY ("rotation_id") REFERENCES "public"."rotations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rotation_checklist_items" ADD CONSTRAINT "rotation_checklist_items_dependency_id_credential_dependencies_id_fk" FOREIGN KEY ("dependency_id") REFERENCES "public"."credential_dependencies"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rotation_checklist_items" ADD CONSTRAINT "rotation_checklist_items_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rotations_one_in_progress_per_credential" ON "rotations" USING btree ("credential_id") WHERE "rotations"."status" = 'in_progress';
--> statement-breakpoint
CREATE INDEX "idx_rotations_project_initiated" ON "rotations" USING btree ("project_id","initiated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "idx_rotations_credential_status" ON "rotations" USING btree ("credential_id","status");
--> statement-breakpoint
CREATE INDEX "idx_rotations_org" ON "rotations" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rotation_checklist_items_rotation_dependency" ON "rotation_checklist_items" USING btree ("rotation_id","dependency_id");
--> statement-breakpoint
CREATE INDEX "idx_rotation_checklist_items_rotation" ON "rotation_checklist_items" USING btree ("rotation_id");
--> statement-breakpoint
CREATE INDEX "idx_rotation_checklist_items_org" ON "rotation_checklist_items" USING btree ("org_id");
--> statement-breakpoint

ALTER TABLE rotations                ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE rotation_checklist_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY rotations_isolation
  ON rotations
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY rotation_checklist_items_isolation
  ON rotation_checklist_items
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON rotations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON rotation_checklist_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
