import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import {
  bootCredentialRouteApp,
  createCredentialTestProject,
  createCredentialViaApi,
} from '../credentials/credential-route-test-helpers.js'
import { countSharesForOrganization, listSharesForOrganization } from './service.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'share-service',
  orgNamePrefix: 'Share Service Org',
})

describe('credential-share service normalization', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    await resetVaultForTest()
    app = await bootCredentialRouteApp(createApp, initVault, 'credential-share-service-passphrase')
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('sorts normalized attribute keys alphabetically using locale-aware comparison', async () => {
    const sharer = await registerOwner(app, 'locale-order-sharer')
    const recipient = await addUserToOrg(app, sharer.orgId, 'locale-order-recipient', {
      orgRole: 'member',
    })
    const projectId = await createCredentialTestProject(app, sharer.cookies, 'locale-order')
    const credential = await createCredentialViaApi(app, sharer.cookies, projectId, {
      name: 'locale-order-credential',
      template: 'login',
      fields: [
        { key: 'z', value: 'z-value', sensitive: false },
        { key: 'a_b', value: 'underscore-value', sensitive: false },
        { key: 'a-b', value: 'hyphen-value', sensitive: false },
      ],
    } as unknown as { name: string; value: string })

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials/${credential.id}/shares`,
      headers: { cookie: cookieHeader(sharer.cookies) },
      payload: {
        recipientUserId: recipient.userId,
        attributeKeys: ['z', 'a_b', 'a-b'],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        singleUse: true,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json<{ data: { attributeKeys: string[] } }>().data.attributeKeys).toEqual([
      'a_b',
      'a-b',
      'z',
    ])
  })
})

/** Story 20.13 AC9 — genuinely new query coverage: no `listSharesForOrganization`/
 * `countSharesForOrganization` existed anywhere in `service.ts` before this story, so it needs
 * its own direct `service.test.ts` coverage (not just a facade-level test), mirroring the
 * credential-scoped pair's own existing HTTP-route coverage shape but calling the org-scoped
 * functions directly. */
describe('listSharesForOrganization / countSharesForOrganization (AC9)', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    await resetVaultForTest()
    app = await bootCredentialRouteApp(createApp, initVault, 'org-shares-service-passphrase')
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  async function shareCredential(
    cookies: Record<string, string>,
    projectId: string,
    credentialId: string,
    recipientUserId: string
  ): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials/${credentialId}/shares`,
      headers: { cookie: cookieHeader(cookies) },
      payload: {
        recipientUserId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        singleUse: false,
      },
    })
    expect(response.statusCode).toBe(201)
  }

  it('returns shares across every credential in the org, ordered newest-first (AC9 example)', async () => {
    const sharer = await registerOwner(app, 'org-shares-owner')
    const recipient = await addUserToOrg(app, sharer.orgId, 'org-shares-recipient', {
      orgRole: 'member',
    })
    const projectId = await createCredentialTestProject(app, sharer.cookies, 'org-shares')
    const credA = await createCredentialViaApi(app, sharer.cookies, projectId, {
      name: 'org-shares-credential-a',
      value: 'value-a',
    })
    const credB = await createCredentialViaApi(app, sharer.cookies, projectId, {
      name: 'org-shares-credential-b',
      value: 'value-b',
    })
    await shareCredential(sharer.cookies, projectId, credA.id, recipient.userId)
    await shareCredential(sharer.cookies, projectId, credB.id, recipient.userId)

    const [items, total] = await withOrg(sharer.orgId, async (tx) => {
      const listParams = { orgId: sharer.orgId }
      return Promise.all([
        listSharesForOrganization(tx, listParams),
        countSharesForOrganization(tx, listParams),
      ])
    })

    expect(total).toBe(2)
    expect(items.map((share) => share.credentialId).sort()).toEqual([credA.id, credB.id].sort())
    // newest-first ordering: the most recently created share (credB's) comes first.
    expect(items[0]?.credentialId).toBe(credB.id)
  })

  it('edge case: an org with zero shares returns an empty list/zero total, not an error', async () => {
    const owner = await registerOwner(app, 'org-shares-empty-owner')

    const [items, total] = await withOrg(owner.orgId, async (tx) => {
      const listParams = { orgId: owner.orgId }
      return Promise.all([
        listSharesForOrganization(tx, listParams),
        countSharesForOrganization(tx, listParams),
      ])
    })

    expect(items).toEqual([])
    expect(total).toBe(0)
  })

  it('cross-tenant scoping: one org never sees another org’s shares', async () => {
    const ownerA = await registerOwner(app, 'org-shares-tenant-a')
    const recipientA = await addUserToOrg(app, ownerA.orgId, 'org-shares-tenant-a-recipient', {
      orgRole: 'member',
    })
    const projectA = await createCredentialTestProject(app, ownerA.cookies, 'org-shares-tenant-a')
    const credA = await createCredentialViaApi(app, ownerA.cookies, projectA, {
      name: 'org-shares-tenant-a-credential',
      value: 'value-a',
    })
    await shareCredential(ownerA.cookies, projectA, credA.id, recipientA.userId)

    const ownerB = await registerOwner(app, 'org-shares-tenant-b')

    const [itemsA, itemsB] = await Promise.all([
      withOrg(ownerA.orgId, (tx) => listSharesForOrganization(tx, { orgId: ownerA.orgId })),
      withOrg(ownerB.orgId, (tx) => listSharesForOrganization(tx, { orgId: ownerB.orgId })),
    ])

    expect(itemsA.length).toBeGreaterThan(0)
    expect(itemsA.every((share) => share.orgId === ownerA.orgId)).toBe(true)
    expect(itemsB).toEqual([])
  })

  it('status filtering and pagination match the credential-scoped pair’s own shape', async () => {
    const owner = await registerOwner(app, 'org-shares-pagination-owner')
    const recipient = await addUserToOrg(app, owner.orgId, 'org-shares-pagination-recipient', {
      orgRole: 'member',
    })
    const projectId = await createCredentialTestProject(app, owner.cookies, 'org-shares-pagination')
    const cred = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'org-shares-pagination-credential',
      value: 'value',
    })
    await shareCredential(owner.cookies, projectId, cred.id, recipient.userId)
    await shareCredential(owner.cookies, projectId, cred.id, recipient.userId)

    const [firstPage, total] = await withOrg(owner.orgId, async (tx) => {
      const listParams = { orgId: owner.orgId, status: 'active' as const, limit: 1, offset: 0 }
      return Promise.all([
        listSharesForOrganization(tx, listParams),
        countSharesForOrganization(tx, { orgId: owner.orgId, status: 'active' }),
      ])
    })

    expect(firstPage).toHaveLength(1)
    expect(total).toBe(2)
  })
})
