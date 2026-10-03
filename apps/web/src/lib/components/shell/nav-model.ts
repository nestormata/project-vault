import type { ResolvedExtensionNavItem } from '$lib/api/extension-panel.js'
import { renderSurface } from '$lib/navigation/build-surface.js'

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
export function buildExtensionNavTopLevelItems(
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

// Story 68.7 AC-1: a compatibility facade over the `primary` surface's builder (nav as data), with
// the EMPTY delta: the same items, labels and order as before (labels resolve per call, Story 28.4).
// Action items (PV's search button) are not part of this shape. The frozen Story 29.3 `navItems`
// are appended after every PV item exactly as before.
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
  const nodes = renderSurface(
    'primary',
    {
      pathname: '',
      user: { isPlatformOperator: opts.isPlatformOperator, orgRole: '' },
      hasUiPanelExtension: opts.hasUiPanelExtension === true,
    },
    { delta: {} }
  )
  const pvItems = nodes.flatMap((node) =>
    node.href === undefined
      ? []
      : [{ label: node.label, mobileLabel: node.mobileLabel, href: node.href }]
  )

  // Story 29.3 AC10 — manifest-declared navItems are appended AFTER every item above (including
  // the platform-admin and generic ui-panel items), never reordered or merged into them.
  const extensionNavTopLevelItems = buildExtensionNavTopLevelItems(opts.extensionNavItems ?? [])
  return [...pvItems, ...extensionNavTopLevelItems]
}

export function isActiveNavItem(itemHref: string, pathname: string) {
  return pathname === itemHref || pathname.startsWith(`${itemHref}/`)
}
