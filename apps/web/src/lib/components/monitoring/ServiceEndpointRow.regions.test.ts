import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Story 69.12: an endpoint row has the sub-regions Status and edit/delete next to the Monitoring
// cell that keeps the row point. Every point lands inside its own cell (never between `<td>` or
// `<tr>` siblings), after the cell's own content, and the callbacks the table owns are what the row
// calls.

vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/projects/[projectId]/service-endpoints' }, params: {} },
}))

const POINTS = [
  'project.service-endpoints.row-status',
  'project.service-endpoints.row',
  'project.service-endpoints.row-actions',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const endpoint = {
  id: 'e-1',
  orgId: 'o-1',
  projectId: 'p-1',
  name: 'Public API',
  url: 'https://api.example.test/health',
  checkFrequencyMinutes: 5,
  downThresholdFailures: 3,
  status: 'healthy',
  consecutiveFailures: 0,
  lastCheckedAt: null,
  healthCheckPaused: false,
  healthCheckPausedAt: null,
  healthCheckPausedBy: null,
  createdBy: null,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
}

let Row: Component<Record<string, unknown>>
const callbacks = { onPauseToggle: vi.fn(), onDelete: vi.fn() }
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Row = (await import('./ServiceEndpointRow.svelte')).default as unknown as typeof Row
}, 60_000)
beforeEach(() => {
  for (const fn of Object.values(callbacks)) fn.mockReset()
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const mount = (overrides: Record<string, unknown> = {}) => {
  const table = document.createElement('table')
  const body = document.createElement('tbody')
  table.append(body)
  document.body.append(table)
  return render(Row, {
    target: body,
    props: {
      project: { id: 'p-1', name: 'Project' },
      endpoint,
      orgRole: 'owner',
      projectId: 'p-1',
      canManage: true,
      pauseSubmitting: false,
      pauseError: null,
      ...callbacks,
      data: fills,
      ...overrides,
    },
  })
}
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('ServiceEndpointRow sub-regions (probe order)', () => {
  it('status, monitoring and edit/delete points land in their own cell, in column order', () => {
    mount()
    const status = probe(POINTS[0])
    const monitoring = probe(POINTS[1])
    const actions = probe(POINTS[2])
    const badge = screen.getByText('healthy')
    expect(follows(badge, status)).toBe(true)
    expect(status.previousElementSibling).toBe(badge)
    expect(status.parentElement?.tagName).toBe('TD')
    expect(follows(status, screen.getByText(/Checked every/))).toBe(true)
    expect(monitoring.parentElement?.tagName).toBe('TD')
    expect(follows(monitoring, screen.getByRole('link', { name: 'Edit' }))).toBe(true)
    const editDelete = screen.getByRole('link', { name: 'Edit' }).parentElement
    expect(follows(editDelete as Node, actions)).toBe(true)
    expect(actions.previousElementSibling).toBe(editDelete)
    expect(actions.parentElement?.tagName).toBe('TD')
  })

  it('never places a point between the cells of the row', () => {
    mount()
    const row = document.querySelector('tr') as HTMLTableRowElement
    expect(row.children).toHaveLength(5)
    expect([...row.children].every((cell) => cell.tagName === 'TD')).toBe(true)
    for (const el of screen.getAllByTestId('probe')) expect(el.parentElement?.tagName).toBe('TD')
  })

  it('a caller who cannot manage gets no edit/delete cell and no point for it', () => {
    mount({ canManage: false })
    const row = document.querySelector('tr') as HTMLTableRowElement
    expect(row.children).toHaveLength(4)
    expect(
      screen.getAllByTestId('probe').filter((el) => el.textContent?.includes(POINTS[2]))
    ).toHaveLength(0)
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull()
  })

  it('points receive the project, endpoint and role', () => {
    mount()
    for (const point of POINTS) {
      const keys = (probe(point).getAttribute('data-keys') ?? '').split(',')
      expect(keys).toEqual(expect.arrayContaining(['endpoint', 'orgRole', 'project']))
    }
  })
})

describe('ServiceEndpointRow callbacks (interaction)', () => {
  it('deletes only after the confirmation click', async () => {
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(callbacks.onDelete).not.toHaveBeenCalled()
    await fireEvent.click(await screen.findByRole('button', { name: /Confirm delete/ }))
    expect(callbacks.onDelete).toHaveBeenCalledTimes(1)
  })

  it('links the edit action to the endpoint detail page', () => {
    mount()
    expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(
      '/projects/p-1/service-endpoints/e-1'
    )
  })
})
