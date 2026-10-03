import { describe, expect, it, vi } from 'vitest'
import { ExtensionRegistrationError } from './errors.js'
import { EXTENSION_API_VERSION } from './manifest.js'
import type { ExtensionManifest } from './manifest.js'
import { registerExtension } from './register-extension.js'
import type { ExtensionHooks } from './register-extension.js'
import type { ApiRoutesDeclaration, ApiRoutesHooks } from './hooks/api-routes.js'

const NAME = 'com.acme.api-routes'
const DOCS_URL = '/api/v1/cm/documents'
const DOCS_KEY = `GET ${DOCS_URL}` as const
const handler = () => ({ ok: true })

function manifestWith(
  apiRoutes: unknown,
  extra: Partial<ExtensionManifest> = {}
): ExtensionManifest {
  return {
    name: NAME,
    apiVersion: EXTENSION_API_VERSION,
    capabilities: [],
    ...extra,
    apiRoutes: apiRoutes as ApiRoutesDeclaration,
  }
}

function hooksFor(routes: ApiRoutesHooks['routes']): () => ExtensionHooks {
  return () => ({ apiRoutes: { routes } })
}

function implementationsFor(declaration: ApiRoutesDeclaration): ApiRoutesHooks['routes'] {
  const entries = [...(declaration.add ?? []), ...(declaration.override ?? [])]
  return Object.fromEntries(entries.map((entry) => [`${entry.method} ${entry.url}`, { handler }]))
}

function expectInvalid(
  apiRoutes: unknown,
  messagePart: string,
  hooks?: () => ExtensionHooks
): void {
  let caught: unknown
  try {
    registerExtension(manifestWith(apiRoutes), hooks ?? (() => ({})))
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ExtensionRegistrationError)
  expect((caught as ExtensionRegistrationError).reason).toBe('invalid-manifest-field')
  expect((caught as Error).message).toContain(messagePart)
}

describe('Story 68.8 AC-1 — apiRoutes on the manifest and hooks', () => {
  it('returns apiRoutes on the registered manifest, deep-equal to the input, with no unknown-key warn', () => {
    const declaration: ApiRoutesDeclaration = { add: [{ method: 'GET', url: DOCS_URL }] }
    const warn = vi.fn()
    const result = registerExtension(
      manifestWith(declaration),
      hooksFor({ [DOCS_KEY]: { handler } }),
      { logger: { warn } }
    )
    expect(result.manifest.apiRoutes).toEqual(declaration)
    const routes = new Map(Object.entries(result.hooks.apiRoutes?.routes ?? {}))
    expect(routes.get(DOCS_KEY)?.handler).toBe(handler)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a manifest without apiRoutes registers exactly as before', () => {
    const result = registerExtension(
      { name: NAME, apiVersion: EXTENSION_API_VERSION, capabilities: [] },
      () => ({})
    )
    expect(result.manifest.apiRoutes).toBeUndefined()
  })

  it.each(['apiroutes', 'ApiRoutes'])('a case near-miss key "%s" fails the load', (key) => {
    const manifest = {
      name: NAME,
      apiVersion: EXTENSION_API_VERSION,
      capabilities: [],
      [key]: { add: [] },
    } as unknown as ExtensionManifest
    expect(() => registerExtension(manifest, () => ({}))).toThrow(ExtensionRegistrationError)
  })

  it('an unknown top-level apiRoutes key still fails (apiRoutes.app became valid in 3.29.0)', () => {
    expectInvalid({ apps: { errorHandler: 'wrap' } }, 'apiRoutes has unknown key "apps"')
  })
})

