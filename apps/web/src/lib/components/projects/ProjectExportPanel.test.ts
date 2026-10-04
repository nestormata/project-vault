import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { downloadExportBlob, exportProject } from '$lib/api/project-export.js'
import { sampleProject } from '$lib/test/fixtures.js'
import ProjectExportPanel from './ProjectExportPanel.svelte'

// Story 69.1 AC-2 / AC-5 item 9: the export panel owns the reveal-once state machine (Story 28.9 D2),
// moved byte for byte, and a contribution at `project.detail.export` never sees the key.

const pageState = vi.hoisted(() => ({
  route: { id: '/(app)/projects/[projectId]' } as { id: string | null },
  params: { projectId: 'p1' } as Record<string, string>,
}))
vi.mock('$app/state', () => ({ page: pageState }))
vi.mock('$lib/api/project-export.js', () => ({
  exportProject: vi.fn(),
  downloadExportBlob: vi.fn(),
}))
vi.mock('virtual:pv-inject/project.detail.export', async () => ({
  default: [
    {
      id: 'export#0',
      order: 0,
      component: (await import('$lib/test/injection/Probe.svelte')).default,
    },
  ],
}))

const KEY = 'SECRET-EXPORT-KEY-9f3a'
const project = sampleProject({ id: 'p1', name: 'Payments API' })
const exported = { blob: new Blob(['x']), filename: 'p.pvexport', exportKey: KEY }

afterEach(cleanup)
beforeEach(() => {
  vi.mocked(exportProject).mockReset()
  vi.mocked(downloadExportBlob).mockReset()
})

const exportButton = () => screen.getByRole('button', { name: 'Export project' })

async function reveal(): Promise<void> {
  vi.mocked(exportProject).mockResolvedValueOnce(exported)
  render(ProjectExportPanel, { props: { project } })
  await fireEvent.click(exportButton())
  await waitFor(() => expect(screen.getByText(KEY)).toBeTruthy())
}

describe('ProjectExportPanel state machine', () => {
  it('downloads the file and reveals the key once, gating Done on the acknowledgement', async () => {
    await reveal()
    expect(exportProject).toHaveBeenCalledWith(fetch, 'p1')
    expect(downloadExportBlob).toHaveBeenCalledWith(exported.blob, 'p.pvexport')
    expect(screen.queryByRole('button', { name: 'Export project' })).toBeNull()
    const done = screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement
    expect(done.disabled).toBe(true)
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox.getAttribute('aria-describedby')).toBe('export-key-ack-help')
    expect(document.getElementById('export-key-ack-help')).toBeTruthy()
    await fireEvent.click(checkbox)
    expect(done.disabled).toBe(false)
    await fireEvent.click(done)
    expect(screen.queryByText(KEY)).toBeNull()
    expect(exportButton()).toBeTruthy()
  })

  it('shows the error of a failed export (API message, plain Error, or a generic fallback)', async () => {
    render(ProjectExportPanel, { props: { project } })
    vi.mocked(exportProject).mockRejectedValueOnce(new ApiClientError(403, null, 'No access'))
    await fireEvent.click(exportButton())
    await waitFor(() => expect(screen.getByText('No access')).toBeTruthy())
    vi.mocked(exportProject).mockRejectedValueOnce(new Error('boom'))
    await fireEvent.click(exportButton())
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy())
    vi.mocked(exportProject).mockRejectedValueOnce('nope')
    await fireEvent.click(exportButton())
    await waitFor(() => expect(screen.getByText('Export failed.')).toBeTruthy())
  })

  it('ignores a second click while an export is in flight', async () => {
    let release: (value: typeof exported) => void = () => {}
    vi.mocked(exportProject).mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve))
    )
    render(ProjectExportPanel, { props: { project } })
    const button = exportButton() as HTMLButtonElement
    await fireEvent.click(button)
    await waitFor(() => expect(button.disabled).toBe(true))
    await fireEvent.click(button)
    expect(exportProject).toHaveBeenCalledTimes(1)
    release(exported)
    await waitFor(() => expect(screen.getByText(KEY)).toBeTruthy())
  })

  it('clears a previous error when the next export starts', async () => {
    render(ProjectExportPanel, { props: { project } })
    vi.mocked(exportProject).mockRejectedValueOnce(new Error('first failure'))
    await fireEvent.click(exportButton())
    await waitFor(() => expect(screen.getByText('first failure')).toBeTruthy())
    vi.mocked(exportProject).mockResolvedValueOnce(exported)
    await fireEvent.click(exportButton())
    await waitFor(() => expect(screen.getByText(KEY)).toBeTruthy())
    expect(screen.queryByText('first failure')).toBeNull()
  })
})

describe('ProjectExportPanel region point (export key confinement)', () => {
  it('renders the point outside the key branch: present idle, present while the key is shown', async () => {
    render(ProjectExportPanel, { props: { project } })
    expect(screen.getAllByTestId('probe')).toHaveLength(1)
    cleanup()
    await reveal()
    expect(screen.getAllByTestId('probe')).toHaveLength(1)
  })

  it('never hands the key, exporting or exportError to the contribution, before or after the reveal', async () => {
    await reveal()
    const probe = screen.getByTestId('probe')
    expect(probe.getAttribute('data-keys')).toBe('data,params,project,routeId')
    expect(probe.textContent).not.toContain(KEY)
    expect(probe.textContent).not.toMatch(/exportKey|exporting|exportError/)
  })
})
