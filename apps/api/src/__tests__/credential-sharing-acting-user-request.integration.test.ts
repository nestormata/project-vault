import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { credentialShares } from '@project-vault/db/schema'
import {
  cookieHeader,
  configureAuthIntegrationEnv,
  initVaultForTest,
} from './helpers/auth-test-helpers.js'
import { API_ROUTES_FIXTURE_PACKAGE, importApiRoutesFixture } from './helpers/api-routes-fixture.js'
import { createMembershipTestHelpers } from './helpers/membership-test-helpers.js'
import {
  enrollTotpForSession,
  type EnrolledTotp,
} from './helpers/external-share-step-up-test-helpers.js'

/**
 * Story 65.6 Task 6b — request-path proof, the consumer view (CentralizeMe 14-39 / 14-40): an M7
 * `apiRoutes` handler, reached through a REAL authenticated Fastify request, calls
 * `HostServices.credentialSharing` the way CM's share UI will. The handlers pass the signed-in user
 * only as `viewer` / `actor` and never pass `actingUserId`, so these cases prove the ambient request
 * user reaches the host on create, list and revoke. The last case is the scheduled-task shape: the
 * same host, no request, so the unknown / fallback path.
 */
process.env['VAULT_EXTENSIONS_PACKAGE'] = API_ROUTES_FIXTURE_PACKAGE
configureAuthIntegrationEnv()

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')
const { __resetExtensionStateForTests } = await import('../extensions/loader.js')
const { __resetAuthStrategiesForTests } = await import('../modules/auth/strategies.js')
const { buildCredentialSharingHost } = await import('../lib/credential-sharing-host.js')
const { createCredentialTestProject, createCredentialViaApi } =
  await import('../modules/credentials/credential-route-test-helpers.js')
const fixture = await importApiRoutesFixture()

type TestApp = Awaited<ReturnType<typeof createApp>>
type Cookies = Record<string, string>

const EXTENSION_NAME = 'test.mock-api-routes-extension'
const SHARE_URL = '/api/v1/cm/shares'
const NOT_AUTHORIZED = 'credential_sharing_not_authorized'

const { registerOwner, addUserToOrg, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'sharing-request',
  orgNamePrefix: 'Sharing Request Org',
})

