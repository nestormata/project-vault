// Story 68.7 AC-1 (ADR 0007 M5, design §7): the one registry of PV's nav surfaces and every PV nav
// item id. Pure data with no imports, so `pnpm pack:web-host` loads it with tsx (no tsconfig) to
// write `manifests/nav-ids.json`, and `check-nav-ids` reads it with the TypeScript parser.
//
// Ids are a public contract that names meaning, not position or path: `primary.secrets` keeps its
// id when its href or label changes. PV never renames an id (a rename is a removal plus an
// addition, listed in web-host's CHANGELOG under "Nav ids removed"). Adding a surface or an item is
// a PV change: declare it here, then emit it from the surface's builder (a test ties both ways).
// `conditional` marks a PV item with a visibility condition (`when`), applied after any delta.
//
// Nothing here limits a composed app: CM may change, hide, remove, move or replace ANY of these
// items and add its own anywhere (no allowlist, no required prefix for CM ids).

/** One node of a surface's PV tree as the registry declares it. */
export interface NavIdNode {
  readonly id: string
  readonly conditional?: boolean
  readonly children?: readonly NavIdNode[]
}

/** A surface: its root id, the renderer that owns its markup, the context its items read. */
export interface NavSurfaceDef {
  readonly id: string
  readonly file: string
  readonly contextKeys: readonly string[]
  readonly items: readonly NavIdNode[]
}

export interface NavSurfaceRecord {
  id: string
  file: string
  contextKeys: readonly string[]
}

export interface NavIdRecord {
  id: string
  surface: string
  parent: string | null
  conditional: boolean
}

const PRIMARY = {
  id: 'primary',
  file: 'src/lib/components/shell/PrimaryNav.svelte',
  contextKeys: ['user', 'hasUiPanelExtension', 'pathname'],
  items: [
    { id: 'primary.search' },
    { id: 'primary.dashboard' },
    { id: 'primary.projects' },
    { id: 'primary.secrets' },
    { id: 'primary.notifications' },
    { id: 'primary.health' },
    { id: 'primary.settings' },
    { id: 'primary.platform', conditional: true },
    { id: 'primary.extension-panel', conditional: true },
  ],
} as const satisfies NavSurfaceDef

const PROJECT = {
  id: 'project',
  file: 'src/lib/components/shell/ProjectNav.svelte',
  contextKeys: ['projectId', 'orgRole', 'pathname'],
  items: [
    { id: 'project.overview' },
    { id: 'project.secrets' },
    { id: 'project.members' },
    { id: 'project.machine-users' },
    { id: 'project.services' },
    { id: 'project.certificates' },
    { id: 'project.domains' },
    { id: 'project.endpoints', conditional: true },
    { id: 'project.status-page' },
  ],
} as const satisfies NavSurfaceDef

const SHELL = [
  {
    id: 'shell.brand',
    file: 'src/lib/components/shell/ShellBrand.svelte',
    contextKeys: ['hidePrimaryNav'],
    items: [{ id: 'shell.brand.home' }],
  },
  {
    id: 'shell.utility',
    file: 'src/lib/components/shell/NotificationsLink.svelte',
    contextKeys: ['unreadCount', 'pathname'],
    items: [{ id: 'shell.utility.notifications' }],
  },
  {
    id: 'shell.mfa-banner',
    file: 'src/lib/components/shell/AppShell.svelte',
    contextKeys: ['bannerMessage'],
    items: [{ id: 'shell.mfa-banner.security' }],
  },
  {
    id: 'account',
    file: 'src/lib/components/shell/ShellAccount.svelte',
    contextKeys: ['user'],
    items: [{ id: 'account.sign-out' }],
  },
  {
    id: 'footer',
    file: 'src/lib/components/shell/Footer.svelte',
    contextKeys: [],
    items: [{ id: 'footer.github' }, { id: 'footer.license' }],
  },
] as const satisfies readonly NavSurfaceDef[]

