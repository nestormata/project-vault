import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBackupCrypto } from './run-backup-worker.js'

const KEY = randomBytes(32)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = resolve(__dirname, '..')

// Story 74.2: the worker sources the real worker_thread path needs, as paths under src/.
// Only `node:` builtins are imported by these files, so a compiled copy needs no node_modules.
const WORKER_SOURCES = [
  'workers/run-backup-worker.ts',
  'workers/backup-encrypt.worker.ts',
  'workers/backup-crypto.ts',
  'fs-access.ts',
]
const COMPILED_ENTRY = 'workers/run-backup-worker.js'

type BackupCryptoFn = typeof runBackupCrypto

/**
 * Compiles the worker sources into `outDir` as ESM, mirroring the src/ layout. The test owns this
 * directory, so nothing else (a forced `turbo` rebuild of packages/crypto/dist, nightly run
 * 40619337374) can rewrite the artifact while the test reads it.
 */
function compileWorkerSources(outDir: string): void {
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'module' }))
  for (const source of WORKER_SOURCES) {
    const compiled = ts.transpileModule(readFileSync(join(SRC_ROOT, source), 'utf8'), {
      fileName: source,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    })
    const target = join(outDir, source.replace(/\.ts$/, '.js'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, compiled.outputText)
  }
}

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
  let outDir = ''

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'pv-backup-worker-'))
    compileWorkerSources(outDir)
  })

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true })
  })

  it('round-trips via the real worker_thread from an artifact the test compiled itself', async () => {
    for (const source of WORKER_SOURCES) {
      const emitted = source.replace(/\.ts$/, '.js')
      expect(
        existsSync(join(outDir, emitted)),
        `compiled worker artifact missing: ${emitted}`
      ).toBe(true)
    }
    const entry = join(outDir, COMPILED_ENTRY)
    const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
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
