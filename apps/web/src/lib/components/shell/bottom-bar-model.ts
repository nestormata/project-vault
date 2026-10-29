// Story 72.7 (P3b): the bottom bar's model. The bar renders the SAME `primary` nav data as the
// header and the rail: this function only decides which entries sit in the bar and which move into
// "More". It reads no nav ids, so a host's nav delta (hide, move, insert) reshapes the bar by itself.
import type { ResolvedPathname } from '$app/types'
import type { PrimaryNavItem } from './nav-model.js'
import { isActiveNavItem } from './nav-model.js'
import { BOTTOM_BAR_LINKS } from './shell-variant.js'
import type { NavNode } from '$lib/navigation/types.js'

export interface BottomBarModel {
  /** Internal links shown in the bar itself, in nav order. */
  bar: NavNode[]
  /** Everything else, in nav order: remaining links, external links, actions (Search). */
  more: NavNode[]
  /** An overflowed entry is the current page, so the trigger is marked current. */
  moreCurrent: boolean
}

// A node with children contributes its own link (when it has one) and then its descendants, so a
// section label or disclosure never hides its items on a phone. A group with no link of its own
// contributes only its children.
function flatten(node: NavNode): NavNode[] {
  if (node.children.length === 0) return node.kind === 'group' ? [] : [node]
  const own =
    node.href !== undefined || node.external !== undefined ? [{ ...node, children: [] }] : []
  return [...own, ...node.children.flatMap(flatten)]
}

/** The frozen Story 29.3 extension `navItems` as nodes, so they flow through the same model. */
export function legacyNavNodes(items: PrimaryNavItem[], pathname: string): NavNode[] {
  const toNode = (item: PrimaryNavItem, id: string, children: NavNode[]): NavNode => {
    const active = isActiveNavItem(item.href, pathname)
    return {
      id,
      kind: 'link',
      label: item.label,
      mobileLabel: item.mobileLabel,
      description: '',
      title: '',
      // Runtime strings validated by NAV_ITEM_HREF_PATTERN at registration, not members of the
      // generated Pathname union (same provenance as the cast-free `resolve()` calls in PrimaryNav).
      href: item.href as ResolvedPathname,
      query: '',
      active,
      current: active || children.some((child) => child.current),
      shortcut: '',
      children,
    }
  }
  return items.map((item, index) =>
    toNode(
      item,
      `legacy.${index}`,
      (item.children ?? []).map((child, childIndex) =>
        toNode(child, `legacy.${index}.${childIndex}`, [])
      )
    )
  )
}

export function buildBottomBarModel(
  nodes: NavNode[],
  max: number = BOTTOM_BAR_LINKS
): BottomBarModel {
  const leaves = nodes.flatMap(flatten)
  const bar = leaves
    .filter((node) => node.href !== undefined && node.external === undefined)
    .slice(0, max)
  const more = leaves.filter((node) => !bar.includes(node))
  return { bar, more, moreCurrent: more.some((node) => node.active || node.current) }
}
