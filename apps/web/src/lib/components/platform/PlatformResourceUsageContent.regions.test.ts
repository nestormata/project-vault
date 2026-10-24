import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.14: the resource usage page's cards are sub-regions. A probe contribution lands BETWEEN
// the two PV sections it was meant to sit between, and the per-organization rows keep ONE owner (the
// editor) shared by the allocation notices, the table and the inline quota form.

const quotaMock = vi.hoisted(() => vi.fn())
vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/platform/settings/resource-usage' }, params: {} },
}))
vi.mock('$lib/api/platform.js', () => ({ setOrgAuditQuota: quotaMock }))

const POINTS = [
  'platform.settings-resource-usage.intro',
  'platform.settings-resource-usage.error',
  'platform.settings-resource-usage.orgs',
  'platform.settings-resource-usage.users',
  'platform.settings-resource-usage.audit-entries',
  'platform.settings-resource-usage.storage',
  'platform.settings-resource-usage.audit-log-storage',
  'platform.settings-resource-usage.allocation',
  'platform.settings-resource-usage.org-table',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const GB = 1024 ** 3
const ROW = {
  orgId: 'org-ok',
  orgName: 'Ok Org',
  bytesUsed: 100_000_000,
  preauthBytesUsed: 0,
  quotaBytes: GB,
  utilizationPct: 9.3,
  refusedWriteCount: 0,
  lastRefusalAt: null,
  lastReconciledAt: '2026-10-04T11:00:00.000Z',
  writeRatePerMinute: null,
  rateWindowCount: 0,
  rateRefusedCount: 0,
  state: 'ok',
}
const STALE = { ...ROW, orgId: 'org-stale', orgName: 'Stale Org', state: 'stale' }
const usage = (overrides: Record<string, unknown> = {}) => ({
  orgs: { current: 3, limit: 10 },
  usersPerOrg: [{ orgId: 'org-1', current: 5, limit: 50 }],
  secretsPerProject: [],
  auditLogEntries: { current: 1000, limit: null },
  storageBytes: { current: 900_000, limit: null },
  auditLogStorage: { currentBytes: 42_000_000_000, limitBytes: 50_000_000_000, utilizationPct: 84 },
  auditStorageByOrg: [ROW, STALE],
  truncated: false,
  allocatedLogicalBytes: 5 * GB,
  estimatedPhysicalBytes: 2 * GB,
  allocationIncludesUnlimitedOrgs: false,
  observedPhysicalToLogicalRatio: null,
  ...overrides,
})
const pageData = (overrides: Record<string, unknown> = {}) => ({
  allowed: true,
  usage: usage(),
  warnings: [],
  errorMessage: null,
  ...overrides,
})

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Content = (await import('./PlatformResourceUsageContent.svelte'))
    .default as unknown as typeof Content
}, 60_000)
beforeEach(() => {
  quotaMock.mockReset()
})
afterEach(cleanup)

const mount = (overrides: Record<string, unknown> = {}) =>
  render(Content, { props: { pageData: pageData(overrides), data: fills } })
const probe = (
  name: (typeof POINTS)[number] extends `platform.settings-resource-usage.${infer N}` ? N : never
): HTMLElement => {
  const point = `platform.settings-resource-usage.${name}`
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const heading = (name: string): HTMLElement => screen.getByRole('heading', { name })
const editRow = async (orgName: string) => {
  const row = screen.getByText(orgName).closest('tr') as HTMLElement
  await fireEvent.click(within(row).getByRole('button', { name: 'Edit' }))
}
const quotaInput = () => screen.getAllByPlaceholderText('Unlimited')[0] as HTMLInputElement
const rateInput = () => screen.getAllByPlaceholderText('Unlimited')[1] as HTMLInputElement
const type = (input: HTMLElement, value: string) => fireEvent.input(input, { target: { value } })
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }))

