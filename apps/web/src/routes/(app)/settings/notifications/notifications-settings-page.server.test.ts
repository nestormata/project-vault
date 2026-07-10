import { beforeEach, describe, expect, it, vi } from 'vitest'

const getNotificationPreferencesMock = vi.hoisted(() => vi.fn())
const getOrgNotificationRoutingMock = vi.hoisted(() => vi.fn())
const patchNotificationPreferencesMock = vi.hoisted(() => vi.fn())
const putOrgNotificationRoutingMock = vi.hoisted(() => vi.fn())
const postAdminNotificationTestMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/notifications.js', () => ({
  getNotificationPreferences: getNotificationPreferencesMock,
  getOrgNotificationRouting: getOrgNotificationRoutingMock,
  patchNotificationPreferences: patchNotificationPreferencesMock,
  putOrgNotificationRouting: putOrgNotificationRoutingMock,
  postAdminNotificationTest: postAdminNotificationTestMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import { actions, load } from './+page.server.js'

function makeEvent(user: { orgRole: string; mfaEnrolled: boolean } | null) {
  return { fetch: vi.fn(), locals: { user } } as unknown as Parameters<typeof load>[0]
}

function actionEvent(fields: Record<string, string> = {}, user: unknown = undefined) {
  const formData = new FormData()
  for (const [key, value] of Object.entries(fields)) formData.set(key, value)
  return {
    request: { formData: async () => formData },
    fetch: vi.fn(),
    locals: { user },
  } as unknown as Parameters<(typeof actions)['updatePreference']>[0]
}

const PREFS = { items: [] }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('/settings/notifications +page.server.ts load', () => {
  it('a non-admin member sees preferences but no routing table, and cannot send test', async () => {
    getNotificationPreferencesMock.mockResolvedValue(PREFS)

    const result = await load(makeEvent({ orgRole: 'member', mfaEnrolled: true }))

    expect(result.isAdmin).toBe(false)
    expect(result.canSendTest).toBe(false)
    expect(result.routing).toBeNull()
    expect(getOrgNotificationRoutingMock).not.toHaveBeenCalled()
  })

  it('an MFA-enrolled owner sees the routing table and can send test notifications', async () => {
    getNotificationPreferencesMock.mockResolvedValue(PREFS)
    getOrgNotificationRoutingMock.mockResolvedValue([
      { alertType: 'security.mfa_recovery_used', routeTo: 'owner' },
      { alertType: 'credential.expiring', routeTo: 'admin' },
    ])

    const result = await load(makeEvent({ orgRole: 'owner', mfaEnrolled: true }))

    expect(result.isAdmin).toBe(true)
    expect(result.canSendTest).toBe(true)
    // MFA-direct alert types must never appear in the routable table (ADR-3.4-06).
    expect(result.routing).toEqual([{ alertType: 'credential.expiring', routeTo: 'admin' }])
  })

  it('an admin without MFA enrolled cannot send test notifications', async () => {
    getNotificationPreferencesMock.mockResolvedValue(PREFS)
    getOrgNotificationRoutingMock.mockResolvedValue([])

    const result = await load(makeEvent({ orgRole: 'admin', mfaEnrolled: false }))

    expect(result.isAdmin).toBe(true)
    expect(result.canSendTest).toBe(false)
  })

  it('a 403 fetching org routing is forwarded as no-routing rather than a page error', async () => {
    getNotificationPreferencesMock.mockResolvedValue(PREFS)
    getOrgNotificationRoutingMock.mockRejectedValue(new ApiClientError(403, null, 'forbidden'))

    const result = await load(makeEvent({ orgRole: 'owner', mfaEnrolled: true }))

    expect(result.routing).toBeNull()
  })

  it('a non-403 error fetching org routing propagates (safe-500, not silently swallowed)', async () => {
    getNotificationPreferencesMock.mockResolvedValue(PREFS)
    getOrgNotificationRoutingMock.mockRejectedValue(new ApiClientError(500, null, 'boom'))

    await expect(load(makeEvent({ orgRole: 'owner', mfaEnrolled: true }))).rejects.toThrow('boom')
  })

  it('an anonymous/no-user request never queries routing and is never admin', async () => {
    getNotificationPreferencesMock.mockResolvedValue(PREFS)

    const result = await load(makeEvent(null))

    expect(result.isAdmin).toBe(false)
    expect(result.canSendTest).toBe(false)
    expect(getOrgNotificationRoutingMock).not.toHaveBeenCalled()
  })
})

