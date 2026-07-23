import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const logoutMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

vi.mock('$lib/api/auth.js', () => ({
  logout: logoutMock,
}))

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/dashboard') },
}))

import AppShell from './AppShell.svelte'

afterEach(() => {
  cleanup()
  gotoMock.mockClear()
  logoutMock.mockReset()
  logoutMock.mockResolvedValue(undefined)
})

function childrenSnippet(text = 'page body') {
  return createRawSnippet(() => ({
    render: () => `<p>${text}</p>`,
  }))
}

function baseUser(overrides: Record<string, unknown> = {}) {
  return {
    orgId: 'org-1',
    orgName: 'Acme Inc',
    orgRole: 'owner',
    isPlatformOperator: false,
    mfaStatus: {
      enrollmentRequired: false,
      gracePeriodActive: false,
      gracePeriodExpiresAt: null,
      gracePeriodDaysRemaining: null,
      bannerMessage: null,
    },
    ...overrides,
  }
}

describe('AppShell.svelte', () => {
  it('shows a plain title (no dashboard link) and hides PrimaryNav when hidePrimaryNav is true', () => {
    render(AppShell, {
      props: {
        user: baseUser(),
        children: childrenSnippet(),
        hidePrimaryNav: true,
      },
    })

    expect(screen.queryByRole('link', { name: 'Project Vault' })).toBeNull()
    expect(screen.getByText('Project Vault')).toBeTruthy()
    expect(screen.queryByTestId('primary-nav')).toBeNull()
    expect(screen.queryByRole('link', { name: /notifications/i })).toBeNull()
  })

  it('shows a dashboard link title and renders PrimaryNav + notifications link when hidePrimaryNav is false', () => {
    render(AppShell, {
      props: {
        user: baseUser(),
        children: childrenSnippet(),
        hidePrimaryNav: false,
      },
    })

    const titleLink = screen.getByRole('link', { name: 'Project Vault' })
    expect(titleLink.getAttribute('href')).toBe('/dashboard')
    expect(screen.getByTestId('primary-nav')).toBeTruthy()
    // AC-24: the primary nav item and the header's notification-bell link now share the same
    // "Notifications" accessible name (nav label renamed from "Alerts" to match the destination
    // page's own heading) — both are expected to be present.
    expect(screen.getAllByRole('link', { name: /notifications/i }).length).toBeGreaterThanOrEqual(2)
  })

  it('does not show an unread badge when unreadCount is 0', () => {
    render(AppShell, {
      props: {
        user: baseUser(),
        children: childrenSnippet(),
        hidePrimaryNav: false,
        unreadCount: 0,
      },
    })

    expect(screen.queryByLabelText('Notifications')?.querySelector('span.absolute')).toBeNull()
  })

  it('shows the exact unread count when between 1 and 99', () => {
    render(AppShell, {
      props: {
        user: baseUser(),
        children: childrenSnippet(),
        hidePrimaryNav: false,
        unreadCount: 5,
      },
    })

    expect(screen.getByText('5')).toBeTruthy()
  })

  it('caps the unread badge at "99+" above 99', () => {
    render(AppShell, {
      props: {
        user: baseUser(),
        children: childrenSnippet(),
        hidePrimaryNav: false,
        unreadCount: 140,
      },
    })

    expect(screen.getByText('99+')).toBeTruthy()
  })

  it('renders the mfa banner when enrollmentRequired is true even without a bannerMessage', () => {
    render(AppShell, {
      props: {
        user: baseUser({
          mfaStatus: {
            enrollmentRequired: true,
            gracePeriodActive: false,
            gracePeriodExpiresAt: null,
            gracePeriodDaysRemaining: null,
            bannerMessage: null,
          },
        }),
        children: childrenSnippet(),
      },
    })

    expect(document.querySelector('.border-amber-200')).toBeTruthy()
  })

  it('renders the mfa banner text when bannerMessage is set', () => {
    render(AppShell, {
      props: {
        user: baseUser({
          mfaStatus: {
            enrollmentRequired: false,
            gracePeriodActive: true,
            gracePeriodExpiresAt: null,
            gracePeriodDaysRemaining: 3,
            bannerMessage: 'MFA grace period ends in 3 days',
          },
        }),
        children: childrenSnippet(),
      },
    })

    expect(screen.getByText('MFA grace period ends in 3 days')).toBeTruthy()
  })

  it('shows no mfa banner when neither enrollmentRequired nor bannerMessage are set', () => {
    render(AppShell, { props: { user: baseUser(), children: childrenSnippet() } })

    expect(document.querySelector('.border-amber-200')).toBeNull()
  })

  it('renders provided role and org name, and invokes onsearch from PrimaryNav', async () => {
    const onsearch = vi.fn()
    render(AppShell, {
      props: {
        user: baseUser({ orgRole: 'admin', orgName: 'Test Org' }),
        children: childrenSnippet(),
        hidePrimaryNav: false,
        onsearch,
      },
    })

    expect(screen.getByText('Role: admin')).toBeTruthy()
    expect(screen.getByText('Org: Test Org')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: /search/i }))
    expect(onsearch).toHaveBeenCalled()
  })

  it('signs out successfully: calls logout then redirects to login with a logged-out reason', async () => {
    render(AppShell, { props: { user: baseUser(), children: childrenSnippet() } })

    await fireEvent.click(screen.getByRole('button', { name: /sign out/i }))

    expect(logoutMock).toHaveBeenCalled()
    expect(gotoMock).toHaveBeenCalledWith('/login?reason=logged-out')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('still redirects to login even when logout() throws, swallowing the error silently', async () => {
    logoutMock.mockRejectedValueOnce(new Error('network down'))
    render(AppShell, { props: { user: baseUser(), children: childrenSnippet() } })

    await fireEvent.click(screen.getByRole('button', { name: /sign out/i }))

    expect(gotoMock).toHaveBeenCalledWith('/login?reason=logged-out')
  })

  it('renders children in the main content area', () => {
    render(AppShell, {
      props: { user: baseUser(), children: childrenSnippet('unique child content') },
    })

    expect(screen.getByText('unique child content')).toBeTruthy()
  })
})
