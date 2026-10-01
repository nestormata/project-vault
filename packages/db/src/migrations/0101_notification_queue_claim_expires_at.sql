-- Story 70.1 AC7 — exclusive notification_queue claim lease (claim_expires_at) and the DW-252
-- send-in-progress marker (send_started_at, Decisions 2026-09-30). Purely additive: nullable, no
-- default, no backfill, no index (the claim is a primary-key UPDATE; the catch-up predicate
-- already uses idx_notification_queue_pending). RLS policy and grants are unchanged: vault_app
-- has table-level UPDATE, and vault_admin's 0090 column grant is deliberately not widened.
-- Existing pending rows (NULL lease, NULL marker) stay claimable exactly as before.
ALTER TABLE "notification_queue" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_queue" ADD COLUMN "send_started_at" timestamp with time zone;