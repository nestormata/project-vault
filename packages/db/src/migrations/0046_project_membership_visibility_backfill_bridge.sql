-- Post-rebase bridge for Story 3.5 / 4.5 migration-number collision recovery:
-- some local databases had this branch's original 0044_credential_expiry_alerts.sql applied before
-- Story 4.5 landed on main and claimed 0044 for project_membership visibility backfill. After the
-- rebase, drizzle's timestamp-based pending detection sees local 0044 as "already applied" (same
-- folder timestamp as the old branch-only 0044) and therefore skips it forever on those databases.
--
-- Re-running the Story 4.5 backfill at 0046 repairs that drift without harming fresh databases:
--  * fresh DBs apply 0044, then 0046 no-ops via ON CONFLICT DO NOTHING
--  * rebased existing DBs skip 0044, then 0046 performs the missing backfill exactly once
INSERT INTO "project_memberships" ("org_id", "project_id", "user_id", "role")
SELECT p."org_id", p."id", om."user_id", 'viewer'
FROM "projects" p
JOIN "org_memberships" om ON om."org_id" = p."org_id"
WHERE om."role" IN ('member', 'viewer')
ON CONFLICT ("project_id", "user_id") DO NOTHING;
