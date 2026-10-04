// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { ComponentProps } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { serializeWithoutNoise } from '$lib/test/dom.js'
import { projectLayoutData } from '$lib/test/page-data.js'
import type { MonitoringAlert } from '$lib/api/monitoring-alerts.js'
import type { ServiceEndpoint, ServiceEndpointDetail } from '$lib/api/service-endpoints.js'
import EndpointListPage from './(app)/projects/[projectId]/service-endpoints/+page.svelte'
import EndpointNewPage from './(app)/projects/[projectId]/service-endpoints/new/+page.svelte'
import EndpointDetailPage from './(app)/projects/[projectId]/service-endpoints/[serviceEndpointId]/+page.svelte'
import StatusPageAdmin from './(app)/projects/[projectId]/status-page/+page.svelte'
import PublicStatusPage from './status/[token]/+page.svelte'

// Story 69.3 AC-2: characterization oracle for the monitoring region extraction. The 68-4 route-render
// oracle renders each route once against a permissive Proxy, which pins none of the states below (the
// endpoint list had no markup test at all). This one renders the five routes of Story 69.3 with explicit
// fixture data for every branch of the regions 69.3 extracts, including the interactive ones (delete,
// pause toggle, history pager, regenerate confirm), and snapshots the normalized markup. The snapshot
// was generated from unmodified `main` BEFORE any region edit and is committed first; it is never
// regenerated. Normalization matches `region-extraction-oracle.test`.

