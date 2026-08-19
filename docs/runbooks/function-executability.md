# Function executability invariant

Story 24.5b's catalog check is a read-only post-migration and post-restore guard. Run it as
`vault_app` (or another role that can read the PostgreSQL catalogs and evaluate
`has_function_privilege`), after migrations and after every dump/restore:

```bash
DATABASE_URL="$VAULT_APP_DATABASE_URL" pnpm check-function-executability
psql "$VAULT_APP_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/check-function-executability.sql
```

Success is the stable line `function-executability-check: OK`. A failure names the full function
identity/signature or the owning role whose global function default ACL is missing or grants
`PUBLIC EXECUTE`. The command exits non-zero and deliberately does not print a DSN, password, or
raw PostgreSQL driver error.

After a restore, verify that the global `pg_default_acl` function row is keyed to the role owning
the migration-created functions. A revoke row keyed only to the restore actor is not sufficient;
rerun the check with the restored application's read role. If the check reports a function,
revoke `EXECUTE` from `PUBLIC` on that exact signature, then investigate the restore/default-ACL
owner before retrying. Re-granting `PUBLIC` is forbidden. Do not repair the alert with an
all-functions grant or by adding an unreviewed allowlist entry.

The pinned structural exception is currently `pg_trgm`: its extension-owned functions remain
`PUBLIC`-executable because revoking them breaks extension operators. A hand-written function
with an extension-like name is still in scope. Adding another pinned extension or a reviewed
allowlist entry requires a source change and evidence.

This is not tenant RLS, audit logging, authentication/session protection, rate limiting, or
in-process extension containment. An in-process module pack can still reach host-owned code or
connections; this check protects the separate-connection PostgreSQL privilege boundary only.
