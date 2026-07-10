import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'

import UpgradePage from './+page.svelte'

afterEach(() => cleanup())

function allowedData(overrides: Record<string, unknown> = {}) {
  return {
    allowed: true as const,
    version: '0.9.0',
    apiDocsEnabled: false,
    ...overrides,
  }
}

describe('/platform/upgrade +page.svelte', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/platform/upgrade')).toBe(true)
  })

  it('a non-operator sees the platform-operator-required notice', () => {
    render(UpgradePage, { props: { data: { allowed: false } } })

    expect(screen.getByRole('heading', { name: /platform operator access required/i })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /current version/i })).toBeNull()
  })

  it('shows the running version when present', () => {
    render(UpgradePage, { props: { data: allowedData({ version: '1.2.3' }) } })

    expect(screen.getByText(/running version/i).textContent).toMatch(/1\.2\.3/)
  })

  it('edge: shows a fallback message when version is unavailable', () => {
    render(UpgradePage, { props: { data: allowedData({ version: null }) } })

    expect(screen.getByText(/version information unavailable/i)).toBeTruthy()
  })

  it('shows the API docs disabled message and no Swagger link when apiDocsEnabled is false', () => {
    render(UpgradePage, { props: { data: allowedData({ apiDocsEnabled: false }) } })

    expect(screen.getByText(/not enabled on this instance/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /open api documentation/i })).toBeNull()
  })

  it('shows a working Swagger UI link when apiDocsEnabled is true', () => {
    render(UpgradePage, { props: { data: allowedData({ apiDocsEnabled: true }) } })

    const link = screen.getByRole('link', { name: /open api documentation/i })
    expect(link.getAttribute('href')).toBe('/api/v1/docs')
    expect(screen.queryByText(/not enabled on this instance/i)).toBeNull()
  })

  it('the Platform Admin breadcrumb link resolves to a real route', () => {
    render(UpgradePage, { props: { data: allowedData() } })

    const link = screen.getByRole('link', { name: /platform admin/i })
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
  })
})
