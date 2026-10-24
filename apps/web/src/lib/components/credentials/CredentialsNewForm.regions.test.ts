import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.11: the new secret form is one sub-region per field group. A probe contribution lands
// after its own group, the template switch swaps the value region for the fields region, and the
// form keeps ONE owner of every typed value across that switch.

const api = vi.hoisted(() => ({ createCredential: vi.fn(), goto: vi.fn() }))
vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/projects/[projectId]/credentials/new' }, params: {} },
}))
vi.mock('$app/navigation', () => ({ goto: api.goto }))
vi.mock('$lib/api/credentials.js', () => ({ createCredential: api.createCredential }))

const POINTS = [
  'project.credentials-new.name',
  'project.credentials-new.template',
  'project.credentials-new.value',
  'project.credentials-new.fields',
  'project.credentials-new.description',
  'project.credentials-new.tags',
  'project.credentials-new.error',
  'project.credentials-new.submit',
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
  Form = (await import('./CredentialsNewForm.svelte')).default as unknown as typeof Form
}, 60_000)
beforeEach(() => {
  api.createCredential.mockReset()
  api.goto.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

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
const choose = (value: string) =>
  fireEvent.change(byId('credential-template'), { target: { value } })

describe('CredentialsNewForm sub-regions (probe order)', () => {
  it('each field group is followed by its own probe, in form order', () => {
    mount()
    const order = [
      ['credential-name-help', 'project.credentials-new.name'],
      ['credential-template-help', 'project.credentials-new.template'],
      ['credential-value-help', 'project.credentials-new.value'],
      ['credential-description-help', 'project.credentials-new.description'],
      ['credential-tags-help', 'project.credentials-new.tags'],
    ] as const
    for (const [help, point] of order) {
      expect(follows(byId(help), probe(point))).toBe(true)
    }
    const probes = order.map(([, point]) => probe(point))
    probes.forEach((p, i) => {
      if (i > 0) expect(follows(probes[i - 1] as HTMLElement, p)).toBe(true)
    })
    expect(
      follows(probe('project.credentials-new.tags'), probe('project.credentials-new.submit'))
    ).toBe(true)
    expect(
      follows(
        screen.getByRole('button', { name: 'Create secret' }),
        probe('project.credentials-new.submit')
      )
    ).toBe(true)
  })

  it('the error probe sits between the tags group and the submit row, shown even without an error', () => {
    mount()
    const error = probe('project.credentials-new.error')
    expect(follows(probe('project.credentials-new.tags'), error)).toBe(true)
    expect(follows(error, screen.getByRole('button', { name: 'Create secret' }))).toBe(true)
  })

  it('renders no sub-region for a caller who cannot create secrets', () => {
    mount('viewer')
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
    expect(screen.getByText('Create not available')).toBeTruthy()
  })
})

describe('CredentialsNewForm state (interaction)', () => {
  it('a template swaps the value region for the fields region and keeps the typed name', async () => {
    mount()
    await type('credential-name', 'Prod DB')
    expect(screen.queryAllByTestId('probe').some((p) => p.textContent?.includes('.fields"'))).toBe(
      false
    )
    await choose('login')
    expect(document.getElementById('credential-value')).toBeNull()
    expect(follows(screen.getByText('Fields'), probe('project.credentials-new.fields'))).toBe(true)
    expect(byId('credential-name').value).toBe('Prod DB')
    await choose('')
    expect(byId('credential-value')).toBeTruthy()
    expect(byId('credential-name').value).toBe('Prod DB')
  })

  it('asks before a template switch discards edited fields, and keeps them on cancel', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    mount()
    await choose('login')
    const inputs = screen.getAllByPlaceholderText('field name')
    const keysBefore = inputs.map((input) => (input as HTMLInputElement).value)
    const valueInput = document.querySelector(
      'input[type="password"], textarea'
    ) as HTMLInputElement
    await fireEvent.input(valueInput, { target: { value: 'hunter2' } })
    await choose('api_key')
    expect(confirmSpy).toHaveBeenCalledWith('Switching templates will reset your fields. Continue?')
    expect(
      screen.getAllByPlaceholderText('field name').map((input) => (input as HTMLInputElement).value)
    ).toEqual(keysBefore)
    expect(document.querySelector('input[type="password"], textarea')).toBeTruthy()
  })

  it('submits a single-value secret, then clears the value and navigates to it', async () => {
    api.createCredential.mockResolvedValue({ id: 'c9' })
    mount()
    await type('credential-name', ' Prod DB ')
    await type('credential-value', 's3cret')
    await type('credential-tags', 'prod, api')
    await fireEvent.click(screen.getByRole('button', { name: 'Create secret' }))
    await waitFor(() => expect(api.createCredential).toHaveBeenCalled())
    expect(api.createCredential).toHaveBeenCalledWith(fetch, 'p1', {
      name: 'Prod DB',
      description: null,
      tags: ['prod', 'api'],
      value: 's3cret',
    })
    await waitFor(() => expect(api.goto).toHaveBeenCalledWith('/projects/p1/credentials/c9'))
    expect(byId('credential-value').value).toBe('')
  })

  it('shows a server failure in the error region and never keeps the typed value', async () => {
    api.createCredential.mockRejectedValue(new ApiClientError(500, null, 'boom'))
    mount()
    await type('credential-name', 'x')
    await type('credential-value', 's3cret')
    await fireEvent.click(screen.getByRole('button', { name: 'Create secret' }))
    const alert = await screen.findByRole('alert')
    expect(follows(alert, probe('project.credentials-new.error'))).toBe(true)
    expect(byId('credential-value').value).toBe('')
  })

  it('blocks a submit without a name or a value and shows the field errors in place', async () => {
    mount()
    await fireEvent.submit(document.querySelector('form') as HTMLFormElement)
    expect(api.createCredential).not.toHaveBeenCalled()
    expect(byId('credential-name').parentElement?.querySelector('p.text-red-700')).toBeTruthy()
  })

  it('never hands a typed value to a point', async () => {
    mount()
    await type('credential-value', 's3cret')
    for (const el of screen.getAllByTestId('probe')) {
      expect(el.getAttribute('data-keys')).not.toMatch(/value|name|tags|description|fields/)
      expect(el.textContent).not.toContain('s3cret')
    }
  })
})
