-- Migration 0004: auth sessions and refresh tokens
-- Story 1.6 adds JWT session identifiers and identity-scoped refresh-token rotation.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS jti TEXT;
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS sessions_jti_unique ON sessions (jti);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  new_session_id  UUID REFERENCES sessions(id) ON DELETE SET NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens (token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session_id ON refresh_tokens (session_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens (expires_at);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO vault_app;
--> statement-breakpoint

COMMENT ON TABLE refresh_tokens IS
  'Identity-scoped refresh-token rotation table. No org_id and no RLS by design; access is restricted to auth service code.';
