-- Story 20.2: durable endpoint-scoped health-check pause state.
-- Existing rows remain unpaused; pause does not rewrite last-known health or alert history.
ALTER TABLE "service_endpoints"
  ADD COLUMN "health_check_paused_at" timestamp with time zone,
  ADD COLUMN "health_check_paused_by" uuid;
--> statement-breakpoint
ALTER TABLE "service_endpoints"
  ADD CONSTRAINT "service_endpoints_health_check_paused_by_users_id_fk"
  FOREIGN KEY ("health_check_paused_by") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
