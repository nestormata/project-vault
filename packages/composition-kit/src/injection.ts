// Story 68.4: integrity checks for injection contributions, and the lock section that records them.
// Every check here is about the declaration being mechanically usable (a named export exists, an
// action key is not claimed twice, the host can route the behavior). None of them limits what a
// component, `load` or `action` may import, render or do, and none can refuse an injection that
// could instead be expressed as a page override (M1) or a component replacement (M4).
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import type * as TypeScript from 'typescript'
import type { MaterializeResult } from './materialize.js'
import { compareCodeUnits, normalizePackPath } from './paths.js'
import { requirePeer } from './peers.js'
import type { PointRoute, Registries } from './registry.js'
import type { Host, Pack } from './sources.js'
import type { InjectionContribution, UiPackManifest } from './types.js'

type Ts = typeof TypeScript

export interface LockInjection {
  point: string
  component: string
  order: number
  load: string | null
  actions: string | null
  routeId: string | null
  scope: string | null
}

export interface InjectionFindings {
  problems: string[]
  notes: string[]
  lock: LockInjection[]
}

interface ExportInfo {
  names: Set<string>
  hasDefault: boolean
  stars: string[]
  /** Keys of an `export const actions = { ... }` literal in this file. */
  actionKeys: string[]
  actionsIsLiteral: boolean
}

const SPECIFIER_SUFFIXES = ['', '.ts', '.js', '.mts', '.mjs', '/index.ts', '/index.js']

function hasExportModifier(ts: Ts, node: TypeScript.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword) === true
}

function bindingNames(ts: Ts, name: TypeScript.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(ts, element.name)
  )
}

function literalKeys(ts: Ts, literal: TypeScript.ObjectLiteralExpression): string[] {
  return literal.properties.flatMap((property) => {
    const name = ts.isSpreadAssignment(property) ? undefined : property.name
    return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))
      ? [name.text]
      : []
  })
}

function actionsLiteral(
  ts: Ts,
  declaration: TypeScript.VariableDeclaration
): TypeScript.ObjectLiteralExpression | undefined {
  if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'actions') return undefined
  let value = declaration.initializer
  while (value !== undefined && (ts.isSatisfiesExpression(value) || ts.isAsExpression(value))) {
    value = value.expression
  }
  return value !== undefined && ts.isObjectLiteralExpression(value) ? value : undefined
}

function collectVariables(ts: Ts, statement: TypeScript.VariableStatement, info: ExportInfo): void {
  for (const declaration of statement.declarationList.declarations) {
    for (const name of bindingNames(ts, declaration.name)) info.names.add(name)
    const literal = actionsLiteral(ts, declaration)
    if (literal !== undefined) {
      info.actionsIsLiteral = true
      info.actionKeys = literalKeys(ts, literal)
    }
  }
}

function collectFunction(
  ts: Ts,
  statement: TypeScript.FunctionDeclaration,
  info: ExportInfo
): void {
  const isDefault = statement.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.DefaultKeyword)
  if (isDefault === true) info.hasDefault = true
  else if (statement.name !== undefined) info.names.add(statement.name.text)
}

function collectExportDeclaration(
  ts: Ts,
  statement: TypeScript.ExportDeclaration,
  info: ExportInfo
): void {
  const clause = statement.exportClause
  if (clause !== undefined && ts.isNamedExports(clause)) {
    for (const element of clause.elements) {
      if (element.name.text === 'default') info.hasDefault = true
      else info.names.add(element.name.text)
    }
  } else if (clause === undefined && statement.moduleSpecifier !== undefined) {
    if (ts.isStringLiteralLike(statement.moduleSpecifier))
      info.stars.push(statement.moduleSpecifier.text)
  }
}

function collectStatement(ts: Ts, statement: TypeScript.Statement, info: ExportInfo): void {
  if (ts.isExportAssignment(statement)) info.hasDefault = true
  else if (ts.isExportDeclaration(statement)) collectExportDeclaration(ts, statement, info)
  else if (ts.isVariableStatement(statement) && hasExportModifier(ts, statement)) {
    collectVariables(ts, statement, info)
  } else if (ts.isFunctionDeclaration(statement) && hasExportModifier(ts, statement)) {
    collectFunction(ts, statement, info)
  }
}

function analyze(ts: Ts, text: string, file: string): ExportInfo {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const info: ExportInfo = {
    names: new Set(),
    hasDefault: false,
    stars: [],
    actionKeys: [],
    actionsIsLiteral: false,
  }
  for (const statement of source.statements) collectStatement(ts, statement, info)
  return info
}

type Presence = 'yes' | 'no' | 'unverified'

class ExportReader {
  private readonly cache = new Map<string, ExportInfo>()

