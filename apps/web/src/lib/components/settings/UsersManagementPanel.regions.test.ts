import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Story 69.10: the users panel's sections are sub-regions. A probe contribution lands BETWEEN the
// two PV sections it was meant to sit between, and the users table keeps ONE owner of the state its
// rows share (a single open panel at a time across rows).

const changeRoleMock = vi.hoisted(() => vi.fn())
const dormancyMock = vi.hoisted(() => vi.fn())
vi.mock('$app/state', () => ({ page: { route: { id: '/(app)/settings/users' }, params: {} } }))
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => undefined), goto: vi.fn() }))
vi.mock('$lib/api/compliance.js', () => ({
  pseudonymizeUser: vi.fn(),
  createErasureRequest: vi.fn(),
}))
vi.mock('$lib/api/organization-settings.js', () => ({
  updateUserDormancyThreshold: vi.fn(),
  updateMachineKeyDormancyThreshold: dormancyMock,
  updateOrgDefaultLocale: vi.fn(),
}))
vi.mock('$lib/api/org-users.js', () => ({
  changeProjectRole: changeRoleMock,
  deactivateOrgUser: vi.fn(),
  removeOrgUser: vi.fn(),
  sendRecoveryLink: vi.fn(),
}))

const POINTS = [
  'settings.users.machine-dormancy',
  'settings.users.user-dormancy',
  'settings.users.default-language',
  'settings.users.table',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const USERS = [
  {
    userId: 'u-a',
    email: 'user.a',
    displayName: 'User A',
    orgRole: 'member',
    status: 'active',
    projects: [{ projectId: 'p1', projectName: 'Alpha', role: 'viewer' }],
  },
  {
    userId: 'u-b',
    email: 'user.b',
    displayName: 'User B',
    orgRole: 'member',
    status: 'active',
    projects: [],
  },
]

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Panel = (await import('./UsersManagementPanel.svelte')).default as unknown as typeof Panel
}, 60_000)
beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  changeRoleMock.mockReset()
  dormancyMock.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const mount = (overrides: Record<string, unknown> = {}) =>
  render(Panel, {
    props: {
      canManage: true,
      orgId: 'org-1',
      orgRole: 'owner',
      users: USERS,
      nativeLoginEnabled: true,
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

describe('UsersManagementPanel sub-regions (AC-4 probe order)', () => {
  it('machine-dormancy: after its save button, before the user dormancy card', () => {
    mount()
    const probeEl = probe('settings.users.machine-dormancy')
    expect(follows(screen.getByRole('button', { name: 'Save' }), probeEl)).toBe(true)
    expect(follows(probeEl, heading('User dormancy alerts'))).toBe(true)
  })

  it('user-dormancy: between the user dormancy save and the default language card', () => {
    mount()
    const probeEl = probe('settings.users.user-dormancy')
    expect(
      follows(screen.getByRole('button', { name: 'Save user dormancy threshold' }), probeEl)
    ).toBe(true)
    expect(follows(probeEl, heading('Default language for new users'))).toBe(true)
  })

  it('default-language: after its save, before the users table', () => {
    mount()
    const probeEl = probe('settings.users.default-language')
    expect(follows(screen.getByRole('button', { name: 'Save default language' }), probeEl)).toBe(
      true
    )
    expect(follows(probeEl, screen.getByRole('table'))).toBe(true)
  })

  it('table: after the error banner of a failed role change, before the table', async () => {
    changeRoleMock.mockRejectedValue(new Error('nope'))
    mount()
    const select = screen.getByLabelText('Role for user.a in Alpha')
    await fireEvent.change(select, { target: { value: 'member' } })
    const alert = await screen.findByText('Failed to change role.')
    const probeEl = probe('settings.users.table')
    expect(follows(alert, probeEl)).toBe(true)
    expect(follows(probeEl, screen.getByRole('table'))).toBe(true)
  })

  it('renders no sub-region for a caller who cannot manage users', () => {
    mount({ canManage: false })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
    expect(screen.getByText(/Only organization owners and admins/)).toBeTruthy()
  })
})

describe('UsersManagementPanel table state (AC-4 interaction)', () => {
  it('keeps ONE pseudonymize panel open across rows', async () => {
    mount()
    const buttons = screen.getAllByRole('button', { name: 'Pseudonymize identity' })
    expect(buttons).toHaveLength(2)
    await fireEvent.click(buttons[0] as HTMLElement)
    expect(screen.getAllByText('This action is permanent and irreversible.')).toHaveLength(1)
    await fireEvent.click(buttons[1] as HTMLElement)
    const panels = screen.getAllByText('This action is permanent and irreversible.')
    expect(panels).toHaveLength(1)
    const rowOfPanel = panels[0]?.closest('tr') as HTMLElement
    expect(within(rowOfPanel).getByText('User B')).toBeTruthy()
  })

  it('opens the erasure form per row and closes it on cancel', async () => {
    mount()
    await fireEvent.click(
      screen.getAllByRole('button', { name: 'Request erasure' })[0] as HTMLElement
    )
    expect(document.getElementById('erasure-reason-u-a')).toBeTruthy()
    expect(document.getElementById('erasure-reason-u-b')).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.getElementById('erasure-reason-u-a')).toBeNull()
  })

  it('a dormancy card keeps its own saving state and uses the org id', async () => {
    dormancyMock.mockResolvedValue({ machineKeyDormancyThresholdDays: 90 })
    mount()
    const select = document.getElementById('dormancy-threshold-select') as HTMLSelectElement
    const option = [...select.options].find((o) => o.value !== '') as HTMLOptionElement
    await fireEvent.change(select, { target: { value: option.value } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(dormancyMock).toHaveBeenCalledWith(expect.anything(), 'org-1', Number(option.value))
    expect(await screen.findByText('Threshold updated to 90 days.')).toBeTruthy()
  })
})
