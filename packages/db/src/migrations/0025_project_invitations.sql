CREATE TABLE "project_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role_to_assign" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_invitations_role_check" CHECK ("project_invitations"."role_to_assign" IN ('admin','member','viewer'))
);
--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_invitations_token_hash" ON "project_invitations" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "idx_project_invitations_project_id" ON "project_invitations" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "idx_project_invitations_org_id" ON "project_invitations" USING btree ("org_id");
--> statement-breakpoint
ALTER TABLE "project_invitations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "project_invitations_isolation"
  ON "project_invitations"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "notification_queue" ADD COLUMN "recipient_email" text;
