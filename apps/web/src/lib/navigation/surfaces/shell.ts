// Story 68.7 (S3-S7): the app shell's persistent chrome: the brand link, the notifications bell,
// the MFA banner's settings link, the account menu and the footer.
import { goto } from '$app/navigation'
import { resolve } from '$app/paths'
import { logout } from '$lib/api/auth.js'
import { m } from '$lib/paraglide/messages.js'
import { openShortcuts } from '$lib/state/shortcuts.svelte.js'
import type { SurfaceBuilder } from './define.js'
import { text } from './define.js'

export const shellBrandItems: SurfaceBuilder<'shell.brand'> = () => [
  { id: 'shell.brand.home', label: text('Project Vault'), href: () => resolve('/dashboard') },
]

export const shellUtilityItems: SurfaceBuilder<'shell.utility'> = () => [
  {
    id: 'shell.utility.notifications',
    kind: 'badge-link',
    label: text('Notifications'),
    href: () => resolve('/notifications'),
  },
]

/** The path the MFA banner's server-provided message names; the banner links it in place. */
export const MFA_SETTINGS_PATH = '/settings/security'

export const shellMfaBannerItems: SurfaceBuilder<'shell.mfa-banner'> = () => [
  {
    id: 'shell.mfa-banner.security',
    label: text(MFA_SETTINGS_PATH),
    href: () => resolve(MFA_SETTINGS_PATH),
  },
]

/** PV's sign-out: a missing or expired session must not trap the user in the app shell. */
export async function signOut(): Promise<void> {
  try {
    await logout(fetch)
  } catch {
    // A missing/expired session should not trap the user in the app shell.
  }
  await goto(resolve('/login?reason=logged-out'))
}

/** Where the account menu's Help item points: PV's documentation. */
export const HELP_URL = 'https://github.com/nestormata/project-vault/tree/main/docs'

// Story 72.6 (P3a): the account dropdown. Account and Language lead to PV's own settings pages,
// Keyboard shortcuts opens PV's shortcuts dialog, Help is an external link; Sign out stays last
// and keeps its id. A composed app inserts its own items `before: 'account.sign-out'`.
export const accountItems: SurfaceBuilder<'account'> = () => [
  {
    id: 'account.account',
    label: () => m.nav_account(),
    href: () => resolve('/settings'),
    match: 'exact',
  },
  {
    id: 'account.language',
    label: () => m.nav_language(),
    href: () => resolve('/settings/language'),
  },
  {
    id: 'account.shortcuts',
    kind: 'action',
    label: () => m.nav_keyboard_shortcuts(),
    onSelect: () => openShortcuts(),
  },
  {
    id: 'account.help',
    kind: 'external',
    label: () => m.nav_help(),
    href: () => HELP_URL,
  },
  {
    id: 'account.sign-out',
    kind: 'action',
    label: () => m.shell_sign_out(),
    onSelect: () => signOut(),
  },
]

export const footerItems: SurfaceBuilder<'footer'> = () => [
  {
    id: 'footer.github',
    kind: 'external',
    label: text('GitHub'),
    href: () => 'https://github.com/nestormata/project-vault',
  },
  {
    id: 'footer.license',
    kind: 'external',
    label: text('AGPL-3.0'),
    href: () => 'https://github.com/nestormata/project-vault/blob/main/LICENSE',
  },
]
