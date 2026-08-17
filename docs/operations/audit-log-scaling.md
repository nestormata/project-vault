# Audit log scaling and escalation path

`audit_log_entries` is append-only and, per
`_bmad-output/planning-artifacts/architecture.md`, is expected to grow into the tens of GB on a
busy multi-org instance. This doc records the escalation path as storage pressure grows, and the
protections currently in place at each stage.

## Current protections

1. **Instance-wide alerting** (`apps/api/src/workers/audit-storage-check.ts`, daily
   `audit-storage/check` job) — 80/90/95% tiered alerts against `AUDIT_LOG_STORAGE_LIMIT_GB`,
   fanned out to every org. Unchanged by Story 22.1.
2. **Per-org storage quotas** (Story 22.1, `apps/api/src/modules/audit/quota-gate.ts`) — an
   opt-in (`AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED`), per-org ceiling on authenticated-origin audit
   volume. Over-quota writes fail closed (`503 audit_quota_exhausted`) rather than being silently
   dropped. See `docs/operations/audit-quota-degradation-strategy.md` for the full design
   rationale.
3. **Relief valves reachable at 100%** — lowering `audit_retention_config.retention_days`,
   enabling S3/webhook forwarding-then-prune, and an operator raising the org's own quota are all
   exempt from quota refusal (`QUOTA_REMEDIATION_EVENT_TYPES`), so an over-quota org is never
   locked out of un-blocking itself.

## What changed in Story 22.1 (release note)

**The instance-wide audit-write circuit breaker (`isAuditStorageMaintenanceModeActive()` as a
write gate, `shouldSuppressAuditWrite()`) is DELETED, not converted.** Before this story, a single
active `audit_storage.critical` alert silently suppressed non-security-critical audit writes for
**every** organization on the instance — the write appeared to succeed (2xx) but no audit row was
recorded. That was a live violation of this project's audit-completeness invariant
(`architecture.md:58`) on every deployed instance whenever utilization crossed 95%.

After this story: a write is refused only if the **writing organization itself** is over its own
configured quota. Instance-wide utilization is still measured and alerted (unchanged), but no
longer gates anyone's writes. In a default deployment (quotas unconfigured, kill switch off — the
shipped default) this is strictly an improvement: writes that used to be silently dropped now
succeed and are recorded.

**What replaces the deleted protection:**

- Per-org quotas bound each configured org's own growth (Story 22.1).
- An aggregate-allocation bound, so an operator cannot hand out more quota than the instance can
  hold, ships in Story 22.3.
- Instance-level protection for *unconfigured* orgs (the residual gap this deletion leaves open —
  `quota IS NULL` is unbounded) is Story 22.5's, via a default per-org quota rather than an
  instance-wide gate.
- The unchanged 80/90/95% instance alerts remain the operator's early warning.

## Escalation path

| Symptom | Response |
|---|---|
| An org crosses 80/90/95% of its own quota | Org-facing notification (Story 22.1 AC-18) — lower retention or enable forwarding. |
| Reconciliation (`audit-org-usage/reconcile`) falls behind or fails | `audit_usage_reconciliation.failing` operator alert (Story 22.1 AC-7). Immediate remedy: the `AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED` kill switch. |
| Instance-wide `audit_log_entries` size crosses 80/90/95% | Existing `audit_storage.warning`/`.critical` alerts (Story 9.2, unchanged). |
| Write latency (not storage) becomes the bottleneck | Table partitioning of `audit_log_entries` — a separate, not-yet-scheduled operational story. Out of scope for Story 22.1, which only isolates *storage*, not throughput or latency (see Story 22.2 for write-rate limiting and Story 22.4 for the cross-tenant latency/coupling bench). |
