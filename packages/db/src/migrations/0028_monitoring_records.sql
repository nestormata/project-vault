CREATE TABLE "payment_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"renewal_date" timestamp with time zone,
	"alert_lead_days" jsonb DEFAULT '[14, 3]'::jsonb NOT NULL,
	"notified_lead_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_records_name_len_check" CHECK (char_length("payment_records"."name") BETWEEN 1 AND 256),
	CONSTRAINT "payment_records_url_len_check" CHECK ("payment_records"."url" IS NULL OR char_length("payment_records"."url") BETWEEN 0 AND 2048)
);
--> statement-breakpoint
CREATE TABLE "cert_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"expires_at" timestamp with time zone,
	"alert_lead_days" jsonb DEFAULT '[30, 7]'::jsonb NOT NULL,
	"notified_lead_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cert_records_domain_len_check" CHECK (char_length("cert_records"."domain") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE TABLE "domain_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"domain_name" text NOT NULL,
	"renewal_date" timestamp with time zone,
	"alert_lead_days" jsonb DEFAULT '[30]'::jsonb NOT NULL,
	"notified_lead_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_records_domain_name_len_check" CHECK (char_length("domain_records"."domain_name") BETWEEN 1 AND 256)
);
--> statement-breakpoint
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cert_records" ADD CONSTRAINT "cert_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cert_records" ADD CONSTRAINT "cert_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cert_records" ADD CONSTRAINT "cert_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_records" ADD CONSTRAINT "domain_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_records" ADD CONSTRAINT "domain_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_records" ADD CONSTRAINT "domain_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_payment_records_project_renewal" ON "payment_records" USING btree ("project_id","renewal_date");
--> statement-breakpoint
CREATE INDEX "idx_payment_records_org" ON "payment_records" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_cert_records_project_expires" ON "cert_records" USING btree ("project_id","expires_at");
--> statement-breakpoint
CREATE INDEX "idx_cert_records_org" ON "cert_records" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_domain_records_project_renewal" ON "domain_records" USING btree ("project_id","renewal_date");
--> statement-breakpoint
CREATE INDEX "idx_domain_records_org" ON "domain_records" USING btree ("org_id");
--> statement-breakpoint

ALTER TABLE payment_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE cert_records    ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE domain_records  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY payment_records_isolation
  ON payment_records
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY cert_records_isolation
  ON cert_records
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY domain_records_isolation
  ON domain_records
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON payment_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON cert_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON domain_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
