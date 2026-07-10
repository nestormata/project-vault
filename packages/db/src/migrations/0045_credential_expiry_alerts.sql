ALTER TABLE "credentials" ADD COLUMN "alert_lead_days" jsonb DEFAULT '[30, 7, 1]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "notified_lead_days" jsonb DEFAULT '[]'::jsonb NOT NULL;
