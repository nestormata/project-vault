import postgres from 'postgres'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { enrollMfaViaApi, registerAndLoginViaApi } from '../fixtures/auth.js'
import {
  createCredentialViaApi,
  createInvitationViaApi,
  createProjectViaApi,
} from '../fixtures/api.js'
import {
  extractTokenFromAcceptUrl,
  readLatestInvitationAcceptUrl,
  setOrganizationRoleViaDb,
  superuserDatabaseUrl,
} from '../fixtures/db.js'
import {
  uniqueCredentialValue,
  uniqueEmail,
  uniqueOrgName,
  uniqueProjectName,
} from '../fixtures/ids.js'
import { instrumentHydrationDetection, waitForHydration } from '../fixtures/hydration.js'
import { InvitationAcceptPage } from '../pages/InvitationAcceptPage.js'
import { LoginPage } from '../pages/LoginPage.js'
import { RegisterPage } from '../pages/RegisterPage.js'
import { RotationPage } from '../pages/RotationPage.js'

// J30 (Story 43-15, FR102): deactivating a user who still owns an unfinished rotation is refused
// with an actionable message until that rotation is resolved — by the SAME owner who got the
// refusal (the story's Resolution Matrix), either in one step ("Abandon unfinished rotations and
// deactivate", AC-8) or manually (abandon the rotation, then retry the plain deactivate).
//
// Setup is API/DB only ("UI is for validation only"): X joins the owner's org through a real
// project invitation, is raised to org admin (rotation initiation needs it), enrolls MFA and
// starts a rotation. The subject under test is the owner's Settings → Users flow.

const OWNER_PASSWORD = ['e2e', 'J30', 'Owner', 'Password', '123'].join('-')
const USERS_SETTINGS_URL = '/settings/users'
const X_PASSWORD = ['e2e', 'J30', 'Initiator', 'Password', '123'].join('-')

type Fixture = {
  ownerContext: BrowserContext
  xContext: BrowserContext
  xEmail: string
  xDisplayName: string
  projectId: string
  credentialId: string
  initialValue: string
  rotationId: string
}

async function setup(browser: Browser, label: string): Promise<Fixture> {
  const ownerContext = await browser.newContext()
  const owner = await registerAndLoginViaApi(ownerContext, {
    email: uniqueEmail(`j30-${label}-owner`),
    password: OWNER_PASSWORD,
    orgName: uniqueOrgName('J30 Org'),
  })
  await enrollMfaViaApi(ownerContext)
  const project = await createProjectViaApi(ownerContext, {
    name: uniqueProjectName('J30 Project'),
    slug: `j30-${label}-${Date.now()}`,
  })
  const initialValue = uniqueCredentialValue('j30-initial')
  const credential = await createCredentialViaApi(ownerContext, project.id, {
    name: `j30-${label}-credential`,
    value: initialValue,
  })

  const xEmail = uniqueEmail(`j30-${label}-x`)
  await createInvitationViaApi(ownerContext, project.id, { email: xEmail, role: 'member' })
  const token = extractTokenFromAcceptUrl(await readLatestInvitationAcceptUrl(xEmail))
  const xContext = await browser.newContext()
  const xPage = await xContext.newPage()
  // The first-click hydration race (J26) can drop the register submit, which only surfaces later
  // as a failed login — wait for hydration, then for the registration to actually leave /register.
  await instrumentHydrationDetection(xPage)
  await new InvitationAcceptPage(xPage).goto(token)
  await expect(xPage).toHaveURL(/\/register\?/)
  const register = new RegisterPage(xPage)
  await waitForHydration(xPage, register.submitButton())
  await register.passwordInput().fill(X_PASSWORD)
  await register.submitButton().click()
  await expect(xPage).not.toHaveURL(/\/register/)
  await new LoginPage(xPage).goto()
  await new LoginPage(xPage).fillAndSubmit({ email: xEmail, password: X_PASSWORD })
  await expect(xPage).toHaveURL(/\/dashboard/)
  await xContext.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })
  await setOrganizationRoleViaDb(owner.orgId, xEmail, 'admin')
  await enrollMfaViaApi(xContext)
  await xPage.close()

  const initiate = await xContext.request.post(
    `/api/v1/projects/${project.id}/credentials/${credential.id}/rotations`,
    { data: { newValue: uniqueCredentialValue('j30-rotated') } }
  )
  expect(initiate.status(), await initiate.text()).toBe(201)
  const rotationId = ((await initiate.json()) as { data: { id: string } }).data.id

  const users = await ownerContext.request.get('/api/v1/org/users')
  const xRow = ((await users.json()) as { data: { email: string; displayName: string }[] }).data
    .filter((user) => user.email === xEmail)
    .at(0)
  if (!xRow) throw new Error(`X (${xEmail}) is not listed in the owner's org`)

  return {
    ownerContext,
    xContext,
    xEmail,
    xDisplayName: xRow.displayName,
    projectId: project.id,
    credentialId: credential.id,
    initialValue,
    rotationId,
  }
}

