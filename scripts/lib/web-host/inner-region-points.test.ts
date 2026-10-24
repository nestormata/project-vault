import { readFileSync } from 'node:fs'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  childrenOf,
  containsPoint,
  parseRegions,
  type Node,
} from '../../../apps/web/guards/region-markup.js'
import { listRouteFiles } from '../route-files.js'
import { buildInjectionPointsManifest } from './injection-points-manifest.js'
import { indexableFile } from './component-index.js'

// Story 69.6 AC-5 (DW-538): what an M4 replacement of a region component does to the region's point.
// PV renders the point of a route-file region as the `children` of the region component (the 69-5
// shape) or beside it. A point that is a CHILD lives and dies with its component: a replacement that
// wraps the original through `pv-original:` and forwards `children` keeps it, a full replacement that
// renders neither drops it. The table below is derived from the real route files, never typed, and the
// kit-shaped replacement tables prove the two outcomes without a Docker stack (the mock UI pack proves
// them end to end, `m3-phase6-region-points.spec.ts`).

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/web')

// Route files are loaded as raw text at transform time (the lint-clean loading pattern, no fs reads).
const ROUTE_TEXT: Record<string, string> = import.meta.glob(
  ['../../../apps/web/src/routes/**/+*.svelte'],
  { query: '?raw', import: 'default', eager: true }
)

interface ReplacementEntry {
  /** The PV file that is shadowed, relative to the app root (`src/lib/...`), as the kit's map holds it. */
  host: string
  /** True when the CM file renders `pv-original:` and forwards `children`. */
  wrapsOriginal: boolean
}

interface InnerRow {
  point: string
  routeFile: string
  /** The region component's `src/lib/...` path (the module M4 replaces). */
  component: string
  relation: 'child' | 'sibling'
}

function componentPath(routeFile: string, node: Node, source: string): string | null {
  const parsed = parseRegions(source, routeFile, { requirePoint: false })
  const binding = node.name?.split('.')[0] ?? ''
  const specifier = parsed.svelteImports.get(binding)
  if (specifier === undefined) return null
  return specifier.startsWith('$lib/')
    ? posix.join('src/lib', specifier.slice('$lib/'.length))
    : posix.join(posix.dirname(routeFile), specifier)
}

function literalName(node: Node): string {
  const value = node.attributes?.find((entry) => entry.name === 'name')?.value
  const text = Array.isArray(value) ? value[0] : value
  return text !== undefined && text !== true && text.type === 'Text' ? (text.data ?? '') : ''
}

function pointNames(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap((child) => pointNames(child))
  if (node === null || typeof node !== 'object') return []
  const record = node as Node
  if (record.type === 'Component' && record.name === 'InjectionPoint') return [literalName(record)]
  return childrenOf(record).flatMap((child) => pointNames(child))
}

function routeSource(rel: string): string {
  const source = Object.entries(ROUTE_TEXT).find(([key]) => key.endsWith(`/apps/web/${rel}`))?.[1]
  if (source === undefined) throw new Error(`route file not loaded: ${rel}`)
  return source
}

/** Every region of a route file whose marked node is a component use, with the relation of its point. */
function innerTable(webRoot: string): InnerRow[] {
  const rows: InnerRow[] = []
  for (const route of listRouteFiles(webRoot).routes) {
    const source = routeSource(route.rel)
    const parsed = parseRegions(source, route.rel, { requirePoint: false })
    for (const region of parsed.regions) {
      if (region.node.type !== 'Component' || !containsPoint(region.node)) continue
      const component = componentPath(route.rel, region.node, source)
      if (component === null || !indexableFile(component)) continue
      const children = (region.node as { fragment?: unknown }).fragment
      const relation = containsPoint(children) ? 'child' : 'sibling'
      for (const point of pointNames(region.node)) {
        rows.push({ point, routeFile: route.rel, component, relation })
      }
    }
  }
  return rows
}

/** What a kit-shaped replacement table does to a point: dropped only when its component is replaced
 * without forwarding the original's children and the point is one of those children. */
function survives(row: InnerRow, table: readonly ReplacementEntry[]): boolean {
  const replaced = table.find((entry) => entry.host === row.component)
  if (replaced === undefined || replaced.wrapsOriginal) return true
  return row.relation !== 'child'
}

const rows = innerTable(WEB)
const byPoint = (name: string): InnerRow => {
  const found = rows.find((row) => row.point === name)
  if (found === undefined) throw new Error(`no region row for ${name}`)
  return found
}

