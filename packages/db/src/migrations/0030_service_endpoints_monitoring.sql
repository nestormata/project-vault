CREATE TABLE "service_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"check_frequency_minutes" integer DEFAULT 5 NOT NULL,
	"down_threshold_failures" integer DEFAULT 2 NOT NULL,
	"status" text DEFAULT 'healthy' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"down_episode_started_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_endpoints_name_len_check" CHECK (char_length("service_endpoints"."name") BETWEEN 1 AND 256),
	CONSTRAINT "service_endpoints_url_len_check" CHECK (char_length("service_endpoints"."url") BETWEEN 1 AND 2048),
	CONSTRAINT "service_endpoints_check_frequency_check" CHECK ("service_endpoints"."check_frequency_minutes" IN (1,5,15,30)),
	CONSTRAINT "service_endpoints_down_threshold_check" CHECK ("service_endpoints"."down_threshold_failures" BETWEEN 1 AND 10),
	CONSTRAINT "service_endpoints_status_check" CHECK ("service_endpoints"."status" IN ('healthy','degraded','down'))
);
--> statement-breakpoint
CREATE TABLE "endpoint_health_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_endpoint_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"is_healthy" boolean NOT NULL,
	"status_code" integer,
	"latency_ms" integer NOT NULL,
	"failure_reason" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoint_health_checks_failure_reason_check" CHECK (("endpoint_health_checks"."is_healthy" = true AND "endpoint_health_checks"."failure_reason" IS NULL) OR ("endpoint_health_checks"."is_healthy" = false AND "endpoint_health_checks"."failure_reason" IN ('timeout','http_error','network_error','ssrf_blocked')))
);
--> statement-breakpoint
CREATE TABLE "monitoring_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"service_endpoint_id" uuid,
	"alert_type" text NOT NULL,
	"severity" text NOT NULL,
	"episode_key" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"snoozed_until" timestamp with time zone,
	"dismissed_by" uuid,
	"dismissed_at" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitoring_alerts_alert_type_check" CHECK ("monitoring_alerts"."alert_type" IN ('service.down','service.recovery')),
	CONSTRAINT "monitoring_alerts_severity_check" CHECK ("monitoring_alerts"."severity" IN ('info','warning','critical')),
	CONSTRAINT "monitoring_alerts_status_check" CHECK ("monitoring_alerts"."status" IN ('active','snoozed','dismissed','resolved_by_deletion'))
);
--> statement-breakpoint
ALTER TABLE "service_endpoints" ADD CONSTRAINT "service_endpoints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_endpoints" ADD CONSTRAINT "service_endpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_endpoints" ADD CONSTRAINT "service_endpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_health_checks" ADD CONSTRAINT "endpoint_health_checks_service_endpoint_id_service_endpoints_id_fk" FOREIGN KEY ("service_endpoint_id") REFERENCES "public"."service_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_health_checks" ADD CONSTRAINT "endpoint_health_checks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_alerts" ADD CONSTRAINT "monitoring_alerts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_alerts" ADD CONSTRAINT "monitoring_alerts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_alerts" ADD CONSTRAINT "monitoring_alerts_service_endpoint_id_service_endpoints_id_fk" FOREIGN KEY ("service_endpoint_id") REFERENCES "public"."service_endpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_alerts" ADD CONSTRAINT "monitoring_alerts_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_service_endpoints_org" ON "service_endpoints" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_service_endpoints_due_query" ON "service_endpoints" USING btree ("check_frequency_minutes","last_checked_at");--> statement-breakpoint
CREATE INDEX "idx_endpoint_health_checks_endpoint_checked" ON "endpoint_health_checks" USING btree ("service_endpoint_id","checked_at");--> statement-breakpoint
CREATE INDEX "idx_endpoint_health_checks_org" ON "endpoint_health_checks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_monitoring_alerts_org" ON "monitoring_alerts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_monitoring_alerts_endpoint_episode" ON "monitoring_alerts" USING btree ("service_endpoint_id","episode_key");--> statement-breakpoint
CREATE INDEX "idx_audit_log_entries_org_actor_event" ON "audit_log_entries" USING btree ("org_id","actor_token_id","event_type","created_at");--> statement-breakpoint

ALTER TABLE service_endpoints       ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE endpoint_health_checks  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE monitoring_alerts       ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY service_endpoints_isolation
  ON service_endpoints
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY endpoint_health_checks_isolation
  ON endpoint_health_checks
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY monitoring_alerts_isolation
  ON monitoring_alerts
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON service_endpoints
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON monitoring_alerts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();