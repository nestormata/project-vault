import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { getProjectNavItems } from './project-nav-model.js'
import { projectRouteExists } from '$lib/test/route-exists.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const mockedPage = vi.hoisted(() => ({
  url: new URL('http://localhost/projects/placeholder'),
}))

vi.mock('$app/state', () => ({
  page: mockedPage,
}))

import ProjectNav from './ProjectNav.svelte'

afterEach(() => cleanup())

describe('project sub-nav hrefs resolve to real routes (AC-18, G3 navigation truth)', () => {
  it('every tab href in project-nav-model resolves to a real +page.svelte on disk', () => {
    const items = getProjectNavItems(projectId, 'owner')
    for (const item of items) {
      const suffix = item.href.replace(`/projects/${projectId}`, '')
      expect(projectRouteExists(suffix)).toBe(true)
    }
  })

  it('AC-8: renders identically (same 9 tabs) across three distinct project sub-routes, active tab tracking the route', () => {
    const routes = [
      `/projects/${projectId}`,
      `/projects/${projectId}/credentials`,
      `/projects/${projectId}/members`,
    ]
    for (const [index, route] of routes.entries()) {
      mockedPage.url = new URL(`http://localhost${route}`)
      const { unmount } = render(ProjectNav, { props: { projectId, orgRole: 'owner' } })

      const links = screen.getAllByRole('link')
      expect(links).toHaveLength(9)

      const activeLinks = links.filter((link) => link.getAttribute('aria-current') === 'page')
      expect(activeLinks).toHaveLength(1)
      const expectedActiveLabel = ['Overview', 'Credentials', 'Members'][index]
      expect(activeLinks[0]?.textContent?.trim()).toBe(expectedActiveLabel)

      unmount()
    }
  })
})
