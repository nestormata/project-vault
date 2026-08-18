import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const setOrgAuditQuotaMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/platform.js', async () => {
  const actual = await vi.importActual('$lib/api/platform.js')
  return {
    ...actual,
    setOrgAuditQuota: setOrgAuditQuotaMock,
  }
})

import ResourceUsagePage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const BASE_USAGE = {
  orgs: { current: 1, limit: 10 },
  usersPerOrg: [],
  secretsPerProject: [],
  auditLogEntries: { current: 100, limit: null as number | null },
  storageBytes: { current: 900_000, limit: null as number | null },
  auditLogStorage: { currentBytes: 1_000_000_000, limitBytes: 50_000_000_000, utilizationPct: 2 },
}

const OK_ORG = {
  orgId: 'org-ok',
  orgName: 'Ok Org',
  bytesUsed: 100_000_000,
  preauthBytesUsed: 0,
  quotaBytes: 1_073_741_824,
  utilizationPct: 9.31,
  refusedWriteCount: 0,
  lastRefusalAt: null,
  lastReconciledAt: new Date().toISOString(),
  writeRatePerMinute: null,
  rateWindowCount: 0,
  rateRefusedCount: 0,
  state: 'ok' as const,
}

const UNLIMITED_ORG = {
  ...OK_ORG,
  orgId: 'org-unlimited',
  orgName: 'Unlimited Org',
  quotaBytes: null,
  utilizationPct: null,
  state: 'unlimited' as const,
}

const STALE_ORG = {
  ...OK_ORG,
  orgId: 'org-stale',
  orgName: 'Stale Org',
  lastReconciledAt: null,
  state: 'stale' as const,
}

const BLOCKED_ORG = {
  ...OK_ORG,
  orgId: 'org-blocked',
  orgName: 'Blocked Org',
  bytesUsed: 2_000_000_000,
  quotaBytes: 1_073_741_824,
  utilizationPct: 186.3,
  state: 'blocked' as const,
}

function usageWith(rows: (typeof OK_ORG)[], overrides: Record<string, unknown> = {}) {
  return {
    ...BASE_USAGE,
    auditStorageByOrg: rows,
    truncated: false,
    allocatedLogicalBytes: rows.reduce((sum, r) => sum + (r.quotaBytes ?? 0), 0),
    estimatedPhysicalBytes: 0,
    allocationIncludesUnlimitedOrgs: rows.some((r) => r.quotaBytes === null),
    observedPhysicalToLogicalRatio: null,
    ...overrides,
  }
}

function allowedData(usage: ReturnType<typeof usageWith>) {
  return { allowed: true as const, usage, warnings: [] as string[], errorMessage: null }
}

