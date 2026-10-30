import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTENSION_API_VERSION } from '@project-vault/extension-api'
import {
  runStubRoute,
  stubDb,
  stubInstance,
  tableFor,
  type StubInstance,
  type StubRoute,
} from '../__tests__/helpers/secure-route-stubs.js'
import { secureAddedApiRoute, secureRoute, type SecureRouteRegistration } from './secure-route.js'
import {
  PROJECT_ROLE_DEFAULT_SINCE,
  projectRolePolicyFor,
  resolveProjectRoleGate,
} from './secure-route-project-role.js'

const effectiveProjectRoleForCaller = vi.fn()
vi.mock('../modules/projects/project-access.js', () => ({
  effectiveProjectRoleForCaller: (...args: unknown[]) => effectiveProjectRoleForCaller(...args),
}))
const isProjectDeleted = vi.fn(async (..._args: unknown[]) => false)
vi.mock('../modules/projects/project-lifecycle.js', () => ({
  isProjectDeleted: (...args: unknown[]) => isProjectDeleted(...args),
}))
// Added routes take no `db` option; the gate and the handler run on this stub transaction.
vi.mock('@project-vault/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@project-vault/db')>()),
  getDb: () => stubDb(),
}))

/**
 * Story 69.18 — the project-role gate on an extension's own security (`apiRoutes` adds and
 * overrides with `replaceSecurity`): defaulted to `member` for a manifest that declares the
 * contract that introduced it, never for an older one, and never dropped by omission.
 */
const PROJECT_ID = randomUUID()
const CURRENT = PROJECT_ROLE_DEFAULT_SINCE
const LEGACY = '3.36.0'
const ADD_URL = '/api/v1/cm/projects/:projectId/notes'
const PV_PREFIX = '/api/v1/projects'
const PV_URL = '/:projectId/archive'
const WRITE = '/p/:projectId/x'
const LEGACY_POLICY = 'extension-legacy'

function onlyRoute(instance: StubInstance): StubRoute {
  const route = instance.routes.at(0)
  if (!route) throw new Error('no route registered')
  return route
}

function invoke(route: StubRoute, method = 'POST') {
  return runStubRoute(route, {
    method,
    params: { projectId: PROJECT_ID },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  })
}

function registerAdd(
  security: Record<string, unknown>,
  options: { apiVersion?: string; method?: string; url?: string } = {}
) {
  const method = options.method ?? 'POST'
  const url = options.url ?? ADD_URL
  const handler = vi.fn(async () => ({ data: { ok: true } }))
  const table = tableFor(
    { add: [{ method, url, options: { security: { writeAuditEvent: false, ...security } } }] },
    { [`${method} ${url}`]: { handler } },
    options.apiVersion ?? CURRENT
  )
  const entry = table.adds.at(0)
  if (!entry) throw new Error('expected one added route')
  const registry = new Map<string, SecureRouteRegistration>()
  const instance = stubInstance({ table, registry })
  secureAddedApiRoute(instance as never, entry)
  return { route: onlyRoute(instance), handler, registration: registry.get(`${method} ${url}`) }
}

function registerOverride(declaration: Record<string, unknown>, apiVersion: string = CURRENT) {
  const key = `POST ${PV_PREFIX}${PV_URL}`
  const cm = vi.fn(async () => ({ data: { source: 'cm' } }))
  const table = tableFor(
    { override: [{ method: 'POST', url: `${PV_PREFIX}${PV_URL}`, ...declaration }] },
    { [key]: { handler: cm } },
    apiVersion
  )
  const registry = new Map<string, SecureRouteRegistration>()
  const instance = stubInstance({ prefix: PV_PREFIX, table, registry })
  secureRoute(instance as never, {
    method: 'POST',
    url: PV_URL,
    db: stubDb(),
    auditWriter: vi.fn(async () => undefined),
    handler: vi.fn(),
  })
  return { route: onlyRoute(instance), cm, registration: registry.get(key) }
}

beforeEach(() => {
  effectiveProjectRoleForCaller.mockReset()
  isProjectDeleted.mockReset()
  isProjectDeleted.mockResolvedValue(false)
})

