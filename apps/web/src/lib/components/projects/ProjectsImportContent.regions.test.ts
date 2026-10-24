import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.11: the project import page body is the form (error, file, export key, name, submit) or
// the success panel, each a sub-region. A probe lands after its own section, receives only the
// standard props (never the typed key or the picked file), and the flow keeps ONE owner of the state.

const api = vi.hoisted(() => ({ importProject: vi.fn(), goto: vi.fn() }))
vi.mock('$app/state', () => ({ page: { route: { id: '/(app)/projects/import' }, params: {} } }))
vi.mock('$app/navigation', () => ({ goto: api.goto }))
vi.mock('$lib/api/project-export.js', () => ({ importProject: api.importProject }))

const POINTS = [
  'project.import.error',
  'project.import.file',
  'project.import.export-key',
  'project.import.name',
  'project.import.submit',
  'project.import.done',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const KEY = 'typed-export-key-1234'

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Content = (await import('./ProjectsImportContent.svelte')).default as unknown as typeof Content
}, 60_000)
beforeEach(() => {
  api.importProject.mockReset()
  api.goto.mockReset()
})
afterEach(cleanup)

const mount = () => render(Content, { props: { data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const probeCount = () => screen.queryAllByTestId('probe').length
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const byId = (id: string) => document.getElementById(id) as HTMLInputElement
const pick = (name: string) =>
  fireEvent.change(byId('pvexport-file'), {
    target: { files: [new File(['payload'], name, { type: 'application/octet-stream' })] },
  })
const submitForm = () => fireEvent.submit(byId('export-key').closest('form') as HTMLFormElement)

describe('ProjectsImportContent sub-regions (probe order)', () => {
  it('the form renders error, file, export key, name and submit probes in order', () => {
    mount()
    const order = [
      probe('project.import.error'),
      probe('project.import.file'),
      probe('project.import.export-key'),
      probe('project.import.name'),
      probe('project.import.submit'),
    ]
    order.forEach((node, i) => {
      if (i > 0) expect(follows(order[i - 1] as HTMLElement, node)).toBe(true)
    })
    expect(follows(byId('pvexport-file-help'), order[1] as Node)).toBe(true)
    expect(follows(byId('export-key-help'), order[2] as Node)).toBe(true)
    expect(follows(byId('project-name-help'), order[3] as Node)).toBe(true)
    expect(follows(screen.getByRole('link', { name: /projects/i }), order[4] as Node)).toBe(true)
    expect((order[4] as HTMLElement).previousElementSibling).toBe(
      screen.getByRole('button', { name: 'Import project' }).parentElement
    )
    expect(probeCount()).toBe(5)
  })

  it('the success panel replaces the form and renders only the done probe', async () => {
    api.importProject.mockResolvedValue({
      projectId: 'new-1',
      name: 'Payments API',
      importedCounts: { credentials: 2 },
    })
    mount()
    await pick('p.pvexport')
    await fireEvent.input(byId('export-key'), { target: { value: KEY } })
    await submitForm()
    const view = await screen.findByRole('button', { name: 'View project' })
    expect(probeCount()).toBe(1)
    expect(
      follows(screen.getByRole('link', { name: /projects/i }), probe('project.import.done'))
    ).toBe(true)
    expect(probe('project.import.done').previousElementSibling).toBe(view.parentElement)
    await fireEvent.click(view)
    expect(api.goto).toHaveBeenCalledWith('/projects/new-1')
  })
})

describe('ProjectsImportContent form state (interaction)', () => {
  it('keeps submit disabled until a file and a key are set, and warns about a wrong file type', async () => {
    mount()
    const submit = screen.getByRole('button', { name: 'Import project' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await pick('notes.txt')
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(follows(screen.getByRole('alert'), probe('project.import.file'))).toBe(true)
    await pick('p.pvexport')
    expect(screen.queryByRole('alert')).toBeNull()
    await fireEvent.input(byId('export-key'), { target: { value: KEY } })
    expect(submit.disabled).toBe(false)
  })

  it('toggles the export key between hidden and visible', async () => {
    mount()
    expect(byId('export-key').type).toBe('password')
    await fireEvent.click(screen.getByRole('button', { name: /show/i }))
    expect(byId('export-key').type).toBe('text')
    expect(screen.getByRole('button', { name: /hide/i }).getAttribute('aria-pressed')).toBe('true')
  })

  it('imports with the trimmed key and the optional name, then drops the key', async () => {
    api.importProject.mockResolvedValue({ projectId: 'n', name: 'X', importedCounts: {} })
    mount()
    await pick('p.pvexport')
    await fireEvent.input(byId('export-key'), { target: { value: `  ${KEY}  ` } })
    await fireEvent.input(byId('project-name'), { target: { value: ' Renamed ' } })
    await submitForm()
    await waitFor(() => expect(api.importProject).toHaveBeenCalled())
    expect(api.importProject.mock.calls[0]?.slice(2)).toEqual([KEY, 'Renamed'])
  })

  it('shows a decrypt failure above the form and keeps what was typed', async () => {
    api.importProject.mockRejectedValue(
      new ApiClientError(422, { code: 'import_decrypt_failed' }, 'x')
    )
    mount()
    await pick('p.pvexport')
    await fireEvent.input(byId('export-key'), { target: { value: KEY } })
    await submitForm()
    const message = await screen.findByText(/could not be decrypted/)
    expect(follows(message, probe('project.import.error'))).toBe(true)
    expect(byId('export-key').value).toBe(KEY)
  })

  it('never hands the key or the picked file to a point', async () => {
    mount()
    await pick('secret-name.pvexport')
    await fireEvent.input(byId('export-key'), { target: { value: KEY } })
    for (const el of screen.getAllByTestId('probe')) {
      expect(el.textContent).not.toContain(KEY)
      expect(el.textContent).not.toContain('secret-name')
      expect(el.getAttribute('data-keys')).not.toMatch(/key|file|flow/i)
    }
  })
})
