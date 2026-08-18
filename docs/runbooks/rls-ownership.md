# RLS ownership operations

Story 24.1 makes the PostgreSQL RLS boundary effective for table owners.

## Normal migration and verification

Run the guarded migration as the supported `postgres` superuser, then run the same coverage guard
through a `vault_app` connection. The preflight allows a supported superuser (including PostgreSQL's
usual `rolbypassrls=true` setting), but refuses a non-superuser role with `rolbypassrls=true`.

```bash
DATABASE_URL="$SUPERUSER_DATABASE_URL" pnpm db:migrate
DATABASE_URL="$VAULT_APP_DATABASE_URL" pnpm check-rls
```

The guard checks policy coverage, `ENABLE`/`FORCE` equality, safe ownership, expanded `vault_app`
ACLs, non-public `org_id` schema scope, and view safety. A deploy must fail if the second command
fails. `scripts/fly-migrate.sh` performs both steps through its isolated Fly database proxy.

The migration takes an `ACCESS EXCLUSIVE` lock while changing each table. Its `lock_timeout` is five
seconds and the migration is transactional; a timeout or failed assertion rolls back the whole
ownership change. Schedule the deploy during a low-write window and retry after the conflicting
transaction clears. No data rewrite is performed.

The append-only `audit_log_entries` and `platform_audit_events` tables retain `vault_app` `SELECT,
INSERT` only. Do not grant direct `UPDATE` or `DELETE`; historical cleanup uses the existing
controlled `SECURITY DEFINER` purge functions. Story 24.5a makes their function ACL the database
boundary: `PUBLIC` is not executable, and only `vault_app` is explicitly granted `EXECUTE`. The
platform purge remains caller-enforced through `withPlatformOperatorContext()`; this ACL does not
bound an in-process extension that already holds the `vault_app` pool.

## Restore and rollback

Cluster roles are not included in `pg_dump`. Restore `vault_owner` first (with `NOLOGIN NOSUPERUSER
NOBYPASSRLS`), restore the dump without `--no-owner`, and run `DATABASE_URL="$VAULT_APP_DATABASE_URL"
pnpm check-rls` before serving traffic. Never use `--no-owner` for this restore: it can return table
ownership to a superuser while leaving `FORCE` enabled.

The reviewed rollback SQL is intentionally not a registered migration and is therefore a controlled
operator action only:

```bash
psql "$SUPERUSER_DATABASE_URL" -f docs/runbooks/rls-ownership-rollback.sql
DATABASE_URL="$VAULT_APP_DATABASE_URL" pnpm check-rls
```

Rollback restores RLS-enabled public tables to the historical `postgres` owner and removes FORCE in
one transaction. The coverage guard is expected to fail after rollback until the forward migration
is reapplied; do not serve application traffic in that state.
