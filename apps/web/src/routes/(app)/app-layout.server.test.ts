import { describe, expect, it, vi, beforeEach } from 'vitest'
import { isRedirect } from '@sveltejs/kit'

const getOnboardingStatusMock = vi.hoisted(() => vi.fn())
const listProjectsMock = vi.hoisted(() => vi.fn())
const getUsersMeMock = vi.hoisted(() => vi.fn())
const getThemesMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/onboarding.js', () => ({
  getOnboardingStatus: getOnboardingStatusMock,
}))
vi.mock('$lib/api/projects.js', () => ({
  listProjects: listProjectsMock,
}))
vi.mock('$lib/api/inbox.js', () => ({
  getUsersMe: getUsersMeMock,
}))
vi.mock('$lib/api/themes.js', () => ({
  getThemes: getThemesMock,
}))

import { load } from './+layout.server.js'

const noCustomThemes = { themes: [{ name: 'base', label: 'Default', css: null }], selected: null }

function makeEvent(user: unknown) {
  return { fetch: vi.fn(), locals: { user } } as unknown as Parameters<typeof load>[0]
}

const baseUser = { id: 'u1', orgRole: 'member' }

describe('/(app) +layout.server.ts', () => {
  beforeEach(() => {
    getOnboardingStatusMock.mockReset()
    listProjectsMock.mockReset()
    getUsersMeMock.mockReset()
    getThemesMock.mockReset()
    getThemesMock.mockResolvedValue(noCustomThemes)
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

  it('when the per-user onboarding flag is not set and the org has no projects yet, lists projects (empty) and keeps the wizard gate open', async () => {
    getOnboardingStatusMock.mockResolvedValue({ completed: false })
    listProjectsMock.mockResolvedValue({ items: [], total: 0 })
    getUsersMeMock.mockResolvedValue({ notifications: { unreadCount: 0 } })

    const result = await load(makeEvent(baseUser))

    expect(result.onboardingCompleted).toBe(false)
    expect(listProjectsMock).toHaveBeenCalled()
    expect(result.projects).toEqual([])
  })

  it('AC-8: when the per-user onboarding flag is not set but the org already has a project, still fetches and returns it (even though the wizard gate closes)', async () => {
    getOnboardingStatusMock.mockResolvedValue({ completed: false })
    listProjectsMock.mockResolvedValue({ items: [{ id: 'p1', name: 'Payments' }], total: 1 })
    getUsersMeMock.mockResolvedValue({ notifications: { unreadCount: 0 } })

    const result = await load(makeEvent(baseUser))

    expect(result.onboardingCompleted).toBe(true)
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

  describe('theme resolution (Story 16.2 AC-2/AC-3/AC-6)', () => {
    it('AC-2: resolves appliedTheme to the caller selection when it is currently available', async () => {
      getOnboardingStatusMock.mockResolvedValue({ completed: true })
      getUsersMeMock.mockResolvedValue({ notifications: { unreadCount: 0 } })
      getThemesMock.mockResolvedValue({
        themes: [
          { name: 'base', label: 'Default', css: null },
          { name: 'acme-brand', label: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
        ],
        selected: 'acme-brand',
      })

      const result = await load(makeEvent(baseUser))

      expect(result.appliedTheme).toBe('acme-brand')
      expect(result.orphanedNotice).toBe(false)
      expect(result.orphanedThemeName).toBeNull()
      expect(result.themeCss).toBe('[data-theme="acme-brand"] {}')
    })

    it('AC-2: resolves appliedTheme to null (base) when nothing is selected', async () => {
      getOnboardingStatusMock.mockResolvedValue({ completed: true })
      getUsersMeMock.mockResolvedValue({ notifications: { unreadCount: 0 } })
      getThemesMock.mockResolvedValue(noCustomThemes)

      const result = await load(makeEvent(baseUser))

      expect(result.appliedTheme).toBeNull()
      expect(result.orphanedNotice).toBe(false)
    })

    it('AC-3: falls back to base and flags orphanedNotice when the selected theme is no longer compiled', async () => {
      getOnboardingStatusMock.mockResolvedValue({ completed: true })
      getUsersMeMock.mockResolvedValue({ notifications: { unreadCount: 0 } })
      getThemesMock.mockResolvedValue({
        themes: [{ name: 'base', label: 'Default', css: null }],
        selected: 'removed-theme',
      })

      const result = await load(makeEvent(baseUser))

      expect(result.appliedTheme).toBeNull()
      expect(result.orphanedNotice).toBe(true)
      expect(result.orphanedThemeName).toBe('removed-theme')
    })

    it('AC-3 edge: a re-installed same-named theme is simply re-applied on the next load (no stale orphan flag)', async () => {
      getOnboardingStatusMock.mockResolvedValue({ completed: true })
      getUsersMeMock.mockResolvedValue({ notifications: { unreadCount: 0 } })
      getThemesMock.mockResolvedValue({
        themes: [
          { name: 'base', label: 'Default', css: null },
          { name: 'acme-brand', label: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
        ],
        selected: 'acme-brand',
      })

      const result = await load(makeEvent(baseUser))

      expect(result.appliedTheme).toBe('acme-brand')
      expect(result.orphanedNotice).toBe(false)
    })

    it('fails open to the base theme (never crashes the layout load) when the themes fetch fails', async () => {
      getOnboardingStatusMock.mockResolvedValue({ completed: true })
      getUsersMeMock.mockResolvedValue({ notifications: { unreadCount: 0 } })
      getThemesMock.mockRejectedValue(new Error('boom'))

      const result = await load(makeEvent(baseUser))

      expect(result.appliedTheme).toBeNull()
      expect(result.orphanedNotice).toBe(false)
      expect(result.themeCss).toBe('')
    })
  })
})
