import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import nodemailer from 'nodemailer'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { createTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import type { DeliveryProvider } from '@project-vault/extension-api'
import { getNotificationQueueEntry } from '../__tests__/helpers/notification-test-helpers.js'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import {
  __resetDeliveryProvidersForTests,
  wireExtensionDeliveryProvider,
} from '../lib/delivery-provider.js'
import type { ExtensionState } from '../extensions/loader.js'
import {
  resetEmailTransportForTesting,
  sendEmailNotification,
  setEmailTransportForTesting,
} from './notification-email.js'

configureAuthIntegrationEnv()

function loadedStateWith(deliveryProvider: Record<string, DeliveryProvider>): ExtensionState {
  return {
    status: 'loaded',
    manifest: { name: 'com.acme.test-extension', apiVersion: '3.11.0', capabilities: [] },
    loadedAt: new Date().toISOString(),
    hooks: { deliveryProvider },
  }
}

async function seedEmailQueueEntry(orgId: string, recipientEmail: string): Promise<string> {
  const [entry] = await withOrg(orgId, (tx) =>
    tx
      .insert(notificationQueue)
      .values({
        orgId,
        recipientEmail,
        channel: 'email',
        templateId: 'security.failed_auth_threshold',
        payload: {
          thresholdType: 'ip',
          thresholdCount: 10,
          windowSeconds: 300,
          attemptCount: 10,
          windowStart: new Date().toISOString(),
          windowEnd: new Date().toISOString(),
          ipAddress: '203.0.113.1',
        },
        status: 'pending',
      })
      .returning({ id: notificationQueue.id })
  )
  if (!entry) throw new Error('expected queue entry')
  return entry.id
}

describe('sendEmailNotification — Story 20.11 AC1 DeliveryProvider dispatch', () => {
  beforeAll(async () => {
    // The provider-backed send path records the transition via applyDeliveryStatusUpdate(),
    // which writes a same-transaction audit entry (AC5) needing a real (unsealed) vault.
    await resetVaultForTest()
    const { initVault } = await import('../modules/vault/key-service.js')
    await initVaultForTest(initVault, 'notification-email-delivery-provider-vault-secret')
  })

  beforeEach(() => {
    __resetDeliveryProvidersForTests()
  })

  afterEach(() => {
    __resetDeliveryProvidersForTests()
    resetEmailTransportForTesting()
  })

  it('calls the registered DeliveryProvider instead of nodemailer and records providerId/providerMessageId, status sent', async () => {
    // A configured nodemailer transport is deliberately present too, to prove the provider path
    // is chosen INSTEAD of it, not merely because no SMTP transport is configured. The
    // providerMessageId is unique per test run (not a fixed literal) — it is recorded under a
    // real unique index (AC9) that is not scoped by test org, so a fixed literal could collide
    // with a leftover row from an earlier run whose test-org cleanup hit an unrelated FK
    // violation (packages/db/src/test-helpers.ts's cleanupTestOrg swallows FK violations).
    setEmailTransportForTesting(nodemailer.createTransport({ jsonTransport: true }))
    const providerMessageId = `provider-msg-${randomUUID()}`
    const send = vi.fn().mockResolvedValue({ providerMessageId })
    const provider: DeliveryProvider = {
      send,
      verifyWebhookSignature: () => true,
      parseWebhookEvents: () => [],
    }
    wireExtensionDeliveryProvider(loadedStateWith({ email: provider }))

    await createTestUser('delivery-provider-dispatch')
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailQueueEntry(orgId, 'recipient@example.com')

      await sendEmailNotification(queueId, orgId)

      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientAddress: 'recipient@example.com',
          queueRowId: queueId,
          templateId: 'security.failed_auth_threshold',
        })
      )

      const entry = await getNotificationQueueEntry(orgId, queueId)
      expect(entry?.status).toBe('sent')
      expect(entry?.providerId).toBe('email')
      expect(entry?.providerMessageId).toBe(providerMessageId)
    })
  })

  it('falls back to nodemailer unchanged when no DeliveryProvider is registered for the channel (AC1 positive/AC8)', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    setEmailTransportForTesting(transport)

    await createTestUser('delivery-provider-fallback')
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailQueueEntry(orgId, 'recipient2@example.com')

      await sendEmailNotification(queueId, orgId)

      const entry = await getNotificationQueueEntry(orgId, queueId)
      expect(entry?.status).toBe('delivered')
      expect(entry?.providerId).toBeNull()
    })
  })

  it('AC1 edge: propagates a throw from provider.send() so the dispatcher job retry/backoff applies identically', async () => {
    const send = vi.fn().mockRejectedValue(new Error('provider unavailable'))
    const provider: DeliveryProvider = {
      send,
      verifyWebhookSignature: () => true,
      parseWebhookEvents: () => [],
    }
    wireExtensionDeliveryProvider(loadedStateWith({ email: provider }))

    await createTestUser('delivery-provider-throws')
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailQueueEntry(orgId, 'recipient3@example.com')

      await expect(sendEmailNotification(queueId, orgId)).rejects.toThrow('provider unavailable')

      const entry = await getNotificationQueueEntry(orgId, queueId)
      // Claimed (attempt_count incremented) but not marked sent/delivered — the pg-boss job layer
      // owns the retry, same as an nodemailer sendMail() rejection would leave the row.
      expect(entry?.status).toBe('pending')
    })
  })
})
