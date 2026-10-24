import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Story 69.11: the "Services shown on the public page" card is three sub-regions (the selectable
// services, the no-endpoints notice, the save row) inside the card that keeps its own end point. A
// probe lands after its own section, and the callbacks the page owns are what the rows call.

vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/projects/[projectId]/status-page' }, params: {} },
}))

const POINTS = [
  'project.status-page.services-list',
  'project.status-page.services-empty',
  'project.status-page.services-save',
  'project.status-page.services',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const ROWS = [
  { id: 's1', label: 'API', current: { serviceId: 's1', displayName: 'Gateway' }, index: 0 },
  { id: 's2', label: 'Web', current: { serviceId: 's2', displayName: 'Site' }, index: 1 },
  { id: 's3', label: 'Billing', current: undefined, index: -1 },
]

let Card: Component<Record<string, unknown>>
const callbacks = {
  onToggle: vi.fn(),
  onSetDisplayName: vi.fn(),
  onMove: vi.fn(),
  onSave: vi.fn(),
}
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Card = (await import('./StatusPageServices.svelte')).default as unknown as typeof Card
}, 60_000)
beforeEach(() => {
  for (const fn of Object.values(callbacks)) fn.mockReset()
})
afterEach(cleanup)

const mount = (overrides: Record<string, unknown> = {}) =>
  render(Card, {
    props: {
      project: { id: 'p1', name: 'Project' },
      capabilities: {},
      projectId: 'p1',
      serviceEndpoints: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
      rows: ROWS,
      selectedCount: 2,
      capabilityDenied: false,
      isBusy: false,
      ...callbacks,
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
const probeCount = () => screen.queryAllByTestId('probe').length
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('StatusPageServices sub-regions (probe order)', () => {
  it('list, save and the card end point follow their own section in order', () => {
    mount()
    const list = probe('project.status-page.services-list')
    const save = probe('project.status-page.services-save')
    const end = probe('project.status-page.services')
    expect(
      follows(screen.getByRole('list', { name: 'Services shown on the public page' }), list)
    ).toBe(true)
    expect(follows(list, screen.getByRole('button', { name: 'Save services' }))).toBe(true)
    expect(follows(screen.getByRole('button', { name: 'Save services' }), save)).toBe(true)
    expect(follows(save, end)).toBe(true)
    expect(probeCount()).toBe(3)
  })

  it('empty: after the notice, before the save row, with no list when there are no rows', () => {
    mount({ rows: [], serviceEndpoints: [] })
    const empty = probe('project.status-page.services-empty')
    expect(follows(screen.getByText(/No monitored service endpoints/), empty)).toBe(true)
    expect(follows(empty, screen.getByRole('button', { name: 'Save services' }))).toBe(true)
    expect(screen.queryByRole('list')).toBeNull()
    expect(probeCount()).toBe(3)
  })

  it('every sub-region point receives the project context and nothing of the selection', () => {
    mount()
    for (const point of POINTS.filter((name) => !name.endsWith('-empty'))) {
      const keys = (probe(point).getAttribute('data-keys') ?? '').split(',')
      expect(keys).toEqual(expect.arrayContaining(['capabilities', 'project', 'serviceEndpoints']))
      expect(keys).not.toEqual(expect.arrayContaining(['rows']))
      expect(keys.filter((key) => /select|row|display/i.test(key))).toEqual([])
    }
  })
})

describe('StatusPageServices callbacks (interaction)', () => {
  it('calls the page back for toggle, rename, move and save', async () => {
    mount()
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Billing' }))
    expect(callbacks.onToggle).toHaveBeenCalledWith({ id: 's3', name: 'Billing' })
    await fireEvent.input(screen.getAllByPlaceholderText('Public display name')[0] as HTMLElement, {
      target: { value: 'Edge' },
    })
    expect(callbacks.onSetDisplayName).toHaveBeenCalledWith('s1', 'Edge')
    await fireEvent.click(screen.getByRole('button', { name: 'Move API down' }))
    expect(callbacks.onMove).toHaveBeenCalledWith(0, 1)
    await fireEvent.click(screen.getByRole('button', { name: 'Save services' }))
    expect(callbacks.onSave).toHaveBeenCalled()
  })

  it('shows move buttons only when more than one service is selected, bounded at the ends', () => {
    mount({ selectedCount: 1 })
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull()
    cleanup()
    mount()
    expect(
      (screen.getByRole('button', { name: 'Move API up' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Move Web down' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('disables save with an explanation when the plan has no public status pages', () => {
    mount({ capabilityDenied: true })
    const save = screen.getByRole('button', { name: 'Save services' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(save.getAttribute('aria-describedby')).toBe('status-page-capability-denied-help')
    expect(document.getElementById('status-page-capability-denied-help')).toBeTruthy()
    expect(
      follows(
        document.getElementById('status-page-capability-denied-help') as Node,
        probe('project.status-page.services-save')
      )
    ).toBe(true)
  })
})
