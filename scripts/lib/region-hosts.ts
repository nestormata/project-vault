// Story 69.1 (Q12 option B, Q1): which page and layout routes render a region component. A region
// point lives in a shared component, so the registry declares the host routes (`<routeId>#<scope>`)
// whose behavior table may carry a contribution's load and actions, and this module DERIVES them from
// the import graph (route component -> components -> region component, `.svelte` edges only,
// type-only imports ignored) so the declaration is checked, never trusted. A region component that is
// only reached through a `.ts` module is not seen: that would also be invisible to the monolithic
// guard, and the mismatch is reported as a problem rather than guessed at.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  moduleSpecifiers,
  resolveSpecifier,
  sysReadFile,
  type GraphResolver,
} from './web-host/import-graph.js'
import { listRouteFiles } from './route-files.js'

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
    const edges = moduleSpecifiers(readFileSync(file, 'utf8'), file)
      .filter(({ typeOnly, specifier }) => !typeOnly && specifier.endsWith('.svelte'))
      .flatMap(({ specifier }) => {
        const target = resolveSpecifier(specifier, file, this.resolver)
        return target.kind === 'file' ? [target.path] : []
      })
    this.cache.set(file, edges)
    return edges
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
