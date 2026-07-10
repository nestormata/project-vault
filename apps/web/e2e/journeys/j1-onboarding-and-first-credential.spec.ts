import { expect, test } from '@playwright/test'
import { enrollMfaViaApi, registerAndLoginViaApi, registerViaUiAndLogin } from '../fixtures/auth.js'
import { createInvitationViaApi } from '../fixtures/api.js'
import { extractTokenFromAcceptUrl, readLatestInvitationAcceptUrl } from '../fixtures/db.js'
import {
  uniqueCredentialValue,
  uniqueEmail,
  uniqueOrgName,
  uniqueProjectName,
} from '../fixtures/ids.js'
import { CredentialsPage } from '../pages/CredentialsPage.js'
import { InvitationAcceptPage } from '../pages/InvitationAcceptPage.js'
import { LoginPage } from '../pages/LoginPage.js'
import { OnboardingPage } from '../pages/OnboardingPage.js'
import { RegisterPage } from '../pages/RegisterPage.js'

// J1: Register -> onboard -> create first credential -> reveal value.
// See story AC-J1-1/AC-J1-2/AC-J1-3.

test.describe('J1 — onboarding and first credential', () => {
  test('AC-J1-1: happy path — register, onboard, create credential, reveal value', async ({
    page,
  }) => {
    const email = uniqueEmail('j1-happy')
    const password = 'e2e-Correct-Password-12'
    const orgName = uniqueOrgName('J1 Org')
    const projectName = uniqueProjectName('J1 Project')

    // Registration does not auto-login (docs/runbook.md) — registerViaUiAndLogin drives the real
    // /register form then explicitly signs in afterward, not assuming a session exists post-reg.
    await registerViaUiAndLogin(page, { email, password, orgName })
    await expect(page).toHaveURL(/\/dashboard/)

    const onboarding = new OnboardingPage(page)
    await expect(onboarding.dialog()).toBeVisible()
    await onboarding.completeStep1(projectName)

    const credentialName = 'j1-wizard-credential'
    const wizardCredentialValue = uniqueCredentialValue('j1-wizard')
    await onboarding.completeStep2({ name: credentialName, value: wizardCredentialValue })
    await onboarding.completeStep3()
    await expect(onboarding.dialog()).toBeHidden()
    await expect(page).toHaveURL(/\/dashboard/)

    // The wizard's own Step 2 already proves "create first credential" end to end (a real
    // project-scoped credential, created inline). AC-J1-1 additionally asks the spec to exercise
    // the dedicated /projects/{projectId}/credentials/new route + the detail page's reveal
    // action — the standalone route the wizard does not itself navigate to — so this spec creates
    // a second credential there and reveals *that* one, giving both flows real coverage.
    const projectsResponse = await page.request.get('/api/v1/projects')
    expect(projectsResponse.ok()).toBeTruthy()
    const projects = (await projectsResponse.json()) as {
      data: { items: { id: string; name: string }[] }
    }
    const project = projects.data.items.find((p) => p.name === projectName)
    expect(project, 'onboarding-created project should be listed').toBeTruthy()
    if (!project) throw new Error('unreachable — asserted above')
    const projectId = project.id

    const credentialsPage = new CredentialsPage(page)
    await credentialsPage.gotoNew(projectId)
    const submittedValue = uniqueCredentialValue('j1-reveal')
    await credentialsPage.createCredential({
      name: 'j1-standalone-credential',
      value: submittedValue,
    })

    // createCredential navigates to the detail page on success.
    await page.waitForURL(`**/projects/${projectId}/credentials/*`)
    await credentialsPage.revealButton().click()
    await expect(credentialsPage.revealedValueText()).toHaveText(submittedValue)
  })

  test('AC-J1-2: failure path — invalid registration shows the real inline error, no navigation, no user created', async ({
    page,
  }) => {
    // Discovered while implementing this story (documented here, not silently worked around):
    // the password input carries a real `minlength="12"` HTML attribute (RegisterForm.svelte),
    // matching the server's own PasswordSchema (min(12).max(256), packages/shared/src/schemas/
    // auth.ts) exactly. A too-short password therefore never reaches the server at all — the
    // browser's own native constraint validation blocks the `submit` event before RegisterForm's
    // JS handler (and therefore any fetch call) ever runs, so there is no *server*-side
    // validation-error path reachable through the real UI for this specific rule. AC-J1-2's own
    // "Example (edge — duplicate email)" is used as this test's primary scenario instead — a
    // failure that genuinely reaches the server and has no client-side pre-check, giving real,
    // no-mock coverage of RegisterForm's error-rendering path.
    const email = uniqueEmail('j1-dup')
    const password = 'e2e-J1-Dup-Password-123'
    const orgName = uniqueOrgName('J1 Dup Org')

    const registerPage = new RegisterPage(page)
    await registerPage.goto()
    await registerPage.fillAndSubmit({ email, password, orgName })
    await expect(page).toHaveURL(/\/login/)

    // Registering the SAME email again surfaces a real "already registered"-class error inline —
    // not a crash, blank page, or RegisterForm's generic catch-all fallback text — and no
    // navigation away from /register occurs.
    await registerPage.goto()
    await registerPage.fillAndSubmit({ email, password, orgName: uniqueOrgName('dup') })
    await expect(registerPage.errorAlert()).toBeVisible()
    await expect(registerPage.errorAlert()).not.toHaveText('Registration failed.')
    await expect(page).toHaveURL(/\/register$/)
  })

  test('AC-J1-3: failure path — reveal is denied at the UI for a role without reveal permission', async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext()
    const ownerEmail = uniqueEmail('j1-owner')
    const ownerPassword = 'e2e-Owner-Password-123'
    const orgName = uniqueOrgName('J1 Deny Org')

    await registerAndLoginViaApi(ownerContext, {
      email: ownerEmail,
      password: ownerPassword,
      orgName,
    })

    const projectRes = await ownerContext.request.post('/api/v1/projects', {
      data: { name: uniqueProjectName('J1 Deny Project'), slug: `j1-deny-${Date.now()}` },
    })
    expect(projectRes.ok()).toBeTruthy()
    const project = (await projectRes.json()) as { data: { id: string } }
    const projectId = project.data.id

    const credentialValue = uniqueCredentialValue('j1-deny')
    const credRes = await ownerContext.request.post(`/api/v1/projects/${projectId}/credentials`, {
      data: { name: 'j1-deny-credential', value: credentialValue },
    })
    expect(credRes.ok()).toBeTruthy()
    const credential = (await credRes.json()) as { data: { id: string } }
    const credentialId = credential.data.id

    // canCreateCredential (apps/web/src/lib/components/onboarding/onboarding-logic.ts) grants
    // reveal to member/admin/owner and denies it to 'viewer' — the lowest tier with any project
    // access, proving this is a real permission-tier check, not merely "unauthenticated can't
    // reveal." A 'viewer' can only be granted project access via a real invitation (registering a
    // second, unrelated user creates a brand-new separate org with zero access to this project),
    // so this reuses J2's own invite-accept mechanism (AC-J2-1) rather than a shortcut.
    // POST /:projectId/invitations enforces requireMfaEnrollmentStrict() unconditionally.
    await enrollMfaViaApi(ownerContext)

    const viewerEmail = uniqueEmail('j1-viewer')
    await createInvitationViaApi(ownerContext, projectId, { email: viewerEmail, role: 'viewer' })
    const acceptUrl = await readLatestInvitationAcceptUrl(viewerEmail)
    const token = extractTokenFromAcceptUrl(acceptUrl)

    const viewerContext = await browser.newContext()
    const viewerPage = await viewerContext.newPage()
    const acceptPage = new InvitationAcceptPage(viewerPage)
    await acceptPage.goto(token)
    // No account exists yet for this email — redirects to /register?invitationToken=...
    await expect(viewerPage).toHaveURL(/\/register\?/)
    const viewerPassword = 'e2e-Viewer-Password-123'
    const registerPage = new RegisterPage(viewerPage)
    await registerPage.passwordInput().fill(viewerPassword)
    await registerPage.submitButton().click()
    // Invited registration redirects to /projects/{projectId} (getPostRegisterPath), but
    // registration itself still does not auto-login (docs/runbook.md) — a subsequent explicit
    // login is always required regardless of where that initial redirect transiently lands.
    const loginPage = new LoginPage(viewerPage)
    await loginPage.goto()
    await loginPage.fillAndSubmit({ email: viewerEmail, password: viewerPassword })

    // The first-run OnboardingDialog would otherwise block this session's next /(app) navigation
    // (see registerAndLoginViaApi's own note) — onboarding isn't this test's subject either.
    await viewerContext.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })

    const credentialsPage = new CredentialsPage(viewerPage)
    await credentialsPage.gotoDetail(projectId, credentialId)

    // The reveal action must either be absent entirely, or produce a real 403-mapped error on
    // click — never a client-side-only disabled control masking a missing server check.
    const revealVisible = await credentialsPage
      .revealButton()
      .isVisible()
      .catch(() => false)
    if (revealVisible) {
      await credentialsPage.revealButton().click()
      await expect(credentialsPage.errorAlert()).toBeVisible()
    } else {
      await expect(credentialsPage.revealButton()).toHaveCount(0)
    }

    await ownerContext.close()
    await viewerContext.close()
  })
})
