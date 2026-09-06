ALTER TABLE "notification_queue" DROP CONSTRAINT "notification_queue_status_check";--> statement-breakpoint
ALTER TABLE "notification_queue" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "notification_queue" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "notification_queue" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_queue_provider_message_id" ON "notification_queue" USING btree ("provider_id","provider_message_id") WHERE "notification_queue"."provider_message_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_queue" ADD CONSTRAINT "notification_queue_status_check" CHECK ("notification_queue"."status" IN ('pending','sent','delivered','bounced','failed','suppressed'));