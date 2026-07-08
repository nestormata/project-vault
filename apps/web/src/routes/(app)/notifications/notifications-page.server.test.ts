import { describe, expect, it, vi, beforeEach } from 'vitest'

const getNotificationInboxMock = vi.hoisted(() => vi.fn())
const listOrgSecurityAlertsMock = vi.hoisted(() => vi.fn())
const dismissSecurityAlertMock = vi.hoisted(() => vi.fn())
const deactivateOrgUserMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/inbox.js', () => ({
  getNotificationInbox: getNotificationInboxMock,
  markInboxEntryRead: vi.fn(),
  markAllInboxRead: vi.fn(),
  dismissInboxEntry: vi.fn(),
}))

vi.mock('$lib/api/security-alerts.js', () => ({
  listOrgSecurityAlerts: listOrgSecurityAlertsMock,
  dismissSecurityAlert: dismissSecurityAlertMock,
}))

vi.mock('$lib/api/org-users.js', () => ({
  deactivateOrgUser: deactivateOrgUserMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: vi.fn(),
}))

import { ApiClientError } from '$lib/api/client.js'
import { requireUser } from '$lib/server/require-user.js'
import { load, actions } from './+page.server.js'

const requireUserMock = vi.mocked(requireUser)

const SAMPLE_ENTRY = {
  id: '00000000-0000-4000-8000-000000000001',
  alertType: 'credential.expiring',
  severity: 'warning',
  title: 'Credential expiring soon',
  body: 'Stripe API Key expires in 3 days',
  projectId: null,
  resourceId: null,
  resourceType: null,
  readAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
}

const EMPTY_DORMANCY_ALERTS_PAGE = { items: [], total: 0, page: 1, limit: 20, hasNext: false }

function makeEvent(searchParams: Record<string, string> = {}) {
  const url = new URL('http://localhost/notifications')
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value)
  return { fetch: vi.fn(), url, locals: {} } as unknown as Parameters<typeof load>[0]
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

// Story 9.3 D8.4: GET /api/v1/notifications/inbox's response shape changed from a bare
// `{ data: [...], page, limit }` to `{ data: { items, total, page, limit, hasNext } }` — this
// asserts load() reads the new nested shape (inbox.data.items) rather than treating the whole
// `data` object as the notifications array (which would break +page.svelte's `.some()`/`.length`
// array usage the instant the API's actual response shape changed).
describe('/notifications +page.server.ts', () => {
  beforeEach(() => {
    getNotificationInboxMock.mockReset()
    listOrgSecurityAlertsMock.mockReset()
    requireUserMock.mockReset()
    requireUserMock.mockReturnValue({ orgRole: 'member' } as ReturnType<typeof requireUser>)
  })

  it('returns notifications as a real array read from inbox.data.items', async () => {
    getNotificationInboxMock.mockResolvedValue({
      data: { items: [SAMPLE_ENTRY], total: 1, page: 1, limit: 20, hasNext: false },
    })

    const result = await load(makeEvent())

    expect(Array.isArray(result.notifications)).toBe(true)
    expect(result.notifications).toEqual([SAMPLE_ENTRY])
    expect(result.page).toBe(1)
  })

  it('returns an empty notifications array when the inbox is empty', async () => {
    getNotificationInboxMock.mockResolvedValue({
      data: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
    })

    const result = await load(makeEvent())

    expect(result.notifications).toEqual([])
  })

  it('returns an empty array (not a thrown error) on a 403 from the API', async () => {
    getNotificationInboxMock.mockRejectedValue(new ApiClientError(403, null, 'forbidden'))

    const result = await load(makeEvent({ page: '2' }))

    expect(result.notifications).toEqual([])
    expect(result.page).toBe(2)
  })
})

// Story 8.6 AC-4: dormancy alerts (`machine_key.dormant` security_alerts rows) surfaced alongside
// this page's existing personal inbox notifications, org-admin-scoped.
describe('notifications +page.server.ts (AC-4: dormancy alerts in existing inbox)', () => {
  beforeEach(() => {
    getNotificationInboxMock.mockReset()
    listOrgSecurityAlertsMock.mockReset()
    requireUserMock.mockReset()
    getNotificationInboxMock.mockResolvedValue({
      data: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
    })
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
      data: {
        items: [{ id: 'n-1', alertType: 'credential.expiry' }],
        total: 1,
        page: 1,
        limit: 20,
        hasNext: false,
      },
    })
    listOrgSecurityAlertsMock.mockResolvedValueOnce(EMPTY_DORMANCY_ALERTS_PAGE)

    const result = await load(makeEvent())

    expect(result.notifications).toEqual([{ id: 'n-1', alertType: 'credential.expiry' }])
    expect(result.dormancyAlerts).toEqual([])
  })
})

