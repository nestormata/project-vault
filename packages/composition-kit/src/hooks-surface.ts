// Story 68.6 AC-12 — what the web-host says about its hook contribution surface
// (`manifests/hooks-surface.json`, written by PV's pack script from PV's HOOK_SURFACE), and the
// informational notes about a pack's hook files. Nothing here refuses a hook or an export: names
// that are not hooks are ignored by PV's composition and listed so CM's review sees them (Q11).
import type * as TypeScript from 'typescript'
import { readHostManifest } from './registry.js'
import type { HooksContribution, UiPackManifest } from './types.js'

export type HookFileKind = 'server' | 'universal' | 'client'

export interface HooksSurface {
  server: string[]
  universal: string[]
  client: string[]
  /** PV's own protected prefixes (segment-prefix semantics). */
  protectedPrefixes: string[]
}

const KINDS: readonly HookFileKind[] = ['server', 'universal', 'client']
/** The composed hooks file each contribution kind feeds. */
export const HOOK_FILES: ReadonlyMap<HookFileKind, string> = new Map([
  ['server', 'src/hooks.server.ts'],
  ['universal', 'src/hooks.ts'],
  ['client', 'src/hooks.client.ts'],
])
/** Non-Kit exports PV's server composition consumes. */
const SERVER_EXTRAS = ['headerPolicy']

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : undefined
}

function hooksOf(surface: HooksSurface, kind: HookFileKind): string[] {
  return new Map<HookFileKind, string[]>([
    ['server', surface.server],
    ['universal', surface.universal],
    ['client', surface.client],
  ]).get(kind) as string[]
}

/** Reads `manifests/hooks-surface.json`; no surface for an older web-host without it. */
export function readHooksSurface(hostDir: string): { surface?: HooksSurface; problems: string[] } {
  try {
    const raw = readHostManifest(hostDir, 'hooks-surface.json')
    if (raw === undefined) return { problems: [] }
    const record = new Map(Object.entries(raw as object))
    const [server, universal, client, prefixes] = [
      ...KINDS.map((kind) => stringList(record.get(kind))),
      stringList(record.get('protectedPrefixes')),
    ]
    if (
      record.get('schemaVersion') !== 1 ||
      server === undefined ||
      universal === undefined ||
      client === undefined ||
      prefixes === undefined
    ) {
      throw new Error('expected { schemaVersion: 1, server, universal, client, protectedPrefixes }')
    }
    return { surface: { server, universal, client, protectedPrefixes: prefixes }, problems: [] }
  } catch (error) {
    return { problems: [`manifests/hooks-surface.json: ${(error as Error).message}`] }
  }
}

function hasExportModifier(ts: typeof TypeScript, node: TypeScript.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
}

function declarationNames(ts: typeof TypeScript, node: TypeScript.Node): string[] {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.flatMap((decl) =>
      ts.isIdentifier(decl.name) ? [decl.name.text] : []
    )
  }
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    return node.name === undefined ? [] : [node.name.text]
  }
  return []
}

function namesOf(ts: typeof TypeScript, node: TypeScript.Node): string[] {
  if (hasExportModifier(ts, node)) return declarationNames(ts, node)
  if (!ts.isExportDeclaration(node) || node.isTypeOnly || node.exportClause === undefined) return []
  const clause = node.exportClause
  return ts.isNamedExports(clause)
    ? clause.elements.filter((e) => !e.isTypeOnly).map((e) => e.name.text)
    : []
}

/** The value names a module exports, read with the app's own TypeScript (types are skipped). */
export function exportNames(source: string, ts: typeof TypeScript, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false)
  const names: string[] = []
  sf.forEachChild((node) => {
    names.push(...namesOf(ts, node))
  })
  return names
}

/** True when `a` and `b` differ by one edit (substitution, insertion, deletion) or one adjacent
 * transposition (`handel` -> `handle`). */
function nearMiss(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && a.charAt(i) === b.charAt(i)) i++
  const restA = a.slice(i)
  const restB = b.slice(i)
  const edits = [
    restA.slice(1) === restB.slice(1),
    restA.slice(1) === restB,
    restA === restB.slice(1),
  ]
  const swapped = restA.charAt(1) + restA.charAt(0) + restA.slice(2)
  return edits.includes(true) || (restA.length > 1 && swapped === restB)
}

/** Q11 / AC-12 notes for one hook file's export names. */
export function hookExportNotes(
  kind: HookFileKind,
  names: readonly string[],
  surface: HooksSurface
): string[] {
  const own = new Set([...hooksOf(surface, kind), ...(kind === 'server' ? SERVER_EXTRAS : [])])
  return names.flatMap((name) => {
    if (own.has(name)) return []
    const elsewhere = KINDS.find(
      (other) => other !== kind && hooksOf(surface, other).includes(name)
    )
    if (elsewhere !== undefined)
      return [`hooks.${kind}: \`${name}\` is a ${elsewhere} hook; move it to hooks.${elsewhere}`]
    const near = [...own].find((hook) => nearMiss(name, hook))
    const hint = near === undefined ? '' : `; did you mean \`${near}\`?`
    return [
      `hooks.${kind}: export \`${name}\` is not a SvelteKit ${kind} hook; not composed${hint}`,
    ]
  })
}

/** The hook kinds a manifest contributes, with their pack paths. */
export function hookEntries(hooks: HooksContribution | undefined): [HookFileKind, string][] {
  return Object.entries(hooks ?? {}).filter(
    (entry): entry is [HookFileKind, string] =>
      (KINDS as readonly string[]).includes(entry[0]) && typeof entry[1] === 'string'
  )
}

/** AC-11: a full override of a hooks file wins; a contribution for that file is not composed. */
export function overriddenHookNotes(
  hooks: HooksContribution | undefined,
  overridden: ReadonlySet<string>
): string[] {
  return hookEntries(hooks).flatMap(([kind]) => {
    const file = HOOK_FILES.get(kind) as string
    return overridden.has(file)
      ? [
          `hooks.${kind} contribution is not composed because ${file} is overridden; import it from your override if you want it`,
        ]
      : []
  })
}

export function hookKindsOf(manifest: UiPackManifest): HookFileKind[] {
  return hookEntries(manifest.hooks).map(([kind]) => kind)
}
