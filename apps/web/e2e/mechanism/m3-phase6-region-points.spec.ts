import { randomUUID } from 'node:crypto'
import { expect, test, type BrowserContext, type Locator } from '@playwright/test'
import { setPlatformOperatorViaDb } from '../fixtures/db.js'
import {
  countAuditEvents,
  countWebLogLines,
  createProject,
  expectAnonymousLoginRedirect,
  expectForeignOriginRejected,
  getPlain,
  open,
  readWebLog,
  revokeSessionKeepingCookies,
  seedOrgOwner,
  trackHydrationMismatch,
} from './fixtures.js'

// Story 69.6 AC-8, M3 region points on the regions Epic 69 phase 6 added to PV's native pages. The
// pack fills `app.layout.search` (a layout), `auth.register.heading` / `auth.register.form` /
// `auth.login.links` (public pre-auth pages), `platform.home.nav-cards` (the platform home) and
// `project.certificates.list-header` (a list header). The root error page cannot carry a fill here:
// the pack overrides `+error.svelte` (M1), so PV's own error regions never render in this product.
// Existing mechanism cases are untouched.
const ID = {
  search: 'mock-p6-layout-search',
  regHeading: 'mock-p6-register-heading',
  regForm: 'mock-p6-register-form',
  loginLinks: 'mock-p6-login-links',
  platformNav: 'mock-p6-platform-nav',
  certs: 'mock-p6-certs-header',
  certsText: 'mock-p6-certs-text',
} as const
const SENTINEL = 'mock-ui-pack:m3-p6'
const PLATFORM_FILL = `${SENTINEL}-platform.home.nav-cards`
const DOCUMENT_EVENT = 'cm.document.created'
const SETTINGS = '/settings'
const PLATFORM = '/platform'
const REGISTER = '/register'
const certsPath = (projectId: string) => `/projects/${projectId}/certificates`
const plain = (html: string) => html.replaceAll('<!---->', '')
const runsIn = (html: string): number => Number(/runs=(\d+)/.exec(plain(html))?.[1] ?? Number.NaN)
const origin = () => process.env['E2E_BASE_URL'] ?? ''

