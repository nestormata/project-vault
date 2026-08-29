import { m } from '$lib/paraglide/messages.js'
import type { ResolvedExtensionNavItem } from '$lib/api/extension-panel.js'

export type PrimaryNavItem = {
  label: string
  mobileLabel: string
  href: string
  /** Story 29.3 AC10/AC12 — the icon token carried through from a manifest-declared top-level
   * `navItems` entry (`ResolvedExtensionNavItem.icon`). Undefined for every PV-native item and
   * for a manifest-declared item that omitted `icon`. */
  icon?: string
  /** Story 29.3 AC10/AC12 — the resolved, nested children of a manifest-declared top-level
   * `navItems` entry (every other declared entry whose `parentId` matches this one's `id`).
   * Undefined for every PV-native item and for a manifest-declared item with no children. */
  children?: PrimaryNavItem[]
}

const DEFAULT_NAV_OPTS = {
  isPlatformOperator: false,
  hasUiPanelExtension: false,
  extensionNavItems: [] as ResolvedExtensionNavItem[],
}

/**
 * Story 29.3 AC10 — turns the manifest-declared, resolved `navItems` list (a flat array with
 * optional `parentId` links, exactly one level deep per `registerExtension()`'s own load-time
 * validation) into `PrimaryNavItem[]` top-level entries, each carrying its own nested `children`
 * array. A malformed `parentId` should be unreachable here (already rejected at
 * `registerExtension()` time) but this function still degrades safely: an item whose `parentId`
 * doesn't resolve to any top-level entry (or a `navItems` array containing only children with no
 * matching parent, from a hand-crafted degraded API response) is silently dropped rather than
 * thrown — `+layout.server.ts`'s own fail-open discipline extends to a malformed shape here too.
 */
function buildExtensionNavTopLevelItems(
  extensionNavItems: ResolvedExtensionNavItem[]
): PrimaryNavItem[] {
  const topLevel = extensionNavItems.filter((item) => item.parentId === undefined)
  return topLevel.map((item) => {
    const children = extensionNavItems
      .filter((candidate) => candidate.parentId === item.id)
      .map((child) => ({ label: child.label, mobileLabel: child.label, href: child.href }))
    return {
      label: item.label,
      mobileLabel: item.label,
      href: item.href,
      ...(item.icon !== undefined ? { icon: item.icon } : {}),
      ...(children.length > 0 ? { children } : {}),
    }
  })
}

// Story 28.4 AC2: labels are built INSIDE getPrimaryNavItems()'s own function body so every
// m.nav_*() call resolves fresh on each invocation, not once at module load. A module-scope
// constant array (the pre-fix shape) would evaluate each m.nav_*() call exactly once, at whatever
// locale was active when this module first loaded — silently freezing the nav in that locale even
// after a later no-reload setLocale() call (Story 15.1's own design). Building the array inside
// the function, and having PrimaryNav.svelte call this function from a `$derived`, keeps the nav
// reactive to a live locale switch.
export function getPrimaryNavItems(
  opts: {
    isPlatformOperator: boolean
    hasUiPanelExtension?: boolean
    /** Story 29.3 AC10 — resolved, manifest-declared nav entries merged in as additional
     * top-level items (with their own nested `children`), appended AFTER every existing
     * hardcoded item below. Defaults to `[]` — identical to omitting the field entirely. */
    extensionNavItems?: ResolvedExtensionNavItem[]
  } = DEFAULT_NAV_OPTS
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
  const withUiPanelItem = opts.hasUiPanelExtension ? [...items, extensionUiPanelNavItem] : items

  // Story 29.3 AC10 — manifest-declared navItems are appended AFTER every item above (including
  // the platform-admin and generic ui-panel items), never reordered or merged into them. This is
  // a separate, independent mechanism from `extensionUiPanelNavItem` above (AC10/AC14 boundary —
  // that pre-existing single generic item is explicitly out of scope for this story).
  const extensionNavTopLevelItems = buildExtensionNavTopLevelItems(opts.extensionNavItems ?? [])
  return [...withUiPanelItem, ...extensionNavTopLevelItems]
}

export function isActiveNavItem(itemHref: string, pathname: string) {
  return pathname === itemHref || pathname.startsWith(`${itemHref}/`)
}