describe('resolveProjectRoleGate (Story 69.18 decision table)', () => {
  const gate = (
    method: string,
    url: string,
    security: Record<string, unknown> | undefined,
    policy: 'pv' | 'extension' | typeof LEGACY_POLICY
  ) => resolveProjectRoleGate({ method, url, security, policy })

  it.each(['pv', 'extension'] as const)('defaults a %s project write to member', (policy) => {
    expect(gate('PATCH', WRITE, {}, policy)).toEqual({
      minimumProjectRole: 'member',
      ungated: null,
    })
  })

  it('leaves a legacy-contract project write ungated and says why', () => {
    expect(gate('POST', WRITE, undefined, LEGACY_POLICY)).toEqual({
      minimumProjectRole: null,
      ungated: 'legacy_contract',
    })
  })

  it("records an extension's declared 'viewer' and stays silent for PV's", () => {
    const viewer = { minimumProjectRole: 'viewer' }
    expect(gate('POST', WRITE, viewer, 'extension').ungated).toBe('declared_viewer')
    expect(gate('POST', WRITE, viewer, 'pv')).toEqual({
      minimumProjectRole: null,
      ungated: null,
    })
  })

  it('honours a declared higher role under every policy, legacy included', () => {
    for (const policy of ['pv', 'extension', LEGACY_POLICY] as const) {
      expect(gate('POST', WRITE, { minimumProjectRole: 'admin' }, policy)).toEqual({
        minimumProjectRole: 'admin',
        ungated: null,
      })
    }
  })

  it('never defaults a read, or a write without a :projectId segment', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(gate(method, WRITE, {}, 'extension')).toEqual({
        minimumProjectRole: null,
        ungated: null,
      })
    }
    expect(gate('POST', '/p/:projectIdentifier/x', {}, 'extension').minimumProjectRole).toBeNull()
  })

  it('leaves an anonymous extension project write ungated, but keeps the default on PV', () => {
    expect(gate('POST', WRITE, { requireAuth: false }, 'extension').ungated).toBe('unauthenticated')
    expect(gate('POST', WRITE, { requireAuth: false }, 'pv').minimumProjectRole).toBe('member')
  })
})

describe('projectRolePolicyFor (Story 69.18)', () => {
  it.each([
    [CURRENT, 'extension'],
    ['3.37.1', 'extension'],
    ['3.40.0', 'extension'],
    ['4.0.0', 'extension'],
    ['3.36.9', LEGACY_POLICY],
    ['3.25.0', LEGACY_POLICY],
    ['not-a-version', 'extension'],
    ['3.37', 'extension'],
  ])('a manifest declaring %s gets the %s policy', (apiVersion, policy) => {
    expect(projectRolePolicyFor(apiVersion)).toBe(policy)
  })

  it('the default ships in the contract this host speaks (move both together on a renumber)', () => {
    expect(projectRolePolicyFor(EXTENSION_API_VERSION)).toBe('extension')
  })
})

