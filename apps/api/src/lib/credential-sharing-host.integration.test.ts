import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExtensionManifest } from '@project-vault/extension-api'
import { CredentialSharingNoMachineUserError } from '@project-vault/extension-api'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
} from '../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import { createMembershipTestHelpers } from '../__tests__/helpers/membership-test-helpers.js'
import {
  bootCredentialRouteApp,
  createCredentialTestProject,
  createCredentialViaApi,
} from '../modules/credentials/credential-route-test-helpers.js'
import {
  buildCredentialSharingHost,
  __resetCredentialSharingHostRateLimitForTests,
  __resetCredentialSharingOrgRateLimitForTests,
} from './credential-sharing-host.js'

/**
 * Story 20.12 Task 5 — real-Postgres integration coverage for `buildCredentialSharingHost`
 * (AC2/AC3/AC4/AC6): cross-tenant scoping, the full create -> findByToken -> reveal ->
 * re-reveal-fails round trip through the facade only (proving no direct DB access is needed
 * anywhere in the call chain), and rotation-supersession scoping. Unit-level control-flow
 * coverage (rate limiting, machine-user fail-closed, audit outcomes) lives in
 * `credential-sharing-host.test.ts`.
 */

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner } = createMembershipTestHelpers({
  emailPrefix: 'cred-sharing-host',
  orgNamePrefix: 'Credential Sharing Host Org',
})

const EXTENSION_NAME = 'com.acme.credential-sharing-host-fixture'
const RECIPIENT_EMAIL = 'recipient@invalid'

const MANIFEST: ExtensionManifest = {
  name: EXTENSION_NAME,
  apiVersion: '3.22.0',
  capabilities: [],
}

function machineUsersUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/machine-users`
}
function apiKeysUrl(machineUserId: string): string {
  return `/api/v1/machine-users/${machineUserId}/api-keys`
}

async function provisionMachineUserForExtension(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string
): Promise<void> {
  const created = await app.inject({
    method: 'POST',
    url: machineUsersUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
    // The facade resolves a machine-user for an org by matching `name` to the calling
    // extension's manifest name — see credential-sharing-host.ts's `resolveMachineUserForExtension`
    // doc comment for the full convention rationale.
    payload: { name: EXTENSION_NAME, role: 'member' },
  })
  expect(created.statusCode).toBe(201)
  const machineUserId = created.json<{ data: { id: string } }>().data.id

  const key = await app.inject({
    method: 'POST',
    url: apiKeysUrl(machineUserId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: 'facade-fixture-key' },
  })
  expect(key.statusCode).toBe(201)
}

function futureIso(ms = 60 * 60 * 1000): string {
  return new Date(Date.now() + ms).toISOString()
}

describe('buildCredentialSharingHost — real-Postgres integration (Story 20.12 Task 5)', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    app = await bootCredentialRouteApp(createApp, initVault, 'credential-sharing-host-passphrase')
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('AC2/AC3: end-to-end create -> findByToken -> reveal -> single-use re-reveal-fails round trip through the facade only', async () => {
    __resetCredentialSharingHostRateLimitForTests()
    __resetCredentialSharingOrgRateLimitForTests()
    const owner = await registerOwner(app, 'roundtrip')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'roundtrip')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'roundtrip-credential',
      value: 'super-secret-value',
    })
    await provisionMachineUserForExtension(app, owner.cookies, projectId)

    const host = buildCredentialSharingHost(MANIFEST)

    const created = await host.createExternalShare({
      organizationId: owner.orgId,
      projectId,
      credentialId: credential.id,
      recipientEmail: RECIPIENT_EMAIL,
      expiresAt: futureIso(),
      // The legacy `{ name, value }` credential-create shape synthesizes a single, sensitive
      // `value` field (Story 13.2 AC-6/AC-7). A whole-resource share (no fieldKey/attributeKeys)
      // applies sensitivity-default-exclusion, so this share must explicitly name the field —
      // naming it is explicit consent, sensitive or not (see service.ts's
      // effectiveAttributeKeysForShare doc comment).
      fieldKey: 'value',
    })
    expect(created.status).toBe('ok')
    if (created.status !== 'ok') return
    expect(created.token).toBeTruthy()
    expect((created.share as { tokenHash?: unknown }).tokenHash).toBeUndefined()

    const found = await host.findShareByToken(created.token)
    expect(found.status).toBe('ok')
    if (found.status !== 'ok') return
    expect(found.share.id).toBe(created.share.id)

    const revealed = await host.revealShare(created.token)
    expect(revealed).toMatchObject({ status: 'ok', value: 'super-secret-value' })

    // Single-use — a second reveal attempt must fail, never double-reveal.
    const secondReveal = await host.revealShare(created.token)
    expect(secondReveal.status).toBe('already_viewed')
  })

  it('AC3 edge case: a syntactically-invalid raw token (garbage/non-hex) resolves to not_found on both methods, never throws', async () => {
    __resetCredentialSharingHostRateLimitForTests()
    __resetCredentialSharingOrgRateLimitForTests()
    const host = buildCredentialSharingHost(MANIFEST)

    await expect(host.findShareByToken('')).resolves.toEqual({ status: 'not_found' })
    await expect(host.findShareByToken('not-hex-garbage!!! spaces')).resolves.toEqual({
      status: 'not_found',
    })
    await expect(host.revealShare('')).resolves.toEqual({ status: 'not_found' })
    await expect(host.revealShare('not-hex-garbage!!! spaces')).resolves.toEqual({
      status: 'not_found',
    })
  })

  it('AC2/AC6 cross-tenant scoping: createExternalShare fails closed for an org with no machine-user mapping, never touching another org', async () => {
    __resetCredentialSharingHostRateLimitForTests()
    __resetCredentialSharingOrgRateLimitForTests()
    const ownerA = await registerOwner(app, 'tenant-a')
    const projectA = await createCredentialTestProject(app, ownerA.cookies, 'tenant-a')
    const credentialA = await createCredentialViaApi(app, ownerA.cookies, projectA, {
      name: 'tenant-a-credential',
      value: 'tenant-a-secret',
    })
    // Deliberately NOT provisioning a machine-user for ownerA's org.

    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.createExternalShare({
        organizationId: ownerA.orgId,
        projectId: projectA,
        credentialId: credentialA.id,
        recipientEmail: RECIPIENT_EMAIL,
        expiresAt: futureIso(),
      })
    ).rejects.toBeInstanceOf(CredentialSharingNoMachineUserError)
  })

  it('AC4 cross-tenant scoping: revokeShare scoped to (organizationId, credentialId) never revokes a same-id share belonging to a different org', async () => {
    __resetCredentialSharingHostRateLimitForTests()
    __resetCredentialSharingOrgRateLimitForTests()
    const ownerA = await registerOwner(app, 'revoke-tenant-a')
    const projectA = await createCredentialTestProject(app, ownerA.cookies, 'revoke-tenant-a')
    const credentialA = await createCredentialViaApi(app, ownerA.cookies, projectA, {
      name: 'revoke-tenant-a-credential',
      value: 'tenant-a-secret',
    })
    await provisionMachineUserForExtension(app, ownerA.cookies, projectA)

    const ownerB = await registerOwner(app, 'revoke-tenant-b')
    const projectB = await createCredentialTestProject(app, ownerB.cookies, 'revoke-tenant-b')
    const credentialB = await createCredentialViaApi(app, ownerB.cookies, projectB, {
      name: 'revoke-tenant-b-credential',
      value: 'tenant-b-secret',
    })
    await provisionMachineUserForExtension(app, ownerB.cookies, projectB)

    const host = buildCredentialSharingHost(MANIFEST)
    const shareA = await host.createExternalShare({
      organizationId: ownerA.orgId,
      projectId: projectA,
      credentialId: credentialA.id,
      recipientEmail: RECIPIENT_EMAIL,
      expiresAt: futureIso(),
    })
    expect(shareA.status).toBe('ok')
    if (shareA.status !== 'ok') return

    // Org B tries to revoke org A's shareId, scoped to its own (org B, credential B) — must be
    // not_found, never reaching across the tenant boundary.
    const revokeFromWrongOrg = await host.revokeShare({
      organizationId: ownerB.orgId,
      projectId: projectB,
      credentialId: credentialB.id,
      shareId: shareA.share.id,
    })
    expect(revokeFromWrongOrg).toEqual({ status: 'not_found' })

    // The real owner can still revoke its own share.
    const revokeFromOwner = await host.revokeShare({
      organizationId: ownerA.orgId,
      projectId: projectA,
      credentialId: credentialA.id,
      shareId: shareA.share.id,
    })
    expect(revokeFromOwner).toMatchObject({ status: 'ok', alreadyTerminal: false })
  })

  it('AC4: revokeShare idempotent-no-op on an already-terminal share (matches HTTP route behavior)', async () => {
    __resetCredentialSharingHostRateLimitForTests()
    __resetCredentialSharingOrgRateLimitForTests()
    const owner = await registerOwner(app, 'idempotent-revoke')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'idempotent-revoke')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'idempotent-revoke-credential',
      value: 'secret',
    })
    await provisionMachineUserForExtension(app, owner.cookies, projectId)

    const host = buildCredentialSharingHost(MANIFEST)
    const created = await host.createExternalShare({
      organizationId: owner.orgId,
      projectId,
      credentialId: credential.id,
      recipientEmail: RECIPIENT_EMAIL,
      expiresAt: futureIso(),
    })
    expect(created.status).toBe('ok')
    if (created.status !== 'ok') return

    const first = await host.revokeShare({
      organizationId: owner.orgId,
      projectId,
      credentialId: credential.id,
      shareId: created.share.id,
    })
    expect(first).toMatchObject({ status: 'ok', alreadyTerminal: false })

    const second = await host.revokeShare({
      organizationId: owner.orgId,
      projectId,
      credentialId: credential.id,
      shareId: created.share.id,
    })
    expect(second).toMatchObject({ status: 'ok', alreadyTerminal: true })
  })

  it('AC4: supersedeSharesForRotation scoped by targetFields — an unrelated field is left untouched', async () => {
    __resetCredentialSharingHostRateLimitForTests()
    __resetCredentialSharingOrgRateLimitForTests()
    const owner = await registerOwner(app, 'supersede')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'supersede')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'supersede-login',
      template: 'login',
      fields: [
        { key: 'username', value: 'user', sensitive: false },
        { key: 'password', value: 'pass', sensitive: true },
      ],
    } as unknown as { name: string; value: string })
    await provisionMachineUserForExtension(app, owner.cookies, projectId)

    const host = buildCredentialSharingHost(MANIFEST)
    const passwordShare = await host.createExternalShare({
      organizationId: owner.orgId,
      projectId,
      credentialId: credential.id,
      recipientEmail: RECIPIENT_EMAIL,
      expiresAt: futureIso(),
      fieldKey: 'password',
    })
    const usernameShare = await host.createExternalShare({
      organizationId: owner.orgId,
      projectId,
      credentialId: credential.id,
      recipientEmail: 'recipient2@invalid',
      expiresAt: futureIso(),
      fieldKey: 'username',
    })
    expect(passwordShare.status).toBe('ok')
    expect(usernameShare.status).toBe('ok')
    if (passwordShare.status !== 'ok' || usernameShare.status !== 'ok') return

    const result = await host.supersedeSharesForRotation({
      organizationId: owner.orgId,
      credentialId: credential.id,
      targetFields: ['password'],
      rotationId: crypto.randomUUID(),
    })

    const supersededIds = result.supersededShares.map((share) => share.id)
    expect(supersededIds).toContain(passwordShare.share.id)
    expect(supersededIds).not.toContain(usernameShare.share.id)

    const usernameAfter = await host.findShareByToken(usernameShare.token)
    expect(usernameAfter.status).toBe('ok')
    if (usernameAfter.status === 'ok') expect(usernameAfter.share.status).toBe('active')
  })

  it('AC8/AC12 cross-tenant scoping: listSharesForCredential never returns another org’s shares on a same-id credential', async () => {
    __resetCredentialSharingHostRateLimitForTests()
    __resetCredentialSharingOrgRateLimitForTests()
    const ownerA = await registerOwner(app, 'list-cred-tenant-a')
    const projectA = await createCredentialTestProject(app, ownerA.cookies, 'list-cred-tenant-a')
    const credentialA = await createCredentialViaApi(app, ownerA.cookies, projectA, {
      name: 'list-cred-tenant-a-credential',
      value: 'secret-a',
    })
    await provisionMachineUserForExtension(app, ownerA.cookies, projectA)

    const ownerB = await registerOwner(app, 'list-cred-tenant-b')
    const projectB = await createCredentialTestProject(app, ownerB.cookies, 'list-cred-tenant-b')
    const credentialB = await createCredentialViaApi(app, ownerB.cookies, projectB, {
      name: 'list-cred-tenant-b-credential',
      value: 'secret-b',
    })
    await provisionMachineUserForExtension(app, ownerB.cookies, projectB)

    const host = buildCredentialSharingHost(MANIFEST)
    const shareA = await host.createExternalShare({
      organizationId: ownerA.orgId,
      projectId: projectA,
      credentialId: credentialA.id,
      recipientEmail: RECIPIENT_EMAIL,
      expiresAt: futureIso(),
    })
    expect(shareA.status).toBe('ok')

    const listFromOwnOrg = await host.listSharesForCredential({
      organizationId: ownerA.orgId,
      credentialId: credentialA.id,
    })
    expect(listFromOwnOrg).toMatchObject({ status: 'ok', total: 1 })

    // AC8 edge case: a credentialId belonging to a different org resolves as empty, not an error.
    const listFromWrongOrg = await host.listSharesForCredential({
      organizationId: ownerB.orgId,
      credentialId: credentialA.id,
    })
    expect(listFromWrongOrg).toEqual({ status: 'ok', items: [], total: 0 })

    const listOtherCredential = await host.listSharesForCredential({
      organizationId: ownerB.orgId,
      credentialId: credentialB.id,
    })
    expect(listOtherCredential).toEqual({ status: 'ok', items: [], total: 0 })
  })

  it('AC9/AC12 cross-tenant scoping + pagination: listSharesForOrganization returns every credential’s shares in the caller’s org only', async () => {
    __resetCredentialSharingHostRateLimitForTests()
    __resetCredentialSharingOrgRateLimitForTests()
    const owner = await registerOwner(app, 'list-org-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'list-org')
    const credentialOne = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'list-org-credential-one',
      value: 'secret-one',
    })
    const credentialTwo = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'list-org-credential-two',
      value: 'secret-two',
    })
    await provisionMachineUserForExtension(app, owner.cookies, projectId)

    const otherOwner = await registerOwner(app, 'list-org-other-owner')
    const otherProjectId = await createCredentialTestProject(
      app,
      otherOwner.cookies,
      'list-org-other'
    )
    const otherCredential = await createCredentialViaApi(app, otherOwner.cookies, otherProjectId, {
      name: 'list-org-other-credential',
      value: 'secret-other',
    })
    await provisionMachineUserForExtension(app, otherOwner.cookies, otherProjectId)

    const host = buildCredentialSharingHost(MANIFEST)
    await host.createExternalShare({
      organizationId: owner.orgId,
      projectId,
      credentialId: credentialOne.id,
      recipientEmail: RECIPIENT_EMAIL,
      expiresAt: futureIso(),
    })
    await host.createExternalShare({
      organizationId: owner.orgId,
      projectId,
      credentialId: credentialTwo.id,
      recipientEmail: 'recipient3@invalid',
      expiresAt: futureIso(),
    })
    await host.createExternalShare({
      organizationId: otherOwner.orgId,
      projectId: otherProjectId,
      credentialId: otherCredential.id,
      recipientEmail: 'recipient4@invalid',
      expiresAt: futureIso(),
    })

    const orgList = await host.listSharesForOrganization({ organizationId: owner.orgId })
    expect(orgList.status).toBe('ok')
    expect(orgList.total).toBe(2)
    expect(orgList.items.map((share) => share.credentialId).sort()).toEqual(
      [credentialOne.id, credentialTwo.id].sort()
    )
    expect(orgList.items.every((share) => share.orgId === owner.orgId)).toBe(true)

    const otherOrgList = await host.listSharesForOrganization({ organizationId: otherOwner.orgId })
    expect(otherOrgList).toMatchObject({ status: 'ok', total: 1 })

    // AC9: limit/offset pagination on the org-scoped listing.
    const firstPage = await host.listSharesForOrganization({
      organizationId: owner.orgId,
      limit: 1,
    })
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.total).toBe(2)
  })

  it('AC9 edge case: an org with zero shares returns { status: "ok", items: [], total: 0 }', async () => {
    __resetCredentialSharingHostRateLimitForTests()
    __resetCredentialSharingOrgRateLimitForTests()
    const owner = await registerOwner(app, 'list-org-empty-owner')
    const host = buildCredentialSharingHost(MANIFEST)

    const result = await host.listSharesForOrganization({ organizationId: owner.orgId })
    expect(result).toEqual({ status: 'ok', items: [], total: 0 })
  })
})
