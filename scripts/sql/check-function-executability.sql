\set ON_ERROR_STOP on

-- Execute the exact canonical predicate and contract used by the TypeScript checker.
\ir ../../packages/db/src/sql/function-executability.sql

DO $$
DECLARE
  violations text;
BEGIN
  SELECT string_agg(
    COALESCE(signature, 'default ACL') || ': ' || detail,
    E'\n'
    ORDER BY kind, signature NULLS LAST, detail
  )
  INTO violations
  FROM function_executability_violations;

  IF violations IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'function executability invariant failed' || E'\n' || violations;
  END IF;
END
$$;

SELECT 'function-executability-check: OK' AS result;
