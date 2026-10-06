// @pv-guard monolithic-region
// @pv-scope pv-originated-only
//
// Story 68.10 AC-4 (ADR 0007 guardrail 1, design section 6): a region marked
// `<!-- @region <name> -->` in a PV-originated `.svelte` file must be a component or contain one,
// so it can be replaced on its own through the M4 registry and `pv-original:`. "A component" is a
// capitalized tag (or dotted member) whose binding is imported from a `.svelte` file in the same
// file's scripts, a `<svelte:component>`, or a `{@render}` marked node. `<InjectionPoint>` never
// counts, otherwise 68-4's required point would make the rule vacuous. A region that is only plain
// HTML, text and a point is monolithic.
//
// Story 69.5 adds two rules for PV ROUTE files only (`src/routes/**/+page|+layout|+error.svelte`):
//  R1 (unmarked top-level content): every top-level template node must be inside an `@region` or be
//     a component use / `{@render}`. "Top-level" descends through root-level `{#if}`/`{#each}`/
//     `{#await}`/`{#key}`/`<svelte:boundary>` branches, and through LAYOUT WRAPPERS: an element with
//     no direct text, no attribute other than class/id/style/role/data-*/aria-*, and at least one
//     child, whose children are themselves covered. Ignored: `<svelte:head|window|document|body>`,
//     comments, blank text, `{@const}`, `<InjectionPoint>`; `{#snippet}` bodies are checked like a branch. A route file that holds
//     nothing but points has no regions and fails too (points are not content).
//  R2 (thin region shell): inside a marked region of a route file only elements that hold something
//     (no text, no form controls, no handlers/binds/actions), `<InjectionPoint>`, components,
//     `{@render}` and `{#if}`/`{#each}`/`{#key}`/`{#await}` blocks around those. The markup lives in
//     the component, not in the shell.
//  R3 (Story 69.6, top-level component use outside a region): in a route file a top-level component
//     use (`<Foo />`, `<Foo.Bar />`, `<svelte:component>` or `{@render}`) that is not itself the marked
//     region is a finding, unless the component it uses holds an `@region` of its own (the 69.1-69.4
//     pattern: a region component hosts its regions). R1 let a bare use through because it can be
//     replaced (M4); R3 closes the gap that left it without an injection point. A marked region that is only a `{@render}` is a finding
//     too: it holds no component of its own. The scan also counts the top-level uses and how many sit
//     in a region, the figure `check-injection-point-coverage` prints.
// Neither rule has a suppression syntax, a baseline or a skip list; `$lib` components are not route
// files and are checked by the replaceability rule only.
//
// The rule checks REPLACEABILITY, not size: a region wrapped in a trivial component passes (a known
// limit, whether that extraction is meaningful is 69.5's componentization audit). There is no
// suppression syntax, no baseline and no allow-list of region names. Files a composition lock
// records as CM's are exempt by provenance (the caller passes the list), nothing else is.
//
// Ships with web-host (`guards/monolithic-region.js`, registry kind "script"), so `pv-verify` runs
// the same rule over a composed tree. Imports only `node:`, `svelte/compiler` and the shared walker.
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  childrenOf,
  isBlankText,
  lineAt,
  parseRegions,
  type Node,
  type ParsedMarkup,
} from './region-markup.js'
import { walkSvelte } from './svelte-files.js'

export interface MonolithicFinding {
  line: number
  message: string
}

export interface FileScan {
  regions: number
  /** Route files only: top-level component uses (marked regions plus unmarked uses). */
  uses?: number
  /** Route files only: how many of those uses are the marked region (the rest are R3 findings). */
  usesInRegion?: number
  /** Route files only: every top-level use in source order, for the audit listing. */
  useList?: TopLevelUse[]
  /** True when the file is a route file (R1 and R2 applied). */
  route?: boolean
  findings: MonolithicFinding[]
}

/** One top-level use of a route file: a marked region, a use of a component that hosts its own
 * region (`covered`), or a use no region holds (`UNCOVERED`, an R3 finding). */
export interface TopLevelUse {
  line: number
  use: string
  status: 'covered' | 'UNCOVERED'
  /** `render` for a `{@render}` use (a render-only position), `component` otherwise. */
  kind: 'component' | 'render'
}

