-- Story 20.8 AC-7: the extension-state/cleanup worker deletes expired rows across every org via
-- the admin, RLS-bypassing connection (getAdminDb()) — the same cross-org sweep shape as
-- prune-revoked-tokens/import:cleanup-expired. vault_admin is BYPASSRLS (migration 0071) but RLS
-- bypass is orthogonal to table-level GRANTs — it still needs its own explicit privileges, same
-- as pending_imports/notification_inbox's own admin grants in that same migration: SELECT on the
-- columns the DELETE's WHERE clause and RETURNING list reference, plus DELETE itself.
GRANT SELECT (id, expires_at) ON extension_ephemeral_state TO vault_admin;
--> statement-breakpoint
GRANT DELETE ON extension_ephemeral_state TO vault_admin;
