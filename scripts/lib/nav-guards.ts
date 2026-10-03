// Story 68.7 AC-10 (ADR 0007 M5, design §7): the two nav guards' library.
//
// - `checkNavIdsGuard`: PV's nav registry, read with the TypeScript parser (no execution: the
//   registry is pure data built from per-surface literals and spreads), and the surface builders.
//   Fails a registry or builder item without an id, a broken id grammar, a duplicate id, a PV id
//   outside its surface prefix and a parent that names a missing id. It does not freeze the id list.
// - `checkNavSurfacesGuard`: in PV-originated `.svelte` files, every `<nav>` element and every
//   `aria-current` attribute must live in a registered surface renderer (`file`), so a nav surface
//   cannot be hand-written outside the data model. Markup is parsed with `svelte/compiler`.
//
// Integrity only. Nothing is exempted by a list or a flag: a file is left out only when it is CM's
// (materialized under `_cm`, or recorded as CM's by a composition lock: provenance, never a path).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { cmFiles, type LockProvenance } from './injection-point-coverage.js'
import { svelteCompiler } from './route-files.js'
import { toRepoPath, walkFiles } from './scan-utils.js'

export type { LockProvenance }

export const NAV_REGISTRY_FILE = 'src/lib/navigation/nav-registry.ts'
const BUILDERS_DIR = 'src/lib/navigation/surfaces'
const RESERVED = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'toString',
  'valueOf',
])
const WORD = /^[a-z0-9]+$/
const CM_DIRS = ['src/lib/_cm/', 'src/lib/server/_cm/']

export interface RegistryId {
  id: string
  parent: string | null
  line: number
}

export interface RegistrySurface {
  id: string
  file: string
  ids: RegistryId[]
  /** Lines of items that have no id. */
  missing: number[]
}

