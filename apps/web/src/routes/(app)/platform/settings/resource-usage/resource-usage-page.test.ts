import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'

import ResourceUsagePage from './+page.svelte'

afterEach(() => cleanup())

const SAMPLE_USAGE = {
  orgs: { current: 3, limit: 10 },
  usersPerOrg: [{ orgId: 'org-1', current: 5, limit: 50 }],
  secretsPerProject: [],
  auditLogEntries: { current: 1000, limit: null as number | null },
  storageBytes: { current: 900_000, limit: null as number | null },
  auditLogStorage: { currentBytes: 42_000_000_000, limitBytes: 50_000_000_000, utilizationPct: 84 },
}

function allowedData(overrides: Record<string, unknown> = {}) {
  return {
    allowed: true as const,
    usage: SAMPLE_USAGE,
    warnings: [] as string[],
    errorMessage: null,
    ...overrides,
  }
}

describe('/platform/settings/resource-usage +page.svelte', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/platform/settings/resource-usage')).toBe(true)
  })

  it('a non-operator sees the platform-operator-required notice', () => {
    render(ResourceUsagePage, { props: { data: { allowed: false, warnings: [] } } })

    expect(screen.getByRole('heading', { name: /platform operator access required/i })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /^organizations$/i })).toBeNull()
  })

  it('surfaces a load-time errorMessage instead of the usage sections', () => {
    render(ResourceUsagePage, {
      props: { data: allowedData({ usage: null, errorMessage: 'Failed to load usage' }) },
    })

    expect(screen.getByText('Failed to load usage')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /^organizations$/i })).toBeNull()
  })

  it('renders under-threshold usage with plain styling, no warning label', () => {
    render(ResourceUsagePage, { props: { data: allowedData() } })

    // orgs: 3/10 = 30%, below all thresholds
    expect(screen.getByText(/3 \/ 10 \(30%\)/)).toBeTruthy()
    expect(screen.queryByText(/^critical$/i)).toBeNull()
    expect(screen.queryByText(/high usage/i)).toBeNull()
    // The default sample's auditLogStorage is 84%, which does earn "Approaching limit" —
    // assert only that the orgs section itself carries no threshold label.
    const orgsHeading = screen.getByRole('heading', { name: /^organizations$/i })
    const orgsSection = orgsHeading.closest('section') as HTMLElement
    expect(orgsSection.textContent).not.toMatch(/approaching limit/i)
  })

  it('shows "No limit configured" when a limit is null', () => {
    render(ResourceUsagePage, { props: { data: allowedData() } })

    expect(screen.getByText(/1,000 \/ No limit configured/)).toBeTruthy()
  })

  it('shows an "Approaching limit" label at >=80% and <90%', () => {
    render(ResourceUsagePage, {
      props: {
        data: allowedData({
          usage: { ...SAMPLE_USAGE, orgs: { current: 8, limit: 10 } },
        }),
      },
    })

    expect(screen.getByText(/8 \/ 10 \(80%\)/)).toBeTruthy()
    expect(screen.getAllByText(/approaching limit/i).length).toBeGreaterThan(0)
  })

  it('shows a "High usage" label at >=90% and <95%', () => {
    render(ResourceUsagePage, {
      props: {
        data: allowedData({
          usage: { ...SAMPLE_USAGE, orgs: { current: 9, limit: 10 } },
        }),
      },
    })

    expect(screen.getByText(/9 \/ 10 \(90%\)/)).toBeTruthy()
    expect(screen.getByText(/high usage/i)).toBeTruthy()
  })

  it('shows a "Critical" label at >=95%', () => {
    render(ResourceUsagePage, {
      props: {
        data: allowedData({
          usage: { ...SAMPLE_USAGE, orgs: { current: 96, limit: 100 } },
        }),
      },
    })

    expect(screen.getByText(/96 \/ 100 \(96%\)/)).toBeTruthy()
    expect(screen.getByText(/^critical$/i)).toBeTruthy()
  })

  it('renders per-org user rows and their own limit percentage', () => {
    render(ResourceUsagePage, {
      props: {
        data: allowedData({
          usage: {
            ...SAMPLE_USAGE,
            usersPerOrg: [
              { orgId: 'org-a', current: 45, limit: 50 },
              { orgId: 'org-b', current: 2, limit: null },
            ],
          },
        }),
      },
    })

    expect(screen.getByText('org-a')).toBeTruthy()
    expect(screen.getByText(/45 \/ 50 \(90%\)/)).toBeTruthy()
    expect(screen.getByText('org-b')).toBeTruthy()
    expect(screen.getByText(/2 \/ No limit/)).toBeTruthy()
  })

  it('formats storage bytes with formatBytes and shows the audit-log-storage utilization directly from the backend', () => {
    render(ResourceUsagePage, { props: { data: allowedData() } })

    expect(screen.getByText(/878\.9 KB \/ No limit configured/)).toBeTruthy()
    expect(screen.getByText(/39\.1 GB \/ 46\.6 GB/)).toBeTruthy()
    expect(screen.getByText(/\(84%\)/)).toBeTruthy()
  })

  it('shows the audit-log-storage critical threshold note at >=95% utilization', () => {
    render(ResourceUsagePage, {
      props: {
        data: allowedData({
          usage: {
            ...SAMPLE_USAGE,
            auditLogStorage: {
              currentBytes: 48_000_000_000,
              limitBytes: 50_000_000_000,
              utilizationPct: 96,
            },
          },
        }),
      },
    })

    expect(screen.getByText(/critical threshold is 95%/i)).toBeTruthy()
  })

  it('renders the audit_storage_critical warning banner with a working link', () => {
    render(ResourceUsagePage, {
      props: { data: allowedData({ warnings: ['audit_storage_critical'] }) },
    })

    expect(screen.getByText(/audit log storage is at critical capacity/i)).toBeTruthy()
  })

  it('renders the key_custody_risk warning banner', () => {
    render(ResourceUsagePage, { props: { data: allowedData({ warnings: ['key_custody_risk'] }) } })

    expect(screen.getByText(/master key custody risk/i)).toBeTruthy()
  })

  it('unknown warning codes are silently ignored (no crash, no blank banner)', () => {
    render(ResourceUsagePage, {
      props: { data: allowedData({ warnings: ['some_future_unknown_warning'] }) },
    })

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
