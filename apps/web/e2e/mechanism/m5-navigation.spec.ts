import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { setPlatformOperatorViaDb } from '../fixtures/db.js'
import { createProject, seedOrgOwner } from './fixtures.js'

// Story 68.10 AC-1 / AC-6, M5 (navigation customization): the mock pack's nav delta (ui-pack/nav.ts)
// applies every operation (add, remove, hide, rename, reorder, move, replace, nest, inheritance of a
// new item) to PV's native items and to the pack's own, on every nav surface a composed page renders.
// The surfaces `footer` (M4 replaces Footer.svelte) and `error.nav` (M1 replaces +error.svelte) are
// rendered by PV files this pack replaces on purpose; the shipped composed-nav test that `pv-verify`
// runs in the compose stage validates them. Accessibility is asserted with roles, accessible names,
// aria-current and keyboard operation (no axe dependency: Q10 default).

/** Visible text of each element, whitespace collapsed (CSS-hidden spans are not part of it). */
async function visibleTexts(locator: Locator): Promise<string[]> {
  const raw = await locator.allInnerTexts()
  return raw.map((text) => text.replace(/\s+/g, ' ').trim())
}

function primaryTopLevel(page: Page): Locator {
  return page.getByTestId(PRIMARY_NAV).locator(TOP_LEVEL)
}

const SETTINGS = '/settings'
const PRIMARY_NAV = 'primary-nav'
const PROJECT_NAV = 'project-nav'
const MOCK_SETTINGS = 'Mock Settings'
/** The nav's own top-level entries: plain links and the summaries of disclosures. */
const TOP_LEVEL = ':scope > a, :scope > details > summary'
const MOCK_BILLING = 'Mock Billing'

/** The primary nav after the delta, for an owner who is not the platform operator. */
const PRIMARY_ORDER = [
  'Notifications',
  'Projects',
  MOCK_BILLING,
  MOCK_SETTINGS,
  'Dashboard',
  'Mock Tools',
]

/** The project nav after the delta (labels from PV's messages). */
const PROJECT_ORDER = [
  'Mock Team',
  'Overview',
  'Secrets',
  'Machine Users',
  'Services',
  'Endpoints',
  'Status Page',
  'Mock Project Billing',
]

