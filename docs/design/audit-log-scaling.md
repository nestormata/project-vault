# Audit log scaling and escalation path

`audit_log_entries` is append-only and is expected to grow into the tens of GB on a busy multi-org
instance. This note records the escalation path as storage pressure grows, and the protections in
place at each stage.

Operator procedures live in
[`docs/runbooks/audit-storage-exhaustion.md`](../runbooks/audit-storage-exhaustion.md) and
[`docs/runbooks/incident-response.md`](../runbooks/incident-response.md); the version-ordered
upgrade actions live in [`docs/runbooks/upgrade-notes.md`](../runbooks/upgrade-notes.md).

## Current protections

1. **Instance-wide alerting** (`apps/api/src/workers/audit-storage-check.ts`, daily
   `audit-storage/check` job) — 80/90/95% tiered alerts against `AUDIT_LOG_STORAGE_LIMIT_GB`, fanned
   out to every org. This is alerting only; it gates nothing.
2. **Per-org storage quotas** (`apps/api/src/modules/audit/quota-gate.ts`) — a per-org ceiling on
   authenticated-origin audit volume, with a master kill switch
   (`AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED`) and an instance-wide fallback for orgs with no explicit
   quota row (`AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB`). Over-quota writes fail closed
   (`503 audit_quota_exhausted`) rather than being silently dropped. Full rationale:
   [`audit-quota.md`](audit-quota.md).
3. **Relief valves reachable at 100%** — lowering `audit_retention_config.retention_days`, enabling
   S3/webhook forwarding-then-prune, and an operator raising the org's own quota are all exempt from
   quota refusal (`QUOTA_REMEDIATION_EVENT_TYPES`), so an over-quota org is never locked out of
   un-blocking itself.
4. **Aggregate-allocation bound** — the operator-facing quota-setting endpoint warns when the sum of
   per-org quotas would exceed what the instance can hold, so an operator cannot silently hand out
   more quota than the disk supports. It is a warning, not a hard refusal: per-org quotas bound each
   org, never the aggregate.

## Escalation path

| Symptom | Response |
| --- | --- |
| An org crosses 80/90/95% of its own quota | Org-facing notification — lower retention or enable forwarding. |
| Reconciliation (`audit-org-usage/reconcile`) falls behind or fails | `audit_usage_reconciliation.failing` operator alert. Immediate remedy: the `AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED` kill switch. |
| Instance-wide `audit_log_entries` size crosses 80/90/95% | `audit_storage.warning` / `audit_storage.critical` alerts, then [`audit-storage-exhaustion.md`](../runbooks/audit-storage-exhaustion.md). |
| Every org is inside its own quota and the instance is still full | The overcommit case. Same runbook; the honest end of the path is provisioning more disk. |
| Write latency (not storage) becomes the bottleneck | Table partitioning of `audit_log_entries`. Not implemented and not scheduled. The quota mechanism isolates *storage* only, not throughput or latency; per-org write-**rate** limiting (`AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED`, `AUDIT_ORG_DEFAULT_WRITE_RATE_PER_MIN`) is the separate throughput axis. |
