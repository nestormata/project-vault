import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerExtension } from '@project-vault/extension-api'
import extension, {
  BOOT_FAULT_ENV,
  MOCK_UI_PACK_EXTENSION_NAME,
  MOCK_UI_PACK_LOW_LIMIT,
} from './index.js'

const PROJECT_URL = '/api/v1/projects/:projectId'
const PROJECT_ROUTE = `GET ${PROJECT_URL}`
const CREATE_DOCUMENT = 'POST /api/v1/cm/documents'
const REPLACED_ROUTE = 'GET /api/v1/users/me'
const HEAD_ROUTE = `HEAD ${PROJECT_URL}`
const MISSING_ROUTE = 'GET /api/v1/mock-ui-pack-no-such-route'

type Handler = (...args: unknown[]) => Promise<unknown>
function handlerOf(key: string): Handler {
  const routes = new Map(Object.entries(extension.hooksFactory().apiRoutes?.routes ?? {}))
  const handler = routes.get(key)?.handler
  if (handler === undefined) throw new Error(`no handler for ${key}`)
  return handler as Handler
}

describe('mock-ui-pack module pack (Story 68.10 AC-1 M7, AC-7)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('passes registerExtension() integrity checks as shipped', () => {
    const result = registerExtension(extension.manifest, () => extension.hooksFactory())
    expect(result.manifest.name).toBe(MOCK_UI_PACK_EXTENSION_NAME)
  })

  it('declares only data in the manifest', () => {
    expect(JSON.parse(JSON.stringify(extension.manifest))).toEqual(extension.manifest)
  })

  it('covers add, wrap, replace, HEAD and both replaceSecurity directions', () => {
    const declaration = extension.manifest.apiRoutes
    const add = (declaration?.add ?? []).map((entry) => `${entry.method} ${entry.url}`)
    expect(add).toEqual(
      expect.arrayContaining([
        'GET /api/v1/cm/documents',
        CREATE_DOCUMENT,
        'POST /cm/webhooks/:provider',
        'GET /api/v1/cm/mfa',
        'GET /api/v1/cm/gated',
        'GET /api/v1/cm/limited',
      ])
    )
    const override = declaration?.override ?? []
    const byKey = new Map(override.map((entry) => [`${entry.method} ${entry.url}`, entry]))
    expect(byKey.get(PROJECT_ROUTE)).toMatchObject({ mode: 'wrap', schema: 'extend' })
    expect(byKey.get(HEAD_ROUTE)).toMatchObject({ mode: 'replace' })
    expect(byKey.get(REPLACED_ROUTE)).toMatchObject({ mode: 'replace' })
    expect(byKey.get(REPLACED_ROUTE)?.replaceSecurity).toBeUndefined()
    // exactly two security declarations, one loosening and one tightening (never silent)
    const replaced = override.filter((entry) => entry.replaceSecurity === true)
    expect(replaced.map((entry) => `${entry.method} ${entry.url}`).sort()).toEqual([
      'GET /api/v1/capabilities',
      'POST /api/v1/auth/cli-login',
    ])
  })

  it('the mutating add route writes the pack event through PV default audit and the webhook is public', () => {
    const add = extension.manifest.apiRoutes?.add ?? []
    const post = add.find((entry) => `${entry.method} ${entry.url}` === CREATE_DOCUMENT)
    expect(post?.options?.security?.writeAuditEvent).toEqual({
      eventType: 'cm.document.created',
      resourceType: 'cm_document',
    })
    const hook = add.find((entry) => entry.url === '/cm/webhooks/:provider')
    expect(hook?.options?.security).toMatchObject({ requireAuth: false })
  })

  it('the limited add route has its own low explicit limit and no other add route does', () => {
    const add = extension.manifest.apiRoutes?.add ?? []
    const limited = add.filter((entry) => {
      const limit = entry.options?.security?.rateLimit
      return typeof limit === 'object'
    })
    expect(limited.map((entry) => entry.url)).toEqual(['/api/v1/cm/limited'])
    expect(limited[0]?.options?.security?.rateLimit).toMatchObject({ max: MOCK_UI_PACK_LOW_LIMIT })
  })

  it('reads tenant rows only through ctx.tx and never opens a database client of its own', async () => {
    const executed: string[] = []
    const ctx = {
      auth: { orgId: 'org-1' },
      tx: {
        execute: async (query: string) => {
          executed.push(query)
          return [{ id: 'p1' }, { id: 'p2' }]
        },
      },
    }
    await expect(handlerOf('GET /api/v1/cm/documents')(ctx)).resolves.toEqual({
      data: { orgId: 'org-1', visibleProjectIds: ['p1', 'p2'] },
    })
    expect(executed).toEqual(['select id from projects order by id'])
  })

  it('the wrap extends PV data and keeps its fields; a sent reply is passed through', async () => {
    const wrap = handlerOf(PROJECT_ROUTE)
    const reply = { sent: false, header: () => undefined }
    const out = await wrap({}, {}, reply, async () => ({ data: { id: 'p1', name: 'N' } }))
    expect(out).toEqual({ data: { id: 'p1', name: 'N', cmTiles: ['mock-ui-pack:m7-tile-p1'] } })
    const sent = await wrap({}, {}, { ...reply, sent: true }, async () => 'already')
    expect(sent).toBe('already')
  })

  it('the explicit HEAD handler sets its own header and an empty body', async () => {
    const headers = new Map<string, string>()
    const reply = { sent: false, header: (n: string, v: string) => headers.set(n, v) }
    await expect(handlerOf(HEAD_ROUTE)({}, {}, reply)).resolves.toBe('')
    expect(headers.get('x-cm-head')).toBe('explicit')
  })

  it('the pack gate denies exactly the write capability and permits the rest', async () => {
    const gate = extension.hooksFactory().capabilityGate
    const decide = async (capability: string) =>
      gate?.onCheckCapability({ capability } as Parameters<typeof gate.onCheckCapability>[0])
    await expect(decide('cm.documents.write')).resolves.toMatchObject({ permitted: false })
    await expect(decide('cm.documents.read')).resolves.toEqual({ permitted: true })
  })

  it('every other handler answers its own sentinel, so a spec cannot pass on a neighbour', async () => {
    const answers: Array<[string, unknown]> = [
      ['POST /cm/webhooks/:provider', { received: 'acme' }],
      ['GET /api/v1/cm/mfa', { data: 'mock-ui-pack:m7-mfa-ok' }],
      ['GET /api/v1/cm/gated', { data: 'mock-ui-pack:m7-gated-ok' }],
      ['GET /api/v1/cm/own-capability', { data: 'mock-ui-pack:m7-capability-ok' }],
      ['GET /api/v1/cm/limited', { data: 'mock-ui-pack:m7-limited-ok' }],
      [REPLACED_ROUTE, { data: { cm: 'mock-ui-pack:m7-replaced' } }],
      ['POST /api/v1/auth/cli-login', { cm: 'mock-ui-pack:m7-loosened' }],
      ['GET /api/v1/capabilities', { data: { capabilities: {} } }],
    ]
    for (const [key, expected] of answers) {
      await expect(handlerOf(key)({}, { params: { provider: 'acme' } })).resolves.toEqual(expected)
    }
  })

  it('the document create route echoes the title and tolerates a missing one', async () => {
    const create = handlerOf(CREATE_DOCUMENT)
    await expect(create({}, { body: { title: 'T' } })).resolves.toEqual({
      data: { ok: true, title: 'T' },
    })
    await expect(create({}, { body: {} })).resolves.toEqual({ data: { ok: true, title: null } })
  })

  it('the boot fault switch adds a wrap of a PV route that does not exist, only when set', () => {
    const keys = () =>
      (extension.manifest.apiRoutes?.override ?? []).map((entry) => `${entry.method} ${entry.url}`)
    expect(keys()).not.toContain(MISSING_ROUTE)
    vi.stubEnv(BOOT_FAULT_ENV, 'missing-target')
    expect(keys()).toContain(MISSING_ROUTE)
    // the hooks implement the faulty route too, so the failure is the missing PV target
    const routes = extension.hooksFactory().apiRoutes?.routes ?? {}
    expect(Object.keys(routes)).toContain(MISSING_ROUTE)
  })

  it('an unknown fault value is ignored (the switch can only make boot fail, never open anything)', () => {
    vi.stubEnv(BOOT_FAULT_ENV, 'open-everything')
    expect(extension.manifest.apiRoutes?.override?.map((entry) => entry.url)).not.toContain(
      '/api/v1/mock-ui-pack-no-such-route'
    )
    expect(() =>
      registerExtension(extension.manifest, () => extension.hooksFactory())
    ).not.toThrow()
  })
})
