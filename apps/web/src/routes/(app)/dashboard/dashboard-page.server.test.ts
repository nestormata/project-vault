import { describe, expect, it, vi, beforeEach } from 'vitest'

const listProjectsMock = vi.hoisted(() => vi.fn())
const getOrgDashboardMock = vi.hoisted(() => vi.fn())
const getProjectDashboardMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/projects.js', () => ({
  listProjects: listProjectsMock,
  getProjectDashboard: getProjectDashboardMock,
}))

vi.mock('$lib/api/dashboard.js', () => ({
  getOrgDashboard: getOrgDashboardMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeEvent() {
  return { fetch: vi.fn() } as unknown as Parameters<typeof load>[0]
}

describe('/dashboard +page.server.ts', () => {
  beforeEach(() => {
    listProjectsMock.mockReset()
    getOrgDashboardMock.mockReset()
    getProjectDashboardMock.mockReset()
    getOrgDashboardMock.mockResolvedValue(null)
  })

  it('returns the selected project + dashboard on the happy path', async () => {
    listProjectsMock.mockResolvedValue({
      items: [{ id: projectId, name: 'Payments', description: null }],
      total: 1,
      page: 1,
      limit: 20,
      hasNext: false,
    })
    getOrgDashboardMock.mockResolvedValue(null)
    getProjectDashboardMock.mockResolvedValue({ upcomingRotations: [] })

    const result = await load(makeEvent())

    expect(result.selectedProject?.id).toBe(projectId)
    expect(result.dashboard).toEqual({ upcomingRotations: [] })
    expect(result.vaultSealed).toBeFalsy()
  })

  // AC-4: listProjects/getOrgDashboard/getProjectDashboard are all vault-guarded. Today
  // listProjects has zero catch of any kind, getOrgDashboard has a .catch() that special-cases
  // 404, and getProjectDashboard has its own try/catch that special-cases 404 — none of the three
  // touch 503. A 503 from any of them must be caught by one new outer try/catch wrapping the
  // entire loader body, discarding any already-fetched data (D1/AC-4's "partial failure" edge
  // case) rather than rendering a partially-degraded dashboard.
  it('AC-4: returns vaultSealed: true when listProjects 503s (sealed vault)', async () => {
    listProjectsMock.mockRejectedValue(
      new ApiClientError(
        503,
        { status: 'sealed', message: 'Vault not initialized' },
        'Vault not initialized'
      )
    )

    const result = await load(makeEvent())

    expect(result.vaultSealed).toBe(true)
    expect(result.dashboard).toBeNull()
    expect(result.orgDashboard).toBeNull()
    expect(result.selectedProject).toBeNull()
    expect(result.projects).toEqual({ items: [] })
  })

  it('AC-4: returns vaultSealed: true when getOrgDashboard 503s (sealed vault)', async () => {
    listProjectsMock.mockResolvedValue({
      items: [{ id: projectId, name: 'Payments', description: null }],
      total: 1,
      page: 1,
      limit: 20,
      hasNext: false,
    })
    getOrgDashboardMock.mockRejectedValue(
      new ApiClientError(
        503,
        { status: 'sealed', message: 'Vault not initialized' },
        'Vault not initialized'
      )
    )

    const result = await load(makeEvent())

    expect(result.vaultSealed).toBe(true)
  })

  it('AC-4 edge: listProjects succeeding but getProjectDashboard sealing is still treated as a full sealed state, discarding the already-fetched projects/orgDashboard data', async () => {
    listProjectsMock.mockResolvedValue({
      items: [{ id: projectId, name: 'Payments', description: null }],
      total: 1,
      page: 1,
      limit: 20,
      hasNext: false,
    })
    getOrgDashboardMock.mockResolvedValue(null)
    getProjectDashboardMock.mockRejectedValue(
      new ApiClientError(
        503,
        { status: 'sealed', message: 'Vault not initialized' },
        'Vault not initialized'
      )
    )

    const result = await load(makeEvent())

    expect(result.vaultSealed).toBe(true)
    expect(result.dashboard).toBeNull()
    expect(result.selectedProject).toBeNull()
  })

  it('AC-4 edge: existing 404-swallowing behavior for getOrgDashboard/getProjectDashboard is unchanged', async () => {
    listProjectsMock.mockResolvedValue({
      items: [{ id: projectId, name: 'Payments', description: null }],
      total: 1,
      page: 1,
      limit: 20,
      hasNext: false,
    })
    getOrgDashboardMock.mockRejectedValue(new ApiClientError(404, null, 'not found'))
    getProjectDashboardMock.mockRejectedValue(new ApiClientError(404, null, 'not found'))

    const result = await load(makeEvent())

    expect(result.vaultSealed).toBeFalsy()
    expect(result.orgDashboard).toBeNull()
    expect(result.dashboard).toBeNull()
    expect(result.selectedProject).toBeNull()
  })

  it('AC-4 edge: a non-404/503 ApiClientError still propagates unchanged', async () => {
    listProjectsMock.mockRejectedValue(new ApiClientError(500, null, 'boom'))

    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
})
