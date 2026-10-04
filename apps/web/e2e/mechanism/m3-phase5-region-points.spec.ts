import { randomUUID } from 'node:crypto'
import { expect, test, type BrowserContext } from '@playwright/test'
import {
  countAuditEvents,
  createProject,
  open,
  readWebLog,
  seedOrgMember,
  seedOrgOwner,
  trackHydrationMismatch,
} from './fixtures.js'

// Story 69.4 AC-8, M3 region points on PV's settings audit, settings notifications and project
// members pages. The pack fills `settings.audit.header`, `settings.audit.results`,
// `settings.notifications.channels`, `settings.notifications.routing`, `project.members.access` and
// `project.members.invitations`. The existing `m3-injection.spec.ts` cases are untouched.
const ID = {
  auditHeader: 'mock-p5-audit-header',
  auditResults: 'mock-p5-audit-results',
  channelsText: 'mock-p5-channels-text',
  channels: 'mock-p5-channels',
  routing: 'mock-p5-routing',
  accessText: 'mock-p5-access-text',
  access: 'mock-p5-access',
  invitations: 'mock-p5-invitations',
} as const
const AUDIT = '/settings/audit'
const NOTIFICATIONS = '/settings/notifications'
const AUDIT_RESULTS = 'mock-ui-pack:m3-p5-settings.audit.results'
const DOCUMENT_EVENT = 'cm.document.created'
const membersPath = (projectId: string) => `/projects/${projectId}/members`
// Svelte writes `<!---->` anchors between adjacent text parts; they carry no content.
const plain = (html: string) => html.replaceAll('<!---->', '')

