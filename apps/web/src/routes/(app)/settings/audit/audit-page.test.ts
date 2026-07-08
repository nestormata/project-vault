import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'

vi.mock('$lib/api/audit.js', () => ({
  verifyAuditRange: vi.fn(),
  triggerAuditExport: vi.fn(),
  getAuditExportStatus: vi.fn(),
  auditExportDownloadUrl: (jobId: string) => `/api/v1/org/audit/exports/${jobId}/download`,
}))

import AuditPage from './+page.svelte'

afterEach(() => cleanup())

const SAMPLE_EVENT = {
  id: 'evt-1',
  eventType: 'credential.access',
  actorDisplayName: 'Dana Smith',
  resourceId: 'cred-1',
  resourceType: 'credential',
  projectId: 'proj-1',
  ipAddress: '203.0.113.4',
  createdAt: '2026-06-14T10:03:00.000Z',
}

function allowedData(overrides: Record<string, unknown> = {}) {
  return {
    orgRole: 'owner',
    allowed: true as const,
    filters: {},
    events: [SAMPLE_EVENT],
    total: 340,
    limit: 20,
    page: 1,
    hasNext: true,
    errorMessage: null,
    ...overrides,
  }
}

describe('/settings/audit +page.svelte', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/settings/audit')).toBe(true)
  })

  it('AC-B4: a non-owner, non-admin role sees an honest role notice, no forwarding link', () => {
    render(AuditPage, { props: { data: { orgRole: 'member', allowed: false } } })

    expect(screen.getByText(/requires the owner role/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /forwarding & retention/i })).toBeNull()
  })

  it('AC-B4: an admin sees the role notice plus a link to Forwarding & Retention', () => {
    render(AuditPage, { props: { data: { orgRole: 'admin', allowed: false } } })

    expect(screen.getByText(/requires the owner role/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /forwarding & retention/i })
    expect(link.getAttribute('href')).toBe('/settings/audit/forwarding')
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
  })

  it('AC-A2: an owner sees links to Access Report and Forwarding & Retention that resolve', () => {
    render(AuditPage, { props: { data: allowedData() } })

    const accessReportLink = screen.getByRole('link', { name: /access report/i })
    expect(accessReportLink.getAttribute('href')).toBe('/settings/audit/access-report')
    expect(routeExists(accessReportLink.getAttribute('href') ?? '')).toBe(true)

    const forwardingLink = screen.getByRole('link', { name: /forwarding & retention/i })
    expect(forwardingLink.getAttribute('href')).toBe('/settings/audit/forwarding')
    expect(routeExists(forwardingLink.getAttribute('href') ?? '')).toBe(true)
  })

  it('AC-B1: renders a real, unfiltered first page of events in a table', () => {
    render(AuditPage, { props: { data: allowedData() } })

    expect(screen.getByText('credential.access')).toBeTruthy()
    expect(screen.getByText('Dana Smith')).toBeTruthy()
  })

  it('AC-B1 edge: an honest empty state for a brand-new org', () => {
    render(AuditPage, { props: { data: allowedData({ events: [], total: 0, hasNext: false }) } })

    expect(screen.getByText(/no audit events yet/i)).toBeTruthy()
  })

  it('AC-B2 edge: an empty filtered result set shows a distinct message with a Clear filters control', () => {
    render(AuditPage, {
      props: {
        data: allowedData({
          events: [],
          total: 0,
          hasNext: false,
          filters: { eventType: 'nonexistent' },
        }),
      },
    })

    expect(screen.getByText(/no audit events match these filters/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /clear filters/i })).toBeTruthy()
  })

  it('AC-B2: shows a visible summary of active filters', () => {
    render(AuditPage, {
      props: {
        data: allowedData({
          filters: {
            eventType: 'credential.access',
            from: '2026-06-01T00:00:00.000Z',
            to: '2026-06-30T00:00:00.000Z',
          },
        }),
      },
    })

    expect(screen.getByText(/filtered by/i).textContent).toMatch(/credential\.access/)
  })

  it('AC-B3: clicking an event row expands a detail panel with fields already in the response, no second API call', async () => {
    render(AuditPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByText('credential.access'))

    expect(await screen.findByText(/cred-1/)).toBeTruthy()
    expect(screen.getAllByText(/203\.0\.113\.4/).length).toBeGreaterThanOrEqual(1)
  })

  it('renders the Export and Verify panels even when the events table is empty (AC-O1)', () => {
    render(AuditPage, { props: { data: allowedData({ events: [], total: 0, hasNext: false }) } })

    expect(screen.getByRole('heading', { name: /^export$/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /integrity verification/i })).toBeTruthy()
  })

  it('surfaces a load-time error message without hiding the export/verify panels', () => {
    render(AuditPage, {
      props: { data: allowedData({ events: [], errorMessage: 'Too many requests' }) },
    })

    expect(screen.getByText('Too many requests')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /^export$/i })).toBeTruthy()
  })
})
