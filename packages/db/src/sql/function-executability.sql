-- Story 24.5b canonical catalog contract.
--
-- This file is executed by both the TypeScript checker and the SQL-only psql twin. Keep the
-- pinned extension set and reviewed identity allowlist here, beside the one structural predicate.
-- Temporary tables are session-local evidence only; no application or tenant data is changed.
DO $$
BEGIN
  IF to_regclass('pg_temp.function_executability_violations') IS NOT NULL THEN
    DROP TABLE function_executability_violations;
  END IF;
  IF to_regclass('pg_temp.function_executability_functions') IS NOT NULL THEN
    DROP TABLE function_executability_functions;
  END IF;
  IF to_regclass('pg_temp.function_executability_allowlist') IS NOT NULL THEN
    DROP TABLE function_executability_allowlist;
  END IF;
END
$$;

CREATE TEMP TABLE function_executability_functions (
  function_oid oid NOT NULL,
  signature text NOT NULL,
  identity_arguments text NOT NULL,
  owner_oid oid NOT NULL,
  owner_name name NOT NULL,
  is_pinned_extension_owned boolean NOT NULL
) ON COMMIT PRESERVE ROWS;

CREATE TEMP TABLE function_executability_allowlist (
  identity text PRIMARY KEY,
  reason text NOT NULL
) ON COMMIT PRESERVE ROWS;

-- Intentionally empty today. Any exception must be a full identity-signature entry with a
-- reviewed reason; names, prefixes, and wildcards are not valid allowlist entries.
WITH reviewed_allowlist(identity, reason) AS (
  SELECT NULL::text, NULL::text WHERE false
)
INSERT INTO function_executability_allowlist(identity, reason)
SELECT identity, reason
FROM reviewed_allowlist;

-- One canonical scope predicate shared with Story 23.5:
-- public procedures/functions, excluding only extension-owned pg_proc objects whose dependency is
-- class pg_proc -> pg_extension, deptype='e', and whose extension is in this pinned set.
INSERT INTO function_executability_functions (
  function_oid,
  signature,
  identity_arguments,
  owner_oid,
  owner_name,
  is_pinned_extension_owned
)
SELECT
  p.oid,
  format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes)),
  pg_get_function_identity_arguments(p.oid),
  p.proowner,
  owner_role.rolname,
  EXISTS (
    SELECT 1
    FROM pg_depend d
    JOIN pg_extension e ON e.oid = d.refobjid
    WHERE d.classid = 'pg_proc'::regclass
      AND d.refclassid = 'pg_extension'::regclass
      AND d.objid = p.oid
      AND d.deptype = 'e'
      AND e.extname IN ('pg_trgm')
  )
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles owner_role ON owner_role.oid = p.proowner
WHERE n.nspname = 'public'
  AND p.prokind IN ('f', 'p');

CREATE TEMP TABLE function_executability_violations (
  kind text NOT NULL,
  signature text,
  detail text NOT NULL
) ON COMMIT PRESERVE ROWS;

INSERT INTO function_executability_violations(kind, signature, detail)
SELECT
  'function',
  f.signature,
  format('PUBLIC EXECUTE is present; owner=%s', f.owner_name)
FROM function_executability_functions f
WHERE NOT f.is_pinned_extension_owned
  AND NOT EXISTS (
    SELECT 1
    FROM function_executability_allowlist a
    WHERE a.identity = f.signature
  )
  AND has_function_privilege('public', f.function_oid, 'EXECUTE');

-- The migration's ALTER DEFAULT PRIVILEGES is global and is keyed by the role that owns the
-- migration-created functions. A revoke row belonging only to a restore actor is not evidence.
INSERT INTO function_executability_violations(kind, signature, detail)
SELECT
  'default_acl',
  NULL,
  format(
    'global function default ACL for owner %s is missing or grants PUBLIC EXECUTE',
    owner_role.rolname
  )
FROM (
  SELECT DISTINCT owner_oid
  FROM function_executability_functions
  WHERE NOT is_pinned_extension_owned
) expected
JOIN pg_roles owner_role ON owner_role.oid = expected.owner_oid
LEFT JOIN pg_default_acl defaults
  ON defaults.defaclrole = expected.owner_oid
 AND defaults.defaclobjtype = 'f'
 AND defaults.defaclnamespace = 0
WHERE defaults.oid IS NULL
   OR EXISTS (
     SELECT 1
     FROM aclexplode(defaults.defaclacl) acl
     WHERE acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
   );
