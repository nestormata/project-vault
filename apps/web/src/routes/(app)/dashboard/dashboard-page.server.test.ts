import { describe, expect, it, vi, beforeEach } from 'vitest'

const listProjectsMock = vi.hoisted(() => vi.fn())
const getOrgDashboardMock = vi.hoisted(() => vi.fn())
const getProjectDashboardMock = vi.hoisted(() => vi.fn())
const listCertificatesMock = vi.hoisted(() => vi.fn())
const listDomainsMock = vi.hoisted(() => vi.fn())
const getAttentionMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/projects.js', () => ({
  listAllProjects: listProjectsMock,
  listProjects: listProjectsMock,
  getProjectDashboard: getProjectDashboardMock,
}))

vi.mock('$lib/api/dashboard.js', () => ({
  getOrgDashboard: getOrgDashboardMock,
  getDashboardAttention: getAttentionMock,
}))

vi.mock('$lib/api/certificates.js', () => ({
  listCertificates: listCertificatesMock,
}))

vi.mock('$lib/api/domains.js', () => ({
  listDomains: listDomainsMock,
}))

import { isRedirect, redirect } from '@sveltejs/kit'
import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'
import { expectLoaded } from '$lib/test/page-data.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeEvent(searchParams: Record<string, string> = {}) {
  const url = new URL('http://localhost/dashboard')
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value)
  return { fetch: vi.fn(), url } as unknown as Parameters<typeof load>[0]
}

