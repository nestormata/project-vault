import { expect, test, type Request } from '@playwright/test'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'
import { RegisterPage } from '../pages/RegisterPage.js'

// J32 — Story 66.3 AC-11 regression journey. When a secret-bearing form is submitted natively —
// the click landed before hydration, or the JavaScript never loaded — the secret must not reach
// the URL, the request, or the response. Two layers make that true (see
// apps/web/src/lib/security/form-secret-inputs.test.ts for the source-level guard): the secret
// input has no `name` (so it is never serialized) and the form declares `method="post"` (so even a
// named field would go into the body, not the query string). /register has no form action, so
// SvelteKit answers the native POST with 405, rendered as the app's own error page.
//
// The JS-free state is produced by aborting the app's own client bundle for this one page — the
// deterministic stand-in for "hydration has not happened (yet)". It is scoped to
// `/_app/immutable/` requests of this test's page only; no API route is mocked.

const CANARY_SECRET = 'j32-Native-Submit-Canary-Password-91'

test.describe('J32 — secret forms submitted without JavaScript (Story 66.3 AC-11)', () => {
  test('a native submit of the register form posts no secret and does not reflect it', async ({
    page,
  }) => {
    await page.route('**/_app/immutable/**', (route) => route.abort())
    const registerPage = new RegisterPage(page)
    await page.goto('/register')
    await registerPage.emailInput().fill(uniqueEmail('j32'))
    await registerPage.orgNameInput().fill(uniqueOrgName('J32 Org'))
    await registerPage.passwordInput().fill(CANARY_SECRET)

    const submission = page.waitForRequest(
      (request: Request) =>
        request.resourceType() === 'document' && request.url().includes('/register')
    )
    await registerPage.submitButton().click()
    const request = await submission
    const response = await request.response()

    // Layer 2: a POST — nothing is appended to the URL.
    expect(request.method()).toBe('POST')
    expect(new URL(request.url()).search).toBe('')
    // Layer 1: the unnamed password input is never serialized into the body.
    expect(request.postData() ?? '').not.toContain(CANARY_SECRET)
    // No form action on /register: a clean 405 through the app's error page — not a 500, and
    // nothing from the request echoed back.
    expect(response?.status()).toBe(405)
    await expect(page).toHaveURL(/\/register$/)
    expect(await page.content()).not.toContain(CANARY_SECRET)
  })
})
