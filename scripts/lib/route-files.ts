// Story 68.4 AC-10 / AC-18: the ONE route-discovery library. The pack script (`injection-points.json`),
// the coverage guard and the tests all read PV's route files and injection-point uses through here,
// so Kit's route-id rules and the point extraction are written once. Markup is read with
// `svelte/compiler`'s parser and the server files with TypeScript's compiler API, never with a regex
// over source text.
import { createRequire } from 'node:module'
import { join, posix } from 'node:path'
import ts from 'typescript'
import { toRepoPath, walkFiles } from './scan-utils.js'

const requireFromWeb = createRequire(join(import.meta.dirname, '..', '..', 'apps/web/package.json'))
const svelteCompiler = requireFromWeb('svelte/compiler') as typeof import('svelte/compiler')

export const ROUTES_DIR = 'src/routes'
export type RouteKind = 'page' | 'layout' | 'error'
export type ServerKind = 'page' | 'layout'
export type PointScope = 'page' | 'layout' | 'error' | 'shell' | 'component'

export interface RouteFile {
  /** Path relative to the web app root (`src/routes/(app)/projects/+page.svelte`). */
  rel: string
  kind: RouteKind
  /** SvelteKit's route id for the file's directory: `/`, `/(app)/projects/[projectId]`, ... */
  routeId: string
}

export interface ServerFile {
  rel: string
  kind: ServerKind
  /** `+page.ts` / `+layout.ts` (a universal load) rather than `+page.server.ts`. */
  universal: boolean
  routeId: string
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]s$/
const ROUTE_FILE = /^\+(page|layout|error)\.svelte$/
const SERVER_FILE = /^\+(page|layout)(\.server)?\.[jt]s$/

/** Kit's route id of a directory below `src/routes`: `/` for the root, else `/<dir>` with route
 * groups and parameters kept verbatim (this is the string `event.route.id` holds). */
export function routeIdOfDir(dirBelowRoutes: string): string {
  return dirBelowRoutes === '' || dirBelowRoutes === '.' ? '/' : `/${dirBelowRoutes}`
}

function isTestPath(rel: string): boolean {
  return TEST_FILE.test(rel) || rel.split('/').includes('__tests__')
}

export interface RouteScan {
  routes: RouteFile[]
  servers: ServerFile[]
}

/** Every route component and every page/layout server or universal file below `<webRoot>/src/routes`,
 * sorted by path. Tests are never route files. */
export function listRouteFiles(webRoot: string): RouteScan {
  const base = join(webRoot, ROUTES_DIR)
  const routes: RouteFile[] = []
  const servers: ServerFile[] = []
  for (const file of walkFiles(base, () => true)) {
    const rel = toRepoPath(webRoot, file)
    if (isTestPath(rel)) continue
    const name = posix.basename(rel)
    const dir = posix.dirname(rel).slice(ROUTES_DIR.length + 1)
    const routeId = routeIdOfDir(dir)
    const component = ROUTE_FILE.exec(name)
    if (component !== null) {
      routes.push({ rel, kind: component[1] as RouteKind, routeId })
      continue
    }
    const server = SERVER_FILE.exec(name)
    if (server !== null) {
      servers.push({
        rel,
        kind: server[1] as ServerKind,
        universal: server[2] === undefined,
        routeId,
      })
    }
  }
  const byPath = (a: { rel: string }, b: { rel: string }): number => a.rel.localeCompare(b.rel)
  return { routes: routes.toSorted(byPath), servers: servers.toSorted(byPath) }
}

// --- markup: injection points and @region blocks ---------------------------------------------

interface Node {
  type: string
  start: number
  end: number
  name?: string
  data?: string
  attributes?: { type: string; name: string; value: true | Node | Node[] }[]
  expression?: { value?: unknown }
  [key: string]: unknown
}

export interface PointUse {
  /** The literal name, or null when `name` is not a string literal. */
  name: string | null
  line: number
}

export interface RegionProblem {
  line: number
  message: string
}

export interface ParsedMarkup {
  points: PointUse[]
  regionProblems: RegionProblem[]
}

const REGION_COMMENT = /^\s*@region\s+(\S+)\s*$/
const REGION_WORD = /^\s*@region\b/

function lineAt(code: string, index: number): number {
  return code.slice(0, index).split('\n').length
}

function textOf(part: Node | true | undefined): string | null {
  if (part === undefined || part === true) return null
  if (part.type === 'Text') return part.data ?? null
  const literal = part.type === 'ExpressionTag' ? part.expression?.value : undefined
  return typeof literal === 'string' ? literal : null
}

function literalName(node: Node): string | null {
  const attribute = (node.attributes ?? []).find(
    (entry) => entry.type === 'Attribute' && entry.name === 'name'
  )
  const value = attribute?.value
  const parts = Array.isArray(value) ? value : [value]
  return parts.length === 1 ? textOf(parts[0]) : null
}

function isPoint(node: unknown): node is Node {
  const candidate = node as Node | null
  return candidate?.type === 'Component' && candidate.name === 'InjectionPoint'
}

