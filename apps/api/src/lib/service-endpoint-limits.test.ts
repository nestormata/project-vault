import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'
import type { ServiceEndpointLimitsResolver } from '@project-vault/extension-api'
import {
  CheckIntervalTooShortError,
  HealthChecksDisabledError,
  SERVICE_ENDPOINT_LIMITS_TIMEOUT_MS,
  ServiceEndpointLimitsUnavailableError,
  __resetServiceEndpointLimitsForTests,
  __setServiceEndpointLimitsResolverForTests,
  __setStaticServiceEndpointLimitsForTests,
  decideServiceEndpointMutation,
  getServiceEndpointLimitsResolver,
  resolveServiceEndpointLimits,
  serviceEndpointLimitsHttpError,
  throwServiceEndpointLimitsDecision,
  wireExtensionServiceEndpointLimits,
  type ServiceEndpointMutation,
} from './service-endpoint-limits.js'
import type { ExtensionState } from '../extensions/loader.js'

const createMutation: ServiceEndpointMutation = {
  kind: 'create',
  enablingCheck: true,
  intervalSeconds: 300,
  previousIntervalSeconds: null,
}

const openResolved = {
  status: 'ok' as const,
  healthChecksEnabled: true,
  maxEndpointsOrg: null,
  minCheckIntervalSeconds: null,
}

function loadedState(resolver: ServiceEndpointLimitsResolver | undefined): ExtensionState {
  return {
    status: 'loaded',
    manifest: { name: 'com.example.ext', apiVersion: '3.42.0', capabilities: [] },
    loadedAt: new Date().toISOString(),
    hooks: resolver ? { serviceEndpointLimits: resolver } : {},
  }
}

describe('decideServiceEndpointMutation (Story 73.7)', () => {
  afterEach(() => __resetServiceEndpointLimitsForTests())

  it('default-open create is allowed under the per-project cap', () => {
    expect(
      decideServiceEndpointMutation(openResolved, createMutation, {
        project: 24,
        org: 24,
        maxPerProject: 25,
      })
    ).toEqual({ allowed: true })
  })

  it('refuses create at the per-project cap with the existing message shape', () => {
    expect(
      decideServiceEndpointMutation(openResolved, createMutation, {
        project: 25,
        org: 25,
        maxPerProject: 25,
      })
    ).toEqual({
      allowed: false,
      code: 'service_endpoint_limit_reached',
      message: 'This project has reached its maximum of 25 monitored endpoints',
      limit: 25,
    })
  })

  it('refuses create at the org cap while under the per-project cap', () => {
    expect(
      decideServiceEndpointMutation({ ...openResolved, maxEndpointsOrg: 3 }, createMutation, {
        project: 1,
        org: 3,
        maxPerProject: 25,
      })
    ).toEqual({
      allowed: false,
      code: 'service_endpoint_limit_reached',
      message: 'This organization has reached its maximum of 3 monitored endpoints',
      limit: 3,
    })
  })

  it('refuses create and resume when health checks are disabled', () => {
    const resolved = { ...openResolved, healthChecksEnabled: false }
    expect(
      decideServiceEndpointMutation(resolved, createMutation, {
        project: 0,
        org: 0,
        maxPerProject: 25,
      })
    ).toMatchObject({ allowed: false, code: 'health_checks_disabled' })
    expect(
      decideServiceEndpointMutation(
        resolved,
        {
          kind: 'update',
          enablingCheck: true,
          intervalSeconds: null,
          previousIntervalSeconds: 300,
        },
        { project: 1, org: 1, maxPerProject: 25 }
      )
    ).toMatchObject({ allowed: false, code: 'health_checks_disabled' })
  })

  it('allows pause and name-only update when health checks are disabled', () => {
    const resolved = { ...openResolved, healthChecksEnabled: false }
    expect(
      decideServiceEndpointMutation(
        resolved,
        {
          kind: 'update',
          enablingCheck: false,
          intervalSeconds: null,
          previousIntervalSeconds: 300,
        },
        { project: 1, org: 1, maxPerProject: 25 }
      )
    ).toEqual({ allowed: true })
  })

  it('refuses a too-short interval on create and on update', () => {
    const resolved = { ...openResolved, minCheckIntervalSeconds: 300 }
    expect(
      decideServiceEndpointMutation(
        resolved,
        { ...createMutation, intervalSeconds: 60 },
        { project: 0, org: 0, maxPerProject: 25 }
      )
    ).toMatchObject({ allowed: false, code: 'check_interval_too_short', limit: 300 })
    expect(
      decideServiceEndpointMutation(
        resolved,
        {
          kind: 'update',
          enablingCheck: false,
          intervalSeconds: 60,
          previousIntervalSeconds: 300,
        },
        { project: 1, org: 1, maxPerProject: 25 }
      )
    ).toMatchObject({ allowed: false, code: 'check_interval_too_short' })
  })

  it('fail-closed: unavailable refuses create and raising updates, allows lowering updates', () => {
    const unavailable = { status: 'unavailable' as const }
    expect(
      decideServiceEndpointMutation(unavailable, createMutation, {
        project: 0,
        org: 0,
        maxPerProject: 25,
      })
    ).toMatchObject({ allowed: false, code: 'service_endpoint_limits_unavailable' })
    expect(
      decideServiceEndpointMutation(
        unavailable,
        {
          kind: 'update',
          enablingCheck: true,
          intervalSeconds: null,
          previousIntervalSeconds: 300,
        },
        { project: 1, org: 1, maxPerProject: 25 }
      )
    ).toMatchObject({ allowed: false, code: 'service_endpoint_limits_unavailable' })
    expect(
      decideServiceEndpointMutation(
        unavailable,
        {
          kind: 'update',
          enablingCheck: false,
          intervalSeconds: 900,
          previousIntervalSeconds: 300,
        },
        { project: 1, org: 1, maxPerProject: 25 }
      )
    ).toEqual({ allowed: true })
  })
})

