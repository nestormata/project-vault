import { randomUUID } from 'node:crypto'
import { describe, expect, it, beforeAll, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { AuditEvent } from '@project-vault/shared'
import type { DeliveryProvider } from '@project-vault/extension-api'
import type { ExtensionState } from '../extensions/loader.js'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import {
  DeliveryProviderConflictError,
  DeliveryProviderRegistrationAuditError,
  auditDeliveryProviderRegistrationOrFailClosed,
  getDeliveryProviderForChannel,
  getRegisteredDeliveryProviderChannels,
  wireExtensionDeliveryProvider,
  __resetDeliveryProvidersForTests,
} from './delivery-provider.js'

configureAuthIntegrationEnv()

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

// Story 20.11 AC5 — the registration audit fanout needs a real (unsealed) vault to fetch the
// audit HMAC key, mirroring delivery-status-integration.test.ts's identical precedent.
describe('auditDeliveryProviderRegistrationOrFailClosed', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    const { initVault } = await import('../modules/vault/key-service.js')
    await initVaultForTest(initVault, 'delivery-provider-registration-audit-vault-secret')
  })

  beforeEach(() => {
    __resetDeliveryProvidersForTests()
  })

  it('AC5: writes a notification.delivery_provider_registered row per org per channel', async () => {
    await withTestOrg(async ({ orgId }) => {
      wireExtensionDeliveryProvider(loadedState({ email: makeProvider() }))
      await auditDeliveryProviderRegistrationOrFailClosed(
        getRegisteredDeliveryProviderChannels(),
        { warn: () => undefined, fatal: () => undefined },
        () => Promise.resolve([orgId])
      )

      const rows = await withOrg(orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(
            and(
              eq(auditLogEntries.orgId, orgId),
              eq(auditLogEntries.eventType, AuditEvent.NOTIFICATION_DELIVERY_PROVIDER_REGISTERED)
            )
          )
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.payload).toMatchObject({ channel: 'email' })
    })
  })

  it('AC5 fail-closed: a per-org audit-write failure rolls back the registration and throws', async () => {
    wireExtensionDeliveryProvider(loadedState({ email: makeProvider() }))
    expect(getDeliveryProviderForChannel('email')).toBeDefined()

    await expect(
      auditDeliveryProviderRegistrationOrFailClosed(
        getRegisteredDeliveryProviderChannels(),
        { warn: () => undefined, fatal: () => undefined },
        // A non-existent org id: withOrg's RLS-scoped write will fail for it, simulating any
        // per-org audit-write failure — the registration must not survive un-audited.
        () => Promise.resolve([randomUUID()])
      )
    ).rejects.toThrow(DeliveryProviderRegistrationAuditError)

    expect(getDeliveryProviderForChannel('email')).toBeUndefined()
    expect(getRegisteredDeliveryProviderChannels()).toEqual([])
  })

  it('AC5 fail-closed: failure to enumerate organizations rolls back the registration and throws', async () => {
    wireExtensionDeliveryProvider(loadedState({ email: makeProvider() }))

    await expect(
      auditDeliveryProviderRegistrationOrFailClosed(
        getRegisteredDeliveryProviderChannels(),
        { warn: () => undefined, fatal: () => undefined },
        () => Promise.reject(new Error('org enumeration failed'))
      )
    ).rejects.toThrow(DeliveryProviderRegistrationAuditError)

    expect(getDeliveryProviderForChannel('email')).toBeUndefined()
  })

  it('no-ops for an empty channel list', async () => {
    await expect(
      auditDeliveryProviderRegistrationOrFailClosed(
        [],
        { warn: () => undefined, fatal: () => undefined },
        () => Promise.reject(new Error('must not be called'))
      )
    ).resolves.toBeUndefined()
  })
})
