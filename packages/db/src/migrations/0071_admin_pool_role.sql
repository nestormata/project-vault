-- Story 24.2: replace the process-wide superuser admin handle with a dedicated,
-- non-superuser BYPASSRLS role. This migration must be run through the existing
-- superuser-only migration path; it deliberately does not set a usable password.
--
-- Rollback safety: rotate ADMIN_DATABASE_URL away from vault_admin and redeploy the
-- pre-24.2 image before dropping this role. Dropping it first makes the new API fail
-- its fail-closed startup probe.
DO $$
DECLARE
  existing pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM pg_roles WHERE rolname = 'vault_admin';
  IF FOUND THEN
    IF existing.rolsuper OR existing.rolcreatedb OR existing.rolcreaterole OR existing.rolreplication THEN
      RAISE EXCEPTION 'Story 24.2: existing vault_admin has unsafe role attributes';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_auth_members m
      JOIN pg_roles parent ON parent.oid = m.roleid
      JOIN pg_roles member ON member.oid = m.member
      WHERE member.rolname = 'vault_admin'
    ) THEN
      RAISE EXCEPTION 'Story 24.2: vault_admin must not inherit membership privileges';
    END IF;
    ALTER ROLE vault_admin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS NOINHERIT;
  ELSE
    CREATE ROLE vault_admin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS NOINHERIT;
  END IF;
END
$$;
--> statement-breakpoint
GRANT CONNECT ON DATABASE project_vault TO vault_admin;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO vault_admin;
--> statement-breakpoint

-- Read surface derived from Story 24.2's call-site inventory. There is intentionally
-- no broad future-table grant or default-privilege grant.
GRANT SELECT ON project_invitations, account_recovery_tokens, api_keys, machine_users,
  credential_shares, status_pages, operational_status_tokens, org_sso_domains,
  organizations, external_identities, data_erasure_requests, org_memberships,
  rotations, rotation_checklist_items, credential_versions, admin_alerts,
  audit_log_entries, platform_audit_events, credentials, projects TO vault_admin;
--> statement-breakpoint

-- DELETE ... WHERE expires_at ... RETURNING id requires SELECT on the predicate
-- and returned columns in addition to DELETE.
GRANT SELECT (id, expires_at) ON notification_inbox, pending_imports TO vault_admin;
--> statement-breakpoint
GRANT UPDATE ON api_keys, operational_status_tokens TO vault_admin;
--> statement-breakpoint
GRANT DELETE ON notification_inbox, pending_imports TO vault_admin;
--> statement-breakpoint

-- No sequence, role-management, server-file, or future-table privileges are granted.
