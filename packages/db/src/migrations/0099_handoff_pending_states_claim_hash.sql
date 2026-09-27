-- Story 60.3 AC2: additive, nullable `claim_hash` column for the claim-exchange mechanism (Story
-- 60.2's Option 1 — see packages/db/src/schema/handoff-pending-states.ts for full rationale).
-- Nullable and no backfill: pre-existing rows from before this story have no claim to hash, and
-- the 120s pending-state TTL means none survive across a deploy anyway.
ALTER TABLE "handoff_pending_states" ADD COLUMN "claim_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_handoff_pending_states_claim_hash" ON "handoff_pending_states" USING btree ("claim_hash");