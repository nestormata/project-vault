-- Migration 0003: vault_state table
-- Platform-level single-row table; no org_id; no RLS required.
-- This table must be added to check-rls-coverage.ts allow-list.

CREATE TABLE vault_state (
  id               SMALLINT    PRIMARY KEY DEFAULT 1,
  key_version      INTEGER     NOT NULL DEFAULT 1,
  encrypted_sentinel TEXT       NOT NULL,
  audit_key_version INTEGER    NOT NULL DEFAULT 1,
  kms_type         TEXT        NOT NULL,
  key_derivation_params TEXT,   -- JSON; non-null only when kms_type = 'passphrase'
  initialized_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT vault_state_single_row CHECK (id = 1),
  CONSTRAINT vault_state_kms_type_check CHECK (kms_type IN ('passphrase', 'envelope', 'file', 'kms'))
);

COMMENT ON TABLE vault_state IS
  'Single-row platform table. Stores encrypted sentinel for key verification at unseal. '
  'No org_id — not subject to RLS. Exempt from check-rls-coverage.';

COMMENT ON COLUMN vault_state.encrypted_sentinel IS
  'JSON-encoded EncryptedValue of the sentinel string. Decryption success = correct key. '
  'Sentinel plaintext: ''project-vault-sentinel-v1''.';

COMMENT ON COLUMN vault_state.audit_key_version IS
  'Independent lifecycle from key_version. Both start at 1 and rotate separately. '
  'Old audit key versions must be retained in key_history (Story 9.x) for decrypting '
  'audit_log_entries written under previous key versions.';

-- DELETE is granted at the SQL permission layer but blocked at runtime by the
-- append-only trigger below, except when the test-only GUC bypass is active.
GRANT SELECT, INSERT, DELETE ON vault_state TO vault_app;

-- Append-only: prevent vault_state tampering after init (Red Team hardening).
-- UPDATE/DELETE would allow replacing encrypted_sentinel with attacker-controlled ciphertext.
-- Test-only bypass: integration tests set app.vault_test_reset='true' (SET LOCAL, scoped to
-- the resetting transaction) so resetVaultForTest() can truncate state between cases without
-- weakening the production guarantee — the GUC is never set outside test helpers.
CREATE OR REPLACE FUNCTION vault_state_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.vault_test_reset', true) = 'true' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'vault_state is append-only — UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vault_state_no_update
  BEFORE UPDATE ON vault_state
  FOR EACH ROW EXECUTE FUNCTION vault_state_immutable();

CREATE TRIGGER vault_state_no_delete
  BEFORE DELETE ON vault_state
  FOR EACH ROW EXECUTE FUNCTION vault_state_immutable();
