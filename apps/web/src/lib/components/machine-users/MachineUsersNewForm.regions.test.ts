import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.12: the new machine user form is one sub-region per field group. A probe contribution
// lands after its own group, and the form keeps ONE owner of every typed value.

const api = vi.hoisted(() => ({ createMachineUser: vi.fn(), goto: vi.fn() }))
vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/projects/[projectId]/machine-users/new' }, params: {} },
}))
vi.mock('$app/navigation', () => ({ goto: api.goto }))
vi.mock('$lib/api/machine-users.js', () => ({ createMachineUser: api.createMachineUser }))

const POINTS = [
  'project.machine-users-new.name',
  'project.machine-users-new.role',
  'project.machine-users-new.description',
  'project.machine-users-new.error',
  'project.machine-users-new.submit',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))

let Form: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Form = (await import('./MachineUsersNewForm.svelte')).default as unknown as typeof Form
}, 60_000)
beforeEach(() => {
  api.createMachineUser.mockReset()
  api.goto.mockReset()
})
afterEach(cleanup)

const mount = (orgRole = 'owner') =>
  render(Form, { props: { pageData: { orgRole, projectId: 'p1' }, data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const byId = (id: string) => document.getElementById(id) as HTMLInputElement
const type = (id: string, value: string) => fireEvent.input(byId(id), { target: { value } })
const submit = () => fireEvent.submit(document.querySelector('form') as HTMLFormElement)

describe('MachineUsersNewForm sub-regions (probe order)', () => {
  it('each field group is followed by its own probe, in form order', () => {
    mount()
    const order = [
      ['machine-user-name-help', 'project.machine-users-new.name'],
      ['machine-user-role-help', 'project.machine-users-new.role'],
      ['machine-user-description-help', 'project.machine-users-new.description'],
    ] as const
    for (const [help, point] of order) {
      expect(follows(byId(help), probe(point))).toBe(true)
      expect(probe(point).parentElement?.lastElementChild).toBe(probe(point))
    }
    const probes = POINTS.map((point) => probe(point))
    probes.forEach((p, i) => {
      if (i > 0) expect(follows(probes[i - 1] as HTMLElement, p)).toBe(true)
    })
  })

  it('the error probe follows the failure banner and precedes the submit row', async () => {
    api.createMachineUser.mockRejectedValue(new ApiClientError(500, null, 'boom'))
    mount()
    await type('machine-user-name', 'Bot')
    await submit()
    const alert = await screen.findByRole('alert')
    expect(follows(alert, probe('project.machine-users-new.error'))).toBe(true)
    expect(
      follows(
        probe('project.machine-users-new.error'),
        screen.getByRole('button', { name: 'Create machine user' })
      )
    ).toBe(true)
  })

  it('the submit probe follows the submit row', () => {
    mount()
    expect(
      follows(
        screen.getByRole('link', { name: 'Cancel' }),
        probe('project.machine-users-new.submit')
      )
    ).toBe(true)
  })

  it('renders no sub-region for a caller who cannot create machine users', () => {
    mount('viewer')
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
    expect(screen.getByText('Create not available')).toBeTruthy()
  })
})

describe('MachineUsersNewForm state (interaction)', () => {
  it('submits the trimmed values chosen across the sub-regions', async () => {
    api.createMachineUser.mockResolvedValue({ id: 'mu9' })
    mount()
    await type('machine-user-name', ' Bot ')
    await fireEvent.change(byId('machine-user-role'), { target: { value: 'viewer' } })
    await type('machine-user-description', ' about ')
    await submit()
    await waitFor(() => expect(api.goto).toHaveBeenCalledWith('/projects/p1/machine-users/mu9'))
    expect(api.createMachineUser).toHaveBeenCalledWith(fetch, 'p1', {
      name: 'Bot',
      role: 'viewer',
      description: 'about',
    })
  })

  it('a blank name shows the error in the error region and never calls the API', async () => {
    mount()
    await submit()
    const alert = await screen.findByText('Name is required.')
    expect(follows(alert, probe('project.machine-users-new.error'))).toBe(true)
    expect(api.createMachineUser).not.toHaveBeenCalled()
  })

  it('never hands a typed value to a point', async () => {
    mount()
    await type('machine-user-name', 'secretname')
    for (const el of screen.getAllByTestId('probe')) {
      expect(el.getAttribute('data-keys')).not.toMatch(/name|role|description/)
      expect(el.textContent).not.toContain('secretname')
    }
  })
})
