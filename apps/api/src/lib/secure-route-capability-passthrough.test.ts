import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityGate } from '@project-vault/extension-api'
import { CapabilityId } from '@project-vault/shared'
import {
  loadedApiRoutesState,
  runStubRoute,
  stubInstance,
  tableFor,
  type StubInstance,
  type StubRoute,
} from '../__tests__/helpers/secure-route-stubs.js'
import {
  __resetCapabilityGateForTests,
  checkCapability,
  wireExtensionCapabilityGate,
} from './capability-gate.js'
import { secureAddedApiRoute, secureRoute } from './secure-route.js'

/**
 * Story 68.8 Q14 (Nestor 2026-10-02): an `apiRoutes` entry's own `security.capability` (an added
 * route, or an override that sets `security` through `replaceSecurity`) may name an id PV does not
 * know. PV passes it through to the registered extension `capabilityGate`, which decides. With no
 * gate registered such an id denies (fail closed). PV's own routes keep the strict boot-time and
 * runtime unknown-capability checks.
 */
const CM_ONLY_CAPABILITY = 'cm.documents.read'
const DASHBOARD_PREFIX = '/api/v1/dashboard'
const DASHBOARD_KEY = 'GET /api/v1/dashboard'
const ADDED_URL = '/api/v1/cm/documents'
const ADDED_KEY = `GET ${ADDED_URL}`

type GateFn = CapabilityGate['onCheckCapability']

function wireGate(onCheckCapability: GateFn): void {
  wireExtensionCapabilityGate(
    loadedApiRoutesState(undefined, {}, { capabilityGate: { onCheckCapability } })
  )
}

function onlyRoute(instance: StubInstance): StubRoute {
  const route = instance.routes.at(0)
  if (!route) throw new Error('no route registered')
  return route
}

function addedRoute(capability: string, handler: () => Promise<unknown>): StubRoute {
  const table = tableFor(
    {
      add: [
        {
          method: 'GET',
          url: ADDED_URL,
          options: { security: { capability, requireOrgScope: false, writeAuditEvent: false } },
        },
      ],
    },
    { [ADDED_KEY]: { handler } }
  )
  const entry = table.adds.at(0)
  if (!entry) throw new Error('expected one added route')
  const instance = stubInstance({ table })
  secureAddedApiRoute(instance as never, entry)
  return onlyRoute(instance)
}

function replaceSecurityRoute(capability: string, handler: () => Promise<unknown>): StubRoute {
  const table = tableFor(
    {
      override: [
        {
          method: 'GET',
          url: DASHBOARD_PREFIX,
          mode: 'replace',
          replaceSecurity: true,
          security: { capability, requireOrgScope: false, writeAuditEvent: false },
        },
      ],
    },
    { [DASHBOARD_KEY]: { handler } }
  )
  const instance = stubInstance({ prefix: DASHBOARD_PREFIX, table })
  secureRoute(instance as never, { method: 'GET', url: '', handler: async () => ({ pv: true }) })
  return onlyRoute(instance)
}

const BUILDERS = [
  ['an added route', addedRoute],
  ['a replaceSecurity override', replaceSecurityRoute],
] as const

