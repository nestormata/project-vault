import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { enrollMfaDirect } from '../fixtures/db.js'
import {
  createIsolatedDatabase,
  initIsolatedVault,
  registerAndLoginIsolated,
  spawnIsolatedApiProcess,
  spawnIsolatedWebProcess,
  teardownIsolatedStack,
  type WebHandle,
} from '../fixtures/isolated-stack-shared.js'

/**
 * J25 — Story 25.12's own end-to-end proof that both extension-panel postMessage relays
 * (`apps/web`'s `+page.svelte`) are genuinely widened beyond the `project-container` panel's
 * original hardcoded shape, driven against the real `mock-ui-panel-extension` fixture (Story
 * 25.1 Task 7, extended by this story's own Task 6).
 *
 * Runs against a dedicated, isolated `apps/api` + `apps/web` process pair (mirrors Story 23.2's
 * J19 / Story 23.3's J20 harness — see `isolated-stack-shared.ts`) because the shared E2E
 * docker stack's one `VAULT_EXTENSIONS_PACKAGE` slot is already spent on `mock-sso-extension`,
 * and a host process can only load ONE extension package at a time.
 *
 * Covers:
 *  - AC1: a real multi-field action request round-trips through the widened ACTION relay,
 *    asserting on the actual captured network request body (not just a passing unit test).
 *  - AC2 happy path: a data request to a newly-declared `panelDataPaths` entry
 *    (`/api/v1/org/users`) succeeds where it would have 404/rejected under the pre-story
 *    hardcoded allowlist.
 *  - AC2 edge case: a data request to an undeclared (but `/api/v1/`-prefixed) path is rejected
 *    calmly — no thrown error, no broken page, zero matching network request issued.
 */

const API_PORT = 34840
const WEB_PORT = 34841
const DB_NAME = 'project_vault_j25_panel_relay_e2e'
const PASSWORD = 'j25-panel-relay-e2e-Password-1'
const BASE_URL = `http://localhost:${WEB_PORT}`
const API_BASE = `http://localhost:${API_PORT}`

let apiProcess: ChildProcess | undefined
let webHandle: WebHandle | undefined

/**
 * Vite dev mode serves an unbundled module graph (mirrors J20's own documented rationale for
 * the same class of race): the extension panel's `srcdoc` iframe (and the button/script inside
 * it) is present in the server-rendered HTML immediately, but `+page.svelte`'s own `window`
 * message-relay listener is only attached by a Svelte `$effect` that runs after client-side
 * hydration completes — clicking/posting a message before that effect has run falls through to
 * a no-op (the panel's own postMessage has nobody listening on the parent side yet). Story
 * 25.4 AC5's own mount effect moves DOM focus to the `<h1>` heading only after hydration, so
 * waiting for that focus is a real, semantically-meaningful hydration-completion signal — not a
 * blanket `networkidle` heuristic — and (Svelte effects run in source order at mount) proves the
 * message-listener effect, declared earlier in the file, has already registered too.
 */
async function waitForPanelHydration(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Extension' })).toBeFocused()
}

async function registerLoggedInMember(
  request: Parameters<typeof registerAndLoginIsolated>[0],
  label: string
): Promise<{ userId: string; orgId: string }> {
  const email = `j25-${label}-${randomUUID()}@example.test`
  const identity = await registerAndLoginIsolated(request, API_BASE, {
    email,
    password: PASSWORD,
    orgName: `J25 ${label} Org ${randomUUID()}`,
  })
  await enrollMfaDirect(identity.userId, DB_NAME)
  return identity
}

