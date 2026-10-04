// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { ComponentProps } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serializeWithoutNoise } from '$lib/test/dom.js'
import { appLayoutData, projectLayoutData } from '$lib/test/page-data.js'
import { sampleProject, sampleProjectDashboard, sampleProjectSummary } from '$lib/test/fixtures.js'
import DashboardPage from './(app)/dashboard/+page.svelte'
import ProjectPage from './(app)/projects/[projectId]/+page.svelte'

// Story 69.1 AC-2: characterization oracle for the region extraction. The 68-4 route-render oracle
// renders every route file once against a permissive Proxy and so only pins the sealed dashboard,
// the project-not-found card and the layout. This one renders the dashboard and the project page
// with explicit fixture data (every branch of the regions 69.1 extracts) and snapshots the
// normalized markup. The snapshot was generated from unmodified `main` BEFORE any region edit and
// is committed first; it is never regenerated. Normalization matches `route-render-snapshot.test`.

vi.mock('$lib/api/project-export.js', () => ({
  exportProject: vi.fn(async () => ({
    blob: new Blob(['x']),
    filename: 'p.pvexport',
    exportKey: 'KEY-FIXTURE-123',
  })),
  downloadExportBlob: vi.fn(),
}))

import { exportProject } from '$lib/api/project-export.js'

afterEach(cleanup)

function normalize(root: Element): string {
  return serializeWithoutNoise(root).replace(/\s+/g, ' ').trim()
}

type DashboardData = ComponentProps<typeof DashboardPage>['data']
type LoadedDashboardData = Exclude<DashboardData, { vaultSealed: true }>
type ProjectData = ComponentProps<typeof ProjectPage>['data']

// Noon UTC dates keep the localized day stable in any test time zone.
const NOON = '2026-07-01T12:00:00.000Z'
const LATER = '2026-07-15T12:00:00.000Z'

const selected = sampleProjectSummary({
  id: 'p1',
  name: 'Payments API',
  description: 'Stripe + billing webhooks',
})
const other = sampleProjectSummary({ id: 'p2', name: 'Other project' })

const ready = (count: number) => ({ status: 'ready' as const, count })
const monitoringAssets = { certificates: ready(2), domains: ready(1) }

function dashboardData(overrides: Partial<LoadedDashboardData> = {}): LoadedDashboardData {
  return {
    ...appLayoutData(),
    projects: { items: [selected, other], total: 2, page: 1, limit: 100, hasNext: false },
    selectedProject: selected,
    dashboard: sampleProjectDashboard({
      credentialStats: { active: 3, expiringSoon: 1, expired: 0 },
      monitoredServiceHealth: { healthy: 1, degraded: 1, down: 0 },
      unresolvedAlertCount: 2,
    }),
    orgDashboard: null,
    orgDashboardError: false,
    dashboardError: false,
    alertStatus: 'ready',
    monitoringAssets,
    ...overrides,
  } as LoadedDashboardData
}

function renderDashboard(data: DashboardData): string {
  const { container } = render(DashboardPage, { props: { data } })
  const html = normalize(container)
  cleanup()
  return html
}

const orgDashboard = (items: number) =>
  ({
    totalCredentials: 12,
    expiringWithin30Days: {
      count: items,
      items: Array.from({ length: items }, (_, i) => ({
        id: `c${i}`,
        name: `Cred ${i}`,
        projectId: 'p1',
        projectName: 'Payments API',
        expiresAt: LATER,
      })),
    },
    unresolvedAlertCount: 4,
  }) as unknown as LoadedDashboardData['orgDashboard']

const eventTypes = [
  'credential.created',
  'credential.version_created',
  'credential.value_revealed',
  'credential.version_purged',
  'credential.tags_updated',
  'credential.dependency_added',
  'credential.dependency_archived',
  'credential.lifecycle_updated',
] as const

const withDashboard = (overrides: Record<string, unknown>) =>
  sampleProjectDashboard({
    credentialStats: { active: 3, expiringSoon: 1, expired: 0 },
    monitoredServiceHealth: { healthy: 1, degraded: 1, down: 0 },
    ...overrides,
  } as never)

