import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const getVaultReadinessMock = vi.hoisted(() => vi.fn())
const initVaultMock = vi.hoisted(() => vi.fn())
const unsealVaultMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

vi.mock('$lib/api/vault.js', () => ({
  getVaultReadiness: getVaultReadinessMock,
  initVault: initVaultMock,
  unsealVault: unsealVaultMock,
}))

import VaultPage from './+page.svelte'

function requireForm(element: Element | null): HTMLFormElement {
  const form = element?.closest('form')
  if (!form) throw new Error('expected the button to be inside a form')
  return form
}

afterEach(() => {
  cleanup()
  gotoMock.mockClear()
  getVaultReadinessMock.mockReset()
  initVaultMock.mockReset()
  unsealVaultMock.mockReset()
})

describe('/vault +page.svelte', () => {
  it('renders the server-provided readiness data before any client refresh', () => {
    render(VaultPage, {
      props: { data: { readiness: { state: 'sealed', message: 'Manual unseal required.' } } },
    })

    expect(screen.getByRole('heading', { name: 'Unseal vault' })).toBeTruthy()
    expect(screen.getByText('Manual unseal required.')).toBeTruthy()
  })

  it('handles vault init: calls initVault then refreshes readiness, redirecting to /login when ready', async () => {
    initVaultMock.mockResolvedValue(undefined)
    getVaultReadinessMock.mockResolvedValue({ state: 'ready' })
    render(VaultPage, {
      props: { data: { readiness: { state: 'uninitialized', message: 'Set up the vault.' } } },
    })

    await fireEvent.input(screen.getByLabelText('Bootstrap token'), {
      target: { value: 'boot' },
    })
    await fireEvent.input(screen.getByLabelText('Vault passphrase'), {
      target: { value: 'pw' },
    })
    await fireEvent.submit(requireForm(screen.getByRole('button', { name: /initialize vault/i })))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(initVaultMock).toHaveBeenCalled()
    expect(getVaultReadinessMock).toHaveBeenCalled()
    expect(gotoMock).toHaveBeenCalledWith('/login')
  })

  it('handles vault unseal: calls unsealVault then refreshes readiness, not redirecting when still sealed', async () => {
    unsealVaultMock.mockResolvedValue(undefined)
    getVaultReadinessMock.mockResolvedValue({ state: 'sealed', message: 'Still sealed.' })
    render(VaultPage, {
      props: { data: { readiness: { state: 'sealed', message: 'Manual unseal required.' } } },
    })

    await fireEvent.input(screen.getByLabelText('Vault passphrase'), {
      target: { value: 'pw' },
    })
    await fireEvent.submit(requireForm(screen.getByRole('button', { name: /unseal vault/i })))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(unsealVaultMock).toHaveBeenCalled()
    expect(gotoMock).not.toHaveBeenCalled()
    expect(await screen.findByText('Still sealed.')).toBeTruthy()
  })
})
