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
  process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
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
  // `[].concat(x)` flattens a single string or an array into a string[] in one step, so this
  // needs only one (non-nested) ternary instead of the previous `a ? b : c ? d : e` (Sonar
  // typescript:S3358 flags nested ternaries as hard to read).
  const headers: string[] = setCookie ? ([] as string[]).concat(setCookie) : []
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

/**
 * Mints a real session bound to `orgId` for `userId` and returns its cookie jar.
 *
 * `registerAndLoginViaApi` always logs a user into the org they registered, so its cookie is
 * scoped to that org. Tests that graft a user into a *second* org (multi-org membership) need a
 * session whose JWT `orgId` claim points at that second org — otherwise every request authenticates
 * back into the user's original org. This reuses the production session-creation path
 * (`createLoginSessionInTx`) and the app's JWT signer so the resulting cookie is indistinguishable
 * from one issued by the login route.
 */
export async function mintOrgSessionCookies(
  app: TestApp,
  userId: string,
  orgId: string
): Promise<CookieJar> {
  const { withOrg } = await import('@project-vault/db')
  const { createLoginSessionInTx } = await import('../../modules/auth/service.js')
  const { firstActorTokenIdForUser } = await import('../../modules/audit/actor-token.js')
  const result = await withOrg(orgId, async (tx) => {
    // Code-review finding (Story 8.1): look up the user's real identity token instead of
    // hardcoding identityTokenId: null — this helper mints a session for an already-registered
    // user (who already has a real user_identity_tokens row from registration) being granted a
    // session scoped to a second org. Hardcoding null silently discarded that real token. A null
    // actor_token_id on an actor_type='human' row permanently fails
    // checkAuditActorTokenCoverage (packages/db/src/check-audit-actor-token-coverage.ts), since
    // audit_log_entries is append-only and never cleaned up between test runs.
    const identityTokenId = await firstActorTokenIdForUser(tx, userId)
    return createLoginSessionInTx(tx, { id: userId, identityTokenId }, orgId, {})
  })
  const accessJwt = await (
    app as unknown as {
      jwt: {
        sign: (
          payload: Record<string, unknown>,
          options: { jti: string; expiresIn: number }
        ) => Promise<string> | string
      }
    }
  ).jwt.sign(
    {
      sub: result.tokens.accessClaims.sub,
      orgId: result.tokens.accessClaims.orgId,
      sessionVersion: result.tokens.accessClaims.sessionVersion,
    },
    { jti: result.tokens.accessClaims.jti, expiresIn: result.tokens.accessMaxAgeSec }
  )
  const jar: CookieJar = { 'access-token': accessJwt }
  if (result.tokens.refreshOpaque) jar['refresh-token'] = result.tokens.refreshOpaque
  return jar
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
