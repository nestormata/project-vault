import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { users } from '@project-vault/db/schema'
import {
  cookieHeader,
  createProjectViaApi,
  registerAndLoginViaApi,
} from './helpers/auth-test-helpers.js'
import { resetVaultForTest } from './helpers/vault-test-cleanup.js'
import { __resetCapabilityGateForTests } from '../lib/capability-gate.js'

async function enrollMfa(userId: string): Promise<void> {
  await getDb().update(users).set({ mfaEnrolledAt: new Date() }).where(eq(users.id, userId))
}

/**
 * Story 23.3 AC-29 — the mandatory end-to-end proof: boots the REAL `createApp()` with
 * `@project-vault/mock-capability-gate-extension` as `VAULT_EXTENSIONS_PACKAGE`, driving the
 * actual `loadExtension()` -> `wireExtensionCapabilityGate()` -> route path (not a hand-injected
 * mock), and asserts both permitted and denied outcomes on BOTH annotated routes (AC-23, AC-24).
 *
 * The fixture's `PERMITTED_ORG_IDS` set is mutated in-process to include this test's real,
 * DB-generated org id — legitimate because this spec runs in the same Node process as the
 * dynamically-imported fixture module (module singleton), the same technique
 * `mock-envelope-extension`'s own E2E harness comment documents ("spec runs in the same Node
 * process as the test runner"). The fixture's own deterministic-lookup unit tests
 * (`fixtures/mock-capability-gate-extension/src/index.test.ts`) already cover the fixed literal
 * ids in isolation; this file's job is proving the real boot wiring, not re-testing the fixture.
 */
process.env['VAULT_EXTENSIONS_PACKAGE'] = '@project-vault/mock-capability-gate-extension'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { initVaultForTest } = await import('./helpers/auth-test-helpers.js')

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'capability-gate-boot-integration-passphrase'

function statusPageUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/status-page`
}

function publicStatusPageUrl(token: string): string {
  return `/api/v1/status-pages/${token}`
}

describe.sequential('Story 23.3 AC-29 — real boot with mock-capability-gate-extension', () => {
  let app: TestApp

  beforeAll(async () => {
    delete process.env['RELEASE_VERSION']
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  }, 30_000)

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
    __resetCapabilityGateForTests()
    delete process.env['VAULT_EXTENSIONS_PACKAGE']
  })

  it('the fixture gate is genuinely registered at boot (not a hand-injected mock)', async () => {
    const res = await app.inject({ method: 'GET', url: '/status' })
    const body = res.json<{ capabilityGate?: { gate: { name: string } | null } }>()
    expect(body.capabilityGate?.gate).toEqual({ name: 'test.mock-capability-gate-extension' })
  })

  it('AC-23: a permitted org can publish a status page (201), and a denied org gets 403 capability_denied', async () => {
    const fixtureModule = await import('@project-vault/mock-capability-gate-extension')

    const permittedOwner = await registerAndLoginViaApi(app, {
      email: `cap-gate-permitted-${Date.now()}@example.test`,
      password: 'correct-horse-battery-staple',
      orgName: `Cap Gate Permitted Org ${Date.now()}`,
    })
    // Mutate the fixture's in-memory lookup to include this real, DB-generated org id — see the
    // file-level comment for why this is legitimate (module singleton, same-process import).
    fixtureModule.PERMITTED_ORG_IDS.add(permittedOwner.orgId)
    await enrollMfa(permittedOwner.userId)

    const permittedProjectId = await createProjectViaApi(
      app,
      permittedOwner.cookies,
      'cap-gate-permitted'
    )
    const permittedRes = await app.inject({
      method: 'POST',
      url: statusPageUrl(permittedProjectId),
      headers: { cookie: cookieHeader(permittedOwner.cookies) },
      payload: {},
    })
    expect(permittedRes.statusCode).toBe(201)
    const permittedToken = permittedRes.json<{ data: { token: string } }>().data.token

    const deniedOwner = await registerAndLoginViaApi(app, {
      email: `cap-gate-denied-${Date.now()}@example.test`,
      password: 'correct-horse-battery-staple',
      orgName: `Cap Gate Denied Org ${Date.now()}`,
    })
    await enrollMfa(deniedOwner.userId)
    const deniedProjectId = await createProjectViaApi(app, deniedOwner.cookies, 'cap-gate-denied')
    const deniedRes = await app.inject({
      method: 'POST',
      url: statusPageUrl(deniedProjectId),
      headers: { cookie: cookieHeader(deniedOwner.cookies) },
      payload: {},
    })
    expect(deniedRes.statusCode).toBe(403)
    expect(deniedRes.json()).toMatchObject({
      code: 'capability_denied',
      capability: 'monitoring.public-status-page',
      reasonCode: 'fixture_not_entitled',
    })

    // AC-24: the permitted org's public page serves 200; an unknown token still 404s.
    const publicOk = await app.inject({ method: 'GET', url: publicStatusPageUrl(permittedToken) })
    expect(publicOk.statusCode).toBe(200)

    const publicUnknown = await app.inject({
      method: 'GET',
      url: publicStatusPageUrl('deadbeef'.repeat(4)),
    })
    expect(publicUnknown.statusCode).toBe(404)
  })
})
