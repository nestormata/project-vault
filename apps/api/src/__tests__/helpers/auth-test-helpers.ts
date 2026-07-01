import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { createApp } from '../../app.js'

export type CookieJar = Record<string, string>
type InitVault = (
  config: { kmsType: 'passphrase'; passphrase: string },
  headers: Record<string, string | string[] | undefined>
) => Promise<unknown>
type TestApp = Awaited<ReturnType<typeof createApp>>

export function configureAuthIntegrationEnv(): void {
  process.env['DATABASE_URL'] ??=
    'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
  process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
}

/**
 * Sets integration env vars and dynamically imports the modules every SecureRoute integration
 * suite needs (app must load after env vars are set, since env.ts reads process.env at import
 * time). Centralized here so route test files don't each repeat the same bootstrap sequence.
 */
export async function bootstrapRouteIntegrationTest() {
  configureAuthIntegrationEnv()
  const { createApp } = await import('../../app.js')
  const { initVault } = await import('../../modules/vault/key-service.js')
  const humanAudit = await import('../../modules/audit/human-entry.js')
  return { createApp, initVault, humanAudit }
}

export function parseSetCookies(setCookie: string | string[] | undefined): CookieJar {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  return Object.fromEntries(
    headers
      .map((header) => header.split(';')[0] ?? '')
      .filter(Boolean)
      .map((cookie) => {
        const [name, ...valueParts] = cookie.split('=')
        return [name, valueParts.join('=')]
      })
  )
}

export function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

export async function initVaultForTest(initVault: InitVault, passphrase: string): Promise<void> {
  try {
    await initVault({ kmsType: 'passphrase', passphrase }, {})
  } catch (error) {
    if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
  }
}

/** Asserts a SecureRoute same-transaction audit-write failure: 503 audit_write_failed. */
export function expectAuditWriteFailed(response: { statusCode: number; json: <T>() => T }): void {
  expect(response.statusCode).toBe(503)
  expect(response.json()).toMatchObject({ code: 'audit_write_failed' })
}

type InjectableApp = {
  close: () => Promise<unknown>
  inject: (request: {
    method: string
    url: string
    payload?: unknown
    headers?: Record<string, string>
  }) => Promise<{ statusCode: number; json: <T>() => T }>
}

/**
 * Closes the current app, resets the vault to sealed, boots a fresh sealed app, and asserts
 * every given request gets a 503 { status: 'sealed' } response (vault-guard fail-closed).
 * Returns the sealed app instance so the caller can close it and re-unseal afterward.
 */
export async function assertRoutesFailClosedWhileSealed<TApp extends InjectableApp>(
  currentApp: TApp,
  createSealedApp: () => Promise<TApp>,
  requests: readonly {
    method: string
    url: string
    payload?: unknown
    headers?: Record<string, string>
  }[]
): Promise<TApp> {
  await currentApp.close()
  const { resetVaultForTest } = await import('./vault-test-cleanup.js')
  await resetVaultForTest()
  const sealedApp = await createSealedApp()
  for (const request of requests) {
    const res = await sealedApp.inject(request)
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ status: 'sealed' })
  }
  return sealedApp
}

export async function registerAndLoginViaApi(
  app: TestApp,
  input: { email: string; password: string; orgName: string }
): Promise<{ userId: string; orgId: string; cookies: CookieJar }> {
  const register = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email: input.email, password: input.password, orgName: input.orgName },
  })
  expect(register.statusCode).toBe(201)
  const registerBody = register.json<{ data: { userId: string; orgId: string } }>()

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: input.email, password: input.password },
  })
  expect(login.statusCode).toBe(200)

  return {
    userId: registerBody.data.userId,
    orgId: registerBody.data.orgId,
    cookies: parseSetCookies(login.headers['set-cookie']),
  }
}

export async function createProjectViaApi(
  app: TestApp,
  cookies: CookieJar,
  slug: string
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: `Project ${slug}`, slug: `${slug}-${randomUUID().slice(0, 8)}` },
  })
  expect(res.statusCode).toBe(201)
  return res.json<{ data: { id: string } }>().data.id
}

export async function bootUnsealedRouteApp(initVault: InitVault, passphrase: string) {
  const { resetVaultForTest } = await import('./vault-test-cleanup.js')
  const { createApp } = await import('../../app.js')
  await resetVaultForTest()
  await initVaultForTest(initVault, passphrase)
  const app = await createApp({ logger: false, vaultGuardEnabled: true })
  return {
    app,
    close: async () => {
      await app.close()
      await resetVaultForTest()
    },
  }
}
