import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { sampleProject } from '$lib/test/fixtures.js'

// The component's own source, loaded as raw text at transform time (the lint-clean loading pattern).
const ERROR_REGION_SOURCE: string = Object.values(
  import.meta.glob('./ProjectExportErro[r].svelte', {
    query: '?raw',
    import: 'default',
    eager: true,
  })
).join('')

// Story 69.12: the export section is one sub-region per concern (description, failure message, the
// export with its one-time reveal). A probe contribution lands after its own section, every point
// receives `{ project }` ONLY, and the export key text exists in the key sub-region alone (Story
// 62-2 D3: never a prop, context, snippet argument or point input).

const api = vi.hoisted(() => ({ exportProject: vi.fn(), downloadExportBlob: vi.fn() }))
vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/projects/[projectId]' }, params: { projectId: 'p1' } },
}))
vi.mock('$lib/api/project-export.js', () => api)

const POINTS = [
  'project.detail.export-intro',
  'project.detail.export-error',
  'project.detail.export-key',
  'project.detail.export',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const KEY = 'REGION-TEST-VALUE-77'
const project = sampleProject({ id: 'p1', name: 'Payments API' })
const exported = { blob: new Blob(['x']), filename: 'p.pvexport', exportKey: KEY }

let Panel: Component<Record<string, unknown>>
let ProjectExportError: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Panel = (await import('./ProjectExportPanel.svelte')).default as unknown as typeof Panel
  ProjectExportError = (await import('./ProjectExportError.svelte'))
    .default as unknown as typeof ProjectExportError
}, 60_000)
beforeEach(() => {
  api.exportProject.mockReset()
  api.downloadExportBlob.mockReset()
})
afterEach(cleanup)

