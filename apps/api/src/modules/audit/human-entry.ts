import { sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { getAuditKey } from '../vault/key-service.js'
import { currentAuditKeyVersion } from './key-version.js'
import { computeAuditHmac } from './write-entry.js'
import { logAuditWriteSuspended, shouldSuppressAuditWrite } from './maintenance-mode.js'

type RequestMeta = {
  ipAddress?: string | null
  userAgent?: string | null
}

export type HumanAuditFields = {
  orgId: string
  actorTokenId: string | null
  eventType: string
  resourceId?: string
  resourceType?: string
  payload: Record<string, unknown>
  meta?: RequestMeta
}

export async function writeHumanAuditEntry(tx: Tx, fields: HumanAuditFields): Promise<void> {
  // Story 9.2 AC-17/D10: audit-storage maintenance-mode circuit breaker — checked before the
  // set_config/INSERT, event-type membership first (security-critical types bypass entirely).
  if (await shouldSuppressAuditWrite(tx, fields.eventType)) {
    logAuditWriteSuspended(fields.eventType, fields.orgId)
    return
  }
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${fields.orgId}, true)`)
  const keyVersion = await currentAuditKeyVersion(tx)
  const hmac = computeAuditHmac(
    {
      orgId: fields.orgId,
      actorTokenId: fields.actorTokenId,
      actorType: 'human',
      eventType: fields.eventType,
      resourceId: fields.resourceId,
      resourceType: fields.resourceType,
      payload: fields.payload,
      keyVersion,
    },
    getAuditKey()
  )

  await tx.insert(auditLogEntries).values({
    orgId: fields.orgId,
    actorTokenId: fields.actorTokenId,
    actorType: 'human',
    eventType: fields.eventType,
    resourceId: fields.resourceId,
    resourceType: fields.resourceType,
    payload: fields.payload,
    keyVersion,
    hmac,
    ipAddress: fields.meta?.ipAddress ?? null,
    userAgent: fields.meta?.userAgent ?? null,
  })
}