export interface TreeFinding extends MonolithicFinding {
  file: string
}

export interface TreeScan {
  files: number
  /** Regions in route files only (`+page`/`+layout`/`+error.svelte`); a part of `regions`. */
  routeRegions: number
  /** Files left out because the lock records them as CM's (not part of `files`). */
  exempted: number
  regions: number
  /** Route files only: top-level component uses, and how many of them sit in a region (R3). */
  topLevelUses: number
  topLevelUsesInRegion: number
  findings: TreeFinding[]
}

const INJECTION_POINT = 'InjectionPoint'
const TEST_SUPPORT = /(^|\/)src\/lib\/test\//
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]s$/
const ROUTE_FILE_NAMES = new Set(['+page.svelte', '+layout.svelte', '+error.svelte'])
const IGNORED_TOP_LEVEL = new Set([
  'SvelteHead',
  'SvelteWindow',
  'SvelteDocument',
  'SvelteBody',
  'ConstTag',
  'DebugTag',
])
const FORM_TAGS = new Set(['input', 'select', 'textarea', 'button', 'form', 'label', 'a', 'img'])
const WRAPPER_ATTRIBUTES = new Set(['class', 'id', 'style', 'role'])
const WRAPPER_ATTRIBUTE_PREFIXES = ['data-', 'aria-']
const TEXT_NODES = new Set(['Text', 'ExpressionTag', 'HtmlTag'])

function isPointImport(source: string | undefined): boolean {
  return source?.split('/').at(-1) === `${INJECTION_POINT}.svelte`
}

function isComponentUse(node: Node, imports: ReadonlyMap<string, string>): boolean {
  if (node.type === 'SvelteComponent') return true
  if (node.type !== 'Component' || node.name === undefined) return false
  const binding = node.name.split('.')[0] ?? ''
  const source = imports.get(binding)
  if (node.name === INJECTION_POINT || isPointImport(source)) return false
  return source !== undefined
}

function containsComponent(node: unknown, imports: ReadonlyMap<string, string>): boolean {
  if (Array.isArray(node)) return node.some((child) => containsComponent(child, imports))
  if (node === null || typeof node !== 'object') return false
  if (isComponentUse(node as Node, imports)) return true
  return childrenOf(node as Node).some((child) => containsComponent(child, imports))
}

function isReplaceable(node: Node, imports: ReadonlyMap<string, string>): boolean {
  return node.type === 'RenderTag' || containsComponent(node, imports)
}

type Fragmentish = { nodes?: Node[] } | null | undefined

function nodesOf(fragment: unknown): Node[] {
  return (fragment as Fragmentish)?.nodes ?? []
}

/** The template fragments a block node branches into (transparent for R1 and R2). */
function branchesOf(node: Node): Node[][] | null {
  switch (node.type) {
    case 'IfBlock':
      return [nodesOf(node.consequent), nodesOf(node.alternate)]
    case 'EachBlock':
      return [nodesOf(node.body), nodesOf(node.fallback)]
    case 'AwaitBlock':
      return [nodesOf(node.pending), nodesOf(node.then), nodesOf(node.catch)]
    case 'SnippetBlock':
      return [nodesOf(node.body)]
    case 'KeyBlock':
    case 'SvelteBoundary':
    case 'SvelteFragment':
      return [nodesOf(node.fragment)]
    default:
      return null
  }
}

function isElement(node: Node): boolean {
  return node.type === 'RegularElement' || node.type === 'SvelteElement'
}

function isBlankOrComment(node: Node): boolean {
  return node.type === 'Comment' || isBlankText(node)
}

function describe(node: Node): string {
  if (isElement(node)) return `<${node.name ?? 'element'}>`
  if (node.type === 'Text') return 'text'
  if (node.type === 'ExpressionTag') return '{expression}'
  if (node.type === 'HtmlTag') return '{@html}'
  return `{${node.type}}`
}

function describeUse(node: Node, code: string): string {
  if (node.type === 'RenderTag') return code.slice(node.start, node.end)
  if (node.type === 'SvelteComponent') return '<svelte:component>'
  return `<${node.name ?? 'component'} />`
}

