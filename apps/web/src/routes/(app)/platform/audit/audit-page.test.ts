import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'
import { ApiClientError } from '$lib/api/client.js'

const verifyPlatformAuditIntegrityMock = vi.hoisted(() => vi.fn())
const postMaintenanceModeMock = vi.hoisted(() => vi.fn())
const getMaintenanceModeStatusMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/platform.js', () => ({
  verifyPlatformAuditIntegrity: verifyPlatformAuditIntegrityMock,
  postMaintenanceMode: postMaintenanceModeMock,
  getMaintenanceModeStatus: getMaintenanceModeStatusMock,
}))

import AuditPage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const SAMPLE_EVENT = {
  id: 'evt-1',
  operatorId: '00000000-0000-4000-8000-000000000001',
  actionType: 'org.created',
  targetOrgId: 'org-1',
  targetUserId: null,
  ipAddress: '203.0.113.4',
  timestamp: '2026-07-08T00:00:00.000Z',
}

const INACTIVE_STATUS = {
  active: false,
  reason: null,
  activatedAt: null,
  deactivatedAt: '2026-07-01T00:00:00Z',
  pendingEntriesCount: 0,
}

const ACTIVE_STATUS = {
  active: true,
  reason: 'Storage outage',
  activatedAt: '2026-07-09T00:00:00Z',
  deactivatedAt: null,
  pendingEntriesCount: 4,
}

function allowedData(overrides: Record<string, unknown> = {}) {
  return {
    allowed: true as const,
    filters: {},
    page: 1,
    events: [SAMPLE_EVENT],
    total: 1,
    limit: 20,
    hasNext: false,
    eventsErrorMessage: null,
    maintenanceStatus: INACTIVE_STATUS,
    maintenanceStatusError: null,
    ...overrides,
  }
}

