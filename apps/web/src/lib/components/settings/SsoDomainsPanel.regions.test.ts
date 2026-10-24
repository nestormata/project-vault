import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Story 69.10: the SSO domains panel's sections are sub-regions. A probe contribution lands BETWEEN
// the two PV sections it was meant to sit between, and the list keeps ONE owner of the edit/remove
// state shared by its rows.

const deleteMock = vi.hoisted(() => vi.fn())
vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/settings/sso-domains' }, params: {} },
}))
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => undefined) }))
vi.mock('$lib/api/org-sso-domains.js', () => ({
  createOrgSsoDomain: vi.fn(),
  updateOrgSsoDomain: vi.fn(),
  deleteOrgSsoDomain: deleteMock,
}))

const POINTS = ['settings.sso-domains.add', 'settings.sso-domains.list'] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const ROWS = [
  { id: 'd1', domain: 'acme.com', providerName: 'p.one', createdAt: '2026-07-20T10:00:00.000Z' },
  { id: 'd2', domain: 'beta.io', providerName: 'p.two', createdAt: '2026-07-21T10:00:00.000Z' },
]

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Panel = (await import('./SsoDomainsPanel.svelte')).default as unknown as typeof Panel
}, 60_000)
beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  deleteMock.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const mount = (overrides: Record<string, unknown> = {}) =>
  render(Panel, {
    props: {
      allowed: true,
      mfaRequired: false,
      errorMessage: null,
      domains: ROWS,
      data: fills,
      ...overrides,
    },
  })
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

describe('SsoDomainsPanel sub-regions (AC-4 probe order)', () => {
  it('add: after the form hint, before the domains table', () => {
    mount()
    const add = probe('settings.sso-domains.add')
    expect(follows(heading('Add domain'), add)).toBe(true)
    expect(follows(screen.getByRole('button', { name: 'Add domain' }), add)).toBe(true)
    expect(follows(add, screen.getByRole('table'))).toBe(true)
  })

  it('list: after the last row of the table', () => {
    mount()
    const rows = screen.getAllByRole('row')
    expect(follows(rows[rows.length - 1] as HTMLElement, probe('settings.sso-domains.list'))).toBe(
      true
    )
  })

  it('list: still rendered (after the empty-state notice) when there are no domains', () => {
    mount({ domains: [] })
    expect(
      follows(
        screen.getByText('No SSO domains configured yet.'),
        probe('settings.sso-domains.list')
      )
    ).toBe(true)
  })

  it('renders no sub-region for a non-admin or an MFA-less admin', () => {
    mount({ allowed: false })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
    cleanup()
    mount({ mfaRequired: true })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
  })
})

describe('SsoDomainsPanel list state (AC-4 interaction)', () => {
  it('edits one row at a time, and cancel restores the read row', async () => {
    mount()
    await fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0] as HTMLElement)
    const editRow = within(screen.getByTestId('edit-row-d1'))
    expect((editRow.getByLabelText('Domain') as HTMLInputElement).value).toBe('acme.com')
    expect(screen.getAllByRole('button', { name: /^edit$/i })).toHaveLength(1)
    await fireEvent.click(editRow.getByRole('button', { name: /^cancel$/i }))
    expect(screen.queryByTestId('edit-row-d1')).toBeNull()
    expect(screen.getAllByRole('button', { name: /^edit$/i })).toHaveLength(2)
  })

  it('shows a remove failure above the table with the contract copy, and keeps the rows', async () => {
    deleteMock.mockRejectedValue(new Error('boom'))
    mount()
    await fireEvent.click(screen.getAllByRole('button', { name: /^remove$/i })[0] as HTMLElement)
    const alert = await screen.findByText('Failed to remove domain.')
    expect(follows(alert, screen.getByRole('table'))).toBe(true)
    expect(screen.getAllByRole('row')).toHaveLength(3)
  })
})
