# Monitoring: metrics, alerts, audit-log integrity

<!-- Verified against apps/api/src/routes/metrics.ts, apps/api/src/modules/rotation/metrics.ts,
     apps/api/src/config/env.ts (METRICS_BIND_HOST), apps/api/src/workers/*.ts,
     apps/api/src/modules/audit/{routes,schema}.ts,
     apps/api/src/modules/platform-audit/{routes,schema}.ts -->

## When to use

Setting up scraping and alerting for a new instance, or deciding who owns an alert that just fired.

---

## Scraping Prometheus metrics

`GET /metrics` is bound **loopback-only by default**: any caller whose remote address is not
`127.0.0.1`/`::1` receives `403 {"error":"Forbidden"}` unless the **`METRICS_BIND_HOST`** environment
variable is explicitly set to `0.0.0.0` (default `127.0.0.1`; `.env.example` carries it with the same
warning). This is a deliberate default-secure posture — scrape from a sidecar or same-host collector
to stay within the loopback-only default, or set `METRICS_BIND_HOST` deliberately if you need
external scraping, and never expose `/metrics` through a public reverse proxy
([`reverse-proxy-tls.md`](reverse-proxy-tls.md)).

The variable is parsed at boot; changing it requires an API restart.

### Currently-shipped metric set

| Metric | Meaning |
| --- | --- |
| `http_requests_total` | Per-route request count, labeled `method`/`route`/`status_code` |
| `http_request_duration_seconds` | Per-route request latency histogram, same labels |
| `process_uptime_seconds` | Process uptime |
| `vault_sealed` | **1** if sealed or uninitialized, **0** if unsealed — the single most important dashboard tile for this application |
| `db_pool_connections_active` | In-flight query count; sustained high values indicate connection-pool exhaustion |
| `rotation_initiations_total`, `rotation_completions_total`, `rotation_checklist_items_pending_total`, `rotation_break_glass_total` (+ related stale/recovery counters and gauges) | Rotation-lifecycle metrics |
| Node.js default process metrics | via `collectDefaultMetrics()` |

There is **no queue-depth metric** for the background job system. If you need job-queue visibility,
query pg-boss's own tables directly.

**Recommended alerting:** `vault_sealed == 1` for more than 2 minutes (an unattended reseal, worth
paging on), plus a sustained `db_pool_connections_active` threshold.

`/metrics` is per-process and is not aggregated across API processes — see
[`multi-replica.md`](multi-replica.md).

---

## Key alert types and who responds

| Alert type | First response |
| --- | --- |
| `backup.missed` / `backup.failure` | [`backup-restore.md`](backup-restore.md) § Backup missed for more than 24 hours |
| `key_custody_risk` (key age > `KEY_ROTATION_MAX_AGE_DAYS`, default 365 days) | [`master-key.md`](master-key.md) |
| `audit_storage.critical` / `audit_storage.warning` (95%/90%/80% of `AUDIT_LOG_STORAGE_LIMIT_GB`) | [`incident-response.md`](incident-response.md) § Audit-log storage at 95%, then [`audit-storage-exhaustion.md`](audit-storage-exhaustion.md) |
| `audit_usage_reconciliation.failing` | [`audit-storage-exhaustion.md`](audit-storage-exhaustion.md); the immediate kill switch is `AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED=false` |
| `resource.orgs_near_limit`, `resource.users_near_limit` (80/90/95% tier thresholds) | Contact the org to plan a tier upgrade or usage reduction — **not** a technical incident |
| `org.sessions_revoked_by_service` | [`service-revocation-token-rotation.md`](service-revocation-token-rotation.md) — expected on a real deprovisioning, a leak signal otherwise |
| `backup.storage_init_failed` | [`backup-restore.md`](backup-restore.md) § Backup permission remediation |
| `security.failed_auth_threshold` | Organization admins, not the platform operator |
| `user.dormant` | Organization admins, not the platform operator |
| `clock_skew.measured` at `warn` level | [`handoff-instance-identity.md`](handoff-instance-identity.md) § Clock-skew signal |

Org-level alerts landing in a shared ops channel the platform operator also monitors are **not**
automatically the platform operator's to act on — this table exists specifically to prevent
misrouting incident-response time to an alert that belongs to an org admin. Treat it as living
documentation: any new alert type should be added here as part of the change that introduces it.

`GET /ready`'s `warnings` array surfaces exactly two of these (`audit_storage_critical` and
`key_custody_risk`) and only while the corresponding `admin_alerts` row is `status = 'active'`. No
other alert has a `/ready` signal.

---

## Verifying audit-log integrity — two separate logs

There are two entirely separate logs, each with its own verify endpoint, and **no unified cross-log
search in v1**. This is a deliberate v1 scope boundary, not an oversight: checking one does not mean
you have checked "the" audit trail.

- **Per-org security audit log** (`audit_log_entries`) — `GET /api/v1/org/audit/verify`
  (**Owner role only** — there is no separate "Audit" role in this application; an org admin is not
  sufficient and receives `403`). Response:
  `{"data":{"summary":"...","rowsChecked":N,"passed":N,"failed":[{"id","eventType","timestamp"}],"failedCount":N,"failedTruncated":bool,"verifiedAt":"..."}}`.
- **Platform operator audit log** (`platform_audit_events`) — `GET /api/v1/platform/audit/verify`
  (platform-operator-only, requires MFA). Every response carries an `X-Log-Scope: platform` header.
  The response shape matches the org-scoped one except that `failed[]` entries use `actionType`
  instead of `eventType`.

An operator investigating a full incident picture must check both independently — an admin-initiated
org creation, or a backup/restore action, is recorded exclusively in the platform log, not the org
log. Checking only the org log and finding it clean is an incomplete investigation if the suspected
action was a platform-operator action.

Both endpoints require an **unsealed vault** (they recompute HMACs against the respective signing
key); a sealed vault returns `503`. Unseal first
([`vault-lifecycle.md`](vault-lifecycle.md)).

Both logs are chain-linked: each row stores the previous row's HMAC plus a monotonic `chain_seq`, so
deleting an interior row breaks verification even though every surviving row's own HMAC stays
self-consistent. A verification failure naming a specific row is therefore evidence of tampering or
corruption, not a benign inconsistency.
