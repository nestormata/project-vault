import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

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

describe('route audit', () => {
  it.todo('every /api/v1/ route must be registered via SecureRoute')

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
