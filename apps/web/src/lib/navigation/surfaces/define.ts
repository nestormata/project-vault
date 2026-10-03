// Story 68.7 AC-1: helpers shared by the surface builders. Every builder allocates a fresh tree per
// call (no shared mutable state) and types its ids as registered `NavId`s.
import type { NavId } from '../nav-registry.js'
import type { NavContexts, NavItem, NavSurfaceId } from '../types.js'

/** A PV item: a registered id, PV children only. */
export type PvItem<C> = Omit<NavItem<C>, 'id' | 'children'> & { id: NavId; children?: PvItem<C>[] }

/** A surface's builder: PV's full tree (visibility conditions are `when`s, applied after a delta). */
export type SurfaceBuilder<S extends NavSurfaceId> = () => PvItem<NavContexts[S]>[]

/** A label that does not depend on the locale or the context. */
export function text(value: string): () => string {
  return () => value
}
