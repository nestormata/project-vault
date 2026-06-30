ALTER TABLE "notification_queue" ADD COLUMN "deliver_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"alert_type" text NOT NULL,
	"channel" text NOT NULL,
	"frequency" text DEFAULT 'immediate' NOT NULL,
	"min_severity" text DEFAULT 'warning' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_channel_check" CHECK ("notification_preferences"."channel" IN ('email','slack','inbox')),
	CONSTRAINT "notification_preferences_frequency_check" CHECK ("notification_preferences"."frequency" IN ('immediate','digest_daily')),
	CONSTRAINT "notification_preferences_severity_check" CHECK ("notification_preferences"."min_severity" IN ('info','warning','critical'))
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notification_preferences" ON "notification_preferences" USING btree ("org_id","user_id","alert_type","channel");
--> statement-breakpoint
ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notification_preferences_org_isolation"
  ON "notification_preferences"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE TABLE "org_notification_routing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"alert_type" text NOT NULL,
	"route_to" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_notification_routing_route_to_check" CHECK ("org_notification_routing"."route_to" IN ('owner','admin','member'))
);
--> statement-breakpoint
ALTER TABLE "org_notification_routing" ADD CONSTRAINT "org_notification_routing_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_org_notification_routing" ON "org_notification_routing" USING btree ("org_id","alert_type");
--> statement-breakpoint
ALTER TABLE "org_notification_routing" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_notification_routing_org_isolation"
  ON "org_notification_routing"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
