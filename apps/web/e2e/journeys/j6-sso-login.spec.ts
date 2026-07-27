import postgres from 'postgres'
import { expect, test, type Browser, type BrowserContext, type APIResponse } from '@playwright/test'
import { superuserDatabaseUrl } from '../fixtures/db.js'
import { LoginPage } from '../pages/LoginPage.js'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'

// J6: authenticate via a registered external provider strategy (Story 14.3, AC-12) — plus, since
// Story 14.4, the actual login-screen UI path this file's header comment used to defer.
//
// Story 14.3 shipped no login-screen UI (this story, 14.4, owns that) — Story 14.4's own tests
// below close that gap by driving the real /login screen end-to-end via the mock SSO extension
// fixture, seeding an org_sso_domains row for a fixture domain. The remaining tests still drive
// /sso/start + /sso/callback directly via the browser context's request API (J2/J4's "UI is for
// validation only" convention) for backend-outcome coverage that doesn't need a browser page.
// It requires the API to be booted with its VAULT_EXTENSIONS_PACKAGE env var pointed at the mock
// extension's package name (see docker-compose.e2e.yml) and the three fixture identities' backing
// rows pre-seeded the same way apps/api/src/scripts/sso-qa.ts seeds them for manual QA.
//
// See fixtures/mock-sso-extension/README.md for the mock provider's fixture-identity table.

const PROVIDER = 'test.mock-sso-extension'
const LINKED_USER_CREDENTIAL = 'linked-user'
const ACCESS_TOKEN_COOKIE = 'access-token'
// Story 14.4: the domain the UI-driven tests below type into the login screen's email field —
// deliberately unrelated to any real seeded user's email (the domain only selects which
// provider's SSO step to show; the SSO credential typed in that step is what resolves the actual
// identity, exactly like the direct /sso/start+/callback tests above).
const SSO_MAPPED_DOMAIN = 'j6-sso-e2e-mapped-domain.test'

/**
 * Pre-seeds the two fixture identities' backing rows this journey needs — the mock extension
 * itself (fixtures/mock-sso-extension) only maps a credential string to a canned AuthResult; it
 * never touches the database. `unlinked-user` deliberately needs no seeding at all (its entire
 * point is "nothing exists yet"). Mirrors apps/api/src/scripts/sso-qa.ts's manual-QA seeding.
 */
