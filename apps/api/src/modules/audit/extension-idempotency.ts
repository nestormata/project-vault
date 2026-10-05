import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditLogEntries, extensionAuditIdempotencyKeys } from '@project-vault/db/schema'
import { writeExtensionAuditEntry, type ExtensionAuditFields } from './extension-entry.js'
import { attributionFingerprintPart, type PvAttribution } from './extension-attribution.js'
import { estimateAuditEntrySizeBytes } from './quota-gate.js'

/**
 * Story 71.1 — idempotent `AuditEventSourceHost.writeAuditEvent({ idempotencyKey })`. This sibling
 * helper owns the dedupe logic so `extension-entry.ts` (the plain, keyless insert) is untouched:
 * a call that omits the key never reaches this module and behaves byte-identically to before.
 */

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Story 71.1 AC-7b — upper bound on the estimated size of a KEYED call, enforced before the lock,
 * the lookup and the fingerprint. A replay skips the rate/storage gates (AC-7), so without a bound
 * it could become a free CPU/bandwidth channel. The estimate is the same one the storage gate
 * uses (`estimateAuditEntrySizeBytes`). Applies to keyed calls only.
 */
export const MAX_IDEMPOTENT_AUDIT_ENTRY_BYTES = 1_048_576

/** Story 71.1 AC-1 — thrown before any transaction when `idempotencyKey` is not a valid key. */
export class ExtensionAuditIdempotencyKeyInvalidError extends Error {
  constructor() {
    // Never echoes the rejected value: it may be an attacker- or secret-shaped string.
    super(`idempotencyKey must be a string matching ${IDEMPOTENCY_KEY_PATTERN.source}`)
    this.name = 'ExtensionAuditIdempotencyKeyInvalidError'
  }
}

/**
 * Story 71.1 AC-3 — the key was already used with different content. Non-retryable, carries no
 * stored content (not even the stored fingerprint), never acknowledges the write.
 */
export class ExtensionAuditIdempotencyConflictError extends Error {
  readonly retryable = false
  constructor() {
    super('idempotencyKey was already used with different event content')
    this.name = 'ExtensionAuditIdempotencyConflictError'
  }
}

/** Story 71.1 AC-7b — a keyed call whose estimated entry size exceeds the fixed ceiling. */
export class ExtensionAuditIdempotencyPayloadTooLargeError extends Error {
  constructor() {
    super(
      `audit event with an idempotencyKey exceeds the ${MAX_IDEMPOTENT_AUDIT_ENTRY_BYTES}-byte size limit`
    )
    this.name = 'ExtensionAuditIdempotencyPayloadTooLargeError'
  }
}

/**
 * Internal only: the key-row insert lost a race the advisory lock should have prevented (defence in
 * depth). Throwing rolls the whole transaction back, including the audit row just inserted, so the
 * caller retries once on a fresh transaction and takes the replay path.
 */
export class ExtensionAuditIdempotencyRaceError extends Error {
  constructor() {
    super('idempotency key row already existed at insert time')
    this.name = 'ExtensionAuditIdempotencyRaceError'
  }
}

export function assertValidIdempotencyKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ExtensionAuditIdempotencyKeyInvalidError()
  }
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Canonical JSON: object keys sorted recursively (code-unit order), array order preserved, an
 * `undefined` property treated as absent (so `{a: undefined}` equals `{}`), `null` kept distinct
 * from absent. Values with `toJSON` (Date) are canonicalised through it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  const withToJson = value as { toJSON?: () => unknown }
  if (typeof withToJson.toJSON === 'function') return canonicalJson(withToJson.toJSON())
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
  return `{${entries.join(',')}}`
}

export type IdempotentAuditContent = {
  eventType: string
  resourceType?: string
  resourceId?: string
  projectId?: string
  /** The caller payload, BEFORE the host folds `extensionName` into it. */
  payload: Record<string, unknown>
  /**
   * Story 71.4 — the resolved attribution; only its effective time and actor (provider, subject,
   * attestation) enter the fingerprint, never `delegatedBy`, the assertion id, the kid, the reason
   * or the user id, so a retry with a fresh assertion still replays. Absent attribution leaves the
   * fingerprint exactly as it was before 71.4.
   */
  attribution?: PvAttribution
}

