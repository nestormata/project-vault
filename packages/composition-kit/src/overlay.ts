import {
  compareCodeUnits,
  findCaseCollisions,
  normalizePackPath,
  sortedCodeUnits,
  stripTrailingSlashes,
} from './paths.js'
import { treeDigest } from './sources.js'
import type { Host, Pack } from './sources.js'
import type { Replacement, UiPackManifest } from './types.js'

export type FileSource = { kind: 'file'; abs: string } | { kind: 'text'; content: Buffer }

/** The hashes CM last accepted, read from the committed lock (the authoritative accepted state). */
export interface AcceptedState {
  overrides: Map<string, { hostSha256: string; hostVersion: string }>
  replacements: Map<string, { hostSha256: string; hostVersion: string }>
}

export interface OverrideRecord {
  path: string
  /** The accepted hash (lock if present, else the manifest's declaration). */
  hostSha256: string
  cmSha256: string
  story: string | null
  hostVersion: string
}

export interface AdditionRecord {
  path: string
  cmSha256: string
}

export interface RemovalRecord {
  path: string
  matched: number
  hostSha256: string | null
  hostVersion: string
  files: string[]
}

export interface ReplacementRecord {
  target: string
  with: string
  hostSha256: string
  cmSha256: string
  story: string | null
  hostVersion: string
  /** The resolved web-host file (`src/lib/...`). */
  hostPath: string
}

export interface DriftItem {
  kind: 'override' | 'replacement'
  /** The overlay path, or the replacement target. */
  key: string
  hostPath: string
  story: string | null
  accepted: string
  acceptedAt: string
  actual: string
  hostAbs: string
  cmAbs: string
}

export interface OverlayResult {
  files: Map<string, FileSource>
  overrides: OverrideRecord[]
  additions: AdditionRecord[]
  removals: RemovalRecord[]
  replacements: ReplacementRecord[]
  drift: DriftItem[]
  problems: string[]
  notes: string[]
  /** Host paths the pack overrides or removes (used by the injection-point check). */
  changedHostPaths: Set<string>
}

export interface OverlayInput {
  host: Host
  pack: Pack
  manifest: UiPackManifest
  accepted: AcceptedState
  /** Memoized sha256 of a file by absolute path. */
  hash: (abs: string) => string
  /** Previously recorded removed files per removal entry (from the lock), for the "gained a file" note. */
  previousRemovalFiles?: ReadonlyMap<string, readonly string[]>
}

const RESERVED = ['src/lib/_cm/', 'src/lib/server/_cm/']
const ROUTES = 'src/routes'
const LIB = 'src/lib/'
const LIB_EXTENSIONS = ['', '.svelte', '.ts', '.js']
const LIB_INDEXES = ['/index.svelte', '/index.ts', '/index.js']

function isOverlayPath(rel: string): boolean {
  return rel.startsWith('src/') || rel.startsWith('static/')
}

/** The host files a removal entry covers: a route id's whole subtree, a file, or a directory. */
function matchRemoval(entry: string, hostPaths: readonly string[]): string[] | string {
  if (entry.startsWith('/')) {
    const id = stripTrailingSlashes(entry)
    const prefix = `${ROUTES}${id}/`
    return hostPaths.filter((path) => path.startsWith(prefix))
  }
  if (entry.startsWith('src/') || entry.startsWith('static/')) {
    const prefix = `${stripTrailingSlashes(entry)}/`
    return hostPaths.filter((path) => path === entry || path.startsWith(prefix))
  }
  return `routes.remove "${entry}" is neither a route id (it starts with "/") nor a file path (it starts with "src/" or "static/")`
}

interface Removal {
  record: RemovalRecord
  paths: string[]
}

/** A removed file's hash; a removed route id's hash is a digest over its files. */
function removalDigest(
  entry: string,
  files: readonly string[],
  input: OverlayInput
): string | null {
  if (files.length === 0) return null
  const hashes = files.map((path) => ({ path, sha: input.hash(input.host.files.get(path) ?? '') }))
  const [first] = hashes
  return files.length === 1 && files.at(0) === entry && first !== undefined
    ? first.sha
    : treeDigest(hashes)
}

function planRemoval(
  entry: string,
  files: string[],
  input: OverlayInput,
  notes: string[]
): Removal {
  const previous = input.previousRemovalFiles?.get(entry)
  if (previous !== undefined && files.some((path) => !previous.includes(path))) {
    notes.push(`removed route id or path ${entry} gained a file in web-host (it is removed too)`)
  }
  return {
    paths: files,
    record: {
      path: entry,
      matched: files.length,
      hostSha256: removalDigest(entry, files, input),
      hostVersion: input.host.tuple.pvRelease,
      files,
    },
  }
}

