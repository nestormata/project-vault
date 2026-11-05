import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compileSourceSubset,
  type CompiledSourceSubset,
} from '../../../../scripts/lib/compile-source-subset.js'
import { runBackupCrypto } from './run-backup-worker.js'

const KEY = randomBytes(32)
const COMPILED_ENTRY = 'workers/run-backup-worker.js'

type BackupCryptoFn = typeof runBackupCrypto

/** A named failure for a missing artifact or export, instead of `x is not a function`. */
function requireBackupCryptoExport(mod: Record<string, unknown>, entry: string): BackupCryptoFn {
  const exported = mod.runBackupCrypto
  if (typeof exported !== 'function') {
    throw new TypeError(`compiled ${entry} does not export runBackupCrypto as a function`)
  }
  return exported as BackupCryptoFn
}

describe('Story 9.1 D5/AC-5: runBackupCrypto (worker_thread offload with sync fallback)', () => {
  it('round-trips via the synchronous fallback when no compiled worker artifact is present', async () => {
    // Running against src/ (not a built dist/), so the sibling .worker.js referenced by
    // run-backup-worker.ts does not exist on disk — this deterministically exercises the
    // documented fallback path, proving the business logic works without requiring a real
    // worker_thread spin-up in every test environment.
    const plaintext = Buffer.from('pretend this is a gzipped pg_dump')
    const encrypted = await runBackupCrypto('encrypt', plaintext, KEY)
    const decrypted = await runBackupCrypto('decrypt', encrypted, KEY)
    expect(decrypted.equals(plaintext)).toBe(true)
  })
})

describe('Story 74.2: runBackupCrypto over the real worker_thread (self-compiled artifact)', () => {
  let compiled: CompiledSourceSubset | undefined

  beforeAll(() => {
    compiled = compileSourceSubset(
      fileURLToPath(new URL('./run-backup-worker.ts', import.meta.url))
    )
  })

  afterAll(() => {
    compiled?.cleanup()
  })

  it('round-trips via the real worker_thread from an artifact the test compiled itself', async () => {
    expect(compiled, 'helper did not compile the worker').toBeDefined()
    if (compiled === undefined) return
    const worker = fileURLToPath(new URL('./backup-encrypt.worker.js', compiled.entryUrl))
    expect(existsSync(worker), 'compiled worker artifact missing').toBe(true)
    const mod = (await import(compiled.entryUrl)) as Record<string, unknown>
    const runBackupCryptoFromCompiled = requireBackupCryptoExport(mod, COMPILED_ENTRY)

    const plaintext = Buffer.from('pretend this is a gzipped pg_dump, via the real worker')
    const encrypted = await runBackupCryptoFromCompiled('encrypt', plaintext, KEY)
    const decrypted = await runBackupCryptoFromCompiled('decrypt', encrypted, KEY)
    expect(encrypted.equals(plaintext)).toBe(false)
    expect(decrypted.equals(plaintext)).toBe(true)
  })

  it('fails with a named message, not a TypeError, when the compiled module lacks the export', () => {
    expect(() => requireBackupCryptoExport({}, COMPILED_ENTRY)).toThrow(
      'compiled workers/run-backup-worker.js does not export runBackupCrypto as a function'
    )
    expect(() => requireBackupCryptoExport({ runBackupCrypto: 'nope' }, COMPILED_ENTRY)).toThrow(
      /does not export runBackupCrypto as a function/
    )
  })
})
