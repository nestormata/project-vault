import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.11: the erasure request page body is one sub-region per state. A probe contribution
// lands in the right place for each state, and the execute zone keeps ONE owner of its state.

const api = vi.hoisted(() => ({ executeErasure: vi.fn(), invalidateAll: vi.fn() }))
vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/settings/users/[userId]/erasure/[requestId]' }, params: {} },
}))
vi.mock('$app/navigation', () => ({ invalidateAll: api.invalidateAll }))
vi.mock('$lib/api/compliance.js', () => ({ executeErasure: api.executeErasure }))

const POINTS = [
  'settings.users-erasure-detail.notice',
  'settings.users-erasure-detail.inventory',
  'settings.users-erasure-detail.execute',
  'settings.users-erasure-detail.report',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const BASE = { orgRole: 'owner', userId: 'u1', requestId: 'r1', userEmail: 'jane@example' }
const INVENTORY = { tables: [{ table: 'org_users', rowCount: 1, piiFields: ['email'] }] }
const REPORT = {
  executedAt: '2026-10-05T12:30:00.000Z',
  piiRemoved: [{ table: 'org_users', fields: ['email'], method: 'hard_delete' }],
  piiRetained: [{ table: 'audit_events', reason: 'legal retention' }],
  retentionJustification: 'kept for compliance',
  auditEventId: 'evt-1',
}
const pending = (overrides: Record<string, unknown> = {}) => ({
  ...BASE,
  state: 'pending',
  piiInventory: INVENTORY,
  ...overrides,
})

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Panel = (await import('./ErasureRequestPanel.svelte')).default as unknown as typeof Panel
}, 60_000)
beforeEach(() => {
  api.executeErasure.mockReset()
  api.invalidateAll.mockReset()
})
afterEach(cleanup)

const mount = (pageData: Record<string, unknown>) =>
  render(Panel, { props: { pageData, data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const probes = () => screen.queryAllByTestId('probe')
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('ErasureRequestPanel sub-regions (probe order)', () => {
  it('inventory: after the table; execute: after the owner zone, in the pending card', () => {
    mount(pending())
    const inventory = probe('settings.users-erasure-detail.inventory')
    const execute = probe('settings.users-erasure-detail.execute')
    expect(follows(screen.getByRole('table'), inventory)).toBe(true)
    expect(follows(inventory, screen.getByText(/permanent and irreversible/))).toBe(true)
    expect(follows(screen.getByRole('button', { name: 'Execute erasure' }), execute)).toBe(true)
    expect(probes()).toHaveLength(2)
  })

  it('inventory: still rendered (after the intro) without an inventory table', () => {
    mount(pending({ piiInventory: null }))
    expect(screen.queryByRole('table')).toBeNull()
    expect(
      follows(
        screen.getByText(/nothing has been touched yet/),
        probe('settings.users-erasure-detail.inventory')
      )
    ).toBe(true)
  })

  it('execute: after the owner-only notice for an admin, with no execute button', () => {
    mount(pending({ orgRole: 'admin' }))
    expect(screen.queryByRole('button', { name: 'Execute erasure' })).toBeNull()
    expect(
      follows(
        screen.getByText('Only an organization owner can execute this erasure request.'),
        probe('settings.users-erasure-detail.execute')
      )
    ).toBe(true)
  })

  it('notice: after the notice for each notice state, and no other sub-region', () => {
    for (const state of ['not_allowed', 'not_found', 'in_progress']) {
      mount({ ...BASE, state })
      expect(probes()).toHaveLength(1)
      expect(probe('settings.users-erasure-detail.notice')).toBeTruthy()
      cleanup()
    }
  })

  it('report: after the audit event line of a completed request', () => {
    mount({ ...BASE, state: 'completed', report: REPORT })
    expect(probes()).toHaveLength(1)
    expect(
      follows(screen.getByText('Audit event: evt-1'), probe('settings.users-erasure-detail.report'))
    ).toBe(true)
    expect(screen.getByText('Audit event: evt-1').parentElement).toBe(
      probe('settings.users-erasure-detail.report').parentElement
    )
  })
})

describe('ErasureRequestPanel execute zone state (interaction)', () => {
  const arm = async () => {
    mount(pending())
    const execute = screen.getByRole('button', { name: 'Execute erasure' }) as HTMLButtonElement
    expect(execute.disabled).toBe(true)
    await fireEvent.input(document.getElementById('erasure-execute-confirm') as HTMLElement, {
      target: { value: 'Jane@Example' },
    })
    expect(execute.disabled).toBe(false)
    await fireEvent.click(execute)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm execute erasure?' }))
  }

  it('executes once the typed email matches, then reloads the page data', async () => {
    api.executeErasure.mockResolvedValue(undefined)
    await arm()
    await waitFor(() => expect(api.executeErasure).toHaveBeenCalledWith(fetch, 'u1', 'r1'))
    await waitFor(() => expect(api.invalidateAll).toHaveBeenCalled())
  })

  it('shows the server remediation when the user belongs to other organizations', async () => {
    api.executeErasure.mockRejectedValue(
      new ApiClientError(409, { remediation: 'Remove them first.', otherOrgCount: 1 } as never, 'x')
    )
    await arm()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('This user belongs to 1 other organization. Remove them first.')
  })

  it('offers a refresh instead of a retry when the erasure already completed', async () => {
    api.executeErasure.mockRejectedValue(
      new ApiClientError(409, { code: 'already_completed' }, 'x')
    )
    await arm()
    expect(await screen.findByText(/already completed/)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(api.invalidateAll).toHaveBeenCalled()
  })

  it('blocks execution when the user email cannot be resolved', () => {
    mount(pending({ userEmail: null }))
    expect(document.getElementById('erasure-execute-confirm')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Execute erasure' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })
})
