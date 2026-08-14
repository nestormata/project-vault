-- Story 24.1: make RLS a real boundary.
--
-- Before this migration every table was owned by the postgres SUPERUSER, making FORCE RLS inert
-- against the owner. Move only RLS-enabled public tables to a dedicated NOLOGIN, NOSUPERUSER,
-- NOBYPASSRLS owner, then force RLS on exactly that same catalog-derived set. postgres remains the
-- migration role and therefore remains a deliberate superuser bypass until Story 24.2.
--
-- Drizzle wraps each migration file in one transaction (verified by Story 24.1 T1). SET LOCAL keeps
-- this migration's ACCESS EXCLUSIVE lock wait bounded without leaking a session-level setting.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  CREATE ROLE vault_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- The create block is intentionally idempotent only for existence. Never silently adopt a role with
-- unsafe attributes, even when another database on this cluster created the name first.
ALTER ROLE vault_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;

DO $$
DECLARE
  role_is_safe boolean;
BEGIN
  SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin AND NOT rolcreatedb AND NOT rolcreaterole AND rolinherit
    INTO role_is_safe
    FROM pg_roles
   WHERE rolname = 'vault_owner';

  IF NOT COALESCE(role_is_safe, false) THEN
    RAISE EXCEPTION 'Story 24.1: vault_owner must be NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, INHERIT';
  END IF;
END
$$;

-- Belt-and-braces defaults for objects created by the owner role. A later migration must still issue
-- an explicit GRANT for each RLS-enabled table; the coverage guard enforces that convention. The two
-- append-only audit tables are deliberately granted only SELECT/INSERT below and never direct DELETE.
ALTER DEFAULT PRIVILEGES FOR ROLE vault_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vault_app;

DO $$
DECLARE
  table_row record;
BEGIN
  FOR table_row IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relrowsecurity
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO vault_owner', table_row.schema_name, table_row.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', table_row.schema_name, table_row.table_name);

    IF table_row.table_name IN ('audit_log_entries', 'platform_audit_events') THEN
      EXECUTE format('GRANT SELECT, INSERT ON TABLE %I.%I TO vault_app', table_row.schema_name, table_row.table_name);
      EXECUTE format('REVOKE UPDATE, DELETE ON TABLE %I.%I FROM vault_app', table_row.schema_name, table_row.table_name);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO vault_app', table_row.schema_name, table_row.table_name);
    END IF;
  END LOOP;
END
$$;
