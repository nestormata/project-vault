// Story 63-5: the rule behind the `repeated-static-ids` guard. Markup that renders more than once
// per page must not carry a literal id, or a literal id reference (`for`, `aria-describedby`, ...)
// that points at markup repeated with it: two rows then share one id, which is invalid HTML and
// breaks the help-text association (DW-611 on /notifications, the 19-3 tags help before it).
//
// Markup renders more than once when it sits in an `{#each}` body, in a `{#snippet}` rendered
// inside one (or rendered twice), or in a component that is itself rendered that way, transitively.
// A component also repeats when one file renders it twice outside mutually exclusive branches.
// Reads markup with `svelte/compiler`. Known limit: a snippet handed to another component that
// renders it in a loop is not followed across files.
import { posix } from 'node:path'
import { parse } from 'svelte/compiler'

export const ID_ATTRIBUTES: readonly string[] = [
  'id',
  'for',
  'aria-activedescendant',
  'aria-controls',
  'aria-describedby',
  'aria-details',
  'aria-errormessage',
  'aria-labelledby',
  'aria-owns',
]

export interface RepeatedStaticId {
  file: string
  line: number
  attribute: string
  value: string
  /** Why this markup renders more than once. */
  reason: string
}

interface Node {
  type: string
  start: number
  name?: string
  data?: string
  attributes?: { type: string; name: string; value: unknown; start: number }[]
  expression?: {
    type?: string
    name?: string
    value?: unknown
    expressions?: unknown[]
    quasis?: { value?: { cooked?: string } }[]
  }
  [key: string]: unknown
}

/** Where a piece of markup sits: the `{#each}` reason (if any), the innermost snippet, and the
 * exclusive branches it is under (`<block start>:<branch key>`). */
interface Site {
  each: string | null
  snippet: string | null
  branches: string[]
}

interface Ref extends Site {
  attribute: string
  value: string
  line: number
}

interface Use extends Site {
  target: string
  line: number
}

interface Render extends Site {
  name: string
}

interface ParsedFile {
  refs: Ref[]
  uses: Use[]
  renders: Render[]
}

const EXCLUSIVE_BRANCHES = new Map<string, readonly string[]>([
  ['IfBlock', ['consequent', 'alternate']],
  ['AwaitBlock', ['pending', 'then', 'catch']],
  ['EachBlock', ['body', 'fallback']],
])

function lineAt(code: string, index: number): number {
  return code.slice(0, index).split('\n').length
}

/** The string an `{...}` attribute value always yields: `{'x'}`, or a template literal with no
 * placeholders. */
function expressionText(tag: Node): unknown {
  const expression = tag.expression
  if (expression?.type !== 'TemplateLiteral') return expression?.value
  return expression.expressions?.length === 0 ? expression.quasis?.[0]?.value?.cooked : undefined
}

function literalValue(value: unknown): string | null {
  const parts = (Array.isArray(value) ? value : [value]) as (Node | true)[]
  if (parts.length === 0 || parts.some((part) => part === true)) return null
  const texts = parts.map((part) => {
    const node = part as Node
    if (node.type === 'Text') return node.data ?? ''
    const literal = node.type === 'ExpressionTag' ? expressionText(node) : undefined
    return typeof literal === 'string' ? literal : null
  })
  if (texts.some((text) => text === null)) return null
  const joined = texts.join('').trim()
  return joined === '' ? null : joined
}

function resolveImport(file: string, specifier: string): string | null {
  if (specifier.startsWith('$lib/')) return posix.normalize(`src/lib/${specifier.slice(5)}`)
  if (specifier.startsWith('.')) return posix.normalize(posix.join(posix.dirname(file), specifier))
  return null
}

interface ImportStatement {
  type: string
  source?: { value?: unknown }
  specifiers?: { local?: { name?: string } }[]
}

type ScriptAst = { content?: { body?: ImportStatement[] } } | null | undefined

