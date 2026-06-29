CREATE TABLE "credential_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"system_name" text NOT NULL,
	"system_type" text DEFAULT 'other' NOT NULL,
	"notes" text,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_dependencies_system_type_check" CHECK ("credential_dependencies"."system_type" IN ('service','ci_pipeline','database','third_party','other')),
	CONSTRAINT "credential_dependencies_system_name_len_check" CHECK (char_length("credential_dependencies"."system_name") BETWEEN 1 AND 256)
);
--> statement-breakpoint
ALTER TABLE "credential_dependencies" ADD CONSTRAINT "credential_dependencies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_dependencies" ADD CONSTRAINT "credential_dependencies_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_dependencies" ADD CONSTRAINT "credential_dependencies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_dependencies" ADD CONSTRAINT "credential_dependencies_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_credential_dependencies_cred_active" ON "credential_dependencies" USING btree ("credential_id","archived_at");--> statement-breakpoint
CREATE INDEX "idx_credential_dependencies_org" ON "credential_dependencies" USING btree ("org_id");

ALTER TABLE credential_dependencies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY credential_dependencies_isolation
  ON credential_dependencies
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON credential_dependencies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
