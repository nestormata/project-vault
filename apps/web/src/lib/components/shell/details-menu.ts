// Story 72.7: the close behaviour shared by the shell's native <details> menus (the account menu,
// the bottom bar's "More" and the project tabs' "More"). Escape closes and returns focus to the
// trigger; choosing a link or button inside the panel closes the menu and puts focus on the trigger
// BEFORE the item's own handler runs (capture phase), so a dialog the item opens returns focus to a
// visible element; a click outside and tabbing out close it and leave focus where the user put it.

/** Wires the close rules onto an open menu; returns the teardown. */
export function attachDetailsMenu(
  root: HTMLElement,
  summary: HTMLElement | null,
  close: (returnFocus: boolean) => void
): () => void {
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    close(true)
  }
  function onInsideClick(event: MouseEvent) {
    const target = event.target
    if (!(target instanceof Element) || summary?.contains(target)) return
    // A link or button inside the panel closes the menu; a disclosure's summary does not.
    if (target.closest('a, button')) close(true)
  }
  function onOutsideClick(event: MouseEvent) {
    if (event.target instanceof Node && !root.contains(event.target)) close(false)
  }
  function onFocusOut(event: FocusEvent) {
    const next = event.relatedTarget
    if (next instanceof Node && !root.contains(next)) close(false)
  }
  root.addEventListener('keydown', onKeyDown)
  root.addEventListener('click', onInsideClick, true)
  root.addEventListener('focusout', onFocusOut)
  window.addEventListener('click', onOutsideClick)
  return () => {
    root.removeEventListener('keydown', onKeyDown)
    root.removeEventListener('click', onInsideClick, true)
    root.removeEventListener('focusout', onFocusOut)
    window.removeEventListener('click', onOutsideClick)
  }
}
