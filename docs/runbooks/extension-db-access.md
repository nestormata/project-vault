# Extension database access

The extension database handle is an opt-in, operator-approved path. It is backed by the
`vault_extension` role and a separate pool; it is never the core `DATABASE_URL` pool.

## Provisioning

The migration creates `vault_extension` with a published development-only password. Before a
non-development deployment, rotate it with `ALTER ROLE vault_extension PASSWORD '<secure-random>';`
or configure `pg_hba.conf` for SCRAM/peer authentication and remove the password. Set
`EXTENSION_DATABASE_URL` and restart the API; the pool is constructed once at startup.

`EXTENSION_GRANT_DATABASE_URL` is an operator-only credential for the grant reconciler. It must
not be present in the API container environment or readable by the API process in a hardened
deployment. The reconciler is dry-run by default; use `--apply` only after reviewing its output.

## Approval and reconciliation

An extension's `dbScope` is a request, not an authorization. Record the exact normalized scope,
its SHA-256 hash, any override rationale, and tool-owned grants in
`extension_db_scope_approvals`, then run:

```text
pnpm --filter @project-vault/db extension:grants
pnpm --filter @project-vault/db extension:grants --apply
```

The command refuses missing tables, non-RLS tables, denied audit/pgboss objects, ownership by
the extension role, and manifest-hash drift. `--revoke-all` is the emergency narrowing path;
`--revoke-foreign` is required before removing grants the tool did not record. A drift refusal
leaves the previous tool-owned grants in place and emits a warning until re-approved.

Boot records the declared/approved scope, rationale, drift status, and tool-owned grant set in
operational logs. The operator reconciliation step is the source of truth for applied/revoked
sets; per-query auditing is deliberately not attempted through the wrapper. Run
`pnpm check-extension-db-role` after migrations to assert that no default ACL, non-public schema
usage, function execution, or ownership path has widened the role.

## Pool sizing and rollback

The extension pool defaults to max 3 connections. Core and admin pools retain their effective
max 10 defaults, so operators should leave headroom for migrations and `psql` sessions. A pool
max larger than Postgres `max_connections` is rejected; aggregate over-subscription warns and
continues because provider sizing can change while the service is healthy.

To roll back, first run `ALTER ROLE vault_extension NOLOGIN`, terminate its sessions, then run
`DROP OWNED BY vault_extension` in every database (or revoke each database/schema/table/sequence/
function class), remove its approval rows, and finally `DROP ROLE vault_extension`. Do not restore
`PUBLIC` EXECUTE on audit purge functions; Story 24.5 owns that one-way hardening.

Per-query auditing is intentionally not attempted through the wrapper because an in-process
extension can bypass it. Operators needing that evidence should use PostgreSQL `pgaudit`,
`log_statement`, or a role-level `log_statement` setting.