const deleteServiceEndpointMock = vi.hoisted(() => vi.fn())
const updateServiceEndpointMock = vi.hoisted(() => vi.fn())
const getHealthHistoryMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const regenerateMock = vi.hoisted(() => vi.fn())
const enableMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$lib/api/service-endpoints.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/api/service-endpoints.js')>()
  return {
    ...original,
    deleteServiceEndpoint: deleteServiceEndpointMock,
    updateServiceEndpoint: updateServiceEndpointMock,
    getHealthHistory: getHealthHistoryMock,
  }
})
vi.mock('$lib/api/status-page.js', () => ({
  disableStatusPage: vi.fn(),
  enableStatusPage: enableMock,
  regenerateStatusPageToken: regenerateMock,
  updateStatusPageServices: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// The snapshot carries localized times: pin the zone so it does not depend on the test machine.
process.env.TZ = 'UTC'
const NOON = '2026-07-01T12:00:00.000Z'
const LATER = '2026-07-15T12:00:00.000Z'

function normalize(root: Element): string {
  return serializeWithoutNoise(root).replace(/\s+/g, ' ').trim()
}

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const endpointId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function endpoint(overrides: Partial<ServiceEndpointDetail> = {}): ServiceEndpointDetail {
  return {
    id: endpointId,
    orgId: 'org-1',
    projectId,
    name: 'API health',
    url: 'https://api.example.com/health',
    checkFrequencyMinutes: 5,
    downThresholdFailures: 2,
    status: 'healthy',
    consecutiveFailures: 0,
    lastCheckedAt: NOON,
    healthCheckPaused: false,
    healthCheckPausedAt: null,
    healthCheckPausedBy: null,
    createdBy: null,
    createdAt: NOON,
    updatedAt: NOON,
    ...overrides,
  }
}

const alert = (overrides: Partial<MonitoringAlert> = {}): MonitoringAlert => ({
  id: 'al-1',
  alertType: 'service.down',
  severity: 'critical',
  status: 'active',
  episodeKey: 'ep-key',
  serviceEndpointId: endpointId,
  snoozedUntil: null,
  dismissedBy: null,
  dismissedAt: null,
  createdAt: NOON,
  ...overrides,
})

type ListData = ComponentProps<typeof EndpointListPage>['data']
type NewData = ComponentProps<typeof EndpointNewPage>['data']
type DetailData = ComponentProps<typeof EndpointDetailPage>['data']
type StatusAdminData = ComponentProps<typeof StatusPageAdmin>['data']
type PublicData = ComponentProps<typeof PublicStatusPage>['data']

function listData(overrides: Record<string, unknown> = {}): ListData {
  return {
    ...projectLayoutData(),
    projectId,
    orgRole: 'owner',
    endpoints: [endpoint()],
    alerts: [],
    notFound: false,
    ...overrides,
  } as unknown as ListData
}

function renderIt(component: unknown, data: unknown): string {
  const { container } = render(component as never, { props: { data } } as never)
  const html = normalize(container)
  cleanup()
  return html
}

/** Opens the pause/resume dialog and confirms it (the dialog's own button carries the same label). */
async function togglePause(): Promise<void> {
  const trigger = screen.getByRole('button', { name: /^(pause|resume) monitoring$/i })
  const label = trigger.textContent ?? ''
  await fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog')
  const buttons = Array.from(dialog.querySelectorAll('button'))
  const confirm = buttons.find((button) => button.textContent?.trim() === label.trim())
  await fireEvent.click(confirm as HTMLElement)
}

const several = [
  endpoint({ id: 'e1', name: 'Alpha', status: 'healthy', lastCheckedAt: NOON }),
  endpoint({
    id: 'e2',
    name: 'Beta with a rather long name that has to truncate somewhere',
    url: 'https://beta.example.com/a/very/long/path/that/also/truncates/somewhere',
    status: 'down',
    consecutiveFailures: 3,
    lastCheckedAt: LATER,
    healthCheckPaused: true,
    healthCheckPausedAt: LATER,
  }),
  endpoint({ id: 'e3', name: 'Gamma', status: 'degraded', lastCheckedAt: null }),
  endpoint({ id: 'e4', name: 'Delta', status: 'unknown' as never, healthCheckPaused: undefined }),
]

async function listStates(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  out['list zero endpoints'] = renderIt(EndpointListPage as never, listData({ endpoints: [] }))
  out['list several endpoints, one paused (owner)'] = renderIt(
    EndpointListPage as never,
    listData({ endpoints: several })
  )
  out['list several endpoints (viewer, no actions column)'] = renderIt(
    EndpointListPage as never,
    listData({ endpoints: several, orgRole: 'viewer' })
  )
  out['list with active and snoozed alerts'] = renderIt(
    EndpointListPage as never,
    listData({
      endpoints: several,
      alerts: [
        alert(),
        alert({ id: 'al-2', status: 'snoozed', snoozedUntil: LATER, severity: 'warning' }),
        alert({ id: 'al-3', serviceEndpointId: null, alertType: 'service.recovery' }),
      ],
    })
  )
  out['list notFound'] = renderIt(
    EndpointListPage as never,
    listData({ endpoints: [], alerts: [], notFound: true })
  )

  const deleteFails = render(EndpointListPage, {
    props: { data: listData({ endpoints: several }) },
  })
  deleteServiceEndpointMock.mockRejectedValueOnce(new Error('delete boom'))
  await fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0] as HTMLElement)
  await fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))
  await waitFor(() => expect(screen.getByText('delete boom')).toBeTruthy())
  out['list delete error keeps the row'] = normalize(deleteFails.container)
  cleanup()

  const delete404 = render(EndpointListPage, {
    props: { data: listData({ endpoints: several }) },
  })
  deleteServiceEndpointMock.mockRejectedValueOnce(new ApiClientError(404, null, 'gone'))
  await fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0] as HTMLElement)
  await fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))
  await waitFor(() => expect(screen.getByText('gone')).toBeTruthy())
  out['list delete 404 removes the row and shows the error'] = normalize(delete404.container)
  cleanup()

  const deleted = render(EndpointListPage, { props: { data: listData({ endpoints: several }) } })
  deleteServiceEndpointMock.mockResolvedValueOnce(undefined)
  await fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0] as HTMLElement)
  await fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))
  await waitFor(() => expect(screen.queryByText('Alpha')).toBeNull())
  out['list delete success removes the row'] = normalize(deleted.container)
  cleanup()

  const pauseFails = render(EndpointListPage, {
    props: { data: listData({ endpoints: [endpoint()] }) },
  })
  updateServiceEndpointMock.mockRejectedValueOnce(new Error('pause boom'))
  await togglePause()
  await waitFor(() => expect(updateServiceEndpointMock).toHaveBeenCalled())
  await waitFor(() => expect(pauseFails.container.textContent).toContain('pause boom'))
  out['list pause toggle error'] = normalize(pauseFails.container)
  cleanup()

  const pauses = render(EndpointListPage, {
    props: { data: listData({ endpoints: [endpoint()] }) },
  })
  updateServiceEndpointMock.mockResolvedValueOnce(
    endpoint({ healthCheckPaused: true, healthCheckPausedAt: LATER })
  )
  await togglePause()
  await waitFor(() => expect(pauses.container.textContent).toContain('paused'))
  out['list pause toggle success'] = normalize(pauses.container)
  cleanup()
  return out
}

