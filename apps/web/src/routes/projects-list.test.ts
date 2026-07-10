import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))
const updateProjectTagsMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({
  goto: vi.fn(async () => {}),
  invalidateAll: invalidateAllMock,
}))

vi.mock('$lib/api/projects.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/api/projects.js')>()
  return {
    ...original,
    updateProjectTags: updateProjectTagsMock,
  }
})

import ProjectsListPage from './(app)/projects/+page.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: projectId,
    name: 'Payments API',
    slug: 'payments-api',
    description: null,
    role: 'member' as const,
    credentialCount: 0,
    expiringCount: 0,
    alertCount: 0,
    tags: [] as string[],
    isArchived: false,
    ...overrides,
  }
}

function baseData(items: ReturnType<typeof makeProject>[] = [makeProject()]) {
  return {
    projects: { items, total: items.length, page: 1, limit: 20, hasNext: false },
    includeArchived: false,
  }
}

describe('/projects +page.svelte — tag management (Group P)', () => {
  beforeEach(() => {
    invalidateAllMock.mockClear()
    updateProjectTagsMock.mockReset()
  })
  afterEach(() => cleanup())

  it('AC-P2: shows tag chips and lets a member edit them via a full-replace text input', async () => {
    updateProjectTagsMock.mockResolvedValue({ id: projectId, tags: ['payments', 'billing'] })
    render(ProjectsListPage, {
      props: { data: baseData([makeProject({ tags: ['payments', 'stripe'] })]) },
    })

    expect(screen.getByText('payments')).toBeTruthy()
    expect(screen.getByText('stripe')).toBeTruthy()

    const input = screen.getByLabelText(/Tags/i) as HTMLInputElement
    expect(input.value).toBe('payments, stripe')
    await fireEvent.input(input, { target: { value: 'payments, billing' } })
    await fireEvent.click(screen.getByRole('button', { name: /Save/i }))

    await waitFor(() =>
      expect(updateProjectTagsMock).toHaveBeenCalledWith(fetch, projectId, ['payments', 'billing'])
    )
    await waitFor(() => expect(invalidateAllMock).toHaveBeenCalled())
  })

  it('shows "No tags yet" when a project has no tags', () => {
    render(ProjectsListPage, { props: { data: baseData([makeProject({ tags: [] })]) } })
    expect(screen.getByText('No tags yet')).toBeTruthy()
  })

  it('AC-P2 edge: saving an empty string clears tags', async () => {
    updateProjectTagsMock.mockResolvedValue({ id: projectId, tags: [] })
    render(ProjectsListPage, {
      props: { data: baseData([makeProject({ tags: ['payments'] })]) },
    })

    const input = screen.getByLabelText(/Tags/i) as HTMLInputElement
    await fireEvent.input(input, { target: { value: '' } })
    await fireEvent.click(screen.getByRole('button', { name: /Save/i }))

    await waitFor(() => expect(updateProjectTagsMock).toHaveBeenCalledWith(fetch, projectId, []))
  })

  it('AC-P3: viewers see tag chips but no Edit tags control', () => {
    render(ProjectsListPage, {
      props: {
        data: baseData([makeProject({ role: 'viewer' as const, tags: ['payments'] })]),
      },
    })

    expect(screen.getByText('payments')).toBeTruthy()
    expect(screen.queryByLabelText(/Tags/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Save/i })).toBeNull()
  })

  it('AC-P3: an archived project shows tag chips but no Edit tags control, even for an owner', () => {
    render(ProjectsListPage, {
      props: {
        data: baseData([
          makeProject({ role: 'owner' as const, isArchived: true, tags: ['payments'] }),
        ]),
      },
    })

    expect(screen.getByText('payments')).toBeTruthy()
    expect(screen.queryByLabelText(/Tags/i)).toBeNull()
  })

  it('AC-P4: a 422 validation error renders inline, retains the typed text, and leaves chips unchanged', async () => {
    updateProjectTagsMock.mockRejectedValue(
      new ApiClientError(
        422,
        {
          code: 'validation_error',
          message: 'Request validation failed',
          details: { tags: ['Too big: expected array to have <=20 items'] },
        },
        'Request validation failed'
      )
    )
    render(ProjectsListPage, {
      props: { data: baseData([makeProject({ tags: ['payments'] })]) },
    })

    const input = screen.getByLabelText(/Tags/i) as HTMLInputElement
    const manyTags = Array(21).fill('x').join(', ')
    await fireEvent.input(input, { target: { value: manyTags } })
    await fireEvent.click(screen.getByRole('button', { name: /Save/i }))

    await waitFor(() =>
      expect(screen.getByText('A project may have at most 20 tags.')).toBeTruthy()
    )
    expect(input.value).toBe(manyTags)
    expect(screen.getByText('payments')).toBeTruthy()
    expect(invalidateAllMock).not.toHaveBeenCalled()
  })
})
