-- Story 9.4 AC-17: platform_audit_events retention pruning — a dedicated SECURITY DEFINER
-- function, independent of Story 8.2's purge_expired_audit_log_entries() (this table has no
-- org_id/tenant context to check against; it purges platform-wide by design, per AC-17's
-- negative example). Mirrors migration 0036's purge_expired_audit_log_entries() +
-- prevent_audit_log_mutation() escape-hatch pattern exactly, adapted for this table's own
-- append-only trigger.

CREATE OR REPLACE FUNCTION purge_expired_platform_audit_entries(p_cutoff timestamptz)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  PERFORM set_config('app.platform_audit_retention_purge', 'true', true);
  DELETE FROM platform_audit_events WHERE created_at < p_cutoff;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  PERFORM set_config('app.platform_audit_retention_purge', 'false', true);
  RETURN v_deleted;
END;
$$;
--> statement-breakpoint

-- The trigger gains exactly one new escape hatch: DELETE is allowed only while the above
-- function's session-local flag is set. UPDATE is never allowed, under any flag — retention only
-- ever deletes whole rows, never mutates them.
CREATE OR REPLACE FUNCTION prevent_platform_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.platform_audit_retention_purge', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'platform_audit_events is append-only: UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- vault_app is granted EXECUTE on the function ONLY — never a raw DELETE grant (which remains
-- revoked, migration 0041). The function's own internal SECURITY DEFINER + session-flag-gated
-- trigger escape hatch is what keeps this broad EXECUTE grant safe.
GRANT EXECUTE ON FUNCTION purge_expired_platform_audit_entries(timestamptz) TO vault_app;
