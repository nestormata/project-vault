import { describe, expect, it, vi, beforeEach } from 'vitest'

const listServiceEndpointDetailsMock = vi.hoisted(() => vi.fn())
const listAlertsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/service-endpoints.js', () => ({
  listServiceEndpointDetails: listServiceEndpointDetailsMock,
}))

vi.mock('$lib/api/monitoring-alerts.js', () => ({
  listAlerts: listAlertsMock,
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

describe('service-endpoints list +page.server.ts (AC-E1/E2/F1/AC-I2)', () => {
  beforeEach(() => {
    listServiceEndpointDetailsMock.mockReset()
    listAlertsMock.mockReset()
  })

  it('AC-F1: merges active and snoozed alerts from two calls (fetch-unfiltered-and-filter path is also acceptable, but this is the two-call approach)', async () => {
    listServiceEndpointDetailsMock.mockResolvedValue([{ id: 'e1', name: 'API health' }])
    listAlertsMock.mockImplementation(
      (_fetch: unknown, _projectId: string, query: { status?: string }) => {
        if (query.status === 'active') {
          return Promise.resolve({
            items: [{ id: 'a1', status: 'active' }],
            page: 1,
            limit: 50,
            total: 1,
            hasNext: false,
          })
        }
        return Promise.resolve({
          items: [{ id: 'a2', status: 'snoozed' }],
          page: 1,
          limit: 50,
          total: 1,
          hasNext: false,
        })
      }
    )

    const result = await load(makeEvent('viewer'))

    expect(result.endpoints).toEqual([{ id: 'e1', name: 'API health' }])
    expect(result.alerts).toHaveLength(2)
    expect(result.alerts.map((a) => a.id)).toEqual(expect.arrayContaining(['a1', 'a2']))
    expect(result.notFound).toBe(false)
  })

  it('404s to a notFound flag instead of throwing', async () => {
    listServiceEndpointDetailsMock.mockRejectedValueOnce(new ApiClientError(404, null, 'not found'))
    listAlertsMock.mockResolvedValue({ items: [], page: 1, limit: 50, total: 0, hasNext: false })

    const result = await load(makeEvent())

    expect(result.notFound).toBe(true)
    expect(result.endpoints).toEqual([])
    expect(result.alerts).toEqual([])
  })
})
