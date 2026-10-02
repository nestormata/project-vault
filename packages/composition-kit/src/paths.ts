import { posix } from 'node:path'

/** Every path the kit stores or prints is forward-slash, relative, and OS-independent. */
export function toPosix(path: string): string {
  return path.replaceAll('\\', '/')
}

/** Locale-independent ordering: the lock must be byte-identical on every machine. */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

export function sortedCodeUnits(values: readonly string[]): string[] {
  return [...values].sort(compareCodeUnits)
}

/** Why a manifest path cannot name a file inside the composed tree, or null. An integrity check
 * on the declaration only: every file inside the composed tree can still be overridden. */
export function manifestPathProblem(path: string): string | null {
  if (path === '') return 'is empty'
  if (path.includes('\\')) return 'must use forward slashes'
  if (path.startsWith('/')) return 'is an absolute path and cannot name a file in the composed tree'
  if (posix.normalize(path).startsWith('../') || posix.normalize(path) === '..') {
    return 'escapes the composed tree (path escape)'
  }
  return null
}

/** `./a/../a/x.ts` -> `a/x.ts`; null when the reference leaves the pack or is absolute. */
export function normalizePackPath(reference: string): string | null {
  if (reference.startsWith('/') || reference.includes('\\')) return null
  const normalized = posix.normalize(reference)
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.') return null
  return normalized
}

/** Groups of paths that are equal ignoring case (a case-insensitive filesystem would merge them). */
export function findCaseCollisions(paths: readonly string[]): string[][] {
  const byLower = new Map<string, string[]>()
  for (const path of paths) {
    const key = path.toLowerCase()
    byLower.set(key, [...(byLower.get(key) ?? []), path])
  }
  return [...byLower.values()]
    .filter((group) => group.length > 1)
    .map((group) => sortedCodeUnits(group))
    .sort((a, b) => compareCodeUnits(a[0] ?? '', b[0] ?? ''))
}

/** A path (relative to the pack root) is server-only when any directory segment is `server` or its
 * basename carries a whole `.server.` token (Kit's own rule for ids inside the cwd). */
export function isServerOnlyPath(path: string): boolean {
  const segments = path.split('/')
  const base = segments.at(-1) ?? ''
  return segments.slice(0, -1).includes('server') || base.includes('.server.')
}
