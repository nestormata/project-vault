// Story 72.6: whether the keyboard shortcuts dialog is open. The account menu's "Keyboard
// shortcuts" action opens it; `ShortcutsDialogHost` (mounted once in the (app) layout) shows it.
let open = $state(false)

export function isShortcutsOpen(): boolean {
  return open
}

export function openShortcuts(): void {
  open = true
}

export function closeShortcuts(): void {
  open = false
}
