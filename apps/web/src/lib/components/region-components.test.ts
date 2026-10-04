import { cleanup, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { sampleProject, sampleProjectDashboard, sampleProjectSummary } from '$lib/test/fixtures.js'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.1 AC-1 / AC-5: every extracted region component renders its own point, forwards the page's
// `__inject` map to it (undefined and null-less maps render components with `data = null` and never
// throw), and hands a contribution only the props listed for that point in the registry.

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
]

const loaded = new Map<string, Component<never>>()

beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  for (const entry of CASES) loaded.set(entry.point, (await entry.load()).default)
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
    // the empty region also renders the monitoring region, whose point carries `project`
    const allowed = entry.point === 'dashboard.home.empty' ? [[], ['project']] : [entry.receives]
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