function importTarget(file: string, statement: ImportStatement): string | null {
  const source = statement.source?.value
  if (statement.type !== 'ImportDeclaration' || typeof source !== 'string') return null
  return source.endsWith('.svelte') ? resolveImport(file, source) : null
}

function svelteImports(file: string, scripts: ScriptAst[]): Map<string, string> {
  const bound = new Map<string, string>()
  for (const statement of scripts.flatMap((script) => script?.content?.body ?? [])) {
    const target = importTarget(file, statement)
    const names = (statement.specifiers ?? []).map((specifier) => specifier.local?.name)
    for (const name of names) if (target !== null && name !== undefined) bound.set(name, target)
  }
  return bound
}

/** The callee of `{@render name(...)}` or `{@render name?.(...)}` (a ChainExpression wraps it). */
function renderedName(tag: Node): string | undefined {
  type Call = { callee?: { name?: string } }
  const call = tag.expression as (Call & { expression?: Call }) | undefined
  return (call?.expression ?? call)?.callee?.name
}

type LiteralRef = { attribute: string; value: string; line: number }

function literalIdAttributes(node: Node, code: string): LiteralRef[] {
  return (node.attributes ?? [])
    .filter((entry) => entry.type === 'Attribute' && ID_ATTRIBUTES.includes(entry.name))
    .map((entry) => ({
      attribute: entry.name,
      value: literalValue(entry.value),
      line: lineAt(code, entry.start),
    }))
    .filter((entry): entry is LiteralRef => entry.value !== null)
}

/** Records what one node contributes: a snippet render, a component use, literal id attributes. */
function recordNode(
  node: Node,
  site: Site,
  file: string,
  code: string,
  imports: Map<string, string>,
  out: ParsedFile
): void {
  const rendered = node.type === 'RenderTag' ? renderedName(node) : undefined
  if (rendered !== undefined) out.renders.push({ ...site, name: rendered })
  const target = node.type === 'SvelteSelf' ? file : componentTarget(node, imports)
  if (target !== undefined) out.uses.push({ ...site, target, line: lineAt(code, node.start) })
  for (const ref of literalIdAttributes(node, code)) out.refs.push({ ...site, ...ref })
}

function componentTarget(node: Node, imports: Map<string, string>): string | undefined {
  return node.type === 'Component' ? imports.get(node.name ?? '') : undefined
}

/** The site of `node`'s child under `key`: a snippet body names its snippet, an exclusive branch
 * is recorded, and an `{#each}` body repeats. */
function childSite(node: Node, key: string, site: Site, code: string): Site {
  let here =
    node.type === 'SnippetBlock' ? { ...site, snippet: String(node.expression?.name) } : site
  if (EXCLUSIVE_BRANCHES.get(node.type)?.includes(key)) {
    here = { ...here, branches: [...here.branches, `${node.start}:${key}`] }
  }
  if (node.type === 'EachBlock' && key === 'body') {
    here = { ...here, each: `inside the {#each} at line ${lineAt(code, node.start)}` }
  }
  return here
}

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === 'object' && typeof (value as Node).type === 'string'
}

function parseFile(file: string, code: string): ParsedFile {
  const root = parse(code, { modern: true, filename: file }) as unknown as {
    fragment: Node
    instance?: ScriptAst
    module?: ScriptAst
  }
  const imports = svelteImports(file, [root.instance, root.module])
  const out: ParsedFile = { refs: [], uses: [], renders: [] }
  const visit = (node: Node, site: Site): void => {
    recordNode(node, site, file, code, imports, out)
    for (const [key, child] of Object.entries(node)) {
      if (key === 'metadata' || key === 'expression') continue
      const children: unknown[] = Array.isArray(child) ? child : [child]
      const here = childSite(node, key, site, code)
      for (const entry of children) if (isNode(entry)) visit(entry, here)
    }
  }
  visit(root.fragment, { each: null, snippet: null, branches: [] })
  return out
}

function exclusive(a: Site, b: Site): boolean {
  return a.branches.some((branch) => {
    const block = branch.slice(0, branch.indexOf(':'))
    return b.branches.some((other) => other.startsWith(`${block}:`) && other !== branch)
  })
}