test.describe('M5 navigation customization', () => {
  test('works: the primary nav applies add, remove, hide, rename, move and reorder to native and pack items', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm5-primary')
    await page.goto(SETTINGS)
    await expect(page.getByTestId(PRIMARY_NAV)).toBeVisible()
    // reorder put Notifications first, the insert landed after Projects, the move sent Dashboard
    // after Settings, the rename shows, and the pack's group is appended last
    expect(await visibleTexts(primaryTopLevel(page))).toEqual(PRIMARY_ORDER)
    const nav = page.getByTestId(PRIMARY_NAV)
    // remove and hide: absent from the DOM
    for (const gone of ['Secrets', 'Health', 'Mock Hidden']) {
      await expect(nav.getByRole('link', { name: gone, exact: true })).toHaveCount(0)
    }
  })

  test('works: nesting, a child under a native item, a child under the pack own item and a late child', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm5-nest')
    await page.goto(SETTINGS)
    const nav = page.getByTestId(PRIMARY_NAV)
    // the pack's own two-level group: a native disclosure, keyboard operable
    const tools = nav.locator('summary', { hasText: 'Mock Tools' })
    await tools.focus()
    await page.keyboard.press('Enter')
    await expect(nav.getByRole('link', { name: 'Mock Late' })).toBeVisible()
    const reports = nav.locator('summary', { hasText: 'Mock Reports' })
    await reports.click()
    await expect(nav.getByRole('link', { name: 'Mock Daily' })).toBeVisible()
    // a child under a NATIVE item: the item keeps its own link, first in its panel
    await nav.locator('summary', { hasText: MOCK_SETTINGS }).click()
    const panel = nav.locator('details', {
      has: page.locator('summary', { hasText: MOCK_SETTINGS }),
    })
    expect(await visibleTexts(panel.getByRole('link'))).toEqual([
      MOCK_SETTINGS,
      'Mock Settings Child',
    ])
  })

  test('works: a new item is inherited by every page that renders the primary nav', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm5-inherit')
    for (const path of [SETTINGS, '/projects', '/notifications', '/health', '/credentials']) {
      await page.goto(path)
      expect(await visibleTexts(primaryTopLevel(page)), path).toEqual(PRIMARY_ORDER)
    }
  })

  test('works: the mobile nav renders the same data with the narrow-screen label', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm5-mobile')
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto(SETTINGS)
    // an item without its own mobileLabel falls back to the label; a string `relabel` changes only the
    // label, so the renamed native item keeps PV's narrow-screen text
    expect(await visibleTexts(primaryTopLevel(page))).toEqual(
      PRIMARY_ORDER.map((label) => (label === MOCK_SETTINGS ? 'Settings' : label))
    )
  })

  test('fails (denied): hide and remove are presentation only, the hidden and removed routes still answer', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm5-hide')
    // Health is hidden and Secrets removed from the nav; neither route was removed
    for (const path of ['/health', '/credentials']) {
      const response = await page.goto(path)
      expect(response?.status(), path).toBe(200)
    }
    await page.goto(SETTINGS)
    await expect(page.getByTestId(PRIMARY_NAV).getByRole('link', { name: 'Health' })).toHaveCount(0)
  })

  test('works: the active item is marked with aria-current and the landmark keeps its name', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm5-a11y')
    await page.goto('/notifications')
    const nav = page.getByRole('navigation', { name: 'Primary navigation' })
    await expect(nav.getByRole('link', { name: 'Notifications' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    // an inserted pack link is a plain link with an accessible name, never the current page here
    await expect(nav.getByRole('link', { name: MOCK_BILLING })).not.toHaveAttribute(
      'aria-current',
      'page'
    )
    // a relabelled native icon-less link keeps one accessible name (no duplicated desktop/mobile text)
    await expect(nav.getByRole('link', { name: 'Projects', exact: true })).toHaveCount(1)
  })

  test('works: the project nav applies the delta, nests under a native tab and inherits on every tab', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm5-project')
    const projectId = await createProject(context, `Mock M5 ${Date.now()}`)
    const tabs = (): Locator => page.getByTestId(PROJECT_NAV).locator(TOP_LEVEL)
    await page.goto(`/projects/${projectId}`)
    // reorder first (Members renamed), the pack's tab appended, Certificates removed, Domains hidden
    expect(await visibleTexts(tabs())).toEqual(PROJECT_ORDER)
    const nav = page.getByTestId(PROJECT_NAV)
    await nav.locator('summary', { hasText: 'Services' }).click()
    await expect(nav.getByRole('link', { name: 'Mock Service Child' })).toBeVisible()
    for (const section of ['members', 'credentials', 'domains']) {
      await page.goto(`/projects/${projectId}/${section}`)
      await expect(nav.getByRole('link', { name: 'Mock Project Billing' }), section).toBeVisible()
    }
  })

  test('fails (denied): a removed or hidden project tab is absent while its route still serves', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm5-project-hide')
    const projectId = await createProject(context, `Mock M5 hide ${Date.now()}`)
    await page.goto(`/projects/${projectId}`)
    const nav = page.getByTestId(PROJECT_NAV)
    for (const gone of ['Certificates', 'Domains']) {
      await expect(nav.getByRole('link', { name: gone })).toHaveCount(0)
    }
    for (const section of ['certificates', 'domains']) {
      const response = await page.goto(`/projects/${projectId}/${section}`)
      expect(response?.status(), section).toBe(200)
    }
  })

  test('works: the settings index and the audit link row apply the delta, nested cards included', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm5-settings')
    await page.goto(SETTINGS)
    const main = page.getByRole('main')
    await expect(main.getByRole('link', { name: /Mock Seats/ })).toContainText(
      'Mock seats and roles'
    )
    await expect(main.getByRole('link', { name: /Mock Card/ })).toContainText(
      'Mock card description'
    )
    // a nested card sits under its parent card
    await expect(main.getByRole('link', { name: /Mock Audit Card/ })).toContainText(
      'Mock nested card'
    )
    for (const gone of ['SSO Domains', 'Themes', 'Users']) {
      await expect(main.getByText(gone, { exact: true })).toHaveCount(0)
    }
    await page.goto('/settings/audit')
    await expect(page.getByRole('link', { name: 'Mock Audit Link' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Mock Forwarding' })).toBeVisible()
    await expect(page.getByRole('link', { name: /Forwarding & Retention/ })).toHaveCount(0)
  })

  test('works: the platform surfaces (index cards, link row, breadcrumbs) apply the delta for the operator', async ({
    page,
    context,
  }) => {
    const owner = await seedOrgOwner(context, 'm5-platform')
    const displaced = await setPlatformOperatorViaDb(owner.email, true)
    try {
      await page.goto('/platform')
      const main = page.getByRole('main')
      await expect(main.getByRole('link', { name: /Mock Backups/ })).toContainText(
        'Mock backups text'
      )
      await expect(main.getByRole('link', { name: /Mock Platform Card/ })).toBeVisible()
      await expect(main.getByRole('link', { name: /Version & Upgrade/ })).toHaveCount(0)
      // the operator also gets PV's own conditional primary item, in its place after Dashboard
      expect(await visibleTexts(primaryTopLevel(page))).toContain('Platform Admin')
      await page.goto('/platform/settings')
      await expect(page.getByRole('link', { name: 'Mock Platform Link' })).toBeVisible()
      // breadcrumbs: PV's relabelled node is the current (text) crumb
      await expect(main.getByText('Mock System')).toBeVisible()
      const upgrade = await page.goto('/platform/upgrade')
      // hide is not remove: the hidden card's page still answers
      expect(upgrade?.status()).toBe(200)
    } finally {
      if (displaced !== null) await setPlatformOperatorViaDb(displaced, true)
      else await setPlatformOperatorViaDb(owner.email, false)
    }
  })

  test('works: a pack page renders PV breadcrumbs for a node the pack inserted under PV own tree', async ({
    page,
  }) => {
    await page.goto('/billing/deep/level')
    const crumbs = page.getByRole('navigation').filter({ hasText: 'Mock Deep Crumb' })
    expect(await visibleTexts(crumbs.locator('a'))).toEqual(['Platform Admin', 'Mock Crumb'])
    await expect(crumbs.locator('span', { hasText: 'Mock Deep Crumb' })).toBeVisible()
  })

  test('works: notification tabs, back links, auth links, brand, bell and the account menu apply the delta', async ({
    page,
    context,
  }) => {
    await page.goto('/login')
    const links = await visibleTexts(page.getByRole('link'))
    // the pack's link lands right after PV's register link; the recovery link is renamed
    expect(links.indexOf('Mock Auth Help')).toBe(links.indexOf('Register') + 1)
    expect(links).toContain('Mock Recover')
    expect(links).not.toContain("Can't access your account?")

    await seedOrgOwner(context, 'm5-shell')
    await page.goto('/notifications?status=all')
    // tabs: Unread hidden, Read renamed, the pack's tab appended
    expect(
      await visibleTexts(page.getByRole('link', { name: /^(All|Unread|Mock Read|Mock Tab)$/ }))
    ).toEqual(['All', 'Mock Read', 'Mock Tab'])
    // shell: the brand link is replaced, the bell is renamed, the account menu has the pack's items
    await expect(page.getByRole('link', { name: 'Mock Brand' })).toHaveAttribute('href', /billing$/)
    await expect(page.getByRole('link', { name: 'Mock Bell' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Mock Account Billing' })).toBeVisible()
    await page.locator('summary', { hasText: 'Mock More' }).click()
    await expect(page.getByRole('link', { name: 'Mock One' })).toBeVisible()
    // PV's own sign-out action survives beside the pack's items
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
    // back links: one renamed, one hidden (hide is not remove)
    await page.goto('/settings/language')
    await expect(page.getByRole('link', { name: 'Mock Back' })).toBeVisible()
    await expect(page.getByRole('link', { name: '← Settings' })).toHaveCount(0)
    await page.goto('/settings/security')
    await expect(page.getByRole('link', { name: '← Settings' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Mock Back' })).toHaveCount(0)
  })

  test('fails (rejected): an id web-host does not have is recorded and ignored at runtime, never a crash', async ({
    page,
    context,
  }) => {
    // the delta hides `primary.mock-not-a-pv-item`; the compose stage proves it was recorded and
    // reported in the lock and the compose output, and here every surface still renders
    await seedOrgOwner(context, 'm5-unknown')
    const response = await page.goto(SETTINGS)
    expect(response?.status()).toBe(200)
    await expect(page.getByTestId(PRIMARY_NAV)).toBeVisible()
  })
})
