ALTER TABLE "organizations" ADD COLUMN "machine_key_dormancy_threshold_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "cacheable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "overlap_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "rotated_from_key_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "dormancy_snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "overlap_alert_sent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_rotated_from_key_id_fk" FOREIGN KEY ("rotated_from_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_security_alerts_dormant_key" ON "security_alerts" USING btree (("payload"->>'keyId')) WHERE "security_alerts"."alert_type" = 'machine_key.dormant' AND "security_alerts"."status" != 'dismissed';--> statement-breakpoint
CREATE INDEX "idx_api_keys_overlap_expires" ON "api_keys" USING btree ("overlap_expires_at") WHERE "api_keys"."overlap_expires_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_dormancy_threshold_check" CHECK ("organizations"."machine_key_dormancy_threshold_days" IN (30, 60, 90, 180));