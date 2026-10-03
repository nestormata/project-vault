import type { CompositionLock } from './lock.js'
import { resolveLibTarget, type AcceptedState } from './overlay.js'
import type { Host } from './sources.js'
import type { UiPackManifest } from './types.js'

export interface AcceptedEntry {
  key: string
  kind: 'override' | 'replacement'
  oldSha256: string
  newSha256: string
  hostVersion: string
}

export interface Acceptance {
  state: AcceptedState
  entries: AcceptedEntry[]
  already: string[]
  problems: string[]
}

type Accepted = { hostSha256: string; hostVersion: string }

/** The hashes CM last accepted: the committed lock is the authoritative accepted state. */
export function acceptedState(lock: CompositionLock | undefined): AcceptedState {
  const pick = (entry: Accepted): Accepted => ({
    hostSha256: entry.hostSha256,
    hostVersion: entry.hostVersion,
  })
  return {
    overrides: new Map((lock?.overrides ?? []).map((entry) => [entry.path, pick(entry)])),
    replacements: new Map((lock?.replacements ?? []).map((entry) => [entry.target, pick(entry)])),
  }
}

interface Declared {
  kind: 'override' | 'replacement'
  key: string
  hostPath: string
  declaredSha256: string
}

/** The override or replacement a `--accept-host` argument names (an overlay path, a replacement
 * target, or the web-host file a replacement targets). */
function declaredFor(
  path: string,
  manifest: UiPackManifest,
  hostPaths: ReadonlySet<string>
): Declared | undefined {
  const override = manifest.routes?.overrides?.find((entry) => entry.path === path)
  if (override !== undefined) {
    return {
      kind: 'override',
      key: override.path,
      hostPath: override.path,
      declaredSha256: override.hostSha256,
    }
  }
  for (const [target, entry] of Object.entries(manifest.replacements ?? {})) {
    const hostPath = resolveLibTarget(target, hostPaths).at(0)
    if ((target === path || hostPath === path) && hostPath !== undefined) {
      return { kind: 'replacement', key: target, hostPath, declaredSha256: entry.hostSha256 }
    }
  }
  return undefined
}

/** `--accept-host`: records the current web-host hash of each named declaration in the accepted
 * state (and so in the lock). The manifest is CM's hand-written source and is never rewritten. */
export function applyAcceptances(
  paths: readonly string[],
  manifest: UiPackManifest,
  host: Host,
  state: AcceptedState,
  hash: (abs: string) => string
): Acceptance {
  const out: Acceptance = { state, entries: [], already: [], problems: [] }
  const hostPaths = new Set(host.files.keys())
  for (const path of paths) {
    const declared = declaredFor(path, manifest, hostPaths)
    const hostAbs = declared === undefined ? undefined : host.files.get(declared.hostPath)
    if (declared === undefined || hostAbs === undefined) {
      out.problems.push(
        `--accept-host ${path}: not declared as an override or replacement in the manifest (or web-host no longer has it).`
      )
      continue
    }
    const bucket = declared.kind === 'override' ? state.overrides : state.replacements
    const oldSha256 = bucket.get(declared.key)?.hostSha256 ?? declared.declaredSha256
    const newSha256 = hash(hostAbs)
    if (oldSha256 === newSha256) {
      out.already.push(declared.key)
      continue
    }
    const hostVersion = host.tuple.pvRelease
    bucket.set(declared.key, { hostSha256: newSha256, hostVersion })
    out.entries.push({ key: declared.key, kind: declared.kind, oldSha256, newSha256, hostVersion })
  }
  return out
}
