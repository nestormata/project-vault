// Story 68.7 AC-8 (ADR 0007 M5, design §7): the nav delta shapes for UI pack authors. A structural
// twin of PV's own nav model (`apps/web/src/lib/navigation/types.ts` in web-host): the kit (MIT)
// and web-host (AGPL) never import each other; a contract test in each proves the two assign both
// ways. `H` is the internal href type: in a composed app CM's hrefs come from SvelteKit's
// `resolve()` (`ResolvedPathname`), which is what PV's renderers accept.
import type { Component } from 'svelte'

/** An absolute external URL (`kind: 'external'`). */
export type ExternalUrl = `https://${string}` | `http://${string}`

export type NavKind = 'link' | 'action' | 'group' | 'badge-link' | 'external'

/** A label: a function evaluated per render (locale-reactive) or a constant string. */
export type NavLabel<C> = ((ctx: C) => string) | string

export type NavMatch<C> = 'exact' | 'prefix' | ((ctx: C) => boolean)

export interface NavItemFields<C, H extends string = string> {
  /** Default: `action` with `onSelect`, `group` with only children, else `link`. */
  kind?: NavKind
  /** Required, also for an icon-only item: it is the item's accessible name. */
  label: NavLabel<C>
  mobileLabel?: NavLabel<C>
  description?: NavLabel<C>
  title?: NavLabel<C>
  /** `link`/`badge-link`: a same-origin path from `resolve()`; `external`: an absolute URL. */
  href?: (ctx: C) => H | ExternalUrl
  query?: (ctx: C) => string
  match?: NavMatch<C>
  /** Visibility (presentation only: hiding never protects a route). */
  when?: (ctx: C) => boolean
  /** A Svelte component (a string token renders nothing on data items). */
  icon?: Component | string
  shortcut?: string
  onSelect?: (ctx: C) => void | Promise<void>
  children?: NavItem<C, H>[]
}

export interface NavItem<C, H extends string = string> extends NavItemFields<C, H> {
  id: string
}

/** A replacement keeps the target id, so its item carries none. */
export type NavReplacement<C, H extends string = string> = NavItemFields<C, H> & { id?: never }

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

export type NavOp<C, H extends string = string> =
  | ({ op: 'insert'; item: NavItem<C, H> } & NavAnchor)
  | { op: 'remove'; id: string }
  | { op: 'hide'; id: string }
  | { op: 'relabel'; id: string; label: NavLabel<C> | NavLabels<C> }
  | ({ op: 'move'; id: string } & NavAnchor)
  | { op: 'replace'; id: string; item: NavReplacement<C, H> }
  | { op: 'reorder'; parent: string; ids: string[] }

export interface NavUser {
  isPlatformOperator: boolean
  orgRole: string
}

/** The context PV gives each of its surfaces (web-host's `manifests/nav-ids.json` lists every
 * surface and its context keys; a newer web-host may add surfaces this kit does not type yet). */
export interface NavContexts {
  primary: { pathname: string; user: NavUser; hasUiPanelExtension: boolean; search?: () => void }
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

/** A UI pack's nav delta: the operations per surface, applied in array order on top of PV's nav.
 * Known surfaces type their callbacks' context; any other surface key is accepted as well. */
export type NavDelta = {
  readonly [S in keyof NavContexts]?: readonly NavOp<NavContexts[S]>[]
} & { readonly [surface: string]: readonly NavOp<never>[] | undefined }
