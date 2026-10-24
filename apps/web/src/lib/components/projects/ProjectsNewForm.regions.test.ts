import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.12: the new project form is one sub-region per field group. A probe contribution lands
// after its own group, and the form keeps ONE owner of every typed value and of the slug that
// follows the name.

const api = vi.hoisted(() => ({ createProject: vi.fn(), goto: vi.fn() }))
vi.mock('$app/state', () => ({ page: { route: { id: '/(app)/projects/new' }, params: {} } }))
vi.mock('$app/navigation', () => ({ goto: api.goto }))
vi.mock('$lib/api/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/api/projects.js')>()),
  createProject: api.createProject,
}))

const POINTS = [
  'project.new.name',
  'project.new.slug',
  'project.new.description',
  'project.new.error',
  'project.new.submit',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))

let Form: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Form = (await import('./ProjectsNewForm.svelte')).default as unknown as typeof Form
}, 60_000)
beforeEach(() => {
  api.createProject.mockReset()
  api.goto.mockReset()
})
afterEach(cleanup)

const mount = () => render(Form, { props: { data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const byId = (id: string) => document.getElementById(id) as HTMLInputElement
const type = (id: string, value: string) => fireEvent.input(byId(id), { target: { value } })

describe('ProjectsNewForm sub-regions (probe order)', () => {
  it('each field group is followed by its own probe, in form order', () => {
    mount()
    const order = [
      ['project-name-help', 'project.new.name'],
      ['project-slug-help', 'project.new.slug'],
      ['project-description-help', 'project.new.description'],
    ] as const
    for (const [help, point] of order) {
      expect(follows(byId(help), probe(point))).toBe(true)
    }
    const probes = POINTS.map((point) => probe(point))
    probes.forEach((p, i) => {
      if (i > 0) expect(follows(probes[i - 1] as HTMLElement, p)).toBe(true)
    })
    expect(follows(screen.getByText(/^Use 3-50 lowercase/), probe('project.new.slug'))).toBe(true)
  })

  it('the name probe is the last child of its group, after an error', async () => {
    api.createProject.mockRejectedValue(
      new ApiClientError(
        400,
        { code: 'validation_error', details: { name: ['bad name'] } } as never,
        'Invalid'
      )
    )
    mount()
    await type('project-name', 'x')
    await fireEvent.submit(document.querySelector('form') as HTMLFormElement)
    const message = await screen.findByText('bad name')
    expect(follows(message, probe('project.new.name'))).toBe(true)
    expect(probe('project.new.name').parentElement?.lastElementChild).toBe(
      probe('project.new.name')
    )
  })

  it('the slug probe follows the taken-slug alert and the error probe follows the banner', async () => {
    api.createProject.mockRejectedValueOnce(
      new ApiClientError(409, { code: 'slug_taken' } as never, 'taken')
    )
    mount()
    await type('project-name', 'x')
    await fireEvent.submit(document.querySelector('form') as HTMLFormElement)
    const alert = await screen.findByText('A project with this slug already exists - try another.')
    expect(follows(alert, probe('project.new.slug'))).toBe(true)
    api.createProject.mockRejectedValueOnce(new Error('boom'))
    await fireEvent.submit(document.querySelector('form') as HTMLFormElement)
    const banner = await screen.findByText('boom')
    expect(follows(banner, probe('project.new.error'))).toBe(true)
    expect(follows(probe('project.new.description'), probe('project.new.error'))).toBe(true)
    expect(
      follows(probe('project.new.error'), screen.getByRole('button', { name: 'Create project' }))
    ).toBe(true)
  })

  it('the submit probe follows the submit row', () => {
    mount()
    expect(follows(screen.getByRole('link', { name: 'Cancel' }), probe('project.new.submit'))).toBe(
      true
    )
  })
})

describe('ProjectsNewForm state (interaction)', () => {
  it('the name suggests a slug until the slug is edited by hand', async () => {
    mount()
    await type('project-name', 'My Project')
    expect(byId('project-slug').value).toBe('my-project')
    await type('project-slug', 'custom')
    await type('project-name', 'Another')
    expect(byId('project-slug').value).toBe('custom')
    expect(byId('project-name').value).toBe('Another')
  })

  it('submits the trimmed description with the typed name and slug, then goes to the dashboard', async () => {
    api.createProject.mockResolvedValue({})
    mount()
    await type('project-name', 'Proj')
    await type('project-description', ' about ')
    await fireEvent.submit(document.querySelector('form') as HTMLFormElement)
    await waitFor(() => expect(api.goto).toHaveBeenCalledWith('/dashboard'))
    expect(api.createProject).toHaveBeenCalledWith(fetch, {
      name: 'Proj',
      slug: 'proj',
      description: 'about',
    })
  })

  it('never hands a typed value to a point', async () => {
    mount()
    await type('project-name', 'secretname')
    for (const el of screen.getAllByTestId('probe')) {
      expect(el.getAttribute('data-keys')).not.toMatch(/name|slug|description/)
      expect(el.textContent).not.toContain('secretname')
    }
  })
})