/** Story 71.1 AC-3 — sha256 over the canonical JSON of the caller-supplied content. */
export function computeContentFingerprint(content: IdempotentAuditContent): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        eventType: content.eventType,
        resourceType: content.resourceType,
        resourceId: content.resourceId,
        projectId: content.projectId,
        payload: content.payload,
        attribution: attributionFingerprintPart(content.attribution),
      })
    )
    .digest('hex')
}

export type IdempotentExtensionAuditFields = ExtensionAuditFields & {
  idempotencyKey: string
  projectId?: string
}

export type IdempotentAuditReceipt = { id: string; createdAt: Date; deduped: boolean }

/**
 * Story 71.1 AC-2/AC-3/AC-7. Runs inside the caller's `withOrg` transaction (READ COMMITTED):
 *
 * 1. size bound (AC-7b), then the content fingerprint;
 * 2. a transaction-scoped advisory lock over a hash of org + extension + key — a second writer
 *    blocks here until the first commits, so its lookup then sees the first writer's key row;
 * 3. lookup: found → identical fingerprint returns the ORIGINAL receipt (no gates, no row, no
 *    chain advance — AC-7), a different one throws the typed conflict;
 * 4. not found → the existing keyless insert (gates included), then the key row in the same
 *    transaction. The composite primary key is the backstop if the lock were ever bypassed.
 *
 * Stores the fingerprint only, never the payload.
 */
export async function writeIdempotentExtensionAuditEntry(
  tx: Tx,
  fields: IdempotentExtensionAuditFields
): Promise<IdempotentAuditReceipt> {
  const { idempotencyKey, projectId, ...auditFields } = fields
  if (
    estimateAuditEntrySizeBytes({
      payload: fields.payload,
      resourceId: fields.resourceId,
      resourceType: fields.resourceType,
    }) > MAX_IDEMPOTENT_AUDIT_ENTRY_BYTES
  ) {
    throw new ExtensionAuditIdempotencyPayloadTooLargeError()
  }
  const fingerprint = computeContentFingerprint({
    eventType: fields.eventType,
    resourceType: fields.resourceType,
    resourceId: fields.resourceId,
    projectId,
    payload: fields.payload,
    attribution: fields.attribution,
  })

  const lockInput = JSON.stringify([fields.orgId, fields.extensionName, idempotencyKey])
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockInput}, 0))`)

  const [existing] = await tx
    .select({
      fingerprint: extensionAuditIdempotencyKeys.contentFingerprint,
      auditId: auditLogEntries.id,
      createdAt: auditLogEntries.createdAt,
    })
    .from(extensionAuditIdempotencyKeys)
    .leftJoin(auditLogEntries, eq(auditLogEntries.id, extensionAuditIdempotencyKeys.auditEntryId))
    .where(
      and(
        eq(extensionAuditIdempotencyKeys.orgId, fields.orgId),
        eq(extensionAuditIdempotencyKeys.extensionName, fields.extensionName),
        eq(extensionAuditIdempotencyKeys.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1)

  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new ExtensionAuditIdempotencyConflictError()
    // The FK makes a missing audit row impossible; never fabricate a receipt if it ever happens.
    if (existing.auditId === null || existing.createdAt === null) {
      throw new Error('idempotency key row found but its audit row is missing')
    }
    return { id: existing.auditId, createdAt: existing.createdAt, deduped: true }
  }

  const row = await writeExtensionAuditEntry(tx, auditFields)
  const inserted = await tx
    .insert(extensionAuditIdempotencyKeys)
    .values({
      orgId: fields.orgId,
      extensionName: fields.extensionName,
      idempotencyKey,
      contentFingerprint: fingerprint,
      auditEntryId: row.id,
    })
    .onConflictDoNothing()
    .returning({ orgId: extensionAuditIdempotencyKeys.orgId })
  if (inserted.length === 0) throw new ExtensionAuditIdempotencyRaceError()
  return { id: row.id, createdAt: row.createdAt, deduped: false }
}
