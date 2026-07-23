import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'

const registerMock = vi.hoisted(() => vi.fn())
const pageMock = vi.hoisted(() => ({ url: new URL('http://localhost/register') }))

vi.mock('$lib/api/auth.js', () => ({
  register: registerMock,
}))

vi.mock('$app/navigation', () => ({
  goto: vi.fn(async () => {}),
}))

vi.mock('$app/state', () => ({
  page: pageMock,
}))

import RegisterPage from './+page.svelte'

describe('/register +page.svelte', () => {
  beforeEach(() => {
    pageMock.url = new URL('http://localhost/register')
    registerMock.mockReset()
  })
  afterEach(() => cleanup())

  it('shows the first-organization copy and an org-name field when there is no invitation token', () => {
    render(RegisterPage)

    // AC-25: "first organization" claimed scarcity that isn't true (every registration always
    // creates a new, independent org regardless of how many already exist) — replaced with
    // copy that's accurate no matter the instance's actual org count.
    expect(screen.getByText(/create a new, independent organization/i)).toBeTruthy()
    expect(screen.getByLabelText(/organization name/i)).toBeTruthy()
  })

  it('shows invited-join copy and hides the org-name field when an invitationToken is present', () => {
    pageMock.url = new URL(
      'http://localhost/register?invitationToken=tok-1&email=invited%40example.com'
    )
    render(RegisterPage)

    expect(
      screen.getByText(/you don't have an account yet — create one to join the project\./i)
    ).toBeTruthy()
    expect(screen.queryByLabelText(/organization name/i)).toBeNull()
    expect((screen.getByLabelText(/email/i) as HTMLInputElement).value).toBe('invited@example.com')
  })

  it('prefills no email when the ?email param is absent', () => {
    render(RegisterPage)
    expect((screen.getByLabelText(/email/i) as HTMLInputElement).value).toBe('')
  })

  it('links back to /login, a real route', () => {
    render(RegisterPage)
    const link = screen.getByRole('link', { name: /sign in/i })
    expect(link.getAttribute('href')).toBe('/login')
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
  })
})
