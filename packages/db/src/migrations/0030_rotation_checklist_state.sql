-- Story 5.2 AC-1: rotation_checklist_items gains five new columns for retry tracking,
-- last-failure visibility, and "who last acted" (FR66). No CHECK-constraint change — the
-- full status vocabulary ('unconfirmed','confirmed','failed','max_retries_exceeded') was
-- already declared by 5.1's 0027_rotations.sql. No new indexes: none of these columns are
-- ever filtered/sorted on by this story's queries (retryCount is read by primary key row).
ALTER TABLE "rotation_checklist_items" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "rotation_checklist_items" ADD COLUMN "retry_scheduled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "rotation_checklist_items" ADD COLUMN "last_failure_reason" text;
--> statement-breakpoint
ALTER TABLE "rotation_checklist_items" ADD COLUMN "last_acted_by" uuid;
--> statement-breakpoint
ALTER TABLE "rotation_checklist_items" ADD COLUMN "last_acted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "rotation_checklist_items" ADD CONSTRAINT "rotation_checklist_items_last_acted_by_users_id_fk" FOREIGN KEY ("last_acted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
