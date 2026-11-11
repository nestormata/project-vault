import { describe, expect, it } from 'vitest'
import type {
  ServiceEndpointLimits,
  ServiceEndpointLimitsContext,
  ServiceEndpointLimitsResolver,
} from './service-endpoint-limits.js'

describe('ServiceEndpointLimits contract shape (Story 73.7)', () => {
  it('context has exactly orgId, projectId, and callId', () => {
    const fixture: ServiceEndpointLimitsContext = {
      orgId: 'org_1',
      projectId: 'proj_1',
      callId: 'call_1',
    }
    expect(new Set(Object.keys(fixture))).toEqual(new Set(['orgId', 'projectId', 'callId']))
  })

  it('limits object may be empty (default open)', () => {
    const fixture: ServiceEndpointLimits = {}
    expect(Object.keys(fixture)).toEqual([])
  })

  it('limits object may set all three optional fields', () => {
    const fixture: ServiceEndpointLimits = {
      healthChecksEnabled: false,
      maxEndpoints: 3,
      minCheckIntervalSeconds: 300,
    }
    expect(new Set(Object.keys(fixture))).toEqual(
      new Set(['healthChecksEnabled', 'maxEndpoints', 'minCheckIntervalSeconds'])
    )
  })

  it('resolver is a single async method', async () => {
    const resolver: ServiceEndpointLimitsResolver = {
      onResolveServiceEndpointLimits: async () => ({ maxEndpoints: 2 }),
    }
    await expect(
      resolver.onResolveServiceEndpointLimits({
        orgId: 'o',
        projectId: 'p',
        callId: 'c',
      })
    ).resolves.toEqual({ maxEndpoints: 2 })
  })
})
