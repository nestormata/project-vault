import { sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { getAuditKey } from '../vault/key-service.js'
import { currentAuditKeyVersion } from './key-version.js'
import { computeAuditHmac } from './write-entry.js'
import { assertOrgMayWriteAuditGates, estimateAuditEntrySizeBytes } from './quota-gate.js'

export type ExtensionAuditFields = {
  orgId: string
  eventType: string
  resourceId?: string
  resourceType?: string
  payload: Record<string, unknown>
  /** Story 23.8 AC-11 — the loaded extension's own `manifest.name`, folded into `payload` before
   * the insert (never a new column) — same precedent as `machine-entry.ts`'s `machineUserId`. */
  extensionName: string
}

/**
 * Story 23.8 AC-7/AC-9/AC-11/AC-12/AC-13 — structurally identical to `writeHumanAuditEntry()` /
 * `writeMachineAuditEntry()` except `actorType` is always `'extension'` and `actorTokenId` is
 * always `null` (AC-2's edge case — extension-side human actors have no corresponding
 * `user_identity_tokens` row). `revealedFields`/`ipAddress`/`userAgent` are always `null` — none
 * of them are meaningful for an in-process extension call (AC-12).
 *
 * Unlike the other three write helpers, this one returns the real inserted row's `id`/`createdAt`
 * (a `RETURNING` clause) — the extension needs a durable receipt per `AuditEventSourceWriteResult`
 * (AC-7's edge case).
 */
export async function writeExtensionAuditEntry(
  tx: Tx,
  fields: ExtensionAuditFields
): Promise<{ id: string; createdAt: Date }> {
  // AC-11 edge case: the host-assigned extensionName always wins over any caller-supplied
  // payload.extensionName — spread order, host key last.
  const payload = {
    ...fields.payload,
    extensionName: fields.extensionName,
  }

  // Story 22.1 AC-13 / Story 22.2 AC-4 (see human-entry.ts). Size is estimated over the
  // fully-assembled payload (including extensionName, folded in before the insert) — same
  // precedent as writeMachineAuditEntry(). Rebased onto 22-2's write-rate limiting (2026-08-17):
  // extension-authored rows now go through the same combined rate-then-storage gate as every
  // other of the nine insert sites, rather than the storage-only gate this story originally used.
  await assertOrgMayWriteAuditGates(tx, {
    orgId: fields.orgId,
    eventType: fields.eventType,
    sizeBytes: estimateAuditEntrySizeBytes({ ...fields, payload }),
  })
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${fields.orgId}, true)`)
  const keyVersion = await currentAuditKeyVersion(tx)
  const hmac = computeAuditHmac(
    {
      orgId: fields.orgId,
      actorTokenId: null,
      actorType: 'extension',
      eventType: fields.eventType,
      resourceId: fields.resourceId,
      resourceType: fields.resourceType,
      payload,
      keyVersion,
    },
    getAuditKey()
  )

  const [row] = await tx
    .insert(auditLogEntries)
    .values({
      orgId: fields.orgId,
      actorTokenId: null,
      actorType: 'extension',
      eventType: fields.eventType,
      resourceId: fields.resourceId,
      resourceType: fields.resourceType,
      payload,
      keyVersion,
      hmac,
      ipAddress: null,
      userAgent: null,
      revealedFields: null,
    })
    .returning({ id: auditLogEntries.id, createdAt: auditLogEntries.createdAt })

  if (!row) {
    throw new Error('writeExtensionAuditEntry: insert did not return a row')
  }

  return { id: row.id, createdAt: row.createdAt }
}
