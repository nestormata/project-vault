import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MFA_ENROLLMENT_EXEMPT_ROUTES } from '@project-vault/shared'

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

type ParsedRoute = {
  method: string
  url: string
  preHandlerSource: string
}

function parseRoutes(source: string): ParsedRoute[] {
  return source
    .split('fastify.route(')
    .slice(1)
    .map((chunk) => {
      const head = chunk.split(/handler:\s*async/)[0] ?? chunk
      const method = /method:\s*'([A-Z]+)'/.exec(head)?.[1] ?? ''
      const url = /url:\s*'([^']+)'/.exec(head)?.[1] ?? ''
      const preHandlerSource = /preHandler:\s*\[([^\]]*)\]/.exec(head)?.[1] ?? ''
      return { method, url, preHandlerSource }
    })
    .filter((route) => route.method && route.url)
}

function requiresOwnerOrAdmin(preHandlerSource: string): boolean {
  const match = /requireOrgRole\(([^)]*)\)/.exec(preHandlerSource)
  if (!match) return false
  return /'owner'|'admin'/.test(match[1] ?? '')
}

describe('route audit', () => {
  it.todo('every /api/v1/ route must be registered via SecureRoute')

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
    expect(source).toMatch(
      /preHandler:\s*\[\s*authPreHandler\(fastify\),\s*requireOrgRole\('admin', 'owner'\),\s*requireMfaEnrollment\(\)\s*\]/
    )
  })

  it('does not import the test-only privileged route helper from production entrypoints', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/app.ts'), 'utf-8')
    const mainSource = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf-8')

    expect(appSource).not.toContain('privileged-test-route')
    expect(mainSource).not.toContain('privileged-test-route')
  })
})
