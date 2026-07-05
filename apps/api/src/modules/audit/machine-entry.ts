import { sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { getAuditKey } from '../vault/key-service.js'
import { currentAuditKeyVersion } from './key-version.js'
import { computeAuditHmac } from './write-entry.js'

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
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${fields.orgId}, true)`)
  const keyVersion = await currentAuditKeyVersion(tx)
  const payload = {
    ...fields.payload,
    machineUserId: fields.machineUserId,
    keyId: fields.keyId,
  }
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
    ipAddress: fields.meta?.ipAddress ?? null,
    userAgent: fields.meta?.userAgent ?? null,
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
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${fields.orgId}, true)`)
  const keyVersion = await currentAuditKeyVersion(tx)
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
    ipAddress: null,
    userAgent: null,
  })
}
