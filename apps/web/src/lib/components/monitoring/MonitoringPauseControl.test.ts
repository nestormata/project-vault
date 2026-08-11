import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'

import MonitoringPauseControl from './MonitoringPauseControl.svelte'

function renderControl(props: Record<string, unknown> = {}) {
  const onToggle = vi.fn(async () => true)
  const result = render(MonitoringPauseControl, {
    props: {
      paused: false,
      pausedAt: null,
      lastKnownStatus: 'healthy',
      canManage: true,
      idSuffix: 'endpoint-1',
      onToggle,
      ...props,
    },
  })
  return { ...result, onToggle }
}

describe('MonitoringPauseControl', () => {
  afterEach(() => cleanup())

  it('card variant (default) keeps the detail page heading and explanatory copy', () => {
    const { container } = renderControl()
    expect(screen.getByRole('heading', { name: 'Monitoring active' })).toBeTruthy()
    expect(container.querySelector('section')).toBeTruthy()
    expect(screen.getByText(/checks run according to the configured schedule/i)).toBeTruthy()
  })

  it('row variant exposes the same accessible name via a group instead of a heading', () => {
    renderControl({ variant: 'row' })
    expect(screen.queryByRole('heading', { name: 'Monitoring active' })).toBeNull()
    const group = screen.getByRole('group', { name: 'Monitoring active' })
    expect(group).toBeTruthy()
  })

  it('row variant reports paused state, last known status, and the paused timestamp', () => {
    renderControl({
      variant: 'row',
      paused: true,
      pausedAt: '2026-07-01T00:00:00.000Z',
      lastKnownStatus: 'down',
    })
    const group = screen.getByRole('group', { name: 'Monitoring paused' })
    expect(within(group).getByText('Down', { exact: true })).toBeTruthy()
    expect(within(group).getByText(/^Paused /)).toBeTruthy()
  })

  it('row variant shows the viewer note and no button when the role cannot manage', () => {
    renderControl({ variant: 'row', canManage: false, paused: true })
    expect(screen.getByText(/you can view this state/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /monitoring$/i })).toBeNull()
  })

  it('row variant renders its error message as a live alert', () => {
    renderControl({ variant: 'row', errorMessage: 'Nope.' })
    expect(screen.getByRole('alert').textContent).toBe('Nope.')
  })

  it.each([['card'], ['row']])(
    '%s variant drives the same confirm-dialog toggle path',
    async (variant) => {
      const { onToggle } = renderControl({ variant })
      await fireEvent.click(screen.getByRole('button', { name: 'Pause monitoring' }))
      const dialog = screen.getByRole('dialog')
      expect(dialog.textContent).toMatch(/future probes/i)
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Pause monitoring' }))
      await waitFor(() => expect(onToggle).toHaveBeenCalledWith(true))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }
  )
})
