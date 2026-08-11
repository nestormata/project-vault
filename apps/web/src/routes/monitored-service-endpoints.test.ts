import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const createServiceEndpointMock = vi.hoisted(() => vi.fn())
const updateServiceEndpointMock = vi.hoisted(() => vi.fn())
const deleteServiceEndpointMock = vi.hoisted(() => vi.fn())
const getHealthHistoryMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({ goto: gotoMock }))

vi.mock('$lib/api/service-endpoints.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/api/service-endpoints.js')>()
  return {
    ...original,
    createServiceEndpoint: createServiceEndpointMock,
    updateServiceEndpoint: updateServiceEndpointMock,
    deleteServiceEndpoint: deleteServiceEndpointMock,
    getHealthHistory: getHealthHistoryMock,
  }
})

import ServiceEndpointsListPage from './(app)/projects/[projectId]/service-endpoints/+page.svelte'
import NewServiceEndpointPage from './(app)/projects/[projectId]/service-endpoints/new/+page.svelte'
import ServiceEndpointDetailPage from './(app)/projects/[projectId]/service-endpoints/[serviceEndpointId]/+page.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const serviceEndpointId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function makeEndpoint(overrides: Record<string, unknown> = {}) {
  return {
    id: serviceEndpointId,
    orgId: 'org-1',
    projectId,
    name: 'API health',
    url: 'https://api.example.com/health',
    checkFrequencyMinutes: 5,
    downThresholdFailures: 2,
    status: 'healthy' as const,
    consecutiveFailures: 0,
    lastCheckedAt: null,
    healthCheckPaused: false,
    healthCheckPausedAt: null,
    healthCheckPausedBy: null,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('/projects/:projectId/service-endpoints list (AC-E1/E2, AC-F1 embedded panel)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    deleteServiceEndpointMock.mockReset()
    updateServiceEndpointMock.mockReset()
  })
  afterEach(() => cleanup())

  it('AC-E1 viewer: empty state, no create control', () => {
    render(ServiceEndpointsListPage, {
      props: {
        data: { projectId, orgRole: 'viewer', endpoints: [], alerts: [], notFound: false },
      },
    })
    expect(screen.getByText('No service endpoints registered yet.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Add endpoint' })).toBeNull()
  })

  it('AC-E2: renders name/status badge/lastCheckedAt/checkFrequencyMinutes/downThresholdFailures', () => {
    render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'viewer',
          endpoints: [makeEndpoint()],
          alerts: [],
          notFound: false,
        },
      },
    })
    expect(screen.getByText('API health')).toBeTruthy()
    expect(screen.getByText('healthy')).toBeTruthy()
    expect(screen.getByText(/every 5 min/i)).toBeTruthy()
    expect(screen.getByText(/2 consecutive/i)).toBeTruthy()
  })

  it('shows paused monitoring and the last-known status without relying on color', () => {
    render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'viewer',
          endpoints: [makeEndpoint({ status: 'down', healthCheckPaused: true })],
          alerts: [],
          notFound: false,
        },
      },
    })
    expect(screen.getByText('Monitoring paused')).toBeTruthy()
    expect(screen.getByText('Down', { exact: true })).toBeTruthy()
  })

  it('AC-F1: embeds the ActiveAlertsPanel with the loaded alerts', () => {
    render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member',
          endpoints: [makeEndpoint()],
          alerts: [
            {
              id: 'alert-1',
              alertType: 'service.down',
              severity: 'critical',
              status: 'active',
              episodeKey: 'ep-1',
              serviceEndpointId,
              snoozedUntil: null,
              dismissedBy: null,
              dismissedAt: null,
              createdAt: '2026-07-01T00:00:00.000Z',
            },
          ],
          notFound: false,
        },
      },
    })
    expect(screen.getByText('Active alerts')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Snooze 1 hour/i })).toBeTruthy()
  })

  it('two-step delete removes the row without a full reload, disclosing the alert-resolution effect (AC-E5)', async () => {
    deleteServiceEndpointMock.mockResolvedValue(undefined)
    render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member',
          endpoints: [makeEndpoint()],
          alerts: [],
          notFound: false,
        },
      },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    // AC-E5/code-review finding: the list page's delete control must carry the same
    // alert-resolution disclosure as the detail page's, not a bare "Confirm delete?".
    const confirmButton = screen.getByRole('button', { name: /resolve any active alerts/i })
    await fireEvent.click(confirmButton)
    await waitFor(() =>
      expect(deleteServiceEndpointMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        serviceEndpointId
      )
    )
    expect(screen.getByText('No service endpoints registered yet.')).toBeTruthy()
  })

  it('treats a raced 404 delete as removed while showing the API message', async () => {
    deleteServiceEndpointMock.mockRejectedValue(
      new ApiClientError(404, { message: 'Endpoint no longer exists' }, 'Endpoint no longer exists')
    )
    render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member',
          endpoints: [makeEndpoint()],
          alerts: [],
          notFound: false,
        },
      },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))
    expect(await screen.findByText(/no service endpoints/i)).toBeTruthy()
  })

  it.each([
    [new Error('delete exploded'), /delete exploded/i],
    [{ reason: 'unknown' }, /could not delete endpoint/i],
  ])('keeps the row and maps delete failures', async (failure, expected) => {
    deleteServiceEndpointMock.mockRejectedValue(failure)
    render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member',
          endpoints: [makeEndpoint()],
          alerts: [],
          notFound: false,
        },
      },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(expected)
    expect(screen.getByText('API health')).toBeTruthy()
  })

  it('AC-1 row layout: uses the shared AssetTable shell with an sr-only caption and labelled column headers', () => {
    const { container } = render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member',
          endpoints: [makeEndpoint()],
          alerts: [],
          notFound: false,
        },
      },
    })
    const table = container.querySelector('table')
    expect(table).toBeTruthy()
    // The bespoke <ul>/<li> grid rows are gone — the list is a real table like its peers.
    expect(container.querySelector('li')).toBeNull()

    const caption = table?.querySelector('caption')
    expect(caption?.textContent).toMatch(/service endpoints/i)
    expect(caption?.className).toMatch(/\bsr-only\b/)

    const headers = Array.from(table?.querySelectorAll('thead th') ?? [])
    expect(headers.map((th) => th.textContent?.trim())).toEqual([
      'Endpoint',
      'Status',
      'Schedule',
      'Monitoring',
      'Actions',
    ])
    for (const th of headers) expect(th.getAttribute('scope')).toBe('col')
  })

  it('AC-1 row layout: manager rows expose one <td> per <th>, including the actions cell', () => {
    const { container } = render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member',
          endpoints: [makeEndpoint({ healthCheckPaused: false })],
          alerts: [],
          notFound: false,
        },
      },
    })
    const headerCount = container.querySelectorAll('thead th').length
    const rows = container.querySelectorAll('tbody tr')
    expect(rows.length).toBe(1)
    expect(headerCount).toBe(5)
    for (const row of rows) expect(row.querySelectorAll('td').length).toBe(headerCount)
  })

  it('AC-3 row layout: a viewer loses the Actions column entirely, header and cells together', () => {
    const { container } = render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'viewer',
          endpoints: [makeEndpoint({ healthCheckPaused: true })],
          alerts: [],
          notFound: false,
        },
      },
    })
    const headers = Array.from(container.querySelectorAll('thead th'))
    expect(headers.map((th) => th.textContent?.trim())).toEqual([
      'Endpoint',
      'Status',
      'Schedule',
      'Monitoring',
    ])
    const row = container.querySelector('tbody tr')
    expect(row?.querySelectorAll('td').length).toBe(4)
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.queryByRole('button', { name: /monitoring$/i })).toBeNull()
    // Read-only pause *state* is still legible without any mutation control.
    expect(screen.getByText('Monitoring paused')).toBeTruthy()
  })

  it('AC-2 row layout: a missing pause flag still leaves the monitoring <td> in place', () => {
    const { container } = render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'viewer',
          endpoints: [makeEndpoint({ healthCheckPaused: undefined })],
          alerts: [],
          notFound: false,
        },
      },
    })
    const cells = container.querySelectorAll('tbody tr td')
    expect(cells.length).toBe(4)
    expect(cells[3]?.textContent?.trim()).toBe('')
  })

  it('AC-2 row layout: long names and URLs sit in a bounded truncating container', () => {
    const longName = 'N'.repeat(200)
    const longUrl = `https://example.com/${'p'.repeat(280)}`
    const { container } = render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member',
          endpoints: [makeEndpoint({ name: longName, url: longUrl })],
          alerts: [],
          notFound: false,
        },
      },
    })
    const nameCell = container.querySelector('tbody tr td')
    const bounded = nameCell?.querySelector('div')
    expect(bounded?.className).toMatch(/max-w-\[/)
    const truncated = Array.from(bounded?.querySelectorAll('p.truncate') ?? [])
    expect(truncated.map((p) => p.getAttribute('title'))).toEqual([longName, longUrl])
    // Wide content scrolls inside the card rather than pushing the page sideways.
    expect(container.querySelector('.overflow-x-auto')).toBeTruthy()
  })

  it('AC-2 row layout: every row keeps the same cell count across mixed content and pause states', () => {
    const { container } = render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member',
          endpoints: [
            makeEndpoint({ id: 'e-1', name: 'Short', healthCheckPaused: undefined }),
            makeEndpoint({
              id: 'e-2',
              name: 'A much longer name used to check that columns stay aligned',
              healthCheckPaused: true,
              healthCheckPausedAt: '2026-07-01T00:00:00.000Z',
            }),
            makeEndpoint({ id: 'e-3', name: 'Mid length name', healthCheckPaused: false }),
          ],
          alerts: [],
          notFound: false,
        },
      },
    })
    const rows = container.querySelectorAll('tbody tr')
    expect(rows.length).toBe(3)
    for (const row of rows) expect(row.querySelectorAll('td').length).toBe(5)
    // Only the paused row carries the amber tint — the at-a-glance signal the old per-row card
    // used to provide. Nothing else asserted this, so a Tailwind cleanup could have dropped it
    // with the whole suite still green.
    expect(rows[0]?.className).not.toMatch(/\bbg-amber-50\b/)
    expect(rows[1]?.className).toMatch(/\bbg-amber-50\b/)
    expect(rows[2]?.className).not.toMatch(/\bbg-amber-50\b/)
  })

  it('AC-2 row layout: a paused row reports pause state, last-known status, and the paused timestamp', () => {
    render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'viewer',
          endpoints: [
            makeEndpoint({
              status: 'degraded',
              healthCheckPaused: true,
              healthCheckPausedAt: '2026-07-01T00:00:00.000Z',
            }),
          ],
          alerts: [],
          notFound: false,
        },
      },
    })
    expect(screen.getByText('Monitoring paused')).toBeTruthy()
    expect(screen.getByText('Degraded', { exact: true })).toBeTruthy()
    expect(screen.getByText(/^Paused /)).toBeTruthy()
  })

  // 'unknown' is off-contract for the API enum; it is here to prove the badge degrades to a
  // neutral class rather than stringifying `undefined` if that contract is ever broken.
  it.each([
    ['healthy', 'bg-emerald-100'],
    ['degraded', 'bg-amber-100'],
    ['down', 'bg-red-100'],
    ['unknown', 'bg-slate-100'],
  ])(
    'AC-2 row layout: the %s status badge renders the literal word with the %s class',
    (status, expectedClass) => {
      const { container } = render(ServiceEndpointsListPage, {
        props: {
          data: {
            projectId,
            orgRole: 'viewer',
            endpoints: [makeEndpoint({ status })],
            alerts: [],
            notFound: false,
          },
        },
      })
      const statusCell = container.querySelectorAll('tbody tr td')[1]
      const badge = statusCell?.querySelector('span')
      expect(badge?.textContent?.trim()).toBe(status)
      expect(badge?.className).toContain(expectedClass)
      expect(badge?.className).not.toMatch(/undefined/)
    }
  )

  it('AC-4 row layout: the Edit link and the delete/pause buttons are keyboard reachable with accessible names', () => {
    render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member',
          endpoints: [makeEndpoint({ healthCheckPaused: false })],
          alerts: [],
          notFound: false,
        },
      },
    })
    const editLink = screen.getByRole('link', { name: 'Edit' })
    expect(editLink.getAttribute('href')).toBe(
      `/projects/${projectId}/service-endpoints/${serviceEndpointId}`
    )
    const pauseButton = screen.getByRole('button', { name: 'Pause monitoring' })
    const deleteButton = screen.getByRole('button', { name: 'Delete' })
    for (const control of [editLink, pauseButton, deleteButton]) {
      ;(control as HTMLElement).focus()
      expect(document.activeElement).toBe(control)
    }
  })

  it('AC-3 row layout: a rejected pause keeps its error inside its own row', async () => {
    updateServiceEndpointMock.mockRejectedValue(
      new ApiClientError(403, { message: 'Forbidden' }, 'Forbidden')
    )
    const { container } = render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member',
          endpoints: [
            makeEndpoint({ id: 'e-1', name: 'First endpoint', healthCheckPaused: false }),
            makeEndpoint({ id: 'e-2', name: 'Second endpoint', healthCheckPaused: false }),
          ],
          alerts: [],
          notFound: false,
        },
      },
    })
    const rows = Array.from(container.querySelectorAll('tbody tr'))
    await fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: /pause/i }))
    await fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Pause monitoring' })
    )
    await waitFor(() =>
      expect(within(rows[1] as HTMLElement).getByRole('alert').textContent).toMatch(/permission/i)
    )
    expect(within(rows[0] as HTMLElement).queryByRole('alert')).toBeNull()
  })

  it('AC-5 row layout: only the loaded project’s endpoints render, with links scoped to that project', () => {
    const { container } = render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member',
          endpoints: [makeEndpoint({ id: 'e-1', name: 'Only mine' })],
          alerts: [],
          notFound: false,
        },
      },
    })
    expect(container.querySelectorAll('tbody tr').length).toBe(1)
    for (const link of screen.getAllByRole('link', { name: 'Edit' })) {
      expect(link.getAttribute('href')).toMatch(
        new RegExp(`^/projects/${projectId}/service-endpoints/`)
      )
    }
  })

  it('renders project-not-found and all endpoint status/date variants', () => {
    render(ServiceEndpointsListPage, {
      props: {
        data: { projectId, orgRole: 'member', endpoints: [], alerts: [], notFound: true },
      },
    })
    expect(screen.getByText(/project.*not found/i)).toBeTruthy()
    cleanup()
    render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'viewer',
          endpoints: [
            makeEndpoint({ id: 'e-1', status: 'degraded', lastCheckedAt: '2026-07-01T00:00:00Z' }),
            makeEndpoint({ id: 'e-2', status: 'down' }),
            makeEndpoint({ id: 'e-3', status: 'unknown' }),
          ],
          alerts: [],
          notFound: false,
        },
      },
    })
    expect(screen.getByText('degraded')).toBeTruthy()
    expect(screen.getByText('down')).toBeTruthy()
    expect(screen.getByText('unknown')).toBeTruthy()
  })
})

