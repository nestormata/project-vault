import { describe, expect, it, vi, beforeEach } from 'vitest'

const platformOperatorGateMock = vi.hoisted(() => vi.fn())
const listPlatformAuditEventsMock = vi.hoisted(() => vi.fn())
const getMaintenanceModeStatusMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/require-platform-operator.js', () => ({
  platformOperatorGate: platformOperatorGateMock,
}))

vi.mock('$lib/api/platform.js', () => ({
  listPlatformAuditEvents: listPlatformAuditEventsMock,
  getMaintenanceModeStatus: getMaintenanceModeStatusMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const platformUser = {
  userId: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgName: 'Test Org',
  sessionId: '00000000-0000-4000-8000-000000000003',
  orgRole: 'owner' as const,
  isPlatformOperator: true,
  mfaEnrolled: false,
  mfaEnrolledAt: null,
  remainingRecoveryCodesCount: null,
  mfaStatus: {
    enrollmentRequired: false,
    gracePeriodActive: false,
    gracePeriodExpiresAt: null,
    gracePeriodDaysRemaining: null,
    bannerMessage: null,
  },
}

function makeEvent(searchParams: Record<string, string> = {}) {
  const url = new URL('http://localhost/platform/audit')
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value)
  return { fetch: vi.fn(), url, locals: { user: platformUser } } as unknown as Parameters<
    typeof load
  >[0]
}

const INACTIVE_STATUS = {
  active: false,
  reason: null,
  activatedAt: null,
  deactivatedAt: '2026-07-01T00:00:00Z',
  pendingEntriesCount: 0,
}

const SAMPLE_EVENTS = {
  items: [
    {
      id: 'evt-1',
      operatorId: '00000000-0000-4000-8000-000000000001',
      actionType: 'org.created',
      targetOrgId: null,
      targetUserId: null,
      payload: {},
      ipAddress: null,
      timestamp: '2026-07-08T00:00:00Z',
    },
  ],
  page: 1,
  limit: 20,
  total: 1,
  hasNext: false,
}

describe('/platform/audit +page.server.ts', () => {
  beforeEach(() => {
    platformOperatorGateMock.mockReset()
    listPlatformAuditEventsMock.mockReset()
    getMaintenanceModeStatusMock.mockReset()
  })

  it('AC-A3: returns allowed=false for non-platform-operator', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: false })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(false)
    expect(listPlatformAuditEventsMock).not.toHaveBeenCalled()
  })

  it('AC-K1: returns events and maintenance status for a platform operator', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    listPlatformAuditEventsMock.mockResolvedValue(SAMPLE_EVENTS)
    getMaintenanceModeStatusMock.mockResolvedValue(INACTIVE_STATUS)

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.events).toHaveLength(1)
      expect(result.maintenanceStatus?.active).toBe(false)
      expect(result.eventsErrorMessage).toBeNull()
    }
  })

  it('AC-M1 edge: maintenanceStatusError is set if GET /maintenance-mode fails', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    listPlatformAuditEventsMock.mockResolvedValue(SAMPLE_EVENTS)
    getMaintenanceModeStatusMock.mockRejectedValue(new Error('Network error'))

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.maintenanceStatus).toBeNull()
      expect(result.maintenanceStatusError).toBeTruthy()
    }
  })

  it('does not crash on events API error — surfaces friendly error', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    listPlatformAuditEventsMock.mockRejectedValue(
      new ApiClientError(429, { message: 'Too many requests' }, 'Too many requests')
    )
    getMaintenanceModeStatusMock.mockResolvedValue(INACTIVE_STATUS)

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.events).toHaveLength(0)
      expect(result.eventsErrorMessage).toBeTruthy()
    }
  })

  it('AC-K2: passes filter params to the events API', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    listPlatformAuditEventsMock.mockResolvedValue({ ...SAMPLE_EVENTS, items: [] })
    getMaintenanceModeStatusMock.mockResolvedValue(INACTIVE_STATUS)

    await load(makeEvent({ actionType: 'org.created', from: '2026-07-01T00:00:00Z' }))

    expect(listPlatformAuditEventsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actionType: 'org.created', from: '2026-07-01T00:00:00Z' })
    )
  })
})
