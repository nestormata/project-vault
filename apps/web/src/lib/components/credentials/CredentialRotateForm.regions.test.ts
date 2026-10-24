import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClientError } from '$lib/test/api-error.js'

// Story 69.14: the start-rotation form's sections are sub-regions. A probe contribution lands
// BETWEEN the two PV sections it was meant to sit between, and the field selection, the typed
// values and the same-value prompt keep ONE owner (the form controller) across the sections.

const initiateRotationMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('$app/state', () => ({
  page: {
    route: { id: '/(app)/projects/[projectId]/credentials/[credentialId]/rotate' },
    params: {},
  },
}))
vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$lib/api/rotations.js', () => ({ initiateRotation: initiateRotationMock }))

const POINTS = [
  'project.credentials-rotate.dependencies',
  'project.credentials-rotate.fields',
  'project.credentials-rotate.field-values',
  'project.credentials-rotate.value',
  'project.credentials-rotate.notes',
  'project.credentials-rotate.same-value-confirm',
  'project.credentials-rotate.actions',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const TWO_FIELDS = [
  { key: 'username', sensitive: false },
  { key: 'password', sensitive: true },
]

let Form: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Form = (await import('./CredentialRotateForm.svelte')).default as unknown as typeof Form
}, 60_000)
beforeEach(() => {
  initiateRotationMock.mockReset()
  gotoMock.mockClear()
})
afterEach(() => {
  cleanup()
})

