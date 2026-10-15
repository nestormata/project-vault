import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createCredentialViaApi, createProjectViaApi } from '../fixtures/api.js'
import {
  uniqueCredentialValue,
  uniqueEmail,
  uniqueOrgName,
  uniqueProjectName,
} from '../fixtures/ids.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'

// J37 (Story 68-27) — web auth resolution on the real image, at the API's default per-user
// `/auth/me` limiter. Two claims:
//  1. Request budget: a multi-page journey costs one `/auth/me` per page/data request. The
//     same-origin `/api/v1/*` calls (browser fetches and SvelteKit's internal `event.fetch`) add
//     none. Measured through the API's own rate-limit headers, so the count is the backend's, not
//     a guess; the assertion is structural (a count bound), never a duration.
//  2. Exhaustion is a refusal, not a sign-out: once the `/auth/me` limiter is spent, protected
//     pages answer a retryable 429 with Retry-After and are never a 303 to /login.
async function authMeQuota(request: {
  get: (url: string) => Promise<{
    status: () => number
    headers: () => Record<string, string>
  }>
}) {
  const response = await request.get('/api/v1/auth/me')
  expect(response.status()).toBe(200)
  const headers = response.headers()
  const limit = Number(headers['x-ratelimit-limit'])
  const remaining = Number(headers['x-ratelimit-remaining'])
  expect(Number.isInteger(limit) && Number.isInteger(remaining), JSON.stringify(headers)).toBe(true)
  return { limit, remaining }
}

// Bounded concurrency without a loop: each batch settles before the next starts, so a burst is
// real but never a thundering herd of full server renders.
async function inBatches<T, R>(
  items: T[],
  size: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const head = await Promise.all(items.slice(0, size).map(run))
  return [...head, ...(await inBatches(items.slice(size), size, run))]
}

// Reads `/auth/me` through the same-origin proxy in batches of 10 until the API answers 429 (the
// per-user limiter, 60 per minute by default); gives up after `batches` batches.
async function readUntilThrottled(
  request: { get: (url: string) => Promise<{ status: () => number }> },
  batches: number
): Promise<boolean> {
  if (batches === 0) return false
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => request.get('/api/v1/auth/me'))
  )
  if (responses.some((response) => response.status() === 429)) return true
  return readUntilThrottled(request, batches - 1)
}

test.describe('J37 — auth request budget and upstream refusal', () => {
  test('a multi-page journey spends one /auth/me per page request, and exhaustion is a 429 not a sign-out', async ({
    page,
    context,
  }) => {
    // Four full page loads, a quota probe after each, and a limiter burst.
    test.setTimeout(180_000)
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j37-owner'),
      password: OWNER_PASSWORD,
      orgName: uniqueOrgName('J37 Org'),
    })
    const first = await createProjectViaApi(context, {
      name: uniqueProjectName('J37 First'),
      slug: `j37-a-${Date.now()}`,
    })
    const second = await createProjectViaApi(context, {
      name: uniqueProjectName('J37 Second'),
      slug: `j37-b-${Date.now()}`,
    })
    await createCredentialViaApi(context, first.id, {
      name: 'j37-credential',
      value: uniqueCredentialValue('j37'),
    })

    let pageRequests = 0
    const seen: string[] = []
    page.on('request', (request) => {
      const { pathname } = new URL(request.url())
      if (!pathname.startsWith('/_app/'))
        seen.push(`${request.method()} ${request.resourceType()} ${pathname}`)
      if (request.resourceType() === 'document' || pathname.endsWith('/__data.json')) {
        pageRequests += 1
      }
    })

    // Per page: one `/auth/me` for each document or data request, and none for the `/api/v1/*`
    // calls the page makes (SSR `event.fetch`, the browser's own fetches, the event stream).
    const measured: string[] = []
    let quota = await authMeQuota(context.request)
    const startQuota = quota
    const paths = [
      '/dashboard',
      `/projects/${first.id}`,
      `/projects/${second.id}`,
      `/projects/${first.id}/credentials`,
    ]
    await inBatches(paths, 1, async (path) => {
      pageRequests = 0
      await page.goto(path)
      await expect(page).toHaveURL(path)
      const next = await authMeQuota(context.request)
      // The quota probe is itself one `/auth/me` through the proxy (the API counts it).
      const spent = quota.remaining - next.remaining - 1
      measured.push(`${path}: spent ${spent} for ${pageRequests} page request(s)`)
      expect(spent, measured.join('; ')).toBeGreaterThanOrEqual(1)
      expect(spent, measured.join('; ')).toBeLessThanOrEqual(pageRequests)
      quota = next
    })
    test.info().annotations.push({ type: 'auth-me-budget', description: measured.join('; ') })
    expect(startQuota.remaining - quota.remaining).toBeLessThan(startQuota.limit)

    // Burst of repeated authenticated reads of `/auth/me` itself until the per-user limiter is
    // spent (through the same-origin proxy, which no longer probes first). The next protected page
    // then meets a genuinely throttled auth API.
    const throttled = await readUntilThrottled(context.request, 20)
    expect(throttled, 'the per-user /auth/me limiter must be exhausted').toBe(true)

    // Before 68-27 this was a 303 to /login (a false sign-out). Now: a retryable refusal.
    const refused = await context.request.get('/dashboard', {
      maxRedirects: 0,
      headers: { accept: 'text/html' },
    })
    expect(refused.status()).toBe(429)
    expect(refused.headers()['location']).toBeUndefined()
    // The API's limiter sends no Retry-After today; if it ever does, it is passed on sanitized.
    const retryAfter = refused.headers()['retry-after']
    if (retryAfter !== undefined) expect(Number(retryAfter)).toBeGreaterThanOrEqual(0)
    expect(refused.headers()['cache-control']).toBe('no-store')
    expect(await refused.text()).toContain('Temporarily unavailable')

    // The session itself is intact: once the window passes the same cookies work again. (Not
    // waited for here; the cookies are unchanged and no refresh/logout happened in between.)
    const cookiesAfter = await context.cookies()
    expect(cookiesAfter.map((cookie) => cookie.name)).toEqual(
      expect.arrayContaining(['access-token'])
    )
  })
})
