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
 * J27 — end-to-end proof that Story 29.3's manifest-declared `navItems` render as real entries in
 * PV's own primary nav and are genuinely clickable/navigable, not just correctly modeled by
 * `nav-model.test.ts`'s unit-level merge logic or `PrimaryNav.test.ts`'s component-level render
 * assertions.
 *
 * Drives the mock extension's own declared `navItems` (see
 * `fixtures/mock-ui-panel-extension/src/index.ts`):
 *   - one top-level item (`TEST_NAV_ITEM_ID` = 'mock-ext-settings', label "Mock Extension
 *     Settings", href '/dashboard', icon 'grid') — rendered as a `<details>/<summary>` disclosure
 *     because it has a child, per `PrimaryNav.svelte`'s AC12 rendering rule.
 *   - one child (`TEST_NAV_CHILD_ITEM_ID` = 'mock-ext-settings-child', label "Mock Child Page",
 *     href '/health') — rendered as a real `<a>` inside the disclosure.
 *
 * Mirrors J25's isolated-stack pattern (dedicated DB, real `apps/api`+`apps/web` processes, the
 * mock UI-panel extension loaded via `VAULT_EXTENSIONS_PACKAGE` — see `beforeAll` below) rather
 * than the shared E2E stack, since this journey — like J25 — needs the mock extension loaded and
 * a host process can only load one extensions package at a time.
 */

const API_PORT = 34842
const WEB_PORT = 34843
const DB_NAME = 'project_vault_j27_extension_nav_items_e2e'
const PASSWORD = 'j27-extension-nav-items-e2e-Password-1'
const BASE_URL = `http://localhost:${WEB_PORT}`
const API_BASE = `http://localhost:${API_PORT}`

let apiProcess: ChildProcess | undefined
let webHandle: WebHandle | undefined

test.describe.serial('J27 — Story 29.3 nav/menu manifest merge (mock-ui-panel-extension)', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000)
    ;({ apiProcess, webHandle } = await setupMockExtensionIsolatedStack({
      apiPort: API_PORT,
      webPort: WEB_PORT,
      dbName: DB_NAME,
      apiLogLabel: 'api-nav-items',
      webLogLabel: 'web-nav-items',
      vaultPassphrase: 'j27-extension-nav-items-e2e-passphrase',
      debugLogLevelEnvVar: 'J27_DEBUG_LOG_LEVEL',
    }))
  })

  test.afterAll(async () => {
    await teardownIsolatedStack({
      webHandle,
      apiHandle: apiProcess ? { process: apiProcess } : undefined,
      dbName: DB_NAME,
    })
  })

  test('manifest-declared top-level nav item, its disclosure, and its child both render and navigate correctly', async ({
    page,
    context,
  }) => {
    const email = `j27-nav-${randomUUID()}@example.test`
    const identity = await registerAndLoginIsolated(context.request, API_BASE, {
      email,
      password: PASSWORD,
      orgName: `J27 Nav Org ${randomUUID()}`,
    })
    await enrollMfaDirect(identity.userId, DB_NAME)

    await page.goto(`${BASE_URL}/dashboard`)

    const primaryNav = page.getByTestId('primary-nav')
    await expect(primaryNav).toBeVisible()

    // AC10/AC12: the top-level manifest-declared item has a child, so it renders as a
    // <details>/<summary> disclosure (not a plain link) — the label is visible, but the child is
    // not yet, since <details> starts closed. `PrimaryNav.svelte` renders both a `sm:hidden`
    // mobile-label span and a `hidden sm:inline` desktop-label span with identical text inside the
    // same <summary> (there is no separate mobileLabel for a manifest-declared item — both spans
    // read `item.label`), so locate the single <summary> element itself rather than the label text
    // to keep this a strict-mode-safe locator.
    const summary = primaryNav.locator('summary', { hasText: 'Mock Extension Settings' })
    await expect(summary).toBeVisible()
    const childLink = primaryNav.getByRole('link', { name: 'Mock Child Page' })
    await expect(childLink).toBeHidden()

    // Keyboard/screen-reader-accessible disclosure (AC12): a real click on the <summary> element
    // toggles it open via native <details> semantics, no custom JS.
    await summary.click()
    await expect(childLink).toBeVisible()
    // SvelteKit's `resolve()` (used by PrimaryNav.svelte for every rendered href) emits a
    // relative path (e.g. `./health` from `/dashboard`), not the declared absolute `/health` —
    // the declared value survives end to end regardless, proven by the real navigation below.
    await expect(childLink).toHaveAttribute('href', /(^|\/)health$/)

    // Clicking the child performs a real top-level browser navigation to its declared href — not
    // a client-side no-op or a dead link.
    await childLink.click()
    await expect(page).toHaveURL(`${BASE_URL}/health`)
    await expect(page.getByRole('heading', { name: 'Cross-project health' })).toBeVisible()

    // Confirm the parent item's own icon renders (AC12) — proves the icon-token->glyph mapping
    // resolved a real declared token ('grid'), not just that the label rendered. The disclosure
    // persists across the client-side navigation (it is part of the same PrimaryNav instance).
    const summaryAfterNav = primaryNav.locator('summary', { hasText: 'Mock Extension Settings' })
    await expect(summaryAfterNav).toBeVisible()
    const iconSpan = primaryNav.locator('[data-nav-icon="grid"]')
    await expect(iconSpan).toBeVisible()
  })
})
