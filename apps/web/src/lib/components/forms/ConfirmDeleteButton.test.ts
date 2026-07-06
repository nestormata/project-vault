import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import ConfirmDeleteButton from './ConfirmDeleteButton.svelte'

afterEach(() => cleanup())

describe('ConfirmDeleteButton (Story 6.4 Dev Notes: shared two-step confirm, no window.confirm())', () => {
  it('AC-B5 happy path: first click relabels to confirm, second click invokes onConfirm', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(ConfirmDeleteButton, { props: { onConfirm } })

    const button = screen.getByRole('button', { name: 'Delete' })
    await fireEvent.click(button)
    expect(screen.getByRole('button', { name: 'Confirm delete?' })).toBeTruthy()
    expect(onConfirm).not.toHaveBeenCalled()

    await fireEvent.click(screen.getByRole('button', { name: 'Confirm delete?' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('AC-B5 edge: a single click never deletes anything on its own', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(ConfirmDeleteButton, { props: { onConfirm } })

    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('supports custom labels (e.g. alert dismiss reusing the same component)', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(ConfirmDeleteButton, {
      props: { label: 'Dismiss', confirmLabel: 'Confirm dismiss?', onConfirm },
    })

    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.getByRole('button', { name: 'Confirm dismiss?' })).toBeTruthy()
  })

  it('resets back to the initial label after a successful confirm (state does not leak/stick)', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(ConfirmDeleteButton, { props: { onConfirm } })

    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm delete?' }))

    expect(await screen.findByRole('button', { name: 'Delete' })).toBeTruthy()
  })

  it('does not render a control at all when disabled is not applicable — instead is simply not shown by callers (AC-I1); when rendered but disabled prop is true, clicks are inert', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(ConfirmDeleteButton, { props: { onConfirm, disabled: true } })

    const button = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await fireEvent.click(button)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
