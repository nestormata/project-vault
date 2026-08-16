import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'

const requestRecoveryMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/recovery.js', () => ({
  requestRecovery: requestRecoveryMock,
}))

import RecoveryPage from './+page.svelte'

const GENERIC_MESSAGE = "If that email is registered, we've sent a recovery link."

describe('/recovery +page.svelte', () => {
  beforeEach(() => {
    requestRecoveryMock.mockReset()
  })
  afterEach(() => cleanup())

  it('shows the generic confirmation message after a successful request, regardless of whether the email matched (AC-9/AC-11)', async () => {
    requestRecoveryMock.mockResolvedValue({ message: 'sent' })

    render(RecoveryPage)
    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'someone@example.com' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /send recovery link/i }))

    expect(await screen.findByRole('status')).toHaveProperty('textContent', GENERIC_MESSAGE)
    expect(requestRecoveryMock).toHaveBeenCalledWith(fetch, 'someone@example.com')
  })

  it('shows the same generic confirmation even when the request fails/rate-limits (no enumeration leak)', async () => {
    requestRecoveryMock.mockRejectedValue(new Error('rate limited'))

    render(RecoveryPage)
    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'someone@example.com' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /send recovery link/i }))

    expect((await screen.findByRole('status')).textContent).toBe(GENERIC_MESSAGE)
  })

  it('Story 23.2 AC-13: shows the honest native_login_disabled message, never the fabricated generic confirmation', async () => {
    requestRecoveryMock.mockRejectedValue({ code: 'native_login_disabled', message: 'raw' })

    render(RecoveryPage)
    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'someone@example.com' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /send recovery link/i }))

    const status = await screen.findByRole('status')
    expect(status.textContent).not.toBe(GENERIC_MESSAGE)
    expect(status.textContent).toMatch(/external sign-in/i)
  })

  it('disables the submit button and shows pending copy while the request is in flight', async () => {
    let resolveRequest: (value: { message: string }) => void = () => {}
    requestRecoveryMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      })
    )

    render(RecoveryPage)
    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'someone@example.com' },
    })
    const button = screen.getByRole('button', { name: /send recovery link/i }) as HTMLButtonElement
    await fireEvent.click(button)

    expect(button.disabled).toBe(true)
    expect(button.textContent).toMatch(/sending/i)

    resolveRequest({ message: 'sent' })
    expect(await screen.findByRole('status')).toBeTruthy()
  })

  it('ignores re-entrant submit attempts while a request is already pending', async () => {
    let resolveRequest: (value: { message: string }) => void = () => {}
    requestRecoveryMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      })
    )

    render(RecoveryPage)
    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'someone@example.com' },
    })
    const button = screen.getByRole('button', { name: /send recovery link/i })
    await fireEvent.click(button)
    await fireEvent.click(button)

    expect(requestRecoveryMock).toHaveBeenCalledTimes(1)
    resolveRequest({ message: 'sent' })
    expect(await screen.findByRole('status')).toBeTruthy()
  })

  it('links back to /login, a real route', () => {
    render(RecoveryPage)
    const link = screen.getByRole('link', { name: /sign in/i })
    expect(link.getAttribute('href')).toBe('/login')
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
  })
})
