// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.12: the new machine user form's client-driven states (no access, blank name, failures,
// the submit in flight) cannot be reached by the route oracles. This pins them: the snapshot was
// recorded BEFORE the form was split into sub-regions and must come out unchanged. The mount helper
// is the only line that follows the component's props.

const api = vi.hoisted(() => ({ createMachineUser: vi.fn(), goto: vi.fn() }))
vi.mock('$app/state', () => ({ page: { route: { id: null }, params: {} } }))
vi.mock('$app/navigation', () => ({ goto: api.goto }))
vi.mock('$lib/api/machine-users.js', () => ({ createMachineUser: api.createMachineUser }))

let Form: Component<Record<string, unknown>>
beforeAll(async () => {
  Form = (await import('./MachineUsersNewForm.svelte')).default as unknown as typeof Form
}, 60_000)
beforeEach(() => {
  api.createMachineUser.mockReset()
  api.goto.mockReset()
})
afterEach(cleanup)

const mountForm = (orgRole = 'owner') =>
  render(Form, { props: { data: { orgRole, projectId: 'p-1' } } })
const asText = (states: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(states).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  )
const field = (id: string) => document.getElementById(id) as HTMLInputElement
const type = (id: string, value: string) => fireEvent.input(field(id), { target: { value } })
const submit = () => fireEvent.submit(field('machine-user-name').closest('form') as HTMLFormElement)

describe('MachineUsersNewForm client states (Story 69.12 pre-split pin)', () => {
  it('renders every interactive state exactly as before the split', async () => {
    const states: Record<string, unknown> = {}

    const initial = mountForm()
    states['initial'] = serializeWithoutNoise(initial.container)
    await submit()
    states['blank-name'] = serializeWithoutNoise(initial.container)
    states['blank-name-calls'] = api.createMachineUser.mock.calls.length
    cleanup()

    const denied = mountForm('viewer')
    states['no-access'] = serializeWithoutNoise(denied.container)
    cleanup()

    api.createMachineUser.mockRejectedValueOnce(new ApiClientError(409, null, 'name taken'))
    const failed = mountForm()
    await type('machine-user-name', 'Bot')
    await submit()
    await screen.findByText('name taken')
    states['api-error'] = serializeWithoutNoise(failed.container)
    cleanup()

    api.createMachineUser.mockRejectedValueOnce(new Error('network'))
    const generic = mountForm()
    await type('machine-user-name', 'Bot')
    await submit()
    await screen.findByText('Failed to create machine user.')
    states['generic-error'] = serializeWithoutNoise(generic.container)
    cleanup()

    api.createMachineUser.mockReset()
    let release: (value?: unknown) => void = () => undefined
    api.createMachineUser.mockReturnValueOnce(
      new Promise((resolveCreate) => (release = resolveCreate))
    )
    const pending = mountForm()
    await type('machine-user-name', '  Bot  ')
    await fireEvent.change(field('machine-user-role'), { target: { value: 'viewer' } })
    await type('machine-user-description', ' about ')
    await submit()
    await submit()
    states['submitting'] = serializeWithoutNoise(pending.container)
    states['submitting-calls'] = api.createMachineUser.mock.calls.length
    release({ id: 'mu-9' })
    await waitFor(() => expect(api.goto).toHaveBeenCalled())
    states['ok-args'] = api.createMachineUser.mock.calls.map((call) => call.slice(1))
    states['ok-goto'] = api.goto.mock.calls

    await expect(`${JSON.stringify(asText(states), null, 2)}\n`).toMatchFileSnapshot(
      './MachineUsersNewForm.states.snapshot.json'
    )
  }, 60_000)
})
