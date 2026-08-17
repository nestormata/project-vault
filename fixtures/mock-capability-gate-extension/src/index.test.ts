import { describe, expect, it } from 'vitest'
import { EXTENSION_API_VERSION, isExtensionApiVersionSupported } from '@project-vault/extension-api'
import mockCapabilityGateExtension, {
  GARBAGE_TRIGGER_ORG_ID,
  GATED_CAPABILITY,
  HANG_TRIGGER_ORG_ID,
  PERMITTED_ORG_IDS,
  THROW_TRIGGER_ORG_ID,
} from './index.js'

const baseContext = {
  capability: GATED_CAPABILITY,
  userId: null,
  orgRole: null,
  gateCallId: 'fixture-call-id',
}

describe('mock-capability-gate-extension (Story 23.3 AC-27, AC-28, AC-29)', () => {
  it('declares a valid, reverse-DNS manifest with only the capability-gate capability', () => {
    expect(mockCapabilityGateExtension.manifest.name).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/)
    expect(mockCapabilityGateExtension.manifest.capabilities).toEqual(['capability-gate'])
  })

  it('does NOT implement an auth strategy (proves a manifest may declare capability-gate alone)', () => {
    const hooks = mockCapabilityGateExtension.hooksFactory()
    expect(hooks.authStrategy).toBeUndefined()
    expect(hooks.capabilityGate).toBeDefined()
  })

  it('permits a permitted-org-id request', async () => {
    const hooks = mockCapabilityGateExtension.hooksFactory()
    for (const orgId of PERMITTED_ORG_IDS) {
      const decision = await hooks.capabilityGate?.onCheckCapability({ ...baseContext, orgId })
      expect(decision).toEqual({ permitted: true })
    }
  })

  it('denies any other org id with a deterministic reasonCode/message', async () => {
    const hooks = mockCapabilityGateExtension.hooksFactory()
    const decision = await hooks.capabilityGate?.onCheckCapability({
      ...baseContext,
      orgId: 'some-unentitled-org',
    })
    expect(decision).toEqual({
      permitted: false,
      reasonCode: 'fixture_not_entitled',
      message: 'This fixture org is not entitled to publish a public status page.',
    })
  })

  it('denies a null (unauthenticated) orgId', async () => {
    const hooks = mockCapabilityGateExtension.hooksFactory()
    const decision = await hooks.capabilityGate?.onCheckCapability({ ...baseContext, orgId: null })
    expect(decision).toMatchObject({ permitted: false })
  })

  it('the throw trigger org id throws synchronously inside the async function', async () => {
    const hooks = mockCapabilityGateExtension.hooksFactory()
    await expect(
      hooks.capabilityGate?.onCheckCapability({ ...baseContext, orgId: THROW_TRIGGER_ORG_ID })
    ).rejects.toThrow('deterministic throw trigger')
  })

  it('the hang trigger org id never resolves', async () => {
    const hooks = mockCapabilityGateExtension.hooksFactory()
    const result = hooks.capabilityGate?.onCheckCapability({
      ...baseContext,
      orgId: HANG_TRIGGER_ORG_ID,
    })
    const raced = await Promise.race([
      result,
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 20)),
    ])
    expect(raced).toBe('still-pending')
  })

  it('the garbage trigger org id returns a malformed decision', async () => {
    const hooks = mockCapabilityGateExtension.hooksFactory()
    const decision = await hooks.capabilityGate?.onCheckCapability({
      ...baseContext,
      orgId: GARBAGE_TRIGGER_ORG_ID,
    })
    expect(decision).not.toHaveProperty('permitted', true)
    expect(decision).not.toHaveProperty('permitted', false)
  })

  it('never makes an outbound network call (structural: only manifest + hooksFactory exported)', () => {
    expect(Object.keys(mockCapabilityGateExtension)).toEqual(['manifest', 'hooksFactory'])
  })

  it('declares the canonical version consumed by the host gate', () => {
    expect(mockCapabilityGateExtension.manifest.apiVersion).toBe(EXTENSION_API_VERSION)
    expect(isExtensionApiVersionSupported(mockCapabilityGateExtension.manifest.apiVersion)).toBe(
      true
    )
  })
})
