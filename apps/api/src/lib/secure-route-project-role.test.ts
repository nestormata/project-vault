import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  runStubRoute,
  stubDb,
  stubInstance,
  tableFor,
  type StubInstance,
  type StubRoute,
} from '../__tests__/helpers/secure-route-stubs.js'
import {
  secureRoute,
  type SecureRouteRegistration,
  type SecureRouteRegistrationOptions,
} from './secure-route.js'

const effectiveProjectRoleForCaller = vi.fn()
vi.mock('../modules/projects/project-access.js', () => ({
  effectiveProjectRoleForCaller: (...args: unknown[]) => effectiveProjectRoleForCaller(...args),
}))

/**
 * Story 69.17 (DW-606) — the secureRoute project-role gate: every PV write under `:projectId`
 * requires an effective project role of at least `member` unless the route declares otherwise.
 */
const PROJECT_ID = randomUUID()
const PREFIX = '/api/v1/projects'
const WRITE_URL = '/:projectId/things'

type Options = Partial<SecureRouteRegistrationOptions>

function register(
  options: Options = {},
  registry?: Map<string, SecureRouteRegistration>
): { route: StubRoute; handler: ReturnType<typeof vi.fn>; auditWriter: ReturnType<typeof vi.fn> } {
  const instance = stubInstance({ prefix: PREFIX, ...(registry ? { registry } : {}) })
  const handler = vi.fn(async () => ({ data: { ok: true } }))
  const auditWriter = vi.fn(async () => undefined)
  secureRoute(
    instance as never,
    {
      method: 'POST',
      url: WRITE_URL,
      db: stubDb(),
      auditWriter,
      handler,
      ...options,
    } as SecureRouteRegistrationOptions
  )
  return { route: onlyRoute(instance), handler, auditWriter }
}

function onlyRoute(instance: StubInstance): StubRoute {
  const route = instance.routes.at(0)
  if (!route) throw new Error('no route registered')
  return route
}

function invoke(route: StubRoute, warn = vi.fn()) {
  return runStubRoute(route, {
    method: 'POST',
    params: { projectId: PROJECT_ID },
    routeOptions: { url: `${PREFIX}${WRITE_URL}` },
    log: { warn, info: vi.fn(), error: vi.fn() },
  })
}

beforeEach(() => {
  effectiveProjectRoleForCaller.mockReset()
})

