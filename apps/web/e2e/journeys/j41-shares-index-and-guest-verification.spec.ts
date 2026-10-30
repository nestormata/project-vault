import { randomUUID } from 'node:crypto'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createProjectViaApi } from '../fixtures/api.js'
import { createLoginTemplateCredentialViaUi } from '../fixtures/credentials-ui.js'
import { describeEachAppearance, type Appearance } from '../fixtures/appearance.js'
import {
  GUEST_TEST_CODE,
  GUEST_WRONG_CODE,
  createExternalShareViaUi,
  actUntilAnswered,
  openGuestShare,
  sendGuestCode,
  submitGuestCode,
  plantVerificationCode,
  tokenFromShareUrl,
} from '../fixtures/guest-verification.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'
const USERNAME_VALUE = 'j41-svc-account'
const PASSWORD_VALUE = 'j41-super-secret-password'
const REVEAL_BUTTON = 'Reveal secret'
const WRONG_CODE_TEXT = 'That code did not work'
const MASKED_ADDRESS = /[a-z0-9]\*\*\*@[a-z0-9]\*\*\*/

// J41 (Story 72.11): the shares index, the Opened and Locked display statuses, typed share error
// reasons, and the guest (external recipient) verification step, end to end through the real UI and
// the real API, under every appearance of fixtures/appearance.ts (desktop and 390 px, light and
// dark). The emailed code is replaced by a known one after the page's real "Send code" request
// (fixtures/guest-verification.ts); everything else is the product path.

interface Sharer {
  projectId: string
  credentialId: string
  credentialName: string
}

/** A signed-in owner with one login-template credential, left open on its detail page. */
async function startAsSharer(page: Page, context: BrowserContext): Promise<Sharer> {
  await registerAndLoginViaApi(context, {
    email: uniqueEmail('j41-owner'),
    password: OWNER_PASSWORD,
    orgName: uniqueOrgName('J41 Org'),
  })
  const project = await createProjectViaApi(context, {
    name: uniqueProjectName('J41 Project'),
    slug: `j41-${randomUUID().slice(0, 12)}`,
  })
  const credentialName = `j41-login-${randomUUID().slice(0, 8)}`
  await createLoginTemplateCredentialViaUi(page, project.id, {
    name: credentialName,
    field1Value: USERNAME_VALUE,
    field2Value: PASSWORD_VALUE,
  })
  // `createLoginTemplateCredentialViaUi` resolves on `/credentials/new` already: wait for the id.
  await expect(page).toHaveURL(/\/credentials\/[0-9a-f-]{36}$/)
  const credentialId = new URL(page.url()).pathname.split('/').pop() as string
  return { projectId: project.id, credentialId, credentialName }
}

/** A recipient's own browser context, with the same appearance as the sharer's. */
async function newGuest(browser: Browser, appearance: Appearance): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { ...appearance.viewport },
    colorScheme: appearance.colorScheme,
  })
}

async function expectAppearanceApplied(page: Page, appearance: Appearance): Promise<void> {
  // PV has no dark scheme of its own (epic 72 D2): what must hold is that the browser really runs
  // in the requested scheme and size, and that the page still lays out.
  const dark = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)
  expect(dark).toBe(appearance.colorScheme === 'dark')
  expect(page.viewportSize()?.width).toBe(appearance.viewport.width)
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

function indexRow(page: Page, credentialName: string) {
  return page.getByRole('listitem').filter({ hasText: credentialName })
}

