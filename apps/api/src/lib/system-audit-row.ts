import type { Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { currentAuditKeyVersion } from '../modules/audit/key-version.js'
import { computeAuditHmac } from '../modules/audit/write-entry.js'
import { getAuditKey } from '../modules/vault/key-service.js'

/**
 * Writes a system-initiated (`actorTokenId: null`, `actorType: 'system'`) audit row inside the
 * caller's transaction — shared by every background job that fires an alert with no human actor
 * (check-failed-auth-threshold.ts, check-anomalous-access.ts, monitoring-health-check.ts).
 * Mirrors `writeHumanAuditEntryOrFailClosed`'s HMAC/key-version handling for the human-actor case.
 */
export async function writeSystemAuditRow(
  tx: Tx,
  input: {
    orgId: string
    eventType: string
    resourceId?: string
    payload: Record<string, unknown>
  }
): Promise<void> {
  const keyVersion = await currentAuditKeyVersion(tx)
  const hmac = computeAuditHmac(
    {
      orgId: input.orgId,
      actorTokenId: null,
      actorType: 'system',
      eventType: input.eventType,
      payload: input.payload,
      keyVersion,
    },
    getAuditKey()
  )
  await tx.insert(auditLogEntries).values({
    orgId: input.orgId,
    actorTokenId: null,
    actorType: 'system',
    eventType: input.eventType,
    resourceId: input.resourceId,
    payload: input.payload,
    keyVersion,
    hmac,
  })
}
