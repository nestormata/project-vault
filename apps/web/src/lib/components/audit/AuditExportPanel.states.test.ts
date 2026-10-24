// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.12: the export panel's client-driven states (trigger error, pending, completed, failed,
// rate limit, poll cap, poll error) cannot be reached by the route oracles. This pins them: the
// snapshot was recorded BEFORE the panel was split into sub-regions and must come out unchanged.

const api = vi.hoisted(() => ({
  triggerAuditExport: vi.fn(),
  getAuditExportStatus: vi.fn(),
  auditExportDownloadUrl: (jobId: string) => `/api/v1/org/audit/exports/${jobId}/download`,
}))
vi.mock('$lib/api/audit.js', () => api)

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  Panel = (await import('./AuditExportPanel.svelte')).default as unknown as typeof Panel
}, 60_000)

const status = (overrides: Record<string, unknown>) => ({
  jobId: 'job-1',
  status: 'processing',
  downloadUrl: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  completedAt: null,
  ...overrides,
})
const asText = (states: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(states).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  )
const fill = async (from = '2026-09-01', to = '2026-09-30') => {
  await fireEvent.input(screen.getByLabelText('From'), { target: { value: from } })
  await fireEvent.input(screen.getByLabelText('To'), { target: { value: to } })
}
const start = async () => {
  await fill()
  await fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
}
const startPending = async () => {
  await start()
  await screen.findByText(/Verifying integrity/)
}
function reset() {
  cleanup()
  vi.clearAllTimers()
  api.triggerAuditExport.mockReset()
  api.getAuditExportStatus.mockReset()
}
beforeEach(() => {
  reset()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('AuditExportPanel client states (Story 69.12 pre-split pin)', () => {
  it('renders every interactive state exactly as before the split', async () => {
    const states: Record<string, unknown> = {}

    const initial = render(Panel)
    states['initial'] = serializeWithoutNoise(initial.container)
    await fill()
    states['dates-filled'] = serializeWithoutNoise(initial.container)
    reset()

    api.triggerAuditExport.mockRejectedValueOnce(new ApiClientError(422, null, 'range too wide'))
    const apiError = render(Panel)
    await start()
    await screen.findByText('range too wide')
    states['trigger-api-error'] = serializeWithoutNoise(apiError.container)
    reset()

    api.triggerAuditExport.mockRejectedValueOnce(new Error('network'))
    const generic = render(Panel)
    await start()
    await screen.findByText('Failed to start export')
    states['trigger-generic-error'] = serializeWithoutNoise(generic.container)
    reset()

    api.triggerAuditExport.mockResolvedValueOnce({ jobId: 'job-1', status: 'pending' })
    api.getAuditExportStatus.mockResolvedValue(status({ status: 'processing' }))
    const pending = render(Panel)
    await start()
    await screen.findByText(/Verifying integrity/)
    states['pending'] = serializeWithoutNoise(pending.container)
    states['trigger-args'] = api.triggerAuditExport.mock.calls.map((call) => call.slice(1))
    reset()

    api.triggerAuditExport.mockResolvedValueOnce({ jobId: 'job-1', status: 'pending' })
    api.getAuditExportStatus.mockResolvedValueOnce(status({ status: 'completed' }))
    const done = render(Panel)
    await startPending()
    await vi.advanceTimersByTimeAsync(2000)
    await screen.findByRole('link', { name: 'Download CSV' })
    states['completed'] = serializeWithoutNoise(done.container)
    states['poll-args'] = api.getAuditExportStatus.mock.calls.map((call) => call.slice(1))
    reset()

    api.triggerAuditExport.mockResolvedValueOnce({ jobId: 'job-1', status: 'pending' })
    api.getAuditExportStatus.mockResolvedValueOnce(
      status({ status: 'failed', integritySummary: { passed: 10, failedCount: 3 } })
    )
    const failed = render(Panel)
    await startPending()
    await vi.advanceTimersByTimeAsync(2000)
    await screen.findByText(/Export failed/)
    states['failed'] = serializeWithoutNoise(failed.container)
    reset()

    api.triggerAuditExport.mockResolvedValueOnce({ jobId: 'job-1', status: 'pending' })
    api.getAuditExportStatus.mockResolvedValueOnce(status({ status: 'failed' }))
    const failedBare = render(Panel)
    await startPending()
    await vi.advanceTimersByTimeAsync(2000)
    await screen.findByText(/Export failed/)
    states['failed-no-summary'] = serializeWithoutNoise(failedBare.container)
    reset()

    api.triggerAuditExport.mockResolvedValueOnce({ jobId: 'job-1', status: 'pending' })
    api.getAuditExportStatus.mockRejectedValueOnce(new ApiClientError(429, null, 'slow down'))
    const limited = render(Panel)
    await startPending()
    await vi.advanceTimersByTimeAsync(2000)
    await screen.findByText(/temporarily rate-limited/)
    states['rate-limited'] = serializeWithoutNoise(limited.container)
    reset()

    api.triggerAuditExport.mockResolvedValueOnce({ jobId: 'job-1', status: 'pending' })
    api.getAuditExportStatus.mockRejectedValueOnce(new ApiClientError(500, null, 'boom'))
    const pollApiError = render(Panel)
    await startPending()
    await vi.advanceTimersByTimeAsync(2000)
    await screen.findByText('boom')
    states['poll-api-error'] = serializeWithoutNoise(pollApiError.container)
    reset()

    api.triggerAuditExport.mockResolvedValueOnce({ jobId: 'job-1', status: 'pending' })
    api.getAuditExportStatus.mockRejectedValueOnce(new Error('network'))
    const pollGeneric = render(Panel)
    await startPending()
    await vi.advanceTimersByTimeAsync(2000)
    await screen.findByText('Failed to check export status')
    states['poll-generic-error'] = serializeWithoutNoise(pollGeneric.container)
    reset()

    api.triggerAuditExport.mockResolvedValueOnce({ jobId: 'job-1', status: 'pending' })
    api.getAuditExportStatus.mockResolvedValue(status({ status: 'processing' }))
    const capped = render(Panel)
    await startPending()
    await vi.advanceTimersByTimeAsync(2000 * 61)
    await screen.findByText('This export is taking longer than expected.')
    states['capped'] = serializeWithoutNoise(capped.container)
    states['capped-poll-count'] = api.getAuditExportStatus.mock.calls.length
    api.getAuditExportStatus.mockResolvedValueOnce(status({ status: 'completed' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByRole('link', { name: 'Download CSV' })
    states['capped-check-again'] = serializeWithoutNoise(capped.container)
    reset()

    api.triggerAuditExport.mockResolvedValueOnce({ jobId: 'job-1', status: 'pending' })
    api.getAuditExportStatus.mockRejectedValue(new ApiClientError(429, null, 'slow down'))
    const limitedCap = render(Panel)
    await startPending()
    await vi.advanceTimersByTimeAsync(2000 + 4000 * 60)
    await screen.findByText('This export is taking longer than expected.')
    states['rate-limited-capped'] = serializeWithoutNoise(limitedCap.container)
    states['rate-limited-capped-polls'] = api.getAuditExportStatus.mock.calls.length

    await expect(`${JSON.stringify(asText(states), null, 2)}\n`).toMatchFileSnapshot(
      './AuditExportPanel.states.snapshot.json'
    )
  }, 60_000)
})