describe('Story 68.8 Q14 — an apiRoutes entry’s own capability id reaches the extension gate', () => {
  afterEach(() => {
    __resetCapabilityGateForTests()
  })

  describe.each(BUILDERS)('%s', (_label, build) => {
    it('a CM-only id the gate permits: the gate receives the id unchanged and the handler runs', async () => {
      const gate = vi.fn<GateFn>(async () => ({ permitted: true }))
      wireGate(gate)
      const handler = vi.fn(async () => ({ data: 'cm' }))
      const { reply } = await runStubRoute(build(CM_ONLY_CAPABILITY, handler))
      expect(gate).toHaveBeenCalledTimes(1)
      expect(gate.mock.calls[0]?.[0]).toMatchObject({ capability: CM_ONLY_CAPABILITY })
      expect(handler).toHaveBeenCalledTimes(1)
      expect(reply.statusCode).toBe(200)
      expect(reply.body).toEqual({ data: 'cm' })
    })

    it('a CM-only id the gate denies: 403 capability_denied with the gate’s reason, handler never runs', async () => {
      wireGate(async () => ({ permitted: false, reasonCode: 'cm_not_entitled', message: 'No.' }))
      const handler = vi.fn(async () => ({}))
      const { reply } = await runStubRoute(build(CM_ONLY_CAPABILITY, handler))
      expect(reply.statusCode).toBe(403)
      expect(reply.body).toEqual({
        code: 'capability_denied',
        capability: CM_ONLY_CAPABILITY,
        reasonCode: 'cm_not_entitled',
        message: 'No.',
      })
      expect(handler).not.toHaveBeenCalled()
    })

    it('a CM-only id with no gate registered denies (fail closed: unknown_capability)', async () => {
      const handler = vi.fn(async () => ({}))
      const { reply } = await runStubRoute(build(CM_ONLY_CAPABILITY, handler))
      expect(reply.statusCode).toBe(403)
      expect(reply.body).toMatchObject({
        code: 'capability_denied',
        capability: CM_ONLY_CAPABILITY,
        reasonCode: 'unknown_capability',
      })
      expect(handler).not.toHaveBeenCalled()
    })

    it('a PV-known id behaves exactly as today: no gate → proceeds ungated (AC-5 fail-open)', async () => {
      const handler = vi.fn(async () => ({ ok: true }))
      const { reply } = await runStubRoute(
        build(CapabilityId.MONITORING_PUBLIC_STATUS_PAGE, handler)
      )
      expect(reply.statusCode).toBe(200)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('a PV-known id behaves exactly as today: a denying gate → 403 with the gate’s reason', async () => {
      wireGate(async () => ({ permitted: false, reasonCode: 'not_entitled' }))
      const handler = vi.fn(async () => ({}))
      const { reply } = await runStubRoute(
        build(CapabilityId.MONITORING_PUBLIC_STATUS_PAGE, handler)
      )
      expect(reply.statusCode).toBe(403)
      expect(reply.body).toMatchObject({
        code: 'capability_denied',
        capability: CapabilityId.MONITORING_PUBLIC_STATUS_PAGE,
        reasonCode: 'not_entitled',
      })
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('PV’s own routes keep the strict unknown-capability checks', () => {
    it('a PV route with an unknown id still fails registration (AC-22 boot-time check)', () => {
      expect(() =>
        secureRoute(stubInstance() as never, {
          method: 'GET',
          url: '/api/v1/test/unknown',
          security: { capability: CM_ONLY_CAPABILITY as never, requireOrgScope: false },
          handler: async () => ({}),
        })
      ).toThrow('SecureRoute: unknown capability id "cm.documents.read"')
    })

    it('an override WITHOUT replaceSecurity keeps PV’s security, so PV’s unknown id still fails registration', () => {
      const table = tableFor(
        { override: [{ method: 'GET', url: DASHBOARD_PREFIX, mode: 'replace' }] },
        { [DASHBOARD_KEY]: { handler: async () => ({}) } }
      )
      expect(() =>
        secureRoute(stubInstance({ prefix: DASHBOARD_PREFIX, table }) as never, {
          method: 'GET',
          url: '',
          security: { capability: CM_ONLY_CAPABILITY as never, requireOrgScope: false },
          handler: async () => ({}),
        })
      ).toThrow('unknown capability id "cm.documents.read"')
    })

    it('a hand-built PV check with an unknown id still denies unknown_capability without consulting the gate', async () => {
      const gate = vi.fn<GateFn>(async () => ({ permitted: true }))
      const decision = await checkCapability(
        { onCheckCapability: gate },
        {
          capability: CM_ONLY_CAPABILITY as never,
          orgId: null,
          userId: null,
          orgRole: null,
          surface: 'org',
        }
      )
      expect(decision).toMatchObject({ permitted: false, reasonCode: 'unknown_capability' })
      expect(gate).not.toHaveBeenCalled()
    })
  })
})
