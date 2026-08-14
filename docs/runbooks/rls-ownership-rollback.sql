-- CONTROLLED ROLLBACK ONLY — Story 24.1
-- Not a registered Drizzle migration. Execute only during an approved recovery procedure, then
-- reapply the forward migration before serving traffic. The transaction makes the all-table change
-- atomic: either every RLS-enabled public table is restored or none is.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  table_row record;
BEGIN
  RAISE NOTICE 'Story 24.1 rollback: restoring RLS table ownership to postgres and removing FORCE';
  FOR table_row IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relrowsecurity
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %I.%I NO FORCE ROW LEVEL SECURITY', table_row.schema_name, table_row.table_name);
    EXECUTE format('ALTER TABLE %I.%I OWNER TO postgres', table_row.schema_name, table_row.table_name);
  END LOOP;
END
$$;

COMMIT;
