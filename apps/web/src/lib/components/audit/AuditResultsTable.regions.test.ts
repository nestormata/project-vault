import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Story 69.12: the results are three sub-regions (the empty message, the event table, the pagination)
// plus a per-row attribution region inside the actor cell. A probe lands after its own section, never
// between two table rows, and the expanded row survives the split into a row component.

vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/settings/audit' }, params: {} },
}))
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }))

const POINTS = [
  'settings.audit.results-empty',
  'settings.audit.results-rows',
  'settings.audit.results-attribution',
  'settings.audit.results-pagination',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const POINT_PROPS = {
  orgRole: 'owner',
  allowed: true,
  filters: {},
  events: [],
  page: 1,
  total: 0,
  hasNext: false,
  errorMessage: null,
}
const EVENTS = [
  {
    id: 'evt-a',
    eventType: 'credential.access',
    actorDisplayName: 'Dana Smith',
    resourceId: 'cred-1',
    resourceType: 'credential',
    projectId: 'proj-1',
    ipAddress: '203.0.113.4',
    createdAt: '2026-10-01T10:00:00.000Z',
    attribution: {
      actor: { kind: 'issuer_attested', provider: 'cm', subject: 'user-1', reason: 'unlinked' },
    },
  },
  {
    id: 'evt-b',
    eventType: 'member.invited',
    actorDisplayName: 'Olivia Owner',
    resourceId: null,
    resourceType: null,
    projectId: null,
    ipAddress: null,
    createdAt: '2026-10-01T09:00:00.000Z',
  },
]

let Table: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Table = (await import('./AuditResultsTable.svelte')).default as unknown as typeof Table
}, 60_000)
afterEach(cleanup)

const mount = (overrides: Record<string, unknown> = {}) =>
  render(Table, {
    props: {
      events: EVENTS,
      filters: {},
      hasFilters: false,
      page: 1,
      total: 2,
      hasNext: false,
      pointProps: POINT_PROPS,
      data: fills,
      ...overrides,
    },
  })
const probes = (point: string): HTMLElement[] =>
  screen.queryAllByTestId('probe').filter((el) => el.textContent?.includes(`"fill:${point}"`))
const probe = (point: string): HTMLElement => {
  const found = probes(point)[0]
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('AuditResultsTable sub-regions (probe order)', () => {
  it('rows: the rows probe follows the table card; the pagination probe follows the pagination', () => {
    mount({ hasNext: true, page: 2, total: 40 })
    const rows = probe('settings.audit.results-rows')
    const pagination = probe('settings.audit.results-pagination')
    expect(follows(screen.getByRole('table'), rows)).toBe(true)
    expect(rows.closest('table')).toBeNull()
    expect(follows(rows, screen.getByText('40 total — page 2'))).toBe(true)
    expect(follows(screen.getByText('Next'), pagination)).toBe(true)
    expect(probes('settings.audit.results-empty')).toHaveLength(0)
  })

  it('no probe ever lands between two table rows', () => {
    const { container } = mount()
    for (const point of ['settings.audit.results-rows', 'settings.audit.results-pagination']) {
      expect(probe(point).closest('tbody')).toBeNull()
    }
    for (const el of probes('settings.audit.results-attribution')) {
      expect(el.closest('td')).not.toBeNull()
    }
    const bodyChildren = Array.from(container.querySelectorAll('tbody > *'))
    expect(bodyChildren.every((child) => child.tagName === 'TR')).toBe(true)
  })

  it('attribution: one probe per row, inside the actor cell and after the attestation badge', () => {
    mount()
    const attribution = probes('settings.audit.results-attribution')
    expect(attribution).toHaveLength(EVENTS.length)
    const [first, second] = attribution as [HTMLElement, HTMLElement]
    expect(first.closest('td')?.textContent).toContain('Dana Smith')
    expect(follows(screen.getByTestId('actor-attestation'), first)).toBe(true)
    expect(first.parentElement?.lastElementChild).toBe(first)
    expect(second.closest('td')?.textContent).toContain('Olivia Owner')
    expect(first.closest('tr')).not.toBe(second.closest('tr'))
  })

  it('empty: the empty probe follows the message for both messages and the rows region is absent', () => {
    mount({ events: [], total: 0 })
    expect(
      follows(screen.getByText('No audit events yet.'), probe('settings.audit.results-empty'))
    ).toBe(true)
    expect(screen.getAllByTestId('probe')).toHaveLength(1)
    cleanup()
    mount({ events: [], total: 0, hasFilters: true })
    expect(
      follows(
        screen.getByText('No audit events match these filters.'),
        probe('settings.audit.results-empty')
      )
    ).toBe(true)
  })

  it('the empty probe is the next sibling of the message paragraph, with no text node between', () => {
    mount({ events: [], total: 0 })
    const message = screen.getByText('No audit events yet.')
    let next = message.nextSibling
    while (next?.nodeType === Node.COMMENT_NODE) next = next.nextSibling
    expect(next).toBe(probe('settings.audit.results-empty'))
  })
})

describe('AuditResultsTable row expansion (state owner)', () => {
  const dl = () => document.querySelector('dl')

  it('expands one row at a time and collapses it again, keeping each detail row next to its row', async () => {
    const { container } = mount()
    const rows = () => screen.getAllByRole('row')
    await fireEvent.click(rows()[1] as HTMLElement)
    expect(dl()?.textContent).toContain('cred-1')
    expect(rows()[2]?.querySelector('dl')).not.toBeNull()
    await fireEvent.click(rows()[3] as HTMLElement)
    expect(container.querySelectorAll('dl')).toHaveLength(1)
    expect(rows()[1]?.nextElementSibling?.querySelector('dl')).toBeNull()
    expect(rows()[3]?.querySelector('dl')).not.toBeNull()
    await fireEvent.click(rows()[2] as HTMLElement)
    expect(dl()).toBeNull()
  })

  it('the expansion survives the pagination region re-rendering with new page props', async () => {
    const view = mount()
    await fireEvent.click(screen.getAllByRole('row')[1] as HTMLElement)
    await view.rerender({ page: 2, total: 40, hasNext: true })
    expect(dl()).not.toBeNull()
    expect(screen.getByText('40 total — page 2')).toBeTruthy()
  })

  it('the pagination links keep the active filters', () => {
    mount({ filters: { eventType: 'credential.access' }, page: 2, total: 40, hasNext: true })
    expect(screen.getByText('Previous').getAttribute('href')).toBe(
      '?eventType=credential.access&page=1'
    )
    expect(screen.getByText('Next').getAttribute('href')).toBe(
      '?eventType=credential.access&page=3'
    )
  })

  it('each point receives the page results props and no row', () => {
    mount()
    for (const point of POINTS.filter((p) => p !== 'settings.audit.results-empty')) {
      for (const el of probes(point)) {
        expect(el.getAttribute('data-keys')).toBe(
          'allowed,data,errorMessage,events,filters,hasNext,orgRole,page,params,routeId,total'
        )
      }
    }
  })
})