function planRemovals(input: OverlayInput, problems: string[], notes: string[]): Removal[] {
  const hostPaths = [...input.host.files.keys()]
  const removals: Removal[] = []
  for (const entry of input.manifest.routes?.remove ?? []) {
    const matched = matchRemoval(entry, hostPaths)
    if (typeof matched === 'string') problems.push(matched)
    else removals.push(planRemoval(entry, sortedCodeUnits(matched), input, notes))
  }
  return removals
}

function packOverlay(pack: Pack): string[] {
  return sortedCodeUnits([...pack.files.keys()].filter(isOverlayPath))
}

function reservedProblems(hostPaths: Iterable<string>, packPaths: readonly string[]): string[] {
  const problems: string[] = []
  for (const [label, paths] of [
    ['web-host', hostPaths],
    ['the UI pack', packPaths],
  ] as const) {
    for (const path of paths) {
      if (RESERVED.some((prefix) => path.startsWith(prefix))) {
        problems.push(
          `Reserved namespace: ${path} is under src/lib/_cm or src/lib/server/_cm, which the composer owns (found in ${label}).`
        )
      }
    }
  }
  return problems
}

function underRemoved(path: string, removals: readonly Removal[]): string | undefined {
  return removals.find((removal) => {
    const entry = removal.record.path
    const prefix = entry.startsWith('/')
      ? `${ROUTES}${stripTrailingSlashes(entry)}/`
      : `${stripTrailingSlashes(entry)}/`
    return path === entry || path.startsWith(prefix)
  })?.record.path
}

interface Declared {
  path: string
  hostSha256: string
  story: string | null
}

function declaredOverrides(manifest: UiPackManifest): Map<string, Declared> {
  return new Map(
    (manifest.routes?.overrides ?? []).map((entry) => [
      entry.path,
      { path: entry.path, hostSha256: entry.hostSha256, story: entry.story ?? null },
    ])
  )
}

function declarationProblems(
  declared: ReadonlyMap<string, Declared>,
  packPaths: readonly string[],
  hostFiles: ReadonlyMap<string, string>
): string[] {
  return [...declared.keys()].flatMap((path) => {
    if (!packPaths.includes(path)) {
      return [`Override declared for ${path} but the UI pack has no such file (check the path).`]
    }
    return hostFiles.has(path)
      ? []
      : [
          `Override declared for ${path} but web-host has no such file (PV removed it, or the path is mistyped); remove the declaration to make it an addition, or keep it as a new file.`,
        ]
  })
}

/** A pack file on a path web-host also has: an override when declared, otherwise a collision. */
function planCollision(
  path: string,
  hostAbs: string,
  declaration: Declared | undefined,
  input: OverlayInput,
  out: OverlayResult
): void {
  const cmAbs = input.pack.files.get(path) ?? ''
  const actual = input.hash(hostAbs)
  if (declaration === undefined) {
    out.problems.push(
      `Collision: ${path} exists in web-host (sha256 ${actual}) but is not declared in routes.overrides. Declare it with hostSha256 "${actual}" to override it.`
    )
    return
  }
  const state = input.accepted.overrides.get(path)
  const accepted = state?.hostSha256 ?? declaration.hostSha256
  const acceptedAt = state?.hostVersion ?? input.manifest.host.pvRelease
  out.overrides.push({
    path,
    hostSha256: accepted,
    cmSha256: input.hash(cmAbs),
    story: declaration.story,
    hostVersion: acceptedAt,
  })
  if (accepted !== actual) {
    out.drift.push({
      kind: 'override',
      key: path,
      hostPath: path,
      story: declaration.story,
      accepted,
      acceptedAt,
      actual,
      hostAbs,
      cmAbs,
    })
  }
  out.files.set(path, { kind: 'file', abs: cmAbs })
  out.changedHostPaths.add(path)
}

function planOverrides(
  input: OverlayInput,
  packPaths: readonly string[],
  out: OverlayResult
): void {
  const declared = declaredOverrides(input.manifest)
  out.problems.push(...declarationProblems(declared, packPaths, input.host.files))
  for (const path of packPaths) {
    const hostAbs = input.host.files.get(path)
    if (hostAbs !== undefined) {
      planCollision(path, hostAbs, declared.get(path), input, out)
      continue
    }
    const cmAbs = input.pack.files.get(path) ?? ''
    out.additions.push({ path, cmSha256: input.hash(cmAbs) })
    out.files.set(path, { kind: 'file', abs: cmAbs })
  }
}

export function resolveLibTarget(target: string, hostPaths: ReadonlySet<string>): string[] {
  const base = `${LIB}${target.slice('$lib/'.length)}`
  const candidates = [
    ...LIB_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...LIB_INDEXES.map((suffix) => `${base}${suffix}`),
  ]
  return candidates.filter((candidate) => hostPaths.has(candidate))
}

