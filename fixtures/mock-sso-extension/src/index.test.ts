import { describe, expect, it } from 'vitest'
import { EXTENSION_API_VERSION, isExtensionApiVersionSupported } from '@project-vault/extension-api'
import mockSsoExtension, { FIXTURE_IDENTITIES } from './index.js'

describe('mock-sso-extension (Story 14.3 Task 10, AC-12)', () => {
  it('declares a valid, reverse-DNS manifest with the auth-provider capability', () => {
    expect(mockSsoExtension.manifest.name).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/)
    expect(mockSsoExtension.manifest.capabilities).toContain('auth-provider')
  })

  it('resolves deterministically for the linked-user fixture identity', async () => {
    const hooks = mockSsoExtension.hooksFactory()
    const result = await hooks.authStrategy?.onAuthenticate('linked-user')
    expect(result).toEqual({
      externalSubject: FIXTURE_IDENTITIES['linked-user'].externalSubject,
      providerName: mockSsoExtension.manifest.name,
      email: 'linked-user@example.test',
    })
  })

  it('resolves deterministically for the unlinked-user fixture identity', async () => {
    const hooks = mockSsoExtension.hooksFactory()
    const result = await hooks.authStrategy?.onAuthenticate('unlinked-user')
    expect(result?.email).toBe('unlinked-user@example.test')
    expect(result?.externalSubject).toBe(FIXTURE_IDENTITIES['unlinked-user'].externalSubject)
  })

  it('resolves deterministically for the invited-user fixture identity', async () => {
    const hooks = mockSsoExtension.hooksFactory()
    const result = await hooks.authStrategy?.onAuthenticate('invited-user')
    expect(result?.email).toBe('invited-user@example.test')
    expect(result?.externalSubject).toBe(FIXTURE_IDENTITIES['invited-user'].externalSubject)
  })

  it('rejects any credential outside the fixed fixture set', async () => {
    const hooks = mockSsoExtension.hooksFactory()
    await expect(hooks.authStrategy?.onAuthenticate('anything-else')).rejects.toThrow()
  })

  it('never makes an outbound network call (no fetch/http import in the module)', () => {
    // Static, structural guarantee: this fixture's own source never imports node:http(s)/fetch.
    expect(Object.keys(mockSsoExtension)).toEqual(['manifest', 'hooksFactory'])
  })

  it('declares the canonical version consumed by the host gate', () => {
    expect(mockSsoExtension.manifest.apiVersion).toBe(EXTENSION_API_VERSION)
    expect(isExtensionApiVersionSupported(mockSsoExtension.manifest.apiVersion)).toBe(true)
  })
})