function isPoint(node: Node, imports: ReadonlyMap<string, string>): boolean {
  if (node.type !== 'Component') return false
  return node.name === INJECTION_POINT || isPointImport(imports.get(node.name?.split('.')[0] ?? ''))
}

function isWrapperAttribute(attribute: { type: string; name: string }): boolean {
  if (attribute.type === 'ClassDirective' || attribute.type === 'StyleDirective') return true
  if (attribute.type !== 'Attribute') return false
  return (
    WRAPPER_ATTRIBUTES.has(attribute.name) ||
    WRAPPER_ATTRIBUTE_PREFIXES.some((prefix) => attribute.name.startsWith(prefix))
  )
}

function isLayoutWrapper(node: Node): boolean {
  if (!isElement(node) || !(node.attributes ?? []).every(isWrapperAttribute)) return false
  const children = nodesOf(node.fragment).filter((child) => !isBlankOrComment(child))
  return children.length > 0 && !children.some((child) => TEXT_NODES.has(child.type))
}

function isRouteFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return (
    ROUTE_FILE_NAMES.has(name) && (path.startsWith('src/routes/') || path.includes('/src/routes/'))
  )
}

/** What R3 needs to look through a component use: the app root, a way to read a component file and
 * a per-scan parse cache. */
export interface ScanContext {
  appRoot: string | null
  /** The source of an absolute `.svelte` path, or undefined when it cannot be read. */
  read: (absolutePath: string) => string | undefined
  holdsRegion: Map<string, boolean>
}

/** `$lib/x.svelte` and `./x.svelte` to an absolute path; a package import resolves to nothing. */
function resolveSvelteImport(ctx: ScanContext, fromFile: string, source: string): string | null {
  if (source.startsWith('$lib/') && ctx.appRoot !== null) {
    return join(ctx.appRoot, 'src', 'lib', source.slice('$lib/'.length))
  }
  if (source.startsWith('./') || source.startsWith('../')) return resolve(dirname(fromFile), source)
  return null
}

function fileHoldsRegion(path: string, ctx: ScanContext): boolean {
  const code = ctx.read(path)
  if (code === undefined) return false
  try {
    return parseRegions(code, path, { requirePoint: false }).regions.length > 0
  } catch {
    return false
  }
}

interface Site {
  code: string
  file: string
  ctx: ScanContext
  marked: ReadonlyMap<Node, string>
  imports: ReadonlyMap<string, string>
}

/** True when the component this use names carries an `@region` in its own file, so the use already
 * has an injection position (a region component hosting its own regions). */
function usesRegionComponent(node: Node, site: Site): boolean {
  if (node.type !== 'Component' || node.name === undefined) return false
  const source = site.imports.get(node.name.split('.')[0] ?? '')
  const path = source === undefined ? null : resolveSvelteImport(site.ctx, site.file, source)
  if (path === null) return false
  const known = site.ctx.holdsRegion.get(path)
  if (known !== undefined) return known
  const holds = fileHoldsRegion(path, site.ctx)
  site.ctx.holdsRegion.set(path, holds)
  return holds
}

interface Coverage {
  findings: MonolithicFinding[]
  /** Marked regions met at top level. */
  covered: number
  /** Unmarked top-level uses (R3 findings, also part of `findings`). */
  unmarkedUses: number
  /** Every top-level use met, in source order. */
  uses: TopLevelUse[]
}

type Cover = 'skip' | 'covered' | 'use' | 'descend' | 'finding'

function coverOf(node: Node, site: Site): Cover {
  const { imports } = site
  if (isBlankOrComment(node) || IGNORED_TOP_LEVEL.has(node.type) || isPoint(node, imports)) {
    return 'skip'
  }
  if (site.marked.has(node) || usesRegionComponent(node, site)) return 'covered'
  if (isComponentUse(node, imports) || node.type === 'RenderTag') return 'use'
  return branchesOf(node) !== null || isLayoutWrapper(node) ? 'descend' : 'finding'
}

