import type { Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { currentAuditKeyVersion } from '../modules/audit/key-version.js'
import { computeAuditHmac } from '../modules/audit/write-entry.js'
import {
  assertOrgMayWriteAudit,
  assertOrgMayWriteAuditAtRate,
  estimateAuditEntrySizeBytes,
} from '../modules/audit/quota-gate.js'
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
  // Story 22.1 AC-13/AC-13's "RLS context" edge — this helper sets no org RLS context of its own
  // (its ~10 callers, including extensions/loader.ts's injected per-org writer for loaded module
  // packs, provide the org context via their own transaction), so the gate takes orgId explicitly
  // rather than reading current_setting('app.current_org_id').
  // Story 22.2 AC-4 (site 5 of 9): rate gate first, then storage gate (documented ordering).
  await assertOrgMayWriteAuditAtRate(tx, { orgId: input.orgId, eventType: input.eventType })
  await assertOrgMayWriteAudit(tx, {
    orgId: input.orgId,
    eventType: input.eventType,
    sizeBytes: estimateAuditEntrySizeBytes(input),
  })
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
