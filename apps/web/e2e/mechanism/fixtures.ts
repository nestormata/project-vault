import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Page,
  PlaywrightWorkerArgs,
} from '@playwright/test'
import { expect } from '@playwright/test'
import { seedRegisterAndLogin } from './seed-guard.js'
import postgres from 'postgres'
import { gotoHydrated } from '../fixtures/hydration.js'
import { enrollMfaViaApi, registerViaInvitation } from '../fixtures/auth.js'
import { createInvitationViaApi } from '../fixtures/api.js'
import {
  extractTokenFromAcceptUrl,
  readLatestInvitationAcceptUrl,
  superuserDatabaseUrl,
} from '../fixtures/db.js'
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

// One throwaway credential per worker process, never a literal: it only registers the seeded users.
export const testPassword = randomBytes(24).toString('base64url')

export type SeededUser = { userId: string; orgId: string; email: string }

/** Registers an org and an owner through the web origin's /api/v1 proxy, logs in (the context keeps
 * the session cookie) and completes onboarding. */
export async function seedOrgOwner(context: BrowserContext, label: string): Promise<SeededUser> {
  const email = uniqueEmail(`mock-${label}`)
  const { userId, orgId } = await seedRegisterAndLogin(
    (route, data) => context.request.post(route, { data }),
    { email, password: testPassword, orgName: uniqueOrgName(`Mock ${label}`) }
  )
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

/** Ends the MFA enrollment grace period of one membership (setup-only SQL on the disposable e2e
 * database, like the platform-operator promotion): a fresh owner is inside the grace period, so PV's
 * `requireMfa` lets them through until it ends. Nothing about PV's own check is bypassed. */
export async function endMfaGracePeriod(orgId: string, userId: string): Promise<void> {
  const sql = postgres(superuserDatabaseUrl(), { max: 1 })
  try {
    const updated = await sql`
      update org_memberships set grace_period_expires_at = now() - interval '1 day'
      where org_id = ${orgId} and user_id = ${userId}
    `
    if (updated.count !== 1) throw new Error('endMfaGracePeriod: expected exactly one membership')
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

export type SeededMember = { context: BrowserContext; user: SeededUser }

/** A plain org member of the owner's org (Story 69.4), seeded through the REAL invitation flow: the
 * owner (MFA enrolled, as PV requires to invite) invites a new email to one of their projects, the
 * invitee registers through the accept link and logs in. No product back door and no SQL role edit.
 * The returned context holds the member's session and has finished onboarding. */
export async function seedOrgMember(
  browser: Browser,
  owner: { context: BrowserContext; projectId: string },
  label: string
): Promise<SeededMember> {
  await enrollMfaViaApi(owner.context)
  const email = uniqueEmail(`mock-${label}`)
  await createInvitationViaApi(owner.context, owner.projectId, { email, role: 'member' })
  const token = extractTokenFromAcceptUrl(await readLatestInvitationAcceptUrl(email))
  const context = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
  const page = await context.newPage()
  await registerViaInvitation(page, token, testPassword)
  await page.close()
  const body = (await postOk(context, '/api/v1/auth/login', { email, password: testPassword })) as {
    data: { userId: string; orgId: string }
  }
  await postOk(context, '/api/v1/users/me/onboarding', { completed: true })
  return { context, user: { userId: body.data.userId, orgId: body.data.orgId, email } }
}

/** The recent output of the composed web container of this run (read-only). The project name comes
 * from the runner's environment; callers assert on error names, never on a secret. */
export function readWebLog(): string {
  const project = process.env['COMPOSE_PROJECT_NAME'] ?? ''
  if (project === '') throw new Error('COMPOSE_PROJECT_NAME is required: run through the runner')
  // docker is resolved from fixed system directories, never from `$PATH` (Sonar S4036).
  for (const docker of ['/usr/bin/docker', '/usr/local/bin/docker', '/bin/docker']) {
    const run = spawnSync(docker, ['logs', '--tail', '500', `${project}-web-1`], {
      encoding: 'utf8',
    })
    if (run.error === undefined) return `${run.stdout}${run.stderr}`
  }
  throw new Error('docker was not found in /usr/bin, /usr/local/bin or /bin')
}

/** POSTs JSON through the context's session and returns the parsed body, failing on a non-2xx. */
async function postOk(context: BrowserContext, route: string, data: unknown): Promise<unknown> {
  const response = await context.request.post(route, { data })
  expect(response.ok(), await response.text()).toBeTruthy()
  return response.status() === 204 ? null : response.json()
}

/** A form POST from a foreign `origin` header, never following redirects: PV's CSRF check answers it. */
export function postFromForeignOrigin(context: BrowserContext, path: string) {
  return context.request.post(path, {
    form: { title: 'x' },
    headers: { origin: 'http://evil.example' },
    maxRedirects: 0,
  })
}

/** Revokes the session server-side while the browser keeps its (now stale) cookies, so the next
 * navigation is an expired-session request rather than an anonymous one. */
export async function revokeSessionKeepingCookies(context: BrowserContext): Promise<void> {
  const stale = await context.cookies()
  const logout = await context.request.post('/api/v1/auth/logout')
  expect(logout.status(), await logout.text()).toBe(204)
  await context.addCookies(stale)
}