describe('PlatformResourceUsageContent sub-regions (AC-4 probe order)', () => {
  it('intro: after the title and subtitle, before the first card', () => {
    mount()
    const intro = probe('intro')
    expect(follows(screen.getByText(/Monitor instance-wide resource/), intro)).toBe(true)
    expect(follows(intro, heading('Organizations'))).toBe(true)
  })

  it('intro: lands after the warnings banner', () => {
    mount({ warnings: ['audit_storage_critical'] })
    expect(
      follows(screen.getByText(/Audit log storage is at critical capacity/), probe('intro'))
    ).toBe(true)
  })

  it('each card point lands after its own figure, before the next card heading', () => {
    mount()
    const steps: [Parameters<typeof probe>[0], string, string][] = [
      ['orgs', 'Organizations', 'Users per Organization'],
      ['users', 'Users per Organization', 'Audit Log Entries'],
      ['audit-entries', 'Audit Log Entries', 'Storage'],
      ['storage', 'Storage', 'Audit Log Storage (physical)'],
      ['audit-log-storage', 'Audit Log Storage (physical)', 'Audit Storage by Organization'],
    ]
    for (const [name, own, next] of steps) {
      expect(follows(heading(own), probe(name))).toBe(true)
      expect(follows(probe(name), heading(next))).toBe(true)
    }
    expect(follows(screen.getByText('org-1'), probe('users'))).toBe(true)
    expect(follows(screen.getByText(/84%/), probe('audit-log-storage'))).toBe(true)
  })

  it('allocation: after the summary and notices, before the table', () => {
    mount()
    const allocation = probe('allocation')
    expect(follows(heading('Audit Storage by Organization'), allocation)).toBe(true)
    expect(follows(screen.getByText(/Σ per-organization quotas/), allocation)).toBe(true)
    expect(follows(screen.getByText(/may be out of date/), allocation)).toBe(true)
    expect(follows(allocation, screen.getByRole('table'))).toBe(true)
  })

  it('org-table: after the table, before the footnote', () => {
    mount()
    const table = probe('org-table')
    expect(follows(screen.getByRole('table'), table)).toBe(true)
    expect(follows(table, screen.getByText(/Per-organization figures count row data only/))).toBe(
      true
    )
  })

  it('org-table: renders the empty state before the point and no summary without rows', () => {
    mount({ usage: usage({ auditStorageByOrg: [] }) })
    expect(follows(screen.getByText('No organizations yet.'), probe('org-table'))).toBe(true)
    expect(screen.queryByText(/Σ per-organization quotas/)).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('allocation: shows the truncation and unlimited notices before the point', () => {
    mount({
      usage: usage({
        truncated: true,
        allocationIncludesUnlimitedOrgs: true,
        observedPhysicalToLogicalRatio: 0.42,
      }),
    })
    const allocation = probe('allocation')
    expect(follows(screen.getByText(/highest-utilization organizations of more/), allocation)).toBe(
      true
    )
    expect(follows(screen.getByText(/this is a lower bound/), allocation)).toBe(true)
    expect(screen.getByText(/Observed ratio: 0.42×/)).toBeTruthy()
  })

  it('error: after the banner, with none of the cards', () => {
    mount({ usage: null, errorMessage: 'Failed to load resource usage' })
    expect(follows(screen.getByText('Failed to load resource usage'), probe('error'))).toBe(true)
    expect(screen.queryByRole('heading', { name: 'Organizations' })).toBeNull()
    expect(screen.queryAllByTestId('probe')).toHaveLength(2)
  })

  it('renders no sub-region when the caller is not a platform operator', () => {
    render(Content, { props: { pageData: { allowed: false }, data: fills } })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
  })
})

describe('PlatformResourceUsageContent shared editor (AC-4 interaction)', () => {
  it('saving a quota updates its row in place and clears the stale notice above the table', async () => {
    quotaMock.mockResolvedValue({ ...STALE, state: 'ok', quotaBytes: 2 * GB, utilizationPct: 4 })
    mount()
    expect(screen.getByText(/may be out of date/)).toBeTruthy()
    await editRow('Stale Org')
    expect(quotaInput().value).toBe('1')
    await type(quotaInput(), '2')
    await type(rateInput(), '30')
    await save()
    expect(await screen.findByText('Saved')).toBeTruthy()
    expect(quotaMock).toHaveBeenCalledWith(expect.anything(), 'org-stale', {
      quotaBytes: 2 * GB,
      writeRatePerMinute: 30,
    })
    expect(screen.queryByText(/may be out of date/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByText('2.0 GB (logical)')).toBeTruthy()
  })

  it('blank fields clear the quota and rate to unlimited', async () => {
    quotaMock.mockResolvedValue({ ...ROW, quotaBytes: null, state: 'unlimited' })
    mount()
    await editRow('Ok Org')
    await type(quotaInput(), '')
    await save()
    await screen.findByText('Saved')
    expect(quotaMock).toHaveBeenCalledWith(expect.anything(), 'org-ok', {
      quotaBytes: null,
      writeRatePerMinute: null,
    })
  })

  it('opening another row closes the first form, and cancel closes without saving', async () => {
    mount()
    await editRow('Ok Org')
    await editRow('Stale Org')
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(quotaMock).not.toHaveBeenCalled()
  })

  it('a quota below current usage asks first, then saves on Continue anyway', async () => {
    quotaMock.mockResolvedValue({ ...ROW, quotaBytes: 1024 ** 2 * 10 })
    mount()
    await editRow('Ok Org')
    await fireEvent.change(screen.getByRole('combobox'), { target: { value: 'MB' } })
    await type(quotaInput(), '10')
    await save()
    expect((await screen.findByRole('alert')).textContent).toContain('currently using 95.4 MB')
    expect(quotaMock).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }))
    await screen.findByText('Saved')
    expect(quotaMock).toHaveBeenCalledWith(expect.anything(), 'org-ok', {
      quotaBytes: 10 * 1024 ** 2,
      writeRatePerMinute: null,
    })
  })

  it('an overcommit refusal asks to acknowledge, then resends with the acknowledgement', async () => {
    quotaMock
      .mockRejectedValueOnce(
        new ApiClientError(
          422,
          {
            code: 'quota_overcommit',
            estimatedPhysicalBytes: 60 * GB,
            instanceLimitBytes: 50 * GB,
          } as never,
          'overcommit'
        )
      )
      .mockResolvedValueOnce({ ...ROW, quotaBytes: 4 * GB })
    mount()
    await editRow('Ok Org')
    await type(quotaInput(), '4')
    await save()
    const alert = await screen.findByRole('alert')
    const text = (alert.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('estimated 60.0 GB of physical storage')
    expect(text).toContain('against a 50.0 GB instance limit')
    await fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }))
    await screen.findByText('Saved')
    expect(quotaMock).toHaveBeenLastCalledWith(expect.anything(), 'org-ok', {
      quotaBytes: 4 * GB,
      writeRatePerMinute: null,
      acknowledgeOvercommit: true,
    })
  })

  it.each([
    [404, undefined, 'Organization not found'],
    [500, undefined, 'Server exploded'],
  ])('a %i save failure shows its message and keeps the form open', async (status, code, text) => {
    quotaMock.mockRejectedValue(new ApiClientError(status, code ? { code } : null, text))
    mount()
    await editRow('Ok Org')
    await type(quotaInput(), '2')
    await save()
    expect((await screen.findByRole('alert')).textContent).toContain(text)
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('an MFA refusal shows the MFA guidance and keeps the form open', async () => {
    quotaMock.mockRejectedValue(new ApiClientError(403, { code: 'mfa_required' }, 'MFA needed'))
    mount()
    await editRow('Ok Org')
    await type(quotaInput(), '2')
    await save()
    expect(await screen.findByText(/MFA needed/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('a non-finite rate is rejected before any request', async () => {
    mount()
    await editRow('Ok Org')
    await type(rateInput(), '1.5')
    await fireEvent.submit(rateInput().closest('form') as HTMLElement)
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Enter a valid, finite number.'
    )
    expect(quotaMock).not.toHaveBeenCalled()
  })
})
