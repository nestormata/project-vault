// Story 72.7 (P3b): which shell the (app) layout renders, and which pages count as task pages.
//
// `header` (the default) is the shell PV has always had: the primary nav in the top header.
// `rail` renders the SAME `primary` nav data as a persistent left rail from the `md` breakpoint and
// as a bottom tab bar below it. The variant is operator-chosen (`WEB_SHELL_VARIANT`), read by the
// (app) layout load; anything but `rail` (unset, empty, a typo) is the default, so a bad value can
// never break the shell.

export type ShellVariant = 'header' | 'rail'

export function parseShellVariant(raw: string | undefined | null): ShellVariant {
  return raw?.trim().toLowerCase() === 'rail' ? 'rail' : 'header'
}

/** How many links the bottom bar shows before the rest move into "More". */
export const BOTTOM_BAR_LINKS = 4

/** The viewport width below which the project tabs overflow into "More" (CSS px). */
export const TAB_OVERFLOW_BELOW_PX = 900

/** How many project tabs stay inline below `TAB_OVERFLOW_BELOW_PX`. */
export const TABS_INLINE_WHEN_NARROW = 3

// A task page is a page whose job is finishing one form or flow (CM D-09: forms with a sticky action
// bar). Its last path segment names the task. The bottom bar is not rendered there, so only one
// fixed element is ever on screen. `shell-variant.test.ts` walks the real route tree to keep this
// list honest when a route is added.
const TASK_SEGMENTS: ReadonlySet<string> = new Set(['new', 'import', 'rotate'])

export function isTaskPage(pathname: string): boolean {
  const segments = pathname.split('/').filter((segment) => segment !== '')
  const last = segments[segments.length - 1]
  return last !== undefined && TASK_SEGMENTS.has(last)
}

/** Whether a focused element is a text-entry control, which hides the bottom bar (CM F-23) so the
 * on-screen keyboard never stacks on top of it. */
export function isTextEntry(element: Element | null): boolean {
  if (element === null) return false
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true
  if (element instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'file', 'image'].includes(
      element.type
    )
  }
  return element.closest('[contenteditable=""], [contenteditable="true"]') !== null
}