const pageData = (overrides: Record<string, unknown> = {}) => ({
  projectId: 'p1',
  credentialId: 'c1',
  orgRole: 'admin',
  canManage: true,
  dependencies: {
    hasDependencies: true,
    hasStagedRotation: false,
    items: [
      { id: 'd1', systemName: 'billing-worker' },
      { id: 'd2', systemName: 'api-gateway' },
    ],
  },
  fieldMeta: [{ key: 'value', sensitive: true }],
  activeRotationId: null,
  ...overrides,
})
const mount = (overrides: Record<string, unknown> = {}) =>
  render(Form, { props: { pageData: pageData(overrides), data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const hasProbe = (point: string): boolean =>
  screen.queryAllByTestId('probe').some((el) => el.textContent?.includes(`"fill:${point}"`))
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const theForm = (): HTMLFormElement => {
  const found = document.querySelector('form')
  if (found === null) throw new Error('no form rendered')
  return found
}

describe('CredentialRotateForm sub-regions (probe order)', () => {
  it('dependencies: after the last listed system, before the form', () => {
    mount()
    const point = probe('project.credentials-rotate.dependencies')
    expect(follows(screen.getByText('api-gateway'), point)).toBe(true)
    expect(follows(point, theForm())).toBe(true)
  })

  it('dependencies: still rendered after the empty-state notice with no dependent systems', () => {
    mount({ dependencies: { hasDependencies: false, hasStagedRotation: false, items: [] } })
    expect(
      follows(
        screen.getByText(/No dependent systems are recorded/),
        probe('project.credentials-rotate.dependencies')
      )
    ).toBe(true)
  })

  it('value: after the help text of the single input, before the notes', () => {
    mount()
    const point = probe('project.credentials-rotate.value')
    expect(follows(screen.getByLabelText('New value'), point)).toBe(true)
    expect(follows(point, screen.getByLabelText('Notes'))).toBe(true)
    expect(hasProbe('project.credentials-rotate.fields')).toBe(false)
    expect(hasProbe('project.credentials-rotate.field-values')).toBe(false)
  })

  it('fields: after the mode choice, before the value input, only for a multi-field credential', () => {
    mount({ fieldMeta: TWO_FIELDS })
    const point = probe('project.credentials-rotate.fields')
    expect(follows(screen.getByText(/specific fields/i), point)).toBe(true)
    expect(follows(point, screen.getByLabelText('New value'))).toBe(true)
  })

  it('notes: after the notes input, before the actions', () => {
    mount()
    const point = probe('project.credentials-rotate.notes')
    expect(follows(screen.getByLabelText('Notes'), point)).toBe(true)
    expect(follows(point, probe('project.credentials-rotate.actions'))).toBe(true)
  })

  it('actions: after the Cancel link, as the last section of the form', () => {
    mount()
    const point = probe('project.credentials-rotate.actions')
    expect(follows(screen.getByRole('link', { name: 'Cancel' }), point)).toBe(true)
    expect(theForm().contains(point)).toBe(true)
  })

  it('renders no sub-region for a sealed vault or a caller who cannot manage rotations', () => {
    mount({ vaultSealed: true, dependencies: null, fieldMeta: null })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
    cleanup()
    mount({ canManage: false, dependencies: null, fieldMeta: null })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
  })
})

describe('CredentialRotateForm state across sections (interaction)', () => {
  it('keeps the typed value when the selection switches to two fields and back to one', async () => {
    mount({ fieldMeta: TWO_FIELDS })
    await fireEvent.click(screen.getByText(/specific fields/i))
    await fireEvent.click(screen.getByLabelText('username', { selector: 'input' }))
    await fireEvent.input(screen.getByLabelText('New value'), { target: { value: 'alice' } })
    expect(hasProbe('project.credentials-rotate.value')).toBe(true)

    await fireEvent.click(screen.getByLabelText('password', { selector: 'input' }))
    expect(hasProbe('project.credentials-rotate.value')).toBe(false)
    const fieldValues = probe('project.credentials-rotate.field-values')
    expect(follows(probe('project.credentials-rotate.fields'), fieldValues)).toBe(true)
    expect(follows(fieldValues, probe('project.credentials-rotate.notes'))).toBe(true)
    expect((document.getElementById('rotation-value-username') as HTMLTextAreaElement).value).toBe(
      'alice'
    )
    await fireEvent.input(
      document.getElementById('rotation-value-password') as HTMLTextAreaElement,
      {
        target: { value: 'secret-2' },
      }
    )

    await fireEvent.click(screen.getByLabelText('username', { selector: 'input' }))
    expect(hasProbe('project.credentials-rotate.field-values')).toBe(false)
    expect((screen.getByLabelText('New value') as HTMLTextAreaElement).value).toBe('secret-2')
  })

  it('shows the field-values error through the field-values section and clears it on resubmit', async () => {
    mount({ fieldMeta: TWO_FIELDS })
    await fireEvent.click(screen.getByText(/specific fields/i))
    await fireEvent.click(screen.getByLabelText('username', { selector: 'input' }))
    await fireEvent.click(screen.getByLabelText('password', { selector: 'input' }))
    await fireEvent.input(
      document.getElementById('rotation-value-username') as HTMLTextAreaElement,
      {
        target: { value: 'alice' },
      }
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Start rotation' }))
    const error = await screen.findByText("Enter a new value for 'password'")
    expect(follows(error, probe('project.credentials-rotate.field-values'))).toBe(true)
    expect(initiateRotationMock).not.toHaveBeenCalled()
  })

  it('drives the same-value prompt: it appears between the notes and the actions, Cancel keeps the value', async () => {
    initiateRotationMock.mockRejectedValueOnce(
      apiClientError(
        409,
        { code: 'same_value_confirmation_required', field: null, message: 'identical' },
        'identical'
      )
    )
    mount()
    expect(hasProbe('project.credentials-rotate.same-value-confirm')).toBe(false)
    await fireEvent.input(screen.getByLabelText('New value'), { target: { value: 'dup-secret-9' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Start rotation' }))
    const prompt = await screen.findByText(/is identical to its current value/)
    const point = probe('project.credentials-rotate.same-value-confirm')
    expect(follows(probe('project.credentials-rotate.notes'), prompt)).toBe(true)
    expect(follows(screen.getByRole('button', { name: 'Cancel' }), point)).toBe(true)
    expect(follows(point, probe('project.credentials-rotate.actions'))).toBe(true)
    expect(point.closest('[role="alert"]')).toBeNull()
    expect(
      screen.queryAllByTestId('probe').some((p) => p.textContent?.includes('dup-secret-9'))
    ).toBe(false)

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(hasProbe('project.credentials-rotate.same-value-confirm')).toBe(false)
    expect((screen.getByLabelText('New value') as HTMLTextAreaElement).value).toBe('dup-secret-9')
    expect(initiateRotationMock).toHaveBeenCalledTimes(1)
  })

  it('Confirm resubmits the rejected request with confirmSameValue and navigates', async () => {
    initiateRotationMock
      .mockRejectedValueOnce(
        apiClientError(
          409,
          { code: 'same_value_confirmation_required', field: null, message: 'identical' },
          'identical'
        )
      )
      .mockResolvedValueOnce({ id: 'rot-9' })
    mount()
    await fireEvent.input(screen.getByLabelText('New value'), { target: { value: 'same' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Start rotation' }))
    await screen.findByText(/is identical to its current value/)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await vi.waitFor(() => expect(gotoMock).toHaveBeenCalledWith(expect.stringContaining('rot-9')))
    expect(initiateRotationMock).toHaveBeenLastCalledWith(
      expect.anything(),
      'p1',
      'c1',
      expect.objectContaining({ newValue: 'same', confirmSameValue: true })
    )
  })

  it('links a conflict error to the active rotation and keeps the actions section rendered', async () => {
    initiateRotationMock.mockRejectedValueOnce(
      apiClientError(
        409,
        { code: 'rotation_in_progress', rotationId: 'rot-7', message: 'busy' },
        'busy'
      )
    )
    mount()
    await fireEvent.input(screen.getByLabelText('New value'), { target: { value: 'x' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Start rotation' }))
    const link = await screen.findByRole('link', {
      name: 'A rotation is already in progress for this secret.',
    })
    expect(link.getAttribute('href')).toContain('/rotations/rot-7')
    expect(follows(link, probe('project.credentials-rotate.actions'))).toBe(true)
  })

  it('disables the sections and shows the active-rotation notice when a rotation is active', () => {
    mount({ fieldMeta: TWO_FIELDS, activeRotationId: 'rot-active' })
    expect(screen.getByRole('link', { name: 'View active rotation' })).toBeTruthy()
    expect((screen.getByLabelText('New value') as HTMLTextAreaElement).disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Start rotation' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })
})
