// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { sampleProject } from '$lib/test/fixtures.js'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.12: the export panel's client-driven states (export in flight, the failure messages, the
// one-time reveal, the copy status, the acknowledgement gate and the return to idle) cannot be
// reached by the route oracles. This pins them: the snapshot was recorded BEFORE the panel was split
// into sub-regions and must come out unchanged. The mount helper is the only line that follows the
// component's props.

const api = vi.hoisted(() => ({ exportProject: vi.fn(), downloadExportBlob: vi.fn() }))
vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/projects/[projectId]' }, params: { projectId: 'p1' } },
}))
vi.mock('$lib/api/project-export.js', () => api)

const project = sampleProject({ id: 'p1', name: 'Payments API' })
const exported = { blob: new Blob(['x']), filename: 'p.pvexport', exportKey: 'STATE-PIN-VALUE-1' }

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  Panel = (await import('./ProjectExportPanel.svelte')).default as unknown as typeof Panel
}, 60_000)
beforeEach(() => {
  api.exportProject.mockReset()
  api.downloadExportBlob.mockReset()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const mountPanel = () => render(Panel, { props: { project } })
const asText = (states: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(states).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  )
const exportButton = () => screen.getByRole('button', { name: 'Export project' })
const revealKey = async () => {
  api.exportProject.mockResolvedValueOnce(exported)
  const view = mountPanel()
  await fireEvent.click(exportButton())
  await screen.findByText(exported.exportKey)
  return view
}

describe('ProjectExportPanel client states (Story 69.12 pre-split pin)', () => {
  it('renders every interactive state exactly as before the split', async () => {
    const states: Record<string, unknown> = {}

    const idle = mountPanel()
    states['idle'] = serializeWithoutNoise(idle.container)
    cleanup()

    api.exportProject.mockReturnValueOnce(new Promise(() => undefined))
    const exporting = mountPanel()
    await fireEvent.click(exportButton())
    await screen.findByRole('button', { name: 'Exporting…' })
    states['exporting'] = serializeWithoutNoise(exporting.container)
    cleanup()

    api.exportProject.mockRejectedValueOnce(new ApiClientError(403, null, 'No access'))
    const apiError = mountPanel()
    await fireEvent.click(exportButton())
    await screen.findByText('No access')
    states['error-api'] = serializeWithoutNoise(apiError.container)
    api.exportProject.mockRejectedValueOnce(new Error('boom'))
    await fireEvent.click(exportButton())
    await screen.findByText('boom')
    states['error-plain'] = serializeWithoutNoise(apiError.container)
    api.exportProject.mockRejectedValueOnce('nope')
    await fireEvent.click(exportButton())
    await screen.findByText('Export failed.')
    states['error-generic'] = serializeWithoutNoise(apiError.container)
    api.exportProject.mockResolvedValueOnce(exported)
    await fireEvent.click(exportButton())
    await screen.findByText(exported.exportKey)
    states['error-cleared-by-next-export'] = serializeWithoutNoise(apiError.container)
    cleanup()

    const revealed = await revealKey()
    states['revealed'] = serializeWithoutNoise(revealed.container)
    states['download-args'] = api.downloadExportBlob.mock.calls.map((call) => [call[1]])
    await fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Copied'))
    states['copy-success'] = serializeWithoutNoise(revealed.container)
    states['copied-text'] = (
      navigator.clipboard.writeText as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => call[0])
    await fireEvent.click(screen.getByRole('checkbox'))
    states['acknowledged'] = serializeWithoutNoise(revealed.container)
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    states['done-back-to-idle'] = serializeWithoutNoise(revealed.container)
    cleanup()

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const copyFailed = await revealKey()
    await fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain("Couldn't copy"))
    states['copy-failure'] = serializeWithoutNoise(copyFailed.container)
    cleanup()

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    })
    const timed = await revealKey()
    vi.useFakeTimers()
    await fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await vi.advanceTimersByTimeAsync(0)
    states['copy-status-open'] = screen.getByRole('status').textContent ?? ''
    await vi.advanceTimersByTimeAsync(3000)
    states['copy-status-cleared'] = serializeWithoutNoise(timed.container)

    await expect(`${JSON.stringify(asText(states), null, 2)}\n`).toMatchFileSnapshot(
      './ProjectExportPanel.states.snapshot.json'
    )
  }, 60_000)
})