function replacementTarget(input: OverlayInput, target: string, out: OverlayResult): string | null {
  if (!target.startsWith('$lib/')) {
    out.problems.push(`Replacement target ${target} must start with "$lib/".`)
    return null
  }
  const hostPaths = new Set(input.host.files.keys())
  const matches = resolveLibTarget(target, hostPaths)
  if (matches.length === 0) {
    out.problems.push(
      `Replacement target ${target} does not exist in web-host (no matching file under src/lib).`
    )
    return null
  }
  if (matches.length > 1) {
    out.problems.push(
      `Replacement target ${target} is ambiguous in web-host: ${matches.join(', ')}.`
    )
    return null
  }
  return matches[0] ?? null
}

/** Why a replacement cannot be combined with another declaration on the same file, or null. */
function replacementConflict(
  target: string,
  hostPath: string,
  input: OverlayInput,
  removals: readonly Removal[]
): string | null {
  const overlaid = (input.manifest.routes?.overrides ?? []).some((entry) => entry.path === hostPath)
  if (overlaid) {
    return `Conflict: ${hostPath} is both overlaid (routes.overrides) and replaced (replacements ${target}). Choose one.`
  }
  const removed = underRemoved(hostPath, removals)
  return removed === undefined
    ? null
    : `Conflict: ${hostPath} is both replaced (replacements ${target}) and removed (routes.remove ${removed}).`
}

function planReplacement(
  target: string,
  entry: Replacement,
  hostPath: string,
  withRel: string,
  input: OverlayInput,
  out: OverlayResult
): void {
  const hostAbs = input.host.files.get(hostPath) ?? ''
  const withAbs = input.pack.files.get(withRel) ?? ''
  const state = input.accepted.replacements.get(target)
  const accepted = state?.hostSha256 ?? entry.hostSha256
  const acceptedAt = state?.hostVersion ?? input.manifest.host.pvRelease
  const actual = input.hash(hostAbs)
  const story = entry.story ?? null
  out.replacements.push({
    target,
    with: withRel,
    hostSha256: accepted,
    cmSha256: input.hash(withAbs),
    story,
    hostVersion: acceptedAt,
    hostPath,
  })
  if (accepted !== actual) {
    out.drift.push({
      kind: 'replacement',
      key: target,
      hostPath,
      story,
      accepted,
      acceptedAt,
      actual,
      hostAbs,
      cmAbs: withAbs,
    })
  }
}

function planReplacements(
  input: OverlayInput,
  removals: readonly Removal[],
  out: OverlayResult
): void {
  for (const [target, entry] of Object.entries(input.manifest.replacements ?? {})) {
    const hostPath = replacementTarget(input, target, out)
    const withRel = normalizePackPath(entry.with)
    // A missing "with" file is reported once, with the manifest's other named files (plan.ts).
    if (hostPath === null || withRel === null || !input.pack.files.has(withRel)) continue
    const conflict = replacementConflict(target, hostPath, input, removals)
    if (conflict === null) planReplacement(target, entry, hostPath, withRel, input, out)
    else out.problems.push(conflict)
  }
}

function contradictionProblems(
  packPaths: readonly string[],
  declared: ReadonlySet<string>,
  removals: readonly Removal[]
): string[] {
  const problems: string[] = []
  for (const path of [...new Set([...packPaths, ...declared])].sort(compareCodeUnits)) {
    const removed = underRemoved(path, removals)
    if (removed !== undefined) {
      problems.push(
        `Contradiction: ${path} is in the UI pack (or declared in routes.overrides) but routes.remove "${removed}" removes it. Choose one.`
      )
    }
  }
  return problems
}

/** Design section 3 steps 1-2 and section 6's integrity rules: the composed `src/`, `static/`,
 * `messages/`, `project.inlang/` and `vendor/` file set, with every override, addition, removal
 * and replacement classified. Every refusal here is an integrity check, never a policy. */
export function planOverlay(input: OverlayInput): OverlayResult {
  const out: OverlayResult = {
    files: new Map([...input.host.files].map(([rel, abs]) => [rel, { kind: 'file', abs }])),
    overrides: [],
    additions: [],
    removals: [],
    replacements: [],
    drift: [],
    problems: [],
    notes: [],
    changedHostPaths: new Set(),
  }
  const packPaths = packOverlay(input.pack)
  out.problems.push(
    ...reservedProblems(input.host.files.keys(), packPaths),
    ...findCaseCollisions(packPaths).map(
      (group) => `Case collision: ${group.join(' and ')} differ only by case.`
    )
  )
  const removals = planRemovals(input, out.problems, out.notes)
  const declared = new Set((input.manifest.routes?.overrides ?? []).map((entry) => entry.path))
  out.problems.push(...contradictionProblems(packPaths, declared, removals))
  for (const removal of removals) {
    out.removals.push(removal.record)
    for (const path of removal.paths) {
      out.files.delete(path)
      out.changedHostPaths.add(path)
    }
  }
  planOverrides(
    input,
    packPaths.filter((path) => underRemoved(path, removals) === undefined),
    out
  )
  planReplacements(input, removals, out)
  return out
}
