import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { credentialPointExtras } from '$lib/credentials/credential-detail-helpers.js'
import { sampleCredential, sampleDependency, sampleProject } from '$lib/test/fixtures.js'

// Story 69-14: the Dependent systems section's sub-regions. A probe contribution lands BETWEEN the
// two PV sections it was meant to sit between, and the section keeps ONE owner of the list, the busy
// flags, the add form and the poll across its sub-regions.

const addMock = vi.hoisted(() => vi.fn())
const archiveMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())
const confirmMock = vi.hoisted(() => vi.fn())
vi.mock('$app/state', () => ({
  page: {
    route: { id: '/(app)/projects/[projectId]/credentials/[credentialId]' },
    params: {},
  },
}))
vi.mock('$lib/api/credentials.js', () => ({
  addCredentialDependency: addMock,
  archiveCredentialDependency: archiveMock,
  listCredentialDependencies: listMock,
}))
vi.mock('$lib/api/rotations.js', () => ({ confirmChecklistItem: confirmMock }))

const POINTS = [
  'credential.detail.dependencies',
  'credential.detail.dependencies-list',
  'credential.detail.dependencies-add',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const otherCredentialId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const CREDENTIAL = sampleCredential({ id: credentialId, projectId })
const MULTI = sampleCredential({
  id: credentialId,
  projectId,
  fields: [
    { key: 'host', sensitive: false },
    { key: 'password', sensitive: true },
  ],
})
const pending = {
  rotationId: 'rot-9',
  itemId: 'i1',
  status: 'pending',
  confirmedBy: null,
  confirmedAt: null,
}
const EMPTY = { items: [], hasDependencies: false, hasStagedRotation: false }
const POPULATED = {
  items: [
    sampleDependency({ id: 'dep-a', systemName: 'billing-worker' }),
    sampleDependency({
      id: 'dep-b',
      systemName: 'tracked-system',
      checklistStatus: pending as never,
    }),
  ],
  hasDependencies: true,
  hasStagedRotation: true,
}

let Section: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Section = (await import('./CredentialDependencies.svelte')).default as unknown as typeof Section
}, 60_000)
beforeEach(() => {
  for (const mock of [addMock, archiveMock, listMock, confirmMock]) mock.mockReset()
  listMock.mockResolvedValue(EMPTY)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function propsFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    credential: CREDENTIAL,
    projectId,
    credentialId,
    orgRole: 'member' as const,
    project: sampleProject({ id: projectId, role: 'member' }),
    dependencies: EMPTY,
  }
  const merged = { ...base, ...overrides } as typeof base
  return { ...merged, pointProps: credentialPointExtras(merged), data: fills }
}
const mount = (overrides: Record<string, unknown> = {}) =>
  render(Section, { props: propsFor(overrides) })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const probeCount = (point: string): number =>
  screen.queryAllByTestId('probe').filter((el) => el.textContent?.includes(`"fill:${point}"`))
    .length
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const button = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name })
const openForm = async (): Promise<void> => {
  await fireEvent.click(screen.getByText('Add dependent system', { selector: 'summary' }))
}
const typeName = (value: string) =>
  fireEvent.input(screen.getByLabelText('System name'), { target: { value } })

describe('CredentialDependencies sub-regions (probe order)', () => {
  it('empty list: the list point follows the empty notice, the add point sits inside the form', () => {
    mount()
    const list = probe('credential.detail.dependencies-list')
    expect(follows(screen.getByText('No dependent systems recorded.'), list)).toBe(true)
    expect(follows(list, screen.getByText('Add dependent system', { selector: 'summary' }))).toBe(
      true
    )
    const add = probe('credential.detail.dependencies-add')
    expect(follows(button('Add dependent system'), add)).toBe(true)
    expect(add.closest('form')).not.toBeNull()
    expect(follows(add, probe('credential.detail.dependencies'))).toBe(true)
  })

  it('populated list: the list point follows the last row', () => {
    mount({ dependencies: POPULATED })
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(follows(rows[1] as HTMLElement, probe('credential.detail.dependencies-list'))).toBe(true)
  })

  it('a project viewer gets the list and the section points but no add region', () => {
    mount({
      dependencies: POPULATED,
      orgRole: 'viewer',
      project: sampleProject({ id: projectId, role: 'viewer' }),
    })
    expect(probeCount('credential.detail.dependencies-list')).toBe(1)
    expect(probeCount('credential.detail.dependencies-add')).toBe(0)
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
    expect(probeCount('credential.detail.dependencies')).toBe(1)
  })
})

describe('CredentialDependencies effective project role (DW-606)', () => {
  it('an org admin holding a project viewer row keeps the add region, as the API allows', () => {
    mount({
      dependencies: POPULATED,
      orgRole: 'admin',
      project: sampleProject({ id: projectId, role: 'viewer' }),
    })
    expect(probeCount('credential.detail.dependencies-add')).toBe(1)
  })

  it('an org member holding a project viewer row gets no add region', () => {
    mount({
      dependencies: POPULATED,
      orgRole: 'member',
      project: sampleProject({ id: projectId, role: 'viewer' }),
    })
    expect(probeCount('credential.detail.dependencies-add')).toBe(0)
  })
})

