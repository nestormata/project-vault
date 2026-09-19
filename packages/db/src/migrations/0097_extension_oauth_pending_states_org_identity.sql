-- Story 40.1 — nullable, purely additive metadata columns (see
-- `packages/db/src/schema/extension-oauth-pending-states.ts` for full rationale): the
-- authenticated START-leg caller's `orgId`/`userId`, captured so the (unauthenticated) CALLBACK
-- leg can know who started this journey when it needs to mint an `extension_request_states` row
-- (AC12). Never read/enforced by 39.1's own burn-before-use replay protection.
ALTER TABLE "extension_oauth_pending_states" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "extension_oauth_pending_states" ADD COLUMN "identity_id" text;