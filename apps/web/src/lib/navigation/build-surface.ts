// Story 68.7 AC-1/AC-2/AC-5/AC-6/AC-7 (design §7): one code path for PV's build and a composed
// build. `buildSurface` takes PV's full tree for a surface, applies the delta's ops for it (the
// active delta from `virtual:pv-nav` unless one is given), then the visibility conditions.
// `renderSurface` evaluates the visible items for one render: labels (per render, so locale
// switches follow), hrefs, active state and handlers.
//
// The build is the gate; runtime is total (Q7). In production a bad op or a throwing callback costs
// only that op or item and the page still renders; in dev (`import.meta.env.DEV`) the first render
// throws with every problem or the failing item's id, so CM sees it immediately.
import type { ResolvedPathname } from '$app/types'
import { activeDelta } from './active-delta.js'
import { applyNavDelta, kindOf, visibleItems, type TreeItem } from './apply-delta.js'
import { surfaceOfNavId } from './nav-registry.js'
import { surfaceItems } from './surfaces/index.js'
import type {
  ExternalUrl,
  NavContexts,
  NavDelta,
  NavItem,
  NavLabel,
  NavNode,
  NavOp,
  NavSurfaceId,
} from './types.js'

export interface BuiltSurface<C> {
  /** The full delta-applied tree (hidden nodes flagged; `when` not yet applied). */
  items: TreeItem<C>[]
  /** What renders: hidden nodes, false `when`s and emptied groups removed. */
  visible: NavItem<C>[]
  problems: string[]
  notes: string[]
}

export interface RenderOptions {
  delta?: NavDelta
  /** Throw on any problem (default: `import.meta.env.DEV`). */
  strict?: boolean
}

function opsFor<S extends NavSurfaceId>(
  delta: NavDelta,
  surface: S
): readonly NavOp<NavContexts[S]>[] {
  // An own property only: a delta key such as `__proto__` never reaches a prototype.
  const ops: NavDelta[S] = Object.getOwnPropertyDescriptor(delta, surface)?.value
  return ops ?? []
}

export function buildSurface<S extends NavSurfaceId>(
  surface: S,
  ctx: NavContexts[S],
  delta: NavDelta = activeDelta,
  onError?: (id: string, error: unknown) => void
): BuiltSurface<NavContexts[S]> {
  const pvItems: NavItem<NavContexts[S]>[] = surfaceItems(surface)
  const applied = applyNavDelta(surface, pvItems, opsFor(delta, surface), {
    ownerOf: surfaceOfNavId,
  })
  return { ...applied, visible: visibleItems(applied.items, ctx, onError) }
}

class NavItemError extends Error {}

function textOf<C>(label: NavLabel<C> | undefined, ctx: C): string {
  const value = typeof label === 'function' ? label(ctx) : (label ?? '')
  if (typeof value !== 'string') throw new NavItemError('a label must be a string')
  return value
}

const ABSOLUTE = /^(https?):\/\/(.+)$/

function externalOf(href: string): NavNode['external'] {
  const match = ABSOLUTE.exec(href)
  if (match === null) {
    throw new NavItemError(
      `an external href must be an absolute http(s) URL, got ${JSON.stringify(href)}`
    )
  }
  return { scheme: match[1] === 'http' ? 'http' : 'https', rest: match[2] ?? '' }
}

/** `link`/`badge-link` mean "inside this app": a same-origin path, never `//host` or a scheme. */
function isSameOriginPath(href: string): href is ResolvedPathname {
  return href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\')
}

function hrefFields<C>(
  item: NavItem<C>,
  kind: NavNode['kind'],
  ctx: C
): Pick<NavNode, 'href' | 'external'> {
  if (item.href === undefined) return {}
  const href: ResolvedPathname | ExternalUrl | string = item.href(ctx)
  if (kind === 'external') return { external: externalOf(href) }
  if (!isSameOriginPath(href)) {
    throw new NavItemError(
      `a link href must be a same-origin path (starting with one "/"); use kind "external" for an absolute URL, got ${JSON.stringify(href)}`
    )
  }
  return { href }
}

function isActive<C>(
  item: NavItem<C>,
  href: string | undefined,
  ctx: C & { pathname: string }
): boolean {
  if (typeof item.match === 'function') return item.match(ctx)
  if (href === undefined) return false
  if (item.match === 'exact') return ctx.pathname === href
  return ctx.pathname === href || ctx.pathname.startsWith(`${href}/`)
}

function evaluate<C extends { pathname: string }>(
  item: NavItem<C>,
  ctx: C,
  children: NavNode[]
): NavNode {
  const kind = kindOf(item)
  const links = hrefFields(item, kind, ctx)
  const label = textOf(item.label, ctx)
  const active = isActive(item, links.href, ctx)
  const handler = item.onSelect
  return {
    id: item.id,
    kind,
    label,
    mobileLabel: item.mobileLabel === undefined ? label : textOf(item.mobileLabel, ctx),
    description: textOf(item.description, ctx),
    title: textOf(item.title, ctx),
    ...links,
    query: item.query === undefined ? '' : item.query(ctx),
    active,
    current: active || children.some((child) => child.current),
    ...(typeof item.icon === 'function' ? { icon: item.icon } : {}),
    shortcut: item.shortcut ?? '',
    ...(handler === undefined ? {} : { onSelect: () => handler(ctx) }),
    children,
  }
}

function render<C extends { pathname: string }>(
  items: readonly NavItem<C>[],
  ctx: C,
  fail: (id: string, error: unknown) => void
): NavNode[] {
  return items.flatMap((item) => {
    try {
      return [evaluate(item, ctx, render(item.children ?? [], ctx, fail))]
    } catch (error) {
      fail(item.id, error)
      return []
    }
  })
}

function itemError(id: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`nav item "${id}": ${message}`, { cause: error })
}

/** The visible items of a surface, evaluated for this render. */
export function renderSurface<S extends NavSurfaceId>(
  surface: S,
  ctx: NavContexts[S],
  options: RenderOptions = {}
): NavNode[] {
  const strict = options.strict ?? import.meta.env.DEV
  const fail = (id: string, error: unknown): void => {
    if (strict) throw itemError(id, error)
  }
  const built = buildSurface(surface, ctx, options.delta ?? activeDelta, fail)
  if (strict && built.problems.length > 0) {
    throw new Error(
      `nav delta problems in surface "${surface}":\n${built.problems.map((p) => `  - ${p}`).join('\n')}`
    )
  }
  return render(built.visible, ctx, fail)
}

/** The node with `id` anywhere in a rendered tree, and the path of nodes from the root to it. */
export function findNodePath(nodes: readonly NavNode[], id: string): NavNode[] | undefined {
  for (const node of nodes) {
    if (node.id === id) return [node]
    const below = findNodePath(node.children, id)
    if (below !== undefined) return [node, ...below]
  }
  return undefined
}
