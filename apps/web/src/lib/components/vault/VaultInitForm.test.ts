import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import VaultInitForm from './VaultInitForm.svelte'

afterEach(() => cleanup())

function requireForm(element: Element | null): HTMLFormElement {
  const form = element?.closest('form')
  if (!form) throw new Error('expected the button to be inside a form')
  return form
}

describe('VaultInitForm.svelte', () => {
  it('defaults to passphrase mode and shows the passphrase field', () => {
    const { container } = render(VaultInitForm, { props: { onSubmit: vi.fn() } })

    expect(screen.getByLabelText('Vault passphrase')).toBeTruthy()
    expect(container.querySelector('#vault-envelope-key-path')).toBeNull()
    expect(container.querySelector('#vault-master-key-path')).toBeNull()
  })

  it('switches to envelope mode and shows the split-key acknowledgement checkbox', async () => {
    const { container } = render(VaultInitForm, { props: { onSubmit: vi.fn() } })

    await fireEvent.click(screen.getByRole('radio', { name: /envelope key path/i }))

    expect(container.querySelector('#vault-envelope-key-path')).toBeTruthy()
    expect(screen.getByText(/split-key model for envelope mode/i)).toBeTruthy()
    expect(screen.queryByLabelText('Vault passphrase')).toBeNull()
  })

  it('switches to file mode and shows the co-location risk acknowledgement checkbox', async () => {
    const { container } = render(VaultInitForm, { props: { onSubmit: vi.fn() } })

    await fireEvent.click(screen.getByRole('radio', { name: /master key file path/i }))

    expect(container.querySelector('#vault-master-key-path')).toBeTruthy()
    expect(screen.getByText(/key co-location risk for file mode/i)).toBeTruthy()
  })

  it('submits the passphrase request and clears sensitive fields afterward', async () => {
    const onSubmit = vi.fn(async () => {})
    render(VaultInitForm, { props: { onSubmit } })

    await fireEvent.input(screen.getByLabelText('Bootstrap token'), {
      target: { value: 'bootstrap-secret' },
    })
    await fireEvent.input(screen.getByLabelText('Vault passphrase'), {
      target: { value: 'my-passphrase' },
    })
    await fireEvent.submit(requireForm(screen.getByRole('button', { name: /initialize vault/i })))
    await Promise.resolve()
    await Promise.resolve()

    expect(onSubmit).toHaveBeenCalledWith(
      { kmsType: 'passphrase', passphrase: 'my-passphrase' },
      'bootstrap-secret'
    )
    expect((screen.getByLabelText('Bootstrap token') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Vault passphrase') as HTMLInputElement).value).toBe('')
  })

  it('shows an error message when onSubmit rejects with an Error, and re-enables the button', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('bootstrap token invalid')
    })
    render(VaultInitForm, { props: { onSubmit } })

    await fireEvent.input(screen.getByLabelText('Bootstrap token'), {
      target: { value: 'bad-token' },
    })
    await fireEvent.input(screen.getByLabelText('Vault passphrase'), {
      target: { value: 'pw' },
    })
    await fireEvent.submit(requireForm(screen.getByRole('button', { name: /initialize vault/i })))
    await Promise.resolve()
    await Promise.resolve()

    expect((await screen.findByRole('alert')).textContent).toContain('bootstrap token invalid')
    expect(
      (screen.getByRole('button', { name: /initialize vault/i }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('falls back to a generic error message when a non-Error is thrown', async () => {
    const onSubmit = vi.fn(async () => {
      throw 'oops'
    })
    render(VaultInitForm, { props: { onSubmit } })

    await fireEvent.input(screen.getByLabelText('Bootstrap token'), { target: { value: 't' } })
    await fireEvent.input(screen.getByLabelText('Vault passphrase'), { target: { value: 'p' } })
    await fireEvent.submit(requireForm(screen.getByRole('button', { name: /initialize vault/i })))
    await Promise.resolve()
    await Promise.resolve()

    expect((await screen.findByRole('alert')).textContent).toContain('Vault initialization failed.')
  })

  it('ignores a second submit while the first is still in-flight', async () => {
    let resolveSubmit: (() => void) | undefined
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve
        })
    )
    render(VaultInitForm, { props: { onSubmit } })

    await fireEvent.input(screen.getByLabelText('Bootstrap token'), { target: { value: 't' } })
    await fireEvent.input(screen.getByLabelText('Vault passphrase'), { target: { value: 'p' } })
    const form = requireForm(screen.getByRole('button', { name: /initialize vault/i }))
    await fireEvent.submit(form)
    await fireEvent.submit(form)

    expect(onSubmit).toHaveBeenCalledTimes(1)
    resolveSubmit?.()
  })
})
