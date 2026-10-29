/**
 * @pv-stable: the id rules of the shared controls (Story 72.3). The help id is `<id>-help` unless
 * overridden, the error id is `<id>-error`, and `aria-describedby` lists the error first.
 */
export function helpIdOf(id: string, helpId?: string): string {
  return helpId ?? `${id}-help`
}

export function errorIdOf(id: string): string {
  return `${id}-error`
}

/** The `aria-describedby` value, or undefined when neither a hint nor an error shows. */
export function describedByOf(
  id: string,
  helpId: string | undefined,
  hint: string | undefined,
  error: string | undefined
): string | undefined {
  const ids = [error ? errorIdOf(id) : '', hint ? helpIdOf(id, helpId) : ''].filter(Boolean)
  return ids.length > 0 ? ids.join(' ') : undefined
}
