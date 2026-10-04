// Story 68.4 AC-2: `manifests/injection-points.json` of the packed @project-vault/web-host. The registry
// (`injection-points.ts`) is the single source of point names; this joins it with the files that
// render each point (found with the Svelte parser, through the one shared route library) and writes
// the file the composition kit already understands (`{ schemaVersion: 1, points: [{ name, file }] }`).
// `kind`, `propsType`, `routeId` and `scope` are additive fields the kit ignores, and so is `hostRoutes`
// (Story 69.1, region points only) for a kit that predates the per-route opt-in. Output is
// byte-deterministic: sorted by name in code-unit order, no timestamps, posix paths relative to the
// package root.
import { sortKeys } from '../../../packages/composition-kit/src/sort-keys.ts'
import {
  readRegistryFields,
  regionHostProblems,
  registryProblems,
  scanMarkup,
  type PointFile,
} from '../injection-point-coverage.js'
import { listRouteFiles, type PointScope } from '../route-files.js'

export const INJECTION_POINTS_MANIFEST = 'injection-points.json'

export interface InjectionPointEntry {
  name: string
  file: string
  kind: string
  propsType: string
  routeId?: string
  scope: PointScope
  /** Story 69.1: for a region point (scope `component`), the page/layout routes that render it, as
   * `<routeId>#<scope>`, derived from the import graph. The kit reads it for the per-route opt-in. */
  hostRoutes?: string[]
}

export interface InjectionPointsManifest {
  text: string
  points: InjectionPointEntry[]
  problems: string[]
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function rendererOf(name: string, files: readonly PointFile[]): string | undefined {
  return files.find((file) => file.names.some((use) => use.name === name))?.rel
}

function scopeOf(
  rel: string,
  fields: ReadonlyMap<string, string>,
  routeByFile: ReadonlyMap<string, { routeId: string; kind: string }>
): Pick<InjectionPointEntry, 'routeId' | 'scope'> {
  const route = routeByFile.get(rel)
  if (route !== undefined) return { routeId: route.routeId, scope: route.kind as PointScope }
  // A shared shell component renders the point, but the data comes from a layout's load.
  const hostRouteId = fields.get('hostRouteId')
  if (fields.get('kind') === 'shell' && hostRouteId !== undefined) {
    return { routeId: hostRouteId, scope: 'shell' }
  }
  return { scope: 'component' }
}

/** Builds the manifest for the web app at `webRoot`. `problems` is non-empty when the registry and
 * the source disagree (the pack fails on it). */
export function buildInjectionPointsManifest(webRoot: string): InjectionPointsManifest {
  const registry = readRegistryFields(webRoot)
  if (registry === null || registry.size === 0) {
    return {
      text: '',
      points: [],
      problems: [
        'injection-points.ts: no INJECTION_POINTS registry found (an empty manifest is a bug, not a stub)',
      ],
    }
  }
  const problems: string[] = []
  const markup = scanMarkup(webRoot, new Set(), problems)
  const kinds = new Map(
    [...registry].map(([name, fields]) => [name, fields.get('kind') ?? 'standard'])
  )
  problems.push(...registryProblems(markup, kinds, true))
  const regionHosts = regionHostProblems(webRoot, registry, markup)
  problems.push(...regionHosts.problems)
  const routeByFile = new Map(listRouteFiles(webRoot).routes.map((route) => [route.rel, route]))
  const points: InjectionPointEntry[] = []
  for (const [name, fields] of registry) {
    const file = rendererOf(name, markup)
    if (file === undefined) continue
    points.push({
      name,
      file,
      kind: fields.get('kind') ?? 'standard',
      propsType: fields.get('propsType') ?? '',
      ...scopeOf(file, fields, routeByFile),
      ...(regionHosts.derived.has(name) ? { hostRoutes: regionHosts.derived.get(name) } : {}),
    })
  }
  points.sort((a, b) => compareCodeUnits(a.name, b.name))
  const text = `${JSON.stringify(sortKeys({ schemaVersion: 1, points }), null, 2)}\n`
  return { text, points, problems: [...new Set(problems)].sort(compareCodeUnits) }
}
