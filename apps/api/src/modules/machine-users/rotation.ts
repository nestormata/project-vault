import { and, eq, isNotNull } from 'drizzle-orm'
import { withOrg, type Tx } from '@project-vault/db'
import { AuditEvent } from '@project-vault/shared'
import { apiKeys } from '@project-vault/db/schema'
import { writeMachineAuditEntry } from '../audit/machine-entry.js'
import { createOrgAdminNotificationEntries } from '../../notifications/dispatcher.js'
import { generateApiKey, hashApiKey } from './tokens.js'

type ApiKeyRow = typeof apiKeys.$inferSelect

/**
 * Story 7.2 AC-26 — row-locks the key via `SELECT ... FOR UPDATE` at the start of both the
 * rotate and emergency-revoke transactions, closing the TOCTOU window between two concurrent
 * calls on the same key (matching Story 4.4's row-lock precedent for its own TOCTOU closure). A
 * second concurrent transaction blocks until the first commits, then re-reads the just-committed
 * row via this same function — so its caller always sees the post-rotation/post-revoke state.
 */
export async function lockApiKeyForUpdate(
  tx: Tx,
  params: { machineUserId: string; keyId: string }
): Promise<ApiKeyRow | null> {
  const rows = await tx
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, params.keyId), eq(apiKeys.machineUserId, params.machineUserId)))
    .for('update')
    .limit(1)
  return rows[0] ?? null
}

export type RotateApiKeyResult = {
  newKeyId: string
  plaintext: string
  overlapExpiresAt: Date
}

/**
 * Story 7.2 AC-16/D8 — zero-downtime rotation: inserts a new key (`rotatedFromKeyId` pointing at
 * the old key) and sets the OLD key's `overlapExpiresAt` — the old key's `revokedAt` stays null
 * for the duration of the overlap window, so both keys independently succeed against the
 * token-exchange endpoint until the auto-revoke job (AC-18) catches up.
 */
export async function rotateApiKey(
  tx: Tx,
  params: { orgId: string; machineUserId: string; oldKey: ApiKeyRow; overlapMinutes: number }
): Promise<RotateApiKeyResult> {
  const plaintext = generateApiKey()
  const keyHash = hashApiKey(plaintext)
  const overlapExpiresAt = new Date(Date.now() + params.overlapMinutes * 60_000)

  const [newKey] = await tx
    .insert(apiKeys)
    .values({
      orgId: params.orgId,
      machineUserId: params.machineUserId,
      name: params.oldKey.name,
      keyHash,
      hmacKeyVersion: 1,
      rotatedFromKeyId: params.oldKey.id,
    })
    .returning({ id: apiKeys.id })
  if (!newKey) throw new Error('rotateApiKey: new key insert returned no row')

  await tx.update(apiKeys).set({ overlapExpiresAt }).where(eq(apiKeys.id, params.oldKey.id))

  return { newKeyId: newKey.id, plaintext, overlapExpiresAt }
}

export type EmergencyRevokeResult = {
  newKeyId: string
  plaintext: string
}

/**
 * Story 7.2 AC-20 — atomic revoke-old + issue-new in one transaction, no overlap window
 * whatsoever (the defining behavioral difference from `rotateApiKey`): the old key's `revokedAt`
 * is set immediately, and the new key's `overlapExpiresAt` stays null since there is no overlap
 * to track.
 */
export async function emergencyRevokeApiKey(
  tx: Tx,
  params: { orgId: string; machineUserId: string; oldKey: ApiKeyRow }
): Promise<EmergencyRevokeResult> {
  const plaintext = generateApiKey()
  const keyHash = hashApiKey(plaintext)

  await tx.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, params.oldKey.id))

  const [newKey] = await tx
    .insert(apiKeys)
    .values({
      orgId: params.orgId,
      machineUserId: params.machineUserId,
      name: params.oldKey.name,
      keyHash,
      hmacKeyVersion: 1,
      rotatedFromKeyId: params.oldKey.id,
      overlapExpiresAt: null,
    })
    .returning({ id: apiKeys.id })
  if (!newKey) throw new Error('emergencyRevokeApiKey: new key insert returned no row')

  return { newKeyId: newKey.id, plaintext }
}

/**
 * Story 7.2 AC-19/D10 — called immediately after updating the OLD key's `lastUsedAt` on a
 * successful token exchange (Task 3). Detects "old key used after its successor was already
 * adopted elsewhere" — the `last_used_at IS NOT NULL` condition on the NEW key is exactly what
 * distinguishes this from ordinary overlap-window usage (new key not yet adopted, no alert).
 * Purely detective, never blocking: any failure here (including a missing notification-routing
 * config) must never fail the token exchange itself, so callers should wrap this in try/catch
 * and swallow errors after logging.
 *
 * Fires `security.anomalous_access` (D10, the alert type reserved but unused until this story)
 * via `createOrgAdminNotificationEntries` and writes a `machine_user.rotation_anomaly_detected`
 * audit row (actorType: machine_user) — both inside the same org-scoped transaction as the
 * lastUsedAt caller passes in. Does not call `sendNotificationJobs()` itself (no reliable
 * `BossService` handle exists in the machine-token-exchange request context) — the queued
 * notification row is durably picked up by the existing `notification:*-catchup` jobs.
 */
export async function checkRotationAnomaly(
  orgId: string,
  params: { oldKeyId: string; machineUserId: string; usedAt: Date }
): Promise<void> {
  await withOrg(orgId, async (tx) => {
    const [supersededBy] = await tx
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.rotatedFromKeyId, params.oldKeyId), isNotNull(apiKeys.lastUsedAt)))
      .limit(1)
    if (!supersededBy) return

    await createOrgAdminNotificationEntries({
      orgId,
      tx,
      template: {
        templateId: 'security.anomalous_access',
        severity: 'warning',
        payload: {
          oldKeyId: params.oldKeyId,
          newKeyId: supersededBy.id,
          machineUserId: params.machineUserId,
          usedAt: params.usedAt.toISOString(),
        },
      },
    })

    await writeMachineAuditEntry(tx, {
      orgId,
      eventType: AuditEvent.MACHINE_USER_ROTATION_ANOMALY_DETECTED,
      resourceType: 'api_key',
      resourceId: params.oldKeyId,
      machineUserId: params.machineUserId,
      keyId: params.oldKeyId,
      payload: { oldKeyId: params.oldKeyId, newKeyId: supersededBy.id },
    })
  })
}
