import { describe, expect, it, vi, beforeEach } from 'vitest'
import { isRedirect } from '@sveltejs/kit'

const getOnboardingStatusMock = vi.hoisted(() => vi.fn())
const listProjectsMock = vi.hoisted(() => vi.fn())
const getUsersMeMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/onboarding.js', () => ({
  getOnboardingStatus: getOnboardingStatusMock,
}))
vi.mock('$lib/api/projects.js', () => ({
  listProjects: listProjectsMock,
}))
vi.mock('$lib/api/inbox.js', () => ({
  getUsersMe: getUsersMeMock,
}))

import { load } from './+layout.server.js'

function makeEvent(user: unknown) {
  return { fetch: vi.fn(), locals: { user } } as unknown as Parameters<typeof load>[0]
}

const baseUser = { id: 'u1', orgRole: 'member' }

describe('/(app) +layout.server.ts', () => {
  beforeEach(() => {
    getOnboardingStatusMock.mockReset()
    listProjectsMock.mockReset()
    getUsersMeMock.mockReset()
  })

  it('redirects to /login when there is no authenticated user', async () => {
    let caught: unknown
    try {
      await load(makeEvent(null))
    } catch (error) {
      caught = error
    }

    expect(isRedirect(caught)).toBe(true)
    expect((caught as { location: string }).location).toBe('/login')
  })

  it('happy path: onboarding completed, skips listing projects, returns unread count', async () => {
    getOnboardingStatusMock.mockResolvedValue({ completed: true })
    getUsersMeMock.mockResolvedValue({ notifications: { unreadCount: 4 } })

    const result = await load(makeEvent(baseUser))

    expect(result.onboardingCompleted).toBe(true)
    expect(listProjectsMock).not.toHaveBeenCalled()
    expect(result.projects).toEqual([])
    expect(result.unreadCount).toBe(4)
  })

  it('when onboarding is not completed, lists projects and includes them', async () => {
    getOnboardingStatusMock.mockResolvedValue({ completed: false })
    listProjectsMock.mockResolvedValue({ items: [{ id: 'p1', name: 'Payments' }], total: 1 })
    getUsersMeMock.mockResolvedValue({ notifications: { unreadCount: 0 } })

    const result = await load(makeEvent(baseUser))

    expect(result.onboardingCompleted).toBe(false)
    expect(listProjectsMock).toHaveBeenCalled()
    expect(result.projects).toEqual([{ id: 'p1', name: 'Payments' }])
  })

  it('treats a failed onboarding status lookup as completed (fail-open)', async () => {
    getOnboardingStatusMock.mockRejectedValue(new Error('boom'))
    getUsersMeMock.mockResolvedValue({ notifications: { unreadCount: 0 } })

    const result = await load(makeEvent(baseUser))

    expect(result.onboardingCompleted).toBe(true)
    expect(listProjectsMock).not.toHaveBeenCalled()
  })

  it('falls back to an empty project list when listProjects fails during onboarding', async () => {
    getOnboardingStatusMock.mockResolvedValue({ completed: false })
    listProjectsMock.mockRejectedValue(new Error('boom'))
    getUsersMeMock.mockResolvedValue({ notifications: { unreadCount: 0 } })

    const result = await load(makeEvent(baseUser))

    expect(result.projects).toEqual([])
  })

  it('falls back to zero unread count when getUsersMe fails', async () => {
    getOnboardingStatusMock.mockResolvedValue({ completed: true })
    getUsersMeMock.mockRejectedValue(new Error('boom'))

    const result = await load(makeEvent(baseUser))

    expect(result.unreadCount).toBe(0)
  })

  it('sets importRouteLive true for owner/admin roles and false for others', async () => {
    getOnboardingStatusMock.mockResolvedValue({ completed: true })
    getUsersMeMock.mockResolvedValue({ notifications: { unreadCount: 0 } })

    const ownerResult = await load(makeEvent({ ...baseUser, orgRole: 'owner' }))
    expect(ownerResult.importRouteLive).toBe(true)

    const viewerResult = await load(makeEvent({ ...baseUser, orgRole: 'viewer' }))
    expect(viewerResult.importRouteLive).toBe(false)
  })
})
