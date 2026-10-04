import { randomBytes, randomUUID } from 'node:crypto'
import type {
  APIRequestContext,
  BrowserContext,
  Page,
  PlaywrightWorkerArgs,
} from '@playwright/test'
import { expect } from '@playwright/test'
import { seedRegisterAndLogin } from './seed-guard.js'
import { createInvitationViaApi } from '../fixtures/api.js'
import { enrollMfaViaApi } from '../fixtures/auth.js'
import { extractTokenFromAcceptUrl, readLatestInvitationAcceptUrl } from '../fixtures/db.js'
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

async function postForId(context: BrowserContext, path: string, data: unknown): Promise<string> {
  const response = await context.request.post(path, { data })
  expect(response.ok(), await response.text()).toBeTruthy()
  return ((await response.json()) as { data: { id: string } }).data.id
}

/** A project of the seeded user's org, created through the API (the session of `context`). */
export function createProject(context: BrowserContext, name: string): Promise<string> {
  return postForId(context, '/api/v1/projects', { name })
}

/** A credential of the seeded user's project, created through the API with the session of `context`.
 * The secret value is random per call, never a literal; only the id is returned. */
export function createCredential(
  context: BrowserContext,
  projectId: string,
  name: string
): Promise<string> {
  return postForId(context, `/api/v1/projects/${projectId}/credentials`, {
    name,
    value: randomBytes(18).toString('base64url'),
  })
}

/** An org owner with one project and one credential, each uniquely named (Story 69.2). */
export async function seedCredentialPage(
  context: BrowserContext,
  label: string
): Promise<SeededUser & { projectId: string; credentialId: string; credentialName: string }> {
  const user = await seedOrgOwner(context, label)
  const projectId = await createProject(context, `${label}-${randomUUID().slice(0, 8)}`)
  const credentialName = `${label}-${randomUUID().slice(0, 8)}`
  const credentialId = await createCredential(context, projectId, credentialName)
  return { ...user, projectId, credentialId, credentialName }
}

/** Adds a second user to the owner's org as a project `viewer`, through PV's real invitation flow
 * (invite, read the queued accept URL, register with the invitation token, log in) and returns it. The
 * viewer's session lives in `viewerContext`. The invitation endpoint needs an MFA-enrolled inviter, so
 * the owner is enrolled first (the same precondition J2 sets up). */
export async function seedProjectViewer(
  ownerContext: BrowserContext,
  viewerContext: BrowserContext,
  projectId: string,
  label: string
): Promise<SeededUser> {
  await enrollMfaViaApi(ownerContext)
  const email = uniqueEmail(`mock-${label}`)
  await createInvitationViaApi(ownerContext, projectId, { email, role: 'viewer' })
  const token = extractTokenFromAcceptUrl(await readLatestInvitationAcceptUrl(email))
  const register = await viewerContext.request.post('/api/v1/auth/register', {
    data: { email, password: testPassword, invitationToken: token },
  })
  expect(register.ok(), `invited registration answered HTTP ${register.status()}`).toBeTruthy()
  const login = await viewerContext.request.post('/api/v1/auth/login', {
    data: { email, password: testPassword },
  })
  expect(login.ok(), `viewer login answered HTTP ${login.status()}`).toBeTruthy()
  const body = (await login.json()) as { data: { userId: string; orgId: string } }
  const onboarding = await viewerContext.request.post('/api/v1/users/me/onboarding', {
    data: { completed: true },
  })
  expect(onboarding.ok(), `viewer onboarding answered HTTP ${onboarding.status()}`).toBeTruthy()
  return { userId: body.data.userId, orgId: body.data.orgId, email }
}

/** An anonymous form POST to an injected action is redirected to /login before the action runs. */
export async function expectAnonymousLoginRedirect(
  request: APIRequestContext,
  path: string,
  origin: string
): Promise<void> {
  const response = await request.post(path, {
    form: { title: 'x' },
    headers: { origin },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(303)
  expect(response.headers()['location']).toBe('/login')
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
