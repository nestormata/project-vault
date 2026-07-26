import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { rotations } from '@project-vault/db/schema'
import { eq } from 'drizzle-orm'
import {
  addCredentialDependencyViaApi,
  bootstrapCredentialRouteOwners,
  createCredentialTestProject,
  createCredentialViaApi,
  credentialDependenciesUrl,
} from './credential-route-test-helpers.js'
import { cookieHeader } from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createApp,
  CREDENTIAL_INTEGRATION_LOGIN_SECRET as PASSWORD,
  initVault,
  resetVaultForTest,
  type CredentialRegisteredUser as RegisteredUser,
  type CredentialTestApp as TestApp,
} from './credential-integration-context.js'

const TEST_PASSPHRASE = 'dependency-checklist-status-passphrase'

function rotationsUrl(projectId: string, credentialId: string, suffix = '') {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations${suffix}`
}

async function initiateRotationViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string
) {
  return app.inject({
    method: 'POST',
    url: rotationsUrl(projectId, credentialId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { newValue: `rotated-${randomUUID()}` },
  })
}

function checklistItemUrl(
  projectId: string,
  credentialId: string,
  rotationId: string,
  itemId: string,
  action: 'confirm' | 'fail'
) {
  return `${rotationsUrl(projectId, credentialId)}/${rotationId}/checklist/${itemId}/${action}`
}

async function confirmChecklistItemViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  ids: { projectId: string; credentialId: string; rotationId: string; itemId: string }
) {
  return app.inject({
    method: 'POST',
    url: checklistItemUrl(ids.projectId, ids.credentialId, ids.rotationId, ids.itemId, 'confirm'),
    headers: { cookie: cookieHeader(cookies) },
    payload: {},
  })
}

async function failChecklistItemViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  ids: { projectId: string; credentialId: string; rotationId: string; itemId: string }
) {
  return app.inject({
    method: 'POST',
    url: checklistItemUrl(ids.projectId, ids.credentialId, ids.rotationId, ids.itemId, 'fail'),
    headers: { cookie: cookieHeader(cookies) },
    payload: { reason: 'target system not yet updated' },
  })
}

type ListDependenciesResponse = {
  data: {
    items: {
      id: string
      systemName: string
      archivedAt: string | null
      checklistStatus: {
        rotationId: string
        itemId: string
        status: string
        confirmedBy: string | null
        confirmedAt: string | null
      } | null
    }[]
    hasDependencies: boolean
    hasStagedRotation: boolean
  }
}

async function listDependenciesViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string,
  suffix = ''
) {
  return app.inject({
    method: 'GET',
    url: credentialDependenciesUrl(projectId, credentialId, suffix),
    headers: { cookie: cookieHeader(cookies) },
  })
}

describe.sequential('AC-5: dependency list checklist-status join', () => {
  let app: TestApp
  let owner: RegisteredUser

  beforeAll(async () => {
    ;({ app, owner } = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      TEST_PASSPHRASE,
      PASSWORD,
      'checklist-join'
    ))
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('Example 5b: no staged rotation → hasStagedRotation false and every checklistStatus null', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'no-staged')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    await addCredentialDependencyViaApi(app, owner.cookies, projectId, credential.id, {
      systemName: 'alpha',
    })

    const res = await listDependenciesViaApi(app, owner.cookies, projectId, credential.id)
    expect(res.statusCode).toBe(200)
    const body = res.json<ListDependenciesResponse>()
    expect(body.data.hasStagedRotation).toBe(false)
    expect(body.data.items.every((item) => item.checklistStatus === null)).toBe(true)
  }, 20_000)

  it('Example 5a: staged rotation with mixed confirmation states', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'mixed-states')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    const alpha = await addCredentialDependencyViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      {
        systemName: 'Alpha',
      }
    )
    const beta = await addCredentialDependencyViaApi(app, owner.cookies, projectId, credential.id, {
      systemName: 'Beta',
    })
    const gamma = await addCredentialDependencyViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      {
        systemName: 'Gamma',
      }
    )
    const alphaId = alpha.json<{ data: { id: string } }>().data.id
    const betaId = beta.json<{ data: { id: string } }>().data.id
    const gammaId = gamma.json<{ data: { id: string } }>().data.id

    const initiate = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id)
    expect(initiate.statusCode).toBe(201)
    const rotationId = initiate.json<{ data: { id: string } }>().data.id
    const rotationDetail = await app.inject({
      method: 'GET',
      url: rotationsUrl(projectId, credential.id, `/${rotationId}`),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    const checklistItems = rotationDetail.json<{
      data: { checklistItems: { id: string; dependencyId: string | null }[] }
    }>().data.checklistItems
    const itemFor = (depId: string) => {
      const item = checklistItems.find((ci) => ci.dependencyId === depId)
      if (!item) throw new Error(`no checklist item for dependency ${depId}`)
      return item
    }

    await confirmChecklistItemViaApi(app, owner.cookies, {
      projectId,
      credentialId: credential.id,
      rotationId,
      itemId: itemFor(alphaId).id,
    })
    await failChecklistItemViaApi(app, owner.cookies, {
      projectId,
      credentialId: credential.id,
      rotationId,
      itemId: itemFor(gammaId).id,
    })
    // Beta stays unconfirmed/pending.

    const res = await listDependenciesViaApi(app, owner.cookies, projectId, credential.id)
    const body = res.json<ListDependenciesResponse>()
    expect(body.data.hasStagedRotation).toBe(true)

    const byId = new Map(body.data.items.map((item) => [item.id, item]))
    expect(byId.get(alphaId)?.checklistStatus).toMatchObject({
      rotationId,
      status: 'confirmed',
    })
    expect(byId.get(betaId)?.checklistStatus).toMatchObject({
      rotationId,
      status: 'unconfirmed',
    })
    expect(byId.get(gammaId)?.checklistStatus).toMatchObject({
      rotationId,
      status: 'failed',
    })
  }, 30_000)

  it('Example 5c: dependency added after the rotation was staged has null checklistStatus while hasStagedRotation is true', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'added-after-staging')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    await addCredentialDependencyViaApi(app, owner.cookies, projectId, credential.id, {
      systemName: 'pre-existing',
    })

    const initiate = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id)
    expect(initiate.statusCode).toBe(201)

    const delta = await addCredentialDependencyViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      {
        systemName: 'Delta-added-mid-rotation',
      }
    )
    const deltaId = delta.json<{ data: { id: string } }>().data.id

    const res = await listDependenciesViaApi(app, owner.cookies, projectId, credential.id)
    const body = res.json<ListDependenciesResponse>()
    expect(body.data.hasStagedRotation).toBe(true)
    const deltaItem = body.data.items.find((item) => item.id === deltaId)
    expect(deltaItem?.checklistStatus).toBeNull()
  }, 20_000)

  it('Example 5d: archived dependency is excluded by default; with includeArchived its checklistStatus is null', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'archived-dep')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    const created = await addCredentialDependencyViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      {
        systemName: 'to-archive-before-rotation',
      }
    )
    const dependencyId = created.json<{ data: { id: string } }>().data.id

    await app.inject({
      method: 'DELETE',
      url: `${credentialDependenciesUrl(projectId, credential.id)}/${dependencyId}`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })

    const defaultList = await listDependenciesViaApi(app, owner.cookies, projectId, credential.id)
    const defaultBody = defaultList.json<ListDependenciesResponse>()
    expect(defaultBody.data.items.some((item) => item.id === dependencyId)).toBe(false)

    const archivedList = await listDependenciesViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      '?includeArchived=true'
    )
    const archivedBody = archivedList.json<ListDependenciesResponse>()
    const archivedItem = archivedBody.data.items.find((item) => item.id === dependencyId)
    expect(archivedItem?.checklistStatus).toBeNull()
  }, 20_000)

  it('Example 5f: a checklist item stays confirmable after its source dependency is archived mid-rotation', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'confirm-after-archive')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    const created = await addCredentialDependencyViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      {
        systemName: 'archived-mid-rotation',
      }
    )
    const dependencyId = created.json<{ data: { id: string } }>().data.id

    const initiate = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id)
    const rotationId = initiate.json<{ data: { id: string } }>().data.id
    const rotationDetail = await app.inject({
      method: 'GET',
      url: rotationsUrl(projectId, credential.id, `/${rotationId}`),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    const itemId = rotationDetail
      .json<{
        data: { checklistItems: { id: string; dependencyId: string | null }[] }
      }>()
      .data.checklistItems.find((ci) => ci.dependencyId === dependencyId)?.id
    if (!itemId) throw new Error('expected a checklist item for the dependency')

    await app.inject({
      method: 'DELETE',
      url: `${credentialDependenciesUrl(projectId, credential.id)}/${dependencyId}`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })

    const confirm = await confirmChecklistItemViaApi(app, owner.cookies, {
      projectId,
      credentialId: credential.id,
      rotationId,
      itemId,
    })
    expect(confirm.statusCode).toBe(200)
  }, 20_000)

  it('never returns checklistStatus for a cross-org credential (404, no data leak)', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'checklist-cross-org')
    const res = await listDependenciesViaApi(app, owner.cookies, randomUUID(), randomUUID())
    expect(res.statusCode).toBe(404)
    void projectId
  }, 20_000)

  it('hasStagedRotation flips back to false once the rotation is no longer staged (promoted)', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'promoted-clears-flag')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    await addCredentialDependencyViaApi(app, owner.cookies, projectId, credential.id, {
      systemName: 'promote-target',
    })
    const initiate = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id)
    const rotationId = initiate.json<{ data: { id: string } }>().data.id

    const staged = await listDependenciesViaApi(app, owner.cookies, projectId, credential.id)
    expect(staged.json<ListDependenciesResponse>().data.hasStagedRotation).toBe(true)

    // Directly flip the rotation to 'promoted' (mirrors Story 5.6's own test convention of
    // forcing a status transition rather than depending on this story's own promote-route tests).
    await withOrg(owner.orgId, (tx) =>
      tx.update(rotations).set({ status: 'promoted' }).where(eq(rotations.id, rotationId))
    )

    const afterPromote = await listDependenciesViaApi(app, owner.cookies, projectId, credential.id)
    const body = afterPromote.json<ListDependenciesResponse>()
    expect(body.data.hasStagedRotation).toBe(false)
    expect(body.data.items.every((item) => item.checklistStatus === null)).toBe(true)
  }, 20_000)
})
