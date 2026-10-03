import { join, relative, sep } from 'node:path'
import type * as TypeScript from 'typescript'
import { acceptedState, applyAcceptances, type AcceptedEntry } from './accept.js'
import { appRootProblems } from './apply.js'
import { assemble } from './assemble.js'
import { checkCompatibility, checkRuntimeDependencies } from './compat.js'
import { collectRoots, composedPathOf, contributionsOf, deferredNotes } from './contributions.js'
import { driftReport } from './drift.js'
import { overlapProblems, ownershipProblems } from './guards.js'
import { buildLock, readLock, serializeLock, type CompositionLock } from './lock.js'
import { materialize, type MaterializeResult } from './materialize.js'
import { loadManifest, validateManifest } from './manifest.js'
import { planOverlay, type FileSource, type OverlayResult } from './overlay.js'
import { compareCodeUnits, normalizePackPath, sortedCodeUnits } from './paths.js'
import { checkInjectionPoints, checkNavIds, readRegistries, type Registries } from './registry.js'
import { hasher, loadHost, loadPack, type Host, type Pack } from './sources.js'
import {
  exportNames,
  hookEntries,
  hookExportNotes,
  overriddenHookNotes,
  readHooksSurface,
  type HooksSurface,
} from './hooks-surface.js'
import { protectedPathsFindings, type ProtectedPathsRecord } from './protected-paths.js'
import { requirePeer } from './peers.js'
import type { UiPackManifest } from './types.js'

export { GENERATED_MARKER } from './assemble.js'
export type { AcceptedEntry } from './accept.js'
export const DEFAULT_LOCK = 'composition.lock.json'
const MANIFEST_FILE = 'pv-ui.manifest.ts'

export interface ComposeOptions {
  appRoot: string
  packRoot: string
  hostDir: string
  /** An already-loaded manifest (dev plugin, tests); otherwise loaded from `manifestPath`. */
  manifest?: unknown
  manifestPath?: string
  lockPath?: string
  /** A directory whose installed `@project-vault/extension-api` is compared to the tuple. */
  modulePack?: string
  /** Overlay paths (or replacement targets) whose current web-host hash is accepted into the lock. */
  acceptHost?: readonly string[]
  /** A previous web-host directory for the true old-to-new PV diff of drifted files. */
  previousHost?: string
  appLabel?: string
  /** Where `typescript` and `svelte/compiler` are resolved from (default: the app root). */
  resolveFrom?: string
  log?: (line: string) => void
  /** Also log each derived protected route (Story 68.6). */
  verbose?: boolean
}

export interface ComposeSummary {
  overrides: number
  additions: number
  removals: number
  replacements: number
  materialized: number
  notes: number
  files: number
}

export interface ComposePlan {
  problems: string[]
  notes: string[]
  files: Map<string, FileSource>
  lockPath: string
  lock?: CompositionLock
  lockText?: string
  existingLock?: CompositionLock
  accepted: AcceptedEntry[]
  alreadyAccepted: string[]
  summary: ComposeSummary
}

/** Problems and notes gathered across the planning stages. */
class Findings {
  readonly problems: string[] = []
  readonly notes: string[] = []

  add(source: { problems?: readonly string[]; notes?: readonly string[] }): void {
    this.problems.push(...(source.problems ?? []))
    this.notes.push(...(source.notes ?? []))
  }
}

function emptyPlan(lockPath: string, problems: string[], notes: string[] = []): ComposePlan {
  return {
    problems: sortedCodeUnits(problems),
    notes,
    files: new Map(),
    lockPath,
    accepted: [],
    alreadyAccepted: [],
    summary: {
      overrides: 0,
      additions: 0,
      removals: 0,
      replacements: 0,
      materialized: 0,
      notes: notes.length,
      files: 0,
    },
  }
}

interface Stage {
  manifest: UiPackManifest
  host: Host
  pack: Pack
  options: ComposeOptions
  hash: (abs: string) => string
  existingLock?: CompositionLock
  registries: Registries
}

async function prepare(
  options: ComposeOptions,
  lockPath: string,
  log: (line: string) => void
): Promise<{ stage?: Stage; findings: Findings }> {
  const findings = new Findings()
  const resolveFrom = options.resolveFrom ?? options.appRoot
  const manifestPath = options.manifestPath ?? join(options.packRoot, MANIFEST_FILE)
  const validation = validateManifest(
    options.manifest ?? (await loadManifest(manifestPath, { resolveFrom }))
  )
  findings.add(validation)
  if (validation.manifest === undefined) return { findings }
  log('pv-compose: locate web-host')
  const located = loadHost(options.hostDir)
  findings.add(located)
  if (located.host === undefined) return { findings }
  const loadedPack = loadPack(options.packRoot)
  const registries = readRegistries(located.host.dir)
  const existing = readLock(lockPath)
  findings.add(loadedPack)
  findings.add(registries)
  findings.add({ problems: existing?.problem === undefined ? [] : [existing.problem] })
  const stage: Stage = {
    manifest: validation.manifest,
    host: located.host,
    pack: loadedPack.pack,
    options,
    hash: hasher(),
    registries,
    ...(existing?.lock === undefined ? {} : { existingLock: existing.lock }),
  }
  return { stage, findings }
}

