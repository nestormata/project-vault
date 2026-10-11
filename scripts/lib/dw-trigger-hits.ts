/**
 * Story 43.22 — which open `deferred-work.md` entries have a revisit trigger that names a file (or
 * directory) present in a diff. Pure: the entries come from the shared `parseDwEntries`, the
 * trigger label rules from `check-deferred-work-triggers.ts` (`entryTriggerValues`), the changed
 * files from the caller. A nudge, not an adversarial barrier: a false negative is acceptable, a
 * false positive should be rare. Matching is flat string work (no backtracking regexes).
 */
import { entryState, entryTriggerValues } from '../check-deferred-work-triggers.js'
import type { DwEntry } from './deferred-work-ledger.js'

export type FiredTrigger = {
  id: string
  /** The entry heading's line in `deferred-work.md`. */
  line: number
  /** Trigger candidates that matched at least one changed file, in trigger order. */
  matchedPaths: string[]
  /** Changed files matched by those candidates, sorted and de-duplicated. */
  matchedFiles: string[]
}

const KNOWN_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'md',
  'yml',
  'yaml',
  'sql',
  'svelte',
  'json',
  'sh',
])
const BACKTICKED = /`([^`\n]+)`/g
const LEADING_PUNCTUATION = new Set(['(', '"', "'", '[', '<'])
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ')', ':', '"', "'", ']', '>'])

/** Repo-relative form: `\` as `/`, one leading `./` dropped. */
export function normalizePath(path: string): string {
  const slashed = path.replaceAll('\\', '/')
  return slashed.startsWith('./') ? slashed.slice(2) : slashed
}

function trimPunctuation(token: string): string {
  let start = 0
  let end = token.length
  while (start < end && LEADING_PUNCTUATION.has(token.charAt(start))) start += 1
  while (end > start && TRAILING_PUNCTUATION.has(token.charAt(end - 1))) end -= 1
  return token.slice(start, end)
}

function extensionOf(segment: string): string | undefined {
  const dot = segment.lastIndexOf('.')
  return dot > 0 ? segment.slice(dot + 1) : undefined
}

function looksLikePath(token: string): boolean {
  if (token.includes('/')) return true
  const ext = extensionOf(token)
  return ext !== undefined && KNOWN_EXTENSIONS.has(ext)
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9'
}

/** `a/b.ts:12` or `a/b.ts:12-30` -> `a/b.ts`. */
function dropLineSuffix(token: string): string {
  const colon = token.lastIndexOf(':')
  if (colon < 0) return token
  const suffix = token.slice(colon + 1)
  const isRange = isDigit(suffix.charAt(0)) && [...suffix].every((c) => c === '-' || isDigit(c))
  return isRange ? token.slice(0, colon) : token
}

function cleanCandidate(raw: string): string {
  return normalizePath(dropLineSuffix(trimPunctuation(raw.trim())))
}

function isUsable(candidate: string): boolean {
  return candidate !== '' && !candidate.includes('://') && !/\s/.test(candidate)
}

/** Candidate paths in one trigger value: every backticked token, plus bare tokens that contain a
 * `/` or end in a known extension. */
export function extractCandidatePaths(triggerValue: string): string[] {
  const candidates: string[] = []
  for (const match of triggerValue.matchAll(BACKTICKED)) {
    candidates.push(cleanCandidate(match[1] as string))
  }
  const unticked = triggerValue.replaceAll(BACKTICKED, ' ')
  for (const token of unticked.split(/\s+/)) {
    const candidate = cleanCandidate(token)
    if (looksLikePath(candidate)) candidates.push(candidate)
  }
  return candidates.filter(isUsable)
}

/** `*` within one path segment; every other character literal. Two-pointer, no regex. */
function segmentMatches(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let starP = -1
  let starT = 0
  while (t < text.length) {
    if (p < pattern.length && pattern.charAt(p) === '*') {
      starP = p
      starT = t
      p += 1
    } else if (p < pattern.length && pattern.charAt(p) === text.charAt(t)) {
      p += 1
      t += 1
    } else if (starP >= 0) {
      starT += 1
      t = starT
      p = starP + 1
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern.charAt(p) === '*') p += 1
  return p === pattern.length
}

function globSegmentsMatch(pattern: string[], path: string[]): boolean {
  const [head, ...rest] = pattern
  if (head === undefined) return path.length === 0
  if (head === '**') {
    for (let skip = 0; skip <= path.length; skip += 1) {
      if (globSegmentsMatch(rest, path.slice(skip))) return true
    }
    return false
  }
  const [first, ...remaining] = path
  return first !== undefined && segmentMatches(head, first) && globSegmentsMatch(rest, remaining)
}

function matchesGlob(candidate: string, file: string): boolean {
  return globSegmentsMatch(candidate.split('/'), file.split('/'))
}

/** AC-11: whether `candidate` (normalized) names `file` (normalized). */
function candidateMatches(candidate: string, file: string): boolean {
  if (candidate.includes('*')) return matchesGlob(candidate, file)
  if (candidate.endsWith('/')) return file.startsWith(candidate)
  const segments = candidate.split('/')
  if (segments.length === 1) return file === candidate
  const last = segments.at(-1) as string
  if (extensionOf(last) !== undefined) return file === candidate
  return file === candidate || file.startsWith(`${candidate}/`)
}

function firedTrigger(entry: DwEntry, files: string[]): FiredTrigger | undefined {
  const candidates = [
    ...new Set(entryTriggerValues(entry).flatMap((value) => extractCandidatePaths(value))),
  ]
  const matchedPaths: string[] = []
  const matchedFiles = new Set<string>()
  for (const candidate of candidates) {
    const matches = files.filter((file) => candidateMatches(candidate, file))
    if (matches.length === 0) continue
    matchedPaths.push(candidate)
    for (const file of matches) matchedFiles.add(file)
  }
  if (matchedPaths.length === 0) return undefined
  return { id: entry.id, line: entry.line, matchedPaths, matchedFiles: [...matchedFiles].sort() }
}

/** AC-1: the open entries whose trigger names a changed file, ordered by heading line. */
export function findFiredTriggers(entries: DwEntry[], changedFiles: string[]): FiredTrigger[] {
  const files = [...new Set(changedFiles.map(normalizePath))]
  return entries
    .filter((entry) => entryState(entry).kind === 'open')
    .flatMap((entry) => firedTrigger(entry, files) ?? [])
    .sort((a, b) => a.line - b.line)
}
