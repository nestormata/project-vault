# Credential version retention

<!-- Verified against apps/api/src/workers/prune-credential-versions.ts,
     apps/api/src/config/env.ts, apps/api/src/main.ts (credentials/prune-versions cron) -->

## When to use

Turning on destructive purge of historical credential versions on a new production deployment, or
explaining why a `versionsWouldPurge` / `versionsPurged` count looks wrong.

---

## What the worker does

Each credential's `retentionCount` (set at creation, per credential) bounds how many historical
versions are kept. Older, non-current, non-rotation-locked versions are candidates for the retention
worker (`credentials/prune-versions`, cron `0 3 * * *`).

Purging is **irreversible** — a purged version's `encryptedValue` is zero-overwritten then set to
`null` and cannot be recovered from the live database, only from a pre-purge backup snapshot
([`backup-restore.md`](backup-restore.md)).

`CREDENTIAL_RETENTION_DRY_RUN` (boolean env var) controls whether the worker actually purges or only
logs what it *would* purge:

- **Production defaults to `true` (dry-run).** The default is derived from `NODE_ENV=production`, so
  a fresh production deployment never purges anything until an operator explicitly overrides it.
  Every run instead emits a `CREDENTIAL_RETENTION_DRY_RUN` operational log line per purge-eligible
  version (`credentialId`, `versionNumber`) plus a per-org summary (`credentialsScanned`,
  `versionsWouldPurge`).
- **Development/test default to `false`** (destructive), for local test coverage.

It is parsed once at boot: changing it requires an API restart.

---

## Enabling destructive purge on a new production deployment

1. Leave `CREDENTIAL_RETENTION_DRY_RUN` unset (or explicitly `true`) for at least one full worker run
   cycle after go-live. Confirm the worker is actually running by checking for
   `CREDENTIAL_RETENTION_DRY_RUN`-tagged log lines in your log aggregator — zero log lines with
   credentials present in the org usually means the worker is not scheduled, not that nothing is
   purge-eligible.
2. Review the dry-run summaries' `versionsWouldPurge` counts against your own expectations for how
   many old versions each project's credentials should realistically have accumulated. Investigate
   before proceeding if a count looks implausibly high — that usually indicates a `retentionCount`
   misconfiguration rather than a worker bug.
3. Take a fresh backup snapshot immediately before flipping the flag. This is your only recovery path
   if a purge turns out to be wrong.
4. Set `CREDENTIAL_RETENTION_DRY_RUN=false` and restart the API process so the worker picks up the
   new value.
5. **Verify:** after the next run, confirm the `CREDENTIAL_RETENTION_SUMMARY` log lines'
   `versionsPurged` counts are consistent with the dry-run's `versionsWouldPurge` counts from step 2.
   They should match closely; a large discrepancy usually means new versions were created between the
   dry run and the real run, which is expected under normal usage, not a defect.

**Rollback:** set `CREDENTIAL_RETENTION_DRY_RUN=true` and restart. That stops further purging
immediately but does **not** restore anything already purged — recovering a purged version requires a
restore from a pre-purge backup.

---

## Why a count can look lower than expected

**Rotation-in-progress exemption:** a version that is the current active credential value for an
in-progress rotation is exempt from purge until the rotation completes or is abandoned (the
`rotationLockedAt` guard in `purgeCandidatesForCredential`/`purgeVersion`). This is enforced
automatically and requires no operator action, but explains a low `versionsWouldPurge` count for a
project with active rotations.

---

## Every purge is audited

Each purged version writes a `credential.version_purged` entry to the tamper-evident audit log
(`payload: { credentialId, versionNumber }`) in the same transaction as the purge. Query the audit log
([`monitoring.md`](monitoring.md) § Verifying audit-log integrity) to reconstruct exactly which
versions were purged and when.