describe('Story 22.3: Audit Storage by Organization table', () => {
  it('renders a per-org row with used/quota/utilization/state', () => {
    render(ResourceUsagePage, { props: { data: allowedData(usageWith([OK_ORG])) } })

    expect(screen.getByText('Ok Org')).toBeTruthy()
    expect(screen.getByText(/^ok$/i)).toBeTruthy()
  })

  it('AC-6: an unlimited org shows "No quota configured" and an em dash for utilization', () => {
    render(ResourceUsagePage, { props: { data: allowedData(usageWith([UNLIMITED_ORG])) } })

    expect(screen.getByText('No quota configured')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy()
    // "Unlimited" appears twice here (the state badge AND the Write Rate cell, since
    // writeRatePerMinute is also null on this fixture) — assert at least one, not exactly one.
    expect(screen.getAllByText(/^unlimited$/i).length).toBeGreaterThan(0)
  })

  it('AC-6: a stale org shows a distinct Stale label instead of a numeric utilization', () => {
    render(ResourceUsagePage, { props: { data: allowedData(usageWith([STALE_ORG])) } })

    expect(screen.getByText(/^stale$/i)).toBeTruthy()
    expect(screen.getByText(/never reconciled/i)).toBeTruthy()
  })

  it('a blocked org is labelled distinctly as "may already be refusing writes"', () => {
    render(ResourceUsagePage, { props: { data: allowedData(usageWith([BLOCKED_ORG])) } })

    expect(screen.getByText(/^blocked$/i)).toBeTruthy()
    expect(screen.getByText(/may already be refusing writes/i)).toBeTruthy()
  })

  it('AC-1/AC-6: LEFT JOIN correctness — a never-omitted org row still renders even at zero usage', () => {
    const neverWritten = { ...OK_ORG, bytesUsed: 0, orgId: 'org-fresh', orgName: 'Fresh Org' }
    render(ResourceUsagePage, { props: { data: allowedData(usageWith([neverWritten])) } })

    expect(screen.getByText('Fresh Org')).toBeTruthy()
  })

  it('AC-7: shows the aggregate-allocation summary line', () => {
    render(ResourceUsagePage, {
      props: {
        data: allowedData(
          usageWith([OK_ORG], {
            allocatedLogicalBytes: 4_000_000_000,
            estimatedPhysicalBytes: 12_000_000_000,
          })
        ),
      },
    })

    expect(screen.getByText(/Σ per-organization quotas/i)).toBeTruthy()
  })

  it('AC-7: shows the lower-bound caveat when allocationIncludesUnlimitedOrgs is true', () => {
    render(ResourceUsagePage, {
      props: {
        data: allowedData(usageWith([UNLIMITED_ORG], { allocationIncludesUnlimitedOrgs: true })),
      },
    })

    expect(screen.getByText(/lower bound/i)).toBeTruthy()
  })

  it('shows a truncated notice when the response is capped', () => {
    render(ResourceUsagePage, {
      props: { data: allowedData(usageWith([OK_ORG], { truncated: true })) },
    })

    expect(screen.getByText(/highest-utilization organizations/i)).toBeTruthy()
  })

  it('shows the footnote distinguishing logical (per-org) from physical (instance) figures', () => {
    render(ResourceUsagePage, { props: { data: allowedData(usageWith([OK_ORG])) } })

    expect(screen.getByText(/does not equal the/i)).toBeTruthy()
  })

  it('AC-5: clicking Edit reveals the inline form with quota/rate inputs', async () => {
    render(ResourceUsagePage, { props: { data: allowedData(usageWith([OK_ORG])) } })

    await fireEvent.click(screen.getByRole('button', { name: /edit/i }))

    expect(screen.getByRole('button', { name: /^save$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy()
  })

  it('AC-5: a successful edit updates the row in place without a full reload', async () => {
    setOrgAuditQuotaMock.mockResolvedValue({
      ...OK_ORG,
      quotaBytes: 2_147_483_648,
      utilizationPct: 4.66,
    })
    render(ResourceUsagePage, { props: { data: allowedData(usageWith([OK_ORG])) } })

    await fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    await fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(setOrgAuditQuotaMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText(/saved/i)).toBeTruthy())
  })

  it('AC-5: below-current-usage confirm dialog appears before submitting a lowering quota, then proceeds on confirm', async () => {
    setOrgAuditQuotaMock.mockResolvedValue({ ...OK_ORG, quotaBytes: 1024, state: 'blocked' })
    render(ResourceUsagePage, { props: { data: allowedData(usageWith([OK_ORG])) } })

    await fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    // Both the quota and write-rate inputs share the "Unlimited" placeholder — the quota input
    // is the first in DOM order.
    const quotaInput = screen.getAllByPlaceholderText(/unlimited/i)[0] as HTMLInputElement
    await fireEvent.input(quotaInput, { target: { value: '0.000001' } })
    await fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(setOrgAuditQuotaMock).not.toHaveBeenCalled()
    expect(screen.getByText(/immediately block its audit writes/i)).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: /continue anyway/i }))
    await waitFor(() => expect(setOrgAuditQuotaMock).toHaveBeenCalledTimes(1))
  })

  it('AC-5: an overcommit 422 shows the confirm-and-acknowledge flow, and acknowledging resubmits with acknowledgeOvercommit: true', async () => {
    setOrgAuditQuotaMock
      .mockRejectedValueOnce(
        new ApiClientError(
          422,
          {
            code: 'quota_overcommit',
            message: 'overcommit',
            allocatedLogicalBytes: 40_000_000_000,
            estimatedPhysicalBytes: 62_000_000_000,
            instanceLimitBytes: 50_000_000_000,
            requestedBytes: 20_000_000_000,
          },
          'overcommit'
        )
      )
      .mockResolvedValueOnce({ ...OK_ORG, quotaBytes: 20_000_000_000 })

    render(ResourceUsagePage, { props: { data: allowedData(usageWith([OK_ORG])) } })

    await fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    await fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /continue anyway/i })).toBeTruthy()
    )

    await fireEvent.click(screen.getByRole('button', { name: /continue anyway/i }))

    await waitFor(() => expect(setOrgAuditQuotaMock).toHaveBeenCalledTimes(2))
    const secondCallArgs = setOrgAuditQuotaMock.mock.calls[1]
    expect(secondCallArgs?.[2]).toMatchObject({ acknowledgeOvercommit: true })
  })

  it('AC-5: an mfa_required error on submit shows the MFA-aware alert', async () => {
    setOrgAuditQuotaMock.mockRejectedValue(
      new ApiClientError(403, { code: 'mfa_required', message: 'MFA required' }, 'MFA required')
    )
    render(ResourceUsagePage, { props: { data: allowedData(usageWith([OK_ORG])) } })

    await fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    await fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(screen.getByText(/mfa required/i)).toBeTruthy())
  })

  it('is defensive against a malformed/missing auditStorageByOrg (AC-6)', () => {
    const malformed = { ...usageWith([OK_ORG]), auditStorageByOrg: undefined }
    expect(() =>
      render(ResourceUsagePage, { props: { data: allowedData(malformed as never) } })
    ).not.toThrow()
  })
})
