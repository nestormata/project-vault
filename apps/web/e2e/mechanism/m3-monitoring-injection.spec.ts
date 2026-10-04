import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createServiceEndpointViaApi } from '../fixtures/api.js'
import { enablePublicStatusPageViaUi } from '../fixtures/status-page-ui.js'
import {
  countAuditEvents,
  createProject,
  expectAnonymousLoginRedirect,
  open,
  seedOrgOwner,
  trackHydrationMismatch,
} from './fixtures.js'

// Story 69.3 AC-5 / AC-7 / AC-8, M3 at the REGION points of the monitoring pages: the endpoint detail
// page (a component, a load and an action, opted in with `hostRoutes`), the endpoint list (one fill per
// row, component only) and the status page admin screen (a component and a load whose result never
// holds the public token). All three are PV's own pages. The public status page has no fill here: the
// pack removes `/status` (see the pack README).
const TILE = 'mock-endpoint-health'
const TILE_LOAD = 'mock-endpoint-health-load'
const NOTE = (page: Page) => page.getByLabel('Health note')
const PILL = 'mock-endpoint-pill'
const STATUS_TILE = 'mock-status-services'
const ENDPOINT_EVENT = 'cm.document.created'
const NOT_FOUND = 'Endpoint not found'
const ACTION = 'project.service-endpoints-detail.history.ping'
const ENDPOINT_URL = 'https://example.com/health'

