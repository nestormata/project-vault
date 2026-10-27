import { afterEach, describe, expect, it } from 'vitest'
import { checkProjectWriteRoles, registerExtension } from '@project-vault/extension-api'
import extension, {
  observed,
  resetObserved,
  setApiRoutesScenario,
  type ApiRoutesScenario,
} from './index.js'

const PROJECT_ROLE = 'project-role'

const VALID_SCENARIOS: ApiRoutesScenario[] = [
  'default',
  'missing-target',
  'collision',
  'bad-schema',
  'never-refused',
  'old-pack',
  'app-wrap',
  'app-replace',
  'app-throwing-wrap',
  'app-throwing-replace',
  'app-hooks-prepend',
  'app-hooks-append',
  'app-hooks-throw',
  PROJECT_ROLE,
  'project-role-legacy',
]

const PROJECT_ROUTE = 'GET /api/v1/projects/:projectId'

function routeCaller() {
  const routes = new Map(Object.entries(extension.hooksFactory().apiRoutes?.routes ?? {}))
  return (key: string, ...args: unknown[]) =>
    (routes.get(key)?.handler as (...a: unknown[]) => Promise<unknown>)(...args)
}

describe('mock-api-routes-extension', () => {
  afterEach(() => {
    setApiRoutesScenario('default')
    resetObserved()
  })

  it.each(VALID_SCENARIOS)(
    'the %s scenario passes registerExtension() integrity checks',
    (name) => {
      setApiRoutesScenario(name)
      const result = registerExtension(extension.manifest, () => extension.hooksFactory())
      expect(result.manifest.name).toBe('test.mock-api-routes-extension')
      expect(observed.hooksFactoryCalls).toBe(1)
    }
  )

  it('the above-host scenario fails negotiation before hooksFactory() runs', () => {
    setApiRoutesScenario('above-host')
    expect(() => registerExtension(extension.manifest, () => extension.hooksFactory())).toThrow()
    expect(observed.hooksFactoryCalls).toBe(0)
  })

  it('the project-role handlers count and name their route (Story 69.18)', async () => {
    setApiRoutesScenario(PROJECT_ROLE)
    const call = routeCaller()
    const keys = Object.keys(extension.hooksFactory().apiRoutes?.routes ?? {})
    for (const key of keys) expect(await call(key)).toEqual({ data: { route: key } })
    expect([...observed.calls.keys()].sort()).toEqual([...keys].sort())
  })

  it('the project-role scenario owns one ungated project write on purpose (Story 69.18)', () => {
    setApiRoutesScenario(PROJECT_ROLE)
    const current = checkProjectWriteRoles(extension.manifest)
    expect(current.routes.filter((route) => route.ungated !== null)).toEqual([
      {
        route: 'POST /api/v1/cm/projects/:projectId/notes/narrow',
        minimumProjectRole: null,
        ungated: 'declared_viewer',
      },
      {
        route: 'POST /api/v1/projects/:projectId/unarchive',
        minimumProjectRole: null,
        ungated: 'declared_viewer',
      },
    ])
    setApiRoutesScenario('project-role-legacy')
    expect(checkProjectWriteRoles(extension.manifest).routes.map((route) => route.ungated)).toEqual(
      [
        'legacy_contract',
        'declared_viewer',
        null,
        'legacy_contract',
        'legacy_contract',
        'declared_viewer',
      ]
    )
  })

  it('declares only data in the manifest and keeps every function in the hooks', () => {
    const serialized = JSON.stringify(extension.manifest)
    expect(JSON.parse(serialized)).toEqual(extension.manifest)
  })

  it('the default handlers behave as the integration tests expect', async () => {
    const call = routeCaller()
    const headers = new Map<string, string>()
    const reply = { sent: false, header: (name: string, value: string) => headers.set(name, value) }
    const executed: string[] = []
    const ctx = {
      auth: { orgId: 'org-1' },
      tx: {
        execute: async (query: string) => {
          executed.push(query)
          return [{ id: 'p1' }]
        },
      },
    }

    await expect(call('GET /api/v1/cm/documents', ctx)).resolves.toEqual({
      data: { orgId: 'org-1', visibleProjectIds: ['p1'] },
    })
    await expect(call('POST /cm/x', ctx, { body: {} })).resolves.toEqual({ data: { ok: true } })
    await expect(call('POST /cm/x', ctx, { body: { fail: true } })).rejects.toThrow(
      'fixture write failed'
    )
    expect(executed.filter((query) => query.startsWith('insert'))).toHaveLength(2)

    await expect(
      call(PROJECT_ROUTE, ctx, {}, reply, async () => ({ data: { id: 'p1' } }))
    ).resolves.toEqual({ data: { id: 'p1', cmTiles: ['tile-for-p1'] } })
    const sentReply = { ...reply, sent: true }
    await expect(call(PROJECT_ROUTE, ctx, {}, sentReply, async () => 'pv-reply')).resolves.toBe(
      'pv-reply'
    )

    await expect(call('HEAD /api/v1/projects/:projectId', ctx, {}, reply)).resolves.toBe('')
    expect(headers.get('x-cm-head')).toBe('explicit')

    await expect(call('GET /health', {}, reply, async () => 'pv-health')).resolves.toBe('pv-health')
    const onSend = extension.hooksFactory().apiRoutes?.routes?.['GET /health']?.hooks?.onSend as (
      ...a: unknown[]
    ) => Promise<unknown>
    await expect(onSend({}, {}, '{"status":"ok"}')).resolves.toBe('{"status":"ok","cm":"ok"}')
    await expect(onSend({}, {}, 'plain')).resolves.toBe('plain')

    await expect(
      call('POST /cm/webhooks/:provider', {}, { params: { provider: 'stripe' } })
    ).resolves.toEqual({
      received: 'stripe',
    })
    await expect(call('GET /api/v1/dashboard', {})).resolves.toEqual({ cm: 'dashboard' })
    await expect(call('GET /api/v1/cm/gated')).resolves.toEqual({ data: 'gated-ok' })
  })

  it('the remaining default handlers return their fixed bodies', async () => {
    const call = routeCaller()

    await expect(call('GET /api/v1/cm/mfa')).resolves.toEqual({ data: 'mfa-ok' })
    await expect(call('GET /api/v1/cm/operator')).resolves.toEqual({ data: 'operator-ok' })
    await expect(call('GET /api/v1/auth/login')).resolves.toEqual({ cm: 'login-get' })
    await expect(call('POST /api/v1/vault/unseal')).resolves.toEqual({ cm: 'unseal' })
    await expect(call('POST /api/v1/auth/cli-login')).resolves.toEqual({ cm: 'cli' })
    await expect(call('GET /api/v1/docs/yaml')).resolves.toBe('cm: yaml')
    await expect(call('GET /api/v1/capabilities')).resolves.toEqual({ capabilities: {} })
    await expect(call('GET /api/v1/cm/own-capability')).resolves.toEqual({
      data: 'cm-capability-ok',
    })
    await expect(call('GET /api/v1/cm/own-capability-denied')).resolves.toEqual({
      data: 'never reached',
    })
    expect(observed.calls.get('GET /api/v1/cm/own-capability')).toBe(1)
    expect(observed.calls.get('GET /api/v1/cm/own-capability-denied')).toBe(1)

    await expect(
      call('GET /api/v1/status-pages/:token', { tx: {} }, {}, {}, async () => 'pv-status')
    ).resolves.toBe('pv-status')
    expect(observed.contexts).toContainEqual({
      route: 'GET /api/v1/status-pages/:token',
      ctxKeys: ['tx'],
    })
  })

  it.each([
    ['collision', 'GET /api/v1/projects', { cm: true }],
    ['bad-schema', PROJECT_ROUTE, {}],
  ] as const)('the %s scenario handler for %s returns %j', async (name, key, body) => {
    setApiRoutesScenario(name)
    await expect(routeCaller()(key)).resolves.toEqual(body)
  })

  it('a stored next() called after the wrap settled is recorded, not run', async () => {
    const routes = new Map(Object.entries(extension.hooksFactory().apiRoutes?.routes ?? {}))
    let settled = false
    const next = async () => {
      if (settled) throw new Error('after settle')
      return 'pv'
    }
    const handler = routes.get('GET /api/v1/users/me')?.handler as (
      ...a: unknown[]
    ) => Promise<unknown>
    await expect(handler({}, {}, {}, next)).resolves.toBe('pv')
    settled = true
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(observed.lateNextErrors).toEqual(['after settle'])
  })

  it('registers an auth strategy (used to prove local-first wiring order)', async () => {
    await expect(extension.hooksFactory().authStrategy?.onAuthenticate('x')).resolves.toEqual({
      externalSubject: 'fixture-subject',
      providerName: 'mock-api-routes',
    })
  })

  it('the capability gate denies the gated PV capability only', async () => {
    const gate = extension.hooksFactory().capabilityGate
    await expect(
      gate?.onCheckCapability({ capability: 'monitoring.public-status-page' } as never)
    ).resolves.toMatchObject({
      permitted: false,
    })
    await expect(gate?.onCheckCapability({ capability: 'cm.other' } as never)).resolves.toEqual({
      permitted: true,
    })
  })

  describe('Story 68.14 app-level scenarios', () => {
    const appHandlers = () => extension.hooksFactory().apiRoutes?.app

    it('app-wrap delegates a non-CM error and maps CmError to 409', async () => {
      setApiRoutesScenario('app-wrap')
      const handler = appHandlers()?.errorHandler as (...a: unknown[]) => Promise<unknown>
      const sent: unknown[] = []
      const reply = {
        status: (code: number) => ({ send: (body: unknown) => sent.push([code, body]) }),
      }
      const next = async () => 'pv'
      const { CmError } = await import('./index.js')
      await handler(new CmError('x'), {}, reply, next)
      expect(sent).toEqual([[409, { code: 'cm_conflict' }]])
      expect(await handler(new Error('plain'), {}, reply, next)).toBe('pv')
    })

    it('app-throwing-replace throws from the error handler and rejects from the not-found handler', async () => {
      setApiRoutesScenario('app-throwing-replace')
      const app = appHandlers()
      expect(() =>
        (app?.errorHandler as (...a: unknown[]) => unknown)(new Error('x'), {}, {})
      ).toThrow(TypeError)
      await expect(
        (app?.notFoundHandler as (...a: unknown[]) => Promise<unknown>)({}, {})
      ).rejects.toBeInstanceOf(TypeError)
    })

    it('records hook order in observed.hookOrder', () => {
      setApiRoutesScenario('app-hooks-prepend')
      const hooks = appHandlers()?.hooks
      const fn = hooks?.onRequest as (...a: unknown[]) => unknown
      fn({}, { getHeader: () => undefined }, () => undefined)
      expect(observed.hookOrder).toEqual([{ phase: 'onRequest', requestIdHeader: false }])
    })

    it('app-wrap answers CM paths itself and delegates every other not-found to PV', async () => {
      setApiRoutesScenario('app-wrap')
      const notFound = appHandlers()?.notFoundHandler as (...a: unknown[]) => Promise<unknown>
      const sent: unknown[] = []
      const reply = {
        status: (code: number) => ({ send: (body: unknown) => sent.push([code, body]) }),
      }
      await notFound({ url: '/cm/missing' }, reply, async () => 'pv')
      expect(sent).toEqual([[404, { code: 'cm_not_found' }]])
      await expect(notFound({ url: '/api/v1/missing' }, reply, async () => 'pv')).resolves.toBe(
        'pv'
      )
    })

    it('app-replace answers every error and not-found with its own body', async () => {
      setApiRoutesScenario('app-replace')
      const app = appHandlers()
      const sent: unknown[] = []
      const reply = {
        status: (code: number) => ({ send: (body: unknown) => sent.push([code, body]) }),
      }
      await (app?.errorHandler as (...a: unknown[]) => Promise<unknown>)(
        new RangeError('x'),
        {},
        reply
      )
      await (app?.notFoundHandler as (...a: unknown[]) => Promise<unknown>)({}, reply)
      expect(sent).toEqual([
        [418, { code: 'cm_teapot', errorName: 'RangeError' }],
        [404, { code: 'cm_nope' }],
      ])
      expect(observed.errorHandlerErrors).toEqual(['RangeError'])
    })

    it('the app error routes throw a CmError, a plain error and a 400 error', async () => {
      setApiRoutesScenario('app-wrap')
      const call = routeCaller()
      await expect(call('GET /cm/boom')).rejects.toMatchObject({ name: 'CmError' })
      await expect(call('GET /cm/plain-error')).rejects.toThrow('plain failure')
      await expect(call('GET /cm/status-error')).rejects.toMatchObject({ statusCode: 400 })
    })
  })

  describe('Story 65.6 credential-sharing scenario', () => {
    type Calls = Array<[string, Record<string, unknown>]>

    function fakeHost(calls: Calls, revokeError?: unknown) {
      const record = (name: string) => async (input: Record<string, unknown>) => {
        calls.push([name, input])
        if (name === 'revokeShare' && revokeError !== undefined) throw revokeError
        return { status: 'ok', name }
      }
      return {
        credentialSharing: {
          createExternalShare: record('createExternalShare'),
          listSharesForCredential: record('listSharesForCredential'),
          revokeShare: record('revokeShare'),
        },
      }
    }

    function sharingCaller(host: unknown) {
      setApiRoutesScenario('credential-sharing')
      const routes = new Map(
        Object.entries(extension.hooksFactory(host as never).apiRoutes?.routes ?? {})
      )
      return (key: string, ...args: unknown[]) =>
        (routes.get(key)?.handler as (...a: unknown[]) => Promise<unknown>)(...args)
    }

    const REVOKE = 'POST /api/v1/cm/shares/revoke'

    const ctx = { auth: { orgId: 'org-1', userId: 'user-1' } }
    const ids = { projectId: 'p1', credentialId: 'c1' }

    it('needs the real HostServices to build its routes', () => {
      setApiRoutesScenario('credential-sharing')
      expect(() => extension.hooksFactory()).toThrow('needs the real HostServices')
    })

    it('creates a share without actingUserId and forwards a field key only when given', async () => {
      const calls: Calls = []
      const call = sharingCaller(fakeHost(calls))
      await expect(call('POST /api/v1/cm/shares', ctx, { body: ids })).resolves.toEqual({
        data: { status: 'ok', name: 'createExternalShare' },
      })
      await call('POST /api/v1/cm/shares', ctx, { body: { ...ids, fieldKey: 'password' } })
      const [plain, withField] = calls.map(([, input]) => input)
      expect(plain).toMatchObject({ organizationId: 'org-1', ...ids })
      expect(plain).not.toHaveProperty('fieldKey')
      expect(plain).not.toHaveProperty('actingUserId')
      expect(withField).toMatchObject({ fieldKey: 'password' })
    })

    it('lists shares with the signed-in user as viewer', async () => {
      const calls: Calls = []
      const call = sharingCaller(fakeHost(calls))
      await call('GET /api/v1/cm/shares', ctx, { query: { credentialId: 'c1' } })
      expect(calls).toEqual([
        [
          'listSharesForCredential',
          { organizationId: 'org-1', credentialId: 'c1', viewer: { userId: 'user-1' } },
        ],
      ])
    })

    it('revokes with the signed-in user as actor and turns a failure into its error code', async () => {
      const calls: Calls = []
      const body = { ...ids, shareId: 's1' }
      await expect(sharingCaller(fakeHost(calls))(REVOKE, ctx, { body })).resolves.toEqual({
        data: { status: 'ok', name: 'revokeShare' },
      })
      expect(calls[0]?.[1]).toMatchObject({ shareId: 's1', actor: { userId: 'user-1' } })

      const coded = sharingCaller(fakeHost([], { code: 'share_not_found' }))
      await expect(coded(REVOKE, ctx, { body })).resolves.toEqual({
        data: { status: 'error', code: 'share_not_found' },
      })
      const uncoded = sharingCaller(fakeHost([], new Error('no code')))
      await expect(uncoded(REVOKE, ctx, { body })).resolves.toEqual({
        data: { status: 'error', code: null },
      })
    })
  })

  it('reads no rows from a non-array result and answers a webhook without a provider', async () => {
    const call = routeCaller()
    const ctx = { auth: { orgId: 'org-1' }, tx: { execute: async () => ({ rowCount: 0 }) } }
    await expect(call('GET /api/v1/cm/documents', ctx)).resolves.toEqual({
      data: { orgId: 'org-1', visibleProjectIds: [] },
    })
    await expect(call('POST /cm/webhooks/:provider', {}, {})).resolves.toEqual({ received: null })
  })
})
