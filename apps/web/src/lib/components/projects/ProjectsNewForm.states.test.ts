// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.12: the new project form's client-driven states (slug suggestion, slug edit, the
// field-error and failure banners) cannot be reached by the route oracles. This pins them: the
// snapshot was recorded BEFORE the form was split into sub-regions and must come out unchanged.

const api = vi.hoisted(() => ({ createProject: vi.fn(), goto: vi.fn() }))
vi.mock('$app/state', () => ({ page: { route: { id: null }, params: {} } }))
vi.mock('$app/navigation', () => ({ goto: api.goto }))
vi.mock('$lib/api/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/api/projects.js')>()),
  createProject: api.createProject,
}))

let Form: Component<Record<string, unknown>>
beforeAll(async () => {
  Form = (await import('./ProjectsNewForm.svelte')).default as unknown as typeof Form
}, 60_000)
beforeEach(() => {
  api.createProject.mockReset()
  api.goto.mockReset()
})
afterEach(cleanup)

const asText = (states: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(states).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  )
const field = (id: string) => document.getElementById(id) as HTMLInputElement
const type = (id: string, value: string) => fireEvent.input(field(id), { target: { value } })
const submit = () => fireEvent.submit(field('project-name').closest('form') as HTMLFormElement)

describe('ProjectsNewForm client states (Story 69.12 pre-split pin)', () => {
  it('renders every interactive state exactly as before the split', async () => {
    const states: Record<string, unknown> = {}

    const initial = render(Form, { props: {} })
    states['initial'] = serializeWithoutNoise(initial.container)
    await type('project-name', 'My Project')
    states['name-typed-slug-suggested'] = serializeWithoutNoise(initial.container)
    states['name-typed-slug-value'] = field('project-slug').value
    await type('project-slug', 'custom-slug')
    await type('project-name', 'Other Name')
    states['slug-edited-sticks'] = field('project-slug').value
    states['slug-edited'] = serializeWithoutNoise(initial.container)
    cleanup()

    api.createProject.mockRejectedValueOnce(
      new ApiClientError(409, { code: 'slug_taken' } as never, 'taken')
    )
    const taken = render(Form, { props: {} })
    await type('project-name', 'Taken')
    await submit()
    await screen.findByText('A project with this slug already exists - try another.')
    states['slug-taken'] = serializeWithoutNoise(taken.container)
    await type('project-slug', 'free-slug')
    states['slug-taken-cleared-on-edit'] = serializeWithoutNoise(taken.container)
    cleanup()

    api.createProject.mockRejectedValueOnce(
      new ApiClientError(
        400,
        {
          code: 'validation_error',
          details: {
            name: ['name is bad'],
            slug: ['slug is bad'],
            description: ['description is bad'],
          },
        } as never,
        'Invalid input'
      )
    )
    const invalid = render(Form, { props: {} })
    await type('project-name', 'Bad')
    await submit()
    await screen.findByText('Invalid input')
    states['validation-error'] = serializeWithoutNoise(invalid.container)
    cleanup()

    api.createProject.mockRejectedValueOnce(
      new ApiClientError(
        400,
        { code: 'validation_error', details: 'not an object' } as never,
        'Invalid again'
      )
    )
    const invalidPlain = render(Form, { props: {} })
    await type('project-name', 'Bad')
    await submit()
    await screen.findByText('Invalid again')
    states['validation-error-no-details'] = serializeWithoutNoise(invalidPlain.container)
    cleanup()

    api.createProject.mockRejectedValueOnce(new Error('network'))
    const generic = render(Form, { props: {} })
    await type('project-name', 'Net')
    await submit()
    await screen.findByText('network')
    states['generic-error'] = serializeWithoutNoise(generic.container)
    cleanup()

    api.createProject.mockRejectedValueOnce('weird')
    const unknown = render(Form, { props: {} })
    await type('project-name', 'Weird')
    await submit()
    await screen.findByText('Project creation failed.')
    states['unknown-error'] = serializeWithoutNoise(unknown.container)
    cleanup()

    api.createProject.mockReset()
    let release: (value?: unknown) => void = () => undefined
    api.createProject.mockReturnValueOnce(new Promise((resolveCreate) => (release = resolveCreate)))
    const pending = render(Form, { props: {} })
    await type('project-name', '  Spaced  ')
    await fireEvent.input(field('project-description'), { target: { value: ' about ' } })
    await submit()
    await submit()
    states['submitting'] = serializeWithoutNoise(pending.container)
    states['submitting-calls'] = api.createProject.mock.calls.length
    release()
    await waitFor(() => expect(api.goto).toHaveBeenCalled())
    states['ok-args'] = api.createProject.mock.calls.map((call) => call.slice(1))
    states['ok-goto'] = api.goto.mock.calls

    await expect(`${JSON.stringify(asText(states), null, 2)}\n`).toMatchFileSnapshot(
      './ProjectsNewForm.states.snapshot.json'
    )
  }, 60_000)
})
