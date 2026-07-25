import { describe, expect, it, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { users } from '@project-vault/db/schema'
import type { ExtensionManifest } from '@project-vault/extension-api'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  type CookieJar,
} from '../__tests__/helpers/auth-test-helpers.js'
import { createDirectAuthenticatedUser } from '../__tests__/helpers/org-role-test-helpers.js'
import { createUnsealedRouteSuite } from '../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import { __resetExtensionStateForTests, loadExtension } from './loader.js'

const { initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof import('../app.js').createApp>>

const TEST_PASSPHRASE = 'extensions-status-route-passphrase'
const STATUS_URL = '/api/v1/admin/extensions/status'

const VALID_MANIFEST: ExtensionManifest = {
  name: 'com.acme.sso-extension',
  apiVersion: '^1.0.0',
  capabilities: ['auth-provider'],
}

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

async function enrollMfa(userId: string): Promise<void> {
  await getDb().update(users).set({ mfaEnrolledAt: new Date() }).where(eq(users.id, userId))
}

async function getStatus(app: TestApp, cookies?: CookieJar) {
  return app.inject({
    method: 'GET',
    url: STATUS_URL,
    headers: cookies ? { cookie: cookieHeader(cookies) } : {},
  })
}

describe.sequential('GET /api/v1/admin/extensions/status', () => {
  suite.registerLifecycle()

  beforeEach(() => {
    __resetExtensionStateForTests()
  })

  it('AC-4: returns 200 null when no extension is loaded', async () => {
    const admin = await createDirectAuthenticatedUser(suite.app, 'status-null', 'admin')
    await enrollMfa(admin.userId)

    const res = await getStatus(suite.app, admin.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
  })

  it('AC-2: returns the manifest JSON when an extension is loaded', async () => {
    await loadExtension('@acme/extension', {
      importFn: async () => ({
        default: { manifest: VALID_MANIFEST, hooksFactory: () => ({}) },
      }),
      listOrgIds: async () => [],
    })
    const admin = await createDirectAuthenticatedUser(suite.app, 'status-loaded', 'admin')
    await enrollMfa(admin.userId)

    const res = await getStatus(suite.app, admin.cookies)

    expect(res.statusCode).toBe(200)
    const body = res.json<{
      name: string
      apiVersion: string
      capabilities: string[]
      loadedAt: string
    }>()
    expect(body.name).toBe(VALID_MANIFEST.name)
    expect(body.apiVersion).toBe(VALID_MANIFEST.apiVersion)
    expect(body.capabilities).toEqual(VALID_MANIFEST.capabilities)
    expect(typeof body.loadedAt).toBe('string')
  })

  it('AC-4: returns 200 null when a load failed', async () => {
    await loadExtension('bad-package', {
      importFn: async () => {
        throw new Error('nope')
      },
      listOrgIds: async () => [],
    })
    const admin = await createDirectAuthenticatedUser(suite.app, 'status-failed', 'admin')
    await enrollMfa(admin.userId)

    const res = await getStatus(suite.app, admin.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
  })

  it.each(['member', 'viewer'] as const)('AC-5: returns 403 for org role %s', async (role) => {
    const nonAdmin = await createDirectAuthenticatedUser(suite.app, `status-${role}`, role)

    const res = await getStatus(suite.app, nonAdmin.cookies)

    expect(res.statusCode).toBe(403)
  })

  it('AC-5: returns 403 for org role owner (owner is not treated as admin for this route)', async () => {
    const owner = await createDirectAuthenticatedUser(suite.app, 'status-owner', 'owner')

    const res = await getStatus(suite.app, owner.cookies)

    expect(res.statusCode).toBe(403)
  })

  it('AC-5: returns 401 for an unauthenticated caller', async () => {
    const res = await getStatus(suite.app)

    expect(res.statusCode).toBe(401)
  })
})
