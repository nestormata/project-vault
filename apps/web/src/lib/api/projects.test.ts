import { describe, expect, it, vi } from 'vitest'
import { ApiClientError } from './client.js'
import {
  createProject,
  getProjectDashboard,
  listProjects,
  suggestProjectSlug,
  updateProject,
} from './projects.js'
import { jsonResponse } from '$lib/test/json-response.js'

describe('project API helpers', () => {
  it('createProject sends the expected body and returns project data', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          data: {
            id: '00000000-0000-4000-8000-000000000010',
            orgId: '00000000-0000-4000-8000-000000000002',
            name: 'Payments API',
            slug: 'payments-api',
            description: null,
            role: 'owner',
            createdBy: '00000000-0000-4000-8000-000000000001',
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
            archivedAt: null,
          },
        },
        { status: 201 }
      )
    )

    const result = await createProject(fetchFn, {
      name: 'Payments API',
      slug: 'payments-api',
      description: null,
    })

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/projects', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Payments API', slug: 'payments-api', description: null }),
    })
    expect(result.slug).toBe('payments-api')
  })

  it('listProjects returns the project list envelope data', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { items: [], total: 0 } }))

    await expect(listProjects(fetchFn)).resolves.toEqual({ items: [], total: 0 })
  })

  it('getProjectDashboard returns dashboard data', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          credentialStats: { active: 0, expiringSoon: 0, expired: 0 },
          upcomingRotations: [],
          monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
          recentAccessEvents: [],
          unresolvedAlertCount: 0,
          isEmpty: true,
          suggestedActions: ['add_credential', 'add_service', 'import_credentials'],
        },
      })
    )

    await expect(
      getProjectDashboard(fetchFn, '00000000-0000-4000-8000-000000000010')
    ).resolves.toMatchObject({ isEmpty: true })
  })

  it('updateProject sends only mutable fields', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          id: '00000000-0000-4000-8000-000000000010',
          name: 'New Name',
          slug: 'payments-api',
          description: null,
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      })
    )

    await updateProject(fetchFn, '00000000-0000-4000-8000-000000000010', {
      name: 'New Name',
      description: null,
    })

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/projects/00000000-0000-4000-8000-000000000010',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: 'New Name', description: null }),
      })
    )
  })

  it('surfaces slug_taken as a catchable ApiClientError', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 'slug_taken',
          message: 'A project with this slug already exists in your organization',
        },
        { status: 409 }
      )
    )

    await expect(
      createProject(fetchFn, { name: 'Payments API', slug: 'payments-api' })
    ).rejects.toMatchObject({
      status: 409,
      code: 'slug_taken',
    } satisfies Partial<ApiClientError>)
  })

  it.each([
    ['Payments API', 'payments-api'],
    ['  My  App!! ', 'my-app'],
    ['A', 'project'],
    ['AB', 'project'],
    ['---', 'project'],
  ])('suggests a slug for %s', (name, slug) => {
    expect(suggestProjectSlug(name)).toBe(slug)
  })

  it('truncates suggested slugs without a trailing hyphen', () => {
    expect(suggestProjectSlug(`${'a'.repeat(49)} project`)).toBe('a'.repeat(49))
  })
})
