import { randomUUID } from 'node:crypto'
import type { BrowserContext, Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createCredentialViaApi, createProjectViaApi } from '../fixtures/api.js'
import {
  describeEachAppearance,
  expectAppearanceApplied,
  expectNoHorizontalOverflow,
} from '../fixtures/appearance.js'
import {
  seedCertificate,
  seedInvitation,
  seedShare,
  userIdByEmail,
} from '../fixtures/dashboard-attention.js'
import { gotoHydrated } from '../fixtures/hydration.js'
import { inviteAndSignIn } from '../fixtures/invited-user.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'
const MEMBER_PASSWORD = 'e2e-Member-Password-123'
const HEADING = 'Needs attention'

// J42 (Story 72.12): the dashboard "Needs attention" list inside the org summary, end to end
// through the real UI and the real API, under every appearance of fixtures/appearance.ts. Shares,
// certificates and invitations are seeded on the database (fixtures/dashboard-attention.ts).

interface Owner {
  orgId: string
  userId: string
  email: string
  projectId: string
  projectName: string
  credentialId: string
  credentialName: string
}

async function startAsOwner(context: BrowserContext): Promise<Owner> {
  const email = uniqueEmail('j42-owner')
  const { orgId, userId } = await registerAndLoginViaApi(context, {
    email,
    password: OWNER_PASSWORD,
    orgName: uniqueOrgName('J42 Org'),
  })
  const projectName = uniqueProjectName('J42 Project')
  const project = await createProjectViaApi(context, {
    name: projectName,
    slug: `j42-${randomUUID().slice(0, 12)}`,
  })
  const credentialName = `j42-secret-${randomUUID().slice(0, 8)}`
  const credential = await createCredentialViaApi(context, project.id, {
    name: credentialName,
    value: 'j42-value-never-shown',
  })
  return {
    orgId,
    userId,
    email,
    projectId: project.id,
    projectName,
    credentialId: credential.id,
    credentialName,
  }
}

async function openDashboard(page: Page): Promise<void> {
  await gotoHydrated(page, '/dashboard', page.getByRole('heading', { name: 'Secret overview' }))
}

function attentionRows(page: Page): Locator {
  return page.getByTestId('dashboard-attention').getByRole('listitem')
}

/** Tab until `target` has focus (bounded), the keyboard-reachability proof for one link. */
async function tabUntilFocused(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < 80; presses += 1) {
    await page.keyboard.press('Tab')
    if (await target.evaluate((node) => node === document.activeElement)) return
  }
  throw new Error('The link was not reachable with Tab')
}

async function inviteMember(
  ownerContext: BrowserContext,
  owner: Owner,
  browser: { newContext: () => Promise<BrowserContext> }
): Promise<{ memberPage: Page; memberId: string }> {
  const { page, email } = await inviteAndSignIn(ownerContext, browser, {
    projectId: owner.projectId,
    role: 'member',
    label: 'j42-member',
    password: MEMBER_PASSWORD,
  })
  return { memberPage: page, memberId: await userIdByEmail(email) }
}

