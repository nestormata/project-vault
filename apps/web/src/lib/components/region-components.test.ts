import { cleanup, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { sampleProject, sampleProjectDashboard, sampleProjectSummary } from '$lib/test/fixtures.js'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.1 AC-1 / AC-5: every extracted region component renders its own point, forwards the page's
// `__inject` map to it (undefined and null-less maps render components with `data = null` and never
// throw), and hands a contribution only the props listed for that point in the registry.

vi.mock('$lib/api/service-endpoints.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/api/service-endpoints.js')>()),
  getHealthHistory: vi.fn(async () => ({
    items: [],
    page: 1,
    limit: 20,
    total: 0,
    hasNext: false,
  })),
}))

const pageState = vi.hoisted(() => ({
  route: { id: '/(app)/test' } as { id: string | null },
  params: {} as Record<string, string>,
}))
vi.mock('$app/state', () => ({ page: pageState }))

const POINTS = [
  'project.detail.summary',
  'project.detail.export',
  'project.detail.tiles',
  'project.detail.not-found',
  'dashboard.home.vault-sealed',
  'dashboard.home.org-summary',
  'dashboard.home.project-summary',
  'dashboard.home.rotations',
  'dashboard.home.activity',
  'dashboard.home.monitoring',
  'dashboard.home.suggested-actions',
  'dashboard.home.summary-unavailable',
  'dashboard.home.empty',
  'project.service-endpoints.header',
  'project.service-endpoints.alerts',
  'project.service-endpoints.table',
  'project.service-endpoints.row',
  'project.service-endpoints.empty',
  'project.service-endpoints.not-found',
  'project.service-endpoints-new.header',
  'project.service-endpoints-new.form',
  'project.service-endpoints-detail.title',
  'project.service-endpoints-detail.pause',
  'project.service-endpoints-detail.settings',
  'project.service-endpoints-detail.history',
  'project.service-endpoints-detail.delete',
  'project.service-endpoints-detail.not-found',
  'project.status-page.header',
  'project.status-page.read-only',
  'project.status-page.disabled',
  'project.status-page.link',
  'project.status-page.services',
  'status.detail.header',
  'status.detail.services',
  'status.detail.unavailable',
] as const

type Loader = () => Promise<{ default: Component<never> }>

const project = sampleProject({ id: 'p1', name: 'Payments API', memberCount: 2 })
const summary = sampleProjectSummary({ id: 'p1', name: 'Payments API' })
const dashboard = sampleProjectDashboard({
  credentialStats: { active: 1, expiringSoon: 2, expired: 0 },
  monitoredServiceHealth: { healthy: 1, degraded: 0, down: 0 },
  upcomingRotations: [{ credentialId: 'c1', credentialName: 'Key', status: 'pending' }],
  suggestedActions: ['add_credential'],
})
const projects = { items: [summary] }
const orgDashboard = {
  totalCredentials: 3,
  expiringWithin30Days: { count: 0, items: [] },
  unresolvedAlertCount: 0,
}
const cards = {
  certificates: { status: 'ready', count: 0 },
  domains: { status: 'ready', count: 0 },
}

// Story 69.3 fixtures: the monitoring pages' own data.
const orgRole = 'owner' as const
const noop = () => undefined
const endpoint = {
  id: 'e1',
  orgId: 'o1',
  projectId: 'p1',
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
}
const serviceEndpoints = [
  {
    id: 'e1',
    name: 'API health',
    url: 'https://api.example.com/health',
    status: 'healthy' as const,
    lastCheckedAt: null,
    healthCheckPaused: false,
    healthCheckPausedAt: null,
    healthCheckPausedBy: null,
  },
]
const listProps = { project, orgRole, endpoints: [endpoint] }
const statusPageProps = { project, capabilities: {}, serviceEndpoints }
const FAKE_PUBLIC_URL = 'https://vault.example.com/status/fixed-fake-token'

interface Case {
  /** The region's own point. */
  point: (typeof POINTS)[number]
  load: Loader
  props: Record<string, unknown>
  /** What a contribution at the point receives besides `routeId` and `params`. */
  receives: string[]
}

