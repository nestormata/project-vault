import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { credentials } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import {
  bootstrapCredentialRouteOwners,
  createCredentialTestProject,
  credentialLifecycleUrl,
} from './credential-route-test-helpers.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'cacheable-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'

describe('credential.cacheable (Story 7.2 D7)', () => {
  let app: TestApp
  let owner: { userId: string; orgId: string; cookies: Record<string, string> }

  beforeAll(async () => {
    const boot = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      TEST_PASSPHRASE,
      PASSWORD,
      'cacheable'
    )
    app = boot.app
    owner = boot.owner
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('defaults cacheable to true when omitted on create', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'cacheable-default')
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'Default Cacheable', value: 'v' },
    })
    expect(res.statusCode).toBe(201)
    const credentialId = res.json<{ data: { id: string } }>().data.id

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ cacheable: credentials.cacheable })
        .from(credentials)
        .where(eq(credentials.id, credentialId))
    )
    expect(row?.cacheable).toBe(true)
  })

  it('accepts an explicit cacheable: false on create', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'cacheable-explicit')
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'Non-Cacheable', value: 'v', cacheable: false },
    })
    expect(res.statusCode).toBe(201)
    const credentialId = res.json<{ data: { id: string } }>().data.id

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ cacheable: credentials.cacheable })
        .from(credentials)
        .where(eq(credentials.id, credentialId))
    )
    expect(row?.cacheable).toBe(false)
  })

  it('updates cacheable via the lifecycle-PATCH endpoint and returns it in the response', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'cacheable-patch')
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'Patchable', value: 'v' },
    })
    const credentialId = createRes.json<{ data: { id: string } }>().data.id

    const patchRes = await app.inject({
      method: 'PATCH',
      url: credentialLifecycleUrl(projectId, credentialId),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { cacheable: false },
    })
    expect(patchRes.statusCode).toBe(200)
    expect(patchRes.json<{ data: { cacheable: boolean } }>().data.cacheable).toBe(false)

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ cacheable: credentials.cacheable })
        .from(credentials)
        .where(eq(credentials.id, credentialId))
    )
    expect(row?.cacheable).toBe(false)
  })
})
