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
//     comments, blank text, `{#snippet}`, `{@const}`, `<InjectionPoint>`. A route file that holds
//     nothing but points has no regions and fails too (points are not content).
//  R2 (thin region shell): inside a marked region of a route file only elements that hold something
//     (no text, no form controls, no handlers/binds/actions), `<InjectionPoint>`, components,
//     `{@render}` and `{#if}`/`{#each}`/`{#key}`/`{#await}` blocks around those. The markup lives in
//     the component, not in the shell.
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
import { join, relative, resolve, sep } from 'node:path'
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
  /** True when the file is a route file (R1 and R2 applied). */
  route?: boolean
  findings: MonolithicFinding[]
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
  'SnippetBlock',
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

interface Coverage {
  findings: MonolithicFinding[]
  covered: number
}

type Cover = 'skip' | 'covered' | 'descend' | 'finding'

function coverOf(
  node: Node,
  marked: ReadonlySet<Node>,
  imports: ReadonlyMap<string, string>
): Cover {
  if (isBlankOrComment(node) || IGNORED_TOP_LEVEL.has(node.type) || isPoint(node, imports)) {
    return 'skip'
  }
  if (marked.has(node) || isComponentUse(node, imports) || node.type === 'RenderTag') {
    return 'covered'
  }
  return branchesOf(node) !== null || isLayoutWrapper(node) ? 'descend' : 'finding'
}

function unmarkedTopLevel(
  nodes: Node[],
  marked: ReadonlySet<Node>,
  imports: ReadonlyMap<string, string>,
  code: string,
  out: Coverage
): void {
  for (const node of nodes) {
    const cover = coverOf(node, marked, imports)
    if (cover === 'covered') out.covered += 1
    else if (cover === 'descend') {
      for (const branch of branchesOf(node) ?? [nodesOf(node.fragment)]) {
        unmarkedTopLevel(branch, marked, imports, code, out)
      }
    } else if (cover === 'finding') {
      out.findings.push({
        line: lineAt(code, node.start),
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

const SHELL_PARTS = new Set(['ConstTag', 'RenderTag', 'Component', 'SvelteComponent'])

function shellChildren(node: Node, branches: Node[][] | null): Node[] {
  return branches?.flat() ?? nodesOf(node.fragment).filter((child) => !isBlankOrComment(child))
}

/** The first node inside a region shell that is real markup rather than a component, a point, a
 * render or a block around those (R2). */
function shellOffender(node: Node): Node | null {
  if (isBlankOrComment(node) || SHELL_PARTS.has(node.type)) return null
  const branches = branchesOf(node)
  if (branches === null && !isElement(node)) return node
  const children = shellChildren(node, branches)
  if (branches === null && isInlineElement(node, children)) return node
  for (const child of children) {
    const offender = shellOffender(child)
    if (offender !== null) return offender
  }
  return null
}

function routeFindings(parsed: ParsedMarkup, code: string): MonolithicFinding[] {
  const marked = new Set(parsed.regions.map((region) => region.node))
  const coverage: Coverage = { findings: [], covered: 0 }
  unmarkedTopLevel(parsed.topLevel, marked, parsed.svelteImports, code, coverage)
  if (coverage.covered === 0 && coverage.findings.length === 0) {
    coverage.findings.push({
      line: 1,
      message:
        'route file has no regions: it holds nothing but injection points (points are not content)',
    })
  }
  for (const region of parsed.regions) {
    const offender = shellOffender(region.node)
    if (offender === null) continue
    coverage.findings.push({
      line: region.line,
      message: `@region "${region.name}" is not a thin shell: ${describe(offender)} holds markup that belongs in its component`,
    })
  }
  return coverage.findings
}

/** Scans one `.svelte` source. A file the compiler cannot parse is a finding: an unparseable file
 * must never hide a region (fail closed). */
export function scanMonolithicRegions(source: string, file = '<source>'): FileScan {
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
  if (route) findings.push(...routeFindings(parsed, source))
  findings.sort((a, b) => a.line - b.line)
  return route
    ? { regions: parsed.regions.length, route, findings }
    : { regions: parsed.regions.length, findings }
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** Scans every `.svelte` file under `<appRoot>/src` (test support and test files excluded, like the
 * 68-4 coverage guard). `exemptFiles` are app-relative paths the lock records as CM's. */
export function scanMonolithicRegionsTree(
  appRoot: string,
  exemptFiles: readonly string[] = []
): TreeScan {
  const exempt = new Set(exemptFiles)
  const root = resolve(appRoot)
  const result: TreeScan = { files: 0, exempted: 0, regions: 0, routeRegions: 0, findings: [] }
  for (const absolute of walkSvelte(join(root, 'src'))) {
    const rel = toPosix(relative(root, absolute))
    if (TEST_SUPPORT.test(rel) || TEST_FILE.test(rel)) continue
    if (exempt.has(rel)) {
      result.exempted += 1
      continue
    }
    const scan = scanMonolithicRegions(readFileSync(absolute, 'utf8'), absolute)
    result.files += 1
    result.regions += scan.regions
    if (scan.route === true) result.routeRegions += scan.regions
    result.findings.push(...scan.findings.map((finding) => ({ ...finding, file: rel })))
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
