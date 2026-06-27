/* eslint-disable security/detect-non-literal-fs-filename */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MFA_ENROLLMENT_EXEMPT_ROUTES } from '@project-vault/shared'
import {
  DIRECT_DB_ACCESS_CLASSIFICATIONS,
  HELPER_ROUTE_REGISTRATION_CLASSIFICATIONS,
  PUBLIC_ROUTE_EXEMPTIONS,
  ROUTE_ACTION_CLASSIFICATIONS,
} from '../lib/route-exemptions.js'

export const EXEMPT_PATHS = new Set([
  '/health',
  '/ready',
  '/metrics',
  '/api/v1/vault/init',
  '/api/v1/vault/unseal',
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/mfa/recover',
])

// Routes.ts file path (relative to apps/api/src/modules) -> the prefix it's registered
// under in app.ts (`fastify.register(routes, { prefix })`).
const ROUTE_FILES: Array<{ path: string; prefix: string }> = [
  { path: 'modules/auth/routes.ts', prefix: '/api/v1/auth' },
  { path: 'modules/org/routes.ts', prefix: '/api/v1/org' },
]
const WORKER_FILES = [
  'workers/check-failed-auth-threshold.ts',
  'workers/prune-failed-auth-attempts.ts',
  'workers/prune-totp-used-codes.ts',
  'workers/prune-revoked-tokens.ts',
  'workers/prune-mfa-pending.ts',
]

type ParsedRoute = {
  method: string
  url: string
  preHandlerSource: string
  registrar: string
}

function parseRoutes(source: string): ParsedRoute[] {
  const rawRoutes = source
    .split('fastify.route(')
    .slice(1)
    .map((chunk) => {
      const head = chunk.split(/handler:\s*async/)[0] ?? chunk
      const method = /method:\s*'([A-Z]+)'/.exec(head)?.[1] ?? ''
      const url = /url:\s*'([^']+)'/.exec(head)?.[1] ?? ''
      const preHandlerSource = /preHandler:\s*\[([^\]]*)\]/.exec(head)?.[1] ?? ''
      return { method, url, preHandlerSource, registrar: 'fastify.route' }
    })
    .filter((route) => route.method && route.url)
  const secureRoutes = source
    .split('secureRoute(')
    .slice(1)
    .map((chunk) => {
      const head = chunk.split(/handler:\s*async/)[0] ?? chunk
      const method = /method:\s*'([A-Z]+)'/.exec(head)?.[1] ?? ''
      const url = /url:\s*'([^']+)'/.exec(head)?.[1] ?? ''
      const preHandlerSource = /security:\s*\{([^}]*)\}/.exec(head)?.[1] ?? ''
      return { method, url, preHandlerSource, registrar: 'secureRoute' }
    })
    .filter((route) => route.method && route.url)
  return [...rawRoutes, ...secureRoutes]
}

function requiresOwnerOrAdmin(preHandlerSource: string): boolean {
  const match = /requireOrgRole\(([^)]*)\)/.exec(preHandlerSource)
  if (!match) return false
  return /'owner'|'admin'/.test(match[1] ?? '')
}

