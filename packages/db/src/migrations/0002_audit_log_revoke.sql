-- Defense-in-depth: vault_app's UPDATE/DELETE on audit_log_entries is already blocked
-- by the prevent_audit_log_mutation() trigger (0001), but a trigger is a single point
-- of failure (e.g. accidentally dropped by a future migration). REVOKE at the grant
-- layer too, matching the existing REVOKE DELETE ON api_instances pattern.
REVOKE UPDATE, DELETE ON audit_log_entries FROM vault_app;
--> statement-breakpoint
