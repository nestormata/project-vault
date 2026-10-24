import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Story 69.10: the credentials list's sections are sub-regions. A probe contribution lands BETWEEN
// the two PV sections it was meant to sit between, and the filter and archived-toggle sections keep
// building their navigation from the same filters.

const gotoMock = vi.hoisted(() => vi.fn())
vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/projects/[projectId]/credentials' }, params: {} },
}))

const POINTS = [
  'project.credentials.filters',
  'project.credentials.archived-toggle',
  'project.credentials.results',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const NO_FILTERS = { q: '', status: '', tags: '', page: 1, includeArchived: false }
const ITEM = {
  id: 'c-1',
  name: 'Stripe key',
  status: 'active',
  tags: ['payments'],
  expiresAt: null,
  hasDependencies: false,
  archivedAt: null,
  activeRotation: null,
}
const pageData = (overrides: Record<string, unknown> = {}) => ({
  notFound: false,
  projectId: 'p-1',
  filters: NO_FILTERS,
  credentials: { items: [ITEM], total: 1 },
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
  Content = (await import('./CredentialsListContent.svelte')).default as unknown as typeof Content
}, 60_000)
beforeEach(() => gotoMock.mockReset())
afterEach(cleanup)

const mount = (overrides: Record<string, unknown> = {}, canCreate = true) =>
  render(Content, { props: { pageData: pageData(overrides), canCreate, data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const archivedBox = (): HTMLInputElement =>
  document.getElementById('credentials-include-archived') as HTMLInputElement

describe('CredentialsListContent sub-regions (AC-4 probe order)', () => {
  it('filters: after the Apply filters button, before the archived toggle', () => {
    mount()
    const filters = probe('project.credentials.filters')
    expect(follows(screen.getByRole('button', { name: 'Apply filters' }), filters)).toBe(true)
    expect(follows(filters, archivedBox())).toBe(true)
  })

  it('archived-toggle: after the toggle label, before the results', () => {
    mount()
    const toggle = probe('project.credentials.archived-toggle')
    expect(follows(screen.getByText(/Include archived/), toggle)).toBe(true)
    expect(follows(toggle, screen.getByRole('table'))).toBe(true)
  })

  it('results: after the count line', () => {
    mount()
    expect(follows(screen.getByText(/Showing 1 of 1/), probe('project.credentials.results'))).toBe(
      true
    )
  })

  it('results: after the empty state when nothing matches', () => {
    mount({ credentials: { items: [], total: 0 } }, false)
    expect(
      follows(
        screen.getByText(/have been added to this project yet/),
        probe('project.credentials.results')
      )
    ).toBe(true)
  })

  it('renders no sub-region when the project is not found', () => {
    mount({ notFound: true })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
  })
})

describe('CredentialsListContent navigation (AC-4 interaction)', () => {
  it('submitting the filters navigates to page 1 with the typed values', async () => {
    mount({ filters: { ...NO_FILTERS, page: 3, includeArchived: true } })
    await fireEvent.input(document.getElementById('credential-search') as HTMLElement, {
      target: { value: 'stripe' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
    expect(gotoMock).toHaveBeenCalledTimes(1)
    const url = String(gotoMock.mock.calls[0]?.[0])
    expect(url).toContain('/projects/p-1/credentials?')
    expect(url).toContain('q=stripe')
    expect(url).toContain('includeArchived=true')
    expect(url).not.toContain('page=')
  })

  it('toggling archived keeps the active filters, resets to page 1 and guards re-entrancy', async () => {
    gotoMock.mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
    mount({ filters: { ...NO_FILTERS, q: 'db', page: 2 } })
    const first = fireEvent.click(archivedBox())
    const second = fireEvent.click(archivedBox())
    await Promise.all([first, second])
    expect(gotoMock).toHaveBeenCalledTimes(1)
    const url = String(gotoMock.mock.calls[0]?.[0])
    expect(url).toContain('q=db')
    expect(url).toContain('includeArchived=true')
    expect(url).not.toContain('page=')
  })

  it('shows the Clear link only while a filter is active', () => {
    mount({ filters: { ...NO_FILTERS, status: 'expired' } })
    expect(screen.getByRole('link', { name: 'Clear' })).toBeTruthy()
    cleanup()
    mount()
    expect(screen.queryByRole('link', { name: 'Clear' })).toBeNull()
  })
})