describe('secureRoute project-role gate (Story 69.17)', () => {
  it('refuses a project viewer on a default-gated write with the standard 403 body, before the handler and the audit write', async () => {
    effectiveProjectRoleForCaller.mockResolvedValue('viewer')
    const { route, handler, auditWriter } = register()
    const warn = vi.fn()

    const { reply } = await invoke(route, warn)

    expect(reply.statusCode).toBe(403)
    expect(reply.body).toEqual({
      code: 'insufficient_project_role',
      message: 'Your role in this project does not permit this action',
    })
    expect(handler).not.toHaveBeenCalled()
    expect(auditWriter).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'project.write_denied',
        projectId: PROJECT_ID,
        callerId: 'stub-user',
        effectiveRole: 'viewer',
        minimumProjectRole: 'member',
        method: 'POST',
        route: `${PREFIX}${WRITE_URL}`,
      }),
      'Project write denied by project role'
    )
  })

  it('resolves the role from the request transaction, the caller and the :projectId param', async () => {
    effectiveProjectRoleForCaller.mockResolvedValue('member')
    const { route, handler } = register()

    const { reply } = await invoke(route)

    expect(reply.statusCode).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
    expect(effectiveProjectRoleForCaller).toHaveBeenCalledWith(
      expect.objectContaining({ execute: expect.any(Function) }),
      expect.objectContaining({ userId: 'stub-user', orgRole: 'member' }),
      PROJECT_ID
    )
  })

  it.each(['PUT', 'PATCH', 'DELETE'] as const)('gates %s like POST', async (method) => {
    effectiveProjectRoleForCaller.mockResolvedValue('viewer')
    const { route, handler } = register({ method })

    const { reply } = await invoke(route)

    expect(reply.statusCode).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('never gates a read under :projectId', async () => {
    const { route, handler } = register({ method: 'GET' })

    await invoke(route)

    expect(handler).toHaveBeenCalledOnce()
    expect(effectiveProjectRoleForCaller).not.toHaveBeenCalled()
  })

  it('never gates a write without a :projectId segment', async () => {
    const { route, handler } = register({ url: '/:projectIdentifier/things' })

    await invoke(route)

    expect(handler).toHaveBeenCalledOnce()
    expect(effectiveProjectRoleForCaller).not.toHaveBeenCalled()
  })

  it("an explicit 'viewer' skips the check (every caller meets it)", async () => {
    const { route, handler } = register({
      security: { minimumProjectRole: 'viewer' },
    })

    await invoke(route)

    expect(handler).toHaveBeenCalledOnce()
    expect(effectiveProjectRoleForCaller).not.toHaveBeenCalled()
  })

  it('an explicit higher role refuses a project member', async () => {
    effectiveProjectRoleForCaller.mockResolvedValue('member')
    const { route, handler } = register({ security: { minimumProjectRole: 'admin' } })

    const { reply } = await invoke(route)

    expect(reply.statusCode).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('keeps the org-role floor first: a caller below minimumRole never reaches the project check', async () => {
    const { route, handler } = register({ security: { minimumRole: 'admin' } })

    const { reply } = await invoke(route)

    expect(reply.body).toMatchObject({ code: 'insufficient_role' })
    expect(handler).not.toHaveBeenCalled()
    expect(effectiveProjectRoleForCaller).not.toHaveBeenCalled()
  })

  it('fails closed when the role lookup throws (the handler never runs)', async () => {
    effectiveProjectRoleForCaller.mockRejectedValue(new Error('db down'))
    const { route, handler } = register()

    await expect(invoke(route)).rejects.toThrow('db down')
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses at registration a declared role on a URL without :projectId', () => {
    expect(() => register({ url: '/things', security: { minimumProjectRole: 'member' } })).toThrow(
      'SecureRoute: minimumProjectRole requires a :projectId route parameter'
    )
  })

  describe('a gated write without org scope (Story 69.18)', () => {
    const unscoped = { security: { requireOrgScope: false, writeAuditEvent: false } } as const

    it('refuses a project viewer from its own org-scoped read, before the handler', async () => {
      effectiveProjectRoleForCaller.mockResolvedValue('viewer')
      const db = stubDb()
      const { route, handler } = register({ ...unscoped, db })

      const { reply } = await invoke(route)

      expect(reply.statusCode).toBe(403)
      expect(reply.body).toMatchObject({ code: 'insufficient_project_role' })
      expect(handler).not.toHaveBeenCalled()
      expect(db.tx.execute).toHaveBeenCalledOnce()
      expect(effectiveProjectRoleForCaller).toHaveBeenCalledWith(
        db.tx,
        expect.objectContaining({ userId: 'stub-user' }),
        PROJECT_ID
      )
    })

    it('lets a project member through to a handler that gets no PV transaction', async () => {
      effectiveProjectRoleForCaller.mockResolvedValue('member')
      const { route, handler } = register({ ...unscoped, db: stubDb() })

      const { reply } = await invoke(route)

      expect(reply.statusCode).toBe(200)
      expect(handler).toHaveBeenCalledOnce()
      expect(handler.mock.calls.at(0)?.at(0)).not.toHaveProperty('tx')
    })

    it('fails closed when the role lookup throws', async () => {
      effectiveProjectRoleForCaller.mockRejectedValue(new Error('db down'))
      const { route, handler } = register({ ...unscoped, db: stubDb() })

      await expect(invoke(route)).rejects.toThrow('db down')
      expect(handler).not.toHaveBeenCalled()
    })

    it('answers 503 and runs no handler when the RLS context cannot be set', async () => {
      const db = stubDb()
      db.tx.execute.mockRejectedValue(new Error('rls down'))
      const { route, handler } = register({ ...unscoped, db })

      const { reply } = await invoke(route)

      expect(reply.statusCode).toBe(503)
      expect(reply.body).toMatchObject({ code: 'service_unavailable' })
      expect(handler).not.toHaveBeenCalled()
      expect(effectiveProjectRoleForCaller).not.toHaveBeenCalled()
    })
  })

  it('refuses at registration a PV project write on an anonymous route', () => {
    expect(() => register({ security: { requireAuth: false, writeAuditEvent: false } })).toThrow(
      'SecureRoute: minimumProjectRole requires requireAuth'
    )
  })

  it('records the resolved gate in the per-app registry', () => {
    const registry = new Map<string, SecureRouteRegistration>()
    register({}, registry)
    register({ method: 'GET' }, registry)

    expect(registry.get(`POST ${PREFIX}${WRITE_URL}`)?.minimumProjectRole).toBe('member')
    expect(registry.get(`GET ${PREFIX}${WRITE_URL}`)?.minimumProjectRole).toBeNull()
  })

  it("keeps PV's gate on an override that does not replace security", async () => {
    effectiveProjectRoleForCaller.mockResolvedValue('viewer')
    const cm = vi.fn(async () => ({ data: { source: 'cm' } }))
    const key = `POST ${PREFIX}${WRITE_URL}`
    const table = tableFor(
      { override: [{ method: 'POST', url: `${PREFIX}${WRITE_URL}`, mode: 'replace' }] },
      { [key]: { handler: cm } }
    )
    const instance = stubInstance({ prefix: PREFIX, table })
    secureRoute(instance as never, {
      method: 'POST',
      url: WRITE_URL,
      db: stubDb(),
      auditWriter: vi.fn(async () => undefined),
      handler: vi.fn(),
    })

    const { reply } = await invoke(onlyRoute(instance))

    expect(reply.statusCode).toBe(403)
    expect(cm).not.toHaveBeenCalled()
  })
})
