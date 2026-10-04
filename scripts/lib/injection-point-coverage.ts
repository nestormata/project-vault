// Story 68.4 AC-10: the injection-point coverage guard (library). It checks PV-originated files only
// (design section 5, section 12): every PV `+page.svelte`, `+layout.svelte` and `+error.svelte` renders
// its three standard points, every `@region` block holds a point, every literal point name is
// registered, and every page/layout server file calls `injectLoad` / `injectActions` with its own
// route id and scope. Nothing is exempted by a list or a flag: a file is left out only when a
// composition lock records it as CM's (provenance, never a path list), and that only ever removes a
// check.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { deriveRegionHosts } from './region-hosts.js'
import {
  listRouteFiles,
  parseMarkup,
  parseServerFile,
  type RouteFile,
  type ServerFile,
} from './route-files.js'
import { toRepoPath, walkFiles } from './scan-utils.js'

export const REGISTRY_FILE = 'src/lib/components/composition/injection-points.ts'
const STANDARD_SUFFIXES = ['before', 'after', 'header.actions'] as const
const SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/
const TEST_SUPPORT = /(^|\/)src\/lib\/test\//
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]s$/
const BEFORE = '.before'

/** The part of a `composition.lock.json` the guard reads: which files are CM's. */
export interface LockProvenance {
  overrides?: { path: string }[]
  additions?: { path: string }[]
  materialized?: { path: string }[]
}

export interface CoverageOptions {
  /** The web app root (`apps/web`, or a composed app). */
  webRoot: string
  /** A composition lock: files it lists are CM's and are skipped. Without it every file is PV's. */
  lock?: LockProvenance
}

export interface CoverageResult {
  problems: string[]
  scannedRouteFiles: number
}

type Registry = Map<string, string>

// --- registry ---------------------------------------------------------------------------------

function stringFields(element: ts.ObjectLiteralExpression): Map<string, string> {
  const fields = new Map<string, string>()
  for (const property of element.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
    if (ts.isStringLiteralLike(property.initializer)) {
      fields.set(property.name.text, property.initializer.text)
    }
  }
  return fields
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isSatisfiesExpression(current) || ts.isAsExpression(current))
    current = current.expression
  return current
}

function isRegistryDeclaration(node: ts.Node): node is ts.VariableDeclaration {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === 'INJECTION_POINTS' &&
    node.initializer !== undefined
  )
}

function stringList(expression: ts.Expression | undefined): string[] {
  if (expression === undefined || !ts.isArrayLiteralExpression(expression)) return []
  return expression.elements.filter(ts.isStringLiteralLike).map((entry) => entry.text)
}

/** `...regionPoints('<propsType>', ['<routeId>#<scope>', ...], ['<region name>', ...])`: region
 * points all hosted by the same routes. The host routes are stored comma-joined in `hostRoutes`
 * (a route id never contains a comma). */
function regionRows(call: ts.CallExpression): Map<string, string>[] {
  const [propsType, hosts, names] = call.arguments
  if (propsType === undefined || !ts.isStringLiteralLike(propsType)) return []
  return stringList(names).map(
    (name) =>
      new Map([
        ['name', name],
        ['kind', 'region'],
        ['propsType', propsType.text],
        ['hostRoutes', stringList(hosts).join(',')],
      ])
  )
}

/** The rows one `INJECTION_POINTS` element stands for: an object literal is one row, and a
 * `...pagePoints('<propsType>', ['<area>.<page>', ...])` spread is the three standard points of
 * each listed page (the registry module expands it the same way at runtime). */
function registryRows(element: ts.Expression): Map<string, string>[] {
  if (ts.isObjectLiteralExpression(element)) return [stringFields(element)]
  if (!ts.isSpreadElement(element) || !ts.isCallExpression(element.expression)) return []
  const call = element.expression
  if (!ts.isIdentifier(call.expression)) return []
  if (call.expression.text === 'regionPoints') return regionRows(call)
  if (call.expression.text !== 'pagePoints') return []
  const [propsType, pages] = call.arguments
  if (propsType === undefined || !ts.isStringLiteralLike(propsType)) return []
  return stringList(pages).flatMap((page) =>
    STANDARD_SUFFIXES.map(
      (suffix) =>
        new Map([
          ['name', `${page}.${suffix}`],
          ['kind', 'standard'],
          ['propsType', propsType.text],
        ])
    )
  )
}

/** Every registered point's string fields (`name`, `kind`, `propsType`, optional `hostRouteId`),
 * read with the TypeScript parser. */
