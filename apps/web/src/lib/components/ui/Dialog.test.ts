import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { tick } from 'svelte'
import { installDialogPolyfill, pressEscape } from '$lib/test/dialog-test-helpers.js'
import DialogHarness from '$lib/test/DialogHarness.test.svelte'
import Dialog from './Dialog.svelte'

function dialogEl(): HTMLDialogElement {
  return document.querySelector('dialog') as HTMLDialogElement
}

describe('Dialog (native <dialog>)', () => {
  beforeEach(() => installDialogPolyfill())
  afterEach(() => cleanup())

  it('opens as a modal with an accessible name and description', async () => {
    render(Dialog, { props: { open: true, id: 'd1', title: 'Delete it?', description: 'Gone.' } })
    await tick()
    const dialog = dialogEl()
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(screen.getByRole('dialog', { name: 'Delete it?' })).toBe(dialog)
    expect(dialog.getAttribute('aria-labelledby')).toBe('d1-title')
    expect(dialog.getAttribute('aria-describedby')).toBe('d1-description')
    expect(document.getElementById('d1-description')?.textContent).toBe('Gone.')
  })

  it('has no aria-describedby without a description (never a dangling id)', async () => {
    render(Dialog, { props: { open: true, id: 'd2', title: 'T' } })
    await tick()
    expect(dialogEl().hasAttribute('aria-describedby')).toBe(false)
  })

  it('stays closed while open is false', async () => {
    render(Dialog, { props: { open: false, id: 'd3', title: 'T' } })
    await tick()
    expect(dialogEl().hasAttribute('open')).toBe(false)
  })

  it('Escape closes it, reports onclose and returns focus to the opener', async () => {
    const onclose = vi.fn()
    render(DialogHarness, { props: { onclose } })
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    await fireEvent.click(opener)
    await tick()
    expect(dialogEl().hasAttribute('open')).toBe(true)
    expect(document.activeElement).not.toBe(opener)
    pressEscape(dialogEl())
    await tick()
    expect(dialogEl().hasAttribute('open')).toBe(false)
    expect(onclose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(opener)
  })

  it('a non-dismissible dialog ignores Escape and the backdrop', async () => {
    const onclose = vi.fn()
    render(Dialog, { props: { open: true, id: 'd4', title: 'T', dismissible: false, onclose } })
    await tick()
    pressEscape(dialogEl())
    await fireEvent.click(dialogEl())
    await tick()
    expect(dialogEl().hasAttribute('open')).toBe(true)
    expect(onclose).not.toHaveBeenCalled()
  })

  it('a backdrop click closes a dismissible dialog, a click inside the panel does not', async () => {
    const onclose = vi.fn()
    render(Dialog, { props: { open: true, id: 'd5', title: 'Inside', onclose } })
    await tick()
    await fireEvent.click(screen.getByText('Inside'))
    expect(dialogEl().hasAttribute('open')).toBe(true)
    await fireEvent.click(dialogEl())
    await tick()
    expect(dialogEl().hasAttribute('open')).toBe(false)
    expect(onclose).toHaveBeenCalledTimes(1)
  })

  it('gives initial focus to the data-autofocus control', async () => {
    render(DialogHarness, { props: { autofocusSecond: true } })
    await fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await tick()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Second' }))
  })

  it('hands focus back when torn down while open', async () => {
    const view = render(DialogHarness, { props: {} })
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    await fireEvent.click(opener)
    await tick()
    await fireEvent.click(screen.getByRole('button', { name: 'Unmount dialog' }))
    await tick()
    expect(document.querySelector('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
    view.unmount()
  })

  it('falls back to the open attribute when the browser has no dialog API', async () => {
    const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>
    const { showModal, close } = proto
    delete proto.showModal
    delete proto.close
    try {
      const onclose = vi.fn()
      const view = render(DialogHarness, { props: { onclose } })
      await fireEvent.click(screen.getByRole('button', { name: 'Open' }))
      await tick()
      expect(dialogEl().hasAttribute('open')).toBe(true)
      await fireEvent.click(screen.getByRole('button', { name: 'Close it' }))
      await tick()
      expect(dialogEl().hasAttribute('open')).toBe(false)
      expect(onclose).toHaveBeenCalledTimes(1)
      view.unmount()
    } finally {
      proto.showModal = showModal
      proto.close = close
    }
  })
})
