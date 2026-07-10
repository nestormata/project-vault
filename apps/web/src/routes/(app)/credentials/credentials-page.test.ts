import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'

vi.mock('$app/paths', () => ({
  resolve: (path: string) => path,
}))

import CredentialsPage from './+page.svelte'

afterEach(() => cleanup())

describe('/credentials +page.svelte', () => {
  it('shows the no-projects empty state with a Create project link', () => {
    render(CredentialsPage, { props: { data: { projects: { items: [], total: 0 } } } })

    expect(screen.getByText(/no projects yet/i)).toBeTruthy()
    const links = screen.getAllByRole('link', { name: /create project/i })
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link.getAttribute('href')).toBe('/projects/new')
    }
  })

  it('lists projects with credential/expiring/alert counts and a Manage-credentials link', () => {
    render(CredentialsPage, {
      props: {
        data: {
          projects: {
            items: [
              {
                id: 'p-1',
                name: 'Proj A',
                slug: 'proj-a',
                credentialCount: 5,
                expiringCount: 2,
                alertCount: 1,
              },
            ],
            total: 1,
          },
        },
      },
    })

    expect(screen.getByText('Proj A')).toBeTruthy()
    expect(screen.getByText('proj-a')).toBeTruthy()
    expect(screen.getByText('5')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
    const link = screen.getByRole('link', { name: /manage credentials/i })
    expect(link.getAttribute('href')).toBe('/projects/p-1/credentials')
  })
})
