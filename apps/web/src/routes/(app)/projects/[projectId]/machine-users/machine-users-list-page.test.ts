import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'

vi.mock('$app/paths', () => ({
  resolve: (path: string) => path,
}))

import MachineUsersListPage from './+page.svelte'

afterEach(() => cleanup())

const projectId = 'proj-1'

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    orgRole: 'admin',
    machineUsers: { items: [], total: 0 },
    notFound: false,
    ...overrides,
  }
}

describe('machine-users list +page.svelte', () => {
  it('shows the project-not-found alert when notFound is true', () => {
    render(MachineUsersListPage, { props: { data: baseData({ notFound: true }) } })

    expect(screen.getByText(/project was not found or you do not have access/i)).toBeTruthy()
  })

  it('shows the manager-oriented empty state and a Create link when canManage is true', () => {
    render(MachineUsersListPage, { props: { data: baseData({ orgRole: 'owner' }) } })

    expect(screen.getByText(/no machine users yet/i)).toBeTruthy()
    expect(screen.getByText(/create a machine user to issue an api key/i)).toBeTruthy()
    const createLink = screen.getByRole('link', { name: /create machine user/i })
    expect(createLink.getAttribute('href')).toBe(`/projects/${projectId}/machine-users/new`)
  })

  it('shows the viewer-oriented empty state and no Create link for a non-managing role', () => {
    render(MachineUsersListPage, { props: { data: baseData({ orgRole: 'viewer' }) } })

    expect(screen.getByText(/no machine users have been created in this project yet/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /create machine user/i })).toBeNull()
  })

  it('renders a populated table with Active and Deactivated status badges and links to detail pages', () => {
    render(MachineUsersListPage, {
      props: {
        data: baseData({
          orgRole: 'admin',
          machineUsers: {
            items: [
              {
                id: 'mu-1',
                name: 'ci-bot',
                role: 'member',
                keyCount: 2,
                createdAt: '2026-01-15T00:00:00.000Z',
                deactivatedAt: null,
              },
              {
                id: 'mu-2',
                name: 'old-bot',
                role: 'viewer',
                keyCount: 0,
                createdAt: '2026-02-20T00:00:00.000Z',
                deactivatedAt: '2026-03-01T00:00:00.000Z',
              },
            ],
            total: 2,
          },
        }),
      },
    })

    const ciLink = screen.getByRole('link', { name: 'ci-bot' })
    expect(ciLink.getAttribute('href')).toBe(`/projects/${projectId}/machine-users/mu-1`)
    const oldLink = screen.getByRole('link', { name: 'old-bot' })
    expect(oldLink.getAttribute('href')).toBe(`/projects/${projectId}/machine-users/mu-2`)

    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Deactivated')).toBeTruthy()
    expect(
      screen.getByText(
        new Date('2026-01-15T00:00:00.000Z').toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      )
    ).toBeTruthy()
  })

  it('the back-to-credentials link always resolves for this project', () => {
    render(MachineUsersListPage, { props: { data: baseData() } })

    const link = screen.getByRole('link', { name: /back to credentials/i })
    expect(link.getAttribute('href')).toBe(`/projects/${projectId}/credentials`)
  })
})
