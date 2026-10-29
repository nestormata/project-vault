// Story 72.5: jsdom has no `HTMLDialogElement.showModal`/`close`. This installs a stand-in that
// follows the HTML spec closely enough for the behaviour under test: `showModal` sets `open`,
// `close` removes it and queues a `close` event, and `pressEscape` raises the cancelable `cancel`
// event a browser raises for Escape and closes the dialog unless a listener prevented it.
export function installDialogPolyfill(): void {
  const proto = HTMLDialogElement.prototype as unknown as {
    showModal: () => void
    close: () => void
  }
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
    // The first focusable element, as the dialog focusing steps pick.
    this.querySelector<HTMLElement>('button, input, select, textarea, a[href]')?.focus()
  }
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
}

export function pressEscape(dialog: HTMLDialogElement): void {
  const cancel = new Event('cancel', { cancelable: true })
  dialog.dispatchEvent(cancel)
  if (!cancel.defaultPrevented) dialog.close()
}
