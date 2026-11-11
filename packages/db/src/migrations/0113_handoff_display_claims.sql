-- Story 73.3: optional display sidecar for CentralizeMe handoff claims (organization name,
-- plan/tier label, informational role). Additive jsonb on the existing session rows so the
-- values survive MFA and authenticate without living in the PV access JWT (73-2 is parked).
-- Native login leaves the column NULL. No RLS change: sessions already has FORCE RLS;
-- pending_mfa_sessions stays identity-scoped with no tenant RLS.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "handoff_display_claims" jsonb;--> statement-breakpoint
ALTER TABLE "pending_mfa_sessions" ADD COLUMN IF NOT EXISTS "handoff_display_claims" jsonb;
