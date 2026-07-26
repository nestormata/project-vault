import postgres from 'postgres'
import { expect, test } from '@playwright/test'
import { superuserDatabaseUrl } from '../fixtures/db.js'

// J6: authenticate via a registered external provider strategy (Story 14.3, AC-12).
//
// This story has no login-screen UI yet (Story 14.4 owns that) — the Product Surface Contract's
// honest-placeholder note applies: this journey drives the real, callable backend flow directly
// via the browser context's own request API (same convention J2/J4 already use for
// "UI is for validation only" scenarios), sharing the context's real cookie jar exactly as a
// browser session would. It requires the API to be booted with its VAULT_EXTENSIONS_PACKAGE env
// var pointed at the mock extension's package name (see docker-compose.e2e.yml) and the three
// fixture identities' backing rows pre-seeded the same way apps/api/src/scripts/sso-qa.ts seeds
// them for manual QA.
//
// See fixtures/mock-sso-extension/README.md for the mock provider's fixture-identity table.

const PROVIDER = 'test.mock-sso-extension'
const ACCESS_TOKEN_COOKIE = 'access-token'

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
  } finally {
    await sql.end()
  }
}

test.describe('J6 — SSO login via a registered external provider strategy', () => {
  test.beforeAll(async () => {
    await seedSsoFixtures()
  })

  test('AC-5: linked-user fixture identity gets a full session (cookies set)', async ({
    browser,
  }) => {
    const context = await browser.newContext()

    const start = await context.request.post(`/api/v1/auth/sso/start/${PROVIDER}`)
    expect(start.ok()).toBeTruthy()

    const callback = await context.request.post(`/api/v1/auth/sso/callback/${PROVIDER}`, {
      data: { credential: 'linked-user' },
    })
    expect(callback.ok(), await callback.text()).toBeTruthy()

    const cookies = await context.cookies()
    expect(cookies.some((c) => c.name === ACCESS_TOKEN_COOKIE)).toBe(true)

    const me = await context.request.get('/api/v1/auth/me')
    expect(me.ok()).toBeTruthy()

    await context.close()
  })

  test('AC-7: unlinked-user fixture identity is rejected with account_link_required, no session', async ({
    browser,
  }) => {
    const context = await browser.newContext()

    const start = await context.request.post(`/api/v1/auth/sso/start/${PROVIDER}`)
    expect(start.ok()).toBeTruthy()

    const callback = await context.request.post(`/api/v1/auth/sso/callback/${PROVIDER}`, {
      data: { credential: 'unlinked-user' },
    })
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
    const context = await browser.newContext()

    const start = await context.request.post(`/api/v1/auth/sso/start/${PROVIDER}`)
    expect(start.ok()).toBeTruthy()

    const callback = await context.request.post(`/api/v1/auth/sso/callback/${PROVIDER}`, {
      data: { credential: 'invited-user' },
    })
    expect(callback.ok(), await callback.text()).toBeTruthy()

    const cookies = await context.cookies()
    expect(cookies.some((c) => c.name === ACCESS_TOKEN_COOKIE)).toBe(true)

    const me = await context.request.get('/api/v1/auth/me')
    expect(me.ok()).toBeTruthy()

    await context.close()
  })

  test('AC-11: an unregistered provider name gets a generic 404, no crash', async ({ browser }) => {
    const context = await browser.newContext()

    const callback = await context.request.post(
      '/api/v1/auth/sso/callback/not-a-registered-provider',
      { data: { credential: 'linked-user' } }
    )
    expect(callback.status()).toBe(404)

    await context.close()
  })
})