describeEachAppearance('J42 dashboard attention', (appearance) => {
  test('AC6/AC7: the owner sees every kind with one link per row, keyboard reachable', async ({
    page,
    context,
  }) => {
    const owner = await startAsOwner(context)
    const certificateDomain = `soon-${randomUUID().slice(0, 6)}.example.com`
    const expiredDomain = `gone-${randomUUID().slice(0, 6)}.example.com`
    const inviteeEmail = `j42-invitee-${randomUUID().slice(0, 6)}@team.example`
    const recipientEmail = `j42-guest-${randomUUID().slice(0, 6)}@vendor.example`
    await seedShare({
      orgId: owner.orgId,
      credentialId: owner.credentialId,
      sharedBy: owner.userId,
      recipientEmail,
      expiresInHours: 24,
    })
    await seedCertificate({
      orgId: owner.orgId,
      projectId: owner.projectId,
      domain: certificateDomain,
      expiresInHours: 24 * 5,
    })
    await seedCertificate({
      orgId: owner.orgId,
      projectId: owner.projectId,
      domain: expiredDomain,
      expiresInHours: -48,
    })
    await seedInvitation({
      orgId: owner.orgId,
      projectId: owner.projectId,
      invitedBy: owner.userId,
      email: inviteeEmail,
      expiresInHours: 24 * 3,
    })

    await openDashboard(page)
    await expectAppearanceApplied(page, appearance)
    await expect(page.getByRole('heading', { name: HEADING })).toBeVisible()
    await expect(page.getByRole('list', { name: HEADING })).toBeVisible()
    const rows = attentionRows(page)
    await expect(rows).toHaveCount(4)

    const expectRow = async (text: string, linkName: string, href: string) => {
      const row = rows.filter({ hasText: text })
      await expect(row).toHaveCount(1)
      const links = row.getByRole('link')
      await expect(links).toHaveCount(1)
      await expect(links).toHaveText(linkName)
      await expect(links).toHaveAttribute('href', href)
      await expect(row).toContainText(/Expires/)
    }
    await expectRow(
      owner.credentialName,
      'View secret',
      `/projects/${owner.projectId}/credentials/${owner.credentialId}`
    )
    await expectRow(
      certificateDomain,
      'View certificates',
      `/projects/${owner.projectId}/certificates`
    )
    await expectRow(expiredDomain, 'View certificates', `/projects/${owner.projectId}/certificates`)
    await expectRow(inviteeEmail, 'View members', `/projects/${owner.projectId}/members`)
    await expect(rows.filter({ hasText: expiredDomain })).toContainText('Expired')
    await expect(rows.filter({ hasText: certificateDomain })).not.toContainText('Expired')
    await expect(page.getByText(/and \d+ more/)).toHaveCount(0)
    await expectNoHorizontalOverflow(page)

    // Every row link is reachable with Tab alone.
    await page.locator('body').click({ position: { x: 1, y: 1 } })
    for (let index = 0; index < 4; index += 1) {
      await tabUntilFocused(page, rows.nth(index).getByRole('link'))
    }

    if (appearance.narrow) {
      // 390 px: the badge sits above the sentence (stacked) and nothing scrolls sideways.
      const row = rows.filter({ hasText: certificateDomain })
      const badge = row.getByText('Certificate', { exact: true })
      const sentence = row.getByText(certificateDomain)
      const badgeBox = await badge.boundingBox()
      const sentenceBox = await sentence.boundingBox()
      expect(badgeBox?.y).toBeLessThan(sentenceBox?.y ?? 0)
    }
  })

  test('AC6: an organization with nothing to attend to shows no card at all', async ({
    page,
    context,
  }) => {
    await startAsOwner(context)
    await openDashboard(page)
    await expectAppearanceApplied(page, appearance)
    await expect(page.getByRole('heading', { name: HEADING })).toHaveCount(0)
    await expect(page.getByTestId('dashboard-attention')).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
  })

  test('AC1/AC6: more than ten of a kind show ten rows and "and N more"', async ({
    page,
    context,
  }) => {
    const owner = await startAsOwner(context)
    for (let index = 0; index < 12; index += 1) {
      await seedCertificate({
        orgId: owner.orgId,
        projectId: owner.projectId,
        domain: `bulk-${index}.example.com`,
        expiresInHours: 24 * (index + 1),
      })
    }
    await openDashboard(page)
    await expect(attentionRows(page)).toHaveCount(10)
    await expect(page.getByText('and 2 more')).toBeVisible()
    await expect(page.getByText('bulk-11.example.com')).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
  })

  test('AC7: the list reads in Spanish for a Spanish user', async ({ page, context }) => {
    const owner = await startAsOwner(context)
    await seedCertificate({
      orgId: owner.orgId,
      projectId: owner.projectId,
      domain: 'es-gone.example.com',
      expiresInHours: -24,
    })
    // The locale cookie is what the app's own language switch sets.
    await context.addCookies([
      { name: 'PARAGLIDE_LOCALE', value: 'es', domain: 'localhost', path: '/' },
    ])
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: 'Requiere atención' })).toBeVisible()
    const row = attentionRows(page).filter({ hasText: 'es-gone.example.com' })
    await expect(row).toContainText('Vencido')
    await expect(row).toContainText('ya venció')
    await expect(row.getByRole('link', { name: 'Ver certificados' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('AC3: a member sees only their own share and the certificates of their own project', async ({
    page,
    context,
    browser,
  }) => {
    test.slow()
    const owner = await startAsOwner(context)
    const otherProject = await createProjectViaApi(context, {
      name: uniqueProjectName('J42 Other'),
      slug: `j42-other-${randomUUID().slice(0, 8)}`,
    })
    const otherCredential = await createCredentialViaApi(context, otherProject.id, {
      name: `j42-other-secret-${randomUUID().slice(0, 6)}`,
      value: 'j42-other-value',
    })
    const { memberPage, memberId } = await inviteMember(context, owner, browser)

    const ownDomain = `own-${randomUUID().slice(0, 6)}.example.com`
    const hiddenDomain = `hidden-${randomUUID().slice(0, 6)}.example.com`
    const ownerShareRecipient = `j42-ownerguest-${randomUUID().slice(0, 6)}@vendor.example`
    const memberShareRecipient = `j42-memberguest-${randomUUID().slice(0, 6)}@vendor.example`
    await seedShare({
      orgId: owner.orgId,
      credentialId: owner.credentialId,
      sharedBy: memberId,
      recipientEmail: memberShareRecipient,
      expiresInHours: 48,
    })
    await seedShare({
      orgId: owner.orgId,
      credentialId: owner.credentialId,
      sharedBy: owner.userId,
      recipientEmail: ownerShareRecipient,
      expiresInHours: 48,
    })
    await seedShare({
      orgId: owner.orgId,
      credentialId: otherCredential.id,
      sharedBy: owner.userId,
      recipientEmail: `j42-elsewhere-${randomUUID().slice(0, 6)}@vendor.example`,
      expiresInHours: 48,
    })
    await seedCertificate({
      orgId: owner.orgId,
      projectId: owner.projectId,
      domain: ownDomain,
      expiresInHours: 24 * 4,
    })
    await seedCertificate({
      orgId: owner.orgId,
      projectId: otherProject.id,
      domain: hiddenDomain,
      expiresInHours: 24 * 4,
    })
    await seedInvitation({
      orgId: owner.orgId,
      projectId: owner.projectId,
      invitedBy: owner.userId,
      email: `j42-pending-${randomUUID().slice(0, 6)}@team.example`,
      expiresInHours: 24 * 3,
    })

    await memberPage.setViewportSize({ ...appearance.viewport })
    await memberPage.emulateMedia({ colorScheme: appearance.colorScheme })
    await openDashboard(memberPage)
    const rows = attentionRows(memberPage)
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: memberShareRecipient })).toHaveCount(1)
    await expect(rows.filter({ hasText: ownDomain })).toHaveCount(1)
    await expect(memberPage.getByText(ownerShareRecipient)).toHaveCount(0)
    await expect(memberPage.getByText(hiddenDomain)).toHaveCount(0)
    await expect(memberPage.getByText('Invitation', { exact: true })).toHaveCount(0)
    await expectNoHorizontalOverflow(memberPage)

    // The owner sees everything the member does not (positive control).
    await openDashboard(page)
    await expect(attentionRows(page)).toHaveCount(6)
  })
})
