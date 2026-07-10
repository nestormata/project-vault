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

// J4: Initiate rotation -> confirm checklist -> complete rotation.
// See story AC-J4-1/AC-J4-2/AC-J4-3.
//
// Setup (project/credential/dependent-system creation) is done via direct API calls, per AC-I4's
// "UI is for validation only" principle — J1 already covers credential creation through the UI;
// this journey's subject under test is the rotation flow itself.
//
// Discovered while implementing this story (documented here, not silently worked around): both
// initiate-rotation and complete-rotation routes require `minimumRole: 'admin'` AND
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
  test('AC-J4-1: happy path — initiate, confirm every checklist item, complete', async ({
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

    await rotationPage.completeRotationButton().click()
    await expect(page.getByText('completed', { exact: true })).toBeVisible()
  })

  test('AC-J4-2: failure path — completing with an unconfirmed checklist item is rejected server-side too', async ({
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

    // Deliberately leave the checklist item unconfirmed: the complete button must be disabled
    // (no UI path to trigger it), matching AC-E5a's minimum-checklist-gate design.
    await expect(rotationPage.completeRotationButton()).toBeDisabled()

    // A disabled button alone is not evidence of a real guard — verify the server itself rejects
    // completion via a direct authenticated API call.
    const completeResponse = await context.request.post(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}/complete`,
      { data: {} }
    )
    expect(completeResponse.status()).toBe(422)
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

    await expect(rotationPage.completeRotationButton()).toBeDisabled()
    await rotationPage.acknowledgeNoDependenciesCheckbox().check()
    await expect(rotationPage.completeRotationButton()).toBeEnabled()
    await rotationPage.completeRotationButton().click()
    await expect(page.getByText('completed', { exact: true })).toBeVisible()
  })

  test('AC-J4-3: failure path — a second rotation cannot be initiated while one is already in progress', async ({
    page,
    context,
  }) => {
    const { projectId, credentialId } = await setupCredentialWithDependency(context)

    const rotationPage = new RotationPage(page)
    await rotationPage.gotoInitiate(projectId, credentialId)
    await rotationPage.initiate(uniqueCredentialValue('j4-first-rotation'))
    await page.waitForURL(`**/projects/${projectId}/credentials/${credentialId}/rotations/*`)
    const firstRotationUrl = page.url()

    // Discovered while implementing this story: the /rotate page's own server load function
    // (apps/web/.../rotate/+page.server.ts) checks for an active rotation and redirects (303) to
    // it BEFORE the initiate form ever renders — the real concurrency guard here is a load-time
    // redirect, not a submit-time error on the form. Attempting a second rotation for the SAME
    // credential therefore never reaches the form at all.
    await rotationPage.gotoInitiate(projectId, credentialId)
    await expect(page).toHaveURL(firstRotationUrl)
    await expect(rotationPage.newValueInput()).toHaveCount(0)

    // Verify the server itself rejects a concurrent initiate too (not just the UI's redirect),
    // matching AC-J1-3/AC-J2-3/AC-J4-2's shared "prove the server enforces it" principle.
    const secondInitiateResponse = await context.request.post(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations`,
      { data: { newValue: uniqueCredentialValue('j4-second-rotation') } }
    )
    expect(secondInitiateResponse.status()).toBe(409)
  })
})
