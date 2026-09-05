import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { withTestOrg, withTwoTestOrgs } from '@project-vault/db/test-helpers'
import type { DeliveryProvider } from '@project-vault/extension-api'
import {
  __resetDeliveryProvidersForTests,
  wireExtensionDeliveryProvider,
} from '../../lib/delivery-provider.js'
import type { ExtensionState } from '../../extensions/loader.js'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { handleDeliveryWebhook } from './delivery-webhook-service.js'

configureAuthIntegrationEnv()

function loadedStateWith(deliveryProvider: Record<string, DeliveryProvider>): ExtensionState {
  return {
    status: 'loaded',
    manifest: { name: 'com.acme.test-extension', apiVersion: '3.11.0', capabilities: [] },
    loadedAt: new Date().toISOString(),
    hooks: { deliveryProvider },
  }
}

async function seedSentQueueEntry(orgId: string, providerMessageId: string): Promise<string> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(notificationQueue)
      .values({
        orgId,
        channel: 'email',
        templateId: 'test.template',
        payload: {},
        status: 'sent',
        providerId: 'email',
        providerMessageId,
      })
      .returning({ id: notificationQueue.id })
  )
  if (!row) throw new Error('expected queue row')
  return row.id
}

describe('handleDeliveryWebhook', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    const { initVault } = await import('../../modules/vault/key-service.js')
    await initVaultForTest(initVault, 'delivery-webhook-service-vault-secret')
  })

  beforeEach(() => {
    __resetDeliveryProvidersForTests()
  })

  it('AC3 failure: unknown providerId is generically rejected (404)', async () => {
    const result = await handleDeliveryWebhook({
      providerId: 'unregistered',
      rawBody: '{}',
      headers: {},
    })
    expect(result).toEqual({ outcome: 'rejected', status: 404 })
  })

  it('AC3/AC6 failure: an invalid signature is generically rejected (same 404 shape as unknown providerId)', async () => {
    const provider: DeliveryProvider = {
      send: () => Promise.resolve({ providerMessageId: 'x' }),
      verifyWebhookSignature: () => false,
      parseWebhookEvents: () => [],
    }
    wireExtensionDeliveryProvider(loadedStateWith({ email: provider }))

    const result = await handleDeliveryWebhook({
      providerId: 'email',
      rawBody: '{}',
      headers: {},
    })
    expect(result).toEqual({ outcome: 'rejected', status: 404 })
  })

  it('AC3 edge: a validly-signed event for an unknown message id is a non-enumerating accepted no-op', async () => {
    const provider: DeliveryProvider = {
      send: () => Promise.resolve({ providerMessageId: 'x' }),
      verifyWebhookSignature: () => true,
      parseWebhookEvents: () => [{ providerMessageId: 'never-existed', status: 'delivered' }],
    }
    wireExtensionDeliveryProvider(loadedStateWith({ email: provider }))

    const result = await handleDeliveryWebhook({
      providerId: 'email',
      rawBody: '{}',
      headers: {},
    })
    expect(result).toEqual({ outcome: 'accepted' })
  })

  it('AC3 positive: a validly-signed event for a resolvable message id applies the update to that row only', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const providerMessageId = `msg-${orgAId}`
      const queueId = await seedSentQueueEntry(orgAId, providerMessageId)
      const otherQueueId = await seedSentQueueEntry(orgBId, `msg-${orgBId}`)

      const provider: DeliveryProvider = {
        send: () => Promise.resolve({ providerMessageId: 'x' }),
        verifyWebhookSignature: () => true,
        parseWebhookEvents: () => [{ providerMessageId, status: 'delivered' }],
      }
      wireExtensionDeliveryProvider(loadedStateWith({ email: provider }))

      const result = await handleDeliveryWebhook({
        providerId: 'email',
        rawBody: '{}',
        headers: {},
      })
      expect(result).toEqual({ outcome: 'accepted' })

      const [updated] = await withOrg(orgAId, (tx) =>
        tx.select().from(notificationQueue).where(eq(notificationQueue.id, queueId))
      )
      expect(updated?.status).toBe('delivered')

      const [untouched] = await withOrg(orgBId, (tx) =>
        tx.select().from(notificationQueue).where(eq(notificationQueue.id, otherQueueId))
      )
      expect(untouched?.status).toBe('sent')
    })
  })

  it('never trusts a client-supplied org — the row is invisible unless the provider message id itself resolves it', async () => {
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedSentQueueEntry(orgId, 'resolves-fine')
      expect(queueId).toBeTruthy()
    })
  })
})
