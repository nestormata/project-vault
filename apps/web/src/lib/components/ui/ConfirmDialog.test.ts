import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { tick } from 'svelte'
import { installDialogPolyfill, pressEscape } from '$lib/test/dialog-test-helpers.js'
import { requestConfirm } from '$lib/state/confirm.svelte.js'
import ConfirmDialog from './ConfirmDialog.svelte'
import ConfirmDialogHost from './ConfirmDialogHost.svelte'

const base = { id: 'c1', title: 'Archive secret?', message: 'It stays recoverable.' }

describe('ConfirmDialog', () => {
  beforeEach(() => installDialogPolyfill())
  afterEach(() => cleanup())

  it('names the dialog, describes it and confirms', async () => {
    const onconfirm = vi.fn()
    render(ConfirmDialog, { props: { ...base, open: true, confirmLabel: 'Archive', onconfirm } })
    await tick()
    expect(screen.getByRole('dialog', { name: 'Archive secret?' })).toBeTruthy()
    expect(screen.getByText('It stays recoverable.')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await tick()
    expect(onconfirm).toHaveBeenCalledTimes(1)
    expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(false)
  })

  it('Cancel and Escape report oncancel, never onconfirm', async () => {
    const onconfirm = vi.fn()
    const oncancel = vi.fn()
    render(ConfirmDialog, { props: { ...base, open: true, onconfirm, oncancel } })
    await tick()
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await tick()
    expect(oncancel).toHaveBeenCalledTimes(1)
    cleanup()
    const second = vi.fn()
    render(ConfirmDialog, { props: { ...base, open: true, onconfirm, oncancel: second } })
    await tick()
    pressEscape(document.querySelector('dialog') as HTMLDialogElement)
    await tick()
    expect(second).toHaveBeenCalledTimes(1)
    expect(onconfirm).not.toHaveBeenCalled()
  })

  it('typed confirmation: Confirm stays disabled until the exact name is typed', async () => {
    const onconfirm = vi.fn()
    render(ConfirmDialog, {
      props: { ...base, open: true, typedValue: 'Payments', confirmLabel: 'Delete', onconfirm },
    })
    await tick()
    const confirm = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    const input = screen.getByLabelText('Type the exact name to confirm')
    await fireEvent.input(input, { target: { value: 'Paymen' } })
    expect(confirm.disabled).toBe(true)
    await fireEvent.input(input, { target: { value: ' payments ' } })
    expect(confirm.disabled).toBe(false)
    await fireEvent.click(confirm)
    expect(onconfirm).toHaveBeenCalledTimes(1)
  })

  it('typed input is described by its help text', async () => {
    render(ConfirmDialog, { props: { ...base, open: true, typedValue: 'x', onconfirm: vi.fn() } })
    await tick()
    const input = screen.getByLabelText('Type the exact name to confirm')
    const describedBy = input.getAttribute('aria-describedby') ?? ''
    expect(describedBy).toBe('c1-typed-help')
    expect(document.getElementById(describedBy)).toBeTruthy()
  })

  it('a pending confirmation cannot be confirmed again', async () => {
    const onconfirm = vi.fn()
    render(ConfirmDialog, { props: { ...base, open: true, pending: true, onconfirm } })
    await tick()
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('initial focus is Cancel, the safe choice', async () => {
    render(ConfirmDialog, { props: { ...base, open: true, onconfirm: vi.fn() } })
    await tick()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })
})

describe('requestConfirm + ConfirmDialogHost', () => {
  beforeEach(() => installDialogPolyfill())
  afterEach(() => cleanup())

  it('without a host it falls back to window.confirm with the same message', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await expect(requestConfirm({ title: 'T', message: 'Really?' })).resolves.toBe(true)
    expect(spy).toHaveBeenCalledWith('Really?')
    spy.mockRestore()
  })

  it('shows the dialog, resolves true on confirm and returns focus to the opener', async () => {
    render(ConfirmDialogHost)
    await tick()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const answer = requestConfirm({
      title: 'Remove user?',
      message: 'They lose access.',
      confirmLabel: 'Remove',
      variant: 'danger',
    })
    await tick()
    await tick()
    expect(screen.getByRole('dialog', { name: 'Remove user?' })).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await expect(answer).resolves.toBe(true)
    await tick()
    expect(document.querySelector('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('resolves false on Cancel and on Escape; queued requests are answered in order', async () => {
    render(ConfirmDialogHost)
    await tick()
    const first = requestConfirm({ title: 'One', message: 'one' })
    const second = requestConfirm({ title: 'Two', message: 'two' })
    await tick()
    await tick()
    expect(screen.getByRole('dialog', { name: 'One' })).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expect(first).resolves.toBe(false)
    await tick()
    await tick()
    expect(screen.getByRole('dialog', { name: 'Two' })).toBeTruthy()
    pressEscape(document.querySelector('dialog') as HTMLDialogElement)
    await expect(second).resolves.toBe(false)
  })

  it('unmounting the host answers a pending request with false', async () => {
    const view = render(ConfirmDialogHost)
    await tick()
    const answer = requestConfirm({ title: 'T', message: 'm' })
    await tick()
    view.unmount()
    await expect(answer).resolves.toBe(false)
  })
})
