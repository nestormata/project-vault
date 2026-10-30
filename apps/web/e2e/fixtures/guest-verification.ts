import { createHmac } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import postgres from 'postgres'
import { superuserDatabaseUrl } from './db.js'
import { gotoHydrated } from './hydration.js'

// Story 72.11: the guest (external recipient) code step in a journey.
//
// The six-digit code is emailed. The code sits in `notification_queue.payload.code` only while the
// row is `pending`; the delivery worker sends it at once and then drops it, so a test cannot read
// it reliably after the request (the invitation fixture in db.ts can read its link because that
// payload is kept). So this fixture does what the mailbox owner's reading step stands for in a
// different way: after the page's real "Send code" request has written a code, it REPLACES the
// stored hash with the hash of a code the test chose, computed exactly as the API does
// (HMAC-SHA256 keyed by the raw share token over `<share id>:<code>`), and extends its expiry.
// Everything after that (typing the code, the attempt cap, the proof, the reveal) is the real
// product path. Setup-only, on the disposable E2E database's superuser connection, like
// `setOrganizationRoleViaDb`; never usable against a real instance.

/** A fixed, valid six-digit code for journeys that need the right code. */
export const GUEST_TEST_CODE = '482916'
/** A six-digit code that never equals GUEST_TEST_CODE. */
export const GUEST_WRONG_CODE = '000000'

const POLL_TIMEOUT_MS = 15_000

/** The code hash the API stores (V3): HMAC-SHA256 keyed by the raw token over `shareId:code`. */
export function guestCodeHash(rawToken: string, shareId: string, code: string): string {
  return createHmac('sha256', rawToken).update(`${shareId}:${code}`).digest('hex')
}

/** The raw token of an external share link as the sharer sees it. */
export function tokenFromShareUrl(shareUrl: string): string {
  const token = new URL(shareUrl).pathname.split('/').pop()
  if (!token) throw new Error(`no token in share url: ${shareUrl}`)
  return token
}

interface PlantOptions {
  recipientEmail: string
  rawToken: string
  /** How many sends the share must have recorded before the code is replaced (1 = the first). */
  sendCount: number
  code?: string
}

/**
 * Waits for the share of `recipientEmail` to record its `sendCount`-th code send, then stores the
 * hash of `code` (default GUEST_TEST_CODE) as the live code.
 */
export async function plantVerificationCode(options: PlantOptions): Promise<void> {
  const code = options.code ?? GUEST_TEST_CODE
  const sql = postgres(superuserDatabaseUrl(), { max: 1 })
  try {
    const found: { id: string | null } = { id: null }
    await expect
      .poll(
        async () => {
          // The newest share of that address: an older one (a repeated run) must never match.
          const rows = await sql<{ id: string; sends: number; has_code: boolean }[]>`
            select id, verification_send_count as sends,
                   verification_code_hash is not null as has_code
            from credential_shares
            where recipient_email = ${options.recipientEmail}
            order by created_at desc
            limit 1
          `
          const row = rows[0]
          found.id = row && row.sends >= options.sendCount && row.has_code ? row.id : null
          return found.id
        },
        {
          message: `a code send recorded for ${options.recipientEmail}`,
          timeout: POLL_TIMEOUT_MS,
          intervals: [100],
        }
      )
      .not.toBeNull()
    if (found.id === null) throw new Error('unreachable: the poll above ended with a share')
    const hash = guestCodeHash(options.rawToken, found.id, code)
    await sql`
      update credential_shares
      set verification_code_hash = ${hash},
          verification_code_expires_at = now() + interval '10 minutes'
      where id = ${found.id}
    `
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** Opens the public guest page of a gated share and waits until its "Send code" button is live. */
export async function openGuestShare(page: Page, rawToken: string): Promise<void> {
  await gotoHydrated(
    page,
    `/external-shares/${rawToken}`,
    page.getByRole('button', { name: 'Send code' })
  )
}

/** Which of the two guest verification routes a request belongs to. */
type GuestRoute = 'send' | 'confirm'

function isGuestRoute(url: string, route: GuestRoute): boolean {
  const path = new URL(url).pathname
  return path.endsWith(route === 'send' ? '/verification' : '/verification/confirm')
}

// The send route allows 10 and the confirm route 20 requests a minute per IP, and the web proxy
// does not forward the client address, so every journey of the suite shares one bucket. A run of
// several appearances can reach it: a 429 means "not counted, try again after the window", never a
// product failure. Waiting out the window keeps the journeys deterministic; callers use
// `test.slow()` for the extra time.
const RATE_LIMIT_WINDOW_WAIT_MS = 20_000
const RATE_LIMIT_RETRIES = 4

/**
 * Runs `act` (the click or key press that fires one guest verification request) and returns once
 * the request was answered by something other than 429. After a 429 it waits and acts again.
 */
export async function actUntilAnswered(
  page: Page,
  route: GuestRoute,
  act: () => Promise<void>,
  retriesLeft = RATE_LIMIT_RETRIES
): Promise<void> {
  const answered = page.waitForResponse(
    (response) => response.request().method() === 'POST' && isGuestRoute(response.url(), route)
  )
  await act()
  const status = (await answered).status()
  if (status !== 429) return
  if (retriesLeft === 0) throw new Error(`guest ${route} stayed rate limited`)
  await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WINDOW_WAIT_MS))
  await actUntilAnswered(page, route, act, retriesLeft - 1)
}

