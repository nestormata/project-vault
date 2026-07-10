import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'

const runAccessReportCsvMock = vi.hoisted(() => vi.fn())
const triggerTextDownloadMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/audit.js', () => ({
  runAccessReportCsv: runAccessReportCsvMock,
}))

vi.mock('$lib/download.js', () => ({
  triggerTextDownload: triggerTextDownloadMock,
}))

import AccessReportPage from './+page.svelte'

afterEach(() => cleanup())

const SAMPLE_REPORT = {
  users: [
    {
      userId: 'u1',
      displayName: 'Dana Smith',
      orgRole: 'owner',
      status: 'active' as const,
      projects: [
        {
          projectId: 'p1',
          projectName: 'Prod',
          role: 'owner',
          grantedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
    {
      userId: 'u2',
      displayName: 'Former Employee',
      orgRole: 'member',
      status: 'deactivated' as const,
      projects: [],
    },
  ],
  generatedAt: '2026-07-07T00:00:00.000Z',
  asOf: '2026-03-01T00:00:00.000Z',
  page: 1,
  limit: 20,
  total: 2,
  hasNext: false,
}

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    orgRole: 'owner',
    allowed: true as const,
    asOf: undefined,
    page: 1,
    report: SAMPLE_REPORT,
    errorMessage: null,
    ...overrides,
  }
}

describe('/settings/audit/access-report +page.svelte', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/settings/audit/access-report')).toBe(true)
  })

  it('AC-B4 equivalent: non-owner sees a role notice', () => {
    render(AccessReportPage, { props: { data: { orgRole: 'admin', allowed: false } } })
    expect(screen.getByText(/requires the owner role/i)).toBeTruthy()
  })

  it('AC-G1/G2: renders asOf/generatedAt and the paginated table including a deactivated user still listed', () => {
    render(AccessReportPage, { props: { data: baseData() } })

    expect(screen.getByText('Dana Smith')).toBeTruthy()
    expect(screen.getByText('Former Employee')).toBeTruthy()
    expect(screen.getByText(/deactivated/i)).toBeTruthy()
    expect(screen.getByText(/2026-03-01/)).toBeTruthy()
  })

  it('AC-G2 failure: shows the friendly error message from load(), not an empty table', () => {
    render(AccessReportPage, {
      props: {
        data: baseData({
          report: null,
          errorMessage: 'This date is before your organization was created.',
        }),
      },
    })

    expect(screen.getByText('This date is before your organization was created.')).toBeTruthy()
  })

  it('AC-G3: clicking Download CSV calls runAccessReportCsv with the same asOf/page and triggers a text download', async () => {
    runAccessReportCsvMock.mockResolvedValue('displayName,orgRole\nDana Smith,owner\n')

    render(AccessReportPage, { props: { data: baseData({ asOf: '2026-03-01T00:00:00.000Z' }) } })

    await fireEvent.click(screen.getByRole('button', { name: /download csv/i }))

    expect(runAccessReportCsvMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ asOf: '2026-03-01T00:00:00.000Z', page: 1 })
    )
    expect(triggerTextDownloadMock).toHaveBeenCalledWith(
      'access-report-2026-03-01.csv',
      'text/csv',
      'displayName,orgRole\nDana Smith,owner\n'
    )
  })

  it('AC-G3: uses "current" in the filename when no asOf was set', async () => {
    runAccessReportCsvMock.mockResolvedValue('csv text')

    render(AccessReportPage, { props: { data: baseData({ asOf: undefined }) } })

    await fireEvent.click(screen.getByRole('button', { name: /download csv/i }))

    expect(triggerTextDownloadMock).toHaveBeenCalledWith(
      'access-report-current.csv',
      'text/csv',
      'csv text'
    )
  })

  it('shows an inline error and re-enables the button when the CSV download fails', async () => {
    runAccessReportCsvMock.mockRejectedValue(new Error('network down'))

    render(AccessReportPage, { props: { data: baseData() } })
    const button = screen.getByRole('button', { name: /download csv/i }) as HTMLButtonElement
    await fireEvent.click(button)

    expect(await screen.findByText('Failed to download CSV')).toBeTruthy()
    expect(button.disabled).toBe(false)
  })

  it('shows an honest empty state when the report has no users', () => {
    render(AccessReportPage, {
      props: { data: baseData({ report: { ...SAMPLE_REPORT, users: [] } }) },
    })

    expect(screen.getByText(/no users found for this report/i)).toBeTruthy()
  })

  it('shows a Previous link when on a page after the first, and a Next link when hasNext is true', () => {
    render(AccessReportPage, {
      props: {
        data: baseData({
          page: 2,
          report: { ...SAMPLE_REPORT, page: 2, hasNext: true },
        }),
      },
    })

    expect(screen.getByRole('link', { name: /previous/i })).toBeTruthy()
    const next = screen.getByRole('link', { name: /next/i })
    expect(next.getAttribute('href')).toContain('page=3')
  })

  it('omits Previous and Next links on a single, first page of results', () => {
    render(AccessReportPage, { props: { data: baseData() } })

    expect(screen.queryByRole('link', { name: /previous/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /next/i })).toBeNull()
  })
})