const CASES: Case[] = [
  {
    point: 'project.detail.summary',
    load: () => import('$lib/components/projects/ProjectSummaryCard.svelte'),
    props: { project },
    receives: ['project'],
  },
  {
    point: 'project.detail.export',
    load: () => import('$lib/components/projects/ProjectExportPanel.svelte'),
    props: { project },
    receives: ['project'],
  },
  {
    point: 'project.detail.tiles',
    load: () => import('$lib/components/projects/ProjectStatTiles.svelte'),
    props: { project, dashboard },
    receives: ['project'],
  },
  {
    point: 'project.detail.not-found',
    load: () => import('$lib/components/projects/ProjectNotFound.svelte'),
    props: {},
    receives: ['project'],
  },
  {
    point: 'dashboard.home.vault-sealed',
    load: () => import('$lib/components/dashboard/DashboardVaultSealed.svelte'),
    props: {},
    receives: [],
  },
  {
    point: 'dashboard.home.org-summary',
    load: () => import('$lib/components/dashboard/OrgSummarySection.svelte'),
    props: { orgDashboard },
    receives: [],
  },
  {
    point: 'dashboard.home.project-summary',
    load: () => import('$lib/components/dashboard/DashboardProjectSummaryCard.svelte'),
    props: { project: summary, projects, dashboard },
    receives: ['project'],
  },
  {
    point: 'dashboard.home.rotations',
    load: () => import('$lib/components/dashboard/UpcomingRotationsSection.svelte'),
    props: { project: summary, rotations: dashboard.upcomingRotations },
    receives: ['project'],
  },
  {
    point: 'dashboard.home.activity',
    load: () => import('$lib/components/dashboard/RecentActivitySection.svelte'),
    props: { project: summary, events: [] },
    receives: ['project'],
  },
  {
    point: 'dashboard.home.monitoring',
    load: () => import('$lib/components/dashboard/DashboardMonitoringSection.svelte'),
    props: { project: summary, hasCredentials: true, hasServices: true, ...cards },
    receives: ['project'],
  },
  {
    point: 'dashboard.home.suggested-actions',
    load: () => import('$lib/components/dashboard/SuggestedActionsSection.svelte'),
    props: { project: summary, actions: dashboard.suggestedActions },
    receives: ['project'],
  },
  {
    point: 'dashboard.home.summary-unavailable',
    load: () => import('$lib/components/dashboard/DashboardSummaryUnavailable.svelte'),
    props: { project: summary, projects },
    receives: ['project'],
  },
  {
    point: 'dashboard.home.empty',
    load: () => import('$lib/components/dashboard/DashboardEmptyRegion.svelte'),
    props: {},
    receives: [],
  },
  // Story 69.3: the monitoring regions.
  {
    point: 'project.service-endpoints.header',
    load: () => import('$lib/components/monitoring/ServiceEndpointsHeader.svelte'),
    props: { ...listProps, projectId: 'p1', canManage: true },
    receives: ['endpoints', 'orgRole', 'project'],
  },
  {
    point: 'project.service-endpoints.alerts',
    load: () => import('$lib/components/monitoring/ServiceEndpointsAlerts.svelte'),
    props: { ...listProps, alerts: [], endpointNames: [], projectId: 'p1' },
    receives: ['endpoints', 'orgRole', 'project'],
  },
  {
    point: 'project.service-endpoints.table',
    load: () => import('$lib/components/monitoring/ServiceEndpointsTable.svelte'),
    props: {
      ...listProps,
      projectId: 'p1',
      canManage: true,
      deleteError: null,
      pauseSubmittingId: null,
      pauseErrors: {},
      onDelete: noop,
      onPauseToggle: () => true,
    },
    receives: ['endpoints', 'orgRole', 'project'],
  },
  {
    point: 'project.service-endpoints.row',
    load: () => import('$lib/components/monitoring/ServiceEndpointRow.svelte'),
    props: {
      project,
      endpoint,
      orgRole,
      projectId: 'p1',
      canManage: true,
      pauseSubmitting: false,
      pauseError: null,
      onPauseToggle: () => true,
      onDelete: noop,
    },
    receives: ['endpoint', 'orgRole', 'project'],
  },
  {
    point: 'project.service-endpoints.empty',
    load: () => import('$lib/components/monitoring/ServiceEndpointsEmpty.svelte'),
    props: listProps,
    receives: ['endpoints', 'orgRole', 'project'],
  },
  {
    point: 'project.service-endpoints.not-found',
    load: () => import('$lib/components/monitoring/ServiceEndpointsNotFound.svelte'),
    props: { ...listProps, project: null },
    receives: ['endpoints', 'orgRole', 'project'],
  },
  {
    point: 'project.service-endpoints-new.header',
    load: () => import('$lib/components/monitoring/ServiceEndpointNewHeader.svelte'),
    props: { project, orgRole },
    receives: ['orgRole', 'project'],
  },
  {
    point: 'project.service-endpoints-new.form',
    load: () => import('$lib/components/monitoring/ServiceEndpointCreateForm.svelte'),
    props: { project, orgRole, projectId: 'p1' },
    receives: ['orgRole', 'project'],
  },
  {
    point: 'project.service-endpoints-detail.title',
    load: () => import('$lib/components/monitoring/ServiceEndpointTitle.svelte'),
    props: { project, endpoint, orgRole },
    receives: ['endpoint', 'orgRole', 'project'],
  },
  {
    point: 'project.service-endpoints-detail.pause',
    load: () => import('$lib/components/monitoring/ServiceEndpointPause.svelte'),
    props: {
      project,
      endpoint,
      orgRole,
      paused: false,
      canManage: true,
      submitting: false,
      errorMessage: null,
      onToggle: () => true,
    },
    receives: ['endpoint', 'orgRole', 'project'],
  },
  {
    point: 'project.service-endpoints-detail.settings',
    load: () => import('$lib/components/monitoring/ServiceEndpointSettings.svelte'),
    props: { project, endpoint, orgRole, projectId: 'p1', onUpdated: noop },
    receives: ['endpoint', 'orgRole', 'project'],
  },
  {
    point: 'project.service-endpoints-detail.history',
    load: () => import('$lib/components/monitoring/ServiceEndpointHistory.svelte'),
    props: { project, endpoint, orgRole, projectId: 'p1' },
    receives: ['endpoint', 'orgRole', 'project'],
  },
  {
    point: 'project.service-endpoints-detail.delete',
    load: () => import('$lib/components/monitoring/ServiceEndpointDelete.svelte'),
    props: { project, endpoint, orgRole, deleteError: null, onDelete: noop },
    receives: ['endpoint', 'orgRole', 'project'],
  },
  {
    point: 'project.service-endpoints-detail.not-found',
    load: () => import('$lib/components/monitoring/ServiceEndpointDetailNotFound.svelte'),
    props: { project, projectId: 'p1' },
    receives: ['endpoint', 'project'],
  },
  {
    point: 'project.status-page.header',
    load: () => import('$lib/components/status-page/StatusPageHeader.svelte'),
    props: statusPageProps,
    receives: ['capabilities', 'project', 'serviceEndpoints'],
  },
  {
    point: 'project.status-page.read-only',
    load: () => import('$lib/components/status-page/StatusPageReadOnly.svelte'),
    props: statusPageProps,
    receives: ['capabilities', 'project', 'serviceEndpoints'],
  },
  {
    point: 'project.status-page.disabled',
    load: () => import('$lib/components/status-page/StatusPageDisabled.svelte'),
    props: { ...statusPageProps, capabilityDenied: false, isBusy: false, onEnable: noop },
    receives: ['capabilities', 'project', 'serviceEndpoints'],
  },
  {
    point: 'project.status-page.link',
    load: () => import('$lib/components/status-page/StatusPageLink.svelte'),
    props: {
      project,
      publicUrl: FAKE_PUBLIC_URL,
      legacyToken: false,
      copied: false,
      isBusy: false,
      onRegenerate: noop,
      onDisable: noop,
      onCopy: noop,
    },
    receives: ['hasPublicUrl', 'isLegacy', 'project'],
  },
  {
    point: 'project.status-page.services',
    load: () => import('$lib/components/status-page/StatusPageServices.svelte'),
    props: {
      ...statusPageProps,
      projectId: 'p1',
      rows: [],
      selectedCount: 0,
      capabilityDenied: false,
      isBusy: false,
      onToggle: noop,
      onSetDisplayName: noop,
      onMove: noop,
      onSave: noop,
    },
    receives: ['capabilities', 'project', 'serviceEndpoints'],
  },
  {
    point: 'status.detail.header',
    load: () => import('$lib/components/public-status/PublicStatusHeader.svelte'),
    props: {},
    receives: [],
  },
  {
    point: 'status.detail.services',
    load: () => import('$lib/components/public-status/PublicStatusServices.svelte'),
    props: { statusPage: { services: [] } },
    receives: ['statusPage'],
  },
  {
    point: 'status.detail.unavailable',
    load: () => import('$lib/components/public-status/PublicStatusUnavailable.svelte'),
    props: {},
    receives: [],
  },
]