describe('/projects/:projectId/service-endpoints/new (AC-E3)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    createServiceEndpointMock.mockReset()
  })
  afterEach(() => cleanup())

  it('happy path: name+url only (frequency/threshold left at defaults 5/2)', async () => {
    createServiceEndpointMock.mockResolvedValue(makeEndpoint())
    render(NewServiceEndpointPage, { props: { data: { projectId, orgRole: 'member' } } })

    await fireEvent.input(screen.getByLabelText(/^Name$/i), { target: { value: 'API health' } })
    await fireEvent.input(screen.getByLabelText(/URL/i), {
      target: { value: 'https://api.example.com/health' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Create endpoint' }))

    await waitFor(() =>
      expect(createServiceEndpointMock).toHaveBeenCalledWith(expect.anything(), projectId, {
        name: 'API health',
        url: 'https://api.example.com/health',
        checkFrequencyMinutes: 5,
        downThresholdFailures: 2,
      })
    )
    expect(gotoMock).toHaveBeenCalledWith(
      `/projects/${projectId}/service-endpoints/${serviceEndpointId}`
    )
  })

  it('edge: non-default frequency/threshold are submitted', async () => {
    createServiceEndpointMock.mockResolvedValue(makeEndpoint())
    render(NewServiceEndpointPage, { props: { data: { projectId, orgRole: 'member' } } })

    await fireEvent.input(screen.getByLabelText(/^Name$/i), { target: { value: 'API health' } })
    await fireEvent.input(screen.getByLabelText(/URL/i), {
      target: { value: 'https://api.example.com/health' },
    })
    await fireEvent.change(screen.getByLabelText(/Check frequency/i), { target: { value: '1' } })
    await fireEvent.input(screen.getByLabelText(/Failures before/i), { target: { value: '1' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Create endpoint' }))

    await waitFor(() =>
      expect(createServiceEndpointMock).toHaveBeenCalledWith(expect.anything(), projectId, {
        name: 'API health',
        url: 'https://api.example.com/health',
        checkFrequencyMinutes: 1,
        downThresholdFailures: 1,
      })
    )
  })

  it('failure: endpoint cap reached surfaces the server message verbatim', async () => {
    createServiceEndpointMock.mockRejectedValue(
      new ApiClientError(
        422,
        {
          code: 'service_endpoint_limit_reached',
          message: 'This project has reached its maximum of 25 monitored endpoints',
        },
        'This project has reached its maximum of 25 monitored endpoints'
      )
    )
    render(NewServiceEndpointPage, { props: { data: { projectId, orgRole: 'member' } } })
    await fireEvent.input(screen.getByLabelText(/^Name$/i), { target: { value: 'API health' } })
    await fireEvent.input(screen.getByLabelText(/URL/i), {
      target: { value: 'https://api.example.com/health' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Create endpoint' }))

    expect(
      await screen.findByText('This project has reached its maximum of 25 monitored endpoints')
    ).toBeTruthy()
  })

  it('failure: SSRF rejection surfaces the server message verbatim, no client-side pre-validation', async () => {
    createServiceEndpointMock.mockRejectedValue(
      new ApiClientError(
        422,
        {
          code: 'url_not_allowed',
          message:
            'URL resolves to a private, loopback, or reserved address and cannot be monitored',
        },
        'URL resolves to a private, loopback, or reserved address and cannot be monitored'
      )
    )
    render(NewServiceEndpointPage, { props: { data: { projectId, orgRole: 'member' } } })
    await fireEvent.input(screen.getByLabelText(/^Name$/i), { target: { value: 'Metadata' } })
    await fireEvent.input(screen.getByLabelText(/URL/i), {
      target: { value: 'http://169.254.169.254/' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Create endpoint' }))

    expect(
      await screen.findByText(
        'URL resolves to a private, loopback, or reserved address and cannot be monitored'
      )
    ).toBeTruthy()
  })
})

describe('/projects/:projectId/service-endpoints/:serviceEndpointId (AC-E4/E5/E6)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    updateServiceEndpointMock.mockReset()
    getHealthHistoryMock.mockReset()
    getHealthHistoryMock.mockResolvedValue({
      items: [],
      page: 1,
      limit: 50,
      total: 0,
      hasNext: false,
    })
  })
  afterEach(() => cleanup())

  it('AC-E4: the url field starts blank (fresh entry), not pre-filled with the redacted value', () => {
    render(ServiceEndpointDetailPage, {
      props: { data: { projectId, orgRole: 'member', endpoint: makeEndpoint(), notFound: false } },
    })
    const urlInput = screen.getByLabelText(/New URL/i) as HTMLInputElement
    expect(urlInput.value).toBe('')
  })

  it('AC-E4: PATCHes only the changed field (re-URL only)', async () => {
    updateServiceEndpointMock.mockResolvedValue(
      makeEndpoint({ url: 'https://api.example.com/healthz' })
    )
    render(ServiceEndpointDetailPage, {
      props: { data: { projectId, orgRole: 'member', endpoint: makeEndpoint(), notFound: false } },
    })

    await fireEvent.input(screen.getByLabelText(/New URL/i), {
      target: { value: 'https://api.example.com/healthz' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(updateServiceEndpointMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        serviceEndpointId,
        { url: 'https://api.example.com/healthz' }
      )
    )
  })

  it('AC-E5: delete confirmation copy mentions resolving active alerts', () => {
    render(ServiceEndpointDetailPage, {
      props: { data: { projectId, orgRole: 'member', endpoint: makeEndpoint(), notFound: false } },
    })
    expect(screen.getByText(/resolve any active alerts/i)).toBeTruthy()
  })

  it('AC-E6: renders health history rows (checkedAt/isHealthy/statusCode/latencyMs/failureReason)', async () => {
    getHealthHistoryMock.mockResolvedValue({
      items: [
        {
          isHealthy: false,
          statusCode: null,
          latencyMs: 0,
          failureReason: 'ssrf_blocked',
          checkedAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      page: 1,
      limit: 50,
      total: 1,
      hasNext: false,
    })
    render(ServiceEndpointDetailPage, {
      props: { data: { projectId, orgRole: 'member', endpoint: makeEndpoint(), notFound: false } },
    })

    expect(await screen.findByText('Blocked (unsafe address)')).toBeTruthy()
  })

  it('failure: not-found shows the not-found notice', () => {
    render(ServiceEndpointDetailPage, {
      props: { data: { projectId, orgRole: 'member', endpoint: null, notFound: true } },
    })
    expect(screen.getByText(/endpoint.*not found/i)).toBeTruthy()
  })

  it('code-review finding (AC-I1): viewer sees a read-only view, not disabled-but-visible form inputs', () => {
    render(ServiceEndpointDetailPage, {
      props: { data: { projectId, orgRole: 'viewer', endpoint: makeEndpoint(), notFound: false } },
    })
    expect(screen.queryByLabelText(/^Name$/i)).toBeNull()
    expect(screen.queryByLabelText(/New URL/i)).toBeNull()
    expect(screen.queryByLabelText(/Check frequency/i)).toBeNull()
    expect(screen.queryByLabelText(/Failures before/i)).toBeNull()
    expect(screen.getByText('Checked every 5 min')).toBeTruthy()
    expect(screen.getByText('Down after 2 consecutive failures')).toBeTruthy()
  })
})
