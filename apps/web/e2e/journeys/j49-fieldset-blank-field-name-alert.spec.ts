import { expect, test, type Page } from '@playwright/test'
import {
  describeEachAppearance,
  expectAppearanceApplied,
  expectNoHorizontalOverflow,
  type Appearance,
} from '../fixtures/appearance.js'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { fillLoginTemplateCredentialForm } from '../fixtures/credentials-ui.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'
import type { CredentialsPage } from '../pages/CredentialsPage.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'
const BLANK_NAME_ALERT = 'Field name is required'
const LOGIN_USER_KEY = 'username'
const LOGIN_PASSWORD_KEY = 'password'
const EXACT = { exact: true } as const

function fieldName(page: Page, index: number) {
  return page.getByLabel(`Field ${index} name`, EXACT)
}

function fieldCard(page: Page, index: number) {
  return fieldName(page, index).locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " space-y-1 ") and contains(concat(" ", normalize-space(@class), " "), " rounded-xl ")][1]'
  )
}

async function openLoginTemplate(
  page: Page,
  context: Parameters<typeof registerAndLoginViaApi>[0],
  appearance: Appearance,
  label: string,
  firstName: string
): Promise<{ projectId: string; credentialsPage: CredentialsPage }> {
  const slug = appearance.name.replace(/\s+/g, '-')
  await registerAndLoginViaApi(context, {
    email: uniqueEmail(`j49-${label}-${slug}`),
    password: OWNER_PASSWORD,
    orgName: uniqueOrgName('J49 Org'),
  })
  const projectRes = await context.request.post('/api/v1/projects', {
    data: { name: uniqueProjectName('J49 Project'), slug: `j49-${Date.now()}` },
  })
  expect(projectRes.ok()).toBeTruthy()
  const projectId = (await projectRes.json()).data.id as string
  const credentialsPage = await fillLoginTemplateCredentialForm(page, projectId, {
    name: 'j49-login',
    field1Value: 'svc',
    field2Value: 'pw',
    beforeSubmit: async () => {
      await expect(fieldName(page, 1)).toHaveValue(LOGIN_USER_KEY)
      await fieldName(page, 1).fill(firstName)
    },
  })
  return { projectId, credentialsPage }
}

function isCredentialDetailPath(projectId: string, pathname: string): boolean {
  const prefix = `/projects/${projectId}/credentials/`
  if (!pathname.startsWith(prefix)) return false
  const rest = pathname.slice(prefix.length).replace(/\/$/, '')
  return rest.length > 0 && rest !== 'new' && !rest.startsWith('new/')
}

describeEachAppearance('J49 blank field-name alert in the field-set editor', (appearance) => {
  test(`blank name shows Field name is required; a named field does not [${appearance.name}]`, async ({
    page,
    context,
  }) => {
    const { projectId, credentialsPage } = await openLoginTemplate(
      page,
      context,
      appearance,
      'blank',
      ''
    )
    const newCredentialPath = `/projects/${projectId}/credentials/new`
    await expectAppearanceApplied(page, appearance)
    await credentialsPage.submitButton().click()

    const blankRow = fieldCard(page, 1)
    const namedRow = fieldCard(page, 2)
    await expect(blankRow.getByRole('alert')).toHaveText(BLANK_NAME_ALERT)
    await expect(namedRow.getByRole('alert')).toHaveCount(0)
    await expect(fieldName(page, 2)).toHaveValue(LOGIN_PASSWORD_KEY)
    await expectNoHorizontalOverflow(page)
    await expect(page).toHaveURL((url) => url.pathname === newCredentialPath)

    await fieldName(page, 1).fill(LOGIN_USER_KEY)
    await credentialsPage.submitButton().click()
    await expect(page).toHaveURL((url) => isCredentialDetailPath(projectId, url.pathname))
    await expect(page.getByText(BLANK_NAME_ALERT)).toHaveCount(0)
    await expectAppearanceApplied(page, appearance)
    await expectNoHorizontalOverflow(page)
  })

  test(`whitespace-only name is treated as blank [${appearance.name}]`, async ({
    page,
    context,
  }) => {
    const { projectId, credentialsPage } = await openLoginTemplate(
      page,
      context,
      appearance,
      'ws',
      '   '
    )
    await expectAppearanceApplied(page, appearance)
    await credentialsPage.submitButton().click()

    await expect(fieldCard(page, 1).getByRole('alert')).toHaveText(BLANK_NAME_ALERT)
    await expect(fieldCard(page, 2).getByRole('alert')).toHaveCount(0)
    await expect(page).toHaveURL((url) => url.pathname === `/projects/${projectId}/credentials/new`)
    await expectNoHorizontalOverflow(page)
  })
})
