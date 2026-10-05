import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

describe('POST /api/v1/notifications/delivery-webhook/:providerId - Story 70.3 AC5 rate limit', () => {
  let app: TestApp
  let savedBypass: string | undefined

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, 'delivery-webhook-rate-limit-vault-secret')
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    __resetDeliveryProvidersForTests()
    savedBypass = process.env['RATE_LIMIT_TEST_BYPASS']
    delete process.env['RATE_LIMIT_TEST_BYPASS']
  })

  afterEach(() => {
    if (savedBypass === undefined) delete process.env['RATE_LIMIT_TEST_BYPASS']
    else process.env['RATE_LIMIT_TEST_BYPASS'] = savedBypass
  })

  function provider(webhookRateLimit?: DeliveryProvider['webhookRateLimit']): DeliveryProvider {
    return {
      send: () => Promise.resolve({ providerMessageId: 'x' }),
      verifyWebhookSignature: () => true,
      parseWebhookEvents: () => [],
      ...(webhookRateLimit ? { webhookRateLimit } : {}),
    }
  }

  async function post(providerId: string, remoteAddress: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/notifications/delivery-webhook/${providerId}`,
      remoteAddress,
      payload: { ping: true },
    })
  }

  async function statuses(providerId: string, ip: string, count: number): Promise<number[]> {
    const out: number[] = []
    for (let i = 0; i < count; i += 1) out.push((await post(providerId, ip)).statusCode)
    return out
  }

  it('a provider declaring max 500 accepts 500 calls and answers 429 on the 501st', async () => {
    wireExtensionDeliveryProvider(
      loadedStateWith({ email: provider({ max: 500, windowSeconds: 60 }) })
    )
    const codes = await statuses('email', '198.51.100.10', 501)
    expect(codes.slice(0, 500).every((code) => code === 202)).toBe(true)
    expect(codes[500]).toBe(429)
  })

  it('a provider without a declaration keeps the default 60 per window (429 on the 61st)', async () => {
    wireExtensionDeliveryProvider(loadedStateWith({ email: provider() }))
    const codes = await statuses('email', '198.51.100.11', 61)
    expect(codes.slice(0, 60).every((code) => code === 202)).toBe(true)
    expect(codes[60]).toBe(429)
    expect((await post('email', '198.51.100.11')).json()).toMatchObject({
      code: 'rate_limit_exceeded',
    })
  })

  it('providers on different channels have independent buckets for one IP', async () => {
    wireExtensionDeliveryProvider(loadedStateWith({ email: provider(), slackish: provider() }))
    const ip = '198.51.100.12'
    expect((await statuses('email', ip, 61))[60]).toBe(429)
    expect((await post('slackish', ip)).statusCode).toBe(202)
  })

  it('unknown provider ids share one bucket and keep the identical 404 body', async () => {
    wireExtensionDeliveryProvider(loadedStateWith({ email: provider() }))
    const ip = '198.51.100.13'
    const codes: number[] = []
    for (let i = 0; i < 70; i += 1) codes.push((await post(`unknown-${i}`, ip)).statusCode)
    expect(codes.slice(0, 60).every((code) => code === 404)).toBe(true)
    expect(codes.slice(60).every((code) => code === 429)).toBe(true)
    const first = await post('unknown-first', '198.51.100.14')
    expect(first.statusCode).toBe(404)
    expect(first.json()).toEqual({ code: 'delivery_webhook_rejected', message: 'Request rejected' })
  })

  it('RATE_LIMIT_TEST_BYPASS=true under NODE_ENV=test still bypasses the limit', async () => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
    wireExtensionDeliveryProvider(loadedStateWith({ email: provider() }))
    const codes = await statuses('email', '198.51.100.15', 70)
    expect(codes.every((code) => code === 202)).toBe(true)
  })
})
