-- Story 23.5: least-privilege connection identity and operator-owned approval artifact.
-- The password is deliberately a published development placeholder. Rotate it before any
-- non-development deployment (see docs/runbooks/extension-db-access.md).
DO $$
BEGIN
  CREATE ROLE vault_extension LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT
    PASSWORD 'dev-only-change-in-prod';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
--> statement-breakpoint

-- Reassert the security-relevant attributes for an operator-precreated role. NOINHERIT is
-- defense-in-depth only; membership is separately forbidden by the grant reconciler.
ALTER ROLE vault_extension LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
GRANT CONNECT ON DATABASE project_vault TO vault_extension;
GRANT USAGE ON SCHEMA public TO vault_extension;
--> statement-breakpoint

-- Story 24.5b is a hard prerequisite. A new role inherits PUBLIC's ACLs, so fail the
-- migration rather than creating an extension role that can execute an in-scope function.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f', 'p')
       AND NOT EXISTS (
         SELECT 1
           FROM pg_depend d
           JOIN pg_extension e ON e.oid = d.refobjid
          WHERE d.classid = 'pg_proc'::regclass
            AND d.refclassid = 'pg_extension'::regclass
            AND d.objid = p.oid
            AND d.deptype = 'e'
            AND e.extname IN ('pg_trgm')
       )
       AND has_function_privilege('public', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Story 23.5 requires Story 24.5b function executability hardening first';
  END IF;
END
$$;
--> statement-breakpoint

-- The approval artifact is operator-owned. The API role may read status at boot; the extension
-- role receives no privilege on this table and no default privileges are widened for it.
CREATE TABLE IF NOT EXISTS extension_db_scope_approvals (
  extension_name text PRIMARY KEY,
  manifest_scope_hash text NOT NULL,
  approved_scope jsonb NOT NULL,
  override_rationales jsonb NOT NULL DEFAULT '{}'::jsonb,
  tool_owned_grants jsonb NOT NULL DEFAULT '[]'::jsonb,
  approved_at timestamptz NOT NULL DEFAULT now(),
  approved_by text NOT NULL
);
GRANT SELECT ON extension_db_scope_approvals TO vault_app;