const loaded = new Map<string, Component<never>>()

beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  await Promise.all(
    CASES.map(async (entry) => {
      loaded.set(entry.point, (await entry.load()).default)
    })
  )
})
afterEach(cleanup)

function mount(entry: Case, data: Record<string, readonly unknown[]> | undefined) {
  const component = loaded.get(entry.point)
  if (component === undefined) throw new Error(`no component for ${entry.point}`)
  return render(component as Component<Record<string, unknown>>, {
    props: { ...entry.props, data },
  })
}

function probeAt(): HTMLElement {
  const probes = screen.getAllByTestId('probe')
  const own = probes.find((candidate) => candidate.textContent?.includes('"routeId"'))
  return own ?? (probes[0] as HTMLElement)
}

describe.each(CASES)('region component for $point (Story 69.1)', (entry) => {
  it('hands a contribution only routeId, params and the props the registry lists', () => {
    mount(entry, undefined)
    const keys = screen
      .getAllByTestId('probe')
      .map((el) => el.getAttribute('data-keys')?.split(',') ?? [])
    expect(keys.length).toBeGreaterThan(0)
    // the empty region also renders the monitoring region, whose point carries `project`; the
    // endpoints table also renders one row region per endpoint
    const allowed =
      entry.point === 'dashboard.home.empty'
        ? [[], ['project']]
        : entry.point === 'project.service-endpoints.table'
          ? [entry.receives, ['endpoint', 'orgRole', 'project']]
          : [entry.receives]
    for (const list of keys) {
      const extras = list.filter((key) => !['data', 'params', 'routeId'].includes(key)).sort()
      expect(allowed).toContainEqual(extras)
    }
  })

  it('renders data = null when the page passes no map, and never throws', () => {
    mount(entry, undefined)
    expect(probeAt().textContent).toContain('"data":null')
  })

  it('forwards the contribution entry from the page map, aligned to its own point', () => {
    mount(entry, { [entry.point]: [{ marker: `entry-for-${entry.point}` }] })
    const texts = screen.getAllByTestId('probe').map((el) => el.textContent ?? '')
    expect(texts.some((text) => text.includes(`entry-for-${entry.point}`))).toBe(true)
  })

  it('renders the same markup as without a map when the map holds nothing for it', () => {
    const empty = mount(entry, undefined)
    const without = serializeWithoutNoise(empty.container)
    cleanup()
    const other = mount(entry, { 'unrelated.point.x': [{ n: 1 }] })
    expect(serializeWithoutNoise(other.container)).toBe(without)
  })
})