const mount = () => render(Panel, { props: { project, data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const exportButton = () => screen.getByRole('button', { name: 'Export project' })
const reveal = async () => {
  api.exportProject.mockResolvedValueOnce(exported)
  const view = mount()
  await fireEvent.click(exportButton())
  await screen.findByText(KEY)
  return view
}

describe('ProjectExportPanel sub-regions (probe order)', () => {
  it('idle: description, failure message and export probes follow their own sections, in order', () => {
    mount()
    const intro = probe('project.detail.export-intro')
    const error = probe('project.detail.export-error')
    const key = probe('project.detail.export-key')
    const end = probe('project.detail.export')
    expect(follows(screen.getByText(/shown to you exactly once/), intro)).toBe(true)
    expect(follows(intro, error)).toBe(true)
    expect(follows(error, exportButton())).toBe(true)
    expect(follows(exportButton(), key)).toBe(true)
    expect(follows(key, end)).toBe(true)
    expect(end.parentElement?.lastElementChild).toBe(end)
    expect(screen.getAllByTestId('probe')).toHaveLength(4)
  })

  it('a failed export puts the message before the error probe and keeps the other probes in place', async () => {
    api.exportProject.mockRejectedValueOnce(new ApiClientError(403, null, 'No access'))
    mount()
    await fireEvent.click(exportButton())
    const message = await screen.findByText('No access')
    expect(follows(probe('project.detail.export-intro'), message)).toBe(true)
    expect(follows(message, probe('project.detail.export-error'))).toBe(true)
    expect(follows(probe('project.detail.export-error'), exportButton())).toBe(true)
  })

  it('revealed: the description goes, its probe stays, and the key probe follows the Done button', async () => {
    await reveal()
    expect(screen.queryByText(/shown to you exactly once/)).toBeNull()
    expect(
      follows(
        screen.getByRole('heading', { name: 'Export project' }),
        probe('project.detail.export-intro')
      )
    ).toBe(true)
    expect(
      follows(screen.getByRole('button', { name: 'Done' }), probe('project.detail.export-key'))
    ).toBe(true)
    expect(screen.getAllByTestId('probe')).toHaveLength(4)
  })
})

describe('ProjectExportPanel state (interaction)', () => {
  it('the reveal state survives in the key region while the description follows it back', async () => {
    await reveal()
    expect(api.exportProject).toHaveBeenCalledWith(fetch, 'p1')
    expect(api.downloadExportBlob).toHaveBeenCalledWith(exported.blob, 'p.pvexport')
    await fireEvent.click(screen.getByRole('checkbox'))
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByText(KEY)).toBeNull()
    expect(screen.getByText(/shown to you exactly once/)).toBeTruthy()
    expect(exportButton()).toBeTruthy()
  })

  it('an empty key from the server keeps the description and the Export button, as before the split', async () => {
    api.exportProject.mockResolvedValueOnce({ ...exported, exportKey: '' })
    mount()
    await fireEvent.click(exportButton())
    await waitFor(() => expect(api.downloadExportBlob).toHaveBeenCalled())
    expect(screen.getByText(/Download an encrypted, portable snapshot/)).toBeTruthy()
    expect(exportButton()).toBeTruthy()
  })

  it('a later successful export clears the earlier failure message', async () => {
    api.exportProject.mockRejectedValueOnce(new Error('first failure'))
    mount()
    await fireEvent.click(exportButton())
    await screen.findByText('first failure')
    api.exportProject.mockResolvedValueOnce(exported)
    await fireEvent.click(exportButton())
    await waitFor(() => expect(screen.getByText(KEY)).toBeTruthy())
    expect(screen.queryByText('first failure')).toBeNull()
  })
})

describe('ProjectExportPanel export key confinement (Story 62-2 D3)', () => {
  it('the key text appears only inside the key sub-region, never in a point', async () => {
    await reveal()
    const holders = Array.from(document.querySelectorAll('*')).filter(
      (el) => el.children.length === 0 && el.textContent?.includes(KEY)
    )
    expect(holders).toHaveLength(1)
    expect(holders[0]?.tagName).toBe('CODE')
    const reveal_block = holders[0]?.closest('div.border-amber-300') as HTMLElement
    expect(reveal_block).not.toBeNull()
    for (const el of screen.getAllByTestId('probe')) {
      expect(reveal_block.contains(el)).toBe(false)
      expect(el.textContent).not.toContain(KEY)
    }
    expect(document.body.innerHTML.split(KEY)).toHaveLength(2)
  })

  it('hands every point { project } only, before and after the reveal', async () => {
    const view = mount()
    const idle = screen.getAllByTestId('probe').map((el) => el.getAttribute('data-keys'))
    view.unmount()
    await reveal()
    const revealed = screen.getAllByTestId('probe').map((el) => el.getAttribute('data-keys'))
    for (const keys of [...idle, ...revealed]) {
      expect(keys).toBe('data,params,project,routeId')
    }
    for (const el of screen.getAllByTestId('probe')) {
      expect(el.textContent).not.toMatch(/exportKey|exporting|exportError|revealed|copyStatus/)
    }
  })
})

describe('ProjectExportError prop contract (Story 62-2 D3, amended by DW-610 item 1)', () => {
  it('a replacement of the export-error region receives exactly { project, exportError, data }', () => {
    // The component's declared props are the documented replacement contract: no more, no less.
    const start = ERROR_REGION_SOURCE.indexOf('let {')
    const end = ERROR_REGION_SOURCE.indexOf('= $props()')
    const declaration = ERROR_REGION_SOURCE.slice(start, end)
    const squashed = declaration.split(/\s+/).join(' ')
    expect(squashed).toBe(
      'let { project, exportError, data, }: { project: ProjectOverview exportError: string | null data?: Record<string, readonly unknown[]> | undefined } '
    )
  })

  it('renders the raw API error text, and the point inside still gets { project } only', () => {
    render(ProjectExportError, {
      props: { project, exportError: 'No access', data: fills },
    })
    expect(screen.getByText('No access')).toBeTruthy()
    const point = probe('project.detail.export-error')
    expect(point.getAttribute('data-keys')).toBe('data,params,project,routeId')
    expect(point.textContent).not.toContain('No access')
    expect(point.textContent).not.toContain('exportError')
  })

  it('renders no message for a null error, the point still renders', () => {
    render(ProjectExportError, { props: { project, exportError: null, data: fills } })
    expect(document.querySelector('p.text-red-700')).toBeNull()
    expect(screen.getAllByTestId('probe')).toHaveLength(1)
  })

  it('a failed export carries the error text and never the key into the panel points', async () => {
    api.exportProject.mockRejectedValueOnce(
      new ApiClientError(500, null, 'An unexpected error occurred')
    )
    mount()
    await fireEvent.click(exportButton())
    await screen.findByText('An unexpected error occurred')
    for (const el of screen.getAllByTestId('probe')) {
      expect(el.textContent).not.toContain('An unexpected error occurred')
      expect(el.textContent).not.toContain(KEY)
    }
  })
})
