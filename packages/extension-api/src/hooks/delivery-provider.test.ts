import { describe, expect, it } from 'vitest'
import { DeliveryProviderPermanentError, type DeliveryProvider } from './delivery-provider.js'

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
        attemptNumber: 1,
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

describe('DeliveryProviderPermanentError (Story 70.3 AC2)', () => {
  it('is an Error with the documented name, reason and cause', () => {
    const cause = new Error('upstream 422')
    const error = new DeliveryProviderPermanentError('invalid recipient', {
      reason: 'invalid_recipient',
      cause,
    })
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(DeliveryProviderPermanentError)
    expect(error.name).toBe('DeliveryProviderPermanentError')
    expect(error.message).toBe('invalid recipient')
    expect(error.reason).toBe('invalid_recipient')
    expect(error.cause).toBe(cause)
  })

  it('reason is optional', () => {
    const error = new DeliveryProviderPermanentError('rejected')
    expect(error.reason).toBeUndefined()
  })

  it.each([
    ['too long', 'a'.repeat(65)],
    ['uppercase', 'Invalid'],
    ['contains an address', ['bad user', 'example.com'].join('@')],
    ['starts with a digit', '1abc'],
    ['empty', ''],
  ])('rejects a reason that is %s with a TypeError', (_label, reason) => {
    expect(() => new DeliveryProviderPermanentError('x', { reason })).toThrow(TypeError)
  })

  it('accepts a 64 character slug', () => {
    const reason = `a${'b'.repeat(63)}`
    expect(new DeliveryProviderPermanentError('x', { reason }).reason).toBe(reason)
  })
})

describe('DeliveryProvider optional contract fields (Story 70.3)', () => {
  it('accepts html on the send payload and a webhookRateLimit declaration', () => {
    const provider: DeliveryProvider = {
      send: (payload) => Promise.resolve({ providerMessageId: payload.html ?? payload.body }),
      verifyWebhookSignature: () => true,
      parseWebhookEvents: () => [],
      webhookRateLimit: { max: 500, windowSeconds: 60 },
    }
    expect(provider.webhookRateLimit?.max).toBe(500)
  })
})
