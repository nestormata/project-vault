-- Migration 0005: registration bootstrap audit policy
-- Allows the auth registration transaction to insert its initial USER_REGISTERED audit row
-- without setting app.current_org_id. The GUC is scoped to the transaction and only affects
-- INSERT checks for audit_log_entries.

CREATE POLICY audit_log_bootstrap_insert ON audit_log_entries
  FOR INSERT
  WITH CHECK (org_id = NULLIF(current_setting('app.auth_bootstrap_org_id', true), '')::uuid);
