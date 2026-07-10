import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'

const verifyMfaLoginMock = vi.hoisted(() => vi.fn())
const getCurrentUserMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('$lib/api/auth.js', () => ({
  verifyMfaLogin: verifyMfaLoginMock,
  getCurrentUser: getCurrentUserMock,
}))

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

import MfaLoginForm from './MfaLoginForm.svelte'

async function submitCode(code = '123456') {
  await fireEvent.input(screen.getByLabelText(/authenticator code/i), {
    target: { value: code },
  })
  await fireEvent.click(screen.getByRole('button', { name: /verify mfa code/i }))
}

describe('MfaLoginForm', () => {
  beforeEach(() => {
    verifyMfaLoginMock.mockReset()
    getCurrentUserMock.mockReset()
    gotoMock.mockClear()
  })
  afterEach(() => cleanup())

  it('verifies the TOTP and redirects to /dashboard on success', async () => {
    verifyMfaLoginMock.mockResolvedValue({
      userId: 'u1',
      orgId: 'o1',
      expiresAt: '2026-01-01T00:00:00Z',
    })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

    render(MfaLoginForm, { props: { mfaToken: 'tok-1', onExpired: vi.fn() } })
    await submitCode('123456')

    expect(verifyMfaLoginMock).toHaveBeenCalledWith(fetch, { mfaToken: 'tok-1', totp: '123456' })
    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
  })

  it('shows a friendly message when the TOTP code is rejected, and retains the token for retry', async () => {
    verifyMfaLoginMock.mockRejectedValue({ code: 'invalid_totp' })

    render(MfaLoginForm, { props: { mfaToken: 'tok-1', onExpired: vi.fn() } })
    await submitCode('000000')

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /that code was not accepted\. try the next code/i
    )
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it('calls onExpired and shows an expiry message when the mfa token has expired', async () => {
    const onExpired = vi.fn()
    verifyMfaLoginMock.mockRejectedValue({ code: 'mfa_token_expired' })

    render(MfaLoginForm, { props: { mfaToken: 'tok-1', onExpired } })
    await submitCode('123456')

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(
      /your login step expired\. please sign in again\./i
    )
    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  it('shows the Error message for an unknown non-coded failure', async () => {
    verifyMfaLoginMock.mockRejectedValue(new Error('network down'))

    render(MfaLoginForm, { props: { mfaToken: 'tok-1', onExpired: vi.fn() } })
    await submitCode('123456')

    expect((await screen.findByRole('alert')).textContent).toMatch('network down')
  })

  it('shows a generic failure message for a thrown non-Error value', async () => {
    verifyMfaLoginMock.mockRejectedValue('boom')

    render(MfaLoginForm, { props: { mfaToken: 'tok-1', onExpired: vi.fn() } })
    await submitCode('123456')

    expect((await screen.findByRole('alert')).textContent).toMatch(/mfa verification failed/i)
  })

  it('disables the submit button and shows pending copy while verifying', async () => {
    let resolveVerify: (value: unknown) => void = () => {}
    verifyMfaLoginMock.mockReturnValue(
      new Promise((resolve) => {
        resolveVerify = resolve
      })
    )
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

    render(MfaLoginForm, { props: { mfaToken: 'tok-1', onExpired: vi.fn() } })
    await fireEvent.input(screen.getByLabelText(/authenticator code/i), {
      target: { value: '123456' },
    })
    const button = screen.getByRole('button', { name: /verify mfa code/i }) as HTMLButtonElement
    await fireEvent.click(button)

    expect(button.disabled).toBe(true)
    expect(button.textContent).toMatch(/verifying/i)

    resolveVerify({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
    await waitFor(() => expect(gotoMock).toHaveBeenCalled())
  })

  it('ignores re-entrant submit attempts while a request is already pending', async () => {
    let resolveVerify: (value: unknown) => void = () => {}
    verifyMfaLoginMock.mockReturnValue(
      new Promise((resolve) => {
        resolveVerify = resolve
      })
    )
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

    render(MfaLoginForm, { props: { mfaToken: 'tok-1', onExpired: vi.fn() } })
    await fireEvent.input(screen.getByLabelText(/authenticator code/i), {
      target: { value: '123456' },
    })
    const button = screen.getByRole('button', { name: /verify mfa code/i })
    await fireEvent.click(button)
    await fireEvent.click(button)

    expect(verifyMfaLoginMock).toHaveBeenCalledTimes(1)
    resolveVerify({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
    await waitFor(() => expect(gotoMock).toHaveBeenCalled())
  })
})
