// Story 68.7 AC-2 (ADR 0007 M5, design §7): the nav data model. Client-safe (nav renders in the
// browser too): no server imports. Every surface accepts `children` at any depth; there is no depth
// cap anywhere. The kit's `@project-vault/composition-kit/nav` declares the same shapes
// structurally (the two never import each other; contract tests prove assignability both ways).
import type { ResolvedPathname } from '$app/types'
import type { Component } from 'svelte'

/** An absolute external URL (`kind: 'external'`, rendered with `target`/`rel` like the footer). */
export type ExternalUrl = `https://${string}` | `http://${string}`

export type NavKind = 'link' | 'action' | 'group' | 'badge-link' | 'external'

/** A label: evaluated per render (locale-reactive). A plain string is accepted and rendered as is
 * in every locale (normalized to a constant function). */
export type NavLabel<C> = ((ctx: C) => string) | string

/** How an item matches the current page: `exact`, `prefix` (the default: the path or a path below
 * it) or a predicate. */
export type NavMatch<C> = 'exact' | 'prefix' | ((ctx: C) => boolean)

/** The fields of a nav item (everything but its id). */
export interface NavItemFields<C> {
  /** Default: `action` with `onSelect`, `group` with only children, else `link`. */
  kind?: NavKind
  /** Required, also for an icon-only item: it is the item's accessible name. */
  label: NavLabel<C>
  /** The primary nav's narrow-screen label. */
  mobileLabel?: NavLabel<C>
  /** An index card's second line. */
  description?: NavLabel<C>
  /** A tooltip and accessible name for an icon-only action (PV's search button). */
  title?: NavLabel<C>
  /** `link`/`badge-link`: a same-origin path from `resolve()`; `external`: an absolute URL. */
  href?: (ctx: C) => ResolvedPathname | ExternalUrl
  /** Rendered right after the href (a tab bar's `?status=all`). */
  query?: (ctx: C) => string
  match?: NavMatch<C>
  /** A PV (or CM) visibility condition, evaluated AFTER the delta. Presentation only: hiding an
   * item never protects its route (that is protected paths and the API's authorization). */
  when?: (ctx: C) => boolean
  /** A Svelte component rendered as the item's icon (CM icons are ordinary components). */
  icon?: Component | string
  /** A keyboard shortcut hint shown next to an action (PV's search: ⌘K). */
  shortcut?: string
  /** `action` items: what selecting the item does. */
  onSelect?: (ctx: C) => void | Promise<void>
  children?: NavItem<C>[]
}

export interface NavItem<C> extends NavItemFields<C> {
  id: string
}

/** A replacement keeps the target id (Q5), so its item carries none. */
export type NavReplacement<C> = NavItemFields<C> & { id?: never }

export interface NavLabels<C> {
  label?: NavLabel<C>
  mobileLabel?: NavLabel<C>
  description?: NavLabel<C>
}

/** Exactly one of `after`, `before` or `parent` (`parent: '<surfaceId>'` is the surface root). */
export interface NavAnchor {
  after?: string
  before?: string
  parent?: string
}

export type NavOp<C> =
  | ({ op: 'insert'; item: NavItem<C> } & NavAnchor)
  | { op: 'remove'; id: string }
  | { op: 'hide'; id: string }
  | { op: 'relabel'; id: string; label: NavLabel<C> | NavLabels<C> }
  | ({ op: 'move'; id: string } & NavAnchor)
  | { op: 'replace'; id: string; item: NavReplacement<C> }
  | { op: 'reorder'; parent: string; ids: string[] }

/** The user fields nav conditions read (structurally satisfied by `AuthUser`). */
export interface NavUser {
  isPlatformOperator: boolean
  orgRole: string
}

/** The context each surface's items receive. Every surface knows the current `pathname`. */
export interface NavContexts {
  primary: {
    pathname: string
    user: NavUser
    hasUiPanelExtension: boolean
    /** Opens PV's global search (the `primary.search` action). */
    search?: () => void
  }
  project: { pathname: string; projectId: string; orgRole: string }
  'shell.brand': { pathname: string; hidePrimaryNav: boolean }
  'shell.utility': { pathname: string; unreadCount: number }
  'shell.mfa-banner': { pathname: string; bannerMessage: string }
  account: { pathname: string; user: NavUser }
  footer: { pathname: string }
  'settings.index': { pathname: string }
  'platform.index': { pathname: string }
  'platform.settings.links': { pathname: string }
  'settings.audit.links': { pathname: string }
  'notifications.tabs': { pathname: string; status: string }
  breadcrumbs: { pathname: string; node: string }
  back: { pathname: string; projectId: string; credentialId: string }
  'error.nav': { pathname: string; authenticated: boolean }
  'auth.links': { pathname: string }
}

export type NavSurfaceId = keyof NavContexts

/** CM's nav delta (the default export of its `nav.ts`, delivered through `virtual:pv-nav`): the
 * operations per surface, applied in array order on top of PV's nav. */
export type NavDelta = { readonly [S in NavSurfaceId]?: readonly NavOp<NavContexts[S]>[] }

/** An evaluated item, ready for a renderer (labels and hrefs resolved for this render). */
export interface NavNode {
  id: string
  kind: NavKind
  label: string
  mobileLabel: string
  description: string
  title: string
  href?: ResolvedPathname
  external?: { scheme: 'https' | 'http'; rest: string }
  query: string
  /** The item itself matches the current page. */
  active: boolean
  /** The item or one of its descendants matches the current page. */
  current: boolean
  icon?: Component
  shortcut: string
  onSelect?: () => void | Promise<void>
  children: NavNode[]
}
