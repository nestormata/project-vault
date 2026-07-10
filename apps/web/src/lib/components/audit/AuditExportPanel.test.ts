import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const triggerAuditExportMock = vi.hoisted(() => vi.fn())
const getAuditExportStatusMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/audit.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/api/audit.js')>('$lib/api/audit.js')
  return {
    ...actual,
    triggerAuditExport: triggerAuditExportMock,
    getAuditExportStatus: getAuditExportStatusMock,
  }
})

import { ApiClientError } from '$lib/api/client.js'
import AuditExportPanel from './AuditExportPanel.svelte'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

beforeEach(() => {
  triggerAuditExportMock.mockReset()
  getAuditExportStatusMock.mockReset()
})

async function startExport(from = '2026-06-01', to = '2026-06-30') {
  await fireEvent.input(screen.getByLabelText(/from/i), { target: { value: from } })
  await fireEvent.input(screen.getByLabelText(/to/i), { target: { value: to } })
  await fireEvent.click(screen.getByRole('button', { name: /export csv/i }))
}

describe('AuditExportPanel (AC group C)', () => {
  it('AC-C1 happy path: polls until completed, then shows a Download CSV link', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    triggerAuditExportMock.mockResolvedValue({ jobId: 'job-1', status: 'pending' })
    getAuditExportStatusMock
      .mockResolvedValueOnce({
        jobId: 'job-1',
        status: 'processing',
        downloadUrl: null,
        createdAt: '2026-07-07T00:00:00.000Z',
        completedAt: null,
      })
      .mockResolvedValueOnce({
        jobId: 'job-1',
        status: 'completed',
        downloadUrl: null,
        createdAt: '2026-07-07T00:00:00.000Z',
        completedAt: '2026-07-07T00:01:00.000Z',
      })

    render(AuditExportPanel)
    await startExport()

    expect(await screen.findByText(/verifying integrity, then generating export/i)).toBeTruthy()

    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)

    const link = await screen.findByRole('link', { name: /download csv/i })
    expect(link.getAttribute('href')).toBe('/api/v1/org/audit/exports/job-1/download')
  })

  it('AC-C2: a failed integrity verification shows the failure message and no download link', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    triggerAuditExportMock.mockResolvedValue({ jobId: 'job-2', status: 'pending' })
    getAuditExportStatusMock.mockResolvedValueOnce({
      jobId: 'job-2',
      status: 'failed',
      downloadUrl: null,
      integritySummary: { passed: 1200, failedCount: 3 },
      createdAt: '2026-07-07T00:00:00.000Z',
      completedAt: '2026-07-07T00:01:00.000Z',
    })

    render(AuditExportPanel)
    await startExport()
    await vi.advanceTimersByTimeAsync(2000)

    expect(await screen.findByText(/export failed/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /download csv/i })).toBeNull()
  })

  it('AC-C3: surfaces the exact 422 range_too_large message from the trigger call', async () => {
    triggerAuditExportMock.mockRejectedValue(
      new ApiClientError(
        422,
        {
          code: 'range_too_large',
          message: 'Export range too large — please export in smaller date windows',
        },
        'Export range too large — please export in smaller date windows'
      )
    )

    render(AuditExportPanel)
    await startExport()

    expect(
      await screen.findByText('Export range too large — please export in smaller date windows')
    ).toBeTruthy()
  })

  it('AC-C1 edge: stops polling after the 60-attempt cap and shows a manual "Check again" control', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    triggerAuditExportMock.mockResolvedValue({ jobId: 'job-3', status: 'pending' })
    getAuditExportStatusMock.mockResolvedValue({
      jobId: 'job-3',
      status: 'processing',
      downloadUrl: null,
      createdAt: '2026-07-07T00:00:00.000Z',
      completedAt: null,
    })

    render(AuditExportPanel)
    await startExport()

    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(2000)
    }

    expect(await screen.findByText(/taking longer than expected/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /check again/i })).toBeTruthy()
    // No further automatic poll should have been scheduled beyond the cap.
    const callCountAtCap = getAuditExportStatusMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getAuditExportStatusMock.mock.calls).toHaveLength(callCountAtCap)
  }, 10000)

  it('AC-C1 failure: a 429 mid-poll shows a rate-limit message and backs off instead of failing terminally', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    triggerAuditExportMock.mockResolvedValue({ jobId: 'job-4', status: 'pending' })
    getAuditExportStatusMock
      .mockRejectedValueOnce(
        new ApiClientError(429, { message: 'Too many requests' }, 'Too many requests')
      )
      .mockResolvedValueOnce({
        jobId: 'job-4',
        status: 'completed',
        downloadUrl: null,
        createdAt: '2026-07-07T00:00:00.000Z',
        completedAt: '2026-07-07T00:01:00.000Z',
      })

    render(AuditExportPanel)
    await startExport()
    await vi.advanceTimersByTimeAsync(2000)

    expect(await screen.findByText(/temporarily rate-limited/i)).toBeTruthy()

    await vi.advanceTimersByTimeAsync(4000)

    expect(await screen.findByRole('link', { name: /download csv/i })).toBeTruthy()
  })

  it('blocks export client-side when from/to are blank, with no API call', async () => {
    render(AuditExportPanel)

    await fireEvent.click(screen.getByRole('button', { name: /export csv/i }))

    expect(triggerAuditExportMock).not.toHaveBeenCalled()
  })

  it('a non-ApiClientError trigger failure shows a generic export-start error', async () => {
    triggerAuditExportMock.mockRejectedValue(new Error('network down'))
    render(AuditExportPanel)

    await startExport()

    expect(await screen.findByText(/^failed to start export$/i)).toBeTruthy()
  })

  it('a non-ApiClientError poll failure stops polling and shows a generic status-check error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    triggerAuditExportMock.mockResolvedValue({ jobId: 'job-5', status: 'pending' })
    getAuditExportStatusMock.mockRejectedValue(new Error('network down'))

    render(AuditExportPanel)
    await startExport()
    await vi.advanceTimersByTimeAsync(2000)

    expect(await screen.findByText(/^failed to check export status$/i)).toBeTruthy()
  })
})