function recordUse(node: Node, status: TopLevelUse['status'], site: Site, out: Coverage): void {
  const region = site.marked.get(node)
  out.uses.push({
    line: lineAt(site.code, node.start),
    use: region === undefined ? describeUse(node, site.code) : `@region ${region}`,
    status,
    kind: node.type === 'RenderTag' ? 'render' : 'component',
  })
  if (status === 'covered') {
    out.covered += 1
    return
  }
  out.unmarkedUses += 1
  out.findings.push({
    line: lineAt(site.code, node.start),
    message: `unmarked top-level component use: ${describeUse(node, site.code)} (wrap it in a region component with a registered point)`,
  })
}

function unmarkedTopLevel(nodes: Node[], site: Site, out: Coverage): void {
  for (const node of nodes) {
    const cover = coverOf(node, site)
    if (cover === 'covered') recordUse(node, 'covered', site, out)
    else if (cover === 'use') recordUse(node, 'UNCOVERED', site, out)
    else if (cover === 'descend') {
      for (const branch of branchesOf(node) ?? [nodesOf(node.fragment)]) {
        unmarkedTopLevel(branch, site, out)
      }
    } else if (cover === 'finding') {
      out.findings.push({
        line: lineAt(site.code, node.start),
        message: `unmarked top-level content: ${describe(node)} (put it in a region component)`,
      })
    }
  }
}

function isPlainAttribute(attribute: { type: string; name: string }): boolean {
  if (attribute.type === 'ClassDirective' || attribute.type === 'StyleDirective') return true
  return attribute.type === 'Attribute' && !attribute.name.startsWith('on')
}

/** An element that is real markup rather than a shell: a form control or link, a handler/bind/
 * action, direct text, or nothing inside it. */
function isInlineElement(node: Node, children: Node[]): boolean {
  return (
    FORM_TAGS.has(node.name ?? '') ||
    !(node.attributes ?? []).every(isPlainAttribute) ||
    children.length === 0 ||
    children.some((child) => TEXT_NODES.has(child.type))
  )
}

const SHELL_PARTS = new Set(['ConstTag', 'RenderTag'])
const COMPONENT_NODES = new Set(['Component', 'SvelteComponent'])

function shellChildren(node: Node, branches: Node[][] | null): Node[] {
  return branches?.flat() ?? nodesOf(node.fragment).filter((child) => !isBlankOrComment(child))
}

/** The first node inside a region shell that is real markup rather than a component, a point, a
 * render or a block around those (R2). */
function shellOffender(node: Node): Node | null {
  if (isBlankOrComment(node) || SHELL_PARTS.has(node.type)) return null
  if (COMPONENT_NODES.has(node.type)) return firstOffender(nodesOf(node.fragment))
  const branches = branchesOf(node)
  if (branches === null && !isElement(node)) return node
  const children = shellChildren(node, branches)
  if (branches === null && isInlineElement(node, children)) return node
  return firstOffender(children)
}

function firstOffender(nodes: Node[]): Node | null {
  for (const child of nodes) {
    const offender = shellOffender(child)
    if (offender !== null) return offender
  }
  return null
}

function routeCoverage(
  parsed: ParsedMarkup,
  where: { code: string; file: string; ctx: ScanContext }
): Coverage {
  const marked = new Map(parsed.regions.map((region) => [region.node, region.name]))
  const site: Site = { ...where, marked, imports: parsed.svelteImports }
  const coverage: Coverage = { findings: [], covered: 0, unmarkedUses: 0, uses: [] }
  unmarkedTopLevel(parsed.topLevel, site, coverage)
  if (coverage.covered === 0 && coverage.findings.length === 0) {
    coverage.findings.push({
      line: 1,
      message:
        'route file has no regions: it holds nothing but injection points (points are not content)',
    })
  }
  for (const region of parsed.regions) {
    if (region.node.type === 'RenderTag') {
      coverage.findings.push({
        line: region.line,
        message: `@region "${region.name}" is only a {@render}: it holds no component of its own`,
      })
      continue
    }
    const offender = shellOffender(region.node)
    if (offender === null) continue
    coverage.findings.push({
      line: region.line,
      message: `@region "${region.name}" is not a thin shell: ${describe(offender)} holds markup that belongs in its component`,
    })
  }
  return coverage
}

