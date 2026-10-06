// Story 69.5 AC-1 / AC-9: the route-region audit (library). For every route file under
// `<webRoot>/src/routes` it lists the `@region` blocks that make up the page, including regions that
// live in the `$lib` components the page imports (directly or through other components), with the
// registered point, the component that holds the region's markup and line counts that make
// "wrapper theatre" (a region holding a whole page body) visible. The table is derived from the tree
// on every run, never read back from a story file. Markup is read with `svelte/compiler`, never with
// a regex over source text; the census is `scripts/lib/route-files.ts` (the same list the 68-4
// coverage guard uses). There is no skip list and no owner exemption: a route file with no region is
// MISSING whoever owns it.
import { dirname, join, posix } from 'node:path'
import {
  newScanContext,
  scanMonolithicRegions,
  type ScanContext,
  type TopLevelUse,
} from '../../apps/web/guards/monolithic-region.js'
import { childrenOf, lineAt, parseRegions, type Node } from '../../apps/web/guards/region-markup.js'
import { readRegistry } from './injection-point-coverage.js'
import { censusProblem, listRouteFiles, ROUTES_DIR, type RouteKind } from './route-files.js'
import { readOverlayFile, toRepoPath, walkFiles } from './scan-utils.js'

const COMPONENT_DIR = 'src/lib/components/'
const RESET_NAME = /^\+(page|layout|error)@.*\.svelte$/
const STABLE_MARKER = '@pv-stable'
/** Story 69.6 Q1/AC-4: a region component longer than this holds more than one section, and a CM
 * author cannot inject between its sections until each becomes a sub-region component. */
export const MAX_REGION_COMPONENT_LINES = 60
/**
 * The single, explicit sequencing switch for the OVERSIZE finding (Nestor's Story 69.6 Q1 decision,
 * 2026-10-05: the decomposition of the 38 region components is split into follow-up stories). While it
 * is `false` an OVERSIZE region is printed and counted but is not a problem. Follow-up stories
 * 69-10, 69-11 and 69-12 split the components in batches; the last one flips this to `true`. It is a
 * switch for the whole rule, never a list of component names: no component is exempt by name.
 */
export const OVERSIZE_ENFORCEMENT = false
export const OVERSIZE_FOLLOW_UP_STORIES = ['69-10', '69-11', '69-12'] as const

export type AuditStatus = 'done' | 'MISSING' | 'UNPARSEABLE' | 'OVERSIZE'

export interface AuditRow {
  file: string
  scope: RouteKind
  region: string
  /** App-relative path of the component that holds the region's markup ('' when it has none). */
  component: string
  point: string
  /** Lines the region's own node spans in the file that carries the marker. */
  inlineLines: number
  /** Non-blank template lines of the component file. */
  componentLines: number
  stableCandidate: 'no' | 'marked'
  status: AuditStatus
}

/** One top-level component use of a route file (a marked region, a use of a component that hosts
 * its own region, or an UNCOVERED use). */
export interface UseRow extends TopLevelUse {
  file: string
}

export interface AuditOptions {
  /** Defaults to `OVERSIZE_ENFORCEMENT`; tests set it to prove both modes. */
  enforceOversize?: boolean
}

export interface AuditResult {
  rows: AuditRow[]
  /** One message per OVERSIZE region (a problem only when enforcement is on). */
  oversize: string[]
  /** Every top-level use of every route file; the listing AC-1 asks for. */
  uses: UseRow[]
  problems: string[]
  routeFiles: number
}

interface FoundRegion {
  host: string
  name: string
  line: number
  node: Node
  imports: ReadonlyMap<string, string>
  code: string
}

/** `$lib/x.svelte` and `./x.svelte` to an app-relative path; anything else (packages) is left out. */
function resolveImport(from: string, source: string): string | null {
  if (source.startsWith('$lib/')) return posix.join('src/lib', source.slice('$lib/'.length))
  if (source.startsWith('./') || source.startsWith('../')) return posix.join(dirname(from), source)
  return null
}

/** The first node (depth-first, source order) the picker maps to a non-empty string. */
function firstMatch(node: unknown, pick: (node: Node) => string): string {
  if (node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) {
    return node.map((child) => firstMatch(child, pick)).find((found) => found !== '') ?? ''
  }
  const own = pick(node as Node)
  return own !== '' ? own : firstMatch(childrenOf(node as Node), pick)
}

