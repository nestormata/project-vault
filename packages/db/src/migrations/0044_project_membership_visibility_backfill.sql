-- Story 4.5 AC-V7/D2: one-time backfill preserving existing project visibility for org
-- member/viewer users as of this story's migration day. This story tightens `GET /api/v1/projects`
-- (and every other project-scoped read/write route) so an org member/viewer with no explicit
-- `project_memberships` row can no longer see or act on a project at all (previously: any org
-- member/viewer saw every project in their org, per Story 2.1's ADR-2.1-01, deferred tightening
-- to "before shipping per-project roles" and never revisited until now).
--
-- This migration inserts a `'viewer'` (the lowest project role — grants no new capability beyond
-- restoring pre-story visibility, see the story's D2 worked proof) `project_memberships` row for
-- every (project, org member) pair where the org member's role is `'member'` or `'viewer'` and no
-- row already exists — scoped per-org via an explicit `org_memberships.org_id = projects.org_id`
-- join (no RLS session context is available inside a migration, so `app.current_org_id` cannot be
-- relied on here). Org `owner`/`admin` need no backfill — D1 gives them an unconditional
-- visibility bypass, permanently, with no migration required.
--
-- `ON CONFLICT (project_id, user_id) DO NOTHING` preserves any real, higher role a member already
-- holds via a genuine Story 4.1 invitation-acceptance membership — this migration never downgrades
-- an existing row. Runs for archived projects too (Open Question 2): visibility preservation does
-- not depend on archival state, matching this codebase's existing "reads remain available on
-- archived projects" convention (Story 4.4 AC-5).
--
-- Pure data migration — no schema/DDL change, so `drizzle-kit generate` would not produce this
-- file; hand-authored, matching migration 0043's own hand-authored precedent (Story 1.13).
--
-- Migration numbering: 0043 was claimed by 1-13-infra-and-process-hardening's
-- 0043_normalize_tag_case.sql (confirmed landed first — see this story's AC-V7 cross-story
-- coordination note); this story takes 0044, the next free index at implementation time.
INSERT INTO "project_memberships" ("org_id", "project_id", "user_id", "role")
SELECT p."org_id", p."id", om."user_id", 'viewer'
FROM "projects" p
JOIN "org_memberships" om ON om."org_id" = p."org_id"
WHERE om."role" IN ('member', 'viewer')
ON CONFLICT ("project_id", "user_id") DO NOTHING;