const INDEXES = [
  {
    id: 'settings.index',
    file: 'src/lib/navigation/NavCards.svelte',
    contextKeys: [],
    items: [
      { id: 'settings.index.notifications' },
      { id: 'settings.index.users' },
      { id: 'settings.index.security' },
      { id: 'settings.index.language' },
      { id: 'settings.index.themes' },
      { id: 'settings.index.audit' },
      { id: 'settings.index.extensions' },
      { id: 'settings.index.sso-domains' },
      { id: 'settings.index.external-identities' },
    ],
  },
  {
    id: 'platform.index',
    file: 'src/lib/navigation/NavCards.svelte',
    contextKeys: [],
    items: [
      { id: 'platform.index.backups' },
      { id: 'platform.index.settings' },
      { id: 'platform.index.upgrade' },
      { id: 'platform.index.audit' },
    ],
  },
  {
    id: 'platform.settings.links',
    file: 'src/lib/navigation/NavLinkRow.svelte',
    contextKeys: [],
    items: [
      { id: 'platform.settings.links.orgs' },
      { id: 'platform.settings.links.resource-usage' },
    ],
  },
  {
    id: 'settings.audit.links',
    file: 'src/lib/navigation/NavLinkRow.svelte',
    contextKeys: [],
    items: [
      { id: 'settings.audit.links.access-report' },
      { id: 'settings.audit.links.forwarding' },
    ],
  },
  {
    id: 'notifications.tabs',
    file: 'src/lib/navigation/NavTabs.svelte',
    contextKeys: ['status'],
    items: [
      { id: 'notifications.tabs.all' },
      { id: 'notifications.tabs.unread' },
      { id: 'notifications.tabs.read' },
    ],
  },
] as const satisfies readonly NavSurfaceDef[]

const BREADCRUMBS = {
  id: 'breadcrumbs',
  file: 'src/lib/navigation/Breadcrumbs.svelte',
  contextKeys: ['node'],
  items: [
    {
      id: 'breadcrumbs.platform',
      children: [
        {
          id: 'breadcrumbs.platform.settings',
          children: [
            { id: 'breadcrumbs.platform.settings.orgs' },
            { id: 'breadcrumbs.platform.settings.resource-usage' },
          ],
        },
        { id: 'breadcrumbs.platform.backups' },
        { id: 'breadcrumbs.platform.upgrade' },
        { id: 'breadcrumbs.platform.audit' },
      ],
    },
  ],
} as const satisfies NavSurfaceDef

const WAYFINDING = [
  {
    id: 'back',
    file: 'src/lib/navigation/NavLink.svelte',
    contextKeys: ['projectId', 'credentialId'],
    items: [
      { id: 'back.settings.security' },
      { id: 'back.settings.language' },
      { id: 'back.settings.themes' },
      { id: 'back.settings.notifications' },
      { id: 'back.settings.audit.access-report' },
      { id: 'back.settings.audit.forwarding' },
      { id: 'back.settings.users.erasure' },
      { id: 'back.project.machine-users' },
      { id: 'back.project.credentials.import' },
      { id: 'back.project.credential' },
      { id: 'back.project.machine-user' },
      { id: 'back.project.rotation' },
      { id: 'back.project.service-endpoint' },
      { id: 'back.project.service' },
      { id: 'back.project.certificate' },
      { id: 'back.project.domain' },
    ],
  },
  {
    id: 'error.nav',
    file: 'src/routes/+error.svelte',
    contextKeys: ['authenticated'],
    items: [{ id: 'error.nav.back' }],
  },
  {
    id: 'auth.links',
    file: 'src/lib/navigation/NavLink.svelte',
    contextKeys: [],
    items: [
      { id: 'auth.links.login.register' },
      { id: 'auth.links.login.recovery' },
      { id: 'auth.links.register.login' },
      { id: 'auth.links.recovery.login' },
    ],
  },
] as const satisfies readonly NavSurfaceDef[]

/** Every surface with its PV tree, in inventory order (S1-S16). */
export const NAV_SURFACE_DEFS = [
  PRIMARY,
  PROJECT,
  ...SHELL,
  ...INDEXES,
  BREADCRUMBS,
  ...WAYFINDING,
] as const satisfies readonly NavSurfaceDef[]

