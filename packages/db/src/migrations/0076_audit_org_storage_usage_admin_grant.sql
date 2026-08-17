-- Story 22.1 AC-7: the audit-org-usage/reconcile worker's staleness check
-- (apps/api/src/workers/audit-org-usage-reconcile.ts's checkStaleOrgs()) needs a cross-org
-- COUNT(*) over audit_org_storage_usage to find orgs whose last_reconciled_at has fallen behind
-- AUDIT_ORG_USAGE_STALE_AFTER_HOURS. This is the same justified reconciliation-worker bypass class
-- as the AC-8 aggregate read (0071's vault_admin grant list predates this story and does not cover
-- either of the two tables this story adds), not a general-purpose widening of vault_admin's
-- surface — it grants SELECT only, on one table, for one worker's one query.
GRANT SELECT ON audit_org_storage_usage TO vault_admin;
