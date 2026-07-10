import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'

vi.mock('$app/paths', () => ({
  resolve: (path: string) => path,
}))

import CredentialsImportPage from './+page.svelte'

afterEach(() => cleanup())

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    canImport: true,
    orgRole: 'admin',
    projects: { items: [], total: 0 },
    ...overrides,
  }
}

describe('credentials/import +page.svelte', () => {
  it('shows the access-denied notice when canImport is false', () => {
    render(CredentialsImportPage, { props: { data: baseData({ canImport: false }) } })

    expect(screen.getByText(/import not available/i)).toBeTruthy()
    expect(screen.getByText(/requires admin or owner access/i)).toBeTruthy()
  })

  it('shows the create-a-project empty state when there are no projects', () => {
    render(CredentialsImportPage, { props: { data: baseData() } })

    expect(screen.getByText(/create a project before importing credentials/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /create project/i })
    expect(link.getAttribute('href')).toBe('/projects/new')
  })

  it('lists projects with an Import-into link for each when canImport is true and projects exist', () => {
    render(CredentialsImportPage, {
      props: {
        data: baseData({
          projects: {
            items: [{ id: 'p-1', name: 'Proj A', slug: 'proj-a' }],
            total: 1,
          },
        }),
      },
    })

    expect(screen.getByText('Proj A')).toBeTruthy()
    expect(screen.getByText('proj-a')).toBeTruthy()
    const link = screen.getByRole('link', { name: /import into this project/i })
    expect(link.getAttribute('href')).toBe('/projects/p-1/credentials/import')
  })

  it('does not show the access-denied notice when canImport is true, even with an empty project list', () => {
    render(CredentialsImportPage, { props: { data: baseData() } })

    expect(screen.queryByText(/import not available/i)).toBeNull()
  })
})
