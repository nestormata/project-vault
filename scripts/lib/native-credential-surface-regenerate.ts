import { diffManifestAgainstHits } from './check-native-credential-surface.js'
import type {
  Predicate,
  SurfaceHit,
  SurfaceManifestEntry,
} from './native-credential-surface-scan.js'

/**
 * Story 40.2 — `--write` regeneration mode. Re-points EXISTING manifest entries' `line` field to
 * their current live location, per the matching algorithm described in the story's "Recommended
 * Mechanism Decision": group by `(path, predicate)`, a group-size guard (AC-4/AC-5), deterministic
 * exact `symbol`-to-`text` matching (AC-12), an ordinal fallback for the rest, and a self-verify
 * pass before any group's mapping is trusted (AC-11). This module performs no file I/O — the CLI
 * wrapper (`scripts/check-native-credential-surface.ts`) owns reading and writing the manifest.
 */

export type RegenerationChange = {
  path: string
  predicate: Predicate
  oldLine: number
  newLine: number
}

export type RegenerationResult = {
  /** A new manifest array (never mutates the input) with `line` updated on regenerated entries. */
  manifest: SurfaceManifestEntry[]
  /** Every entry whose line actually changed, in the order its group was resolved. */
  changes: RegenerationChange[]
  /** Count of `(path, predicate)` groups left untouched: size mismatches + failed self-verify. */
  unresolvedGroupCount: number
}

type IndexedEntry = { index: number; entry: SurfaceManifestEntry }
type LineUpdate = { index: number; line: number }
type MatchedGroup = { key: string; updates: LineUpdate[] }

function groupKeyOf(path: string, predicate: Predicate): string {
  return `${path}:::${predicate}`
}

function groupManifestEntries(manifest: SurfaceManifestEntry[]): Map<string, IndexedEntry[]> {
  const groups = new Map<string, IndexedEntry[]>()
  manifest.forEach((entry, index) => {
    const key = groupKeyOf(entry.path, entry.predicate)
    const item = { index, entry }
    const existing = groups.get(key)
    if (existing) existing.push(item)
    else groups.set(key, [item])
  })
  return groups
}

function groupHitsByKey(hits: SurfaceHit[]): Map<string, SurfaceHit[]> {
  const groups = new Map<string, SurfaceHit[]>()
  for (const hit of hits) {
    const key = groupKeyOf(hit.path, hit.predicate)
    const existing = groups.get(key)
    if (existing) existing.push(hit)
    else groups.set(key, [hit])
  }
  // Ascending-line order per group — the scan already walks files top-to-bottom, but sort
  // defensively so the matching algorithm never depends on that internal detail.
  for (const list of groups.values()) list.sort((a, b) => a.line - b.line)
  return groups
}

/**
 * Steps 2-3 of the matching algorithm for one size-matched `(path, predicate)` group.
 *
 * Step 2a (identity match, precedes the story's own symbol-match step): for each entry, in
 * original order, if an unclaimed hit already sits at that entry's CURRENT line, claim it —
 * i.e. never move an entry that isn't actually drifted. This matters because `symbol` is
 * documentation copied at authoring time and is only verified against the live tree when the
 * check-only path's `entryKey()` triple happens to also validate the entry's other fields — it is
 * never cross-checked against `text` for an entry that already passes. A group can therefore
 * contain an entry whose `symbol` is stale (or was always a paraphrase) while its `line` was never
 * wrong at all; without this identity-first pass, step 2b's symbol match can "fix" that entry by
 * reassigning it to a sibling hit's line — swapping two already-correct entries in the same group.
 * (Discovered via this story's own required manual `--write` run against the real repo tree,
 * which must report 0 entries regenerated when nothing has drifted — see Tasks.)
 *
 * Step 2b: deterministic exact `symbol`-to-`text` matching (AC-12 — each still-unmatched entry,
 * visited in original manifest order, claims the earliest unclaimed hit whose text equals its
 * symbol).
 *
 * Step 3: ordinal fallback pairing any still-unmatched entries (original relative order) with any
 * still-unclaimed hits (ascending line).
 */