describe('inner region points under an M4 replacement (Story 69.6 AC-5)', () => {
  it('derives a table with real child regions (not an empty or hand-typed list)', () => {
    expect(rows.filter((row) => row.relation === 'child').length).toBeGreaterThan(50)
    expect(byPoint('settings.home.header')).toMatchObject({
      routeFile: 'src/routes/(app)/settings/+page.svelte',
      component: 'src/lib/components/settings/SettingsHomeHeader.svelte',
      relation: 'child',
    })
    expect(byPoint('app.layout.search')).toMatchObject({
      component: 'src/lib/components/shell/AppLayoutSearch.svelte',
      relation: 'child',
    })
  })

  it('positive: a replacement that wraps the original and forwards children keeps the inner point', () => {
    const row = byPoint('settings.home.header')
    expect(survives(row, [{ host: row.component, wrapsOriginal: true }])).toBe(true)
  })

  it('edge: a full replacement drops the inner point, and only that component is affected', () => {
    const header = byPoint('settings.sso-domains.header')
    const panel = byPoint('settings.sso-domains.panel')
    const table = [{ host: header.component, wrapsOriginal: false }]
    expect(survives(header, table)).toBe(false)
    expect(survives(panel, table)).toBe(true)
  })

  it('failure: the manifest still lists a dropped inner point with its host file and routes', () => {
    const header = byPoint('settings.sso-domains.header')
    const { points, problems } = buildInjectionPointsManifest(WEB)
    expect(problems).toEqual([])
    const entry = points.find((point) => point.name === header.point)
    expect(entry).toMatchObject({
      kind: 'region',
      file: header.routeFile,
      hostRoutes: ['/(app)/settings/sso-domains#page'],
    })
  })

  it('every replaceable region component of a route is in the component index (M4 can target it)', () => {
    for (const row of rows) expect(indexableFile(row.component), row.component).toBe(true)
  })

  it('the mock UI pack replaces one region component fully and one through pv-original: (both proven e2e)', () => {
    const manifest = readFileSync(
      resolve(WEB, '../../fixtures/mock-ui-pack/ui-pack/pv-ui.manifest.ts'),
      'utf8'
    )
    expect(manifest).toContain("'$lib/components/settings/SettingsHomeHeader.svelte'")
    expect(manifest).toContain("'$lib/components/settings/SsoDomainsHeader.svelte'")
  })
})

// Story 69.10 (AC-5 users-panel variant): the sub-regions of a split region component. Their points
// are rendered by the sub-region components the region component imports, so a replacement that
// wraps the original through `pv-original:` keeps them and a full replacement drops them; replacing
// one sub-region component drops only its own points. The import closure is derived from the real
// component sources, never typed.
const LIB_TEXT: Record<string, string> = import.meta.glob(
  ['../../../apps/web/src/lib/components/**/*.svelte'],
  { query: '?raw', import: 'default', eager: true }
)

function libSource(rel: string): string | undefined {
  return Object.entries(LIB_TEXT).find(([key]) => key.endsWith(`/apps/web/${rel}`))?.[1]
}

/** The component and every component it imports, transitively (`src/lib/...` paths). */
function closure(rel: string, seen = new Set<string>()): Set<string> {
  if (seen.has(rel)) return seen
  seen.add(rel)
  const source = libSource(rel)
  if (source === undefined) return seen
  const parsed = parseRegions(source, rel, { requirePoint: false })
  for (const specifier of parsed.svelteImports.values()) {
    const next = specifier.startsWith('$lib/')
      ? posix.join('src/lib', specifier.slice('$lib/'.length))
      : specifier.startsWith('.')
        ? posix.join(posix.dirname(rel), specifier)
        : null
    if (next !== null && next.endsWith('.svelte')) closure(next, seen)
  }
  return seen
}

/** A sub-region point survives unless a replaced component (without `pv-original:`) reaches its file. */
function subRegionSurvives(file: string, table: readonly ReplacementEntry[]): boolean {
  return table.every((entry) => entry.wrapsOriginal || !closure(entry.host).has(file))
}

const PANEL = 'src/lib/components/settings/UsersManagementPanel.svelte'
const TABLE_POINT = 'settings.users.table'
const USERS_SUB_POINTS = [
  'settings.users.machine-dormancy',
  'settings.users.user-dormancy',
  'settings.users.default-language',
  TABLE_POINT,
] as const

describe('sub-region points of a split region component under an M4 replacement (Story 69.10)', () => {
  const { points } = buildInjectionPointsManifest(WEB)
  const fileOf = (name: string): string => {
    const entry = points.find((point) => point.name === name)
    if (entry === undefined) throw new Error(`no manifest entry for ${name}`)
    return entry.file
  }

  it('lists every users sub-region point with a host file the panel reaches', () => {
    const reached = closure(PANEL)
    for (const name of USERS_SUB_POINTS) {
      const file = fileOf(name)
      expect(file.startsWith('src/lib/components/settings/Users')).toBe(true)
      expect(reached.has(file), `${name} -> ${file}`).toBe(true)
    }
  })

  it('positive: a pv-original: wrapper around the panel keeps every sub-region point', () => {
    for (const name of USERS_SUB_POINTS) {
      expect(subRegionSurvives(fileOf(name), [{ host: PANEL, wrapsOriginal: true }])).toBe(true)
    }
  })

  it('edge: a full replacement of the panel drops every sub-region point', () => {
    for (const name of USERS_SUB_POINTS) {
      expect(subRegionSurvives(fileOf(name), [{ host: PANEL, wrapsOriginal: false }])).toBe(false)
    }
  })

  it('edge: replacing only the table sub-region drops only the table points', () => {
    const table = [{ host: fileOf(TABLE_POINT), wrapsOriginal: false }]
    expect(subRegionSurvives(fileOf(TABLE_POINT), table)).toBe(false)
    expect(subRegionSurvives(fileOf('settings.users.machine-dormancy'), table)).toBe(true)
    expect(subRegionSurvives(fileOf('settings.users.default-language'), table)).toBe(true)
  })
})
