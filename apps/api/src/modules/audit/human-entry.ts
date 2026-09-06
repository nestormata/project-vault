import { sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { getAuditKey } from '../vault/key-service.js'
import { computeAuditHmac, readAuditChainHead, GENESIS_SENTINEL } from './write-entry.js'
import { assertOrgMayWriteAuditGates, estimateAuditEntrySizeBytes } from './quota-gate.js'

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
  // Story 13.3 — which field key(s) a CREDENTIAL_VALUE_REVEALED event actually revealed, as a
  // first-class `audit_log_entries.revealed_fields` column, separate from `payload`'s per-event
  // shape. Undefined/omitted for any non-reveal event or a legacy whole-secret reveal (column
  // stays NULL, never `[]`).
  revealedFields?: string[]
  meta?: RequestMeta
}

export async function writeHumanAuditEntry(tx: Tx, fields: HumanAuditFields): Promise<void> {
  // Story 22.1 AC-13 / 22.2 AC-4 (site 1 of 9): gate immediately before the INSERT, inside the
  // caller's transaction. Throws SameTransactionAuditWriteError on refusal — there is no "skip
  // this write" return value.
  await assertOrgMayWriteAuditGates(tx, {
    orgId: fields.orgId,
    eventType: fields.eventType,
    sizeBytes: estimateAuditEntrySizeBytes(fields),
  })
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${fields.orgId}, true)`)
  // Story 1.25 AC-2: the advisory lock + previous-row read happen inside this same transaction,
  // before the insert, so no concurrent writer for this org can observe (or extend past) the
  // same "previous row" between this read and the insert below.
  const { keyVersion, previousEntryHmac: previousHmac } = await readAuditChainHead(tx, fields.orgId)
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
      previousEntryHmac: previousHmac ?? GENESIS_SENTINEL,
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
    // Story 1.25 AC-2: the ACTUAL previous row's hmac (or null for genesis) — never the sentinel
    // above, which exists only inside the HMAC digest input.
    previousEntryHmac: previousHmac,
    ipAddress: fields.meta?.ipAddress ?? null,
    userAgent: fields.meta?.userAgent ?? null,
    revealedFields: fields.revealedFields ?? null,
  })
}
