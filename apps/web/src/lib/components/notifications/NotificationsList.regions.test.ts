import { cleanup, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Story 69.11: the inbox is the empty state, or the cards followed by the pagination, each a
// sub-region. A probe lands after its own section, and a successful card action updates the row
// through the route's callbacks.

type Enhancer = () => (input: {
  result: { type: string }
  update: () => Promise<void>
}) => Promise<void>
const forms = vi.hoisted(() => ({ enhancers: [] as Array<{ form: HTMLFormElement; fn: unknown }> }))
const unread = vi.hoisted(() => ({ decrementUnread: vi.fn() }))
vi.mock('$app/state', () => ({ page: { route: { id: '/(app)/notifications' }, params: {} } }))
vi.mock('$app/forms', () => ({
  enhance: (form: HTMLFormElement, fn: unknown) => {
    forms.enhancers.push({ form, fn })
    return { destroy: () => undefined }
  },
}))
vi.mock('$lib/state/notifications.svelte.js', () => ({ decrementUnread: unread.decrementUnread }))

const POINTS = [
  'notifications.home.empty',
  'notifications.home.items',
  'notifications.home.pagination',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const entry = (overrides: Record<string, unknown>) => ({
  id: 'n1',
  alertType: 'credential.expiry',
  severity: 'critical',
  title: 'Secret expires soon',
  body: 'in 3 days',
  projectId: 'p1',
  createdAt: '2026-10-04T10:00:00.000Z',
  readAt: null,
  ...overrides,
})

let List: Component<Record<string, unknown>>
const markReadLocally = vi.fn()
const dismissLocally = vi.fn()
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  List = (await import('./NotificationsList.svelte')).default as unknown as typeof List
}, 60_000)
beforeEach(() => {
  forms.enhancers.length = 0
  for (const fn of [markReadLocally, dismissLocally, unread.decrementUnread]) fn.mockReset()
})
afterEach(cleanup)

const mount = (overrides: Record<string, unknown> = {}) =>
  render(List, {
    props: {
      notifications: [entry({}), entry({ id: 'n2', readAt: '2026-10-04T11:00:00.000Z' })],
      status: 'all',
      page: 1,
      hasNext: false,
      markReadLocally,
      dismissLocally,
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

describe('NotificationsList sub-regions (probe order)', () => {
  it('items: after the last card; pagination: after the Next link, below the cards', () => {
    mount({ page: 2, hasNext: true })
    const items = probe('notifications.home.items')
    const pagination = probe('notifications.home.pagination')
    const dismiss = screen.getAllByRole('button', { name: 'Dismiss' })
    expect(follows(dismiss[dismiss.length - 1] as HTMLElement, items)).toBe(true)
    expect(follows(items, screen.getByRole('link', { name: 'Previous' }))).toBe(true)
    expect(follows(screen.getByRole('link', { name: 'Next' }), pagination)).toBe(true)
    expect(screen.queryAllByTestId('probe')).toHaveLength(2)
  })

  it('pagination: still rendered when there is neither a previous nor a next page', () => {
    mount()
    expect(screen.queryByRole('link', { name: 'Next' })).toBeNull()
    expect(probe('notifications.home.pagination')).toBeTruthy()
  })

  it('empty: after the all-caught-up line of the unread tab, and no items or pagination', () => {
    mount({ notifications: [], status: 'unread' })
    expect(
      follows(screen.getByText("You're all caught up!"), probe('notifications.home.empty'))
    ).toBe(true)
    expect(screen.queryAllByTestId('probe')).toHaveLength(1)
  })

  it('empty: after the alerts-will-appear line of the other tabs', () => {
    mount({ notifications: [], status: 'read' })
    expect(
      follows(
        screen.getByText('Notifications will appear here when alerts fire.'),
        probe('notifications.home.empty')
      )
    ).toBe(true)
  })
})

describe('NotificationsList card actions (interaction)', () => {
  const run = async (formIndex: number, type: string) => {
    const update = vi.fn(async () => undefined)
    const handler = (forms.enhancers.at(formIndex)?.fn as Enhancer)()
    await handler({ result: { type }, update })
    return update
  }

  it('marks an unread card read locally and lowers the unread badge on success', async () => {
    mount()
    const update = await run(0, 'success')
    expect(markReadLocally).toHaveBeenCalledWith('n1')
    expect(unread.decrementUnread).toHaveBeenCalledWith(1)
    expect(update).toHaveBeenCalled()
  })

  it('does not touch local state when the action fails, but still reloads', async () => {
    mount()
    const update = await run(0, 'failure')
    expect(markReadLocally).not.toHaveBeenCalled()
    expect(unread.decrementUnread).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalled()
  })

  it('offers Mark as read only on unread cards, and dismissing a read card keeps the badge', async () => {
    mount()
    expect(screen.getAllByRole('button', { name: 'Mark as read' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(2)
    const dismissRead = forms.enhancers.findIndex(
      ({ form }) =>
        form.getAttribute('action') === '?/dismiss' && form.querySelector('[value="n2"]')
    )
    await run(dismissRead, 'success')
    expect(dismissLocally).toHaveBeenCalledWith('n2')
    expect(unread.decrementUnread).not.toHaveBeenCalled()
  })

  it('links a notification to its project only when it has one', () => {
    mount({ notifications: [entry({}), entry({ id: 'n3', projectId: null })] })
    expect(screen.getAllByRole('link', { name: 'View project →' })).toHaveLength(1)
  })
})
