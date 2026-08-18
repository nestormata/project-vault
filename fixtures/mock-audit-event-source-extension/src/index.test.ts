import { afterEach, describe, expect, it } from 'vitest'
import { EXTENSION_API_VERSION, isExtensionApiVersionSupported } from '@project-vault/extension-api'
import mockAuditEventSourceExtension, {
  __resetMockAuditEventSourceExtensionForTests,
  triggerAuditWrite,
} from './index.js'

afterEach(() => __resetMockAuditEventSourceExtensionForTests())

describe('mock-audit-event-source-extension (Story 23.8 AC-27)', () => {
  it('declares a valid, reverse-DNS manifest with only the audit-event-source capability', () => {
    expect(mockAuditEventSourceExtension.manifest.name).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/)
    expect(mockAuditEventSourceExtension.manifest.capabilities).toEqual(['audit-event-source'])
  })

  it('declares the canonical version consumed by the host', () => {
    expect(mockAuditEventSourceExtension.manifest.apiVersion).toBe(EXTENSION_API_VERSION)
    expect(isExtensionApiVersionSupported(mockAuditEventSourceExtension.manifest.apiVersion)).toBe(
      true
    )
  })

  it('hooksFactory(host) returns no hooks — this hook is host-provided, not extension-implemented', () => {
    const hooks = mockAuditEventSourceExtension.hooksFactory({
      auditEventSource: { writeAuditEvent: async () => ({ id: 'x', createdAt: '' }) },
    })
    expect(hooks).toEqual({})
  })

  it('triggerAuditWrite throws before hooksFactory() has run', async () => {
    await expect(
      triggerAuditWrite({ eventType: 'ext.x.y', orgId: 'org', payload: {} })
    ).rejects.toThrow(/before hooksFactory\(\) ran/)
  })

  it('triggerAuditWrite delegates to the real, captured host.auditEventSource.writeAuditEvent', async () => {
    const writeAuditEvent = async (input: { eventType: string }) => ({
      id: `row-for-${input.eventType}`,
      createdAt: '2026-08-17T00:00:00.000Z',
    })
    mockAuditEventSourceExtension.hooksFactory({ auditEventSource: { writeAuditEvent } })

    const result = await triggerAuditWrite({
      eventType: `ext.${mockAuditEventSourceExtension.manifest.name}.fixture_triggered`,
      orgId: 'org-1',
      payload: {},
    })

    expect(result).toEqual({
      id: `row-for-ext.${mockAuditEventSourceExtension.manifest.name}.fixture_triggered`,
      createdAt: '2026-08-17T00:00:00.000Z',
    })
  })

  it('never makes an outbound network call (structural: only manifest + hooksFactory exported as default)', () => {
    expect(Object.keys(mockAuditEventSourceExtension)).toEqual(['manifest', 'hooksFactory'])
  })
})
