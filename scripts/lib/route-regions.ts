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
import { childrenOf, lineAt, parseRegions, type Node } from '../../apps/web/guards/region-markup.js'
import { readRegistry } from './injection-point-coverage.js'
import { listRouteFiles, ROUTES_DIR, type RouteKind } from './route-files.js'
import { readOverlayFile, toRepoPath, walkFiles } from './scan-utils.js'

const COMPONENT_DIR = 'src/lib/components/'
const ORACLE_FILE = 'src/routes/route-render-snapshot.test.ts'
const RESET_NAME = /^\+(page|layout|error)@.*\.svelte$/
const STABLE_MARKER = '@pv-stable'

export type AuditStatus = 'done' | 'MISSING' | 'UNPARSEABLE'

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

export interface AuditResult {
  rows: AuditRow[]
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

function censusProblem(webRoot: string, routeFiles: number): string | null {
  const oracle = readCode(webRoot, ORACLE_FILE)
  const declared = oracle === null ? null : /covers every one of the (\d+) route files/.exec(oracle)
  if (declared?.[1] === undefined || Number(declared[1]) === routeFiles) return null
  return `route-render oracle (${ORACLE_FILE}) expects ${declared[1]} route files but the tree has ${routeFiles}`
}

export function auditRouteRegions(webRoot: string): AuditResult {
  const { routes } = listRouteFiles(webRoot)
  const registry = readRegistry(webRoot)
  const result: AuditResult = { rows: [], problems: [], routeFiles: routes.length }
  const resets = walkFiles(join(webRoot, ROUTES_DIR), (file) =>
    RESET_NAME.test(posix.basename(file))
  )
  for (const file of resets) {
    result.problems.push(
      `${toRepoPath(webRoot, file)}: a route file with a reset name (+page@.svelte) is invisible to the route census`
    )
  }
  if (registry === null) result.problems.push('the injection-point registry file is missing')
  for (const route of routes) {
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
  }
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
  const span = lineAt(region.code, region.node.end) - lineAt(region.code, region.node.start) + 1
  return {
    file: route.rel,
    scope: route.kind,
    region: region.name,
    component,
    point,
    inlineLines: inRoute ? span : 0,
    componentLines: componentCode === null ? 0 : templateLines(componentCode),
    stableCandidate: componentCode?.includes(STABLE_MARKER) === true ? 'marked' : 'no',
    status: 'done',
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
