import { describe, expect, it } from 'vitest'
import type { DeliveryProvider } from './delivery-provider.js'

describe('DeliveryProvider', () => {
  it('send resolves a providerMessageId', async () => {
    const provider: DeliveryProvider = {
      send: (payload) => Promise.resolve({ providerMessageId: `sent:${payload.queueRowId}` }),
      verifyWebhookSignature: () => true,
      parseWebhookEvents: () => [],
    }

    await expect(
      provider.send({
        recipientAddress: 'user@example.com',
        subject: 'hi',
        body: 'hello',
        templateId: 'test.template',
        queueRowId: 'row-1',
      })
    ).resolves.toEqual({ providerMessageId: 'sent:row-1' })
  })

  it('verifyWebhookSignature and parseWebhookEvents are callable with the documented shapes', () => {
    const provider: DeliveryProvider = {
      send: () => Promise.resolve({ providerMessageId: 'x' }),
      verifyWebhookSignature: ({ rawBody, headers }) =>
        rawBody === 'ok' && headers['x-signature'] === 'sig',
      parseWebhookEvents: (rawBody) =>
        rawBody === 'ok' ? [{ providerMessageId: 'x', status: 'delivered' }] : [],
    }

    expect(
      provider.verifyWebhookSignature({ rawBody: 'ok', headers: { 'x-signature': 'sig' } })
    ).toBe(true)
    expect(
      provider.verifyWebhookSignature({ rawBody: 'bad', headers: { 'x-signature': 'sig' } })
    ).toBe(false)
    expect(provider.parseWebhookEvents('ok')).toEqual([
      { providerMessageId: 'x', status: 'delivered' },
    ])
    expect(provider.parseWebhookEvents('bad')).toEqual([])
  })
})
