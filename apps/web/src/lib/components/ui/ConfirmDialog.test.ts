import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { tick } from 'svelte'
import { installDialogPolyfill, pressEscape } from '$lib/test/dialog-test-helpers.js'
import { cancelAllConfirms, requestConfirm } from '$lib/state/confirm.svelte.js'
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

  it('a double click calls onconfirm once while it is in flight', async () => {
    let finish!: () => void
    const onconfirm = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    render(ConfirmDialog, { props: { ...base, open: true, onconfirm } })
    await tick()
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    await fireEvent.click(confirm)
    await fireEvent.click(confirm)
    expect(onconfirm).toHaveBeenCalledTimes(1)
    finish()
  })

  it('a failed onconfirm leaves it open and a later Cancel still reports oncancel', async () => {
    const oncancel = vi.fn()
    const onconfirm = vi.fn(async () => {
      throw new Error('boom')
    })
    render(ConfirmDialog, { props: { ...base, open: true, onconfirm, oncancel } })
    await tick()
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm' })).catch(() => {})
    await tick()
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await tick()
    expect(oncancel).toHaveBeenCalledTimes(1)
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

  it('two queued requests sharing one object are both answered', async () => {
    render(ConfirmDialogHost)
    await tick()
    const shared = { title: 'Same', message: 'same' }
    const first = requestConfirm(shared)
    const second = requestConfirm(shared)
    await tick()
    await tick()
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await expect(first).resolves.toBe(true)
    await tick()
    await tick()
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await expect(second).resolves.toBe(true)
  })

  it('cancelAllConfirms (navigation) answers the shown and queued requests with false', async () => {
    render(ConfirmDialogHost)
    await tick()
    const first = requestConfirm({ title: 'A', message: 'a' })
    const second = requestConfirm({ title: 'B', message: 'b' })
    await tick()
    cancelAllConfirms()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
  })

  it('without a host a typed confirmation is asked in a prompt and compared like the input', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('  PAYMENTS ')
    await expect(
      requestConfirm({ title: 'T', message: 'Delete?', typedValue: 'payments' })
    ).resolves.toBe(true)
    prompt.mockReturnValue('nope')
    await expect(
      requestConfirm({ title: 'T', message: 'Delete?', typedValue: 'payments' })
    ).resolves.toBe(false)
    prompt.mockReturnValue(null)
    await expect(
      requestConfirm({ title: 'T', message: 'Delete?', typedValue: 'payments' })
    ).resolves.toBe(false)
    prompt.mockRestore()
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