function childrenOf(node: Node): unknown[] {
  return Object.entries(node)
    .filter(([key, value]) => key !== 'metadata' && typeof value === 'object' && value !== null)
    .map(([, value]) => value)
}

function containsPoint(node: unknown): boolean {
  if (Array.isArray(node)) return node.some((child) => containsPoint(child))
  if (node === null || typeof node !== 'object') return false
  if (isPoint(node)) return true
  return childrenOf(node as Node).some((child) => containsPoint(child))
}

function regionProblemsIn(siblings: Node[], code: string): RegionProblem[] {
  const problems: RegionProblem[] = []
  siblings.forEach((node, index) => {
    if (node.type !== 'Comment' || !REGION_WORD.test(node.data ?? '')) return
    const line = lineAt(code, node.start)
    if (!REGION_COMMENT.test(node.data ?? '')) {
      problems.push({ line, message: '@region comment must be written `<!-- @region <name> -->`' })
      return
    }
    const next = siblings.slice(index + 1).find((sibling) => !isBlankText(sibling))
    if (next === undefined) {
      problems.push({ line, message: '@region comment is not followed by an element or block' })
    } else if (!containsPoint(next)) {
      problems.push({ line, message: '@region block contains no <InjectionPoint>' })
    }
  })
  return problems
}

function isBlankText(node: Node): boolean {
  return node.type === 'Text' && (node.data ?? '').trim() === ''
}

function walk(node: unknown, code: string, out: ParsedMarkup): void {
  if (Array.isArray(node)) {
    if (node.some((child) => (child as Node | null)?.type === 'Comment')) {
      out.regionProblems.push(...regionProblemsIn(node as Node[], code))
    }
    for (const child of node) walk(child, code, out)
    return
  }
  if (node === null || typeof node !== 'object') return
  const record = node as Node
  if (isPoint(record))
    out.points.push({ name: literalName(record), line: lineAt(code, record.start) })
  for (const child of childrenOf(record)) walk(child, code, out)
}

/** The `<InjectionPoint>` uses (literal names, in source order) and malformed `@region` blocks. */
export function parseMarkup(code: string, file: string): ParsedMarkup {
  const root = svelteCompiler.parse(code, { modern: true, filename: file }) as unknown as {
    fragment: Node
  }
  const out: ParsedMarkup = { points: [], regionProblems: [] }
  walk(root.fragment, code, out)
  return out
}

// --- server files: injectLoad / injectActions call sites --------------------------------------

export interface LoadCall {
  routeId: string | null
  scope: string | null
}

export interface ServerCalls {
  /** `injectLoad(event, route, scope)` and `withInjectedLoad(own, route, scope)` calls. */
  loadCalls: LoadCall[]
  /** Route ids passed to `injectActions(...)` (null when not a string literal). */
  actionCalls: (string | null)[]
  /** Own action keys (the properties of an `export const actions = { ... }` literal). */
  actionKeys: string[]
  /** `export const actions` has (or spreads from a literal with) a `default` key. */
  hasDefaultAction: boolean
}

function stringArg(call: ts.CallExpression, index: number): string | null {
  const arg = call.arguments.at(index)
  return arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : null
}

function calleeName(call: ts.CallExpression): string | null {
  return ts.isIdentifier(call.expression) ? call.expression.text : null
}

function propertyKey(property: ts.ObjectLiteralElementLike): string | null {
  if (ts.isSpreadAssignment(property)) return null
  const name = property.name
  if (name === undefined) return null
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return null
}

function isExported(statement: ts.VariableStatement): boolean {
  return statement.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword) === true
}

function exportedActionsInit(statement: ts.Statement): ts.Expression | null {
  if (!ts.isVariableStatement(statement) || !isExported(statement)) return null
  const declaration = statement.declarationList.declarations.find(
    (entry) => ts.isIdentifier(entry.name) && entry.name.text === 'actions'
  )
  return declaration?.initializer ?? null
}

function actionLiteral(source: ts.SourceFile): ts.ObjectLiteralExpression | null {
  for (const statement of source.statements) {
    let init = exportedActionsInit(statement)
    if (init === null) continue
    while (ts.isSatisfiesExpression(init) || ts.isAsExpression(init)) init = init.expression
    return ts.isObjectLiteralExpression(init) ? init : null
  }
  return null
}

export function parseServerFile(code: string, file: string): ServerCalls {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
  const calls: ServerCalls = {
    loadCalls: [],
    actionCalls: [],
    actionKeys: [],
    hasDefaultAction: false,
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      if (name === 'injectLoad' || name === 'withInjectedLoad') {
        calls.loadCalls.push({ routeId: stringArg(node, 1), scope: stringArg(node, 2) })
      } else if (name === 'injectActions') {
        calls.actionCalls.push(stringArg(node, 0))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const literal = actionLiteral(source)
  if (literal !== null) {
    calls.actionKeys = literal.properties.flatMap((property) => propertyKey(property) ?? [])
    calls.hasDefaultAction = calls.actionKeys.includes('default')
  }
  return calls
}
