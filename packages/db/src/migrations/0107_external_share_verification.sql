-- Story 72-11 V1 — guest recipient verification for native external credential shares.
-- Purely additive and idempotent: nine columns on credential_shares, no new table (so no new RLS
-- surface: the columns inherit the table's FORCE RLS policy), no backfill.
--   * verification_required: true only for shares created through PV's native external-share
--     route (V2). Every existing row and every host-created row stays false (link-only access).
--   * verification_code_hash / verification_code_expires_at: the current 6-digit code, stored as
--     HMAC-SHA256 keyed by the raw share token (never stored) over shareId:code (V3), valid 10 min.
--   * verification_attempt_count: failed confirm attempts per share across codes (V4, cap 5).
--   * verification_send_count / verification_sent_at: resend throttle (V5, 60 s, 5 sends).
--   * verification_proof_hash / verified_at: SHA-256 of the one-time proof (V8, valid 15 min).
--   * locked_at: set when an attempt cap closed the share (V10).
-- ROLLING DEPLOY: the previous app version never reads or writes these columns; rows it creates
-- land as verification_required = false (link-only), the same as a host-created share.
ALTER TABLE "credential_shares" ADD COLUMN IF NOT EXISTS "verification_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD COLUMN IF NOT EXISTS "verification_code_hash" text;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD COLUMN IF NOT EXISTS "verification_code_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD COLUMN IF NOT EXISTS "verification_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD COLUMN IF NOT EXISTS "verification_send_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD COLUMN IF NOT EXISTS "verification_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD COLUMN IF NOT EXISTS "verification_proof_hash" text;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD COLUMN IF NOT EXISTS "locked_at" timestamp with time zone;
