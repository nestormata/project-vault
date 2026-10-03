// Story 68.7 AC-8: `@project-vault/composition-kit/nav` (MIT, zero runtime dependencies). The
// operation builders only build plain objects: integrity is validated by PV at compose time and
// by web-host's shipped composed-nav test in CI. Nothing here limits a pack: any PV
// nav item may be changed, hidden, removed, moved or replaced, and CM items go anywhere.
import type {
  NavAnchor,
  NavDelta,
  NavItem,
  NavLabel,
  NavLabels,
  NavOp,
  NavReplacement,
} from './types.js'

export type * from './types.js'

/** Inserts `item` after/before a sibling, or as the last child of `parent` (`parent: '<surface>'`
 * is the surface root). */
export function insert<C, H extends string = string>(
  spec: NavAnchor & { item: NavItem<C, H> }
): NavOp<C, H> {
  return { op: 'insert', ...spec }
}

/** Removes an item and its subtree (absent: a note, the desired state already holds). */
export function remove(id: string): { op: 'remove'; id: string } {
  return { op: 'remove', id }
}

/** Hides an item and its subtree; it stays an anchor for other operations. */
export function hide(id: string): { op: 'hide'; id: string } {
  return { op: 'hide', id }
}

/** Replaces the named labels only (a function is evaluated per render; a string is constant). */
export function relabel<C>(id: string, label: NavLabel<C> | NavLabels<C>): NavOp<C> {
  return { op: 'relabel', id, label }
}

/** Moves an item (with its subtree) after/before a sibling or under a new parent. */
export function move(id: string, anchor: NavAnchor): { op: 'move'; id: string } & NavAnchor {
  return { op: 'move', id, ...anchor }
}

/** Replaces an item's content; it keeps its id, and PV's children and visibility condition unless
 * the replacement declares `children` / `when`. */
export function replace<C, H extends string = string>(
  id: string,
  item: NavReplacement<C, H>
): NavOp<C, H> {
  return { op: 'replace', id, item }
}

/** Puts the listed children of `parent` first, in this order; the others (including PV items
 * added later) keep their relative order after them. */
export function reorder(
  parent: string,
  ids: string[]
): { op: 'reorder'; parent: string; ids: string[] } {
  return { op: 'reorder', parent, ids }
}

/** The default export of a UI pack's `nav.ts` (identity; it types the delta). */
export function defineNavDelta<D extends NavDelta>(delta: D): D {
  return delta
}
