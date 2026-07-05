import type { Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { currentAuditKeyVersion } from '../modules/audit/key-version.js'
import { computeAuditHmac } from '../modules/audit/write-entry.js'
import { getAuditKey } from '../modules/vault/key-service.js'

/** Manual system-actor audit write — `computeAuditHmac` + direct `auditLogEntries` insert,
 *  `actorTokenId: null, actorType: 'system'` — for background-job-initiated events that have no
 *  human `actorUserId` (so `writeHumanAuditEntryOrFailClosed` doesn't apply). Copied verbatim
 *  from `check-failed-auth-threshold.ts`'s original `insertAuditRow()` pattern and shared here so
 *  every system-actor job (break-glass overlap-expiry, stale-rotation recovery, ...) writes this
 *  shape identically. */
export async function writeSystemActorAuditRow(
  tx: Tx,
  input: { orgId: string; eventType: string; payload: Record<string, unknown> }
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
    payload: input.payload,
    keyVersion,
    hmac,
  })
}
