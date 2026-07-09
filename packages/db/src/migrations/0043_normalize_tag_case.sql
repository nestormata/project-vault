-- Story 1.13 AC-T4: backfill existing credentials.tags/projects.tags JSONB rows to lowercase and
-- dedupe any resulting collisions (e.g. a row with both 'Prod' and 'prod'). New writes are already
-- normalized by apps/api/src/lib/tags.ts's dedupeTags (AC-T1); this migration only fixes rows
-- written before that code change landed.
--
-- The WHERE clause compares against the normalized result, not just `<> '[]'::jsonb`, because both
-- tables have a set_updated_at BEFORE UPDATE trigger (0014_credentials.sql, 0013_projects.sql) that
-- bumps updated_at on any UPDATE that touches a row — even one that writes back the exact same
-- value. Comparing against the normalized form means already-compliant rows (tags already
-- lowercase and deduped — expected to be the large majority) are left completely untouched: no
-- UPDATE, no updated_at bump, no trigger fire. Only rows whose tags actually change are touched,
-- which is the only updated_at bump this migration can honestly justify.
UPDATE "credentials"
SET "tags" = (
  SELECT coalesce(jsonb_agg(DISTINCT lower(elem)), '[]'::jsonb)
  FROM jsonb_array_elements_text("tags") AS elem
)
WHERE "tags" <> (
  SELECT coalesce(jsonb_agg(DISTINCT lower(elem)), '[]'::jsonb)
  FROM jsonb_array_elements_text("tags") AS elem
);--> statement-breakpoint
UPDATE "projects"
SET "tags" = (
  SELECT coalesce(jsonb_agg(DISTINCT lower(elem)), '[]'::jsonb)
  FROM jsonb_array_elements_text("tags") AS elem
)
WHERE "tags" <> (
  SELECT coalesce(jsonb_agg(DISTINCT lower(elem)), '[]'::jsonb)
  FROM jsonb_array_elements_text("tags") AS elem
);
