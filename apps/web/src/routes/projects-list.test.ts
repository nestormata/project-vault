import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const updateProjectTagsMock = vi.hoisted(() => vi.fn())
const archiveProjectMock = vi.hoisted(() => vi.fn())
const unarchiveProjectMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
  invalidateAll: invalidateAllMock,
}))

vi.mock('$lib/api/projects.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/api/projects.js')>()
  return {
    ...original,
    updateProjectTags: updateProjectTagsMock,
    archiveProject: archiveProjectMock,
    unarchiveProject: unarchiveProjectMock,
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
    gotoMock.mockClear()
    updateProjectTagsMock.mockReset()
    archiveProjectMock.mockReset()
    unarchiveProjectMock.mockReset()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

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

  it('renders empty, populated, description, and role-sensitive project states', () => {
    render(ProjectsListPage, { props: { data: baseData([]) } })
    expect(screen.getByText(/no projects yet/i)).toBeTruthy()
    cleanup()
    render(ProjectsListPage, {
      props: {
        data: baseData([
          makeProject({ description: 'Payment infrastructure', role: 'owner' }),
          makeProject({
            id: 'viewer-project',
            name: 'Viewer Project',
            role: 'viewer',
            isArchived: true,
          }),
        ]),
      },
    })
    expect(screen.getByText('Payment infrastructure')).toBeTruthy()
    expect(screen.getByText('Archived')).toBeTruthy()
    expect(screen.getByRole('button', { name: /archive project/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /unarchive/i })).toBeNull()
  })

  it('toggles archived visibility on and off', async () => {
    render(ProjectsListPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByRole('button', { name: /show archived/i }))
    expect(gotoMock).toHaveBeenCalledWith('?includeArchived=true', { invalidateAll: true })
    cleanup()
    render(ProjectsListPage, {
      props: { data: { ...baseData(), includeArchived: true } },
    })
    await fireEvent.click(screen.getByRole('button', { name: /hide archived/i }))
    expect(gotoMock).toHaveBeenLastCalledWith('?', { invalidateAll: true })
  })

  it('archives once after confirmation and invalidates', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let resolveArchive!: () => void
    archiveProjectMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveArchive = resolve
      })
    )
    render(ProjectsListPage, {
      props: { data: baseData([makeProject({ role: 'owner' })]) },
    })
    const archive = screen.getByRole('button', { name: /archive project/i })
    await fireEvent.click(archive)
    await fireEvent.click(archive)
    expect(archiveProjectMock).toHaveBeenCalledTimes(1)
    resolveArchive()
    await waitFor(() => expect(invalidateAllMock).toHaveBeenCalledTimes(1))
  })

  it('cancels archiving without mutation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(ProjectsListPage, {
      props: { data: baseData([makeProject({ role: 'owner' })]) },
    })
    await fireEvent.click(screen.getByRole('button', { name: /archive project/i }))
    expect(archiveProjectMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      new ApiClientError(
        409,
        { code: 'active_rotations', rotationIds: ['rotation-1', 'rotation-2'] },
        'active'
      ),
      /2 in-progress rotation/i,
    ],
    [new ApiClientError(403, { message: 'Archive denied' }, 'Archive denied'), /archive denied/i],
    [new Error('unknown'), /failed to archive project/i],
  ])('maps archive failures', async (failure, expected) => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    archiveProjectMock.mockRejectedValue(failure)
    render(ProjectsListPage, {
      props: { data: baseData([makeProject({ role: 'owner' })]) },
    })
    await fireEvent.click(screen.getByRole('button', { name: /archive project/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(expected)
  })

  it('unarchives once and invalidates', async () => {
    unarchiveProjectMock.mockResolvedValue({})
    render(ProjectsListPage, {
      props: {
        data: baseData([makeProject({ role: 'owner', isArchived: true })]),
      },
    })
    await fireEvent.click(screen.getByRole('button', { name: /unarchive/i }))
    expect(unarchiveProjectMock).toHaveBeenCalledWith(expect.anything(), projectId)
    expect(invalidateAllMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [new ApiClientError(403, { message: 'Unarchive denied' }, 'Unarchive denied'), /denied/i],
    [new Error('unknown'), /failed to unarchive project/i],
  ])('maps unarchive failures', async (failure, expected) => {
    unarchiveProjectMock.mockRejectedValue(failure)
    render(ProjectsListPage, {
      props: {
        data: baseData([makeProject({ role: 'owner', isArchived: true })]),
      },
    })
    await fireEvent.click(screen.getByRole('button', { name: /unarchive/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(expected)
  })

  it('guards duplicate tag saves while pending and maps an unknown error', async () => {
    let rejectSave!: (reason: unknown) => void
    updateProjectTagsMock.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectSave = reject
      })
    )
    render(ProjectsListPage, { props: { data: baseData() } })
    const save = screen.getByRole('button', { name: /^save$/i })
    await fireEvent.click(save)
    await fireEvent.click(save)
    expect(updateProjectTagsMock).toHaveBeenCalledTimes(1)
    rejectSave(new Error('unknown'))
    expect(await screen.findByText(/failed to save tags/i)).toBeTruthy()
  })
})
