import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentialShares } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createMembershipTestHelpers,
  MEMBERSHIP_TEST_LOGIN_SECRET,
} from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import {
  bootCredentialRouteApp,
  createCredentialTestProject,
  createCredentialViaApi,
} from '../credentials/credential-route-test-helpers.js'
import * as dispatcher from '../../notifications/dispatcher.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'external-share-route',
  orgNamePrefix: 'External Share Route Org',
})

function externalSharesUrl(projectId: string, credentialId: string) {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/external-shares`
}

function accessUrl(token: string, suffix = '') {
  return `/api/v1/external-shares/access/${token}${suffix}`
}

function futureIso(ms = 30 * 60 * 1000): string {
  return new Date(Date.now() + ms).toISOString()
}

const DEFAULT_RECIPIENT_EMAIL = 'priya@vendor.example'

describe('external credential-shares routes', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    app = await bootCredentialRouteApp(createApp, initVault, 'external-shares-routes-passphrase')
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  async function createFixture(label: string) {
    const sharer = await registerOwner(app, `${label}-sharer`)
    const projectId = await createCredentialTestProject(app, sharer.cookies, label)
    const credential = await createCredentialViaApi(app, sharer.cookies, projectId)
    return { sharer, projectId, credentialId: credential.id }
  }

  async function createExternalShareViaApi(
    cookies: Record<string, string>,
    projectId: string,
    credentialId: string,
    body: Record<string, unknown>
  ) {
    return app.inject({
      method: 'POST',
      url: externalSharesUrl(projectId, credentialId),
      headers: { cookie: cookieHeader(cookies) },
      payload: {
        recipientEmail: DEFAULT_RECIPIENT_EMAIL,
        expiresAt: futureIso(),
        password: MEMBERSHIP_TEST_LOGIN_SECRET,
        ...body,
      },
    })
  }

  it('AC-1/AC-5/AC-11: creates an external share with recipient_type=external, singleUse hard-coded true, and audits creation', async () => {
    const { sharer, projectId, credentialId } = await createFixture('happy')

    const response = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {})

    expect(response.statusCode).toBe(201)
    const body = response.json<{
      data: {
        id: string
        token: string
        recipientType: string
        recipientEmail: string
        recipientUserId: string | null
        singleUse: boolean
      }
    }>()
    expect(body.data.recipientType).toBe('external')
    expect(body.data.recipientEmail).toBe(DEFAULT_RECIPIENT_EMAIL)
    expect(body.data.recipientUserId).toBeNull()
    expect(body.data.singleUse).toBe(true)
    expect(body.data.token).toEqual(expect.any(String))

    const audit = await withOrg(sharer.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.share_created'))
    )
    expect(audit.some((row) => row.resourceId === body.data.id)).toBe(true)
  })

  it('AC-1: an email matching an existing org member is still stored as external, never resolved to recipientUserId', async () => {
    const { sharer, projectId, credentialId } = await createFixture('email-collision')
    const teammate = await addUserToOrg(app, sharer.orgId, 'email-collision-teammate', {
      orgRole: 'member',
    })

    const response = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientEmail: teammate.email,
    })

    expect(response.statusCode).toBe(201)
    const body = response.json<{
      data: { recipientType: string; recipientUserId: string | null }
    }>()
    expect(body.data.recipientType).toBe('external')
    expect(body.data.recipientUserId).toBeNull()
  })

  it('AC-1: rejects a malformed recipientEmail with a 422 schema-validation error', async () => {
    const { sharer, projectId, credentialId } = await createFixture('bad-email')

    const response = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientEmail: 'not-an-email',
    })

    expect(response.statusCode).toBe(422)
  })

  it('AC-2: denies external-share creation for a caller below member project role', async () => {
    const { sharer, projectId, credentialId } = await createFixture('insufficient')
    const projectViewer = await addUserToOrg(app, sharer.orgId, 'insufficient-viewer', {
      orgRole: 'member',
    })
    await addProjectMember(sharer.orgId, projectId, projectViewer.userId, 'viewer')

    const response = await createExternalShareViaApi(
      projectViewer.cookies,
      projectId,
      credentialId,
      {}
    )

    expect(response.statusCode).toBe(403)
    expect(response.json<{ code: string }>().code).toBe('insufficient_project_role')
  })

  it('AC-3: a missing step-up factor fails with 401 step_up_required and no share is created', async () => {
    const { sharer, projectId, credentialId } = await createFixture('missing-factor')

    const response = await app.inject({
      method: 'POST',
      url: externalSharesUrl(projectId, credentialId),
      headers: { cookie: cookieHeader(sharer.cookies) },
      payload: { recipientEmail: DEFAULT_RECIPIENT_EMAIL, expiresAt: futureIso() },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json<{ code: string }>().code).toBe('step_up_required')

    const shares = await withOrg(sharer.orgId, (tx) =>
      tx.select().from(credentialShares).where(eq(credentialShares.credentialId, credentialId))
    )
    expect(shares).toHaveLength(0)
  })

  it('AC-3: a wrong password fails with 401 step_up_required and no share is created', async () => {
    const { sharer, projectId, credentialId } = await createFixture('wrong-pw')

    const response = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {
      password: 'definitely-wrong-password',
    })

    expect(response.statusCode).toBe(401)
    expect(response.json<{ code: string }>().code).toBe('step_up_required')

    const shares = await withOrg(sharer.orgId, (tx) =>
      tx.select().from(credentialShares).where(eq(credentialShares.credentialId, credentialId))
    )
    expect(shares).toHaveLength(0)
  })

  it('AC-5: rejects an expiresAt beyond the 72h external cap (tighter than 17.1s 7-day cap)', async () => {
    const { sharer, projectId, credentialId } = await createFixture('too-long')

    const response = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {
      expiresAt: futureIso(4 * 24 * 60 * 60 * 1000),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('expires_at_invalid')
  })

  it('AC-5: rejects singleUse: false with a dedicated 400 external_share_must_be_single_use', async () => {
    const { sharer, projectId, credentialId } = await createFixture('single-use-false')

    const response = await app.inject({
      method: 'POST',
      url: externalSharesUrl(projectId, credentialId),
      headers: { cookie: cookieHeader(sharer.cookies) },
      payload: {
        recipientEmail: DEFAULT_RECIPIENT_EMAIL,
        expiresAt: futureIso(),
        password: MEMBERSHIP_TEST_LOGIN_SECRET,
        singleUse: false,
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('external_share_must_be_single_use')
  })

  it('AC-5: accepts an explicit singleUse: true (still hard-coded true server-side)', async () => {
    const { sharer, projectId, credentialId } = await createFixture('single-use-true')

    const response = await app.inject({
      method: 'POST',
      url: externalSharesUrl(projectId, credentialId),
      headers: { cookie: cookieHeader(sharer.cookies) },
      payload: {
        recipientEmail: DEFAULT_RECIPIENT_EMAIL,
        expiresAt: futureIso(),
        password: MEMBERSHIP_TEST_LOGIN_SECRET,
        singleUse: true,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json<{ data: { singleUse: boolean } }>().data.singleUse).toBe(true)
  })

  it('AC-16: the 6th concurrent-pending external share for the same credential/field is rejected 429', async () => {
    const { sharer, projectId, credentialId } = await createFixture('cap')

    for (let i = 0; i < 5; i += 1) {
      const response = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {
        recipientEmail: `vendor-${i}@example.com`,
      })
      expect(response.statusCode).toBe(201)
    }

    const sixth = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientEmail: 'vendor-6@example.com',
    })

    expect(sixth.statusCode).toBe(429)
    expect(sixth.json<{ code: string }>().code).toBe('external_share_cap_exceeded')
  })

  it("AC-16: a share past its expiresAt but not yet lazily swept doesn't count toward the cap", async () => {
    const { sharer, projectId, credentialId } = await createFixture('cap-lazy-expire')

    for (let i = 0; i < 4; i += 1) {
      const response = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {
        recipientEmail: `vendor-${i}@example.com`,
      })
      expect(response.statusCode).toBe(201)
    }
    const fifth = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientEmail: 'vendor-4@example.com',
    })
    expect(fifth.statusCode).toBe(201)
    const fifthShareId = fifth.json<{ data: { id: string } }>().data.id

    // Backdate the 5th share's expiresAt into the past without touching its `status` — still
    // `active` in the DB, simulating the never-read (never lazily-expired) case AC-16 describes.
    await withOrg(sharer.orgId, (tx) =>
      tx
        .update(credentialShares)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(credentialShares.id, fifthShareId))
    )

    const sixth = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientEmail: 'vendor-6@example.com',
    })

    expect(sixth.statusCode).toBe(201)
  })

  it('AC-9: the metadata GET is provably inert — repeated fetches never burn the token, and reveal still succeeds', async () => {
    const { sharer, projectId, credentialId } = await createFixture('inert-get')
    const create = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {})
    const { token } = create.json<{ data: { token: string } }>().data

    for (let i = 0; i < 3; i += 1) {
      const get = await app.inject({ method: 'GET', url: accessUrl(token) })
      expect(get.statusCode).toBe(200)
      expect(get.headers['referrer-policy']).toBe('no-referrer')
      const body = get.json<{ data: { credentialName: string; sharedByDisplayName: string } }>()
      expect(body.data.credentialName).toEqual(expect.any(String))
      // AC-9: sharer email is never leaked to an unauthenticated party.
      expect(JSON.stringify(body)).not.toContain('@')
    }

    const reveal = await app.inject({ method: 'POST', url: accessUrl(token, '/reveal') })
    expect(reveal.statusCode).toBe(200)
  })

  it('AC-8/AC-13: reveal returns the value once, sets Cache-Control: no-store and Referrer-Policy, and a second reveal is already_viewed', async () => {
    const { sharer, projectId, credentialId } = await createFixture('reveal')
    const create = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {})
    const { token } = create.json<{ data: { token: string } }>().data

    const reveal = await app.inject({ method: 'POST', url: accessUrl(token, '/reveal') })
    expect(reveal.statusCode).toBe(200)
    expect(reveal.headers['cache-control']).toBe('no-store')
    expect(reveal.headers['referrer-policy']).toBe('no-referrer')
    const body = reveal.json<{ data: { value: string } }>()
    expect(body.data.value).toEqual(expect.any(String))

    const second = await app.inject({ method: 'POST', url: accessUrl(token, '/reveal') })
    expect(second.statusCode).toBe(410)
    expect(second.json<{ code: string }>().code).toBe('share_already_viewed')
  })

  it('AC-17: a malformed token and a well-formed-but-never-issued token both collapse to the same 404 shape', async () => {
    const garbage = await app.inject({ method: 'GET', url: accessUrl('short') })
    const wellFormedNeverIssued = await app.inject({
      method: 'GET',
      url: accessUrl(randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')),
    })

    expect(garbage.statusCode).toBe(404)
    expect(wellFormedNeverIssued.statusCode).toBe(404)
    expect(garbage.json()).toEqual(wellFormedNeverIssued.json())
  })

  it('AC-11/AC-12/Story 18.6: reveal audits CREDENTIAL_SHARE_VIEWED and emails the external recipient without a token', async () => {
    const dispatchSpy = vi.spyOn(dispatcher, 'createOrgAdminNotificationEntries')
    const recipientDispatchSpy = vi.spyOn(dispatcher, 'dispatchDirectEmailNotification')
    const { sharer, projectId, credentialId } = await createFixture('admin-notify')

    const create = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {})
    const { id: shareId, token } = create.json<{ data: { id: string; token: string } }>().data
    expect(recipientDispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientEmail: DEFAULT_RECIPIENT_EMAIL,
        template: expect.objectContaining({ templateId: 'credential.share_created' }),
      })
    )

    await app.inject({ method: 'POST', url: accessUrl(token, '/reveal') })
    expect(
      dispatchSpy.mock.calls.some(
        (call) => call[0].template.templateId === 'credential.external_share_viewed'
      )
    ).toBe(true)

    const audit = await withOrg(sharer.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.share_viewed'))
    )
    const entry = audit.find((row) => row.resourceId === shareId)
    expect(entry).toBeTruthy()
    expect(entry?.actorType).toBe('system')
    expect((entry?.payload as Record<string, unknown> | null)?.['recipientType']).toBe('external')

    dispatchSpy.mockRestore()
    recipientDispatchSpy.mockRestore()
  })

  it('AC-22: exceeding the reveal-attempt cap auto-revokes the share, with no attempt count leaked in the response', async () => {
    const { sharer, projectId, credentialId } = await createFixture('attempt-cap')
    const create = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {})
    const { id: shareId, token } = create.json<{ data: { id: string; token: string } }>().data

    // Force the share into a losing-attempt state (already viewed) so every subsequent reveal
    // POST resolves to a real row but loses — exactly what AC-22 counts against the cap.
    await withOrg(sharer.orgId, (tx) =>
      tx.update(credentialShares).set({ status: 'viewed' }).where(eq(credentialShares.id, shareId))
    )

    let lastResponse
    for (let i = 0; i < 6; i += 1) {
      lastResponse = await app.inject({ method: 'POST', url: accessUrl(token, '/reveal') })
      expect(lastResponse.statusCode).toBe(410)
      const responseText = JSON.stringify(lastResponse.json())
      expect(responseText).not.toMatch(/attempt/i)
      expect(responseText).not.toMatch(/remaining/i)
    }

    const [row] = await withOrg(sharer.orgId, (tx) =>
      tx.select().from(credentialShares).where(eq(credentialShares.id, shareId))
    )
    expect(row?.status).toBe('revoked')
  })

  it('AC-4/PR-251-ordering: a field renamed/removed since share creation is treated as expired, never burns the single-use claim (no CREDENTIAL_SHARE_VIEWED audit)', async () => {
    const { sharer, projectId, credentialId } = await createFixture('field-removed')
    const create = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {
      fieldKey: 'value',
    })
    expect(create.statusCode).toBe(201)
    const { id: shareId, token } = create.json<{ data: { id: string; token: string } }>().data

    // Simulate the field being renamed/removed by pointing the share at a fieldKey that no
    // longer resolves via fieldMetaForResponse — mirrors PR #251's regression scenario without
    // needing a real rename/rotation flow.
    await withOrg(sharer.orgId, (tx) =>
      tx
        .update(credentialShares)
        .set({ fieldKey: 'no-longer-exists' })
        .where(eq(credentialShares.id, shareId))
    )

    const reveal = await app.inject({ method: 'POST', url: accessUrl(token, '/reveal') })
    expect(reveal.statusCode).toBe(410)
    expect(reveal.json<{ code: string }>().code).toBe('share_expired')

    const audit = await withOrg(sharer.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.share_viewed'))
    )
    expect(audit.some((row) => row.resourceId === shareId)).toBe(false)
  })

  it('AC-19: token_hash uniqueness is enforced regardless of recipient_type (defense-in-depth, not expected to collide by construction)', async () => {
    const { sharer, projectId, credentialId } = await createFixture('unique-hash')
    const create = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {})
    expect(create.statusCode).toBe(201)
    const { id: shareId } = create.json<{ data: { id: string } }>().data

    const [row] = await withOrg(sharer.orgId, (tx) =>
      tx.select().from(credentialShares).where(eq(credentialShares.id, shareId))
    )
    if (!row) throw new Error('expected the just-created share row to exist')

    await expect(
      withOrg(sharer.orgId, (tx) =>
        tx.insert(credentialShares).values({
          orgId: sharer.orgId,
          credentialId,
          sharedBy: sharer.userId,
          recipientType: 'external',
          recipientEmail: 'other@example.com',
          tokenHash: row.tokenHash,
          singleUse: true,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          status: 'active',
        })
      )
    ).rejects.toThrow()
  })

  it('AC-22: repeated metadata GETs never increment the reveal-attempt counter', async () => {
    const { sharer, projectId, credentialId } = await createFixture('get-no-increment')
    const create = await createExternalShareViaApi(sharer.cookies, projectId, credentialId, {})
    const { id: shareId, token } = create.json<{ data: { id: string; token: string } }>().data

    for (let i = 0; i < 10; i += 1) {
      await app.inject({ method: 'GET', url: accessUrl(token) })
    }

    const [row] = await withOrg(sharer.orgId, (tx) =>
      tx.select().from(credentialShares).where(eq(credentialShares.id, shareId))
    )
    expect(row?.revealAttemptCount).toBe(0)
  })
})