describe('Story 68.8 AC-2 — apiRoutes validation checks integrity only', () => {
  it('accepts routes at any URL with no capability, public-route allowlist or redirect origins', () => {
    const declaration: ApiRoutesDeclaration = {
      add: [
        { method: 'GET', url: DOCS_URL },
        {
          method: 'POST',
          url: '/cm/webhooks/:provider',
          options: { security: { requireAuth: false } },
        },
        { method: 'GET', url: '/billing/invoices/*' },
        { method: 'GET', url: '/', options: { security: { requireAuth: false } } },
        { method: 'OPTIONS', url: '/cm/x' },
        { method: 'HEAD', url: '/cm/x' },
      ],
      override: [{ method: 'GET', url: '/api/v1/projects/:projectId', mode: 'wrap' }],
    }
    const result = registerExtension(
      manifestWith(declaration),
      hooksFor(implementationsFor(declaration))
    )
    expect(result.manifest.apiRoutes).toEqual(declaration)
  })

  it('has no count cap: 500 add entries register', () => {
    const add = Array.from({ length: 500 }, (_, index) => ({
      method: 'GET' as const,
      url: `/cm/route-${index}`,
    }))
    const declaration: ApiRoutesDeclaration = { add }
    const result = registerExtension(
      manifestWith(declaration),
      hooksFor(implementationsFor(declaration))
    )
    expect(result.manifest.apiRoutes?.add).toHaveLength(500)
  })

  it('accepts empty declarations as no-ops', () => {
    expect(() => registerExtension(manifestWith({}), () => ({}))).not.toThrow()
    expect(() => registerExtension(manifestWith({ add: [] }), () => ({}))).not.toThrow()
    expect(() => registerExtension(manifestWith({ override: [] }), () => ({}))).not.toThrow()
  })

  it('never reads capabilities, anonymousRoutePaths or redirectOrigins', () => {
    const declaration: ApiRoutesDeclaration = {
      add: [{ method: 'GET', url: '/cm/public', options: { security: { requireAuth: false } } }],
    }
    const manifest = manifestWith(declaration)
    const reads: string[] = []
    const watched = new Proxy(manifest, {
      get(target, property, receiver) {
        if (typeof property === 'string') reads.push(property)
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    registerExtension(watched, hooksFor(implementationsFor(declaration)))
    // Other validators read `capabilities` for their own fields; the apiRoutes validators receive
    // only the apiRoutes value itself, so the read list does not grow because of apiRoutes.
    const baseline: string[] = []
    const plain = { name: NAME, apiVersion: EXTENSION_API_VERSION, capabilities: [] }
    registerExtension(
      new Proxy(plain, {
        get(target, property, receiver) {
          if (typeof property === 'string') baseline.push(property)
          return Reflect.get(target, property, receiver) as unknown
        },
      }),
      () => ({})
    )
    const extra = reads.filter((key) => key !== 'apiRoutes')
    expect(extra.filter((key) => key === 'anonymousRoutePaths')).toHaveLength(
      baseline.filter((key) => key === 'anonymousRoutePaths').length
    )
    expect(extra.filter((key) => key === 'redirectOrigins')).toHaveLength(
      baseline.filter((key) => key === 'redirectOrigins').length
    )
    expect(extra.filter((key) => key === 'capabilities')).toHaveLength(
      baseline.filter((key) => key === 'capabilities').length
    )
  })

  it('a public-route manifest still needs anonymousRoutePaths (existing gates unchanged)', () => {
    expect(() =>
      registerExtension(manifestWith({}, { capabilities: ['public-route'] }), () => ({}))
    ).toThrow(ExtensionRegistrationError)
  })

  describe('failure examples (each message names the offending entry)', () => {
    it('apiRoutes must be an object', () => {
      expectInvalid([], 'apiRoutes must be an object')
    })

    it('add must be an array', () => {
      expectInvalid({ add: {} }, 'apiRoutes.add must be an array')
    })

    it('an entry must be an object', () => {
      expectInvalid({ override: ['GET /x'] }, 'apiRoutes.override[0] must be an object')
    })

    it('lowercase method', () => {
      expectInvalid(
        { add: [{ method: 'get', url: '/x' }] },
        'apiRoutes.add[0].method must be one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'
      )
    })

    it('url without a leading slash', () => {
      expectInvalid(
        { add: [{ method: 'GET', url: 'api/v1/x' }] },
        'apiRoutes.add[0].url must start with /'
      )
    })

    it.each([
      ['/x?y=1', 'query'],
      ['/x#frag', 'fragment'],
      ['/a b', 'space'],
      ['/a\tb', 'tab'],
      ['/a\u0000b', 'control'],
    ])('url %j (%s) is rejected', (url) => {
      expectInvalid({ add: [{ method: 'GET', url }] }, 'apiRoutes.add[0].url')
    })

    it('url longer than 2048 characters', () => {
      expectInvalid({ add: [{ method: 'GET', url: `/${'a'.repeat(2048)}` }] }, 'at most 2048')
    })

    it('a non-string url', () => {
      expectInvalid({ add: [{ method: 'GET', url: 42 }] }, 'apiRoutes.add[0].url must be a string')
    })

    it('duplicate GET /x in add', () => {
      expectInvalid(
        {
          add: [
            { method: 'GET', url: '/x' },
            { method: 'GET', url: '/x' },
          ],
        },
        'apiRoutes.add[1] duplicates GET /x'
      )
    })

    it('GET /x in both add and override', () => {
      expectInvalid(
        {
          add: [{ method: 'GET', url: '/x' }],
          override: [{ method: 'GET', url: '/x', mode: 'replace' }],
        },
        'apiRoutes.override[0] duplicates GET /x'
      )
    })

    it("mode 'merge'", () => {
      expectInvalid(
        { override: [{ method: 'GET', url: '/x', mode: 'merge' }] },
        "apiRoutes.override[0].mode must be 'replace' or 'wrap'"
      )
    })

    it("schema 'merge'", () => {
      expectInvalid(
        { override: [{ method: 'GET', url: '/x', mode: 'wrap', schema: 'merge' }] },
        "apiRoutes.override[0].schema must be 'extend' or 'replace'"
      )
    })

    it('an unknown hook phase', () => {
      expectInvalid(
        {
          override: [
            { method: 'GET', url: '/x', mode: 'wrap', hooks: { prepend: ['onResponse'] } },
          ],
        },
        'apiRoutes.override[0].hooks.prepend[0] must be one of onRequest, preValidation, preHandler, onSend'
      )
    })

    it('an unknown hooks key on an override', () => {
      expectInvalid(
        { override: [{ method: 'GET', url: '/x', mode: 'wrap', hooks: { before: [] } }] },
        'apiRoutes.override[0].hooks has unknown key "before"'
      )
    })

    it('an unknown add option phase', () => {
      expectInvalid(
        { add: [{ method: 'GET', url: '/x', options: { hooks: ['onTimeout'] } }] },
        'apiRoutes.add[0].options.hooks[0] must be one of'
      )
    })

    it('a typo in an entry key', () => {
      expectInvalid(
        { override: [{ method: 'GET', url: '/x', mode: 'replace', replaceSecurty: true }] },
        'apiRoutes.override[0] has unknown key "replaceSecurty"'
      )
    })

    it('a typo in an add options key', () => {
      expectInvalid(
        { add: [{ method: 'GET', url: '/x', options: { secruity: {} } }] },
        'apiRoutes.add[0].options has unknown key "secruity"'
      )
    })

    it('security on an override without replaceSecurity', () => {
      expectInvalid(
        {
          override: [
            { method: 'GET', url: '/x', mode: 'replace', security: { requireAuth: false } },
          ],
        },
        'apiRoutes.override[0]: security is only honoured with replaceSecurity: true'
      )
    })

    it('a non-boolean replaceSecurity', () => {
      expectInvalid(
        { override: [{ method: 'GET', url: '/x', mode: 'replace', replaceSecurity: 'yes' }] },
        'apiRoutes.override[0].replaceSecurity must be a boolean'
      )
    })

    it('a non-object security', () => {
      expectInvalid(
        { add: [{ method: 'GET', url: '/x', options: { security: 'open' } }] },
        'apiRoutes.add[0].options.security must be an object'
      )
    })

    it('a non-boolean options.schema', () => {
      expectInvalid(
        { add: [{ method: 'GET', url: '/x', options: { schema: 'yes' } }] },
        'apiRoutes.add[0].options.schema must be a boolean'
      )
    })

    it('a non-positive bodyLimit', () => {
      expectInvalid(
        { add: [{ method: 'GET', url: '/x', options: { bodyLimit: 0 } }] },
        'apiRoutes.add[0].options.bodyLimit must be a positive integer'
      )
    })

    it('a declared add with no handler after hooksFactory()', () => {
      expectInvalid(
        { add: [{ method: 'GET', url: '/x' }] },
        'apiRoutes entry "GET /x" has no callable handler in hooks.apiRoutes.routes',
        hooksFor({})
      )
    })

    it('a declared schema with no schema value', () => {
      expectInvalid(
        { add: [{ method: 'GET', url: '/x', options: { schema: true } }] },
        'apiRoutes entry "GET /x" declares a schema but hooks.apiRoutes.routes has no schema for it',
        hooksFor({ 'GET /x': { handler } })
      )
    })

    it('a declared override schema with no schema value', () => {
      expectInvalid(
        { override: [{ method: 'GET', url: '/x', mode: 'wrap', schema: 'extend' }] },
        'declares a schema',
        hooksFor({ 'GET /x': { handler } })
      )
    })

    it('a declared hook phase with no function', () => {
      expectInvalid(
        {
          override: [
            { method: 'GET', url: '/x', mode: 'wrap', hooks: { prepend: ['preHandler'] } },
          ],
        },
        'apiRoutes entry "GET /x" declares a preHandler hook but hooks.apiRoutes.routes has no function for it',
        hooksFor({ 'GET /x': { handler } })
      )
    })

    it('a declared hook phase whose array holds a non-function', () => {
      expectInvalid(
        { add: [{ method: 'GET', url: '/x', options: { hooks: ['onSend'] } }] },
        'declares a onSend hook',
        hooksFor({ 'GET /x': { handler, hooks: { onSend: ['x' as never] } } })
      )
    })
  })

  it('accepts hook functions given as an array', () => {
    const declaration: ApiRoutesDeclaration = {
      add: [{ method: 'GET', url: '/x', options: { hooks: ['onSend'], schema: true } }],
    }
    expect(() =>
      registerExtension(
        manifestWith(declaration),
        hooksFor({ 'GET /x': { handler, schema: {}, hooks: { onSend: [() => undefined] } } })
      )
    ).not.toThrow()
  })

  it('an implementation with no declaration only warns', () => {
    const warn = vi.fn()
    registerExtension(manifestWith({}), hooksFor({ 'GET /orphan': { handler } }), {
      logger: { warn },
    })
    expect(warn).toHaveBeenCalledWith(
      'hooks.apiRoutes.routes has an implementation for undeclared key "GET /orphan"'
    )
  })
})

describe('Story 68.8 AC-2 (a) — the security object inside an entry is integrity-checked too', () => {
  const add = (security: unknown) => ({
    add: [{ method: 'GET', url: '/x', options: { security } }],
  })
  const override = (security: unknown) => ({
    override: [{ method: 'GET', url: '/x', mode: 'replace', replaceSecurity: true, security }],
  })
  const registers = (declaration: unknown) => () =>
    registerExtension(
      manifestWith(declaration),
      hooksFor(implementationsFor(declaration as ApiRoutesDeclaration))
    )

  it('a full, well-formed security object registers', () => {
    expect(
      registers(
        add({
          requireAuth: true,
          requireOrgScope: true,
          minimumRole: 'admin',
          allowedRoles: ['owner', 'admin'],
          requireMfa: true,
          requirePlatformOperator: false,
          writeAuditEvent: {
            eventType: 'cm.read',
            resourceType: 'doc',
            resourceIdFromParams: 'id',
          },
          rateLimit: { max: 10, timeWindowMs: 1000, key: 'cm' },
          capability: 'cm.documents.read',
        })
      )
    ).not.toThrow()
    expect(registers(add({ writeAuditEvent: false, rateLimit: false }))).not.toThrow()
    expect(registers(override({ requireAuth: false, rateLimit: false }))).not.toThrow()
  })

  it('a typo in a security key fails instead of silently dropping a restriction (add)', () => {
    expectInvalid(
      add({ minimumRol: 'admin' }),
      'apiRoutes.add[0].options.security has unknown key "minimumRol"'
    )
  })

  it('a typo in a security key fails instead of silently dropping a restriction (override)', () => {
    expectInvalid(
      override({ requireMFA: true }),
      'apiRoutes.override[0].security has unknown key "requireMFA"'
    )
  })

  it.each([
    [{ requireAuth: 'false' }, 'security.requireAuth must be a boolean'],
    [{ requireOrgScope: 0 }, 'security.requireOrgScope must be a boolean'],
    [{ requireMfa: 'yes' }, 'security.requireMfa must be a boolean'],
    [{ requirePlatformOperator: 1 }, 'security.requirePlatformOperator must be a boolean'],
    [{ minimumRole: 'Admin' }, 'security.minimumRole must be one of owner, admin, member, viewer'],
    [{ allowedRoles: 'admin' }, 'security.allowedRoles must be an array'],
    [{ allowedRoles: ['admin', 'root'] }, 'security.allowedRoles[1] must be one of owner'],
    [{ capability: '' }, 'security.capability must be a non-empty string'],
    [{ capability: 7 }, 'security.capability must be a non-empty string'],
    [{ rateLimit: true }, 'security.rateLimit must be false or an object'],
    [{ rateLimit: { max: 0 } }, 'security.rateLimit.max must be a positive integer'],
    [{ rateLimit: { max: '5' } }, 'security.rateLimit.max must be a positive integer'],
    [{ rateLimit: { max: 5, timeWindowMs: -1 } }, 'security.rateLimit.timeWindowMs'],
    [{ rateLimit: { max: 5, key: 3 } }, 'security.rateLimit.key must be a non-empty string'],
    [{ rateLimit: { max: 5, window: 1 } }, 'security.rateLimit has unknown key "window"'],
    [{ writeAuditEvent: 'yes' }, 'security.writeAuditEvent must be a boolean or an object'],
    [{ writeAuditEvent: {} }, 'security.writeAuditEvent.eventType must be a non-empty string'],
    [
      { writeAuditEvent: { eventType: 'x', resourceType: 1 } },
      'security.writeAuditEvent.resourceType must be a non-empty string',
    ],
    [
      { writeAuditEvent: { eventType: 'x', payload: {} } },
      'security.writeAuditEvent has unknown key "payload"',
    ],
  ])('security %j is rejected', (security, message) => {
    expectInvalid(add(security), `apiRoutes.add[0].options.${message}`)
  })

  it('entries that differ only by a trailing slash are the same route and fail as duplicates', () => {
    expectInvalid(
      {
        override: [
          { method: 'GET', url: '/x', mode: 'replace' },
          { method: 'GET', url: '/x/', mode: 'wrap' },
        ],
      },
      'apiRoutes.override[1] duplicates GET /x'
    )
  })
})

describe('Story 68.14 AC-5 — apiRoutes.app (app-level hooks, error handler, not-found handler)', () => {
  const fn = () => undefined
  const fullApp = {
    hooks: { prepend: ['onRequest'], append: ['onSend'] },
    errorHandler: 'wrap',
    notFoundHandler: 'replace',
  }
  const fullImplementation = {
    hooks: { onRequest: fn, onSend: [fn, fn] },
    errorHandler: fn,
    notFoundHandler: fn,
  }
  const register = (app: unknown, implementation: unknown, warn = vi.fn()) =>
    registerExtension(
      manifestWith({ app }),
      () => ({ apiRoutes: { app: implementation } }) as never,
      { logger: { warn } }
    )
  const expectAppInvalid = (app: unknown, implementation: unknown, messagePart: string): void => {
    let caught: unknown
    try {
      register(app, implementation)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ExtensionRegistrationError)
    expect((caught as ExtensionRegistrationError).reason).toBe('invalid-manifest-field')
    expect((caught as Error).message).toContain(messagePart)
  }

  it('a full app declaration with its implementations registers and is returned unchanged', () => {
    const warn = vi.fn()
    const result = register(fullApp, fullImplementation, warn)
    expect(result.manifest.apiRoutes).toEqual({ app: fullApp })
    expect(result.hooks.apiRoutes?.app?.errorHandler).toBe(fn)
    expect(warn).not.toHaveBeenCalled()
  })

  it('an empty app object is valid and installs nothing', () => {
    expect(() => register({}, undefined)).not.toThrow()
  })

  it('a pack without app (3.27/3.28 shape) loads unchanged', () => {
    const declaration: ApiRoutesDeclaration = { add: [{ method: 'GET', url: DOCS_URL }] }
    const result = registerExtension(
      manifestWith(declaration),
      hooksFor({ [DOCS_KEY]: { handler } })
    )
    expect(result.manifest.apiRoutes?.app).toBeUndefined()
  })

  it('app may be combined with add and override entries', () => {
    const declaration = { add: [{ method: 'GET', url: DOCS_URL }], app: { errorHandler: 'wrap' } }
    expect(() =>
      registerExtension(manifestWith(declaration), () => ({
        apiRoutes: { routes: { [DOCS_KEY]: { handler } }, app: { errorHandler: fn } },
      }))
    ).not.toThrow()
  })

  it.each([
    [{ errorHandler: 'append' }, "apiRoutes.app.errorHandler must be 'wrap' or 'replace'"],
    [{ notFoundHandler: true }, "apiRoutes.app.notFoundHandler must be 'wrap' or 'replace'"],
    [{ hooks: { prepend: ['onReady'] } }, 'apiRoutes.app.hooks.prepend[0] must be one of'],
    [{ hooks: { append: ['onRequest', 5] } }, 'apiRoutes.app.hooks.append[1] must be one of'],
    [{ hooks: { prepend: 'onRequest' } }, 'apiRoutes.app.hooks.prepend must be an array'],
    [{ hooks: { middle: [] } }, 'apiRoutes.app.hooks has unknown key "middle"'],
    [{ hooks: [] }, 'apiRoutes.app.hooks must be an object'],
    [{ errorhandler: 'wrap' }, 'apiRoutes.app has unknown key "errorhandler"'],
  ])('app %j fails registration as an integrity error', (app, message) => {
    expectAppInvalid(app, {}, message)
  })

  it('an app that is not an object fails', () => {
    expectAppInvalid([], undefined, 'apiRoutes.app must be an object')
    expectAppInvalid('wrap', undefined, 'apiRoutes.app must be an object')
  })

  it('a declared error handler without a function fails after hooksFactory()', () => {
    expectAppInvalid(
      { errorHandler: 'wrap' },
      {},
      'apiRoutes.app declares an errorHandler but hooks.apiRoutes.app has no function for it'
    )
  })

  it('a declared not-found handler without a function fails after hooksFactory()', () => {
    expectAppInvalid(
      { notFoundHandler: 'replace' },
      { notFoundHandler: 'nope' },
      'apiRoutes.app declares a notFoundHandler but hooks.apiRoutes.app has no function for it'
    )
  })

  it('a declared hook phase without a function fails after hooksFactory()', () => {
    expectAppInvalid(
      { hooks: { prepend: ['onRequest'] } },
      { hooks: {} },
      'apiRoutes.app declares an onRequest hook but hooks.apiRoutes.app has no function for it'
    )
    expectAppInvalid(
      { hooks: { append: ['onSend'] } },
      undefined,
      'apiRoutes.app declares an onSend hook but hooks.apiRoutes.app has no function for it'
    )
  })

  it('undeclared app implementations only warn', () => {
    const warn = vi.fn()
    register({}, { errorHandler: fn, notFoundHandler: fn, hooks: { onRequest: fn } }, warn)
    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(messages).toEqual([
      'hooks.apiRoutes.app has an implementation for undeclared errorHandler',
      'hooks.apiRoutes.app has an implementation for undeclared notFoundHandler',
      'hooks.apiRoutes.app has an implementation for undeclared hook phase "onRequest"',
    ])
  })
})
