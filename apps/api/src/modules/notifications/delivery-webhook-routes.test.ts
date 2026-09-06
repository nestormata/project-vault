import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DeliveryProvider } from '@project-vault/extension-api'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import {
  __resetDeliveryProvidersForTests,
  wireExtensionDeliveryProvider,
} from '../../lib/delivery-provider.js'
import type { ExtensionState } from '../../extensions/loader.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

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

describe('POST /api/v1/notifications/delivery-webhook/:providerId', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, 'delivery-webhook-routes-vault-secret')
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    __resetDeliveryProvidersForTests()
  })

  it('AC3 failure: an unregistered providerId is rejected 404, generic body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/delivery-webhook/unregistered',
      payload: { anything: true },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'delivery_webhook_rejected' })
  })

  it('AC3/AC6 failure: an invalid signature is rejected with the SAME shape as an unknown providerId', async () => {
    const provider: DeliveryProvider = {
      send: () => Promise.resolve({ providerMessageId: 'x' }),
      verifyWebhookSignature: () => false,
      parseWebhookEvents: () => [],
    }
    wireExtensionDeliveryProvider(loadedStateWith({ email: provider }))

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/delivery-webhook/email',
      payload: { anything: true },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      code: 'delivery_webhook_rejected',
      message: 'Request rejected',
    })
  })

  it('AC3 positive: a validly-signed event for a resolvable message id is accepted (202) and applies the update', async () => {
    await withTestOrg(async ({ orgId }) => {
      const providerMessageId = `route-msg-${orgId}`
      const queueId = await seedSentQueueEntry(orgId, providerMessageId)

      let capturedRawBody = ''
      const provider: DeliveryProvider = {
        send: () => Promise.resolve({ providerMessageId: 'x' }),
        verifyWebhookSignature: ({ rawBody }) => {
          capturedRawBody = rawBody
          return true
        },
        parseWebhookEvents: () => [{ providerMessageId, status: 'delivered' }],
      }
      wireExtensionDeliveryProvider(loadedStateWith({ email: provider }))

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/delivery-webhook/email',
        payload: { event: 'delivered', id: providerMessageId },
      })

      expect(response.statusCode).toBe(202)
      expect(response.json()).toEqual({ data: { accepted: true } })
      expect(capturedRawBody).toContain(providerMessageId)

      const rows = await withOrg(orgId, (tx) => tx.select().from(notificationQueue))
      const updated = rows.find((r) => r.id === queueId)
      expect(updated?.status).toBe('delivered')
    })
  })
})
