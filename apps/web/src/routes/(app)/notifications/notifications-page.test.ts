import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'

type EnhancedSubmitCallback = (input: { cancel?: () => void }) => {
  update: (input: { update: () => void }) => void
}

const enhanceCallbacks = vi.hoisted(() => new Map<HTMLFormElement, EnhancedSubmitCallback>())
const markAllReadLocallyMock = vi.hoisted(() => vi.fn())
const decrementUnreadMock = vi.hoisted(() => vi.fn())

vi.mock('$app/forms', () => ({
  enhance: (form: HTMLFormElement, callback?: EnhancedSubmitCallback) => {
    if (callback) enhanceCallbacks.set(form, callback)
    return { destroy: () => enhanceCallbacks.delete(form) }
  },
}))
vi.mock('$lib/state/notifications.svelte.js', () => ({
  markAllReadLocally: markAllReadLocallyMock,
  decrementUnread: decrementUnreadMock,
}))

import NotificationsPage from './+page.svelte'

afterEach(() => {
  cleanup()
  enhanceCallbacks.clear()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

const userDormantAlertView = {
  id: 'alert-2',
  userId: 'user-1',
  displayName: 'jsmith@example.com',
  orgRole: 'member',
  lastActiveAt: '2026-04-04T00:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
}

const unreadNotification = {
  id: 'notification-1',
  title: 'API unavailable',
  body: 'The production API is down.',
  severity: 'critical',
  alertType: 'service.down',
  projectId: 'project-1',
  readAt: null,
  createdAt: '2026-07-10T00:00:00.000Z',
}

function formFor(button: HTMLElement): HTMLFormElement {
  const form = button.closest('form')
  if (!form) throw new Error('Expected button to belong to a form')
  return form
}

function enhancedSubmit(button: HTMLElement) {
  const callback = enhanceCallbacks.get(formFor(button))
  if (!callback) throw new Error('Expected enhanced form callback')
  return callback
}

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    notifications: [],
    total: 0,
    hasNext: false,
    page: 1,
    status: 'all' as const,
    orgRole: 'admin',
    dormancyAlerts: [],
    userDormancyAlerts: [],
    ...overrides,
  }
}

