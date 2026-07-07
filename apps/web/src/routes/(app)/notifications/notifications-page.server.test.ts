import { describe, expect, it, vi, beforeEach } from 'vitest'

const getNotificationInboxMock = vi.hoisted(() => vi.fn())
const listOrgSecurityAlertsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/inbox.js', () => ({
  getNotificationInbox: getNotificationInboxMock,
  markInboxEntryRead: vi.fn(),
  markAllInboxRead: vi.fn(),
  dismissInboxEntry: vi.fn(),
}))

vi.mock('$lib/api/security-alerts.js', () => ({
  listOrgSecurityAlerts: listOrgSecurityAlertsMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: vi.fn(),
}))

import { ApiClientError } from '$lib/api/client.js'
import { requireUser } from '$lib/server/require-user.js'
import { load } from './+page.server.js'

const requireUserMock = vi.mocked(requireUser)

function makeEvent(url = 'https://vault.example.com/notifications') {
  return {
    fetch: vi.fn(),
    url: new URL(url),
    locals: {},
  } as unknown as Parameters<typeof load>[0]
}

const dormantAlert = {
  id: 'alert-1',
  alertType: 'machine_key.dormant',
  severity: 'warning' as const,
  status: 'delivered' as const,
  payload: {
    keyId: 'key-1',
    machineUserId: 'mu-1',
    machineUserName: 'ci-deploy-bot',
    keyName: 'prod-key',
    lastUsedAt: '2026-05-01T00:00:00.000Z',
    projectId: 'project-1',
  },
  deliveryStatus: 'delivered',
  createdAt: '2026-07-01T00:00:00.000Z',
}

describe('notifications +page.server.ts (AC-4: dormancy alerts in existing inbox)', () => {
  beforeEach(() => {
    getNotificationInboxMock.mockReset()
    listOrgSecurityAlertsMock.mockReset()
    requireUserMock.mockReset()
    getNotificationInboxMock.mockResolvedValue({ data: [], page: 1 })
  })

  it('includes machine_key.dormant alerts for an org admin', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    listOrgSecurityAlertsMock.mockResolvedValueOnce({
      items: [dormantAlert],
      total: 1,
      page: 1,
      limit: 20,
      hasNext: false,
    })

    const result = await load(makeEvent())

    expect(result.dormancyAlerts).toHaveLength(1)
    expect(result.dormancyAlerts[0]).toMatchObject({
      id: 'alert-1',
      machineUserName: 'ci-deploy-bot',
      keyName: 'prod-key',
    })
  })

  it('does not call the org security-alerts endpoint for a non-admin viewer/member', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'member' } as ReturnType<typeof requireUser>)

    const result = await load(makeEvent())

    expect(listOrgSecurityAlertsMock).not.toHaveBeenCalled()
    expect(result.dormancyAlerts).toEqual([])
  })

  it('degrades to an empty dormancy list (not a crash) on a 403 from the org endpoint', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    listOrgSecurityAlertsMock.mockRejectedValueOnce(new ApiClientError(403, null, 'forbidden'))

    const result = await load(makeEvent())

    expect(result.dormancyAlerts).toEqual([])
  })

  it('still returns the personal inbox notifications unchanged alongside dormancyAlerts', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'owner' } as ReturnType<typeof requireUser>)
    getNotificationInboxMock.mockResolvedValueOnce({
      data: [{ id: 'n-1', alertType: 'credential.expiry' }],
      page: 1,
    })
    listOrgSecurityAlertsMock.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
      hasNext: false,
    })

    const result = await load(makeEvent())

    expect(result.notifications).toEqual([{ id: 'n-1', alertType: 'credential.expiry' }])
    expect(result.dormancyAlerts).toEqual([])
  })
})
