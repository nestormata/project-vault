-- Post-rebase compatibility: some local databases applied this story before the migration was
-- renumbered from 0044 to 0045, so the columns may already exist even though the rebased journal
-- now replays this file as pending. `IF NOT EXISTS` keeps the migration additive and lets those
-- databases converge without manual column cleanup, while fresh databases still get the same
-- schema shape.
ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "alert_lead_days" jsonb DEFAULT '[30, 7, 1]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "notified_lead_days" jsonb DEFAULT '[]'::jsonb NOT NULL;
