# Incident response

<!-- Verified against apps/api/src/routes/{health,metrics}.ts,
     apps/api/src/workers/audit-storage-check.ts, apps/api/src/modules/audit/routes.ts,
     apps/api/src/modules/audit/quota-gate.ts, apps/api/src/modules/machine-users/routes.ts,
     apps/api/src/modules/rotation/routes.ts -->

## When to use

The instance is not responding, an alert has fired, or a credential/key is suspected compromised.

---

## "Vault unreachable" triage

- **Trigger:** no HTTP response at all — strictly worse than a sealed-but-responsive vault
  ([`vault-lifecycle.md`](vault-lifecycle.md)).

### Diagnose

1. **Container not running at all.** `docker compose ps` shows `api` exited or restarting. Check
   `docker compose logs api` for a crash loop — most commonly a failed startup env-var validation (a
   `FATAL:` message naming the specific missing/invalid variable) or an unrecovered OOM-kill loop.
2. **Container running but not responding.** Check `docker compose logs api` for a hang (e.g. a stuck
   migration — see [`upgrades.md`](upgrades.md)). Check Postgres reachability independently
   (`docker compose logs db`, or `docker compose exec db pg_isready`).
3. **Container responding but `/health` and `/ready` both time out.** Check for connection-pool
   exhaustion (the `db_pool_connections_active` Prometheus gauge — a sustained high value indicates
   this failure mode) or an event-loop-blocking bug (check CPU usage; Node.js is single-threaded for
   non-worker-thread code).

### Fix

Each branch ends in a concrete remediation: restart the specific failed component, or — if the
failure correlates exactly with a just-completed upgrade — roll back to the last known-good image
tag. That is often faster and safer than deep triage, **provided no destructive migration was part of
the failed upgrade**, which would make a plain rollback unsafe.

Only escalate to a full restore ([`backup-restore.md`](backup-restore.md)) if data *corruption* — not
just unavailability — is suspected. Do not reach for a destructive, hours-long restore reflexively
before ruling out a simple container crash loop.

---

## Audit-log storage at 95% capacity

- **Trigger:** the `audit_storage.critical` alert (95% of `AUDIT_LOG_STORAGE_LIMIT_GB`, default
  **50 GB**), or `GET /ready` reporting
  `{"status":"ready","warnings":["audit_storage_critical"]}`.

**This alert is informational — it does not suspend anyone's audit writes.** There is no
instance-wide audit-write gate in this codebase; the only write-side consequence of storage pressure
is a **per-org** `503 audit_quota_exhausted` for an organization that is over **its own** configured
quota. Do not go looking for suspended writes or queued WARN-level entries to replay: none exist.

### Diagnose

1. Confirm the condition: `GET /ready` → `{"status":"ready","warnings":["audit_storage_critical"]}`.
   `/ready` still reports `ready`; this is a warning, not an outage.
2. Identify the responsible organizations from the alert payload rather than guessing. The
   `admin_alerts` row's `payload.topContributingOrgs` is an array of `{orgId, bytesAdded, rowsAdded}`
   — the top 5 orgs by recent growth.

### Fix

3. **Export before pruning anything.** `audit_log_entries` is the org's compliance record; never prune
   without a completed, verified export first:

   ```bash
   curl -s -X POST http://localhost:${API_HOST_PORT}/api/v1/org/audit/export \
     -H 'Authorization: Bearer <org owner token, MFA verified>' \
     -H 'Content-Type: application/json' \
     -d '{"from":"2026-01-01T00:00:00Z","to":"2026-03-31T23:59:59Z","format":"csv"}'
   # → 202 {"data":{"jobId":"<uuid>","status":"pending"}}
   ```

   Owner role plus MFA; `format` is required and `"csv"` is the only accepted value. The range may
   not exceed **400 days** — split a longer export into several calls.
   `includeIntegrityReport` defaults to `true`.

   The export is asynchronous: poll `GET /api/v1/org/audit/exports/:jobId` until `status` is
   `completed`, then fetch `GET /api/v1/org/audit/exports/:jobId/download`. Do not prune until the
   download has been retrieved and stored.
4. Prune entries older than the org's configured retention period via the existing retention-purge
   mechanism (organization admins configure `audit_retention_config.retention_days` within their tier
   limits). Retention configuration and forwarding are both exempt from quota refusal, so an org that
   is itself over quota can always still make these changes.
5. **Work the instance-level levers.** If the instance is at 95% while every organization is inside
   its own quota, that is the overcommit case — follow
   [`audit-storage-exhaustion.md`](audit-storage-exhaustion.md), which has the SQL and the ordered
   levers (lower the instance-wide default, tighten large orgs' explicit quotas, point contributors at
   retention/forwarding, provision more disk).

### Verify

6. Re-check storage utilization drops below the 80% tier, and confirm `GET /ready` no longer reports
   `audit_storage_critical` after the next `audit-storage/check` run (daily, cron `0 4 * * *`).