function isNavIdText(id: string): boolean {
  return id
    .split('.')
    .every(
      (segment) => !RESERVED.has(segment) && segment.split('-').every((word) => WORD.test(word))
    )
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

function property(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of node.properties) {
    if (
      ts.isPropertyAssignment(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === name
    ) {
      return member.initializer
    }
  }
  return undefined
}

function hasProperty(node: ts.ObjectLiteralExpression, name: string): boolean {
  return node.properties.some(
    (member) =>
      (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) &&
      ts.isIdentifier(member.name) &&
      member.name.text === name
  )
}

function stringOf(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined
}

function readItems(
  source: ts.SourceFile,
  list: ts.Expression | undefined,
  parent: string | null,
  out: RegistrySurface
): void {
  if (list === undefined || !ts.isArrayLiteralExpression(list)) return
  for (const element of list.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue
    const id = stringOf(property(element, 'id'))
    if (id === undefined) out.missing.push(lineOf(source, element))
    else out.ids.push({ id, parent, line: lineOf(source, element) })
    readItems(source, property(element, 'children'), id ?? parent, out)
  }
}

/** Every surface literal (`{ id, file, contextKeys, items }`) in the registry, wherever it is
 * declared (the registry spreads per-surface constants into NAV_SURFACE_DEFS). */
export function readNavRegistrySource(webRoot: string): RegistrySurface[] {
  const path = join(webRoot, NAV_REGISTRY_FILE)
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const surfaces: RegistrySurface[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isObjectLiteralExpression(node) &&
      hasProperty(node, 'file') &&
      hasProperty(node, 'items')
    ) {
      const surface: RegistrySurface = {
        id: stringOf(property(node, 'id')) ?? '',
        file: stringOf(property(node, 'file')) ?? '',
        ids: [],
        missing: [],
      }
      readItems(source, property(node, 'items'), null, surface)
      surfaces.push(surface)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return surfaces
}

function idProblems(surfaces: readonly RegistrySurface[]): string[] {
  const known = new Set(surfaces.flatMap((surface) => surface.ids.map((entry) => entry.id)))
  const seen = new Set<string>()
  const problems: string[] = []
  for (const surface of surfaces) {
    for (const line of surface.missing)
      problems.push(`${NAV_REGISTRY_FILE}:${line}: a nav registry item has no id`)
    for (const entry of surface.ids) {
      if (seen.has(entry.id)) problems.push(`nav id "${entry.id}" is declared twice`)
      else if (!isNavIdText(entry.id)) problems.push(`nav id "${entry.id}" breaks the id grammar`)
      else if (!entry.id.startsWith(`${surface.id}.`)) {
        problems.push(`nav id "${entry.id}" must start with its surface id "${surface.id}."`)
      } else if (entry.parent !== null && !known.has(entry.parent)) {
        problems.push(`nav id "${entry.id}" names a missing parent "${entry.parent}"`)
      }
      seen.add(entry.id)
    }
  }
  return problems
}

/** Builder items: every object literal with a `label` must carry an `id` (shorthand or literal). */
function builderProblems(webRoot: string): string[] {
  const files = walkFiles(
    join(webRoot, BUILDERS_DIR),
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts')
  )
  return files.flatMap((file) => {
    const rel = toRepoPath(webRoot, file)
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const problems: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isObjectLiteralExpression(node) &&
        hasProperty(node, 'label') &&
        !hasProperty(node, 'id')
      ) {
        problems.push(`${rel}:${lineOf(source, node)}: a nav item has a label but no id`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return problems
  })
}

export function checkNavIdsGuard(webRoot: string): {
  problems: string[]
  surfaces: number
  ids: number
} {
  const surfaces = readNavRegistrySource(webRoot)
  if (surfaces.length === 0) {
    return { problems: [`${NAV_REGISTRY_FILE}: no nav surfaces found`], surfaces: 0, ids: 0 }
  }
  return {
    problems: [...idProblems(surfaces), ...builderProblems(webRoot)],
    surfaces: surfaces.length,
    ids: surfaces.reduce((count, surface) => count + surface.ids.length, 0),
  }
}

interface MarkupNode {
  type?: string
  name?: string
  start?: number
  attributes?: { type?: string; name?: string; start?: number }[]
}

function lineAt(code: string, index: number): number {
  return code.slice(0, index).split('\n').length
}

function usesOf(node: MarkupNode, code: string): { what: string; line: number }[] {
  const found =
    node.type === 'RegularElement' && node.name === 'nav'
      ? [{ what: '<nav>', line: lineAt(code, node.start ?? 0) }]
      : []
  for (const attribute of node.attributes ?? []) {
    if (attribute.type === 'Attribute' && attribute.name === 'aria-current') {
      found.push({ what: 'aria-current', line: lineAt(code, attribute.start ?? 0) })
    }
  }
  return found
}

function collectUses(value: unknown, code: string, found: { what: string; line: number }[]): void {
  if (Array.isArray(value)) {
    for (const child of value) collectUses(child, code, found)
    return
  }
  if (value === null || typeof value !== 'object') return
  found.push(...usesOf(value as MarkupNode, code))
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'metadata' && key !== 'attributes') collectUses(child, code, found)
  }
}

/** `<nav>` elements and `aria-current` attributes anywhere in a parsed Svelte file (comments are
 * Comment nodes, so `<nav` in a comment is not an element). */
function navUses(code: string, file: string): { what: string; line: number }[] {
  const root = svelteCompiler.parse(code, { modern: true, filename: file })
  const found: { what: string; line: number }[] = []
  collectUses(root.fragment, code, found)
  return found
}

export function checkNavSurfacesGuard(
  webRoot: string,
  lock?: LockProvenance
): { problems: string[]; scannedFiles: number } {
  const surfaces = readNavRegistrySource(webRoot)
  const renderers = new Set(surfaces.map((surface) => surface.file))
  const problems = surfaces
    .filter((surface) => !existsSync(join(webRoot, surface.file)))
    .map(
      (surface) =>
        `surface "${surface.id}" names a renderer file that does not exist: ${surface.file}`
    )
  const skip = cmFiles(lock)
  const files = walkFiles(join(webRoot, 'src'), (file) => file.endsWith('.svelte'))
    .map((file) => ({ file, rel: toRepoPath(webRoot, file) }))
    .filter(({ rel }) => !skip.has(rel) && !CM_DIRS.some((dir) => rel.startsWith(dir)))
  for (const { file, rel } of files) {
    if (renderers.has(rel)) continue
    for (const use of navUses(readFileSync(file, 'utf8'), file)) {
      problems.push(
        `${rel}:${use.line}: ${use.what} outside a registered nav surface renderer; register a surface in ${NAV_REGISTRY_FILE} and render it from data`
      )
    }
  }
  return { problems, scannedFiles: files.length }
}

/** A guard's exit: 0 with its OK line, or 1 with every problem listed under its FATAL line. */
export function reportGuard(problems: readonly string[], ok: string, fatal: string): number {
  if (problems.length === 0) {
    process.stdout.write(`${ok}\n`)
    return 0
  }
  process.stderr.write([`FATAL: ${fatal}:`, ...problems.map((p) => `  - ${p}`), ''].join('\n'))
  return 1
}
