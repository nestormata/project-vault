import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.12: the export card is three sub-regions (date range and button, progress and errors,
// download or failure result). A probe lands after its own section, receives only the role flags,
// and the controller that the sections share drives the card from the form to the result.

vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/settings/audit' }, params: {} },
}))
const api = vi.hoisted(() => ({
  triggerAuditExport: vi.fn(),
  getAuditExportStatus: vi.fn(),
  auditExportDownloadUrl: (jobId: string) => `/api/v1/org/audit/exports/${jobId}/download`,
}))
vi.mock('$lib/api/audit.js', () => api)

const POINTS = [
  'settings.audit.export-form',
  'settings.audit.export-status',
  'settings.audit.export-result',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const POINT_PROPS = { orgRole: 'owner', allowed: true }

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Panel = (await import('./AuditExportPanel.svelte')).default as unknown as typeof Panel
}, 60_000)
beforeEach(() => {
  api.triggerAuditExport.mockReset()
  api.getAuditExportStatus.mockReset()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
})

const mount = () => render(Panel, { props: { pointProps: POINT_PROPS, data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const startExport = async () => {
  await fireEvent.input(screen.getByLabelText('From'), { target: { value: '2026-09-01' } })
  await fireEvent.input(screen.getByLabelText('To'), { target: { value: '2026-09-30' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
}

describe('AuditExportPanel sub-regions (probe order)', () => {
  it('idle: the form probe is the last item of the date row, after the button', () => {
    mount()
    const form = probe('settings.audit.export-form')
    const button = screen.getByRole('button', { name: 'Export CSV' })
    expect(follows(button, form)).toBe(true)
    expect(form.parentElement?.lastElementChild).toBe(form)
    expect(form.parentElement).toBe(button.parentElement)
  })

  it('idle: the status and result probes are present, after the date row, result last', () => {
    mount()
    const form = probe('settings.audit.export-form')
    const status = probe('settings.audit.export-status')
    const result = probe('settings.audit.export-result')
    expect(follows(form, status)).toBe(true)
    expect(follows(status, result)).toBe(true)
    expect(result.parentElement?.lastElementChild).toBe(result)
    expect(screen.getAllByTestId('probe')).toHaveLength(3)
  })

  it('a failed start: the status probe follows the error alert and precedes the result probe', async () => {
    api.triggerAuditExport.mockRejectedValueOnce(new ApiClientError(422, null, 'range too wide'))
    mount()
    await startExport()
    const alert = await screen.findByText('range too wide')
    expect(follows(alert, probe('settings.audit.export-status'))).toBe(true)
    expect(
      follows(probe('settings.audit.export-status'), probe('settings.audit.export-result'))
    ).toBe(true)
  })

  it('the controller connects the form to the other sections: dates, trigger args, pending text', async () => {
    api.triggerAuditExport.mockResolvedValueOnce({ jobId: 'job-1', status: 'pending' })
    api.getAuditExportStatus.mockResolvedValue({ jobId: 'job-1', status: 'processing' })
    mount()
    expect((screen.getByRole('button', { name: 'Export CSV' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    await startExport()
    const pending = await screen.findByText(/Verifying integrity/)
    expect(api.triggerAuditExport.mock.calls.map((call) => call[1])).toEqual([
      { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z' },
    ])
    expect(follows(probe('settings.audit.export-form'), pending)).toBe(true)
    expect(follows(pending, probe('settings.audit.export-status'))).toBe(true)
  })

  it('completed: the result probe follows the download link and is the last child of the card', async () => {
    api.triggerAuditExport.mockResolvedValueOnce({ jobId: 'job-1', status: 'pending' })
    api.getAuditExportStatus.mockResolvedValueOnce({ jobId: 'job-1', status: 'completed' })
    mount()
    await startExport()
    await screen.findByText(/Verifying integrity/)
    await vi.advanceTimersByTimeAsync(2000)
    const link = await screen.findByRole('link', { name: 'Download CSV' })
    const result = probe('settings.audit.export-result')
    expect(follows(link, result)).toBe(true)
    expect(result.parentElement?.lastElementChild).toBe(result)
    expect(link.getAttribute('href')).toBe('/api/v1/org/audit/exports/job-1/download')
  })

  it('failed: the result probe follows the tampered-records notice', async () => {
    api.triggerAuditExport.mockResolvedValueOnce({ jobId: 'job-1', status: 'pending' })
    api.getAuditExportStatus.mockResolvedValueOnce({
      jobId: 'job-1',
      status: 'failed',
      integritySummary: { passed: 1, failedCount: 2 },
    })
    mount()
    await startExport()
    await screen.findByText(/Verifying integrity/)
    await vi.advanceTimersByTimeAsync(2000)
    const notice = await screen.findByText(/2 tampered record/)
    expect(follows(notice, probe('settings.audit.export-result'))).toBe(true)
  })

  it('capped: the status probe follows the Check again button and Check again polls the same job', async () => {
    api.triggerAuditExport.mockResolvedValueOnce({ jobId: 'job-1', status: 'pending' })
    api.getAuditExportStatus.mockResolvedValue({ jobId: 'job-1', status: 'processing' })
    mount()
    await startExport()
    await screen.findByText(/Verifying integrity/)
    await vi.advanceTimersByTimeAsync(2000 * 61)
    const again = await screen.findByRole('button', { name: 'Check again' })
    expect(follows(again, probe('settings.audit.export-status'))).toBe(true)
    api.getAuditExportStatus.mockClear()
    await fireEvent.click(again)
    expect(api.getAuditExportStatus.mock.calls.map((call) => call[1])).toEqual(['job-1'])
  })

  it('each point receives only the role flags, never the dates or the job', () => {
    mount()
    for (const point of POINTS) {
      const keys = probe(point).getAttribute('data-keys')
      expect(keys).toBe('allowed,data,orgRole,params,routeId')
    }
  })
})