describe('/platform/audit +page.svelte', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/platform/audit')).toBe(true)
  })

  it('a non-operator sees the platform-operator-required notice, no panels', () => {
    render(AuditPage, { props: { data: { allowed: false } } })

    expect(screen.getByRole('heading', { name: /platform operator access required/i })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /verify integrity/i })).toBeNull()
  })

  it('renders event rows and the events table for an operator', () => {
    render(AuditPage, { props: { data: allowedData() } })

    expect(screen.getByText('org.created')).toBeTruthy()
    expect(screen.getByText('org-1')).toBeTruthy()
  })

  it('edge: shows the unfiltered empty-state message when there are no events', () => {
    render(AuditPage, { props: { data: allowedData({ events: [], total: 0, hasNext: false }) } })

    expect(screen.getByText(/no platform audit events yet/i)).toBeTruthy()
  })

  it('edge: shows the filtered empty-state message when filters are active', () => {
    render(AuditPage, {
      props: {
        data: allowedData({
          events: [],
          total: 0,
          hasNext: false,
          filters: { actionType: 'nonexistent' },
        }),
      },
    })

    expect(screen.getByText(/no platform audit events match these filters/i)).toBeTruthy()
  })

  it('surfaces eventsErrorMessage instead of the table', () => {
    render(AuditPage, {
      props: { data: allowedData({ eventsErrorMessage: 'Too many requests' }) },
    })

    expect(screen.getByText('Too many requests')).toBeTruthy()
    expect(screen.queryByText('org.created')).toBeNull()
  })

  it('blocks the search submission client-side when "to" precedes "from"', async () => {
    const { container } = render(AuditPage, { props: { data: allowedData() } })

    const fromInput = container.querySelector('#filter-actionType') as HTMLInputElement
    // Use the shared date range inputs rendered by AuditDateRangeInputs
    const fromDate = container.querySelector('input[name="from"]') as HTMLInputElement
    const toDate = container.querySelector('input[name="to"]') as HTMLInputElement
    expect(fromInput).toBeTruthy()
    await fireEvent.input(fromDate, { target: { value: '2026-06-30T00:00:00.000Z' } })
    await fireEvent.input(toDate, { target: { value: '2026-06-01T00:00:00.000Z' } })
    const form = fromDate.closest('form') as HTMLFormElement
    const submitEvent = await fireEvent.submit(form)

    expect(submitEvent).toBe(false)
    expect(screen.getByText(/end date must be after start date/i)).toBeTruthy()
  })

  it('shows a filter summary when filters are active', () => {
    render(AuditPage, {
      props: {
        data: allowedData({
          filters: { actionType: 'org.created', operatorId: 'op-1' },
        }),
      },
    })

    expect(screen.getByText(/action = org\.created/)).toBeTruthy()
    expect(screen.getByText(/operator = op-1/)).toBeTruthy()
  })

  it('shows Next pagination control when hasNext is true, and href preserves filters', () => {
    render(AuditPage, {
      props: {
        data: allowedData({ hasNext: true, filters: { actionType: 'org.created' } }),
      },
    })

    const next = screen.getByRole('link', { name: /next/i })
    expect(next.getAttribute('href')).toBe('?actionType=org.created&page=2')
  })

  it('maintenance banner: shows inactive banner when status is inactive', () => {
    render(AuditPage, { props: { data: allowedData({ maintenanceStatus: INACTIVE_STATUS }) } })

    expect(screen.getByText(/maintenance mode: inactive/i)).toBeTruthy()
  })

  it('maintenance banner: shows active alert banner with reason and pending count', () => {
    render(AuditPage, { props: { data: allowedData({ maintenanceStatus: ACTIVE_STATUS }) } })

    expect(screen.getByText(/maintenance mode is active/i)).toBeTruthy()
    expect(screen.getAllByText(/storage outage/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/4 entries queued/)).toBeTruthy()
  })

  it('maintenance banner: shows the status-unavailable alert and disables actions', () => {
    render(AuditPage, {
      props: {
        data: allowedData({
          maintenanceStatus: null,
          maintenanceStatusError: 'Maintenance mode status unavailable',
        }),
      },
    })

    expect(screen.getAllByText(/maintenance mode status unavailable/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/actions disabled/i)).toBeTruthy()
  })

  it('verify integrity: submit is disabled until both dates are filled, then calls the API and shows a passing result', async () => {
    verifyPlatformAuditIntegrityMock.mockResolvedValue({
      failedCount: 0,
      failed: [],
      failedTruncated: false,
      summary: 'All records verified',
      rowsChecked: 10,
      passed: 10,
      verifiedAt: '2026-07-10T00:00:00.000Z',
    })
    render(AuditPage, { props: { data: allowedData() } })

    const verifyButton = screen.getByRole('button', {
      name: /verify integrity/i,
    }) as HTMLButtonElement
    expect(verifyButton.disabled).toBe(true)

    const fromInput = document.querySelector('#verify-from') as HTMLInputElement
    const toInput = document.querySelector('#verify-to') as HTMLInputElement
    await fireEvent.input(fromInput, { target: { value: '2026-06-01T00:00:00.000Z' } })
    await fireEvent.input(toInput, { target: { value: '2026-06-30T00:00:00.000Z' } })
    expect(verifyButton.disabled).toBe(false)

    await fireEvent.click(verifyButton)
    await screen.findByText(/all records verified/i)

    expect(verifyPlatformAuditIntegrityMock).toHaveBeenCalledWith(expect.anything(), {
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T00:00:00.000Z',
    })
    expect(screen.getByText(/10 records checked, 10 passed/i)).toBeTruthy()
  })

  it('verify integrity: shows tampering-detected alert when failedCount > 0', async () => {
    verifyPlatformAuditIntegrityMock.mockResolvedValue({
      failedCount: 1,
      failed: [{ id: 'evt-x', actionType: 'org.deleted', timestamp: '2026-06-15T00:00:00.000Z' }],
      failedTruncated: true,
      summary: '1 mismatch found',
      rowsChecked: 10,
      passed: 9,
      verifiedAt: '2026-07-10T00:00:00.000Z',
    })
    render(AuditPage, { props: { data: allowedData() } })

    await fireEvent.input(document.querySelector('#verify-from') as HTMLInputElement, {
      target: { value: '2026-06-01T00:00:00.000Z' },
    })
    await fireEvent.input(document.querySelector('#verify-to') as HTMLInputElement, {
      target: { value: '2026-06-30T00:00:00.000Z' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /verify integrity/i }))

    expect(await screen.findByText(/tampering detected/i)).toBeTruthy()
    expect(screen.getByText(/org\.deleted/)).toBeTruthy()
    expect(screen.getByText(/…\(truncated\)/)).toBeTruthy()
  })

  it('verify integrity: shows a friendly error on API failure', async () => {
    verifyPlatformAuditIntegrityMock.mockRejectedValue(
      new ApiClientError(500, { message: 'Verification unavailable' }, 'Verification unavailable')
    )
    render(AuditPage, { props: { data: allowedData() } })

    await fireEvent.input(document.querySelector('#verify-from') as HTMLInputElement, {
      target: { value: '2026-06-01T00:00:00.000Z' },
    })
    await fireEvent.input(document.querySelector('#verify-to') as HTMLInputElement, {
      target: { value: '2026-06-30T00:00:00.000Z' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /verify integrity/i }))

    expect(await screen.findByText('Verification unavailable')).toBeTruthy()
  })

  it('maintenance activate: requires a non-empty reason before the confirm control is enabled', async () => {
    render(AuditPage, { props: { data: allowedData({ maintenanceStatus: INACTIVE_STATUS }) } })

    const activateButton = screen.getByRole('button', {
      name: /^activate maintenance mode$/i,
    }) as HTMLButtonElement
    expect(activateButton.disabled).toBe(true)

    const reasonBox = screen.getByPlaceholderText(/reason for activating/i)
    await fireEvent.input(reasonBox, { target: { value: 'Storage outage recovery' } })
    expect(activateButton.disabled).toBe(false)
  })

  it('maintenance activate: two-step confirm calls postMaintenanceMode and refreshes status', async () => {
    postMaintenanceModeMock.mockResolvedValue(undefined)
    getMaintenanceModeStatusMock.mockResolvedValue(ACTIVE_STATUS)
    render(AuditPage, { props: { data: allowedData({ maintenanceStatus: INACTIVE_STATUS }) } })

    await fireEvent.input(screen.getByPlaceholderText(/reason for activating/i), {
      target: { value: 'Storage outage recovery' },
    })
    const activateButton = screen.getByRole('button', { name: /^activate maintenance mode$/i })
    await fireEvent.click(activateButton)
    await fireEvent.click(screen.getByRole('button', { name: /confirm activation/i }))

    expect(postMaintenanceModeMock).toHaveBeenCalledWith(expect.anything(), {
      action: 'activate',
      reason: 'Storage outage recovery',
    })
    expect(await screen.findByText(/maintenance mode is active/i)).toBeTruthy()
  })

  it('maintenance activate: shows an MFA-required notice distinct from a generic error', async () => {
    postMaintenanceModeMock.mockRejectedValue(
      new ApiClientError(
        403,
        { code: 'mfa_required', message: 'MFA is required' },
        'MFA is required'
      )
    )
    render(AuditPage, { props: { data: allowedData({ maintenanceStatus: INACTIVE_STATUS }) } })

    await fireEvent.input(screen.getByPlaceholderText(/reason for activating/i), {
      target: { value: 'Storage outage recovery' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /^activate maintenance mode$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm activation/i }))

    expect(await screen.findByText('MFA is required')).toBeTruthy()
  })

  it('maintenance activate: 409 conflict shows already-active message and re-checks status', async () => {
    postMaintenanceModeMock.mockRejectedValue(
      new ApiClientError(
        409,
        { message: 'Maintenance mode is already active.' },
        'Maintenance mode is already active.'
      )
    )
    getMaintenanceModeStatusMock.mockResolvedValue(ACTIVE_STATUS)
    render(AuditPage, { props: { data: allowedData({ maintenanceStatus: INACTIVE_STATUS }) } })

    await fireEvent.input(screen.getByPlaceholderText(/reason for activating/i), {
      target: { value: 'Storage outage recovery' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /^activate maintenance mode$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm activation/i }))

    expect(await screen.findByText('Maintenance mode is already active.')).toBeTruthy()
    expect(getMaintenanceModeStatusMock).toHaveBeenCalled()
  })

  it('maintenance deactivate: two-step confirm calls postMaintenanceMode(deactivate) and refreshes to inactive', async () => {
    postMaintenanceModeMock.mockResolvedValue(undefined)
    getMaintenanceModeStatusMock.mockResolvedValue(INACTIVE_STATUS)
    render(AuditPage, { props: { data: allowedData({ maintenanceStatus: ACTIVE_STATUS }) } })

    const deactivateButton = screen.getByRole('button', { name: /deactivate maintenance mode/i })
    await fireEvent.click(deactivateButton)
    await fireEvent.click(screen.getByRole('button', { name: /confirm deactivation/i }))

    expect(postMaintenanceModeMock).toHaveBeenCalledWith(expect.anything(), {
      action: 'deactivate',
    })
    expect(await screen.findByText(/maintenance mode: inactive/i)).toBeTruthy()
  })

  it('maintenance deactivate: 503 shows audit-log-unavailable message', async () => {
    postMaintenanceModeMock.mockRejectedValue(
      new ApiClientError(
        503,
        { message: 'Cannot deactivate maintenance mode: platform audit log is still unavailable' },
        'Cannot deactivate maintenance mode: platform audit log is still unavailable'
      )
    )
    getMaintenanceModeStatusMock.mockResolvedValue(ACTIVE_STATUS)
    render(AuditPage, { props: { data: allowedData({ maintenanceStatus: ACTIVE_STATUS }) } })

    await fireEvent.click(screen.getByRole('button', { name: /deactivate maintenance mode/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm deactivation/i }))

    expect(await screen.findByText(/platform audit log is still unavailable/i)).toBeTruthy()
  })

  it('the org audit log link resolves to a real route', () => {
    render(AuditPage, { props: { data: allowedData() } })

    const link = screen.getByRole('link', { name: /audit & compliance/i })
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
  })

  it('maintenance activate: an unrecognized ApiClientError status shows its own message', async () => {
    postMaintenanceModeMock.mockRejectedValue(new ApiClientError(500, {}, 'server exploded'))
    render(AuditPage, { props: { data: allowedData({ maintenanceStatus: INACTIVE_STATUS }) } })

    await fireEvent.input(screen.getByPlaceholderText(/reason for activating/i), {
      target: { value: 'Storage outage recovery' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /^activate maintenance mode$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm activation/i }))

    expect(await screen.findByText('server exploded')).toBeTruthy()
  })

  it('maintenance activate: a non-ApiClientError (network failure) shows the generic activation-failed message', async () => {
    postMaintenanceModeMock.mockRejectedValue(new Error('network down'))
    render(AuditPage, { props: { data: allowedData({ maintenanceStatus: INACTIVE_STATUS }) } })

    await fireEvent.input(screen.getByPlaceholderText(/reason for activating/i), {
      target: { value: 'Storage outage recovery' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /^activate maintenance mode$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm activation/i }))

    expect(await screen.findByText(/^failed to activate maintenance mode$/i)).toBeTruthy()
  })

  it('maintenance deactivate: shows an MFA-required notice distinct from a generic error', async () => {
    postMaintenanceModeMock.mockRejectedValue(
      new ApiClientError(
        403,
        { code: 'mfa_required', message: 'MFA is required' },
        'MFA is required'
      )
    )
    render(AuditPage, { props: { data: allowedData({ maintenanceStatus: ACTIVE_STATUS }) } })

    await fireEvent.click(screen.getByRole('button', { name: /deactivate maintenance mode/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm deactivation/i }))

    expect(await screen.findByText('MFA is required')).toBeTruthy()
  })

  it('maintenance deactivate: an unrecognized ApiClientError status shows its own message', async () => {
    postMaintenanceModeMock.mockRejectedValue(new ApiClientError(500, {}, 'server exploded'))
    render(AuditPage, { props: { data: allowedData({ maintenanceStatus: ACTIVE_STATUS }) } })

    await fireEvent.click(screen.getByRole('button', { name: /deactivate maintenance mode/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm deactivation/i }))

    expect(await screen.findByText('server exploded')).toBeTruthy()
  })

  it('maintenance deactivate: a non-ApiClientError (network failure) shows the generic deactivation-failed message', async () => {
    postMaintenanceModeMock.mockRejectedValue(new Error('network down'))
    render(AuditPage, { props: { data: allowedData({ maintenanceStatus: ACTIVE_STATUS }) } })

    await fireEvent.click(screen.getByRole('button', { name: /deactivate maintenance mode/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm deactivation/i }))

    expect(await screen.findByText(/^failed to deactivate maintenance mode$/i)).toBeTruthy()
  })

  it('verify integrity: a non-ApiClientError (network failure) shows the generic verification message', async () => {
    verifyPlatformAuditIntegrityMock.mockRejectedValue(new Error('network down'))
    render(AuditPage, { props: { data: allowedData() } })

    await fireEvent.input(document.querySelector('#verify-from') as HTMLInputElement, {
      target: { value: '2026-06-01T00:00:00.000Z' },
    })
    await fireEvent.input(document.querySelector('#verify-to') as HTMLInputElement, {
      target: { value: '2026-06-30T00:00:00.000Z' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /verify integrity/i }))

    expect(await screen.findByText(/^verification failed$/i)).toBeTruthy()
  })

  it('shows a filter summary combining action, operator, org, and user filters', () => {
    render(AuditPage, {
      props: {
        data: allowedData({
          filters: {
            actionType: 'org.create',
            operatorId: 'op-1',
            targetOrgId: 'org-1',
            targetUserId: 'user-1',
          },
        }),
      },
    })

    expect(screen.getByText(/action = org.create/)).toBeTruthy()
    expect(screen.getByText(/operator = op-1/)).toBeTruthy()
    expect(screen.getByText(/org = org-1/)).toBeTruthy()
    expect(screen.getByText(/user = user-1/)).toBeTruthy()
  })
})
