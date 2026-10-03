// Story 68.7 (S3-S7): the app shell's persistent chrome: the brand link, the notifications bell,
// the MFA banner's settings link, the account menu and the footer.
import { goto } from '$app/navigation'
import { resolve } from '$app/paths'
import { logout } from '$lib/api/auth.js'
import { m } from '$lib/paraglide/messages.js'
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

export const accountItems: SurfaceBuilder<'account'> = () => [
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
