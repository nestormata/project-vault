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
  IF to_regclass('pg_temp.function_executability_expected_migration_function_owner') IS NOT NULL THEN
    DROP TABLE function_executability_expected_migration_function_owner;
  END IF;
  IF to_regclass('pg_temp.function_executability_allowlist') IS NOT NULL THEN
    DROP TABLE function_executability_allowlist;
  END IF;
  IF to_regclass('pg_temp.function_executability_constants') IS NOT NULL THEN
    DROP TABLE function_executability_constants;
  END IF;
END
$$;

CREATE TEMP TABLE function_executability_constants (
  public_schema name NOT NULL,
  owner_kind text NOT NULL,
  function_kind text NOT NULL,
  default_acl_kind text NOT NULL,
  execute_privilege text NOT NULL
) ON COMMIT PRESERVE ROWS;

INSERT INTO function_executability_constants(
  public_schema,
  owner_kind,
  function_kind,
  default_acl_kind,
  execute_privilege
)
VALUES ('public', 'owner', 'function', 'default_acl', 'EXECUTE');

CREATE TEMP TABLE function_executability_functions (
  function_oid oid NOT NULL,
  signature text NOT NULL,
  identity_arguments text NOT NULL,
  owner_oid oid NOT NULL,
  owner_name name,
  is_pinned_extension_owned boolean NOT NULL
) ON COMMIT PRESERVE ROWS;

-- Supported deployments run migrations as the stable role identity `postgres`. Compare role
-- names, never fixed OIDs: a dump/restore may assign a different OID to postgres, but it must not
-- silently change the migration grantor to the restore actor.
CREATE TEMP TABLE function_executability_expected_migration_function_owner (
  owner_oid oid NOT NULL,
  owner_name name NOT NULL
) ON COMMIT PRESERVE ROWS;

INSERT INTO function_executability_expected_migration_function_owner(owner_oid, owner_name)
SELECT oid, rolname
FROM pg_roles
WHERE rolname = 'postgres';

CREATE TEMP TABLE function_executability_allowlist (
  identity text PRIMARY KEY CHECK (
    position('.' in identity) > 0
    AND position('(' in identity) > 0
    AND right(identity, 1) = ')'
    AND position('*' in identity) = 0
    AND position('%' in identity) = 0
  ),
  reason text NOT NULL CHECK (btrim(reason) <> '')
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
  format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
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
LEFT JOIN pg_roles owner_role ON owner_role.oid = p.proowner
CROSS JOIN function_executability_constants constants
WHERE n.nspname = constants.public_schema
  AND p.prokind IN ('f', 'p');

CREATE TEMP TABLE function_executability_violations (
  kind text NOT NULL,
  signature text,
  detail text NOT NULL
) ON COMMIT PRESERVE ROWS;

INSERT INTO function_executability_violations(kind, signature, detail)
SELECT
  constants.owner_kind,
  NULL,
  'expected migration function owner role "postgres" is missing'
FROM function_executability_constants constants
LEFT JOIN function_executability_expected_migration_function_owner expected ON TRUE
WHERE expected.owner_oid IS NULL;

INSERT INTO function_executability_violations(kind, signature, detail)
SELECT
  constants.owner_kind,
  f.signature,
  format('function owner role OID %s is missing', f.owner_oid)
FROM function_executability_functions f
CROSS JOIN function_executability_constants constants
LEFT JOIN pg_roles owner_role ON owner_role.oid = f.owner_oid
WHERE NOT f.is_pinned_extension_owned
  AND owner_role.oid IS NULL;

INSERT INTO function_executability_violations(kind, signature, detail)
SELECT
  constants.owner_kind,
  f.signature,
  format(
    'function owner %s does not match expected migration owner %s',
    COALESCE(f.owner_name::text, format('OID %s', f.owner_oid)),
    expected.owner_name
  )
FROM function_executability_functions f
CROSS JOIN function_executability_expected_migration_function_owner expected
CROSS JOIN function_executability_constants constants
WHERE NOT f.is_pinned_extension_owned
  AND f.owner_oid <> expected.owner_oid;

INSERT INTO function_executability_violations(kind, signature, detail)
SELECT
  constants.function_kind,
  f.signature,
  format('PUBLIC EXECUTE is present; owner=%s', f.owner_name)
FROM function_executability_functions f
CROSS JOIN function_executability_constants constants
LEFT JOIN function_executability_allowlist a ON a.identity = f.signature
WHERE NOT f.is_pinned_extension_owned
  AND a.identity IS NULL
  AND has_function_privilege(constants.public_schema::text, f.function_oid, constants.execute_privilege);

-- The migration's ALTER DEFAULT PRIVILEGES is global and is keyed by the role that owns the
-- migration-created functions. A revoke row belonging only to a restore actor is not evidence.
INSERT INTO function_executability_violations(kind, signature, detail)
SELECT
  constants.default_acl_kind,
  NULL,
  format(
    'global function default ACL for migration owner %s is missing or grants PUBLIC EXECUTE',
    expected.owner_name
  )
FROM function_executability_expected_migration_function_owner expected
CROSS JOIN function_executability_constants constants
LEFT JOIN pg_default_acl defaults
  ON defaults.defaclrole = expected.owner_oid
 AND defaults.defaclobjtype = 'f'
 AND defaults.defaclnamespace = 0
LEFT JOIN LATERAL (
  SELECT 1 AS has_public_execute
  FROM aclexplode(defaults.defaclacl) acl
  WHERE acl.grantee = 0
    AND acl.privilege_type = constants.execute_privilege
  LIMIT 1
) public_execute ON TRUE
WHERE defaults.oid IS NULL
   OR public_execute.has_public_execute IS NOT NULL;

-- A schema-scoped default can widen effective defaults even when the global row is safe.
INSERT INTO function_executability_violations(kind, signature, detail)
SELECT
  constants.default_acl_kind,
  NULL,
  format(
    'schema public function default ACL for migration owner %s grants PUBLIC EXECUTE',
    expected.owner_name
  )
FROM function_executability_expected_migration_function_owner expected
CROSS JOIN function_executability_constants constants
JOIN pg_default_acl defaults
  ON defaults.defaclrole = expected.owner_oid
 AND defaults.defaclobjtype = 'f'
 AND defaults.defaclnamespace = constants.public_schema::regnamespace
JOIN LATERAL (
  SELECT 1 AS has_public_execute
  FROM aclexplode(defaults.defaclacl) acl
  WHERE acl.grantee = 0
    AND acl.privilege_type = constants.execute_privilege
  LIMIT 1
) public_execute ON TRUE;
