import { expect, test } from '@playwright/test'
import { enrollMfaViaApi, registerAndLoginViaApi } from '../fixtures/auth.js'
import {
  addCredentialDependencyViaApi,
  createCredentialViaApi,
  createProjectViaApi,
} from '../fixtures/api.js'
import {
  uniqueCredentialValue,
  uniqueEmail,
  uniqueOrgName,
  uniqueProjectName,
} from '../fixtures/ids.js'
import { RotationPage } from '../pages/RotationPage.js'

// J4: Initiate rotation -> confirm checklist -> promote -> retire rotation.
// See story AC-J4-1/AC-J4-2/AC-J4-3.
//
// Setup (project/credential/dependent-system creation) is done via direct API calls, per AC-I4's
// "UI is for validation only" principle — J1 already covers credential creation through the UI;
// this journey's subject under test is the rotation flow itself.
//
// Discovered while implementing this story (documented here, not silently worked around): both
// initiate-rotation, promote-rotation, and retire-rotation routes require `minimumRole: 'admin'` AND
// `requireMfa: true` (apps/api/src/modules/rotation/routes.ts) — the same MFA-enrollment posture
// as project archive/transfer-ownership. The owner session must be MFA-enrolled before either
// action, or both 403 with mfa_required and the journey never executes (same class of finding as
// AC-J2-1's requireMfaEnrollmentStrict() discovery for invitations).

async function setupCredentialWithDependency(context: import('@playwright/test').BrowserContext) {
  await registerAndLoginViaApi(context, {
    email: uniqueEmail('j4-owner'),
    password: 'e2e-J4-Password-123',
    orgName: uniqueOrgName('J4 Org'),
  })
  await enrollMfaViaApi(context)
  const project = await createProjectViaApi(context, {
    name: uniqueProjectName('J4 Project'),
    slug: `j4-project-${Date.now()}`,
  })
  const credential = await createCredentialViaApi(context, project.id, {
    name: 'j4-credential',
    value: uniqueCredentialValue('j4-initial'),
  })
  await addCredentialDependencyViaApi(context, project.id, credential.id, {
    systemName: 'j4-dependent-system',
  })
  return { projectId: project.id, credentialId: credential.id }
}

