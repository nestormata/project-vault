import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { VaultCacheCorruptedError } from './errors.js'
import type { EncryptedValue } from './cache-crypto.js'

export type CacheEntry = {
  encryptedValue: EncryptedValue
  versionNumber: number
  cachedAt: string
  ttlSeconds: number
}

export type CacheFile = Record<string, CacheEntry>

const FILE_MODE = 0o600
const DEFAULT_TTL_SECONDS = 86_400

export function defaultCachePath(): string {
  return join(homedir(), '.project-vault', 'cache.json')
}

/**
 * AC-13 — a corrupted (truncated/tampered) cache file must never be silently treated as "no
 * cache" and must never partially-parse into a state that could return a garbage/attacker-planted
 * value as if it were real. Any read/parse failure throws `VaultCacheCorruptedError`.
 */
export function readCacheFile(path: string): CacheFile {
  if (!existsSync(path)) return {}
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new VaultCacheCorruptedError()
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new VaultCacheCorruptedError()
    }
    return parsed as CacheFile
  } catch (error) {
    if (error instanceof VaultCacheCorruptedError) throw error
    throw new VaultCacheCorruptedError()
  }
}

let warnedWindowsPermissions = false

/**
 * AC-12 — every write is atomic: the full new contents are written to a temp file in the same
 * directory, then renamed over the real path (`rename(2)` is atomic on POSIX filesystems). A
 * concurrent reader (e.g. a parallel CI job on the same runner host) always sees either the fully
 * old or fully new file, never a torn write — this is what makes `VaultCacheCorruptedError` a
 * genuine "the file is actually broken" signal rather than a false positive from interleaved
 * writes. Mode 0600 is set on both the temp file and the final path (umask can otherwise produce
 * a looser mode than the `mode` option alone guarantees).
 */
export function writeCacheFile(path: string, data: CacheFile): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.cache.json.tmp-${randomBytes(6).toString('hex')}`)
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: FILE_MODE })
  renameSync(tmpPath, path)

  if (process.platform === 'win32') {
    if (!warnedWindowsPermissions) {
      warnedWindowsPermissions = true
      process.stderr.write(
        '[project-vault/agent] file-permission enforcement (mode 0600) is best-effort on Windows.\n'
      )
    }
    return
  }
  chmodSync(path, FILE_MODE)
}

export function getEntry(cache: CacheFile, name: string): CacheEntry | undefined {
  return cache[name]
}

export function withEntry(cache: CacheFile, name: string, entry: CacheEntry): CacheFile {
  return { ...cache, [name]: entry }
}

export function withoutEntry(cache: CacheFile, name: string): CacheFile {
  const { [name]: _removed, ...rest } = cache
  return rest
}

export function buildCacheEntry(
  encryptedValue: EncryptedValue,
  versionNumber: number,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): CacheEntry {
  return { encryptedValue, versionNumber, cachedAt: new Date().toISOString(), ttlSeconds }
}

/**
 * A cache entry is expired once `cachedAt + ttlSeconds` has passed — `ttlSeconds`/`cachedAt` are
 * written into every entry (AC-12's exact cache-file shape) specifically to bound how long a
 * secret may be served offline; an entry surviving past its own recorded TTL must stop being
 * servable rather than being read forever once fallback mode is entered.
 */
export function isEntryExpired(entry: CacheEntry, now: Date = new Date()): boolean {
  const expiresAtMs = new Date(entry.cachedAt).getTime() + entry.ttlSeconds * 1000
  return now.getTime() >= expiresAtMs
}
