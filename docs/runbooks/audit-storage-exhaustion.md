# Audit storage: the instance is full but every org is inside its quota

<!-- Verified against apps/api/src/workers/audit-storage-check.ts,
     apps/api/src/modules/audit/quota-gate.ts, apps/api/src/modules/audit/quota-config.ts,
     apps/api/src/modules/platform-admin/audit-quota-routes.ts, apps/api/src/app.ts,
     apps/api/src/config/env.ts, packages/db/src/migrations/0075_audit_org_storage_quota.sql -->

## When to use

- **Trigger:** the instance-wide `audit_storage.warning` / `audit_storage.critical` alert (80/90/95%
  of `AUDIT_LOG_STORAGE_LIMIT_GB`, default 50 GB) has fired, and checking the orgs shows every one of
  them comfortably inside its own quota.

Related: the general 95%-capacity response, including the export-before-prune step, is in
[`incident-response.md`](incident-response.md). If you are preparing to *upgrade onto* the
quota defaults rather than responding to an alert, that is in
[`upgrade-notes.md`](upgrade-notes.md) § Per-org audit storage quotas become the default.

---

## Why this happens — it is expected, not a bug

Per-org quotas (default or explicit) bound each org's **own** contribution to `audit_log_entries`, but
nothing bounds the **sum** across every org on the instance. An instance can be overcommitted: many
orgs each comfortably within their own quota, whose quotas nonetheless add up to more disk than the
instance actually has.

The 80/90/95% instance-wide alert is the correct and **only** backstop for this. There is
deliberately no second, instance-wide write gate — see
[`docs/design/audit-quota.md`](../design/audit-quota.md) for why one is not reinstated. This runbook
is the operational half of that decision.

---

## Diagnose — identify the largest contributors

The alert payload already includes this: check the `admin_alerts` row's `payload.topContributingOrgs`
(`{orgId, bytesAdded, rowsAdded}` for the top 5 orgs by growth), or query directly:

```sql
SELECT org_id, count(*) AS rows_added
FROM audit_log_entries
WHERE created_at > now() - interval '24 hours'
GROUP BY org_id
ORDER BY count(*) DESC
LIMIT 5;
```

---

## Fix — in order of speed

### Step 1 — lower the instance-wide default (fastest, affects every unconfigured org)

If most of the pressure comes from many small-to-medium unconfigured orgs rather than one or two
large ones, lowering the instance-wide fallback is the fastest lever. In `.env`:

```
AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB=<lower value in MB>
```

**Then restart the API.** This variable is parsed once into the process's configuration at boot;
editing `.env` and waiting changes nothing. No migration, backfill, or data change is needed — the
new value is used on the next write after the restart.

### Step 2 — tighten individual large orgs' explicit quotas

For orgs identified above that already have (or should have) an explicit quota row, lower it via
`PUT /api/v1/admin/orgs/:orgId/audit-quota` (or the equivalent web page). The write-time overcommit
check on that endpoint warns if the resulting aggregate is still over the instance-wide 80%
threshold, so this step also self-checks whether it was enough.

Unlike step 1, this takes effect immediately — it is a database row, not an environment value.

### Step 3 — point large contributors at retention and forwarding

Retention configuration (`audit_retention_config.retention_days`) and forwarding-then-prune are both
quota-remediation event types: an org can always reconfigure its own retention or enable forwarding
**even while it is itself over quota**. That is the deadlock-prevention property the quota design
builds in. Pointing a large contributor at shorter retention or S3/webhook forwarding frees space
without waiting on an operator-side quota change.

### Step 4 — when the honest answer is "provision more disk"

If every org is legitimately using its allotted quota (not a misconfiguration, not a runaway writer)
and the sum genuinely exceeds available disk, no configuration change fixes this — the instance needs
more storage. Steps 1–3 buy time; they do not substitute for capacity planning once real, sustained
multi-org audit volume outgrows the disk the instance was provisioned with.

---

## Verify

1. The next daily `audit-storage/check` run (cron `0 4 * * *`) no longer raises the alert; the
   `admin_alerts` row's `status` moves off `active`.
2. `GET /ready` no longer lists `audit_storage_critical` in `warnings`.
3. `GET /api/v1/admin/resource-usage` shows the instance-wide audit-log figure back below the 80%
   tier.

Do not close this out on the strength of a quota change alone — the change only bounds *future*
growth. Utilization drops only when retention pruning or forwarding actually removes rows.

---

## Rollback

Every lever here is reversible and non-destructive:

- Step 1: restore the previous `AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB` and restart.
- Step 2: raise the org's explicit quota again via the same endpoint, or set `quotaBytes: null` for a
  deliberate "unlimited" override.
- Step 3: retention and forwarding changes are the org's own; shortened retention that has already
  pruned rows is **not** reversible — those audit entries are gone unless they were exported or
  forwarded first. Confirm an export exists before advising an org to shorten retention.
- If quota enforcement itself is causing more harm than the storage pressure, the master kill switch
  is `AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED=false` plus a restart. It is checked first, in process
  memory, before any database access.

---

## Cross-references

- [`docs/design/audit-quota.md`](../design/audit-quota.md) — the design rationale: why a default
  per-org quota rather than an instance-wide gate, the non-influenceability invariant, and the SQL
  precision trap between "no quota-config row" and "an explicit `NULL` quota row".
- [`docs/design/audit-log-scaling.md`](../design/audit-log-scaling.md) — the broader escalation-path
  table this runbook slots into.
