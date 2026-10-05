// Story 68.10 AC-4.4: the ONE markup walker for `<InjectionPoint>` uses and `<!-- @region <name> -->`
// blocks. Story 68.4 wrote it in `scripts/lib/route-files.ts` (not shipped); it lives here so the
// repository's route scan and the shipped `monolithic-region` guard share one parse and one marker
// regex. It reads markup with `svelte/compiler`, never with a regex over source text, and imports
// nothing outside `node:` and `svelte/compiler`, so the compiled copy runs from a published package.
import { parse } from 'svelte/compiler'

export interface Node {
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

/** A point the template can never render: inside a `{#snippet}` the file never `{@render}`s, or in
 * markup behind a literal-false `{#if}`. It does not count as rendering its name. */
export interface DeadPoint extends PointUse {
  reason: string
}

export interface RegionProblem {
  line: number
  message: string
}

/** A well-formed `@region` marker and the element or block it describes. */
export interface Region {
  name: string
  line: number
  node: Node
}

export interface ParsedMarkup {
  points: PointUse[]
  /** Points that sit where the template never renders them (not part of `points`). */
  deadPoints: DeadPoint[]
  /** Points inside a `{#snippet}` of this file, until `settleSnippetPoints` places them. */
  snippetPoints: DeadPoint[]
  regionProblems: RegionProblem[]
  regions: Region[]
  /** Local names bound by an `import` of a `.svelte` file (instance and module script). */
  svelteImports: Map<string, string>
  /** The direct children of the template fragment (the root `<script>`/`<style>` are not in it). */
  topLevel: Node[]
}

const REGION_COMMENT = /^\s*@region\s+(\S+)\s*$/
const REGION_WORD = /^\s*@region\b/

export function lineAt(code: string, index: number): number {
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

export function childrenOf(node: Node): unknown[] {
  return Object.entries(node)
    .filter(([key, value]) => key !== 'metadata' && typeof value === 'object' && value !== null)
    .map(([, value]) => value)
}

export function containsPoint(node: unknown): boolean {
  if (Array.isArray(node)) return node.some((child) => containsPoint(child))
  if (node === null || typeof node !== 'object') return false
  if (isPoint(node)) return true
  return childrenOf(node as Node).some((child) => containsPoint(child))
}

export function isBlankText(node: Node): boolean {
  return node.type === 'Text' && (node.data ?? '').trim() === ''
}

function regionsIn(
  siblings: Node[],
  code: string
): { problems: RegionProblem[]; regions: Region[]; pointless: RegionProblem[] } {
  const problems: RegionProblem[] = []
  const pointless: RegionProblem[] = []
  const regions: Region[] = []
  siblings.forEach((node, index) => {
    if (node.type !== 'Comment' || !REGION_WORD.test(node.data ?? '')) return
    const line = lineAt(code, node.start)
    const name = REGION_COMMENT.exec(node.data ?? '')?.[1]
    if (name === undefined) {
      problems.push({ line, message: '@region comment must be written `<!-- @region <name> -->`' })
      return
    }
    const next = siblings.slice(index + 1).find((sibling) => !isBlankText(sibling))
    if (next === undefined) {
      problems.push({ line, message: '@region comment is not followed by an element or block' })
      return
    }
    regions.push({ name, line, node: next })
    if (!containsPoint(next)) {
      pointless.push({ line, message: '@region block contains no <InjectionPoint>' })
    }
  })
  return { problems, regions, pointless }
}

/** Where a walk currently is, for the points it meets. */
interface Site {
  /** Inside markup that can never render (a literal-false `{#if}` branch). */
  dead: string | null
  /** The `{#snippet}` the node sits in, unless a component receives it as a prop. */
  snippet: string | null
  /** Directly inside a component's body, where a `{#snippet}` is a prop the component renders. */
  inComponent: boolean
}

const LIVE: Site = { dead: null, snippet: null, inComponent: false }

/** `{#if false}` / `{#if 0}` (and a literal-true test's `{:else}`): a branch no render reaches. */
function deadBranch(node: Node): 'consequent' | 'alternate' | null {
  const test = node.test as { type?: string; value?: unknown } | undefined
  if (test?.type !== 'Literal') return null
  return test.value ? 'alternate' : 'consequent'
}

function nextSite(record: Node, site: Site): Site {
  if (record.type === 'Component' || record.type === 'SvelteComponent') {
    return { ...site, inComponent: true }
  }
  if (record.type !== 'SnippetBlock') return site
  const name = (record.expression as { name?: string } | undefined)?.name ?? '?'
  // A snippet written in a component's body is a prop that component renders: it is not dead.
  const snippet = site.inComponent || site.snippet !== null ? site.snippet : name
  return { ...site, snippet, inComponent: false }
}

function recordPoint(record: Node, code: string, out: ParsedMarkup, site: Site): void {
  const use: PointUse = { name: literalName(record), line: lineAt(code, record.start) }
  if (site.dead !== null) out.deadPoints.push({ ...use, reason: site.dead })
  else if (site.snippet !== null) out.snippetPoints.push({ ...use, reason: site.snippet })
  else out.points.push(use)
}

function walkList(
  siblings: unknown[],
  code: string,
  out: ParsedMarkup,
  rules: RegionRules,
  site: Site
): void {
  if (siblings.some((child) => (child as Node | null)?.type === 'Comment')) {
    const found = regionsIn(siblings as Node[], code)
    out.regions.push(...found.regions)
    out.regionProblems.push(...found.problems, ...(rules.requirePoint ? found.pointless : []))
  }
  for (const child of siblings) walk(child, code, out, rules, site)
}

const NEVER_RENDERED = 'inside markup behind a literal {#if} that never renders it'

function walkChildren(
  record: Node,
  here: Site,
  code: string,
  out: ParsedMarkup,
  rules: RegionRules
): void {
  const never = record.type === 'IfBlock' ? deadBranch(record) : null
  for (const [key, child] of Object.entries(record)) {
    if (key === 'metadata' || typeof child !== 'object' || child === null) continue
    walk(child, code, out, rules, key === never ? { ...here, dead: NEVER_RENDERED } : here)
  }
}

function walk(
  node: unknown,
  code: string,
  out: ParsedMarkup,
  rules: RegionRules,
  site = LIVE
): void {
  if (Array.isArray(node)) return walkList(node, code, out, rules, site)
  if (node === null || typeof node !== 'object') return
  const record = node as Node
  if (isPoint(record)) recordPoint(record, code, out, site)
  walkChildren(record, nextSite(record, site), code, out, rules)
}

interface CallLike {
  type?: string
  callee?: { name?: string }
  expression?: CallLike
}

/** The name a `{@render name(...)}` / `{@render name?.(...)}` tag calls, if it is a plain name. */
function renderedName(tag: Node): string | undefined {
  const call = tag.expression as CallLike | undefined
  const inner = call?.type === 'ChainExpression' ? call.expression : call
  return inner?.callee?.name
}

/** The callee names of every `{@render name(...)}` in the file. */
function renderedNames(node: unknown, names: Set<string>): void {
  const record = node as Node | null
  if (record === null || typeof record !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) renderedNames(child, names)
    return
  }
  const name = record.type === 'RenderTag' ? renderedName(record) : undefined
  if (name !== undefined) names.add(name)
  for (const child of childrenOf(record)) renderedNames(child, names)
}

/** A point in a `{#snippet}` counts only when the same file renders that snippet. */
function settleSnippetPoints(root: SvelteRoot, out: ParsedMarkup): void {
  if (out.snippetPoints.length === 0) return
  const rendered = new Set<string>()
  renderedNames(root.fragment, rendered)
  for (const { reason: snippet, ...use } of out.snippetPoints) {
    if (rendered.has(snippet)) out.points.push(use)
    else
      out.deadPoints.push({
        ...use,
        reason: `inside {#snippet ${snippet}}, which is never rendered`,
      })
  }
  out.points.sort((a, b) => a.line - b.line)
}

interface RegionRules {
  /** 68-4's rule: the block must hold an `<InjectionPoint>`. The monolithic guard turns it off. */
  requirePoint: boolean
}

interface ImportStatement {
  type: string
  source?: { value?: unknown }
  specifiers?: { local?: { name?: string } }[]
}

interface ScriptAst {
  content?: { body?: ImportStatement[] }
}

function svelteImportSource(statement: ImportStatement): string | undefined {
  const source = statement.source?.value
  const isSvelte = typeof source === 'string' && source.endsWith('.svelte')
  return statement.type === 'ImportDeclaration' && isSvelte ? source : undefined
}

function importedSvelteNames(root: { instance?: ScriptAst | null; module?: ScriptAst | null }) {
  const bound = new Map<string, string>()
  const statements = [root.instance, root.module].flatMap((script) => script?.content?.body ?? [])
  for (const statement of statements) {
    const source = svelteImportSource(statement)
    if (source === undefined) continue
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.local?.name !== undefined) bound.set(specifier.local.name, source)
    }
  }
  return bound
}

interface SvelteRoot {
  fragment: Node
  instance?: ScriptAst | null
  module?: ScriptAst | null
}

/** Parses once: the `<InjectionPoint>` uses (literal names, in source order), the well-formed
 * `@region` blocks, the malformed ones, and the `.svelte` bindings imported by the file's scripts.
 * Throws the compiler's error for a file it cannot parse. */
export function parseRegions(code: string, file: string, rules: RegionRules): ParsedMarkup {
  const root = parse(code, { modern: true, filename: file }) as unknown as SvelteRoot
  const out: ParsedMarkup = {
    points: [],
    deadPoints: [],
    snippetPoints: [],
    regionProblems: [],
    regions: [],
    svelteImports: importedSvelteNames(root),
    topLevel: ((root.fragment as { nodes?: Node[] }).nodes ?? []) as Node[],
  }
  walk(root.fragment, code, out, rules)
  settleSnippetPoints(root, out)
  return out
}

/** The 68-4 view: points and malformed `@region` blocks, including "holds no `<InjectionPoint>`". */
export function parseMarkup(code: string, file: string): ParsedMarkup {
  return parseRegions(code, file, { requirePoint: true })
}
