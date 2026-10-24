import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Story 69.10: the platform audit log's sections are sub-regions. A probe contribution lands BETWEEN
// the two PV sections it was meant to sit between, and the maintenance status keeps ONE owner shared
// by the banner above and the maintenance card below.

const verifyMock = vi.hoisted(() => vi.fn())
const postMock = vi.hoisted(() => vi.fn())
const statusMock = vi.hoisted(() => vi.fn())
vi.mock('$app/state', () => ({ page: { route: { id: '/(app)/platform/audit' }, params: {} } }))
vi.mock('$lib/api/platform.js', () => ({
  verifyPlatformAuditIntegrity: verifyMock,
  postMaintenanceMode: postMock,
  getMaintenanceModeStatus: statusMock,
}))

const POINTS = [
  'platform.audit.maintenance-status',
  'platform.audit.search',
  'platform.audit.results',
  'platform.audit.verify',
  'platform.audit.maintenance',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const INACTIVE = { active: false, reason: null, activatedAt: null, pendingEntriesCount: 0 }
const ACTIVE = {
  active: true,
  reason: 'Storage outage',
  activatedAt: '2026-07-09T00:00:00.000Z',
  pendingEntriesCount: 4,
}
const EVENT = {
  id: 'evt-1',
  operatorId: 'op-1',
  actionType: 'org.created',
  targetOrgId: 'org-1',
  targetUserId: null,
  ipAddress: null,
  timestamp: '2026-07-08T00:00:00.000Z',
}
const pageData = (overrides: Record<string, unknown> = {}) => ({
  allowed: true,
  filters: {},
  page: 1,
  events: [EVENT],
  total: 1,
  limit: 20,
  hasNext: false,
  eventsErrorMessage: null,
  maintenanceStatus: INACTIVE,
  maintenanceStatusError: null,
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
  Content = (await import('./PlatformAuditContent.svelte')).default as unknown as typeof Content
}, 60_000)
beforeEach(() => {
  verifyMock.mockReset()
  postMock.mockReset()
  statusMock.mockReset()
})
afterEach(cleanup)

const mount = (overrides: Record<string, unknown> = {}) =>
  render(Content, { props: { pageData: pageData(overrides), data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const heading = (name: string): HTMLElement => screen.getByRole('heading', { name })

describe('PlatformAuditContent sub-regions (AC-4 probe order)', () => {
  it('maintenance-status: after the intro and the status banner, before the Search card', () => {
    mount()
    const probeEl = probe('platform.audit.maintenance-status')
    expect(follows(screen.getByText(/Maintenance mode: inactive/), probeEl)).toBe(true)
    expect(follows(probeEl, heading('Search'))).toBe(true)
  })

  it('results: after the events table, before the search point and the Verify card', () => {
    mount()
    const results = probe('platform.audit.results')
    expect(follows(screen.getByRole('table'), results)).toBe(true)
    expect(follows(results, probe('platform.audit.search'))).toBe(true)
    expect(follows(probe('platform.audit.search'), heading('Verify Integrity'))).toBe(true)
  })

  it('verify: after the verify form, before the Maintenance Mode card', () => {
    mount()
    const probeEl = probe('platform.audit.verify')
    expect(follows(screen.getByRole('button', { name: 'Verify integrity' }), probeEl)).toBe(true)
    expect(follows(probeEl, heading('Maintenance Mode'))).toBe(true)
  })

  it('maintenance: after the activate control, last on the page', () => {
    mount()
    expect(
      follows(
        screen.getByRole('button', { name: /^activate maintenance mode$/i }),
        probe('platform.audit.maintenance')
      )
    ).toBe(true)
  })

  it('results: renders the empty state before the point when there are no events', () => {
    mount({ events: [], total: 0 })
    expect(
      follows(screen.getByText('No platform audit events yet.'), probe('platform.audit.results'))
    ).toBe(true)
  })

  it('renders no sub-region when the caller is not a platform operator', () => {
    render(Content, { props: { pageData: { allowed: false }, data: fills } })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
  })
})

describe('PlatformAuditContent shared state (AC-4 interaction)', () => {
  it('activating maintenance mode refreshes the banner above through the shared status', async () => {
    postMock.mockResolvedValue(undefined)
    statusMock.mockResolvedValue(ACTIVE)
    mount()
    expect(screen.queryByText(/Maintenance mode is ACTIVE/)).toBeNull()
    await fireEvent.input(screen.getByPlaceholderText(/reason for activating/i), {
      target: { value: 'Storage outage' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /^activate maintenance mode$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm activation/i }))
    expect(await screen.findByText(/Maintenance mode is ACTIVE/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^deactivate maintenance mode$/i })).toBeTruthy()
    expect(postMock).toHaveBeenCalledWith(expect.anything(), {
      action: 'activate',
      reason: 'Storage outage',
    })
  })

  it('a failed status refresh disables the actions and shows the unavailable banner', async () => {
    postMock.mockResolvedValue(undefined)
    statusMock.mockRejectedValue(new Error('down'))
    mount()
    await fireEvent.input(screen.getByPlaceholderText(/reason for activating/i), {
      target: { value: 'r' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /^activate maintenance mode$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm activation/i }))
    expect(await screen.findByText(/Actions disabled/)).toBeTruthy()
    expect(screen.getAllByText(/Maintenance mode status unavailable/).length).toBeGreaterThan(0)
  })

  it('verify keeps its own state: a clean result shows the all-clear and counts', async () => {
    verifyMock.mockResolvedValue({
      failedCount: 0,
      failed: [],
      failedTruncated: false,
      summary: 'All records verified',
      rowsChecked: 3,
      passed: 3,
      verifiedAt: '2026-07-10T00:00:00.000Z',
    })
    mount()
    const submit = screen.getByRole('button', { name: 'Verify integrity' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await fireEvent.input(document.getElementById('verify-from') as HTMLElement, {
      target: { value: '2026-07-01T00:00:00.000Z' },
    })
    await fireEvent.input(document.getElementById('verify-to') as HTMLElement, {
      target: { value: '2026-07-02T00:00:00.000Z' },
    })
    expect(submit.disabled).toBe(false)
    await fireEvent.click(submit)
    expect(await screen.findByText(/All records verified/)).toBeTruthy()
    expect(screen.getByText(/3 records checked, 3 passed/)).toBeTruthy()
  })
})
