import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { setOrganizationRoleViaDb } from '../fixtures/db.js'
import {
  apiContextFor,
  countAuditEvents,
  createCredential,
  createProject,
  expectAnonymousLoginRedirect,
  open,
  seedOrgOwner,
  seedProjectViewer,
  trackHydrationMismatch,
} from './fixtures.js'

// Story 69.2 AC-6 / AC-8, M3 at REGION points of PV's own credential detail page (a page the pack did
// NOT override), against the real API and database: an actions fill (component plus a form action),
// a Shares fill (a load and two actions) and a metadata tile, all opted in with `hostRoutes`. The
// pack replaces no credential region component: PV's own page tests run over the composed tree, and a
// replaced region would break them (the test-subject walk does not go through a route). M4 eligibility of
// the regions is proven by `scripts/lib/web-host/credential-regions-index.test.ts`.
//
// Vault sealed (AC-6 case 3) is covered at unit level (`credential-detail-regions.test.ts`,
// `inject-behavior.test.ts`) and in the kit integration job against the API stub: a sealed vault
// cannot be produced in this shared stack without breaking every other spec.
const NOTE = (page: Page) => page.getByLabel('Credential note')
const SAVE = (page: Page) => page.getByRole('button', { name: 'Save credential note' })
const RESULT = (page: Page) => page.getByTestId('mock-credential-actions-result')
const LOAD = (page: Page) => page.getByTestId('mock-credential-shares-load')
const NONCE = (page: Page) => page.getByTestId('mock-credential-shares-nonce')
const SHARES_FILL = 'mock-credential-shares'
const ACTIONS_FILL = 'mock-credential-actions'
const DOCUMENT_EVENT = 'cm.document.created'
const NOT_FOUND_CARD = 'Secret not found'

const pathOf = (projectId: string, credentialId: string) =>
  `/projects/${projectId}/credentials/${credentialId}`
const noteName = () => `m3c-note-${randomUUID().slice(0, 8)}`

/** The text with every id replaced, so two pages for different ids can be compared byte for byte. */
const withoutIds = (text: string, ...ids: string[]): string =>
  ids.reduce((result, id) => result.split(id).join('<id>'), text)

