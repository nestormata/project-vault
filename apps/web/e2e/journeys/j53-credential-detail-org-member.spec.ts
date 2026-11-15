import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { createCredentialViaApi, createProjectViaApi } from '../fixtures/api.js'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import {
  describeEachAppearance,
  expectAppearanceApplied,
  expectNoHorizontalOverflow,
} from '../fixtures/appearance.js'
import { armHydrationDetection, waitForHydration } from '../fixtures/hydration.js'
import {
  uniqueCredentialValue,
  uniqueEmail,
  uniqueOrgName,
  uniqueProjectName,
} from '../fixtures/ids.js'
import { inviteAndSignIn } from '../fixtures/invited-user.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'
const MEMBER_PASSWORD = 'e2e-Member-Password-123'
const SECRET_NAME = 'J53 grouped secret'

// J53 (Story 73.18 / DW-536): an org member invited as project viewer opens a credential they
// can see. The page used to 500 because the load called admin-only GET /org/users.
// Numbered J53 because 73-17 (PR #707) already took J52 for the legacy share field journey.

describeEachAppearance('J53 credential detail for an org member', (appearance) => {
  test('AC1/AC2: a project viewer gets 200 and the limited view, never the error page', async ({
    context,
    browser,
  }) => {
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j53-owner'),
      password: OWNER_PASSWORD,
      orgName: uniqueOrgName('J53 Org'),
    })
    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('J53 Project'),
      slug: `j53-${randomUUID().slice(0, 12)}`,
    })
    const secretValue = uniqueCredentialValue('j53-value-never-shown')
    const credential = await createCredentialViaApi(context, project.id, {
      name: SECRET_NAME,
      value: secretValue,
    })
    const member = await inviteAndSignIn(context, browser, {
      projectId: project.id,
      role: 'viewer',
      label: 'j53-member',
      password: MEMBER_PASSWORD,
    })
    const me = await member.page.request.get('/api/v1/auth/me')
    expect(((await me.json()) as { data: { orgRole: string } }).data.orgRole).toBe('member')

    const pageErrors: string[] = []
    member.page.on('pageerror', (error) => pageErrors.push(error.message))

    const path = `/projects/${project.id}/credentials/${credential.id}`
    await member.page.setViewportSize({ ...appearance.viewport })
    await member.page.emulateMedia({ colorScheme: appearance.colorScheme })
    await armHydrationDetection(member.page)
    const response = await member.page.goto(path)
    expect(response, 'credential detail navigation').not.toBeNull()
    expect(response?.status()).toBe(200)
    const heading = member.page.getByRole('heading', { level: 1, name: SECRET_NAME })
    await waitForHydration(member.page, heading)

    await expectAppearanceApplied(member.page, appearance)
    await expect(heading).toBeVisible()
    await expect(member.page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0)
    await expect(
      member.page.getByText('Revealing values requires Member access or higher.')
    ).toBeVisible()
    await expect(member.page.getByText(secretValue)).toHaveCount(0)
    expect(pageErrors).toEqual([])
    await expectNoHorizontalOverflow(member.page)

    await member.page.context().close()
  })
})
