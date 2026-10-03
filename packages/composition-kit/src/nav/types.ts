// Story 68.7 AC-8 (ADR 0007 M5, design §7): the nav delta shapes for UI pack authors. The kit (MIT)
// and web-host (AGPL) never import each other: these types are a structural twin of web-host's nav
// model, and a contract test on each side proves the two assign both ways. `Href` is the internal
// href type: in a composed app CM's hrefs come from SvelteKit's `resolve()` (`ResolvedPathname`),
// which is what PV's renderers accept.
import type { Component } from 'svelte'

/** A label: a constant string, or a function evaluated per render (locale-reactive). */
export type NavLabel<Ctx> = string | ((ctx: Ctx) => string)

/** How an item matches the current page: a predicate, `exact`, or `prefix` (the default). */
export type NavMatch<Ctx> = ((ctx: Ctx) => boolean) | 'prefix' | 'exact'

/** What an item renders as; omitted: `action` with `onSelect`, `group` with only children, else
 * `link`. */
export type NavKind = 'external' | 'badge-link' | 'group' | 'action' | 'link'

/** An absolute external URL (`kind: 'external'`). */
export type ExternalUrl = `http://${string}` | `https://${string}`

export interface NavItemFields<Ctx, Href extends string = string> {
  /** Required, also for an icon-only item: it is the item's accessible name. */
  label: NavLabel<Ctx>
  kind?: NavKind
  /** `link`/`badge-link`: a same-origin path from `resolve()`; `external`: an absolute URL. */
  href?: (ctx: Ctx) => ExternalUrl | Href
  /** Rendered right after the href (a tab's `?status=all`). */
  query?: (ctx: Ctx) => string
  match?: NavMatch<Ctx>
  /** Visibility (presentation only: hiding never protects a route). */
  when?: (ctx: Ctx) => boolean
  /** `action` items. */
  onSelect?: (ctx: Ctx) => Promise<void> | void
  /** A Svelte component (a string token renders nothing on data items). */
  icon?: string | Component
  description?: NavLabel<Ctx>
  mobileLabel?: NavLabel<Ctx>
  title?: NavLabel<Ctx>
  shortcut?: string
  children?: NavItem<Ctx, Href>[]
}

/** A nav item with its id (the pack's own ids follow PV's grammar; no prefix is required). */
export type NavItem<Ctx, Href extends string = string> = NavItemFields<Ctx, Href> & { id: string }

/** A replacement keeps the target id, so its item carries none. */
export type NavReplacement<Ctx, Href extends string = string> = NavItemFields<Ctx, Href> & {
  id?: never
}

/** Exactly one of `before`, `after` or `parent` (`parent: '<surfaceId>'` is the surface root). */
export interface NavAnchor {
  before?: string
  after?: string
  parent?: string
}

/** The labels `relabel` may change. */
export interface NavLabels<Ctx> {
  description?: NavLabel<Ctx>
  label?: NavLabel<Ctx>
  mobileLabel?: NavLabel<Ctx>
}

type Insert<Ctx, Href extends string> = NavAnchor & { op: 'insert'; item: NavItem<Ctx, Href> }
type Move = NavAnchor & { op: 'move'; id: string }

/** One operation of a nav delta. */
export type NavOp<Ctx, Href extends string = string> =
  | Insert<Ctx, Href>
  | Move
  | { op: 'hide' | 'remove'; id: string }
  | { op: 'replace'; id: string; item: NavReplacement<Ctx, Href> }
  | { op: 'relabel'; id: string; label: NavLabels<Ctx> | NavLabel<Ctx> }
  | { op: 'reorder'; parent: string; ids: string[] }

/** What nav conditions read of the signed-in user. */
export interface NavUser {
  orgRole: string
  isPlatformOperator: boolean
}

type At<Extra = unknown> = Extra & { pathname: string }

/** The context PV gives each surface (web-host's `manifests/nav-ids.json` lists every surface and
 * its context keys; a newer web-host may add surfaces this kit does not type yet). */
export interface NavContexts {
  primary: At<{ user: NavUser; hasUiPanelExtension: boolean; search?: () => void }>
  project: At<{ projectId: string; orgRole: string }>
  account: At<{ user: NavUser }>
  'shell.brand': At<{ hidePrimaryNav: boolean }>
  'shell.utility': At<{ unreadCount: number }>
  'shell.mfa-banner': At<{ bannerMessage: string }>
  'notifications.tabs': At<{ status: string }>
  breadcrumbs: At<{ node: string }>
  back: At<{ projectId: string; credentialId: string }>
  'error.nav': At<{ authenticated: boolean }>
  footer: At
  'settings.index': At
  'platform.index': At
  'platform.settings.links': At
  'settings.audit.links': At
  'auth.links': At
}

/** A UI pack's nav delta: the operations per surface, applied in array order on top of PV's nav.
 * Known surfaces type their callbacks' context; any other surface key is accepted as well. */
export type NavDelta = {
  readonly [Surface in keyof NavContexts]?: readonly NavOp<NavContexts[Surface]>[]
} & { readonly [surface: string]: readonly NavOp<never>[] | undefined }
