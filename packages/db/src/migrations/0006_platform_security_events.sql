-- Migration 0006: platform security events
-- Stores security telemetry that happens before an org context can be resolved
-- (for example unknown-email or orphan-user failed login attempts).

CREATE TABLE IF NOT EXISTS platform_security_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    TEXT NOT NULL,
  subject_hash  TEXT,
  email_domain  TEXT,
  ip_address    TEXT,
  user_agent    TEXT,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  key_version   INTEGER NOT NULL,
  hmac          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_platform_security_events_event_type
  ON platform_security_events (event_type, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_platform_security_events_subject_hash
  ON platform_security_events (subject_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_platform_security_events_created_at
  ON platform_security_events (created_at DESC);
--> statement-breakpoint
GRANT SELECT, INSERT ON platform_security_events TO vault_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON platform_security_events FROM vault_app;
--> statement-breakpoint
COMMENT ON TABLE platform_security_events IS
  'Platform-scoped append-only security telemetry for events without an org context. No raw subject PII; subject_hash is keyed.';