  constructor(
    private readonly ts: Ts,
    private readonly pack: Pack
  ) {}

  info(rel: string): ExportInfo | undefined {
    const known = this.cache.get(rel)
    if (known !== undefined) return known
    const abs = this.pack.files.get(rel)
    if (abs === undefined) return undefined
    const info = analyze(this.ts, readFileSync(abs, 'utf8'), rel)
    this.cache.set(rel, info)
    return info
  }

  private resolve(from: string, specifier: string): string | undefined {
    if (!specifier.startsWith('.')) return undefined
    const base = posix.normalize(posix.join(posix.dirname(from), specifier))
    const stem = base.replace(/\.(js|mjs)$/, '')
    return [...SPECIFIER_SUFFIXES.map((suffix) => `${base}${suffix}`), `${stem}.ts`].find(
      (candidate) => this.pack.files.has(candidate)
    )
  }

  /** Whether `rel` exports `name`: directly, or through one level of the pack's own `export *`. */
  has(rel: string, name: string): { presence: Presence; hasDefault: boolean } {
    const info = this.info(rel)
    if (info === undefined) return { presence: 'unverified', hasDefault: false }
    if (info.names.has(name)) return { presence: 'yes', hasDefault: info.hasDefault }
    let presence: Presence = 'no'
    for (const specifier of info.stars) {
      const target = this.resolve(rel, specifier)
      const inner = target === undefined ? undefined : this.info(target)
      if (inner === undefined) presence = 'unverified'
      else if (inner.names.has(name)) return { presence: 'yes', hasDefault: info.hasDefault }
      else if (inner.stars.length > 0) presence = 'unverified'
    }
    return { presence, hasDefault: info.hasDefault }
  }
}

interface Declared {
  point: string
  index: number
  entry: InjectionContribution
}

function declaredContributions(manifest: UiPackManifest): Declared[] {
  return Object.entries(manifest.injections ?? {}).flatMap(([point, list]) =>
    list.map((entry, index) => ({ point, index, entry }))
  )
}

function packPath(reference: string | undefined): string | null {
  return reference === undefined ? null : normalizePackPath(reference)
}

interface Context {
  ts: Ts
  reader: ExportReader
  pack: Pack
  host: Host
  routes: ReadonlyMap<string, PointRoute>
  registryFiles: ReadonlyMap<string, string | null>
  registryPresent: boolean
  out: { problems: string[]; notes: string[] }
}

function checkExport(
  ctx: Context,
  field: string,
  reference: string | undefined,
  name: 'load' | 'actions'
): void {
  const rel = packPath(reference)
  if (rel === null || !ctx.pack.files.has(rel)) return // the missing file is reported once, by the composer
  const { presence, hasDefault } = ctx.reader.has(rel, name)
  if (presence === 'no') {
    const hint = hasDefault
      ? ' (a default export is not accepted: the contract is the explicit named export)'
      : ''
    ctx.out.problems.push(`${field}: ${rel} has no named export "${name}"${hint}`)
  } else if (presence === 'unverified') {
    ctx.out.notes.push(
      `${field}: "${name}" in ${rel} is re-exported through a chain deeper than one level; not verified`
    )
  }
}

function checkActionNames(ctx: Context, point: string, declared: readonly Declared[]): void {
  const owners = new Map<string, string>()
  for (const { entry } of declared) {
    const rel = packPath(entry.actions)
    const info = rel === null ? undefined : ctx.reader.info(rel)
    if (rel === null || info === undefined || !info.actionsIsLiteral) continue
    for (const key of info.actionKeys) {
      const full = `${point}.${key}`
      const owner = owners.get(full)
      if (owner !== undefined && owner !== rel) {
        ctx.out.problems.push(`action "${full}" is exported by both ${owner} and ${rel}`)
      }
      owners.set(full, rel)
    }
  }
}

/** Reads the host page server file beside the point's page and reports a `default` action. */
function defaultActionProblem(ctx: Context, point: string, file: string | null): string | null {
  if (file === null) return null
  const hostRel = posix.join(posix.dirname(file), '+page.server.ts')
  const abs = ctx.host.files.get(hostRel)
  if (abs === undefined) return null
  const info = analyze(ctx.ts, readFileSync(abs, 'utf8'), hostRel)
  if (!info.actionKeys.includes('default')) return null
  return (
    `injections.${point}.actions: ${hostRel} exports a default action, and Kit forbids a default ` +
    'action next to named ones on one route. PV story needed: convert the default action to a ' +
    'named one (guardrail 3), or override the page (M1)'
  )
}

function behaviorNeedsRoute(route: PointRoute | undefined): boolean {
  return route === undefined || route.scope === null || route.routeId === null
}

function declaresBehavior(declared: readonly Declared[]): boolean {
  return declared.some(({ entry }) => entry.load !== undefined || entry.actions !== undefined)
}

