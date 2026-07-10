-- Story 1.13 AC-T4: backfill existing credentials.tags/projects.tags JSONB rows to lowercase and
-- dedupe any resulting collisions (e.g. a row with both 'Prod' and 'prod'). New writes are already
-- normalized by apps/api/src/lib/tags.ts's dedupeTags (AC-T1); this migration only fixes rows
-- written before that code change landed.
--
-- The WHERE clause avoids `tags <> (SELECT jsonb_agg(DISTINCT lower(elem)) ...)` because
-- `jsonb_agg(DISTINCT ...)` sorts its output (ascending, by the aggregated text values) — never the
-- original array's insertion order. A row already fully lowercase and duplicate-free but stored in
-- a non-alphabetical order (e.g. '["staging","prod"]') would compare unequal to its own
-- alphabetically-sorted normalized form and get needlessly rewritten (code-review finding, 1.13).
-- Both tables have a set_updated_at BEFORE UPDATE trigger (0014_credentials.sql, 0013_projects.sql)
-- that bumps updated_at on any UPDATE that touches a row — even one that writes back an
-- order-only-different value — so an order-sensitive comparison would violate this migration's own
-- goal of leaving already-compliant rows (expected to be the large majority) completely untouched.
-- Instead, the WHERE clause below is order-independent: a row needs normalizing only if (a) any
-- element isn't already lowercase, or (b) lowering produces fewer distinct values than the element
-- count (a same-case or cross-case duplicate exists) — neither condition depends on array order.
UPDATE "credentials"
SET "tags" = (
  SELECT coalesce(jsonb_agg(DISTINCT lower(elem)), '[]'::jsonb)
  FROM jsonb_array_elements_text("tags") AS elem
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements_text("tags") AS elem WHERE elem <> lower(elem)
) OR (
  SELECT count(*) FROM jsonb_array_elements_text("tags") AS elem
) <> (
  SELECT count(DISTINCT lower(elem)) FROM jsonb_array_elements_text("tags") AS elem
);--> statement-breakpoint
UPDATE "projects"
SET "tags" = (
  SELECT coalesce(jsonb_agg(DISTINCT lower(elem)), '[]'::jsonb)
  FROM jsonb_array_elements_text("tags") AS elem
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements_text("tags") AS elem WHERE elem <> lower(elem)
) OR (
  SELECT count(*) FROM jsonb_array_elements_text("tags") AS elem
) <> (
  SELECT count(DISTINCT lower(elem)) FROM jsonb_array_elements_text("tags") AS elem
);
