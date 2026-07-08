import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'

vi.mock('$app/forms', () => ({ enhance: () => () => {} }))
vi.mock('$lib/state/notifications.svelte.js', () => ({
  markAllReadLocally: vi.fn(),
  decrementUnread: vi.fn(),
}))

import NotificationsPage from './+page.svelte'

afterEach(() => cleanup())

const userDormantAlertView = {
  id: 'alert-2',
  userId: 'user-1',
  displayName: 'jsmith@example.com',
  orgRole: 'member',
  lastActiveAt: '2026-04-04T00:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
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
})