test.describe('J4 — rotation lifecycle', () => {
  test('shows an interpretation and accessible field help for a cron rotation schedule', async ({
    page,
    context,
  }) => {
    const { projectId, credentialId } = await setupCredentialWithDependency(context)

    await page.goto(`/projects/${projectId}/credentials/${credentialId}`)
    const schedule = page.getByLabel('Rotation schedule (cron)')
    await schedule.fill('0 0 1 * *')
    await expect(page.getByText('Every 1st day of the month')).toBeVisible()

    await page.getByRole('button', { name: /show cron field help/i }).click()
    await expect(page.getByRole('dialog', { name: /cron schedule fields/i })).toBeVisible()
    await expect(page.getByText(/weekday \(0–7/i)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: /cron schedule fields/i })).toHaveCount(0)
  })

  test('AC-J4-1: happy path — initiate, confirm every checklist item, promote, retire', async ({
    page,
    context,
  }) => {
    const { projectId, credentialId } = await setupCredentialWithDependency(context)

    const rotationPage = new RotationPage(page)
    await rotationPage.gotoInitiate(projectId, credentialId)
    await rotationPage.initiate(uniqueCredentialValue('j4-rotated'))

    // initiateRotation navigates to the checklist page on success.
    await page.waitForURL(`**/projects/${projectId}/credentials/${credentialId}/rotations/*`)

    await rotationPage.confirmButton(0).click()
    await expect(rotationPage.confirmButton(0)).toHaveCount(0)

    await expect(rotationPage.promoteRotationButton()).toBeEnabled()
    await rotationPage.promoteRotationButton().click()
    await expect(page.getByText('promoted', { exact: true })).toBeVisible()

    await rotationPage.retireRotationButton().click()
    await expect(page.getByText('retired', { exact: true })).toBeVisible()
  })

  test('AC-J4-2: failure path — promoting with an unconfirmed checklist item requires acknowledgement', async ({
    page,
    context,
  }) => {
    const { projectId, credentialId } = await setupCredentialWithDependency(context)

    const rotationPage = new RotationPage(page)
    await rotationPage.gotoInitiate(projectId, credentialId)
    await rotationPage.initiate(uniqueCredentialValue('j4-incomplete'))
    await page.waitForURL(`**/projects/${projectId}/credentials/${credentialId}/rotations/*`)
    const rotationIdSegment = page.url().split('/rotations/')[1]
    if (!rotationIdSegment) throw new Error('expected a rotation id in the URL after initiation')
    const rotationId = rotationIdSegment

    // Deliberately leave the checklist item unconfirmed: promotion requires an explicit
    // acknowledgement before the advisory checklist can be bypassed.
    await expect(rotationPage.promoteRotationButton()).toBeDisabled()

    // A disabled button alone is not evidence of a real guard — verify the server itself rejects
    // promotion via a direct authenticated API call.
    const promoteResponse = await context.request.post(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}/promote`,
      { data: {} }
    )
    expect(promoteResponse.status()).toBe(422)
  })

  test('AC-J4-2b: edge — zero dependent systems still requires the explicit acknowledgement checkbox', async ({
    page,
    context,
  }) => {
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j4-empty-owner'),
      password: 'e2e-J4-Empty-Password-123',
      orgName: uniqueOrgName('J4 Empty Org'),
    })
    await enrollMfaViaApi(context)
    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('J4 Empty Project'),
      slug: `j4-empty-${Date.now()}`,
    })
    const credential = await createCredentialViaApi(context, project.id, {
      name: 'j4-empty-credential',
      value: uniqueCredentialValue('j4-empty-initial'),
    })

    const rotationPage = new RotationPage(page)
    await rotationPage.gotoInitiate(project.id, credential.id)
    await rotationPage.initiate(uniqueCredentialValue('j4-empty-rotated'))
    await page.waitForURL(`**/projects/${project.id}/credentials/${credential.id}/rotations/*`)

    await expect(rotationPage.promoteRotationButton()).toBeDisabled()
    await rotationPage.acknowledgeNoDependenciesCheckbox().check()
    await expect(rotationPage.promoteRotationButton()).toBeEnabled()
    await rotationPage.promoteRotationButton().click()
    await expect(page.getByText('promoted', { exact: true })).toBeVisible()

    // Retire is a separate irreversible action and must require its own acknowledgement.
    await expect(rotationPage.retireRotationButton()).toBeDisabled()
    await rotationPage.acknowledgeNoDependenciesCheckbox().check()
    await rotationPage.retireRotationButton().click()
    await expect(page.getByText('retired', { exact: true })).toBeVisible()
  })

  test('AC-J4-3: failure path — a second rotation cannot be initiated while one is staged', async ({
    page,
    context,
  }) => {
    const { projectId, credentialId } = await setupCredentialWithDependency(context)

    const rotationPage = new RotationPage(page)
    await rotationPage.gotoInitiate(projectId, credentialId)
    await rotationPage.initiate(uniqueCredentialValue('j4-first-rotation'))
    await page.waitForURL(`**/projects/${projectId}/credentials/${credentialId}/rotations/*`)

    // Staged rotations remain on /rotate so the UI can explain the conflict and disable the
    // form. The API remains the authoritative concurrency guard.
    await rotationPage.gotoInitiate(projectId, credentialId)
    await expect(page).toHaveURL(/\/rotate$/)
    await expect(rotationPage.newValueInput()).toBeDisabled()
    await expect(rotationPage.startRotationButton()).toBeDisabled()

    // Verify the server itself rejects a concurrent initiate too (not just the UI's redirect),
    // matching AC-J1-3/AC-J2-3/AC-J4-2's shared "prove the server enforces it" principle.
    const secondInitiateResponse = await context.request.post(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations`,
      { data: { newValue: uniqueCredentialValue('j4-second-rotation') } }
    )
    expect(secondInitiateResponse.status()).toBe(409)
  })
})
