import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const snoozeAlertMock = vi.hoisted(() => vi.fn())
const dismissAlertMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/monitoring-alerts.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/api/monitoring-alerts.js')>()
  return {
    ...original,
    snoozeAlert: snoozeAlertMock,
    dismissAlert: dismissAlertMock,
  }
})

import ActiveAlertsPanel from './ActiveAlertsPanel.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const alertId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const endpointId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function makeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: alertId,
    alertType: 'service.down' as const,
    severity: 'critical' as const,
    status: 'active' as const,
    episodeKey: 'ep-1',
    serviceEndpointId: endpointId,
    snoozedUntil: null,
    dismissedBy: null,
    dismissedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

const endpointNames = [{ id: endpointId, name: 'API health' }]

describe('ActiveAlertsPanel (Story 6.4 AC-F1/F2/F3)', () => {
  beforeEach(() => {
    snoozeAlertMock.mockReset()
    dismissAlertMock.mockReset()
  })
  afterEach(() => cleanup())

  it('AC-F1 edge: renders a "No active alerts" note when the list is empty', () => {
    render(ActiveAlertsPanel, {
      props: { alerts: [], endpoints: endpointNames, orgRole: 'member', projectId },
    })
    expect(screen.getByText('No active alerts')).toBeTruthy()
  })

  it('AC-F1: shows alertType/severity/endpoint name/createdAt for an active alert', () => {
    render(ActiveAlertsPanel, {
      props: { alerts: [makeAlert()], endpoints: endpointNames, orgRole: 'member', projectId },
    })
    expect(screen.getByText('API health')).toBeTruthy()
    expect(screen.getByText(/service\.down/i)).toBeTruthy()
    expect(screen.getByText(/critical/i)).toBeTruthy()
  })

  it('AC-F1 edge: shows "Endpoint deleted" when serviceEndpointId is null', () => {
    render(ActiveAlertsPanel, {
      props: {
        alerts: [makeAlert({ serviceEndpointId: null })],
        endpoints: endpointNames,
        orgRole: 'member',
        projectId,
      },
    })
    expect(screen.getByText('Endpoint deleted')).toBeTruthy()
  })

  it('AC-I1: member sees Snooze but not Dismiss; admin sees both', () => {
    const { unmount } = render(ActiveAlertsPanel, {
      props: { alerts: [makeAlert()], endpoints: endpointNames, orgRole: 'member', projectId },
    })
    expect(screen.getByRole('button', { name: /Snooze 1 hour/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    unmount()

    render(ActiveAlertsPanel, {
      props: { alerts: [makeAlert()], endpoints: endpointNames, orgRole: 'admin', projectId },
    })
    expect(screen.getByRole('button', { name: /Snooze 1 hour/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('AC-F2 happy path: snoozing for 1 hour calls snoozeAlert with durationMinutes 60', async () => {
    snoozeAlertMock.mockResolvedValue({
      ...makeAlert(),
      status: 'snoozed',
      snoozedUntil: '2026-07-01T01:00:00.000Z',
    })
    render(ActiveAlertsPanel, {
      props: { alerts: [makeAlert()], endpoints: endpointNames, orgRole: 'member', projectId },
    })

    await fireEvent.click(screen.getByRole('button', { name: /Snooze 1 hour/i }))

    await waitFor(() =>
      expect(snoozeAlertMock).toHaveBeenCalledWith(expect.anything(), projectId, alertId, {
        durationMinutes: 60,
      })
    )
    expect(await screen.findByText(/Snoozed until/)).toBeTruthy()
  })

  it('AC-F2 edge: the snooze control remains available (not disabled) on an already-snoozed alert', () => {
    render(ActiveAlertsPanel, {
      props: {
        alerts: [makeAlert({ status: 'snoozed', snoozedUntil: '2026-07-01T01:00:00.000Z' })],
        endpoints: endpointNames,
        orgRole: 'member',
        projectId,
      },
    })
    const button = screen.getByRole('button', { name: /Snooze 1 hour/i }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })

  it('AC-F3 happy path (admin): dismiss requires two-step confirm, then removes the alert', async () => {
    dismissAlertMock.mockResolvedValue({ ...makeAlert(), status: 'dismissed' })
    render(ActiveAlertsPanel, {
      props: { alerts: [makeAlert()], endpoints: endpointNames, orgRole: 'admin', projectId },
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm dismiss?' }))

    await waitFor(() =>
      expect(dismissAlertMock).toHaveBeenCalledWith(expect.anything(), projectId, alertId)
    )
    await waitFor(() => expect(screen.queryByText('API health')).toBeNull())
  })

  it('AC-F2 failure: a stale 409 from snooze (already dismissed elsewhere) shows an error banner, not a crash', async () => {
    snoozeAlertMock.mockRejectedValue(
      new ApiClientError(409, { code: 'alert_dismissed' }, 'Alert is dismissed')
    )
    render(ActiveAlertsPanel, {
      props: { alerts: [makeAlert()], endpoints: endpointNames, orgRole: 'member', projectId },
    })

    await fireEvent.click(screen.getByRole('button', { name: /Snooze 1 hour/i }))

    expect(await screen.findByText('Alert is dismissed')).toBeTruthy()
  })
})
