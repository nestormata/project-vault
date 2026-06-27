-- Migration 0007: session revocation cache and Story 1.7 session hardening
-- revoked_tokens stores JWT jtis only until the original access token expiry window closes.

CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti         TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at ON revoked_tokens (expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_user_id ON revoked_tokens (user_id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON revoked_tokens TO vault_app;
--> statement-breakpoint
COMMENT ON TABLE revoked_tokens IS
  'Identity-scoped JWT revocation cache. No org_id and no RLS by design; rows expire at the original access token exp.';
--> statement-breakpoint

UPDATE sessions SET jti = gen_random_uuid()::text WHERE jti IS NULL;
--> statement-breakpoint
ALTER TABLE sessions ALTER COLUMN jti SET NOT NULL;
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_jti ON sessions (jti);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sessions_last_active_at ON sessions (last_active_at);
