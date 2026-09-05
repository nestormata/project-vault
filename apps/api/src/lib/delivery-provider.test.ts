import { describe, expect, it, beforeEach } from 'vitest'
import type { DeliveryProvider } from '@project-vault/extension-api'
import type { ExtensionState } from '../extensions/loader.js'
import {
  DeliveryProviderConflictError,
  getDeliveryProviderForChannel,
  getRegisteredDeliveryProviderChannels,
  wireExtensionDeliveryProvider,
  __resetDeliveryProvidersForTests,
} from './delivery-provider.js'

function makeProvider(): DeliveryProvider {
  return {
    send: () => Promise.resolve({ providerMessageId: 'msg-1' }),
    verifyWebhookSignature: () => true,
    parseWebhookEvents: () => [],
  }
}

function loadedState(deliveryProvider?: Record<string, DeliveryProvider>): ExtensionState {
  return {
    status: 'loaded',
    manifest: { name: 'com.acme.test-extension', apiVersion: '3.11.0', capabilities: [] },
    loadedAt: new Date().toISOString(),
    hooks: { deliveryProvider },
  }
}

describe('wireExtensionDeliveryProvider', () => {
  beforeEach(() => {
    __resetDeliveryProvidersForTests()
  })

  it('no-ops for a non-loaded extension state', () => {
    wireExtensionDeliveryProvider({ status: 'not_configured' })
    expect(getRegisteredDeliveryProviderChannels()).toEqual([])
  })

  it('no-ops when the loaded extension declares no deliveryProvider hook', () => {
    wireExtensionDeliveryProvider(loadedState(undefined))
    expect(getRegisteredDeliveryProviderChannels()).toEqual([])
  })

  it('registers a provider per declared channel', () => {
    const provider = makeProvider()
    wireExtensionDeliveryProvider(loadedState({ email: provider }))
    expect(getRegisteredDeliveryProviderChannels()).toEqual(['email'])
    expect(getDeliveryProviderForChannel('email')).toBe(provider)
    expect(getDeliveryProviderForChannel('slack')).toBeUndefined()
  })

  it('registers multiple distinct channels from one call', () => {
    const emailProvider = makeProvider()
    const slackProvider = makeProvider()
    wireExtensionDeliveryProvider(loadedState({ email: emailProvider, slack: slackProvider }))
    expect(getRegisteredDeliveryProviderChannels().sort()).toEqual(['email', 'slack'])
  })

  it('AC1 failure case: registering the same channel twice throws a named conflict error, loud, not last-write-wins', () => {
    wireExtensionDeliveryProvider(loadedState({ email: makeProvider() }))
    const second = makeProvider()
    expect(() => wireExtensionDeliveryProvider(loadedState({ email: second }))).toThrow(
      DeliveryProviderConflictError
    )
    // The original registration is retained — last-registered-wins is not acceptable.
    expect(getDeliveryProviderForChannel('email')).not.toBe(second)
  })
})
