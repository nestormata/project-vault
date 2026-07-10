import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import NotificationsPage from './+page.svelte'

afterEach(() => cleanup())

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    preferences: [
      {
        alertType: 'credential.expiry',
        channel: 'email',
        frequency: 'immediate',
        minSeverity: 'warning',
      },
    ],
    routing: null,
    isAdmin: false,
    canSendTest: false,
    ...overrides,
  }
}

describe('/settings/notifications +page.svelte', () => {
  it('renders known preference rows with human labels', () => {
    render(NotificationsPage, { props: { data: baseData(), form: null } })

    expect(screen.getByText('Credential Expiry')).toBeTruthy()
    expect(screen.getAllByText('Immediate').length).toBeGreaterThan(0)
  })

  it('falls back to the raw alert type when no human label is registered', () => {
    render(NotificationsPage, {
      props: {
        data: baseData({
          preferences: [
            {
              alertType: 'unmapped.custom_type',
              channel: 'inbox',
              frequency: 'digest_daily',
              minSeverity: 'info',
            },
          ],
        }),
        form: null,
      },
    })

    expect(screen.getByText('unmapped.custom_type')).toBeTruthy()
    expect(screen.getAllByText('Daily digest').length).toBeGreaterThan(0)
  })

  it('a non-admin sees no org routing table and no test-notification panel', () => {
    render(NotificationsPage, { props: { data: baseData({ isAdmin: false }), form: null } })

    expect(screen.queryByText('Org-Level Routing')).toBeNull()
    expect(screen.queryByText('Send Test Notification')).toBeNull()
  })

  it('an admin without routing data still sees no routing table (isAdmin && routing required)', () => {
    render(NotificationsPage, {
      props: { data: baseData({ isAdmin: true, routing: null }), form: null },
    })

    expect(screen.queryByText('Org-Level Routing')).toBeNull()
    expect(screen.getByText('Send Test Notification')).toBeTruthy()
  })

  it('an admin with routing data sees the routing table', () => {
    render(NotificationsPage, {
      props: {
        data: baseData({
          isAdmin: true,
          routing: [{ alertType: 'service.down', routeTo: 'owner' }],
        }),
        form: null,
      },
    })

    expect(screen.getByText('Org-Level Routing')).toBeTruthy()
    expect(screen.getByText('Service Down')).toBeTruthy()
  })

  it('an admin who cannot send a test sees the MFA-enrollment hint, not the send button', () => {
    render(NotificationsPage, {
      props: { data: baseData({ isAdmin: true, canSendTest: false }), form: null },
    })

    expect(screen.getByText(/enroll in mfa to unlock/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /send test notification/i })).toBeNull()
  })

  it('an admin who can send a test sees the send button', () => {
    render(NotificationsPage, {
      props: { data: baseData({ isAdmin: true, canSendTest: true }), form: null },
    })

    expect(screen.getByRole('button', { name: /send test notification/i })).toBeTruthy()
  })

  it('renders a delivered/not-configured/failed test result distinctly per channel', () => {
    render(NotificationsPage, {
      props: {
        data: baseData({ isAdmin: true, canSendTest: true }),
        form: { testResult: { email: 'delivered', slack: 'not_configured' } },
      },
    })

    expect(screen.getByText('Delivered')).toBeTruthy()
    expect(screen.getByText('Not configured')).toBeTruthy()
  })

  it('renders a failed test-notification channel result', () => {
    render(NotificationsPage, {
      props: {
        data: baseData({ isAdmin: true, canSendTest: true }),
        form: { testResult: { email: 'failed', slack: 'delivered' } },
      },
    })

    expect(screen.getByText('Failed')).toBeTruthy()
  })

  it('renders an action error message when the form reports one', () => {
    render(NotificationsPage, {
      props: {
        data: baseData({ isAdmin: true, canSendTest: true }),
        form: { error: 'Failed to update preference' },
      },
    })

    expect(screen.getByText('Failed to update preference')).toBeTruthy()
  })

  it('renders no test-result and no error block when form is null', () => {
    render(NotificationsPage, {
      props: { data: baseData({ isAdmin: true, canSendTest: true }), form: null },
    })

    expect(screen.queryByText(/failed to update/i)).toBeNull()
  })
})
