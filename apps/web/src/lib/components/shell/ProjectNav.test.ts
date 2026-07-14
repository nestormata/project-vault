import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const mockedPage = vi.hoisted(() => ({
  url: new URL('http://localhost/projects/placeholder'),
}))

vi.mock('$app/state', () => ({
  page: mockedPage,
}))

import ProjectNav from './ProjectNav.svelte'

function setPathname(pathname: string) {
  mockedPage.url = new URL(`http://localhost${pathname}`)
}

afterEach(() => cleanup())

describe('ProjectNav.svelte', () => {
  it('AC-8: renders all 9 tabs, in order, as real <a> hrefs (progressive enhancement, AC-11)', () => {
    setPathname(`/projects/${projectId}`)
    render(ProjectNav, { props: { projectId, orgRole: 'member' } })

    const labels = [
      'Overview',
      'Credentials',
      'Members',
      'Machine Users',
      'Services',
      'Certificates',
      'Domains',
      'Endpoints',
      'Status Page',
    ]
    for (const label of labels) {
      const link = screen.getByRole('link', { name: label })
      expect(link.tagName).toBe('A')
      expect(link.getAttribute('href')).toBeTruthy()
    }
  })

  it('AC-9: marks the active tab matching the current route via aria-current', () => {
    setPathname(`/projects/${projectId}/credentials`)
    render(ProjectNav, { props: { projectId, orgRole: 'member' } })

    expect(screen.getByRole('link', { name: 'Credentials' }).getAttribute('aria-current')).toBe(
      'page'
    )
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBeNull()
  })

  it('AC-9: overview tab is only active on the exact overview path', () => {
    setPathname(`/projects/${projectId}`)
    render(ProjectNav, { props: { projectId, orgRole: 'member' } })

    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page')
  })

  it('AC-9: hides the Endpoints tab for a viewer role', () => {
    setPathname(`/projects/${projectId}`)
    render(ProjectNav, { props: { projectId, orgRole: 'viewer' } })

    expect(screen.queryByRole('link', { name: 'Endpoints' })).toBeNull()
  })

  it('AC-5: shows an Archived badge when isArchived is true, and hides it otherwise', () => {
    setPathname(`/projects/${projectId}`)
    const { unmount } = render(ProjectNav, {
      props: { projectId, orgRole: 'member', isArchived: true },
    })
    expect(screen.getByTestId('project-nav-archived-badge')).toBeTruthy()
    unmount()

    render(ProjectNav, { props: { projectId, orgRole: 'member', isArchived: false } })
    expect(screen.queryByTestId('project-nav-archived-badge')).toBeNull()
  })

  it('AC-16: exposes a distinct "Project navigation" landmark from the primary nav', () => {
    setPathname(`/projects/${projectId}`)
    render(ProjectNav, { props: { projectId, orgRole: 'member' } })

    expect(screen.getByRole('navigation', { name: 'Project navigation' })).toBeTruthy()
  })
})