function literalText(value: Node | Node[] | true | undefined): string {
  const first = Array.isArray(value) ? value[0] : value
  return first !== undefined && first !== true && first.type === 'Text' ? (first.data ?? '') : ''
}

function pointNameOf(node: Node): string {
  if (node.type !== 'Component' || node.name !== 'InjectionPoint') return ''
  return literalText((node.attributes ?? []).find((entry) => entry.name === 'name')?.value)
}

function usedComponentOf(
  host: string,
  imports: ReadonlyMap<string, string>
): (node: Node) => string {
  return (node) => {
    if (node.type !== 'Component' || node.name === undefined) return ''
    const source = imports.get(node.name.split('.')[0] ?? '')
    const resolved = source === undefined ? null : resolveImport(host, source)
    return resolved === null || resolved.endsWith('/InjectionPoint.svelte') ? '' : resolved
  }
}

function templateLines(code: string): number {
  const end = code.lastIndexOf('</script>')
  const body = end === -1 ? code : code.slice(end + '</script>'.length)
  return body.split('\n').filter((line) => line.trim() !== '').length
}

function readCode(webRoot: string, rel: string): string | null {
  return readOverlayFile(webRoot, rel) ?? null
}

interface Reach {
  regions: FoundRegion[]
  unparseable: { file: string; reason: string }[]
}

/** The regions of a route file and of every `.svelte` it imports (transitively, once each). */
function reachRegions(webRoot: string, entry: string): Reach {
  const reach: Reach = { regions: [], unparseable: [] }
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const rel = queue.shift() as string
    if (seen.has(rel)) continue
    seen.add(rel)
    const code = readCode(webRoot, rel)
    if (code === null) continue
    let parsed
    try {
      parsed = parseRegions(code, rel, { requirePoint: false })
    } catch (error) {
      reach.unparseable.push({ file: rel, reason: (error as Error).message.split('\n')[0] ?? '' })
      continue
    }
    for (const region of parsed.regions) {
      reach.regions.push({ ...region, host: rel, imports: parsed.svelteImports, code })
    }
    for (const source of parsed.svelteImports.values()) {
      const resolved = resolveImport(rel, source)
      if (resolved !== null && !resolved.endsWith('/InjectionPoint.svelte')) queue.push(resolved)
    }
  }
  return reach
}

function useProblems(route: { rel: string }, use: UseRow): string[] {
  if (use.status === 'covered') return []
  const where = `${route.rel}:${use.line}`
  const hint = 'wrap it in a region component with a registered point'
  return [
    use.kind === 'render'
      ? `${where}: render-only top-level ${use.use} is UNCOVERED (${hint})`
      : `${where}: top-level use ${use.use} is UNCOVERED (${hint})`,
  ]
}

function usesOf(webRoot: string, route: { rel: string }, ctx: ScanContext): UseRow[] {
  const code = readCode(webRoot, route.rel)
  if (code === null) return []
  const scan = scanMonolithicRegions(code, join(webRoot, route.rel), ctx)
  return (scan.useList ?? []).map((use) => ({ file: route.rel, ...use }))
}

function oversizeMessages(rows: readonly AuditRow[]): string[] {
  return rows
    .filter((row) => row.status === 'OVERSIZE')
    .map(
      (row) =>
        `${row.file}: region "${row.region}" is OVERSIZE (${row.component} holds ${row.componentLines} template lines, the limit is ${MAX_REGION_COMPONENT_LINES}): split its sections into sub-region components`
    )
}

function auditRoute(
  webRoot: string,
  route: { rel: string; kind: RouteKind },
  registry: ReadonlyMap<string, string> | null,
  ctx: ScanContext,
  result: AuditResult
): void {
  const reach = reachRegions(webRoot, route.rel)
  for (const failed of reach.unparseable) {
    result.rows.push(emptyRow(route.rel, route.kind, 'UNPARSEABLE'))
    result.problems.push(`${failed.file}: UNPARSEABLE (${failed.reason})`)
  }
  if (reach.regions.length === 0 && reach.unparseable.length === 0) {
    result.rows.push(emptyRow(route.rel, route.kind, 'MISSING'))
    result.problems.push(`${route.rel}: MISSING (no @region reachable from this route file)`)
  }
  for (const region of reach.regions) {
    result.rows.push(rowFor(webRoot, route, region, registry, result.problems))
  }
  for (const use of usesOf(webRoot, route, ctx)) {
    result.uses.push(use)
    result.problems.push(...useProblems(route, use))
  }
}