/** Presses "Send code" (waiting out a rate limit) and returns once the request was answered. */
export async function sendGuestCode(page: Page): Promise<void> {
  await actUntilAnswered(page, 'send', () =>
    page.getByRole('button', { name: 'Send code' }).click()
  )
}

/** Types `code` and presses "Verify code" (waiting out a rate limit); returns once answered. */
export async function submitGuestCode(page: Page, code: string): Promise<void> {
  await actUntilAnswered(page, 'confirm', async () => {
    await page.getByLabel('6-digit code').fill(code)
    await page.getByRole('button', { name: 'Verify code' }).click()
  })
}

interface GuestCodeStep {
  recipientEmail: string
  rawToken: string
  code?: string
}

/**
 * The guest page's whole code step as a recipient does it: press "Send code", (fixture: set the
 * code), type it, press "Verify code". Leaves the page on the "Reveal secret" step.
 */
export async function completeGuestCodeStep(page: Page, step: GuestCodeStep): Promise<void> {
  const code = step.code ?? GUEST_TEST_CODE
  await sendGuestCode(page)
  await plantVerificationCode({
    recipientEmail: step.recipientEmail,
    rawToken: step.rawToken,
    sendCount: 1,
    code,
  })
  await submitGuestCode(page, code)
  await expect(page.getByRole('button', { name: 'Reveal secret' })).toBeVisible()
}

interface ExternalShareForm {
  recipientEmail: string
  /** The sharer's own password: the step-up the external share form asks for. */
  password: string
  /** Hours until expiry; the form default (one hour) when omitted. */
  expiresInHours?: number
}

/**
 * Fills and submits the credential page's external share form (the page must already be open on
 * the credential, with the default field selection) and returns the one-time link.
 */
export async function createExternalShareViaUi(
  page: Page,
  form: ExternalShareForm
): Promise<string> {
  await page.getByRole('button', { name: 'External (email)' }).click()
  await page.getByPlaceholder('vendor@invalid').fill(form.recipientEmail)
  if (form.expiresInHours !== undefined) {
    await page.getByLabel('Expires in (hours)').fill(String(form.expiresInHours))
  }
  await page.getByLabel('Confirm your password').fill(form.password)
  await page.getByRole('button', { name: 'Create share link' }).click()
  await expect(page.getByText('Share link created')).toBeVisible()
  const link = await page.locator('code', { hasText: '/external-shares/' }).textContent()
  if (!link) throw new Error('the share link was not shown')
  return link
}
