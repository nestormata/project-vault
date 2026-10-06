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
