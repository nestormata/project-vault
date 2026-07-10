import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/dashboard') },
}))

import PrimaryNav from './PrimaryNav.svelte'

afterEach(() => cleanup())

describe('PrimaryNav.svelte', () => {
  it('does not show Platform Admin link when isPlatformOperator is false (default)', () => {
    render(PrimaryNav, { props: {} })

    expect(screen.queryByRole('link', { name: /platform admin/i })).toBeNull()
  })

  it('shows a Platform Admin link when isPlatformOperator is true', () => {
    render(PrimaryNav, { props: { isPlatformOperator: true } })

    const link = screen.getByRole('link', { name: /platform/i })
    expect(link.getAttribute('href')).toBe('/platform')
  })

  it('marks the current path as active via aria-current', () => {
    render(PrimaryNav, { props: {} })

    const dashboardLink = screen.getByRole('link', { name: /dashboard/i })
    expect(dashboardLink.getAttribute('aria-current')).toBe('page')
    const projectsLink = screen.getByRole('link', { name: /projects/i })
    expect(projectsLink.getAttribute('aria-current')).toBeNull()
  })

  it('invokes onsearch when the search button is clicked', async () => {
    const onsearch = vi.fn()
    render(PrimaryNav, { props: { onsearch } })

    await fireEvent.click(screen.getByRole('button', { name: /search/i }))

    expect(onsearch).toHaveBeenCalled()
  })
})
