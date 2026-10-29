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

type Pending = { seq: number; request: ConfirmRequest; resolve: (answer: boolean) => void }

let nextSeq = 0

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
  if (hosts === 0) return Promise.resolve(confirmWithoutHost(request))
  return new Promise<boolean>((resolve) => {
    nextSeq += 1
    const entry: Pending = { seq: nextSeq, request, resolve }
    if (active) waiting.push(entry)
    else active = entry
  })
}

/** The request now on screen, with a sequence number that is unique per request (two requests may
 * share one object, so the object itself cannot tell them apart). */
export function getActiveConfirm(): { seq: number; request: ConfirmRequest } | null {
  return active ? { seq: active.seq, request: active.request } : null
}

/** Answers every request still waiting (on screen or queued) with `false`, e.g. on navigation. */
export function cancelAllConfirms(): void {
  const all = [...(active ? [active] : []), ...waiting.splice(0)]
  active = null
  for (const entry of all) entry.resolve(false)
}

function confirmWithoutHost(request: ConfirmRequest): boolean {
  if (request.typedValue === undefined) return window.confirm(request.message)
  // A typed confirmation must stay typed: ask for the value in a prompt, compared like
  // TypedConfirmInput (trimmed, case-insensitive).
  const typed = window.prompt(
    `${request.message}\n\n${request.typedLabel ?? 'Type the exact name to confirm'}`
  )
  return typed !== null && typed.trim().toLowerCase() === request.typedValue.trim().toLowerCase()
}

export function settleConfirm(answer: boolean): void {
  const done = active
  active = waiting.shift() ?? null
  done?.resolve(answer)
}
