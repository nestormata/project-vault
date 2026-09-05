import { sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { getAuditKey } from '../vault/key-service.js'
import { currentAuditKeyVersion } from './key-version.js'
import { computeAuditHmac, getPreviousEntryHmac, GENESIS_SENTINEL } from './write-entry.js'
import { assertOrgMayWriteAuditGates, estimateAuditEntrySizeBytes } from './quota-gate.js'

type RequestMeta = {
  ipAddress?: string | null
  userAgent?: string | null
}

export type MachineAuditFields = {
  orgId: string
  eventType: string
  resourceId?: string
  resourceType?: string
  payload: Record<string, unknown>
  /** Story 7.2 D5 — the machine actor's identity lives in the payload, not a new indexed column. */
  machineUserId: string
  keyId: string
  // Story 13.3 — see HumanAuditFields.revealedFields; same first-class column, populated for the
  // machine reveal route's own `?field=` support.
  revealedFields?: string[]
  meta?: RequestMeta
}

/**
 * Story 7.2 D5 — structurally identical to `writeHumanAuditEntry()` except `actorTokenId` is
 * always null and `actorType` is always `'machine_user'`. Machine users have no corresponding
 * `user_identity_tokens` row (that table only ever holds rows for human `users`, used for FR44
 * pseudonymization-on-deletion) — inventing one would misrepresent that semantics. The actor
 * identity for a machine-originated event lives in the payload (`machineUserId`/`keyId`),
 * discoverable via `payload->>'machineUserId'` for Epic 8's future audit search.
 */
export async function writeMachineAuditEntry(tx: Tx, fields: MachineAuditFields): Promise<void> {
  const payload = {
    ...fields.payload,
    machineUserId: fields.machineUserId,
    keyId: fields.keyId,
  }
  // Story 22.1 AC-13 / 22.2 AC-4 (site 2 of 9, see human-entry.ts). Size is estimated over the
  // fully-assembled payload (including machineUserId/keyId, which are folded in before the
  // insert).
  await assertOrgMayWriteAuditGates(tx, {
    orgId: fields.orgId,
    eventType: fields.eventType,
    sizeBytes: estimateAuditEntrySizeBytes({ ...fields, payload }),
  })
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${fields.orgId}, true)`)
  const keyVersion = await currentAuditKeyVersion(tx)
  const previousHmac = await getPreviousEntryHmac(tx, {
    table: 'audit_log_entries',
    orgId: fields.orgId,
  })
  const hmac = computeAuditHmac(
    {
      orgId: fields.orgId,
      actorTokenId: null,
      actorType: 'machine_user',
      eventType: fields.eventType,
      resourceId: fields.resourceId,
      resourceType: fields.resourceType,
      payload,
      keyVersion,
      previousEntryHmac: previousHmac ?? GENESIS_SENTINEL,
    },
    getAuditKey()
  )

  await tx.insert(auditLogEntries).values({
    orgId: fields.orgId,
    actorTokenId: null,
    actorType: 'machine_user',
    eventType: fields.eventType,
    resourceId: fields.resourceId,
    resourceType: fields.resourceType,
    payload,
    keyVersion,
    hmac,
    previousEntryHmac: previousHmac,
    ipAddress: fields.meta?.ipAddress ?? null,
    userAgent: fields.meta?.userAgent ?? null,
    revealedFields: fields.revealedFields ?? null,
  })
}

export type SystemAuditFields = {
  orgId: string
  eventType: string
  resourceId?: string
  resourceType?: string
  payload: Record<string, unknown>
}

/**
 * Story 7.2 D5/AC-18 — for job-initiated events with no human or machine caller (e.g. the
 * overlap-window auto-revoke job). `actorType: 'system'` is the third value the
 * `audit_log_entries` CHECK constraint already permits; `actorTokenId` is always null.
 */
export async function writeSystemAuditEntry(tx: Tx, fields: SystemAuditFields): Promise<void> {
  // Story 22.1 AC-13 / 22.2 AC-4 (site 3 of 9, see human-entry.ts).
  await assertOrgMayWriteAuditGates(tx, {
    orgId: fields.orgId,
    eventType: fields.eventType,
    sizeBytes: estimateAuditEntrySizeBytes(fields),
  })
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${fields.orgId}, true)`)
  const keyVersion = await currentAuditKeyVersion(tx)
  const previousHmac = await getPreviousEntryHmac(tx, {
    table: 'audit_log_entries',
    orgId: fields.orgId,
  })
  const hmac = computeAuditHmac(
    {
      orgId: fields.orgId,
      actorTokenId: null,
      actorType: 'system',
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
    actorTokenId: null,
    actorType: 'system',
    eventType: fields.eventType,
    resourceId: fields.resourceId,
    resourceType: fields.resourceType,
    payload: fields.payload,
    keyVersion,
    hmac,
    previousEntryHmac: previousHmac,
    ipAddress: null,
    userAgent: null,
  })
}
