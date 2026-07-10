import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'

import PlatformPage from './+page.svelte'

afterEach(() => cleanup())

function allowedData(overrides: Record<string, unknown> = {}) {
  return {
    allowed: true as const,
    warnings: [] as string[],
    ...overrides,
  }
}

describe('/platform +page.svelte', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/platform')).toBe(true)
  })

  it('a non-operator sees the platform-operator-required notice, no admin links', () => {
    render(PlatformPage, { props: { data: { allowed: false, warnings: [] } } })

    expect(screen.getByRole('heading', { name: /platform operator access required/i })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /backups/i })).toBeNull()
  })

  it('an operator sees all four admin nav links resolving to real routes', () => {
    render(PlatformPage, { props: { data: allowedData() } })

    const expectedHrefs = [
      '/platform/backups',
      '/platform/settings',
      '/platform/upgrade',
      '/platform/audit',
    ]
    const actualHrefs = screen.getAllByRole('link').map((l) => l.getAttribute('href'))
    for (const href of expectedHrefs) {
      expect(actualHrefs).toContain(href)
      expect(routeExists(href)).toBe(true)
    }
  })

  it('shows a warning banner with a working link when audit_storage_critical is present', () => {
    render(PlatformPage, { props: { data: allowedData({ warnings: ['audit_storage_critical'] }) } })

    expect(screen.getByText(/audit log storage is at critical capacity/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /^resource usage →$/i })
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
  })

  it('no warning banner is shown when warnings is empty', () => {
    render(PlatformPage, { props: { data: allowedData({ warnings: [] }) } })

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
