import { describe, expect, it, vi, beforeEach } from 'vitest'

const listAuditEventsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/audit.js', () => ({
  listAuditEvents: listAuditEventsMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: vi.fn(),
}))

import { ApiClientError } from '$lib/api/client.js'
import { requireUser } from '$lib/server/require-user.js'
import { load } from './+page.server.js'

const requireUserMock = vi.mocked(requireUser)

function makeEvent(searchParams: Record<string, string> = {}) {
  const url = new URL('http://localhost/settings/audit')
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value)
  return { fetch: vi.fn(), url, locals: {} } as unknown as Parameters<typeof load>[0]
}

const SAMPLE_RESULT = {
  data: [
    {
      id: 'evt-1',
      eventType: 'credential.access',
      actorDisplayName: 'Dana Smith',
      resourceId: 'cred-1',
      resourceType: 'credential',
      projectId: 'proj-1',
      ipAddress: '203.0.113.4',
      createdAt: '2026-06-14T10:03:00.000Z',
    },
  ],
  page: 1,
  limit: 20,
  total: 340,
  hasNext: true,
}

describe('/settings/audit +page.server.ts', () => {
  beforeEach(() => {
    listAuditEventsMock.mockReset()
    requireUserMock.mockReset()
  })

  it('AC-B4: does not call the API and returns allowed=false for a non-owner role', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)

    const result = await load(makeEvent())

    expect(result.allowed).toBe(false)
    expect(listAuditEventsMock).not.toHaveBeenCalled()
  })

  it('AC-B1: an owner with zero filters issues GET /audit/events?page=1&limit=20 (no other filters)', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'owner' } as ReturnType<typeof requireUser>)
    listAuditEventsMock.mockResolvedValue(SAMPLE_RESULT)

    const result = await load(makeEvent())

    expect(listAuditEventsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ page: 1, limit: 20 })
    )
    const [, calledQuery] = listAuditEventsMock.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(calledQuery.eventType).toBeUndefined()
    expect(calledQuery.from).toBeUndefined()
    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.total).toBe(340)
      expect(result.hasNext).toBe(true)
      expect(result.events).toHaveLength(1)
    }
  })

  it('AC-B2: passes eventType/from/to filters through to the API call', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'owner' } as ReturnType<typeof requireUser>)
    listAuditEventsMock.mockResolvedValue({ ...SAMPLE_RESULT, total: 12, hasNext: false })

    await load(
      makeEvent({
        eventType: 'credential.access',
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-30T00:00:00.000Z',
      })
    )

    expect(listAuditEventsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'credential.access',
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-30T00:00:00.000Z',
      })
    )
  })

  it('AC-B1 edge: an honest empty result set on a brand-new org', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'owner' } as ReturnType<typeof requireUser>)
    listAuditEventsMock.mockResolvedValue({
      data: [],
      page: 1,
      limit: 20,
      total: 0,
      hasNext: false,
    })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.events).toEqual([])
      expect(result.total).toBe(0)
    }
  })

  it('does not crash on an unexpected API error — surfaces a friendly errorMessage instead', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'owner' } as ReturnType<typeof requireUser>)
    listAuditEventsMock.mockRejectedValue(
      new ApiClientError(429, { message: 'Too many requests' }, 'Too many requests')
    )

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.events).toEqual([])
      expect(result.errorMessage).toBeTruthy()
    }
  })
})