describe('resolveServiceEndpointLimits (Story 73.7)', () => {
  afterEach(() => __resetServiceEndpointLimitsForTests())

  it('uses static limits when no resolver is registered', async () => {
    __setStaticServiceEndpointLimitsForTests({
      healthChecksEnabled: false,
      maxEndpoints: 2,
      minCheckIntervalSeconds: 300,
    })
    await expect(resolveServiceEndpointLimits({ orgId: 'o', projectId: 'p' })).resolves.toEqual({
      status: 'ok',
      healthChecksEnabled: false,
      maxEndpointsOrg: 2,
      minCheckIntervalSeconds: 300,
    })
  })

  it('a registered resolver replaces static env, including empty default-open', async () => {
    __setStaticServiceEndpointLimitsForTests({ healthChecksEnabled: false, maxEndpoints: 1 })
    __setServiceEndpointLimitsResolverForTests({
      onResolveServiceEndpointLimits: async () => ({}),
    })
    await expect(resolveServiceEndpointLimits({ orgId: 'o', projectId: 'p' })).resolves.toEqual({
      status: 'ok',
      healthChecksEnabled: true,
      maxEndpointsOrg: null,
      minCheckIntervalSeconds: null,
    })
  })

  it('passes orgId, projectId, and a host-minted callId to the resolver', async () => {
    const seen: string[] = []
    __setServiceEndpointLimitsResolverForTests({
      onResolveServiceEndpointLimits: async (context) => {
        seen.push(context.orgId, context.projectId, context.callId)
        return { maxEndpoints: 4 }
      },
    })
    const result = await resolveServiceEndpointLimits({ orgId: 'org-a', projectId: 'proj-a' })
    expect(result).toMatchObject({ status: 'ok', maxEndpointsOrg: 4 })
    expect(seen[0]).toBe('org-a')
    expect(seen[1]).toBe('proj-a')
    expect(seen[2]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  })

  it('strips extra keys from a resolver answer', async () => {
    __setServiceEndpointLimitsResolverForTests({
      onResolveServiceEndpointLimits: async () =>
        ({ healthChecksEnabled: true, extra: 1 }) as never,
    })
    await expect(resolveServiceEndpointLimits({ orgId: 'o', projectId: 'p' })).resolves.toEqual({
      status: 'ok',
      healthChecksEnabled: true,
      maxEndpointsOrg: null,
      minCheckIntervalSeconds: null,
    })
  })

  it('fail-closed on throw, timeout, and non-integer max', async () => {
    const error = vi.fn()
    __setServiceEndpointLimitsResolverForTests({
      onResolveServiceEndpointLimits: async () => {
        throw new Error('secret boom')
      },
    })
    await expect(
      resolveServiceEndpointLimits({ orgId: 'o', projectId: 'p', logger: { error } })
    ).resolves.toEqual({ status: 'unavailable' })
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: OperationalEvent.SERVICE_ENDPOINT_LIMITS_UNAVAILABLE,
        subReason: 'threw',
      }),
      expect.any(String)
    )
    expect(JSON.stringify(error.mock.calls[0])).not.toContain('secret boom')

    __setServiceEndpointLimitsResolverForTests({
      onResolveServiceEndpointLimits: async () =>
        new Promise(() => {
          /* hang */
        }),
    })
    await expect(
      resolveServiceEndpointLimits({ orgId: 'o', projectId: 'p', timeoutMs: 20, logger: { error } })
    ).resolves.toEqual({ status: 'unavailable' })

    __setServiceEndpointLimitsResolverForTests({
      onResolveServiceEndpointLimits: async () => ({ maxEndpoints: 1.5 }),
    })
    await expect(resolveServiceEndpointLimits({ orgId: 'o', projectId: 'p' })).resolves.toEqual({
      status: 'unavailable',
    })
  })

  it('wires the resolver once and ignores a second wire', () => {
    const first: ServiceEndpointLimitsResolver = {
      onResolveServiceEndpointLimits: async () => ({ maxEndpoints: 1 }),
    }
    const second: ServiceEndpointLimitsResolver = {
      onResolveServiceEndpointLimits: async () => ({ maxEndpoints: 9 }),
    }
    wireExtensionServiceEndpointLimits(loadedState(first))
    const warn = vi.fn()
    wireExtensionServiceEndpointLimits(loadedState(second), { warn })
    expect(getServiceEndpointLimitsResolver()).toBe(first)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: OperationalEvent.SERVICE_ENDPOINT_LIMITS_DOUBLE_WIRE_IGNORED,
      }),
      expect.any(String)
    )
  })

  it('maps typed errors to HTTP 403/422/503', () => {
    expect(serviceEndpointLimitsHttpError(new HealthChecksDisabledError())).toMatchObject({
      status: 403,
      code: 'health_checks_disabled',
    })
    expect(serviceEndpointLimitsHttpError(new CheckIntervalTooShortError(300))).toMatchObject({
      status: 422,
      code: 'check_interval_too_short',
    })
    expect(
      serviceEndpointLimitsHttpError(new ServiceEndpointLimitsUnavailableError())
    ).toMatchObject({ status: 503, code: 'service_endpoint_limits_unavailable' })
    expect(throwServiceEndpointLimitsDecision).toBeTypeOf('function')
    expect(SERVICE_ENDPOINT_LIMITS_TIMEOUT_MS).toBe(250)
  })
})
