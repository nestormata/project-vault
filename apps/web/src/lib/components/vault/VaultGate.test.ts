import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import VaultGate from './VaultGate.svelte'
import type { VaultReadiness } from '$lib/api/vault.js'

afterEach(() => cleanup())

function props(readiness: VaultReadiness) {
  return {
    readiness,
    onRetry: vi.fn(),
    onInit: vi.fn(),
    onUnseal: vi.fn(),
  }
}

describe('VaultGate.svelte', () => {
  it('shows the init form when uninitialized', () => {
    render(VaultGate, {
      props: props({ state: 'uninitialized', message: 'Set up the vault to continue.' }),
    })

    expect(screen.getByRole('heading', { name: 'Initialize vault' })).toBeTruthy()
    expect(screen.getByText('Set up the vault to continue.')).toBeTruthy()
    expect(screen.getByLabelText('Bootstrap token')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /retry readiness/i })).toBeNull()
  })

  it('shows the unseal form when sealed', () => {
    render(VaultGate, {
      props: props({ state: 'sealed', message: 'Manual unseal is required.' }),
    })

    expect(screen.getByRole('heading', { name: 'Unseal vault' })).toBeTruthy()
    expect(screen.getByText('Manual unseal is required.')).toBeTruthy()
    expect(screen.getByLabelText('Vault passphrase')).toBeTruthy()
  })

  it('shows a Retry readiness button when unavailable, and invokes onRetry', async () => {
    const componentProps = props({ state: 'unavailable', message: 'The vault host is offline.' })
    render(VaultGate, { props: componentProps })

    expect(screen.getByText('Project Vault is not ready')).toBeTruthy()
    const button = screen.getByRole('button', { name: /retry readiness/i })
    await fireEvent.click(button)

    expect(componentProps.onRetry).toHaveBeenCalled()
  })

  it('shows a ready message with no form and no retry button when ready', () => {
    render(VaultGate, { props: props({ state: 'ready' }) })

    expect(screen.getByText('Project Vault is ready')).toBeTruthy()
    expect(screen.getByText('Continue to sign in or register.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByLabelText('Bootstrap token')).toBeNull()
    expect(screen.queryByLabelText('Vault passphrase')).toBeNull()
  })
})
