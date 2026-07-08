import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const verifyAuditRangeMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/audit.js', () => ({
  verifyAuditRange: verifyAuditRangeMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import AuditVerifyPanel from './AuditVerifyPanel.svelte'

afterEach(() => cleanup())

async function fillAndSubmit(from = '2026-06-01', to = '2026-06-30') {
  await fireEvent.input(screen.getByLabelText(/from/i), { target: { value: from } })
  await fireEvent.input(screen.getByLabelText(/to/i), { target: { value: to } })
  await fireEvent.click(screen.getByRole('button', { name: /run integrity check/i }))
}

describe('AuditVerifyPanel (AC group D)', () => {
  it('AC-D1 happy path: renders the exact summary string from the API, non-cryptographer-friendly', async () => {
    verifyAuditRangeMock.mockResolvedValue({
      summary: 'All 1,247 records verified — no tampering detected',
      rowsChecked: 1247,
      passed: 1247,
      failed: [],
      failedCount: 0,
      failedTruncated: false,
      verifiedAt: '2026-07-07T00:00:00.000Z',
    })

    render(AuditVerifyPanel)
    await fillAndSubmit()

    expect(
      await screen.findByText('All 1,247 records verified — no tampering detected')
    ).toBeTruthy()
  })

  it('AC-D1 edge: rowsChecked 0 shows a plain non-error message', async () => {
    verifyAuditRangeMock.mockResolvedValue({
      summary: 'No audit events in this range',
      rowsChecked: 0,
      passed: 0,
      failed: [],
      failedCount: 0,
      failedTruncated: false,
      verifiedAt: '2026-07-07T00:00:00.000Z',
    })

    render(AuditVerifyPanel)
    await fillAndSubmit()

    expect(await screen.findByText(/no audit events in this range/i)).toBeTruthy()
  })

  it('AC-D2: renders the failed list with eventType and timestamp per row', async () => {
    verifyAuditRangeMock.mockResolvedValue({
      summary: '3 records failed verification',
      rowsChecked: 100,
      passed: 97,
      failed: [{ id: 'evt-1', eventType: 'credential.access', timestamp: '2026-06-14T10:03:00Z' }],
      failedCount: 1,
      failedTruncated: false,
      verifiedAt: '2026-07-07T00:00:00.000Z',
    })

    render(AuditVerifyPanel)
    await fillAndSubmit()

    expect(await screen.findByText(/credential\.access/)).toBeTruthy()
  })

  it('AC-D3: surfaces the exact 422 range_too_large message and keeps the date inputs populated', async () => {
    verifyAuditRangeMock.mockRejectedValue(
      new ApiClientError(
        422,
        { code: 'range_too_large', message: 'Please select a range of 90 days or fewer' },
        'Please select a range of 90 days or fewer'
      )
    )

    render(AuditVerifyPanel)
    await fillAndSubmit('2026-01-01', '2026-06-01')

    expect(await screen.findByText('Please select a range of 90 days or fewer')).toBeTruthy()
    expect((screen.getByLabelText(/from/i) as HTMLInputElement).value).toBe('2026-01-01')
    expect((screen.getByLabelText(/to/i) as HTMLInputElement).value).toBe('2026-06-01')
  })

  it('handles a 429 rate limit with a friendly message', async () => {
    verifyAuditRangeMock.mockRejectedValue(
      new ApiClientError(429, { message: 'Too many requests' }, 'Too many requests')
    )

    render(AuditVerifyPanel)
    await fillAndSubmit()

    expect(await screen.findByText(/doing that too quickly/i)).toBeTruthy()
  })
})
