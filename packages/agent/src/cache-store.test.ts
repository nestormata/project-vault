import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildCacheEntry,
  getEntry,
  readCacheFile,
  withEntry,
  withoutEntry,
  writeCacheFile,
} from './cache-store.js'
import { VaultCacheCorruptedError } from './errors.js'

const CACHE_FILENAME = 'cache.json'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-agent-cache-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('cache-store', () => {
  it('returns an empty cache when the file does not exist', () => {
    const path = join(dir, CACHE_FILENAME)
    expect(readCacheFile(path)).toEqual({})
  })

  it('writes and reads back a cache entry, with mode 0600', () => {
    const path = join(dir, CACHE_FILENAME)
    const entry = buildCacheEntry({ version: 1, iv: 'aa', ciphertext: 'bb', tag: 'cc' }, 1)
    writeCacheFile(path, withEntry({}, 'DATABASE_URL', entry))

    const read = readCacheFile(path)
    expect(getEntry(read, 'DATABASE_URL')).toEqual(entry)

    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('removes an entry via withoutEntry', () => {
    const path = join(dir, CACHE_FILENAME)
    const entry = buildCacheEntry({ version: 1, iv: 'aa', ciphertext: 'bb', tag: 'cc' }, 1)
    writeCacheFile(path, withEntry({}, 'SECRET_A', entry))

    const cache = readCacheFile(path)
    writeCacheFile(path, withoutEntry(cache, 'SECRET_A'))

    expect(getEntry(readCacheFile(path), 'SECRET_A')).toBeUndefined()
  })

  it('creates the parent directory if it does not exist yet', () => {
    const path = join(dir, 'nested', 'dir', 'cache.json')
    const entry = buildCacheEntry({ version: 1, iv: 'aa', ciphertext: 'bb', tag: 'cc' }, 1)

    expect(() => writeCacheFile(path, withEntry({}, 'X', entry))).not.toThrow()
    expect(getEntry(readCacheFile(path), 'X')).toEqual(entry)
  })

  it('throws VaultCacheCorruptedError for truncated/invalid JSON', () => {
    const path = join(dir, CACHE_FILENAME)
    writeFileSync(path, '{ this is not valid json')

    expect(() => readCacheFile(path)).toThrow(VaultCacheCorruptedError)
  })

  it('throws VaultCacheCorruptedError when the top-level JSON is not an object', () => {
    const path = join(dir, CACHE_FILENAME)
    writeFileSync(path, '[1, 2, 3]')

    expect(() => readCacheFile(path)).toThrow(VaultCacheCorruptedError)
  })
})
