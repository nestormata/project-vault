// Story 72.6 (P3a): the account dropdown on the `account` surface: its items in order, the
// disclosure behaviour (Escape, outside click, choosing an item) and the shortcuts dialog host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import { tick } from 'svelte'
import { setLocale } from '$lib/paraglide/runtime.js'
import { installDialogPolyfill } from '$lib/test/dialog-test-helpers.js'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const logoutMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$lib/api/auth.js', () => ({ logout: logoutMock }))

import { testAuthUser } from '$lib/test/page-data.js'
import { closeShortcuts, isShortcutsOpen } from '$lib/state/shortcuts.svelte.js'
import { HELP_URL } from '$lib/navigation/surfaces/shell.js'
import ShellAccount from './ShellAccount.svelte'
import ShortcutsDialogHost from './ShortcutsDialogHost.svelte'

beforeEach(() => installDialogPolyfill())

afterEach(async () => {
  cleanup()
  closeShortcuts()
  gotoMock.mockClear()
  await setLocale('en', { reload: false })
})

const user = () => testAuthUser({ orgRole: 'admin', orgName: 'Test Org' })

function menu(): HTMLDetailsElement {
  return screen.getByTestId('account-menu') as HTMLDetailsElement
}

// jsdom does not toggle <details> on a summary click: set `open` and raise the event a browser does.
async function openMenu(): Promise<void> {
  menu().open = true
  menu().dispatchEvent(new Event('toggle'))
  await tick()
}

describe('the account dropdown (Story 72.6)', () => {
  it('offers Account, Language, Keyboard shortcuts, Help and Sign out, in that order', () => {
    render(ShellAccount, { props: { user: user() } })
    const entries = within(menu())
      .getAllByRole('link')
      .concat(within(menu()).getAllByRole('button'))
    const names = entries
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map((el) => el.textContent?.trim())
    expect(names).toEqual(['Account', 'Language', 'Keyboard shortcuts', 'Help', 'Sign out'])
  })

  it('points Account and Language at the settings pages and Help at the docs in a new tab', () => {
    render(ShellAccount, { props: { user: user() } })
    expect(screen.getByRole('link', { name: 'Account' }).getAttribute('href')).toBe('/settings')
    expect(screen.getByRole('link', { name: 'Language' }).getAttribute('href')).toBe(
      '/settings/language'
    )
    const help = screen.getByRole('link', { name: 'Help' })
    expect(help.getAttribute('href')).toBe(HELP_URL)
    expect(help.getAttribute('target')).toBe('_blank')
    expect(help.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('the trigger is a summary named "Account menu" and the menu starts closed', () => {
    render(ShellAccount, { props: { user: user() } })
    expect(menu().open).toBe(false)
    expect(menu().querySelector('summary')?.textContent).toContain('Account menu')
  })

  it('Escape closes the open menu and returns focus to the trigger', async () => {
    render(ShellAccount, { props: { user: user() } })
    const summary = menu().querySelector('summary') as HTMLElement
    await openMenu()
    await fireEvent.keyDown(screen.getByRole('link', { name: 'Language' }), { code: 'Escape' })
    await tick()
    expect(menu().open).toBe(false)
    expect(document.activeElement).toBe(summary)
  })

  it('a click outside closes it without moving focus', async () => {
    render(ShellAccount, { props: { user: user() } })
    await openMenu()
    await fireEvent.click(document.body)
    await tick()
    expect(menu().open).toBe(false)
  })

  it('choosing Sign out signs out and closes the menu', async () => {
    render(ShellAccount, { props: { user: user() } })
    await openMenu()
    await fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await tick()
    expect(logoutMock).toHaveBeenCalled()
    expect(gotoMock).toHaveBeenCalledWith('/login?reason=logged-out')
    expect(menu().open).toBe(false)
  })

  it('Keyboard shortcuts opens the shortcuts dialog through its host', async () => {
    render(ShortcutsDialogHost)
    render(ShellAccount, { props: { user: user() } })
    const dialog = document.querySelector('dialog') as HTMLDialogElement
    expect(dialog.hasAttribute('open')).toBe(false)
    await fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    await tick()
    expect(isShortcutsOpen()).toBe(true)
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBe(dialog)
    expect(within(dialog).getByText('Ctrl K')).toBeTruthy()
    // Closing from the dialog's own button clears the shared state.
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await tick()
    expect(dialog.hasAttribute('open')).toBe(false)
    expect(isShortcutsOpen()).toBe(false)
  })

  it('the labels follow the locale', async () => {
    await setLocale('es', { reload: false })
    render(ShellAccount, { props: { user: user() } })
    expect(screen.getByRole('link', { name: 'Cuenta' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Idioma' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Atajos de teclado' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Ayuda' })).toBeTruthy()
  })
})
