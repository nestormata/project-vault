-- Migration 0010: Failed authentication attempt telemetry
-- Story 1.9 records failed auth attempts for platform threshold detection.

CREATE TABLE IF NOT EXISTS failed_auth_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  ip_address      INET NOT NULL,
  attempted_email TEXT NOT NULL,
  reason          TEXT NOT NULL
                    CHECK (reason IN (
                      'invalid_credentials',
                      'invalid_totp',
                      'invalid_recovery_code',
                      'expired_recovery_code'
                    )),
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_failed_auth_attempts_ip_time
  ON failed_auth_attempts (ip_address, attempted_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_failed_auth_attempts_user_time
  ON failed_auth_attempts (user_id, attempted_at DESC)
  WHERE user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_failed_auth_attempts_email_time
  ON failed_auth_attempts (lower(attempted_email), attempted_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_failed_auth_attempts_prune
  ON failed_auth_attempts (attempted_at);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON failed_auth_attempts TO vault_app;
--> statement-breakpoint
COMMENT ON TABLE failed_auth_attempts IS
  'Platform-scoped failed authentication telemetry. No org_id and no RLS by design; tenant APIs must not expose rows.';
