import { describe, expect, it, beforeAll, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { adminAlerts, auditLogEntries } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'

const { initVault } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { withTestOrg, createTestUser } = await import('@project-vault/db/test-helpers')
const { isSecurityCriticalAuditEventType, shouldSuppressAuditWrite } =
  await import('./maintenance-mode.js')
const { writeHumanAuditEntry } = await import('./human-entry.js')
const { firstActorTokenIdForUser } = await import('./actor-token.js')

const CRITICAL_ALERT_TYPE = 'audit_storage.critical'
const ROUTINE_EVENT_TYPE = 'credential.value_revealed'

async function activateMaintenanceMode(): Promise<void> {
  await getDb()
    .insert(adminAlerts)
    .values({ alertType: CRITICAL_ALERT_TYPE, severity: 'critical', payload: {}, status: 'active' })
}

async function clearMaintenanceMode(): Promise<void> {
  await getDb().delete(adminAlerts).where(eq(adminAlerts.alertType, CRITICAL_ALERT_TYPE))
}

describe.sequential('Story 9.2 D10/AC-17: audit-storage maintenance-mode circuit breaker', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    try {
      await initVault({ kmsType: 'passphrase', passphrase: 'maintenance-mode-test-passphrase' }, {})
    } catch (error) {
      if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
    }
  })

  afterEach(async () => {
    await clearMaintenanceMode()
  })

  it('AC-17: security-critical event types are never in the suppressible set', () => {
    expect(isSecurityCriticalAuditEventType(AuditEvent.MFA_RECOVERY_USED)).toBe(true)
    expect(isSecurityCriticalAuditEventType(AuditEvent.MACHINE_USER_API_KEY_ROTATED)).toBe(true)
    expect(isSecurityCriticalAuditEventType(ROUTINE_EVENT_TYPE)).toBe(false)
  })

  it('AC-17/D10 code-review regression: machine-key rotation-anomaly detection (written via a direct writeMachineAuditEntry call in rotation.ts) is security-critical', () => {
    // This event is the same class as MACHINE_USER_API_KEY_ROTATED/_EMERGENCY_REVOKED (a
    // potential credential-compromise signal) and, per D10, must never be suppressed by the
    // maintenance-mode circuit breaker — it was missing from the allowlist before this fix.
    expect(
      isSecurityCriticalAuditEventType(AuditEvent.MACHINE_USER_ROTATION_ANOMALY_DETECTED)
    ).toBe(true)
  })

  it('AC-17: suppresses a routine write only while maintenance mode is active', async () => {
    await withTestOrg(async ({ orgId, tx }) => {
      expect(await shouldSuppressAuditWrite(tx, ROUTINE_EVENT_TYPE)).toBe(false)
      await activateMaintenanceMode()
      expect(await shouldSuppressAuditWrite(tx, ROUTINE_EVENT_TYPE)).toBe(true)
      // Security-critical types bypass the check entirely, even while active.
      expect(await shouldSuppressAuditWrite(tx, AuditEvent.MFA_RECOVERY_USED)).toBe(false)
      void orgId
    })
  })

  it('AC-17: writeHumanAuditEntry skips the INSERT for routine events while active, but still writes security-critical events', async () => {
    await withTestOrg(async ({ orgId, tx }) => {
      await activateMaintenanceMode()
      // check-audit-actor-token-coverage (Story 8.1 D3) permanently flags any human-actor
      // audit_log_entries row with a NULL actor_token_id — audit_log_entries is append-only, so
      // such a row can never be cleaned up. Use a real test user + identity token, not null.
      const userId = await createTestUser('maintenance-mode-critical-actor')
      const actorTokenId = await firstActorTokenIdForUser(tx, userId)

      await writeHumanAuditEntry(tx, {
        orgId,
        actorTokenId,
        eventType: ROUTINE_EVENT_TYPE,
        payload: {},
      })
      const routineRows = await tx
        .select({ id: auditLogEntries.id })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, ROUTINE_EVENT_TYPE))
      expect(routineRows).toHaveLength(0)

      await writeHumanAuditEntry(tx, {
        orgId,
        actorTokenId,
        eventType: AuditEvent.MFA_RECOVERY_USED,
        payload: {},
      })
      const criticalRows = await tx
        .select({ id: auditLogEntries.id })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, AuditEvent.MFA_RECOVERY_USED))
      expect(criticalRows.length).toBeGreaterThanOrEqual(1)
    })
  })
})