describe('/notifications +page.svelte (Story 8.7 AC group H / AC-A3)', () => {
  it('AC-A3/H1: renders a "Dormant user alerts" section for an admin with an open alert', () => {
    render(NotificationsPage, {
      props: { data: baseData({ userDormancyAlerts: [userDormantAlertView] }) },
    })

    expect(screen.getByText(/dormant user alerts/i)).toBeTruthy()
    expect(screen.getByText(/jsmith@example.com/)).toBeTruthy()
    expect(screen.getByText(/last active/i)).toBeTruthy()
  })

  it('AC-H1: renders Dismiss, Deactivate account, and a Pseudonymize identity link', () => {
    render(NotificationsPage, {
      props: { data: baseData({ userDormancyAlerts: [userDormantAlertView] }) },
    })

    expect(screen.getByRole('button', { name: /dismiss/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /deactivate account/i })).toBeTruthy()
    const link = screen.getByRole('link', { name: /pseudonymize identity/i })
    expect(link.getAttribute('href')).toBe('/settings/users')
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
  })

  it('AC-H1 edge: dismiss without a reason is blocked client-side', async () => {
    render(NotificationsPage, {
      props: { data: baseData({ userDormancyAlerts: [userDormantAlertView] }) },
    })

    const reasonInputs = screen.getAllByPlaceholderText(/reason for dismissing/i)
    const submitButtons = screen.getAllByRole('button', { name: /^dismiss$/i })
    // Find the user-dormancy section's own dismiss form (last one, since it's rendered after the
    // machine-key section in the DOM).
    const userSectionReasonInput = reasonInputs[reasonInputs.length - 1] as HTMLInputElement
    expect(userSectionReasonInput.required).toBe(true)
    expect(submitButtons.length).toBeGreaterThan(0)
  })

  it('AC-H2: shows "No dormant user alerts" when the list is empty (not indistinguishable from a loading/error state)', () => {
    render(NotificationsPage, { props: { data: baseData({ userDormancyAlerts: [] }) } })

    expect(screen.getByText(/no dormant user alerts/i)).toBeTruthy()
  })

  it('AC-H3: a member/viewer sees neither dormancy section', () => {
    render(NotificationsPage, {
      props: { data: baseData({ orgRole: 'member', userDormancyAlerts: [], dormancyAlerts: [] }) },
    })

    expect(screen.queryByText(/dormant user alerts/i)).toBeNull()
    expect(screen.queryByText(/machine key dormancy alerts/i)).toBeNull()
  })

  it('renders unread known notifications with a project link and local mark/dismiss updates', () => {
    render(NotificationsPage, {
      props: { data: baseData({ notifications: [unreadNotification], total: 1 }) },
    })

    expect(screen.getByText('Service Down')).toBeTruthy()
    expect(screen.getByTitle('Unread')).toBeTruthy()
    expect(screen.getByRole('link', { name: /view project/i }).getAttribute('href')).toBe(
      '/projects/project-1'
    )

    const update = vi.fn()
    const markAllResult = enhancedSubmit(screen.getByRole('button', { name: /mark all as read/i }))(
      {}
    )
    markAllResult.update({ update })
    expect(markAllReadLocallyMock).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledTimes(1)

    enhancedSubmit(screen.getByRole('button', { name: /^mark as read$/i }))({}).update({ update })
    enhancedSubmit(screen.getByRole('button', { name: /^dismiss$/i }))({}).update({ update })
    expect(decrementUnreadMock).toHaveBeenCalledTimes(2)
  })

  it('renders read unknown notifications with fallbacks and no read or project action', () => {
    render(NotificationsPage, {
      props: {
        data: baseData({
          notifications: [
            {
              ...unreadNotification,
              id: 'notification-unknown',
              severity: 'mystery',
              alertType: 'custom.alert',
              projectId: null,
              readAt: '2026-07-10T01:00:00.000Z',
            },
          ],
        }),
      },
    })

    expect(screen.getByText('custom.alert')).toBeTruthy()
    expect(screen.queryByTitle('Unread')).toBeNull()
    expect(screen.queryByRole('button', { name: /mark as read/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /view project/i })).toBeNull()
    const update = vi.fn()
    enhancedSubmit(screen.getByRole('button', { name: /^dismiss$/i }))({}).update({ update })
    expect(decrementUnreadMock).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalled()
  })

  it('distinguishes unread and all empty-state copy', () => {
    render(NotificationsPage, { props: { data: baseData({ status: 'unread' }) } })
    expect(screen.getByText(/all caught up/i)).toBeTruthy()
    cleanup()
    render(NotificationsPage, { props: { data: baseData({ status: 'all' }) } })
    expect(screen.getByText(/notifications will appear/i)).toBeTruthy()
  })

  it('renders previous and next only at their shipped pagination boundaries', () => {
    const notifications = Array.from({ length: 20 }, (_, index) => ({
      ...unreadNotification,
      id: `notification-${index}`,
      title: `Alert ${index}`,
      readAt: '2026-07-10T01:00:00.000Z',
    }))
    render(NotificationsPage, {
      props: { data: baseData({ notifications, page: 2, status: 'read' }) },
    })
    expect(screen.getByRole('link', { name: /previous/i }).getAttribute('href')).toBe(
      '/notifications?page=1&status=read'
    )
    expect(screen.getByRole('link', { name: /next/i }).getAttribute('href')).toBe(
      '/notifications?page=3&status=read'
    )
    cleanup()
    render(NotificationsPage, {
      props: { data: baseData({ notifications: notifications.slice(0, 19), page: 1 }) },
    })
    expect(screen.queryByRole('link', { name: /previous/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /next/i })).toBeNull()
  })

  it('renders machine-key dormancy variants and cancels or accepts key revocation', () => {
    const alerts = [
      {
        id: 'machine-alert-1',
        projectId: 'project-1',
        machineUserId: 'machine-1',
        machineUserName: 'Deploy Bot',
        keyId: 'key-1',
        keyName: 'Production',
        lastUsedAt: null,
      },
      {
        id: 'machine-alert-2',
        projectId: 'project-1',
        machineUserId: 'machine-2',
        machineUserName: 'Backup Bot',
        keyId: 'key-2',
        keyName: 'Nightly',
        lastUsedAt: '2026-07-01T00:00:00.000Z',
      },
    ]
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(NotificationsPage, { props: { data: baseData({ dormancyAlerts: alerts }) } })
    expect(screen.getByText(/last used: never/i)).toBeTruthy()
    expect(
      screen.getAllByRole('link', { name: /view machine user/i })[0]?.getAttribute('href')
    ).toBe('/projects/project-1/machine-users/machine-1')
    const revokeButtons = screen.getAllByRole('button', { name: /revoke key/i })
    const cancel = vi.fn()
    enhancedSubmit(revokeButtons[0] as HTMLElement)({ cancel })
    enhancedSubmit(revokeButtons[1] as HTMLElement)({ cancel })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels or accepts dormant-user deactivation confirmation', () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(NotificationsPage, {
      props: {
        data: baseData({
          userDormancyAlerts: [
            userDormantAlertView,
            { ...userDormantAlertView, id: 'alert-3', userId: 'user-2', lastActiveAt: null },
          ],
        }),
      },
    })
    expect(screen.getByText(/never active/i)).toBeTruthy()
    const buttons = screen.getAllByRole('button', { name: /deactivate account/i })
    const cancel = vi.fn()
    enhancedSubmit(buttons[0] as HTMLElement)({ cancel })
    enhancedSubmit(buttons[1] as HTMLElement)({ cancel })
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
