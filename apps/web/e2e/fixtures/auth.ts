import type { BrowserContext, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import * as OTPAuth from 'otpauth'
import { LoginPage } from '../pages/LoginPage.js'
import { RegisterPage } from '../pages/RegisterPage.js'
import { SecurityPage } from '../pages/SecurityPage.js'

export type RegisterOptions = {
  email: string
  password: string
  orgName: string
}

// AC-I4: registerViaUi drives the real /register form — used by J1 only, since registration UI
// correctness is J1's own subject under test.
export async function registerViaUi(page: Page, opts: RegisterOptions): Promise<void> {
  const registerPage = new RegisterPage(page)
  await registerPage.goto()
  await registerPage.fillAndSubmit(opts)
}

// Shared by AC-J1-1 and AC-J3-3: registerViaUi followed by the required explicit login
// (registration does not auto-login, docs/runbook.md) landing on /dashboard.
export async function registerViaUiAndLogin(page: Page, opts: RegisterOptions): Promise<void> {
  await registerViaUi(page, opts)
  await expect(page).toHaveURL(/\/login/)
  const loginPage = new LoginPage(page)
  await loginPage.fillAndSubmit({ email: opts.email, password: opts.password })
}

// AC-I4: registerAndLoginViaApi is the "UI is for validation only, not setup" primitive used by
// J2/J3/J4 to reach an already-authenticated starting state quickly, mirroring apps/api's own
// integration-test helper of the same name/shape (auth-test-helpers.ts).
//
// Implementation note (documented deviation from the story's literal "returning the session
// cookie for context.addCookies(...)" phrasing): `context.request` is Playwright's own idiomatic
// APIRequestContext bound to a BrowserContext's cookie jar — any Set-Cookie response header from
// a `context.request.*` call is automatically stored in that context and sent by subsequent
// `page.goto()` navigations in the same context. This achieves the identical end state (an
// authenticated browser context) with less brittle code than manually parsing Set-Cookie headers
// and calling context.addCookies(...) by hand.
export async function registerAndLoginViaApi(
  context: BrowserContext,
  opts: RegisterOptions
): Promise<{ userId: string; orgId: string }> {
  const registerResponse = await context.request.post('/api/v1/auth/register', {
    data: { email: opts.email, password: opts.password, orgName: opts.orgName },
  })
  expect(registerResponse.ok(), await registerResponse.text()).toBeTruthy()

  const loginResponse = await context.request.post('/api/v1/auth/login', {
    data: { email: opts.email, password: opts.password },
  })
  expect(loginResponse.ok(), await loginResponse.text()).toBeTruthy()
  const loginBody = (await loginResponse.json()) as { data: { userId: string; orgId: string } }

  // Discovered while implementing this story: the first-run OnboardingDialog renders as a modal
  // overlay (aria-modal="true") on ANY `(app)` route for a user who hasn't completed onboarding —
  // not just /dashboard — which makes the rest of the page inert to accessibility-role locators.
  // Every journey that reaches its starting state via this API-only helper (J2/J3/J4) is testing
  // something other than onboarding (J1 owns that), so it marks onboarding complete the same way,
  // matching this helper's own "UI is for validation only" principle rather than each journey
  // dismissing the dialog by hand.
  const onboardingResponse = await context.request.post('/api/v1/users/me/onboarding', {
    data: { completed: true },
  })
  expect(onboardingResponse.ok(), await onboardingResponse.text()).toBeTruthy()

  return loginBody.data
}

// AC-I4: enrollMfaViaApi — direct API calls only (mirrors apps/api's
// mfa-enroll-test-helpers.ts's enrollUserWithMfa shape), used by journeys that need an
// MFA-enrolled caller as a precondition without MFA itself being the subject under test
// (AC-J2-1's requireMfaEnrollmentStrict() precondition on invitations).
export async function enrollMfaViaApi(context: BrowserContext): Promise<{ secret: string }> {
  const enrollResponse = await context.request.post('/api/v1/auth/mfa/enroll', { data: {} })
  expect(enrollResponse.ok(), await enrollResponse.text()).toBeTruthy()
  const enrollBody = (await enrollResponse.json()) as { data: { secret: string } }
  const secret = enrollBody.data.secret

  const verifyResponse = await context.request.post('/api/v1/auth/mfa/verify-enrollment', {
    data: { totp: currentTotp(secret) },
  })
  expect(verifyResponse.ok(), await verifyResponse.text()).toBeTruthy()

  return { secret }
}

// Shared by AC-J3-1 and AC-J3-2: drives the real /settings/security enrollment form (goto ->
// start enrollment -> read the revealed secret -> submit the current TOTP code -> dismiss the
// recovery-codes screen), returning the secret so the caller can compute further login-challenge
// codes. MFA enrollment UI correctness itself is not J3's subject in every AC (only AC-J3-1's),
// but both ACs need a real MFA-enrolled session as their starting point.
export async function enrollMfaViaUi(page: Page): Promise<{ secret: string }> {
  const securityPage = new SecurityPage(page)
  await securityPage.goto()
  await securityPage.startEnrollmentButton().click()
  const secretRaw = (await securityPage.secretText().textContent())?.trim()
  expect(secretRaw, 'enrollment must reveal a TOTP secret').toBeTruthy()
  if (!secretRaw) throw new Error('unreachable — asserted above')
  await securityPage.totpInput().fill(currentTotp(secretRaw))
  await securityPage.verifyButton().click()
  await expect(securityPage.saveRecoveryCodesButton()).toBeVisible()
  await securityPage.saveRecoveryCodesButton().click()
  return { secret: secretRaw }
}

// Reuses apps/api's own TOTP-generation test-helper algorithm/parameters (SHA1, 6 digits, 30s
// period — apps/api/src/__tests__/helpers/totp.ts) rather than re-deriving RFC 6238 parameters
// independently. Uses the `otpauth` package (this repo's existing convention, per that same
// helper) rather than the story's illustrative "e.g. otplib" suggestion.
export function currentTotp(base32Secret: string, timestamp = Date.now()): string {
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(base32Secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  }).generate({ timestamp })
}

const TOTP_PERIOD_MS = 30_000

// Discovered while implementing this story: apps/api enforces real TOTP anti-replay
// (totp_used_codes, apps/api/src/modules/auth/totp.ts) keyed by the code's time-window counter —
// submitting a code derived from the SAME 30s window twice (e.g. once for MFA enrollment-verify,
// once moments later for login-verify) is correctly rejected as a replay even though the numeric
// code is "fresh" per RFC 6238. AC-J3-1's own dev note anticipated same-value collision as
// generally fine, but didn't anticipate server-side replay rejection specifically — this helper
// makes tests that submit more than one real TOTP code deterministically cross into a new window
// before generating the next one, rather than hoping for a lucky boundary crossing.
export async function waitForNextTotpWindow(afterTimestamp = Date.now()): Promise<void> {
  const currentWindowStart = Math.floor(afterTimestamp / TOTP_PERIOD_MS) * TOTP_PERIOD_MS
  const nextWindowStart = currentWindowStart + TOTP_PERIOD_MS
  const delayMs = nextWindowStart - Date.now() + 250 // small buffer past the boundary
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
}
