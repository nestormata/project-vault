import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Story 69.11: the projects list is one results sub-region. A probe contribution lands AFTER the
// PV results (the cards, or the empty notice), and the cards share ONE owner of the busy/tag state.

const api = vi.hoisted(() => ({
  archiveProject: vi.fn(),
  unarchiveProject: vi.fn(),
  updateProjectTags: vi.fn(),
  invalidateAll: vi.fn(),
}))
vi.mock('$app/state', () => ({ page: { route: { id: '/(app)/projects' }, params: {} } }))
vi.mock('$app/navigation', () => ({ invalidateAll: api.invalidateAll }))
vi.mock('$lib/api/projects.js', () => ({
  archiveProject: api.archiveProject,
  unarchiveProject: api.unarchiveProject,
  updateProjectTags: api.updateProjectTags,
}))

const POINT = 'project.home.results'
const fills = { [POINT]: [{ marker: `fill:${POINT}` }] }
const project = (overrides: Record<string, unknown>) => ({
  id: 'p1',
  name: 'Alpha',
  slug: 'alpha',
  description: null,
  role: 'owner',
  isArchived: false,
  tags: ['api'],
  credentialCount: 1,
  expiringCount: 0,
  alertCount: 0,
  ...overrides,
})
const ITEMS = [project({}), project({ id: 'p2', name: 'Beta', slug: 'beta', role: 'viewer' })]

let List: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  vi.doMock(`virtual:pv-inject/${POINT}`, () => ({
    default: [{ id: `${POINT}#0`, order: 0, component: probe }],
  }))
  List = (await import('./ProjectsListContent.svelte')).default as unknown as typeof List
}, 60_000)
beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  for (const fn of Object.values(api)) fn.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const mount = (overrides: Record<string, unknown> = {}) =>
  render(List, { props: { projects: ITEMS, errorMessage: null, data: fills, ...overrides } })
const probe = (): HTMLElement => screen.getByTestId('probe')
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('ProjectsListContent results sub-region (probe order)', () => {
  it('results: after the last project card', () => {
    mount()
    const cards = screen.getAllByRole('listitem').filter((li) => li.querySelector('h2'))
    expect(cards).toHaveLength(2)
    expect(follows(cards[1] as HTMLElement, probe())).toBe(true)
  })

  it('results: after the empty notice when there are no projects', () => {
    mount({ projects: [] })
    expect(follows(screen.getByText('No projects yet'), probe())).toBe(true)
    expect(screen.queryByRole('list')).toBeNull()
  })
})

describe('ProjectsListContent shared card state (interaction)', () => {
  it('archives after confirm, and keeps every button off while that project is busy', async () => {
    let finish: () => void = () => undefined
    api.archiveProject.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Archive project' }))
    expect(api.archiveProject).toHaveBeenCalledWith(fetch, 'p1')
    expect(
      (screen.getByRole('button', { name: 'Archive project' }) as HTMLButtonElement).disabled
    ).toBe(true)
    finish()
    await waitFor(() => expect(api.invalidateAll).toHaveBeenCalled())
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Archive project' }) as HTMLButtonElement).disabled
      ).toBe(false)
    )
  })

  it('does not archive when the confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Archive project' }))
    expect(api.archiveProject).not.toHaveBeenCalled()
  })

  it('unarchives an archived project the caller owns', async () => {
    api.unarchiveProject.mockResolvedValue(undefined)
    mount({ projects: [project({ isArchived: true })] })
    expect(screen.queryByRole('button', { name: 'Archive project' })).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }))
    expect(api.unarchiveProject).toHaveBeenCalledWith(fetch, 'p1')
  })

  it('saves edited tags as a parsed list and shows a failure under that card only', async () => {
    api.updateProjectTags.mockRejectedValue(new Error('boom'))
    mount({ projects: [ITEMS[0], project({ id: 'p3', name: 'Gamma', role: 'member' })] })
    const input = document.getElementById('project-tags-p1') as HTMLInputElement
    expect(input.value).toBe('api')
    await fireEvent.input(input, { target: { value: ' prod , api ,, ' } })
    await fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement)
    expect(api.updateProjectTags).toHaveBeenCalledWith(fetch, 'p1', ['prod', 'api'])
    expect(await screen.findAllByRole('alert')).toHaveLength(1)
    expect(screen.getByText('Failed to save tags.').getAttribute('role')).toBe('alert')
    expect((document.getElementById('project-tags-p3') as HTMLInputElement).value).toBe('api')
  })

  it('offers no tag editor to a viewer or on an archived project', () => {
    mount({ projects: [project({ role: 'viewer' }), project({ id: 'p9', isArchived: true })] })
    expect(document.getElementById('project-tags-p1')).toBeNull()
    expect(document.getElementById('project-tags-p9')).toBeNull()
  })
})