describe('/settings/notifications +page.server.ts actions', () => {
  it('updatePreference succeeds and forwards the exact patch payload', async () => {
    patchNotificationPreferencesMock.mockResolvedValue(undefined)

    const result = await actions.updatePreference(
      actionEvent({
        alertType: 'credential.expiring',
        channel: 'email',
        frequency: 'immediate',
        minSeverity: 'warning',
      })
    )

    expect(patchNotificationPreferencesMock).toHaveBeenCalledWith(expect.any(Function), [
      {
        alertType: 'credential.expiring',
        channel: 'email',
        frequency: 'immediate',
        minSeverity: 'warning',
      },
    ])
    expect(result).toEqual({ success: true })
  })

  it('updatePreference returns a 422 failure when the API call rejects', async () => {
    patchNotificationPreferencesMock.mockRejectedValue(new Error('network down'))

    const result = await actions.updatePreference(actionEvent({}))

    expect(result).toEqual({ status: 422, data: { error: 'Failed to update preference' } })
  })

  it('updateRouting succeeds and forwards the routing selections', async () => {
    putOrgNotificationRoutingMock.mockResolvedValue(undefined)

    const result = await actions.updateRouting(
      actionEvent({ routeTo_credential_expiring: 'admin' })
    )

    expect(putOrgNotificationRoutingMock).toHaveBeenCalled()
    expect(result).toEqual({ success: true })
  })

  it('updateRouting returns a 422 failure when the API call rejects', async () => {
    putOrgNotificationRoutingMock.mockRejectedValue(new Error('network down'))

    const result = await actions.updateRouting(actionEvent({}))

    expect(result).toEqual({ status: 422, data: { error: 'Failed to update routing' } })
  })

  it('sendTest is denied for a non-admin or non-MFA-enrolled user', async () => {
    const result = await actions.sendTest(actionEvent({}, { orgRole: 'member', mfaEnrolled: true }))

    expect(result).toEqual({
      status: 403,
      data: { error: 'Only MFA-enrolled owners/admins can send a test notification' },
    })
    expect(postAdminNotificationTestMock).not.toHaveBeenCalled()
  })

  it('sendTest succeeds for an MFA-enrolled admin and returns the test result', async () => {
    postAdminNotificationTestMock.mockResolvedValue({ delivered: true })

    const result = await actions.sendTest(actionEvent({}, { orgRole: 'admin', mfaEnrolled: true }))

    expect(result).toEqual({ testResult: { delivered: true } })
  })

  it('sendTest returns a 429 rate-limit failure distinctly from other errors', async () => {
    postAdminNotificationTestMock.mockRejectedValue(new ApiClientError(429, null, 'rate limited'))

    const result = await actions.sendTest(actionEvent({}, { orgRole: 'owner', mfaEnrolled: true }))

    expect(result).toEqual({
      status: 429,
      data: { error: 'Test notification rate limit reached — try again in a few minutes' },
    })
  })

  it('sendTest returns a generic 422 failure for an unknown/plain error without leaking internals', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    postAdminNotificationTestMock.mockRejectedValue(new Error('smtp socket reset by peer'))

    const result = await actions.sendTest(actionEvent({}, { orgRole: 'owner', mfaEnrolled: true }))

    expect(result).toEqual({ status: 422, data: { error: 'Failed to send test notification' } })
    // The real cause is still logged server-side for diagnosis, just not exposed to the client.
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('smtp socket reset by peer'))
    stderrSpy.mockRestore()
  })
})
