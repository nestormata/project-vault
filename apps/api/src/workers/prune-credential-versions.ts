import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  auditLogEntries,
  credentialVersions,
  credentials,
  rotations,
} from '@project-vault/db/schema'
import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import type { FastifyBaseLogger } from 'fastify'
import { env } from '../config/env.js'
import { operationalLog } from '../lib/logger.js'
import { zeroOverwriteCredentialVersionValue } from '../lib/zero-overwrite-credential-version.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { currentAuditKeyVersion } from '../modules/audit/key-version.js'
import { computeAuditHmac } from '../modules/audit/write-entry.js'
import {
  assertOrgMayWriteAudit,
  assertOrgMayWriteAuditAtRate,
  estimateAuditEntrySizeBytes,
} from '../modules/audit/quota-gate.js'
import { getAuditKey } from '../modules/vault/key-service.js'
import { writeSystemAuditRow } from '../lib/system-audit-row.js'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

type PurgeCandidate = {
  id: string
  credentialId: string
  versionNumber: number
}

async function purgeCandidatesForCredential(
  tx: Tx,
  credentialId: string,
  retentionCount: number
): Promise<PurgeCandidate[]> {
  const versions = await tx
    .select({
      id: credentialVersions.id,
      versionNumber: credentialVersions.versionNumber,
      abandonedAt: credentialVersions.abandonedAt,
    })
    .from(credentialVersions)
    .where(
      and(
        eq(credentialVersions.credentialId, credentialId),
        isNull(credentialVersions.purgedAt),
        isNull(credentialVersions.rotationLockedAt)
      )
    )
    .orderBy(desc(credentialVersions.versionNumber))

  // Story 5.3 fix: an abandoned version (AC-12/CR5) can carry a HIGHER version number than the
  // actual "current" version — abandonment never renumbers anything (AC-13's anti-pattern
  // guard) — so ranking purge-eligibility purely by versionNumber DESC can push the real
  // current version out of the keep window while a defunct abandoned version occupies a
  // retention slot instead. `revealCurrentValue()`/`listVersionHistory()`'s "current" definition
  // (highest versionNumber with purgedAt AND abandonedAt both null) must never be purged
  // regardless of its rank in this list — abandoned versions still age out on the normal
  // schedule (AC-1's "NOT purged early — stays queryable in history"), they just can't be
  // allowed to protect themselves ahead of the version that's actually live.
  const currentVersionId = versions.find((version) => version.abandonedAt === null)?.id ?? null

  // Keep-≥-1 invariant (F1): never purge the single highest non-purged version, even if
  // retentionCount somehow resolves below 1 (the DB CHECK prevents this, but guard anyway).
  const keepCount = Math.max(retentionCount, 1)
  return versions
    .slice(keepCount)
    .filter((version) => version.id !== currentVersionId)
    .map((version) => ({
      id: version.id,
      credentialId,
      versionNumber: version.versionNumber,
    }))
}

async function purgeVersion(tx: Tx, orgId: string, candidate: PurgeCandidate): Promise<boolean> {
  const [lockedCandidate] = await tx
    .select({ id: credentialVersions.id })
    .from(credentialVersions)
    .where(
      and(
        eq(credentialVersions.id, candidate.id),
        isNull(credentialVersions.rotationLockedAt),
        isNull(credentialVersions.purgedAt)
      )
    )
    .for('update')
    .limit(1)
  if (!lockedCandidate) return false

  await zeroOverwriteCredentialVersionValue(tx, candidate.id)
  await tx
    .update(credentialVersions)
    .set({ encryptedValue: null, keyVersion: null, purgedAt: new Date() })
    .where(eq(credentialVersions.id, candidate.id))

  const payload = { credentialId: candidate.credentialId, versionNumber: candidate.versionNumber }
  const purgeEventType = 'credential.version_purged'
  // Story 22.2 AC-4 (site 8 of 9): rate gate first, then storage gate (documented ordering).
  await assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: purgeEventType })
  // Story 22.1 AC-13 (site 8 of 9 — this worker's own inline insert; it also calls the already-
  // gated writeSystemAuditRow site 5 elsewhere in this file).
  await assertOrgMayWriteAudit(tx, {
    orgId,
    eventType: purgeEventType,
    sizeBytes: estimateAuditEntrySizeBytes({
      payload,
      resourceId: candidate.credentialId,
      resourceType: 'credential',
    }),
  })
  const keyVersion = await currentAuditKeyVersion(tx)
  const hmac = computeAuditHmac(
    {
      orgId,
      actorTokenId: null,
      actorType: 'system',
      eventType: purgeEventType,
      resourceId: candidate.credentialId,
      resourceType: 'credential',
      payload,
      keyVersion,
    },
    getAuditKey()
  )
  await tx.insert(auditLogEntries).values({
    orgId,
    actorTokenId: null,
    actorType: 'system',
    eventType: purgeEventType,
    resourceId: candidate.credentialId,
    resourceType: 'credential',
    payload,
    keyVersion,
    hmac,
  })

  // Review fix (5-6 code review, AC-9.1e/AC-9.3): the deferred break-glass `ROTATION_OLD_RETIRED`
  // audit event belongs at the moment the old version's ciphertext is *actually* zeroed — this
  // is that moment. It previously fired from rotation-break-glass-expire.ts's overlap-expiry
  // UPDATE, which only clears `rotationLockedAt`/`breakGlassOverlapExpiresAt` (lifting the FR105
  // exemption) — the version then still has to wait its turn in this job's ordinary
  // retentionCount-gated purge cycle (same as any other non-current version), which can be a
  // long or even indefinite delay depending on `retentionCount`. Firing the audit at overlap
  // expiry therefore claimed "old retired" (cryptographically destroyed) for a value that, in
  // the common case (default retentionCount=3, few historical versions), had not actually been
  // destroyed yet and might not be for some time. Writing it here instead means the audit only
  // ever describes a purge that has genuinely already happened in this same transaction.
  const [breakGlassRotation] = await tx
    .select({ id: rotations.id })
    .from(rotations)
    .where(
      and(
        eq(rotations.previousVersionId, candidate.id),
        eq(rotations.status, 'break_glass_complete')
      )
    )
    .limit(1)
  if (breakGlassRotation) {
    await writeSystemAuditRow(tx, {
      orgId,
      eventType: AuditEvent.ROTATION_OLD_RETIRED,
      payload: {
        rotationId: breakGlassRotation.id,
        credentialVersionId: candidate.id,
        credentialId: candidate.credentialId,
        breakGlass: true,
      },
    })
  }

  return true
}

