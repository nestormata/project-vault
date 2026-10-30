import { randomUUID } from 'node:crypto'
import { expect, test, type BrowserContext } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createProjectViaApi } from '../fixtures/api.js'
import { inviteAndSignIn } from '../fixtures/invited-user.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

// J44 (Story 72-14): API-level journey for POST /api/v1/projects/:projectId/members, which adds an
// EXISTING organization user to a project without an invitation. The route has no UI in PV (the
// CentralizeMe picker is injected by a module), so there is no browser page here.

type Member = { userId: string; email: string; displayName: string; role: string }

async function listMembers(context: BrowserContext, projectId: string): Promise<Member[]> {
  const response = await context.request.get(`/api/v1/projects/${projectId}/members`)
  expect(response.status()).toBe(200)
  return ((await response.json()) as { data: Member[] }).data
}

const OWNER_PASSWORD = 'e2e-Owner-Password-123'
const INVITEE_PASSWORD = 'e2e-Invitee-Password-123'
const STRANGER_PASSWORD = 'e2e-Stranger-Password-123'

test.describe('J44 — add an existing organization user to a project', () => {
  test('an owner adds an existing org user; repeats and unknown users are refused', async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext()
    await registerAndLoginViaApi(ownerContext, {
      email: uniqueEmail('j44-owner'),
      password: OWNER_PASSWORD,
      orgName: uniqueOrgName('J44 Org'),
    })
    const firstProject = await createProjectViaApi(ownerContext, {
      name: uniqueProjectName('J44 First'),
      slug: `j44-first-${Date.now()}`,
    })
    const secondProject = await createProjectViaApi(ownerContext, {
      name: uniqueProjectName('J44 Second'),
      slug: `j44-second-${Date.now()}`,
    })

    // Accepting an invitation to the first project makes the invitee an organization user.
    const invitee = await inviteAndSignIn(ownerContext, browser, {
      projectId: firstProject.id,
      role: 'member',
      label: 'j44-invitee',
      password: INVITEE_PASSWORD,
    })
    const inviteeId = (await listMembers(ownerContext, firstProject.id)).find(
      (member) => member.email === invitee.email
    )?.userId as string
    expect(inviteeId).toBeTruthy()
    expect((await listMembers(ownerContext, secondProject.id)).map((m) => m.userId)).not.toContain(
      inviteeId
    )

    // A project member below admin cannot add anyone.
    const refused = await invitee.page
      .context()
      .request.post(`/api/v1/projects/${firstProject.id}/members`, {
        data: { userId: inviteeId, role: 'viewer' },
      })
    expect(refused.status()).toBe(403)

    const added = await ownerContext.request.post(`/api/v1/projects/${secondProject.id}/members`, {
      data: { userId: inviteeId, role: 'viewer' },
    })
    expect(added.status(), await added.text()).toBe(201)
    const row = ((await added.json()) as { data: Member }).data
    expect(row).toEqual({
      userId: inviteeId,
      email: invitee.email,
      displayName: invitee.email,
      role: 'viewer',
    })
    expect(await listMembers(ownerContext, secondProject.id)).toContainEqual(row)

    // Re-issue: 409 already_member, never a silent 200.
    const again = await ownerContext.request.post(`/api/v1/projects/${secondProject.id}/members`, {
      data: { userId: inviteeId, role: 'admin' },
    })
    expect(again.status()).toBe(409)
    expect(await again.json()).toMatchObject({ code: 'already_member' })

    // The added project viewer cannot add either.
    const viewerWrite = await invitee.page
      .context()
      .request.post(`/api/v1/projects/${secondProject.id}/members`, {
        data: { userId: randomUUID(), role: 'viewer' },
      })
    expect(viewerWrite.status()).toBe(403)

    // Nonexistent and cross-organization users answer the same 404.
    const strangerContext = await browser.newContext()
    const stranger = await registerAndLoginViaApi(strangerContext, {
      email: uniqueEmail('j44-stranger'),
      password: STRANGER_PASSWORD,
      orgName: uniqueOrgName('J44 Other Org'),
    })
    const cross = await ownerContext.request.post(`/api/v1/projects/${secondProject.id}/members`, {
      data: { userId: stranger.userId, role: 'member' },
    })
    const missing = await ownerContext.request.post(
      `/api/v1/projects/${secondProject.id}/members`,
      {
        data: { userId: randomUUID(), role: 'member' },
      }
    )
    expect(cross.status()).toBe(404)
    expect(missing.status()).toBe(404)
    expect(await cross.json()).toEqual(await missing.json())

    // A strict body: `owner` is not assignable.
    const owner = await ownerContext.request.post(`/api/v1/projects/${secondProject.id}/members`, {
      data: { userId: stranger.userId, role: 'owner' },
    })
    expect(owner.status()).toBe(422)

    await ownerContext.close()
    await strangerContext.close()
    await invitee.page.context().close()
  })
})