function userRow(page: Page, displayName: string) {
  return page.getByRole('row').filter({ hasText: displayName })
}

async function deactivateFromUsersPage(page: Page, displayName: string): Promise<void> {
  page.once('dialog', (dialog) => void dialog.accept())
  await userRow(page, displayName)
    .getByRole('button', { name: /deactivate account/i })
    .click()
}

async function expectBlocked(page: Page, fixture: Fixture): Promise<void> {
  await expect(page.getByRole('alert').first()).toContainText(
    `${fixture.xEmail} still owns 1 unfinished rotation(s). Complete, retire, or abandon them before deactivating this account.`
  )
  await expect(userRow(page, fixture.xDisplayName).getByText('Deactivated')).toHaveCount(0)
}

async function superuserSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(superuserDatabaseUrl(), { max: 1 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function expectRotationResolved(fixture: Fixture): Promise<void> {
  const base = `/api/v1/projects/${fixture.projectId}/credentials/${fixture.credentialId}`
  const detail = await fixture.ownerContext.request.get(`${base}/rotations/${fixture.rotationId}`)
  expect(((await detail.json()) as { data: { status: string } }).data.status).toBe('abandoned')
  // The previous version is current again (abandonRotation's unlock side effect)...
  const value = await fixture.ownerContext.request.get(`${base}/value`)
  expect(((await value.json()) as { data: { value: string } }).data.value).toBe(
    fixture.initialValue
  )
  // ...and no longer rotation-locked. The API never exposes rotation_locked_at, so read it
  // directly (setup-style superuser access, like the invitation-token read above).
  const [previous] = await superuserSql(
    (sql) => sql<{ locked: boolean }[]>`
      select cv.rotation_locked_at is not null as locked
      from rotations r join credential_versions cv on cv.id = r.previous_version_id
      where r.id = ${fixture.rotationId}`
  )
  expect(previous?.locked).toBe(false)
}

test.describe('J30 — deactivation blocked by an active rotation (FR102)', () => {
  test('one step: the owner abandons the unfinished rotation and deactivates in the same request', async ({
    browser,
  }) => {
    const fixture = await setup(browser, 'one-step')
    const page = await fixture.ownerContext.newPage()
    try {
      await page.goto(USERS_SETTINGS_URL)
      await deactivateFromUsersPage(page, fixture.xDisplayName)
      await expectBlocked(page, fixture)

      page.once('dialog', (dialog) => {
        expect(dialog.message()).toMatch(/staged and stale rotations will be abandoned/i)
        void dialog.accept()
      })
      await userRow(page, fixture.xDisplayName)
        .getByRole('button', { name: /abandon unfinished rotations and deactivate/i })
        .click()

      await expect(userRow(page, fixture.xDisplayName).getByText('Deactivated')).toBeVisible()
      await expectRotationResolved(fixture)
    } finally {
      await fixture.xContext.close()
      await fixture.ownerContext.close()
    }
  })

  test('manual path: the owner abandons the rotation first, then the plain deactivate succeeds', async ({
    browser,
  }) => {
    const fixture = await setup(browser, 'manual')
    const page = await fixture.ownerContext.newPage()
    try {
      await page.goto(USERS_SETTINGS_URL)
      await deactivateFromUsersPage(page, fixture.xDisplayName)
      await expectBlocked(page, fixture)

      // The rotation UI offers Abandon on a stale rotation (StaleRecoveryBanner); the stale-rotation
      // worker's transition is simulated so the journey need not wait out its threshold.
      await superuserSql(
        (sql) =>
          sql`update rotations set status = 'stale_recovery' where id = ${fixture.rotationId}`
      )
      const rotationPage = new RotationPage(page)
      await rotationPage.gotoDetail(fixture.projectId, fixture.credentialId, fixture.rotationId)
      await page.getByRole('button', { name: /^abandon$/i }).click()
      await page.getByRole('button', { name: /abandon anyway/i }).click()
      await expect(page.getByText('abandoned', { exact: true })).toBeVisible()

      await page.goto(USERS_SETTINGS_URL)
      await deactivateFromUsersPage(page, fixture.xDisplayName)
      await expect(userRow(page, fixture.xDisplayName).getByText('Deactivated')).toBeVisible()
      await expectRotationResolved(fixture)
    } finally {
      await fixture.xContext.close()
      await fixture.ownerContext.close()
    }
  })
})
