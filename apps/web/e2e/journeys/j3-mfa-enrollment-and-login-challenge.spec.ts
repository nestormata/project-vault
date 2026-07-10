import { expect, test } from '@playwright/test'
import {
  currentTotp,
  enrollMfaViaUi,
  registerAndLoginViaApi,
  registerViaUiAndLogin,
  waitForNextTotpWindow,
} from '../fixtures/auth.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'
import { LoginPage } from '../pages/LoginPage.js'
import { SecurityPage } from '../pages/SecurityPage.js'

// J3: MFA enrollment -> MFA-required login challenge.
// See story AC-J3-1/AC-J3-2/AC-J3-3.

test.describe('J3 — MFA enrollment and login challenge', () => {
  test('AC-J3-1: happy path — enroll via UI, log out, log back in through the real MFA challenge', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j3-happy')
    const password = 'e2e-J3-Password-123'
    await registerAndLoginViaApi(context, { email, password, orgName: uniqueOrgName('J3 Org') })

    // Fresh TOTP computed against the current clock inside enrollMfaViaUi — enrollment-verify and
    // login-verify codes may legitimately be the same or different depending on the 30s window;
    // never hardcoded.
    const { secret } = await enrollMfaViaUi(page)
    // MfaEnrollmentPanel shows "Save your recovery codes" immediately on successful verification
    // (checked before the "MFA is enabled" heading in its own if/else-if chain) — the "MFA is
    // enabled" heading only appears on this next render, once recoveryCodes was dismissed above.
    await expect(new SecurityPage(page).mfaEnabledHeading()).toBeVisible()

    // Log out: clear the browser context's cookies (no dedicated "log out" UI control assumed —
    // this proves the login challenge from a clean, unauthenticated state).
    await context.clearCookies()

    const loginPage = new LoginPage(page)
    await loginPage.goto()
    await loginPage.fillAndSubmit({ email, password })

    // pendingMfa renders MfaLoginForm on the SAME /login page — there is no /login/mfa URL.
    await expect(loginPage.totpInput()).toBeVisible()
    await expect(page).toHaveURL(/\/login/)

    // Real server-side TOTP anti-replay (totp_used_codes) rejects reusing a code from the same
    // 30s window the enrollment-verify step already consumed — wait for a fresh window rather
    // than risk a rare, real (not flaky) rejection.
    await waitForNextTotpWindow()
    await loginPage.submitMfaCode(currentTotp(secret))
    await expect(page).toHaveURL(/\/dashboard/)

    const cookies = await context.cookies()
    expect(cookies.some((cookie) => cookie.name === 'access-token')).toBe(true)
  })

  test('AC-J3-2: failure path — wrong TOTP is rejected, pending MFA session survives the failed attempt', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j3-wrong')
    const password = 'e2e-J3-Wrong-Password-123'
    await registerAndLoginViaApi(context, {
      email,
      password,
      orgName: uniqueOrgName('J3 Wrong Org'),
    })

    const { secret } = await enrollMfaViaUi(page)
    await context.clearCookies()

    const loginPage = new LoginPage(page)
    await loginPage.goto()
    await loginPage.fillAndSubmit({ email, password })
    await expect(loginPage.totpInput()).toBeVisible()

    // Real server-side TOTP anti-replay (totp_used_codes) rejects reusing a code from the same
    // 30s window the enrollment-verify step already consumed.
    await waitForNextTotpWindow()
    const correctCode = currentTotp(secret)
    // Deliberately wrong: increment the last digit, wrapping 9 -> 0, and verify inequality first
    // to avoid a rare accidental-match flake.
    const lastDigit = Number(correctCode[correctCode.length - 1])
    const wrongLastDigit = (lastDigit + 1) % 10
    const wrongCode = correctCode.slice(0, -1) + String(wrongLastDigit)
    expect(wrongCode).not.toBe(correctCode)

    await loginPage.submitMfaCode(wrongCode)
    await expect(loginPage.errorAlert()).toBeVisible()
    // Still on the challenge, not bounced back to a fresh password prompt.
    await expect(loginPage.totpInput()).toBeVisible()

    // The correct code, submitted immediately after, succeeds — the one failed attempt did not
    // destroy the pending MFA session.
    await loginPage.submitMfaCode(currentTotp(secret))
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test('AC-J3-3: negative control — a user who never enrolled MFA logs in with no MFA challenge', async ({
    page,
  }) => {
    const email = uniqueEmail('j3-none')
    const password = 'e2e-J3-None-Password-123'
    const orgName = uniqueOrgName('J3 None Org')

    await registerViaUiAndLogin(page, { email, password, orgName })

    // Lands directly on /dashboard — MfaLoginForm never renders, since enrollment state (not a
    // blanket policy) is what gates the challenge.
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(new LoginPage(page).totpInput()).toHaveCount(0)
  })
})