describe('CredentialDependencies state (one owner across sub-regions)', () => {
  it('adds a dependency to the list, resets the form, and keeps the form open', async () => {
    addMock.mockResolvedValue(sampleDependency({ id: 'dep-new', systemName: 'new-system' }))
    mount()
    await openForm()
    await typeName('new-system')
    await fireEvent.input(screen.getByLabelText('Notes'), { target: { value: 'some notes' } })
    await fireEvent.click(button('Add dependent system'))
    await screen.findByText('new-system (service)')
    expect(screen.queryByText('No dependent systems recorded.')).toBeNull()
    expect((screen.getByLabelText('System name') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('')
    expect(
      follows(
        screen.getByText('new-system (service)'),
        probe('credential.detail.dependencies-list')
      )
    ).toBe(true)
    expect(addMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      credentialId,
      expect.objectContaining({ systemName: 'new-system', notes: 'some notes' })
    )
  })

  it('shows the required-name error on the field and keeps the typed notes', async () => {
    mount()
    await openForm()
    await fireEvent.input(screen.getByLabelText('Notes'), { target: { value: 'kept' } })
    await typeName('   ')
    await fireEvent.submit(screen.getByLabelText('System name').closest('form') as HTMLFormElement)
    const input = screen.getByLabelText('System name')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toContain('dependency-system-name-error')
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('kept')
    expect(addMock).not.toHaveBeenCalled()
  })

  it('shows a server rejection and an archived-project banner in the form, before its point', async () => {
    addMock.mockRejectedValueOnce(new ApiClientError(422, { code: 'invalid_link_url' }, 'bad link'))
    mount()
    await openForm()
    await typeName('x')
    await fireEvent.click(button('Add dependent system'))
    const error = await screen.findByText('bad link')
    expect(follows(error, probe('credential.detail.dependencies-add'))).toBe(true)
    addMock.mockRejectedValueOnce(new ApiClientError(410, { code: 'project_archived' }, 'gone'))
    await fireEvent.click(button('Add dependent system'))
    await screen.findByText(/This project is archived/)
  })

  it('offers the scope selector only for a multi-field secret', async () => {
    mount({ credential: MULTI })
    await openForm()
    expect(screen.getByLabelText('Scope to field')).toBeTruthy()
    cleanup()
    mount()
    await openForm()
    expect(screen.queryByLabelText('Scope to field')).toBeNull()
  })

  it('archives a row out of the list, and shows a failure without dropping the row', async () => {
    archiveMock.mockResolvedValueOnce(undefined)
    mount({ dependencies: POPULATED })
    await fireEvent.click(screen.getAllByRole('button', { name: 'Archive' })[0] as HTMLElement)
    await waitFor(() => expect(screen.queryByText(/billing-worker/)).toBeNull())
    archiveMock.mockRejectedValueOnce(new Error('archive boom'))
    await fireEvent.click(button('Archive'))
    await openForm()
    await screen.findByText('archive boom')
    expect(screen.getByText(/tracked-system/)).toBeTruthy()
  })

  it('confirms a checklist item in place, and reconciles an already_confirmed answer', async () => {
    confirmMock.mockResolvedValueOnce({
      item: { status: 'confirmed', confirmedBy: 'user-2', confirmedAt: '2026-07-15T12:00:00.000Z' },
    })
    mount({ dependencies: POPULATED })
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(false)
    await fireEvent.click(box)
    await waitFor(() => expect(box.disabled).toBe(true))
    expect(box.checked).toBe(true)
    cleanup()

    confirmMock.mockRejectedValueOnce(
      new ApiClientError(409, { code: 'already_confirmed' } as never, 'x')
    )
    mount({ dependencies: POPULATED })
    const second = screen.getByRole('checkbox') as HTMLInputElement
    await fireEvent.click(second)
    await waitFor(() => expect(second.disabled).toBe(true))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('replaces the list and the form when the section is reused for another credential', async () => {
    const view = mount({ dependencies: POPULATED })
    await openForm()
    await typeName('half-typed')
    await view.rerender(propsFor({ credentialId: otherCredentialId, dependencies: EMPTY }))
    expect(screen.getByText('No dependent systems recorded.')).toBeTruthy()
    expect((screen.getByLabelText('System name') as HTMLInputElement).value).toBe('')
  })

  it('polls while rows exist, pauses while hidden, and stops with the section', async () => {
    vi.useFakeTimers()
    listMock.mockResolvedValue({ ...POPULATED, hasStagedRotation: false })
    mount({ dependencies: POPULATED })
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('checkbox')).toBeNull()

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(45_000)
    expect(listMock).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(listMock).toHaveBeenCalledTimes(2)

    cleanup()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listMock).toHaveBeenCalledTimes(2)
    visibility.mockRestore()
  })

  it('does not start a poll for an empty list', async () => {
    vi.useFakeTimers()
    mount()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listMock).not.toHaveBeenCalled()
  })
})
