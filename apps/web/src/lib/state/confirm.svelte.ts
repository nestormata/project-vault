// Story 72.5: one confirmation queue for the whole app. A destructive action asks
// `requestConfirm(...)` and awaits the answer; the `ConfirmDialogHost` mounted in the (app) layout
// shows the shared dialog. Without a mounted host (an embedding that never mounts the layout) the
// request falls back to the browser's `window.confirm` with the same message, so a destructive
// action is never run unconfirmed.

export type ConfirmRequest = {
  title: string
  /** The sentence the user answers; also the `window.confirm` fallback text. */
  message: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'primary' | 'danger'
  /** Typed-name confirmation: Confirm enables only when this is typed. */
  typedValue?: string
  typedLabel?: string
}

type Pending = { request: ConfirmRequest; resolve: (answer: boolean) => void }

let hosts = 0
let active = $state<Pending | null>(null)
const waiting: Pending[] = []

export function registerConfirmHost(): () => void {
  hosts += 1
  return () => {
    hosts -= 1
    if (hosts === 0) {
      active?.resolve(false)
      active = null
      for (const next of waiting.splice(0)) next.resolve(false)
    }
  }
}

export function requestConfirm(request: ConfirmRequest): Promise<boolean> {
  if (hosts === 0) return Promise.resolve(window.confirm(request.message))
  return new Promise<boolean>((resolve) => {
    const entry: Pending = { request, resolve }
    if (active) waiting.push(entry)
    else active = entry
  })
}

export function getActiveConfirm(): ConfirmRequest | null {
  return active?.request ?? null
}

export function settleConfirm(answer: boolean): void {
  const done = active
  active = waiting.shift() ?? null
  done?.resolve(answer)
}