async function seedSsoFixtures(): Promise<void> {
  const sql = postgres(superuserDatabaseUrl(), { max: 1 })
  try {
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, slug)
      values ('j6-sso-e2e-org', 'j6-sso-e2e-org')
      on conflict (slug) do update set name = excluded.name
      returning id
    `
    if (!org) throw new Error('j6-sso-login seed: failed to upsert organization')

    const [linkedUser] = await sql<{ id: string }[]>`
      insert into users (email, password_hash)
      values ('linked-user@example.test', 'x')
      on conflict (email) do update set email = excluded.email
      returning id
    `
    if (!linkedUser) throw new Error('j6-sso-login seed: failed to upsert linked-user')
    await sql`
      insert into external_identities (org_id, user_id, provider_name, external_subject)
      values (${org.id}, ${linkedUser.id}, ${PROVIDER}, 'fixture-subject-linked-user')
      on conflict (org_id, provider_name, external_subject) do nothing
    `
    // Pre-existing gap this story discovered while extending this file: handleLinkedSession()
    // (sso-routes.ts) rejects with account_link_required unless the linked user also has an
    // 'active' org_memberships row — an external_identities link alone is not sufficient. This
    // seed previously omitted it entirely, so the AC-5 test below (and this story's own new
    // AC-1 UI test) always 403'd regardless of Story 14.4's own changes.
    await sql`
      insert into org_memberships (org_id, user_id, role, status)
      values (${org.id}, ${linkedUser.id}, 'member', 'active')
      on conflict (org_id, user_id) do update set status = excluded.status
    `

    const [project] = await sql<{ id: string }[]>`
      insert into projects (org_id, name, slug)
      values (${org.id}, 'j6-sso-e2e-project', 'j6-sso-e2e-project')
      on conflict (org_id, slug) do update set name = excluded.name
      returning id
    `
    const [inviter] = await sql<{ id: string }[]>`
      insert into users (email, password_hash)
      values ('j6-sso-e2e-inviter@example.test', 'x')
      on conflict (email) do update set email = excluded.email
      returning id
    `
    if (!project || !inviter) throw new Error('j6-sso-login seed: failed invitation prerequisites')
    await sql`
      insert into project_invitations
        (org_id, project_id, email, role_to_assign, token_hash, invited_by, expires_at)
      values
        (${org.id}, ${project.id}, 'invited-user@example.test', 'member',
         'j6-sso-e2e-fixed-token-hash', ${inviter.id}, now() + interval '1 day')
      on conflict (token_hash) do nothing
    `

    // Story 14.4 Task 4.3: the row the login screen's domain-lookup endpoint resolves — maps
    // SSO_MAPPED_DOMAIN to this org's registered mock-extension provider, closing this file's own
    // header comment's previously-deferred "Story 14.4 owns that" gap.
    await sql`
      insert into org_sso_domains (org_id, domain, provider_name)
      values (${org.id}, ${SSO_MAPPED_DOMAIN}, ${PROVIDER})
      on conflict (domain) do update set org_id = excluded.org_id, provider_name = excluded.provider_name
    `
  } finally {
    await sql.end()
  }
}

/** Drives `/sso/start` then `/sso/callback` for the given fixture credential, in a fresh context. */
async function runSsoCallback(
  browser: Browser,
  credential: string
): Promise<{ context: BrowserContext; callback: APIResponse }> {
  const context = await browser.newContext()

  const start = await context.request.post(`/api/v1/auth/sso/start/${PROVIDER}`)
  expect(start.ok()).toBeTruthy()

  const callback = await context.request.post(`/api/v1/auth/sso/callback/${PROVIDER}`, {
    data: { credential },
  })

  return { context, callback }
}

/** Asserts the context ended up with a full session: access-token cookie set and `/auth/me` OK. */
async function expectFullSession(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies()
  expect(cookies.some((c) => c.name === ACCESS_TOKEN_COOKIE)).toBe(true)

  const me = await context.request.get('/api/v1/auth/me')
  expect(me.ok()).toBeTruthy()
}

test.describe('J6 — SSO login via a registered external provider strategy', () => {
  test.beforeAll(async () => {
    await seedSsoFixtures()
  })

  test('AC-5: linked-user fixture identity gets a full session (cookies set)', async ({
    browser,
  }) => {
    const { context, callback } = await runSsoCallback(browser, LINKED_USER_CREDENTIAL)
    expect(callback.ok(), await callback.text()).toBeTruthy()

    await expectFullSession(context)

    await context.close()
  })

  test('AC-7: unlinked-user fixture identity is rejected with account_link_required, no session', async ({
    browser,
  }) => {
    const { context, callback } = await runSsoCallback(browser, 'unlinked-user')
    expect(callback.status()).toBe(403)
    const body = (await callback.json()) as { code: string }
    expect(body.code).toBe('account_link_required')

    const cookies = await context.cookies()
    expect(cookies.some((c) => c.name === ACCESS_TOKEN_COOKIE)).toBe(false)

    await context.close()
  })

  test('AC-8: invited-user fixture identity auto-provisions via a pending invitation and gets a session', async ({
    browser,
  }) => {
    const { context, callback } = await runSsoCallback(browser, 'invited-user')
    expect(callback.ok(), await callback.text()).toBeTruthy()

    await expectFullSession(context)

    await context.close()
  })

  test('AC-11: an unregistered provider name gets a generic 404, no crash', async ({ browser }) => {
    const context = await browser.newContext()

    const callback = await context.request.post(
      '/api/v1/auth/sso/callback/not-a-registered-provider',
      { data: { credential: LINKED_USER_CREDENTIAL } }
    )
    expect(callback.status()).toBe(404)

    await context.close()
  })

  // Story 14.4: drives the actual /login screen end-to-end, closing the gap this file's own
  // header comment used to document as deferred to this story.
  test('Story 14.4 AC-1: an SSO-mapped email shows the SSO step (never a password field) and completes login', async ({
    page,
  }) => {
    const loginPage = new LoginPage(page)
    await loginPage.goto()

    await loginPage.fillAndContinueToSso(`alex@${SSO_MAPPED_DOMAIN}`)
    await expect(loginPage.passwordInput()).toHaveCount(0)

    await loginPage.submitSsoCredential(LINKED_USER_CREDENTIAL)

    await expect(page).toHaveURL(/\/dashboard/)
  })

  test('Story 14.4 AC-2: an email with no SSO mapping still renders the password field and local login proceeds normally', async ({
    browser,
  }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const email = uniqueEmail('j6-no-mapping')
    const password = 'e2e-No-Mapping-Password-123'
    await registerAndLoginViaApi(context, { email, password, orgName: uniqueOrgName('J6 Org') })
    // registerAndLoginViaApi already leaves this context authenticated — start a fresh,
    // unauthenticated page to actually exercise the login screen's Step A -> Step B(password)
    // path for this email, mirroring the "Morgan" persona in the story's journey stub.
    await context.clearCookies()

    const loginPage = new LoginPage(page)
    await loginPage.goto()
    await loginPage.fillAndSubmit({ email, password })

    await expect(page).toHaveURL(/\/dashboard/)

    await context.close()
  })
})
