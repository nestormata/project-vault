-- Story 21.7: additive, nullable columns only — no backfill. Existing rows get NULL for both
-- (they keep working via tokenHash-verified lookup; they just aren't redisplayable until the
-- next explicit enable/regenerate, which is when these columns first get populated).
ALTER TABLE "status_pages" ADD COLUMN "encrypted_token" jsonb;--> statement-breakpoint
ALTER TABLE "status_pages" ADD COLUMN "key_version" integer;