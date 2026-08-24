export type PrimaryNavItem = {
  label: string
  mobileLabel: string
  href: string
}

const basePrimaryNavItems: PrimaryNavItem[] = [
  { label: 'Dashboard', mobileLabel: 'Dashboard', href: '/dashboard' },
  { label: 'Projects', mobileLabel: 'Projects', href: '/projects' },
  { label: 'Secrets', mobileLabel: 'Secrets', href: '/credentials' },
  // AC-24: renamed from "Alerts" to match the destination page's own <h1> ("Notifications" —
  // the more established term app-wide: the route, page title, and data model all say
  // "notifications", so the nav label moved to match rather than the other way around).
  { label: 'Notifications', mobileLabel: 'Notifications', href: '/notifications' },
  { label: 'Health', mobileLabel: 'Health', href: '/health' },
  { label: 'Settings', mobileLabel: 'Settings', href: '/settings' },
]

const platformAdminNavItem: PrimaryNavItem = {
  label: 'Platform Admin',
  mobileLabel: 'Platform',
  href: '/platform',
}

// Story 25.1 AC5: a single, generic nav entry — not something hardcoded to any one extension's
// specific use case (e.g. CentralizeMe's access-group panel). `ExtensionManifest` carries no
// display-name field today, so the label is the fixed, generic "Extension" — not the extension's
// own name. Points at this story's one hardcoded slot ('group'); Story 25.2 introduces real
// named-slot enumeration.
const extensionUiPanelNavItem: PrimaryNavItem = {
  label: 'Extension',
  mobileLabel: 'Extension',
  href: '/extensions/panels/group',
}

const DEFAULT_NAV_OPTS = { isPlatformOperator: false, hasUiPanelExtension: false }

export function getPrimaryNavItems(
  opts: { isPlatformOperator: boolean; hasUiPanelExtension?: boolean } = DEFAULT_NAV_OPTS
): PrimaryNavItem[] {
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
