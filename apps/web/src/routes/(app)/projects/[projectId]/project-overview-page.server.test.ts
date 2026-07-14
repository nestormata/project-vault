import { describe, expect, it, vi, beforeEach } from 'vitest'

const getProjectMock = vi.hoisted(() => vi.fn())
const getProjectDashboardMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/projects.js', () => ({
  getProject: getProjectMock,
  getProjectDashboard: getProjectDashboardMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string } }) => locals.user,
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeEvent(orgRole = 'member') {
  return {
    params: { projectId },
    fetch: vi.fn(),
    locals: { user: { orgRole } },
  } as unknown as Parameters<typeof load>[0]
}

const project = {
  id: projectId,
  orgId: 'org-1',
  name: 'Payments API',
  slug: 'payments-api',
  description: 'Stripe + billing webhooks',
  role: 'owner' as const,
  createdBy: 'user-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
  tags: ['team-payments'],
  memberCount: 4,
}

const dashboard = {
  credentialStats: { active: 3, expiringSoon: 2, expired: 0 },
  upcomingRotations: [],
  monitoredServiceHealth: { healthy: 1, degraded: 0, down: 0 },
  recentAccessEvents: [],
  unresolvedAlertCount: 0,
  isEmpty: false,
  suggestedActions: [],
}

describe('project overview +page.server.ts (AC-1 through AC-5)', () => {
  beforeEach(() => {
    getProjectMock.mockReset()
    getProjectDashboardMock.mockReset()
  })

  it('AC-1/AC-2: loads the project detail and dashboard summary for the happy path', async () => {
    getProjectMock.mockResolvedValueOnce(project)
    getProjectDashboardMock.mockResolvedValueOnce(dashboard)

    const result = await load(makeEvent('owner'))

    expect(result.project).toEqual(project)
    expect(result.dashboard).toEqual(dashboard)
    expect(result.notFound).toBe(false)
  })

  it('AC-3: a nonexistent or foreign-org project 404s to an honest not-found result without leaking data', async () => {
    getProjectMock.mockRejectedValueOnce(new ApiClientError(404, null, 'not found'))

    const result = await load(makeEvent())

    expect(result.notFound).toBe(true)
    expect(result.project).toBeNull()
    expect(result.dashboard).toBeNull()
    // AC-3: the dashboard must not be fetched once the project lookup itself has already 404'd —
    // fetching it anyway risks a race where dashboard data leaks even though project detail didn't.
    expect(getProjectDashboardMock).not.toHaveBeenCalled()
  })

  it('AC-4: a malformed project ID error (non-404) is not swallowed — it propagates like the credentials route', async () => {
    getProjectMock.mockRejectedValueOnce(new ApiClientError(422, null, 'validation failed'))

    await expect(load(makeEvent())).rejects.toThrow('validation failed')
  })

  it('AC-5: an archived project loads normally with archivedAt set', async () => {
    const archivedProject = { ...project, archivedAt: '2026-06-01T00:00:00.000Z' }
    getProjectMock.mockResolvedValueOnce(archivedProject)
    getProjectDashboardMock.mockResolvedValueOnce(dashboard)

    const result = await load(makeEvent('owner'))

    expect(result.project?.archivedAt).toBe('2026-06-01T00:00:00.000Z')
    expect(result.notFound).toBe(false)
  })
})
