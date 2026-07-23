import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'

const pageState = vi.hoisted(() => ({
  status: 404,
  error: { message: 'Not Found' } as { message: string } | null,
  data: {} as Record<string, unknown>,
}))

vi.mock('$app/state', () => ({
  page: pageState,
}))

import ErrorPage from './+error.svelte'

afterEach(() => {
  cleanup()
  pageState.status = 404
  pageState.error = { message: 'Not Found' }
  pageState.data = {}
})

describe('+error.svelte — AC-17/18/19', () => {
  it('AC-17: renders within a branded shell with banner/navigation/main landmarks', () => {
    render(ErrorPage)

    expect(screen.getByRole('banner')).toBeTruthy()
    expect(screen.getByRole('navigation')).toBeTruthy()
    expect(screen.getByRole('main')).toBeTruthy()
  })

  it('AC-17: a 404 shows "Page not found" copy and a way back', () => {
    pageState.status = 404
    render(ErrorPage)

    expect(screen.getByText(/page not found/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /back to/i })).toBeTruthy()
  })

  it('AC-19: a genuine 5xx does not claim "Page not found" — shows status-appropriate copy instead', () => {
    pageState.status = 500
    pageState.error = { message: 'Internal Error' }
    render(ErrorPage)

    expect(screen.queryByText(/page not found/i)).toBeNull()
    expect(screen.getByText(/something went wrong/i)).toBeTruthy()
  })

  it('AC-18: an authenticated visitor (user present in page.data) is linked to /dashboard', () => {
    pageState.status = 404
    pageState.data = { user: { userId: 'u1' } }
    render(ErrorPage)

    const link = screen.getByRole('link', { name: /back to dashboard/i })
    expect(link.getAttribute('href')).toBe('/dashboard')
  })

  it('AC-18: an unauthenticated visitor (no user in page.data) is linked to / instead of /dashboard', () => {
    pageState.status = 404
    pageState.data = {}
    render(ErrorPage)

    const link = screen.getByRole('link', { name: /back to/i })
    expect(link.getAttribute('href')).toBe('/')
    expect(link.getAttribute('href')).not.toBe('/dashboard')
  })
})
