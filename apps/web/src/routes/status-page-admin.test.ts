import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import StatusPageAdminPage from './(app)/projects/[projectId]/status-page/+page.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('/projects/:projectId/status-page picker empty state (AC-A3)', () => {
  afterEach(() => cleanup())

  it('links to the new service-endpoints registration page when zero endpoints exist', () => {
    render(StatusPageAdminPage, {
      props: {
        data: {
          projectId,
          canManage: true,
          config: { enabled: true, token: null },
          serviceEndpoints: [],
        },
      },
    })

    const link = screen.getByRole('link', { name: /register one/i })
    expect(link.getAttribute('href')).toBe(`/projects/${projectId}/service-endpoints`)
  })
})
