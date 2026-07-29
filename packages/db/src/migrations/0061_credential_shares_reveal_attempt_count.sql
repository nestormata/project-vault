-- Story 17.2 AC-22: per-token reveal-attempt cap for the external/unauthenticated reveal path —
-- a claim-attempt that resolves to a real credential_shares row but loses (already terminal)
-- increments this counter; exceeding EXTERNAL_SHARE_MAX_REVEAL_ATTEMPTS auto-revokes the share.
-- Additive, nullable-free column (defaults to 0, matching every existing row) — same
-- reconciliation precedent as 17.1's own `single_use` column: the story's Dev Notes said "no new
-- migration needed", written before AC-22 was added by a later advanced-elicitation pass that
-- genuinely needs persisted, cross-request state a fixed code constant / in-memory rate limiter
-- cannot provide (must survive across requests/processes and drive an auto-revoke transition).
ALTER TABLE "credential_shares" ADD COLUMN "reveal_attempt_count" integer DEFAULT 0 NOT NULL;
