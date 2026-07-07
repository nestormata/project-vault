ALTER TABLE "organizations" ADD COLUMN "user_dormancy_threshold_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_user_dormancy_threshold_check" CHECK ("organizations"."user_dormancy_threshold_days" IN (30, 60, 90, 180));--> statement-breakpoint
CREATE UNIQUE INDEX "idx_security_alerts_dormant_user" ON "security_alerts" USING btree ("org_id", ("payload"->>'userId')) WHERE "security_alerts"."alert_type" = 'user.dormant' AND "security_alerts"."status" != 'dismissed';
