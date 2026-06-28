-- Migration 0011: Pending MFA login sessions
-- Story 1.12 stores short-lived, single-use tokens between the password step and
-- the TOTP verification step. Identity-scoped: org_id is stored for session
-- issuance but the table intentionally has NO RLS policy (created pre-session,
-- before any auth/org context exists). Stores HMAC token hashes only, never raw tokens.

CREATE TABLE IF NOT EXISTS pending_mfa_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ip_address    INET,
  user_agent    TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pending_mfa_sessions_expires_after_created_check
    CHECK (expires_at > created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_mfa_sessions_token_hash
  ON pending_mfa_sessions (token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pending_mfa_sessions_expires_at
  ON pending_mfa_sessions (expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pending_mfa_sessions_user_id
  ON pending_mfa_sessions (user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_mfa_sessions_user_org
  ON pending_mfa_sessions (user_id, org_id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON pending_mfa_sessions TO vault_app;
--> statement-breakpoint
COMMENT ON TABLE pending_mfa_sessions IS
  'Short-lived single-use MFA login challenge tokens. Stores HMAC hashes only. org_id present for session issuance but NO RLS by design (created before any session/org context exists).';
