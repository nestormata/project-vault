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

describe('ProjectExportPanel copy button and live region (Story 62-2 AC-1)', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>()

  function stubClipboard(clipboard: { writeText: typeof writeText } | undefined): void {
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
  }

  beforeEach(() => {
    writeText.mockReset()
    writeText.mockResolvedValue(undefined)
    stubClipboard({ writeText })
  })
  afterEach(() => {
    vi.useRealTimers()
    stubClipboard(undefined)
  })

  const copyButton = () => screen.getByRole('button', { name: 'Copy' })
  const statusRegion = () => screen.getByRole('status')

  it('renders an empty polite live region as soon as the reveal opens (pre-existing, so it is announced)', async () => {
    await reveal()
    const region = statusRegion()
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.textContent?.trim()).toBe('')
  })

  it('copies exactly the key, announces success, and clears after 3 s without touching the acknowledgement', async () => {
    await reveal()
    vi.useFakeTimers()
    await fireEvent.click(copyButton())
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(KEY)
    expect(statusRegion().textContent).toContain('Copied to clipboard')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true)
    await vi.advanceTimersByTimeAsync(2999)
    expect(statusRegion().textContent).toContain('Copied to clipboard')
    await vi.advanceTimersByTimeAsync(1)
    expect(statusRegion().textContent?.trim()).toBe('')
  })

  it('announces a failure when writeText rejects; the key stays visible and is not in the message', async () => {
    writeText.mockRejectedValueOnce(new Error(`denied ${KEY}`))
    await reveal()
    await fireEvent.click(copyButton())
    await waitFor(() => expect(statusRegion().textContent).toContain("Couldn't copy"))
    expect(statusRegion().textContent).not.toContain(KEY)
    expect(screen.getByText(KEY)).toBeTruthy()
  })

  it('announces a failure when navigator.clipboard is unavailable (insecure context)', async () => {
    stubClipboard(undefined)
    await reveal()
    await fireEvent.click(copyButton())
    await waitFor(() => expect(statusRegion().textContent).toContain("Couldn't copy"))
    expect(statusRegion().textContent).not.toContain(KEY)
    expect(screen.getByText(KEY)).toBeTruthy()
  })

  it('replaces rather than stacks the message on a double click, writing twice', async () => {
    await reveal()
    vi.useFakeTimers()
    await fireEvent.click(copyButton())
    await fireEvent.click(copyButton())
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(statusRegion().textContent?.match(/Copied to clipboard/g)).toHaveLength(1)
    // The first click's timer must not clear the second message early.
    await vi.advanceTimersByTimeAsync(2000)
    await fireEvent.click(copyButton())
    await vi.advanceTimersByTimeAsync(2000)
    expect(statusRegion().textContent).toContain('Copied to clipboard')
  })

  it('removes the live region, key and status after Done, and a re-export starts clean', async () => {
    await reveal()
    await fireEvent.click(copyButton())
    await waitFor(() => expect(statusRegion().textContent).toContain('Copied to clipboard'))
    await fireEvent.click(screen.getByRole('checkbox'))
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(KEY)).toBeNull()
    vi.mocked(exportProject).mockResolvedValueOnce({ ...exported, exportKey: 'SECOND-KEY' })
    await fireEvent.click(exportButton())
    await waitFor(() => expect(screen.getByText('SECOND-KEY')).toBeTruthy())
    expect(statusRegion().textContent?.trim()).toBe('')
  })

  it('does not update state after unmount (pending timeout is cleared)', async () => {
    await reveal()
    vi.useFakeTimers()
    await fireEvent.click(copyButton())
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    cleanup()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the key out of the injection point and out of the copy label and status', async () => {
    await reveal()
    await fireEvent.click(copyButton())
    await waitFor(() => expect(statusRegion().textContent).toContain('Copied to clipboard'))
    expect(statusRegion().textContent).not.toContain(KEY)
    expect(screen.getByTestId('probe').textContent).not.toContain(KEY)
  })
})

describe('ProjectExportPanel description (Story 62-2 AC-7)', () => {
  const description = () => screen.queryByText(/shown to you exactly once/)

  it('hides the long paragraph while the reveal is open and restores it after Done', async () => {
    render(ProjectExportPanel, { props: { project } })
    expect(description()).not.toBeNull()
    cleanup()
    await reveal()
    expect(description()).toBeNull()
    expect(screen.getByRole('heading', { name: 'Export project' })).toBeTruthy()
    await fireEvent.click(screen.getByRole('checkbox'))
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(description()).not.toBeNull()
  })
})