function matchGroup(entries: IndexedEntry[], hits: SurfaceHit[]): LineUpdate[] {
  const claimedPositions = new Set<number>()
  const updates = new Map<number, number>()

  // Step 2a: identity match — an entry already sitting on a real hit's line is never moved.
  for (const { index, entry } of entries) {
    const hitPosition = hits.findIndex(
      (hit, position) => !claimedPositions.has(position) && hit.line === entry.line
    )
    if (hitPosition === -1) continue
    claimedPositions.add(hitPosition)
    const claimedHit = hits.at(hitPosition)
    if (claimedHit) updates.set(index, claimedHit.line)
  }

  // Step 2b: exact symbol-to-text match among whatever step 2a left unclaimed.
  for (const { index, entry } of entries) {
    if (updates.has(index)) continue
    const hitPosition = hits.findIndex(
      (hit, position) => !claimedPositions.has(position) && hit.text === entry.symbol
    )
    if (hitPosition === -1) continue
    claimedPositions.add(hitPosition)
    const claimedHit = hits.at(hitPosition)
    if (claimedHit) updates.set(index, claimedHit.line)
  }

  const unclaimedHits = hits.filter((_, position) => !claimedPositions.has(position))
  const unmatchedEntries = entries.filter(({ index }) => !updates.has(index))
  unmatchedEntries.forEach(({ index }, position) => {
    const fallbackHit = unclaimedHits.at(position)
    if (fallbackHit) updates.set(index, fallbackHit.line)
  })

  return [...updates.entries()].map(([index, line]) => ({ index, line }))
}

/** Returns a new manifest with `line` overridden per `updates`; every other field is untouched. */
function applyLineUpdates(
  manifest: SurfaceManifestEntry[],
  updates: LineUpdate[]
): SurfaceManifestEntry[] {
  const lineByIndex = new Map(updates.map((update) => [update.index, update.line]))
  return manifest.map((entry, index) => {
    const newLine = lineByIndex.get(index)
    return newLine === undefined ? { ...entry } : { ...entry, line: newLine }
  })
}

/**
 * AC-11 self-verify: re-runs the real diff against the full candidate manifest (reusing `hits`,
 * no second tree scan) and returns the `(path, predicate)` group keys any failure belongs to.
 */
function findFailingGroupKeys(
  repoRoot: string,
  hits: SurfaceHit[],
  candidateManifest: SurfaceManifestEntry[]
): Set<string> {
  const failures = diffManifestAgainstHits(repoRoot, hits, candidateManifest)
  const keys = new Set<string>()
  for (const failure of failures) {
    const subject = failure.kind === 'unlisted' ? failure.hit : failure.entry
    keys.add(groupKeyOf(subject.path, subject.predicate))
  }
  return keys
}

function computeChanges(
  manifest: SurfaceManifestEntry[],
  cleanGroups: MatchedGroup[]
): RegenerationChange[] {
  const originalByIndex = new Map(manifest.map((entry, index) => [index, entry]))
  const changes: RegenerationChange[] = []
  for (const group of cleanGroups) {
    for (const { index, line: newLine } of group.updates) {
      const original = originalByIndex.get(index)
      if (!original || newLine === original.line) continue
      changes.push({
        path: original.path,
        predicate: original.predicate,
        oldLine: original.line,
        newLine,
      })
    }
  }
  return changes
}

/**
 * Computes the regeneration plan for `manifest` given the current live `hits`, and returns the
 * resulting manifest with only `line` fields changed on entries whose group was both
 * size-matched (step 1) and came back clean under self-verification (step 4 / AC-11). Groups that
 * fail either gate are left byte-for-byte as they were in the input `manifest`.
 */
export function regenerateManifest(
  repoRoot: string,
  manifest: SurfaceManifestEntry[],
  hits: SurfaceHit[]
): RegenerationResult {
  const manifestGroups = groupManifestEntries(manifest)
  const hitGroups = groupHitsByKey(hits)
  const allKeys = new Set<string>([...manifestGroups.keys(), ...hitGroups.keys()])

  const matchedGroups: MatchedGroup[] = []
  let sizeMismatchCount = 0

  for (const key of allKeys) {
    const entries = manifestGroups.get(key) ?? []
    const groupHits = hitGroups.get(key) ?? []

    // Step 1: group-size guard. Unequal counts means a real add/remove happened in this group —
    // never guess; leave every entry in the group untouched (AC-4, AC-5).
    if (entries.length !== groupHits.length) {
      sizeMismatchCount += 1
      continue
    }
    if (entries.length === 0) continue // trivial 0/0 no-op

    matchedGroups.push({ key, updates: matchGroup(entries, groupHits) })
  }

  // Step 4: self-verify against the full candidate manifest (every matched group applied).
  const candidateManifest = applyLineUpdates(
    manifest,
    matchedGroups.flatMap((group) => group.updates)
  )
  const failingGroupKeys = findFailingGroupKeys(repoRoot, hits, candidateManifest)
  const cleanGroups = matchedGroups.filter((group) => !failingGroupKeys.has(group.key))

  // Step 5: apply. Only groups that self-verified clean get written; every other group —
  // size-mismatched or self-verify-failed — falls back to its original line numbers.
  return {
    manifest: applyLineUpdates(
      manifest,
      cleanGroups.flatMap((group) => group.updates)
    ),
    changes: computeChanges(manifest, cleanGroups),
    unresolvedGroupCount: sizeMismatchCount + (matchedGroups.length - cleanGroups.length),
  }
}
