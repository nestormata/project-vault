-- Story 24.5a — close the PUBLIC EXECUTE boundary on PV's audit purge and trigger functions.
-- This migration is ACL-only. Its rollback is intentionally a no-op: restoring PUBLIC access
-- would reopen the audit-destruction path, so emergency access must be an explicit GRANT to a
-- named role, never a grant to PUBLIC.
--
-- Preflight is deliberately first. The nested exception block rolls back its trial REVOKE/GRANT
-- pair; a connection that cannot issue the ACL change aborts with an actionable message before
-- the real statements can leave a partial privilege set.
DO $story_24_5a_preflight$
BEGIN
  BEGIN
    REVOKE EXECUTE ON FUNCTION purge_expired_audit_log_entries(uuid, timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION purge_expired_audit_log_entries(uuid, timestamptz) TO vault_app;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Story 24.5a preflight complete';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      NULL;
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'Story 24.5a: this connection cannot revoke EXECUTE on the audit functions';
    WHEN OTHERS THEN
      RAISE EXCEPTION 'Story 24.5a: this connection cannot revoke EXECUTE on the audit functions: %', SQLERRM;
  END;
END
$story_24_5a_preflight$;
--> statement-breakpoint

-- Full signatures are intentional. Do not replace these with an all-functions grant: public also
-- contains extension-owned functions, including pg_trgm's index operators.
REVOKE EXECUTE ON FUNCTION purge_expired_audit_log_entries(uuid, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION purge_expired_platform_audit_entries(timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prevent_audit_log_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prevent_pseudonym_reversal() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_updated_at_column() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION vault_state_immutable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prevent_platform_audit_mutation() FROM PUBLIC;
--> statement-breakpoint

-- Only the application role needs to invoke the two retention functions. The five trigger
-- functions are revoked with no replacement grant: PostgreSQL checks trigger-function EXECUTE
-- when the trigger is created, not when it fires; AC 11 proves the existing triggers still run.
GRANT EXECUTE ON FUNCTION purge_expired_audit_log_entries(uuid, timestamptz) TO vault_app;
GRANT EXECUTE ON FUNCTION purge_expired_platform_audit_entries(timestamptz) TO vault_app;
--> statement-breakpoint

-- This default is keyed to the role issuing it (currently postgres), so it is a convenience and
-- not the lasting guarantee. This schema-scoped row ensures newly-created public functions are
-- denied PUBLIC EXECUTE in public. A restore can re-key the row to the restoring role; the
-- post-restore check must compare pg_default_acl.defaclrole with the migration-object owner. The
-- 24.5b sweep is the durable drift control.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- The platform purge has no internal authorization guard. Its single production caller is
-- platform-audit-retention-prune.ts, which wraps it in withPlatformOperatorContext(); that is a
-- caller-enforced property, not a self-enforced one. app.platform_operator_verified is the RLS
-- read predicate and is intentionally not made a purge token (see Story 24.5a AC 16).
--
-- An extension installed after this default-privilege narrowing may need an explicit
-- GRANT EXECUTE ON FUNCTION ... TO vault_app for each function PV calls. This is an unverified
-- prediction until Story 24.5b's throwaway-database experiment; never repair that case with a
-- blanket grant to PUBLIC.
