import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Story 69.12: the search form is four sub-regions (event type, actor, resource and project, dates
// and submit). A probe lands after its own fields, receives the page's results flags, and the
// form-level submit handler still reaches the date error rendered inside the dates region.

vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/settings/audit' }, params: {} },
}))
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }))

const POINTS = [
  'settings.audit.search-event',
  'settings.audit.search-actor',
  'settings.audit.search-resource',
  'settings.audit.search-dates',
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

let Form: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Form = (await import('./AuditSearchForm.svelte')).default as unknown as typeof Form
}, 60_000)
afterEach(cleanup)

const mount = (overrides: Record<string, unknown> = {}) =>
  render(Form, {
    props: {
      filters: {},
      hasFilters: false,
      pointProps: POINT_PROPS,
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
const field = (id: string) => document.getElementById(id) as HTMLInputElement

describe('AuditSearchForm sub-regions (probe order)', () => {
  it('each probe follows the last field of its own section, in form order', () => {
    mount()
    const event = probe('settings.audit.search-event')
    const actor = probe('settings.audit.search-actor')
    const resource = probe('settings.audit.search-resource')
    const dates = probe('settings.audit.search-dates')
    expect(follows(field('filter-eventType'), event)).toBe(true)
    expect(follows(event, field('filter-actorId'))).toBe(true)
    expect(follows(field('filter-actorSubject'), actor)).toBe(true)
    expect(follows(actor, field('filter-resourceId'))).toBe(true)
    expect(follows(field('filter-projectId'), resource)).toBe(true)
    expect(follows(resource, field('filter-from'))).toBe(true)
    expect(follows(screen.getByRole('button', { name: 'Search' }), dates)).toBe(true)
    expect(screen.getAllByTestId('probe')).toHaveLength(4)
  })

  it('the dates probe is the last child of the form and follows the filter summary', () => {
    const { container } = mount({ filters: { eventType: 'x' }, hasFilters: true })
    const dates = probe('settings.audit.search-dates')
    expect(follows(screen.getByText('Clear filters'), dates)).toBe(true)
    expect((container.querySelector('form') as HTMLFormElement).lastElementChild).toBe(dates)
  })

  it('the first three probes sit right after a label, so they never split two fields', () => {
    mount()
    for (const point of POINTS.slice(0, 3)) {
      expect(probe(point).previousElementSibling?.tagName).toBe('LABEL')
    }
  })

  it('an inverted range keeps the submit blocked and shows the error inside the dates region', async () => {
    const { container } = mount()
    await fireEvent.input(field('filter-from'), { target: { value: '2026-10-31' } })
    await fireEvent.input(field('filter-to'), { target: { value: '2026-10-01' } })
    const proceeded = await fireEvent.submit(container.querySelector('form') as HTMLFormElement)
    expect(proceeded).toBe(false)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('End date must be after start date')
    expect(follows(screen.getByRole('button', { name: 'Search' }), alert)).toBe(true)
    expect(follows(alert, probe('settings.audit.search-dates'))).toBe(true)
  })

  it('the filters reach every section: values are pre-filled in all six fields', () => {
    mount({
      filters: {
        eventType: 'e',
        actorId: 'a',
        actorProvider: 'p',
        actorSubject: 's',
        resourceId: 'r',
        projectId: 'j',
        from: 'f',
        to: 't',
      },
      hasFilters: true,
    })
    const values = [
      'filter-eventType',
      'filter-actorId',
      'filter-actorProvider',
      'filter-actorSubject',
      'filter-resourceId',
      'filter-projectId',
    ].map((label) => (field(label) as HTMLInputElement).value)
    expect(values).toEqual(['e', 'a', 'p', 's', 'r', 'j'])
    expect((field('filter-from') as HTMLInputElement).value).toBe('f')
  })

  it('each point receives the results props of the page and nothing the user typed into the form', () => {
    mount()
    for (const point of POINTS) {
      const keys = probe(point).getAttribute('data-keys')
      expect(keys).toBe(
        'allowed,data,errorMessage,events,filters,hasNext,orgRole,page,params,routeId,total'
      )
    }
  })
})
