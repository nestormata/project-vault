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

function walk(node: unknown, code: string, out: ParsedMarkup, rules: RegionRules): void {
  if (Array.isArray(node)) {
    if (node.some((child) => (child as Node | null)?.type === 'Comment')) {
      const found = regionsIn(node as Node[], code)
      out.regions.push(...found.regions)
      out.regionProblems.push(...found.problems, ...(rules.requirePoint ? found.pointless : []))
    }
    for (const child of node) walk(child, code, out, rules)
    return
  }
  if (node === null || typeof node !== 'object') return
  const record = node as Node
  if (isPoint(record))
    out.points.push({ name: literalName(record), line: lineAt(code, record.start) })
  for (const child of childrenOf(record)) walk(child, code, out, rules)
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
    regionProblems: [],
    regions: [],
    svelteImports: importedSvelteNames(root),
    topLevel: ((root.fragment as { nodes?: Node[] }).nodes ?? []) as Node[],
  }
  walk(root.fragment, code, out, rules)
  return out
}

/** The 68-4 view: points and malformed `@region` blocks, including "holds no `<InjectionPoint>`". */
export function parseMarkup(code: string, file: string): ParsedMarkup {
  return parseRegions(code, file, { requirePoint: true })
}