test.describe('M3 region points on the credential detail page (Story 69.2)', () => {
  test('works: the fills render beside PV own markup, fed by a load that ran with the member session, and hydrate cleanly', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'm3c-render')
    const projectId = await createProject(context, `m3c-${randomUUID().slice(0, 8)}`)
    const name = `m3c-cred-${randomUUID().slice(0, 8)}`
    const credentialId = await createCredential(context, projectId, name)
    await open(page, pathOf(projectId, credentialId), NOTE(page))
    // PV's own regions are still there beside the contributions
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Archive secret' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Shares', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Secret value' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Dependent systems' })).toBeVisible()
    // the load result reached the fill through data.__inject (rendered on the server)
    await expect(LOAD(page)).toContainText(`credential=${credentialId}`)
    await expect(LOAD(page)).toContainText('status=200')
    // the actions fill sits in the header card and sees the caller's roles (display data)
    const actions = page.getByTestId(ACTIONS_FILL)
    await expect(actions).toHaveAttribute('data-org-role', 'owner')
    await expect(actions).toHaveAttribute('data-project-role', 'owner')
    await expect(actions).toHaveAttribute('data-credential', credentialId)
    // the metadata tile joins PV's own grid (the point is the last child of the `<dl>`)
    await expect(page.locator('dl [data-testid="mock-credential-metadata"]')).toHaveCount(1)
    // PV's native Shares body is still there, and the shares fill sits in the same section
    await expect(page.getByRole('button', { name: 'Create share link' })).toBeVisible()
    await expect(page.getByTestId(SHARES_FILL)).toHaveCount(1)
    await expect(page.getByRole('heading', { name: 'Version history' })).toBeVisible()
    expect(mismatches()).toEqual([])
  })

  test('works: the composed action posts through PV fetch, the real API persists exactly one audit row, and the page re-renders with a fresh load', async ({
    page,
    context,
  }) => {
    const user = await seedOrgOwner(context, 'm3c-action')
    const projectId = await createProject(context, `m3c-act-${randomUUID().slice(0, 8)}`)
    const credentialId = await createCredential(
      context,
      projectId,
      `m3c-${randomUUID().slice(0, 8)}`
    )
    const before = await countAuditEvents(user.orgId, DOCUMENT_EVENT)
    await open(page, pathOf(projectId, credentialId), NOTE(page))
    const firstNonce = await NONCE(page).textContent()
    const note = noteName()
    await NOTE(page).fill(note)
    await SAVE(page).click()
    await expect(RESULT(page)).toHaveText(`saved:${note}`)
    await expect.poll(() => countAuditEvents(user.orgId, DOCUMENT_EVENT)).toBe(before + 1)
    // Kit re-ran the page load after the action: the contribution load is fresh
    await expect(NONCE(page)).not.toHaveText(firstNonce ?? '')
    await expect(LOAD(page)).toContainText(`credential=${credentialId}`)
  })

  test('works: a viewer sees the fills with projectRole viewer, PV controls unchanged, and the composed action denies from server state', async ({
    context,
    browser,
  }) => {
    const owner = await seedOrgOwner(context, 'm3c-viewer-owner')
    const projectId = await createProject(context, `m3c-v-${randomUUID().slice(0, 8)}`)
    const credentialId = await createCredential(
      context,
      projectId,
      `m3c-${randomUUID().slice(0, 8)}`
    )
    const viewerContext = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      const viewerPage = await viewerContext.newPage()
      const viewer = await seedProjectViewer(context, viewerContext, projectId, 'm3c-viewer')
      // DW-536: PV's credential page 500s for an org member or viewer (its load reads the admin-only
      // org user list), so the project viewer is an org admin here: the project role is what matters.
      await setOrganizationRoleViaDb(viewer.orgId, viewer.email, 'admin')
      const before = await countAuditEvents(owner.orgId, DOCUMENT_EVENT)
      await open(viewerPage, pathOf(projectId, credentialId), NOTE(viewerPage))
      const actions = viewerPage.getByTestId(ACTIONS_FILL)
      await expect(actions).toHaveAttribute('data-project-role', 'viewer')
      await expect(actions).toHaveAttribute('data-org-role', 'admin')
      // PV's own controls follow PV's own gating: no archive, no reveal
      await expect(viewerPage.getByRole('button', { name: 'Archive secret' })).toHaveCount(0)
      await expect(viewerPage.getByRole('button', { name: 'Reveal value' })).toHaveCount(0)
      await expect(viewerPage.getByRole('heading', { level: 1 })).toBeVisible()
      // The fill posts a FORGED `projectRole=owner` field (hidden input); the action ignores it and
      // decides from the project the API returns for this session.
      await NOTE(viewerPage).fill(noteName())
      await SAVE(viewerPage).click()
      await expect(RESULT(viewerPage)).toHaveText('error:viewer-denied')
      await expect(viewerPage.getByRole('heading', { level: 1 })).toBeVisible()
      expect(await countAuditEvents(owner.orgId, DOCUMENT_EVENT)).toBe(before)
    } finally {
      await viewerContext.close()
    }
  })

  test('works: a 429 from the pack route reaches the action result and the page still renders with a fresh load', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm3c-limit')
    const projectId = await createProject(context, `m3c-l-${randomUUID().slice(0, 8)}`)
    const credentialId = await createCredential(
      context,
      projectId,
      `m3c-${randomUUID().slice(0, 8)}`
    )
    const base = process.env['E2E_BASE_URL'] ?? ''
    const probe = () =>
      context.request.post(`${pathOf(projectId, credentialId)}?/credential.detail.shares.probe`, {
        form: {},
        headers: { origin: base },
        maxRedirects: 0,
      })
    // the pack route allows three calls a minute: use them up, then the fill's own click is the 4th
    for (let call = 0; call < 3; call += 1) expect((await probe()).status()).toBeLessThan(400)
    await open(page, pathOf(projectId, credentialId), NOTE(page))
    const firstNonce = await NONCE(page).textContent()
    await page.getByRole('button', { name: 'Probe pack route' }).click()
    await expect(page.getByTestId('mock-credential-shares-result')).toHaveText('error:429')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(NONCE(page)).not.toHaveText(firstNonce ?? '')
  })

  test('works: without JavaScript the composed form posts, Kit re-renders the page and page.form carries the result', async ({
    browser,
  }) => {
    const noJs = await browser.newContext({
      baseURL: process.env['E2E_BASE_URL'],
      javaScriptEnabled: false,
    })
    try {
      const page = await noJs.newPage()
      await seedOrgOwner(noJs, 'm3c-nojs')
      const projectId = await createProject(noJs, `m3c-nj-${randomUUID().slice(0, 8)}`)
      const credentialId = await createCredential(
        noJs,
        projectId,
        `m3c-${randomUUID().slice(0, 8)}`
      )
      await page.goto(pathOf(projectId, credentialId))
      const firstNonce = await NONCE(page).textContent()
      const note = noteName()
      await NOTE(page).fill(note)
      await SAVE(page).click()
      await expect(RESULT(page)).toHaveText(`saved:${note}`)
      // the POST answered with the page rendered anew: its load ran again
      await expect(NONCE(page)).not.toHaveText(firstNonce ?? '')
    } finally {
      await noJs.close()
    }
  })

  test('fails (denied): another org credential id and a nonexistent id are one and the same not-found card, with no fill data and no 500', async ({
    page,
    context,
    browser,
    playwright,
  }) => {
    await seedOrgOwner(context, 'm3c-owner')
    const ownProject = await createProject(context, `m3c-own-${randomUUID().slice(0, 8)}`)
    const otherContext = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      await seedOrgOwner(otherContext, 'm3c-other')
      const foreignProject = await createProject(otherContext, `m3c-f-${randomUUID().slice(0, 8)}`)
      const foreignCredential = await createCredential(
        otherContext,
        foreignProject,
        `m3c-f-${randomUUID().slice(0, 8)}`
      )
      const missingCredential = randomUUID()
      const foreign = await page.goto(pathOf(foreignProject, foreignCredential))
      await expect(page.getByText(NOT_FOUND_CARD)).toBeVisible()
      await expect(page.getByTestId(SHARES_FILL)).toHaveCount(0)
      await expect(page.getByTestId(ACTIONS_FILL)).toHaveCount(0)
      const missing = await page.goto(pathOf(ownProject, missingCredential))
      await expect(page.getByText(NOT_FOUND_CARD)).toBeVisible()
      expect(foreign?.status()).toBe(missing?.status())
      expect(foreign?.status()).toBeLessThan(500)
      // the data endpoint is byte-identical for both ids and carries no contribution result
      const foreignData = await context.request.get(
        `${pathOf(foreignProject, foreignCredential)}/__data.json`
      )
      const missingData = await context.request.get(
        `${pathOf(foreignProject, missingCredential)}/__data.json`
      )
      expect(foreignData.status()).toBe(missingData.status())
      const foreignText = await foreignData.text()
      expect(withoutIds(foreignText, foreignProject, foreignCredential)).toBe(
        withoutIds(await missingData.text(), foreignProject, missingCredential)
      )
      expect(foreignText).not.toContain('apiStatus')
      // the real API denies at the database level: identical bodies for a foreign and a missing id
      const api = await apiContextFor(playwright, context)
      const cross = await api.get(
        `/api/v1/projects/${foreignProject}/credentials/${foreignCredential}`
      )
      const none = await api.get(
        `/api/v1/projects/${foreignProject}/credentials/${missingCredential}`
      )
      expect(cross.status()).toBe(404)
      expect(await cross.text()).toBe(await none.text())
      await api.dispose()
    } finally {
      await otherContext.close()
    }
  })

  test('fails (rejected): the composed action answers a foreign credential like a nonexistent one, writes nothing, and rejects anonymous and cross-origin posts', async ({
    request,
    context,
    browser,
  }) => {
    const base = process.env['E2E_BASE_URL'] ?? ''
    const user = await seedOrgOwner(context, 'm3c-deny')
    const own = await createProject(context, `m3c-own-${randomUUID().slice(0, 8)}`)
    const ownCredential = await createCredential(context, own, `m3c-${randomUUID().slice(0, 8)}`)
    const otherContext = await browser.newContext({ baseURL: base })
    try {
      await seedOrgOwner(otherContext, 'm3c-deny-other')
      const foreignProject = await createProject(otherContext, `m3c-df-${randomUUID().slice(0, 8)}`)
      const foreignCredential = await createCredential(
        otherContext,
        foreignProject,
        `m3c-df-${randomUUID().slice(0, 8)}`
      )
      const before = await countAuditEvents(user.orgId, DOCUMENT_EVENT)
      const post = (projectId: string, credentialId: string, origin = base) =>
        context.request.post(`${pathOf(projectId, credentialId)}?/credential.detail.actions.note`, {
          form: { note: 'x', projectRole: 'owner' },
          headers: { origin },
          maxRedirects: 0,
        })
      // actions run without the page load, so the action authorizes itself through the API (RLS)
      const foreignResponse = await post(foreignProject, foreignCredential)
      const missingResponse = await post(own, randomUUID())
      expect(foreignResponse.status()).toBe(missingResponse.status())
      expect(foreignResponse.status()).toBeLessThan(500)
      expect(await countAuditEvents(user.orgId, DOCUMENT_EVENT)).toBe(before)
      // cross-origin: Kit's origin check rejects before the action runs
      expect((await post(own, ownCredential, 'http://evil.example')).status()).toBe(403)
      // anonymous: PV's protected paths redirect before any action runs
      await expectAnonymousLoginRedirect(
        request,
        `${pathOf(own, ownCredential)}?/credential.detail.actions.note`,
        base
      )
      expect(await countAuditEvents(user.orgId, DOCUMENT_EVENT)).toBe(before)
    } finally {
      await otherContext.close()
    }
  })

  test('fails (denied): an anonymous request to a credential page is redirected to /login before any contribution load runs', async ({
    page,
  }) => {
    await page.goto(pathOf(randomUUID(), randomUUID()))
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByTestId(SHARES_FILL)).toHaveCount(0)
  })
})
