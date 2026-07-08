import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'
import SettingsPage from './(app)/settings/+page.svelte'

// Story 8.7 AC-A1 — a fourth tile, "Audit & Compliance," is always visible (role-gating happens
// within the target page, not by hiding the tile) and links to a real, existing route.
describe('/settings +page.svelte', () => {
  afterEach(() => cleanup())

  it('renders an "Audit & Compliance" tile linking to /settings/audit', () => {
    render(SettingsPage)

    const link = screen.getByRole('link', { name: /audit & compliance/i })
    expect(link.getAttribute('href')).toBe('/settings/audit')
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
  })

  it('still renders the three pre-existing tiles unchanged', () => {
    render(SettingsPage)

    expect(screen.getByRole('link', { name: /notifications/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /^users/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /^security/i })).toBeTruthy()
  })
})
