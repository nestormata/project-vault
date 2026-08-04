import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentialShares, orgMemberships } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  expectAuditWriteFailed,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import {
  bootCredentialRouteApp,
  createCredentialTestProject,
  createCredentialViaApi,
  createSharingMultiFieldFixture,
  SENTINEL_VALUE,
} from '../credentials/credential-route-test-helpers.js'
import { resourceExists } from '../credentials/bounded-share-adapter.js'

const SENTINEL_PASSWORD = 'sentinel-password-sensitive'

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'credential-shares-routes-passphrase'
const CREDENTIAL_SHARE_EXPIRED_EVENT = 'credential.share_expired'
const { addUserToOrg, registerOwner, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'share-route',
  orgNamePrefix: 'Share Route Org',
})

function nudgeUrl(projectId: string, credentialId: string, suffix = '') {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/nudge${suffix}`
}

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
    expect(JSON.stringify(body)).not.toContain(SENTINEL_VALUE)
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
    // Story 20.5 AC-2 (sensitivity-default-exclusion — the one intended Epic 17 behavior
    // tightening, not a regression): `createFixture`'s credential is a legacy single-value
    // secret, whose sole field is `sensitive: true` by convention. A whole-resource share
    // (`fieldKey`/`attributeKeys` both null) now excludes every sensitive attribute by default —
    // this share never named `value` explicitly, so the sentinel is no longer revealed, and the
    // response's empty field-array shape signals "nothing eligible", not an error.
    const body = response.json<{ data: { value: string } }>()
    expect(body.data.value).toBe('[]')
    expect(body.data.value).not.toContain(SENTINEL_VALUE)

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

  it('AC-1/AC-2: naming a sensitive attribute explicitly in attributeKeys reveals it (explicit consent overrides the default exclusion)', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('reveal-explicit')
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      attributeKeys: ['value'],
      expiresAt: futureIso(),
      singleUse: true,
    })
    expect(create.statusCode).toBe(201)
    expect(create.json<{ data: { attributeKeys: string[] | null } }>().data.attributeKeys).toEqual([
      'value',
    ])
    const { token } = create.json<{ data: { token: string } }>().data

    const response = await app.inject({
      method: 'POST',
      url: accessUrl(token, '/reveal'),
      headers: { cookie: cookieHeader(recipient.cookies) },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ data: { value: string } }>()
    expect(body.data.value).toBe(SENTINEL_VALUE)
  })

  it('AC-1: a create request with action other than "read" is rejected 422, never coerced', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('bad-action')

    const response = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      action: 'write',
      expiresAt: futureIso(),
      singleUse: true,
    })

    // Story 20.5 AC-1's prose names 400; this codebase uniformly maps every Zod schema-validation
    // failure (including this module's own existing `status` enum filter) to 422, never 400 — see
    // the story's Dev Agent Record for the note reconciling this. The request must be rejected and
    // the literal, invalid value must never be coerced into a persisted row.
    expect(response.statusCode).toBe(422)
  })

  // AC-3: `resourceExists` is one of the three required `credential` adapter functions. No
  // current call site invokes it (the sharing layer's own `credentialExistsInProject` serves
  // today's project-scoped routes instead — see the adapter's doc comment), but the function is
  // still real, exported, RLS/org-scoped surface area the contract requires to exist and behave
  // correctly, so it gets direct coverage rather than relying on indirect exercise through a route.
  it('AC-3: resourceExists is org-scoped and reflects whether the row is visible in this org', async () => {
    const { sharer, credentialId } = await createFixture('resource-exists')

    const existsInOwnOrg = await withOrg(sharer.orgId, (tx) => resourceExists(credentialId, tx))
    expect(existsInOwnOrg).toBe(true)

    const otherOrgOwner = await registerOwner(app, 'resource-exists-other')
    const existsInOtherOrg = await withOrg(otherOrgOwner.orgId, (tx) =>
      resourceExists(credentialId, tx)
    )
    expect(existsInOtherOrg).toBe(false)

    const existsForRandomId = await withOrg(sharer.orgId, (tx) => resourceExists(randomUUID(), tx))
    expect(existsForRandomId).toBe(false)
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

  it('AC-5: revoke by an unrelated member (not sharer, not admin) is denied and does not mutate the share', async () => {
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

    // Regression: the revoke handler must check authorization BEFORE mutating the share — an
    // earlier version of this route ran the state transition first and only rejected the
    // *response*, leaving the share revoked in the DB despite the 403.
    const [row] = await withOrg(sharer.orgId, (tx) =>
      tx.select().from(credentialShares).where(eq(credentialShares.id, shareId))
    )
    expect(row?.status).toBe('active')
  })

  it('AC-5: an org admin who did not create the share can list and revoke it', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('admin-revoke')
    const admin = await addUserToOrg(app, sharer.orgId, 'admin-revoke-admin', {
      orgRole: 'admin',
    })
    await addProjectMember(sharer.orgId, projectId, admin.userId, 'admin')
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })
    const { id: shareId } = create.json<{ data: { id: string } }>().data

    const list = await app.inject({
      method: 'GET',
      url: sharesUrl(projectId, credentialId),
      headers: { cookie: cookieHeader(admin.cookies) },
    })
    expect(list.statusCode).toBe(200)
    expect(
      list.json<{ data: { items: { id: string }[] } }>().data.items.some((s) => s.id === shareId)
    ).toBe(true)

    const revoke = await app.inject({
      method: 'POST',
      url: sharesUrl(projectId, credentialId, `/${shareId}/revoke`),
      headers: { cookie: cookieHeader(admin.cookies) },
    })
    expect(revoke.statusCode).toBe(200)
    expect(revoke.json<{ data: { status: string } }>().data.status).toBe('revoked')
  })

  it('AC-3/AC-9: reveal on a share whose field no longer exists is expired without burning the claim or the audit trail', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('field-gone')
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
      singleUse: true,
    })
    const { id: shareId, token } = create.json<{ data: { id: string; token: string } }>().data

    // Simulate the field having been renamed/removed from the credential's template since the
    // share was created (AC-3) by pointing the share at a field key that can never resolve.
    await withOrg(sharer.orgId, (tx) =>
      tx
        .update(credentialShares)
        .set({ fieldKey: 'field-removed-since-creation' })
        .where(eq(credentialShares.id, shareId))
    )

    const response = await app.inject({
      method: 'POST',
      url: accessUrl(token, '/reveal'),
      headers: { cookie: cookieHeader(recipient.cookies) },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json<{ code: string }>().code).toBe('share_expired')

    // Regression: this must not consume the single-use claim — the share stays 'active' (not
    // 'viewed'), and no CREDENTIAL_SHARE_VIEWED audit entry is written for a reveal that never
    // actually revealed anything.
    const [row] = await withOrg(sharer.orgId, (tx) =>
      tx.select().from(credentialShares).where(eq(credentialShares.id, shareId))
    )
    expect(row?.status).toBe('active')
    expect(row?.viewCount).toBe(0)

    const audit = await withOrg(sharer.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.share_viewed'))
    )
    expect(audit.some((a) => a.resourceId === shareId)).toBe(false)
  })

  it('AC-17: metadata GET lazily expires a past-due share instead of showing it as active', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('metadata-expired')
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })
    const { id: shareId, token } = create.json<{ data: { id: string; token: string } }>().data

    await withOrg(sharer.orgId, (tx) =>
      tx
        .update(credentialShares)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(credentialShares.id, shareId))
    )

    const response = await app.inject({
      method: 'GET',
      url: accessUrl(token),
      headers: { cookie: cookieHeader(recipient.cookies) },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ data: { status: string } }>().data.status).toBe('expired')

    // Story 17.3 AC-6: the lazy expiry transition writes a CREDENTIAL_SHARE_EXPIRED audit entry
    // in the same transaction as the status UPDATE — not a silent flip.
    const audit = await withOrg(sharer.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, CREDENTIAL_SHARE_EXPIRED_EVENT))
    )
    expect(audit.some((a) => a.resourceId === shareId)).toBe(true)
  })

  it('AC-5: a share still active-but-not-yet-expired is left untouched by the lazy check (no expired transition, no audit entry)', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('metadata-not-due')
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })
    const { id: shareId, token } = create.json<{ data: { id: string; token: string } }>().data

    const response = await app.inject({
      method: 'GET',
      url: accessUrl(token),
      headers: { cookie: cookieHeader(recipient.cookies) },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ data: { status: string } }>().data.status).toBe('active')

    const audit = await withOrg(sharer.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, CREDENTIAL_SHARE_EXPIRED_EVENT))
    )
    expect(audit.some((a) => a.resourceId === shareId)).toBe(false)
  })

  it('AC-5: a share that is already revoked when its expiresAt passes does not get a spurious expired transition or audit entry', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture(
      'metadata-revoked-then-due'
    )
    const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })
    const { id: shareId, token } = create.json<{ data: { id: string; token: string } }>().data

    await app.inject({
      method: 'POST',
      url: sharesUrl(projectId, credentialId, `/${shareId}/revoke`),
      headers: { cookie: cookieHeader(sharer.cookies) },
    })
    await withOrg(sharer.orgId, (tx) =>
      tx
        .update(credentialShares)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(credentialShares.id, shareId))
    )

    const response = await app.inject({
      method: 'GET',
      url: accessUrl(token),
      headers: { cookie: cookieHeader(recipient.cookies) },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ data: { status: string } }>().data.status).toBe('revoked')

    const audit = await withOrg(sharer.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, CREDENTIAL_SHARE_EXPIRED_EVENT))
    )
    expect(audit.some((a) => a.resourceId === shareId)).toBe(false)
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

  it('AC-1: filters the list by status, and rejects an invalid status with 422', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('status-filter')
    const active = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })
    const activeId = active.json<{ data: { id: string } }>().data.id
    const revoke = await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })
    const revokeId = revoke.json<{ data: { id: string } }>().data.id
    await app.inject({
      method: 'POST',
      url: sharesUrl(projectId, credentialId, `/${revokeId}/revoke`),
      headers: { cookie: cookieHeader(sharer.cookies) },
    })

    const filtered = await app.inject({
      method: 'GET',
      url: sharesUrl(projectId, credentialId, '?status=revoked'),
      headers: { cookie: cookieHeader(sharer.cookies) },
    })
    expect(filtered.statusCode).toBe(200)
    const filteredBody = filtered.json<{ data: { items: { id: string; status: string }[] } }>()
    expect(filteredBody.data.items.every((item) => item.status === 'revoked')).toBe(true)
    expect(filteredBody.data.items.some((item) => item.id === revokeId)).toBe(true)
    expect(filteredBody.data.items.some((item) => item.id === activeId)).toBe(false)

    const invalid = await app.inject({
      method: 'GET',
      url: sharesUrl(projectId, credentialId, '?status=bogus'),
      headers: { cookie: cookieHeader(sharer.cookies) },
    })
    expect(invalid.statusCode).toBe(422)
  })

  it('AC-2: paginates with limit/offset and a total count, clamping an over-large limit rather than rejecting it', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('pagination')
    for (let i = 0; i < 3; i += 1) {
      await createShareViaApi(sharer.cookies, projectId, credentialId, {
        recipientUserId: recipient.userId,
        expiresAt: futureIso(),
      })
    }

    const page1 = await app.inject({
      method: 'GET',
      url: sharesUrl(projectId, credentialId, '?limit=2&offset=0'),
      headers: { cookie: cookieHeader(sharer.cookies) },
    })
    expect(page1.statusCode).toBe(200)
    const page1Body = page1.json<{ data: { items: unknown[]; total: number } }>()
    expect(page1Body.data.items).toHaveLength(2)
    expect(page1Body.data.total).toBeGreaterThanOrEqual(3)

    const page2 = await app.inject({
      method: 'GET',
      url: sharesUrl(projectId, credentialId, '?limit=2&offset=2'),
      headers: { cookie: cookieHeader(sharer.cookies) },
    })
    expect(page2.statusCode).toBe(200)
    const page2Body = page2.json<{ data: { items: unknown[]; total: number } }>()
    expect(page2Body.data.items.length).toBeGreaterThanOrEqual(1)

    // Edge case: limit=500 is clamped to 100 server-side, not rejected with a 400/422.
    const clamped = await app.inject({
      method: 'GET',
      url: sharesUrl(projectId, credentialId, '?limit=500'),
      headers: { cookie: cookieHeader(sharer.cookies) },
    })
    expect(clamped.statusCode).toBe(200)
  })

  it('AC-11: GET nudge returns an active bucket after a share is created, and no buckets for a never-shared credential', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('nudge-list')

    const emptyRes = await app.inject({
      method: 'GET',
      url: nudgeUrl(projectId, credentialId),
      headers: { cookie: cookieHeader(sharer.cookies) },
    })
    expect(emptyRes.statusCode).toBe(200)
    expect(emptyRes.json<{ data: { items: unknown[] } }>().data.items).toHaveLength(0)

    await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })

    const afterShareRes = await app.inject({
      method: 'GET',
      url: nudgeUrl(projectId, credentialId),
      headers: { cookie: cookieHeader(sharer.cookies) },
    })
    expect(afterShareRes.statusCode).toBe(200)
    const body = afterShareRes.json<{
      data: { items: { fieldKey: string | null; active: boolean }[] }
    }>()
    expect(body.data.items).toHaveLength(1)
    expect(body.data.items[0]?.fieldKey).toBeNull()
    expect(body.data.items[0]?.active).toBe(true)
  })

  it('AC-15: dismissing the nudge requires a non-empty reason, records the dismissal, writes an audit entry, and clears the nudge', async () => {
    const { sharer, recipient, projectId, credentialId } = await createFixture('nudge-dismiss')
    await createShareViaApi(sharer.cookies, projectId, credentialId, {
      recipientUserId: recipient.userId,
      expiresAt: futureIso(),
    })

    const emptyReasonRes = await app.inject({
      method: 'POST',
      url: nudgeUrl(projectId, credentialId, '/dismiss'),
      headers: { cookie: cookieHeader(sharer.cookies) },
      payload: { reason: '   ' },
    })
    expect(emptyReasonRes.statusCode).toBe(422)

    const dismissRes = await app.inject({
      method: 'POST',
      url: nudgeUrl(projectId, credentialId, '/dismiss'),
      headers: { cookie: cookieHeader(sharer.cookies) },
      payload: { reason: 'Rotated out of band' },
    })
    expect(dismissRes.statusCode).toBe(200)

    const nudgeAfterDismiss = await app.inject({
      method: 'GET',
      url: nudgeUrl(projectId, credentialId),
      headers: { cookie: cookieHeader(sharer.cookies) },
    })
    const body = nudgeAfterDismiss.json<{ data: { items: { active: boolean }[] } }>()
    expect(body.data.items[0]?.active).toBe(false)

    const audit = await withOrg(sharer.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.share_nudge_dismissed'))
    )
    expect(audit.length).toBeGreaterThanOrEqual(1)
  })

  describe('Story 20.5: bounded/scoped sharing (Scoped/Bounded Sharing Contract)', () => {
    async function createMultiFieldFixture(label: string) {
      const { sharer, projectId, credentialId } = await createSharingMultiFieldFixture(
        app,
        registerOwner,
        label,
        'sentinel-username-non-sensitive',
        SENTINEL_PASSWORD
      )
      const recipient = await addUserToOrg(app, sharer.orgId, `${label}-recipient`, {
        orgRole: 'member',
      })
      return { sharer, recipient, projectId, credentialId }
    }

    it('AC-2: whole-resource share (attributeKeys omitted) of a mixed credential returns only non-sensitive fields', async () => {
      const { sharer, recipient, projectId, credentialId } =
        await createMultiFieldFixture('bounded-default')
      const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
        recipientUserId: recipient.userId,
        expiresAt: futureIso(),
        singleUse: true,
      })
      expect(create.statusCode).toBe(201)
      const { token } = create.json<{ data: { token: string } }>().data

      const response = await app.inject({
        method: 'POST',
        url: accessUrl(token, '/reveal'),
        headers: { cookie: cookieHeader(recipient.cookies) },
      })
      expect(response.statusCode).toBe(200)
      const { value } = response.json<{ data: { value: string } }>().data
      const fields = JSON.parse(value) as Array<{ key: string; sensitive: boolean }>
      expect(fields).toEqual([
        { key: 'username', value: 'sentinel-username-non-sensitive', sensitive: false },
      ])
      // Failure case (AC-2): no sensitive field is ever returned unnamed.
      expect(value).not.toContain(SENTINEL_PASSWORD)
    })

    it('AC-1/AC-2: attributeKeys naming a sensitive field explicitly includes it (explicit consent)', async () => {
      const { sharer, recipient, projectId, credentialId } =
        await createMultiFieldFixture('bounded-explicit')
      const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
        recipientUserId: recipient.userId,
        attributeKeys: ['password'],
        expiresAt: futureIso(),
        singleUse: true,
      })
      expect(create.statusCode).toBe(201)
      expect(
        create.json<{ data: { attributeKeys: string[] | null } }>().data.attributeKeys
      ).toEqual(['password'])
      const { token } = create.json<{ data: { token: string } }>().data

      const response = await app.inject({
        method: 'POST',
        url: accessUrl(token, '/reveal'),
        headers: { cookie: cookieHeader(recipient.cookies) },
      })
      expect(response.statusCode).toBe(200)
      const { value } = response.json<{ data: { value: string } }>().data
      const fields = JSON.parse(value) as Array<{ key: string; value: string; sensitive: boolean }>
      expect(fields).toEqual([{ key: 'password', value: SENTINEL_PASSWORD, sensitive: true }])
    })

    it('AC-1: an unknown attributeKeys entry is rejected the same way an unknown fieldKey is', async () => {
      const { sharer, recipient, projectId, credentialId } =
        await createMultiFieldFixture('bounded-unknown-key')
      const response = await createShareViaApi(sharer.cookies, projectId, credentialId, {
        recipientUserId: recipient.userId,
        attributeKeys: ['does-not-exist'],
        expiresAt: futureIso(),
        singleUse: true,
      })
      expect(response.statusCode).toBe(400)
      expect(response.json<{ code: string }>().code).toBe('unknown_field_key')
    })

    it('AC-1: specifying both fieldKey and attributeKeys is rejected rather than silently preferring one', async () => {
      const { sharer, recipient, projectId, credentialId } =
        await createMultiFieldFixture('bounded-both')
      const response = await createShareViaApi(sharer.cookies, projectId, credentialId, {
        recipientUserId: recipient.userId,
        fieldKey: 'username',
        attributeKeys: ['password'],
        expiresAt: futureIso(),
        singleUse: true,
      })
      expect(response.statusCode).toBe(422)
    })

    it('AC-1 (bugfix, review patch): the 50-key attributeKeys cap applies to the deduplicated set, not the raw request — 51 raw entries where one is a case-variant duplicate of another (50 unique after normalization) is accepted', async () => {
      const sharer = await registerOwner(app, 'bounded-cap-dedup-sharer')
      const recipient = await addUserToOrg(app, sharer.orgId, 'bounded-cap-dedup-recipient', {
        orgRole: 'member',
      })
      const projectId = await createCredentialTestProject(app, sharer.cookies, 'bounded-cap-dedup')
      const fieldKeys = Array.from({ length: 50 }, (_, i) => `field${i}`)
      const credential = await createCredentialViaApi(app, sharer.cookies, projectId, {
        name: 'bounded-cap-dedup-login',
        template: 'login',
        fields: fieldKeys.map((key) => ({ key, value: `value-${key}`, sensitive: false })),
      } as unknown as { name: string; value: string })

      const response = await createShareViaApi(sharer.cookies, projectId, credential.id, {
        recipientUserId: recipient.userId,
        // 51 raw entries, only 50 distinct once normalized (trim/case-folded) — the last entry
        // is an upper-cased duplicate of the first. Before the reordering fix, a raw Zod
        // `.max(50)` on the UN-deduplicated array rejected this with a 422 even though the
        // deduplicated set fits the cap; now the cap is enforced post-dedup, so this succeeds.
        attributeKeys: [...fieldKeys, 'FIELD0'],
        expiresAt: futureIso(),
        singleUse: true,
      })
      expect(response.statusCode).toBe(201)
      expect(
        response.json<{ data: { attributeKeys: string[] | null } }>().data.attributeKeys
      ).toHaveLength(50)
    })

    it("AC-4: a cross-org shareId/credentialId combination is not visible to a different org's owner", async () => {
      const fixtureA = await createMultiFieldFixture('bounded-cross-org-a')
      const fixtureB = await createMultiFieldFixture('bounded-cross-org-b')

      const create = await createShareViaApi(
        fixtureA.sharer.cookies,
        fixtureA.projectId,
        fixtureA.credentialId,
        {
          recipientUserId: fixtureA.recipient.userId,
          expiresAt: futureIso(),
          singleUse: true,
        }
      )
      expect(create.statusCode).toBe(201)
      const { id: shareId } = create.json<{ data: { id: string } }>().data

      // Story 20.5 AC-4: org B's own owner, scoped to org A's project/credential ids, must not
      // see org A's share — the sharing layer's org-scoped transaction (not the adapter) is what
      // enforces this, so this also exercises that the adapter never receives an unscoped lookup.
      const revokeAsOtherOrg = await app.inject({
        method: 'POST',
        url: sharesUrl(fixtureA.projectId, fixtureA.credentialId, `/${shareId}/revoke`),
        headers: { cookie: cookieHeader(fixtureB.sharer.cookies) },
      })
      expect(revokeAsOtherOrg.statusCode).toBe(404)

      const listAsOtherOrg = await app.inject({
        method: 'GET',
        url: sharesUrl(fixtureA.projectId, fixtureA.credentialId),
        headers: { cookie: cookieHeader(fixtureB.sharer.cookies) },
      })
      expect(listAsOtherOrg.statusCode).toBe(404)
    })

    it('AC-1/AC-3: a legacy fieldKey-only share (no attributeKeys) of a sensitive field still reveals it unfiltered (backward compatibility)', async () => {
      // Proves the backward-compatibility guarantee `effectiveAttributeKeysForShare`'s doc comment
      // asserts but no existing test exercised directly: naming a single field via the legacy
      // `fieldKey` column is exactly as much explicit consent as naming it via `attributeKeys`, so
      // a `sensitive: true` field named this way must never be excluded by AC-2's sensitivity-
      // default-exclusion rule (that rule only applies to a whole-resource share with neither
      // `fieldKey` nor `attributeKeys` set). On a genuine multi-field credential, `revealCurrentValue`'s
      // own `?field=` path returns `kind: 'fields'` (a one-element JSON envelope), not a bare
      // string — the real assertion here is that the real password value is present, unmasked,
      // not filtered out.
      const { sharer, recipient, projectId, credentialId } = await createMultiFieldFixture(
        'legacy-field-key-sensitive'
      )
      const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
        recipientUserId: recipient.userId,
        fieldKey: 'password',
        expiresAt: futureIso(),
        singleUse: true,
      })
      expect(create.statusCode).toBe(201)
      expect(
        create.json<{ data: { fieldKey: string | null; attributeKeys: string[] | null } }>().data
          .fieldKey
      ).toBe('password')
      const { token } = create.json<{ data: { token: string } }>().data

      const response = await app.inject({
        method: 'POST',
        url: accessUrl(token, '/reveal'),
        headers: { cookie: cookieHeader(recipient.cookies) },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ data: { value: string } }>()
      const fields = JSON.parse(body.data.value) as Array<{
        key: string
        value: string
        sensitive: boolean
      }>
      expect(fields).toEqual([{ key: 'password', value: SENTINEL_PASSWORD, sensitive: true }])
    })

    it('AC-2/AC-3: a multi-key attributeKeys share whose every named field was renamed/removed since creation is expired, never a silent 200 with an empty field array', async () => {
      // Regression coverage for the "empty result" ambiguity `serializeBoundedFiltered` must
      // resolve correctly: for an explicit, non-null `attributeKeys` allow-list, named keys are
      // never sensitivity-filtered (see `isIncluded`), so the ONLY way filtering can yield zero
      // fields is that none of the named keys still exist on the credential's current version —
      // that must collapse to the same `not_found` -> `expired` outcome the single-key path
      // (`serializeBoundedSingleKey`) already gives for the identical scenario, not a 200 OK with
      // `fields: []` (which is reserved for a legitimate whole-resource share with zero eligible
      // non-sensitive fields).
      const { sharer, recipient, projectId, credentialId } = await createMultiFieldFixture(
        'bounded-multikey-all-removed'
      )
      const create = await createShareViaApi(sharer.cookies, projectId, credentialId, {
        recipientUserId: recipient.userId,
        attributeKeys: ['username', 'password'],
        expiresAt: futureIso(),
        singleUse: true,
      })
      expect(create.statusCode).toBe(201)
      const { id: shareId, token } = create.json<{ data: { id: string; token: string } }>().data

      // Simulate both named fields having been renamed/removed from the credential since the share
      // was created, the same way the existing single-key "field-gone" test does.
      await withOrg(sharer.orgId, (tx) =>
        tx
          .update(credentialShares)
          .set({ attributeKeys: ['ghost-username-since-removed', 'ghost-password-since-removed'] })
          .where(eq(credentialShares.id, shareId))
      )

      const response = await app.inject({
        method: 'POST',
        url: accessUrl(token, '/reveal'),
        headers: { cookie: cookieHeader(recipient.cookies) },
      })

      expect(response.statusCode).toBe(410)
      expect(response.json<{ code: string }>().code).toBe('share_expired')

      // Regression: must not burn the single-use claim or write a spurious viewed audit entry —
      // same invariant the existing single-key "field-gone" test asserts.
      const [row] = await withOrg(sharer.orgId, (tx) =>
        tx.select().from(credentialShares).where(eq(credentialShares.id, shareId))
      )
      expect(row?.status).toBe('active')
      expect(row?.viewCount).toBe(0)
    })

    it('AC-5: an audit-write failure on bounded-share creation rolls back the whole create (no persisted row)', async () => {
      const { sharer, recipient, projectId, credentialId } =
        await createMultiFieldFixture('bounded-audit-fail')
      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error('forced audit failure'))
      try {
        const response = await createShareViaApi(sharer.cookies, projectId, credentialId, {
          recipientUserId: recipient.userId,
          attributeKeys: ['username'],
          expiresAt: futureIso(),
          singleUse: true,
        })
        expectAuditWriteFailed(response)

        const rows = await withOrg(sharer.orgId, (tx) =>
          tx.select().from(credentialShares).where(eq(credentialShares.credentialId, credentialId))
        )
        expect(rows).toHaveLength(0)
      } finally {
        auditSpy.mockRestore()
      }
    })
  })
})
