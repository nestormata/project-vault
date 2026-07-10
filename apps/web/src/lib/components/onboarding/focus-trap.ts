const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function trapFocus(container: HTMLElement): () => void {
  const focusables = () => [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Tab') return
    const elements = focusables()
    if (elements.length === 0) return
    const first = elements[0]
    const last = elements.at(-1)
    if (!first || !last) return

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
      return
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  container.addEventListener('keydown', onKeyDown)
  const initial = focusables()[0]
  initial?.focus()

  return () => container.removeEventListener('keydown', onKeyDown)
}
