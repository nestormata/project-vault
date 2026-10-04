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
