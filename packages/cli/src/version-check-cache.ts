import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicOwnerOnly, type AtomicFs } from './atomic-file.js'
import { sanitizeServerText } from './sanitize-server-text.js'
import { ensureOwnerOnlyDir } from './session-store.js'
import { validateCliVersionPolicy, type CliVersionPolicy } from './version-policy-response.js'

/**
 * Story 43.6 AC-8 — the per-server version-check cache at `<sessionDir()>/version-check.json`.
 * Everything here fails open: an unreadable, corrupted or wrong-version file is "no cache", and a
 * failed write is ignored. The content is public data, but it is still written owner-only through
 * the shared atomic writer (last-writer-wins, never a torn file).
 */
export type VersionCheckCacheEntry = {
  cliVersion: string
  checkedAt: string
  outcome: 'ok' | 'unreachable'
  policy: CliVersionPolicy | null
  lastConfirmedWithdrawn: { reason: string; at: string } | null
  lastNoticeAt: string | null
}

export const VERSION_CHECK_CACHE_FILE = 'version-check.json'
export const CACHE_SCHEMA_VERSION = 1
export const MAX_CACHE_ENTRIES = 20
export const OK_TTL_MS = 60 * 60 * 1000
export const UNREACHABLE_TTL_MS = 10 * 60 * 1000
export const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000

export function versionCheckCachePath(cacheDir: string): string {
  return join(cacheDir, VERSION_CHECK_CACHE_FILE)
}

/** `path` without any trailing `/` characters (a linear scan, no regex). */
export function stripTrailingSlashes(path: string): string {
  let end = path.length
  while (end > 0 && path[end - 1] === '/') end -= 1
  return path.slice(0, end)
}

/**
 * `origin + pathname` without trailing slashes: userinfo, query and fragment never reach the key
 * (or the cache file), and `https://h` / `https://h/` share one entry.
 */
export function computeServerKey(baseUrl: string): string | null {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return null
  }
  return `${url.origin}${stripTrailingSlashes(url.pathname)}`
}

/** `true` while `timestamp` is within `ttlMs` of `now`; a future timestamp counts as expired. */
export function isWithinTtl(timestamp: string | null, now: number, ttlMs: number): boolean {
  if (timestamp === null) return false
  const at = Date.parse(timestamp)
  if (Number.isNaN(at) || at > now) return false
  return now - at < ttlMs
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIsoString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function validateSticky(
  value: unknown
): VersionCheckCacheEntry['lastConfirmedWithdrawn'] | undefined {
  if (value === null) return null
  if (!isRecord(value) || typeof value['reason'] !== 'string' || !isIsoString(value['at'])) {
    return undefined
  }
  // Re-sanitized on every read: the file is same-user writable, and this text reaches the terminal.
  return { reason: sanitizeServerText(value['reason']), at: value['at'] }
}

function hasValidScalars(value: Record<string, unknown>): boolean {
  const { cliVersion, checkedAt, outcome, lastNoticeAt } = value
  return (
    typeof cliVersion === 'string' &&
    isIsoString(checkedAt) &&
    (outcome === 'ok' || outcome === 'unreachable') &&
    (lastNoticeAt === null || isIsoString(lastNoticeAt))
  )
}

function validateEntry(value: unknown): VersionCheckCacheEntry | null {
  if (!isRecord(value) || !hasValidScalars(value)) return null
  const policy = value['policy'] === null ? null : validateCliVersionPolicy(value['policy'])
  if (value['policy'] !== null && policy === null) return null
  const sticky = validateSticky(value['lastConfirmedWithdrawn'])
  if (sticky === undefined) return null
  return {
    cliVersion: value['cliVersion'] as string,
    checkedAt: value['checkedAt'] as string,
    outcome: value['outcome'] as VersionCheckCacheEntry['outcome'],
    policy,
    lastConfirmedWithdrawn: sticky,
    lastNoticeAt: value['lastNoticeAt'] as string | null,
  }
}

export function readVersionCheckCache(path: string): Map<string, VersionCheckCacheEntry> {
  const entries = new Map<string, VersionCheckCacheEntry>()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return entries
  }
  if (!isRecord(parsed) || parsed['schemaVersion'] !== CACHE_SCHEMA_VERSION) return entries
  const raw = parsed['entries']
  if (!isRecord(raw)) return entries
  for (const [key, value] of Object.entries(raw)) {
    const entry = validateEntry(value)
    if (entry !== null) entries.set(key, entry)
  }
  return entries
}

/** Keeps the `MAX_CACHE_ENTRIES` most recently checked entries, then writes atomically (0600). */
export function writeVersionCheckCache(
  path: string,
  entries: Map<string, VersionCheckCacheEntry>,
  atomicFs?: AtomicFs
): void {
  const kept = [...entries.entries()]
    .sort(([, a], [, b]) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))
    .slice(0, MAX_CACHE_ENTRIES)
  const data = `${JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, entries: Object.fromEntries(kept) }, null, 2)}\n`
  try {
    ensureOwnerOnlyDir(join(path, '..'))
    writeFileAtomicOwnerOnly(
      path,
      data,
      { exclusive: false, tempPrefix: `.${VERSION_CHECK_CACHE_FILE}.` },
      atomicFs
    )
  } catch {
    // Fail-open (AC-8): EROFS/ENOSPC/EACCES only cost a later extra request.
  }
}
