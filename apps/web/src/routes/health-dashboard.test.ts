import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import HealthPage from './(app)/health/+page.svelte'

const listProjectsMock = vi.hoisted(() => vi.fn())
const getHealthDashboardMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/projects.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/api/projects.js')>()
  return { ...original, listProjects: listProjectsMock }
})

vi.mock('$lib/api/health-dashboard.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/api/health-dashboard.js')>()
  return { ...original, getHealthDashboard: getHealthDashboardMock }
})

import { load } from './(app)/health/+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeEvent() {
  return { fetch: vi.fn() } as unknown as Parameters<typeof load>[0]
}

describe('/health +page.server.ts (AC-A2)', () => {
  beforeEach(() => {
    listProjectsMock.mockReset()
    getHealthDashboardMock.mockReset()
    getHealthDashboardMock.mockResolvedValue({
      summary: { healthy: 0, degraded: 0, down: 0 },
      projects: [],
    })
  })

  it('resolves singleProjectId when exactly one project exists in the org', async () => {
    listProjectsMock.mockResolvedValue({ items: [{ id: projectId, name: 'Payments' }], total: 1 })
    const result = await load(makeEvent())
    expect(result.singleProjectId).toBe(projectId)
  })

  it('leaves singleProjectId null when zero or multiple projects exist', async () => {
    listProjectsMock.mockResolvedValue({ items: [], total: 0 })
    expect((await load(makeEvent())).singleProjectId).toBeNull()

    listProjectsMock.mockResolvedValue({
      items: [{ id: 'p1' }, { id: 'p2' }],
      total: 2,
    })
    expect((await load(makeEvent())).singleProjectId).toBeNull()
  })

  it('code-review finding: a listProjects failure does not take down the whole /health page', async () => {
    listProjectsMock.mockRejectedValue(new Error('transient upstream failure'))
    const result = await load(makeEvent())
    expect(result.dashboard).toEqual({
      summary: { healthy: 0, degraded: 0, down: 0 },
      projects: [],
    })
    expect(result.singleProjectId).toBeNull()
  })
})

describe('/health +page.svelte (AC-A2)', () => {
  afterEach(() => cleanup())

  it('empty state: the dead-end sentence becomes a link to /projects when multiple/zero projects exist', () => {
    render(HealthPage, {
      props: {
        data: {
          dashboard: { summary: { healthy: 0, degraded: 0, down: 0 }, projects: [] },
          singleProjectId: null,
        },
      },
    })
    const link = screen.getByRole('link', {
      name: 'Register a service endpoint on a project to see its live status here.',
    })
    expect(link.getAttribute('href')).toBe('/projects')
  })

  it("empty state edge: exactly one project links directly to that project's service-endpoints page", () => {
    render(HealthPage, {
      props: {
        data: {
          dashboard: { summary: { healthy: 0, degraded: 0, down: 0 }, projects: [] },
          singleProjectId: projectId,
        },
      },
    })
    const link = screen.getByRole('link', {
      name: 'Register a service endpoint on a project to see its live status here.',
    })
    expect(link.getAttribute('href')).toBe(`/projects/${projectId}/service-endpoints`)
  })

  it('non-empty state: each project card gains a "Manage endpoints" link alongside the existing project-name link', () => {
    render(HealthPage, {
      props: {
        data: {
          dashboard: {
            summary: { healthy: 2, degraded: 0, down: 0 },
            projects: [
              {
                projectId,
                projectName: 'Payments',
                services: [{ id: 's1', name: 'API', status: 'healthy', lastCheckedAt: null }],
              },
            ],
          },
          singleProjectId: null,
        },
      },
    })

    expect(screen.getByRole('link', { name: 'Payments' }).getAttribute('href')).toBe(
      `/projects/${projectId}/credentials`
    )
    expect(screen.getByRole('link', { name: 'Manage endpoints' }).getAttribute('href')).toBe(
      `/projects/${projectId}/service-endpoints`
    )
  })
})
