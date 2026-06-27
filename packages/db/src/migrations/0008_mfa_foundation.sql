-- Migration 0008: TOTP MFA enrollment, recovery codes, and replay protection
-- Story 1.8 adds identity-scoped MFA tables. They intentionally have no org_id and no RLS policy.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMPTZ;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_users_mfa_enrolled_at
  ON users (mfa_enrolled_at)
  WHERE mfa_enrolled_at IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS mfa_enrollments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted  JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','confirmed')),
  label             TEXT NOT NULL DEFAULT 'Authenticator',
  confirmed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_mfa_enrollments_user_pending
  ON mfa_enrollments (user_id)
  WHERE status = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_mfa_enrollments_user_confirmed
  ON mfa_enrollments (user_id)
  WHERE status = 'confirmed';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mfa_enrollments_user_id
  ON mfa_enrollments (user_id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_enrollments TO vault_app;
--> statement-breakpoint
COMMENT ON TABLE mfa_enrollments IS
  'Identity-scoped TOTP enrollment table. No org_id and no RLS by design; access is restricted to auth MFA service code.';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash    TEXT NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user_unused
  ON mfa_recovery_codes (user_id)
  WHERE used_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user_id
  ON mfa_recovery_codes (user_id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_recovery_codes TO vault_app;
--> statement-breakpoint
COMMENT ON TABLE mfa_recovery_codes IS
  'Identity-scoped MFA recovery code table. Stores bcrypt hashes only; no org_id and no RLS by design.';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS totp_used_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash    TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_totp_used_codes_replay
  ON totp_used_codes (user_id, code_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_totp_used_codes_expires_at
  ON totp_used_codes (expires_at);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON totp_used_codes TO vault_app;
--> statement-breakpoint
COMMENT ON TABLE totp_used_codes IS
  'Identity-scoped TOTP replay protection table. Stores HMAC hashes only; no org_id and no RLS by design.';
--> statement-breakpoint

DO $$ BEGIN
  CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON mfa_enrollments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
