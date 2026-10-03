// Story 68.4: the code of the injection virtual modules. Pure functions from the lock's `injections`
// section to module source text. Rules (design section 5, AC-14):
//   - every string that comes from a manifest or the registry (point names, route ids, paths, action
//     keys) is spliced in through JSON.stringify, never raw;
//   - the modules hold only frozen, null-prototype tables and `const`s: no mutable module state, no
//     eval, nothing read from the environment, nothing shared between two requests;
//   - components are STATIC imports (no `import()`), so they render on the server and split per page.

export interface CodegenInjection {
  point: string
  /** Composed path of the component (`src/lib/_cm/...`). */
  component: string
  order: number
  load: string | null
  actions: string | null
  routeId: string | null
  scope: string | null
}

const LIB_PREFIX = 'src/lib/'

/** The import specifier of a composed file: `$lib/...` below `src/lib`, else root-relative. */
export function composedSpecifier(composedPath: string): string {
  return composedPath.startsWith(LIB_PREFIX)
    ? `$lib/${composedPath.slice(LIB_PREFIX.length)}`
    : `/${composedPath}`
}

/** The behavior table key of a point: `<routeId>#<scope>`, with a shell point running in its
 * layout's load. Component- and error-scoped points have no behavior (null). */
export function behaviorKey(point: Pick<CodegenInjection, 'routeId' | 'scope'>): string | null {
  if (point.routeId === null) return null
  if (point.scope === 'page') return `${point.routeId}#page`
  if (point.scope === 'layout' || point.scope === 'shell') return `${point.routeId}#layout`
  return null
}

const json = (value: unknown): string => JSON.stringify(value)

function byOrder(items: readonly CodegenInjection[]): CodegenInjection[] {
  // Array.prototype.sort is stable: equal orders keep the manifest's order.
  return [...items].sort((a, b) => a.order - b.order)
}

/** `virtual:pv-inject/<point>`: the point's components, in order, as a default-exported list. */
export function generatePointModule(point: string, unordered: readonly CodegenInjection[]): string {
  if (unordered.length === 0) return 'export default []\n'
  const entries = byOrder(unordered)
  const imports = entries.map(
    (entry, index) => `import c${index} from ${json(composedSpecifier(entry.component))}`
  )
  const items = entries.map((entry, index) => {
    const id = `${point}#${index}`
    return `  { id: ${json(id)}, order: ${json(entry.order)}, component: c${index} },`
  })
  return `${imports.join('\n')}\nexport default [\n${items.join('\n')}\n]\n`
}

class Imports {
  private readonly ids = new Map<string, string>()

  of(composedPath: string): string {
    const known = this.ids.get(composedPath)
    if (known !== undefined) return known
    const id = `m${this.ids.size}`
    this.ids.set(composedPath, id)
    return id
  }

  lines(): string[] {
    return [...this.ids].map(
      ([path, id]) => `import * as ${id} from ${json(composedSpecifier(path))}`
    )
  }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item])
  return groups
}

function loadsTable(routed: ReadonlyMap<string, CodegenInjection[]>, imports: Imports): string {
  const rows: string[] = []
  for (const [key, entries] of routed) {
    const points = [...groupBy(entries, (entry) => entry.point)]
      .filter(([, list]) => list.some((entry) => entry.load !== null))
      .map(([point, list]) => {
        const contributions = byOrder(list).map((entry) => {
          const load = entry.load === null ? 'null' : `${imports.of(entry.load)}.load`
          return `Object.freeze({ order: ${json(entry.order)}, load: ${load} })`
        })
        return `Object.freeze({ point: ${json(point)}, contributions: Object.freeze([${contributions.join(', ')}]) })`
      })
    if (points.length > 0) rows.push(`  [${json(key)}, Object.freeze([${points.join(', ')}])],`)
  }
  return rows.join('\n')
}

function actionsTable(routed: ReadonlyMap<string, CodegenInjection[]>, imports: Imports): string {
  const rows: string[] = []
  for (const [key, entries] of routed) {
    if (!key.endsWith('#page')) continue
    const sources = byOrder(entries)
      .filter((entry) => entry.actions !== null)
      .map(
        (entry) =>
          `...actionEntries(${json(entry.point)}, ${imports.of(entry.actions as string)}.actions)`
      )
    if (sources.length > 0) rows.push(`  [${json(key)}, own([${sources.join(', ')}])],`)
  }
  return rows.join('\n')
}

const HELPERS = [
  'const own = (list) => {',
  '  const table = Object.create(null)',
  '  for (const [key, value] of list) {',
  '    if (key in table) throw new Error(`duplicate injected action ${JSON.stringify(key)}`)',
  '    table[key] = value',
  '  }',
  '  return Object.freeze(table)',
  '}',
  'const actionEntries = (point, source) =>',
  '  Object.entries(source).map(([name, run]) => [`${point}.${name}`, Object.freeze({ point, name, run })])',
].join('\n')

/** `virtual:pv-inject-behavior`: the `loads` and `actions` tables PV's `injectLoad` and
 * `injectActions` read, keyed `<routeId>#<scope>`. Dispatch is by exact key on a null-prototype
 * object, so `__proto__` and `constructor` can never resolve to an inherited member. */
export function generateBehaviorModule(injections: readonly CodegenInjection[]): string {
  // Every contribution at a routed point is listed (a point's `data` entries align with them), but
  // only files that carry behavior are imported.
  const routable = injections.filter((entry) => behaviorKey(entry) !== null)
  const routed = groupBy(routable, (entry) => behaviorKey(entry) as string)
  const imports = new Imports()
  // Resolve the tables first so only files that are actually routed get imported.
  const loads = loadsTable(routed, imports)
  const actions = actionsTable(routed, imports)
  return [
    ...imports.lines(),
    HELPERS,
    `export const loads = own([\n${loads}\n])`,
    `export const actions = own([\n${actions}\n])`,
    '',
  ].join('\n')
}
