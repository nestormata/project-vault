-- Migration 0009: Shared auth rate-limit buckets
-- Story 1.8 recovery-code login needs per-IP and per-email limits that work across API instances.

CREATE TABLE IF NOT EXISTS auth_rate_limit_buckets (
  bucket_key    TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  reset_at      TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_auth_rate_limit_buckets_reset_at
  ON auth_rate_limit_buckets (reset_at);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limit_buckets TO vault_app;
--> statement-breakpoint
COMMENT ON TABLE auth_rate_limit_buckets IS
  'Shared auth rate-limit counters keyed by route/IP/email. No org_id and no RLS by design.';
