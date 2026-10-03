import { randomUUID } from 'node:crypto'
import type {
  APIRequestContext,
  BrowserContext,
  Page,
  PlaywrightWorkerArgs,
} from '@playwright/test'
import { expect } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import postgres from 'postgres'
import { superuserDatabaseUrl } from '../fixtures/db.js'
import { gotoHydrated } from '../fixtures/hydration.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'

// Story 68.10 AC-5: the shared helpers of the mechanism specs, built on the existing e2e fixtures
// (reused, never copied). Everything is seeded through PV's REAL API (register, login), never SQL,
// and every spec creates its own uniquely named orgs and users and its own sentinels, so no spec
// reads data another spec created and none asserts a global count.

/** The API port, for routes the web origin does not proxy (everything outside /api/v1). */
export function apiBaseUrl(): string {
  const value = process.env['E2E_API_BASE_URL']
  if (value === undefined || value === '') {
    throw new Error('E2E_API_BASE_URL is required: run through `make mock-ui-pack-e2e`')
  }
  return value
}

type Playwright = PlaywrightWorkerArgs['playwright']

export const testPassword = 'correct-horse-battery-staple-mock-pack'

export type SeededUser = { userId: string; orgId: string; email: string }

/** Registers an org and an owner through the web origin's /api/v1 proxy, logs in (the context keeps
 * the session cookie) and completes onboarding. */
export async function seedOrgOwner(context: BrowserContext, label: string): Promise<SeededUser> {
  const email = uniqueEmail(`mock-${label}`)
  const { userId, orgId } = await registerAndLoginViaApi(context, {
    email,
    password: testPassword,
    orgName: uniqueOrgName(`Mock ${label}`),
  })
  return { userId, orgId, email }
}

/** A project of the seeded user's org, created through the API (the session of `context`). */
export async function createProject(context: BrowserContext, name: string): Promise<string> {
  const response = await context.request.post('/api/v1/projects', { data: { name } })
  expect(response.ok(), await response.text()).toBeTruthy()
  return ((await response.json()) as { data: { id: string } }).data.id
}

/** A request context aimed at the API port with the session cookies of `context` (an API-level check
 * of a route the web origin does not proxy, in the same run and report). */
export async function apiContextFor(
  playwright: Playwright,
  context: BrowserContext
): Promise<APIRequestContext> {
  const cookies = await context.cookies()
  const header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  return playwright.request.newContext({
    baseURL: apiBaseUrl(),
    extraHTTPHeaders: header === '' ? {} : { cookie: header },
  })
}

/** An anonymous request context aimed at the API port. */
export function anonymousApi(playwright: Playwright): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: apiBaseUrl() })
}

/** A sentinel no neighbouring case can emit: `mock-ui-pack:<case>-<random>`. */
export function sentinel(label: string): string {
  return `mock-ui-pack:${label}-${randomUUID().slice(0, 8)}`
}

/** Opens a page and waits for Svelte's hydration (the 66-3 convention; never a bare goto before a
 * click). `firstTarget` is the element the spec interacts with first. */
export async function open(page: Page, path: string, firstTarget: ReturnType<Page['locator']>) {
  await gotoHydrated(page, path, firstTarget)
}

/** A read-only count of one org's audit rows of one event type (the superuser bypasses RLS; nothing
 * is ever written through this connection). */
export async function countAuditEvents(orgId: string, eventType: string): Promise<number> {
  const sql = postgres(superuserDatabaseUrl(), { max: 1 })
  try {
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from audit_log_entries
      where org_id = ${orgId} and event_type = ${eventType}
    `
    return row?.count ?? 0
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** Collects Svelte hydration-mismatch warnings from the page console. A mismatch makes the client
 * rebuild part of the DOM (a mismatched head dropped the stylesheet once), so the mechanism specs
 * assert there were none for every page they render. */
export function trackHydrationMismatch(page: Page): () => string[] {
  const seen: string[] = []
  page.on('console', (message) => {
    if (message.text().includes('hydration_mismatch')) seen.push(message.text())
  })
  return () => seen
}
