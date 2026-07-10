import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'

const registerMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('$lib/api/auth.js', () => ({
  register: registerMock,
}))

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

import RegisterForm from './RegisterForm.svelte'

describe('RegisterForm', () => {
  beforeEach(() => {
    registerMock.mockReset()
    gotoMock.mockClear()
  })
  afterEach(() => cleanup())

  it('registers with an org name (no invitation) and redirects to the post-register login path', async () => {
    registerMock.mockResolvedValue({
      userId: 'u1',
      orgId: 'o1',
      email: 'alex@example.com',
      orgName: 'Acme',
      role: 'owner',
    })

    render(RegisterForm)

    expect(screen.getByLabelText(/organization name/i)).toBeTruthy()
    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'alex@example.com' },
    })
    await fireEvent.input(screen.getByLabelText(/organization name/i), {
      target: { value: 'Acme' },
    })
    await fireEvent.input(screen.getByLabelText(/^password$/i), {
      target: { value: 'super-secret-password' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /create account/i }))

    await waitFor(() =>
      expect(registerMock).toHaveBeenCalledWith(fetch, {
        email: 'alex@example.com',
        password: 'super-secret-password',
        orgName: 'Acme',
        invitationToken: undefined,
      })
    )
    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/login?reason=registered'))
  })

  it('hides the org-name field and readonly-locks email when an invitationToken is supplied, redirecting into the project', async () => {
    registerMock.mockResolvedValue({
      userId: 'u1',
      orgId: 'o1',
      email: 'invited@example.com',
      orgName: 'Acme',
      role: 'member',
      invitedProject: { projectId: 'proj-1', projectName: 'Payments', role: 'member' },
    })

    render(RegisterForm, {
      props: { invitationToken: 'tok-1', prefillEmail: 'invited@example.com' },
    })

    expect(screen.queryByLabelText(/organization name/i)).toBeNull()
    const emailInput = screen.getByLabelText(/email/i) as HTMLInputElement
    expect(emailInput.readOnly).toBe(true)
    expect(emailInput.value).toBe('invited@example.com')

    await fireEvent.input(screen.getByLabelText(/^password$/i), {
      target: { value: 'super-secret-password' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /create account/i }))

    await waitFor(() =>
      expect(registerMock).toHaveBeenCalledWith(fetch, {
        email: 'invited@example.com',
        password: 'super-secret-password',
        invitationToken: 'tok-1',
      })
    )
    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/projects/proj-1'))
  })

  it('shows the Error message and clears the password field on a failed registration', async () => {
    registerMock.mockRejectedValue(new Error('Email already registered'))

    render(RegisterForm)

    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'dup@example.com' },
    })
    await fireEvent.input(screen.getByLabelText(/organization name/i), {
      target: { value: 'Acme' },
    })
    await fireEvent.input(screen.getByLabelText(/^password$/i), {
      target: { value: 'super-secret-password' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /create account/i }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/email already registered/i)
    expect((screen.getByLabelText(/^password$/i) as HTMLInputElement).value).toBe('')
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it('shows a generic failure message when registration rejects with a non-Error value', async () => {
    registerMock.mockRejectedValue('weird failure')

    render(RegisterForm)

    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'dup@example.com' },
    })
    await fireEvent.input(screen.getByLabelText(/organization name/i), {
      target: { value: 'Acme' },
    })
    await fireEvent.input(screen.getByLabelText(/^password$/i), {
      target: { value: 'super-secret-password' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /create account/i }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/registration failed/i)
  })
})
