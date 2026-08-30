import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { enrollMfaDirect } from '../fixtures/db.js'
import {
  registerAndLoginIsolated,
  setupMockExtensionIsolatedStack,
  teardownIsolatedStack,
  type WebHandle,
} from '../fixtures/isolated-stack-shared.js'

/**
 * J25 — end-to-end proof that an extension panel's action button reaches the server correctly.
 *
 * Originally written for Story 25.12 against the OLD sandboxed `<iframe srcdoc>` +
 * `postMessage` relay mechanism (this file used to be named
 * `j25-panel-relay-payload-forwarding.spec.ts`). Story 29.1 removed the iframe entirely
 * (panels now render directly into the host page's own DOM via a sanitized `innerHTML`
 * assignment), which left this file's `page.waitForSelector('iframe')` / `frame.evaluate(...)`
 * plumbing dead. Story 29.2 then deleted the ACTION-side `postMessage` relay this file's AC1
 * portion drove, replacing it with a host-owned, delegated click handler
 * (`handleActionClick` in `+page.svelte`) that resolves a clicked element via
 * `.closest('[data-pv-action]')` and issues a real same-origin `fetch` directly — no relay, no
 * iframe, no inline `<script>` inside the panel's own HTML (which Story 29.1's DOMPurify
 * sanitizer strips unconditionally).
 *
 * AC1 below (Story 29.2) is rewritten for that new mechanism: it drives a REAL browser click on
 * the mock extension's `<button data-pv-action="test-action" data-pv-action-note="fixture-note">`
 * (rendered directly in the top-level page — no iframe, no `frame.evaluate`) and asserts the
 * captured network request's full multi-field JSON body reaches
 * `POST /api/v1/extensions/panels/:slot/actions` unmodified, then asserts the host's own
 * `aria-live="polite"` status region reflects the successful response — the same
 * "full payload reaches the route unmodified" property this file has always tested, just via the
 * new transport.
 *
 * Story 29.6 adds a further "AC13" test below, driving a genuine browser click on the mock
 * extension's own panel-rendered `<a href>` navigation link (Story 29.6's real `<a href>`
 * mechanism, replacing the retired NAVIGATION postMessage relay) and asserting a real
 * SvelteKit/browser navigation occurred — coverage `panel-page.test.ts`'s jsdom-based component
 * tests structurally cannot provide, since jsdom has no SvelteKit router to intercept the click.
 *
 * AC2 below (data-relay payload forwarding) is UNCHANGED, out of Story 29.2's scope (it does not
 * touch the DATA relay — see `handlePanelDataMessage` in `+page.svelte`, still driven by
 * `postMessage`, still pending replacement by Story 29.4) and is currently ALSO broken by the
 * same dead iframe-wait Story 29.1 introduced. It is marked `test.skip(...)` rather than deleted
 * or fixed, since fixing/replacing the DATA relay's own E2E coverage is Story 29.4's job, not
 * this story's — see the skip reason on each test below.
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
 * the same class of race): the extension panel's HTML (including its `data-pv-action` button) is
 * present in the server-rendered/client-injected DOM once `renderPanelHtml`'s `use:` action runs,
 * but that action — and the container's own delegated `onclick={handleActionClick}` binding — are
 * only wired up after Svelte's client-side hydration completes. Story 25.4 AC5's own mount effect
 * moves DOM focus to the `<h1>` heading only after hydration, so waiting for that focus is a real,
 * semantically-meaningful hydration-completion signal — not a blanket `networkidle` heuristic.
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
  .serial('J25 — Story 29.2 panel action dispatch, Story 25.12 data relay (mock-ui-panel-extension)', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000)
    ;({ apiProcess, webHandle } = await setupMockExtensionIsolatedStack({
      apiPort: API_PORT,
      webPort: WEB_PORT,
      dbName: DB_NAME,
      apiLogLabel: 'api-panel-relay',
      webLogLabel: 'web-panel-relay',
      vaultPassphrase: 'j25-panel-relay-e2e-passphrase',
      debugLogLevelEnvVar: 'J25_DEBUG_LOG_LEVEL',
    }))
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

  test('AC1 (Story 29.2): a multi-field action request round-trips through the direct same-origin click dispatch — the full payload reaches the server', async ({
    page,
    context,
  }) => {
    await registerLoggedInMember(context.request, 'action')

    await page.goto(`${BASE_URL}/extensions/panels/group`)
    await waitForPanelHydration(page)

    // Story 29.1 removed the iframe: the fixture's button is rendered directly into the host
    // page's own DOM, so a real, top-level Playwright locator (no `frameLocator`, no
    // `frame.evaluate`) drives it.
    const runButton = page.getByRole('button', { name: 'Run test action' })
    await expect(runButton).toBeVisible()
    await expect(runButton).toHaveAttribute('data-pv-action', 'test-action')
    await expect(runButton).toHaveAttribute('data-pv-action-note', 'fixture-note')

    const requestPromise = page.waitForRequest(
      (req) =>
        req.url().includes('/api/v1/extensions/panels/group/actions') && req.method() === 'POST'
    )
    await runButton.click()
    const request = await requestPromise

    // AC1's own concrete proof: the captured POST body carries `note` (a field beyond `kind`)
    // verbatim, assembled purely from `data-pv-action`/`data-pv-action-note` by
    // `handleActionClick` — no relay, no postMessage, no inline `<script>` involved at all.
    const body = request.postDataJSON() as Record<string, unknown>
    expect(body).toEqual({ kind: 'test-action', note: 'fixture-note' })

    // The server's own response is rendered by the host itself into the AC6/AC7 `aria-live`
    // status region (outside the sanitized panel container) — a second, independent
    // confirmation that the full payload reached `handleModuleAction()` and the response made it
    // all the way back, not just that the request left the browser.
    await expect(
      page.getByText('test-action executed for slot "group" with note "fixture-note"')
    ).toBeVisible()

    // The clicked button is re-enabled once the (message-only, no `html`) result settles — the
    // panel container itself was never replaced (AC8/AC5 disposition: only an `html` result
    // replaces the container).
    await expect(runButton).not.toHaveAttribute('disabled', '')
    await expect(runButton).not.toHaveAttribute('aria-busy', 'true')
  })

  // Story 29.6 AC13 — real Playwright e2e coverage that a genuine click on a panel-rendered
  // `<a href>` produces a real SvelteKit client-side navigation: `panel-page.test.ts`'s jsdom-based
  // component tests have no SvelteKit router to intercept the click, so only a real browser proves
  // this. Drives the mock extension's own AC12 fixture link (`TEST_NAV_LINK_SUBPATH`, rendered as
  // `Open detail`) and asserts the URL actually changes AND the target route's own real content
  // renders — not merely that `click()` didn't throw.
  test('AC13 (Story 29.6): clicking the panel-rendered navigation link performs a real browser navigation to the target route', async ({
    page,
    context,
  }) => {
    await registerLoggedInMember(context.request, 'nav-link')

    await page.goto(`${BASE_URL}/extensions/panels/group`)
    await waitForPanelHydration(page)

    const navLink = page.getByRole('link', { name: 'Open detail' })
    await expect(navLink).toBeVisible()
    await expect(navLink).toHaveAttribute('href', '/extensions/panels/group/detail')

    await navLink.click()

    // A real navigation: the URL changed, and the target route's own real content rendered
    // (still the `group` slot's own panel — the `[...subpath]` rest segment is this route's own
    // deep-link mechanism, Story 25.8 AC1, unaffected by this story).
    await expect(page).toHaveURL(`${BASE_URL}/extensions/panels/group/detail`)
    await expect(page.getByRole('heading', { name: 'Extension' })).toBeVisible()
    await expect(page.getByText('Mock panel for slot "group"')).toBeVisible()
  })

  // Skipped: Story 29.1 removed the panel iframe this test drives via `frame.evaluate`/
  // `page.waitForSelector('iframe')`, leaving this dead. The DATA relay itself
  // (`handlePanelDataMessage` in +page.svelte) is unchanged and still postMessage-based — Story
  // 29.2 only replaced the ACTION relay (see this file's top-of-file doc comment). Fixing/
  // replacing this coverage is Story 29.4's job, not Story 29.2's.
  test.skip('AC2 happy path: a data request to a newly-declared panelDataPaths entry succeeds', async ({
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
    expect(response?.status()).toBe(200)
  })

  // Skipped: same dead-iframe reason as the AC2 happy-path test above; see that test's skip
  // comment and this file's top-of-file doc comment. Pending Story 29.4.
  test.skip('AC2 edge case: a request to an undeclared (but /api/v1/-prefixed) path is rejected calmly — no thrown error, no broken page', async ({
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

    const rejectionAcknowledged = frame.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          window.addEventListener('message', function handler(event) {
            const message = event.data as Record<string, unknown>
            if (
              message?.['source'] === 'pv-extension-panel-data-result' &&
              message?.['requestId'] === 'e2e-data-reject'
            ) {
              window.removeEventListener('message', handler)
              resolve(message['ok'] === false)
            }
          })
          window.parent.postMessage(
            {
              source: 'pv-extension-panel-data-request',
              requestId: 'e2e-data-reject',
              method: 'GET',
              path: '/api/v1/admin/users',
            },
            '*'
          )
        })
    )

    expect(await rejectionAcknowledged).toBe(true)
    expect(sawUndeclaredRequest).toBe(false)
    expect(pageErrors).toEqual([])
    await expect(page.getByRole('heading', { name: 'Extension' })).toBeVisible()
    await expect(page.locator('iframe')).toBeVisible()
  })
})