describe('/dashboard +page.server.ts', () => {
  beforeEach(() => {
    listProjectsMock.mockReset()
    getOrgDashboardMock.mockReset()
    getProjectDashboardMock.mockReset()
    listCertificatesMock.mockReset()
    listDomainsMock.mockReset()
    getAttentionMock.mockReset()
    getAttentionMock.mockResolvedValue({
      items: [],
      counts: { expiringShares: 0, expiringCertificates: 0, pendingInvitations: 0 },
    })
    getOrgDashboardMock.mockResolvedValue(null)
    getProjectDashboardMock.mockResolvedValue({ upcomingRotations: [] })
    listCertificatesMock.mockResolvedValue([])
    listDomainsMock.mockResolvedValue([])
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

    const result = expectLoaded(await load(makeEvent()))

    expect(result.selectedProject?.id).toBe(projectId)
    expect(result.dashboard).toEqual({ upcomingRotations: [] })
    expect(result.vaultSealed).toBeFalsy()
  })

  // Story 69.1 AC-8: the one-project 303 auto-skip is CentralizeMe's rule on its M1 override; PV's
  // native dashboard renders for a user with exactly one project and never redirects.
  it('does not redirect a user with exactly one project (the auto-skip is CM, not PV)', async () => {
    listProjectsMock.mockResolvedValue({
      items: [{ id: projectId, name: 'Only project', description: null }],
      total: 1,
      page: 1,
      limit: 20,
      hasNext: false,
    })
    const result = expectLoaded(await load(makeEvent()))
    expect(result.selectedProject?.id).toBe(projectId)
    expect(result.projects.items).toHaveLength(1)
  })

  it('streams monitoring card states so the dashboard can render loading before they settle', async () => {
    listProjectsMock.mockResolvedValue({
      items: [{ id: projectId, name: 'Payments', description: null }],
      total: 1,
      page: 1,
      limit: 20,
      hasNext: false,
    })
    listCertificatesMock.mockResolvedValue([{ id: 'certificate-1' }])
    listDomainsMock.mockResolvedValue([{ id: 'domain-1' }])

    const result = expectLoaded(await load(makeEvent()))

    expect(result.monitoringAssets.certificates).toBeInstanceOf(Promise)
    await expect(result.monitoringAssets.certificates).resolves.toEqual({
      status: 'ready',
      count: 1,
    })
    await expect(result.monitoringAssets.domains).resolves.toEqual({
      status: 'ready',
      count: 1,
    })
  })

  it('uses an explicitly selected accessible project instead of always choosing the first project', async () => {
    const secondProjectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    listProjectsMock.mockResolvedValue({
      items: [
        { id: projectId, name: 'Payments', description: null },
        { id: secondProjectId, name: 'Inventory', description: null },
      ],
      total: 2,
      page: 1,
      limit: 20,
      hasNext: false,
    })
    getProjectDashboardMock.mockResolvedValue({ upcomingRotations: [] })
    listCertificatesMock.mockResolvedValue([{ id: 'certificate-2' }])
    listDomainsMock.mockResolvedValue([{ id: 'domain-2' }])

    const result = expectLoaded(await load(makeEvent({ projectId: secondProjectId })))

    expect(result.selectedProject?.id).toBe(secondProjectId)
    expect(getProjectDashboardMock).toHaveBeenCalledWith(expect.anything(), secondProjectId)
    expect(listCertificatesMock).toHaveBeenCalledWith(expect.anything(), secondProjectId)
    expect(listDomainsMock).toHaveBeenCalledWith(expect.anything(), secondProjectId)
    await expect(result.monitoringAssets.certificates).resolves.toEqual({
      status: 'ready',
      count: 1,
    })
    await expect(result.monitoringAssets.domains).resolves.toEqual({ status: 'ready', count: 1 })
  })

  it('selects an accessible project returned on a later pagination page', async () => {
    const laterProjectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    listProjectsMock.mockResolvedValue({
      items: [
        { id: projectId, name: 'Payments', description: null },
        { id: laterProjectId, name: 'Inventory', description: null },
      ],
      total: 101,
      page: 1,
      limit: 100,
      hasNext: false,
    })

    const result = expectLoaded(await load(makeEvent({ projectId: laterProjectId })))

    expect(result.selectedProject?.id).toBe(laterProjectId)
    expect(getProjectDashboardMock).toHaveBeenCalledWith(expect.anything(), laterProjectId)
  })

  it('falls back to the first accessible project when the URL selection is invalid', async () => {
    listProjectsMock.mockResolvedValue({
      items: [
        { id: projectId, name: 'Payments', description: null },
        { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Inventory', description: null },
      ],
      total: 2,
      page: 1,
      limit: 20,
      hasNext: false,
    })
    getProjectDashboardMock.mockResolvedValue({ upcomingRotations: [] })

    const result = expectLoaded(await load(makeEvent({ projectId: 'not-accessible' })))

    expect(result.selectedProject?.id).toBe(projectId)
    expect(getProjectDashboardMock).toHaveBeenCalledWith(expect.anything(), projectId)
  })

  it('keeps successful monitoring data when the certificate query fails', async () => {
    listProjectsMock.mockResolvedValue({
      items: [{ id: projectId, name: 'Payments', description: null }],
      total: 1,
      page: 1,
      limit: 20,
      hasNext: false,
    })
    getProjectDashboardMock.mockResolvedValue({ unresolvedAlertCount: 3, upcomingRotations: [] })
    listCertificatesMock.mockRejectedValue(new Error('certificates unavailable'))
    listDomainsMock.mockResolvedValue([{ id: 'domain-1' }, { id: 'domain-2' }])

    const result = expectLoaded(await load(makeEvent()))

    expect(result.dashboard).toEqual({ unresolvedAlertCount: 3, upcomingRotations: [] })
    await expect(result.monitoringAssets.certificates).resolves.toEqual({
      status: 'error',
      count: 0,
    })
    await expect(result.monitoringAssets.domains).resolves.toEqual({ status: 'ready', count: 2 })
    expect(result.vaultSealed).toBeFalsy()
  })

  it('keeps certificate/domain data when the dashboard query fails, including an unavailable alert state', async () => {
    listProjectsMock.mockResolvedValue({
      items: [{ id: projectId, name: 'Payments', description: null }],
      total: 1,
      page: 1,
      limit: 20,
      hasNext: false,
    })
    getProjectDashboardMock.mockRejectedValue(new Error('dashboard unavailable'))
    listCertificatesMock.mockResolvedValue([{ id: 'certificate-1' }])
    listDomainsMock.mockResolvedValue([{ id: 'domain-1' }])

    const result = expectLoaded(await load(makeEvent()))

    expect(result.selectedProject?.id).toBe(projectId)
    expect(result.dashboard).toBeNull()
    expect(result.dashboardError).toBe(true)
    expect(result.alertStatus).toBe('error')
    await expect(result.monitoringAssets.certificates).resolves.toEqual({
      status: 'ready',
      count: 1,
    })
    await expect(result.monitoringAssets.domains).resolves.toEqual({ status: 'ready', count: 1 })
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

    const result = expectLoaded(await load(makeEvent()))

    expect(result.vaultSealed).toBe(true)
    expect(result.dashboard).toBeNull()
    expect(result.orgDashboard).toBeNull()
    expect(result.selectedProject).toBeNull()
    expect(result.projects).toEqual({ items: [] })
  })

  it('keeps project data available when getOrgDashboard 503s', async () => {
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

    const result = expectLoaded(await load(makeEvent()))

    expect(result.vaultSealed).toBeFalsy()
    expect(result.dashboard).toEqual({ upcomingRotations: [] })
    expect(result.orgDashboard).toBeNull()
    expect(result.orgDashboardError).toBe(true)
  })

  it('does not turn an individual project dashboard failure into a full sealed state', async () => {
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

    const result = expectLoaded(await load(makeEvent()))

    expect(result.vaultSealed).toBeFalsy()
    expect(result.dashboard).toBeNull()
    expect(result.selectedProject?.id).toBe(projectId)
    expect(result.dashboardError).toBe(true)
    expect(result.alertStatus).toBe('error')
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

    const result = expectLoaded(await load(makeEvent()))

    expect(result.vaultSealed).toBeFalsy()
    expect(result.orgDashboard).toBeNull()
    expect(result.dashboard).toBeNull()
    expect(result.selectedProject).toBeNull()
  })

  it('AC-4 edge: a non-404/503 ApiClientError still propagates unchanged', async () => {
    listProjectsMock.mockRejectedValue(new ApiClientError(500, null, 'boom'))

    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
  // Story 72-12 AC5: the attention read is awaited with the other reads and its failure is handled
  // where the promise is created, so it can never fail the page.
  describe('attention read (story 72-12)', () => {
    const oneProject = {
      items: [{ id: projectId, name: 'Payments', description: null }],
      total: 1,
      page: 1,
      limit: 20,
      hasNext: false,
    }

    it('hands the list to the page as a ready state', async () => {
      listProjectsMock.mockResolvedValue(oneProject)
      const attention = {
        items: [],
        counts: { expiringShares: 0, expiringCertificates: 2, pendingInvitations: 0 },
      }
      getAttentionMock.mockResolvedValue(attention)

      const result = expectLoaded(await load(makeEvent()))

      expect(result.attention).toEqual({ status: 'ready', ...attention })
    })

    it('still loads the page and the other cards when the attention read rejects', async () => {
      listProjectsMock.mockResolvedValue(oneProject)
      getOrgDashboardMock.mockResolvedValue({ totalCredentials: 4 })
      getAttentionMock.mockRejectedValue(new ApiClientError(403, { message: 'no' }, 'no'))

      const result = expectLoaded(await load(makeEvent()))

      expect(result.attention).toEqual({ status: 'error' })
      expect(result.orgDashboard).toEqual({ totalCredentials: 4 })
      expect(result.selectedProject?.id).toBe(projectId)
      expect(result.dashboard).toEqual({ upcomingRotations: [] })
    })

    it('answers a server error and a network failure with the error state', async () => {
      listProjectsMock.mockResolvedValue(oneProject)
      for (const failure of [
        new ApiClientError(500, null, 'boom'),
        new TypeError('fetch failed'),
      ]) {
        getAttentionMock.mockRejectedValue(failure)
        expect(expectLoaded(await load(makeEvent())).attention).toEqual({ status: 'error' })
      }
    })

    it('rethrows a redirect thrown by the client instead of hiding the card', async () => {
      listProjectsMock.mockResolvedValue(oneProject)
      getAttentionMock.mockImplementation(async () => {
        redirect(303, '/login')
      })

      const caught = await Promise.resolve(load(makeEvent())).catch((error: unknown) => error)

      expect(isRedirect(caught)).toBe(true)
    })

    it('does not leave an unhandled rejection when another read fails first', async () => {
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      listProjectsMock.mockResolvedValue(oneProject)
      getAttentionMock.mockRejectedValue(new TypeError('attention down'))
      getProjectDashboardMock.mockRejectedValue(new Error('dashboard down'))

      const result = expectLoaded(await load(makeEvent()))
      await new Promise((resolve) => setTimeout(resolve, 10))
      process.off('unhandledRejection', unhandled)

      expect(unhandled).not.toHaveBeenCalled()
      expect(result.attention).toEqual({ status: 'error' })
    })

    it('does not read attention for a vault-sealed load and works for a project-less caller', async () => {
      listProjectsMock.mockRejectedValueOnce(
        new ApiClientError(503, { status: 'sealed', message: 'sealed' }, 'sealed')
      )
      const sealed = expectLoaded(await load(makeEvent()))
      expect(sealed.vaultSealed).toBe(true)
      expect(getAttentionMock).not.toHaveBeenCalled()

      listProjectsMock.mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        limit: 20,
        hasNext: false,
      })
      const empty = expectLoaded(await load(makeEvent()))
      expect(empty.selectedProject).toBeNull()
      expect(empty.attention?.status).toBe('ready')
    })
  })
})