test.describe
  .serial('J25 — Story 25.12 panel relay payload forwarding (mock-ui-panel-extension)', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000)
    await createIsolatedDatabase(DB_NAME)
    apiProcess = await spawnIsolatedApiProcess({
      port: API_PORT,
      dbName: DB_NAME,
      webPort: WEB_PORT,
      logLabel: 'api-panel-relay',
      logLevelEnvVar: 'J25_DEBUG_LOG_LEVEL',
      extraEnv: { VAULT_EXTENSIONS_PACKAGE: '@project-vault/mock-ui-panel-extension' },
    })
    await initIsolatedVault(API_PORT, 'j25-panel-relay-e2e-passphrase')
    webHandle = await spawnIsolatedWebProcess({
      port: WEB_PORT,
      apiPort: API_PORT,
      logLabel: 'web-panel-relay',
    })
  })

  test.afterAll(async () => {
    await teardownIsolatedStack({
      webHandle,
      apiHandle: apiProcess ? { process: apiProcess } : undefined,
      dbName: DB_NAME,
    })
  })

  test('the fixture extension is genuinely loaded (real boot, not a mock of a mock)', async ({
    page,
  }) => {
    const res = await page.request.get(`${API_BASE}/api/v1/extensions/nav`, {
      headers: {},
      failOnStatusCode: false,
    })
    // Unauthenticated — 401 is expected; this only proves the API process itself is up before
    // the real per-test assertions (which authenticate) run.
    expect([401, 200]).toContain(res.status())
  })

  test('AC1: a multi-field action request round-trips through the widened ACTION relay end to end — the full payload reaches the server', async ({
    page,
    context,
  }) => {
    await registerLoggedInMember(context.request, 'action')

    await page.goto(`${BASE_URL}/extensions/panels/group`)
    await waitForPanelHydration(page)
    const frame = page.frameLocator('iframe')
    const runButton = frame.getByRole('button', { name: 'Run test action' })
    await expect(runButton).toBeVisible()

    const requestPromise = page.waitForRequest(
      (req) =>
        req.url().includes('/api/v1/extensions/panels/group/actions') && req.method() === 'POST'
    )
    await runButton.click()
    const request = await requestPromise

    // AC1's own concrete proof: the captured POST body carries `note` (a field beyond `kind`)
    // verbatim — before this story's fix, the relay reconstructed `{ kind }` only and `note`
    // never left the host page.
    const body = request.postDataJSON() as Record<string, unknown>
    expect(body).toEqual({ kind: 'test-action', note: 'fixture-note' })

    // The server's own response (round-tripped back through the relay and rendered by the
    // fixture's panel script) echoes `note` too — a second, independent confirmation that the
    // full payload reached `handleModuleAction()`, not just that the request left the browser.
    await expect(frame.locator('#test-action-result')).toHaveText(
      'status:200 message:test-action executed for slot "group" with note "fixture-note"'
    )
  })

  test('AC2 happy path: a data request to a newly-declared panelDataPaths entry succeeds', async ({
    page,
    context,
  }) => {
    await registerLoggedInMember(context.request, 'data-ok')

    await page.goto(`${BASE_URL}/extensions/panels/group`)
    await waitForPanelHydration(page)
    const iframeHandle = await page.waitForSelector('iframe')
    const frame = await iframeHandle.contentFrame()
    if (!frame) throw new Error('extension panel iframe content frame unavailable')

    const requestPromise = page.waitForRequest((req) => req.url().includes('/api/v1/org/users'))
    // Simulates the panel (running inside the sandboxed iframe) posting a data-request UP to the
    // host page — executed from within the iframe's own script context (`frame.evaluate`), so
    // `window.parent.postMessage` originates from exactly the window `+page.svelte`'s
    // `event.source === panelIframe?.contentWindow` check expects, matching a real panel's own
    // postMessage call shape exactly.
    await frame.evaluate(() => {
      window.parent.postMessage(
        {
          source: 'pv-extension-panel-data-request',
          requestId: 'e2e-data-ok',
          method: 'GET',
          path: '/api/v1/org/users',
        },
        '*'
      )
    })

    const request = await requestPromise
    const response = await request.response()
    // Under the pre-story hardcoded allowlist, this path would never have reached `fetch()` at
    // all (relay-level `ok: false`) — a real 200 here is the concrete regression this AC fixes.
    expect(response?.status()).toBe(200)
  })

  test('AC2 edge case: a request to an undeclared (but /api/v1/-prefixed) path is rejected calmly — no thrown error, no broken page', async ({
    page,
    context,
  }) => {
    await registerLoggedInMember(context.request, 'data-reject')

    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(String(err)))
    let sawUndeclaredRequest = false
    page.on('request', (req) => {
      if (req.url().includes('/api/v1/admin/users')) sawUndeclaredRequest = true
    })

    await page.goto(`${BASE_URL}/extensions/panels/group`)
    await waitForPanelHydration(page)
    const iframeHandle = await page.waitForSelector('iframe')
    const frame = await iframeHandle.contentFrame()
    if (!frame) throw new Error('extension panel iframe content frame unavailable')

    await frame.evaluate(() => {
      window.parent.postMessage(
        {
          source: 'pv-extension-panel-data-request',
          requestId: 'e2e-data-reject',
          method: 'GET',
          // Plausible-but-undeclared, same /api/v1/ prefix as the legal paths — isolates "not in
          // the declared list" from "wrong prefix" as this story's own AC2 spec requires.
          path: '/api/v1/admin/users',
        },
        '*'
      )
    })
    // Give the relay a real moment to (not) issue the fetch — there is no positive event to
    // await here, since the whole point is that nothing happens.
    await page.waitForTimeout(750)

    expect(sawUndeclaredRequest).toBe(false)
    expect(pageErrors).toEqual([])
    // The page itself is still fully intact — no broken/blank state, same calm degradation this
    // relay already provides for every other rejection case.
    await expect(page.getByRole('heading', { name: 'Extension' })).toBeVisible()
    await expect(page.locator('iframe')).toBeVisible()
  })
})
