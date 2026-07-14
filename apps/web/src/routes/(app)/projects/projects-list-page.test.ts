import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}))

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/projects') },
}))

import ProjectsListPage from './+page.svelte'

afterEach(() => cleanup())

const project = {
  id: 'p1',
  name: 'Payments API',
  slug: 'payments-api',
  description: 'Stripe + billing webhooks',
  role: 'owner' as const,
  credentialCount: 3,
  expiringCount: 1,
  alertCount: 0,
  tags: [] as string[],
  createdAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
  isArchived: false,
}

describe('projects list +page.svelte (AC-12)', () => {
  it('the project name links to the overview page, and "View credentials" stays a separate secondary link', () => {
    render(ProjectsListPage, {
      props: { data: { projects: { items: [project] }, includeArchived: false } },
    })

    const nameLink = screen.getByRole('link', { name: 'Payments API' })
    expect(nameLink.getAttribute('href')).toBe('/projects/p1')

    const credentialsLink = screen.getByRole('link', { name: 'View credentials' })
    expect(credentialsLink.getAttribute('href')).toBe('/projects/p1/credentials')
  })
})
