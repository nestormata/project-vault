// Story 68.7: helpers shared by the nav renderer tests.
import type { ResolvedPathname } from '$app/types'
import type { NavItem } from './types.js'

/** A path as `resolve()` returns it (tests use literal paths with the default base). */
export const path = (value: string): ResolvedPathname => value as ResolvedPathname

/** A CM subtree `depth` levels deep, every level a group except the deepest link. */
export function subtree<C>(prefix: string, depth: number, leafHref: string): NavItem<C> {
  let node: NavItem<C> = {
    id: `${prefix}.l${depth}`,
    label: `L${depth}`,
    href: () => path(leafHref),
  }
  for (let level = depth - 1; level >= 1; level -= 1) {
    node = { id: `${prefix}.l${level}`, label: `L${level}`, children: [node] }
  }
  return node
}

/** The first element matching `selector` under `root`, failing the test when there is none. */
export function one(root: ParentNode, selector: string): Element {
  const found = root.querySelector(selector)
  if (found === null) throw new Error(`no ${selector}`)
  return found
}
