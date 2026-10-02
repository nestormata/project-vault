import { randomUUID } from 'node:crypto'
import { expect, test, type BrowserContext } from '@playwright/test'
import { enrollMfaDirect } from '../fixtures/db.js'
import { gotoHydrated } from '../fixtures/hydration.js'
import {
  createIsolatedDatabase,
  initIsolatedVault,
  teardownIsolatedStack,
  type WebHandle,
} from '../fixtures/isolated-stack-shared.js'
import {
  restartCapabilityGateApi,
  startCapabilityGateApi,
  startCapabilityGateWeb,
  type ApiHandle,
} from '../fixtures/isolated-capability-gate-stack.js'
import { allocateFreePort } from '../fixtures/isolated-ports.js'

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

// Story 66.10: ports come from the OS allocator (assigned in beforeAll), never hardcoded.
let apiPort = 0
let webPort = 0
const DB_NAME = 'project_vault_j20_capgate_e2e'
const PASSWORD = 'j20-capability-gate-e2e-Password-1'
let baseUrl = ''
const CAPABILITY_DENIED_HELP =
  "Your organization's plan doesn't include public status pages. Contact your administrator to upgrade."

let apiHandle: ApiHandle
let webHandle: WebHandle

async function registerAndLogin(
  context: BrowserContext,
  label: string
): Promise<{ userId: string; orgId: string }> {
  const email = `j20-${label}-${randomUUID()}@example.test`
  const register = await context.request.post(`http://localhost:${apiPort}/api/v1/auth/register`, {
    data: { email, password: PASSWORD, orgName: `J20 ${label} Org ${randomUUID()}` },
  })
  expect(register.ok(), await register.text()).toBeTruthy()

  // Log in BEFORE enrolling MFA — enrolling first would make this login demand a TOTP challenge
  // this helper cannot answer (it only sets mfa_enrolled_at directly, it doesn't go through real
  // enrollment and so has no secret to generate a code from).
  const login = await context.request.post(`http://localhost:${apiPort}/api/v1/auth/login`, {
    data: { email, password: PASSWORD },
  })
  expect(login.ok(), await login.text()).toBeTruthy()
  // Story 1.20 (5a5959c1): self-signup now answers with the same generic "accepted" body for a new
  // and an already-registered email, so it no longer carries userId/orgId — the login response
  // does (the same recovery fixtures/auth.ts's registerAndLoginViaApi uses).
  const loginBody = (await login.json()) as { data: { userId: string; orgId: string } }

  await enrollMfaDirect(loginBody.data.userId, DB_NAME)

  return loginBody.data
}

test.describe
  .serial('J20 — capability-gate entitlement journey (Story 23.3, Priya persona)', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000)
    webPort = await allocateFreePort()
    baseUrl = `http://localhost:${webPort}`
    await createIsolatedDatabase(DB_NAME)
    apiHandle = await startCapabilityGateApi({
      dbName: DB_NAME,
      webPort: webPort,
      extensionPackage: '@project-vault/mock-capability-gate-extension',
    })
    apiPort = apiHandle.port
    await initIsolatedVault(apiPort, 'j20-capgate-e2e-passphrase')
    webHandle = await startCapabilityGateWeb({ port: webPort, apiPort: apiPort })
  })

  test.afterAll(async () => {
    await teardownIsolatedStack({ webHandle, apiHandle, dbName: DB_NAME })
  })

  test('the gate is genuinely registered (real boot, not a mock)', async ({ page }) => {
    const res = await page.request.get(`http://localhost:${apiPort}/status`)
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
      `http://localhost:${apiPort}/api/v1/projects`,
      {
        data: { name: 'J20 Project', slug: `j20-project-${Date.now()}` },
      }
    )
    expect(createProject.ok(), await createProject.text()).toBeTruthy()
    const project = (await createProject.json()) as { data: { id: string } }
    const projectId = project.data.id

    // --- Step 1: Priya opens the status page. Since Story 23-7 (#339, 02f6f55c) the control IS
    // pre-gated from the capability map: "Enable public status page" renders disabled, with PV's
    // own fallback copy wired as its accessible description (23-7's Priya persona journey, step
    // 1). The page is loaded hydration-armed so the assertions read the hydrated state.
    const enableButton = page.getByRole('button', { name: 'Enable public status page' })
    await gotoHydrated(page, `${baseUrl}/projects/${projectId}/status-page`, enableButton)
    await expect(page.getByRole('heading', { name: 'Public status page' })).toBeVisible()
    await expect(enableButton).toBeDisabled()
    await expect(enableButton).toHaveAccessibleDescription(CAPABILITY_DENIED_HELP)

    // The UI gate is cosmetic; Story 23.3's backend gate is the enforcement (23-7 step 3, AC-11).
    // Bypassing the UI must still get a real 403 carrying the extension's own message verbatim.
    const bypass = await context.request.post(
      `http://localhost:${apiPort}/api/v1/projects/${projectId}/status-page`,
      { data: {} }
    )
    expect(bypass.status(), await bypass.text()).toBe(403)
    const bypassBody = (await bypass.json()) as { code: string; message: string }
    expect(bypassBody.code).toBe('capability_denied')
    expect(bypassBody.message).toBe(
      'This fixture org is not entitled to publish a public status page.'
    )
    // No status page was actually created — the "enabled" state (a code/copy link) never appears,
    // and the raw extension message is never rendered by the UI (it shows PV's own copy).
    await page.reload()
    await expect(enableButton).toBeDisabled()
    await expect(page.locator('code')).toHaveCount(0)
    await expect(
      page.getByText('This fixture org is not entitled to publish a public status page.')
    ).toHaveCount(0)

    // --- Step 2: an org that never published has no token, so there is nothing meaningful to
    // check on the public route for THIS org — instead confirm the general "unknown token"
    // 404-collapse invariant this story adds no new distinguishable state to (AC-24).
    const unknownTokenRes = await page.request.get(
      `http://localhost:${apiPort}/api/v1/status-pages/${'deadbeef'.repeat(4)}`
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
    const unseal = await page.request.post(`http://localhost:${apiPort}/api/v1/vault/unseal`, {
      data: { kmsType: 'passphrase', passphrase: 'j20-capgate-e2e-passphrase' },
    })
    expect(unseal.ok(), await unseal.text()).toBeTruthy()

    const retryEnableButton = page.getByRole('button', { name: 'Enable public status page' })
    await gotoHydrated(page, `${baseUrl}/projects/${projectId}/status-page`, retryEnableButton)
    await expect(page.getByRole('heading', { name: 'Public status page' })).toBeVisible()
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