export function readRegistryFields(webRoot: string): Map<string, Map<string, string>> | null {
  let text: string
  try {
    text = readFileSync(join(webRoot, REGISTRY_FILE), 'utf8')
  } catch {
    return null
  }
  const source = ts.createSourceFile(REGISTRY_FILE, text, ts.ScriptTarget.Latest, true)
  const registry = new Map<string, Map<string, string>>()
  const visit = (node: ts.Node): void => {
    if (isRegistryDeclaration(node) && node.initializer !== undefined) {
      const list = unwrap(node.initializer)
      const elements = ts.isArrayLiteralExpression(list) ? list.elements : []
      for (const fields of elements.flatMap(registryRows)) {
        const name = fields.get('name')
        if (name !== undefined) registry.set(name, fields)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return registry
}

/** The registered names (and kinds) from `INJECTION_POINTS`. */
export function readRegistry(webRoot: string): Registry | null {
  const fields = readRegistryFields(webRoot)
  if (fields === null) return null
  return new Map([...fields].map(([name, entry]) => [name, entry.get('kind') ?? 'standard']))
}

function registryNameProblems(registry: Registry): string[] {
  const problems: string[] = []
  for (const [name, kind] of registry) {
    const minimum = kind === 'shell' ? 2 : 3
    const segments = name.split('.')
    if (segments.length < minimum || !segments.every((part) => SEGMENT_PATTERN.test(part))) {
      problems.push(
        `${REGISTRY_FILE}: "${name}" breaks the naming rule <area>.<page>.<region> (lowercase, dot-separated, at least ${minimum} segments)`
      )
    }
    // A region point is never one of a page's three standard points: those belong to route files.
    if (kind === 'region' && STANDARD_SUFFIXES.some((suffix) => name.endsWith(`.${suffix}`))) {
      problems.push(
        `${REGISTRY_FILE}: region point "${name}" ends in a standard position (${STANDARD_SUFFIXES.join(', ')}); those belong to route files, give the region its own name`
      )
    }
  }
  return problems
}

// --- markup -----------------------------------------------------------------------------------

export interface PointFile {
  rel: string
  names: { name: string | null; line: number }[]
}

/** The files a composition lock records as CM's (provenance, never a path list). */
export function cmFiles(lock: LockProvenance | undefined): Set<string> {
  const lists = [lock?.overrides, lock?.additions, lock?.materialized]
  return new Set(lists.flatMap((list) => list ?? []).map((entry) => entry.path))
}

export function scanMarkup(
  webRoot: string,
  skip: ReadonlySet<string>,
  problems: string[]
): PointFile[] {
  const files = walkFiles(join(webRoot, 'src'), (file) => file.endsWith('.svelte'))
  const scanned: PointFile[] = []
  for (const file of files) {
    const rel = toRepoPath(webRoot, file)
    if (skip.has(rel) || TEST_SUPPORT.test(rel) || TEST_FILE.test(rel)) continue
    const parsed = parseMarkup(readFileSync(file, 'utf8'), file)
    for (const issue of parsed.regionProblems)
      problems.push(`${rel}:${issue.line}: ${issue.message}`)
    scanned.push({ rel, names: parsed.points })
  }
  return scanned
}

function ownersOf(scanned: readonly PointFile[]): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>()
  for (const file of scanned) {
    for (const use of file.names) {
      if (use.name !== null) owners.set(use.name, (owners.get(use.name) ?? new Set()).add(file.rel))
    }
  }
  return owners
}

function useProblems(scanned: readonly PointFile[], registry: Registry): string[] {
  const problems: string[] = []
  for (const file of scanned) {
    for (const use of file.names) {
      const where = `${file.rel}:${use.line}`
      if (use.name === null) problems.push(`${where}: InjectionPoint name must be a string literal`)
      else if (!registry.has(use.name)) {
        problems.push(
          `${where}: injection point "${use.name}" is not registered in ${REGISTRY_FILE}`
        )
      }
    }
  }
  return problems
}

export function registryProblems(
  scanned: readonly PointFile[],
  registry: Registry,
  complete: boolean
): string[] {
  const owners = ownersOf(scanned)
  const problems = [...useProblems(scanned, registry), ...registryNameProblems(registry)]
  for (const [name, files] of owners) {
    if (files.size > 1) {
      problems.push(
        `injection point "${name}" is rendered in more than one file: ${[...files].join(', ')}`
      )
    }
  }
  // A registered name nobody renders is only reportable when every file was scanned.
  for (const name of complete ? registry.keys() : []) {
    if (!owners.has(name))
      problems.push(`${REGISTRY_FILE}: "${name}" is registered but no file renders it`)
  }
  return problems
}

export interface RegionHosts {
  problems: string[]
  /** Region point name -> the host routes DERIVED from the import graph. */
  derived: Map<string, string[]>
}

/** Story 69.1 Q1: every region point's declared host routes (`regionPoints(...)`) checked against the
 * routes whose import graph reaches the component that renders it, both ways. A region nobody reaches
 * is a problem (an empty host list is a bug, not a stub). Only meaningful over a complete PV tree. */
export function regionHostProblems(
  webRoot: string,
  registry: ReadonlyMap<string, ReadonlyMap<string, string>>,
  scanned: readonly PointFile[]
): RegionHosts {
  const regions = [...registry].filter(([, fields]) => fields.get('kind') === 'region')
  const fileOf = new Map(
    regions.flatMap(([name]) => {
      const file = scanned.find((candidate) =>
        candidate.names.some((use) => use.name === name)
      )?.rel
      return file === undefined ? [] : [[name, file] as const]
    })
  )
  const hostsByFile = deriveRegionHosts(webRoot, [...new Set(fileOf.values())])
  const result: RegionHosts = { problems: [], derived: new Map() }
  for (const [name, fields] of regions) {
    const file = fileOf.get(name)
    if (file === undefined) continue
    const declared = (fields.get('hostRoutes') ?? '').split(',').filter((host) => host !== '')
    const derived = hostsByFile.get(file) ?? []
    result.derived.set(name, derived)
    if (derived.length === 0) {
      result.problems.push(`${REGISTRY_FILE}: "${name}" is rendered by no page or layout (${file})`)
    }
    for (const host of declared.filter((entry) => !derived.includes(entry))) {
      result.problems.push(
        `${REGISTRY_FILE}: "${name}" declares host route "${host}" but no such route renders ${file}`
      )
    }
    for (const host of derived.filter((entry) => !declared.includes(entry))) {
      result.problems.push(
        `${REGISTRY_FILE}: "${name}" is rendered by "${host}" (it imports ${file}) but the registry does not declare it`
      )
    }
  }
  return result
}

function prefixesOf(names: readonly (string | null)[]): string[] {
  return names
    .filter((name): name is string => name?.endsWith(BEFORE) === true)
    .map((name) => name.slice(0, -BEFORE.length))
}

function standardPointProblems(file: RouteFile, names: readonly (string | null)[]): string[] {
  const prefixes = prefixesOf(names)
  if (prefixes.length === 0) {
    return [
      `${file.rel}: lacks the standard injection points (<prefix>.before, .after, .header.actions)`,
    ]
  }
  return prefixes.flatMap((prefix) =>
    STANDARD_SUFFIXES.filter((suffix) => !names.includes(`${prefix}.${suffix}`)).map(
      (suffix) => `${file.rel}: lacks injection point "${prefix}.${suffix}"`
    )
  )
}

function prefixProblems(owners: ReadonlyMap<string, readonly string[]>): string[] {
  return [...owners]
    .filter(([, files]) => files.length > 1)
    .map(
      ([prefix, files]) =>
        `injection point prefix "${prefix}" is used by more than one route file: ${files.join(', ')}`
    )
}

function routeProblems(
  routes: readonly RouteFile[],
  servers: readonly ServerFile[],
  namesOf: ReadonlyMap<string, (string | null)[]>
): string[] {
  const problems: string[] = []
  const prefixOwners = new Map<string, string[]>()
  for (const route of routes) {
    const names = namesOf.get(route.rel) ?? []
    problems.push(...standardPointProblems(route, names))
    for (const prefix of prefixesOf(names)) {
      prefixOwners.set(prefix, [...(prefixOwners.get(prefix) ?? []), route.rel])
    }
    const kind = route.kind === 'layout' ? 'layout' : 'page'
    const hasServer = servers.some((s) => s.routeId === route.routeId && s.kind === kind)
    if (route.kind !== 'error' && !hasServer) {
      problems.push(
        `${route.rel}: has no server file calling injectLoad (every page and layout must be able to receive server data)`
      )
    }
  }
  return [...problems, ...prefixProblems(prefixOwners)]
}

// --- server files -----------------------------------------------------------------------------

function expectedProblems(
  where: string,
  call: string,
  got: string | null,
  expected: string
): string[] {
  return got === expected
    ? []
    : [
        `${where} ${call} is called with ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
      ]
}

function loadCallProblems(server: ServerFile, calls: ReturnType<typeof parseServerFile>): string[] {
  const where = `${server.rel}:`
  if (calls.loadCalls.length === 0) {
    return [`${where} does not call injectLoad (route ${server.routeId}, scope ${server.kind})`]
  }
  return calls.loadCalls.flatMap((call) => [
    ...expectedProblems(where, 'injectLoad route id', call.routeId, server.routeId),
    ...expectedProblems(where, 'injectLoad scope', call.scope, server.kind),
  ])
}

function actionCallProblems(
  server: ServerFile,
  calls: ReturnType<typeof parseServerFile>,
  registry: Registry
): string[] {
  const where = `${server.rel}:`
  if (calls.actionCalls.length === 0) {
    return [`${where} does not spread injectActions(${JSON.stringify(server.routeId)})`]
  }
  const problems = calls.actionCalls.flatMap((route) =>
    expectedProblems(where, 'injectActions route id', route, server.routeId)
  )
  if (calls.hasDefaultAction) {
    problems.push(
      `${where} exports a default action while spreading injectActions (Kit forbids default plus named actions)`
    )
  }
  for (const key of calls.actionKeys) {
    const clash = [...registry.keys()].find((name) => key.startsWith(`${name}.`))
    if (clash !== undefined) {
      problems.push(
        `${where} action "${key}" starts with injection point "${clash}." (injected action keys carry that prefix)`
      )
    }
  }
  return problems
}

function serverProblems(server: ServerFile, code: string, registry: Registry): string[] {
  const calls = parseServerFile(code, server.rel)
  const needsActions = server.kind === 'page' && !server.universal
  return [
    ...loadCallProblems(server, calls),
    ...(needsActions ? actionCallProblems(server, calls, registry) : []),
  ]
}

// --- the guard --------------------------------------------------------------------------------

/** Independent count of the route components below `routes/`, as `find` would see them. */
function rawRouteFileCount(webRoot: string): number {
  return walkFiles(join(webRoot, 'src/routes'), (file) =>
    /\/\+(page|layout|error)\.svelte$/.test(file)
  ).filter((file) => !file.split('/').includes('__tests__')).length
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function scanProblems(
  webRoot: string,
  routes: readonly RouteFile[],
  registry: Registry | null
): string[] {
  const problems: string[] = []
  if (registry === null || registry.size === 0) {
    problems.push(`${REGISTRY_FILE}: no INJECTION_POINTS registry found`)
  }
  if (routes.length === 0) {
    problems.push(
      'scanned 0 route files: no routes found (a guard that matches nothing is not a pass)'
    )
  }
  if (routes.length < rawRouteFileCount(webRoot)) {
    problems.push('the scan found fewer route files than a plain file walk sees')
  }
  return problems
}

export function checkInjectionPointCoverage(options: CoverageOptions): CoverageResult {
  const skip = cmFiles(options.lock)
  const { routes, servers } = listRouteFiles(options.webRoot)
  const registry = readRegistry(options.webRoot)
  const known: Registry = registry ?? new Map()
  const problems = scanProblems(options.webRoot, routes, registry)

  const pvRoutes = routes.filter((route) => !skip.has(route.rel))
  // A server file with no component beside it (a redirect-only `+page.server.ts`) has no region to
  // fill, so it is not part of the contract.
  const pvServers = servers.filter(
    (server) =>
      !skip.has(server.rel) &&
      routes.some((route) => route.routeId === server.routeId && route.kind === server.kind)
  )
  const markup = scanMarkup(options.webRoot, skip, problems)
  problems.push(...registryProblems(markup, known, skip.size === 0))
  // Over a composed tree a CM override may stop importing a region component; only a complete PV
  // tree is checked for host routes.
  if (skip.size === 0 && registry !== null) {
    const fields = readRegistryFields(options.webRoot) ?? new Map()
    problems.push(...regionHostProblems(options.webRoot, fields, markup).problems)
  }
  const namesOf = new Map(markup.map((file) => [file.rel, file.names.map((use) => use.name)]))
  problems.push(...routeProblems(pvRoutes, pvServers, namesOf))
  for (const server of pvServers) {
    const code = readFileSync(join(options.webRoot, server.rel), 'utf8')
    problems.push(...serverProblems(server, code, known))
  }
  return {
    problems: [...new Set(problems)].sort(compareCodeUnits),
    scannedRouteFiles: routes.length,
  }
}