type NodeIds<N> = N extends { readonly id: infer I; readonly children: readonly (infer C)[] }
  ? I | NodeIds<C>
  : N extends { readonly id: infer I }
    ? I
    : never

/** A registered surface id. */
export type SurfaceId = (typeof NAV_SURFACE_DEFS)[number]['id']
/** A registered PV nav item id. */
export type NavId = NodeIds<(typeof NAV_SURFACE_DEFS)[number]['items'][number]>

function flatten(
  surface: string,
  nodes: readonly NavIdNode[],
  parent: string | null
): NavIdRecord[] {
  return nodes.flatMap((node) => [
    { id: node.id, surface, parent, conditional: node.conditional === true },
    ...flatten(surface, node.children ?? [], node.id),
  ])
}

export const NAV_SURFACES: readonly (NavSurfaceRecord & { id: SurfaceId })[] = NAV_SURFACE_DEFS.map(
  ({ id, file, contextKeys }) => ({ id, file, contextKeys })
)

export const NAV_IDS: readonly NavIdRecord[] = NAV_SURFACE_DEFS.flatMap((surface) =>
  flatten(surface.id, surface.items, null)
)

/** Keys that would reach `Object.prototype` if an id were used as a plain-object key. */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
])

function isLowerAlnum(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57)
}

/** One dot-separated segment: `[a-z0-9]+(-[a-z0-9]+)*`, checked in one linear pass. */
function isSegment(segment: string): boolean {
  if (segment.length === 0 || RESERVED_SEGMENTS.has(segment)) return false
  let previousHyphen = true
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index)
    const hyphen = code === 45
    if (hyphen ? previousHyphen : !isLowerAlnum(code)) return false
    previousHyphen = hyphen
  }
  return !previousHyphen
}

/** The id grammar (design §7): lowercase alphanumeric words joined by `-`, segments joined by `.`.
 * A linear helper, never a nested-quantifier regex. Applies to PV and CM ids alike (CM ids carry no
 * required prefix). */
export function isNavId(value: unknown): value is string {
  return typeof value === 'string' && value.split('.').every(isSegment)
}

export function navIdProblems(value: unknown): string[] {
  if (typeof value !== 'string') return ['nav id must be a string']
  return isNavId(value) ? [] : [`nav id "${value}" breaks the id grammar`]
}

function recordProblems(
  entry: NavIdRecord,
  surfaces: ReadonlySet<string>,
  ids: ReadonlySet<string>
): string[] {
  if (!isNavId(entry.id)) return [`nav id "${entry.id}" breaks the id grammar`]
  if (!surfaces.has(entry.surface)) {
    return [`nav id "${entry.id}" names an unknown surface "${entry.surface}"`]
  }
  if (!entry.id.startsWith(`${entry.surface}.`)) {
    return [`nav id "${entry.id}" must start with its surface id "${entry.surface}."`]
  }
  if (entry.parent !== null && !ids.has(entry.parent)) {
    return [`nav id "${entry.id}" names a missing parent "${entry.parent}"`]
  }
  return []
}

/** Integrity of a registry (used by the registry test and the `check-nav-ids` guard): grammar,
 * surface prefixes, unique ids across every surface, existing parents. Never an allowlist. */
export function registryProblems(
  surfaces: readonly NavSurfaceRecord[],
  ids: readonly NavIdRecord[]
): string[] {
  const surfaceIds = new Set(surfaces.map((surface) => surface.id))
  const known = new Set(ids.map((entry) => entry.id))
  const seen = new Set<string>()
  const problems: string[] = []
  for (const surface of surfaces) {
    if (!isNavId(surface.id)) problems.push(`surface id "${surface.id}" breaks the id grammar`)
  }
  for (const entry of ids) {
    if (seen.has(entry.id)) {
      problems.push(`nav id "${entry.id}" is declared twice`)
      continue
    }
    seen.add(entry.id)
    problems.push(...recordProblems(entry, surfaceIds, known))
  }
  return problems
}

/** The surface that owns a PV id, if any. */
export function surfaceOfNavId(id: string): string | undefined {
  return NAV_IDS.find((entry) => entry.id === id)?.surface
}
