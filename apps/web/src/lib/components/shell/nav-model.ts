import { m } from '$lib/paraglide/messages.js'

export type PrimaryNavItem = {
  label: string
  mobileLabel: string
  href: string
}

const DEFAULT_NAV_OPTS = { isPlatformOperator: false, hasUiPanelExtension: false }

// Story 28.4 AC2: labels are built INSIDE getPrimaryNavItems()'s own function body so every
// m.nav_*() call resolves fresh on each invocation, not once at module load. A module-scope
// constant array (the pre-fix shape) would evaluate each m.nav_*() call exactly once, at whatever
// locale was active when this module first loaded — silently freezing the nav in that locale even
// after a later no-reload setLocale() call (Story 15.1's own design). Building the array inside
// the function, and having PrimaryNav.svelte call this function from a `$derived`, keeps the nav
// reactive to a live locale switch.
export function getPrimaryNavItems(
  opts: { isPlatformOperator: boolean; hasUiPanelExtension?: boolean } = DEFAULT_NAV_OPTS
): PrimaryNavItem[] {
  const basePrimaryNavItems: PrimaryNavItem[] = [
    { label: m.nav_dashboard(), mobileLabel: m.nav_dashboard(), href: '/dashboard' },
    { label: m.nav_projects(), mobileLabel: m.nav_projects(), href: '/projects' },
    { label: m.nav_secrets(), mobileLabel: m.nav_secrets(), href: '/credentials' },
    // AC-24: renamed from "Alerts" to match the destination page's own <h1> ("Notifications" —
    // the more established term app-wide: the route, page title, and data model all say
    // "notifications", so the nav label moved to match rather than the other way around).
    { label: m.nav_notifications(), mobileLabel: m.nav_notifications(), href: '/notifications' },
    { label: m.nav_health(), mobileLabel: m.nav_health(), href: '/health' },
    { label: m.nav_settings(), mobileLabel: m.nav_settings(), href: '/settings' },
  ]

  const platformAdminNavItem: PrimaryNavItem = {
    label: m.nav_platform_admin(),
    mobileLabel: m.nav_platform_admin_mobile(),
    href: '/platform',
  }

  // Story 25.1 AC5: a single, generic nav entry — not something hardcoded to any one extension's
  // specific use case (e.g. CentralizeMe's access-group panel). `ExtensionManifest` carries no
  // display-name field today, so the label is the fixed, generic "Extension" — not the extension's
  // own name. Points at this story's one hardcoded slot ('group'); Story 25.2 introduces real
  // named-slot enumeration.
  const extensionUiPanelNavItem: PrimaryNavItem = {
    label: m.nav_extension(),
    mobileLabel: m.nav_extension(),
    href: '/extensions/panels/group',
  }

  const items = opts.isPlatformOperator
    ? [...basePrimaryNavItems, platformAdminNavItem]
    : basePrimaryNavItems
  // AC5: the nav entry does not appear at all if no extension is loaded, or the loaded
  // extension's hooks have no uiPanel — never a dead link by default.
  return opts.hasUiPanelExtension ? [...items, extensionUiPanelNavItem] : items
}

export function isActiveNavItem(itemHref: string, pathname: string) {
  return pathname === itemHref || pathname.startsWith(`${itemHref}/`)
}