// Story 69.3 AC-5.6: the "Shareable link" card hands a contribution flags, never the bearer token or
// the URL built from it. The component renders the URL for the manager (as before), the point does not.
describe('project.status-page.link keeps the token out of the point (Story 69.3 AC-5.6)', () => {
  it('passes hasPublicUrl/isLegacy and no prop that holds the token or the URL', () => {
    const entry = CASES.find((candidate) => candidate.point === 'project.status-page.link') as Case
    mount(entry, undefined)
    const probe = probeAt()
    expect(probe.textContent).toContain('"hasPublicUrl":true')
    expect(probe.textContent).not.toContain('fixed-fake-token')
    expect(probe.textContent).not.toContain('/status/')
    // the page itself still shows the link to the manager, exactly as before
    expect(document.body.textContent).toContain(FAKE_PUBLIC_URL)
  })

  it.each([
    [null, true, false],
    [null, false, false],
  ])('flags for publicUrl %s legacy %s', (publicUrl, legacyToken, hasPublicUrl) => {
    const entry = CASES.find((candidate) => candidate.point === 'project.status-page.link') as Case
    mount({ ...entry, props: { ...entry.props, publicUrl, legacyToken } }, undefined)
    expect(probeAt().textContent).toContain(`"hasPublicUrl":${hasPublicUrl}`)
    expect(probeAt().textContent).toContain(`"isLegacy":${legacyToken}`)
  })
})

describe('the row region renders inside a table cell (Story 69.3 AC-7)', () => {
  it('puts the point in the Monitoring cell, never between rows', () => {
    const entry = CASES.find(
      (candidate) => candidate.point === 'project.service-endpoints.row'
    ) as Case
    const view = mount(entry, undefined)
    const row = view.container.querySelector('tr')
    expect(row).not.toBeNull()
    expect(row?.querySelector('td [data-testid="probe"]')).not.toBeNull()
    expect(view.container.querySelectorAll('tr > [data-testid="probe"]')).toHaveLength(0)
  })

  it('renders one independent fill per row inside the table, none outside a cell (3 rows)', () => {
    const entry = CASES.find(
      (candidate) => candidate.point === 'project.service-endpoints.table'
    ) as Case
    const rows = ['e1', 'e2', 'e3'].map((id) => ({ ...endpoint, id }))
    const view = mount({ ...entry, props: { ...entry.props, endpoints: rows } }, undefined)
    expect(view.container.querySelectorAll('tbody tr')).toHaveLength(3)
    expect(view.container.querySelectorAll('tbody tr td [data-testid="probe"]')).toHaveLength(3)
    // the table-level fill sits after the table card, never inside `<table>`
    expect(view.container.querySelectorAll('table [data-testid="probe"]')).toHaveLength(3)
    const probes = screen.getAllByTestId('probe')
    expect(probes.filter((probe) => probe.closest('table') === null)).toHaveLength(1)
  })
})