export function auditRouteRegions(webRoot: string, options: AuditOptions = {}): AuditResult {
  const { routes } = listRouteFiles(webRoot)
  const registry = readRegistry(webRoot)
  const result: AuditResult = {
    rows: [],
    oversize: [],
    uses: [],
    problems: [],
    routeFiles: routes.length,
  }
  const ctx = newScanContext(webRoot, (path) => readOverlayFile(webRoot, path))
  const resets = walkFiles(join(webRoot, ROUTES_DIR), (file) =>
    RESET_NAME.test(posix.basename(file))
  )
  for (const file of resets) {
    result.problems.push(
      `${toRepoPath(webRoot, file)}: a route file with a reset name (+page@.svelte) is invisible to the route census`
    )
  }
  if (registry === null) result.problems.push('the injection-point registry file is missing')
  for (const route of routes) auditRoute(webRoot, route, registry, ctx, result)
  result.oversize = oversizeMessages(result.rows)
  if (options.enforceOversize ?? OVERSIZE_ENFORCEMENT) result.problems.push(...result.oversize)
  const census = censusProblem(webRoot, routes.length)
  if (census !== null) result.problems.push(census)
  return result
}

function emptyRow(file: string, scope: RouteKind, status: AuditStatus): AuditRow {
  return {
    file,
    scope,
    region: '',
    component: '',
    point: '',
    inlineLines: 0,
    componentLines: 0,
    stableCandidate: 'no',
    status,
  }
}

function regionProblems(
  region: FoundRegion,
  component: string,
  point: string,
  registry: ReadonlyMap<string, string> | null
): string[] {
  const where = `${region.host}:${region.line}: region "${region.name}"`
  const problems: string[] = []
  if (point === '' || (registry !== null && !registry.has(point))) {
    problems.push(`${where}: unregistered point "${point}"`)
  }
  if (!component.startsWith(COMPONENT_DIR)) {
    problems.push(`${where}: not an indexed component (${component === '' ? 'none' : component})`)
  }
  return problems
}

function rowFor(
  webRoot: string,
  route: { rel: string; kind: RouteKind },
  region: FoundRegion,
  registry: ReadonlyMap<string, string> | null,
  problems: string[]
): AuditRow {
  const inRoute = region.host === route.rel
  const component = inRoute
    ? firstMatch(region.node, usedComponentOf(region.host, region.imports))
    : region.host
  const point = firstMatch(region.node, pointNameOf)
  problems.push(...regionProblems(region, component, point, registry))
  const componentCode = component === '' ? null : readCode(webRoot, component)
  const componentLines = componentCode === null ? 0 : templateLines(componentCode)
  const span = lineAt(region.code, region.node.end) - lineAt(region.code, region.node.start) + 1
  return {
    file: route.rel,
    scope: route.kind,
    region: region.name,
    component,
    point,
    inlineLines: inRoute ? span : 0,
    componentLines,
    stableCandidate: componentCode?.includes(STABLE_MARKER) === true ? 'marked' : 'no',
    status: componentLines > MAX_REGION_COMPONENT_LINES ? 'OVERSIZE' : 'done',
  }
}

const COLUMNS = [
  'route file',
  'scope',
  'region',
  'region component',
  'point',
  'inline lines',
  'component lines',
  'stable candidate',
  'status',
] as const

/** The markdown table (one row per region; a MISSING/UNPARSEABLE file has an empty region cell). */
export function formatTable(rows: readonly AuditRow[]): string {
  const lines = [`| ${COLUMNS.join(' | ')} |`, `|${' --- |'.repeat(COLUMNS.length)}`]
  for (const row of rows) {
    lines.push(
      `| ${[
        row.file,
        row.scope,
        row.region,
        row.component,
        row.point,
        row.inlineLines,
        row.componentLines,
        row.stableCandidate,
        row.status,
      ].join(' | ')} |`
    )
  }
  return lines.join('\n')
}

const USE_COLUMNS = ['route file', 'line', 'top-level use', 'kind', 'status'] as const

/** The markdown table of every top-level use (AC-1's `top-level uses` listing). */
export function formatUsesTable(uses: readonly UseRow[]): string {
  const lines = [`| ${USE_COLUMNS.join(' | ')} |`, `|${' --- |'.repeat(USE_COLUMNS.length)}`]
  for (const use of uses) {
    lines.push(`| ${[use.file, use.line, use.use, use.kind, use.status].join(' | ')} |`)
  }
  return lines.join('\n')
}