function compatibilityFindings(stage: Stage): { problems: string[]; notes: string[] } {
  const { options, host, manifest } = stage
  const compat = checkCompatibility({
    appRoot: options.appRoot,
    appLabel: options.appLabel ?? (relative(process.cwd(), options.appRoot) || '.'),
    tuple: host.tuple,
    packPvRelease: manifest.host.pvRelease,
    ...(options.modulePack === undefined ? {} : { modulePack: options.modulePack }),
  })
  return {
    problems: [...compat.problems, ...checkRuntimeDependencies(options.appRoot, host.dependencies)],
    notes: compat.notes,
  }
}

function registryFindings(stage: Stage, overlay: OverlayResult) {
  const names = Object.keys(stage.manifest.injections ?? {})
  const injections = checkInjectionPoints(
    names,
    stage.registries.injectionPoints,
    overlay.changedHostPaths,
    stage.existingLock?.injectionPointsUsed
  )
  const navRefs = stage.existingLock?.navIdsReferenced ?? []
  const nav = checkNavIds(navRefs, stage.registries.navIds)
  return {
    problems: [...injections.problems, ...nav.problems],
    notes: [...injections.notes, ...nav.notes],
    used: injections.used,
    navRefs,
  }
}

/** Pack files nothing reached are listed, never copied (copying all would ship tests and tooling). */
function unreachedNotes(stage: Stage, reached: ReadonlySet<string>): string[] {
  const manifestFile = relative(
    stage.options.packRoot,
    stage.options.manifestPath ?? join(stage.options.packRoot, MANIFEST_FILE)
  )
    .split(sep)
    .join('/')
  const messagesDir =
    stage.manifest.messages === undefined ? null : normalizePackPath(stage.manifest.messages)
  return [...stage.pack.files.keys()]
    .filter(
      (rel) =>
        !reached.has(rel) &&
        !rel.startsWith('.') &&
        rel !== 'package.json' &&
        rel !== manifestFile &&
        !(messagesDir !== null && rel.startsWith(`${messagesDir}/`))
    )
    .sort(compareCodeUnits)
    .map(
      (rel) =>
        `unreached pack file ${rel} was not copied (nothing in the manifest or the overlay imports it)`
    )
}

/** Story 68.6: hook export notes, full-override notes and protected-path derivation, when the
 * web-host ships `manifests/hooks-surface.json`. An older web-host keeps 68-3's behaviour. */
function hookFileNotes(stage: Stage, mat: MaterializeResult, surface: HooksSurface): string[] {
  const entries = hookEntries(stage.manifest.hooks)
  if (entries.length === 0) return []
  const ts = requirePeer<typeof TypeScript>(
    'typescript',
    stage.options.resolveFrom ?? stage.options.appRoot
  )
  return entries.flatMap(([kind, ref]) => {
    const dest = composedPathOf(ref, mat)
    const bytes = dest === null ? undefined : mat.files.get(dest)
    // A missing file was already reported by collectRoots.
    if (bytes === undefined) return []
    return hookExportNotes(kind, exportNames(bytes.toString('utf8'), ts, dest ?? ref), surface)
  })
}

/** Story 68.6: hook export notes, full-override notes and protected-path derivation, when the
 * web-host ships `manifests/hooks-surface.json`. An older web-host keeps 68-3's behaviour. */
function hooksFindings(
  stage: Stage,
  overlay: OverlayResult,
  mat: MaterializeResult,
  log: (line: string) => void
): { problems: string[]; notes: string[]; surface?: HooksSurface; record?: ProtectedPathsRecord } {
  const read = readHooksSurface(stage.host.dir)
  if (read.surface === undefined) return { problems: read.problems, notes: [] }
  const surface = read.surface
  const overridden = new Set(overlay.overrides.map((entry) => entry.path))
  const paths = protectedPathsFindings({
    manifest: stage.manifest,
    cmRouteFiles: [...overlay.overrides, ...overlay.additions].map((entry) => entry.path),
    pvPrefixes: surface.protectedPrefixes,
  })
  log(`pv-compose: ${paths.summary}`)
  if (stage.options.verbose === true) {
    for (const route of paths.record.derived) log(`pv-compose:   protected ${route.routeId}`)
  }
  return {
    problems: paths.problems,
    notes: [
      ...overriddenHookNotes(stage.manifest.hooks, overridden),
      ...hookFileNotes(stage, mat, surface),
      ...paths.notes,
    ],
    surface,
    record: paths.record,
  }
}

