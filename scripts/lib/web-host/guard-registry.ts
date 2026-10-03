// Story 68.9 AC-1: `manifests/guards.json` of the packed @project-vault/web-host, generated from the
// guard files themselves. A test is a guard when its first comment block carries the marker line
// `@pv-guard <id>`; the marker (never a name list) is the single source. Optional marker lines:
//   @pv-scope pv-originated-only   the guard exempts CM-originated files (PV-duty guards only)
//   @pv-entries <kind>             the pack entry section the guard merges (browserStorage, ...)
//   @pv-subject <specifier>        an import that is a SUBJECT of the guard (a module whose own
//                                  behaviour the file also asserts), not guard machinery, so a
//                                  pack that overrides it is not replaced by the pristine copy
// A script guard (a shipped function the kit imports) carries the same marker in `apps/web/guards`.
// Output is byte-deterministic: sorted by id, no timestamps, posix paths relative to the package.
import { createHash } from 'node:crypto'
import ts from 'typescript'
import {
  moduleSpecifiers,
  relativePosix,
  resolveSpecifier,
  type GraphResolver,
} from './import-graph.js'

export const GUARDS_MANIFEST = 'guards.json'
export const GUARD_LICENSE = 'AGPL-3.0-or-later'

export type GuardScope = 'all-files' | 'pv-originated-only'

export interface GuardClosureFile {
  file: string
  sha256: string
}

export interface GuardEntry {
  id: string
  kind: 'test' | 'script'
  file: string
  scope: GuardScope
  entries?: string
  license: string
  closure: GuardClosureFile[]
}

export interface GuardMarker {
  id: string
  scope: GuardScope
  entries?: string
  subjects: string[]
}

/** The text of the comments before the first statement of a file. */
export function leadingCommentText(code: string): string {
  const shebang = code.startsWith('#!') ? code.indexOf('\n') + 1 : 0
  const ranges = ts.getLeadingCommentRanges(code, shebang) ?? []
  return ranges.map((range) => code.slice(range.pos, range.end)).join('\n')
}

const MARKER_ID = /@pv-guard[ \t]+([a-z][a-z0-9-]*)/
const MARKER_SCOPE = /@pv-scope[ \t]+(all-files|pv-originated-only)/
const MARKER_ENTRIES = /@pv-entries[ \t]+([A-Za-z]+)/
const MARKER_SUBJECT = /@pv-subject[ \t]+(\S+)/g

/** The guard marker in a file's leading comment block, or undefined when it is not a guard. */
export function guardMarker(code: string): GuardMarker | undefined {
  const header = leadingCommentText(code)
  const id = MARKER_ID.exec(header)?.[1]
  if (id === undefined) return undefined
  const scope = (MARKER_SCOPE.exec(header)?.[1] ?? 'all-files') as GuardScope
  const entries = MARKER_ENTRIES.exec(header)?.[1]
  const subjects = [...header.matchAll(MARKER_SUBJECT)].map((match) => match[1] ?? '')
  return { id, scope, ...(entries === undefined ? {} : { entries }), subjects }
}

export interface GuardRegistryInput {
  /** Package root of apps/web, absolute. */
  webDir: string
  /** Absolute paths of the shipped self-contained tests. */
  testFiles: readonly string[]
  /** Absolute paths of the shipped script guards (`apps/web/guards/*.ts`, non-test). */
  scriptFiles: readonly string[]
  resolver: GraphResolver
}

export interface GuardRegistry {
  text: string
  guards: GuardEntry[]
  problems: string[]
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function sha256(file: string, resolver: GraphResolver): string {
  const text = resolver.readFile(file) ?? ''
  return createHash('sha256').update(text).digest('hex')
}

/** The guard's helper closure: every module its runtime imports reach, except through an import
 * the guard names as a subject. The guard file itself is not part of it. */
function helperClosure(
  guardFile: string,
  subjects: readonly string[],
  input: GuardRegistryInput
): GuardClosureFile[] {
  const seen = new Set<string>([guardFile])
  const queue = [guardFile]
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const code = input.resolver.readFile(file) ?? ''
    for (const { specifier, typeOnly } of moduleSpecifiers(code, file)) {
      if (typeOnly || (file === guardFile && subjects.includes(specifier))) continue
      const target = resolveSpecifier(specifier, file, input.resolver)
      if (target.kind === 'file' && !seen.has(target.path)) {
        seen.add(target.path)
        queue.push(target.path)
      }
    }
  }
  seen.delete(guardFile)
  return [...seen]
    .map((file) => ({
      file: relativePosix(input.webDir, file),
      sha256: sha256(file, input.resolver),
    }))
    .sort((a, b) => compareCodeUnits(a.file, b.file))
}

/** Compiled copy of a script guard inside the package: `guards/x.ts` ships as `guards/x.js`. */
function shippedScriptPath(webDir: string, file: string): string {
  return relativePosix(webDir, file).replace(/\.ts$/, '.js')
}

export function buildGuardRegistry(input: GuardRegistryInput): GuardRegistry {
  const problems: string[] = []
  const guards: GuardEntry[] = []
  const claimed = new Map<string, string>()
  const consider = (file: string, kind: 'test' | 'script'): void => {
    const marker = guardMarker(input.resolver.readFile(file) ?? '')
    if (marker === undefined) return
    const display = relativePosix(input.webDir, file)
    const first = claimed.get(marker.id)
    if (first !== undefined) {
      problems.push(`guard id ${marker.id} is claimed by both ${first} and ${display}`)
      return
    }
    claimed.set(marker.id, display)
    guards.push({
      id: marker.id,
      kind,
      file: kind === 'test' ? display : shippedScriptPath(input.webDir, file),
      scope: marker.scope,
      ...(marker.entries === undefined ? {} : { entries: marker.entries }),
      license: GUARD_LICENSE,
      closure: kind === 'test' ? helperClosure(file, marker.subjects, input) : [],
    })
  }
  for (const file of input.testFiles) consider(file, 'test')
  for (const file of input.scriptFiles) consider(file, 'script')
  guards.sort((a, b) => compareCodeUnits(a.id, b.id))
  const text = `${JSON.stringify({ schemaVersion: 1, guards }, null, 2)}\n`
  return { text, guards, problems }
}

/** Test files whose header carries `@pv-guard` but that the pack does not ship (not self-contained):
 * the registry would name a file the tarball lacks. */
export function unshippedGuardProblems(
  candidates: readonly string[],
  shipped: ReadonlySet<string>,
  resolver: GraphResolver,
  webDir: string
): string[] {
  return candidates
    .filter(
      (file) => !shipped.has(file) && guardMarker(resolver.readFile(file) ?? '') !== undefined
    )
    .map(
      (file) =>
        `${relativePosix(webDir, file)} carries @pv-guard but is not a self-contained test, so it cannot ship`
    )
}
