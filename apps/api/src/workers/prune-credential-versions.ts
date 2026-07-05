import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditLogEntries, credentialVersions, credentials } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyBaseLogger } from 'fastify'
import { env } from '../config/env.js'
import { operationalLog } from '../lib/logger.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { currentAuditKeyVersion } from '../modules/audit/key-version.js'
import { computeAuditHmac } from '../modules/audit/write-entry.js'
import { getAuditKey } from '../modules/vault/key-service.js'

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

  // Zero-overwrite then null: defense-in-depth/intent-signaling, not byte-level erasure
  // under PostgreSQL MVCC (see AC-8 MVCC caveat) — true shredding is key destruction at
  // master-key rotation (Epic 5+).
  await tx
    .update(credentialVersions)
    .set({
      encryptedValue: {
        version: 1,
        iv: '0'.repeat(24),
        ciphertext: '0'.repeat(64),
        tag: '0'.repeat(32),
      },
    })
    .where(eq(credentialVersions.id, candidate.id))
  await tx
    .update(credentialVersions)
    .set({ encryptedValue: null, keyVersion: null, purgedAt: new Date() })
    .where(eq(credentialVersions.id, candidate.id))

  const payload = { credentialId: candidate.credentialId, versionNumber: candidate.versionNumber }
  const keyVersion = await currentAuditKeyVersion(tx)
  const hmac = computeAuditHmac(
    {
      orgId,
      actorTokenId: null,
      actorType: 'system',
      eventType: 'credential.version_purged',
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
    eventType: 'credential.version_purged',
    resourceId: candidate.credentialId,
    resourceType: 'credential',
    payload,
    keyVersion,
    hmac,
  })
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

export async function pruneCredentialVersions(logger?: WorkerLogger): Promise<void> {
  const dryRun = env.CREDENTIAL_RETENTION_DRY_RUN
  const orgIds = await fetchAllOrgIds()

  for (const orgId of orgIds) {
    const result = await pruneOrgCredentialVersions(orgId, dryRun, logger)
    if (result.credentialsScanned === 0) continue

    if (dryRun) {
      if (logger) {
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
      }
    } else if (logger) {
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
  }
}
