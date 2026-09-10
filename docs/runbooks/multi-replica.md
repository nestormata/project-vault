# Running more than one API replica

<!-- Verified against apps/api/src/modules/vault/key-service.ts (module-level _primaryKey/_auditKey/
     _backupKey/_status, isSealed()), apps/api/src/lib/route-helpers.ts (userRateLimitWindows —
     an in-process Map), apps/api/src/routes/metrics.ts, apps/api/src/main.ts (registerSchedules,
     singletonKey), apps/api/src/modules/backup/service.ts (pg_advisory_lock),
     apps/api/src/config/env.ts (EXTENSION_DATABASE_POOL_MAX),
     apps/api/src/workers/clock-skew-check.ts -->

## The short answer

**A single API replica is the only supported topology in v1.** Do not scale the `api` service to more
than one instance. There is no configuration that makes it correct, and the failure mode is not
graceful degradation — it is a fraction of requests failing in a way that looks like a random outage.

Scaling Postgres, or running the `web` service with multiple replicas, is unaffected by any of this;
the constraint is specific to the API process.

---

## Why — the blocking reason

**Seal state and every derived key live in the API process's own memory, not in the database.**
`POST /api/v1/vault/unseal` derives the primary, audit, backup and platform-audit keys and commits
them to module-level state inside the single process that served the request. `isSealed()` reads that
same in-process state.

With two replicas behind a load balancer, an unseal call reaches exactly one of them. The other stays
sealed, and there is no mechanism — no shared cache, no broadcast, no DB flag — that tells it to
unseal. The observable result is:

- `GET /ready` returns `ready` or `503 {"reason":"sealed"}` depending on which replica answered.
- The `vault_sealed` metric is `0` on one replica and `1` on the other.
- Roughly half of all requests that touch encrypted data fail, and refreshing "fixes" it.

Nothing in this codebase coordinates that, and there is no operator workaround short of unsealing
each replica individually through a direct, load-balancer-bypassing address after every restart — at
which point you have a manual step that must be repeated per replica, per deploy, per crash, with no
tooling and no verification.

---

## The other consequences, for completeness

Even if seal state were solved, these would still need work before multi-replica was safe:

| Area | Behaviour with N replicas |
| --- | --- |
| **Per-route rate limiting** | The limiter is an in-process `Map` (`userRateLimitWindows` in `lib/route-helpers.ts`), keyed by user id or client IP plus route. With N replicas the effective limit is roughly **N × the configured value**, and it is not even that predictable, since which replica a request lands on is the load balancer's business. Security-relevant limits — the 5/minute unseal cap, the 30/minute `/status` cap, the per-route auth caps — all loosen proportionally. There is no shared store (no Redis, nothing DB-backed) to switch to. |
| **`/metrics`** | Each process exposes only its own counters, with no aggregation. Prometheus must scrape every replica as a separate target with distinct labels; a single scrape target behind the load balancer gives you a random replica's numbers each interval, which is worse than no data. Also note `/metrics` is loopback-bound by default, so each replica needs its own same-host collector. |
| **Scheduled jobs** | These are actually fine. Schedules live in the shared `pgboss.schedule` table and pg-boss coordinates them through the database, so a cron does not fire once per replica; the startup one-shot enqueues additionally pass `singletonKey` so a restart or hot reload cannot duplicate them. Job *workers* on every replica is also fine — job fetch is atomic. |
| **Backup and restore concurrency** | Also fine. Both take a Postgres advisory lock on `hashtext('backup/snapshot')`, which is **database-scoped**, so it excludes concurrent backups and restores across every replica connected to that database, not just within one process. |
| **Extension database pool** | `EXTENSION_DATABASE_POOL_MAX` (default 3) is a **per-process** ceiling, as are the core and admin pools (effective max 10 each). N replicas multiply all three against the same Postgres `max_connections`, and you must still leave headroom for migrations and `psql` sessions. A pool max larger than `max_connections` is rejected at startup; aggregate over-subscription only warns, so nothing stops you from oversubscribing a cluster with replicas. |
| **Clock-skew check** | Per-replica by design and correct that way: each process measures its own drift against the same Postgres clock, with no coordination needed. But the `GET /api/v1/admin/extensions/status` diagnostics report only the answering replica's measurement, so a single skewed replica can hide behind a healthy one. |
| **Handoff instance identity** | `VAULT_HANDOFF_INSTANCE_ID` identifies the *instance*, not the process, so replicas of one instance share it — that part is fine. Every replica must still be restarted for a `VAULT_HANDOFF_VERIFY_KEYS` change to take effect ([`handoff-key-rotation.md`](handoff-key-rotation.md)). |

---

## What to do instead

- Size a single API container vertically. The `api` service's memory limit is set in
  `docker-compose.prod.yml`; raise it rather than adding replicas.
- Use the graceful-shutdown window (`stop_grace_period: 30s`) and a healthcheck-gated deploy to keep
  restart downtime short. There is no zero-downtime deploy in v1 — a restart always seals the vault
  and always requires a manual unseal ([`vault-lifecycle.md`](vault-lifecycle.md)).
- Alert on `vault_sealed == 1` for more than 2 minutes so an unattended reseal is noticed
  ([`monitoring.md`](monitoring.md)).
- If you need high availability, plan for it as a product requirement rather than an operational
  setting: it needs a shared unseal mechanism, a shared rate-limit store, and metric aggregation, none
  of which exist today.
