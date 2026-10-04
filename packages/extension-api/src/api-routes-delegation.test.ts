import { describe, expect, it } from 'vitest'
import { ExtensionRegistrationError } from './errors.js'
import { EXTENSION_API_VERSION } from './manifest.js'
import type { ExtensionManifest } from './manifest.js'
import { registerExtension } from './register-extension.js'
import type { ApiRoutesDeclaration } from './hooks/api-routes.js'
import { isApiRouteDelegatedContext } from './hooks/api-routes.js'

/**
 * Story 71.8 — `security.delegation`: the declaration shape (AC-1), the three self-contradiction
 * checks (AC-2), the pass-through (AC-4) and the context type guard (AC-3).
 */

const AUDIT_URL = '/cm/audit-events'
const ROUTE = `POST ${AUDIT_URL}` as const
const MUST_BE_BOOL_OR_OBJECT = 'delegation must be a boolean or an object'
const ORG_NAME_MUST_BE = 'delegation.subjectFields.org.name must be'
const handler = () => ({ ok: true })

type Wrap = (security: unknown) => unknown
const add: Wrap = (security) => ({
  add: [{ method: 'POST', url: AUDIT_URL, options: { security } }],
})
const override: Wrap = (security) => ({
  override: [{ method: 'POST', url: AUDIT_URL, mode: 'replace', replaceSecurity: true, security }],
})

function register(apiRoutes: unknown, routes = { [ROUTE]: { handler } }): ExtensionManifest {
  const manifest: ExtensionManifest = {
    name: 'com.acme.delegation',
    apiVersion: EXTENSION_API_VERSION,
    capabilities: [],
    apiRoutes: apiRoutes as ApiRoutesDeclaration,
  }
  return registerExtension(manifest, () => ({ apiRoutes: { routes } })).manifest
}

function messageOf(apiRoutes: unknown): string {
  try {
    register(apiRoutes)
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionRegistrationError)
    expect((error as ExtensionRegistrationError).reason).toBe('invalid-manifest-field')
    return (error as Error).message
  }
  throw new Error('expected registration to fail')
}

const subject = { org: { in: 'body', name: 'orgId' }, actor: { in: 'body', name: 'actorId' } }
const field = (name: string, where = 'body') => ({ subjectFields: { org: { in: where, name } } })
const shapes: Array<[string, Wrap, string]> = [
  ['add', add, 'apiRoutes.add[0].options.security'],
  ['override', override, 'apiRoutes.override[0].security'],
]

describe.each(shapes)('Story 71.8 AC-1 — security.delegation on an %s', (_name, wrap, path) => {
  it.each([
    [true],
    [false],
    [{}],
    [{ subjectFields: subject }],
    [field('orgId', 'params')],
    [{ subjectFields: {} }],
    [field('a'.repeat(128))],
  ])('accepts delegation %j', (delegation) => {
    expect(() => register(wrap({ delegation }))).not.toThrow()
  })

  it.each([
    ['yes', MUST_BE_BOOL_OR_OBJECT],
    [1, MUST_BE_BOOL_OR_OBJECT],
    [[], MUST_BE_BOOL_OR_OBJECT],
    [null, MUST_BE_BOOL_OR_OBJECT],
    [{ historical: {} }, 'delegation has unknown key "historical"'],
    [{ occurredAt: true }, 'delegation has unknown key "occurredAt"'],
    [{ subjectFields: 'x' }, 'delegation.subjectFields must be an object'],
    [
      { subjectFields: { tenant: { in: 'body', name: 'x' } } },
      'delegation.subjectFields has unknown key "tenant"',
    ],
    [field('x', 'header'), 'delegation.subjectFields.org.in must be'],
    [{ subjectFields: { org: { in: 'body' } } }, ORG_NAME_MUST_BE],
    [field(''), ORG_NAME_MUST_BE],
    [field('a.b'), ORG_NAME_MUST_BE],
    [field('a'.repeat(129)), ORG_NAME_MUST_BE],
    [
      { subjectFields: { org: { in: 'body', name: 'x', extra: 1 } } },
      'delegation.subjectFields.org has unknown key "extra"',
    ],
    [{ subjectFields: { org: 'orgId' } }, 'delegation.subjectFields.org must be an object'],
    [field('__proto__'), ORG_NAME_MUST_BE],
    [
      { subjectFields: { actor: { in: 'body', name: 'constructor' } } },
      'delegation.subjectFields.actor.name must be',
    ],
    [
      { subjectFields: { actor: { in: 'params', name: 'prototype' } } },
      'delegation.subjectFields.actor.name must be',
    ],
  ])('rejects delegation %j', (delegation, part) => {
    expect(messageOf(wrap({ delegation }))).toContain(`${path}.${part}`)
  })

  it('rejects the same field named as both the org and the actor', () => {
    const same = { org: { in: 'body', name: 'id' }, actor: { in: 'body', name: 'id' } }
    expect(messageOf(wrap({ delegation: { subjectFields: same } }))).toContain(
      `${path}.delegation.subjectFields org and actor must not name the same field`
    )
  })
})

