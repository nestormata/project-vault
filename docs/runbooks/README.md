# Operations runbooks

Every runbook here follows the same shape: **When to use / Trigger → Diagnose → Fix → Verify →
Rollback**. Start from [`docs/runbook.md`](../runbook.md) for the short index, or from the trigger
table below.

## Trigger → runbook

| Trigger / symptom | Runbook |
| --- | --- |
| Standing up a new instance for the first time | [`vault-lifecycle.md`](vault-lifecycle.md) |
| `GET /ready` → `503 {"reason":"sealed"}`, or `vault_sealed == 1` | [`vault-lifecycle.md`](vault-lifecycle.md) § Manual unseal |
| `GET /ready` → `503 {"reason":"db"}` or `"uninitialized"` | [`vault-lifecycle.md`](vault-lifecycle.md) § Unexpected seal triage |
| The `/status` monitoring token is lost, or the monitor is getting `401` | [`vault-lifecycle.md`](vault-lifecycle.md) § `/status` token lost |
| Moving to a new release | [`upgrade-notes.md`](upgrade-notes.md) first, then [`upgrades.md`](upgrades.md) |
| The migration wrapper refused a destructive migration | [`upgrades.md`](upgrades.md) § Offline migration path |
| `/health` reports the wrong version, or a release-publish verification step failed | [`upgrades.md`](upgrades.md) § Release-identity source |
| The API refuses to boot on `ADMIN_DATABASE_URL` | [`upgrade-notes.md`](upgrade-notes.md) § Migration `0071` |
| Taking, validating, or restoring a backup on a working instance | [`backup-restore.md`](backup-restore.md) |
| `backup.missed` / `backup.failure` alert | [`backup-restore.md`](backup-restore.md) § Backup missed |
| `backup.storage_init_failed`, or a backup failing with a permission error | [`backup-restore.md`](backup-restore.md) § Backup permission remediation |
| The host is gone and the instance must be rebuilt elsewhere | [`disaster-recovery.md`](disaster-recovery.md) |
| Restoring an external `pg_dump` | [`disaster-recovery.md`](disaster-recovery.md) § Path B |
| `key_custody_risk` alert | [`master-key.md`](master-key.md) |
| Key material is lost, or an unseal fails with `401`/`400 key_file_not_found` | [`master-key.md`](master-key.md) § Lost key material |
| `kms_unreachable`, `kms_key_unavailable`, `kms_permission_denied` | [`master-key.md`](master-key.md) § KMS failure modes |
| A HMAC/session secret is suspected leaked, or an instance is on dev values | [`secret-rotation.md`](secret-rotation.md) |
| `SERVICE_REVOCATION_TOKEN` leak, or `org.sessions_revoked_by_service` fired unexpectedly | [`service-revocation-token-rotation.md`](service-revocation-token-rotation.md) |
| Rotating the CentralizeMe handoff signing key, or responding to its compromise | [`handoff-key-rotation.md`](handoff-key-rotation.md) |
| Configuring handoff identity/keys, or a `clock_skew.measured` warning | [`handoff-instance-identity.md`](handoff-instance-identity.md) |
| No HTTP response at all from the API | [`incident-response.md`](incident-response.md) § Vault unreachable |
| `audit_storage.critical` alert, or `/ready` warns `audit_storage_critical` | [`incident-response.md`](incident-response.md) § Audit-log storage at 95% |
| The instance is full but every org is inside its quota | [`audit-storage-exhaustion.md`](audit-storage-exhaustion.md) |
| An org is getting `503 audit_quota_exhausted` | [`audit-storage-exhaustion.md`](audit-storage-exhaustion.md) |
| A machine-user API key is suspected compromised | [`incident-response.md`](incident-response.md) § Emergency revoke |
| A break-glass rotation was used during an incident | [`incident-response.md`](incident-response.md) § Break-glass sweep |
| Nobody can log in with email/password after installing an auth extension | [`native-login-exclusion.md`](native-login-exclusion.md) |
| Installing, upgrading, or rolling back a module pack | [`module-pack-lifecycle.md`](module-pack-lifecycle.md) |
| Granting or narrowing an extension's database access | [`extension-db-access.md`](extension-db-access.md) |
| `check-rls` fails, or table ownership looks wrong after a restore | [`rls-ownership.md`](rls-ownership.md) |
| `check-function-executability` fails | [`function-executability.md`](function-executability.md) |
| Turning on destructive credential-version purge | [`credential-retention.md`](credential-retention.md) |
| Setting up scraping and alerting, or deciding who owns an alert | [`monitoring.md`](monitoring.md) |
| Putting the stack behind Traefik/nginx, or deciding what to expose | [`reverse-proxy-tls.md`](reverse-proxy-tls.md) |
| Considering scaling the API to more than one replica | [`multi-replica.md`](multi-replica.md) |
| Quarterly maintenance | [`quarterly-checklist.md`](quarterly-checklist.md) |

## Design notes (not procedures)

- [`docs/design/audit-quota.md`](../design/audit-quota.md) — why per-org audit quotas work the way
  they do.
- [`docs/design/audit-log-scaling.md`](../design/audit-log-scaling.md) — the storage-pressure
  escalation path.