describe('Story 65.6 Task 6b — ambient user through a real authenticated M7 route', () => {
  let app: TestApp
  let orgId: string
  let projectId: string
  let credentialId: string
  let memberOne: { userId: string; cookies: Cookies }
  let memberTwo: { userId: string; cookies: Cookies }
  let admin: { userId: string; cookies: Cookies }

  beforeAll(async () => {
    delete process.env['RELEASE_VERSION']
    await resetVaultForTest()
    await initVaultForTest(initVault, 'sharing-request-integration-passphrase')
    __resetExtensionStateForTests()
    __resetAuthStrategiesForTests()
    fixture.setApiRoutesScenario('credential-sharing')
    fixture.resetObserved()
    app = await createApp({ logger: false, vaultGuardEnabled: true })

    const owner = await registerOwner(app, 'owner')
    orgId = owner.orgId
    projectId = await createCredentialTestProject(app, owner.cookies, 'sharing-request')
    credentialId = (
      await createCredentialViaApi(app, owner.cookies, projectId, {
        name: 'sharing-request-credential',
        value: 'sharing-request-secret',
      })
    ).id
    memberOne = await addUserToOrg(app, orgId, 'member-one', { orgRole: 'member' })
    memberTwo = await addUserToOrg(app, orgId, 'member-two', { orgRole: 'member' })
    admin = await addUserToOrg(app, orgId, 'admin', { orgRole: 'admin' })

    // The host resolves the extension's machine user by the manifest name.
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/machine-users`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: EXTENSION_NAME, role: 'member' },
    })
    expect(created.statusCode).toBe(201)
    const key = await app.inject({
      method: 'POST',
      url: `/api/v1/machine-users/${created.json<{ data: { id: string } }>().data.id}/api-keys`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'sharing-request-key' },
    })
    expect(key.statusCode).toBe(201)
  }, 60_000)

  afterAll(async () => {
    await app.close()
    __resetExtensionStateForTests()
    fixture.setApiRoutesScenario('default')
    await resetVaultForTest()
    delete process.env['VAULT_EXTENSIONS_PACKAGE']
  })

  type ShareResult = { status: string; share?: { id: string; sharedBy: string | null } }

  function postShare(cookies: Cookies, totpCode?: string) {
    return app.inject({
      method: 'POST',
      url: SHARE_URL,
      headers: { cookie: cookieHeader(cookies) },
      payload: { projectId, credentialId, fieldKey: 'value', ...(totpCode ? { totpCode } : {}) },
    })
  }

  async function createAs(cookies: Cookies, totpCode: string): Promise<ShareResult> {
    const response = await postShare(cookies, totpCode)
    expect(response.statusCode).toBe(200)
    return response.json<{ data: ShareResult }>().data
  }

  function refusalCode(response: Awaited<ReturnType<typeof postShare>>): string | null {
    expect(response.statusCode).toBe(200)
    const data = response.json<{ data: { status: string; code: string | null } }>().data
    expect(data.status).toBe('error')
    return data.code
  }

  async function shareCount(): Promise<number> {
    const rows = await withOrg(orgId, (tx) =>
      tx.select({ id: credentialShares.id }).from(credentialShares)
    )
    return rows.length
  }

  async function listAs(cookies: Cookies): Promise<string[]> {
    const response = await app.inject({
      method: 'GET',
      url: `${SHARE_URL}?credentialId=${credentialId}`,
      headers: { cookie: cookieHeader(cookies) },
    })
    expect(response.statusCode).toBe(200)
    const data = response.json<{ data: { items: { id: string }[] } }>().data
    return data.items.map((item) => item.id)
  }

  async function revokeAs(cookies: Cookies, shareId: string) {
    const response = await app.inject({
      method: 'POST',
      url: `${SHARE_URL}/revoke`,
      headers: { cookie: cookieHeader(cookies) },
      payload: { projectId, credentialId, shareId },
    })
    expect(response.statusCode).toBe(200)
    return response.json<{ data: { status: string; code?: string } }>().data
  }

  async function statusOf(shareId: string): Promise<string | undefined> {
    const [row] = await withOrg(orgId, (tx) =>
      tx.select().from(credentialShares).where(eq(credentialShares.id, shareId))
    )
    return row?.status
  }

  it('create without actingUserId records the request user, list scopes to them, revoke honours the sharer rule', async () => {
    await Promise.all(
      [memberOne, memberTwo].map((member) =>
        addProjectMember(orgId, projectId, member.userId, 'member')
      )
    )
    await addProjectMember(orgId, projectId, admin.userId, 'admin')
    const [totpOne, totpTwo] = await Promise.all([
      enrollTotpForSession(app, memberOne.userId, memberOne.cookies),
      enrollTotpForSession(app, memberTwo.userId, memberTwo.cookies),
    ])

    const created = await createAs(memberOne.cookies, totpOne.freshCode)
    expect(created.status).toBe('ok')
    const shareId = created.share?.id ?? ''
    expect(created.share?.sharedBy).toBe(memberOne.userId)
    const [row] = await withOrg(orgId, (tx) =>
      tx.select().from(credentialShares).where(eq(credentialShares.id, shareId))
    )
    expect(row).toMatchObject({ hostCreated: true, actingUserId: memberOne.userId })

    const other = await createAs(memberTwo.cookies, totpTwo.freshCode)
    const otherId = other.share?.id ?? ''
    expect(other.share?.sharedBy).toBe(memberTwo.userId)

    expect(await listAs(memberOne.cookies)).toEqual([shareId])
    expect(await listAs(memberTwo.cookies)).toEqual([otherId])
    expect((await listAs(admin.cookies)).sort()).toEqual([shareId, otherId].sort())

    // memberTwo is not the sharer of memberOne's share and is no admin.
    expect(await revokeAs(memberTwo.cookies, shareId)).toEqual({
      status: 'error',
      code: NOT_AUTHORIZED,
    })
    expect(await statusOf(shareId)).toBe('active')
    expect(await revokeAs(memberOne.cookies, shareId)).toMatchObject({ status: 'ok' })
    expect(await statusOf(shareId)).toBe('revoked')
    expect(await revokeAs(admin.cookies, otherId)).toMatchObject({ status: 'ok' })
  })

  describe('Story 72.21 AC6 — the step-up through the real loader and route path', () => {
    let enrolled: EnrolledTotp
    let enrolledCookies: Cookies

    beforeAll(async () => {
      const member = await addUserToOrg(app, orgId, 'step-up-enrolled', { orgRole: 'member' })
      await addProjectMember(orgId, projectId, member.userId, 'member')
      enrolledCookies = member.cookies
      enrolled = await enrollTotpForSession(app, member.userId, member.cookies)
    })

    it('refuses a create without a code and writes nothing', async () => {
      const before = await shareCount()
      const response = await postShare(enrolledCookies)
      expect(refusalCode(response)).toBe('credential_sharing_step_up_required')
      expect(await shareCount()).toBe(before)
    })

    it('refuses a user with no enrolled TOTP with the enrollment error', async () => {
      const bare = await addUserToOrg(app, orgId, 'step-up-bare', { orgRole: 'member' })
      await addProjectMember(orgId, projectId, bare.userId, 'member')
      const before = await shareCount()
      const response = await postShare(bare.cookies, enrolled.freshCode)
      expect(refusalCode(response)).toBe('credential_sharing_totp_enrollment_required')
      expect(await shareCount()).toBe(before)
    })

    it('creates the share once the enrolled user sends a current code', async () => {
      const before = await shareCount()
      const result = await createAs(enrolledCookies, enrolled.freshCode)
      expect(result.status).toBe('ok')
      expect(await shareCount()).toBe(before + 1)
      expect(refusalCode(await postShare(enrolledCookies, enrolled.freshCode))).toBe(
        'credential_sharing_step_up_required'
      )
    })
  })

  it('a scheduled-task style call (no request, no actingUserId) records an unknown acting user and the id fallback records a member', async () => {
    const host = buildCredentialSharingHost({
      name: EXTENSION_NAME,
      apiVersion: '3.36.0',
      capabilities: [],
    })
    const base = {
      organizationId: orgId,
      projectId,
      credentialId,
      recipientEmail: 'scheduled@invalid',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      fieldKey: 'value',
    }
    const unknown = await host.createExternalShare(base)
    const fallback = await host.createExternalShare({ ...base, actingUserId: memberTwo.userId })
    if (unknown.status !== 'ok' || fallback.status !== 'ok') throw new Error('create failed')

    expect(unknown.share.sharedBy).toBeNull()
    expect(fallback.share.sharedBy).toBe(memberTwo.userId)
    // The unknown-acting-user share is admin-only for the same viewer rule a request would apply.
    const asMember = await host.listSharesForCredential({
      organizationId: orgId,
      credentialId,
      viewer: { userId: memberTwo.userId },
    })
    expect(asMember.items.map((item) => item.id)).toContain(fallback.share.id)
    expect(asMember.items.map((item) => item.id)).not.toContain(unknown.share.id)
  })
})
