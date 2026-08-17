import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { expect, test, type BrowserContext } from '@playwright/test'
import { superuserDatabaseUrl } from '../fixtures/db.js'
import {
  createIsolatedDatabase,
  initIsolatedVault,
  teardownIsolatedStack,
} from '../fixtures/isolated-stack-shared.js'
import {
  restartCapabilityGateApi,
  startCapabilityGateApi,
  startCapabilityGateWeb,
  type ApiHandle,
  type WebHandle,
} from '../fixtures/isolated-capability-gate-stack.js'

/**
 * J20 — Story 23.3's own end-to-end proof of the capability-entitlement gate, covering the
 * Priya-orgadmin persona journey from the story's Product Surface Contract: CentralizeMe-hosted
 * instance, restricted plan, `mock-capability-gate-extension` loaded. Runs against a dedicated,
 * isolated apps/api + apps/web process pair (mirrors Story 23.2's J19 harness — see
 * `isolated-capability-gate-stack.ts`'s header comment) because the shared E2E stack's one
 * `VAULT_EXTENSIONS_PACKAGE` slot is already spent on `mock-sso-extension`.
 *
 * Dana-orgadmin's "no gate configured" journey is covered separately in
 * `j20-capability-gate-not-configured.spec.ts`, which reuses the SHARED E2E stack (that stack's
 * loaded manifest never declares `capability-gate`, so it already IS Dana's exact scenario — no
 * dedicated infra needed for that half).
 *
 * Login/registration are driven via `context.request` (real HTTP against the real routes, but
 * not through the login FORM) — this journey's subject under test is the capability-gate denial
 * UI, not the login screen (already covered elsewhere), matching this suite's own
 * "UI is for validation only, not setup" convention (`fixtures/auth.ts`).
 */

const API_PORT = 34820
const WEB_PORT = 34821
const DB_NAME = 'project_vault_j20_capgate_e2e'
const PASSWORD = 'j20-capability-gate-e2e-Password-1'
const BASE_URL = `http://localhost:${WEB_PORT}`

let apiHandle: ApiHandle
let webHandle: WebHandle