const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}`
const detailPath = (projectId: string, endpointId: string) =>
  `/projects/${projectId}/service-endpoints/${endpointId}`

/** The text with every id replaced, so two pages for different ids can be compared byte for byte. */
const withoutIds = (text: string, ...ids: string[]): string =>
  ids.reduce((result, id) => result.split(id).join('<id>'), text)

test.describe('M3 monitoring region points: endpoint detail (Story 69.3)', () => {
  test('works: the tile renders inside the history section beside PV own markup, fed by a load that ran with the member session', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'm3m-detail')
    const projectId = await createProject(context, unique('m3m'))
    const endpoint = await createServiceEndpointViaApi(context, projectId, {
      name: unique('ep'),
      url: ENDPOINT_URL,
    })
    await open(page, detailPath(projectId, endpoint.id), NOTE(page))
    // PV's own regions are still there beside the contribution
    await expect(page.getByRole('heading', { name: 'Recent health checks' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Monitoring active' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pause monitoring' })).toBeVisible()
    // the load result reached the component through data.__inject (rendered on the server)
    await expect(page.getByTestId(TILE_LOAD)).toContainText(`endpoint=${endpoint.id}`)
    await expect(page.getByTestId(TILE_LOAD)).toContainText('status=200')
    // the tile is inside PV's history section (the region point is the last child of the section)
    await expect(
      page.locator('section', { hasText: 'Recent health checks' }).getByTestId(TILE)
    ).toHaveCount(1)
    expect(mismatches()).toEqual([])
  })

  test('works: the opted-in action posts through PV fetch and the real API persists exactly one audit row', async ({
    page,
    context,
  }) => {
    const user = await seedOrgOwner(context, 'm3m-action')
    const projectId = await createProject(context, unique('m3m-act'))
    const endpoint = await createServiceEndpointViaApi(context, projectId, {
      name: unique('ep'),
      url: ENDPOINT_URL,
    })
    const before = await countAuditEvents(user.orgId, ENDPOINT_EVENT)
    await open(page, detailPath(projectId, endpoint.id), NOTE(page))
    await NOTE(page).fill(unique('m3m-note'))
    await page.getByRole('button', { name: 'Save health note' }).click()
    await expect.poll(() => countAuditEvents(user.orgId, ENDPOINT_EVENT)).toBe(before + 1)
  })

  test('works: interleaved requests from two users each carry only their own endpoint, in the SSR HTML and in __data.json', async ({
    context,
    browser,
  }) => {
    const otherContext = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      await seedOrgOwner(context, 'm3m-iso-a')
      await seedOrgOwner(otherContext, 'm3m-iso-b')
      const mineProject = await createProject(context, unique('m3m-ia'))
      const theirProject = await createProject(otherContext, unique('m3m-ib'))
      const mine = await createServiceEndpointViaApi(context, mineProject, {
        name: unique('ep'),
        url: ENDPOINT_URL,
      })
      const theirs = await createServiceEndpointViaApi(otherContext, theirProject, {
        name: unique('ep'),
        url: ENDPOINT_URL,
      })
      // Strictly sequential rounds (the real API rate-limits `/auth/me` per caller, ~7 page requests
      // per user per minute): two rounds per path, both users at once within a round.
      const paths = [
        (project: string, id: string) => detailPath(project, id),
        (project: string, id: string) => `${detailPath(project, id)}/__data.json`,
      ]
      const rounds = paths.flatMap((path) => [path, path])
      await rounds.reduce(async (previous, path) => {
        await previous
        const [a, b] = await Promise.all([
          context.request.get(path(mineProject, mine.id)),
          otherContext.request.get(path(theirProject, theirs.id)),
        ])
        const [textA, textB] = [await a.text(), await b.text()]
        expect(textA).toContain(mine.id)
        expect(textA).not.toContain(theirs.id)
        expect(textB).toContain(theirs.id)
        expect(textB).not.toContain(mine.id)
      }, Promise.resolve())
    } finally {
      await otherContext.close()
    }
  })

  test('fails (denied): a foreign endpoint id inside the own project, a foreign project id and a nonexistent id are one and the same not-found page, with no tile load and no 500', async ({
    page,
    context,
    browser,
  }) => {
    await seedOrgOwner(context, 'm3m-owner')
    const own = await createProject(context, unique('m3m-own'))
    const otherContext = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      await seedOrgOwner(otherContext, 'm3m-other')
      const foreignProject = await createProject(otherContext, unique('m3m-fp'))
      const foreignEndpoint = await createServiceEndpointViaApi(otherContext, foreignProject, {
        name: unique('ep'),
        url: ENDPOINT_URL,
      })
      const missing = randomUUID()
      const pages = [
        detailPath(own, foreignEndpoint.id),
        detailPath(foreignProject, foreignEndpoint.id),
        detailPath(own, missing),
      ]
      const statuses: (number | undefined)[] = []
      // One page at a time (rate limit): each step awaits the last.
      await pages.reduce(async (previous, path) => {
        await previous
        const response = await page.goto(path)
        statuses.push(response?.status())
        await expect(page.getByText(NOT_FOUND)).toBeVisible()
        await expect(page.getByTestId(TILE)).toHaveCount(0)
      }, Promise.resolve())
      expect(new Set(statuses).size).toBe(1)
      expect(statuses[0]).toBeLessThan(500)
      // the data endpoint is byte-identical for a foreign and a missing endpoint, no contribution result
      const foreignData = await context.request.get(
        `${detailPath(own, foreignEndpoint.id)}/__data.json`
      )
      const missingData = await context.request.get(`${detailPath(own, missing)}/__data.json`)
      expect(foreignData.status()).toBe(missingData.status())
      const foreignText = await foreignData.text()
      expect(withoutIds(foreignText, foreignEndpoint.id, own)).toBe(
        withoutIds(await missingData.text(), missing, own)
      )
      expect(foreignText).not.toContain('apiStatus')
    } finally {
      await otherContext.close()
    }
  })

  test('fails (rejected): the opted-in action answers a foreign endpoint like a nonexistent one, writes nothing, and rejects anonymous and cross-origin posts', async ({
    request,
    context,
    browser,
  }) => {
    const base = process.env['E2E_BASE_URL'] ?? ''
    const user = await seedOrgOwner(context, 'm3m-deny')
    const own = await createProject(context, unique('m3m-dp'))
    const ownEndpoint = await createServiceEndpointViaApi(context, own, {
      name: unique('ep'),
      url: ENDPOINT_URL,
    })
    const otherContext = await browser.newContext({ baseURL: base })
    try {
      await seedOrgOwner(otherContext, 'm3m-deny-other')
      const foreignProject = await createProject(otherContext, unique('m3m-df'))
      const foreignEndpoint = await createServiceEndpointViaApi(otherContext, foreignProject, {
        name: unique('ep'),
        url: ENDPOINT_URL,
      })
      const before = await countAuditEvents(user.orgId, ENDPOINT_EVENT)
      const post = (path: string, origin = base) =>
        context.request.post(`${path}?/${ACTION}`, {
          form: { title: 'x' },
          headers: { origin },
          maxRedirects: 0,
        })
      const foreignResponse = await post(detailPath(own, foreignEndpoint.id))
      const missingResponse = await post(detailPath(own, randomUUID()))
      expect(foreignResponse.status()).toBe(missingResponse.status())
      expect(foreignResponse.status()).toBeLessThan(500)
      expect(await countAuditEvents(user.orgId, ENDPOINT_EVENT)).toBe(before)
      const crossOrigin = await post(detailPath(own, ownEndpoint.id), 'http://evil.example')
      expect(crossOrigin.status()).toBe(403)
      await expectAnonymousLoginRedirect(
        request,
        `${detailPath(own, ownEndpoint.id)}?/${ACTION}`,
        base
      )
      expect(await countAuditEvents(user.orgId, ENDPOINT_EVENT)).toBe(before)
    } finally {
      await otherContext.close()
    }
  })

  test('fails (denied): an anonymous request to an endpoint page is redirected to /login before any contribution load runs', async ({
    page,
  }) => {
    await page.goto(detailPath(randomUUID(), randomUUID()))
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByTestId(TILE)).toHaveCount(0)
  })
})

test.describe('M3 monitoring region points: endpoint list rows (Story 69.3)', () => {
  test('works: one fill per row inside the Monitoring cell, valid table markup, clean hydration and client navigation list -> detail -> back', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'm3m-list')
    const projectId = await createProject(context, unique('m3m-list'))
    const created = await Promise.all(
      ['a', 'b', 'c'].map((label) =>
        createServiceEndpointViaApi(context, projectId, {
          name: unique(`ep-${label}`),
          url: ENDPOINT_URL,
        })
      )
    )
    await open(
      page,
      `/projects/${projectId}/service-endpoints`,
      page.getByRole('link', { name: 'Add endpoint' })
    )
    await expect(page.getByRole('table')).toBeVisible()
    await expect(page.locator('tbody tr')).toHaveCount(3)
    // one independent fill per row, each inside a cell and carrying its own endpoint id
    await expect(page.locator(`tbody tr td [data-testid="${PILL}"]`)).toHaveCount(3)
    await expect(page.locator(`tr > [data-testid="${PILL}"]`)).toHaveCount(0)
    await Promise.all(
      created.map((endpoint) =>
        expect(
          page.locator(`tbody tr td [data-testid="${PILL}"][data-endpoint="${endpoint.id}"]`)
        ).toHaveCount(1)
      )
    )
    expect(mismatches()).toEqual([])

    await page.evaluate(() => {
      ;(window as unknown as { __navprobe: string }).__navprobe = 'alive'
    })
    const first = created[0]
    if (first === undefined) throw new Error('no endpoint created')
    await page.locator(`a[href$="/service-endpoints/${first.id}"]`).first().click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(detailPath(projectId, first.id))
    await expect(page.getByTestId(TILE_LOAD)).toContainText(`endpoint=${first.id}`)
    await page.goBack()
    await expect(page.locator(`tbody tr td [data-testid="${PILL}"]`)).toHaveCount(3)
    expect(
      await page.evaluate(() => (window as unknown as { __navprobe?: string }).__navprobe)
    ).toBe('alive')
    expect(mismatches()).toEqual([])
  })
})

test.describe('M3 monitoring region points: status page admin (Story 69.3)', () => {
  test('works: the services tile renders for the owner, fed by a load that returns no token, and the public token is nowhere in what the fill received', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'm3m-status')
    const projectId = await createProject(context, unique('m3m-status'))
    await createServiceEndpointViaApi(context, projectId, {
      name: unique('ep'),
      url: ENDPOINT_URL,
    })
    const publicUrl = await enablePublicStatusPageViaUi(page, projectId)
    const token = publicUrl.split('/').at(-1) ?? ''
    expect(token.length).toBeGreaterThan(10)
    await open(
      page,
      `/projects/${projectId}/status-page`,
      page.getByRole('button', { name: 'Save services' })
    )
    // PV's own regions are there, and the tile sits in the "Services shown on the public page" card
    await expect(page.getByRole('heading', { name: 'Shareable link' })).toBeVisible()
    await expect(page.locator('code')).toContainText(token)
    const tile = page.getByTestId(STATUS_TILE)
    await expect(tile).toContainText(`project=${projectId}`)
    await expect(tile).toContainText('status=200')
    await expect(tile).toContainText('endpoints=1')
    // the tile echoes everything the fill received: the public token is not in it
    expect(await tile.getAttribute('data-received')).not.toContain(token)
    expect(await tile.textContent()).not.toContain(token)
    expect(mismatches()).toEqual([])
  })

  test('fails (denied): an anonymous request to the status page admin route is redirected to /login with no tile', async ({
    page,
  }) => {
    await page.goto(`/projects/${randomUUID()}/status-page`)
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByTestId(STATUS_TILE)).toHaveCount(0)
  })
})
