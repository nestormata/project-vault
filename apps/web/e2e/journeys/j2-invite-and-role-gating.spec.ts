import { expect, test } from '@playwright/test'
import { enrollMfaViaApi, registerAndLoginViaApi } from '../fixtures/auth.js'
import { createInvitationViaApi, createProjectViaApi } from '../fixtures/api.js'
import { extractTokenFromAcceptUrl, readLatestInvitationAcceptUrl } from '../fixtures/db.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'
import { InvitationAcceptPage } from '../pages/InvitationAcceptPage.js'
import { LoginPage } from '../pages/LoginPage.js'
import { MembersPage } from '../pages/MembersPage.js'
import { RegisterPage } from '../pages/RegisterPage.js'

// J2: Invite team member -> accept invite -> role-gated action allow/deny.
// See story AC-J2-1/AC-J2-2/AC-J2-3.

test.describe('J2 — invite and role gating', () => {
  test('AC-J2-1: happy path — owner invites, invitee accepts, lands with the invited role', async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext()
    const ownerEmail = uniqueEmail('j2-owner')
    const ownerPassword = 'e2e-Owner-Password-123'
    await registerAndLoginViaApi(ownerContext, {
      email: ownerEmail,
      password: ownerPassword,
      orgName: uniqueOrgName('J2 Org'),
    })
    const project = await createProjectViaApi(ownerContext, {
      name: uniqueProjectName('J2 Project'),
      slug: `j2-project-${Date.now()}`,
    })

    // POST /:projectId/invitations calls requireMfaEnrollmentStrict() unconditionally — without
    // this, the very first invite send 403s with mfa_required and the rest of the journey never
    // executes (confirmed by reading apps/api/src/modules/invitations/routes.ts).
    await enrollMfaViaApi(ownerContext)

    const memberEmail = uniqueEmail('j2-member')
    await createInvitationViaApi(ownerContext, project.id, { email: memberEmail, role: 'member' })

    // The API never returns the raw invitation token to the inviter (only a hash is persisted) —
    // it's only ever written into the queued notification's acceptUrl, this suite's documented
    // substitute for real email delivery.
    const acceptUrl = await readLatestInvitationAcceptUrl(memberEmail)
    const token = extractTokenFromAcceptUrl(acceptUrl)

    // Fresh, unauthenticated context — not the owner's session.
    const inviteeContext = await browser.newContext()
    const inviteePage = await inviteeContext.newPage()
    const acceptPage = new InvitationAcceptPage(inviteePage)
    await acceptPage.goto(token)

    // No account exists yet for the invited email -> redirects to /register?invitationToken=...
    await expect(inviteePage).toHaveURL(/\/register\?/)
    const memberPassword = 'e2e-Member-Password-123'
    const registerPage = new RegisterPage(inviteePage)
    await registerPage.passwordInput().fill(memberPassword)
    await registerPage.submitButton().click()
    // Registration itself still does not auto-login (docs/runbook.md) regardless of where the
    // invited-registration redirect transiently lands — always follow up with an explicit login.
    const loginPage = new LoginPage(inviteePage)
    await loginPage.goto()
    await loginPage.fillAndSubmit({ email: memberEmail, password: memberPassword })

    // Re-check from the owner's original session: the members list shows the new member with the
    // invited role, proving the invite-accept flow actually persisted the membership.
    const ownerPage = ownerContext.pages()[0] ?? (await ownerContext.newPage())
    const membersPage = new MembersPage(ownerPage)
    await membersPage.goto(project.id)
    const memberRow = membersPage.memberRow(memberEmail)
    await expect(memberRow).toBeVisible()
    await expect(memberRow).toContainText('member')

    await ownerContext.close()
    await inviteeContext.close()
  })

  test('AC-J2-2: failure path — invalid/expired token shows the real error state, no crash', async ({
    page,
  }) => {
    const acceptPage = new InvitationAcceptPage(page)
    const consoleErrors: string[] = []
    page.on('pageerror', (error) => consoleErrors.push(String(error)))
    page.on('console', (message) => {
      // "Unhandled promise rejection" / genuine JS exceptions are the crash signal this AC cares
      // about. Chromium also auto-logs a console error for every non-2xx network response (e.g.
      // "Failed to load resource: ... 404") — expected and unavoidable noise here since this test
      // deliberately triggers peekInvitation's real 404, not a symptom of an unhandled rejection.
      if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
        consoleErrors.push(message.text())
      }
    })

    await acceptPage.goto('does-not-exist-invalid-token-abc123')
    await expect(acceptPage.invalidHeading()).toBeVisible()
    await expect(page.getByText('This invitation link is no longer valid.')).toBeVisible()
    expect(consoleErrors, `Unexpected console errors: ${consoleErrors.join('; ')}`).toHaveLength(0)

    // Edge: missing token entirely renders a distinct, also-real message.
    await acceptPage.goto()
    await expect(acceptPage.invalidHeading()).toBeVisible()
    await expect(page.getByText('This invitation link is missing a token.')).toBeVisible()
  })

  test('AC-J2-3: failure path — a role-gated write action is denied for an under-privileged member, allowed for the owner', async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext()
    const ownerEmail = uniqueEmail('j2-gate-owner')
    const ownerPassword = 'e2e-Owner-Password-123'
    await registerAndLoginViaApi(ownerContext, {
      email: ownerEmail,
      password: ownerPassword,
      orgName: uniqueOrgName('J2 Gate Org'),
    })
    const project = await createProjectViaApi(ownerContext, {
      name: uniqueProjectName('J2 Gate Project'),
      slug: `j2-gate-${Date.now()}`,
    })
    await enrollMfaViaApi(ownerContext)

    const memberEmail = uniqueEmail('j2-gate-member')
    await createInvitationViaApi(ownerContext, project.id, { email: memberEmail, role: 'member' })
    const acceptUrl = await readLatestInvitationAcceptUrl(memberEmail)
    const token = extractTokenFromAcceptUrl(acceptUrl)

    const memberContext = await browser.newContext()
    const memberPage = await memberContext.newPage()
    const memberPassword = 'e2e-Member-Password-123'
    const acceptPage = new InvitationAcceptPage(memberPage)
    await acceptPage.goto(token)
    await expect(memberPage).toHaveURL(/\/register\?/)
    const registerPage = new RegisterPage(memberPage)
    await registerPage.passwordInput().fill(memberPassword)
    await registerPage.submitButton().click()
    // Registration itself still does not auto-login (docs/runbook.md) regardless of where the
    // invited-registration redirect transiently lands — always follow up with an explicit login.
    const loginPage = new LoginPage(memberPage)
    await loginPage.goto()
    await loginPage.fillAndSubmit({ email: memberEmail, password: memberPassword })
    await expect(memberPage).toHaveURL(/\/dashboard/)

    // The first-run OnboardingDialog would otherwise block this session's next /(app) navigation
    // (see registerAndLoginViaApi's own note) — onboarding isn't this test's subject either.
    await memberContext.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })

    // Gated action: inviting further members — data.canManage (members/+page.server.ts) is
    // owner/admin-only, and a 'member' role sees no invite form in the UI at all. The spec still
    // proves the *server*, not just the UI, enforces the boundary via a direct authenticated API
    // call using the member's own session cookie.
    const membersPage = new MembersPage(memberPage)
    await membersPage.goto(project.id)
    await expect(membersPage.cannotManageNotice()).toBeVisible()
    await expect(membersPage.inviteMemberToggleButton()).toHaveCount(0)

    const deniedResponse = await memberContext.request.post(
      `/api/v1/projects/${project.id}/invitations`,
      { data: { email: uniqueEmail('j2-gate-denied'), role: 'viewer' } }
    )
    expect(deniedResponse.status()).toBe(403)

    // Allow side of the same boundary: the SAME action, attempted by the owner, succeeds —
    // isolating the role difference as the cause of the denial (a totally broken endpoint would
    // 403 for everyone, which this positive case rules out).
    const allowedResponse = await ownerContext.request.post(
      `/api/v1/projects/${project.id}/invitations`,
      { data: { email: uniqueEmail('j2-gate-allowed'), role: 'viewer' } }
    )
    expect(allowedResponse.ok()).toBeTruthy()

    await ownerContext.close()
    await memberContext.close()
  })
})
