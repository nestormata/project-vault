import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import {
  apiContextFor,
  countAuditEvents,
  createProject,
  open,
  seedOrgOwner,
  trackHydrationMismatch,
} from './fixtures.js'

// Story 68.10 AC-1 / AC-5 / AC-10.2-3, M3 (injection into native PV pages): the pack injects a
// component, a server load and a form action into PV's own settings page (a page the pack did NOT
// override), a layout point and a shell.head contribution. One real cross-tenant denial (RLS).
const SETTINGS = '/settings'
const TITLE_FIELD = (page: Page) => page.getByLabel('Document title')
const PROBE = (page: Page) => page.getByTestId('mock-settings-tile-probe')
const NOT_FOUND = 'status=404'
const DOCUMENT_EVENT = 'cm.document.created'

test.describe('M3 injection into native PV pages', () => {
  test('works: the injected tile renders the real user, the layout banner and head meta appear beside PV markup', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    const user = await seedOrgOwner(context, 'm3-render')
    await open(page, SETTINGS, TITLE_FIELD(page))
    // PV's own markup is still there beside the contribution
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await expect(page.getByTestId('mock-settings-tile-user')).toContainText(user.userId)
    await expect(page.getByTestId('mock-settings-tile-late')).toBeVisible()
    await expect(page.getByTestId('mock-layout-banner')).toBeVisible()
    await expect(page.locator('meta[name="mock-ui-pack-injected"]')).toHaveAttribute(
      'content',
      'm3-shell-head'
    )
    // injected markup hydrates cleanly (no mismatch rebuilding PV's head or body)
    expect(mismatches()).toEqual([])
  })

  test('works: the injected form action posts through PV fetch and the real API persists exactly one audit row', async ({
    page,
    context,
  }) => {
    const user = await seedOrgOwner(context, 'm3-action')
    const before = await countAuditEvents(user.orgId, DOCUMENT_EVENT)
    await open(page, SETTINGS, TITLE_FIELD(page))
    await TITLE_FIELD(page).fill(`m3-doc-${randomUUID().slice(0, 8)}`)
    await page.getByRole('button', { name: 'Save document' }).click()
    await expect.poll(() => countAuditEvents(user.orgId, DOCUMENT_EVENT)).toBe(before + 1)
  })

  test('fails (denied): another org project id is answered like a nonexistent one and the tile renders without a 500', async ({
    page,
    context,
    browser,
    playwright,
  }) => {
    const owner = await seedOrgOwner(context, 'm3-owner')
    const ownProject = await createProject(context, `m3-own-${randomUUID().slice(0, 8)}`)
    const otherContext = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      await seedOrgOwner(otherContext, 'm3-other')
      const otherProject = await createProject(otherContext, `m3-other-${randomUUID().slice(0, 8)}`)
      // the injected load requests the other org id through the authenticated event.fetch
      const denied = await page.goto(`/settings?mock-probe=${otherProject}`)
      expect(denied?.status()).toBe(200)
      await expect(PROBE(page)).toContainText(NOT_FOUND)
      await page.goto(`/settings?mock-probe=${randomUUID()}`)
      await expect(PROBE(page)).toContainText(NOT_FOUND)
      await page.goto(`/settings?mock-probe=${ownProject}`)
      await expect(PROBE(page)).toContainText('status=200')
      // no existence leak: the real API answers both ids with the identical body
      const api = await apiContextFor(playwright, context)
      const cross = await api.get(`/api/v1/projects/${otherProject}`)
      const missing = await api.get(`/api/v1/projects/${randomUUID()}`)
      expect(cross.status()).toBe(404)
      expect(await cross.text()).toBe(await missing.text())
      await api.dispose()
      expect(owner.orgId).not.toBe('')
    } finally {
      await otherContext.close()
    }
  })

  test('fails (rejected): the injected action is rejected for an anonymous caller and for a foreign origin, like PV own actions', async ({
    request,
    context,
  }) => {
    const base = process.env['E2E_BASE_URL'] ?? ''
    const anonymous = await request.post('/settings?/settings.home.after.document', {
      form: { title: 'x' },
      headers: { origin: base },
      maxRedirects: 0,
    })
    expect(anonymous.status()).toBe(303)
    expect(anonymous.headers()['location']).toBe('/login')
    const user = await seedOrgOwner(context, 'm3-origin')
    const before = await countAuditEvents(user.orgId, DOCUMENT_EVENT)
    const foreign = await context.request.post('/settings?/settings.home.after.document', {
      form: { title: 'x' },
      headers: { origin: 'http://evil.example' },
      maxRedirects: 0,
    })
    expect(foreign.status()).toBe(403)
    expect(await countAuditEvents(user.orgId, DOCUMENT_EVENT)).toBe(before)
  })
})

