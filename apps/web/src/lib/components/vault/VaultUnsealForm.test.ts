import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import VaultUnsealForm from './VaultUnsealForm.svelte'

afterEach(() => cleanup())

function requireForm(element: Element | null): HTMLFormElement {
  const form = element?.closest('form')
  if (!form) throw new Error('expected the button to be inside a form')
  return form
}

describe('VaultUnsealForm.svelte', () => {
  it('defaults to passphrase mode', () => {
    const { container } = render(VaultUnsealForm, { props: { onSubmit: vi.fn() } })

    expect(screen.getByLabelText('Vault passphrase')).toBeTruthy()
    expect(container.querySelector('#vault-unseal-envelope-path')).toBeNull()
    expect(container.querySelector('#vault-unseal-master-path')).toBeNull()
  })

  it('switches to envelope key file mode', async () => {
    const { container } = render(VaultUnsealForm, { props: { onSubmit: vi.fn() } })

    await fireEvent.click(screen.getByRole('radio', { name: /envelope key file/i }))

    expect(container.querySelector('#vault-unseal-envelope-path')).toBeTruthy()
    expect(screen.queryByLabelText('Vault passphrase')).toBeNull()
  })

  it('switches to master key file mode', async () => {
    const { container } = render(VaultUnsealForm, { props: { onSubmit: vi.fn() } })

    await fireEvent.click(screen.getByRole('radio', { name: /master key file/i }))

    expect(container.querySelector('#vault-unseal-master-path')).toBeTruthy()
  })

  it('submits the passphrase request and clears the field afterward', async () => {
    const onSubmit = vi.fn(async () => {})
    render(VaultUnsealForm, { props: { onSubmit } })

    await fireEvent.input(screen.getByLabelText('Vault passphrase'), {
      target: { value: 'unseal-me' },
    })
    await fireEvent.submit(requireForm(screen.getByRole('button', { name: /unseal vault/i })))
    await Promise.resolve()
    await Promise.resolve()

    expect(onSubmit).toHaveBeenCalledWith({ passphrase: 'unseal-me' })
    expect((screen.getByLabelText('Vault passphrase') as HTMLInputElement).value).toBe('')
  })

  it('shows an Error message from a rejected onSubmit', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('vault is already unsealed')
    })
    render(VaultUnsealForm, { props: { onSubmit } })

    await fireEvent.input(screen.getByLabelText('Vault passphrase'), { target: { value: 'x' } })
    await fireEvent.submit(requireForm(screen.getByRole('button', { name: /unseal vault/i })))
    await Promise.resolve()
    await Promise.resolve()

    expect((await screen.findByRole('alert')).textContent).toContain('vault is already unsealed')
  })

  it('falls back to a generic message for a non-Error rejection', async () => {
    const onSubmit = vi.fn(async () => {
      throw 'nope'
    })
    render(VaultUnsealForm, { props: { onSubmit } })

    await fireEvent.input(screen.getByLabelText('Vault passphrase'), { target: { value: 'x' } })
    await fireEvent.submit(requireForm(screen.getByRole('button', { name: /unseal vault/i })))
    await Promise.resolve()
    await Promise.resolve()

    expect((await screen.findByRole('alert')).textContent).toContain('Vault unseal failed.')
  })

  it('ignores a second submit while the first is in-flight', async () => {
    let resolveSubmit: (() => void) | undefined
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve
        })
    )
    render(VaultUnsealForm, { props: { onSubmit } })

    await fireEvent.input(screen.getByLabelText('Vault passphrase'), { target: { value: 'x' } })
    const form = requireForm(screen.getByRole('button', { name: /unseal vault/i }))
    await fireEvent.submit(form)
    await fireEvent.submit(form)

    expect(onSubmit).toHaveBeenCalledTimes(1)
    resolveSubmit?.()
  })
})