If the responsible org disputes that the growth is illegitimate, that is a business conversation —
guide a legitimately high-activity org toward a larger quota or a tier upgrade. Export-and-prune buys
time; it does not replace addressing root cause.

---

## Break-glass rotation post-incident sweep

- **Trigger:** `POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/break-glass` was
  used during an incident.

1. Confirm the old credential value is actually revoked or rotated **in the target system**, not just
   marked rotated in this application.
2. Verify the break-glass action produced the expected audit trail: a `rotation.break_glass`-tagged
   `audit_log_entries` row, plus a superseded-rotation entry if a prior rotation was in flight, both
   visible via the standard org-scoped audit search.
3. Close and discard the browser session used to perform the emergency rotation, and confirm the new
   plaintext value was stored in your credential manager rather than left in a tab, a terminal
   scrollback, or a chat message. The rotation UI clears the value from its own state, but nothing can
   clear it from wherever an operator pasted it.
4. Review whether the incident requires a broader credential sweep — were any dependent credentials
   (this application's dependency tracking) also potentially exposed and requiring their own rotation?
   "No dependents configured" is a valid fast answer, but confirm it reflects reality (dependents were
   actually recorded here), not an unconfigured gap masquerading as "nothing to worry about."
5. Document the incident timeline and root cause in your own incident record.

Do not close the incident the moment the break-glass rotation succeeds — the rotation succeeding is
necessary but not sufficient; skipping the dependency sweep risks leaving a genuinely compromised
dependent credential unaddressed.

---

## Compromised machine-user API key — emergency revoke

- **Trigger:** an API key is suspected leaked and must stop working *now*, with no overlap window.

### Diagnose — find the `keyId`

Both path parameters are **UUIDs**: `:machineUserId` is the machine user's row id and `:keyId` is the
`api_keys` row id. A `pk_...` key prefix is **not** a `keyId` and will return `404`. List the machine
user's keys first and match on `name`:

```bash
curl -s http://localhost:${API_HOST_PORT}/api/v1/machine-users/<machineUserId uuid>/api-keys \
  -H 'Authorization: Bearer <org admin token, MFA verified>'
# → 200 {"data":{"items":[
#     {"id":"<keyId uuid>","name":"ci-deploy","expiresAt":null,"lastUsedAt":"...",
#      "createdAt":"...","isRevoked":false}
#   ], ...}}
```

The listing deliberately does not expose any part of the key material, so identify the right row by
`name`/`createdAt`, not by prefix.

### Fix

```bash
curl -s -X POST \
  http://localhost:${API_HOST_PORT}/api/v1/machine-users/<machineUserId uuid>/api-keys/<keyId uuid>/emergency-revoke \
  -H 'Authorization: Bearer <org admin token, MFA verified>'
# → 200 {"data":{"revokedKeyId":"<uuid>","newKey":"<plaintext, shown only this once>","newKeyId":"<uuid>"}}
```

No request body. This is an **atomic revoke-old + issue-new operation in a single call** —
deliberately distinct from the routine `.../rotate` endpoint's overlap-based zero-downtime rotation
(the old key here stops working *immediately*, with no overlap window) and from a plain revoke, since
the replacement is already in this response.

**Capture `newKey` immediately.** Like every other key-issuance response in this API, the plaintext is
returned exactly once and is not recoverable from any later `GET`.

Requires MFA on the calling admin session (`403 {"code":"mfa_required"}` if not MFA-verified — a
stolen session alone must not be sufficient to interfere with key-compromise response) and is itself
rate-limited; do not interpret a rate-limit response as the revoke having silently failed.

### Verify

1. Confirm via `GET .../api-keys` that the old key's `isRevoked` is now `true` — the list exposes a
   boolean flag here, not a `revokedAt` timestamp.
2. Update the CI/CD or automation system's stored credential with the `newKey` captured above. There
   is no separate create-new-key step: re-running `.../rotate` or `.../emergency-revoke` against the
   now-revoked old key returns
   `409 {"code":"api_key_already_revoked", "message":"This key has already been revoked"}`.
3. Review the audit trail for any usage of the compromised key between suspected exposure and
   revocation, to scope the incident.

### Rollback

None. A revoked key can never be un-revoked; the replacement key is the only path forward.

---

## Related incident runbooks

| Situation | Runbook |
| --- | --- |
| A secret (HMAC/session) is suspected leaked | [`secret-rotation.md`](secret-rotation.md) |
| The CentralizeMe handoff signing key is suspected leaked | [`handoff-key-rotation.md`](handoff-key-rotation.md) |
| `SERVICE_REVOCATION_TOKEN` is suspected leaked, or its alert fired unexpectedly | [`service-revocation-token-rotation.md`](service-revocation-token-rotation.md) |
| An auth extension has locked everyone out of native login | [`native-login-exclusion.md`](native-login-exclusion.md) |
| The instance is gone and must be rebuilt elsewhere | [`disaster-recovery.md`](disaster-recovery.md) |