function summaryOf(
  overlay: OverlayResult,
  mat: MaterializeResult,
  notes: number,
  files: number
): ComposeSummary {
  return {
    overrides: overlay.overrides.length,
    additions: overlay.additions.length,
    removals: overlay.removals.length,
    replacements: overlay.replacements.length,
    materialized: mat.relocated.length,
    notes,
    files,
  }
}

/** Reads the host and the pack and computes everything (the composed file set, the lock, the
 * notes and every problem) without writing a byte. */
export async function plan(options: ComposeOptions): Promise<ComposePlan> {
  const log = options.log ?? (() => undefined)
  const lockPath = options.lockPath ?? join(options.appRoot, DEFAULT_LOCK)
  const overlap = overlapProblems(options.appRoot, options.packRoot, options.hostDir)
  const early = overlap.length > 0 ? overlap : appRootProblems(options.appRoot)
  if (early.length > 0) return emptyPlan(lockPath, early)
  const { stage, findings } = await prepare(options, lockPath, log)
  if (stage === undefined) return emptyPlan(lockPath, findings.problems, findings.notes)
  findings.add({ problems: ownershipProblems(options.appRoot) })
  // The tuple check runs before anything is planned, so a mismatch fails fast.
  findings.add(compatibilityFindings(stage))
  return planStage(stage, findings, lockPath, log)
}

function planStage(
  stage: Stage,
  findings: Findings,
  lockPath: string,
  log: (line: string) => void
): ComposePlan {
  const { options } = stage
  log('pv-compose: overlay')
  const acceptance = applyAcceptances(
    options.acceptHost ?? [],
    stage.manifest,
    stage.host,
    acceptedState(stage.existingLock),
    stage.hash
  )
  findings.add(acceptance)
  const overlay = planOverlay({
    host: stage.host,
    pack: stage.pack,
    manifest: stage.manifest,
    accepted: acceptance.state,
    hash: stage.hash,
    previousRemovalFiles: new Map(
      (stage.existingLock?.removals ?? []).map((r) => [r.path, r.files])
    ),
  })
  findings.add(overlay)
  const contributed = collectRoots(stage.manifest, stage.pack)
  findings.add(contributed)
  log('pv-compose: materialize')
  const overlayPaths = [...overlay.overrides, ...overlay.additions].map((entry) => entry.path)
  const mat = materialize({
    packFiles: stage.pack.files,
    roots: contributed.roots,
    overlayPaths,
    resolveFrom: options.resolveFrom ?? options.appRoot,
  })
  findings.add(mat)
  const assembly = assemble(stage.manifest, stage.host, stage.pack, overlay, mat)
  findings.add(assembly)
  const registry = registryFindings(stage, overlay)
  findings.add(registry)
  const hooks = hooksFindings(stage, overlay, mat, log)
  findings.add(hooks)
  findings.add({
    notes: [
      ...deferredNotes(stage.manifest, hooks.surface !== undefined),
      ...unreachedNotes(stage, new Set([...mat.reached, ...overlayPaths])),
    ],
  })
  for (const item of overlay.drift) {
    const context = {
      hostVersion: stage.host.tuple.pvRelease,
      ...(options.previousHost === undefined ? {} : { previousHost: options.previousHost }),
    }
    findings.add({ problems: [driftReport(item, context)] })
  }
  log('pv-compose: lock')
  const notes = [...new Set(findings.notes)].sort(compareCodeUnits)
  const lock = buildLock({
    tuple: stage.host.tuple,
    overrides: overlay.overrides,
    additions: overlay.additions,
    removals: overlay.removals,
    replacements: overlay.replacements,
    relocated: mat.relocated,
    contributions: contributionsOf(stage.manifest, mat, hooks.record),
    injectionPointsUsed: registry.used,
    navIdsReferenced: registry.navRefs,
    notes,
  })
  return {
    problems: sortedCodeUnits(findings.problems),
    notes,
    files: assembly.files,
    lockPath,
    lock,
    lockText: serializeLock(lock),
    ...(stage.existingLock === undefined ? {} : { existingLock: stage.existingLock }),
    accepted: acceptance.entries,
    alreadyAccepted: acceptance.already,
    summary: summaryOf(overlay, mat, notes.length, assembly.files.size),
  }
}
