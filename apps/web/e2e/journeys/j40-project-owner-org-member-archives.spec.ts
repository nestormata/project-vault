import { expect, test, type Page } from '@playwright/test'
import { enrollMfaViaApi, registerAndLoginViaApi, signInInvitee } from '../fixtures/auth.js'
import { createInvitationViaApi, createProjectViaApi } from '../fixtures/api.js'
import { extractTokenFromAcceptUrl, readLatestInvitationAcceptUrl } from '../fixtures/db.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'
import { gotoHydrated } from '../fixtures/hydration.js'

// J40 (Story 69.20, DW-618): an org `member` who owns a project archives it from the projects list,
// and the same user, as a project `admin` on someone else's project, is offered no Archive and the
// API refuses it. The web and the API share one archive rule.

function card(page: Page, name: string) {
  return page.locator('li').filter({ hasText: name })
}

test.describe('J40 — a project owner who is an org member can archive', () => {
  test('archives their own project from the list; no Archive as a project admin', async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext()
    await registerAndLoginViaApi(ownerContext, {
      email: uniqueEmail('j40-owner'),
      password: 'e2e-Owner-Password-123',
      orgName: uniqueOrgName('J40 Org'),
    })
    await ownerContext.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })
    const theirs = await createProjectViaApi(ownerContext, {
      name: uniqueProjectName('J40 Theirs'),
      slug: `j40-theirs-${Date.now()}`,
    })
    await enrollMfaViaApi(ownerContext)

    const memberEmail = uniqueEmail('j40-member')
    await createInvitationViaApi(ownerContext, theirs.id, { email: memberEmail, role: 'admin' })
    const token = extractTokenFromAcceptUrl(await readLatestInvitationAcceptUrl(memberEmail))
    const memberContext = await browser.newContext()
    const page = await signInInvitee(memberContext, memberEmail, token, 'e2e-Member-Password-123')
    await enrollMfaViaApi(memberContext)
    const me = await memberContext.request.get('/api/v1/auth/me')
    expect(((await me.json()) as { data: { orgRole: string } }).data.orgRole).toBe('member')

    const mine = await createProjectViaApi(memberContext, {
      name: uniqueProjectName('J40 Mine'),
      slug: `j40-mine-${Date.now()}`,
    })

    await gotoHydrated(page, '/projects', page.getByRole('heading', { level: 1 }))
    await expect(card(page, theirs.name).getByText(theirs.name)).toBeVisible()
    await expect(
      card(page, theirs.name).getByRole('button', { name: 'Archive project' })
    ).toHaveCount(0)
    const refused = await memberContext.request.post(`/api/v1/projects/${theirs.id}/archive`)
    expect(refused.status()).toBe(403)

    page.once('dialog', (dialog) => void dialog.accept())
    await card(page, mine.name).getByRole('button', { name: 'Archive project' }).click()
    await expect(page.getByText(mine.name)).toHaveCount(0)

    const list = await memberContext.request.get('/api/v1/projects?includeArchived=true')
    const items = (
      (await list.json()) as { data: { items: { id: string; isArchived: boolean }[] } }
    ).data.items
    expect(items.find((item) => item.id === mine.id)?.isArchived).toBe(true)
    expect(items.find((item) => item.id === theirs.id)?.isArchived).toBe(false)

    await ownerContext.close()
    await memberContext.close()
  })
})
