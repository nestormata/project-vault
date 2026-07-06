CREATE TABLE "status_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_pages_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "status_pages_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "status_page_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"status_page_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_page_services_status_page_id_service_id_unique" UNIQUE("status_page_id","service_id"),
	CONSTRAINT "status_page_services_display_name_len_check" CHECK (char_length("status_page_services"."display_name") BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_services" ADD CONSTRAINT "status_page_services_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_services" ADD CONSTRAINT "status_page_services_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_services" ADD CONSTRAINT "status_page_services_service_id_service_endpoints_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_status_pages_org" ON "status_pages" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_status_page_services_org" ON "status_page_services" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_status_page_services_status_page_id" ON "status_page_services" USING btree ("status_page_id");--> statement-breakpoint

ALTER TABLE status_pages          ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE status_page_services  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY status_pages_isolation
  ON status_pages
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY status_page_services_isolation
  ON status_page_services
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON status_pages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON status_page_services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
