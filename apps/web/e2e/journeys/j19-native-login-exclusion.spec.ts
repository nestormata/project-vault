import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { test, expect } from '@playwright/test'
import { LoginPage } from '../pages/LoginPage.js'
import { superuserDatabaseUrl } from '../fixtures/db.js'
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  restartEnvelopeApi,
  startEnvelopeApi,
  startEnvelopeWeb,
  stopProcess,
  type ApiHandle,
  type WebHandle,
} from '../fixtures/isolated-envelope-stack.js'

/**
 * J19 — Story 23.2's own end-to-end proof of native-login exclusion (AC-6/AC-6a/AC-13/AC-14/
 * AC-16). Runs against a dedicated, isolated apps/api + apps/web process pair (see
 * fixtures/isolated-envelope-stack.ts's header comment for why this cannot share the main E2E
 * stack j1-j18/j6 run against) so this journey can genuinely restart the API process — the one
 * thing AC-4's "resolved once at boot, applied only at the next restart" design actually needs
 * proven, not simulated.
 *
 * This is real Chromium, driven by Playwright, against a real running app — not a mock or a
 * component-level render. `fullyParallel: false`/`workers: 1` (playwright.config.ts) still
 * applies; this file additionally serializes its own three tests with `test.describe.serial`
 * since each depends on the previous one's process/database state.
 */

const AUDIENCE = 'j19-envelope-e2e'
const API_PORT = 34719
const WEB_PORT = 34720
const DB_NAME = 'project_vault_j19_envelope_e2e'
const PROVIDER = 'test.mock-envelope-extension'
const NO_MAPPING_EMAIL = 'someone@example.test'

let apiHandle: ApiHandle
let webHandle: WebHandle

