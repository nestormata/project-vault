import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.11: the access report page body is one sub-region per section. A probe contribution
// lands after its own section, only the sections of the rendered state are present, and the summary
// row owns the CSV download state.

const api = vi.hoisted(() => ({ runAccessReportCsv: vi.fn(), triggerTextDownload: vi.fn() }))
vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/settings/audit/access-report' }, params: {} },
}))
vi.mock('$lib/api/audit.js', () => ({ runAccessReportCsv: api.runAccessReportCsv }))
vi.mock('$lib/download.js', () => ({ triggerTextDownload: api.triggerTextDownload }))

const POINTS = [
  'settings.audit-access-report.form',
  'settings.audit-access-report.error',
  'settings.audit-access-report.summary',
  'settings.audit-access-report.results',
  'settings.audit-access-report.pagination',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const REPORT = {
  asOf: '2026-10-01T00:00:00.000Z',
  generatedAt: '2026-10-05T09:30:00.000Z',
  hasNext: true,
  users: [
    {
      userId: 'u1',
      displayName: 'Active Member',
      orgRole: 'member',
      status: 'active',
      projects: [{ projectId: 'p1', projectName: 'Alpha', role: 'owner' }],
    },
    { userId: 'u2', displayName: 'Former', orgRole: 'viewer', status: 'deactivated', projects: [] },
  ],
}
const allowed = (overrides: Record<string, unknown> = {}) => ({
  allowed: true,
  orgRole: 'owner',
  asOf: undefined,
  page: 1,
  report: REPORT,
  errorMessage: null,
  ...overrides,
})

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Panel = (await import('./AccessReportPanel.svelte')).default as unknown as typeof Panel
}, 60_000)
beforeEach(() => {
  api.runAccessReportCsv.mockReset()
  api.triggerTextDownload.mockReset()
})
afterEach(cleanup)

const mount = (pageData: Record<string, unknown> = allowed()) =>
  render(Panel, { props: { pageData, data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const probeCount = () => screen.queryAllByTestId('probe').length
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('AccessReportPanel sub-regions (probe order)', () => {
  it('a report renders every sub-region probe in section order', () => {
    mount()
    const order = [
      probe('settings.audit-access-report.form'),
      probe('settings.audit-access-report.error'),
      probe('settings.audit-access-report.summary'),
      probe('settings.audit-access-report.pagination'),
      probe('settings.audit-access-report.results'),
    ]
    order.forEach((node, i) => {
      if (i > 0) expect(follows(order[i - 1] as HTMLElement, node)).toBe(true)
    })
    expect(follows(screen.getByRole('button', { name: 'Generate report' }), order[0] as Node)).toBe(
      true
    )
    expect(follows(screen.getByRole('button', { name: 'Download CSV' }), order[2] as Node)).toBe(
      true
    )
    expect(follows(order[2] as Node, screen.getByRole('table'))).toBe(true)
    expect(follows(screen.getByRole('table'), order[3] as Node)).toBe(true)
    expect(follows(screen.getByRole('link', { name: 'Next' }), order[3] as Node)).toBe(true)
  })

  it('results: after the empty notice, with no pagination, when the report has no users', () => {
    mount(allowed({ report: { ...REPORT, users: [] } }))
    expect(
      follows(
        screen.getByText('No users found for this report.'),
        probe('settings.audit-access-report.results')
      )
    ).toBe(true)
    expect(probeCount()).toBe(4)
  })

  it('only the form and error sub-regions render before a report exists', () => {
    mount(allowed({ report: null }))
    expect(probeCount()).toBe(2)
    expect(
      follows(
        probe('settings.audit-access-report.form'),
        probe('settings.audit-access-report.error')
      )
    ).toBe(true)
  })

  it('error: after the load error banner', () => {
    mount(allowed({ report: null, errorMessage: 'report unavailable' }))
    expect(
      follows(screen.getByText('report unavailable'), probe('settings.audit-access-report.error'))
    ).toBe(true)
  })

  it('renders no sub-region for a caller who is not an owner', () => {
    mount({ allowed: false, orgRole: 'admin' })
    expect(probeCount()).toBe(0)
    expect(screen.getByText('This page requires the owner role.')).toBeTruthy()
  })
})

describe('AccessReportPanel summary and pagination (interaction)', () => {
  it('downloads the CSV for the current page and the as-of date, named by that date', async () => {
    api.runAccessReportCsv.mockResolvedValue('a,b')
    mount(allowed({ asOf: '2026-10-01T00:00:00.000Z', page: 2 }))
    await fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    await waitFor(() => expect(api.triggerTextDownload).toHaveBeenCalled())
    expect(api.runAccessReportCsv).toHaveBeenCalledWith(fetch, {
      asOf: '2026-10-01T00:00:00.000Z',
      page: 2,
      limit: 20,
    })
    expect(api.triggerTextDownload).toHaveBeenCalledWith(
      'access-report-2026-10-01.csv',
      'text/csv',
      'a,b'
    )
  })

  it('shows a download failure under the summary row and re-enables the button', async () => {
    api.runAccessReportCsv.mockRejectedValue(new ApiClientError(500, null, 'csv exploded'))
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    const alert = await screen.findByText('csv exploded')
    expect(follows(screen.getByRole('button', { name: 'Download CSV' }), alert)).toBe(true)
    expect(follows(alert, probe('settings.audit-access-report.summary'))).toBe(true)
    expect(api.triggerTextDownload).not.toHaveBeenCalled()
  })

  it('links previous and next pages keeping the as-of date', () => {
    mount(allowed({ asOf: '2026-10-01', page: 2 }))
    expect(screen.getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe(
      '/settings/audit/access-report?asOf=2026-10-01&page=1'
    )
    expect(screen.getByRole('link', { name: 'Next' }).getAttribute('href')).toBe(
      '/settings/audit/access-report?asOf=2026-10-01&page=3'
    )
  })

  it('offers no Previous link on the first page and no Next link on the last', () => {
    mount(allowed({ report: { ...REPORT, hasNext: false } }))
    expect(screen.queryByRole('link', { name: 'Previous' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Next' })).toBeNull()
  })
})