describe('apiRoutes add on the current contract (Story 69.18)', () => {
  it('refuses a project viewer by default, before the handler', async () => {
    effectiveProjectRoleForCaller.mockResolvedValue('viewer')
    const { route, handler, registration } = registerAdd({})

    const { reply } = await invoke(route)

    expect(reply.statusCode).toBe(403)
    expect(reply.body).toMatchObject({ code: 'insufficient_project_role' })
    expect(handler).not.toHaveBeenCalled()
    expect(registration).toMatchObject({ minimumProjectRole: 'member', projectRoleUngated: null })
  })

  it('lets a project member through', async () => {
    effectiveProjectRoleForCaller.mockResolvedValue('member')
    const { route, handler } = registerAdd({})

    const { reply } = await invoke(route)

    expect(reply.statusCode).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('gates an unscoped add (CentralizeMe writes its own store) in its own org-scoped read', async () => {
    effectiveProjectRoleForCaller.mockResolvedValue('viewer')
    const { route, handler } = registerAdd({ requireOrgScope: false })

    const { reply } = await invoke(route)

    expect(reply.statusCode).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it("runs no check for an explicit 'viewer' and records the opt-out", async () => {
    const { route, handler, registration } = registerAdd({ minimumProjectRole: 'viewer' })

    await invoke(route)

    expect(handler).toHaveBeenCalledOnce()
    expect(effectiveProjectRoleForCaller).not.toHaveBeenCalled()
    expect(registration).toMatchObject({
      minimumProjectRole: null,
      projectRoleUngated: 'declared_viewer',
    })
  })

  it('refuses a project member when the route raises the role to admin', async () => {
    effectiveProjectRoleForCaller.mockResolvedValue('member')
    const { route, handler } = registerAdd({ minimumProjectRole: 'admin' })

    const { reply } = await invoke(route)

    expect(reply.statusCode).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('never gates a read under :projectId', async () => {
    const { route, handler } = registerAdd({}, { method: 'GET' })

    await invoke(route, 'GET')

    expect(handler).toHaveBeenCalledOnce()
    expect(effectiveProjectRoleForCaller).not.toHaveBeenCalled()
  })

  it('leaves an anonymous project write ungated and records why', async () => {
    const { route, handler, registration } = registerAdd({
      requireAuth: false,
      rateLimit: false,
    })

    await invoke(route)

    expect(handler).toHaveBeenCalledOnce()
    expect(registration?.projectRoleUngated).toBe('unauthenticated')
  })

  it('fails registration, naming the route, for a declared role without :projectId', () => {
    expect(() =>
      registerAdd({ minimumProjectRole: 'member' }, { url: '/api/v1/cm/notes' })
    ).toThrow(
      'apiRoutes POST /api/v1/cm/notes: SecureRoute: minimumProjectRole requires a :projectId route parameter'
    )
  })
})

describe('apiRoutes add on a legacy contract (Story 69.18)', () => {
  it('keeps the behaviour the extension was written against and records why', async () => {
    const { route, handler, registration } = registerAdd({}, { apiVersion: LEGACY })

    await invoke(route)

    expect(handler).toHaveBeenCalledOnce()
    expect(effectiveProjectRoleForCaller).not.toHaveBeenCalled()
    expect(registration).toMatchObject({
      minimumProjectRole: null,
      projectRoleUngated: 'legacy_contract',
    })
  })
})

describe('overrides of a PV project write (Story 69.18 WRAP/REPLACE semantics)', () => {
  it.each(['replace', 'wrap'] as const)(
    "%s without replaceSecurity keeps PV's gate on either contract",
    async (mode) => {
      for (const apiVersion of [CURRENT, LEGACY]) {
        effectiveProjectRoleForCaller.mockResolvedValue('viewer')
        const { route, cm, registration } = registerOverride({ mode }, apiVersion)

        const { reply } = await invoke(route)

        expect(reply.statusCode).toBe(403)
        expect(cm).not.toHaveBeenCalled()
        expect(registration).toMatchObject({
          minimumProjectRole: 'member',
          projectRoleUngated: null,
        })
      }
    }
  )

  it('replaceSecurity that omits minimumProjectRole cannot drop the gate', async () => {
    effectiveProjectRoleForCaller.mockResolvedValue('viewer')
    const { route, cm, registration } = registerOverride({
      mode: 'replace',
      replaceSecurity: true,
      security: { writeAuditEvent: false },
    })

    const { reply } = await invoke(route)

    expect(reply.statusCode).toBe(403)
    expect(cm).not.toHaveBeenCalled()
    expect(registration?.minimumProjectRole).toBe('member')
  })

  it("replaceSecurity with an explicit 'viewer' drops it, recorded", async () => {
    const { route, cm, registration } = registerOverride({
      mode: 'replace',
      replaceSecurity: true,
      security: { writeAuditEvent: false, minimumProjectRole: 'viewer' },
    })

    await invoke(route)

    expect(cm).toHaveBeenCalledOnce()
    expect(effectiveProjectRoleForCaller).not.toHaveBeenCalled()
    expect(registration?.projectRoleUngated).toBe('declared_viewer')
  })

  it('replaceSecurity from a legacy manifest keeps the pre-3.37 behaviour, recorded', async () => {
    const { route, cm, registration } = registerOverride(
      { mode: 'replace', replaceSecurity: true, security: { writeAuditEvent: false } },
      LEGACY
    )

    await invoke(route)

    expect(cm).toHaveBeenCalledOnce()
    expect(registration?.projectRoleUngated).toBe('legacy_contract')
  })
})