// Story 69.1 AC-4 / AC-5 / AC-8 (Q12 option B): a contribution at a REGION point (a point inside a
// shared PV component) with a load and an action, opted in to the host page with `hostRoutes`. The
// project page is PV's own (the pack did not override it); the dashboard is the pack's override and
// imports a PV region component, so a region point renders inside a page the pack replaced.
const TILE_LOAD = 'mock-project-tile-load'
const TILE_NOTE = (page: Page) => page.getByLabel('Tile note')
const TILE_EVENT = 'cm.document.created'
const NOT_FOUND_CARD = 'Project not found'

/** The text with every project id replaced, so two pages for different ids can be compared byte for byte. */
const withoutIds = (text: string, ...ids: string[]): string =>
  ids.reduce((result, id) => result.split(id).join('<id>'), text)

test.describe('M3 region points (Story 69.1)', () => {
  test('works: the tile renders beside PV own project markup, fed by a load that ran with the member session', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'm3r-render')
    const projectId = await createProject(context, `m3r-${randomUUID().slice(0, 8)}`)
    await open(page, `/projects/${projectId}`, TILE_NOTE(page))
    // PV's own regions are still there, in order, beside the contribution
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export project' })).toBeVisible()
    await expect(page.getByText('Members')).toBeVisible()
    // the load result reached the component through data.__inject (rendered on the server)
    await expect(page.getByTestId(TILE_LOAD)).toContainText(`project=${projectId}`)
    await expect(page.getByTestId(TILE_LOAD)).toContainText('status=200')
    // the tile sits inside PV's stat list (the region point is the last child of the <dl>)
    await expect(page.locator('dl [data-testid="mock-project-tile"]')).toHaveCount(1)
    expect(mismatches()).toEqual([])
  })

  test('works: the opted-in action posts through PV fetch and the real API persists exactly one audit row', async ({
    page,
    context,
  }) => {
    const user = await seedOrgOwner(context, 'm3r-action')
    const projectId = await createProject(context, `m3r-act-${randomUUID().slice(0, 8)}`)
    const before = await countAuditEvents(user.orgId, TILE_EVENT)
    await open(page, `/projects/${projectId}`, TILE_NOTE(page))
    await TILE_NOTE(page).fill(`m3r-note-${randomUUID().slice(0, 8)}`)
    await page.getByRole('button', { name: 'Save tile note' }).click()
    await expect.poll(() => countAuditEvents(user.orgId, TILE_EVENT)).toBe(before + 1)
  })

  test('works: client navigation between two projects re-runs the load and never shows project a data under project b', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm3r-nav')
    const a = await createProject(context, `m3r-a-${randomUUID().slice(0, 8)}`)
    const b = await createProject(context, `m3r-b-${randomUUID().slice(0, 8)}`)
    await open(page, `/projects/${a}`, TILE_NOTE(page))
    await expect(page.getByTestId(TILE_LOAD)).toContainText(`project=${a}`)
    await page.evaluate(() => {
      ;(window as unknown as { __navprobe: string }).__navprobe = 'alive'
    })
    // a client-side navigation (no document load): the project list links to each project
    await page.getByRole('link', { name: 'Projects', exact: true }).first().click()
    await page
      .getByRole('link', { name: /^m3r-b-/ })
      .first()
      .click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${b}`)
    await expect(page.getByTestId(TILE_LOAD)).toContainText(`project=${b}`)
    await expect(page.getByTestId(TILE_LOAD)).not.toContainText(`project=${a}`)
    expect(
      await page.evaluate(() => (window as unknown as { __navprobe?: string }).__navprobe)
    ).toBe('alive')
  })

  test('works: twenty interleaved requests from two users each carry only their own tile data, in the SSR HTML and in __data.json', async ({
    context,
    browser,
  }) => {
    const otherContext = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      await seedOrgOwner(context, 'm3r-iso-a')
      await seedOrgOwner(otherContext, 'm3r-iso-b')
      const mine = await createProject(context, `m3r-ia-${randomUUID().slice(0, 8)}`)
      const theirs = await createProject(otherContext, `m3r-ib-${randomUUID().slice(0, 8)}`)
      const rounds = Array.from({ length: 10 }, (_, index) => index)
      const fetchAll = (path: (id: string) => string) =>
        Promise.all(
          rounds.flatMap(() => [
            context.request.get(path(mine)).then(async (r) => ({ id: mine, text: await r.text() })),
            otherContext.request
              .get(path(theirs))
              .then(async (r) => ({ id: theirs, text: await r.text() })),
          ])
        )
      for (const path of [
        (id: string) => `/projects/${id}`,
        (id: string) => `/projects/${id}/__data.json`,
      ]) {
        for (const { id, text } of await fetchAll(path)) {
          const foreign = id === mine ? theirs : mine
          expect(text).toContain(id)
          expect(text).not.toContain(foreign)
        }
      }
    } finally {
      await otherContext.close()
    }
  })

  test('fails (denied): another org project id and a nonexistent id are one and the same 404 card, with no tile load and no 500', async ({
    page,
    context,
    browser,
  }) => {
    await seedOrgOwner(context, 'm3r-owner')
    const otherContext = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      await seedOrgOwner(otherContext, 'm3r-other')
      const foreign = await createProject(otherContext, `m3r-f-${randomUUID().slice(0, 8)}`)
      const missing = randomUUID()
      const foreignPage = await page.goto(`/projects/${foreign}`)
      await expect(page.getByText(NOT_FOUND_CARD)).toBeVisible()
      await expect(page.getByTestId('mock-project-tile')).toHaveCount(0)
      const missingPage = await page.goto(`/projects/${missing}`)
      await expect(page.getByText(NOT_FOUND_CARD)).toBeVisible()
      expect(foreignPage?.status()).toBe(missingPage?.status())
      expect(foreignPage?.status()).toBeLessThan(500)
      // the data endpoint is byte-identical for both ids and carries no contribution result
      const foreignData = await context.request.get(`/projects/${foreign}/__data.json`)
      const missingData = await context.request.get(`/projects/${missing}/__data.json`)
      expect(foreignData.status()).toBe(missingData.status())
      const foreignText = await foreignData.text()
      expect(withoutIds(foreignText, foreign)).toBe(withoutIds(await missingData.text(), missing))
      expect(foreignText).not.toContain('apiStatus')
    } finally {
      await otherContext.close()
    }
  })

  test('fails (rejected): the opted-in action answers a foreign id like a nonexistent one, writes nothing, and rejects anonymous and cross-origin posts', async ({
    request,
    context,
    browser,
  }) => {
    const base = process.env['E2E_BASE_URL'] ?? ''
    const user = await seedOrgOwner(context, 'm3r-deny')
    const otherContext = await browser.newContext({ baseURL: base })
    try {
      await seedOrgOwner(otherContext, 'm3r-deny-other')
      const foreign = await createProject(otherContext, `m3r-df-${randomUUID().slice(0, 8)}`)
      const own = await createProject(context, `m3r-own-${randomUUID().slice(0, 8)}`)
      const before = await countAuditEvents(user.orgId, TILE_EVENT)
      const post = (id: string, origin = base) =>
        context.request.post(`/projects/${id}?/project.detail.tiles.ping`, {
          form: { title: 'x' },
          headers: { origin },
          maxRedirects: 0,
        })
      // actions run without the page load, so the action authorizes itself through the API (RLS)
      const foreignResponse = await post(foreign)
      const missingResponse = await post(randomUUID())
      expect(foreignResponse.status()).toBe(missingResponse.status())
      expect(foreignResponse.status()).toBeLessThan(500)
      expect(await countAuditEvents(user.orgId, TILE_EVENT)).toBe(before)
      // cross-origin: Kit's origin check rejects before the action runs
      const crossOrigin = await post(own, 'http://evil.example')
      expect(crossOrigin.status()).toBe(403)
      // anonymous: PV's protected paths redirect before any action runs
      const anonymous = await request.post(`/projects/${own}?/project.detail.tiles.ping`, {
        form: { title: 'x' },
        headers: { origin: base },
        maxRedirects: 0,
      })
      expect(anonymous.status()).toBe(303)
      expect(anonymous.headers()['location']).toBe('/login')
      expect(await countAuditEvents(user.orgId, TILE_EVENT)).toBe(before)
    } finally {
      await otherContext.close()
    }
  })

  test('works: a region point renders inside the overridden dashboard, fed by the opted-in load', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'm3r-dashboard')
    await open(page, '/dashboard', page.getByLabel('Note'))
    // the override still renders its own load, and PV's region component beside it
    await expect(page.getByTestId('mock-dashboard-load')).toHaveText(
      'mock-ui-pack:m1-dashboard-load'
    )
    await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible()
    await expect(page.getByTestId('mock-activity-tile')).toHaveText(
      'mock-ui-pack:m3-dashboard-region-load'
    )
    expect(mismatches()).toEqual([])
  })

  test('fails (denied): an anonymous request to a project page is redirected to /login before any contribution load runs', async ({
    page,
  }) => {
    await page.goto(`/projects/${randomUUID()}`)
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByTestId('mock-project-tile')).toHaveCount(0)
  })
})
