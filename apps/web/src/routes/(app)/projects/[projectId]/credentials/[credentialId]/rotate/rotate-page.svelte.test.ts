import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const initiateRotationMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$lib/api/rotations.js', () => ({ initiateRotation: initiateRotationMock }))

import { ApiClientError } from '$lib/api/client.js'
import RotatePage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function data(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    credentialId,
    orgRole: 'admin',
    canManage: true,
    dependencies: { items: [], hasDependencies: false },
    fieldMeta: [{ key: 'value', sensitive: true }],
    activeRotationId: null,
    ...overrides,
  }
}

describe('/rotate +page.svelte (Story 13.4)', () => {
  it('AC-1/AC-7: single-field credential renders exactly the today-shaped form, no selector', () => {
    render(RotatePage, { props: { data: data() } })
    expect(screen.getByLabelText('New value')).toBeTruthy()
    expect(screen.queryByText(/rotate whole secret/i)).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('AC-1: a multi-field credential renders a whole-secret/specific-fields mode toggle, defaulting to whole secret', () => {
    render(RotatePage, {
      props: {
        data: data({
          fieldMeta: [
            { key: 'username', sensitive: false },
            { key: 'password', sensitive: true },
          ],
        }),
      },
    })
    expect(screen.getByText(/rotate whole secret/i)).toBeTruthy()
    expect(screen.getByText(/specific fields/i)).toBeTruthy()
    // Default mode is whole-secret — no per-field checkboxes until the user opts in.
    expect(screen.queryByLabelText('password')).toBeNull()
  })

  it('AC-1: switching to specific-fields mode reveals a checkbox per field key', async () => {
    render(RotatePage, {
      props: {
        data: data({
          fieldMeta: [
            { key: 'username', sensitive: false },
            { key: 'password', sensitive: true },
          ],
        }),
      },
    })
    await fireEvent.click(screen.getByText(/specific fields/i))
    expect(screen.getByLabelText('username')).toBeTruthy()
    expect(screen.getByLabelText('password')).toBeTruthy()
  })

  it('AC-1 happy path: submitting with a targeted field sends targetFields', async () => {
    initiateRotationMock.mockResolvedValue({ id: 'rot-1' })
    render(RotatePage, {
      props: {
        data: data({
          fieldMeta: [
            { key: 'username', sensitive: false },
            { key: 'password', sensitive: true },
          ],
        }),
      },
    })

    await fireEvent.click(screen.getByText(/specific fields/i))
    await fireEvent.click(screen.getByLabelText('password'))
    await fireEvent.input(screen.getByLabelText('New value'), { target: { value: 'new-pw' } })
    await fireEvent.click(screen.getByRole('button', { name: /start rotation/i }))

    await vi.waitFor(() =>
      expect(initiateRotationMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        expect.objectContaining({ newValue: 'new-pw', targetFields: ['password'] })
      )
    )
  })

  it('whole-secret mode (default) omits targetFields entirely', async () => {
    initiateRotationMock.mockResolvedValue({ id: 'rot-1' })
    render(RotatePage, {
      props: {
        data: data({
          fieldMeta: [
            { key: 'username', sensitive: false },
            { key: 'password', sensitive: true },
          ],
        }),
      },
    })

    await fireEvent.input(screen.getByLabelText('New value'), { target: { value: 'whole-new' } })
    await fireEvent.click(screen.getByRole('button', { name: /start rotation/i }))

    await vi.waitFor(() => expect(initiateRotationMock).toHaveBeenCalled())
    const body = initiateRotationMock.mock.calls[0]?.[3]
    expect(body.targetFields).toBeUndefined()
  })

  it('requires at least one field checked before submitting in specific-fields mode', async () => {
    render(RotatePage, {
      props: {
        data: data({
          fieldMeta: [
            { key: 'username', sensitive: false },
            { key: 'password', sensitive: true },
          ],
        }),
      },
    })

    await fireEvent.click(screen.getByText(/specific fields/i))
    await fireEvent.input(screen.getByLabelText('New value'), { target: { value: 'x' } })
    await fireEvent.click(screen.getByRole('button', { name: /start rotation/i }))

    expect(initiateRotationMock).not.toHaveBeenCalled()
    expect(screen.getByText(/select at least one field/i)).toBeTruthy()
  })

  it('AC-3: surfaces a 400 unknown_field_key error inline', async () => {
    initiateRotationMock.mockRejectedValue(
      new ApiClientError(
        400,
        {
          code: 'unknown_field_key',
          field: 'totp_secret',
          message: "Unknown field key: 'totp_secret'",
        },
        "Unknown field key: 'totp_secret'"
      )
    )
    render(RotatePage, {
      props: {
        data: data({
          fieldMeta: [
            { key: 'username', sensitive: false },
            { key: 'password', sensitive: true },
          ],
        }),
      },
    })

    await fireEvent.click(screen.getByText(/specific fields/i))
    await fireEvent.click(screen.getByLabelText('password'))
    await fireEvent.input(screen.getByLabelText('New value'), { target: { value: 'x' } })
    await fireEvent.click(screen.getByRole('button', { name: /start rotation/i }))

    await vi.waitFor(() => expect(screen.getByText(/unknown field key/i)).toBeTruthy())
  })

  // Task 6 — active-rotation banner pre-empting AC-6's 409, per the pre-mortem elicitation note.
  it('disables the field selector and submit button when a rotation is already active', () => {
    render(RotatePage, {
      props: {
        data: data({
          fieldMeta: [
            { key: 'username', sensitive: false },
            { key: 'password', sensitive: true },
          ],
          activeRotationId: 'rot-active',
        }),
      },
    })

    expect(screen.getByText(/rotation is already in progress/i)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: /start rotation/i }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect((screen.getByLabelText('New value') as HTMLTextAreaElement).disabled).toBe(true)
    for (const radio of screen.getAllByRole('radio') as HTMLInputElement[]) {
      expect(radio.disabled).toBe(true)
    }
  })

  // Story 13.5 AC-3: a 409 same_value_confirmation_required shows an inline confirm/cancel
  // prompt instead of the generic error banner; Confirm resubmits with confirmSameValue: true.
  describe('Story 13.5 AC-3: same-value confirmation prompt', () => {
    it('shows the confirm/cancel prompt naming the field, and Confirm resubmits with confirmSameValue: true', async () => {
      initiateRotationMock
        .mockRejectedValueOnce(
          new ApiClientError(
            409,
            {
              code: 'same_value_confirmation_required',
              field: 'password',
              message: "The new value for 'password' is identical to its current value.",
            },
            "The new value for 'password' is identical to its current value."
          )
        )
        .mockResolvedValueOnce({ id: 'rot-1' })

      render(RotatePage, {
        props: {
          data: data({
            fieldMeta: [
              { key: 'username', sensitive: false },
              { key: 'password', sensitive: true },
            ],
          }),
        },
      })

      await fireEvent.click(screen.getByText(/specific fields/i))
      await fireEvent.click(screen.getByLabelText('password', { selector: 'input' }))
      await fireEvent.input(screen.getByLabelText('New value'), { target: { value: 'old-pw' } })
      await fireEvent.click(screen.getByRole('button', { name: /start rotation/i }))

      await vi.waitFor(() =>
        expect(screen.getByRole('alert').textContent).toMatch(/identical to its current value/i)
      )
      expect(screen.getByRole('alert').textContent).toContain('password')

      await fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

      await vi.waitFor(() =>
        expect(initiateRotationMock).toHaveBeenLastCalledWith(
          expect.anything(),
          projectId,
          credentialId,
          expect.objectContaining({
            newValue: 'old-pw',
            targetFields: ['password'],
            confirmSameValue: true,
          })
        )
      )
      await vi.waitFor(() =>
        expect(gotoMock).toHaveBeenCalledWith(expect.stringContaining('/rotations/rot-1'))
      )
    })

    it('Cancel dismisses the prompt and preserves the entered value, no resubmit', async () => {
      initiateRotationMock.mockRejectedValueOnce(
        new ApiClientError(
          409,
          { code: 'same_value_confirmation_required', field: null, message: 'identical' },
          'identical'
        )
      )

      render(RotatePage, { props: { data: data() } })

      await fireEvent.input(screen.getByLabelText('New value'), { target: { value: 'same' } })
      await fireEvent.click(screen.getByRole('button', { name: /start rotation/i }))

      await vi.waitFor(() =>
        expect(screen.getByRole('alert').textContent).toMatch(/identical to its current value/i)
      )
      expect(screen.getByRole('alert').textContent).toMatch(/the secret/i)

      await fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

      expect(screen.queryByRole('alert')).toBeNull()
      expect((screen.getByLabelText('New value') as HTMLTextAreaElement).value).toBe('same')
      expect(initiateRotationMock).toHaveBeenCalledTimes(1)
    })
  })

  // Story 13.5 AC-8: once 2+ fields are checked, one labeled value input per field replaces the
  // single shared textarea; values persist across selection changes; submit sends fieldValues.
  describe('Story 13.5 AC-8: per-field value inputs', () => {
    function multiFieldData() {
      return data({
        fieldMeta: [
          { key: 'username', sensitive: false },
          { key: 'password', sensitive: true },
        ],
      })
    }

    it('renders one labeled input per field once 2+ fields are checked, and submits fieldValues', async () => {
      initiateRotationMock.mockResolvedValue({ id: 'rot-1' })
      render(RotatePage, { props: { data: multiFieldData() } })

      await fireEvent.click(screen.getByText(/specific fields/i))
      await fireEvent.click(screen.getByLabelText('username', { selector: 'input' }))
      await fireEvent.click(screen.getByLabelText('password', { selector: 'input' }))

      expect(screen.getByLabelText('username', { selector: 'textarea' })).toBeTruthy()
      expect(screen.getByLabelText('password', { selector: 'textarea' })).toBeTruthy()
      expect(screen.queryByLabelText('New value')).toBeNull()

      await fireEvent.input(screen.getByLabelText('username', { selector: 'textarea' }), {
        target: { value: 'svc-2' },
      })
      await fireEvent.input(screen.getByLabelText('password', { selector: 'textarea' }), {
        target: { value: 'new-pw' },
      })
      await fireEvent.click(screen.getByRole('button', { name: /start rotation/i }))

      await vi.waitFor(() =>
        expect(initiateRotationMock).toHaveBeenCalledWith(
          expect.anything(),
          projectId,
          credentialId,
          expect.objectContaining({
            targetFields: ['username', 'password'],
            fieldValues: { username: 'svc-2', password: 'new-pw' },
          })
        )
      )
    })

    it('reverts to the single textarea when unchecking back down to 1 field, preserving the typed value', async () => {
      render(RotatePage, { props: { data: multiFieldData() } })

      await fireEvent.click(screen.getByText(/specific fields/i))
      await fireEvent.click(screen.getByLabelText('username', { selector: 'input' }))
      await fireEvent.click(screen.getByLabelText('password', { selector: 'input' }))

      await fireEvent.input(screen.getByLabelText('password', { selector: 'textarea' }), {
        target: { value: 'kept-value' },
      })

      // Uncheck username, dropping back to a single targeted field (password).
      await fireEvent.click(screen.getByLabelText('username', { selector: 'input' }))

      expect(screen.queryByLabelText('password', { selector: 'textarea' })).toBeNull()
      expect((screen.getByLabelText('New value') as HTMLTextAreaElement).value).toBe('kept-value')
    })
  })
})