async function enrollMfa(userId: string): Promise<void> {
  const dbUrl = superuserDatabaseUrl().replace(/\/[^/]+$/, `/${DB_NAME}`)
  const sql = postgres(dbUrl, { max: 1 })
  try {
    await sql`update users set mfa_enrolled_at = now() where id = ${userId}`
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function registerAndLogin(
  context: BrowserContext,
  label: string
): Promise<{ userId: string; orgId: string }> {
  const email = `j20-${label}-${randomUUID()}@example.test`
  const register = await context.request.post(`http://localhost:${API_PORT}/api/v1/auth/register`, {
    data: { email, password: PASSWORD, orgName: `J20 ${label} Org ${randomUUID()}` },
  })
  expect(register.ok(), await register.text()).toBeTruthy()
  const registerBody = (await register.json()) as { data: { userId: string; orgId: string } }

  // Log in BEFORE enrolling MFA — enrolling first would make this login demand a TOTP challenge
  // this helper cannot answer (it only sets mfa_enrolled_at directly, it doesn't go through real
  // enrollment and so has no secret to generate a code from).
  const login = await context.request.post(`http://localhost:${API_PORT}/api/v1/auth/login`, {
    data: { email, password: PASSWORD },
  })
  expect(login.ok(), await login.text()).toBeTruthy()

  await enrollMfa(registerBody.data.userId)

  return registerBody.data
}

test.describe
  .serial('J20 — capability-gate entitlement journey (Story 23.3, Priya persona)', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000)
    await createIsolatedDatabase(DB_NAME)
    apiHandle = await startCapabilityGateApi({
      port: API_PORT,
      dbName: DB_NAME,
      webPort: WEB_PORT,
      extensionPackage: '@project-vault/mock-capability-gate-extension',
    })
    await initIsolatedVault(API_PORT, 'j20-capgate-e2e-passphrase')
    webHandle = await startCapabilityGateWeb({ port: WEB_PORT, apiPort: API_PORT })
  })

  test.afterAll(async () => {
    await teardownIsolatedStack({ webHandle, apiHandle, dbName: DB_NAME })
  })

  test('the gate is genuinely registered (real boot, not a mock)', async ({ page }) => {
    const res = await page.request.get(`http://localhost:${API_PORT}/status`)
    const body = (await res.json()) as { capabilityGate?: { gate: { name: string } | null } }
    expect(body.capabilityGate?.gate).toEqual({ name: 'test.mock-capability-gate-extension' })
  })

  test('AC-23/AC-24: publish is denied with the extension message escaped, public page collapses to 404, and retry succeeds after simulated upgrade', async ({
    page,
    context,
  }) => {
    const owner = await registerAndLogin(context, 'priya')

    // Create a project via the API (setup, not the subject under test).
    const createProject = await context.request.post(
      `http://localhost:${API_PORT}/api/v1/projects`,
      {
        data: { name: 'J20 Project', slug: `j20-project-${Date.now()}` },
      }
    )
    expect(createProject.ok(), await createProject.text()).toBeTruthy()
    const project = (await createProject.json()) as { data: { id: string } }
    const projectId = project.data.id

    // --- Step 1: Priya clicks Publish. The control is NOT pre-gated (renders exactly as today —
    // the story's own persona-journey text) — this real 403 IS the enforcement.
    await page.goto(`${BASE_URL}/projects/${projectId}/status-page`)
    await expect(page.getByRole('heading', { name: 'Public status page' })).toBeVisible()
    // Vite dev mode serves an unbundled module graph — a web-first assertion on the button itself
    // (rather than a blanket networkidle heuristic, matching J19's own documented rationale for
    // the same class of race) is what actually waits for hydration to attach the click handler;
    // clicking too early falls through to a no-op.
    const enableButton = page.getByRole('button', { name: 'Enable public status page' })
    await expect(enableButton).toBeEnabled()
    await enableButton.click()

    // The extension's own message ("This fixture org is not entitled to publish a public status
    // page.") must render verbatim as ESCAPED PLAIN TEXT — Svelte's default `{expr}` interpolation
    // does this automatically; asserting the text is visible (not raw HTML executing) is the
    // behavioral proof available from the DOM.
    await expect(
      page.getByText('This fixture org is not entitled to publish a public status page.')
    ).toBeVisible()
    // No status page was actually created — the "enabled" state (a code/copy link) never appears.
    await expect(page.locator('code')).toHaveCount(0)

    // --- Step 2: an org that never published has no token, so there is nothing meaningful to
    // check on the public route for THIS org — instead confirm the general "unknown token"
    // 404-collapse invariant this story adds no new distinguishable state to (AC-24).
    const unknownTokenRes = await page.request.get(
      `http://localhost:${API_PORT}/api/v1/status-pages/${'deadbeef'.repeat(4)}`
    )
    expect(unknownTokenRes.status()).toBe(404)

    // --- Step 3: Priya's org is "upgraded" in CM's identity/billing app. This journey's fixture
    // has no live network entitlement source to flip, so the upgrade is simulated the same way
    // Story 23.2's J19 simulates a policy change: restart the API process (an operator's real,
    // deliberate action), this time with `extraPermittedOrgId` set to Priya's real org id — the
    // fixture's `MOCK_CAPABILITY_GATE_EXTRA_PERMITTED_ORG_ID` escape hatch reads it at import
    // time. PV itself caches nothing (AC-16): the very next gate check after this restart reflects
    // the new decision — no DB migration, no PV-side flag flip, nothing but the extension's own
    // entitlement source (here, this restart) changing.
    apiHandle = await restartCapabilityGateApi(apiHandle, { extraPermittedOrgId: owner.orgId })

    // Vault master-key material is derived in-process, not persisted (same as J19) — a restart
    // genuinely re-seals the vault regardless of the capability gate, an orthogonal pre-existing
    // vault architecture concern this journey is not testing. Unseal exactly like a real operator
    // would after any restart.
    const unseal = await page.request.post(`http://localhost:${API_PORT}/api/v1/vault/unseal`, {
      data: { kmsType: 'passphrase', passphrase: 'j20-capgate-e2e-passphrase' },
    })
    expect(unseal.ok(), await unseal.text()).toBeTruthy()

    await page.goto(`${BASE_URL}/projects/${projectId}/status-page`)
    await expect(page.getByRole('heading', { name: 'Public status page' })).toBeVisible()
    const retryEnableButton = page.getByRole('button', { name: 'Enable public status page' })
    await expect(retryEnableButton).toBeEnabled()
    await retryEnableButton.click()

    const urlLocator = page.locator('code')
    await expect(urlLocator).toHaveText(/^https?:\/\/.+\/status\/.{10,}$/)
    const publishedUrl = await urlLocator.textContent()
    expect(publishedUrl, 'shareable URL must be revealed once permitted').toBeTruthy()

    // The public page now serves 200 for the newly-published token.
    if (publishedUrl) {
      const publicRes = await page.request.get(publishedUrl)
      expect(publicRes.status()).toBe(200)
    }
  })
})
