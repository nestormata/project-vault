// Story 69.1 (Q12 option B, Q1): which page and layout routes render a region component. A region
// point lives in a shared component, so the registry declares the host routes (`<routeId>#<scope>`)
// whose behavior table may carry a contribution's load and actions, and this module DERIVES them from
// the import graph (route component -> components -> region component, `.svelte` edges only,
// type-only imports ignored) so the declaration is checked, never trusted. A region component that is
// only reached through a `.ts` module is not seen: that would also be invisible to the monolithic
// guard, and the mismatch is reported as a problem rather than guessed at.
import { join, relative } from 'node:path'
import {
  moduleSpecifiers,
  resolveSpecifier,
  sysReadFile,
  type GraphResolver,
} from './web-host/import-graph.js'
import { listRouteFiles, parseMarkup, svelteCompiler } from './route-files.js'

const LIB_ALIAS = '$lib/'

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function libResolver(webRoot: string): GraphResolver {
  return {
    alias: (specifier) =>
      specifier.startsWith(LIB_ALIAS)
        ? join(webRoot, 'src/lib', specifier.slice(LIB_ALIAS.length))
        : undefined,
    readFile: sysReadFile,
  }
}

/** The `.svelte` files a component imports at runtime, absolute. Memoized per file. */
class ComponentEdges {
  private readonly cache = new Map<string, string[]>()

  constructor(private readonly resolver: GraphResolver) {}

  of(file: string): string[] {
    const known = this.cache.get(file)
    if (known !== undefined) return known
    const edges = moduleSpecifiers(sysReadFile(file) ?? '', file)
      .filter(({ typeOnly, specifier }) => !typeOnly && specifier.endsWith('.svelte'))
      .flatMap(({ specifier }) => {
        const target = resolveSpecifier(specifier, file, this.resolver)
        return target.kind === 'file' ? [target.path] : []
      })
    this.cache.set(file, edges)
    return edges
  }

  /** The shortest chain of component files from `root` to `target` (both included), or null. */
  path(root: string, target: string): string[] | null {
    const parent = new Map<string, string | null>([[root, null]])
    const queue = [root]
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      if (file === target) break
      for (const next of this.of(file)) {
        if (parent.has(next)) continue
        parent.set(next, file)
        queue.push(next)
      }
    }
    if (!parent.has(target)) return null
    const chain: string[] = []
    for (let at: string | null | undefined = target; at != null; at = parent.get(at))
      chain.unshift(at)
    return chain
  }

  reaches(root: string, targets: ReadonlySet<string>): Set<string> {
    const seen = new Set<string>()
    const queue = [root]
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      if (seen.has(file)) continue
      seen.add(file)
      queue.push(...this.of(file))
    }
    return new Set([...seen].filter((file) => targets.has(file)))
  }
}

/** For each region component file (relative to `webRoot`), the sorted `<routeId>#<scope>` keys of
 * the page and layout route files that reach it. Error pages run no server code, so they are not
 * hosts. */
export function deriveRegionHosts(
  webRoot: string,
  regionFiles: readonly string[]
): Map<string, string[]> {
  const hosts = new Map<string, string[]>(regionFiles.map((file) => [file, []]))
  const absolute = new Map(regionFiles.map((file) => [join(webRoot, file), file]))
  const targets = new Set(absolute.keys())
  const edges = new ComponentEdges(libResolver(webRoot))
  for (const route of listRouteFiles(webRoot).routes) {
    if (route.kind === 'error') continue
    const key = `${route.routeId}#${route.kind}`
    for (const reached of edges.reaches(join(webRoot, route.rel), targets)) {
      const file = absolute.get(reached)
      if (file !== undefined) hosts.get(file)?.push(key)
    }
  }
  for (const list of hosts.values()) list.sort(compareCodeUnits)
  return hosts
}

interface MarkupNode {
  type: string
  start: number
  end: number
  name?: string
  attributes?: { type: string; name?: string; start: number; end: number }[]
  [key: string]: unknown
}

/** The source text of a use's `data` attribute, or null when the use passes none. */
function dataAttribute(code: string, use: MarkupNode): string | null {
  const data = (use.attributes ?? []).find(
    (attribute) => attribute.type === 'Attribute' && attribute.name === 'data'
  )
  return data === undefined ? null : code.slice(data.start, data.end)
}

function isUseOf(node: MarkupNode, names: ReadonlySet<string>): boolean {
  return node.type === 'Component' && names.has((node.name ?? '').split('.')[0] ?? '')
}

/** Every `<Component data=...>` use of one of `names` in a parsed file: the attribute's source text,
 * or null when the use passes no `data`. */
function dataUses(code: string, file: string, names: ReadonlySet<string>): (string | null)[] {
  const root = svelteCompiler.parse(code, { modern: true, filename: file }) as unknown as {
    fragment: MarkupNode
  }
  const uses: (string | null)[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (node === null || typeof node !== 'object') return
    const record = node as MarkupNode
    if (isUseOf(record, names)) uses.push(dataAttribute(code, record))
    for (const [key, child] of Object.entries(record)) if (key !== 'metadata') visit(child)
  }
  visit(root.fragment)
  return uses
}

/** The local names `file` binds for imports that resolve to `target`. */
function bindingsFor(
  code: string,
  file: string,
  target: string,
  resolver: GraphResolver
): Set<string> {
  const names = new Set<string>()
  for (const [local, source] of parseMarkup(code, file).svelteImports) {
    const resolved = resolveSpecifier(source, file, resolver)
    if (resolved.kind === 'file' && resolved.path === target) names.add(local)
  }
  return names
}

/** The problem of one edge (importer -> next) of a host route's chain to a region, or null. */
function edgeProblem(
  webRoot: string,
  resolver: GraphResolver,
  chain: readonly string[],
  index: number,
  regionFile: string
): string | null {
  const [importer, target] = chain.slice(index, index + 2)
  if (importer === undefined || target === undefined) return null
  const code = sysReadFile(importer) ?? ''
  const names = bindingsFor(code, importer, target, resolver)
  const uses = dataUses(code, importer, names)
  const isRoute = index === 0
  if (uses.some((use) => use !== null && (!isRoute || use.includes('__inject')))) return null
  const tag = [...names][0] ?? 'component'
  const what = isRoute ? 'without data={data.__inject}' : 'without passing data'
  return `${relative(webRoot, importer)} renders <${tag}> (${relative(webRoot, target)}) ${what} (the region ${regionFile} needs the page's __inject map)`
}

/** Story 69.1 Q1: along the import chain from each host route file to a region component, every
 * component must hand the next one `data`, and the route file must hand it its `__inject` map: a
 * region that is not given the map renders `data = null` and a contribution load would never reach it.
 * A server file calling `injectLoad`/`injectActions` with its own id is the separate route check. */
export function dataForwardingProblems(
  webRoot: string,
  hosts: ReadonlyMap<string, readonly string[]>
): string[] {
  const resolver = libResolver(webRoot)
  const edges = new ComponentEdges(resolver)
  const routes = listRouteFiles(webRoot).routes
  const problems: string[] = []
  for (const [regionFile, keys] of hosts) {
    for (const key of keys) {
      const route = routes.find((entry) => `${entry.routeId}#${entry.kind}` === key)
      const chain = route && edges.path(join(webRoot, route.rel), join(webRoot, regionFile))
      if (!chain) continue
      for (let index = 0; index < chain.length - 1; index++) {
        const problem = edgeProblem(webRoot, resolver, chain, index, regionFile)
        if (problem !== null) problems.push(problem)
      }
    }
  }
  return problems
}
