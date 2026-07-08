import { describe, expect, it, vi, beforeEach } from 'vitest'

const getErasureReportMock = vi.hoisted(() => vi.fn())
const createErasureRequestMock = vi.hoisted(() => vi.fn())
const listOrgUsersMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/compliance.js', () => ({
  getErasureReport: getErasureReportMock,
  createErasureRequest: createErasureRequestMock,
}))

vi.mock('$lib/api/org-users.js', () => ({
  listOrgUsers: listOrgUsersMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: vi.fn(),
}))

import { ApiClientError } from '$lib/api/client.js'
import { requireUser } from '$lib/server/require-user.js'
import { load } from './+page.server.js'

const requireUserMock = vi.mocked(requireUser)

const userId = 'u-1'
const requestId = 'req-1'

function makeEvent() {
  return {
    fetch: vi.fn(),
    params: { userId, requestId },
    locals: {},
  } as unknown as Parameters<typeof load>[0]
}

const COMPLETED_REPORT = {
  requestId,
  executedAt: '2026-07-07T00:00:00.000Z',
  piiRemoved: [{ table: 'sessions', fields: ['ipAddress', 'userAgent'], method: 'nulled' }],
  piiRetained: [
    { table: 'audit_log_entries', reason: 'audit log integrity (HMAC-protected, append-only)' },
  ],
  retentionJustification: 'Legal hold under SOC 2 requirements',
  auditEventId: 'evt-1',
}

describe('/settings/users/[userId]/erasure/[requestId] +page.server.ts (D6)', () => {
  beforeEach(() => {
    getErasureReportMock.mockReset()
    createErasureRequestMock.mockReset()
    listOrgUsersMock.mockReset()
    requireUserMock.mockReset()
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    listOrgUsersMock.mockResolvedValue([
      {
        userId,
        email: 'contractor@example.com',
        displayName: 'Contractor',
        orgRole: 'member',
        status: 'active',
        projects: [],
      },
    ])
  })

  it('AC-M1: a 200 report response yields state=completed with the full report', async () => {
    getErasureReportMock.mockResolvedValue(COMPLETED_REPORT)

    const result = await load(makeEvent())

    expect(result.state).toBe('completed')
    if (result.state === 'completed') expect(result.report).toEqual(COMPLETED_REPORT)
  })

  it('D4/D5: resolves the target userEmail via listOrgUsers for the typed-confirm gate', async () => {
    getErasureReportMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'erasure_not_yet_completed', message: 'not ready', status: 'in_progress' },
        'not ready'
      )
    )

    const result = await load(makeEvent())
    expect(result.userEmail).toBe('contractor@example.com')
  })

  it('falls back to null userEmail if the target is no longer listed (e.g. removed from org)', async () => {
    getErasureReportMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'erasure_not_yet_completed', message: 'not ready', status: 'in_progress' },
        'not ready'
      )
    )
    listOrgUsersMock.mockResolvedValue([])

    const result = await load(makeEvent())
    expect(result.userEmail).toBeNull()
  })

  it('D6: a 409 erasure_not_yet_completed{status:"pending"} re-POSTs (safe idempotent read) to fetch piiInventory', async () => {
    getErasureReportMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'erasure_not_yet_completed', message: 'not ready', status: 'pending' },
        'not ready'
      )
    )
    createErasureRequestMock.mockRejectedValue(
      new ApiClientError(
        409,
        {
          code: 'erasure_request_already_pending',
          message: 'pending',
          requestId,
          piiInventory: { tables: [{ table: 'users', rowCount: 1, piiFields: ['email'] }] },
        },
        'pending'
      )
    )

    const result = await load(makeEvent())

    expect(createErasureRequestMock).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      expect.any(Object)
    )
    expect(result.state).toBe('pending')
    if (result.state === 'pending') expect(result.piiInventory?.tables).toHaveLength(1)
  })

  it('D6 (adversarial review, medium): a 409 status:"in_progress" does NOT re-POST and returns state=in_progress', async () => {
    getErasureReportMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'erasure_not_yet_completed', message: 'not ready', status: 'in_progress' },
        'not ready'
      )
    )

    const result = await load(makeEvent())

    expect(createErasureRequestMock).not.toHaveBeenCalled()
    expect(result.state).toBe('in_progress')
  })

  it('a 404 returns state=not_found', async () => {
    getErasureReportMock.mockRejectedValue(
      new ApiClientError(
        404,
        { code: 'erasure_request_not_found', message: 'not found' },
        'not found'
      )
    )

    const result = await load(makeEvent())

    expect(result.state).toBe('not_found')
  })

  it('(regression) a member/viewer role gets state=not_allowed without ever calling the API — every sibling page in this story checks role before its first API call, this page was missing that', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'member' } as ReturnType<typeof requireUser>)

    const result = await load(makeEvent())

    expect(result.state).toBe('not_allowed')
    expect(getErasureReportMock).not.toHaveBeenCalled()
    expect(listOrgUsersMock).not.toHaveBeenCalled()
  })

  it('(regression) an unexpected error during the D6 safe-repost (e.g. a 500, or a 403 the outer role check let through) propagates instead of being repainted as an empty "pending" state', async () => {
    getErasureReportMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'erasure_not_yet_completed', message: 'not ready', status: 'pending' },
        'not ready'
      )
    )
    // Anything other than the specific `erasure_request_already_pending` outcome must not be
    // swallowed into a false "pending, no inventory" result.
    createErasureRequestMock.mockRejectedValue(new ApiClientError(500, null, 'Internal error'))

    await expect(load(makeEvent())).rejects.toThrow('Internal error')
  })
})
