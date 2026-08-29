import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/dashboard') },
}))

import { setLocale } from '$lib/paraglide/runtime.js'
import PrimaryNav from './PrimaryNav.svelte'

afterEach(async () => {
  cleanup()
  // Reset the cookie-strategy locale back to the baseline so later tests (and other test files
  // sharing this jsdom document) don't inherit a locale switch made here.
  await setLocale('en', { reload: false })
})

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

  // Story 28.4 AC2/Task 6: the regression proof that PrimaryNav's nav-item read is reactive to a
  // no-reload locale switch (Story 15.1's own setLocale(..., { reload: false }) design), not just
  // correct on first paint. Before this story's fix, `const navItems = getPrimaryNavItems(...)`
  // resolved exactly once at mount; converting it to `$derived(...)` lets it re-read the current
  // locale whenever this component re-renders for any reason (e.g. after a form's `update()`
  // re-runs the page's load function), which the `rerender` call below simulates.
  it('AC2: nav labels update to Spanish after setLocale switches locale without a full page reload, no remount required', async () => {
    const { rerender } = render(PrimaryNav, { props: {} })
    expect(screen.getAllByText('Dashboard').length).toBeGreaterThan(0)

    await setLocale('es', { reload: false })
    await rerender({})

    expect(screen.queryAllByText('Dashboard').length).toBe(0)
    expect(screen.getAllByText('Panel').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Proyectos').length).toBeGreaterThan(0)
  })

  // AC2 edge: the conditionally-appended Platform Admin / Extension nav items are translated too
  // — a naive fix could miss them since they live off the base array.
  it('AC2 edge: the Platform Admin and Extension nav items are also translated after a locale switch', async () => {
    const { rerender } = render(PrimaryNav, {
      props: { isPlatformOperator: true, hasUiPanelExtension: true },
    })
    expect(screen.getByRole('link', { name: /platform admin/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /^extension/i })).toBeTruthy()

    await setLocale('es', { reload: false })
    await rerender({ isPlatformOperator: true, hasUiPanelExtension: true })

    expect(screen.getByRole('link', { name: /administración de plataforma/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /^extensión/i })).toBeTruthy()
  })
})