async function pruneOrgCredentialVersions(
  orgId: string,
  dryRun: boolean,
  logger?: WorkerLogger
): Promise<{ credentialsScanned: number; versionsPurged: number; versionsWouldPurge: number }> {
  const orgCredentials = await runOrgScopedJob(orgId, 'credentials/prune-versions', ({ tx }) =>
    tx
      .select({ id: credentials.id, retentionCount: credentials.retentionCount })
      .from(credentials)
      .where(eq(credentials.orgId, orgId))
  )

  let versionsPurged = 0
  let versionsWouldPurge = 0

  // Short-transaction batching (F7): one credential per transaction, so purge UPDATEs
  // and audit inserts never hold row locks long enough to block concurrent reveals/add-version.
  for (const credential of orgCredentials) {
    await runOrgScopedJob(orgId, 'credentials/prune-versions', async ({ tx }) => {
      const candidates = await purgeCandidatesForCredential(
        tx,
        credential.id,
        credential.retentionCount
      )
      if (candidates.length === 0) return

      if (dryRun) {
        versionsWouldPurge += candidates.length
        if (logger) {
          for (const candidate of candidates) {
            operationalLog(
              logger,
              'info',
              OperationalEvent.CREDENTIAL_RETENTION_DRY_RUN,
              'credential retention dry-run candidate',
              {
                orgId,
                credentialId: candidate.credentialId,
                versionNumber: candidate.versionNumber,
              }
            )
          }
        }
        return
      }

      for (const candidate of candidates) {
        const purged = await purgeVersion(tx, orgId, candidate)
        if (purged) versionsPurged += 1
      }
    })
  }

  return { credentialsScanned: orgCredentials.length, versionsPurged, versionsWouldPurge }
}

type PruneOrgResult = {
  credentialsScanned: number
  versionsPurged: number
  versionsWouldPurge: number
}

// Story 22.1 fix: purgeVersion() now calls assertOrgMayWriteAudit, which throws for an org that
// is over its audit-storage quota. Without per-org isolation here, that throw would propagate out
// of pruneCredentialVersions's loop and abort the retention purge for every org processed after
// the offending one in this run — one over-quota org would silently defeat the
// security/compliance credential-retention purge for the rest of the instance. Isolate per-org
// failures the same way audit-org-usage-reconcile.ts's writeBackAllOrgs does. Returns null on
// failure so the caller can skip logging a summary for this org.
async function pruneOrgCredentialVersionsIsolated(
  orgId: string,
  dryRun: boolean,
  logger?: WorkerLogger
): Promise<PruneOrgResult | null> {
  try {
    return await pruneOrgCredentialVersions(orgId, dryRun, logger)
  } catch (error) {
    if (logger) {
      operationalLog(
        logger,
        'error',
        OperationalEvent.CREDENTIAL_RETENTION_ORG_FAILED,
        'credential retention: one org failed — continuing with the rest',
        { orgId, err: error instanceof Error ? error.message : String(error) }
      )
    }
    return null
  }
}

function logPruneOrgResult(
  orgId: string,
  dryRun: boolean,
  result: PruneOrgResult,
  logger?: WorkerLogger
): void {
  if (!logger) return
  if (dryRun) {
    operationalLog(
      logger,
      'info',
      OperationalEvent.CREDENTIAL_RETENTION_DRY_RUN,
      'credential retention dry-run summary',
      {
        orgId,
        credentialsScanned: result.credentialsScanned,
        versionsWouldPurge: result.versionsWouldPurge,
      }
    )
    return
  }
  operationalLog(
    logger,
    'info',
    OperationalEvent.CREDENTIAL_RETENTION_SUMMARY,
    'credential retention purge summary',
    {
      orgId,
      credentialsScanned: result.credentialsScanned,
      versionsPurged: result.versionsPurged,
    }
  )
}

export async function pruneCredentialVersions(logger?: WorkerLogger): Promise<void> {
  const dryRun = env.CREDENTIAL_RETENTION_DRY_RUN
  const orgIds = await fetchAllOrgIds()

  for (const orgId of orgIds) {
    const result = await pruneOrgCredentialVersionsIsolated(orgId, dryRun, logger)
    if (!result || result.credentialsScanned === 0) continue
    logPruneOrgResult(orgId, dryRun, result, logger)
  }
}