const userDormantAlert = {
  id: 'alert-2',
  alertType: 'user.dormant',
  severity: 'warning' as const,
  status: 'delivered' as const,
  payload: {
    userId: 'user-1',
    displayName: 'jsmith@example.com',
    orgRole: 'member',
    lastActiveAt: '2026-04-04T00:00:00.000Z',
  },
  createdAt: '2026-07-01T00:00:00.000Z',
}

// Story 8.7 AC group H — dormant-user alerts (`user.dormant` security_alerts rows) surfaced
// alongside the existing machine-key dormancy section, same owner/admin gate.
describe('notifications +page.server.ts (Story 8.7 AC group H: user dormancy alerts)', () => {
  beforeEach(() => {
    getNotificationInboxMock.mockReset()
    listOrgSecurityAlertsMock.mockReset()
    dismissSecurityAlertMock.mockReset()
    deactivateOrgUserMock.mockReset()
    requireUserMock.mockReset()
    getNotificationInboxMock.mockResolvedValue({
      data: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
    })
  })

  it('AC-H1: includes user.dormant alerts for an org admin, derived from the same alerts fetch as machine-key alerts', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    listOrgSecurityAlertsMock.mockResolvedValueOnce({
      items: [userDormantAlert, dormantAlert],
      total: 2,
      page: 1,
      limit: 20,
      hasNext: false,
    })

    const result = await load(makeEvent())

    expect(listOrgSecurityAlertsMock).toHaveBeenCalledTimes(1)
    expect(result.userDormancyAlerts).toHaveLength(1)
    expect(result.userDormancyAlerts[0]).toMatchObject({
      id: 'alert-2',
      displayName: 'jsmith@example.com',
    })
    expect(result.dormancyAlerts).toHaveLength(1)
  })

  it('AC-H3: a member/viewer sees neither dormancy section', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'member' } as ReturnType<typeof requireUser>)

    const result = await load(makeEvent())

    expect(listOrgSecurityAlertsMock).not.toHaveBeenCalled()
    expect(result.userDormancyAlerts).toEqual([])
    expect(result.dormancyAlerts).toEqual([])
  })

  it('AC-H2: an empty user.dormant list on a healthy org', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'owner' } as ReturnType<typeof requireUser>)
    listOrgSecurityAlertsMock.mockResolvedValueOnce(EMPTY_DORMANCY_ALERTS_PAGE)

    const result = await load(makeEvent())

    expect(result.userDormancyAlerts).toEqual([])
  })

  describe('deactivateDormantUser action (AC-H1)', () => {
    it('calls deactivateOrgUser and returns success', async () => {
      deactivateOrgUserMock.mockResolvedValue({
        userId: 'user-1',
        revokedSessionCount: 2,
        revokedInvitationCount: 0,
      })
      const formData = new FormData()
      formData.set('userId', 'user-1')
      const request = { formData: async () => formData } as unknown as Request

      const result = await actions.deactivateDormantUser({
        request,
        fetch: vi.fn(),
      } as unknown as Parameters<typeof actions.deactivateDormantUser>[0])

      expect(deactivateOrgUserMock).toHaveBeenCalledWith(expect.anything(), 'user-1')
      expect(result).toEqual({ success: true })
    })

    it('AC-H1 edge: an already_deactivated error is handled gracefully, not surfaced as a raw error', async () => {
      deactivateOrgUserMock.mockRejectedValue(
        new ApiClientError(
          409,
          { code: 'already_deactivated', message: 'already deactivated' },
          'already deactivated'
        )
      )
      const formData = new FormData()
      formData.set('userId', 'user-1')
      const request = { formData: async () => formData } as unknown as Request

      const result = await actions.deactivateDormantUser({
        request,
        fetch: vi.fn(),
      } as unknown as Parameters<typeof actions.deactivateDormantUser>[0])

      expect(result).toEqual({ success: true, alreadyDeactivated: true })
    })
  })
})