/** The first pair of sites in the list that can both render, or undefined. */
function concurrentPair<T extends Site>(sites: readonly T[]): [T, T] | undefined {
  const pairs = sites.flatMap((a, index) => sites.slice(index + 1).map((b): [T, T] => [a, b]))
  return pairs.find(([a, b]) => !exclusive(a, b))
}

/** Why markup at `site` in `parsed` renders more than once (lexically, within its own file). */
function lexicalReason(site: Site, parsed: ParsedFile, seen = new Set<string>()): string | null {
  if (site.each !== null) return site.each
  if (site.snippet === null || seen.has(site.snippet)) return null
  const snippet = site.snippet
  const renders = parsed.renders.filter((render) => render.name === snippet)
  const inner = new Set(seen).add(snippet)
  const looped = renders
    .map((render) => lexicalReason(render, parsed, inner))
    .find((reason) => reason !== null)
  if (looped !== undefined) return `in {#snippet ${snippet}}, rendered ${looped}`
  return concurrentPair(renders) === undefined
    ? null
    : `in {#snippet ${snippet}}, rendered more than once`
}

function usesByTarget(own: ParsedFile): Map<string, Use[]> {
  const byTarget = new Map<string, Use[]>()
  for (const use of own.uses) byTarget.set(use.target, [...(byTarget.get(use.target) ?? []), use])
  return byTarget
}

/** Files rendered more than once per page, with the reason; resolved to a fixed point. */
function repeatedFiles(parsed: ReadonlyMap<string, ParsedFile>): Map<string, string> {
  const repeated = new Map<string, string>()
  let grew = true
  while (grew) {
    grew = false
    for (const [file, own] of parsed) {
      for (const [target, uses] of usesByTarget(own)) {
        const reason = repeated.has(target) ? null : componentReason(file, uses, own, repeated)
        if (reason === null || !parsed.has(target)) continue
        repeated.set(target, reason)
        grew = true
      }
    }
  }
  return repeated
}

function componentReason(
  file: string,
  uses: readonly Use[],
  own: ParsedFile,
  repeated: ReadonlyMap<string, string>
): string | null {
  if (uses.some((use) => use.target === file)) return `rendered by itself (${file} is recursive)`
  for (const use of uses) {
    const reason = lexicalReason(use, own)
    if (reason !== null) return `rendered by ${file}:${use.line} ${reason}`
  }
  const pair = concurrentPair(uses)
  if (pair !== undefined)
    return `rendered twice by ${file} (lines ${pair[0].line}, ${pair[1].line})`
  const parent = repeated.get(file)
  return parent === undefined ? null : `rendered by ${file}:${uses[0]?.line}, which is ${parent}`
}

/** Every literal id, or literal id reference, in markup that renders more than once per page. A
 * reference is allowed when every id it names is a literal id the same file renders once (one
 * shared help element outside the loop). Throws the compiler's error for a file it cannot parse. */
export function repeatedStaticIds(files: ReadonlyMap<string, string>): RepeatedStaticId[] {
  const parsed = new Map([...files].map(([file, code]) => [file, parseFile(file, code)]))
  const repeated = repeatedFiles(parsed)
  const findings: RepeatedStaticId[] = []
  for (const [file, own] of parsed) {
    const reasonOf = (ref: Ref): string | null =>
      lexicalReason(ref, own) ?? repeated.get(file) ?? null
    const singleIds = new Set(
      own.refs
        .filter((ref) => ref.attribute === 'id' && reasonOf(ref) === null)
        .map((ref) => ref.value)
    )
    for (const ref of own.refs) {
      const reason = reasonOf(ref)
      if (reason === null) continue
      const shared =
        ref.attribute !== 'id' && ref.value.split(/\s+/).every((id) => singleIds.has(id))
      if (shared) continue
      findings.push({ file, line: ref.line, attribute: ref.attribute, value: ref.value, reason })
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}
