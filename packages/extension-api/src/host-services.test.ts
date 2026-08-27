import { describe, expect, it } from 'vitest'
import type { HostServices } from './host-services.js'

describe('HostServices — Story 20.8 AC-1 widening to include ephemeralState', () => {
  it('exposes exactly auditEventSource/orgAuthorization/ephemeralState', () => {
    const fixture: HostServices = {
      auditEventSource: { writeAuditEvent: async () => ({ id: '1', createdAt: '2026-01-01' }) },
      orgAuthorization: { checkMembership: async () => ({ outcome: 'authorized' }) },
      ephemeralState: {
        set: async () => undefined,
        get: async () => undefined,
        delete: async () => undefined,
        compareAndSwap: async () => true,
        compareAndDelete: async () => true,
      },
    }
    expect(new Set(Object.keys(fixture))).toEqual(
      new Set(['auditEventSource', 'orgAuthorization', 'ephemeralState'])
    )
  })

  it('an existing hooksFactory destructuring only { auditEventSource } still type-checks against the widened HostServices (additive-only)', () => {
    function legacyHooksFactory(host: {
      auditEventSource: HostServices['auditEventSource']
    }): void {
      expect(typeof host.auditEventSource.writeAuditEvent).toBe('function')
    }
    const host: HostServices = {
      auditEventSource: { writeAuditEvent: async () => ({ id: '1', createdAt: '2026-01-01' }) },
      orgAuthorization: { checkMembership: async () => ({ outcome: 'authorized' }) },
      ephemeralState: {
        set: async () => undefined,
        get: async () => undefined,
        delete: async () => undefined,
        compareAndSwap: async () => true,
        compareAndDelete: async () => true,
      },
    }
    legacyHooksFactory(host)
  })
})
