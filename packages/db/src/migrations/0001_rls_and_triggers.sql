-- vault_app application role (AC-1b)
-- Uses a DO block with exception handling instead of CREATE ROLE IF NOT EXISTS
-- for portability across PostgreSQL versions older than PG16.
DO $$ BEGIN
  CREATE ROLE vault_app WITH LOGIN PASSWORD 'dev-only-change-in-prod';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'vault_app role already exists — skipping creation';
END $$;
--> statement-breakpoint
GRANT CONNECT ON DATABASE project_vault TO vault_app;
--> statement-breakpoint
-- pg-boss (Story 1.1) creates its own schema/tables on first connect and needs
-- CREATE on the database to do so; this is unrelated to row-level data isolation.
GRANT CREATE ON DATABASE project_vault TO vault_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO vault_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vault_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vault_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vault_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO vault_app;
--> statement-breakpoint

-- T1 — DoS mitigation: prevent vault_app from deleting api_instances rows.
-- The startup guard INSERT uses the migration owner role; vault_app only reads.
-- This blocks an attacker with a compromised vault_app session from suppressing
-- the multi-instance guard by deleting heartbeat rows.
REVOKE DELETE ON api_instances FROM vault_app;
--> statement-breakpoint

-- Row-Level Security on org-scoped tables (AC-3)
ALTER TABLE org_memberships   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sessions          ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE security_alerts   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- WITH CHECK is intentionally omitted: these are command-less (ALL) policies, and
-- PostgreSQL defaults WITH CHECK to the same expression as USING when omitted, so
-- inserts/updates are checked against the same org_id condition as reads.
CREATE POLICY org_memberships_isolation   ON org_memberships   USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY sessions_isolation          ON sessions          USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY audit_log_isolation         ON audit_log_entries USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY security_alerts_isolation   ON security_alerts   USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

-- Append-only trigger on audit_log_entries (AC-5)
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log_entries is append-only: UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER audit_log_immutability
  BEFORE UPDATE OR DELETE ON audit_log_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
--> statement-breakpoint

-- Pseudonymization immutability trigger on user_identity_tokens (AC-5b)
CREATE OR REPLACE FUNCTION prevent_pseudonym_reversal()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.pseudonymized_at IS NOT NULL AND NEW.display_name != OLD.display_name THEN
    RAISE EXCEPTION
      'user_identity_tokens: display_name cannot be modified after pseudonymization — GDPR erasure is permanent';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER enforce_pseudonym_immutability
  BEFORE UPDATE ON user_identity_tokens
  FOR EACH ROW EXECUTE FUNCTION prevent_pseudonym_reversal();
--> statement-breakpoint

-- updated_at auto-update trigger on all mutable tables (AC-6)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER set_updated_at BEFORE UPDATE ON organizations       FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON users               FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON org_memberships     FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON user_identity_tokens FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sessions            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON security_alerts     FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
