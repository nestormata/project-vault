import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, securityAlerts, userIdentityTokens } from '@project-vault/db/schema'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { withExpiryAlertTestOrg } from './expiry-alert-test-helpers.js'
import { runAnomalousAccessCheck } from './check-anomalous-access.js'

const ALERT_TYPE = 'security.anomalous_access'
const CREDENTIAL_REVEAL_EVENT = 'credential.value_revealed'

async function seedActorToken(orgId: string, ownerId: string): Promise<string> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(userIdentityTokens)
      .values({ userId: ownerId, displayName: 'test-actor' })
      .returning({ id: userIdentityTokens.id })
  )
  if (!row) throw new Error('expected identity token to be inserted')
  return row.id
}

async function seedRevealEvents(
  orgId: string,
  actorTokenId: string,
  count: number
): Promise<string[]> {
  const credentialIds = Array.from({ length: count }, () => randomUUID())
  await withOrg(orgId, (tx) =>
    tx.insert(auditLogEntries).values(
      credentialIds.map((credentialId) => ({
        orgId,
        actorTokenId,
        actorType: 'human' as const,
        eventType: CREDENTIAL_REVEAL_EVENT,
        resourceId: credentialId,
        resourceType: 'credential',
        payload: {},
        keyVersion: 1,
        hmac: 'test-hmac',
      }))
    )
  )
  return credentialIds
}

async function alertsFor(orgId: string) {
  return withOrg(orgId, (tx) =>
    tx.select().from(securityAlerts).where(eq(securityAlerts.alertType, ALERT_TYPE))
  )
}

async function systemAuditRowsFor(orgId: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select()
      .from(auditLogEntries)
      .where(and(eq(auditLogEntries.orgId, orgId), eq(auditLogEntries.eventType, ALERT_TYPE)))
  )
}

beforeAll(async () => {
  configureAuthIntegrationEnv()
  await resetVaultForTest()
  const { initVault } = await import('../modules/vault/key-service.js')
  await initVaultForTest(initVault, 'check-anomalous-access-test-passphrase')
})

afterAll(async () => {
  await resetVaultForTest()
})

describe('check-anomalous-access worker (AC 11-12, ADR-6.2-06)', () => {
  it('creates a critical security_alerts row once the threshold (default 5) is reached', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('anomalous-access-threshold', async ({ orgId, ownerId }) => {
      const actorTokenId = await seedActorToken(orgId, ownerId)
      await seedRevealEvents(orgId, actorTokenId, 6)

      await runAnomalousAccessCheck(boss)

      const alerts = await alertsFor(orgId)
      expect(alerts).toHaveLength(1)
      expect(alerts[0]).toMatchObject({ alertType: ALERT_TYPE, severity: 'critical' })
      const payload = alerts[0]?.payload as Record<string, unknown>
      expect(payload['revealedCount']).toBeGreaterThanOrEqual(6)
      expect(Array.isArray(payload['revealedCredentialIds'])).toBe(true)
      expect((payload['revealedCredentialIds'] as unknown[]).length).toBeGreaterThan(0)

      const systemAuditRows = await systemAuditRowsFor(orgId)
      expect(systemAuditRows).toHaveLength(1)
      expect(systemAuditRows[0]).toMatchObject({ actorType: 'system', actorTokenId: null })
    })
  }, 20_000)

  it('does not fire below the threshold', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('anomalous-access-below', async ({ orgId, ownerId }) => {
      const actorTokenId = await seedActorToken(orgId, ownerId)
      await seedRevealEvents(orgId, actorTokenId, 3)

      await runAnomalousAccessCheck(boss)

      expect(await alertsFor(orgId)).toHaveLength(0)
    })
  }, 20_000)

  it('does not create a second alert for the same actor within the same window (dedup)', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('anomalous-access-dedup', async ({ orgId, ownerId }) => {
      const actorTokenId = await seedActorToken(orgId, ownerId)
      await seedRevealEvents(orgId, actorTokenId, 6)

      await runAnomalousAccessCheck(boss)
      await seedRevealEvents(orgId, actorTokenId, 2) // more reveals, same actor, same window
      await runAnomalousAccessCheck(boss)

      expect(await alertsFor(orgId)).toHaveLength(1)
    })
  }, 20_000)

  it('caps revealedCredentialIds at 50 (adversarial-review finding 9)', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('anomalous-access-cap', async ({ orgId, ownerId }) => {
      const actorTokenId = await seedActorToken(orgId, ownerId)
      await seedRevealEvents(orgId, actorTokenId, 60)

      await runAnomalousAccessCheck(boss)

      const alerts = await alertsFor(orgId)
      const payload = alerts[0]?.payload as Record<string, unknown>
      expect((payload['revealedCredentialIds'] as unknown[]).length).toBeLessThanOrEqual(50)
      expect(payload['revealedCount']).toBeGreaterThanOrEqual(60)
    })
  }, 20_000)

  it('attributes breaches per-org: two orgs each get their own scoped alert', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg(
      'anomalous-access-org-a',
      async ({ orgId: orgAId, ownerId: ownerAId }) => {
        await withExpiryAlertTestOrg(
          'anomalous-access-org-b',
          async ({ orgId: orgBId, ownerId: ownerBId }) => {
            const actorA = await seedActorToken(orgAId, ownerAId)
            const actorB = await seedActorToken(orgBId, ownerBId)
            await seedRevealEvents(orgAId, actorA, 6)
            await seedRevealEvents(orgBId, actorB, 7)

            await runAnomalousAccessCheck(boss)

            const alertsA = await alertsFor(orgAId)
            const alertsB = await alertsFor(orgBId)
            expect(alertsA).toHaveLength(1)
            expect(alertsB).toHaveLength(1)
          }
        )
      }
    )
  }, 20_000)
})