function dashboardMatrix(): Record<string, string> {
  const out: Record<string, string> = {}
  out['dashboard sealed'] = renderDashboard({
    ...appLayoutData(),
    projects: { items: [] },
    selectedProject: null,
    dashboard: null,
    orgDashboard: null,
    vaultSealed: true,
  } as DashboardData)
  out['dashboard org summary, no items'] = renderDashboard(
    dashboardData({ orgDashboard: orgDashboard(0), selectedProject: null, dashboard: null })
  )
  out['dashboard org summary, 2 expiring items + selected project'] = renderDashboard(
    dashboardData({ orgDashboard: orgDashboard(2) })
  )
  out['dashboard selected, empty rotations/activity/no suggestions'] =
    renderDashboard(dashboardData())
  out['dashboard selected, rotations of every status'] = renderDashboard(
    dashboardData({
      dashboard: withDashboard({
        upcomingRotations: [
          {
            credentialId: 'c1',
            credentialName: 'Active rot',
            status: 'active',
            activeRotation: { rotationId: 'rot-1', status: 'staged' },
          },
          {
            credentialId: 'c2',
            credentialName: 'Overdue with date',
            status: 'overdue',
            scheduledAt: NOON,
          },
          { credentialId: 'c3', credentialName: 'Overdue no date', status: 'overdue' },
          {
            credentialId: 'c4',
            credentialName: 'Scheduled with date',
            status: 'scheduled',
            scheduledAt: LATER,
          },
          { credentialId: 'c5', credentialName: 'Scheduled no date', status: 'scheduled' },
          { credentialId: 'c6', credentialName: 'Active no rot', status: 'active' },
        ],
      }),
    })
  )
  out['dashboard selected, activity events of every type'] = renderDashboard(
    dashboardData({
      dashboard: withDashboard({
        recentAccessEvents: eventTypes.map((eventType, i) => ({
          credentialId: `c${i}`,
          credentialName: `Cred ${i}`,
          eventType,
          actorDisplayName: `Actor ${i}`,
          occurredAt: NOON,
        })),
      }),
    })
  )
  for (const action of ['add_credential', 'add_service', 'import_credentials', 'mystery_action']) {
    out[`dashboard selected, suggested action ${action}`] = renderDashboard(
      dashboardData({ dashboard: withDashboard({ suggestedActions: [action] }) })
    )
  }
  out['dashboard selected, all suggested actions'] = renderDashboard(
    dashboardData({
      dashboard: withDashboard({
        suggestedActions: ['add_credential', 'add_service', 'import_credentials'],
      }),
    })
  )
  out['dashboard selected, no credentials/services (placeholder grid gaps)'] = renderDashboard(
    dashboardData({ dashboard: sampleProjectDashboard() })
  )
  out['dashboard selected, monitoring assets absent'] = renderDashboard(
    dashboardData({ monitoringAssets: undefined })
  )
  out['dashboard selected, monitoring assets errored'] = renderDashboard(
    dashboardData({
      monitoringAssets: {
        certificates: { status: 'error', count: 0 },
        domains: { status: 'loading', count: 0 },
      },
    })
  )
  out['dashboard summary unavailable (orphan dt/dd)'] = renderDashboard(
    dashboardData({ dashboard: null })
  )
  out['dashboard summary unavailable, monitoring assets absent'] = renderDashboard(
    dashboardData({ dashboard: null, monitoringAssets: undefined })
  )
  out['dashboard empty (no selected project)'] = renderDashboard(
    dashboardData({ selectedProject: null, dashboard: null })
  )
  return out
}

const baseProject = sampleProject({
  id: 'p1',
  name: 'Payments API',
  description: 'Stripe + billing webhooks',
  role: 'owner',
  createdAt: NOON,
  tags: ['billing', 'prod'],
  memberCount: 2,
})

function projectData(overrides: Record<string, unknown> = {}): ProjectData {
  return {
    ...projectLayoutData(),
    project: baseProject,
    dashboard: sampleProjectDashboard({
      credentialStats: { active: 1, expiringSoon: 2, expired: 0 },
      monitoredServiceHealth: { healthy: 3, degraded: 1, down: 2 },
    }),
    notFound: false,
    ...overrides,
  } as unknown as ProjectData
}

function renderProject(data: ProjectData): string {
  const { container } = render(ProjectPage, { props: { data } })
  const html = normalize(container)
  cleanup()
  return html
}

function projectMatrix(): Record<string, string> {
  const out: Record<string, string> = {}
  out['project found full'] = renderProject(projectData())
  out['project found archived, no description, no tags, 1 member'] = renderProject(
    projectData({
      project: { ...baseProject, archivedAt: LATER, description: null, tags: [], memberCount: 1 },
    })
  )
  out['project found, dashboard null'] = renderProject(projectData({ dashboard: null }))
  out['project found, nothing expiring, no services'] = renderProject(
    projectData({
      dashboard: sampleProjectDashboard({
        credentialStats: { active: 0, expiringSoon: 0, expired: 0 },
        monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
      }),
    })
  )
  out['project not found via notFound'] = renderProject(
    projectData({ project: null, dashboard: null, notFound: true })
  )
  out['project not found via project null'] = renderProject(
    projectData({ project: null, dashboard: null, notFound: false })
  )
  out['project notFound true with project present'] = renderProject(projectData({ notFound: true }))
  return out
}

async function exportPanelStates(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const mounted = render(ProjectPage, { props: { data: projectData() } })
  const html = () => normalize(mounted.container)
  out['export idle'] = html()

  let release: (value: { blob: Blob; filename: string; exportKey: string }) => void = () => {}
  vi.mocked(exportProject).mockImplementationOnce(
    () => new Promise((resolve) => (release = resolve))
  )
  await fireEvent.click(screen.getByRole('button', { name: 'Export project' }))
  out['export exporting'] = html()
  release({ blob: new Blob(['x']), filename: 'p.pvexport', exportKey: 'KEY-FIXTURE-123' })
  await waitFor(() => expect(screen.getByText('KEY-FIXTURE-123')).toBeTruthy())
  out['export key revealed, unacknowledged'] = html()
  await fireEvent.click(screen.getByRole('checkbox'))
  out['export key acknowledged'] = html()
  await fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  out['export dismissed'] = html()
  cleanup()

  const failing = render(ProjectPage, { props: { data: projectData() } })
  vi.mocked(exportProject).mockRejectedValueOnce(new Error('boom'))
  await fireEvent.click(screen.getByRole('button', { name: 'Export project' }))
  await waitFor(() => expect(screen.getByText('boom')).toBeTruthy())
  out['export error'] = normalize(failing.container)
  cleanup()
  return out
}

describe('region extraction oracle (Story 69.1 AC-2)', () => {
  it('renders the dashboard and the project page exactly as before the extraction', async () => {
    const result = {
      ...dashboardMatrix(),
      ...projectMatrix(),
      ...(await exportPanelStates()),
    }
    await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(
      './region-extraction.snapshot.json'
    )
    expect(Object.keys(result).length).toBeGreaterThanOrEqual(30)
  })
})
