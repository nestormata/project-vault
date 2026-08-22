import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

const listProjectMembersMock = vi.hoisted(() => vi.fn())
const listServiceEndpointsMock = vi.hoisted(() => vi.fn())
const getStatusPageConfigMock = vi.hoisted(() => vi.fn())
const getCapabilityMapMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/org-users.js', () => ({
  listProjectMembers: listProjectMembersMock,
}))
vi.mock('$lib/api/service-endpoints.js', () => ({
  listServiceEndpoints: listServiceEndpointsMock,
}))
vi.mock('$lib/api/status-page.js', () => ({
  getStatusPageConfig: getStatusPageConfigMock,
}))
vi.mock('$lib/api/capabilities.js', () => ({
  getCapabilityMap: getCapabilityMapMock,
}))
vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string; userId: string } }) => locals.user,
}))

import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeEvent(
  user: { orgRole: string; userId: string },
  url = `https://vault.example.com/projects/${projectId}/status-page`
) {
  return {
    params: { projectId },
    fetch: vi.fn(),
    locals: { user },
    url: new URL(url),
  } as unknown as Parameters<typeof load>[0]
}

describe('project status-page +page.server.ts', () => {
  beforeEach(() => {
    listProjectMembersMock.mockReset()
    listServiceEndpointsMock.mockReset()
    getStatusPageConfigMock.mockReset()
    getCapabilityMapMock.mockReset()
    getCapabilityMapMock.mockResolvedValue({
      capabilities: { 'monitoring.public-status-page': true },
    })
  })

  it('an org owner can manage even without being a project member (ADR-6.3-07)', async () => {
    listProjectMembersMock.mockResolvedValue([])
    getStatusPageConfigMock.mockResolvedValue({ enabled: true })
    listServiceEndpointsMock.mockResolvedValue([{ id: 'e1' }])

    const result = await load(makeEvent({ orgRole: 'owner', userId: 'u-org-owner' }))

    expect(result.canManage).toBe(true)
    expect(result.config).toEqual({ enabled: true })
    expect(result.serviceEndpoints).toEqual([{ id: 'e1' }])
  })

  // Story 18.2 AC-2/AC-4: the public status-page link is now built from the request's own
  // resolved origin (centralized helper), replacing the previous ad hoc window.location.origin
  // read in the client component.
  it('Story 18.2: returns the request URL origin as data.origin', async () => {
    listProjectMembersMock.mockResolvedValue([])
    getStatusPageConfigMock.mockResolvedValue({ enabled: true })
    listServiceEndpointsMock.mockResolvedValue([])

    const result = await load(makeEvent({ orgRole: 'owner', userId: 'u-org-owner' }))

    expect(result.origin).toBe('https://vault.example.com')
  })

  // Story 18.2 AC-5: mirrors the credential-detail load's guard — a broken/untrusted request
  // origin must fail the load loudly (500) rather than let the page render a
  // "https://undefined/status/..."-shaped public link.
  it('Story 18.2 AC-5: fails loudly (throws) instead of returning page data when the request has no usable origin', async () => {
    listProjectMembersMock.mockResolvedValue([])
    getStatusPageConfigMock.mockResolvedValue({ enabled: true })
    listServiceEndpointsMock.mockResolvedValue([])

    const event = makeEvent({ orgRole: 'owner', userId: 'u-org-owner' })
    // Simulate a request context where the origin couldn't be resolved (e.g. a malformed Host
    // header) — SvelteKit's own URL always has *some* origin in practice, but the loader must
    // still defend this path rather than trust it blindly.
    Object.defineProperty(event.url, 'origin', { value: '', configurable: true })

    await expect(load(event)).rejects.toThrow()
  })

  it('a project-owner member (non org-owner) can manage', async () => {
    listProjectMembersMock.mockResolvedValue([{ userId: 'u-1', role: 'owner' }])
    getStatusPageConfigMock.mockResolvedValue({ enabled: false })
    listServiceEndpointsMock.mockResolvedValue([])

    const result = await load(makeEvent({ orgRole: 'member', userId: 'u-1' }))

    expect(result.canManage).toBe(true)
  })

  it('a plain member who is not a project owner cannot manage and gets an empty/never-configured form', async () => {
    listProjectMembersMock.mockResolvedValue([{ userId: 'u-1', role: 'member' }])

    const result = await load(makeEvent({ orgRole: 'member', userId: 'u-1' }))

    expect(result.canManage).toBe(false)
    expect(result.config).toEqual({ enabled: false })
    expect(result.serviceEndpoints).toEqual([])
    expect(getStatusPageConfigMock).not.toHaveBeenCalled()
    expect(listServiceEndpointsMock).not.toHaveBeenCalled()
    // Story 23.7 AC-7 edge case: the capability fetch is skipped entirely for a !canManage
    // viewer, same as the other two calls — never triggers the additional call at all.
    expect(getCapabilityMapMock).not.toHaveBeenCalled()
  })

  it('tolerates a failed member lookup by treating the user as not a project member', async () => {
    listProjectMembersMock.mockRejectedValue(new Error('network down'))

    const result = await load(makeEvent({ orgRole: 'member', userId: 'u-1' }))

    expect(result.canManage).toBe(false)
  })

  // Story 23.7 AC-7/Task 5: the SSR load fetches the capability map inside the same
  // canManage-gated Promise.all as the two pre-existing calls.
  describe('Story 23.7: capabilities', () => {
    beforeEach(() => {
      listProjectMembersMock.mockResolvedValue([])
      getStatusPageConfigMock.mockResolvedValue({ enabled: true })
      listServiceEndpointsMock.mockResolvedValue([])
    })

    it('AC-7: a canManage:true load carries data.capabilities, fully resolved', async () => {
      getCapabilityMapMock.mockResolvedValue({
        capabilities: { 'monitoring.public-status-page': false },
      })

      const result = await load(makeEvent({ orgRole: 'owner', userId: 'u-org-owner' }))

      expect(result.capabilities).toEqual({ 'monitoring.public-status-page': false })
      expect(getCapabilityMapMock).toHaveBeenCalledTimes(1)
    })

    it('AC-9: capability-fetch failure (network/throw) fails open — data.capabilities defaults to every id permitted', async () => {
      getCapabilityMapMock.mockRejectedValue(new Error('capability service unreachable'))

      const result = await load(makeEvent({ orgRole: 'owner', userId: 'u-org-owner' }))

      expect(result.capabilities).toEqual({ 'monitoring.public-status-page': true })
    })

    it('AC-9 edge case: a malformed capability-map body (non-boolean value) fails open, identically to a network failure', async () => {
      getCapabilityMapMock.mockResolvedValue({
        capabilities: { 'monitoring.public-status-page': 'yes' },
      })

      const result = await load(makeEvent({ orgRole: 'owner', userId: 'u-org-owner' }))

      expect(result.capabilities).toEqual({ 'monitoring.public-status-page': true })
    })

    it('AC-9 edge case: an array response body fails open, identically to a network failure (code review fix)', async () => {
      getCapabilityMapMock.mockResolvedValue({
        capabilities: [true],
      })

      const result = await load(makeEvent({ orgRole: 'owner', userId: 'u-org-owner' }))

      expect(result.capabilities).toEqual({ 'monitoring.public-status-page': true })
    })

    it('AC-9 edge case: a response body missing the expected capability key fails open rather than resolving the key to undefined (code review fix)', async () => {
      getCapabilityMapMock.mockResolvedValue({
        capabilities: {},
      })

      const result = await load(makeEvent({ orgRole: 'owner', userId: 'u-org-owner' }))

      expect(result.capabilities).toEqual({ 'monitoring.public-status-page': true })
    })

    it('AC-9 edge case: a 401 session_revoked on the capabilities call is NOT absorbed by the fail-open path — it propagates, same as any other load-function failure', async () => {
      getCapabilityMapMock.mockRejectedValue(
        new ApiClientError(
          401,
          { code: 'session_revoked', message: 'Session revoked' },
          'Session revoked'
        )
      )

      await expect(load(makeEvent({ orgRole: 'owner', userId: 'u-org-owner' }))).rejects.toThrow()
    })

    it('Task 5 pre-mortem guard: a genuine getStatusPageConfig failure is NOT masked by AC-9s fail-open path — it still throws', async () => {
      getStatusPageConfigMock.mockRejectedValue(new Error('status page config unavailable'))
      getCapabilityMapMock.mockResolvedValue({
        capabilities: { 'monitoring.public-status-page': true },
      })

      await expect(load(makeEvent({ orgRole: 'owner', userId: 'u-org-owner' }))).rejects.toThrow(
        'status page config unavailable'
      )
    })
  })
})