function declaresActions(declared: readonly Declared[]): boolean {
  return declared.some(({ entry }) => entry.actions !== undefined)
}

function routeFinding(ctx: Context, point: string, route: PointRoute | undefined): boolean {
  if (route?.scope === 'component') {
    ctx.out.notes.push(
      `component-scoped point "${point}": behavior injection arrives with Epic 69; its load and actions are recorded in the lock and are inert`
    )
    return true
  }
  if (!behaviorNeedsRoute(route)) return false
  ctx.out.problems.push(
    `injections.${point}: behavior injection (load/actions) needs a newer web-host that records a route id and scope for this point; ` +
      'components-only injection still works, or override the page (M1)'
  )
  return true
}

/** Behavior the host has no way to run is refused rather than recorded and silently dropped: an
 * error page has no load or actions, and a layout has a load but no form actions. */
function unrunnableBehavior(
  ctx: Context,
  point: string,
  route: PointRoute | undefined,
  declared: readonly Declared[]
): boolean {
  const way = 'override the page (M1)'
  if (route?.scope === 'error') {
    ctx.out.problems.push(
      `injections.${point}: an error-scoped point has no load or actions (Kit runs no server code for an error page); ${way}`
    )
    return true
  }
  if ((route?.scope === 'layout' || route?.scope === 'shell') && declaresActions(declared)) {
    ctx.out.problems.push(
      `injections.${point}: a layout-scoped point has no form actions (Kit has no actions on a layout); ${way}`
    )
    return true
  }
  return false
}

function checkBehavior(ctx: Context, point: string, declared: readonly Declared[]): void {
  // No behavior, or an unknown point (reported by the registry check): nothing to route.
  if (!declaresBehavior(declared) || !ctx.registryFiles.has(point)) return
  const route = ctx.routes.get(point)
  if (routeFinding(ctx, point, route)) return
  if (unrunnableBehavior(ctx, point, route, declared)) return
  if (declaresActions(declared) && route?.scope === 'page') {
    const problem = defaultActionProblem(ctx, point, ctx.registryFiles.get(point) ?? null)
    if (problem !== null) ctx.out.problems.push(problem)
  }
}

function lockEntries(
  manifest: UiPackManifest,
  composedPath: (reference: string | undefined) => string | null,
  routes: ReadonlyMap<string, PointRoute>
): LockInjection[] {
  const entries = declaredContributions(manifest).map(({ point, entry }) => ({
    point,
    component: composedPath(entry.component) ?? entry.component,
    order: entry.order ?? 0,
    load: composedPath(entry.load),
    actions: composedPath(entry.actions),
    routeId: routes.get(point)?.routeId ?? null,
    scope: routes.get(point)?.scope ?? null,
  }))
  // Array.prototype.sort is stable: contributions with the same order keep the manifest's order.
  return entries.sort((a, b) => compareCodeUnits(a.point, b.point) || a.order - b.order)
}

export interface InjectionInput {
  manifest: UiPackManifest
  pack: Pack
  host: Host
  registries: Registries
  mat: MaterializeResult
  resolveFrom: string
  composedPath: (reference: string | undefined, mat: MaterializeResult) => string | null
}

export function checkInjections(input: InjectionInput): InjectionFindings {
  if (declaredContributions(input.manifest).length === 0)
    return { problems: [], notes: [], lock: [] }
  const ts = requirePeer<Ts>('typescript', input.resolveFrom)
  const out = { problems: [] as string[], notes: [] as string[] }
  const routes = new Map((input.registries.pointRoutes ?? []).map((route) => [route.name, route]))
  const registryFiles = new Map(
    (input.registries.injectionPoints ?? []).map((point) => [point.name, point.file])
  )
  const ctx: Context = {
    ts,
    reader: new ExportReader(ts, input.pack),
    pack: input.pack,
    host: input.host,
    routes,
    registryFiles,
    registryPresent: input.registries.injectionPoints !== undefined,
    out,
  }
  const declared = declaredContributions(input.manifest)
  for (const { point, entry } of declared) {
    const field = `injections.${point}`
    checkExport(ctx, `${field}.load`, entry.load, 'load')
    checkExport(ctx, `${field}.actions`, entry.actions, 'actions')
  }
  for (const point of new Set(declared.map((item) => item.point))) {
    const atPoint = declared.filter((item) => item.point === point)
    checkActionNames(ctx, point, atPoint)
    checkBehavior(ctx, point, atPoint)
  }
  const composedPath = (reference: string | undefined): string | null =>
    input.composedPath(reference, input.mat)
  return {
    problems: out.problems,
    notes: out.notes,
    lock: lockEntries(input.manifest, composedPath, routes),
  }
}
