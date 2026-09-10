# Operational runbook — index

Continuation of [`docs/operator-quickstart.md`](operator-quickstart.md) (zero → eval-ready) for
**after** a healthy instance exists. Every procedure lives in a topic runbook under
[`docs/runbooks/`](runbooks/README.md); this page is the map.

Most `curl`-based procedures also have an equivalent screen in the **Platform Admin** web UI
(`/platform`, visible only to the platform operator — the first user registered on the instance).
The commands are the authoritative, scriptable reference, and the only option when the web app is
unreachable.

## Which runbook for which symptom

| Symptom | Go to |
| --- | --- |
| `/ready` says `sealed`, `db`, or `uninitialized` | [Vault lifecycle](runbooks/vault-lifecycle.md) |
| Moving to a new release | [Upgrade notes](runbooks/upgrade-notes.md), then [Upgrades](runbooks/upgrades.md) |
| `backup.missed` / `backup.failure` / a backup permission error | [Backup & restore](runbooks/backup-restore.md) |
| The host is gone; rebuild elsewhere | [Disaster recovery](runbooks/disaster-recovery.md) |
| `key_custody_risk`, a KMS error, or lost key material | [Master key](runbooks/master-key.md) |
| A secret or API key is suspected leaked | [Secret rotation](runbooks/secret-rotation.md) |
| No HTTP response, or `audit_storage_critical` | [Incident response](runbooks/incident-response.md) |
| The instance is full but every org is inside its quota | [Audit storage exhaustion](runbooks/audit-storage-exhaustion.md) |
| Nobody can log in after an auth extension was installed | [Native-login exclusion](runbooks/native-login-exclusion.md) |
| Deciding what to expose publicly | [Reverse proxy & TLS](runbooks/reverse-proxy-tls.md) |

The full trigger table is in [`docs/runbooks/README.md`](runbooks/README.md).

## All runbooks

- [Vault lifecycle](runbooks/vault-lifecycle.md) — first deploy, init, manual unseal, `/status`, startup/shutdown
- [Upgrades](runbooks/upgrades.md) — in-place upgrade, release identity, destructive migrations
- [Upgrade notes](runbooks/upgrade-notes.md) — version-ordered pre-steps, including 1.2.0
- [Backup & restore](runbooks/backup-restore.md) — trigger, validate, restore, permission remediation
- [Disaster recovery](runbooks/disaster-recovery.md) — rebuilding on a new host, external `pg_dump`
- [Master key](runbooks/master-key.md) — key modes, KMS, lost key material
- [Secret rotation](runbooks/secret-rotation.md) — the twelve HMAC/session secrets
- [Credential retention](runbooks/credential-retention.md) — destructive version purge rollout
- [Incident response](runbooks/incident-response.md) — unreachable API, audit storage, key compromise
- [Audit storage exhaustion](runbooks/audit-storage-exhaustion.md) — instance overcommit
- [Monitoring](runbooks/monitoring.md) — metrics, alert ownership, audit-log integrity
- [Reverse proxy & TLS](runbooks/reverse-proxy-tls.md) — what to expose, worked Traefik example
- [Multiple API replicas](runbooks/multi-replica.md) — why single-replica is the supported topology
- [Quarterly checklist](runbooks/quarterly-checklist.md)
- Subsystems: [module packs](runbooks/module-pack-lifecycle.md) ·
  [extension DB access](runbooks/extension-db-access.md) ·
  [RLS ownership](runbooks/rls-ownership.md) ·
  [function executability](runbooks/function-executability.md) ·
  [native-login exclusion](runbooks/native-login-exclusion.md) ·
  [handoff identity](runbooks/handoff-instance-identity.md) ·
  [handoff key rotation](runbooks/handoff-key-rotation.md) ·
  [service revocation token](runbooks/service-revocation-token-rotation.md)

## Upgrades

Read [upgrade notes](runbooks/upgrade-notes.md) for the pre-steps that apply between your current
version and your target, then follow [upgrades](runbooks/upgrades.md) for the mechanics: the
source-built and image-based paths, the guarded migration step, release-identity verification, and
the offline path for a destructive migration.

## Backup & recovery

[Backup & restore](runbooks/backup-restore.md) covers in-place operations against a running
instance. [Disaster recovery](runbooks/disaster-recovery.md) covers rebuilding on a new host —
volumes, cluster roles, key material, and instance identity.

## Master key management

[Master key](runbooks/master-key.md) covers the four key modes, AWS KMS configuration and failure
modes, and the loss matrix. Rotation is **not supported in v1**.

## Incident response

[Incident response](runbooks/incident-response.md) for triage; [monitoring](runbooks/monitoring.md)
for which alert belongs to whom.
