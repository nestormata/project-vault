import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const updateProject = vi.fn()
const deleteProject = vi.fn()
const restoreProject = vi.fn()
const invalidateAll = vi.fn()
const goto = vi.fn()
const requestConfirm = vi.fn()

vi.mock('$lib/api/projects.js', () => ({
  updateProject: (...args: unknown[]) => updateProject(...args),
  deleteProject: (...args: unknown[]) => deleteProject(...args),
  restoreProject: (...args: unknown[]) => restoreProject(...args),
}))
vi.mock('$app/navigation', () => ({
  invalidateAll: () => invalidateAll(),
  goto: (...args: unknown[]) => goto(...args),
}))
vi.mock('$lib/state/confirm.svelte.js', () => ({
  requestConfirm: (...args: unknown[]) => requestConfirm(...args),
}))

import ProjectSettingsForm from './ProjectSettingsForm.svelte'
import ProjectDeleteZone from './ProjectDeleteZone.svelte'
import DeletedProjectsList from './DeletedProjectsList.svelte'
import { idProblems } from '$lib/test/dom.js'

const project = {
  id: 'p1',
  name: 'Payments',
  description: 'Billing',
  urls: ['https://wiki.example'],
}

beforeEach(() => {
  for (const fn of [
    updateProject,
    deleteProject,
    restoreProject,
    invalidateAll,
    goto,
    requestConfirm,
  ]) {
    fn.mockReset()
  }
})
afterEach(() => cleanup())

describe('ProjectSettingsForm', () => {
  it('prefills the values, has valid ids and saves trimmed values and one URL per line', async () => {
    updateProject.mockResolvedValue({})
    const { container } = render(ProjectSettingsForm, { props: { project } })
    expect(idProblems(container)).toEqual([])
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Payments')
    expect((screen.getByLabelText('Links') as HTMLTextAreaElement).value).toBe(
      'https://wiki.example'
    )

    await fireEvent.input(screen.getByLabelText('Links'), {
      target: { value: 'https://a.example\n\n http://b.example ' },
    })
    await fireEvent.input(screen.getByLabelText('Description'), { target: { value: '   ' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1))
    expect(updateProject).toHaveBeenCalledWith(expect.anything(), 'p1', {
      name: 'Payments',
      description: null,
      urls: ['https://a.example', 'http://b.example'],
    })
    await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy())
    expect(invalidateAll).toHaveBeenCalled()
  })

  it('shows the field error the API reports and keeps the form usable', async () => {
    updateProject.mockRejectedValue(
      new ApiClientError(
        422,
        {
          code: 'validation_error',
          details: { urls: ['Must be an absolute http or https URL'] },
        } as never,
        'invalid'
      )
    )
    render(ProjectSettingsForm, { props: { project } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.getByText('Check the highlighted fields.')).toBeTruthy())
    expect(screen.getByText('Must be an absolute http or https URL')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(
      false
    )
  })

  it('prefills an empty description as an empty box', () => {
    render(ProjectSettingsForm, { props: { project: { ...project, description: null, urls: [] } } })
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('')
  })
})

describe('ProjectDeleteZone', () => {
  it('asks for the typed name, deletes, and goes to the deleted list', async () => {
    requestConfirm.mockResolvedValue(true)
    deleteProject.mockResolvedValue({})
    render(ProjectDeleteZone, { props: { project, graceDays: 30 } })
    expect(screen.getByText(/restore it for 30 days/)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    await waitFor(() => expect(goto).toHaveBeenCalled())
    expect(requestConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ typedValue: 'Payments', variant: 'danger' })
    )
    expect(deleteProject).toHaveBeenCalledWith(expect.anything(), 'p1')
  })

  it('does nothing when the confirmation is declined', async () => {
    requestConfirm.mockResolvedValue(false)
    render(ProjectDeleteZone, { props: { project, graceDays: 30 } })
    await fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    await waitFor(() => expect(requestConfirm).toHaveBeenCalled())
    expect(deleteProject).not.toHaveBeenCalled()
  })

  it('shows the blocker when the API refuses', async () => {
    requestConfirm.mockResolvedValue(true)
    deleteProject.mockRejectedValue(
      new ApiClientError(409, { error: 'active_machine_user_keys' } as never, 'blocked')
    )
    render(ProjectDeleteZone, { props: { project, graceDays: 30 } })
    await fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Revoke the keys/))
    expect(goto).not.toHaveBeenCalled()
  })
})

describe('DeletedProjectsList', () => {
  const deleted = [
    {
      id: 'p1',
      name: 'Payments',
      slug: 'payments',
      deletedAt: '2026-01-01T00:00:00.000Z',
      purgeAfter: '2026-01-31T00:00:00.000Z',
    },
  ]

  it('says so when there is nothing to restore', () => {
    render(DeletedProjectsList, { props: { projects: [] } })
    expect(screen.getByText('There are no deleted projects to restore.')).toBeTruthy()
  })

  it('restores a project and reports it comes back archived', async () => {
    restoreProject.mockResolvedValue({})
    render(DeletedProjectsList, { props: { projects: deleted } })
    await fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/restored and archived/)
    )
    expect(restoreProject).toHaveBeenCalledWith(expect.anything(), 'p1')
    expect(invalidateAll).toHaveBeenCalled()
  })

  it('reports a refused restore', async () => {
    restoreProject.mockRejectedValue(new ApiClientError(403, null, 'no'))
    render(DeletedProjectsList, { props: { projects: deleted } })
    await fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(
        /project owner or an organization owner/
      )
    )
  })

  it('reports an unexpected restore failure generically', async () => {
    restoreProject.mockRejectedValue(new Error('network'))
    render(DeletedProjectsList, { props: { projects: deleted } })
    await fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('The project could not be restored.')
    )
  })
})
