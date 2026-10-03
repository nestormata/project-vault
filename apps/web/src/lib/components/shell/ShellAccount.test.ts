import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { setLocale } from '$lib/paraglide/runtime.js'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const logoutMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$lib/api/auth.js', () => ({ logout: logoutMock }))

import { testAuthUser } from '$lib/test/page-data.js'
import ShellAccount from './ShellAccount.svelte'

afterEach(async () => {
  cleanup()
  gotoMock.mockClear()
  logoutMock.mockReset()
  logoutMock.mockResolvedValue(undefined)
  await setLocale('en', { reload: false })
})

const user = () => testAuthUser({ orgRole: 'admin', orgName: 'Test Org' })

// Story 68.5 AC-10: the role / org / sign-out cluster extracted from AppShell's header.
describe('ShellAccount.svelte', () => {
  it('renders the role, the org name and a sign-out button', () => {
    render(ShellAccount, { props: { user: user() } })

    expect(screen.getByText('Role: admin')).toBeTruthy()
    expect(screen.getByText('Org: Test Org')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
  })

  it('signs out: calls logout then redirects to the login page with a logged-out reason', async () => {
    render(ShellAccount, { props: { user: user() } })

    await fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(logoutMock).toHaveBeenCalled()
    expect(gotoMock).toHaveBeenCalledWith('/login?reason=logged-out')
  })

  it('still redirects when logout() throws', async () => {
    logoutMock.mockRejectedValueOnce(new Error('network down'))
    render(ShellAccount, { props: { user: user() } })

    await fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(gotoMock).toHaveBeenCalledWith('/login?reason=logged-out')
  })

  // The Story 28.4 hazard: m.shell_sign_out() reads no tracked signal, so the label re-reads the
  // locale only because the derived also reads the `user` prop.
  it('re-reads the locale on a no-reload language switch given a fresh user reference', async () => {
    const { rerender } = render(ShellAccount, { props: { user: user() } })
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()

    await setLocale('es', { reload: false })
    await rerender({ user: user() })

    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeTruthy()
  })
})
