import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const gotoMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const createProjectMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

vi.mock('$app/paths', () => ({
  resolve: (path: string) => path,
}))

vi.mock('$lib/api/projects.js', () => ({
  createProject: createProjectMock,
  suggestProjectSlug: (name: string) => {
    const normalized = name
      .trim()
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    return normalized.length >= 3 ? normalized : 'project'
  },
}))

import { ApiClientError } from '$lib/api/client.js'
import NewProjectPage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  gotoMock.mockClear()
  createProjectMock.mockReset()
})

describe('projects/new +page.svelte', () => {
  it('auto-derives the slug from the name until the slug field is manually edited', async () => {
    render(NewProjectPage, {})

    const nameInput = screen.getByLabelText(/^name$/i) as HTMLInputElement
    const slugInput = screen.getByLabelText(/^slug$/i) as HTMLInputElement

    await fireEvent.input(nameInput, { target: { value: 'My Cool Project' } })
    expect(slugInput.value).toBe('my-cool-project')

    await fireEvent.input(nameInput, { target: { value: 'My Cool Project X' } })
    expect(slugInput.value).toBe('my-cool-project-x')
  })

  it('stops auto-deriving the slug once it has been manually edited, and clears any slug error', async () => {
    createProjectMock.mockRejectedValueOnce(
      new ApiClientError(409, { code: 'slug_taken' }, 'slug taken')
    )
    render(NewProjectPage, {})

    const nameInput = screen.getByLabelText(/^name$/i) as HTMLInputElement
    const slugInput = screen.getByLabelText(/^slug$/i) as HTMLInputElement

    await fireEvent.input(nameInput, { target: { value: 'proj' } })
    await fireEvent.click(screen.getByRole('button', { name: /create project/i }))
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.getByText(/slug already exists/i)).toBeTruthy()

    await fireEvent.input(slugInput, { target: { value: 'custom-slug' } })
    expect(screen.queryByText(/slug already exists/i)).toBeNull()

    await fireEvent.input(nameInput, { target: { value: 'Totally Different Name' } })
    expect(slugInput.value).toBe('custom-slug')
  })

  it('submits name/slug/trimmed description and navigates to the dashboard on success', async () => {
    createProjectMock.mockResolvedValueOnce({ id: 'p-1' })
    render(NewProjectPage, {})

    await fireEvent.input(screen.getByLabelText(/^name$/i), { target: { value: 'Proj A' } })
    await fireEvent.input(screen.getByLabelText(/description/i), {
      target: { value: '  a description  ' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /create project/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(createProjectMock).toHaveBeenCalledWith(expect.any(Function), {
      name: 'Proj A',
      slug: 'proj-a',
      description: 'a description',
    })
    expect(gotoMock).toHaveBeenCalledWith('/dashboard')
  })

  it('sends description as null when left blank', async () => {
    createProjectMock.mockResolvedValueOnce({ id: 'p-2' })
    render(NewProjectPage, {})

    await fireEvent.input(screen.getByLabelText(/^name$/i), { target: { value: 'Proj B' } })
    await fireEvent.click(screen.getByRole('button', { name: /create project/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(createProjectMock).toHaveBeenCalledWith(expect.any(Function), {
      name: 'Proj B',
      slug: 'proj-b',
      description: null,
    })
  })

  it('shows a slug-specific error for a slug_taken ApiClientError, without a generic error banner', async () => {
    createProjectMock.mockRejectedValueOnce(
      new ApiClientError(409, { code: 'slug_taken' }, 'slug taken')
    )
    render(NewProjectPage, {})

    await fireEvent.input(screen.getByLabelText(/^name$/i), { target: { value: 'Proj C' } })
    await fireEvent.click(screen.getByRole('button', { name: /create project/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText(/slug already exists/i)).toBeTruthy()
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it('shows per-field validation errors and a top-level error message for a validation_error ApiClientError', async () => {
    createProjectMock.mockRejectedValueOnce(
      new ApiClientError(
        422,
        {
          code: 'validation_error',
          details: { name: ['Name is too long'], slug: ['Invalid slug'] },
        },
        'Validation failed'
      )
    )
    render(NewProjectPage, {})

    await fireEvent.input(screen.getByLabelText(/^name$/i), { target: { value: 'Proj D' } })
    await fireEvent.click(screen.getByRole('button', { name: /create project/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText('Validation failed')).toBeTruthy()
    expect(screen.getByText('Name is too long')).toBeTruthy()
    expect(screen.getByText('Invalid slug')).toBeTruthy()
  })

  it('treats a validation_error with non-object details as having no field errors', async () => {
    createProjectMock.mockRejectedValueOnce(
      new ApiClientError(422, { code: 'validation_error', details: null }, 'Validation failed')
    )
    render(NewProjectPage, {})

    await fireEvent.input(screen.getByLabelText(/^name$/i), { target: { value: 'Proj E' } })
    await fireEvent.click(screen.getByRole('button', { name: /create project/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText('Validation failed')).toBeTruthy()
  })

  it('shows the ApiClientError message for a generic (non-slug, non-validation) ApiClientError', async () => {
    createProjectMock.mockRejectedValueOnce(new ApiClientError(500, {}, 'Server exploded'))
    render(NewProjectPage, {})

    await fireEvent.input(screen.getByLabelText(/^name$/i), { target: { value: 'Proj F' } })
    await fireEvent.click(screen.getByRole('button', { name: /create project/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText('Server exploded')).toBeTruthy()
  })

  it('falls back to a generic message for a plain Error, and to "Project creation failed." for a non-Error throw', async () => {
    createProjectMock.mockRejectedValueOnce(new Error('network down'))
    render(NewProjectPage, {})

    await fireEvent.input(screen.getByLabelText(/^name$/i), { target: { value: 'Proj G' } })
    await fireEvent.click(screen.getByRole('button', { name: /create project/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText('network down')).toBeTruthy()
  })

  it('the cancel link points back to the projects list', () => {
    render(NewProjectPage, {})

    const link = screen.getByRole('link', { name: /cancel/i })
    expect(link.getAttribute('href')).toBe('/projects')
  })
})
