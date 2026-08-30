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
 * The old `postMessage`-based DATA relay (`handlePanelDataMessage` in `+page.svelte`) that this
 * file's AC2 tests used to drive is now fully removed — Story 29.4 replaced it outright with
 * `moduleDataRoutes()`, a direct, manifest-declared `GET /api/v1/extensions/data/:path` mount (no
 * relay, no postMessage, no iframe involved at all). Story 30.3 adds real e2e coverage for that
 * replacement mechanism below (`GET /api/v1/extensions/data/fixture-echo`, the mock fixture's own
 * `TEST_MODULE_DATA_PATH`), mirroring this file's existing AC1 division of labor: fast API-level
 * coverage already lives in `apps/api/src/extensions/module-data-routes.test.ts`, so this e2e
 * addition is deliberately narrow — happy path plus one 404 — proving the same contract holds
 * through the real browser/login/HTTP path that `fastify.inject()` cannot exercise.
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

  // Story 30.3 AC5 — real e2e coverage for `moduleDataRoutes()`, the Story 29.4 mechanism that
  // replaced the old postMessage DATA relay outright. `TEST_MODULE_DATA_PATH` is not currently
  // importable from `apps/web/e2e` (the `@project-vault/mock-ui-panel-extension` fixture package
  // is not a dependency of `apps/web`), so the literal path is hardcoded here — cross-referenced
  // against its source of truth: `fixtures/mock-ui-panel-extension/src/index.ts`'s
  // `TEST_MODULE_DATA_PATH` export (`'/fixture-echo'`).
  test("AC5 (Story 30.3) happy path: GET /api/v1/extensions/data/fixture-echo reaches the real moduleDataRoutes handler and echoes the registered member's own orgId/userId", async ({
    context,
  }) => {
    const { userId, orgId } = await registerLoggedInMember(context.request, 'module-data-ok')

    // Authenticated via the shared browser context's own session cookie (set by
    // `registerAndLoginIsolated` above) — mirrors this file's existing `page.request.get(...)`
    // pattern in the "fixture extension is genuinely loaded" test, just via `context.request`
    // since no page navigation is needed for this assertion.
    const res = await context.request.get(`${API_BASE}/api/v1/extensions/data/fixture-echo`, {
      failOnStatusCode: false,
    })

    expect(res.status()).toBe(200)
    // Proves the route is reachable through the real HTTP path (not a mocked handler) and that
    // `buildModuleDataRequestContext()` resolves genuine per-request identity — this registered
    // member's own orgId/userId — not a shared or memoized value.
    expect(await res.json()).toEqual({ ok: true, orgId, userId })
  })

  // Story 30.3 AC5 — an undeclared moduleData path is an ordinary Fastify 404, not a `502`
  // `MODULE_DATA_UNAVAILABLE_BODY` degraded-panel response: `moduleDataRoutes()` registers routes
  // once, at boot, from the manifest, so an undeclared path was never mounted as a route at all
  // (mirrors `module-data-routes.ts`'s own AC4 "Edge/failure" contract). This deliberately does
  // NOT re-test the `threw`/`timed_out`/`malformed_result` failure-degradation branches, the 401
  // case, or per-org context isolation — `apps/api/src/extensions/module-data-routes.test.ts`
  // already covers all of those exhaustively at the API layer.
  test('AC5 (Story 30.3) edge case: GET to an undeclared moduleData path returns a plain 404', async ({
    context,
  }) => {
    await registerLoggedInMember(context.request, 'module-data-404')

    const res = await context.request.get(`${API_BASE}/api/v1/extensions/data/not-a-real-route`, {
      failOnStatusCode: false,
    })

    expect(res.status()).toBe(404)
  })
})
