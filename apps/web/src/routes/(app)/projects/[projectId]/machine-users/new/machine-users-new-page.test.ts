import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const gotoMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const createMachineUserMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

vi.mock('$app/paths', () => ({
  resolve: (path: string) => path,
}))

vi.mock('$lib/api/machine-users.js', () => ({
  createMachineUser: createMachineUserMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import NewMachineUserPage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  gotoMock.mockClear()
  createMachineUserMock.mockReset()
})

const projectId = 'proj-1'

function baseData(overrides: Record<string, unknown> = {}) {
  return { projectId, orgRole: 'admin', ...overrides }
}

describe('machine-users/new +page.svelte', () => {
  it('renders an access notice and no form for a non-managing role', () => {
    render(NewMachineUserPage, { props: { data: baseData({ orgRole: 'viewer' }) } })

    expect(screen.getByText(/create not available/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /back to machine users/i })
    expect(link.getAttribute('href')).toBe(`/projects/${projectId}/machine-users`)
    expect(screen.queryByLabelText(/^name$/i)).toBeNull()
  })

  it('renders the create form for an admin', () => {
    render(NewMachineUserPage, { props: { data: baseData() } })

    expect(screen.getByLabelText(/^name$/i)).toBeTruthy()
    expect(screen.getByLabelText(/role/i)).toBeTruthy()
    expect(screen.getByLabelText(/description/i)).toBeTruthy()
  })

  it('blocks submission with a blank name and shows a validation error, without calling the API', async () => {
    render(NewMachineUserPage, { props: { data: baseData() } })

    const form = screen
      .getByRole('button', { name: /create machine user/i })
      .closest('form') as HTMLFormElement
    await fireEvent.submit(form)

    expect(screen.getByText(/name is required/i)).toBeTruthy()
    expect(createMachineUserMock).not.toHaveBeenCalled()
  })

  it('submits the trimmed name/role/description and navigates to the new detail page on success', async () => {
    createMachineUserMock.mockResolvedValueOnce({ id: 'mu-99' })
    render(NewMachineUserPage, { props: { data: baseData() } })

    await fireEvent.input(screen.getByLabelText(/^name$/i), { target: { value: '  ci-bot  ' } })
    await fireEvent.change(screen.getByLabelText(/role/i), { target: { value: 'viewer' } })
    await fireEvent.input(screen.getByLabelText(/description/i), {
      target: { value: '  runs jobs  ' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /create machine user/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(createMachineUserMock).toHaveBeenCalledWith(expect.any(Function), projectId, {
      name: 'ci-bot',
      role: 'viewer',
      description: 'runs jobs',
    })
    expect(gotoMock).toHaveBeenCalledWith(`/projects/${projectId}/machine-users/mu-99`)
  })

  it('sends description as null when left blank/whitespace', async () => {
    createMachineUserMock.mockResolvedValueOnce({ id: 'mu-100' })
    render(NewMachineUserPage, { props: { data: baseData() } })

    await fireEvent.input(screen.getByLabelText(/^name$/i), { target: { value: 'ci-bot' } })
    await fireEvent.click(screen.getByRole('button', { name: /create machine user/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(createMachineUserMock).toHaveBeenCalledWith(expect.any(Function), projectId, {
      name: 'ci-bot',
      role: 'member',
      description: null,
    })
  })

  it('surfaces an ApiClientError message on failure and does not navigate', async () => {
    createMachineUserMock.mockRejectedValueOnce(
      new ApiClientError(400, null, 'Name already in use')
    )
    render(NewMachineUserPage, { props: { data: baseData() } })

    await fireEvent.input(screen.getByLabelText(/^name$/i), { target: { value: 'dup' } })
    await fireEvent.click(screen.getByRole('button', { name: /create machine user/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText('Name already in use')).toBeTruthy()
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it('falls back to a generic error message for a non-ApiClientError failure', async () => {
    createMachineUserMock.mockRejectedValueOnce(new Error('boom'))
    render(NewMachineUserPage, { props: { data: baseData() } })

    await fireEvent.input(screen.getByLabelText(/^name$/i), { target: { value: 'x' } })
    await fireEvent.click(screen.getByRole('button', { name: /create machine user/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText(/failed to create machine user/i)).toBeTruthy()
  })

  it('the cancel link points back to the machine-users list', () => {
    render(NewMachineUserPage, { props: { data: baseData() } })

    const cancel = screen.getByRole('link', { name: /cancel/i })
    expect(cancel.getAttribute('href')).toBe(`/projects/${projectId}/machine-users`)
  })
})