describe('route audit', () => {
  it('every non-public /api/v1 route is registered via SecureRoute', () => {
    const publicRoutes = new Set(PUBLIC_ROUTE_EXEMPTIONS.map((entry) => entry.route))
    const violations: string[] = []

    for (const { path, prefix } of ROUTE_FILES) {
      const source = readFileSync(resolve(process.cwd(), 'src', path), 'utf-8')
      for (const route of parseRoutes(source)) {
        const routeKey = `${route.method} ${prefix}${route.url}`
        if (route.registrar === 'secureRoute' || publicRoutes.has(routeKey)) continue
        violations.push(`${path}: ${routeKey} uses ${route.registrar}`)
      }
    }

    expect(violations).toEqual([])
  })

  it('public route exemptions include required security metadata', () => {
    expect(PUBLIC_ROUTE_EXEMPTIONS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          route: 'POST /api/v1/auth/login',
          reason: expect.any(String),
          securityOwner: expect.any(String),
          compensatingControls: expect.arrayContaining([expect.any(String)]),
          expiresAfterStory: null,
        }),
      ])
    )

    for (const exemption of PUBLIC_ROUTE_EXEMPTIONS) {
      expect(exemption.route).toMatch(/^[A-Z]+ \//)
      expect(exemption.reason.trim().length).toBeGreaterThan(10)
      expect(exemption.securityOwner.trim().length).toBeGreaterThan(0)
      expect(exemption.compensatingControls.length).toBeGreaterThan(0)
      if (exemption.temporary) {
        expect(exemption.expiresAfterStory ?? exemption.revisitBy).toBeTruthy()
      }
    }
  })

  it('classifies route-registering helpers and protected route actions', () => {
    expect(HELPER_ROUTE_REGISTRATION_CLASSIFICATIONS).toMatchObject({
      secureRoute: 'secure',
      registerMethodNotAllowed: 'shell-only',
    })

    for (const [route, classification] of Object.entries(ROUTE_ACTION_CLASSIFICATIONS)) {
      expect(route).toMatch(/^[A-Z]+ \/api\/v1\//)
      expect(['read', 'sensitive-read', 'mutation', 'security-action']).toContain(
        classification.action
      )
      if (
        (classification.action === 'mutation' || classification.action === 'security-action') &&
        !classification.auditEvent
      ) {
        expect(classification.auditOmissionReason).toBeTruthy()
        expect(classification.reviewer).toBeTruthy()
      }
    }
  })

  it('does not use the legacy protected-route helper after SecureRoute migration', () => {
    const authSource = readFileSync(resolve(process.cwd(), 'src/modules/auth/routes.ts'), 'utf-8')

    expect(authSource).not.toContain('registerProtectedRoute(fastify')
  })

  it('requires direct getDb imports in route and worker modules to be classified', () => {
    const classifiedPaths = new Set(DIRECT_DB_ACCESS_CLASSIFICATIONS.map((entry) => entry.path))
    const violations: string[] = []

    for (const path of [...ROUTE_FILES.map((file) => file.path), ...WORKER_FILES]) {
      const source = readFileSync(resolve(process.cwd(), 'src', path), 'utf-8')
      if (/import\s+\{[^}]*\bgetDb\b/.test(source) && !classifiedPaths.has(path)) {
        violations.push(path)
      }
    }

    for (const classification of DIRECT_DB_ACCESS_CLASSIFICATIONS) {
      expect(classification.reason.trim().length).toBeGreaterThan(10)
      expect(classification.reviewer.trim().length).toBeGreaterThan(0)
    }
    expect(violations).toEqual([])
  })

  it('does not spread raw request params, query, or body into audit payload builders', () => {
    const violations: string[] = []
    const files = [
      'lib/secure-route.ts',
      'modules/auth/service.ts',
      'modules/auth/mfa.ts',
      'modules/auth/session-revoke.ts',
      'workers/check-failed-auth-threshold.ts',
    ]

    for (const path of files) {
      const source = readFileSync(resolve(process.cwd(), 'src', path), 'utf-8')
      if (/\.\.\.\s*(req|request)\.(params|query|body)/.test(source)) violations.push(path)
    }

    expect(violations).toEqual([])
  })

  it('every owner/admin route requires MFA enrollment unless explicitly exempt (AC-5b/AC-5c)', () => {
    const violations: string[] = []

    for (const { path, prefix } of ROUTE_FILES) {
      const source = readFileSync(resolve(process.cwd(), 'src', path), 'utf-8')
      for (const route of parseRoutes(source)) {
        if (!requiresOwnerOrAdmin(route.preHandlerSource)) continue

        const routeKey = `${route.method} ${prefix}${route.url}`
        const hasMfaCheck = route.preHandlerSource.includes('requireMfaEnrollment()')
        const isExempt = (MFA_ENROLLMENT_EXEMPT_ROUTES as readonly string[]).includes(routeKey)

        if (!hasMfaCheck && !isExempt) {
          violations.push(routeKey)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('uses the shared MFA enrollment exempt route registry', () => {
    const sharedRegistrySource = readFileSync(
      resolve(process.cwd(), '../../packages/shared/src/constants/mfa-exempt-routes.ts'),
      'utf-8'
    )

    expect(sharedRegistrySource).toContain('GET /api/v1/org/security-alerts')
    expect(sharedRegistrySource).toContain('GET /api/v1/auth/me')
  })

  it('requires MFA on the existing owner/admin session-revoke route', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/modules/org/routes.ts'),
      'utf-8'
    ).replace(/\s+/g, ' ')

    expect(source).toContain("url: '/users/:userId/sessions'")
    expect(source).toMatch(/allowedRoles:\s*\['admin', 'owner'\]/)
    expect(source).toMatch(/requireMfa:\s*true/)
  })

  it('does not import the test-only privileged route helper from production entrypoints', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/app.ts'), 'utf-8')
    const mainSource = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf-8')

    expect(appSource).not.toContain('privileged-test-route')
    expect(mainSource).not.toContain('privileged-test-route')
  })
})
