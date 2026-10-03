// Story 68.4 AC-3: PV's own half of the injection-point mechanism (AGPL, apps/web/config). Two Vite
// plugins that live in PV's build whether or not a composition kit is present:
//
//   1. `injectionEntries()` rewrites every `<InjectionPoint name="a.b.c" ...>` use site so the point's
//      module is imported STATICALLY (`import __pvInject_0 from 'virtual:pv-inject/a.b.c'`) and passed
//      as `entries={__pvInject_0}`. An ES import cannot take a variable, so `name` must be a literal.
//      One module per point is what gives each point its own code-split chunk, and a static import is
//      what makes the injected markup render on the server (no `{#await}`, no `import()`).
//   2. `emptyInjectionModules()` resolves every `virtual:pv-inject/*` to an empty list and
//      `virtual:pv-inject-behavior` to empty load/action tables. It runs `enforce: 'post'`, so the kit's
//      `pvInject()` (`enforce: 'pre'`) wins wherever a pack contributes; in PV's own CM-free build every
//      point is empty and renders its fallback, so PV's markup, data and network behaviour are unchanged.
import { parse } from 'svelte/compiler'
import type { Plugin } from 'vite'

export const INJECTION_MODULE_PREFIX = 'virtual:pv-inject/'
export const BEHAVIOR_MODULE_ID = 'virtual:pv-inject-behavior'
const COMPONENT_NAME = 'InjectionPoint'
const IMPORT_NAME = '__pvInject_'
const RESOLVED = '\0'

/** The module source of an empty point: no contribution, the fallback renders. */
export const EMPTY_POINT_MODULE = 'export default []\n'
/** The module source of empty behavior tables (PV's own build). */
export const EMPTY_BEHAVIOR_MODULE =
  'export const loads = Object.freeze(Object.create(null))\n' +
  'export const actions = Object.freeze(Object.create(null))\n'

interface AstNode {
  type: string
  start: number
  end: number
  name?: string
  data?: string
  expression?: { type?: string; value?: unknown }
  attributes?: AttributeNode[]
  [key: string]: unknown
}

interface AttributeNode {
  type: string
  name: string
  start: number
  end: number
  value: true | AstNode | AstNode[]
}

interface ScriptNode {
  start: number
  end: number
  content: { start: number }
  attributes: AttributeNode[]
}

interface RootNode {
  fragment: AstNode
  instance?: ScriptNode | null
  module?: ScriptNode | null
}

function collect(node: unknown, found: AstNode[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, found)
    return
  }
  if (node === null || typeof node !== 'object') return
  const record = node as AstNode
  if (record.type === 'Component' && record.name === COMPONENT_NAME) found.push(record)
  for (const [key, child] of Object.entries(record)) {
    if (key !== 'metadata' && typeof child === 'object') collect(child, found)
  }
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split('\n').length
}

/** The string a `name` attribute value spells out literally (`name="a.b.c"` or `name={"a.b.c"}`). */
function literalValue(value: AttributeNode['value']): string | null {
  const parts = Array.isArray(value) ? value : [value]
  const [only] = parts
  if (parts.length !== 1 || only === undefined || only === true) return null
  if (only.type === 'Text') return only.data ?? null
  const literal = only.type === 'ExpressionTag' ? only.expression?.value : undefined
  return typeof literal === 'string' ? literal : null
}

/** The literal point name of one `<InjectionPoint>` use, or a build error naming file and line. */
function literalName(code: string, file: string, node: AstNode): string {
  const location = `${file}:${lineOf(code, node.start)}`
  const attribute = (node.attributes ?? []).find(
    (entry) => entry.type === 'Attribute' && entry.name === 'name'
  )
  if (attribute === undefined) {
    throw new Error(`InjectionPoint needs a "name" attribute (${location})`)
  }
  const name = literalValue(attribute.value)
  if (name === null) {
    throw new Error(
      `InjectionPoint name must be a string literal because its module is imported statically (${location})`
    )
  }
  return name
}

function hasEntries(node: AstNode): boolean {
  return (node.attributes ?? []).some((entry) => entry.name === 'entries')
}

function freeImportName(code: string, taken: Set<string>, index: number): string {
  let suffix = index
  let candidate = `${IMPORT_NAME}${suffix}`
  while (code.includes(candidate) || taken.has(candidate)) {
    suffix += 1
    candidate = `${IMPORT_NAME}${suffix}`
  }
  taken.add(candidate)
  return candidate
}

function langAttribute(script: ScriptNode | null | undefined): string {
  const lang = script?.attributes.find((entry) => entry.name === 'lang')
  const value = lang?.value
  const first = Array.isArray(value) ? value[0] : undefined
  return first?.type === 'Text' && typeof first.data === 'string' ? ` lang="${first.data}"` : ''
}

/** Rewrites the `<InjectionPoint>` use sites of one `.svelte` file, or returns null when there are
 * none to rewrite. Exported for tests. */
export function rewriteInjectionPoints(code: string, file: string): string | null {
  if (!code.includes(COMPONENT_NAME)) return null
  const root = parse(code, { modern: true, filename: file }) as unknown as RootNode
  const uses: AstNode[] = []
  collect(root.fragment, uses)
  const todo = uses.filter((node) => !hasEntries(node))
  if (todo.length === 0) return null

  const taken = new Set<string>()
  const imports: string[] = []
  const edits: { at: number; text: string }[] = []
  for (const [index, node] of todo.entries()) {
    const name = literalName(code, file, node)
    const identifier = freeImportName(code, taken, index)
    const specifier = `${INJECTION_MODULE_PREFIX}${name}`
    imports.push(`import ${identifier} from ${JSON.stringify(specifier)}`)
    edits.push({ at: node.start + 1 + COMPONENT_NAME.length, text: ` entries={${identifier}}` })
  }
  const block = imports.join('\n')
  if (!root.instance) {
    const lang = langAttribute(root.module)
    edits.push({ at: 0, text: `<script${lang}>\n${block}\n</script>\n` })
  } else {
    edits.push({ at: root.instance.content.start, text: `\n${block}\n` })
  }
  // Apply from the end of the file backwards so earlier offsets stay valid.
  let output = code
  for (const edit of edits.toSorted((a, b) => b.at - a.at)) {
    output = `${output.slice(0, edit.at)}${edit.text}${output.slice(edit.at)}`
  }
  return output
}

/** Adds the static per-point import to every `<InjectionPoint>` (PV's and any pack's). */
export function injectionEntries(): Plugin {
  return {
    name: 'pv-injection-entries',
    enforce: 'pre',
    transform(code, id) {
      // A query (`?raw`, `?url`, `?svelte&type=style`) means the module is not component source.
      if (!id.endsWith('.svelte')) return null
      const rewritten = rewriteInjectionPoints(code, id)
      return rewritten === null ? null : { code: rewritten, map: null }
    },
  }
}

/** PV's own, empty answer to every injection virtual module. */
export function emptyInjectionModules(): Plugin {
  return {
    name: 'pv-injection-empty',
    enforce: 'post',
    resolveId(id) {
      if (id.startsWith(INJECTION_MODULE_PREFIX) || id === BEHAVIOR_MODULE_ID) {
        return `${RESOLVED}${id}`
      }
      return null
    },
    load(id) {
      if (id.startsWith(`${RESOLVED}${INJECTION_MODULE_PREFIX}`)) return EMPTY_POINT_MODULE
      if (id === `${RESOLVED}${BEHAVIOR_MODULE_ID}`) return EMPTY_BEHAVIOR_MODULE
      return null
    },
  }
}