/** True when `first` comes before `second` in the document (DOM order, not paint order). */
async function precedes(first: Locator, second: Locator): Promise<boolean> {
  const handle = await second.elementHandle()
  if (handle === null) return false
  return first.evaluate(
    (node, other) => (node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    handle
  )
}

test.describe('M3 region points of phase 6 on native layouts, public, platform and list pages', () => {
  test('works: each region shows PV markup beside the fill, the props reach it and nothing mismatches', async ({
    page,
    context,
    browser,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    const owner = await seedOrgOwner(context, 'p6-render')
    const projectId = await createProject(context, `p6-own-${randomUUID().slice(0, 8)}`)

    // layout: the global search region renders on every signed-in page and the dialog still works
    await open(page, SETTINGS, page.getByTestId(ID.search))
    await expect(page.getByTestId(ID.search)).toContainText(`${SENTINEL}-app.layout.search`)
    await page.keyboard.press('Control+K')
    await expect(page.getByRole('dialog', { name: 'Global search' })).toBeVisible()
    await expect(page.getByTestId(ID.search)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Global search' })).toHaveCount(0)

    // list header: the fill sits after PV's header card and reads the project through the session
    await open(page, certsPath(projectId), page.getByTestId(ID.certs))
    const card = page.getByRole('heading', { name: 'SSL/TLS certificates' })
    await expect(card).toBeVisible()
    await expect(page.getByTestId(ID.certsText)).toContainText('status=200')
    expect(await precedes(card, page.getByTestId(ID.certs))).toBe(true)

    // public pre-auth pages, with no session: a render-only fill, a counted load and the sign-in links
    const anonymous = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      const pre = await anonymous.newPage()
      const preMismatches = trackHydrationMismatch(pre)
      await open(pre, REGISTER, pre.getByTestId(ID.regForm))
      await expect(pre.getByTestId(ID.regHeading)).toContainText(
        `${SENTINEL}-auth.register.heading`
      )
      await expect(pre.getByTestId(ID.regForm)).toContainText('session=none')
      await expect(pre.getByTestId(ID.regForm)).toContainText(/runs=[1-9]/)
      await open(pre, '/login', pre.getByTestId(ID.loginLinks))
      await expect(pre.getByTestId(ID.loginLinks)).toBeVisible()
      expect(preMismatches()).toEqual([])
    } finally {
      await anonymous.close()
    }

    // platform home: an operator sees PV's nav cards and the fill with its counted load
    const displaced = await setPlatformOperatorViaDb(owner.email, true)
    try {
      await open(page, PLATFORM, page.getByTestId(ID.platformNav))
      await expect(page.getByTestId(ID.platformNav)).toContainText('operator=yes')
      await expect(page.getByTestId(ID.platformNav)).toContainText(/runs=[1-9]/)
    } finally {
      await setPlatformOperatorViaDb(owner.email, false)
      if (displaced !== null) await setPlatformOperatorViaDb(displaced, true)
    }
    expect(mismatches()).toEqual([])
  })

  test('fails (denied): another org owner on a foreign project gets no contribution load and no org A data', async ({
    context,
    browser,
  }) => {
    const ownerA = await seedOrgOwner(context, 'p6-iso-a')
    const nameA = `p6-a-${randomUUID().slice(0, 8)}`
    const projectA = await createProject(context, nameA)
    const contextB = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      await seedOrgOwner(contextB, 'p6-iso-b')
      const html = await contextB.request.get(certsPath(projectA))
      const data = await contextB.request.get(`${certsPath(projectA)}/__data.json`)
      // PV's own project layout answers not-found for a foreign id, so the fill's load never runs
      for (const body of [plain(await html.text()), plain(await data.text())]) {
        expect(body).not.toContain(ownerA.email)
        expect(body).not.toContain(ownerA.userId)
        expect(body).not.toContain(nameA)
        expect(body).not.toContain('status=200')
      }
    } finally {
      await contextB.close()
    }
  })

  test('fails (authorization): a non-operator gets PV own notice and the platform fill load never runs (counter)', async ({
    context,
    browser,
  }) => {
    const operator = await seedOrgOwner(context, 'p6-op')
    const contextB = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    const displaced = await setPlatformOperatorViaDb(operator.email, true)
    try {
      await seedOrgOwner(contextB, 'p6-nonop')
      const read = async (from: BrowserContext) =>
        runsIn(await (await from.request.get(PLATFORM)).text())
      const before = await read(context)
      expect(before).toBeGreaterThan(0)
      const denied = await Promise.all(
        Array.from({ length: 3 }, () => contextB.request.get(PLATFORM))
      )
      for (const response of denied) {
        const body = plain(await response.text())
        expect(body).toContain('Platform Operator Access Required')
        expect(body).not.toContain(PLATFORM_FILL)
      }
      const data = await contextB.request.get(`${PLATFORM}/__data.json`)
      expect(plain(await data.text())).not.toContain(PLATFORM_FILL)
      // three denied requests, none ran the load: the next operator request is exactly one more
      expect(await read(context)).toBe(before + 1)
    } finally {
      await setPlatformOperatorViaDb(operator.email, false)
      if (displaced !== null) await setPlatformOperatorViaDb(displaced, true)
      await contextB.close()
    }
  })

  test('works: the injected action persists exactly one audit row; rejected posts persist none', async ({
    page,
    context,
    request,
  }) => {
    const user = await seedOrgOwner(context, 'p6-audit')
    const projectId = await createProject(context, `p6-audit-${randomUUID().slice(0, 8)}`)
    const before = await countAuditEvents(user.orgId, DOCUMENT_EVENT)
    await open(page, certsPath(projectId), page.getByTestId(ID.certs))
    await page.getByLabel('Note title').fill(`p6-note-${randomUUID().slice(0, 8)}`)
    await page.getByRole('button', { name: 'Save note' }).click()
    await expect.poll(() => countAuditEvents(user.orgId, DOCUMENT_EVENT)).toBe(before + 1)

    const action = `${certsPath(projectId)}?/project.certificates.list-header.note`
    await expectAnonymousLoginRedirect(request, action, origin())
    await expectForeignOriginRejected(context, action)
    expect(await countAuditEvents(user.orgId, DOCUMENT_EVENT)).toBe(before + 1)
  })

  test('fails (session): a revoked session redirects with PV reason, and logout then back shows no fill data', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'p6-session')
    const projectId = await createProject(context, `p6-session-${randomUUID().slice(0, 8)}`)
    await open(page, certsPath(projectId), page.getByTestId(ID.certs))
    await revokeSessionKeepingCookies(context)
    await page.goto(SETTINGS)
    await expect(page).toHaveURL(/\/login\?reason=session-expired/)
    expect(await page.content()).not.toContain(`${SENTINEL}-app.layout.search`)
    await context.clearCookies()
    const anonymous = await context.request.get(certsPath(projectId), { maxRedirects: 0 })
    expect(anonymous.status()).toBe(303)
    expect(await anonymous.text()).not.toContain(SENTINEL)
  })

  test('works: twenty interleaved loads from two orgs never mix contribution data', async ({
    context,
    browser,
  }) => {
    await seedOrgOwner(context, 'p6-par-a')
    const projectA = await createProject(context, `p6-par-a-${randomUUID().slice(0, 8)}`)
    const contextB = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      await seedOrgOwner(contextB, 'p6-par-b')
      const projectB = await createProject(contextB, `p6-par-b-${randomUUID().slice(0, 8)}`)
      await Promise.all(
        Array.from({ length: 2 }, (_, index) =>
          createProject(contextB, `p6-par-b-${index}-${randomUUID().slice(0, 8)}`)
        )
      )
      const load = (from: BrowserContext, project: string) => getPlain(from, certsPath(project))
      const bodies = await Promise.all([
        ...Array.from({ length: 10 }, async () => ({
          own: 'a',
          body: await load(context, projectA),
        })),
        ...Array.from({ length: 10 }, async () => ({
          own: 'b',
          body: await load(contextB, projectB),
        })),
      ])
      for (const { own, body } of bodies) {
        expect(body).toContain(own === 'a' ? 'projects=1' : 'projects=3')
        expect(body).not.toContain(own === 'a' ? 'projects=3' : 'projects=1')
        expect(body).not.toContain(own === 'a' ? projectB : projectA)
      }
    } finally {
      await contextB.close()
    }
  })

  test('fails (operational logging): a throwing pre-auth load gives an error response, logs the point and error name only, and other pre-auth pages keep working', async ({
    browser,
  }) => {
    const anonymous = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      const line = 'injection "auth.register.form" load failed: TypeError'
      const before = countWebLogLines(line)
      const response = await anonymous.request.get(`${REGISTER}?mock-p6-boom=${randomUUID()}`)
      expect(response.status()).toBe(500)
      await expect.poll(() => countWebLogLines(line)).toBe(before + 1)
      expect(readWebLog()).not.toContain('mock-ui-pack-secret-message')
      // the failure is the page's own: sign-in and recovery answer, and the register page without the
      // fault flag renders both its render-only fill and its counted-load fill
      for (const path of ['/login', '/recovery', REGISTER]) {
        const ok = await anonymous.request.get(path)
        expect(ok.status(), path).toBe(200)
      }
      const register = plain(await (await anonymous.request.get(REGISTER)).text())
      expect(register).toContain(`${SENTINEL}-auth.register.heading`)
      expect(register).toContain(`${SENTINEL}-auth.register.form`)
    } finally {
      await anonymous.close()
    }
  })
})