describeEachAppearance('J41 shares index and guest verification', (appearance) => {
  test('AC1/AC2/AC5/AC6: index lists the share, the guest verifies the emailed code, the share reads Opened', async ({
    page,
    context,
    browser,
  }) => {
    test.slow()
    const sharer = await startAsSharer(page, context)
    const recipientEmail = `j41-${randomUUID().slice(0, 8)}@vendor.example`
    const link = await createExternalShareViaUi(page, {
      recipientEmail,
      password: OWNER_PASSWORD,
    })
    const token = tokenFromShareUrl(link)

    // The index lists the share as Active, with a link to the credential.
    await page.goto('/shares')
    await expectAppearanceApplied(page, appearance)
    const row = indexRow(page, sharer.credentialName)
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('Active')
    await expect(row).toContainText(recipientEmail)
    await expect(row.getByRole('link', { name: sharer.credentialName })).toHaveAttribute(
      'href',
      `/projects/${sharer.projectId}/credentials/${sharer.credentialId}`
    )
    await expectNoHorizontalOverflow(page)

    const guestContext = await newGuest(browser, appearance)
    const guest = await guestContext.newPage()
    await openGuestShare(guest, token)
    await expectAppearanceApplied(guest, appearance)
    await expectNoHorizontalOverflow(guest)

    // The link alone shows no credential id and no value, only the masked address shape.
    await expect(guest.getByText(MASKED_ADDRESS).first()).toBeVisible()
    expect(await guest.content()).not.toContain(sharer.credentialId)
    await expect(guest.getByText(USERNAME_VALUE)).toHaveCount(0)
    await expect(guest.getByRole('button', { name: REVEAL_BUTTON })).toHaveCount(0)

    // Send the code: resend is disabled with a visible countdown.
    await sendGuestCode(guest)
    const resend = guest.getByRole('button', { name: /Resend code in \d+ s/ })
    await expect(resend).toBeDisabled()
    const secondsLeft = async () =>
      Number(/in (\d+) s/.exec((await resend.textContent()) ?? '')?.[1] ?? '0')
    const first = await secondsLeft()
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThanOrEqual(60)
    await expect.poll(secondsLeft, { timeout: 5_000 }).toBeLessThan(first)

    await plantVerificationCode({ recipientEmail, rawToken: token, sendCount: 1 })

    // A wrong code shows one generic message; a right code unlocks the reveal.
    await submitGuestCode(guest, GUEST_WRONG_CODE)
    await expect(guest.getByRole('alert')).toContainText(WRONG_CODE_TEXT)
    await submitGuestCode(guest, GUEST_TEST_CODE)
    await guest.getByRole('button', { name: REVEAL_BUTTON }).click()
    await expect(guest.getByText(USERNAME_VALUE, { exact: true })).toBeVisible()
    await expectNoHorizontalOverflow(guest)
    expect(guest.url()).not.toContain('proof')
    await guestContext.close()

    // The index and the credential's own share list now read Opened.
    await page.goto('/shares')
    await expect(indexRow(page, sharer.credentialName)).toContainText('Opened')
    await page.getByRole('link', { name: 'Opened' }).click()
    await expect(indexRow(page, sharer.credentialName)).toHaveCount(1)
    await page.goto(`/projects/${sharer.projectId}/credentials/${sharer.credentialId}`)
    await expect(page.getByRole('listitem').filter({ hasText: recipientEmail })).toContainText(
      'Opened'
    )
  })

  test('AC2/AC5/AC7: five wrong codes lock the share, the index reads Locked and the guest cannot continue', async ({
    page,
    context,
    browser,
  }) => {
    test.slow()
    const sharer = await startAsSharer(page, context)
    const recipientEmail = `j41-lock-${randomUUID().slice(0, 8)}@vendor.example`
    const token = tokenFromShareUrl(
      await createExternalShareViaUi(page, { recipientEmail, password: OWNER_PASSWORD })
    )

    const guestContext = await newGuest(browser, appearance)
    const guest = await guestContext.newPage()
    await openGuestShare(guest, token)
    await sendGuestCode(guest)
    await plantVerificationCode({ recipientEmail, rawToken: token, sendCount: 1 })

    // Five failed attempts, one after another (the cap is per share and each is counted).
    await Array.from({ length: 5 }).reduce<Promise<void>>(
      (previous) =>
        previous.then(async () => {
          await submitGuestCode(guest, GUEST_WRONG_CODE)
          await expect(guest.getByRole('alert')).toContainText(WRONG_CODE_TEXT)
        }),
      Promise.resolve()
    )
    // Even the right code no longer works.
    await submitGuestCode(guest, GUEST_TEST_CODE)
    await expect(guest.getByRole('alert')).toContainText(WRONG_CODE_TEXT)
    await expect(guest.getByRole('button', { name: REVEAL_BUTTON })).toHaveCount(0)

    // A fresh visit shows the closed link and nothing to continue with: no code step, no reveal.
    await guest.reload()
    await expect(guest.getByText('This link is no longer active.')).toBeVisible()
    await expect(guest.getByLabel('6-digit code')).toHaveCount(0)
    await expect(guest.getByRole('button', { name: REVEAL_BUTTON })).toHaveCount(0)
    await expect(guest.getByRole('button', { name: 'Send code' })).toHaveCount(0)
    await guestContext.close()

    await page.goto('/shares')
    await expect(indexRow(page, sharer.credentialName)).toContainText('Locked')
    await page.getByRole('link', { name: 'Locked' }).click()
    await expect(indexRow(page, sharer.credentialName)).toHaveCount(1)
    await expectNoHorizontalOverflow(page)
  })

  test('AC3: a failed share shows the localized message of its typed reason', async ({
    page,
    context,
  }) => {
    await startAsSharer(page, context)
    await page.getByRole('button', { name: 'External (email)' }).click()
    await page.getByPlaceholder('vendor@invalid').fill('j41-reason@vendor.example')

    // No step-up factor: step_up_required.
    await page.getByRole('button', { name: 'Create share link' }).click()
    await expect(page.getByText(/Confirm your password or an authenticator code/)).toBeVisible()

    // Too far away for an external share: expiry_too_late.
    await page.getByLabel('Expires in (hours)').fill('500')
    await page.getByLabel('Confirm your password').fill(OWNER_PASSWORD)
    await page.getByRole('button', { name: 'Create share link' }).click()
    await expect(page.getByText(/expiry time is too far away/)).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('AC5: the code step is completable with the keyboard alone', async ({
    page,
    context,
    browser,
  }) => {
    test.slow()
    await startAsSharer(page, context)
    const recipientEmail = `j41-kbd-${randomUUID().slice(0, 8)}@vendor.example`
    const token = tokenFromShareUrl(
      await createExternalShareViaUi(page, { recipientEmail, password: OWNER_PASSWORD })
    )

    const guestContext = await newGuest(browser, appearance)
    const guest = await guestContext.newPage()
    await openGuestShare(guest, token)

    // Tab to "Send code", Enter sends it.
    await guest.keyboard.press('Tab')
    await expect(guest.getByRole('button', { name: 'Send code' })).toBeFocused()
    await actUntilAnswered(guest, 'send', () => guest.keyboard.press('Enter'))
    await expect(guest.getByRole('button', { name: /Resend code in \d+ s/ })).toBeDisabled()
    await plantVerificationCode({ recipientEmail, rawToken: token, sendCount: 1 })

    // The disabled resend button is skipped: the next stop is the code field, then Verify.
    await guest.keyboard.press('Tab')
    const input = guest.getByLabel('6-digit code')
    await expect(input).toBeFocused()
    await guest.keyboard.type(GUEST_TEST_CODE)
    await guest.keyboard.press('Tab')
    await expect(guest.getByRole('button', { name: 'Verify code' })).toBeFocused()
    await actUntilAnswered(guest, 'confirm', () => guest.keyboard.press('Enter'))

    // The reveal step is the next stop for the keyboard too.
    const reveal = guest.getByRole('button', { name: REVEAL_BUTTON })
    await expect(reveal).toBeVisible()
    await guest.keyboard.press('Tab')
    await expect(reveal).toBeFocused()
    await guest.keyboard.press('Enter')
    await expect(guest.getByText(USERNAME_VALUE, { exact: true })).toBeVisible()
    await guestContext.close()
  })

  test('AC1: an anonymous visitor to /shares is sent to sign in', async ({ browser }) => {
    const anonymous = await newGuest(browser, appearance)
    const anonymousPage = await anonymous.newPage()
    await anonymousPage.goto('/shares')
    await expect(anonymousPage).toHaveURL(/\/login/)
    await anonymous.close()
  })
})