test.describe('M3 region points on settings audit, notifications and project members', () => {
  test('works: each page shows PV markup beside the fill, the props reach it and nothing mismatches', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'p5-render')
    const projectId = await createProject(context, `p5-own-${randomUUID().slice(0, 8)}`)

    await open(page, AUDIT, page.getByTestId(ID.auditHeader))
    await expect(page.getByRole('heading', { name: 'Audit & Compliance' })).toBeVisible()
    await expect(page.getByTestId(ID.auditHeader)).toContainText('role=owner allowed=true')
    await expect(page.getByTestId(ID.auditResults)).toContainText(AUDIT_RESULTS)
    await expect(page.getByTestId(ID.auditResults)).toContainText('role=owner')
    await expect(page.getByTestId(ID.auditResults)).toContainText('rows=1')

    await open(page, NOTIFICATIONS, page.getByTestId(ID.channels))
    await expect(page.getByRole('heading', { name: 'Notification Preferences' })).toBeVisible()
    await expect(page.getByTestId(ID.channelsText)).toContainText(/preferences=[1-9]/)
    await expect(page.getByTestId(ID.routing)).toContainText(/routes=[1-9]/)

    await open(page, membersPath(projectId), page.getByTestId(ID.access))
    await expect(page.getByRole('heading', { name: 'Project members' })).toBeVisible()
    await expect(page.getByTestId(ID.accessText)).toContainText('members=1')
    await expect(page.getByTestId(ID.accessText)).toContainText('status=200')
    await expect(page.getByTestId(ID.invitations)).toContainText('invitations=0')
    expect(mismatches()).toEqual([])
  })

  test('fails (denied): another org owner on a foreign project members page sees 404 and no org A data', async ({
    context,
    browser,
  }) => {
    const ownerA = await seedOrgOwner(context, 'p5-iso-a')
    const projectA = await createProject(context, `p5-a-${randomUUID().slice(0, 8)}`)
    const contextB = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      await seedOrgOwner(contextB, 'p5-iso-b')
      const pageB = await contextB.newPage()
      const response = await pageB.goto(membersPath(projectA))
      // PV's own load degrades a foreign id to empty lists; the fill's load reads the real API
      expect(response?.status()).toBe(200)
      await expect(pageB.getByTestId(ID.accessText)).toContainText('status=404')
      await expect(pageB.getByTestId(ID.accessText)).toContainText('members=0')
      const missing = await pageB.goto(membersPath(randomUUID()))
      expect(missing?.status()).toBe(200)
      await expect(pageB.getByTestId(ID.accessText)).toContainText('status=404')
      const html = await contextB.request.get(membersPath(projectA))
      const data = await contextB.request.get(`${membersPath(projectA)}/__data.json`)
      for (const body of [await html.text(), await data.text()]) {
        expect(body).not.toContain(ownerA.email)
        expect(body).not.toContain(ownerA.userId)
      }
    } finally {
      await contextB.close()
    }
  })

  test('fails (authorization): a plain org member sees PV read-only states and no admin fill, not even in __data.json', async ({
    context,
    browser,
  }) => {
    await seedOrgOwner(context, 'p5-authz-owner')
    const projectId = await createProject(context, `p5-authz-${randomUUID().slice(0, 8)}`)
    const member = await seedOrgMember(browser, { context, projectId }, 'p5-authz-member')
    try {
      const page = await member.context.newPage()
      await open(page, AUDIT, page.getByTestId(ID.auditHeader))
      await expect(page.getByText('This page requires the owner role.')).toBeVisible()
      await expect(page.getByTestId(ID.auditResults)).toHaveCount(0)
      const auditData = await member.context.request.get(`${AUDIT}/__data.json`)
      expect(plain(await auditData.text())).not.toContain(AUDIT_RESULTS)

      await open(page, NOTIFICATIONS, page.getByTestId(ID.channels))
      await expect(page.getByTestId(ID.routing)).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Send Test Notification' })).toHaveCount(0)

      await page.goto(membersPath(projectId))
      await expect(
        page.getByText('Only project owners and admins can manage invitations.')
      ).toBeVisible()
      await expect(page.getByTestId(ID.access)).toHaveCount(0)
      await expect(page.getByTestId(ID.invitations)).toHaveCount(0)
    } finally {
      await member.context.close()
    }
  })

  test('works: the injected action persists exactly one audit row; rejected posts persist none', async ({
    page,
    context,
    request,
  }) => {
    const user = await seedOrgOwner(context, 'p5-audit')
    const before = await countAuditEvents(user.orgId, DOCUMENT_EVENT)
    await open(page, NOTIFICATIONS, page.getByTestId(ID.channels))
    await page.getByLabel('Channel name').fill(`p5-channel-${randomUUID().slice(0, 8)}`)
    await page.getByRole('button', { name: 'Save channel' }).click()
    await expect.poll(() => countAuditEvents(user.orgId, DOCUMENT_EVENT)).toBe(before + 1)

    const action = `${NOTIFICATIONS}?/settings.notifications.channels.save`
    const anonymous = await request.post(action, {
      form: { title: 'x' },
      headers: { origin: process.env['E2E_BASE_URL'] ?? '' },
      maxRedirects: 0,
    })
    expect(anonymous.status()).toBe(303)
    expect(anonymous.headers()['location']).toBe('/login')
    const foreign = await context.request.post(action, {
      form: { title: 'x' },
      headers: { origin: 'http://evil.example' },
      maxRedirects: 0,
    })
    expect(foreign.status()).toBe(403)
    expect(await countAuditEvents(user.orgId, DOCUMENT_EVENT)).toBe(before + 1)
  })

  test('fails (session): a revoked session is redirected with PV reason and no fill data is served', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'p5-session')
    await open(page, NOTIFICATIONS, page.getByTestId(ID.channels))
    const stale = await context.cookies()
    const logout = await context.request.post('/api/v1/auth/logout')
    expect(logout.status(), await logout.text()).toBe(204)
    await context.addCookies(stale)
    await page.goto(AUDIT)
    await expect(page).toHaveURL(/\/login\?reason=session-expired/)
    expect(await page.content()).not.toContain('mock-ui-pack:m3-p5')
    await context.clearCookies()
    const anonymous = await context.request.get(NOTIFICATIONS, { maxRedirects: 0 })
    expect(anonymous.status()).toBe(303)
    expect(await anonymous.text()).not.toContain('mock-ui-pack:m3-p5')
  })

  test('works: twenty interleaved loads from two orgs never mix contribution data', async ({
    context,
    browser,
  }) => {
    await seedOrgOwner(context, 'p5-par-a')
    await createProject(context, `p5-par-a-${randomUUID().slice(0, 8)}`)
    const contextB = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      await seedOrgOwner(contextB, 'p5-par-b')
      await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          createProject(contextB, `p5-par-b-${index}-${randomUUID().slice(0, 8)}`)
        )
      )
      const load = async (from: BrowserContext) => {
        const response = await from.request.get(NOTIFICATIONS)
        expect(response.status()).toBe(200)
        return plain(await response.text())
      }
      const bodies = await Promise.all([
        ...Array.from({ length: 10 }, async () => ({ own: 'a', body: await load(context) })),
        ...Array.from({ length: 10 }, async () => ({ own: 'b', body: await load(contextB) })),
      ])
      for (const { own, body } of bodies) {
        expect(body).toContain(own === 'a' ? 'rows=1' : 'rows=3')
        expect(body).not.toContain(own === 'a' ? 'rows=3' : 'rows=1')
      }
    } finally {
      await contextB.close()
    }
  })

  test('works: the fill limited route answers 429 as a status line, the page stays 200 and PV own audit API is unaffected', async ({
    context,
  }) => {
    await seedOrgOwner(context, 'p5-limit')
    const pages = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const response = await context.request.get(AUDIT)
        return { status: response.status(), body: plain(await response.text()) }
      })
    )
    for (const result of pages) expect(result.status).toBe(200)
    expect(pages.some((result) => result.body.includes('limited=429'))).toBe(true)
    const own = await context.request.get('/api/v1/org/audit/events?limit=1')
    expect(own.status()).toBe(200)
  })

  test('fails (operational logging): a throwing contribution load gives PV error page and logs the point and error name only', async ({
    context,
  }) => {
    await seedOrgOwner(context, 'p5-boom')
    const response = await context.request.get(`${NOTIFICATIONS}?mock-p5-boom=1`)
    expect(response.status()).toBe(500)
    const log = readWebLog()
    expect(log).toContain('injection "settings.notifications.channels" load failed: TypeError')
    expect(log).not.toContain('mock-ui-pack-secret-message')
  })
})