function newStates(): Record<string, string> {
  const base = { ...projectLayoutData(), projectId } as unknown as NewData
  return {
    'new owner (create form)': renderIt(EndpointNewPage as never, { ...base, orgRole: 'owner' }),
    'new member (create form)': renderIt(EndpointNewPage as never, { ...base, orgRole: 'member' }),
    'new viewer (access notice)': renderIt(EndpointNewPage as never, {
      ...base,
      orgRole: 'viewer',
    }),
  }
}

function detailData(overrides: Record<string, unknown> = {}): DetailData {
  return {
    ...projectLayoutData(),
    projectId,
    orgRole: 'owner',
    endpoint: endpoint(),
    notFound: false,
    ...overrides,
  } as unknown as DetailData
}

const historyItem = (n: number, healthy: boolean, reason: string | null = null) => ({
  isHealthy: healthy,
  statusCode: healthy ? 200 : null,
  latencyMs: 40 + n,
  failureReason: reason,
  checkedAt: `2026-07-0${n}T12:00:00.000Z`,
})

async function renderDetail(
  data: DetailData,
  history: unknown
): Promise<{ html: string; container: HTMLElement }> {
  if (history instanceof Error) getHealthHistoryMock.mockRejectedValue(history)
  else getHealthHistoryMock.mockResolvedValue(history)
  const view = render(EndpointDetailPage, { props: { data } })
  await waitFor(() => {
    if (data.endpoint !== null) expect(getHealthHistoryMock).toHaveBeenCalled()
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { html: normalize(view.container), container: view.container }
}

async function detailStates(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const empty = { items: [], page: 1, limit: 20, total: 0, hasNext: false }
  const label = (name: string, html: string) => Object.assign(out, { [name]: html })

  label('detail owner, history empty', (await renderDetail(detailData(), empty)).html)
  cleanup()
  label(
    'detail viewer read-only, history empty',
    (await renderDetail(detailData({ orgRole: 'viewer' }), empty)).html
  )
  cleanup()
  label(
    'detail owner, paused',
    (
      await renderDetail(
        detailData({
          endpoint: endpoint({ healthCheckPaused: true, healthCheckPausedAt: LATER }),
        }),
        empty
      )
    ).html
  )
  cleanup()
  label(
    'detail owner, paused flag absent',
    (
      await renderDetail(
        detailData({ endpoint: endpoint({ healthCheckPaused: undefined }) }),
        empty
      )
    ).html
  )
  cleanup()
  const page1 = {
    items: [
      historyItem(1, true),
      historyItem(2, false, 'timeout'),
      historyItem(3, false, 'ssrf_blocked'),
      historyItem(4, false, 'http_error'),
      historyItem(5, false, 'network_error'),
    ],
    page: 1,
    limit: 5,
    total: 7,
    hasNext: true,
  }
  label('detail history with next page', (await renderDetail(detailData(), page1)).html)
  const more = {
    items: [historyItem(6, true)],
    page: 2,
    limit: 5,
    total: 7,
    hasNext: false,
  }
  getHealthHistoryMock.mockResolvedValueOnce(more)
  await fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull())
  label('detail history after load more', normalize(document.body))
  cleanup()
  label('detail history error', (await renderDetail(detailData(), new Error('history boom'))).html)
  cleanup()
  const notFound = render(EndpointDetailPage, {
    props: { data: detailData({ endpoint: null, notFound: true }) },
  })
  label('detail notFound', normalize(notFound.container))
  cleanup()
  label(
    'detail endpoint missing without notFound flag',
    renderIt(EndpointDetailPage as never, detailData({ endpoint: null, notFound: false }))
  )

  getHealthHistoryMock.mockResolvedValue(empty)
  const pauseFails = render(EndpointDetailPage, { props: { data: detailData() } })
  updateServiceEndpointMock.mockRejectedValueOnce(new Error('detail pause boom'))
  await togglePause()
  await waitFor(() => expect(pauseFails.container.textContent).toContain('detail pause boom'))
  label('detail pause toggle error', normalize(pauseFails.container))
  cleanup()

  const pause404 = render(EndpointDetailPage, { props: { data: detailData() } })
  updateServiceEndpointMock.mockRejectedValueOnce(new ApiClientError(404, null, 'gone'))
  await togglePause()
  await waitFor(() => expect(pause404.container.textContent).toContain('Endpoint not found'))
  label('detail pause toggle 404 turns into not found', normalize(pause404.container))
  cleanup()

  const deleteFails = render(EndpointDetailPage, { props: { data: detailData() } })
  deleteServiceEndpointMock.mockRejectedValueOnce(new Error('detail delete boom'))
  await fireEvent.click(screen.getByRole('button', { name: /delete/i }))
  const confirmDelete = screen.queryByRole('button', { name: /confirm/i })
  if (confirmDelete) await fireEvent.click(confirmDelete)
  await waitFor(() => expect(deleteFails.container.textContent).toContain('detail delete boom'))
  label('detail delete error', normalize(deleteFails.container))
  cleanup()

  const editing = render(EndpointDetailPage, { props: { data: detailData() } })
  await fireEvent.input(screen.getByLabelText('Name'), { target: { value: '' } })
  await fireEvent.submit(editing.container.querySelector('form') as HTMLFormElement)
  label('detail edit validation error', normalize(editing.container))
  cleanup()
  return out
}

const statusEndpoint = (id: string, name: string): ServiceEndpoint => ({
  id,
  name,
  url: `https://${name}.example.com`,
  status: 'healthy',
  lastCheckedAt: null,
  healthCheckPaused: false,
  healthCheckPausedAt: null,
  healthCheckPausedBy: null,
})

function adminData(overrides: Record<string, unknown> = {}): StatusAdminData {
  return {
    ...projectLayoutData(),
    projectId,
    origin: 'https://vault.example.com',
    canManage: true,
    config: { enabled: true, token: 'fixed-fake-token-1', services: [] },
    capabilities: {},
    serviceEndpoints: [
      statusEndpoint('svc-1', 'API'),
      statusEndpoint('svc-2', 'Database'),
      statusEndpoint('svc-3', 'Worker'),
    ],
    ...overrides,
  } as unknown as StatusAdminData
}

async function statusAdminStates(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const r = (name: string, data: StatusAdminData) =>
    Object.assign(out, { [name]: renderIt(StatusPageAdmin as never, data) })
  r('admin read-only (not canManage)', adminData({ canManage: false }))
  r('admin disabled', adminData({ config: { enabled: false } }))
  r(
    'admin disabled, capability denied',
    adminData({
      config: { enabled: false },
      capabilities: { 'monitoring.public-status-page': false },
    })
  )
  r('admin enabled with public url', adminData())
  r(
    'admin enabled legacy token',
    adminData({ config: { enabled: true, legacyToken: true, services: [] } })
  )
  r('admin enabled, no token, not legacy', adminData({ config: { enabled: true, services: [] } }))
  r('admin enabled, zero endpoints', adminData({ serviceEndpoints: [] }))
  r(
    'admin enabled, services selected',
    adminData({
      config: {
        enabled: true,
        token: 'fixed-fake-token-1',
        services: [
          { serviceId: 'svc-2', displayName: 'DB public' },
          { serviceId: 'svc-1', displayName: 'API public' },
        ],
      },
    })
  )
  r(
    'admin enabled, one service selected',
    adminData({
      config: {
        enabled: true,
        token: 'fixed-fake-token-1',
        services: [{ serviceId: 'svc-3', displayName: 'Worker public' }],
      },
    })
  )
  r(
    'admin enabled, capability denied',
    adminData({ capabilities: { 'monitoring.public-status-page': false } })
  )

  const enabling = render(StatusPageAdmin, {
    props: { data: adminData({ config: { enabled: false } }) },
  })
  enableMock.mockRejectedValueOnce(new Error('enable boom'))
  await fireEvent.click(screen.getByRole('button', { name: 'Enable public status page' }))
  await waitFor(() => expect(enabling.container.textContent).toContain('enable boom'))
  out['admin enable error'] = normalize(enabling.container)
  cleanup()

  const enabled = render(StatusPageAdmin, {
    props: { data: adminData({ config: { enabled: false } }) },
  })
  enableMock.mockResolvedValueOnce({ token: 'fixed-fake-token-2' })
  await fireEvent.click(screen.getByRole('button', { name: 'Enable public status page' }))
  await waitFor(() => expect(enabled.container.textContent).toContain('fixed-fake-token-2'))
  out['admin enabled just now, fresh token'] = normalize(enabled.container)
  cleanup()

  const regenerating = render(StatusPageAdmin, { props: { data: adminData() } })
  await fireEvent.click(screen.getByRole('button', { name: 'Regenerate link' }))
  out['admin regenerate confirm step'] = normalize(regenerating.container)
  regenerateMock.mockRejectedValueOnce(new Error('regen boom'))
  await fireEvent.click(screen.getByRole('button', { name: /Confirm/ }))
  await waitFor(() => expect(regenerating.container.textContent).toContain('regen boom'))
  out['admin regenerate error'] = normalize(regenerating.container)
  cleanup()
  return out
}

function publicStates(): Record<string, string> {
  const page = (services: unknown[]) => ({ statusPage: { services } }) as unknown as PublicData
  return {
    'public valid with services': renderIt(
      PublicStatusPage as never,
      page([
        { displayName: 'API', status: 'healthy', lastCheckedAt: NOON },
        { displayName: 'Database', status: 'degraded', lastCheckedAt: LATER },
        { displayName: 'Worker', status: 'down', lastCheckedAt: NOON },
        { displayName: 'Never checked', status: 'healthy', lastCheckedAt: null },
      ])
    ),
    'public valid with no services': renderIt(PublicStatusPage as never, page([])),
    'public invalid token': renderIt(PublicStatusPage as never, { statusPage: null }),
  }
}

describe('monitoring region extraction oracle (Story 69.3 AC-2)', () => {
  it('renders the five monitoring routes exactly as before the extraction', async () => {
    const result = {
      ...(await listStates()),
      ...newStates(),
      ...(await detailStates()),
      ...(await statusAdminStates()),
      ...publicStates(),
    }
    await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(
      './monitoring-extraction.snapshot.json'
    )
    expect(Object.keys(result).length).toBeGreaterThanOrEqual(35)
  })
})