// Story 69.6 AC-5 (DW-538): what an M4 replacement does to the region point PV renders as the child of
// the replaced component. The pack wraps `SettingsHomeHeader` through `pv-original:` (forwarding
// `children`) and replaces `SsoDomainsHeader` FULLY (neither the original nor `children`).
test.describe('M3 region points under M4 replacements', () => {
  test('works: a fill survives a replacement that wraps the original and forwards children', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'p6-m4-keep')
    await open(page, SETTINGS, page.getByTestId('mock-p6-settings-home-header'))
    await expect(page.getByTestId('mock-settings-home')).toHaveText('mock-ui-pack:m4-settings-home')
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    await expect(page.getByTestId('mock-p6-settings-home-header')).toContainText(
      `${SENTINEL}-settings.home.header`
    )
    expect(mismatches()).toEqual([])
  })

  test('fails (by design): a full replacement drops the inner fill, its sibling region keeps its fill, the page still renders', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'p6-m4-drop')
    await open(page, '/settings/sso-domains', page.getByTestId('mock-sso-header'))
    await expect(page.getByTestId('mock-sso-header')).toHaveText('mock-ui-pack:m4-sso-header')
    await expect(page.getByTestId('mock-p6-sso-header')).toHaveCount(0)
    await expect(page.getByTestId('mock-p6-sso-panel')).toContainText(
      `${SENTINEL}-settings.sso-domains.panel`
    )
    expect(await page.content()).not.toContain(`${SENTINEL}-settings.sso-domains.header`)
    expect(mismatches()).toEqual([])
  })
})
