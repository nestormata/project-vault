import { describe, expect, it, vi } from 'vitest'
import { EMPTY_PROJECT_DASHBOARD } from '@project-vault/shared'
import { ApiClientError } from './client.js'
import {
  archiveProject,
  createProject,
  getProjectDashboard,
  listProjects,
  suggestProjectSlug,
  unarchiveProject,
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
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/projects', expect.anything())
  })

  it('listProjects({ includeArchived: true }) appends the query param', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { items: [], total: 0 } }))

    await listProjects(fetchFn, { includeArchived: true })

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/projects?includeArchived=true', expect.anything())
  })

  it('listProjects({ includeArchived: false }) omits the query param', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { items: [], total: 0 } }))

    await listProjects(fetchFn, { includeArchived: false })

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/projects', expect.anything())
  })

  it('archiveProject posts to the archive URL and returns archive state', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          id: '00000000-0000-4000-8000-000000000010',
          name: 'Payments API',
          slug: 'payments-api',
          archivedAt: '2026-07-01T00:00:00.000Z',
          isArchived: true,
        },
      })
    )

    const result = await archiveProject(fetchFn, '00000000-0000-4000-8000-000000000010')

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/projects/00000000-0000-4000-8000-000000000010/archive',
      expect.objectContaining({ method: 'POST' })
    )
    expect(result.isArchived).toBe(true)
  })

  it('unarchiveProject posts to the unarchive URL and returns archive state', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          id: '00000000-0000-4000-8000-000000000010',
          name: 'Payments API',
          slug: 'payments-api',
          archivedAt: null,
          isArchived: false,
        },
      })
    )

    const result = await unarchiveProject(fetchFn, '00000000-0000-4000-8000-000000000010')

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/projects/00000000-0000-4000-8000-000000000010/unarchive',
      expect.objectContaining({ method: 'POST' })
    )
    expect(result.isArchived).toBe(false)
  })

  it('archiveProject surfaces 409 active_rotations as a catchable ApiClientError carrying rotationIds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: 'active_rotations', rotationIds: ['00000000-0000-4000-8000-000000000099'] },
          { status: 409 }
        )
      )

    try {
      await archiveProject(fetchFn, '00000000-0000-4000-8000-000000000010')
      throw new Error('expected archiveProject to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiClientError)
      expect((error as ApiClientError).status).toBe(409)
      expect((error as ApiClientError).code).toBe('active_rotations')
      expect((error as ApiClientError).body).toMatchObject({
        rotationIds: ['00000000-0000-4000-8000-000000000099'],
      })
    }
  })

  it('archiveProject surfaces 410 project_archived distinctly from 409', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 'project_archived',
          message: 'This project is archived and cannot be modified. Unarchive it first.',
        },
        { status: 410 }
      )
    )

    await expect(
      archiveProject(fetchFn, '00000000-0000-4000-8000-000000000010')
    ).rejects.toMatchObject({
      status: 410,
      code: 'project_archived',
    } satisfies Partial<ApiClientError>)
  })

  it('getProjectDashboard returns dashboard data', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: EMPTY_PROJECT_DASHBOARD,
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
