import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Story 69.11: the "Team members" card body is three sub-regions (error banner, member table,
// transfer-ownership row). A probe lands after its own section, receives only the page flags (never
// the member rows), and the row actions call back into the page that owns the mutations.

vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/projects/[projectId]/members' }, params: {} },
}))

const POINTS = [
  'project.members.team-error',
  'project.members.team-table',
  'project.members.team-transfer',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const MEMBERS = [
  { userId: 'u1', displayName: 'Olive Owner', email: 'olive@example', role: 'owner' },
  { userId: 'u2', displayName: 'Adam Admin', email: 'adam@example', role: 'admin' },
]
const POINT_PROPS = {
  projectId: 'p1',
  userId: 'u1',
  canManage: true,
  canManageMembers: true,
  canTransferOwnership: true,
}
const callbacks = { onChangeRole: vi.fn(), onRemove: vi.fn(), onTransfer: vi.fn() }

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Panel = (await import('./ProjectTeamPanel.svelte')).default as unknown as typeof Panel
}, 60_000)
beforeEach(() => {
  for (const fn of Object.values(callbacks)) fn.mockReset()
})
afterEach(cleanup)

const mount = (overrides: Record<string, unknown> = {}) =>
  render(Panel, {
    props: {
      members: MEMBERS,
      memberError: null,
      memberBusyId: null,
      canTransferOwnership: true,
      transferTarget: '',
      pointProps: POINT_PROPS,
      data: fills,
      ...callbacks,
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

describe('ProjectTeamPanel sub-regions (probe order)', () => {
  it('error, table and transfer probes follow their own section in order', () => {
    mount({ memberError: 'Failed to change role.' })
    const error = probe('project.members.team-error')
    const table = probe('project.members.team-table')
    const transfer = probe('project.members.team-transfer')
    expect(follows(screen.getByRole('heading', { name: 'Team members' }), error)).toBe(true)
    expect(follows(screen.getByText('Failed to change role.'), error)).toBe(true)
    expect(follows(error, screen.getByRole('table'))).toBe(true)
    expect(follows(screen.getByRole('table'), table)).toBe(true)
    expect(follows(table, screen.getByLabelText('Transfer ownership'))).toBe(true)
    expect(follows(screen.getByRole('button', { name: 'Transfer' }), transfer)).toBe(true)
  })

  it('transfer: no row and no probe without the transfer right or without non-owner members', () => {
    mount({ canTransferOwnership: false })
    expect(probeCount()).toBe(2)
    expect(screen.queryByText('Transfer ownership')).toBeNull()
    cleanup()
    mount({ members: MEMBERS.slice(0, 1) })
    expect(probeCount()).toBe(2)
  })

  it('table: still rendered after the empty row when there are no members', () => {
    mount({ members: [] })
    expect(follows(screen.getByText('No members yet.'), probe('project.members.team-table'))).toBe(
      true
    )
  })

  it('every sub-region point receives the page flags and never a member row', () => {
    mount()
    for (const point of POINTS) {
      const keys = (probe(point).getAttribute('data-keys') ?? '').split(',')
      expect(keys).toEqual(
        expect.arrayContaining(['projectId', 'userId', 'canManage', 'canManageMembers'])
      )
      expect(keys).not.toContain('members')
      expect(probe(point).textContent).not.toContain('olive@example')
    }
  })
})

describe('ProjectTeamPanel row actions (interaction)', () => {
  it('shows an owner as a badge without role select or remove, and calls back for others', async () => {
    mount()
    expect(screen.getByText('owner')).toBeTruthy()
    expect(screen.queryByLabelText('Role for olive@example')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1)
    await fireEvent.change(screen.getByLabelText('Role for adam@example'), {
      target: { value: 'viewer' },
    })
    expect(callbacks.onChangeRole).toHaveBeenCalledWith(MEMBERS[1], 'viewer')
    await fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(callbacks.onRemove).toHaveBeenCalledWith(MEMBERS[1])
  })

  it('disables the busy member and the transfer until a target is chosen', async () => {
    mount({ memberBusyId: 'u2' })
    expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect((screen.getByRole('button', { name: 'Transfer' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    cleanup()
    mount()
    const transfer = screen.getByRole('button', { name: 'Transfer' }) as HTMLButtonElement
    expect(transfer.disabled).toBe(true)
    await fireEvent.change(screen.getByLabelText('Transfer ownership'), { target: { value: 'u2' } })
    expect(transfer.disabled).toBe(false)
    await fireEvent.click(transfer)
    expect(callbacks.onTransfer).toHaveBeenCalled()
  })
})
