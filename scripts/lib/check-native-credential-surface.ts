import {
  scanNativeCredentialSurface,
  fileWiresNativeLoginGate,
  NATIVE_CREDENTIAL_SURFACE_CLASSIFICATIONS,
} from './native-credential-surface-scan.js'
import type { SurfaceHit, SurfaceManifestEntry } from './native-credential-surface-scan.js'

export type SurfaceCheckFailure =
  | { kind: 'unlisted'; hit: SurfaceHit }
  | { kind: 'dead-entry'; entry: SurfaceManifestEntry }
  | { kind: 'missing-ac'; entry: SurfaceManifestEntry }
  | { kind: 'unknown-classification'; entry: SurfaceManifestEntry }
  | { kind: 'ungated-gate-entry'; entry: SurfaceManifestEntry }

export class NativeCredentialSurfaceError extends Error {
  constructor(public readonly failures: SurfaceCheckFailure[]) {
    super(`native-credential-surface guard found ${failures.length} problem(s)`)
    this.name = 'NativeCredentialSurfaceError'
  }
}

function entryKey(entry: { path: string; line: number; predicate: string }): string {
  return `${entry.path}:${entry.line}:${entry.predicate}`
}

/**
 * Story 23.2 AC-19 — re-runs the P1-P5 sweep over the live tree and fails when:
 *  - a hit exists that the manifest does not list ('unlisted' — the N1 failure);
 *  - a manifest entry no longer matches a hit ('dead-entry' — dead entry, or the code moved);
 *  - any entry has a missing/unknown classification or a missing `ac` pointer;
 *  - any entry classified `gate` corresponds to a file the gate helper does not touch.
 */
export function checkNativeCredentialSurface(
  repoRoot: string,
  manifest: SurfaceManifestEntry[]
): SurfaceCheckFailure[] {
  const hits = scanNativeCredentialSurface(repoRoot)
  const hitsByKey = new Map(hits.map((hit) => [entryKey(hit), hit]))
  const manifestByKey = new Map(manifest.map((entry) => [entryKey(entry), entry]))

  const failures: SurfaceCheckFailure[] = []

  for (const hit of hits) {
    if (!manifestByKey.has(entryKey(hit))) failures.push({ kind: 'unlisted', hit })
  }

  for (const entry of manifest) {
    if (!hitsByKey.has(entryKey(entry))) {
      failures.push({ kind: 'dead-entry', entry })
      continue
    }
    if (!entry.ac || entry.ac.trim().length === 0) {
      failures.push({ kind: 'missing-ac', entry })
    }
    if (!NATIVE_CREDENTIAL_SURFACE_CLASSIFICATIONS.includes(entry.classification)) {
      failures.push({ kind: 'unknown-classification', entry })
    }
    if (entry.classification === 'gate' && !fileWiresNativeLoginGate(repoRoot, entry.path)) {
      failures.push({ kind: 'ungated-gate-entry', entry })
    }
  }

  return failures
}

export function formatFailure(failure: SurfaceCheckFailure): string {
  switch (failure.kind) {
    case 'unlisted':
      return `unlisted native-credential path: ${failure.hit.path}:${failure.hit.line} (${failure.hit.predicate}) — classify it in native-credential-surface.json and point it at an AC.`
    case 'dead-entry':
      return `dead manifest entry (code moved or was removed): ${failure.entry.path}:${failure.entry.line} (${failure.entry.predicate})`
    case 'missing-ac':
      return `manifest entry missing an "ac" pointer: ${failure.entry.path}:${failure.entry.line} (${failure.entry.predicate})`
    case 'unknown-classification':
      return `manifest entry has an unknown classification "${failure.entry.classification}": ${failure.entry.path}:${failure.entry.line}`
    case 'ungated-gate-entry':
      return `entry classified "gate" but ${failure.entry.path} does not call the native-login gate: ${failure.entry.path}:${failure.entry.line}`
  }
}