async function seedLinkedIdentity(): Promise<{
  orgId: string
  userId: string
  externalSubject: string
}> {
  // Superuser connection, matching j6-sso-login.spec.ts's own seedSsoFixtures() precedent —
  // org_sso_domains/org_memberships etc. are RLS-protected and a plain vault_app connection with
  // no app.current_org_id session GUC set gets rejected outright, not merely filtered to zero
  // rows (confirmed empirically while building this harness). superuserDatabaseUrl() targets the
  // MAIN e2e database by name; swap in this journey's own isolated database name.
  const dbUrl = superuserDatabaseUrl().replace(/\/[^/]+$/, `/${DB_NAME}`)
  const sql = postgres(dbUrl, { max: 1 })
  const externalSubject = `j19-subject-${randomUUID()}`
  try {
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values ('j19-envelope-org', 'j19-envelope-org')
      on conflict (slug) do update set name = excluded.name
      returning id
    `
    if (!org) throw new Error('j19 seed: failed to upsert organization')

    const [user] = await sql<{ id: string }[]>`
      insert into users (email, password_hash)
      values ('j19-linked-user@example.test', 'x')
      on conflict (email) do update set email = excluded.email
      returning id
    `
    if (!user) throw new Error('j19 seed: failed to upsert user')

    await sql`
      insert into org_memberships (org_id, user_id, role, status)
      values (${org.id}, ${user.id}, 'member', 'active')
      on conflict (org_id, user_id) do update set status = excluded.status
    `
    await sql`
      insert into external_identities (org_id, user_id, provider_name, external_subject)
      values (${org.id}, ${user.id}, ${PROVIDER}, ${externalSubject})
      on conflict (org_id, provider_name, external_subject) do nothing
    `
    return { orgId: org.id, userId: user.id, externalSubject }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** Signs a fixture envelope via the isolated API's own dependency — imported directly since this
 * spec runs in the same Node process as the test runner (not inside the spawned API process). */
async function signEnvelope(externalSubject: string): Promise<string> {
  const { signFixtureEnvelope } = await import('@project-vault/mock-envelope-extension')
  return signFixtureEnvelope({ sub: externalSubject, aud: AUDIENCE })
}

test.describe.serial('J19 — native-login exclusion end-to-end (Story 23.2)', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000)
    await createIsolatedDatabase(DB_NAME)
    apiHandle = await startEnvelopeApi({
      port: API_PORT,
      dbName: DB_NAME,
      envAudience: AUDIENCE,
      webPort: WEB_PORT,
    })
    // POST /api/v1/vault/init is vault-guard-allowlisted (unlike the SSO start/callback routes
    // this journey needs), and VAULT_ALLOW_REMOTE_INIT=true (set by startEnvelopeApi) permits
    // calling it without a bootstrap token — mirrors global-setup.ts's own initVault() exactly.
    const init = await fetch(`http://localhost:${API_PORT}/api/v1/vault/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kmsType: 'passphrase', passphrase: 'j19-envelope-e2e-passphrase' }),
    })
    if (!init.ok && init.status !== 409) {
      throw new Error(`vault/init failed (${init.status}): ${await init.text()}`)
    }
    webHandle = await startEnvelopeWeb({ port: WEB_PORT, apiPort: API_PORT })
  })

  test.afterAll(async () => {
    if (webHandle) await stopProcess(webHandle.process)
    if (apiHandle) await stopProcess(apiHandle.process)
    await dropIsolatedDatabase(DB_NAME)
  })

  test('AC-4a: declared-but-unproven — the extension is loaded but has never authenticated anyone, so the password form still renders', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${WEB_PORT}/login`)
    // Vite dev mode serves an unbundled module graph (200+ requests) — wait for it to settle so
    // SvelteKit has actually hydrated (attached the form's onsubmit handler) before interacting;
    // clicking too early falls through to a native, unhandled form GET-submit/reload.
    await page.waitForLoadState('networkidle')
    const loginPage = new LoginPage(page)
    await loginPage.emailInput().fill(NO_MAPPING_EMAIL)
    await loginPage.continueButton().click()

    // No SSO mapping for this domain and the policy is still 'enabled' (replacementProven is
    // false) — the password field renders exactly as it would with no extension at all.
    await expect(loginPage.passwordInput()).toBeVisible()

    const health = await page.request.get(`http://localhost:${API_PORT}/health`)
    const healthBody = (await health.json()) as {
      nativeLoginEnabled: boolean
      extensions_status: string
    }
    expect(healthBody.extensions_status).toBe('loaded')
    expect(healthBody.nativeLoginEnabled).toBe(true)
  })

  test('AC-4/AC-4a/N3: one successful SSO login writes the latch, but THIS process keeps the password form (no mid-process flip)', async ({
    page,
  }) => {
    const { externalSubject } = await seedLinkedIdentity()
    const credential = await signEnvelope(externalSubject)

    // Drive the real SSO start -> callback exchange through the running app, not a mock.
    const start = await page.request.post(
      `http://localhost:${API_PORT}/api/v1/auth/sso/start/${PROVIDER}`
    )
    expect(start.ok()).toBeTruthy()
    const callback = await page.request.post(
      `http://localhost:${API_PORT}/api/v1/auth/sso/callback/${PROVIDER}`,
      { data: { credential } }
    )
    expect(callback.ok(), await callback.text()).toBeTruthy()

    // The SSO callback issued a real session cookie, scoped to the host "localhost" (cookies are
    // not port-scoped) — clear it so re-navigating to /login exercises the unauthenticated
    // screen this test actually cares about, rather than the app's (correct, separate) "already
    // signed in, redirect away from /login" behavior.
    await page.context().clearCookies()

    // Same still-running process: the latch was just written, but AC-4 says it is applied only
    // at the NEXT boot — re-navigating to /login in this process must still show the password
    // form.
    await page.goto(`http://localhost:${WEB_PORT}/login`)
    // Vite dev mode serves an unbundled module graph (200+ requests) — wait for it to settle so
    // SvelteKit has actually hydrated (attached the form's onsubmit handler) before interacting;
    // clicking too early falls through to a native, unhandled form GET-submit/reload.
    await page.waitForLoadState('networkidle')
    const loginPage = new LoginPage(page)
    await loginPage.emailInput().fill('someone-else@example.test')
    await loginPage.continueButton().click()
    await expect(loginPage.passwordInput()).toBeVisible()
  })

  test('AC-4/AC-13: after restarting the API process, the login screen is SSO-only and POST /login 403s', async ({
    page,
  }) => {
    apiHandle = await restartEnvelopeApi(apiHandle)

    // Vault master-key material is derived in-process, not persisted — a restart genuinely
    // re-seals the vault regardless of native-login policy (an orthogonal, pre-existing vault
    // architecture concern this journey is not testing). The web app's own layout redirects a
    // sealed instance away from /login to /vault; unseal exactly like a real operator would
    // after any restart, so this journey can reach the login screen it actually cares about.
    const unseal = await page.request.post(`http://localhost:${API_PORT}/api/v1/vault/unseal`, {
      data: { kmsType: 'passphrase', passphrase: 'j19-envelope-e2e-passphrase' },
    })
    expect(unseal.ok(), await unseal.text()).toBeTruthy()

    const health = await page.request.get(`http://localhost:${API_PORT}/health`)
    const healthBody = (await health.json()) as { nativeLoginEnabled: boolean }
    expect(healthBody.nativeLoginEnabled).toBe(false)

    // Real Chrome, fresh navigation against the restarted process.
    await page.goto(`http://localhost:${WEB_PORT}/login`)
    // Vite dev mode serves an unbundled module graph (200+ requests) — wait for it to settle so
    // SvelteKit has actually hydrated (attached the form's onsubmit handler) before interacting;
    // clicking too early falls through to a native, unhandled form GET-submit/reload.
    await page.waitForLoadState('networkidle')
    // AC-13: Register/Recovery links are gone from the page immediately (nativeLoginEnabled is
    // resolved server-side, before the user does anything) — the SSO-only/honest-placeholder
    // state itself is Step B, reached only after Step A's email + Continue (this email's domain
    // has no org_sso_domains mapping, so it resolves to the honest placeholder, not an SSO step).
    await expect(page.getByRole('link', { name: /register/i })).toHaveCount(0)
    const loginPage = new LoginPage(page)
    await loginPage.emailInput().fill(NO_MAPPING_EMAIL)
    await loginPage.continueButton().click()
    await expect(page.getByText(/external sign-in required/i)).toBeVisible()
    await expect(page.getByLabel('Password')).toHaveCount(0)

    // Defense-in-depth: the route itself refuses, independent of what the UI renders.
    const loginAttempt = await page.request.post(`http://localhost:${API_PORT}/api/v1/auth/login`, {
      data: { email: NO_MAPPING_EMAIL, password: 'whatever-password-1' },
    })
    expect(loginAttempt.status()).toBe(403)
    const body = (await loginAttempt.json()) as { code: string }
    expect(body.code).toBe('native_login_disabled')
  })

  test('AC-6a: the bootstrap carve-out is closed too — a second-ever registration attempt is refused', async ({
    page,
  }) => {
    // This isolated database already has users from the seeding above, so isFirstUser is false
    // — the real production code path (registerUser()'s own isFirstUser check), not a fixture.
    const register = await page.request.post(`http://localhost:${API_PORT}/api/v1/auth/register`, {
      data: {
        email: `j19-late-${randomUUID()}@example.test`,
        password: 'CorrectHorseBattery9!',
        orgName: `j19 late org ${randomUUID()}`,
      },
    })
    expect(register.status()).toBe(403)
    const body = (await register.json()) as { code: string }
    expect(body.code).toBe('native_login_disabled')
  })
})