/** A fresh scan context for `appRoot` (null: component imports are not looked through). `read`
 * supplies a component's source; the default reads nothing, so a use is looked through only when
 * the caller says how to read files (the tree scan and the route audit do). */
export function newScanContext(
  appRoot: string | null,
  read: ScanContext['read'] = () => undefined
): ScanContext {
  return { appRoot: appRoot === null ? null : resolve(appRoot), read, holdsRegion: new Map() }
}

/** Scans one `.svelte` source. A file the compiler cannot parse is a finding: an unparseable file
 * must never hide a region (fail closed). */
export function scanMonolithicRegions(
  source: string,
  file = '<source>',
  ctx: ScanContext = newScanContext(null)
): FileScan {
  let parsed
  try {
    parsed = parseRegions(source, file, { requirePoint: false })
  } catch (error) {
    const reason = (error as Error).message.split('\n')[0] ?? 'parse error'
    return {
      regions: 0,
      findings: [
        {
          line: 1,
          message: `file could not be parsed, so its regions were not checked: ${reason}`,
        },
      ],
    }
  }
  const findings: MonolithicFinding[] = parsed.regionProblems.map((problem) => ({ ...problem }))
  for (const region of parsed.regions) {
    if (isReplaceable(region.node, parsed.svelteImports)) continue
    findings.push({
      line: region.line,
      message: `@region "${region.name}" is a monolithic region (neither a component nor does it contain one)`,
    })
  }
  const route = isRouteFile(toPosix(file))
  const coverage = route ? routeCoverage(parsed, { code: source, file, ctx }) : null
  if (coverage !== null) findings.push(...coverage.findings)
  findings.sort((a, b) => a.line - b.line)
  if (coverage === null) return { regions: parsed.regions.length, findings }
  return {
    regions: parsed.regions.length,
    route,
    uses: coverage.covered + coverage.unmarkedUses,
    usesInRegion: coverage.covered,
    useList: coverage.uses,
    findings,
  }
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function addScan(result: TreeScan, rel: string, scan: FileScan): void {
  result.files += 1
  result.regions += scan.regions
  if (scan.route === true) result.routeRegions += scan.regions
  result.topLevelUses += scan.uses ?? 0
  result.topLevelUsesInRegion += scan.usesInRegion ?? 0
  result.findings.push(...scan.findings.map((finding) => ({ ...finding, file: rel })))
}

/** Scans every `.svelte` file under `<appRoot>/src` (test support and test files excluded, like the
 * 68-4 coverage guard). `exemptFiles` are app-relative paths the lock records as CM's. */
export function scanMonolithicRegionsTree(
  appRoot: string,
  exemptFiles: readonly string[] = []
): TreeScan {
  const exempt = new Set(exemptFiles)
  const root = resolve(appRoot)
  const sources = new Map<string, string>()
  const files = [...walkSvelte(join(root, 'src'))]
  for (const absolute of files) sources.set(absolute, readFileSync(absolute, 'utf8'))
  const ctx = newScanContext(root, (path) => sources.get(path))
  const result: TreeScan = {
    files: 0,
    exempted: 0,
    regions: 0,
    routeRegions: 0,
    topLevelUses: 0,
    topLevelUsesInRegion: 0,
    findings: [],
  }
  for (const absolute of files) {
    const rel = toPosix(relative(root, absolute))
    if (TEST_SUPPORT.test(rel) || TEST_FILE.test(rel)) continue
    if (exempt.has(rel)) result.exempted += 1
    else addScan(result, rel, scanMonolithicRegions(sources.get(absolute) ?? '', absolute, ctx))
  }
  return result
}

/** The script-guard contract (`manifests/guards.json`, kind "script"). `exemptFiles` carries the
 * lock's CM-originated paths (the kit passes them to `pv-originated-only` guards). */
export function runGuard(
  appRoot: string,
  exemptFiles: readonly string[] = []
): { file: string; message: string }[] {
  return scanMonolithicRegionsTree(appRoot, exemptFiles).findings.map((finding) => ({
    file: finding.file,
    message: `${finding.file}:${finding.line}: ${finding.message}`,
  }))
}
