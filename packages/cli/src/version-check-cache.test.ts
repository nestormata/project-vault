/* eslint-disable sonarjs/no-duplicate-string -- table-driven cases: each row spells its versions/URLs
   literally so the expected precedence or mapping is readable at a glance. */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  computeServerKey,
  isWithinTtl,
  MAX_CACHE_ENTRIES,
  readVersionCheckCache,
  stripTrailingSlashes,
  versionCheckCachePath,
  writeVersionCheckCache,
  type VersionCheckCacheEntry,
} from './version-check-cache.js'

// tsx (a root devDependency) resolves from the repository root for the child writers.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pvault-version-cache-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function entry(overrides: Partial<VersionCheckCacheEntry> = {}): VersionCheckCacheEntry {
  return {
    cliVersion: '1.2.0',
    checkedAt: '2026-09-24T10:00:00.000Z',
    outcome: 'ok',
    policy: { current: '1.3.0', minimumSupported: null, withdrawn: [] },
    lastConfirmedWithdrawn: null,
    lastNoticeAt: null,
    ...overrides,
  }
}

describe('computeServerKey (AC-8)', () => {
  it.each([
    ['https://v.example.com', 'https://v.example.com'],
    ['https://v.example.com/', 'https://v.example.com'],
    ['https://v.example.com//', 'https://v.example.com'],
    ['https://v.example.com/vault/', 'https://v.example.com/vault'],
    ['https://v.example.com/vault?x=1#frag', 'https://v.example.com/vault'],
    ['https://u:p@v.example.com/', 'https://v.example.com'],
    ['HTTPS://V.EXAMPLE.COM:443/', 'https://v.example.com'],
  ])('%s → %s', (input, expected) => {
    expect(computeServerKey(input)).toBe(expected)
  })

  it('returns null for an unparsable URL', () => {
    expect(computeServerKey('not a url')).toBeNull()
  })
})

describe('isWithinTtl', () => {
  const now = Date.parse('2026-09-24T10:00:00.000Z')
  it('is fresh inside the window', () => {
    expect(isWithinTtl('2026-09-24T09:30:00.000Z', now, 3_600_000)).toBe(true)
  })
  it('is expired at or past the window', () => {
    expect(isWithinTtl('2026-09-24T09:00:00.000Z', now, 3_600_000)).toBe(false)
  })
  it('treats a future timestamp (clock moved backwards) as expired', () => {
    expect(isWithinTtl('2026-09-24T10:00:01.000Z', now, 3_600_000)).toBe(false)
  })
  it('treats null/garbage as expired', () => {
    expect(isWithinTtl(null, now, 3_600_000)).toBe(false)
    expect(isWithinTtl('garbage', now, 3_600_000)).toBe(false)
  })
})

describe('readVersionCheckCache / writeVersionCheckCache', () => {
  it('round-trips entries, writes 0600 in a 0700 directory', () => {
    const dir = join(tempDir(), 'pvault')
    const path = versionCheckCachePath(dir)
    writeVersionCheckCache(path, new Map([['https://a', entry()]]))
    expect(readVersionCheckCache(path).get('https://a')).toEqual(entry())
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: number }
    expect(raw.schemaVersion).toBe(1)
  })

  it('a missing file is an empty cache', () => {
    expect(readVersionCheckCache(join(tempDir(), 'nope.json')).size).toBe(0)
  })

  it.each([
    ['not JSON', '{{{'],
    ['wrong schemaVersion', JSON.stringify({ schemaVersion: 2, entries: {} })],
    ['entries not an object', JSON.stringify({ schemaVersion: 1, entries: [] })],
    ['JSON array', '[]'],
  ])('a corrupted file (%s) is treated as no cache', (_label, content) => {
    const path = join(tempDir(), 'version-check.json')
    writeFileSync(path, content)
    expect(readVersionCheckCache(path).size).toBe(0)
  })

  it('drops individual entries that fail validation', () => {
    const path = join(tempDir(), 'version-check.json')
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          good: entry(),
          badOutcome: entry({ outcome: 'weird' as 'ok' }),
          badPolicy: entry({ policy: { current: 'latest' } as never }),
          badWithdrawn: entry({ lastConfirmedWithdrawn: { reason: 5 } as never }),
          badNotice: entry({ lastNoticeAt: 5 as never }),
          notObject: 'x',
        },
      })
    )
    expect([...readVersionCheckCache(path).keys()]).toEqual(['good'])
  })

  it('re-sanitizes a tampered sticky reason on read', () => {
    const path = join(tempDir(), 'version-check.json')
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          k: entry({
            lastConfirmedWithdrawn: { reason: '\x1b[31mred\u202E', at: '2026-09-24T10:00:00.000Z' },
          }),
        },
      })
    )
    expect(readVersionCheckCache(path).get('k')?.lastConfirmedWithdrawn?.reason).toBe('[31mred')
  })

  it(`evicts the least-recently-checked entries beyond ${MAX_CACHE_ENTRIES}`, () => {
    const path = versionCheckCachePath(tempDir())
    const entries = new Map<string, VersionCheckCacheEntry>()
    for (let i = 0; i < 21; i++) {
      entries.set(
        `https://s${i}`,
        entry({ checkedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() })
      )
    }
    writeVersionCheckCache(path, entries)
    const read = readVersionCheckCache(path)
    expect(read.size).toBe(20)
    expect(read.has('https://s0')).toBe(false)
    expect(read.has('https://s20')).toBe(true)
  })

  it('an EROFS write failure is swallowed (fail-open)', () => {
    const path = versionCheckCachePath(tempDir())
    const erofs = () => {
      throw Object.assign(new Error('read-only'), { code: 'EROFS' })
    }
    expect(() =>
      writeVersionCheckCache(path, new Map([['k', entry()]]), {
        openSync: erofs,
      } as never)
    ).not.toThrow()
  })

  it('a directory that cannot be created is swallowed (fail-open)', () => {
    const base = tempDir()
    writeFileSync(join(base, 'file'), 'x')
    expect(() =>
      writeVersionCheckCache(join(base, 'file', 'sub', 'version-check.json'), new Map())
    ).not.toThrow()
  })

  it('two concurrent real writers never leave a torn file', async () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    const path = versionCheckCachePath(dir)
    const moduleUrl = new URL('./version-check-cache.ts', import.meta.url).href
    const script = (key: string) => `
      const m = await import(${JSON.stringify(moduleUrl)});
      for (let i = 0; i < 25; i++) {
        m.writeVersionCheckCache(${JSON.stringify(path)}, new Map([[${JSON.stringify(key)}, ${JSON.stringify(entry())}]]));
      }`
    const run = (key: string) =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '--no-warnings', '--input-type=module', '-e', script(key)],
          { stdio: 'inherit', cwd: REPO_ROOT }
        )
        child.on('error', reject)
        child.on('exit', (code) => resolve(code ?? 1))
      })
    const codes = await Promise.all([run('https://a'), run('https://b')])
    expect(codes).toEqual([0, 0])
    const read = readVersionCheckCache(path)
    expect(read.size).toBe(1)
    expect(['https://a', 'https://b']).toContain([...read.keys()][0])
  })
})

describe('stripTrailingSlashes', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['///', ''],
    ['/a//', '/a'],
    ['/a', '/a'],
    ['/a//b/', '/a//b'],
  ])('%j → %j', (input, expected) => {
    expect(stripTrailingSlashes(input)).toBe(expected)
  })
})
