CREATE TABLE "notification_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"recipient_user_id" uuid,
	"channel" text NOT NULL,
	"template_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_queue_channel_check" CHECK ("notification_queue"."channel" IN ('email','slack','inbox')),
	CONSTRAINT "notification_queue_status_check" CHECK ("notification_queue"."status" IN ('pending','delivered','failed','suppressed'))
);
--> statement-breakpoint
ALTER TABLE "notification_queue" ADD CONSTRAINT "notification_queue_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_queue" ADD CONSTRAINT "notification_queue_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_notification_queue_pending" ON "notification_queue" USING btree ("org_id","status") WHERE "notification_queue"."status" = 'pending';
--> statement-breakpoint
CREATE INDEX "idx_notification_queue_created_at" ON "notification_queue" USING btree ("created_at");
--> statement-breakpoint
ALTER TABLE "notification_queue" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notification_queue_org_isolation"
  ON "notification_queue"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
