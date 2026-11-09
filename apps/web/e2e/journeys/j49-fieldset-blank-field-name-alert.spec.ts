import { expect, test, type Page } from '@playwright/test'
import {
  describeEachAppearance,
  expectAppearanceApplied,
  expectNoHorizontalOverflow,
} from '../fixtures/appearance.js'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { fillLoginTemplateCredentialForm } from '../fixtures/credentials-ui.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'
const BLANK_NAME_ALERT = 'Field name is required'
const LOGIN_USER_KEY = 'username'
const LOGIN_PASSWORD_KEY = 'password'
const EXACT = { exact: true } as const

function fieldName(page: Page, index: number) {
  return page.getByLabel(`Field ${index} name`, EXACT)
}

function fieldCard(page: Page, index: number) {
  return fieldName(page, index).locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')
}

describeEachAppearance('J49 blank field-name alert in the field-set editor', (appearance) => {
  test(`blank name shows Field name is required; a named field does not [${appearance.name}]`, async ({
    page,
    context,
  }) => {
    const slug = appearance.name.replace(/\s+/g, '-')
    await registerAndLoginViaApi(context, {
      email: uniqueEmail(`j49-${slug}`),
      password: OWNER_PASSWORD,
      orgName: uniqueOrgName('J49 Org'),
    })
    const projectRes = await context.request.post('/api/v1/projects', {
      data: { name: uniqueProjectName('J49 Project'), slug: `j49-${Date.now()}` },
    })
    expect(projectRes.ok()).toBeTruthy()
    const projectId = (await projectRes.json()).data.id as string
    const newCredentialPath = `/projects/${projectId}/credentials/new`

    const credentialsPage = await fillLoginTemplateCredentialForm(page, projectId, {
      name: 'j49-login',
      field1Value: 'svc',
      field2Value: 'pw',
      beforeSubmit: async () => {
        await expect(fieldName(page, 1)).toHaveValue(LOGIN_USER_KEY)
        await fieldName(page, 1).fill('')
      },
    })
    await expectAppearanceApplied(page, appearance)
    await credentialsPage.submitButton().click()

    const blankRow = fieldCard(page, 1)
    const namedRow = fieldCard(page, 2)
    await expect(blankRow.getByRole('alert')).toHaveText(BLANK_NAME_ALERT)
    await expect(namedRow.getByRole('alert')).toHaveCount(0)
    await expect(fieldName(page, 2)).toHaveValue(LOGIN_PASSWORD_KEY)
    await expectNoHorizontalOverflow(page)
    await expect(page).toHaveURL((url) => url.pathname === newCredentialPath)

    await fieldName(page, 1).fill('   ')
    await credentialsPage.submitButton().click()
    await expect(blankRow.getByRole('alert')).toHaveText(BLANK_NAME_ALERT)
    await expect(namedRow.getByRole('alert')).toHaveCount(0)

    await fieldName(page, 1).fill(LOGIN_USER_KEY)
    await credentialsPage.submitButton().click()
    await page.waitForURL(`**/projects/${projectId}/credentials/*`)
    await expect(page.getByText(BLANK_NAME_ALERT)).toHaveCount(0)
    await expectAppearanceApplied(page, appearance)
    await expectNoHorizontalOverflow(page)
  })
})