describe.each(shapes)('Story 71.8 AC-2 — contradictions on an %s', (_name, wrap) => {
  it.each([
    [{ requireMfa: true }, 'requireMfa'],
    [{ requirePlatformOperator: true }, 'requirePlatformOperator'],
    [{ requireAuth: false }, 'requireAuth'],
  ])('rejects delegation with %j, naming the route and the flag', (extra, flag) => {
    for (const delegation of [true, {}]) {
      const message = messageOf(wrap({ delegation, ...extra }))
      expect(message).toContain(ROUTE)
      expect(message).toContain(flag)
    }
  })

  it('reports requireAuth first, then requireMfa, then requirePlatformOperator', () => {
    const all = {
      delegation: true,
      requireMfa: true,
      requirePlatformOperator: true,
      requireAuth: false,
    }
    expect(messageOf(wrap(all))).toContain('requireAuth: false')
    expect(messageOf(wrap({ ...all, requireAuth: true }))).toContain('requireMfa')
    expect(messageOf(wrap({ ...all, requireAuth: true, requireMfa: false }))).toContain(
      'requirePlatformOperator'
    )
  })

  it('accepts the non-contradicting values and every other combination', () => {
    const ok = [
      { delegation: true, requireMfa: false, requirePlatformOperator: false, requireAuth: true },
      {
        delegation: true,
        minimumRole: 'member',
        allowedRoles: ['owner'],
        capability: 'cm.audit',
        rateLimit: { max: 600 },
        writeAuditEvent: true,
        requireOrgScope: false,
      },
      { delegation: true, rateLimit: false },
      { delegation: false, requireMfa: true, requirePlatformOperator: true, requireAuth: false },
    ]
    for (const security of ok) expect(() => register(wrap(security))).not.toThrow()
  })
})

describe('Story 71.8 AC-2 / AC-4 — registration behaviour', () => {
  it('keeps the existing replaceSecurity error when delegation is set without it', () => {
    const declaration = {
      override: [{ method: 'POST', url: AUDIT_URL, mode: 'wrap', security: { delegation: true } }],
    }
    expect(messageOf(declaration)).toContain('security is only honoured with replaceSecurity: true')
  })

  it('passes a nested delegation declaration through registerExtension unchanged', () => {
    const declaration = {
      add: [
        {
          method: 'POST',
          url: AUDIT_URL,
          options: { security: { delegation: { subjectFields: subject }, capability: 'cm.audit' } },
        },
      ],
      override: [
        {
          method: 'GET',
          url: '/pv/x',
          mode: 'wrap',
          replaceSecurity: true,
          security: { delegation: true },
        },
      ],
    }
    const registered = register(declaration, {
      [ROUTE]: { handler },
      'GET /pv/x': { handler },
    } as never)
    expect(registered.apiRoutes).toEqual(declaration)
  })

  it('leaves manifests without delegation unchanged (security {} and undefined)', () => {
    for (const security of [{}, undefined]) {
      const declaration = add(security)
      expect(register(declaration).apiRoutes).toEqual(declaration)
    }
  })
})

describe('Story 71.8 AC-3 — isApiRouteDelegatedContext', () => {
  const delegation = {
    orgId: 'org',
    actorId: 'actor',
    actorProvider: 'cm',
    actorUserId: null,
    actorAttestation: 'issuer_attested',
    delegatedBy: { kid: 'k', issuer: 'i' },
    assertionId: 'jti',
    issuedAt: 1,
    operation: ROUTE,
  }

  it('is true only when ctx.delegation is an object and auth.delegation is true', () => {
    expect(isApiRouteDelegatedContext({ delegation, auth: { delegation: true } } as never)).toBe(
      true
    )
  })

  it.each([
    [{}],
    [{ auth: { delegation: true } }],
    [{ delegation, auth: {} }],
    [{ delegation, auth: { delegation: false } }],
    [{ delegation, auth: { delegation: 'true' } }],
    [{ delegation: null, auth: { delegation: true } }],
    [{ delegation: 'x', auth: { delegation: true } }],
    [{ delegation }],
    [{ delegation, auth: null }],
  ])('is false for %j without throwing', (ctx) => {
    expect(isApiRouteDelegatedContext(ctx as never)).toBe(false)
  })
})
