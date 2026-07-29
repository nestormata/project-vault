import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentialShares, orgMemberships } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import {
  bootCredentialRouteApp,
  createCredentialTestProject,
  createCredentialViaApi,
} from '../credentials/credential-route-test-helpers.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'credential-shares-routes-passphrase'
const { addUserToOrg, registerOwner, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'share-route',
  orgNamePrefix: 'Share Route Org',
})

function sharesUrl(projectId: string, credentialId: string, suffix = '') {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/shares${suffix}`
}

function accessUrl(token: string, suffix = '') {
  return `/api/v1/shares/access/${token}${suffix}`
}

function futureIso(ms = 60 * 60 * 1000): string {
  return new Date(Date.now() + ms).toISOString()
}

describe('credential-shares routes', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    app = await bootCredentialRouteApp(createApp, initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  async function createFixture(label: string) {
    const sharer = await registerOwner(app, `${label}-sharer`)
    const recipient = await addUserToOrg(app, sharer.orgId, `${label}-recipient`, {
      orgRole: 'member',
    })
    const projectId = await createCredentialTestProject(app, sharer.cookies, label)
    const credential = await createCredentialViaApi(app, sharer.cookies, projectId)
    return { sharer, recipient, projectId, credentialId: credential.id }
  }

  async function createShareViaApi(
    cookies: Record<string, string>,
    projectId: string,
    credentialId: string,
    body: Record<string, unknown>
  ) {
    return app.inject({
      method: 'POST',
      url: sharesUrl(projectId, credentialId),
      headers: { cookie: cookieHeader(cookies) },
      payload: body,
    })
  }

  it('AC-1/AC-4/AC-6/AC-7: creates a share and returns a one-time raw token, never a persisted plaintext', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('happy')

    const response = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
      singleUse: true,
    })

    expect(response.statusCode).toBe(201)
    const body = response.json<{
      data: { id: string; token: string; status: string; singleUse: boolean; fieldKey: null }
    }>()
    expect(body.data.token).toEqual(expect.any(String))
    expect(body.data.status).toBe('active')
    expect(body.data.singleUse).toBe(true)
    expect(body.data.fieldKey).toBeNull()

    const audit = await withOrg(sharer.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.share_created'))
    )
    expect(audit.some((row) => row.resourceId === body.data.id)).toBe(true)
  })

  it('AC-1: denies share creation for a caller below member project role (mirrors reveal 403 shape)', async () => {
    // Story 4.5's effective-project-role gate only bites below secureRoute's own org-role
    // `minimumRole: 'member'` floor when the caller's ORG role is >= member but their PROJECT
    // role was explicitly downgraded to viewer — an org-role-only viewer never reaches the
    // handler at all (rejected earlier by secureRoute itself with a different code).
    const { sharer, recipient, projectId, credentialId } = await createFixture('insufficient')
    const projectViewer = await addUserToOrg(app, sharer.orgId, 'insufficient-viewer', {
      orgRole: 'member',
    })
    await addProjectMember(sharer.orgId, projectId, projectViewer.userId, 'viewer')

    const response = await createShareViaApi(projectViewer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })

    expect(response.statusCode).toBe(403)
    expect(response.json<{ code: string }>().code).toBe('insufficient_project_role')
  })

  it('AC-2: rejects a self-share with 400', async () => {
    const { sharer, projectId, credentialId } = await createFixture('self')

    const response = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: sharer.userId,
      expiresAt: futureIso(),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('self_share')
  })

  it('AC-2: rejects a recipient who is not an org member', async () => {
    const { sharer, projectId, credentialId } = await createFixture('nonmember')

    const response = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: randomUUID(),
      expiresAt: futureIso(),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('recipient_not_found')
  })

  it('AC-2: rejects a deactivated recipient at creation time', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('deactivated')
    await withOrg(sharer.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ status: 'deactivated' })
        .where(eq(orgMemberships.userId, recipient.userId))
    )

    const response = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('recipient_inactive')
  })

  it('AC-3: rejects an unknown field key', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('badfield')

    const response = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      fieldKey: 'does-not-exist',
      expiresAt: futureIso(),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('unknown_field_key')
  })

  it('AC-4: rejects an expiresAt in the past', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('past')

    const response = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('expires_at_invalid')
  })

  it('AC-4: rejects an expiresAt beyond the 7-day cap', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('toolong')

    const response = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(8 * 24 * 60 * 60 * 1000),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('expires_at_invalid')
  })

  it('AC-7/AC-8: metadata GET returns share details without the value, and sets Referrer-Policy', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('metadata')
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })
    const { token } = create.json<{ data: { token: string } }>().data

    const response = await app.inject({
      method: 'GET',
      url: accessUrl(token),
      headers: { cookie: cookieHeader(recipient.cookies) },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    const body = response.json<{ data: { credentialId: string; status: string } }>()
    expect(body.data.credentialId).toBe(credentialId)
    expect(body.data.status).toBe('active')
    expect(JSON.stringify(body)).not.toContain('sentinel-credential-value-never-leaks')
  })

  it('AC-7: a token opened by a different org member (not the recipient) is a 403, not a 404', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('mismatch')
    const bystander = await addUserToOrg(app, sharer.orgId, 'mismatch-bystander', {
      orgRole: 'member',
    })
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })
    const { token } = create.json<{ data: { token: string } }>().data

    const response = await app.inject({
      method: 'GET',
      url: accessUrl(token),
      headers: { cookie: cookieHeader(bystander.cookies) },
    })

    expect(response.statusCode).toBe(403)
  })

  it('AC-8/AC-9/AC-14: reveal-step returns the value once, sets Cache-Control: no-store, and audits the view', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('reveal')
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
      singleUse: true,
    })
    const { id: shareId, token } = create.json<{ data: { id: string; token: string } }>().data

    const response = await app.inject({
      method: 'POST',
      url: accessUrl(token, '/reveal'),
      headers: { cookie: cookieHeader(recipient.cookies) },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    const body = response.json<{ data: { value: string } }>()
    expect(body.data.value).toBe('sentinel-credential-value-never-leaks')

    const audit = await withOrg(sharer.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.share_viewed'))
    )
    expect(audit.some((row) => row.resourceId === shareId)).toBe(true)

    // AC-14: a second reveal of the same single-use share is "already viewed", not the value again.
    const second = await app.inject({
      method: 'POST',
      url: accessUrl(token, '/reveal'),
      headers: { cookie: cookieHeader(recipient.cookies) },
    })
    expect(second.statusCode).toBe(410)
    expect(second.json<{ code: string }>().code).toBe('share_already_viewed')
  })

  it('AC-14: concurrent reveal requests for a single-use share only let one succeed', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('race')
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
      singleUse: true,
    })
    const { token } = create.json<{ data: { token: string } }>().data

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: 'POST',
          url: accessUrl(token, '/reveal'),
          headers: { cookie: cookieHeader(recipient.cookies) },
        })
      )
    )
    const successCount = results.filter((r) => r.statusCode === 200).length
    expect(successCount).toBe(1)
  })

  it('AC-4: a singleUse: false share stays viewable (view_count increments) until expiry', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('multiview')
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
      singleUse: false,
    })
    const { token } = create.json<{ data: { token: string } }>().data

    const first = await app.inject({
      method: 'POST',
      url: accessUrl(token, '/reveal'),
      headers: { cookie: cookieHeader(recipient.cookies) },
    })
    const secondView = await app.inject({
      method: 'POST',
      url: accessUrl(token, '/reveal'),
      headers: { cookie: cookieHeader(recipient.cookies) },
    })

    expect(first.statusCode).toBe(200)
    expect(secondView.statusCode).toBe(200)
  })

  it('AC-3/AC-8: reveal on a share whose expiresAt has passed is 410 share_expired, not the value', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('expired')
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })
    const { id: shareId, token } = create.json<{ data: { id: string; token: string } }>().data

    // Simulate the passage of time past expiry directly (no live clock in this test process).
    await withOrg(sharer.orgId, (tx) =>
      tx
        .update(credentialShares)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(credentialShares.id, shareId))
    )

    const response = await app.inject({
      method: 'POST',
      url: accessUrl(token, '/reveal'),
      headers: { cookie: cookieHeader(recipient.cookies) },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json<{ code: string }>().code).toBe('share_expired')
  })

  it('AC-16: reveal is refused once the recipient is deactivated after share creation', async () => {
    // A deactivated org member's session is already rejected by the generic auth layer before
    // any route-specific handler runs — this is the infrastructure AC-16's re-check requirement
    // relies on end-to-end (recipient_ineligible in the service layer is a same-request defense-
    // in-depth backstop for the same invariant, exercised directly in service-level tests).
    const { sharer, recipient, projectId, credentialId } = await createFixture('deactivated-view')
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })
    const { token } = create.json<{ data: { token: string } }>().data

    await withOrg(sharer.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ status: 'deactivated' })
        .where(eq(orgMemberships.userId, recipient.userId))
    )

    const response = await app.inject({
      method: 'POST',
      url: accessUrl(token, '/reveal'),
      headers: { cookie: cookieHeader(recipient.cookies) },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json<{ code: string }>().code).toBe('account_deactivated')
  })

  it('AC-5: revoke by the sharer transitions the share to revoked; a second revoke is a no-op', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('revoke')
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })
    const { id: shareId } = create.json<{ data: { id: string } }>().data

    const revoke = await app.inject({
      method: 'POST',
      url: sharesUrl(projectId, credentialId, `/${shareId}/revoke`),
      headers: { cookie: cookieHeader(sharer.cookies) },
    })
    expect(revoke.statusCode).toBe(200)
    expect(revoke.json<{ data: { status: string } }>().data.status).toBe('revoked')

    const secondRevoke = await app.inject({
      method: 'POST',
      url: sharesUrl(projectId, credentialId, `/${shareId}/revoke`),
      headers: { cookie: cookieHeader(sharer.cookies) },
    })
    expect(secondRevoke.statusCode).toBe(200)
    expect(secondRevoke.json<{ data: { status: string } }>().data.status).toBe('revoked')
  })

  it('AC-5: revoke by an unrelated member (not sharer, not admin) is denied', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('revoke-denied')
    const bystander = await addUserToOrg(app, sharer.orgId, 'revoke-denied-bystander', {
      orgRole: 'member',
    })
    // Must be a visible project member, or the 404 project-visibility gate fires first (AC-1's
    // "unknown project" precedent) — this test is specifically about the sharer-or-admin
    // authorization check, not project visibility.
    await addProjectMember(sharer.orgId, projectId, bystander.userId, 'member')
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })
    const { id: shareId } = create.json<{ data: { id: string } }>().data

    const response = await app.inject({
      method: 'POST',
      url: sharesUrl(projectId, credentialId, `/${shareId}/revoke`),
      headers: { cookie: cookieHeader(bystander.cookies) },
    })

    expect(response.statusCode).toBe(403)
  })

  it('AC-11: lists shares the current user created for a credential', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('list')
    await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })

    const response = await app.inject({
      method: 'GET',
      url: sharesUrl(projectId, credentialId),
      headers: { cookie: cookieHeader(sharer.cookies) },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ data: { items: { recipientUserId: string }[] } }>()
    expect(body.data.items.length).toBeGreaterThanOrEqual(1)
    expect(body.data.items[0]?.recipientUserId).toBe(recipient.userId)
  })
})
